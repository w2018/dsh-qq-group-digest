import { appendFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

export function dayKey(sec) {
  const d = new Date(Number(sec) * 1000)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/**
 * 按 群/天 追加 JSONL。先落盘再计数，崩溃后可恢复。
 */
export class MessageStore {
  constructor(rootDir) {
    this.root = String(rootDir || '')
    this.ensured = new Set()
  }

  groupDir(groupId) {
    return join(this.root, 'messages', String(groupId))
  }

  fileFor(groupId, sec) {
    return join(this.groupDir(groupId), dayKey(sec) + '.jsonl')
  }

  ensure(dir) {
    if (this.ensured.has(dir)) return
    mkdirSync(dir, { recursive: true })
    this.ensured.add(dir)
  }

  append(record) {
    if (!this.root) return
    const dir = this.groupDir(record.groupId)
    this.ensure(dir)
    const line = JSON.stringify({
      g: record.groupId,
      id: record.msgId,
      seq: record.realSeq,
      t: record.timeSec,
      u: record.senderId,
      n: record.senderName,
      x: record.text,
    })
    appendFileSync(this.fileFor(record.groupId, record.timeSec), line + '\n', 'utf8')
  }

  /** 清理超过 keepDays 的 JSONL 文件。 */
  prune(keepDays, nowSec) {
    const days = Math.max(1, Math.trunc(Number(keepDays) || 7))
    const cutoff = (Number(nowSec) || Math.trunc(Date.now() / 1000)) - days * 86400
    const base = join(this.root, 'messages')
    let removed = 0
    let groupDirs = []
    try {
      groupDirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return 0
    }
    for (const g of groupDirs) {
      let files = []
      try {
        files = readdirSync(join(base, g)).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of files) {
        const day = f.replace('.jsonl', '')
        const sec = Math.trunc(new Date(day + 'T23:59:59').getTime() / 1000)
        if (!Number.isFinite(sec)) continue
        if (sec < cutoff) {
          try {
            unlinkSync(join(base, g, f))
            removed += 1
          } catch {
            /* ignore */
          }
        }
      }
    }
    return removed
  }
}

export function writeOutbox(outboxDir, name, content) {
  mkdirSync(outboxDir, { recursive: true })
  const file = join(outboxDir, name)
  const tmp = file + '.tmp'
  writeFileSync(tmp, String(content == null ? '' : content), 'utf8')
  renameSync(tmp, file)
  return file
}