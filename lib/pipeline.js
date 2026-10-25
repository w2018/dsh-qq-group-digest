import { GroupAccumulator } from './batch/accumulator.js'
import { DedupSet, dedupKey } from './ingest/dedup.js'
import { normalizeEvent } from './ingest/normalize.js'
import { summarizeBatch } from './summarize/summarize.js'
import { buildFallbackText } from './summarize/prompt.js'
import { renderReport } from './deliver/render.js'
import { deliverReport } from './deliver/send.js'
import { SummaryHistory } from './store/history.js'

/**
 * 主管线：事件接入 → 规范化 → 去重 → 计数 → 冻结 → 总结 → 渲染 → 投递。
 *
 * 关键约束：
 * - 每群队列 in-flight=1、pending<=1，超出合并进 pending。
 * - 跨群并发（allSettled），群内严格串行。
 * - 先落盘（MessageStore.append）再计数。
 */
export class Pipeline {
  constructor(deps) {
    const d = deps || {}
    this.ctx = d.ctx || null
    this.config = d.config
    this.store = d.store || null
    this.logger = d.logger || null
    this.outboxDir = d.outboxDir || ''
    // actions 在 Runtime 里晚于 Pipeline 创建（要先有 client），由 Runtime 回填。
    this.actions = d.actions || null
    this.history = d.history || new SummaryHistory(d.historyDir || '')
    // 热重建（设置页保存 / /reload）时把上一代 Pipeline 里还没冻结的 pending
    // 记录带过来，避免「改一下配置，攒了半天的消息全丢」。
    this.pendingSeed = d.pendingSeed || null

    this.dedup = new DedupSet(20000)
    this.groupDedup = new Map()
    this.accumulators = new Map()
    this.queues = new Map()
    this.groupNames = new Map()
    this.selfId = ''
    this.running = false
    this.batchSeq = 0

    this.stats = {
      events: 0,
      accepted: 0,
      dropped: 0,
      duplicate: 0,
      frozen: 0,
      summarizedOk: 0,
      summarizedFail: 0,
      delivered: 0,
      deliverFail: 0,
      lastError: '',
      lastBatchId: '',
      lastBatchAt: 0,
      startedAt: 0,
    }
    this.dropReasons = new Map()

    const groups = this.config.listen.groups
    for (const gid of groups) {
      this.groupDedup.set(gid, new DedupSet(5000))
      this.accumulators.set(
        gid,
        new GroupAccumulator(gid, {
          threshold: this.thresholdFor(gid),
          freezeGraceMs: this.config.batch.freezeGraceMs,
          maxBuffer: this.config.batch.maxBuffer,
          maxWaitMs: this.config.batch.maxWaitMs,
        }),
      )
      this.queues.set(gid, { inFlight: null, pending: null })
    }
  }

  /**
   * 把上一代 Pipeline 的快照塞回新缓冲区。
   *
   * 走 acc.push() 而不是直接写 buffer，是为了让状态机与定时器（阈值、宽限期、
   * 最长等待）照常生效：如果新阈值比已累计条数还低，恢复后立刻就该冻结。
   * 已恢复的记录同时写进去重集合，避免重连重放时被二次计数。
   */
  restorePending(seed) {
    if (!seed || typeof seed.forEach !== 'function') return
    let restored = 0
    seed.forEach((records, gid) => {
      const acc = this.accumulators.get(gid)
      if (!acc || !Array.isArray(records)) {
        // 群被移出监听列表：这些记录确实无处可放，记一条日志方便排查。
        this.logWarn('群 ' + gid + ' 已不在监听列表，丢弃 ' + (Array.isArray(records) ? records.length : 0) + ' 条未总结记录')
        return
      }
      const groupDedup = this.groupDedup.get(gid)
      for (const rec of records) {
        if (!rec || !rec.msgId) continue
        const key = dedupKey(gid, rec.msgId)
        if (groupDedup) groupDedup.add(key)
        this.dedup.add(key)
        acc.push(rec, (batch) => this.onFreeze(batch), Date.now())
        this.stats.accepted += 1
        restored += 1
      }
    })
    if (restored > 0) this.info('热重建：已恢复 ' + restored + ' 条未总结消息')
  }

  /** 导出当前所有群尚未冻结的记录（含已排队待总结的批次），供热重建继承。 */
  snapshotPending() {
    const out = new Map()
    for (const [gid, acc] of this.accumulators) {
      const records = acc.buffer.sorted()
      if (records.length > 0) out.set(gid, records)
    }
    // 已经冻结、正在排队等总结的批次也一起带上，否则这次改动会吞掉一整批。
    for (const [gid, q] of this.queues) {
      if (!q.pending || !Array.isArray(q.pending.records) || q.pending.records.length === 0) continue
      const merged = (out.get(gid) || []).concat(q.pending.records)
      out.set(gid, merged)
    }
    return out
  }

