/**
 * 固定容量的去重集合（LRU 近似：命中即刷新，容量满时淘汰最旧）。
 * 用于按 (group_id, message_id) 抑制重连重放与重复推送。
 */
export class DedupSet {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.trunc(Number(capacity) || 5000))
    this.map = new Map()
  }

  has(key) {
    return this.map.has(key)
  }

  add(key) {
    if (this.map.has(key)) {
      this.map.delete(key)
      this.map.set(key, 1)
      return false
    }
    this.map.set(key, 1)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }
    return true
  }

  get size() {
    return this.map.size
  }
}

export function dedupKey(groupId, msgId) {
  return String(groupId) + ':' + String(msgId)
}
