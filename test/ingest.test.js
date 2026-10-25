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

test('normalizeEvent 关键词模糊过滤（大小写不敏感）', () => {
  const base = { groups: new Set(['100000001']), selfId: '100000000', keywords: ['广告', 'VPN'] }
  assert.equal(normalizeEvent(makeEvent({ text: '欢迎加群看广告', msgId: '2001' }), base).dropped, 'keyword')
  assert.equal(normalizeEvent(makeEvent({ text: '需要 vpn 的找我', msgId: '2002' }), base).dropped, 'keyword')
  assert.ok(normalizeEvent(makeEvent({ text: '正常聊天', msgId: '2003' }), base).record)
  // 无文本（纯图片）不做关键词匹配
  assert.ok(base && normalizeEvent(makeEvent({ text: '', msgId: '2004' }), base))
})

test('normalizeEvent 按成员排除（分群生效）', () => {
  const base = {
    groups: new Set(['100000001', '100000002']),
    selfId: '100000000',
    excludedSenders: { '100000001': ['666'] },
  }
  assert.equal(normalizeEvent(makeEvent({ groupId: '100000001', userId: 666, msgId: '3001' }), base).dropped, 'excluded-sender')
  assert.ok(normalizeEvent(makeEvent({ groupId: '100000002', userId: 666, msgId: '3002' }), base).record)
  assert.ok(normalizeEvent(makeEvent({ groupId: '100000001', userId: 777, msgId: '3003' }), base).record)
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
// ── v0.5.0 G：QQ 消息过滤链路逐条验证 ─────────────────────────────
// 方案 G 的口径是「不改语义，只验证」。下面每一条都先在真实实现上跑过，
// 断言的是当前真实行为，不是想象中应该有的行为。

const GROUP = '100000001'
const baseFilter = { groups: new Set([GROUP]), selfId: '100000000', ignoreSelf: true }

test('G: 关键词大小写不敏感，且大小写两侧都命中', () => {
  const opts = Object.assign({}, baseFilter, { keywords: ['VPN'] })
  // 关键词大写、正文小写
  assert.equal(normalizeEvent(makeEvent({ text: 'vpn 怎么配', msgId: 'g101' }), opts).dropped, 'keyword')
  // 关键词小写、正文大写
  const lower = Object.assign({}, baseFilter, { keywords: ['vpn'] })
  assert.equal(normalizeEvent(makeEvent({ text: 'VPN 怎么配', msgId: 'g102' }), lower).dropped, 'keyword')
  // 混写
  assert.equal(normalizeEvent(makeEvent({ text: 'Vpn 怎么配', msgId: 'g103' }), lower).dropped, 'keyword')
})

test('G: 关键词按子串匹配（不要求整词）', () => {
  const opts = Object.assign({}, baseFilter, { keywords: ['广告'] })
  assert.equal(normalizeEvent(makeEvent({ text: '这里有广告啊', msgId: 'g201' }), opts).dropped, 'keyword')
  assert.equal(normalizeEvent(makeEvent({ text: '广告', msgId: 'g202' }), opts).dropped, 'keyword')
  assert.equal(normalizeEvent(makeEvent({ text: '前面广告后面还有字', msgId: 'g203' }), opts).dropped, 'keyword')
})

test('G: 关键词命中即丢，不命中照常入库', () => {
  const opts = Object.assign({}, baseFilter, { keywords: ['广告', '代练'] })
  assert.equal(normalizeEvent(makeEvent({ text: '接代练私聊', msgId: 'g301' }), opts).dropped, 'keyword')
  const kept = normalizeEvent(makeEvent({ text: '今天讨论了向量检索', msgId: 'g302' }), opts)
  assert.equal(kept.dropped, undefined)
  assert.equal(kept.record.text, '今天讨论了向量检索')
})

test('G: 空文本不做关键词匹配，按 [空消息] 入库', () => {
  const opts = Object.assign({}, baseFilter, { keywords: ['广告'] })
  // 空段数组 + 空 raw_message → text 为空
  const emptySegs = Object.assign(makeEvent({ msgId: 'g401' }), { message: [], raw_message: '' })
  const r1 = normalizeEvent(emptySegs, opts)
  assert.equal(r1.dropped, undefined, '空文本不该被关键词误杀')
  assert.equal(r1.record.text, '[空消息]')

  // 纯空白同样视为空
  const blank = Object.assign(makeEvent({ msgId: 'g402' }), {
    message: [{ type: 'text', data: { text: '   ' } }],
    raw_message: '   ',
  })
  assert.equal(normalizeEvent(blank, opts).dropped, undefined)

  // 空字符串消息
  const emptyStr = Object.assign(makeEvent({ msgId: 'g403' }), { message: '', raw_message: '' })
  assert.equal(normalizeEvent(emptyStr, opts).dropped, undefined)
})

test('G: 非文本消息按占位符参与关键词匹配', () => {
  // renderSegments 把图片渲染成 [图片]，所以关键词「图片」能命中纯图片消息。
  const opts = Object.assign({}, baseFilter, { keywords: ['图片'] })
  const imageOnly = Object.assign(makeEvent({ msgId: 'g501' }), { message: [{ type: 'image', data: {} }], raw_message: '' })
  assert.equal(normalizeEvent(imageOnly, opts).dropped, 'keyword')

  // 无关关键词则不命中，占位符照常入库。
  const other = Object.assign({}, baseFilter, { keywords: ['广告'] })
  const kept = normalizeEvent(imageOnly, other)
  assert.equal(kept.dropped, undefined)
  assert.equal(kept.record.text, '[图片]')
})

test('G: 关键词为空数组时不过滤', () => {
  assert.equal(normalizeEvent(makeEvent({ text: '随便说点什么', msgId: 'g601' }), Object.assign({}, baseFilter, { keywords: [] })).dropped, undefined)
  // 不传 keywords 也一样
  assert.equal(normalizeEvent(makeEvent({ text: '随便说点什么', msgId: 'g602' }), baseFilter).dropped, undefined)
})

test('G: excludedSenders 严格按群隔离', () => {
  const opts = Object.assign({}, baseFilter, {
    groups: new Set([GROUP, '200000002', '300000003']),
    excludedSenders: { [GROUP]: ['666'] },
  })
  // 本群名单内 → 丢
  assert.equal(normalizeEvent(makeEvent({ groupId: GROUP, userId: 666, msgId: 'g701' }), opts).dropped, 'excluded-sender')
  // 名单里的 QQ 发到「未列出该群的」另一个群 → 不丢
  assert.equal(normalizeEvent(makeEvent({ groupId: '200000002', userId: 666, msgId: 'g702' }), opts).dropped, undefined)
  // 本群其他人 → 不丢
  assert.equal(normalizeEvent(makeEvent({ groupId: GROUP, userId: 777, msgId: 'g703' }), opts).dropped, undefined)
  // 另一个群有自己的名单，互不影响
  const two = Object.assign({}, opts, { excludedSenders: { [GROUP]: ['666'], '200000002': ['888'] } })
  assert.equal(normalizeEvent(makeEvent({ groupId: '200000002', userId: 888, msgId: 'g704' }), two).dropped, 'excluded-sender')
  assert.equal(normalizeEvent(makeEvent({ groupId: GROUP, userId: 888, msgId: 'g705' }), two).dropped, undefined)
})

test('G: excludedSenders 先于关键词判定（省一次文本渲染）', () => {
  const opts = Object.assign({}, baseFilter, {
    keywords: ['广告'],
    excludedSenders: { [GROUP]: ['666'] },
  })
  // 两个条件都命中，丢因必须是 excluded-sender（顺序在 normalize.js 里是固定的）
  assert.equal(normalizeEvent(makeEvent({ userId: 666, text: '广告', msgId: 'g801' }), opts).dropped, 'excluded-sender')
})

test('G: 白名单外的群丢弃为 group-not-listed', () => {
  assert.equal(normalizeEvent(makeEvent({ groupId: '999999', msgId: 'g901' }), baseFilter).dropped, 'group-not-listed')
  // groups 为空集合时视为「不限群」，不丢
  assert.equal(normalizeEvent(makeEvent({ groupId: '999999', msgId: 'g902' }), { groups: new Set() }).dropped, undefined)
})

test('G: ignoreSelf 为 true 丢自己、为 false 保留', () => {
  const on = Object.assign({}, baseFilter, { ignoreSelf: true })
  assert.equal(normalizeEvent(makeEvent({ userId: 100000000, msgId: 'g1001' }), on).dropped, 'self-message')

  const off = Object.assign({}, baseFilter, { ignoreSelf: false })
  assert.equal(normalizeEvent(makeEvent({ userId: 100000000, msgId: 'g1002' }), off).dropped, undefined)

  // 没给 selfId 时退回事件自带的 self_id，仍然认得出自己
  const noSelf = { groups: new Set([GROUP]), ignoreSelf: true }
  assert.equal(normalizeEvent(makeEvent({ userId: 100000000, msgId: 'g1003' }), noSelf).dropped, 'self-message')
})

test('G: 非群消息与事件类型不符一律丢弃', () => {
  assert.equal(normalizeEvent(makeEvent({ msgId: 'g1101' }), Object.assign({}, baseFilter, {})).dropped, undefined)
  const priv = Object.assign(makeEvent({ msgId: 'g1102' }), { message_type: 'private' })
  assert.equal(normalizeEvent(priv, baseFilter).dropped, 'message-type:private')
  const notice = { post_type: 'notice', notice_type: 'group_increase', group_id: Number(GROUP) }
  assert.equal(normalizeEvent(notice, baseFilter).dropped, 'post-type:notice')
  assert.equal(normalizeEvent(null, baseFilter).dropped, 'not-an-object')
})
