import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 20
const MAX_TEXT = 6000
const MAX_MD = 20000
const MAX_PARTICIPANTS = 30
const MAX_FOCUS = 40

const MEMBERS_HEADINGS = new Set(['## 参与成员', '## 三、参与成员'])
const MEMBERS_EMPTY_ROW = '（未记录）'
const STATUS_HEADING_OLD = '## 四、投递状态'
const STATUS_HEADING_NEW = '## 三、投递状态'

/**
 * 剥离历史存档正文里的「参与成员」小节。
 *
 * 背景：v0.4.x 的 entry.md 里带一份成员表，网页详情页又渲染一份，导致同一次总结
 * 里成员表出现两三次。新版本不再把成员表写进正文，但旧存档还在盘上，读盘时顺手剥掉。
 *
 * 规则必须保守（宁可少剥，不能误删正文）：
 * 1. 只认表头行完全等于 `## 参与成员` 或 `## 三、参与成员` 的小节；
 * 2. 小节范围：从表头行到下一个以 `## ` 开头的行（不含），或到文末；
 * 3. 小节内所有非空行必须「以 | 开头」或「等于 （未记录）」，否则视为普通正文，不剥离；
 * 4. 剥离后如果紧跟的是 `## 四、投递状态`，改写成 `## 三、投递状态`（补上被删掉的那一节）。
 */
export function stripMembersSection(md) {
  const text = String(md == null ? '' : md)
  if (!text || !text.includes('参与成员')) return text

  const lines = text.split('\n')
  const out = []
  let i = 0
  let changed = false
  while (i < lines.length) {
    if (!MEMBERS_HEADINGS.has(lines[i].trim())) {
      out.push(lines[i])
      i += 1
      continue
    }
    // 找到小节结束位置：下一个以「## 」开头的行，或文末。
    let end = i + 1
    while (end < lines.length && !lines[end].startsWith('## ')) end += 1
    const body = lines.slice(i + 1, end)
    const looksLikeTable = body.every((line) => {
      const t = line.trim()
      return t === '' || t.startsWith('|') || t === MEMBERS_EMPTY_ROW
    })
    if (!looksLikeTable) {
      out.push(lines[i])
      i += 1
      continue
    }
    changed = true
    // 丢掉表头行与表格行；末尾连续空行也一并吃掉，避免留下两个空行。
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
    out.push('')
    i = end
    // 紧跟的「## 四、投递状态」补成「## 三、投递状态」。
    if (i < lines.length && lines[i].trim() === STATUS_HEADING_OLD) {
      lines[i] = lines[i].replace(STATUS_HEADING_OLD, STATUS_HEADING_NEW)
    }
  }
  if (!changed) return text
  return out.join('\n')
}

/** participants 归一化：丢掉非法项，最多保留 MAX_PARTICIPANTS 个。 */
function normalizeParticipants(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const id = String(p.id == null ? '' : p.id)
    if (!id) continue
    out.push({
      id,
      name: String(p.name == null ? '' : p.name) || id,
      count: Math.max(0, Math.trunc(Number(p.count) || 0)),
      // 本次总结里该成员的发言重点，15 字以内；由 AI 精细版返回或本地截取，可能为空。
      focus: String(p.focus == null ? '' : p.focus).trim().slice(0, MAX_FOCUS),
    })
    if (out.length >= MAX_PARTICIPANTS) break
  }
  return out
}

/**
 * 每群的历史总结存档。
 *
 * 落盘位置：<storageRoot>/summaries/<群号>.json，结构 { groupId, entries: [...] }。
 * entries 按时间升序，最新一条在末尾；只保留最近 MAX_ENTRIES 条。
 *
 * P4 起条目多了几个结构化字段（participants / md / model / attempts / aiDetail），
 * 读取端一律按「缺字段 = 空值」处理，因此旧存档不需要迁移。
 *
 * 存在理由：每次总结都要把该群上一次的总结喂给模型，避免重复叙述、丢关键信息。
 */
export class SummaryHistory {
  constructor(rootDir) {
    this.root = String(rootDir || '')
    this.cache = new Map()
    this.ensured = false
  }

  fileFor(groupId) {
    return join(this.root, String(groupId) + '.json')
  }