  thresholdFor(groupId) {
    const override = this.config.batch.perGroupOverride
    if (override && override[groupId] && Number.isFinite(Number(override[groupId].threshold))) {
      return Math.max(1, Math.trunc(Number(override[groupId].threshold)))
    }
    return this.config.batch.threshold
  }

  logWarn(msg) {
    this.stats.lastError = msg
    if (this.logger) this.logger.warn?.('[qq-digest] ' + msg)
  }

  info(msg) {
    if (this.logger) this.logger.info?.('[qq-digest] ' + msg)
  }

  start() {
    this.running = true
    this.stats.startedAt = Date.now()
    this.info('管线启动，监听群：' + this.config.listen.groups.join(', '))
    // 恢复必须放在 running=true 之后：构造函数里 onFreeze 会因 running=false 直接
    // return，恢复的记录若当场达阈值，整批会被静默丢弃。
    if (this.pendingSeed) {
      const seed = this.pendingSeed
      this.pendingSeed = null
      this.restorePending(seed)
    }
  }

  dispose() {
    this.running = false
    for (const acc of this.accumulators.values()) acc.dispose()
    this.accumulators.clear()
    this.queues.clear()
  }

  /** WS 事件入口。同步处理，不做 await，避免阻塞事件循环中的顺序。 */
  handleEvent(event) {
    if (!this.running) return
    this.stats.events += 1

    const result = normalizeEvent(event, {
      groups: new Set(this.config.listen.groups),
      ignoreSelf: this.config.listen.ignoreSelf,
      keywords: this.config.listen.keywords,
      excludedSenders: this.config.listen.excludedSenders,
      selfId: this.selfId,
      arrival: Date.now(),
    })

    if (result.dropped) {
      this.stats.dropped += 1
      const key = result.dropped.split(':')[0]
      this.dropReasons.set(key, (this.dropReasons.get(key) || 0) + 1)
      return
    }

    const record = result.record
    if (record.groupName) this.groupNames.set(record.groupId, record.groupName)

    const groupDedup = this.groupDedup.get(record.groupId)
    if (groupDedup && !groupDedup.add(dedupKey(record.groupId, record.msgId))) {
      this.stats.duplicate += 1
      return
    }
    if (!this.dedup.add(dedupKey(record.groupId, record.msgId))) {
      this.stats.duplicate += 1
      return
    }

    if (this.store) {
      try {
        this.store.append(record)
      } catch (error) {
        this.logWarn('落盘失败（不阻塞计数）：' + (error && error.message))
      }
    }

    this.stats.accepted += 1

    const acc = this.accumulators.get(record.groupId)
    if (!acc) return
    acc.push(record, (batch) => this.onFreeze(batch), Date.now())
  }

  onFreeze(batch) {
    if (!this.running) return
    this.stats.frozen += 1
    const gid = batch.groupId
    const bundle = {
      groupId: gid,
      groupName: this.groupNames.get(gid) || '',
      records: batch.records,
      gaps: batch.gaps,
      reason: batch.reason,
    }
    const queue = this.queues.get(gid)
    if (!queue) return
    if (queue.pending) {
      // 合并：pending + 新批次，按时间拼接
      queue.pending = {
        groupId: gid,
        groupName: bundle.groupName || queue.pending.groupName,
        records: queue.pending.records.concat(bundle.records),
        gaps: queue.pending.gaps.concat(bundle.gaps),
        reason: 'merged',
        mergedCount: (queue.pending.mergedCount || 1) + 1,
      }
      this.info('群 ' + gid + ' 上一批仍在排队，已合并（共 ' + queue.pending.mergedCount + ' 批）')
      return
    }
    queue.pending = bundle
    this.drain(gid)
  }

  drain(groupId) {
    const queue = this.queues.get(groupId)
    if (!queue || queue.inFlight) return
    const bundle = queue.pending
    if (!bundle) return
    queue.pending = null
    queue.inFlight = this.processBundle(bundle)
      .catch((error) => {
        this.logWarn('群 ' + groupId + ' 批次处理异常：' + (error && error.message))
      })
      .finally(() => {
        queue.inFlight = null
        const next = this.queues.get(groupId)
        if (next && next.pending) this.drain(groupId)
      })
  }

