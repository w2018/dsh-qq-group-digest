import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SYSTEM_PROMPT, getSystemPrompt, isDefaultPrompt } from '../lib/summarize/prompt-store.js'
import { buildSystemPrompt } from '../lib/summarize/prompt.js'

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
