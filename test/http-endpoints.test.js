import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { DEFAULT_SYSTEM_PROMPT } from '../lib/summarize/prompt-store.js'

// 关键：先把 DSH_HOME 指到临时目录，再 import index.js。
// 否则 storage.dir 为空时 settings.json 会落到用户真实的 ~/.dsh 下。
const dshHomeDir = mkdtempSync(join(tmpdir(), 'qq-digest-home-'))
process.env.DSH_HOME = dshHomeDir

const { apply } = await import('../index.js')

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

let tmpRoot = ''
let handler = null
let settingsFile = ''
const disposers = []

/** 用假的 ctx 挂上插件，拿到它注册到 webServer 的 handler。 */
function bootPlugin() {
  tmpRoot = mkdtempSync(join(tmpdir(), 'qq-digest-http-api-'))
  // 与插件内部的解析保持一致：storage.dir 为空 → $DSH_HOME/storages/qq-digest。
  settingsFile = join(dshHomeDir, 'storages', 'qq-digest', 'settings.json')
  const ctx = {
    logger: silentLogger,
    get: () => undefined,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(meta) {
        handler = meta.handler
        return () => {
          handler = null
        }
      },
    },
  }
  // 刻意不传 storage.dir：让插件按 $DSH_HOME 自己推导落点，
  // 这样 readSettingsFile() 读的路径与插件真正写的路径永远是同一个。
  apply(ctx, {
    listen: { groups: ['971342795'] },
    delivery: { friends: ['201956703'] },
    dryRun: true,
  })
}

/** 发一次请求，返回 { status, body }。 */
function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
    req.method = method
    req.url = pathname
    let status = 0
    let text = ''
    const res = {
      writeHead(code) {
        status = code
      },
      end(chunk) {
        text = chunk === undefined ? '' : String(chunk)
        let parsed = {}
        try {
          parsed = text ? JSON.parse(text) : {}
        } catch {
          parsed = { raw: text }
        }
        resolve({ status, body: parsed, raw: text })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

/**
 * 读设置文件的原始 JSON。
 *
 * 这里不能用 lib/store/settings.js 的 readSettings()：它会过白名单，
 * 而 prompt.system / httpServer.token 正是刻意被排除在白名单外的字段。
 */
function readSettingsFile() {
  if (!existsSync(settingsFile)) return { httpServer: {} }
  return JSON.parse(readFileSync(settingsFile, 'utf8'))
}

before(() => {
  bootPlugin()
})

after(() => {
  // 拆掉运行态：否则 WebSocket 客户端会吊住事件循环，测试进程不退出。
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* 卸载时尽力而为 */
    }
  }
  disposers.length = 0
  for (const dir of [tmpRoot, dshHomeDir]) {
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
})

test('GET /prompt 未自定义时返回内置默认并标记 isDefault', async () => {
  const r = await call('GET', '/api/qq-digest/prompt')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.isDefault, true)
  // system 是「settings.json 里存的原样值」：未自定义时是空串。
  assert.equal(r.body.system, '')
  // effective 才是真正送给模型的提示词。
  assert.equal(r.body.effective, DEFAULT_SYSTEM_PROMPT)
  assert.equal(r.body.defaultPrompt, DEFAULT_SYSTEM_PROMPT)
  assert.equal(r.body.maxChars, 20000)
  assert.equal(r.body.minChars, 10)
})

test('POST /prompt 保存自定义提示词并落盘', async () => {
  const custom = '你是一个群聊摘要助手。请用中文输出要点，保留昵称与链接，不要编造未出现的信息。'
  const r = await call('POST', '/api/qq-digest/prompt', { system: custom })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.isDefault, false)
  assert.equal(r.body.droppedFields.length, 0)

  const back = await call('GET', '/api/qq-digest/prompt')
  assert.equal(back.body.system, custom)
  assert.equal(back.body.effective, custom)
  assert.equal(back.body.isDefault, false)

  // prompt.system 不在 settings.js 白名单里，必须靠专用端点原样落盘。
  assert.equal(readSettingsFile().prompt.system, custom)
})

