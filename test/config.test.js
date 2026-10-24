import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig, deepMerge, normalizeIdList, storageRoot } from '../lib/config.js'

test('deepMerge 递归合并且数组整体替换', () => {
  const out = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 9 }, list: [3] })
  assert.equal(out.a.b, 1)
  assert.equal(out.a.c, 9)
  assert.deepEqual(out.list, [3])
})

test('normalizeIdList 去空去重保序', () => {
  assert.deepEqual(normalizeIdList(['1', ' 2 ', '', '1', null]), ['1', '2'])
})

test('resolveConfig 校验 provider 与 model 必须成对', () => {
  const { errors } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { provider: 'p' } })
  assert.ok(errors.some((e) => e.includes('同时留空或同时填写')))
})

test('resolveConfig 拒绝非法 wsUrl', () => {
  const { errors } = resolveConfig({ napcat: { wsUrl: 'http://x' }, listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.ok(errors.some((e) => e.includes('ws://')))
})

test('resolveConfig dryRun 时允许 friends 为空', () => {
  const { errors } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: [] }, dryRun: true })
  assert.equal(errors.filter((e) => e.includes('delivery.friends')).length, 0)
})

test('resolveConfig 按群覆盖阈值', () => {
  const { config } = resolveConfig({
    listen: { groups: ['1', '2'] },
    delivery: { friends: ['9'] },
    batch: { threshold: 100, perGroupOverride: { '2': { threshold: 20 } } },
  })
  assert.equal(config.batch.perGroupOverride['2'].threshold, 20)
})

test('storageRoot 支持自定义目录', () => {
  assert.equal(storageRoot({ storage: { dir: 'D:/tmp/x' } }), 'D:/tmp/x')
  assert.match(storageRoot({ storage: { dir: '' } }), /qq-digest$/)
})
test('resolveConfig ui.sidebarEntry 默认为 false', () => {
  const { config } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.equal(config.ui.sidebarEntry, false)
})

test('resolveConfig 接受 ui.sidebarEntry=true', () => {
  const { config } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, ui: { sidebarEntry: true } })
  assert.equal(config.ui.sidebarEntry, true)
})

test('resolveConfig ui.sidebarEntry 只认严格 true', () => {
  const { config } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, ui: { sidebarEntry: 'yes' } })
  assert.equal(config.ui.sidebarEntry, false)
})

test('resolveConfig model.historyCount 默认 1 并 clamp 到 0..10', () => {
  const base = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.equal(base.config.model.historyCount, 1)

  const hi = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { historyCount: 99 } })
  assert.equal(hi.config.model.historyCount, 10)

  const lo = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { historyCount: -5 } })
  assert.equal(lo.config.model.historyCount, 0)

  const mid = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { historyCount: 4 } })
  assert.equal(mid.config.model.historyCount, 4)
})

test('resolveConfig model.maxHistoryChars 默认 2000 并 clamp 到 0..20000', () => {
  const base = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.equal(base.config.model.maxHistoryChars, 2000)

  const hi = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { maxHistoryChars: 999999 } })
  assert.equal(hi.config.model.maxHistoryChars, 20000)

  const lo = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { maxHistoryChars: -1 } })
  assert.equal(lo.config.model.maxHistoryChars, 0)
})
