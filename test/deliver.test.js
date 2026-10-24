import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { splitText } from '../lib/transport/action.js'
import { renderReport } from '../lib/deliver/render.js'
import { deliverReport } from '../lib/deliver/send.js'
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
