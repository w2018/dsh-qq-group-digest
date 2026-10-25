import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COOKIE_NAME,
  FAIL_LIMIT,
  clearCookie,
  ensureToken,
  generateToken,
  makeCookie,
  parseCookies,
  rateLimit,
  recordFailure,
  recordSuccess,
  resetRateLimit,
  signSession,
  verifySession,
  verifyToken,
} from '../lib/http/auth.js'
import { HttpServer } from '../lib/http/server.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-digest-http-'))
  const run = async () => fn(dir)
  return run().finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** 造一个最小 Runtime 替身：api.js 只用到 cfg / rootDir / status / actions。 */
function fakeRuntime(overrides) {
  const o = overrides || {}
  const defaults = {
    napcat: { wsUrl: 'ws://127.0.0.1:3001', token: '' },
    listen: { groups: ['100000001'], ignoreSelf: true, keywords: [], excludedSenders: {} },
    batch: { threshold: 5 },
    model: { provider: 'p', model: 'm' },
    delivery: { friends: ['100000002'] },
    storage: { dir: '', keepDays: 7 },
    httpServer: {
      enabled: true,
      port: 1213,
      host: '127.0.0.1',
      authEnabled: true,
      token: 'test-token-abcdefgh',
      sessionHours: 168,
    },
    prompt: { system: '' },
    summary: { aiDetail: false },
    ui: { sidebarEntry: false },
    dryRun: true,
  }
  // httpServer 必须逐字段合并：否则只传 { port } 会把 token / authEnabled 一起冲掉，
  // 而真实 Runtime 是走 deepMerge(DEFAULTS, raw) 的，语义上不会这样。
  const cfg = Object.assign({}, defaults, o.cfg || {}, {
    httpServer: Object.assign({}, defaults.httpServer, (o.cfg && o.cfg.httpServer) || {}),
  })
  return {
    cfg,
    rawConfig: cfg,
    rootDir: o.rootDir || '',
    restarts: 0,
    actions: o.actions || null,
    status() {
      return { started: true, restarts: this.restarts, pipeline: { groups: [] } }
    },
    reconfigure(next) {
      this.rawConfig = next
      this.cfg = Object.assign({}, this.cfg, next || {}, {
        httpServer: Object.assign({}, this.cfg.httpServer, (next && next.httpServer) || {}),
      })
      this.restarts += 1
      return { ok: true, errors: [] }
    },
    async flushAll() {
      return null
    },
    async sendTest(friends) {
      return friends.map((f) => ({ userId: f, ok: true, messageId: '1' }))
    },
  }
}

/** 拿一个真实可用的空闲端口：listen(0) 后立刻关掉。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function makeServer(runtime, extra) {
  return new HttpServer(
    Object.assign(
      {
        getRuntime: () => runtime,
        logStore: null,
        settingsFile: extra && extra.settingsFile ? extra.settingsFile : '',
        pluginRoot: '',
        logger: silentLogger,
      },
      extra || {},
    ),
  )
}

async function call(base, path, options) {
  const opts = Object.assign({ headers: {} }, options || {})
  const res = await fetch(base + path, opts)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, text, json }
}

/** 登录一次，返回可复用的 cookie 头。 */
async function login(base, token) {
  const res = await call(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const raw = res.headers.get('set-cookie') || ''
  return { res, cookie: raw.split(';')[0] }
}

// ── 端口占用 ────────────────────────────────────────────────────

test('端口被占用时 start 不抛错，status().error 有内容', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const blocker = createServer()
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve))

    const runtime = fakeRuntime({ cfg: { httpServer: { enabled: true, port, host: '127.0.0.1' } } })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    try {
      await assert.doesNotReject(() => server.start())
      const st = server.status()
      assert.equal(st.listening, false)
      assert.ok(st.error.length > 0, 'error 应该非空')
      assert.equal(st.port, port)
    } finally {
      await server.stop()
      await new Promise((resolve) => blocker.close(resolve))
    }
  })
})

test('未开启时 start 直接返回，不监听', async () => {
  await withTemp(async (dir) => {
    const runtime = fakeRuntime({ cfg: { httpServer: { enabled: false, port: 1213, host: '127.0.0.1' } } })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    const out = await server.start()
    assert.equal(out.listening, false)
    assert.equal(server.status().listening, false)
    await server.stop()
  })
})

