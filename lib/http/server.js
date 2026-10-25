/**
 * 插件独立 HTTP 服务的骨架：监听、路由分发、静态文件、访问日志。
 *
 * 与 DSH 自带的 webServer 完全独立：自己 createServer 自己 listen，
 * 端口来自 cfg.httpServer.port（默认 1213），默认关闭。
 *
 * 几个刻意的取舍：
 * 1. 端口占用（EADDRINUSE）不抛给上层——设置页还要能打开改端口，所以只把原因
 *    记进 this.error，由 status() 暴露给 UI。
 * 2. 静态文件必须防目录穿越：path.resolve 之后校验前缀，越界一律 403。
 * 3. 所有响应带 cache-control: no-store——这是个配置/日志面板，缓存只会带来困惑。
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

import { createApiRouter } from './api.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 静态资源根目录。文件由 P2 提供，本阶段允许整个目录不存在。 */
const STATIC_DIR = join(import.meta.dirname, 'static')

function contentTypeFor(file) {
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream'
}

/** 取客户端 IP：优先 X-Forwarded-For 首段，退回 socket 地址。 */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim()
  return (req.socket && req.socket.remoteAddress) || 'unknown'
}

export class HttpServer {
  /**
   * @param {object} deps
   *   getRuntime()     → Runtime 实例
   *   logStore         → LogStore 实例（可为 null）
   *   settingsFile     → settings.json 路径
   *   pluginRoot       → 插件根目录
   *   logger           → ctx.logger 或 null
   *   writeSettings(patch) → 保存一份设置覆盖
   */
  constructor(deps) {
    const d = deps || {}
    this.getRuntime = typeof d.getRuntime === 'function' ? d.getRuntime : () => null
    this.logStore = d.logStore || null
    this.settingsFile = d.settingsFile || ''
    this.pluginRoot = d.pluginRoot || ''
    this.logger = d.logger || null
    this.writeSettings = typeof d.writeSettings === 'function' ? d.writeSettings : null

    this.server = null
    this.listening = false
    this.port = 0
    this.host = ''
    this.error = ''
    this.startedAt = 0
    this.requestCount = 0
    this.sseClients = new Set()
    this.lastConfig = null

    this.api = createApiRouter({
      getRuntime: this.getRuntime,
      logStore: this.logStore,
      settingsFile: this.settingsFile,
      pluginRoot: this.pluginRoot,
      writeSettings: this.writeSettings,
      logger: this.logger,
      httpServer: this,
    })
  }

  /** 当前生效的 httpServer 配置段（运行态优先，取不到就退回默认）。 */
  config() {
    const rt = this.getRuntime()
    const cfg = rt && rt.cfg ? rt.cfg : null
    const section = cfg && cfg.httpServer ? cfg.httpServer : {}
    return {
      enabled: section.enabled === true,
      port: Math.trunc(Number(section.port) || 1213),
      host: String(section.host || '0.0.0.0'),
      authEnabled: section.authEnabled !== false,
      token: String(section.token || ''),
      sessionHours: Math.max(1, Math.trunc(Number(section.sessionHours) || 168)),
    }
  }