test('POST /prompt 拒绝超过 20000 字符的提示词', async () => {
  const r = await call('POST', '/api/qq-digest/prompt', { system: 'a'.repeat(20001) })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /过长/)
  assert.equal(r.body.maxChars, 20000)
})

test('POST /prompt 拒绝非空但过短的提示词', async () => {
  const r = await call('POST', '/api/qq-digest/prompt', { system: '太短了' })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /太短/)
})

test('POST /prompt 传空串等价于恢复默认', async () => {
  const r = await call('POST', '/api/qq-digest/prompt', { system: '' })
  assert.equal(r.status, 200)
  assert.equal(r.body.isDefault, true)
  assert.equal(readSettingsFile().prompt.system, '')
})

test('POST /prompt 传与内置默认逐字相同的内容时存空串', async () => {
  const r = await call('POST', '/api/qq-digest/prompt', { system: DEFAULT_SYSTEM_PROMPT })
  assert.equal(r.status, 200)
  assert.equal(r.body.isDefault, true)
  assert.equal(readSettingsFile().prompt.system, '')
})

test('POST /prompt/reset 清空自定义提示词', async () => {
  await call('POST', '/api/qq-digest/prompt', { system: '这是一段自定义提示词，长度足够通过校验，用来验证 reset 语义是否正确。' })
  const before = await call('GET', '/api/qq-digest/prompt')
  assert.equal(before.body.isDefault, false)

  const r = await call('POST', '/api/qq-digest/prompt/reset', {})
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.isDefault, true)
  assert.equal(r.body.system, '')
  assert.equal(r.body.effective, DEFAULT_SYSTEM_PROMPT)
  assert.equal(readSettingsFile().prompt.system, '')

  const after = await call('GET', '/api/qq-digest/prompt')
  assert.equal(after.body.isDefault, true)
  assert.equal(after.body.system, '')
  assert.equal(after.body.effective, DEFAULT_SYSTEM_PROMPT)
})

test('GET /settings 带出 promptSystem、summaryAiDetail 与新能力声明', async () => {
  const r = await call('GET', '/api/qq-digest/settings')
  assert.equal(r.status, 200)
  assert.equal(r.body.backendVersion, 4)
  assert.ok(r.body.capabilities.includes('prompt'))
  assert.ok(r.body.capabilities.includes('http'))
  assert.equal(typeof r.body.promptSystem, 'string')
  assert.equal(r.body.summaryAiDetail, false)
  assert.equal(typeof r.body.defaultPrompt, 'string')
  assert.equal(typeof r.body.httpServer, 'object')
  assert.equal(typeof r.body.httpServer.enabled, 'boolean')
})

test('GET /http 只回掩码，绝不返回完整密钥', async () => {
  const regen = await call('POST', '/api/qq-digest/http/token', {})
  assert.equal(regen.status, 200)
  const plain = regen.body.token
  assert.equal(typeof plain, 'string')
  assert.equal(plain.length, 32)
  assert.match(plain, /^[0-9a-f]{32}$/)
  assert.equal(regen.body.ok, true)

  const r = await call('GET', '/api/qq-digest/http')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.hasToken, true)
  assert.equal(r.body.tokenSet, true)
  // 掩码只露后 4 位。
  assert.equal(r.body.tokenPreview, '****' + plain.slice(-4))
  assert.equal(r.body.tokenMasked, '****' + plain.slice(-4))
  // 整个响应体里不能出现完整密钥。
  assert.equal(r.raw.includes(plain), false)
})

test('POST /http 端口越界返回 400', async () => {
  const low = await call('POST', '/api/qq-digest/http', { port: 80 })
  assert.equal(low.status, 400)
  assert.match(low.body.error, /端口/)

  const high = await call('POST', '/api/qq-digest/http', { port: 70000 })
  assert.equal(high.status, 400)
})

