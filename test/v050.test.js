import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Runtime } from '../lib/runtime.js'
import { NapCatWsClient } from '../lib/transport/napcat-ws.js'
import { callOnce } from '../lib/summarize/summarize.js'
import { Pipeline } from '../lib/pipeline.js'
import { MessageStore } from '../lib/store/messages.js'
import { SummaryHistory } from '../lib/store/history.js'
import { resolveConfig } from '../lib/config.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEvent, baseConfig, fakeLlm, fakeCtx, fakeActions, silentLogger } from './helpers.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'qqd-v050-'))
}

// ── B：callOnce 的新返回形状与截断语义 ──────────────────────────

test('B: callOnce 返回 { text, finishKind, reasoningChars }', async () => {
  const llm = fakeLlm([{ text: '正常输出', reasoning: '想了一下', finishKind: 'stop' }])
  const out = await callOnce({ provider: 'p', model: 'm', llm }, 'sys', 'user', { maxTokens: 1000 }, undefined)
  assert.equal(typeof out, 'object')
  assert.equal(out.text, '正常输出')
  assert.equal(out.finishKind, 'stop')
  assert.equal(out.reasoningChars, '想了一下'.length)
})

test('B: callOnce 遇到 finishKind=max-tokens 原样返回，由上层决定是否抛错', async () => {
  const llm = fakeLlm([{ text: '被截断', reasoning: '推理', finishKind: 'max-tokens' }])
  const out = await callOnce({ provider: 'p', model: 'm', llm }, 'sys', 'user', { maxTokens: 1000 }, undefined)
  assert.equal(out.finishKind, 'max-tokens')
  assert.equal(out.text, '被截断')
  assert.equal(out.reasoningChars, 2)
})

test('B: callOnce 传 maxTokens 时原样交给 llm，缺省回落到 2048', async () => {
  const llm = fakeLlm([{ text: 'x' }])
  await callOnce({ provider: 'p', model: 'm', llm }, 'sys', 'user', { maxTokens: 1234 }, undefined)
  assert.equal(llm.calls[0].maxTokens, 1234)
  await callOnce({ provider: 'p', model: 'm', llm }, 'sys', 'user', {}, undefined)
  assert.equal(llm.calls[1].maxTokens, 2048)
})

// ── C：精细版正文兜底截断（1200 软口径 / 1600 硬上限） ──────────

function buildPipelineWithDetail(overrides, llm) {
  const { config } = resolveConfig(Object.assign(baseConfig(), overrides || {}))
  const dir = tempDir()
  const pipeline = new Pipeline({
    ctx: fakeCtx(llm || fakeLlm()),
    config,
    actions: fakeActions(0),
    store: new MessageStore(dir),
    history: new SummaryHistory(join(dir, 'summaries')),
    logger: silentLogger,
    outboxDir: dir,
  })
  pipeline.start()
  return { pipeline, config, dir }
}

async function runDetailCase(detailText) {
  const detail = [
    '# 100000001 · AI大模型交流',
    '',
    '## 要点',
    detailText,
    '',
    '<!--FOCUS',
    '{"111":"重点"}',
    '-->',
  ].join('\n')
  const llm = fakeLlm([
    { text: '本批讨论了本地模型与上云的取舍，结论是先用本地模型跑一轮再评估效果。' },
    { text: detail },
  ])
  const { pipeline } = buildPipelineWithDetail(
    { batch: { threshold: 2, freezeGraceMs: 0 }, summary: { aiDetail: true } },
    llm,
  )
  const entries = []
  pipeline.onGroupSummary = async (e) => entries.push(e)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1, text: 'a', userId: 111, nickname: '张三' }))
  pipeline.handleEvent(makeEvent({ msgId: '2', realSeq: 2, text: 'b', userId: 222, nickname: '李四' }))
  await new Promise((r) => setTimeout(r, 250))
  pipeline.dispose()
  return entries[0]
}

test('C: 精细版正文未超 1600 字时原样保留，不加截断说明', async () => {
  const entry = await runDetailCase('短正文。'.repeat(50))
  assert.equal(entry.aiDetail, true)
  assert.equal(entry.md.includes('内容较长，已截断'), false)
})

