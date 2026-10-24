import { GroupBuffer } from '../ingest/order.js'

/**
 * 每群独立的计数与冻结状态机。
 *
 *   IDLE ──push──► ACCUMULATING(n++)
 *   ACCUMULATING ──n >= threshold──► GRACE（等 freezeGraceMs）
 *   GRACE ──计时到 / n >= maxBuffer──► 冻结，通知回调
 */
export class GroupAccumulator {
  constructor(groupId, options) {
    const opts = options || {}
    this.groupId = String(groupId)
    this.threshold = Math.max(1, Math.trunc(Number(opts.threshold) || 100))
    this.freezeGraceMs = Math.max(0, Math.trunc(Number(opts.freezeGraceMs) || 0))
    this.maxWaitMs = Math.max(1000, Math.trunc(Number(opts.maxWaitMs) || 3600000))
    this.buffer = new GroupBuffer(this.groupId, opts)
    this.graceTimer = null
    this.maxWaitTimer = null
    this.state = 'IDLE'
    this.stats = { accepted: 0, frozen: 0, lastFrozenAt: 0, lastBatchSize: 0 }
  }

  get pending() {
    return this.buffer.size
  }

  /**
   * 收到一条记录。onFreeze 是同步回调，接收 { snapshot, reason }。
   * 返回 true 表示已接受。
   */
  push(record, onFreeze, now) {
    const at = Number.isFinite(now) ? now : Date.now()
    const accepted = this.buffer.push(record)
    if (!accepted) return false
    this.stats.accepted += 1

    if (this.state === 'IDLE') this.state = 'ACCUMULATING'

    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.maxWaitTimer = null
        if (this.buffer.size > 0) this.fireFreeze(onFreeze, 'max-wait')
      }, this.maxWaitMs)
      if (typeof this.maxWaitTimer.unref === 'function') this.maxWaitTimer.unref()
    }

    if (this.buffer.size >= this.threshold) {
      this.scheduleGrace(onFreeze)
      return true
    }
    if (this.buffer.size >= this.buffer.maxBuffer) {
      this.clearGrace()
      this.fireFreeze(onFreeze, 'max-buffer')
      return true
    }
    return true
  }

  scheduleGrace(onFreeze) {
    if (this.freezeGraceMs <= 0) {
      this.fireFreeze(onFreeze, 'threshold')
      return
    }
    // 宽限期可被新消息重置一次语义：重置后仍会触发，不会无限推迟
    this.clearGrace()
    this.state = 'GRACE'
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      if (this.buffer.size >= this.threshold) this.fireFreeze(onFreeze, 'threshold')
      else this.state = 'ACCUMULATING'
    }, this.freezeGraceMs)
    if (typeof this.graceTimer.unref === 'function') this.graceTimer.unref()
  }

  clearGrace() {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  fireFreeze(onFreeze, reason) {
    this.clearGrace()
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
    if (this.buffer.size === 0) return
    const gaps = this.buffer.gaps()
    const snapshot = this.buffer.freeze()
    this.state = 'IDLE'
    this.stats.frozen += 1
    this.stats.lastFrozenAt = Date.now()
    this.stats.lastBatchSize = snapshot.length
    if (typeof onFreeze === 'function') {
      onFreeze({ groupId: this.groupId, records: snapshot, gaps, reason })
    }
  }

  /** 手动强制冻结（供 /flush 与测试用）。 */
  forceFreeze(onFreeze, reason) {
    this.fireFreeze(onFreeze, reason || 'manual')
  }

  dispose() {
    this.clearGrace()
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
  }
}