// ── 密钥 ────────────────────────────────────────────────────────

test('ensureToken 首次生成并落盘，二次调用不再变', () => {
  const saved = []
  const cfg = { httpServer: { token: '' } }
  const first = ensureToken(cfg, (patch) => saved.push(patch))
  assert.ok(first.length >= 16, '生成的密钥不该太短')
  assert.equal(cfg.httpServer.token, first)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].httpServer.token, first)

  const second = ensureToken(cfg, (patch) => saved.push(patch))
  assert.equal(second, first)
  assert.equal(saved.length, 1, '已有密钥时不应再落盘')
})

test('ensureToken 接受完整配置对象，也容忍 writeSettings 抛错', () => {
  const full = { httpServer: { token: '' } }
  const got = ensureToken(full, () => {
    throw new Error('磁盘满了')
  })
  assert.ok(got.length > 0)
  assert.equal(full.httpServer.token, got)
})

test('verifyToken 正确 / 错误 / 长度不等 / 空密钥', () => {
  const token = generateToken()
  assert.equal(verifyToken(token, token), true)
  assert.equal(verifyToken(token, generateToken()), false)
  assert.equal(verifyToken('short', token), false, '长度不等必须 false 而不是抛错')
  assert.equal(verifyToken(token, ''), false, '期望值为空时一律拒绝')
  assert.equal(verifyToken(null, token), false)
})

// ── 登录态 ──────────────────────────────────────────────────────

test('signSession 签发的串能被 verifySession 校验', () => {
  const token = 'secret-token-1234'
  const session = signSession(token, 1)
  assert.match(session, /^\d+\.[A-Za-z0-9_-]+$/)
  assert.equal(verifySession(session, token), true)
  // 换密钥就失效
  assert.equal(verifySession(session, 'other-token'), false)
  // 篡改签名失效
  assert.equal(verifySession(session.slice(0, -2) + 'xx', token), false)
  // 空值失效
  assert.equal(verifySession('', token), false)
  assert.equal(verifySession(session, ''), false)
  assert.equal(verifySession('garbage', token), false)
})

test('session 过期后失效', () => {
  const token = 'secret-token-1234'
  // 用同一套 HMAC 规则手工签一个「已经过期」的串：exp 取过去的时间。
  const pastExp = Math.trunc(Date.now() / 1000) - 3600
  const sig = createHmac('sha256', token).update('qq-digest-session:' + pastExp).digest('base64url')
  const expired = pastExp + '.' + sig
  assert.equal(verifySession(expired, token), false, '过期必须失效，即使签名正确')

  // 同一个 exp 但签名被改：也失效
  const nowExp = Math.trunc(Date.now() / 1000) + 3600
  const goodSig = createHmac('sha256', token).update('qq-digest-session:' + nowExp).digest('base64url')
  assert.equal(verifySession(nowExp + '.' + goodSig, token), true, '未过期且签名正确应通过')
  assert.equal(verifySession(nowExp + '.' + goodSig.slice(0, -2) + 'xx', token), false)
})

test('makeCookie 带 HttpOnly / SameSite=Lax / Path=/ / Max-Age', () => {
  const cookie = makeCookie('abc.def', 2)
  assert.ok(cookie.startsWith(COOKIE_NAME + '=abc.def'))
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)
  assert.match(cookie, /Max-Age=7200/)
  assert.match(clearCookie(), /Max-Age=0/)
})

test('parseCookies 解析多片段并跳过畸形项', () => {
  const got = parseCookies('a=1; b=two; broken; ' + COOKIE_NAME + '=x.y')
  assert.equal(got.a, '1')
  assert.equal(got.b, 'two')
  assert.equal(got[COOKIE_NAME], 'x.y')
  assert.deepEqual(parseCookies(''), {})
  assert.deepEqual(parseCookies(null), {})
})

// ── 限流 ────────────────────────────────────────────────────────