test('C: 精细版正文超过 1600 字时在段落边界截断并追加说明', async () => {
  // 每段 100 字，共 30 段（3000 字），超过 1600 硬上限。
  const para = '这是一段用于验证精细版长度兜底的正文内容，重复填充到一百字左右以便稳定触发截断。'.repeat(2)
  const entry = await runDetailCase(Array.from({ length: 30 }, () => para).join('\n\n'))
  assert.equal(entry.aiDetail, true)
  assert.ok(entry.md.endsWith('…（内容较长，已截断）'), '应追加截断说明')
  assert.ok(entry.md.length <= 1600 + '\n\n…（内容较长，已截断）'.length + 2, '截断后不应明显超出硬上限')
})

// ── E：delivery.friends 为空时只落盘不发 QQ ────────────────────

test('E: friends 为空时不发 QQ，返回 ok 且历史回填 0/0', async () => {
  const llm = fakeLlm([{ text: '本批讨论了部署方式，结论是先用本地模型跑一轮再说。' }])
  const dir = tempDir()
  const { config } = resolveConfig(
    baseConfig({ delivery: { friends: [], aggregateWindowMs: 0 }, batch: { threshold: 1, freezeGraceMs: 0 } }),
  )
  assert.deepEqual(config.delivery.friends, [])
  const actions = fakeActions(0)
  const history = new SummaryHistory(join(dir, 'summaries'))
  const pipeline = new Pipeline({
    ctx: fakeCtx(llm),
    config,
    actions,
    store: new MessageStore(dir),
    history,
    logger: silentLogger,
    outboxDir: dir,
  })
  pipeline.start()
  const entries = []
  pipeline.onGroupSummary = async (e) => entries.push(e)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1, text: 'a' }))
  await new Promise((r) => setTimeout(r, 150))

  assert.equal(entries.length, 1)
  const out = await pipeline.deliverEntries(entries, 1792825000)
  assert.deepEqual(out.result.delivered, [])
  assert.deepEqual(out.result.failed, [])
  assert.equal(out.result.perGroup.length, 1)
  assert.equal(out.result.perGroup[0].ok, true)
  assert.equal(actions.sent.length, 0, '未配置投递目标时不该调用 sendPrivate')

  const latest = history.latest('100000001')
  assert.equal(latest.delivered, 0)
  assert.equal(latest.failed, 0)
  pipeline.dispose()
})

test('E: 配了 friends 时照常投递（对照组）', async () => {
  const llm = fakeLlm([{ text: '本批讨论了部署方式，结论是先用本地模型跑一轮再说。' }])
  const dir = tempDir()
  const { config } = resolveConfig(
    baseConfig({
      delivery: { friends: ['100000002'], aggregateWindowMs: 0 },
      batch: { threshold: 1, freezeGraceMs: 0 },
      dryRun: false,
    }),
  )
  const actions = fakeActions(0)
  const pipeline = new Pipeline({
    ctx: fakeCtx(llm),
    config,
    actions,
    store: new MessageStore(dir),
    history: new SummaryHistory(join(dir, 'summaries')),
    logger: silentLogger,
    outboxDir: dir,
  })
  pipeline.start()
  const entries = []
  pipeline.onGroupSummary = async (e) => entries.push(e)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1, text: 'a' }))
  await new Promise((r) => setTimeout(r, 150))
  const out = await pipeline.deliverEntries(entries, 1792825000)
  assert.equal(out.result.delivered.length, 1)
  assert.equal(actions.sent.length, 1)
  pipeline.dispose()
})

test('E: status().delivery.configured 反映是否配了投递目标', () => {
  const none = new Runtime({ ctx: fakeCtx(fakeLlm()), rawConfig: baseConfig({ delivery: { friends: [] } }) })
  assert.deepEqual(none.errors, [])
  assert.equal(none.status().delivery.configured, false)

  const some = new Runtime({ ctx: fakeCtx(fakeLlm()), rawConfig: baseConfig({ delivery: { friends: ['100000002'] } }) })
  assert.equal(some.status().delivery.configured, true)
})

