import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../lib/config.js'
import { Pipeline } from '../lib/pipeline.js'
import { makeEvent, baseConfig, fakeLlm, fakeCtx, fakeActions, silentLogger } from './helpers.js'

/** 轻量管线：start() 后 handleEvent 才会被接受。 */
function build(configOverrides) {
  const { config } = resolveConfig(Object.assign(baseConfig(), configOverrides || {}))
  const pipeline = new Pipeline({
    ctx: fakeCtx(fakeLlm()),
    config,
    actions: fakeActions(0),
    logger: silentLogger,
    outboxDir: '',
  })
  pipeline.start()
  return pipeline
}

test('snapshotPending 导出未冻结的 pending 记录', () => {
  const p = build({ batch: { threshold: 100, freezeGraceMs: 0 } })
  p.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  p.handleEvent(makeEvent({ msgId: '2', realSeq: 2 }))
  const snap = p.snapshotPending()
  assert.equal(snap.size, 1)
  assert.equal(snap.get('100000001').length, 2)
})

test('新 Pipeline 通过 pendingSeed 继承旧管线未总结的消息', () => {
  const old = build({ batch: { threshold: 100, freezeGraceMs: 0 } })
  old.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  old.handleEvent(makeEvent({ msgId: '2', realSeq: 2 }))
  const seed = old.snapshotPending()

  const { config } = resolveConfig(Object.assign(baseConfig(), { batch: { threshold: 100, freezeGraceMs: 0 } }))
  const next = new Pipeline({
    ctx: fakeCtx(fakeLlm()),
    config,
    actions: fakeActions(0),
    logger: silentLogger,
    outboxDir: '',
    pendingSeed: seed,
  })
  next.start()
  assert.equal(next.accumulators.get('100000001').pending, 2, '恢复后 pending 应为 2')
  assert.equal(next.stats.accepted, 2)
  next.dispose()
})

test('恢复的 pending 在新阈值下能立刻触发冻结', async () => {
  const llm = fakeLlm([{ text: '恢复后立刻总结的一段足够长的文本内容。' }])
  const old = build({ batch: { threshold: 100, freezeGraceMs: 0 } })
  for (let i = 1; i <= 3; i += 1) old.handleEvent(makeEvent({ msgId: String(i), realSeq: i }))
  const seed = old.snapshotPending()

  const { config } = resolveConfig(
    Object.assign(baseConfig(), { batch: { threshold: 3, freezeGraceMs: 0 } }),
  )
  const next = new Pipeline({
    ctx: fakeCtx(llm),
    config,
    actions: fakeActions(0),
    logger: silentLogger,
    outboxDir: '',
    pendingSeed: seed,
  })
  next.start()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(llm.calls.length, 1, '恢复后 3 条应触发一次总结')
  next.dispose()
})

test('恢复时群已不在监听列表则丢弃并告警', () => {
  const old = build({ batch: { threshold: 100, freezeGraceMs: 0 } })
  old.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  const seed = old.snapshotPending()

  const { config } = resolveConfig(
    Object.assign(baseConfig(), { listen: { groups: ['111'] }, batch: { threshold: 100, freezeGraceMs: 0 } }),
  )
  const warnings = []
  const next = new Pipeline({
    ctx: fakeCtx(fakeLlm()),
    config,
    actions: fakeActions(0),
    logger: { info() {}, warn(m) { warnings.push(m) }, error() {}, debug() {} },
    outboxDir: '',
    pendingSeed: seed,
  })
  next.start()
  assert.equal(next.stats.accepted, 0)
  assert.ok(warnings.some((w) => w.includes('已不在监听列表')))
  next.dispose()
})

test('恢复的记录写进去重集合，重放不会二次计数', () => {
  const old = build({ batch: { threshold: 100, freezeGraceMs: 0 } })
  old.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  const seed = old.snapshotPending()

  const { config } = resolveConfig(Object.assign(baseConfig(), { batch: { threshold: 100, freezeGraceMs: 0 } }))
  const next = new Pipeline({
    ctx: fakeCtx(fakeLlm()),
    config,
    actions: fakeActions(0),
    logger: silentLogger,
    outboxDir: '',
    pendingSeed: seed,
  })
  next.start()
  next.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  assert.equal(next.stats.duplicate, 1, '同一条消息重放应判为重复')
  assert.equal(next.accumulators.get('100000001').pending, 1)
  next.dispose()
})
