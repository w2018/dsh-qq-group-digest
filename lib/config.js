import { join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULTS = {
  napcat: {
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    reconnectMs: [1000, 30000],
    callTimeoutMs: 30000,
  },
  listen: {
    groups: [],
    ignoreSelf: true,
    // 关键词过滤（模糊匹配，命中即丢弃该条消息）；空列表 = 不过滤。
    keywords: [],
    // 按成员过滤：{ 群号: [QQ 号...] }，命中的成员消息不计入总结；空 = 不过滤。
    excludedSenders: {},
  },
  batch: {
    threshold: 100,
    freezeGraceMs: 2000,
    maxBuffer: 500,
    maxWaitMs: 3600000,
    perGroupOverride: {},
  },
  model: {
    provider: '',
    model: '',
    temperature: 0.3,
    maxTokens: 1200,
    timeoutMs: 120000,
    maxInputChars: 12000,
    historyCount: 1,
    maxHistoryChars: 2000,
    retries: 3,
    backoffMs: 2000,
    fallbackToDefault: true,
  },
  delivery: {
    friends: [],
    retry: { attempts: 3, backoffMs: 2000 },
    maxCharsPerMessage: 1800,
    sendIntervalMs: 800,
    aggregateWindowMs: 5000,
  },
  storage: {
    dir: '',
    keepDays: 7,
  },
  // 插件自带的独立 HTTP 网页服务（配置页 / 日志页 / 总结记录页）。
  // 与 DSH 自带的 webServer 完全独立，自己监听端口；默认不开启。
  httpServer: {
    enabled: false,
    port: 1213,
    host: '0.0.0.0',
    authEnabled: true,
    token: '',
    sessionHours: 168,
  },
  prompt: {
    // 空 = 用内置默认提示词（lib/summarize/prompt-store.js 的 DEFAULT_SYSTEM_PROMPT）。
    system: '',
  },
  summary: {
    // AI 精细版开关：开启后每次总结额外一次 LLM 调用产出更长的结构化 Markdown。
    aiDetail: false,
  },
  ui: {
    // 是否在 DSH 主界面左侧边栏挂一个「QQ 群总结」入口行（默认关，设置页里可开）。
    sidebarEntry: false,
  },
  dryRun: false,
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = isPlainObject(base) ? Object.assign({}, base) : base
  for (const key of Object.keys(patch)) {
    const v = patch[key]
    if (v === undefined) continue
    if (isPlainObject(v) && isPlainObject(out[key])) out[key] = deepMerge(out[key], v)
    else if (Array.isArray(v) && Array.isArray(out[key]) && key !== 'groups' && key !== 'friends') out[key] = v.slice()
    else out[key] = v
  }
  return out
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function storageRoot(cfg) {
  const custom = cfg && cfg.storage ? String(cfg.storage.dir || '').trim() : ''
  return custom || join(dshHome(), 'storages', 'qq-digest')
}

export function outboxDir(cfg) {
  return join(storageRoot(cfg), 'outbox')
}

export function normalizeIdList(list) {
  const out = []
  const seen = new Set()
  const source = Array.isArray(list) ? list : []
  for (const raw of source) {
    const s = String(raw == null ? '' : raw).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function toInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.trunc(n)
}

function clamp(value, min, max, fallback) {
  const n = toInt(value, fallback)
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 合并默认值并做校验。
 * 返回 { config, errors }：errors 非空时插件不启动管线，但 status 路由仍可读。
 */
export function resolveConfig(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {})
  const errors = []

  cfg.napcat.wsUrl = String(cfg.napcat.wsUrl || '').trim()
  if (!/^wss?:\/\//i.test(cfg.napcat.wsUrl)) {
    errors.push('napcat.wsUrl 必须以 ws:// 或 wss:// 开头，当前=' + JSON.stringify(cfg.napcat.wsUrl))
  }
  cfg.napcat.callTimeoutMs = clamp(cfg.napcat.callTimeoutMs, 1000, 300000, 30000)
  const backoff = Array.isArray(cfg.napcat.reconnectMs) ? cfg.napcat.reconnectMs : []
  const minBackoff = clamp(backoff[0], 100, 600000, 1000)
  const maxBackoff = clamp(backoff[1], minBackoff, 3600000, 30000)
  cfg.napcat.reconnectMs = [minBackoff, maxBackoff]

  cfg.listen.groups = normalizeIdList(cfg.listen.groups)
  if (cfg.listen.groups.length === 0) {
    errors.push('listen.groups 不能为空：至少配置一个要监听的群号')
  }
  cfg.listen.ignoreSelf = cfg.listen.ignoreSelf !== false
  // 保留用户输入的原始大小写（UI 回显一致）；匹配时再统一转小写。
  cfg.listen.keywords = normalizeIdList(cfg.listen.keywords)

  const excluded = isPlainObject(cfg.listen.excludedSenders) ? cfg.listen.excludedSenders : {}
  const listeningSet = new Set(cfg.listen.groups)
  const normalizedExcluded = {}
  for (const key of Object.keys(excluded)) {
    // 已经不再监听的群，其排除名单一并丢弃，避免设置页残留孤儿芯片。
    if (!listeningSet.has(String(key))) continue
    const list = normalizeIdList(excluded[key])
    if (list.length > 0) normalizedExcluded[String(key)] = list
  }
  cfg.listen.excludedSenders = normalizedExcluded

  cfg.batch.threshold = clamp(cfg.batch.threshold, 1, 100000, 100)
  cfg.batch.freezeGraceMs = clamp(cfg.batch.freezeGraceMs, 0, 60000, 2000)
  cfg.batch.maxBuffer = clamp(cfg.batch.maxBuffer, 1, 100000, 500)
  cfg.batch.maxWaitMs = clamp(cfg.batch.maxWaitMs, 1000, 86400000, 3600000)
  const overrides = isPlainObject(cfg.batch.perGroupOverride) ? cfg.batch.perGroupOverride : {}
  const normalizedOverrides = {}
  for (const key of Object.keys(overrides)) {
    const entry = isPlainObject(overrides[key]) ? overrides[key] : {}
    normalizedOverrides[String(key)] = {
      threshold: clamp(entry.threshold, 1, 100000, cfg.batch.threshold),
    }
  }
  cfg.batch.perGroupOverride = normalizedOverrides

  cfg.model.provider = String(cfg.model.provider || '').trim()
  cfg.model.model = String(cfg.model.model || '').trim()
  if ((cfg.model.provider && !cfg.model.model) || (!cfg.model.provider && cfg.model.model)) {
    errors.push('model.provider 与 model.model 必须同时留空或同时填写')
  }
  cfg.model.maxTokens = clamp(cfg.model.maxTokens, 64, 32000, 1200)
  cfg.model.timeoutMs = clamp(cfg.model.timeoutMs, 5000, 600000, 120000)
  cfg.model.maxInputChars = clamp(cfg.model.maxInputChars, 500, 200000, 12000)
  cfg.model.historyCount = clamp(cfg.model.historyCount, 0, 10, 1)
  cfg.model.maxHistoryChars = clamp(cfg.model.maxHistoryChars, 0, 20000, 2000)
  cfg.model.retries = clamp(cfg.model.retries, 0, 10, 3)
  cfg.model.backoffMs = clamp(cfg.model.backoffMs, 100, 60000, 2000)
  cfg.model.temperature = Number.isFinite(Number(cfg.model.temperature))
    ? Math.min(2, Math.max(0, Number(cfg.model.temperature)))
    : 0.3
  cfg.model.fallbackToDefault = cfg.model.fallbackToDefault !== false

  cfg.delivery.friends = normalizeIdList(cfg.delivery.friends)
  if (cfg.delivery.friends.length === 0 && !cfg.dryRun) {
    errors.push('delivery.friends 不能为空：至少配置一个接收私聊的好友 QQ 号（或设置 dryRun: true）')
  }
  cfg.delivery.maxCharsPerMessage = clamp(cfg.delivery.maxCharsPerMessage, 200, 4000, 1800)
  cfg.delivery.sendIntervalMs = clamp(cfg.delivery.sendIntervalMs, 0, 60000, 800)
  cfg.delivery.aggregateWindowMs = clamp(cfg.delivery.aggregateWindowMs, 0, 600000, 5000)
  const deliveryRetry = isPlainObject(cfg.delivery.retry) ? cfg.delivery.retry : {}
  cfg.delivery.retry = {
    attempts: clamp(deliveryRetry.attempts, 1, 10, 3),
    backoffMs: clamp(deliveryRetry.backoffMs, 100, 60000, 2000),
  }

  cfg.storage.dir = String(cfg.storage.dir || '').trim()
  cfg.storage.keepDays = clamp(cfg.storage.keepDays, 1, 365, 7)

  // httpServer：默认关闭；端口/登录态有效期都 clamp，host 空串回落 0.0.0.0。
  cfg.httpServer = isPlainObject(cfg.httpServer) ? cfg.httpServer : {}
  cfg.httpServer.enabled = cfg.httpServer.enabled === true
  cfg.httpServer.port = clamp(cfg.httpServer.port, 1024, 65535, 1213)
  const host = String(cfg.httpServer.host == null ? '' : cfg.httpServer.host).trim()
  cfg.httpServer.host = host || '0.0.0.0'
  cfg.httpServer.authEnabled = cfg.httpServer.authEnabled !== false
  // 空 token 是合法状态：启用鉴权且为空时由 HTTP 服务首次启动时随机生成并落盘。
  cfg.httpServer.token = String(cfg.httpServer.token == null ? '' : cfg.httpServer.token).trim()
  cfg.httpServer.sessionHours = clamp(cfg.httpServer.sessionHours, 1, 8760, 168)

  // prompt.system：空 = 用内置默认；超长截断并报错（拒绝保存由调用方决定）。
  cfg.prompt = isPlainObject(cfg.prompt) ? cfg.prompt : {}
  const rawPrompt = String(cfg.prompt.system == null ? '' : cfg.prompt.system).trim()
  if (rawPrompt.length > 20000) {
    cfg.prompt.system = rawPrompt.slice(0, 20000)
    errors.push('prompt.system 超过 20000 字符')
  } else {
    cfg.prompt.system = rawPrompt
  }

  cfg.summary = isPlainObject(cfg.summary) ? cfg.summary : {}
  cfg.summary.aiDetail = cfg.summary.aiDetail === true

  cfg.ui = isPlainObject(cfg.ui) ? cfg.ui : { sidebarEntry: false }
  cfg.ui.sidebarEntry = cfg.ui.sidebarEntry === true

  cfg.dryRun = cfg.dryRun === true

  return { config: cfg, errors }
}