test('POST /http 端口被占用时仍保存配置，但响应里带 error', async () => {
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve))
  const busyPort = blocker.address().port
  try {
    const r = await call('POST', '/api/qq-digest/http', { enabled: true, port: busyPort })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.match(String(r.body.error || ''), /占用/)
    // 配置照存，用户改个端口就能用。
    assert.equal(readSettingsFile().httpServer.port, busyPort)

    // 监听重启是 setImmediate 异步的：等它跑完，再看 GET /http 有没有把
    // 「端口被占用」这个真实失败原因报上来。
    await new Promise((resolve) => setTimeout(resolve, 150))
    const live = await call('GET', '/api/qq-digest/http')
    assert.equal(live.body.enabled, true)
    assert.equal(live.body.listening, false)
    assert.match(String(live.body.error || ''), /占用/)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('POST /http 传 __REGEN__ 重新生成密钥并回明文', async () => {
  const r = await call('POST', '/api/qq-digest/http', { token: '__REGEN__' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(typeof r.body.token, 'string')
  assert.equal(r.body.token.length, 32)
  assert.equal(readSettingsFile().httpServer.token, r.body.token)
})

test('POST /http 传空串保持密钥不变', async () => {
  const before = readSettingsFile().httpServer.token
  const r = await call('POST', '/api/qq-digest/http', { token: '' })
  assert.equal(r.status, 200)
  assert.equal(r.body.token, undefined)
  assert.equal(readSettingsFile().httpServer.token, before)
})

test('POST /http/token 生成新密钥，与旧密钥不同', async () => {
  const first = await call('POST', '/api/qq-digest/http/token', {})
  const second = await call('POST', '/api/qq-digest/http/token', {})
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.notEqual(first.body.token, second.body.token)
  assert.equal(readSettingsFile().httpServer.token, second.body.token)
  assert.equal(second.body.tokenPreview, '****' + second.body.token.slice(-4))
})


/** 找一个当前空闲的端口（避免测试间互相撞端口）。 */
async function findFreePort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '0.0.0.0', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

test('开启网页服务后 GET /http 反映真实监听状态', async () => {
  const port = await findFreePort()
  const saved = await call('POST', '/api/qq-digest/http', { enabled: true, port, host: '127.0.0.1' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)

  // 监听是异步重启的，轮询等它真的起来。
  let live = null
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    live = await call('GET', '/api/qq-digest/http')
    if (live.body.listening) break
  }
  assert.equal(live.body.enabled, true)
  assert.equal(live.body.listening, true)
  assert.equal(live.body.running, true)
  assert.equal(live.body.port, port)
  assert.equal(live.body.error, '')
  assert.equal(live.body.url, 'http://127.0.0.1:' + port + '/')

  // 关掉之后监听要真的停，否则插件卸载了端口还占着。
  const off = await call('POST', '/api/qq-digest/http', { enabled: false })
  assert.equal(off.status, 200)
  let after = null
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    after = await call('GET', '/api/qq-digest/http')
    if (!after.body.listening) break
  }
  assert.equal(after.body.enabled, false)
  assert.equal(after.body.listening, false)
  assert.equal(after.body.url, '')
})

test('GET /prompt 的 system 是落盘原样值，effective 才是生效提示词', async () => {
  const custom = '只保留技术讨论，其余忽略；每条要点标注发言人昵称。'
  const saved = await call('POST', '/api/qq-digest/prompt', { system: custom })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.system, custom)
  assert.equal(saved.body.effective, custom)

  const got = await call('GET', '/api/qq-digest/prompt')
  assert.equal(got.body.system, custom)
  assert.equal(got.body.effective, custom)
  assert.equal(got.body.isDefault, false)

  // 收尾：恢复默认，避免影响后续用例的初始状态。
  await call('POST', '/api/qq-digest/prompt/reset', {})
})

test('未知路由返回 404', async () => {
  const r = await call('GET', '/api/qq-digest/nope')
  assert.equal(r.status, 404)
  assert.equal(r.body.ok, false)
})