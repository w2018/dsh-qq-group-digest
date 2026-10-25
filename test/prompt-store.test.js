import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_DETAIL_SYSTEM_PROMPT,
  getSystemPrompt,
  isDefaultPrompt,
  getDetailSystemPrompt,
  isDefaultDetailPrompt,
} from '../lib/summarize/prompt-store.js'
import { buildSystemPrompt, buildDetailSystemPrompt } from '../lib/summarize/prompt.js'

test('DEFAULT_SYSTEM_PROMPT 与 buildSystemPrompt() 逐字一致', () => {
  assert.equal(buildSystemPrompt(), DEFAULT_SYSTEM_PROMPT)
})

test('DEFAULT_SYSTEM_PROMPT 非空且保留发言人称谓硬约束', () => {
  assert.ok(DEFAULT_SYSTEM_PROMPT.length > 200)
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes('【王五】'))
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes('【历史总结的使用方式】'))
})

test('buildSystemPrompt 每次返回同一份常量（不重新拼装）', () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt())
})

test('getSystemPrompt 无覆盖时返回内置默认', () => {
  assert.equal(getSystemPrompt(''), DEFAULT_SYSTEM_PROMPT)
  assert.equal(getSystemPrompt(undefined), DEFAULT_SYSTEM_PROMPT)
  assert.equal(getSystemPrompt(null), DEFAULT_SYSTEM_PROMPT)
})

test('getSystemPrompt 纯空白覆盖视为未设置', () => {
  assert.equal(getSystemPrompt('   \n\t '), DEFAULT_SYSTEM_PROMPT)
})

test('getSystemPrompt 有覆盖时用覆盖并 trim', () => {
  assert.equal(getSystemPrompt('  你是自定义助手  '), '你是自定义助手')
  assert.equal(getSystemPrompt('自定义'), '自定义')
})

test('getSystemPrompt 非字符串入参按字符串处理', () => {
  assert.equal(getSystemPrompt(123), '123')
  assert.equal(getSystemPrompt(false), 'false')
})

test('isDefaultPrompt 与默认逐字比较（不 trim）', () => {
  assert.equal(isDefaultPrompt(DEFAULT_SYSTEM_PROMPT), true)
  assert.equal(isDefaultPrompt(' ' + DEFAULT_SYSTEM_PROMPT), false)
  assert.equal(isDefaultPrompt('自定义'), false)
  assert.equal(isDefaultPrompt(''), false)
  assert.equal(isDefaultPrompt(undefined), false)
  assert.equal(isDefaultPrompt(null), false)
})

// ── AI 精细版提示词（v0.5.0 双提示词） ─────────────────────

test('DEFAULT_DETAIL_SYSTEM_PROMPT 与 buildDetailSystemPrompt() 逐字一致', () => {
  assert.equal(buildDetailSystemPrompt(), DEFAULT_DETAIL_SYSTEM_PROMPT)
  assert.equal(buildDetailSystemPrompt(undefined), DEFAULT_DETAIL_SYSTEM_PROMPT)
})

test('两套默认提示词互不相同', () => {
  assert.notEqual(DEFAULT_DETAIL_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT)
  assert.equal(isDefaultPrompt(DEFAULT_DETAIL_SYSTEM_PROMPT), false)
  assert.equal(isDefaultDetailPrompt(DEFAULT_SYSTEM_PROMPT), false)
})

test('DEFAULT_DETAIL_SYSTEM_PROMPT 保留精细版关键约束', () => {
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.length > 500)
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('## 高频词条'))
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('==文字=='))
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('@@文字@@'))
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('<!--FOCUS'))
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('不要自己生成成员表'))
})

test('DEFAULT_DETAIL_SYSTEM_PROMPT 用 1200 字口径（不再写 800–2000 字）', () => {
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('不超过 1200 个汉字'))
  assert.ok(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('800–1200 字'))
  assert.equal(DEFAULT_DETAIL_SYSTEM_PROMPT.includes('800–2000 字之间'), false)
})

test('getDetailSystemPrompt 无覆盖时返回内置默认', () => {
  assert.equal(getDetailSystemPrompt(''), DEFAULT_DETAIL_SYSTEM_PROMPT)
  assert.equal(getDetailSystemPrompt(undefined), DEFAULT_DETAIL_SYSTEM_PROMPT)
  assert.equal(getDetailSystemPrompt(null), DEFAULT_DETAIL_SYSTEM_PROMPT)
  assert.equal(getDetailSystemPrompt('   \n\t '), DEFAULT_DETAIL_SYSTEM_PROMPT)
})

test('getDetailSystemPrompt 有覆盖时用覆盖并 trim', () => {
  assert.equal(getDetailSystemPrompt('  你是自定义精细版助手  '), '你是自定义精细版助手')
  assert.equal(buildDetailSystemPrompt('自定义精细版'), '自定义精细版')
})

test('isDefaultDetailPrompt 与精细版默认逐字比较（不 trim）', () => {
  assert.equal(isDefaultDetailPrompt(DEFAULT_DETAIL_SYSTEM_PROMPT), true)
  assert.equal(isDefaultDetailPrompt(' ' + DEFAULT_DETAIL_SYSTEM_PROMPT), false)
  assert.equal(isDefaultDetailPrompt('自定义'), false)
  assert.equal(isDefaultDetailPrompt(''), false)
  assert.equal(isDefaultDetailPrompt(undefined), false)
  assert.equal(isDefaultDetailPrompt(null), false)
})