test('连续失败 ' + FAIL_LIMIT + ' 次后锁定，成功则清零', () => {
  resetRateLimit()
  const ip = '10.0.0.9'
  assert.equal(rateLimit(ip).blocked, false)
  for (let i = 0; i < FAIL_LIMIT - 1; i += 1) {
    assert.equal(recordFailure(ip).blocked, false, '第 ' + (i + 1) + ' 次不该锁')
  }
  const locked = recordFailure(ip)
  assert.equal(locked.blocked, true)
  assert.ok(locked.retryAfterSec > 0)
  assert.equal(rateLimit(ip).blocked, true)

  // 另一个 IP 不受影响
  assert.equal(rateLimit('10.0.0.10').blocked, false)

  recordSuccess(ip)
  assert.equal(rateLimit(ip).blocked, false, '成功后应清零')
  resetRateLimit()
})

// ── 静态资源 ────────────────────────────────────────────────────

test('静态路径穿越被拒绝', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const runtime = fakeRuntime({ cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false } } })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    await server.start()
    try {
      const base = 'http://127.0.0.1:' + port
      // 直接问 resolveStatic 拿判定，避免依赖 fetch 对 ../ 的规范化
      assert.equal(server.resolveStatic('/../index.js'), null)
      assert.equal(server.resolveStatic('/../../package.json'), null)
      assert.ok(server.resolveStatic('/app.css'), '正常路径应解析成功')
      // HTTP 层：穿越请求不会读到插件根目录的 index.js
      const res = await call(base, '/..%2findex.js')
      assert.ok(res.status === 403 || res.status === 404, '穿越必须被拒，实际 ' + res.status)
      assert.ok(!res.text.includes('qq-group-digest'), '绝不能泄漏插件源码')
    } finally {
      await server.stop()
    }
  })
})

// 注：早期版本断言「static/ 不存在时首页 404」，但 P2 已经交付了 static/ 里的
// index.html 等文件，首页现在会正常 200。真正要守住的是「静态文件找不到时
// 安静地回 404 JSON，而不是抛错」，所以改成请求一个必然不存在的静态路径。
test('静态文件不存在时返回 404 JSON 且不崩', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const runtime = fakeRuntime({ cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false } } })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    await server.start()
    try {
      const res = await call('http://127.0.0.1:' + port, '/__no_such_page__.html')
      assert.equal(res.status, 404)
      assert.equal(res.json.ok, false)
      assert.equal(res.headers.get('cache-control'), 'no-store')

      // staticReady() 如实反映目录在不在，缺失也不该让请求崩掉。
      assert.equal(typeof server.status().staticReady, 'boolean')
    } finally {
      await server.stop()
    }
  })
})

// ── API 鉴权 ────────────────────────────────────────────────────

test('未登录访问 API 返回 401，登录后放行', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const runtime = fakeRuntime({ cfg: { httpServer: { enabled: true, port, host: '127.0.0.1' } } })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    await server.start()
    try {
      const base = 'http://127.0.0.1:' + port
      const anon = await call(base, '/api/status')
      assert.equal(anon.status, 401)
      assert.equal(anon.json.needLogin, true)

      // 错误密钥
      const bad = await call(base, '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong' }),
      })
      assert.equal(bad.status, 401)

      // 正确密钥
      const { res, cookie } = await login(base, 'test-token-abcdefgh')
      assert.equal(res.status, 200)
      assert.ok(cookie.length > 0)

      const ok = await call(base, '/api/status', { headers: { cookie } })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.ok, true)
      assert.ok(ok.json.http && ok.json.http.listening)

      // 退出后再次失效
      const out = await call(base, '/api/logout', { method: 'POST', headers: { cookie } })
      assert.equal(out.status, 200)
      assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/)
    } finally {
      await server.stop()
      resetRateLimit()
    }
  })
})

test('authEnabled=false 时跳过鉴权', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const runtime = fakeRuntime({
      cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false } },
    })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    await server.start()
    try {
      const res = await call('http://127.0.0.1:' + port, '/api/settings')
      assert.equal(res.status, 200)
      assert.equal(res.json.ok, true)
    } finally {
      await server.stop()
    }
  })
})

// ── API 语义 ────────────────────────────────────────────────────

