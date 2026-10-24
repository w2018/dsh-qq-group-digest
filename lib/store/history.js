import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 20
const MAX_TEXT = 6000

/**
 * 每群的历史总结存档。
 *
 * 落盘位置：<storageRoot>/summaries/<群号>.json，结构 { groupId, entries: [...] }。
 * entries 按时间升序，最新一条在末尾；只保留最近 MAX_ENTRIES 条。
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
    const item = {
      at: Math.trunc(Number(entry && entry.at) || Math.trunc(Date.now() / 1000)),
      batchId: String((entry && entry.batchId) || ''),
      count: Math.trunc(Number(entry && entry.count) || 0),
      firstSec: Math.trunc(Number(entry && entry.firstSec) || 0),
      lastSec: Math.trunc(Number(entry && entry.lastSec) || 0),
      ok: entry && entry.ok === true,
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…(截断)' : text,
      delivered: 0,
      failed: 0,
      outboxFile: '',
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