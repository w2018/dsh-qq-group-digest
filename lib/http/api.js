/**
 * 插件独立 HTTP 服务的 API 路由。
 *
 * 返回值语义：async (req, res, url, ctx) => boolean，true 表示「这个请求我已经处理了」，
 * 由 server.js 决定是否继续走静态文件分支。
 *
 * 鉴权：除 /api/login 外全部要有效 session；httpServer.authEnabled=false 时整体跳过。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { deepMerge } from '../config.js'
import { maskToken, looksMasked, readJson, sanitizeOverride, pickEditable, writeJsonAtomic } from '../store/settings.js'
import * as promptStore from '../summarize/prompt-store.js'
import { renderDetailedMarkdown, renderMembersSection } from '../summarize/markdown.js'
import {
  clearCookie,
  FAIL_LIMIT,
  generateToken,
  makeCookie,
  parseCookies,
  rateLimit,
  recordFailure,
  recordSuccess,
  signSession,
  verifySession,
  verifyToken,
  COOKIE_NAME,
} from './auth.js'

const MAX_PROMPT_CHARS = 20000

// 两套 system prompt：'summary'（普通总结，默认）与 'detail'（AI 精细版）。
// 用命名空间 import 而不是具名 import：精细版导出是 v0.5.0 才加的，
// 命名空间能容忍旧版本缺导出（下面每次调用都做 typeof 兜底）。
const DEFAULT_SYSTEM_PROMPT = promptStore.DEFAULT_SYSTEM_PROMPT

function promptKindOf(value) {
  const kind = String(value == null ? '' : value).trim().toLowerCase()
  return kind === 'detail' ? 'detail' : 'summary'
}

function defaultPromptOf(kind) {
  if (promptKindOf(kind) === 'detail') return String(promptStore.DEFAULT_DETAIL_SYSTEM_PROMPT || '')
  return String(DEFAULT_SYSTEM_PROMPT || '')
}

function isBuiltinPrompt(kind, text) {
  const fn = promptKindOf(kind) === 'detail' ? promptStore.isDefaultDetailPrompt : promptStore.isDefaultPrompt
  if (typeof fn !== 'function') return false
  try {
    return fn(text) === true
  } catch {
    return false
  }
}

// 与 index.js 的 MIN_PROMPT_CHARS 保持一致：下限只挡手滑提交的残缺提示词。
const MIN_PROMPT_CHARS = 10
const MAX_BODY = 256 * 1024
const SSE_INTERVAL_MS = 2000

/** 前后各保留 n 位，中间固定 ****。用于 /api/token 的脱敏展示。 */
function maskKeep(token, n) {
  const s = String(token || '')
  const keep = Math.max(0, Math.trunc(Number(n) || 4))
  if (!s) return ''
  if (s.length <= keep * 2) return '****'
  return s.slice(0, keep) + '****' + s.slice(-keep)
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 读请求体并 JSON 解析；空体返回 {}，超限或畸形抛错。 */
function readBody(req, limit) {
  const max = Math.max(1024, Math.trunc(Number(limit) || MAX_BODY))
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) {
        reject(new Error('payload too large'))
        try {
          req.destroy()
        } catch {
          /* 已经断了 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('body 不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  res.end(body)
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
}

/**
 * 组装 API 路由。
 *
 * deps:
 *   getRuntime()          → Runtime
 *   logStore              → LogStore
 *   settingsFile          → settings.json 绝对路径
 *   pluginRoot            → 插件根目录
 *   writeSettings(patch)  → 保存设置覆盖（可选；缺省时直接改 settings.json）
 *   applySettings(patch)  → 保存并热重载（可选；缺省时尝试 runtime.reconfigure）
 *   logger
 *   httpServer            → HttpServer 实例（用于 status 与重启）
 */
export function createApiRouter(deps) {
  const d = deps || {}
  const getRuntime = typeof d.getRuntime === 'function' ? d.getRuntime : () => null
  const logStore = d.logStore || null
  const settingsFile = d.settingsFile || ''
  const logger = d.logger || null
  const httpServer = d.httpServer || null

  const runtime = () => {
    const rt = getRuntime()
    if (!rt) throw new Error('插件运行态不可用')
    return rt
  }

  /** 原始 settings.json（不做白名单过滤，prompt.token 等字段靠它）。 */
  const readRaw = () => {
    const raw = settingsFile ? readJson(settingsFile, {}) : {}
    return isPlainObject(raw) ? raw : {}
  }

  /** 直接落盘 settings.json（用于白名单外的字段，如 prompt.system / httpServer.token）。 */
  const writeRaw = (next) => {
    if (!settingsFile) return false
    writeJsonAtomic(settingsFile, next)
    return true
  }

  /** 保存并让运行态生效。返回 { ok, errors }。 */
  const applySettings = (patch) => {
    if (typeof d.applySettings === 'function') {
      try {
        const r = d.applySettings(patch)
        return r && typeof r === 'object' ? r : { ok: true, errors: [] }
      } catch (error) {
        return { ok: false, errors: [error && error.message ? error.message : String(error)] }
      }
    }
    if (typeof d.writeSettings === 'function') {
      try {
        d.writeSettings(patch)
      } catch (error) {
        return { ok: false, errors: [error && error.message ? error.message : String(error)] }
      }
    } else {
      try {
        writeRaw(deepMerge(readRaw(), patch))
      } catch (error) {
        return { ok: false, errors: [error && error.message ? error.message : String(error)] }
      }
    }
    const rt = getRuntime()
    if (rt && typeof rt.reconfigure === 'function') {
      try {
        const result = rt.reconfigure(deepMerge(rt.rawConfig || {}, patch))
        return { ok: result.ok !== false, errors: result.errors || [] }
      } catch (error) {
        return { ok: false, errors: [error && error.message ? error.message : String(error)] }
      }
    }
    return { ok: true, errors: [] }
  }

  /** 当前 httpServer 配置段（含可能的惰性生成 token）。 */
  const httpCfg = () => {
    const rt = getRuntime()
    const cfg = rt && rt.cfg ? rt.cfg : null
    const section = cfg && isPlainObject(cfg.httpServer) ? cfg.httpServer : {}
    return {
      enabled: section.enabled === true,
      port: Math.trunc(Number(section.port) || 1213),
      host: String(section.host || '0.0.0.0'),
      authEnabled: section.authEnabled !== false,
      token: String(section.token || ''),
      sessionHours: Math.max(1, Math.trunc(Number(section.sessionHours) || 168)),
    }
  }

  const hasSession = (ctx) => {
    const cfg = httpCfg()
    if (!cfg.authEnabled) return true
    if (!cfg.token) return false
    const cookies = parseCookies(ctx.cookies)
    return verifySession(cookies[COOKIE_NAME], cfg.token)
  }

  /** 群号 → 历史目录。 */
  const summariesDir = () => {
    const rt = getRuntime()
    const root = rt && rt.rootDir ? rt.rootDir : ''
    return root ? join(root, 'summaries') : ''
  }

  /** 列出所有有历史的群号。 */
  const listSummaryGroups = () => {
    const dir = summariesDir()
    if (!dir) return []
    try {
      return readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5))
    } catch {
      return []
    }
  }

  const loadGroupEntries = (groupId) => {
    const dir = summariesDir()
    if (!dir) return []
    const parsed = readJson(join(dir, String(groupId) + '.json'), null)
    if (!parsed || !Array.isArray(parsed.entries)) return []
    return parsed.entries
  }

  /** 摘要预览：取正文前 N 个字符，压掉换行。 */
  const previewOf = (entry, limit) => {
    const text = String((entry && entry.text) || '').replace(/\s+/g, ' ').trim()
    const max = Math.max(20, Math.trunc(Number(limit) || 120))
    return text.length > max ? text.slice(0, max) + '…' : text
  }

  /** 群号 → 群名。优先群名表，其次条目自带的旧值，最后留空由前端显示群号。 */
  const groupNameOf = (groupId, entry) => {
    const rt = getRuntime()
    const store = rt && rt.groupNames && typeof rt.groupNames.get === 'function' ? rt.groupNames : null
    let nm = ''
    if (store) {
      try {
        nm = String(store.get(groupId) || '')
      } catch {
        nm = ''
      }
    }
    return String(nm || (entry && entry.groupName) || '')
  }

  /** 取一条记录的 markdown：优先用存量 md，旧数据即时渲染补一份（零 LLM 调用）。 */
  const markdownOf = (groupId, entry) => {
    const md = String((entry && entry.md) || '')
    if (md) return md
    try {
      return renderDetailedMarkdown(Object.assign({ groupId }, entry))
    } catch {
      return ''
    }
  }

  /** 本地时间戳 YYYYMMDD-HHmm，用于导出文件名。 */
  const stampNow = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return (
      String(d.getFullYear()) +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      pad(d.getMinutes())
    )
  }

  /** 批量操作入参归一化：{ items:[{groupId,batchId}] } 或 { groupId, all:true }。 */
  const parseBatchTargets = (body) => {
    const src = isPlainObject(body) ? body : {}
    if (src.all === true) {
      const groupId = String(src.groupId == null ? '' : src.groupId).trim()
      if (!groupId) return { ok: false, error: '缺少 groupId' }
      return { ok: true, mode: 'all', groupId, items: [] }
    }
    const raw = Array.isArray(src.items) ? src.items : null
    if (!raw) return { ok: false, error: '缺少 items 或 all 标记' }
    const items = []
    const seen = new Set()
    for (const it of raw) {
      if (!isPlainObject(it)) continue
      const groupId = String(it.groupId == null ? '' : it.groupId).trim()
      const batchId = String(it.batchId == null ? '' : it.batchId).trim()
      if (!groupId || !batchId) continue
      const key = groupId + '\u0000' + batchId
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ groupId, batchId })
    }
    if (items.length === 0) return { ok: false, error: 'items 为空或格式不正确' }
    return { ok: true, mode: 'items', items }
  }

  const router = async (req, res, url, ctx) => {
    const pathname = ctx && ctx.pathname ? ctx.pathname : url.pathname
    if (!pathname.startsWith('/api/')) return false
    const method = String(req.method || 'GET').toUpperCase()

    // ── 登录：唯一的公开端点 ──────────────────────────────────
    if (pathname === '/api/login' && method === 'POST') {
      const limited = rateLimit(ctx.ip)
      if (limited.blocked) {
        sendJson(res, 429, {
          ok: false,
          error: '尝试过于频繁，请 ' + limited.retryAfterSec + ' 秒后重试',
          retryAfterSec: limited.retryAfterSec,
        })
        return true
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
        return true
      }
      const cfg = httpCfg()
      // 密钥为空（刚开启鉴权、还没生成过）时在这里惰性生成并落盘，
      // 否则用户永远登不进来。生成后立刻写回配置并热重载。
      let token = cfg.token
      if (!token) {
        token = generateToken()
        try {
          writeRaw(deepMerge(readRaw(), { httpServer: { token } }))
        } catch {
          /* 落盘失败也先用内存里的值，本次登录仍可完成 */
        }
        applySettings({ httpServer: { token } })
      }
      if (!verifyToken(body && body.token, token)) {
        const after = recordFailure(ctx.ip)
        sendJson(res, after.blocked ? 429 : 401, {
          ok: false,
          error: after.blocked
            ? '已连续失败 ' + FAIL_LIMIT + ' 次，请 ' + after.retryAfterSec + ' 秒后重试'
            : '密钥不正确',
          retryAfterSec: after.retryAfterSec || 0,
        })
        return true
      }
      recordSuccess(ctx.ip)
      res.setHeader('set-cookie', makeCookie(signSession(token, cfg.sessionHours), cfg.sessionHours))
      sendJson(res, 200, { ok: true })
      return true
    }

    // ── 鉴权中间件 ────────────────────────────────────────────
    if (!hasSession(ctx)) {
      // 浏览器直接访问页面时给 302，fetch 拿 401。
      const wantsHtml = String(req.headers.accept || '').includes('text/html')
      if (wantsHtml && method === 'GET') {
        redirect(res, '/login')
        return true
      }
      sendJson(res, 401, { ok: false, error: '未登录', needLogin: true })
      return true
    }

    // ── 退出登录 ──────────────────────────────────────────────
    if (pathname === '/api/logout' && method === 'POST') {
      res.setHeader('set-cookie', clearCookie())
      sendJson(res, 200, { ok: true })
      return true
    }

    // ── 状态 ──────────────────────────────────────────────────
    if (pathname === '/api/status' && method === 'GET') {
      const rt = getRuntime()
      sendJson(res, 200, {
        ok: true,
        runtime: rt && typeof rt.status === 'function' ? rt.status() : null,
        http: httpServer && typeof httpServer.status === 'function' ? httpServer.status() : null,
        logs: logStore && typeof logStore.stats === 'function' ? logStore.stats() : null,
      })
      return true
    }

    // ── 设置 ──────────────────────────────────────────────────
    if (pathname === '/api/settings' && method === 'GET') {
      const rt = runtime()
      const editable = pickEditable(rt.cfg)
      const overlay = readRaw()
      const section = isPlainObject(editable.httpServer) ? editable.httpServer : {}
      sendJson(res, 200, {
        ok: true,
        settings: Object.assign({}, editable, {
          napcat: Object.assign({}, editable.napcat, { token: maskToken(editable.napcat && editable.napcat.token) }),
          httpServer: Object.assign({}, section, {
            token: maskKeep(httpCfg().token, 4),
            tokenSet: Boolean(httpCfg().token),
          }),
        }),
        overridden: Object.keys(sanitizeOverride(overlay).override),
        settingsFile,
        defaults: {
          threshold: 100,
          freezeGraceMs: 2000,
          maxBuffer: 500,
          maxWaitMs: 3600000,
          maxTokens: 1200,
          temperature: 0.3,
          timeoutMs: 120000,
          retries: 3,
          maxCharsPerMessage: 1800,
          aggregateWindowMs: 5000,
          keepDays: 7,
          historyCount: 1,
          maxHistoryChars: 2000,
          httpPort: 1213,
          sessionHours: 168,
        },
      })
      return true
    }

    if (pathname === '/api/settings' && method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
        return true
      }
      const incoming = isPlainObject(body.settings) ? body.settings : body
      const cleaned = sanitizeOverride(incoming)
      // 提交上来的脱敏 token 说明用户没改，不能把 **** 写进配置。
      if (cleaned.override.napcat && looksMasked(cleaned.override.napcat.token)) {
        delete cleaned.override.napcat.token
      }
      const result = applySettings(cleaned.override)
      if (!result.ok) {
        sendJson(res, 400, {
          ok: false,
          error: (result.errors || []).join('；') || '配置校验未通过',
          configErrors: result.errors || [],
          droppedFields: cleaned.dropped,
        })
        return true
      }
      // 端口/监听地址变了，HTTP 服务要按新配置重来一次。
      const touchedHttp = cleaned.override.httpServer && Object.keys(cleaned.override.httpServer).length > 0
      if (touchedHttp && httpServer && typeof httpServer.start === 'function') {
        setImmediate(() => {
          httpServer.start().catch(() => {})
        })
      }
      sendJson(res, 200, {
        ok: true,
        reloaded: true,
        droppedFields: cleaned.dropped,
        configErrors: result.errors || [],
        restarts: (getRuntime() && getRuntime().restarts) || 0,
      })
      return true
    }

    if (pathname === '/api/settings/reset' && method === 'POST') {
      // 只清「可编辑白名单」覆盖项。prompt.system 与 httpServer.token 不在白名单里，
      // 它们是独立维护的状态（重置配置不该顺手把提示词和登录密钥一起清掉）。
      const current = readRaw()
      const preserved = {}
      if (current.prompt !== undefined) preserved.prompt = current.prompt
      if (isPlainObject(current.httpServer) && current.httpServer.token !== undefined) {
        preserved.httpServer = { token: current.httpServer.token }
      }
      try {
        writeRaw(preserved)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message })
        return true
      }
      const result = applySettings(preserved)
      sendJson(res, 200, {
        ok: result.ok !== false,
        configErrors: result.errors || [],
        preserved: Object.keys(preserved),
      })
      return true
    }

    // ── AI 提示词（独立于 settings 白名单） ───────────────────
    if (pathname === '/api/prompt' && method === 'GET') {
      // ?kind=summary|detail：普通总结 / AI 精细版两套提示词各存各的。
      const kind = promptKindOf(url.searchParams.get('kind'))
      const field = kind === 'detail' ? 'detailSystem' : 'system'
      const rt = getRuntime()
      const cfg = rt && rt.cfg ? rt.cfg : {}
      const system = String((cfg.prompt && cfg.prompt[field]) || '')
      const fallback = defaultPromptOf(kind)
      sendJson(res, 200, {
        ok: true,
        kind,
        system,
        // effective 才是真正送给模型的 system prompt（空 → 内置默认）。
        effective: system || fallback,
        // 与 index.js 的 GET /prompt 同口径：只看落盘值是否为空。内容恰好等于内置默认的
        // 情况在写入时已经被归一成空串（见下方 POST），不会走到这里。
        isDefault: !system,
        defaultPrompt: fallback,
        maxChars: MAX_PROMPT_CHARS,
        minChars: MIN_PROMPT_CHARS,
      })
      return true
    }

    if (pathname === '/api/prompt' && method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
        return true
      }
      const kind = promptKindOf(body && body.kind != null ? body.kind : url.searchParams.get('kind'))
      const field = kind === 'detail' ? 'detailSystem' : 'system'
      // 与 index.js 的 POST /prompt 对齐：落盘前统一 trim，避免两个入口写出的
      // settings.json 形状不一致（同一份提示词走 DSH 设置页会丢首尾空白、走网页端却保留）。
      const system = String(body && body.system == null ? '' : body.system).trim()
      if (system.length > MAX_PROMPT_CHARS) {
        sendJson(res, 400, {
          ok: false,
          error: '提示词超过 ' + MAX_PROMPT_CHARS + ' 字符（当前 ' + system.length + '）',
          maxChars: MAX_PROMPT_CHARS,
        })
        return true
      }
      // 长度语义：空 = 用默认；否则至少 MIN_PROMPT_CHARS 字符，避免误存半句话。
      if (system.trim().length > 0 && system.trim().length < MIN_PROMPT_CHARS) {
        sendJson(res, 400, {
          ok: false,
          error: '自定义提示词至少 ' + MIN_PROMPT_CHARS + ' 字符（或留空使用默认）',
          maxChars: MAX_PROMPT_CHARS,
          minChars: MIN_PROMPT_CHARS,
        })
        return true
      }
      // 与 index.js 一致：与内置默认逐字相同就存空串，让 isDefault 保持 true，
      // 避免出现「内容一样但被当成自定义」的状态。
      const stored = isBuiltinPrompt(kind, system) ? '' : system
      const patch = {}
      patch[field] = stored
      const next = deepMerge(readRaw(), { prompt: patch })
      try {
        writeRaw(next)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message })
        return true
      }
      const result = applySettings({ prompt: patch })
      const fallback = defaultPromptOf(kind)
      sendJson(res, 200, {
        ok: result.ok !== false,
        kind,
        // system = 落盘的原样值（空串 = 用内置默认），与 index.js 的 POST 语义一致。
        system: stored,
        effective: stored || fallback,
        isDefault: !stored,
        defaultPrompt: fallback,
        maxChars: MAX_PROMPT_CHARS,
        minChars: MIN_PROMPT_CHARS,
        configErrors: result.errors || [],
      })
      return true
    }

    if (pathname === '/api/prompt/reset' && method === 'POST') {
      // 只重置指定的那一套（body.kind / ?kind= 缺省 summary），另一套保持不动。
      // readBody 已经把 JSON 解析成对象了，这里不要再 JSON.parse 一次。
      let body = {}
      try {
        const raw = await readBody(req)
        body = isPlainObject(raw) ? raw : {}
      } catch {
        body = {}
      }
      const kind = promptKindOf(body && body.kind != null ? body.kind : url.searchParams.get('kind'))
      const field = kind === 'detail' ? 'detailSystem' : 'system'
      const patch = {}
      patch[field] = ''
      const next = deepMerge(readRaw(), { prompt: patch })
      try {
        writeRaw(next)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message })
        return true
      }
      const result = applySettings({ prompt: patch })
      const fallback = defaultPromptOf(kind)
      sendJson(res, 200, {
        ok: result.ok !== false,
        kind,
        system: '',
        effective: fallback,
        isDefault: true,
        defaultPrompt: fallback,
        maxChars: MAX_PROMPT_CHARS,
        minChars: MIN_PROMPT_CHARS,
        configErrors: result.errors || [],
      })
      return true
    }

    // ── 日志 ──────────────────────────────────────────────────
    if (pathname === '/api/logs' && method === 'GET') {
      if (!logStore) {
        sendJson(res, 200, { ok: true, entries: [], stats: null })
        return true
      }
      const q = url.searchParams
      const entries = logStore.recent({
        level: q.get('level') || '',
        groupId: q.get('groupId') || '',
        keyword: q.get('keyword') || '',
        since: q.get('since') || '',
        until: q.get('until') || '',
        limit: q.get('limit') || 200,
      })
      sendJson(res, 200, { ok: true, entries, stats: logStore.stats() })
      return true
    }

    if (pathname === '/api/logs/stream' && method === 'GET') {
      if (!logStore) {
        sendJson(res, 503, { ok: false, error: '日志服务不可用' })
        return true
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      let cursor = Math.max(0, Math.trunc(Number(url.searchParams.get('since')) || logStore.stats().lastSeq))
      res.write('retry: 3000\n\n')
      if (httpServer && typeof httpServer.addSseClient === 'function') httpServer.addSseClient(res)

      const push = () => {
        try {
          const batch = logStore
            .recent({ limit: 500 })
            .filter((e) => e.seq > cursor)
            .sort((a, b) => a.seq - b.seq)
          if (batch.length > 0) {
            cursor = batch[batch.length - 1].seq
            res.write('data: ' + JSON.stringify({ entries: batch, stats: logStore.stats() }) + '\n\n')
          } else {
            res.write(': keep-alive\n\n')
          }
        } catch {
          /* 写失败由 close 清理 */
        }
      }

      const timer = setInterval(push, SSE_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
      const cleanup = () => {
        clearInterval(timer)
        if (httpServer && typeof httpServer.removeSseClient === 'function') httpServer.removeSseClient(res)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      push()
      return true
    }

    // ── 总结记录 ──────────────────────────────────────────────
    if (pathname === '/api/summaries' && method === 'GET') {
      const q = url.searchParams
      const groupFilter = String(q.get('groupId') || '').trim()
      const keyword = String(q.get('keyword') || '').trim().toLowerCase()
      const limit = Math.max(1, Math.min(200, Math.trunc(Number(q.get('limit')) || 30)))
      const offset = Math.max(0, Math.trunc(Number(q.get('offset')) || 0))

      const groups = listSummaryGroups()
      const targets = groupFilter ? groups.filter((g) => g === groupFilter) : groups
      const all = []
      for (const gid of targets) {
        for (const entry of loadGroupEntries(gid)) {
          all.push({ groupId: gid, entry })
        }
      }
      const filtered = keyword
        ? all.filter(({ entry }) => {
            const hay = (String(entry.text || '') + ' ' + String(entry.batchId || '')).toLowerCase()
            return hay.includes(keyword)
          })
        : all
      filtered.sort((a, b) => (Number(b.entry.at) || 0) - (Number(a.entry.at) || 0))
      const page = filtered.slice(offset, offset + limit)
      sendJson(res, 200, {
        ok: true,
        total: filtered.length,
        offset,
        limit,
        groups,
        items: page.map(({ groupId, entry }) => ({
          groupId,
          groupName: groupNameOf(groupId, entry),
          batchId: String(entry.batchId || ''),
          at: Number(entry.at) || 0,
          count: Number(entry.count) || 0,
          ok: entry.ok === true,
          delivered: Number(entry.delivered) || 0,
          failed: Number(entry.failed) || 0,
          model: String(entry.model || ''),
          aiDetail: entry.aiDetail === true,
          preview: previewOf(entry, 120),
        })),
      })
      return true
    }

    // /api/summaries/:groupId/:batchId
    const summaryMatch = /^\/api\/summaries\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (summaryMatch && method === 'GET') {
      const groupId = decodeURIComponent(summaryMatch[1])
      const batchId = decodeURIComponent(summaryMatch[2])
      const entries = loadGroupEntries(groupId)
      const found = entries.find((e) => String(e.batchId || '') === batchId)
      if (!found) {
        sendJson(res, 404, { ok: false, error: '没有这条总结记录' })
        return true
      }
      const md = markdownOf(groupId, found)
      sendJson(res, 200, {
        ok: true,
        item: Object.assign({}, found, { groupId, batchId, groupName: groupNameOf(groupId, found), md }),
      })
      return true
    }

    // ── 总结记录：批量删除 ────────────────────────────────────
    if (pathname === '/api/summaries/delete' && method === 'POST') {
      let body
      try {
        body = await readBody(req, MAX_BODY)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
        return true
      }
      const targets = parseBatchTargets(body)
      if (!targets.ok) {
        sendJson(res, 400, { ok: false, error: targets.error })
        return true
      }
      const rt = getRuntime()
      const history = rt && rt.history && typeof rt.history.remove === 'function' ? rt.history : null
      if (!history) {
        sendJson(res, 400, { ok: false, error: '历史存储不可用' })
        return true
      }
      let deleted = 0
      try {
        if (targets.mode === 'all') {
          deleted = Math.trunc(Number(history.removeAll(targets.groupId)) || 0)
        } else {
          for (const item of targets.items) {
            // 单条删不掉（已被删过 / batchId 不匹配）不算错误，只是不计数。
            if (history.remove(item.groupId, item.batchId) === true) deleted += 1
          }
        }
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
        return true
      }
      sendJson(res, 200, { ok: true, deleted })
      return true
    }

    // ── 总结记录：批量导出为一份 markdown ─────────────────────
    if (pathname === '/api/summaries/export' && method === 'POST') {
      let body
      try {
        body = await readBody(req, MAX_BODY)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
        return true
      }
      const targets = parseBatchTargets(body)
      if (!targets.ok) {
        sendJson(res, 400, { ok: false, error: targets.error })
        return true
      }
      // 导出只支持逐条选，不支持整群 all（整群导出请分页拉 /api/summaries）。
      if (targets.mode !== 'items') {
        sendJson(res, 400, { ok: false, error: '导出需要 items 列表' })
        return true
      }
      const cache = new Map()
      const entriesOf = (groupId) => {
        if (!cache.has(groupId)) cache.set(groupId, loadGroupEntries(groupId))
        return cache.get(groupId)
      }
      const blocks = []
      for (const item of targets.items) {
        const found = entriesOf(item.groupId).find((e) => String(e.batchId || '') === item.batchId)
        if (!found) continue
        // 注释行便于把导出的片段按群号/批次号回溯到原始记录。
        // 成员表不进 entry.md（网页详情页自己有一份），只有导出时才追加，
        // 这样导出的 .md 仍是自解释的完整文档且不会出现重复的两份。
        let members = ''
        try {
          members = renderMembersSection(found.participants)
        } catch {
          members = ''
        }
        blocks.push(
          '<!-- ' + item.groupId + ' ' + item.batchId + ' -->' + '\n' + markdownOf(item.groupId, found) + members,
        )
      }
      if (blocks.length === 0) {
        sendJson(res, 404, { ok: false, error: '没有可导出的记录' })
        return true
      }
      sendJson(res, 200, {
        ok: true,
        count: blocks.length,
        markdown: blocks.join('\n\n---\n\n'),
        filename: 'qq-digest-export-' + stampNow() + '.md',
      })
      return true
    }

    // ── NapCat 数据源 ─────────────────────────────────────────
    if (pathname === '/api/groups' && method === 'GET') {
      const rt = runtime()
      let available = []
      let error = ''
      try {
        if (rt.actions) available = await rt.actions.groupList()
      } catch (e) {
        error = e && e.message ? e.message : String(e)
      }
      sendJson(res, 200, {
        ok: true,
        listening: Array.isArray(rt.cfg.listen.groups) ? rt.cfg.listen.groups : [],
        available: (available || []).map((g) => ({
          groupId: String(g.group_id),
          groupName: String(g.group_name || ''),
          memberCount: g.member_count != null ? Number(g.member_count) : null,
        })),
        error,
      })
      return true
    }

    if (pathname === '/api/friends' && method === 'GET') {
      const rt = runtime()
      let available = []
      let error = ''
      try {
        if (rt.actions) available = await rt.actions.friendList()
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
      return true
    }

    if (pathname === '/api/members' && method === 'GET') {
      const rt = runtime()
      const groupId = String(url.searchParams.get('groupId') || '').trim()
      if (!groupId) {
        sendJson(res, 400, { ok: false, error: '缺少 groupId' })
        return true
      }
      let members = []
      let error = ''
      try {
        if (rt.actions && typeof rt.actions.groupMemberList === 'function') {
          members = await rt.actions.groupMemberList(groupId)
        } else {
          error = 'NapCat 未连接，无法获取成员列表'
        }
      } catch (e) {
        error = e && e.message ? e.message : String(e)
      }
      sendJson(res, 200, {
        ok: true,
        groupId,
        members: (members || []).map((m) => ({
          userId: String(m.user_id),
          nickname: String(m.nickname || m.card || ''),
          card: String(m.card || ''),
        })),
        error,
      })
      return true
    }

    if (pathname === '/api/models' && method === 'GET') {
      const rt = getRuntime()
      const out = { ok: true, providers: [], current: null, error: '' }
      try {
        const ctx = rt && rt.ctx ? rt.ctx : null
        const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null
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
            out.providers.push({
              id: String(p.id),
              label: String(p.label || p.name || p.id),
              models: models.map((m) => ({ id: String(m.id), label: String(m.label || m.name || m.id) })),
            })
          }
        }
        const cfgModel = rt && rt.cfg ? rt.cfg.model : null
        if (cfgModel && cfgModel.provider && cfgModel.model) {
          out.current = { provider: cfgModel.provider, model: cfgModel.model }
        }
      } catch (error) {
        out.error = error && error.message ? error.message : String(error)
      }
      sendJson(res, 200, out)
      return true
    }

    // ── 动作 ──────────────────────────────────────────────────
    if (pathname === '/api/test' && method === 'POST') {
      const rt = runtime()
      let body = {}
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
        return true
      }
      const friends =
        Array.isArray(body.friends) && body.friends.length > 0 ? body.friends.map(String) : rt.cfg.delivery.friends
      if (!friends || friends.length === 0) {
        sendJson(res, 400, { ok: false, error: '没有可用的好友：先配置 delivery.friends' })
        return true
      }
      try {
        const results = await rt.sendTest(friends, body.text ? String(body.text) : '[qq-digest] 测试消息：通道正常。')
        sendJson(res, 200, { ok: results.some((r) => r.ok), results })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return true
    }

    if (pathname === '/api/flush' && method === 'POST') {
      const rt = runtime()
      try {
        const delivery = await rt.flushAll()
        sendJson(res, 200, {
          ok: true,
          delivered: delivery ? delivery.result.delivered.length : 0,
          failed: delivery ? delivery.result.failed.length : 0,
          segments: delivery ? delivery.result.segments : 0,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
      return true
    }

    // ── 密钥 ──────────────────────────────────────────────────
    if (pathname === '/api/token' && method === 'GET') {
      const cfg = httpCfg()
      sendJson(res, 200, {
        ok: true,
        tokenMasked: maskKeep(cfg.token, 4),
        tokenSet: Boolean(cfg.token),
        authEnabled: cfg.authEnabled,
        sessionHours: cfg.sessionHours,
      })
      return true
    }

    if (pathname === '/api/token/generate' && method === 'POST') {
      const token = generateToken()
      const next = deepMerge(readRaw(), { httpServer: { token } })
      try {
        writeRaw(next)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message })
        return true
      }
      const result = applySettings({ httpServer: { token } })
      // 明文只在这一刻返回一次；之后只能看脱敏值。
      sendJson(res, 200, {
        ok: result.ok !== false,
        token,
        tokenMasked: maskKeep(token, 4),
        configErrors: result.errors || [],
      })
      // 旧 session 因为签名密钥变了会全部失效，服务按新配置重启一次。
      if (httpServer && typeof httpServer.start === 'function') {
        setImmediate(() => {
          httpServer.start().catch(() => {})
        })
      }
      return true
    }

    // 未匹配的 /api/* 一律 404，不再落到静态分支。
    sendJson(res, 404, { ok: false, error: 'unknown api route' })
    return true
  }

  router.log = logger
  return router
}
