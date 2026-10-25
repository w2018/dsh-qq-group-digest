import { GroupAccumulator } from './batch/accumulator.js'
import { DedupSet, dedupKey } from './ingest/dedup.js'
import { normalizeEvent } from './ingest/normalize.js'
import { summarizeBatch, resolveRoute, callOnce } from './summarize/summarize.js'
import { buildFallbackText, buildUserPrompt } from './summarize/prompt.js'
import * as promptStore from './summarize/prompt-store.js'
import { renderDetailedMarkdown, MAX_MD } from './summarize/markdown.js'
import { renderGroupReport } from './deliver/render.js'
import { deliverReportList } from './deliver/send.js'
import { SummaryHistory } from './store/history.js'

const MAX_PARTICIPANTS = 30
const FOCUS_BLOCK = /<!--\s*FOCUS([\s\S]*?)-->/i
const FOCUS_MAX_CHARS = 15

/**
 * 从 AI 精细版输出里抽出 FOCUS 注释块并解析成 { QQ号: 重点 }。
 * 模型偶尔会写坏 JSON，解析失败一律当空表，绝不影响正文。
 */
function parseFocusBlock(text) {
  const m = FOCUS_BLOCK.exec(String(text || ''))
  if (!m) return {}
  try {
    const parsed = JSON.parse(String(m[1] || '').trim())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [qq, focus] of Object.entries(parsed)) {
      const id = String(qq || '').trim()
      const val = String(focus == null ? '' : focus).trim()
      if (!id || !val) continue
      out[id] = val.length > FOCUS_MAX_CHARS ? val.slice(0, FOCUS_MAX_CHARS) + '…' : val
    }
    return out
  } catch {
    return {}
  }
}

/** 去掉正文里的 FOCUS 注释块（它是给机器看的，不该出现在页面上）。 */
function stripFocusBlock(text) {
  return String(text || '').replace(FOCUS_BLOCK, '').trim()
}

/**
 * 把 FOCUS 结果回填进 participants，返回处理后的正文（**不再拼接成员表**）。
 *
 * v0.5.0 口径（修复方案 A）：entry.md 只存正文，任何成员表都不进 md。
 * 成员表的唯一来源是网页详情页的可滚动列表；导出时由 api.js 用
 * renderMembersSection() 现场补。历史上这里会追加一份成员表，与
 * renderDetailedMarkdown() 的输出重复，导致同一份文档里出现两次「参与成员」。
 */
function applyFocus(md, participants, focusMap) {
  const list = Array.isArray(participants) ? participants : []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const hit = focusMap && focusMap[String(p.id || '')]
    if (hit && !p.focus) p.focus = hit
  }
  const out = String(md || '').trimEnd()
  return out.length > MAX_MD ? out.slice(0, MAX_MD) + '…(截断)' : out
}

/**
 * 精细版正文长度兜底（修复方案 C）。
 *
 * 提示词要求「全文不超过 1200 字」，但模型不一定听话。这里不硬切：
 * 只有超过 1600 字才在最近的段落边界（\n\n）截断并追加说明，
 * 避免把表格、代码块或半句话切坏。
 */
const DETAIL_SOFT_LIMIT = 1200
const DETAIL_HARD_LIMIT = 1600
const DETAIL_TRUNCATED_NOTE = '\n\n…（内容较长，已截断）'

function clampDetailChars(text) {
  const body = String(text == null ? '' : text)
  if (body.length <= DETAIL_HARD_LIMIT) return body
  const cut = body.lastIndexOf('\n\n', DETAIL_HARD_LIMIT)
  const head = cut >= DETAIL_SOFT_LIMIT ? body.slice(0, cut) : body.slice(0, DETAIL_HARD_LIMIT)
  return head.trimEnd() + DETAIL_TRUNCATED_NOTE
}

/** 精细版的 maxTokens：优先 config.model.detailMaxTokens，缺省 4096。 */
function detailMaxTokensOf(modelCfg) {
  const n = Math.trunc(Number(modelCfg && modelCfg.detailMaxTokens))
  return Number.isFinite(n) && n > 0 ? n : 4096
}

/**
 * 取精细版 system prompt（v0.5.0 W1 起由 prompt-store 统一提供）。
 * 保留一层薄封装只是为了让 generateDetailMarkdown 读起来更直白。
 */
function getDetailSystemPrompt(override) {
  return promptStore.getDetailSystemPrompt(override)
}