// ── F：WS 重连可观测字段 ──────────────────────────────────────

test('F: linkStatus 初始为未连接，字段齐全且都是安全默认值', () => {
  const client = new NapCatWsClient({ wsUrl: 'ws://127.0.0.1:3001' })
  const st = client.linkStatus()
  assert.equal(st.connected, false)
  assert.equal(st.reconnecting, false)
  assert.equal(st.retryInMs, 0)
  assert.equal(st.nextRetryAt, 0)
  assert.equal(st.reconnectAttempt, 0)
  assert.equal(st.lastConnectedAt, 0)
  assert.equal(st.lastDisconnectAt, 0)
  assert.equal(st.wsUrl, 'ws://127.0.0.1:3001')
  client.close()
})

test('F: 重连中 linkStatus 带出倒计时与第几次重连', () => {
  const client = new NapCatWsClient({ wsUrl: 'ws://127.0.0.1:3001' })
  client.reconnecting = true
  client.reconnectAttempt = 3
  client.retryInMs = 2000
  client.nextRetryAt = Date.now() + 2000
  client.lastDisconnectAt = Date.now()
  const st = client.linkStatus()
  assert.equal(st.reconnecting, true)
  assert.equal(st.reconnectAttempt, 3)
  assert.equal(st.retryInMs, 2000)
  assert.ok(st.nextRetryAt > 0)
  assert.ok(st.lastDisconnectAt > 0)
  client.close()
})

test('F: close() 后不再是重连态，倒计时归零', () => {
  const client = new NapCatWsClient({ wsUrl: 'ws://127.0.0.1:3001' })
  client.reconnecting = true
  client.reconnectAttempt = 2
  client.retryInMs = 5000
  client.nextRetryAt = Date.now() + 5000
  client.close()
  const st = client.linkStatus()
  assert.equal(st.reconnecting, false)
  assert.equal(st.retryInMs, 0)
  assert.equal(st.nextRetryAt, 0)
})

test('F: runtime.status().ws 保留旧字段并合并 linkStatus 的新字段', () => {
  const runtime = new Runtime({ ctx: fakeCtx(fakeLlm()), rawConfig: baseConfig() })
  // 不真连网：塞一个只提供 linkStatus 的替身，验证合并逻辑本身。
  runtime.client = {
    ready: false,
    stats: { connects: 1 },
    linkStatus: () => ({
      connected: false,
      reconnecting: true,
      retryInMs: 1500,
      nextRetryAt: 1700000000000,
      reconnectAttempt: 2,
      lastConnectedAt: 1699999999000,
      lastDisconnectAt: 1699999999500,
      wsUrl: 'ws://127.0.0.1:3001',
    }),
  }
  const ws = runtime.status().ws
  // 旧前端依赖的三个字段必须还在，且不被 linkStatus 覆盖。
  assert.equal(ws.connected, false)
  assert.equal(ws.url, 'ws://127.0.0.1:3001')
  assert.deepEqual(ws.stats, { connects: 1 })
  // 新前端读的重连字段。
  assert.equal(ws.reconnecting, true)
  assert.equal(ws.retryInMs, 1500)
  assert.equal(ws.nextRetryAt, 1700000000000)
  assert.equal(ws.reconnectAttempt, 2)
  assert.equal(ws.lastConnectedAt, 1699999999000)
  assert.equal(ws.lastDisconnectAt, 1699999999500)
})

test('F: client 没有 linkStatus 时 status().ws 仍返回旧三字段（向后兼容）', () => {
  const runtime = new Runtime({ ctx: fakeCtx(fakeLlm()), rawConfig: baseConfig() })
  assert.equal(runtime.client, null)
  const ws = runtime.status().ws
  assert.equal(ws.connected, false)
  assert.equal(typeof ws.url, 'string')
  assert.deepEqual(ws.stats, {})

  // 旧版 client 没有 linkStatus 方法时也不能抛错。
  runtime.client = { ready: true, stats: {} }
  const ws2 = runtime.status().ws
  assert.equal(ws2.connected, true)
  assert.equal(ws2.reconnecting, undefined)
})
