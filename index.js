/**
 * dsh-qq-group-digest —— Host 半身
 *
 * 职责：连 NapCat 的 OneBot11 正向 WebSocket，监听指定群消息，按阈值分批，
 * 调 DSH 里已配置的模型总结，按群组织后私聊发给指定好友。
 *
 * 模型来源：ctx.llm.stream（凭证/代理/重试/路由全由 DSH 负责，插件不碰 API Key）。
 * 状态落盘：$DSH_HOME/storages/qq-digest/
 *
 * 配置分两层：
 *   1. cordis.patch.yml —— 首次安装的初始值，改它需要重启 DSH；
 *   2. $DSH_HOME/storages/qq-digest/settings.json —— 设置页写盘的用户覆盖，
 *      保存后**立即热重建**运行态，不需要重启 DSH。
 *
 * 路由：
 *   GET  /api/qq-digest/status            运行状态（每群 pending/inFlight/失败统计）
 *   GET  /api/qq-digest/settings          UI 可编辑的配置子集 + 可选项
 *   POST /api/qq-digest/settings          保存覆盖并热重载（body: 部分配置）
 *   POST /api/qq-digest/settings/reset    清空覆盖，回到 patch 初始值
 *   GET  /api/qq-digest/models            列出 DSH 里可选的 provider/model
 *   GET  /api/qq-digest/groups            已监听的群 + NapCat 群列表（用于下拉选群）
 *   GET  /api/qq-digest/members?groupId=  指定群成员列表（用于按成员过滤下拉）
 *   GET  /api/qq-digest/friends           NapCat 好友列表（用于下拉选接收人）
 *   POST /api/qq-digest/flush             立即冻结所有群并总结投递
 *   POST /api/qq-digest/reload            热重载：载入新一代 lib/ 代码并重建运行态
 *   POST /api/qq-digest/test              发一条测试私聊，验证好友可达
 *   GET  /api/qq-digest/recent            最近若干次报告正文
 *   GET  /api/qq-digest/prompt            生效的 system prompt + 内置默认（供设置页编辑）
 *   POST /api/qq-digest/prompt            保存自定义 system prompt（body: { system }）
 *   POST /api/qq-digest/prompt/reset      清空自定义 prompt，回到内置默认
 *   GET  /api/qq-digest/http              网页服务状态（token 只回掩码）
 *   POST /api/qq-digest/http              更新网页服务配置（token 传空=不变，__REGEN__=重生成）
 *   POST /api/qq-digest/http/token        重新生成网页服务密钥（明文只回这一次）
 *
 * 注意：prompt.system 与 httpServer.token 刻意不在 settings.js 的白名单里，
 * 它们只走上面三个专用端点，避免通用保存流程把敏感值误清空。
 */

import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadGeneration } from './lib/hot.js'

import { deepMerge, resolveConfig, storageRoot } from './lib/config.js'
import {
  pickEditable,
  readJson,
  readSettings,
  writeSettings,
  writeJsonAtomic,
  sanitizeOverride,
  maskToken,
  looksMasked,
} from './lib/store/settings.js'
import { Runtime } from './lib/runtime.js'
import { HttpServer } from './lib/http/server.js'
import { LogStore } from './lib/store/logs.js'
import { getSvc } from './lib/summarize/summarize.js'
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_DETAIL_SYSTEM_PROMPT,
  isDefaultPrompt,
  isDefaultDetailPrompt,
} from './lib/summarize/prompt-store.js'

export const name = 'qq-group-digest'

/**
 * 后端代码版本：只在 index.js / 路由层 / lib 契约发生「热重载换不掉」的改动时递增。
 * 设置页拿它和前端期望值比对，不一致就提示「后端是旧代码，需重启 DSH」——
 * 因为热重载只替换 Runtime，不重新 import index.js 的路由表。
 */
const BACKEND_VERSION = 4

/**
 * system prompt 的长度约束：留空 = 用内置默认；非空则 10-20000 字符。
 * 下限只挡「手滑提交一个残缺提示词」，不挡合法的短提示词——
 * 一句「用中文总结，保留链接」本身就够用，没有理由强制 50 字。
 */
const MAX_PROMPT_CHARS = 20000
const MIN_PROMPT_CHARS = 10
/** POST /http 里 token 取这个魔法值表示「重新随机生成」。 */
const TOKEN_REGEN = '__REGEN__'

// 只声明 webServer：llm 走 ctx.get 惰性读取，缺失时降级为清晰报错，
// 而不是让整个插件卡在 PENDING。
export const inject = ['webServer']

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 生成 32 位十六进制密钥（网页端登录用）。 */
function generateToken() {
  return randomBytes(16).toString('hex')
}