/**
 * 从本批记录统计发言人：按发言数降序，同次数按昵称（码点序，稳定可预测），最多 30 个。
 * id 优先用 QQ 号；拿不到 QQ 号时退回昵称当 key，保证匿名记录也能计入。
 */
function collectParticipants(records) {
  const list = Array.isArray(records) ? records : []
  const map = new Map()
  for (const r of list) {
    if (!r) continue
    const id = String(r.senderId == null ? '' : r.senderId)
    const name = String(r.senderName == null ? '' : r.senderName) || id || '未知'
    const key = id || name
    const item = map.get(key)
    if (item) item.count += 1
    else map.set(key, { id, name, count: 1 })
  }
  const out = [...map.values()]
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    if (a.name === b.name) return 0
    return a.name < b.name ? -1 : 1
  })
  return out.slice(0, MAX_PARTICIPANTS)
}

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
    // 持久化群名表：QQ 事件不一定带 group_name，落盘历史只能存群号，
    // 所以群名要单独存一份，读的地方统一走 groupNameOf()。
    this.groupNameStore = d.groupNameStore || null
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

  /**
   * 记住群名：内存 Map 供本次运行使用，同时写进持久化群名表（跨重启、跨历史记录）。
   * 群名来源可能有多处（消息事件、协议端群列表、单群查询），空值一律不覆盖已有值。
   */
  rememberGroupName(groupId, name) {
    const gid = String(groupId || '').trim()
    const val = String(name == null ? '' : name).trim()
    if (!gid || !val) return
    this.groupNames.set(gid, val)
    try {
      if (this.groupNameStore) this.groupNameStore.set(gid, val)
    } catch {
      /* 群名持久化失败不影响主流程 */
    }
  }

  /** 取群名：先查持久化表（更全），再退回内存 Map。都没有返回空串。 */
  groupNameOf(groupId) {
    const gid = String(groupId || '').trim()
    if (this.groupNameStore) {
      const hit = this.groupNameStore.get(gid)
      if (hit) {
        if (!this.groupNames.has(gid)) this.groupNames.set(gid, hit)
        return hit
      }
    }
    return this.groupNames.get(gid) || ''
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
    if (record.groupName) this.rememberGroupName(record.groupId, record.groupName)

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
      groupName: this.groupNameOf(gid),
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
      // 普通总结走 config.prompt.system（设置页可编辑、可恢复默认）。
      systemPrompt: this.config.prompt ? this.config.prompt.system : '',
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
      participants: collectParticipants(records),
      // md 先留空，等下面渲染：渲染函数会读 count / participants 等字段。
      md: '',
      aiDetail: false,
      dryRun: this.config.dryRun === true,
    }

    // 本地渲染先兜底：即使 AI 精细版失败或没开，entry.md 也一定是一篇完整的 Markdown。
    entry.md = renderDetailedMarkdown(entry)
    if (this.config.summary && this.config.summary.aiDetail === true && result.ok) {
      const detail = await this.generateDetailMarkdown(records, bundle, history)
      if (detail && detail.md) {
        // 只回填 FOCUS，不拼成员表：entry.md 里只放正文（成员表由网页详情页 / 导出端点渲染）。
        entry.md = applyFocus(detail.md, entry.participants, detail.focus)
        entry.aiDetail = true
      }
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

  /**
   * 可选：summary.aiDetail=true 时用详细版提示词再调一次 LLM，产出完整 Markdown 文档。
   *
   * 复用 summarize.js 的 resolveRoute / callOnce（不重复实现路由与流式聚合）。
   * 返回 { md, focus }；任何失败都返回 null，调用方保留本地渲染结果 —— 精细版失败绝不影响投递。
   * md 是去掉 FOCUS 注释块后的正文（成员表由调用方追加），focus 是 { QQ号: 15 字重点 }。
   */
  async generateDetailMarkdown(records, bundle, history) {
    try {
      const route = await resolveRoute(this.ctx, this.config.model)
      const userPrompt = buildUserPrompt(records, {
        groupName: bundle.groupName,
        groupId: bundle.groupId,
        gaps: bundle.gaps,
        history,
        maxInputChars: this.config.model.maxInputChars,
        maxHistoryChars: this.config.model.maxHistoryChars,
      })
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error('timeout')),
        Math.max(5000, Math.trunc(Number(this.config.model.timeoutMs) || 120000)),
      )
      if (typeof timer.unref === 'function') timer.unref()
      // 精细版用独立的 system prompt（config.prompt.detailSystem，可编辑可恢复默认）
      // 与独立的 token 额度（config.model.detailMaxTokens）。
      const detailSystem = getDetailSystemPrompt(this.config.prompt ? this.config.prompt.detailSystem : '')
      const detailModel = Object.assign({}, this.config.model, {
        maxTokens: detailMaxTokensOf(this.config.model),
      })
      let out = null
      try {
        out = await callOnce(route, detailSystem, userPrompt, detailModel, controller.signal)
      } finally {
        clearTimeout(timer)
      }
      // callOnce 新签名返回 { text, finishKind, reasoningChars }；兼容旧的纯字符串返回。
      const raw2 = typeof out === 'string' ? out : String((out && out.text) || '')
      const finishKind = typeof out === 'string' ? '' : String((out && out.finishKind) || '')
      if (finishKind === 'max-tokens') {
        // 截断的输出不能当成功结果落盘：正文额度被推理吃光时，结尾会断在半句话上。
        this.logWarn(
          '群 ' +
            bundle.groupId +
            ' AI 精细版输出被截断（maxTokens 用尽，正文 ' +
            raw2.length +
            ' 字 / 推理 ' +
            (Number(out && out.reasoningChars) || 0) +
            ' 字），回退本地渲染',
        )
        return null
      }
      const text = clampDetailChars(stripFocusBlock(raw2))
      if (!text) return null
      return { md: text, focus: parseFocusBlock(raw2) }
    } catch (error) {
      this.logWarn('群 ' + bundle.groupId + ' AI 精细版生成失败，回退本地渲染：' + (error && error.message))
      return null
    }
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
    const now = nowSec || Math.trunc(Date.now() / 1000)
    // 每个群单独渲染、单独发送：多个群绝不合并在一条 QQ 消息里，避免超长被截断。
    const texts = list.map((entry) => ({
      groupId: entry.groupId,
      batchId: entry.batchId,
      text: renderGroupReport(entry, { now }),
    }))
    const text = texts.map((t) => t.text).join('\n\n')
    // 修复方案 E：delivery.friends 不再强制。没配投递目标时只记日志、不发 QQ，
    // 报告照常进网页端与历史记录（delivered/failed 都回填 0）。
    const friends = Array.isArray(this.config.delivery.friends) ? this.config.delivery.friends : []
    if (friends.length === 0) {
      this.info('未配置投递目标，本批报告仅保存在网页端与历史记录中')
      const perGroup = list.map((e) => ({ groupId: e.groupId, batchId: e.batchId, ok: true }))
      if (this.history) {
        for (const e of list) {
          try {
            this.history.updateDelivery(e.groupId, e.batchId, { delivered: 0, failed: 0, outboxFile: '' })
          } catch {
            /* 历史回填失败不影响结论 */
          }
        }
      }
      return { text, texts: texts.map((t) => t.text), result: { delivered: [], failed: [], perGroup, outboxFile: '' }, entries: list, perGroup }
    }
    const res = await deliverReportList(this.actions, texts, {
      friends,
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
    // 回填投递结果：按群回填，某群失败不影响其它群的历史状态。
    if (this.history) {
      const perGroup = Array.isArray(res.perGroup) ? res.perGroup : []
      for (const e of list) {
        const mine = perGroup.find((x) => String(x.groupId) === String(e.groupId) && String(x.batchId) === String(e.batchId))
        const groupOk = mine ? mine.ok === true : res.failed.length === 0
        try {
          this.history.updateDelivery(e.groupId, e.batchId, {
            delivered: groupOk ? res.delivered.length : 0,
            failed: groupOk ? 0 : Math.max(1, res.failed.length),
            outboxFile: groupOk ? '' : res.outboxFile,
          })
        } catch {
          /* 历史回填失败不影响投递结果 */
        }
      }
    }
    return { text, texts: texts.map((t) => t.text), result: res, entries: list, perGroup: res.perGroup || [] }
  }

  status() {
    const groups = []
    for (const [gid, acc] of this.accumulators) {
      const q = this.queues.get(gid) || {}
      groups.push({
        groupId: gid,
        groupName: this.groupNameOf(gid),
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
      // 全量群名表：历史记录里的老群号也能显示成名字。
      groupNames: this.groupNameStore ? this.groupNameStore.all() : Object.fromEntries(this.groupNames),
    }
  }
}
