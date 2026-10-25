import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 86400000
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 毫秒时间戳 → 本地时区的 YYYY-MM-DD。 */
export function dayKey(ms) {
  const d = new Date(Number(ms) || Date.now())
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** YYYY-MM-DD → 该日本地 00:00:00 的毫秒时间戳；非法返回 NaN。 */
function dayStartMs(day) {
  const m = FILE_RE.exec(day + '.jsonl')
  if (!m) return NaN
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isFinite(t) ? t : NaN
}

function normalizeLevel(value, fallback) {
  const s = String(value == null ? '' : value).trim().toLowerCase()
  if (s === 'debug' || s === 'info' || s === 'warn' || s === 'error') return s
  if (s === 'warning') return 'warn'
  if (s === 'err' || s === 'fatal') return 'error'
  return fallback === undefined ? 'info' : fallback
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function toMs(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function hitKeyword(entry, keyword) {
  if (String(entry.msg || '').toLowerCase().includes(keyword)) return true
  if (String(entry.scope || '').toLowerCase().includes(keyword)) return true
  if (String(entry.groupId || '').toLowerCase().includes(keyword)) return true
  try {
    return JSON.stringify(entry.extra || {}).toLowerCase().includes(keyword)
  } catch {
    return false
  }
}

/**
 * 日志缓冲：内存环形数组 + 按天 JSONL 落盘。
 *
 * 设计取舍：
 * 1. 落盘失败绝不抛错——日志本身不能成为新的故障源，内存缓冲继续可用，
 *    失败原因记在 stats().lastError 里供页面顶部提示。
 * 2. 内存只保留最近 maxMemory 条（超出用 shift 丢掉最旧的），避免长期运行吃内存。
 * 3. 每条记录补 at（毫秒）与进程内自增 seq，seq 用于前端增量拉取与去重。
 */
export class LogStore {
  constructor(rootDir, options) {
    const opts = options || {}
    this.root = String(rootDir || '')
    this.maxMemory = Math.max(1, Math.trunc(Number(opts.maxMemory) || 2000))
    this.keepDays = Math.max(1, Math.trunc(Number(opts.keepDays) || 7))
    this.buffer = []
    this.seq = 0
    this.dropped = 0
    this.lastError = ''
    this.ensured = false
  }

  logDir() {
    return join(this.root, 'logs')
  }

  fileFor(ms) {
    return join(this.logDir(), dayKey(ms) + '.jsonl')
  }

  ensureDir() {
    if (this.ensured || !this.root) return
    mkdirSync(this.logDir(), { recursive: true })
    this.ensured = true
  }

  /**
   * 追加一条日志。返回归一化后的记录（含 at / seq）。
   * entry: { level, scope, groupId, msg, extra }
   */
  append(entry) {
    const src = isPlainObject(entry) ? entry : {}
    const at = toMs(src.at)
    this.seq += 1
    const record = {
      at: at === null ? Date.now() : at,
      seq: this.seq,
      level: normalizeLevel(src.level),
      scope: String(src.scope == null ? '' : src.scope).trim(),
      groupId: String(src.groupId == null ? '' : src.groupId).trim(),
      msg: String(src.msg == null ? '' : src.msg),
      extra: src.extra === undefined ? {} : src.extra,
    }

    this.buffer.push(record)
    while (this.buffer.length > this.maxMemory) {
      this.buffer.shift()
      this.dropped += 1
    }

    this.persist(record)
    return record
  }

  /** 只负责持久化：任何失败都吞掉并记在 lastError，不打断调用方。 */
  persist(record) {
    if (!this.root) return
    try {
      this.ensureDir()
      appendFileSync(this.fileFor(record.at), JSON.stringify(record) + '\n', 'utf8')
      this.lastError = ''
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error)
    }
  }

  /**
   * 按条件筛选，最新在前。
   * filter: { level, groupId, keyword, limit, since, until }
   */
  recent(filter) {
    const f = filter || {}
    const limit = Math.max(1, Math.trunc(Number(f.limit) || 200))
    const level = normalizeLevel(f.level, '')
    const groupId = String(f.groupId == null ? '' : f.groupId).trim()
    const keyword = String(f.keyword == null ? '' : f.keyword).trim().toLowerCase()
    const since = toMs(f.since)
    const until = toMs(f.until)

    const out = []
    for (let i = this.buffer.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const entry = this.buffer[i]
      if (level && entry.level !== level) continue
      if (groupId && entry.groupId !== groupId) continue
      if (since !== null && entry.at < since) continue
      if (until !== null && entry.at > until) continue
      if (keyword && !hitKeyword(entry, keyword)) continue
      out.push(entry)
    }
    return out
  }

  /** 供日志页展示的计数摘要。 */
  stats() {
    const byLevel = { debug: 0, info: 0, warn: 0, error: 0 }
    for (const entry of this.buffer) {
      if (byLevel[entry.level] === undefined) byLevel[entry.level] = 0
      byLevel[entry.level] += 1
    }
    const last = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null
    return {
      total: this.seq,
      memory: this.buffer.length,
      maxMemory: this.maxMemory,
      dropped: this.dropped,
      keepDays: this.keepDays,
      byLevel,
      lastAt: last ? last.at : 0,
      lastSeq: last ? last.seq : 0,
      dir: this.root ? this.logDir() : '',
      files: this.listFiles().length,
      lastError: this.lastError,
    }
  }

  listFiles() {
    if (!this.root) return []
    let names = []
    try {
      names = readdirSync(this.logDir())
    } catch {
      return []
    }
    return names.filter((n) => FILE_RE.test(n)).sort()
  }

  /**
   * 删除超过 keepDays 的 YYYY-MM-DD.jsonl。返回删除的文件数。
   * 语义：保留「今天往前 keepDays-1 天」的文件，即 keepDays=7 时保留 7 个自然日。
   */
  prune(nowMs) {
    const now = toMs(nowMs)
    const base = Number.isFinite(now) && now !== null ? now : Date.now()
    const today = new Date(base)
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const cutoff = todayStart - (this.keepDays - 1) * DAY_MS
    let removed = 0
    for (const name of this.listFiles()) {
      const start = dayStartMs(name.slice(0, 10))
      if (!Number.isFinite(start)) continue
      if (start >= cutoff) continue
      try {
        unlinkSync(join(this.logDir(), name))
        removed += 1
      } catch {
        /* 单个文件删不掉不影响其它文件 */
      }
    }
    return removed
  }

  /** 清空内存缓冲（落盘文件保留，按 keepDays 由 prune 回收）。返回被清掉的条数。 */
  clear() {
    const n = this.buffer.length
    this.buffer = []
    return n
  }
}