  log(level, msg, extra) {
    try {
      this.logStore?.append?.({ level, scope: 'http', msg, extra: extra || {} })
    } catch {
      /* 日志失败不能影响请求 */
    }
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level]('[qq-digest][http] ' + msg)
    }
  }

  /**
   * 按当前配置启动。已监听先 close 再 listen。
   * 端口占用等失败不抛出，只写 this.error。
   */
  async start() {
    const cfg = this.config()
    this.lastConfig = cfg
    await this.stop()

    if (!cfg.enabled) {
      this.error = ''
      this.log('info', 'HTTP 服务未开启（httpServer.enabled=false）')
      return { ok: true, listening: false, enabled: false }
    }

    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.log('error', '请求处理异常：' + (error && error.message ? error.message : String(error)))
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          }
          res.end(JSON.stringify({ ok: false, error: 'internal error' }))
        } catch {
          /* 连接可能已经断了 */
        }
      })
    })

    this.server = server
    this.port = cfg.port
    this.host = cfg.host

    return new Promise((resolvePromise) => {
      let settled = false
      const finish = (ok, error) => {
        if (settled) return
        settled = true
        if (ok) {
          this.listening = true
          this.error = ''
          this.startedAt = Date.now()
          this.log('info', '已监听 http://' + cfg.host + ':' + cfg.port)
        } else {
          this.listening = false
          this.error = error
          this.log('warn', '启动失败：' + error)
        }
        resolvePromise({ ok, listening: this.listening, error: this.error })
      }

      server.once('error', (error) => {
        const code = error && error.code ? error.code : ''
        const message =
          code === 'EADDRINUSE'
            ? '端口 ' + cfg.port + ' 已被占用'
            : code === 'EACCES'
              ? '端口 ' + cfg.port + ' 无权限监听'
              : error && error.message
                ? error.message
                : String(error)
        try {
          server.close()
        } catch {
          /* 没 listen 成功时 close 可能报错，忽略 */
        }
        this.server = null
        finish(false, message)
      })

      try {
        server.listen(cfg.port, cfg.host, () => finish(true, ''))
      } catch (error) {
        this.server = null
        finish(false, error && error.message ? error.message : String(error))
      }
    })
  }

  /** 关闭监听并断开所有 SSE 连接。可重复调用。 */
  async stop() {
    for (const res of this.sseClients) {
      try {
        res.end()
      } catch {
        /* 尽力而为 */
      }
    }
    this.sseClients.clear()

    const server = this.server
    this.server = null
    this.listening = false
    this.startedAt = 0
    if (!server) return

    await new Promise((resolvePromise) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolvePromise()
      }
      try {
        server.close(finish)
      } catch {
        finish()
        return
      }
      // close 回调要等所有 keep-alive 连接断开，兜底超时避免卡住。
      const timer = setTimeout(finish, 2000)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  status() {
    const cfg = this.lastConfig || this.config()
    return {
      enabled: cfg.enabled,
      listening: this.listening,
      port: this.port || cfg.port,
      host: this.host || cfg.host,
      error: this.error,
      startedAt: this.startedAt,
      requestCount: this.requestCount,
      staticDir: STATIC_DIR,
      staticReady: this.staticReady(),
    }
  }

  /** 静态目录是否已就位（P2 之前为 false，路由照样不崩）。 */
  staticReady() {
    try {
      return statSync(STATIC_DIR).isDirectory()
    } catch {
      return false
    }
  }

  /** 把相对路径映射到 static/ 下的绝对路径；越界返回 null。 */
  resolveStatic(relativePath) {
    const root = resolve(STATIC_DIR)
    const target = resolve(root, '.' + (relativePath.startsWith('/') ? relativePath : '/' + relativePath))
    // 必须是 root 本身或 root 的子路径，防 /../index.js 之类的穿越。
    if (target !== root && !target.startsWith(root + sep)) return null
    return target
  }

  /** 读静态文件；不存在/越界/读失败都返回 null，由调用方回 404/403。 */
  readStatic(relativePath) {
    const file = this.resolveStatic(relativePath)
    if (!file) return { forbidden: true }
    try {
      const stat = statSync(file)
      if (!stat.isFile()) return null
      return { body: readFileSync(file), file }
    } catch {
      return null
    }
  }

  async handle(req, res) {
    this.requestCount += 1
    const startedAt = Date.now()
    const ip = clientIp(req)

    let url
    try {
      url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'))
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'bad url' })
      return
    }

    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')

    const pathname = decodeURIComponent(url.pathname)
    const ctx = {
      ip,
      cookies: req.headers.cookie || '',
      pathname,
      method: req.method || 'GET',
      logStore: this.logStore,
    }

    // 1) API 优先
    let handled = false
    try {
      handled = await this.api(req, res, url, ctx)
    } catch (error) {
      this.log('error', 'API 处理异常 ' + pathname + '：' + (error && error.message ? error.message : String(error)))
      if (!res.headersSent) this.sendJson(res, 500, { ok: false, error: 'internal error' })
      else res.end()
      handled = true
    }

    // 2) 静态资源
    if (!handled) {
      handled = this.serveStatic(pathname, res)
    }

    if (!handled) this.sendJson(res, 404, { ok: false, error: 'not found' })

    const ms = Date.now() - startedAt
    if (ms > 200 || pathname.startsWith('/api/')) {
      this.log('debug', (req.method || 'GET') + ' ' + pathname + ' ' + ms + 'ms', { ip })
    }
  }

  /** 静态文件路由：/ → index.html；/login → login.html；其余按路径取。 */
  serveStatic(pathname, res) {
    if (pathname.startsWith('/api/')) return false
    let rel = pathname
    if (rel === '/' || rel === '') rel = '/index.html'
    else if (rel === '/login' || rel === '/login/') rel = '/login.html'
    else if (rel === '/logs' || rel === '/logs/') rel = '/logs.html'
    else if (rel === '/summaries' || rel === '/summaries/') rel = '/summaries.html'

    const got = this.readStatic(rel)
    if (got && got.forbidden) {
      this.sendJson(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    if (!got) return false

    res.writeHead(200, {
      'content-type': contentTypeFor(got.file),
      'cache-control': 'no-store',
      'content-length': got.body.length,
    })
    res.end(got.body)
    return true
  }

  sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    })
    res.end(body)
  }

  /** SSE 注册/注销，stop() 时统一断开。 */
  addSseClient(res) {
    this.sseClients.add(res)
  }

  removeSseClient(res) {
    this.sseClients.delete(res)
  }
}
