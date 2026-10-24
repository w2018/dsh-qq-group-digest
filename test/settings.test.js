import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDITABLE_FIELDS, pickEditable, sanitizeOverride, readSettings, writeSettings } from '../lib/store/settings.js'

test('EDITABLE_FIELDS 收录 ui.sidebarEntry 且类型为 boolean', () => {
  const entry = EDITABLE_FIELDS.find(([path]) => path === 'ui.sidebarEntry')
  assert.ok(entry, 'ui.sidebarEntry 必须在可编辑白名单里')
  assert.equal(entry[1], 'boolean')
})

test('pickEditable 带出 ui.sidebarEntry 与历史相关字段', () => {
  const picked = pickEditable({
    napcat: { wsUrl: 'ws://x' },
    model: { historyCount: 3, maxHistoryChars: 5000 },
    ui: { sidebarEntry: true },
  })
  assert.equal(picked.ui.sidebarEntry, true)
  assert.equal(picked.model.historyCount, 3)
  assert.equal(picked.model.maxHistoryChars, 5000)
  assert.equal(picked.napcat.wsUrl, 'ws://x')
})

test('pickEditable 缺字段时不凭空造出 ui 节点', () => {
  const picked = pickEditable({ napcat: { wsUrl: 'ws://x' } })
  assert.equal(picked.ui, undefined)
})

test('sanitizeOverride 保留合法的 ui.sidebarEntry', () => {
  const { override, dropped } = sanitizeOverride({ ui: { sidebarEntry: true } })
  assert.equal(override.ui.sidebarEntry, true)
  assert.deepEqual(dropped, [])
})

test('sanitizeOverride 把字符串 true 归一为布尔真', () => {
  assert.equal(sanitizeOverride({ ui: { sidebarEntry: 'true' } }).override.ui.sidebarEntry, true)
  assert.equal(sanitizeOverride({ ui: { sidebarEntry: false } }).override.ui.sidebarEntry, false)
})

test('sanitizeOverride 丢弃非白名单字段', () => {
  const { override, dropped } = sanitizeOverride({
    ui: { sidebarEntry: true, theme: 'dark' },
    storage: { dir: 'D:/x' },
    unknown: 1,
  })
  assert.equal(override.ui.sidebarEntry, true)
  assert.equal(override.ui.theme, undefined)
  assert.equal(override.storage, undefined)
  assert.equal(override.unknown, undefined)
  assert.ok(dropped.includes('ui.theme'))
  assert.ok(dropped.includes('storage.dir'))
  assert.ok(dropped.includes('unknown'))
})

test('sanitizeOverride 丢弃非数字的 number 字段', () => {
  const { override, dropped } = sanitizeOverride({ model: { historyCount: 'abc', maxHistoryChars: 3000 } })
  assert.equal(override.model.historyCount, undefined)
  assert.equal(override.model.maxHistoryChars, 3000)
  assert.ok(dropped.includes('model.historyCount'))
})

test('sanitizeOverride 输入非对象时返回空覆盖', () => {
  assert.deepEqual(sanitizeOverride(null), { override: {}, dropped: [] })
  assert.deepEqual(sanitizeOverride([1, 2]), { override: {}, dropped: [] })
})

test('writeSettings / readSettings 往返保留 ui.sidebarEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-digest-settings-'))
  try {
    const file = join(dir, 'settings.json')
    writeSettings(file, { ui: { sidebarEntry: true }, model: { historyCount: 2 } })
    const back = readSettings(file)
    assert.equal(back.ui.sidebarEntry, true)
    assert.equal(back.model.historyCount, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSettings 文件不存在时返回空对象', () => {
  assert.deepEqual(readSettings(join(tmpdir(), 'qq-digest-not-exist-' + Date.now() + '.json')), {})
})
