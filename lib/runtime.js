import { join } from 'node:path'

import { resolveConfig, storageRoot, outboxDir } from './config.js'
import { NapCatWsClient } from './transport/napcat-ws.js'
import { createActions, toTextSegments } from './transport/action.js'
import { MessageStore } from './store/messages.js'
import { SummaryHistory } from './store/history.js'
import { Pipeline } from './pipeline.js'

const RECENT_LIMIT = 20

/**
 * 运行态容器：把「配置 → 连接 → 管线 → 聚合投递」这一整套装进一个可整体替换的对象。
 *
 * 存在的理由：设置页保存后需要**不重启 DSH** 就让新配置生效。做法是 stop() 拆掉
 * 旧的 WS 连接/管线/定时器，再用新配置 start() 一套新的。因为状态全在实例字段里，
 * 不散落在模块级变量上，替换是干净的。
 */
export class Runtime {
  constructor(deps) {
    const d = deps || {}
    this.ctx = d.ctx || null
    this.logger = d.logger || null
    this.rawConfig = d.rawConfig || {}

    this.cfg = null
    this.errors = []
    this.started = false
    this.startError = ''
    this.recent = []
    this.restarts = 0
    this.appliedAt = 0

    this.client = null
    this.actions = null
    this.pipeline = null
    this.store = null
    this.rootDir = ''
    this.outbox = ''
    this.pruneTimer = null
    this.aggregateQueue = []
    this.aggregateTimer = null

    this.resolve(this.rawConfig)
  }

  /** 合并默认值 + 校验，同时刷新派生的目录路径。不改运行态。 */
  resolve(rawConfig) {
    const { config, errors } = resolveConfig(rawConfig || {})
    this.rawConfig = rawConfig || {}
    this.cfg = config
    this.errors = errors
    this.rootDir = storageRoot(config)
    this.outbox = outboxDir(config)
    return { config, errors }
  }

  /** 用当前 this.cfg 拉起连接与管线。已启动时先 stop()，并保留未总结的 pending。 */
  start(seed) {
    // 热重建时把上一代还没冻结的消息接过来：改个阈值不该把攒了半天的数据清空。
    const carry = seed || (this.pipeline ? this.pipeline.snapshotPending() : null)
    if (this.started) this.stop()
    if (this.errors.length > 0) {
      this.startError = '配置校验未通过：' + this.errors.join('；')
      this.logger?.warn?.('[qq-digest] ' + this.startError)
      return false
    }

    const cfg = this.cfg
    this.store = new MessageStore(this.rootDir)
    this.history = new SummaryHistory(join(this.rootDir, 'summaries'))
    this.pipeline = new Pipeline({
      ctx: this.ctx,
      config: cfg,
      store: this.store,
      history: this.history,
      pendingSeed: carry,
      logger: this.logger,
      outboxDir: this.outbox,
    })
    this.pipeline.onGroupSummary = async (entry) => this.enqueueReport(entry)

    this.client = new NapCatWsClient({
      wsUrl: cfg.napcat.wsUrl,
      token: cfg.napcat.token,
      reconnectMs: cfg.napcat.reconnectMs,
      callTimeoutMs: cfg.napcat.callTimeoutMs,
      logger: this.logger,
      onEvent: (event) => this.pipeline && this.pipeline.handleEvent(event),
      onStatus: (s) => {
        if (s && s.connected) {
          this.actions
            .loginInfo()
            .then((info) => {
              if (!this.pipeline) return
              this.pipeline.selfId = info && info.user_id != null ? String(info.user_id) : ''
              this.logger?.info?.(
                '[qq-digest] 已连接，登录账号 ' + this.pipeline.selfId + '（' + (info?.nickname || '') + '）',
              )
            })
            .catch(() => {
              /* 拿不到不影响监听 */
            })
        }
      },
    })
    this.actions = createActions(this.client)
    // 关键：Pipeline 先于 client 构造，投递所需的 actions 必须在这里回填，
    // 否则 deliverReport 收到 undefined，发送时报
    // "Cannot read properties of undefined (reading 'sendPrivate')"。
    this.pipeline.actions = this.actions

    this.pruneTimer = setInterval(
      () => {
        try {
          const removed = this.store ? this.store.prune(cfg.storage.keepDays, Math.trunc(Date.now() / 1000)) : 0
          if (removed > 0) this.logger?.info?.('[qq-digest] 清理过期消息文件 ' + removed + ' 个')
        } catch {
          /* 清理失败不影响主流程 */
        }
      },
      6 * 3600 * 1000,
    )
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref()

    try {
      this.pipeline.start()
      this.client.connect()
      this.started = true
      this.startError = ''
      this.appliedAt = Date.now()
      this.logger?.info?.(
        '[qq-digest] 已启动：WS ' +
          cfg.napcat.wsUrl +
          '，监听 ' +
          cfg.listen.groups.length +
          ' 个群，阈值 ' +
          cfg.batch.threshold +
          (cfg.dryRun ? '（dryRun 预演）' : ''),
      )
      return true
    } catch (error) {
      this.startError = error && error.message ? error.message : String(error)
      this.logger?.warn?.('[qq-digest] 启动失败：' + this.startError)
      this.started = false
      return false
    }
  }

