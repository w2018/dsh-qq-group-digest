import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { splitText } from '../lib/transport/action.js'
import { renderReport, renderGroupReport } from '../lib/deliver/render.js'
import { deliverReport, deliverReportList } from '../lib/deliver/send.js'
import { fakeActions, silentLogger } from './helpers.js'

test('splitText 短文本不切', () => {
  assert.deepEqual(splitText('短', 100), ['短'])
})

test('splitText 按行切且每段不超长', () => {
  const text = Array.from({ length: 50 }, (_, i) => '第' + i + '行内容').join('\n')
  const parts = splitText(text, 40)
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= 40)
  assert.equal(parts.join('\n'), text)
})

test('splitText 单行超长硬切', () => {
  const parts = splitText('x'.repeat(250), 100)
  assert.equal(parts.length, 3)
  assert.ok(parts.every((p) => p.length <= 100))
})

test('renderReport 按群编号组织', () => {
  const text = renderReport(
    [
      { groupId: '111', groupName: '群A', ok: true, text: 'A 的总结', count: 100, firstSec: 1792821000, lastSec: 1792824600 },
      { groupId: '222', groupName: '群B', ok: false, text: 'B 的摘录', count: 50, error: '超时' },
    ],
    { now: 1792825000 },
  )
  assert.match(text, /群A（群号 111）/)
  assert.match(text, /群B（群号 222）/)
  assert.match(text, /A 的总结/)
  assert.match(text, /总结失败：超时/)
})

test('deliverReport dryRun 只写 outbox 不发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqd-'))
  const actions = fakeActions(0)
  const res = await deliverReport(actions, '报告正文', {
    friends: ['1'],
    dryRun: true,
    outboxDir: dir,
    logger: silentLogger,
  })
  assert.equal(res.dryRun, true)
  assert.equal(actions.sent.length, 0)
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 1)
})

test('deliverReport 发送成功记录 messageId', async () => {
  const actions = fakeActions(0)
  const res = await deliverReport(actions, '报告正文', { friends: ['1', '2'], dryRun: false, logger: silentLogger })
  assert.equal(res.delivered.length, 2)
  assert.equal(actions.sent.length, 2)
})

test('deliverReport 重试后成功', async () => {
  const actions = fakeActions(1)
  const res = await deliverReport(actions, '报告正文', {
    friends: ['1'],
    dryRun: false,
    retry: { attempts: 2, backoffMs: 5 },
    logger: silentLogger,
  })
  assert.equal(res.delivered.length, 1)
  assert.equal(res.failed.length, 0)
})

test('renderGroupReport 只包含单个群', () => {
  const text = renderGroupReport(
    { groupId: '111', groupName: '群A', ok: true, text: 'A 的总结', count: 100, firstSec: 1792821000, lastSec: 1792824600 },
    { now: 1792825000 },
  )
  assert.match(text, /群A（群号 111）/)
  assert.match(text, /A 的总结/)
  assert.ok(!text.includes('群号 222'))
})

test('renderGroupReport 群名缺失时回退群号，不出现「未命名」', () => {
  const text = renderGroupReport({ groupId: '333', groupName: '', ok: true, text: 'C 的总结', count: 5 })
  assert.match(text, /333（群号 333）/)
  assert.ok(!text.includes('未命名'), '不得出现「未命名群」占位')
})

test('renderReport 群名缺失时同样回退群号', () => {
  const text = renderReport([{ groupId: '444', groupName: '   ', ok: true, text: 'D 的总结', count: 2 }])
  assert.match(text, /1\. 444（群号 444）/)
  assert.ok(!text.includes('未命名'))
})

test('renderGroupReport 失败时带错误并保留摘录', () => {
  const text = renderGroupReport({ groupId: '222', groupName: '群B', ok: false, text: 'B 的摘录', count: 50, error: '超时' })
  assert.match(text, /总结失败：超时/)
  assert.match(text, /B 的摘录/)
})

test('deliverReportList 多群各发一条，不合并在同一消息', async () => {
  const actions = fakeActions(0)
  const res = await deliverReportList(
    actions,
    [
      { groupId: '111', batchId: 'b1', text: '群A 报告' },
      { groupId: '222', batchId: 'b2', text: '群B 报告' },
    ],
    { friends: ['1'], dryRun: false, logger: silentLogger },
  )
  assert.equal(res.delivered.length, 1)
  // 一个好友 × 两个群 = 两次独立发送，每次只含本群内容。
  assert.equal(actions.sent.length, 2)
  const bodies = actions.sent.map((s) => String(s.text || ''))
  assert.ok(bodies.some((b) => b.includes('群A 报告') && !b.includes('群B 报告')))
  assert.ok(bodies.some((b) => b.includes('群B 报告') && !b.includes('群A 报告')))
})

test('deliverReportList 单群失败不影响其它群', async () => {
  const actions = fakeActions(0)
  let n = 0
  const original = actions.sendPrivate
  actions.sendPrivate = async (userId, message) => {
    n += 1
    if (n === 1) throw new Error('第一群炸了')
    return original(userId, message)
  }
  const res = await deliverReportList(
    actions,
    [
      { groupId: '111', batchId: 'b1', text: '群A 报告' },
      { groupId: '222', batchId: 'b2', text: '群B 报告' },
    ],
    { friends: ['1'], dryRun: false, retry: { attempts: 1, backoffMs: 1 }, logger: silentLogger },
  )
  assert.equal(res.failed.length, 1)
  assert.match(res.failed[0].error, /111/)
  const per = res.perGroup.find((x) => x.groupId === '222')
  assert.equal(per.ok, true)
})

test('deliverReportList dryRun 多群各写一个文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqd-'))
  const actions = fakeActions(0)
  const res = await deliverReportList(
    actions,
    [
      { groupId: '111', batchId: 'b1', text: '群A 报告' },
      { groupId: '222', batchId: 'b2', text: '群B 报告' },
    ],
    { friends: ['1'], dryRun: true, outboxDir: dir, logger: silentLogger },
  )
  assert.equal(res.dryRun, true)
  assert.equal(actions.sent.length, 0)
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 2)
})

test('deliverReport 全失败写 outbox 兜底', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqd-'))
  const actions = fakeActions(99)
  const res = await deliverReport(actions, '报告正文', {
    friends: ['1'],
    dryRun: false,
    retry: { attempts: 2, backoffMs: 1 },
    outboxDir: dir,
    logger: silentLogger,
  })
  assert.equal(res.failed.length, 1)
  assert.ok(res.outboxFile)
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('failed-')).length, 1)
})