  ensure() {
    if (this.ensured || !this.root) return
    mkdirSync(this.root, { recursive: true })
    this.ensured = true
  }

  /** 读取某群全部历史（惰性加载并缓存）。 */
  load(groupId) {
    const gid = String(groupId)
    if (this.cache.has(gid)) return this.cache.get(gid)
    let entries = []
    if (this.root) {
      try {
        const parsed = JSON.parse(readFileSync(this.fileFor(gid), 'utf8'))
        if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries
      } catch {
        entries = []
      }
    }
    // 旧存档的 md 里带着成员表，读盘时顺手剥掉（只在内存里处理，不强制回写）。
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && typeof entry.md === 'string' && entry.md) {
        entry.md = stripMembersSection(entry.md)
      }
    }
    this.cache.set(gid, entries)
    return entries
  }

  /** 最近 n 条（按时间升序返回，末尾是最新）。 */
  recent(groupId, n) {
    const list = this.load(groupId)
    const count = Math.max(0, Math.trunc(Number(n) || 0))
    if (count === 0) return []
    return list.slice(Math.max(0, list.length - count))
  }

  /** 上一次总结，没有则 null。 */
  latest(groupId) {
    const list = this.load(groupId)
    return list.length > 0 ? list[list.length - 1] : null
  }

  /** 追加一条总结并落盘。 */
  append(groupId, entry) {
    const gid = String(groupId)
    const list = this.load(gid)
    const text = String((entry && entry.text) || '')
    const md = String((entry && entry.md) || '')
    const item = {
      at: Math.trunc(Number(entry && entry.at) || Math.trunc(Date.now() / 1000)),
      batchId: String((entry && entry.batchId) || ''),
      groupName: String((entry && entry.groupName) || ''),
      count: Math.trunc(Number(entry && entry.count) || 0),
      firstSec: Math.trunc(Number(entry && entry.firstSec) || 0),
      lastSec: Math.trunc(Number(entry && entry.lastSec) || 0),
      ok: entry && entry.ok === true,
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…(截断)' : text,
      delivered: 0,
      failed: 0,
      outboxFile: '',
      participants: normalizeParticipants(entry && entry.participants),
      md: md.length > MAX_MD ? md.slice(0, MAX_MD) + '…(截断)' : md,
      model: String((entry && entry.model) || ''),
      attempts: Math.max(0, Math.trunc(Number(entry && entry.attempts) || 0)),
      aiDetail: Boolean(entry && entry.aiDetail === true),
    }
    list.push(item)
    while (list.length > MAX_ENTRIES) list.shift()
    this.cache.set(gid, list)
    this.flush(gid, list)
    return item
  }

  /** 投递完成后回填投递结果（找不到该批次则忽略）。 */
  updateDelivery(groupId, batchId, info) {
    const list = this.load(groupId)
    const id = String(batchId || '')
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].batchId !== id) continue
      const patch = info || {}
      list[i].delivered = Math.trunc(Number(patch.delivered) || 0)
      list[i].failed = Math.trunc(Number(patch.failed) || 0)
      list[i].outboxFile = String(patch.outboxFile || '')
      this.flush(groupId, list)
      return list[i]
    }
    return null
  }

  /** 删除某群的某一条总结（按 batchId 匹配，从新到旧找第一条）。 */
  remove(groupId, batchId) {
    const gid = String(groupId)
    const id = String(batchId || '')
    if (!id) return false
    const list = this.load(gid)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].batchId !== id) continue
      list.splice(i, 1)
      this.cache.set(gid, list)
      this.flush(gid, list)
      return true
    }
    return false
  }

  /** 清空某群全部历史，返回删除条数。 */
  removeAll(groupId) {
    const gid = String(groupId)
    const list = this.load(gid)
    const n = list.length
    if (n === 0) return 0
    this.cache.set(gid, [])
    this.flush(gid, [])
    return n
  }

  flush(groupId, list) {
    if (!this.root) return
    try {
      this.ensure()
      const file = this.fileFor(groupId)
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify({ groupId: String(groupId), entries: list }, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch {
      /* 落盘失败不影响本次总结 */
    }
  }
}