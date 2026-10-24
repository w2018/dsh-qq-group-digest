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

  cfg.ui = isPlainObject(cfg.ui) ? cfg.ui : { sidebarEntry: false }
  cfg.ui.sidebarEntry = cfg.ui.sidebarEntry === true

  cfg.dryRun = cfg.dryRun === true

  return { config: cfg, errors }
}