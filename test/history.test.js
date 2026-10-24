import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SummaryHistory } from '../lib/store/history.js'

const tmpDirs = []

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-digest-history-'))
  tmpDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
})

test('append 归一化条目字段并给出默认值', () => {
  const hist = new SummaryHistory(makeRoot())
  const item = hist.append('100000001', {
    text: '本批讨论了 deepseek 选型',
    at: 1700000000,
    batchId: 'b-1',
    count: 7,
    firstSec: 1699990000,
    lastSec: 1699999999,
    ok: true,
  })
  assert.equal(item.at, 1700000000)
  assert.equal(item.batchId, 'b-1')
  assert.equal(item.count, 7)
  assert.equal(item.firstSec, 1699990000)
  assert.equal(item.lastSec, 1699999999)
  assert.equal(item.ok, true)
  assert.equal(item.text, '本批讨论了 deepseek 选型')
  assert.equal(item.delivered, 0)
  assert.equal(item.failed, 0)
  assert.equal(item.outboxFile, '')
})

test('append 缺省字段有安全兜底', () => {
  const hist = new SummaryHistory(makeRoot())
  const item = hist.append(123456, {})
  assert.ok(Number.isInteger(item.at) && item.at > 0)
  assert.equal(item.batchId, '')
  assert.equal(item.count, 0)
  assert.equal(item.ok, false)
  assert.equal(item.text, '')
})

test('append 后新实例能从磁盘读回（落盘往返）', () => {
  const root = makeRoot()
  const hist = new SummaryHistory(root)
  hist.append('100000001', { text: '第一条总结', at: 1700000000, batchId: 'b-1', count: 5, firstSec: 1699990000, ok: true })

  const file = join(root, '100000001.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.groupId, '100000001')
  assert.equal(raw.entries.length, 1)
  assert.equal(raw.entries[0].text, '第一条总结')

  const reopened = new SummaryHistory(root)
  const entries = reopened.load('100000001')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].batchId, 'b-1')
  assert.equal(reopened.latest('100000001').text, '第一条总结')
})

test('历史按群隔离，两个群号互不干扰', () => {
  const root = makeRoot()
  const hist = new SummaryHistory(root)
  hist.append('111', { text: '甲群的总结', batchId: 'a', at: 1700000000 })
  hist.append('222', { text: '乙群的总结', batchId: 'b', at: 1700000001 })

  assert.equal(hist.load('111').length, 1)
  assert.equal(hist.load('222').length, 1)
  assert.equal(hist.latest('111').text, '甲群的总结')
  assert.equal(hist.latest('222').text, '乙群的总结')

  const reopened = new SummaryHistory(root)
  assert.equal(reopened.latest('111').batchId, 'a')
  assert.equal(reopened.latest('222').batchId, 'b')
  assert.equal(reopened.latest('333'), null)
})

test('recent 只返回最近 n 条，顺序与存档一致（末尾最新）', () => {
  const hist = new SummaryHistory(makeRoot())
  for (let i = 0; i < 5; i += 1) {
    hist.append('1', { text: 't' + i, at: 1700000000 + i, batchId: 'b' + i })
  }
  const last2 = hist.recent('1', 2)
  assert.equal(last2.length, 2)
  assert.deepEqual(last2.map((e) => e.text), ['t3', 't4'])
  assert.equal(last2[last2.length - 1].text, hist.latest('1').text)

  assert.deepEqual(hist.recent('1', 0), [])
  assert.equal(hist.recent('1', 99).length, 5)
  assert.equal(hist.recent('1', -3).length, 0)
})

test('超过 20 条时淘汰最旧的条目', () => {
  const hist = new SummaryHistory(makeRoot())
  for (let i = 0; i < 25; i += 1) {
    hist.append('1', { text: 't' + i, at: 1700000000 + i, batchId: 'b' + i })
  }
  const list = hist.load('1')
  assert.equal(list.length, 20)
  assert.equal(list[0].text, 't5')
  assert.equal(list[19].text, 't24')
  assert.equal(hist.latest('1').text, 't24')
})

test('超长总结正文被截断到 6000 字符', () => {
  const hist = new SummaryHistory(makeRoot())
  const item = hist.append('1', { text: 'a'.repeat(7000), at: 1700000000 })
  assert.equal(item.text, 'a'.repeat(6000) + '…(截断)')
})

test('updateDelivery 回填投递结果并落盘，未知批次返回 null', () => {
  const root = makeRoot()
  const hist = new SummaryHistory(root)
  hist.append('1', { text: '待投递', batchId: 'b-1', at: 1700000000 })
  const updated = hist.updateDelivery('1', 'b-1', { delivered: 2, failed: 1, outboxFile: '/tmp/outbox/1.json' })
  assert.ok(updated)
  assert.equal(updated.delivered, 2)
  assert.equal(updated.failed, 1)
  assert.equal(updated.outboxFile, '/tmp/outbox/1.json')

  const reopened = new SummaryHistory(root)
  const entry = reopened.latest('1')
  assert.equal(entry.delivered, 2)
  assert.equal(entry.failed, 1)
  assert.equal(entry.outboxFile, '/tmp/outbox/1.json')

  assert.equal(hist.updateDelivery('1', 'not-exist', { delivered: 1 }), null)
})

test('root 为空时不落盘，只在内存里工作', () => {
  const hist = new SummaryHistory('')
  assert.deepEqual(hist.load('1'), [])
  hist.append('1', { text: '仅内存', at: 1700000000 })
  assert.equal(hist.load('1').length, 1)
  assert.equal(hist.latest('1').text, '仅内存')
})