  /** 拆掉连接、管线、定时器。可重复调用。 */
  stop() {
    if (this.aggregateTimer) {
      clearTimeout(this.aggregateTimer)
      this.aggregateTimer = null
    }
    this.aggregateQueue = []
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    try {
      if (this.client) this.client.close()
    } catch {
      /* 尽力而为 */
    }
    try {
      if (this.pipeline) this.pipeline.dispose()
    } catch {
      /* 尽力而为 */
    }
    this.client = null
    this.actions = null
    this.pipeline = null
    this.store = null
    this.started = false
  }

  /**
   * 设置页保存后调用：先解析校验，校验通过才真正替换运行态。
   * 校验不通过时保留旧连接继续跑，避免一次误提交把正在监听的服务打停。
   */
  reconfigure(rawConfig, seed) {
    const previous = { rawConfig: this.rawConfig, cfg: this.cfg, errors: this.errors }
    // 调用方可以显式传快照；没传就在 start() 里自行从旧 pipeline 取。
    const carry = seed || (this.pipeline ? this.pipeline.snapshotPending() : null)
    const { errors } = this.resolve(rawConfig)
    if (errors.length > 0) {
      this.rawConfig = previous.rawConfig
      this.cfg = previous.cfg
      this.errors = previous.errors
      this.startError = '配置校验未通过：' + errors.join('；')
      return { ok: false, errors }
    }
    this.restarts += 1
    this.start(carry)
    return { ok: this.started, errors: [], carried: carry ? carry.size : 0 }
  }

  /** 把群总结 entry 聚合成一条报告再投递，窗口内多个群合并。 */
  enqueueReport(entry) {
    this.aggregateQueue.push(entry)
    const windowMs = Math.max(0, Number(this.cfg.delivery.aggregateWindowMs) || 0)
    if (windowMs === 0) {
      this.flushReports()
      return
    }
    if (this.aggregateTimer) clearTimeout(this.aggregateTimer)
    this.aggregateTimer = setTimeout(() => {
      this.aggregateTimer = null
      this.flushReports()
    }, windowMs)
    if (typeof this.aggregateTimer.unref === 'function') this.aggregateTimer.unref()
  }

  async flushReports() {
    if (this.aggregateTimer) {
      clearTimeout(this.aggregateTimer)
      this.aggregateTimer = null
    }
    if (this.aggregateQueue.length === 0) return null
    if (!this.pipeline) return null
    const entries = this.aggregateQueue
    this.aggregateQueue = []
    try {
      const delivery = await this.pipeline.deliverEntries(entries, Math.trunc(Date.now() / 1000))
      if (delivery) {
        this.recent.unshift({
          at: Date.now(),
          groups: entries.map((e) => ({ groupId: e.groupId, groupName: e.groupName, ok: e.ok, count: e.count })),
          delivered: delivery.result.delivered.length,
          failed: delivery.result.failed.length,
          outboxFile: delivery.result.outboxFile,
          text: delivery.text.length > 4000 ? delivery.text.slice(0, 4000) + '\n…(截断)' : delivery.text,
        })
        if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT
      }
      return delivery
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      this.logger?.warn?.('[qq-digest] 报告投递异常：' + message)
      if (this.pipeline) this.pipeline.stats.lastError = message
      return null
    }
  }

  async flushAll() {
    if (!this.pipeline) return null
    await this.pipeline.flushAll()
    return this.flushReports()
  }

  async sendTest(friends, text) {
    if (!this.actions) throw new Error('插件尚未启动，无法发送测试消息')
    const out = []
    for (const uid of friends) {
      try {
        const r = await this.actions.sendPrivate(uid, toTextSegments(text))
        out.push({ userId: uid, ok: true, messageId: r.messageId })
      } catch (error) {
        out.push({ userId: uid, ok: false, error: error && error.message ? error.message : String(error) })
      }
    }
    return out
  }

  status() {
    const cfg = this.cfg
    return {
      started: this.started,
      startError: this.startError,
      configErrors: this.errors,
      appliedAt: this.appliedAt,
      restarts: this.restarts,
      ws: {
        connected: Boolean(this.client && this.client.ready),
        url: cfg.napcat.wsUrl,
        stats: this.client ? this.client.stats : {},
      },
      pipeline: this.pipeline ? this.pipeline.status() : null,
      model: { provider: cfg.model.provider || '(DSH 默认)', model: cfg.model.model || '(DSH 默认)' },
      delivery: { friends: cfg.delivery.friends, dryRun: cfg.dryRun },
      storage: this.rootDir,
      recent: this.recent.slice(0, 5),
    }
  }
}