  /** 处理单个群的一个批次：总结 → 渲染上下文交回调用方。 */
  async processBundle(bundle) {
    this.batchSeq += 1
    const batchId = 'b' + this.batchSeq + '-' + bundle.groupId
    this.stats.lastBatchId = batchId
    this.stats.lastBatchAt = Date.now()

    const records = bundle.records.slice().sort((a, b) => {
      if (a.realSeq != null && b.realSeq != null && a.realSeq !== b.realSeq) return a.realSeq - b.realSeq
      return a.timeSec - b.timeSec
    })

    this.info('群 ' + bundle.groupId + ' 冻结批次 ' + batchId + '，' + records.length + ' 条（触发原因：' + bundle.reason + '）')

    // 群维度隔离：只取本群历史，绝不跨群。
    const history = this.history ? this.history.recent(bundle.groupId, this.config.model.historyCount) : []

    const result = await summarizeBatch(this.ctx, records, {
      groupId: bundle.groupId,
      groupName: bundle.groupName,
      gaps: bundle.gaps,
      history,
      modelConfig: this.config.model,
      logger: this.logger,
    })

    if (result.ok) {
      this.stats.summarizedOk += 1
    } else {
      this.stats.summarizedFail += 1
      this.logWarn('群 ' + bundle.groupId + ' 总结失败（' + result.kind + '）：' + result.error)
      // 降级：生成原始摘录，仍然尝试投递
      result.text = buildFallbackText(records, {
        groupName: bundle.groupName,
        groupId: bundle.groupId,
        errorMessage: result.error,
      })
    }

    const entry = {
      batchId,
      groupId: bundle.groupId,
      groupName: bundle.groupName,
      ok: result.ok,
      text: result.text,
      count: records.length,
      firstSec: records.length > 0 ? records[0].timeSec : 0,
      lastSec: records.length > 0 ? records[records.length - 1].timeSec : 0,
      error: result.error || '',
      attempts: result.attempts,
      model: result.ok ? result.provider + '/' + result.model : '',
      gaps: bundle.gaps,
      receivedAt: Date.now(),
    }

    // 先记历史再投递：即使投递失败，下一批也能拿到这批的结论作为上下文。
    if (this.history) {
      try {
        this.history.append(bundle.groupId, entry)
      } catch (error) {
        this.logWarn('历史总结落盘失败（不阻塞投递）：' + (error && error.message))
      }
    }

    if (typeof this.onGroupSummary === 'function') {
      try {
        await this.onGroupSummary(entry)
      } catch (error) {
        this.logWarn('onGroupSummary 回调异常：' + (error && error.message))
      }
    }
    return entry
  }

  /** 手动冻结所有群并立即处理（供 /flush 调用）。 */
  async flushAll() {
    const entries = []
    for (const gid of this.accumulators.keys()) {
      const acc = this.accumulators.get(gid)
      if (!acc || acc.pending === 0) continue
      await new Promise((resolve) => {
        acc.forceFreeze((batch) => {
          this.onFreeze(batch)
          resolve()
        }, 'manual-flush')
      })
    }
    // 等待所有 in-flight 完成
    const waits = []
    for (const [gid, q] of this.queues) {
      if (q.inFlight) waits.push(q.inFlight)
    }
    if (waits.length > 0) await Promise.allSettled(waits)
    return entries
  }

  async deliverEntries(entries, nowSec) {
    const list = Array.isArray(entries) ? entries : []
    if (list.length === 0) return null
    const text = renderReport(list, { now: nowSec || Math.trunc(Date.now() / 1000) })
    const res = await deliverReport(this.actions, text, {
      friends: this.config.delivery.friends,
      retry: this.config.delivery.retry,
      maxCharsPerMessage: this.config.delivery.maxCharsPerMessage,
      sendIntervalMs: this.config.delivery.sendIntervalMs,
      dryRun: this.config.dryRun,
      outboxDir: this.outboxDir,
      logger: this.logger,
    })
    if (res.delivered.length > 0) this.stats.delivered += res.delivered.length
    if (res.failed.length > 0) {
      this.stats.deliverFail += res.failed.length
      this.logWarn('投递失败：' + res.failed.map((f) => f.userId + ':' + f.error).join('; '))
    }
    // 回填投递结果，方便设置页与历史文件里看到「这批到底发出去了没有」。
    if (this.history) {
      for (const e of list) {
        try {
          this.history.updateDelivery(e.groupId, e.batchId, {
            delivered: res.delivered.length,
            failed: res.failed.length,
            outboxFile: res.outboxFile,
          })
        } catch {
          /* 历史回填失败不影响投递结果 */
        }
      }
    }
    return { text, result: res, entries: list }
  }

  status() {
    const groups = []
    for (const [gid, acc] of this.accumulators) {
      const q = this.queues.get(gid) || {}
      groups.push({
        groupId: gid,
        groupName: this.groupNames.get(gid) || '',
        threshold: acc.threshold,
        pending: acc.pending,
        state: acc.state,
        inFlight: Boolean(q.inFlight),
        hasPendingBatch: Boolean(q.pending),
        accepted: acc.stats.accepted,
        frozen: acc.stats.frozen,
        lastBatchSize: acc.stats.lastBatchSize,
        lastFrozenAt: acc.stats.lastFrozenAt,
      })
    }
    return {
      running: this.running,
      selfId: this.selfId,
      wsUrl: this.config.napcat.wsUrl,
      groups,
      stats: Object.assign({}, this.stats),
      dropReasons: Object.fromEntries(this.dropReasons),
      dedupSize: this.dedup.size,
    }
  }
}
