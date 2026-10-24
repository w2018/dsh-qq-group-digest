import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeEvent, renderSegments } from '../lib/ingest/normalize.js'
import { DedupSet } from '../lib/ingest/dedup.js'
import { GroupBuffer, compareRecords } from '../lib/ingest/order.js'
import { makeEvent } from './helpers.js'

test('renderSegments 把段数组压成文本', () => {
  const text = renderSegments([
    { type: 'at', data: { qq: '123' } },
    { type: 'text', data: { text: ' 你好' } },
    { type: 'image', data: { file: 'x.jpg' } },
    { type: 'face', data: { id: '1' } },
  ])
  assert.equal(text, '@123 你好[图片][表情]')
})

test('normalizeEvent 规范化群消息', () => {
  const { record } = normalizeEvent(makeEvent({ text: 'hello', msgId: '555', realSeq: 9001 }), {
    groups: new Set(['100000001']),
    selfId: '100000000',
  })
  assert.equal(record.groupId, '100000001')
  assert.equal(record.msgId, '555')
  assert.equal(record.realSeq, 9001)
  assert.equal(record.text, 'hello')
  assert.equal(record.senderName, '张三')
})

test('normalizeEvent 丢弃非群消息、白名单外、自己发的、无 id', () => {
  const base = { groups: new Set(['100000001']), selfId: '100000000', ignoreSelf: true }
  assert.ok(normalizeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }, base).dropped)
  assert.ok(normalizeEvent(makeEvent({ groupId: '1' }), base).dropped)
  assert.ok(normalizeEvent(makeEvent({ userId: 100000000 }), base).dropped)
  assert.ok(normalizeEvent(Object.assign(makeEvent(), { message_id: undefined, real_id: undefined }), base).dropped)
  assert.ok(normalizeEvent(makeEvent({ text: 'ok' }), base).record)
})

test('normalizeEvent 忽略自己发的可关闭', () => {
  const r = normalizeEvent(makeEvent({ userId: 100000000 }), {
    groups: new Set(['100000001']),
    selfId: '100000000',
    ignoreSelf: false,
  })
  assert.ok(r.record)
})

test('DedupSet 命中即去重，容量满淘汰最旧', () => {
  const d = new DedupSet(3)
  assert.equal(d.add('a'), true)
  assert.equal(d.add('b'), true)
  assert.equal(d.add('a'), false)
  d.add('c')
  d.add('d')
  assert.equal(d.size, 3)
  assert.equal(d.has('b'), false)
})

test('GroupBuffer 按 realSeq 排序并检测缺口', () => {
  const buf = new GroupBuffer('1', { maxBuffer: 100 })
  ;[
    { msgId: '1', realSeq: 10, timeSec: 1, arrival: 1 },
    { msgId: '2', realSeq: 12, timeSec: 2, arrival: 2 },
    { msgId: '3', realSeq: 15, timeSec: 3, arrival: 3 },
  ].forEach((r) => buf.push(r))
  assert.equal(buf.size, 3)
  assert.deepEqual(buf.gaps(), [[11, 11], [13, 14]])
  const snap = buf.freeze()
  assert.deepEqual(snap.map((r) => r.realSeq), [10, 12, 15])
  assert.equal(buf.size, 0)
})

test('GroupBuffer 拒绝重复 msgId', () => {
  const buf = new GroupBuffer('1', {})
  assert.equal(buf.push({ msgId: '9', realSeq: 1, timeSec: 1 }), true)
  assert.equal(buf.push({ msgId: '9', realSeq: 2, timeSec: 2 }), false)
})

test('compareRecords 无 seq 时回退到时间', () => {
  const a = { msgId: 'a', realSeq: null, timeSec: 5, arrival: 100 }
  const b = { msgId: 'b', realSeq: null, timeSec: 6, arrival: 50 }
  assert.ok(compareRecords(a, b) < 0)
})