/** 只露末 4 位，其余用 * 覆盖；未设置时返回空串。绝不返回明文。 */
function tokenMask(token) {
  const s = String(token == null ? '' : token).trim()
  if (!s) return ''
  if (s.length <= 4) return '****'
  return '****' + s.slice(-4)
}

/**
 * 探测端口能不能 bind。
 * 返回 { ok: true } 或 { ok: false, error }；error 用人话，直接展示给设置页。
 */
function probePort(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        probe.close()
      } catch {
        /* 未 listen 成功时 close 会抛，忽略 */
      }
      resolve(result)
    }
    probe.once('error', (error) => {
      const code = error && error.code ? String(error.code) : ''
      const message =
        code === 'EADDRINUSE'
          ? '端口 ' + port + ' 已被占用'
          : code === 'EACCES'
            ? '没有权限监听端口 ' + port
            : error && error.message
              ? error.message
              : String(error)
      finish({ ok: false, error: message })
    })
    probe.once('listening', () => finish({ ok: true }))
    try {
      probe.listen(port, host || '0.0.0.0')
    } catch (error) {
      finish({ ok: false, error: error && error.message ? error.message : String(error) })
    }
  })
}

/** 对外展示的访问地址：监听在 0.0.0.0 时给出 127.0.0.1，浏览器里点得开。 */
function displayHost(host) {
  const h = String(host || '').trim()
  if (!h || h === '0.0.0.0' || h === '::') return '127.0.0.1'
  return h
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx, config = {}) {
  const baseConfig = config || {}
  const logger = ctx.logger || null
  // 注意：这里必须先过一遍 resolveConfig，再取 storageRoot。
  // storageRoot 只读 cfg.storage.dir，而 patch 里的 storage.dir 常为空串，
  // 真正的落点由 resolveConfig 兜底成 $DSH_HOME/storages/qq-digest。
  // 直接喂 baseConfig 会在 storage.dir 为空时把 settings.json 写到 $DSH_HOME 根下，
  // 与运行态用的目录不一致（配置保存「成功」但读不回来）。
  const settingsFile = join(storageRoot(resolveConfig(baseConfig).config), 'settings.json')

  /** patch 初始值 + UI 覆盖 = 最终生效配置。 */
  const effectiveConfig = () => deepMerge(baseConfig, readSettings(settingsFile))

  /**
   * 两套 system prompt：'summary'（普通 QQ 总结，默认）与 'detail'（AI 精细版）。
   * 非法值一律按 'summary' 处理，前端传错不至于 500。
   */
  const promptKind = (value) => {
    const kind = String(value == null ? '' : value).trim().toLowerCase()
    return kind === 'detail' ? 'detail' : 'summary'
  }

  /** 某个 kind 对应的 settings.json 字段名（prompt.system / prompt.detailSystem）。 */
  const promptField = (kind) => (promptKind(kind) === 'detail' ? 'detailSystem' : 'system')

  /** 某个 kind 的内置默认文本。 */
  const defaultPromptOf = (kind) =>
    promptKind(kind) === 'detail' ? DEFAULT_DETAIL_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT

  /** 与内置默认逐字比较（判断「内容一样但被当成自定义」）。 */
  const isBuiltinPrompt = (kind, text) =>
    promptKind(kind) === 'detail' ? isDefaultDetailPrompt(text) : isDefaultPrompt(text)

  /** 当前生效的自定义 system prompt（空串 = 用内置默认）。 */
  const currentPrompt = (kind) => {
    const field = promptField(kind)
    return String((runtime.cfg && runtime.cfg.prompt && runtime.cfg.prompt[field]) || '')
  }

  /**
   * 写 prompt.system / prompt.detailSystem 并热重建运行态。
   *
   * prompt.* 不在 settings.js 白名单里，所以不能走通用的
   * readSettings/writeSettings（会被 sanitizeOverride 丢掉）；这里直接读原始
   * JSON、合并、再原子写回，同时把结果同步给 runtime。
   * 返回 { ok, errors }，errors 非空时**不落盘**。
   */
  const applyPrompt = (kind, system) => {
    const field = promptField(kind)
    const raw = readJson(settingsFile, {})
    const merged = Object.assign({}, raw && typeof raw === 'object' ? raw : {})
    const patch = {}
    patch[field] = system
    merged.prompt = Object.assign(
      {},
      merged.prompt && typeof merged.prompt === 'object' ? merged.prompt : {},
      patch,
    )
    const result = runtime.reconfigure(deepMerge(baseConfig, merged))
    if (!result.ok) return { ok: false, errors: result.errors || [] }
    writeJsonAtomic(settingsFile, merged)
    return { ok: true, errors: [] }
  }

  /** 网页服务的运行态：由 lib/http 提供（P1）；未就绪时给出空壳，不让设置页报错。 */
  const httpStatus = () => {
    const cfg = runtime.cfg && runtime.cfg.httpServer ? runtime.cfg.httpServer : {}
    const live = runtime.httpServer && typeof runtime.httpServer.status === 'function'
      ? runtime.httpServer.status() || {}
      : {}
    const enabled = cfg.enabled === true
    const listening = live.listening === true
    const error = live.error ? String(live.error) : ''
    const port = Number(cfg.port) || 1213
    return {
      enabled,
      listening,
      running: listening,
      port,
      host: String(cfg.host || '0.0.0.0'),
      url: listening ? 'http://' + displayHost(cfg.host) + ':' + port + '/' : '',
      error,
      lastError: error,
      authEnabled: cfg.authEnabled !== false,
      sessionHours: Number(cfg.sessionHours) || 168,
      tokenSet: Boolean(String(cfg.token || '').trim()),
      tokenMasked: tokenMask(cfg.token),
      hasToken: Boolean(String(cfg.token || '').trim()),
      tokenPreview: tokenMask(cfg.token),
    }
  }

  // let 而非 const：/reload 会用「新一代代码」里导出的 Runtime 整体替换掉它。
  let runtime = new Runtime({
    ctx,
    logger,
    rawConfig: effectiveConfig(),
  })
  runtime.start()

  const pluginRoot = dirname(fileURLToPath(import.meta.url))

  // ── 独立网页服务（lib/http）────────────────────────────────────
  // 与 DSH 自带的 webServer 完全独立：自己 listen 自己的端口，默认关闭。
  // 实例挂在 runtime 上，让 httpStatus() 与 /reload 后的新运行态都能读到。
  const logStore = new LogStore(storageRoot(resolveConfig(baseConfig).config), {
    keepDays: Number((runtime.cfg.storage || {}).keepDays) || 7,
  })
  const httpServer = new HttpServer({
    getRuntime: () => runtime,
    logStore,
    settingsFile,
    pluginRoot,
    logger,
    // 网页端改设置走这里：白名单外的字段（prompt.system / httpServer.token）
    // 需要原样落盘，不能过 sanitizeOverride。
    writeSettings: (patch) => {
      const raw = readJson(settingsFile, {})
      const merged = Object.assign({}, raw && typeof raw === 'object' ? raw : {})
      const src = patch && typeof patch === 'object' ? patch : {}
      for (const key of Object.keys(src)) {
        const value = src[key]
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          merged[key] = Object.assign({}, merged[key] && typeof merged[key] === 'object' ? merged[key] : {}, value)
        } else {
          merged[key] = value
        }
      }
      writeJsonAtomic(settingsFile, merged)
      return merged
    },
  })
  runtime.httpServer = httpServer

  // 配置变了就重启监听：先 stop 再 start。用 setImmediate 甩到下一轮事件循环，
  // 避免在 HTTP 响应还没写出去时就把自己所在的监听关掉。
  //
  // httpStopped 是卸载闸门：teardown 之后可能还有一个排队中的 setImmediate，
  // 若放任它跑，插件卸载完端口又被占回去，进程也就退不掉了。
  let httpStopped = false
  const restartHttp = () => {
    if (httpStopped) return
    setImmediate(() => {
      if (httpStopped) return
      httpServer
        .start()
        .then(() => {
          // 启动途中被卸载：listen 已经建立，补一次 stop。
          if (httpStopped) return httpServer.stop()
          return undefined
        })
        .catch((error) => {
          logger?.warn?.('[qq-digest][http] 重启监听失败：' + (error && error.message ? error.message : String(error)))
        })
    })
  }

  // 首次启动也异步：端口占用等失败只记在 httpServer.error 里，不阻塞插件加载。
  restartHttp()

  if (runtime.errors.length > 0) {
    logger?.warn?.('[qq-digest] ' + runtime.startError + '（status 与设置页仍可访问，请在设置页补全配置）')
  }

  // httpServer 段是否发生变化（端口 / 监听地址 / 开关 / 鉴权 / 有效期任一不同）。
  // 只有变了才重启监听，避免每次保存其它字段都白白断开一次连接。
  const httpSectionChanged = (a, b) => {
    const keys = ['enabled', 'port', 'host', 'authEnabled', 'sessionHours', 'token']
    const left = a && typeof a === 'object' ? a : {}
    const right = b && typeof b === 'object' ? b : {}
    return keys.some((k) => String(left[k] == null ? '' : left[k]) !== String(right[k] == null ? '' : right[k]))
  }

  // ── HTTP 路由 ──────────────────────────────────────────────────
  const handler = async (req, res) => {
    let pathname = '/'
    // 保留整个 URL 对象：/prompt 系列端点要从 ?kind= 取参数。
    let reqUrl = null
    try {
      reqUrl = new URL(req.url || '/', 'http://localhost')
      pathname = decodeURIComponent(reqUrl.pathname)
    } catch {
      /* 畸形 URL 落 404 */
    }
    // 畸形 URL 时 searchParams 不可用，退化成空参对象（端点仍按默认 kind 处理）。
    const query = (name) => {
      try {
        return reqUrl ? reqUrl.searchParams.get(name) : null
      } catch {
        return null
      }
    }

    if (pathname === '/api/qq-digest/status' && req.method === 'GET') {
      sendJson(res, 200, Object.assign({ ok: true }, runtime.status()))
      return
    }

    // ── 设置页：读 ──────────────────────────────────────────────
    if (pathname === '/api/qq-digest/settings' && req.method === 'GET') {
      const editable = pickEditable(runtime.cfg)
      // pickEditable 只带出「配置里真实存在的字段」；ui 段在 patch 里没写时
      // runtime.cfg.ui 仍会被 resolveConfig 补成 { sidebarEntry: false }，
      // 这里再兜一层，保证设置页永远拿得到开关的当前值。
      const ui = Object.assign({ sidebarEntry: false }, editable.ui)
      sendJson(res, 200, {
        ok: true,
        settings: Object.assign({}, editable, {
          napcat: Object.assign({}, editable.napcat, { token: maskToken(editable.napcat.token) }),
          ui,
        }),
        // token 是否真的存在（UI 用它决定输入框占位提示）
        tokenSet: Boolean(runtime.cfg.napcat.token),
        status: {
          started: runtime.started,
          configErrors: runtime.errors,
          startError: runtime.startError,
          wsConnected: Boolean(runtime.client && runtime.client.ready),
        },
        // prompt.system 与 httpServer.token 不在白名单里，单独平铺给前端：
        // 前者供提示词卡片回显，后者只回掩码 + 是否存在。
        promptSystem: runtime.cfg.prompt ? String(runtime.cfg.prompt.system || '') : '',
        promptIsDefault: !(runtime.cfg.prompt && runtime.cfg.prompt.system),
        // 精细版提示词（v0.5.0 起与普通版并列，各自可编辑、可恢复默认）。
        promptDetailSystem: runtime.cfg.prompt ? String(runtime.cfg.prompt.detailSystem || '') : '',
        promptDetailIsDefault: !(runtime.cfg.prompt && runtime.cfg.prompt.detailSystem),
        promptMaxChars: MAX_PROMPT_CHARS,
        defaultPrompt: DEFAULT_SYSTEM_PROMPT,
        defaultDetailPrompt: DEFAULT_DETAIL_SYSTEM_PROMPT,
        summaryAiDetail: Boolean(runtime.cfg.summary && runtime.cfg.summary.aiDetail),
        httpServer: httpStatus(),
        settingsFile,
        backendVersion: BACKEND_VERSION,
        // 前端据此判断后端是否支持「信息过滤」等新能力，缺字段时自动降级提示。
        capabilities: ['settings', 'groups', 'friends', 'members', 'recent', 'flush', 'reload', 'prompt', 'http', 'httpServer'],
      })
      return
    }

    // ── 设置页：保存并热重载 ────────────────────────────────────
    if (pathname === '/api/qq-digest/settings' && req.method === 'POST') {
      try {
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const incoming = body && body.settings ? body.settings : body

        const current = readSettings(settingsFile)
        const beforeHttp = Object.assign({}, (runtime.cfg && runtime.cfg.httpServer) || {})
        // 合并而非替换：只提交改动字段的客户端也能工作。
        const sanitized = sanitizeOverride(incoming)
        const merged = deepMerge(current, sanitized.override)
        // dropped 非空说明前端提交了本后端不认识（或类型不对）的字段：
        // 典型场景是后端还是旧代码，白名单里没有新增项。必须显式告诉前端，否则就是「显示已保存其实丢了」。
        const droppedFields = sanitized.dropped || []

        // 提交上来的 token 若是脱敏值（含 *）说明用户没改，沿用旧值。
        if (
          merged.napcat &&
          typeof merged.napcat.token === 'string' &&
          looksMasked(merged.napcat.token)
        ) {
          merged.napcat.token = runtime.cfg.napcat.token
        }

        const next = deepMerge(baseConfig, merged)
        const result = runtime.reconfigure(next)
        if (!result.ok) {
          sendJson(res, 400, {
            ok: false,
            error: (result.errors || []).join('；'),
            configErrors: result.errors,
          })
          return
        }

        // 校验通过才落盘：先试跑再持久化，避免把错误配置写进文件。
        writeSettings(settingsFile, merged)
        // httpServer 段变了必须重启监听：只 reconfigure 不会重新 listen，
        // 否则「勾了开启、显示已保存」但端口一直没人听（只有 /http 专用端点会重启）。
        if (httpSectionChanged(beforeHttp, merged.httpServer)) restartHttp()
        sendJson(res, 200, {
          ok: true,
          reloaded: true,
          restarts: runtime.restarts,
          configErrors: runtime.errors,
          status: runtime.status(),
          backendVersion: BACKEND_VERSION,
          droppedFields,
          ...(droppedFields.length > 0
            ? { warning: '以下字段未生效（后端不识别）：' + droppedFields.join('、') }
            : {}),
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    if (pathname === '/api/qq-digest/settings/reset' && req.method === 'POST') {
      try {
        writeSettings(settingsFile, {})
        const beforeHttp = Object.assign({}, (runtime.cfg && runtime.cfg.httpServer) || {})
        const result = runtime.reconfigure(deepMerge(baseConfig, {}))
        // 恢复初始配置会把 httpServer.enabled 打回 false，监听必须同步停掉。
        if (httpSectionChanged(beforeHttp, (runtime.cfg && runtime.cfg.httpServer) || {})) restartHttp()
        sendJson(res, 200, { ok: true, reloaded: result.ok, configErrors: runtime.errors })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    // ── 重载运行态 ──────────────────────────────────────────────
    // 改了 index.js / lib/** 之后调用：拆掉旧运行态（WS 连接、管线、定时器），
    // 重新读 settings 并整体重建。**不需要重启 DSH**。
    //
    // 边界说明：这重载的是「运行态」，不是 JS 模块。进程里已加载的 index.js /
    // lib/** 仍是旧代码；要让新代码本身生效，插件宿主必须重新 import 本插件
    // （例如在设置页里关闭再开启插件，或重启 DSH）。本端点负责的是：
    // 代码重载之后（或配置漂移之后）把连接/管线按最新配置干净地重建一次。
    if (pathname === '/api/qq-digest/reload' && req.method === 'POST') {
      try {
        // 先取快照再拆运行态：stop() 会把 pipeline 置空，之后就取不到了。
        const carry = runtime.pipeline ? runtime.pipeline.snapshotPending() : null
        const previous = runtime

        // 1) 载入新一代代码（把 lib/ 复制到新目录再 import，绕过 ESM 缓存）。
        //    这一步失败就直接报错，旧运行态一动不动。
        let Generation = null
        let generationDir = ''
        let generationError = ''
        try {
          const loaded = await loadGeneration(pluginRoot, previous.rootDir)
          Generation = loaded.Runtime
          generationDir = loaded.dir
        } catch (error) {
          generationError = error && error.message ? error.message : String(error)
        }

        // 2) 用新代码（载入失败则退回旧代码）重建运行态，并接上未总结的消息。
        const next = new (Generation || previous.constructor)({
          ctx,
          logger,
          rawConfig: effectiveConfig(),
        })
        const result = next.reconfigure(effectiveConfig(), carry)
        if (!result.ok) {
          // 新配置校验没过：把新一代拆掉，旧运行态继续跑，监听不中断。
          try {
            next.stop()
          } catch {
            /* 尽力而为 */
          }
          sendJson(res, 400, {
            ok: false,
            error: (result.errors || []).join('；'),
            restarts: previous.restarts,
            configErrors: result.errors,
          })
          return
        }

        // 3) 新一代起来了才拆旧的，顺序不能反。
        try {
          previous.stop()
        } catch {
          /* 尽力而为 */
        }
        runtime = next
        // 新运行态要接上同一个网页服务实例，否则 httpStatus() 读不到监听状态。
        runtime.httpServer = httpServer

        sendJson(res, 200, {
          ok: true,
          reloaded: true,
          codeReloaded: Boolean(Generation),
          generationDir,
          generationError,
          restarts: runtime.restarts,
          carried: result.carried || 0,
          configErrors: runtime.errors,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    // ── 设置页：可选项 ──────────────────────────────────────────
    if (pathname === '/api/qq-digest/models' && req.method === 'GET') {
      const out = { ok: true, providers: [], current: null, error: '' }
      try {
        const llm = getSvc(ctx, 'llm')
        if (!llm) {
          out.error = 'DSH LLM 服务不可用'
        } else {
          const providers = typeof llm.listProviders === 'function' ? llm.listProviders() || [] : []
          for (const p of providers) {
            let models = []
            try {
              models = (await llm.listModels(p.id)) || []
            } catch {
              models = []
            }
            out.providers.push({ id: String(p.id), label: String(p.label || p.name || p.id), models: models.map((m) => ({ id: String(m.id), label: String(m.label || m.name || m.id) })) })
          }
        }
        const def = getSvc(ctx, 'agentDefaultModel')
        if (def && typeof def.currentSelection === 'function') {
          const sel = def.currentSelection()
          if (sel && sel.provider) out.current = { provider: String(sel.provider), model: String(sel.model || '') }
        }
      } catch (error) {
        out.error = error && error.message ? error.message : String(error)
      }
      sendJson(res, 200, out)
      return
    }

    if (pathname === '/api/qq-digest/groups' && req.method === 'GET') {
      const listening = Array.isArray(runtime.cfg.listen.groups) ? runtime.cfg.listen.groups.slice() : []
      let available = []
      let error = ''
      try {
        if (runtime.actions) available = await runtime.actions.groupList()
      } catch (e) {
        error = e && e.message ? e.message : String(e)
      }
      sendJson(res, 200, {
        ok: true,
        listening,
        available: (available || []).map((g) => ({
          groupId: String(g.group_id),
          groupName: String(g.group_name || ''),
          memberCount: g.member_count != null ? Number(g.member_count) : null,
          maxMemberCount: g.max_member_count != null ? Number(g.max_member_count) : null,
        })),
        error,
      })
      return
    }

    if (pathname === '/api/qq-digest/members' && req.method === 'GET') {
      const groupId = new URL(req.url, 'http://x').searchParams.get('groupId') || ''
      let available = []
      let error = ''
      if (!groupId) {
        error = '缺少 groupId 参数'
      } else {
        try {
          if (runtime.actions) available = await runtime.actions.groupMemberList(groupId)
        } catch (e) {
          error = e && e.message ? e.message : String(e)
        }
      }
      sendJson(res, 200, {
        ok: !error,
        groupId,
        available: (available || []).map((m) => ({
          userId: String(m.user_id),
          nickname: String(m.nickname || m.card || ''),
          card: String(m.card || ''),
          role: String(m.role || ''),
        })),
        error,
      })
      return
    }

    if (pathname === '/api/qq-digest/friends' && req.method === 'GET') {
      let available = []
      let error = ''
      try {
        if (runtime.actions) available = await runtime.actions.friendList()
      } catch (e) {
        error = e && e.message ? e.message : String(e)
      }
      sendJson(res, 200, {
        ok: true,
        available: (available || []).map((f) => ({
          userId: String(f.user_id),
          nickname: String(f.nickname || f.remark || ''),
          remark: String(f.remark || ''),
        })),
        error,
      })
      return
    }

    if (pathname === '/api/qq-digest/recent' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, recent: runtime.recent })
      return
    }

    if (pathname === '/api/qq-digest/flush' && req.method === 'POST') {
      try {
        const delivery = await runtime.flushAll()
        sendJson(res, 200, {
          ok: true,
          delivered: delivery ? delivery.result.delivered.length : 0,
          failed: delivery ? delivery.result.failed.length : 0,
          segments: delivery ? delivery.result.segments : 0,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    if (pathname === '/api/qq-digest/test' && req.method === 'POST') {
      try {
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const friends =
          Array.isArray(body.friends) && body.friends.length > 0
            ? body.friends.map(String)
            : runtime.cfg.delivery.friends
        if (friends.length === 0) {
          sendJson(res, 400, { ok: false, error: '没有可用的好友：配置 delivery.friends 或传 { friends: [...] }' })
          return
        }
        const text = body.text ? String(body.text) : '[qq-digest] 测试消息：通道正常。'
        const out = await runtime.sendTest(friends, text)
        sendJson(res, 200, { ok: out.some((o) => o.ok), results: out })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    // ── AI 提示词（prompt.system）────────────────────────────────
    // 不放在 settings 白名单里：自定义 prompt 是一大段文本，走通用保存流程
    // 一旦被 sanitizeOverride 丢弃就是静默丢失，所以单独开三个端点。
    if (pathname === '/api/qq-digest/prompt' && req.method === 'GET') {
      // ?kind=summary|detail：两套提示词各自独立读写，非法值按 summary。
      const kind = promptKind(query('kind'))
      const system = currentPrompt(kind)
      const fallback = defaultPromptOf(kind)
      sendJson(res, 200, {
        ok: true,
        kind,
        // system 是「settings.json 里存的原样值」：空串表示用户没自定义。
        // 前端 textarea 直接回显它，这样「未自定义」时输入框是空的，
        // 而不是把内置默认灌进去让人误以为已经保存过一份自定义。
        system,
        // effective 才是真正送给模型的 system prompt（空 → 内置默认）。
        effective: system || fallback,
        isDefault: !system,
        defaultPrompt: fallback,
        maxChars: MAX_PROMPT_CHARS,
        minChars: MIN_PROMPT_CHARS,
      })
      return
    }

    if (pathname === '/api/qq-digest/prompt' && req.method === 'POST') {
      try {
        const raw = await readBody(req, 256 * 1024)
        const body = raw ? JSON.parse(raw) : {}
        // kind 也允许走 query（POST 用 body.kind 优先，其次 query）。
        const kind = promptKind(
          body && body.kind != null ? body.kind : query('kind'),
        )
        const system = String((body && body.system) == null ? '' : body.system).trim()
        if (system.length > MAX_PROMPT_CHARS) {
          sendJson(res, 400, {
            ok: false,
            error: '提示词过长：' + system.length + ' 字符，上限 ' + MAX_PROMPT_CHARS,
            maxChars: MAX_PROMPT_CHARS,
          })
          return
        }
        // 0 = 清空回默认；其余必须够长，避免误提交一个残缺的提示词把总结质量打崩。
        if (system.length > 0 && system.length < MIN_PROMPT_CHARS) {
          sendJson(res, 400, {
            ok: false,
            error: '提示词太短：至少 ' + MIN_PROMPT_CHARS + ' 字符（留空表示恢复默认）',
            minChars: MIN_PROMPT_CHARS,
          })
          return
        }
        // 与内置默认逐字相同就存空串，让 isDefault 保持 true，避免出现
        // 「内容一样但被当成自定义」的状态。
        const stored = isBuiltinPrompt(kind, system) ? '' : system
        const applied = applyPrompt(kind, stored)
        if (!applied.ok) {
          sendJson(res, 400, { ok: false, error: applied.errors.join('；'), configErrors: applied.errors })
          return
        }
        sendJson(res, 200, {
          ok: true,
          kind,
          // 与 GET /prompt 保持同一套语义：system = 落盘的原样值（空串 = 用默认）。
          system: stored,
          effective: stored || defaultPromptOf(kind),
          isDefault: !stored,
          length: stored.length,
          maxChars: MAX_PROMPT_CHARS,
          minChars: MIN_PROMPT_CHARS,
          defaultPrompt: defaultPromptOf(kind),
          restarts: runtime.restarts,
          configErrors: runtime.errors,
          droppedFields: [],
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    if (pathname === '/api/qq-digest/prompt/reset' && req.method === 'POST') {
      try {
        // 只重置指定的那一套；body.kind / ?kind= 缺省为 summary。
        let body = {}
        try {
          const raw = await readBody(req, 256 * 1024)
          body = raw ? JSON.parse(raw) : {}
        } catch {
          body = {}
        }
        const kind = promptKind(body && body.kind != null ? body.kind : query('kind'))
        const applied = applyPrompt(kind, '')
        if (!applied.ok) {
          sendJson(res, 400, { ok: false, error: applied.errors.join('；'), configErrors: applied.errors })
          return
        }
        sendJson(res, 200, {
          ok: true,
          kind,
          isDefault: true,
          system: '',
          effective: defaultPromptOf(kind),
          defaultPrompt: defaultPromptOf(kind),
          maxChars: MAX_PROMPT_CHARS,
          minChars: MIN_PROMPT_CHARS,
          restarts: runtime.restarts,
          configErrors: runtime.errors,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    // ── 独立网页服务（lib/http，P1）─────────────────────────────
    // token 只回掩码：完整密钥只在 POST /http/token 生成的那一次返回。
    if (pathname === '/api/qq-digest/http' && req.method === 'GET') {
      sendJson(res, 200, Object.assign({ ok: true }, httpStatus()))
      return
    }

    if (pathname === '/api/qq-digest/http' && req.method === 'POST') {
      try {
        const raw = await readBody(req, 64 * 1024)
        const body = raw ? JSON.parse(raw) : {}
        const incoming = body && typeof body === 'object' ? body : {}

        const rawSettings = readJson(settingsFile, {})
        const merged = Object.assign({}, rawSettings && typeof rawSettings === 'object' ? rawSettings : {})
        const nextHttp = Object.assign({}, merged.httpServer && typeof merged.httpServer === 'object' ? merged.httpServer : {})

        // 只接受本端点关心的字段；enabled 也在这里收，方便客户端一次性提交整张卡片。
        if (incoming.enabled !== undefined) nextHttp.enabled = incoming.enabled === true || incoming.enabled === 'true'
        if (incoming.authEnabled !== undefined) {
          nextHttp.authEnabled = incoming.authEnabled === true || incoming.authEnabled === 'true'
        }
        if (incoming.host !== undefined) nextHttp.host = String(incoming.host == null ? '' : incoming.host).trim()
        if (incoming.sessionHours !== undefined) nextHttp.sessionHours = Number(incoming.sessionHours)

        let portError = ''
        if (incoming.port !== undefined) {
          const port = Math.trunc(Number(incoming.port))
          if (!Number.isFinite(port) || port < 1024 || port > 65535) {
            sendJson(res, 400, { ok: false, error: '端口必须是 1024-65535 之间的整数', field: 'httpServer.port' })
            return
          }
          // 端口变了才探测：同端口重复保存不该因为「自己已经占着」而失败。
          const previousPort = Number(runtime.cfg && runtime.cfg.httpServer ? runtime.cfg.httpServer.port : 0)
          const willListen = nextHttp.enabled === undefined
            ? Boolean(runtime.cfg && runtime.cfg.httpServer && runtime.cfg.httpServer.enabled)
            : nextHttp.enabled
          if (willListen && port !== previousPort) {
            const probe = await probePort(port, String(nextHttp.host || (runtime.cfg.httpServer || {}).host || '0.0.0.0'))
            if (!probe.ok) {
              // 端口被占用不算「保存失败」：配置照存，把 error 带回去让设置页显示。
              portError = probe.error || '端口不可用'
            }
          }
          nextHttp.port = port
        }

        // token：不传 / 空串 = 保持不变；__REGEN__ = 重新生成。
        let plainToken = ''
        if (incoming.token !== undefined) {
          const value = String(incoming.token == null ? '' : incoming.token)
          if (value === TOKEN_REGEN) {
            plainToken = generateToken()
            nextHttp.token = plainToken
          } else if (value.trim() && !looksMasked(value)) {
            // 传了明文就当成新密钥；传掩码值说明用户没改，忽略。
            nextHttp.token = value.trim()
            plainToken = nextHttp.token
          }
        }

        merged.httpServer = nextHttp
        const result = runtime.reconfigure(deepMerge(baseConfig, merged))
        if (!result.ok) {
          sendJson(res, 400, {
            ok: false,
            error: (result.errors || []).join('；'),
            configErrors: result.errors,
          })
          return
        }
        writeJsonAtomic(settingsFile, merged)
        // 配置变了就按新端口/开关重启监听（异步，不阻塞这次响应）。
        restartHttp()

        const payload = Object.assign({ ok: true, restarts: runtime.restarts, configErrors: runtime.errors }, httpStatus())
        if (portError) payload.error = portError
        // 明文只在「这一次重新生成」的响应里出现，前端必须立刻提示用户保存。
        if (plainToken) payload.token = plainToken
        sendJson(res, 200, payload)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    if (pathname === '/api/qq-digest/http/token' && req.method === 'POST') {
      try {
        const rawSettings = readJson(settingsFile, {})
        const merged = Object.assign({}, rawSettings && typeof rawSettings === 'object' ? rawSettings : {})
        const nextHttp = Object.assign({}, merged.httpServer && typeof merged.httpServer === 'object' ? merged.httpServer : {})
        const token = generateToken()
        nextHttp.token = token
        merged.httpServer = nextHttp
        const result = runtime.reconfigure(deepMerge(baseConfig, merged))
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: (result.errors || []).join('；'), configErrors: result.errors })
          return
        }
        writeJsonAtomic(settingsFile, merged)
        // 换密钥不需要重连，但保持与 /http 一致的行为：配置变了就重新按配置起一遍。
        restartHttp()
        sendJson(res, 200, Object.assign({ ok: true, token }, httpStatus()))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'unknown route' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/qq-digest', handler }), 'qq-digest: api routes')

  ctx.effect(
    () => () => {
      try {
        runtime.stop()
      } catch {
        /* 卸载时尽力而为 */
      }
      // 独立网页服务必须显式关：它自己 createServer，不归 runtime.stop() 管，
      // 漏掉会让插件卸载后端口一直被占着、node --test 也退不出去。
      httpStopped = true
      try {
        runtime.httpServer = null
        httpServer.stop()
      } catch {
        /* 卸载时尽力而为 */
      }
    },
    'qq-digest: teardown',
  )
}
