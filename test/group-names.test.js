import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GroupNameStore } from '../lib/store/group-names.js'

const tmpDirs = []

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-digest-gn-'))
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

test('GroupNameStore set/get 往返并落盘', () => {
  const dir = makeRoot()
  const store = new GroupNameStore(dir)
  assert.equal(store.get('100000001'), '')
  assert.equal(store.set('100000001', 'AI技术交流分享'), true)
  assert.equal(store.get('100000001'), 'AI技术交流分享')
  assert.equal(store.flush(), true)

  const raw = JSON.parse(readFileSync(join(dir, 'group-names.json'), 'utf8'))
  assert.deepEqual(raw, { '100000001': 'AI技术交流分享' })

  // 新实例从磁盘读回
  const again = new GroupNameStore(dir)
  assert.equal(again.get('100000001'), 'AI技术交流分享')
})

test('GroupNameStore 空值不覆盖已有群名', () => {
  const store = new GroupNameStore(makeRoot())
  store.set('1', '真名')
  assert.equal(store.set('1', '   '), false)
  assert.equal(store.set('1', ''), false)
  assert.equal(store.set('', '无名群'), false)
  assert.equal(store.get('1'), '真名')
})

test('GroupNameStore merge 批量合并并返回变更数', () => {
  const store = new GroupNameStore(makeRoot())
  store.set('1', '旧名')
  const changed = store.merge({ 1: '旧名', 2: '新群', 3: '' })
  assert.equal(changed, 1)
  assert.deepEqual(store.all(), { 1: '旧名', 2: '新群' })
})

test('GroupNameStore 文件损坏时回落空表而不是抛错', () => {
  const dir = makeRoot()
  writeFileSync(join(dir, 'group-names.json'), '{ 不是 JSON', 'utf8')
  const store = new GroupNameStore(dir)
  assert.deepEqual(store.all(), {})
  assert.equal(store.get('1'), '')
  assert.equal(store.set('1', '重建'), true)
  assert.equal(store.flush(), true)
  assert.equal(existsSync(join(dir, 'group-names.json')), true)
  assert.equal(new GroupNameStore(dir).get('1'), '重建')
})

test('GroupNameStore 没有 root 时全部操作安全', () => {
  const store = new GroupNameStore('')
  assert.equal(store.get('1'), '')
  assert.equal(store.set('1', 'x'), true)
  assert.equal(store.get('1'), 'x')
  assert.equal(store.flush(), false)
})
