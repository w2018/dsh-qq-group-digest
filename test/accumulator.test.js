import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GroupAccumulator } from '../lib/batch/accumulator.js'

function rec(i) {
  return { groupId: '1', msgId: String(i), realSeq: i, timeSec: 100 + i, arrival: i, text: 'm' + i, senderName: 'u' }
}

test('达到阈值即冻结，计数归零', async () => {
  const frozen = []
  const acc = new GroupAccumulator('1', { threshold: 5, freezeGraceMs: 0, maxBuffer: 100 })
  for (let i = 1; i <= 5; i += 1) acc.push(rec(i), (b) => frozen.push(b))
  assert.equal(frozen.length, 1)
  assert.equal(frozen[0].records.length, 5)
  assert.equal(frozen[0].reason, 'threshold')
  assert.equal(acc.pending, 0)
  acc.dispose()
})

test('150 条产生 1 批 100 条，余 50 条留在 pending', () => {
  const frozen = []
  const acc = new GroupAccumulator('1', { threshold: 100, freezeGraceMs: 0, maxBuffer: 1000 })
  for (let i = 1; i <= 150; i += 1) acc.push(rec(i), (b) => frozen.push(b))
  assert.equal(frozen.length, 1)
  assert.equal(frozen[0].records.length, 100)
  assert.equal(acc.pending, 50)
  acc.dispose()
})

test('maxBuffer 触发强制冻结', () => {
  const frozen = []
  const acc = new GroupAccumulator('1', { threshold: 100, freezeGraceMs: 0, maxBuffer: 3 })
  for (let i = 1; i <= 3; i += 1) acc.push(rec(i), (b) => frozen.push(b))
  assert.equal(frozen.length, 1)
  assert.equal(frozen[0].reason, 'max-buffer')
  acc.dispose()
})

test('冻结后新消息进入下一批，不污染已冻结快照', () => {
  const frozen = []
  const acc = new GroupAccumulator('1', { threshold: 2, freezeGraceMs: 0, maxBuffer: 100 })
  acc.push(rec(1), (b) => frozen.push(b))
  acc.push(rec(2), (b) => frozen.push(b))
  acc.push(rec(3), (b) => frozen.push(b))
  acc.push(rec(4), (b) => frozen.push(b))
  assert.equal(frozen.length, 2)
  assert.equal(frozen[0].records.length, 2)
  assert.equal(frozen[1].records.length, 2)
  acc.dispose()
})

test('grace 宽限期到期才冻结', async () => {
  const frozen = []
  const acc = new GroupAccumulator('1', { threshold: 2, freezeGraceMs: 30, maxBuffer: 100 })
  acc.push(rec(1), (b) => frozen.push(b))
  acc.push(rec(2), (b) => frozen.push(b))
  assert.equal(frozen.length, 0)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(frozen.length, 1)
  acc.dispose()
})

test('maxWait 兜底触发', async () => {
  const frozen = []
  const acc = new GroupAccumulator('1', { threshold: 100, freezeGraceMs: 0, maxBuffer: 1000, maxWaitMs: 1000 })
  acc.push(rec(1), (b) => frozen.push(b))
  await new Promise((r) => setTimeout(r, 1150))
  assert.equal(frozen.length, 1)
  assert.equal(frozen[0].reason, 'max-wait')
  acc.dispose()
})