test('GET /api/settings 暴露可编辑子集且密钥脱敏', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const runtime = fakeRuntime({
      cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false, token: 'abcdefghijklmnop' } },
    })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    await server.start()
    try {
      const res = await call('http://127.0.0.1:' + port, '/api/settings')
      assert.equal(res.status, 200)
      const s = res.json.settings
      assert.equal(s.httpServer.token, 'abcd****mnop')
      assert.equal(s.httpServer.tokenSet, true)
      assert.equal(s.httpServer.port, port)
      assert.equal(s.ui.sidebarEntry, false)
      assert.equal(res.json.defaults.historyCount, 1)
      // 明文密钥绝不能出现在响应里
      assert.ok(!res.text.includes('abcdefghijklmnop'))
    } finally {
      await server.stop()
    }
  })
})

test('POST /api/settings 保存并返回 droppedFields', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, '{}', 'utf8')
    const runtime = fakeRuntime({
      cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false } },
    })
    const server = makeServer(runtime, { settingsFile })
    await server.start()
    try {
      const res = await call('http://127.0.0.1:' + port, '/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { batch: { threshold: 42 }, bogus: { x: 1 } } }),
      })
      assert.equal(res.status, 200)
      assert.equal(res.json.ok, true)
      assert.ok(res.json.droppedFields.includes('bogus.x'), '白名单外字段应被丢弃并回报')
    } finally {
      await server.stop()
    }
  })
})

test('POST /api/prompt 校验长度：过短 400、超长 400、合法 200', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, '{}', 'utf8')
    const runtime = fakeRuntime({
      cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false } },
    })
    const server = makeServer(runtime, { settingsFile })
    await server.start()
    try {
      const base = 'http://127.0.0.1:' + port
      const post = (body) =>
        call(base, '/api/prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      const tooShort = await post({ system: '短' })
      assert.equal(tooShort.status, 400)

      const tooLong = await post({ system: 'x'.repeat(20001) })
      assert.equal(tooLong.status, 400)
      assert.equal(tooLong.json.maxChars, 20000)

      const fine = await post({ system: 'y'.repeat(60) })
      assert.equal(fine.status, 200)
      assert.equal(fine.json.ok, true)

      const got = await call(base, '/api/prompt')
      assert.equal(got.json.system.length, 60)
      assert.equal(got.json.isDefault, false)
      assert.equal(got.json.maxChars, 20000)
      assert.ok(got.json.defaultPrompt.length > 0)

      const reset = await call(base, '/api/prompt/reset', { method: 'POST' })
      assert.equal(reset.status, 200)
      assert.equal(reset.json.isDefault, true)
    } finally {
      await server.stop()
    }
  })
})

test('GET /api/token 只回脱敏值，POST /api/token/generate 回一次明文', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, '{}', 'utf8')
    const runtime = fakeRuntime({
      cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false, token: 'abcdefghijklmnop' } },
    })
    const server = makeServer(runtime, { settingsFile })
    await server.start()
    try {
      const base = 'http://127.0.0.1:' + port
      const masked = await call(base, '/api/token')
      assert.equal(masked.json.tokenMasked, 'abcd****mnop')
      assert.equal(masked.json.tokenSet, true)
      assert.ok(!masked.text.includes('abcdefghijklmnop'))

      const gen = await call(base, '/api/token/generate', { method: 'POST' })
      assert.equal(gen.status, 200)
      assert.ok(gen.json.token.length >= 16)
      assert.equal(gen.json.tokenMasked.slice(0, 4), gen.json.token.slice(0, 4))
    } finally {
      await server.stop()
    }
  })
})

test('未知 /api/* 返回 404 JSON，不会落到静态分支', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const runtime = fakeRuntime({
      cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false } },
    })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    await server.start()
    try {
      const res = await call('http://127.0.0.1:' + port, '/api/nope')
      assert.equal(res.status, 404)
      assert.equal(res.json.ok, false)
    } finally {
      await server.stop()
    }
  })
})

test('requestCount 随请求递增，stop 后 listening 归零', async () => {
  await withTemp(async (dir) => {
    const port = await freePort()
    const runtime = fakeRuntime({
      cfg: { httpServer: { enabled: true, port, host: '127.0.0.1', authEnabled: false } },
    })
    const server = makeServer(runtime, { settingsFile: join(dir, 'settings.json') })
    await server.start()
    const before = server.status().requestCount
    await call('http://127.0.0.1:' + port, '/api/token')
    assert.ok(server.status().requestCount > before)
    await server.stop()
    assert.equal(server.status().listening, false)
  })
})
