import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderDetailedMarkdown, renderMembersSection, MAX_MD } from '../lib/summarize/markdown.js'

function baseEntry(overrides) {
  return Object.assign(
    {
      batchId: 'b1-100000001',
      groupId: '100000001',
      groupName: 'AI大模型交流',
      ok: true,
      text: '本批主线是讨论 deepseek 的部署方式。\n\n【王五】主张先用本地模型，【张三】同意。',
      count: 7,
      firstSec: 1700000000,
      lastSec: 1700003600,
      model: 'workbuddy/deepseek-v4.1-flash',
      participants: [
        { id: '123456', name: '王五', count: 7 },
        { id: '654321', name: '张三', count: 3 },
      ],
      delivered: 2,
      failed: 1,
    },
    overrides || {},
  )
}

test('renderDetailedMarkdown 正常渲染出三段结构，且不含成员表', () => {
  const md = renderDetailedMarkdown(baseEntry())
  assert.match(md, /^# 100000001 · AI大模型交流/)
  assert.match(md, /^> .*7 条消息 · 2 位发言人 · workbuddy\/deepseek-v4\.1-flash/m)
  assert.match(md, /## 一、本批主线\n本批主线是讨论 deepseek 的部署方式。/)
  assert.match(md, /## 二、要点\n【王五】主张先用本地模型，【张三】同意。/)
  // v0.5.0：成员表不再进正文（网页详情页与导出各自负责），投递状态升为第三节。
  assert.match(md, /## 三、投递状态/)
  assert.equal(md.includes('## 参与成员'), false)
  assert.equal(md.includes('| 成员 | QQ | 发言数 |'), false)
  assert.equal(md.includes('## 四、'), false)
  assert.match(md, /- 状态：成功/)
  assert.match(md, /- 投递成功：2 人 \/ 失败：1 人/)
  assert.match(md, /- 批次：b1-100000001/)
})

test('entry.text 为空时渲染「（本批无有效讨论内容）」', () => {
  const md = renderDetailedMarkdown(baseEntry({ text: '' }))
  assert.match(md, /## 一、本批主线\n（本批无有效讨论内容）/)
  assert.match(md, /## 二、要点\n（无）/)
})

test('participants 为空时正文不出现成员表，但 meta 仍写 0 位发言人', () => {
  const md = renderDetailedMarkdown(baseEntry({ participants: [] }))
  assert.equal(md.includes('（未记录）'), false)
  assert.match(md, /0 位发言人/)
  // 缺字段（旧存档）同样走空分支
  const legacy = renderDetailedMarkdown(baseEntry({ participants: undefined }))
  assert.equal(legacy.includes('（未记录）'), false)
  assert.match(legacy, /0 位发言人/)
  // 空表由 renderMembersSection 负责（导出时用）
  assert.match(renderMembersSection([]), /\| （未记录） \|/)
})

test('群名为空时标题只显示一次群号（不重复）', () => {
  const md = renderDetailedMarkdown(baseEntry({ groupName: '' }))
  assert.match(md, /^# 100000001\n/)
})

test('群名与群号相同（协议端没给群名）时标题也不重复', () => {
  const md = renderDetailedMarkdown(baseEntry({ groupName: '100000001' }))
  assert.match(md, /^# 100000001\n/)
})

test('群名正常时标题是「群号 · 群名」', () => {
  const md = renderDetailedMarkdown(baseEntry({ groupName: '测试群' }))
  assert.match(md, /^# 100000001 · 测试群\n/)
})

test('ok=false 时状态行标注总结失败（降级为原始摘录）', () => {
  const md = renderDetailedMarkdown(baseEntry({ ok: false, model: '', delivered: 0, failed: 0 }))
  assert.match(md, /- 状态：总结失败（降级为原始摘录）/)
  // 失败时 model 为空，元信息里不该出现空尾巴
  assert.match(md, /^> .*7 条消息 · 2 位发言人$/m)
})

test('dryRun 时状态行渲染「预演」', () => {
  const md = renderDetailedMarkdown(baseEntry(), { dryRun: true })
  assert.match(md, /- 状态：预演/)
})

test('超长 Markdown 截断到 MAX_MD 并加截断标记', () => {
  const md = renderDetailedMarkdown(baseEntry({ text: 'x'.repeat(MAX_MD + 500) }))
  assert.ok(md.length <= MAX_MD + '…(截断)'.length)
  assert.ok(md.endsWith('…(截断)'))
})

test('表格单元格里的竖线与换行被转义，不会撑破列', () => {
  const section = renderMembersSection([{ id: '1', name: 'a|b\nc', count: 2 }])
  assert.match(section, /\| a\\\|b c \| 1 \| 2 \|/)
})

test('成员表带上「本次重点」列，focus 为空时填 —', () => {
  const section = renderMembersSection([
    { id: '1', name: '王五', count: 5, focus: '主张本地模型' },
    { id: '2', name: '张三', count: 2 },
  ])
  assert.match(section, /\| 成员 \| QQ \| 发言数 \| 本次重点 \|/)
  assert.match(section, /\| 王五 \| 1 \| 5 \| 主张本地模型 \|/)
  assert.match(section, /\| 张三 \| 2 \| 2 \| — \|/)
})

test('renderMembersSection 可单独追加到 AI 正文之后', () => {
  const section = renderMembersSection([{ id: '9', name: '李四', count: 3, focus: '提了三个问题' }])
  assert.match(section, /^\n## 参与成员\n/)
  assert.match(section, /\| 李四 \| 9 \| 3 \| 提了三个问题 \|/)
  assert.ok(section.endsWith('\n'))
})

test('renderMembersSection 空列表给出（未记录）而不是空白表格', () => {
  const section = renderMembersSection([])
  assert.match(section, /\| （未记录） \| — \| — \| — \|/)
  assert.match(renderMembersSection(null), /（未记录）/)
})

test('空 entry / 非对象入参不抛错', () => {
  const a = renderDetailedMarkdown({})
  assert.match(a, /^# 未知群/)
  assert.match(a, /（本批无有效讨论内容）/)
  const b = renderDetailedMarkdown(null)
  assert.match(b, /## 三、投递状态/)
})