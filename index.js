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
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadGeneration } from './lib/hot.js'

import { deepMerge, storageRoot } from './lib/config.js'
import {
  pickEditable,
  readSettings,
  writeSettings,
  sanitizeOverride,
  maskToken,
  looksMasked,
} from './lib/store/settings.js'
import { Runtime } from './lib/runtime.js'
import { getSvc } from './lib/summarize/summarize.js'

export const name = 'qq-group-digest'

/**
 * 后端代码版本：只在 index.js / 路由层 / lib 契约发生「热重载换不掉」的改动时递增。
 * 设置页拿它和前端期望值比对，不一致就提示「后端是旧代码，需重启 DSH」——
 * 因为热重载只替换 Runtime，不重新 import index.js 的路由表。
 */
const BACKEND_VERSION = 3

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

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx, config = {}) {
  const baseConfig = config || {}
  const logger = ctx.logger || null
  const settingsFile = join(storageRoot(baseConfig.storage ? baseConfig.storage : {}), 'settings.json')

  /** patch 初始值 + UI 覆盖 = 最终生效配置。 */
  const effectiveConfig = () => deepMerge(baseConfig, readSettings(settingsFile))

  // let 而非 const：/reload 会用「新一代代码」里导出的 Runtime 整体替换掉它。
  let runtime = new Runtime({
    ctx,
    logger,
    rawConfig: effectiveConfig(),
  })
  runtime.start()

  const pluginRoot = dirname(fileURLToPath(import.meta.url))

  if (runtime.errors.length > 0) {
    logger?.warn?.('[qq-digest] ' + runtime.startError + '（status 与设置页仍可访问，请在设置页补全配置）')
  }

  // ── HTTP 路由 ──────────────────────────────────────────────────
  const handler = async (req, res) => {
    let pathname = '/'
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
    } catch {
      /* 畸形 URL 落 404 */
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
        settingsFile,
        backendVersion: BACKEND_VERSION,
        // 前端据此判断后端是否支持「信息过滤」等新能力，缺字段时自动降级提示。
        capabilities: ['settings', 'groups', 'friends', 'members', 'recent', 'flush', 'reload'],
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
        const result = runtime.reconfigure(deepMerge(baseConfig, {}))
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
    },
    'qq-digest: teardown',
  )
}
