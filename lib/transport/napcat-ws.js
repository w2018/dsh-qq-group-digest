/**
 * NapCat OneBot11 正向 WebSocket 客户端。
 *
 * 用 Node 内置的全局 WebSocket（Node >= 22），不引第三方 ws 包。
 * 内置 WebSocket 不支持自定义 header，因此 token 走标准写法 ?access_token=<token>
 * （NapCat 两种方式都支持）。
 *
 * 职责：连接 / 口令 / 指数退避重连 / echo 匹配的 action 调用 / 事件回调。
 */
export class NapCatWsClient {
  constructor(options) {
    const opts = options || {}
    this.baseUrl = String(opts.wsUrl || 'ws://127.0.0.1:3001')
    this.token = String(opts.token || '')
    const re = Array.isArray(opts.reconnectMs) ? opts.reconnectMs : [1000, 30000]
    this.minBackoff = Math.max(100, Number(re[0]) || 1000)
    this.maxBackoff = Math.max(this.minBackoff, Number(re[1]) || 30000)
    this.callTimeoutMs = Math.max(1000, Number(opts.callTimeoutMs) || 30000)
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
    this.onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {}
    this.logger = opts.logger || null

    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.closed = false
    this.backoff = this.minBackoff
    this.reconnectTimer = null
    this.ready = false
    this.stats = { connects: 0, events: 0, calls: 0, callFailures: 0, reconnects: 0 }

    // 连接态的可观测字段：网页端与设置页靠它显示「N 秒后重连（第 K 次）」。
    this.reconnectAttempt = 0
    this.nextRetryAt = 0
    this.retryInMs = 0
    this.lastConnectedAt = 0
    this.lastDisconnectAt = 0
    // 当前是否处在「等待重连」状态（close 之后、下次 connect 之前为 true）。
    this.reconnecting = false
  }

  log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level]('[qq-digest][ws] ' + message)
    }
  }

  /** 组装带 token 的 URL（token 为空时原样使用）。 */
  targetUrl() {
    if (!this.token) return this.baseUrl
    const sep = this.baseUrl.indexOf('?') >= 0 ? '&' : '?'
    return this.baseUrl + sep + 'access_token=' + encodeURIComponent(this.token)
  }

  connect() {
    if (this.closed) return
    if (typeof WebSocket !== 'function') {
      this.log('error', '当前 Node 运行时没有全局 WebSocket（需要 Node >= 22）')
      return
    }
    let ws
    try {
      ws = new WebSocket(this.targetUrl())
    } catch (error) {
      this.log('warn', 'construct failed: ' + (error && error.message))
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.ready = true
      this.backoff = this.minBackoff
      this.stats.connects += 1
      // 连上就把重连计数与倒计时清干净，避免 UI 残留上一轮的「第 K 次」。
      this.reconnectAttempt = 0
      this.nextRetryAt = 0
      this.retryInMs = 0
      this.reconnecting = false
      this.lastConnectedAt = Date.now()
      this.log('info', 'connected ' + this.baseUrl)
      this.onStatus({ connected: true, wsUrl: this.baseUrl, at: this.lastConnectedAt })
    })

    ws.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (frame && frame.echo && this.pending.has(frame.echo)) {
        const waiter = this.pending.get(frame.echo)
        this.pending.delete(frame.echo)
        clearTimeout(waiter.timer)
        if (frame.status === 'ok' || frame.retcode === 0) {
          waiter.resolve(frame.data)
        } else {
          const code = frame.retcode == null ? '?' : frame.retcode
          const detail = frame.wording || frame.message || JSON.stringify(frame).slice(0, 200)
          waiter.reject(new Error('napcat ' + code + ': ' + detail))
        }
        return
      }
      this.stats.events += 1
      try {
        this.onEvent(frame)
      } catch (error) {
        this.log('warn', 'event handler threw: ' + (error && error.message))
      }
    })

    ws.addEventListener('close', (event) => {
      this.ready = false
      this.lastDisconnectAt = Date.now()
      this.onStatus({
        connected: false,
        code: event && event.code,
        at: this.lastDisconnectAt,
        willRetry: !this.closed,
      })
      this.failAllPending('socket closed')
      if (!this.closed) this.scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // 内置 WebSocket 的 error 事件不带详细信息；close 事件会随后触发并重连。
      this.log('warn', 'socket error')
    })
  }

  failAllPending(reason) {
    for (const [echo, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
      this.pending.delete(echo)
    }
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return
    const delay = this.backoff
    this.backoff = Math.min(this.maxBackoff, Math.round(this.backoff * 1.8))
    this.stats.reconnects += 1
    this.reconnectAttempt += 1
    this.retryInMs = delay
    this.nextRetryAt = Date.now() + delay
    this.reconnecting = true
    this.log('info', 'reconnect in ' + delay + 'ms')
    this.onStatus({
      connected: false,
      reconnecting: true,
      retryInMs: delay,
      nextRetryAt: this.nextRetryAt,
      attempt: this.reconnectAttempt,
      wsUrl: this.baseUrl,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  /**
   * 连接态快照：runtime.status().ws 与网页端重连倒计时都读它。
   * 字段名与修复方案 F 一致，不改动既有 connected / stats 语义。
   */
  linkStatus() {
    return {
      connected: Boolean(this.ready),
      reconnecting: this.reconnecting === true && this.ready !== true,
      retryInMs: Math.max(0, Math.trunc(Number(this.retryInMs) || 0)),
      nextRetryAt: Math.max(0, Math.trunc(Number(this.nextRetryAt) || 0)),
      reconnectAttempt: Math.max(0, Math.trunc(Number(this.reconnectAttempt) || 0)),
      lastConnectedAt: Math.max(0, Math.trunc(Number(this.lastConnectedAt) || 0)),
      lastDisconnectAt: Math.max(0, Math.trunc(Number(this.lastDisconnectAt) || 0)),
      wsUrl: this.baseUrl,
    }
  }

  /** 调用 OneBot11 action。未连接时立即 reject（由上层决定是否重试）。 */
  call(action, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.ready) {
        reject(new Error('napcat not connected'))
        return
      }
      const echo = 'qqd-' + (++this.seq)
      const timer = setTimeout(() => {
        if (this.pending.has(echo)) {
          this.pending.delete(echo)
          this.stats.callFailures += 1
          reject(new Error('napcat call timeout: ' + action))
        }
      }, this.callTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(echo, { resolve, reject, timer })
      this.stats.calls += 1
      try {
        this.ws.send(JSON.stringify({ action, params: params || {}, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        this.stats.callFailures += 1
        reject(error)
      }
    })
  }

  close() {
    this.closed = true
    // 主动关闭后不再重连，倒计时相关字段一并归零，UI 显示「未连接」而不是「重连中」。
    this.reconnecting = false
    this.nextRetryAt = 0
    this.retryInMs = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.failAllPending('client closed')
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.ready = false
  }
}
