import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SummaryHistory, stripMembersSection } from '../lib/store/history.js'

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

test('P4 结构化字段：participants/md/model/attempts/aiDetail 正常读写并落盘', () => {
  const root = makeRoot()
  const hist = new SummaryHistory(root)
  const item = hist.append('100000001', {
    text: '本批主线',
    at: 1700000000,
    batchId: 'b-1',
    participants: [
      { id: '123456', name: '王五', count: 7 },
      { id: '654321', name: '张三', count: 3 },
    ],
    md: '# 100000001 · AI大模型交流\n\n## 一、本批主线\n本批主线',
    model: 'workbuddy/deepseek-v4.1-flash',
    attempts: 2,
    aiDetail: true,
  })
  // 逐字段断言而不是 deepEqual：participants 后续还会加字段（如 focus），
  // 整对象比较会让「别人加了个新字段」变成假失败。
  assert.equal(item.participants.length, 2)
  assert.deepEqual(
    item.participants.map((p) => [p.id, p.name, p.count]),
    [
      ['123456', '王五', 7],
      ['654321', '张三', 3],
    ],
  )
  assert.match(item.md, /^# 100000001/)
  assert.equal(item.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(item.attempts, 2)
  assert.equal(item.aiDetail, true)

  const reopened = new SummaryHistory(root)
  const entry = reopened.latest('100000001')
  assert.equal(entry.participants.length, 2)
  assert.equal(entry.participants[0].name, '王五')
  assert.equal(entry.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(entry.attempts, 2)
  assert.equal(entry.aiDetail, true)
  assert.match(entry.md, /本批主线/)
})

test('P4 新字段缺省时给安全默认值（空数组 / 空串 / 0 / false）', () => {
  const hist = new SummaryHistory(makeRoot())
  const item = hist.append('1', { text: '只有正文', at: 1700000000 })
  assert.deepEqual(item.participants, [])
  assert.equal(item.md, '')
  assert.equal(item.model, '')
  assert.equal(item.attempts, 0)
  assert.equal(item.aiDetail, false)
})

test('P4 向后兼容：旧存档缺新字段时读取不报错，按空处理', () => {
  const root = makeRoot()
  const legacy = {
    groupId: '1',
    entries: [
      { at: 1699990000, batchId: 'old-1', count: 3, firstSec: 1699980000, lastSec: 1699989999, ok: true, text: '旧版总结正文', delivered: 1, failed: 0, outboxFile: '' },
    ],
  }
  writeFileSync(join(root, '1.json'), JSON.stringify(legacy), 'utf8')

  const hist = new SummaryHistory(root)
  const entry = hist.latest('1')
  assert.equal(entry.text, '旧版总结正文')
  assert.equal(entry.participants, undefined)
  assert.equal(entry.md, undefined)
  assert.equal(entry.model, undefined)
  assert.equal(entry.attempts, undefined)
  assert.equal(entry.aiDetail, undefined)
  // 在旧条目基础上追加新条目，两条共存且字段互不影响
  hist.append('1', { text: '新版总结', at: 1700000000, participants: [{ id: '9', name: '甲', count: 1 }], aiDetail: true })
  assert.equal(hist.load('1').length, 2)
  assert.equal(hist.latest('1').aiDetail, true)
})

// ── v0.5.0：旧存档里的成员表在 load 时剥离 ─────────────────

const LEGACY_MD = [
  '# 100000001 · AI大模型交流',
  '',
  '> 2026-10-25 18:00–18:06 · 33 条消息 · 6 位发言人 · workbuddy/deepseek-v4.1-flash',
  '',
  '## 一、本批主线',
  '本批主线是讨论部署方式。',
  '',
  '## 二、要点',
  '【王五】主张本地模型。',
  '',
  '## 三、参与成员',
  '| 成员 | QQ | 发言数 | 本次重点 |',
  '| :--- | :--- | ---: | :--- |',
  '| 王五 | 123456 | 7 | 主张本地模型 |',
  '',
  '## 四、投递状态',
  '- 状态：成功',
  '- 投递成功：2 人 / 失败：0 人',
].join('\n')

test('stripMembersSection 剥离「## 三、参与成员」并把投递状态改回第三节', () => {
  const out = stripMembersSection(LEGACY_MD)
  assert.equal(out.includes('参与成员'), false)
  assert.equal(out.includes('| 成员 | QQ |'), false)
  assert.equal(out.includes('## 四、投递状态'), false)
  assert.match(out, /## 三、投递状态/)
  // 正文与 meta 必须原样保留
  assert.match(out, /^# 100000001 · AI大模型交流/)
  assert.match(out, /> 2026-10-25 18:00–18:06 · 33 条消息 · 6 位发言人 · workbuddy\/deepseek-v4\.1-flash/)
  assert.match(out, /## 一、本批主线\n本批主线是讨论部署方式。/)
  assert.match(out, /## 二、要点\n【王五】主张本地模型。/)
  assert.match(out, /- 状态：成功/)
})

test('stripMembersSection 也认「## 参与成员」表头（pipeline 追加过的那份）', () => {
  const md = ['# 标题', '', '## 要点', '正文一行', '', '## 参与成员', '', '| 成员 | QQ | 发言数 | 本次重点 |', '| :--- | :--- | ---: | :--- |', '| 李四 | 9 | 3 | — |', ''].join('\n')
  const out = stripMembersSection(md)
  assert.equal(out.includes('## 参与成员'), false)
  assert.equal(out.includes('| 李四 |'), false)
  assert.match(out, /## 要点\n正文一行/)
})

test('stripMembersSection 遇到小节里混有正文时不剥离（保守）', () => {
  const md = ['## 三、参与成员', '| 成员 | QQ | 发言数 |', '这里其实是一段正文说明', ''].join('\n')
  assert.equal(stripMembersSection(md), md)
})

test('stripMembersSection 表头不完全相等时不剥离', () => {
  const md = ['## 参与成员（旧）', '| 成员 | QQ | 发言数 |', ''].join('\n')
  assert.equal(stripMembersSection(md), md)
  const md2 = ['## 三、参与成员列表', '| 成员 | QQ | 发言数 |', ''].join('\n')
  assert.equal(stripMembersSection(md2), md2)
})

test('stripMembersSection 空表「（未记录）」行也算表格，可剥离', () => {
  const md = ['## 三、参与成员', '| 成员 | QQ | 发言数 | 本次重点 |', '| :--- | :--- | ---: | :--- |', '| （未记录） | — | — | — |', '', '## 四、投递状态', '- 状态：成功'].join('\n')
  const out = stripMembersSection(md)
  assert.equal(out.includes('参与成员'), false)
  assert.match(out, /## 三、投递状态/)
})

test('stripMembersSection 小节在文末（后面没有 ## 标题）也能剥离', () => {
  const md = ['# 标题', '', '## 参与成员', '| 成员 | QQ | 发言数 |', '| :--- | :--- | ---: |', '| 甲 | 1 | 2 |'].join('\n')
  const out = stripMembersSection(md)
  assert.equal(out.includes('参与成员'), false)
  assert.equal(out.includes('| 甲 |'), false)
  assert.match(out, /^# 标题/)
})

test('stripMembersSection 没有成员小节时原样返回（同一引用语义）', () => {
  const md = '# 标题\n\n## 一、本批主线\n正文'
  assert.equal(stripMembersSection(md), md)
  assert.equal(stripMembersSection(''), '')
  assert.equal(stripMembersSection(null), '')
  assert.equal(stripMembersSection(undefined), '')
})

test('load 读盘时剥离旧存档里的成员表（内存中处理）', () => {
  const root = makeRoot()
  const legacy = {
    groupId: '100000001',
    entries: [{ at: 1699990000, batchId: 'old-1', count: 33, ok: true, text: '正文', md: LEGACY_MD, delivered: 2, failed: 0 }],
  }
  writeFileSync(join(root, '100000001.json'), JSON.stringify(legacy), 'utf8')

  const hist = new SummaryHistory(root)
  const entry = hist.latest('100000001')
  assert.equal(entry.md.includes('参与成员'), false)
  assert.match(entry.md, /## 三、投递状态/)
  // 不强制回写：磁盘上仍是旧内容
  const onDisk = JSON.parse(readFileSync(join(root, '100000001.json'), 'utf8'))
  assert.match(onDisk.entries[0].md, /## 三、参与成员/)
})

test('append 原样存 md（剥离只发生在读盘路径，不篡改写入内容）', () => {
  const hist = new SummaryHistory(makeRoot())
  const item = hist.append('1', { text: '正文', md: '# 标题\n\n## 三、投递状态\n- 状态：成功', at: 1700000000 })
  assert.equal(item.md, '# 标题\n\n## 三、投递状态\n- 状态：成功')
  // 新版本 pipeline 写入的 md 本就不含成员表，所以这条路径天然干净
  assert.equal(hist.latest('1').md.includes('参与成员'), false)
})

test('P4 md 单独上限 20000，超了截断并加标记；text 上限仍是 6000', () => {
  const hist = new SummaryHistory(makeRoot())
  const item = hist.append('1', { text: 'a'.repeat(7000), md: 'b'.repeat(20050), at: 1700000000 })
  assert.equal(item.text, 'a'.repeat(6000) + '…(截断)')
  assert.equal(item.md, 'b'.repeat(20000) + '…(截断)')
})

test('P4 participants 归一化：丢弃非法项、补齐 name、限制最多 30 个', () => {
  const hist = new SummaryHistory(makeRoot())
  const raw = [null, 'x', { id: '' }, { id: '7' }]
  for (let i = 0; i < 40; i += 1) raw.push({ id: String(100 + i), name: 'n' + i, count: i })
  const item = hist.append('1', { text: 't', at: 1700000000, participants: raw })
  assert.equal(item.participants.length, 30)
  assert.equal(item.participants[0].id, '7')
  assert.equal(item.participants[0].name, '7')
  assert.equal(item.participants[0].count, 0)
  assert.equal(item.participants[1].id, '100')
  assert.equal(item.participants[1].count, 0)
  assert.equal(item.participants[29].id, '128')
})

test('P6 participants 带 focus：超长截断到 40 字、空值归一化为空串', () => {
  const hist = new SummaryHistory(makeRoot())
  const item = hist.append('1', {
    text: 't',
    at: 1700000000,
    participants: [
      { id: '1', name: '甲', count: 2, focus: '  主张本地模型  ' },
      { id: '2', name: '乙', count: 1, focus: '字'.repeat(60) },
      { id: '3', name: '丙', count: 1 },
    ],
  })
  assert.equal(item.participants[0].focus, '主张本地模型')
  assert.equal(item.participants[1].focus.length, 40)
  assert.equal(item.participants[2].focus, '')
})

test('remove 按 batchId 删除单条并落盘', () => {
  const dir = makeRoot()
  const hist = new SummaryHistory(dir)
  hist.append('1', { text: 'a', at: 1700000000, batchId: 'b1' })
  hist.append('1', { text: 'b', at: 1700000100, batchId: 'b2' })
  assert.equal(hist.remove('1', 'b1'), true)
  assert.equal(hist.load('1').length, 1)
  assert.equal(hist.load('1')[0].batchId, 'b2')
  // 已删过 / 不存在 / 空 id 都返回 false，不抛错
  assert.equal(hist.remove('1', 'b1'), false)
  assert.equal(hist.remove('1', 'nope'), false)
  assert.equal(hist.remove('1', ''), false)
  // 重新加载（模拟重启）后依然是删掉的状态
  const again = new SummaryHistory(dir)
  assert.equal(again.load('1').length, 1)
  assert.equal(again.load('1')[0].batchId, 'b2')
})

test('removeAll 清空整群并返回删除条数', () => {
  const dir = makeRoot()
  const hist = new SummaryHistory(dir)
  hist.append('1', { text: 'a', at: 1700000000, batchId: 'b1' })
  hist.append('1', { text: 'b', at: 1700000100, batchId: 'b2' })
  hist.append('2', { text: 'c', at: 1700000200, batchId: 'b3' })
  assert.equal(hist.removeAll('1'), 2)
  assert.equal(hist.load('1').length, 0)
  assert.equal(hist.load('2').length, 1, '其它群不受影响')
  assert.equal(hist.removeAll('1'), 0)
  const again = new SummaryHistory(dir)
  assert.equal(again.load('1').length, 0)
  assert.equal(again.load('2').length, 1)
})
