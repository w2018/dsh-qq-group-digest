import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJson(file, fallback) {
  try {
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** 原子写：先写 .tmp 再 rename，避免半截文件。 */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * UI 可编辑的配置项白名单：点分路径 → 取值类型。
 *
 * 只有这里列出的字段能被设置页读取或写入；其它字段（例如 storage.dir、
 * 重连退避、重试策略）仍由 cordis.patch.yml 决定，UI 不暴露也不允许改，
 * 避免前端一次误提交就把关键参数改坏。
 */
export const EDITABLE_FIELDS = [
  ['napcat.wsUrl', 'string'],
  ['napcat.token', 'string'],
  ['listen.groups', 'idList'],
  ['listen.ignoreSelf', 'boolean'],
  ['listen.keywords', 'stringList'],
  ['listen.excludedSenders', 'idGroupMap'],
  ['batch.threshold', 'number'],
  ['batch.freezeGraceMs', 'number'],
  ['batch.maxBuffer', 'number'],
  ['batch.maxWaitMs', 'number'],
  ['model.provider', 'string'],
  ['model.model', 'string'],
  ['model.temperature', 'number'],
  ['model.maxTokens', 'number'],
  ['model.timeoutMs', 'number'],
  ['model.retries', 'number'],
  ['model.historyCount', 'number'],
  ['model.maxHistoryChars', 'number'],
  ['delivery.friends', 'idList'],
  ['delivery.maxCharsPerMessage', 'number'],
  ['delivery.aggregateWindowMs', 'number'],
  ['storage.keepDays', 'number'],
  // 独立 HTTP 网页服务。注意 prompt.system 故意不在白名单里：它走单独的
  // /api/qq-digest/prompt 端点，避免通用保存流程把它误清空。
  ['httpServer.enabled', 'boolean'],
  ['httpServer.port', 'number'],
  ['httpServer.host', 'string'],
  ['httpServer.authEnabled', 'boolean'],
  ['httpServer.sessionHours', 'number'],
  ['summary.aiDetail', 'boolean'],
  ['ui.sidebarEntry', 'boolean'],
  ['dryRun', 'boolean'],
]

const TYPE_BY_PATH = new Map(EDITABLE_FIELDS)

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function readPath(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[p]
  }
  return cur
}

function writePath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    if (!isPlainObject(cur[key])) cur[key] = {}
    cur = cur[key]
  }
  cur[parts[parts.length - 1]] = value
}

function normalizeIds(list) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw == null ? '' : raw).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** 按类型强转；无法转换时返回 { ok: false }，由调用方丢弃该字段。 */
function coerce(type, value) {
  if (type === 'string') return { ok: true, value: String(value == null ? '' : value).trim() }
  if (type === 'boolean') return { ok: true, value: value === true || value === 'true' }
  if (type === 'idList') return { ok: true, value: normalizeIds(value) }
  if (type === 'stringList') return { ok: true, value: normalizeIds(value) }
  if (type === 'idGroupMap') {
    if (!isPlainObject(value)) return { ok: false }
    const out = {}
    for (const key of Object.keys(value)) {
      const list = normalizeIds(value[key])
      if (list.length > 0) out[String(key)] = list
    }
    return { ok: true, value: out }
  }
  if (type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return { ok: false }
    return { ok: true, value: n }
  }
  return { ok: false }
}

/** 从完整生效配置里抽出可编辑子集（供 GET 返回给 UI）。 */
export function pickEditable(cfg) {
  const out = {}
  for (const [path] of EDITABLE_FIELDS) {
    const value = readPath(cfg, path)
    if (value === undefined) continue
    writePath(out, path, value)
  }
  return out
}

/**
 * 清洗前端提交的覆盖项：只保留白名单字段，按类型强转，丢弃非法值。
 * 返回 { override, dropped }。
 */
export function sanitizeOverride(raw) {
  const dropped = []
  const out = {}
  if (!isPlainObject(raw)) return { override: out, dropped }
  for (const [path, type] of EDITABLE_FIELDS) {
    const value = readPath(raw, path)
    if (value === undefined) continue
    const got = coerce(type, value)
    if (!got.ok) {
      dropped.push(path)
      continue
    }
    writePath(out, path, got.value)
  }
  for (const key of Object.keys(raw)) {
    if (isPlainObject(raw[key])) {
      for (const sub of Object.keys(raw[key])) {
        const path = key + '.' + sub
        if (!TYPE_BY_PATH.has(path)) dropped.push(path)
      }
    } else if (!TYPE_BY_PATH.has(key)) {
      dropped.push(key)
    }
  }
  return { override: out, dropped }
}

export function readSettings(file) {
  return sanitizeOverride(readJson(file, {})).override
}

export function writeSettings(file, override) {
  writeJsonAtomic(file, override)
}

/** 脱敏：只留首尾各 2 位，中间固定 4 个星号。 */
export function maskToken(token) {
  const s = String(token || '')
  if (!s) return ''
  if (s.length <= 4) return '****'
  return s.slice(0, 2) + '****' + s.slice(-2)
}

export function looksMasked(token) {
  return String(token || '').includes('*')
}
