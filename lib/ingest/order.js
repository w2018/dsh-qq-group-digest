/**
 * 单群消息缓冲：负责排序、缺口检测与冻结快照。
 *
 * 排序键优先级：realSeq（NapCat 的 real_seq，单调递增）> timeSec > arrival。
 * 只有 pending 区可以重排；一旦冻结，内容不再改写。
 */
export class GroupBuffer {
  constructor(groupId, options) {
    const opts = options || {}
    this.groupId = String(groupId)
    this.maxBuffer = Math.max(1, Math.trunc(Number(opts.maxBuffer) || 500))
    this.items = []
    this.seenIds = new Set()
  }

  get size() {
    return this.items.length
  }

  /** 插入一条记录；重复 msgId 返回 false。 */
  push(record) {
    if (!record || !record.msgId) return false
    if (this.seenIds.has(record.msgId)) return false
    this.seenIds.add(record.msgId)
    this.items.push(record)
    return true
  }

  /** 按排序键升序返回副本，不改内部顺序之外的语义。 */
  sorted() {
    return this.items.slice().sort(compareRecords)
  }

  /** 检测 realSeq 缺口；返回 [[from,to], ...]，无缺口返回 []。 */
  gaps() {
    const seqs = this.items.map((r) => r.realSeq).filter((v) => v != null).sort((a, b) => a - b)
    const out = []
    for (let i = 1; i < seqs.length; i += 1) {
      const prev = seqs[i - 1]
      const cur = seqs[i]
      if (cur - prev > 1) out.push([prev + 1, cur - 1])
    }
    return out
  }

  /** 冻结：返回排序后的快照，并清空 pending 区（同步完成，无 await，天然原子）。 */
  freeze() {
    const snapshot = this.sorted()
    this.items = []
    this.seenIds = new Set()
    return snapshot
  }
}

export function compareRecords(a, b) {
  const sa = a.realSeq
  const sb = b.realSeq
  if (sa != null && sb != null && sa !== sb) return sa - sb
  if (sa != null && sb == null) return -1
  if (sa == null && sb != null) return 1
  if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec
  return (a.arrival || 0) - (b.arrival || 0)
}
