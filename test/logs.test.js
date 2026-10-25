import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LogStore, dayKey } from '../lib/store/logs.js'

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-digest-logs-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('append 补 at 与自增 seq，并归一化字段', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    const a = store.append({ level: 'INFO', scope: ' pipeline ', groupId: 908370050, msg: '冻结批次' })
    const b = store.append({ level: 'warn', msg: '第二条' })
    assert.equal(a.level, 'info')
    assert.equal(a.scope, 'pipeline')
    assert.equal(a.groupId, '908370050')
    assert.equal(a.seq, 1)
    assert.equal(b.seq, 2)
    assert.ok(a.at > 0)
    assert.ok(b.at >= a.at)
    assert.deepEqual(a.extra, {})
  })
})

test('append 缺字段时给出安全默认值', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    const e = store.append({})
    assert.equal(e.level, 'info')
    assert.equal(e.scope, '')
    assert.equal(e.groupId, '')
    assert.equal(e.msg, '')
  })
})

test('内存环形缓冲超 maxMemory 丢最旧并计数', () => {
  withTemp((dir) => {
    const store = new LogStore(dir, { maxMemory: 3 })
    for (let i = 1; i <= 5; i += 1) store.append({ msg: 'm' + i })
    const got = store.recent({ limit: 10 })
    assert.deepEqual(got.map((e) => e.msg), ['m5', 'm4', 'm3'])
    assert.equal(store.stats().dropped, 2)
    assert.equal(store.stats().memory, 3)
  })
})

test('recent 默认最新在前且受 limit 约束', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    for (let i = 1; i <= 10; i += 1) store.append({ msg: 'm' + i })
    const got = store.recent({ limit: 3 })
    assert.deepEqual(got.map((e) => e.msg), ['m10', 'm9', 'm8'])
    assert.equal(store.recent().length, 10)
  })
})

test('recent 按 level 与 groupId 过滤', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    store.append({ level: 'info', groupId: '1', msg: 'a' })
    store.append({ level: 'error', groupId: '1', msg: 'b' })
    store.append({ level: 'error', groupId: '2', msg: 'c' })
    assert.deepEqual(store.recent({ level: 'error' }).map((e) => e.msg), ['c', 'b'])
    assert.deepEqual(store.recent({ groupId: '1' }).map((e) => e.msg), ['b', 'a'])
    assert.deepEqual(store.recent({ level: 'error', groupId: '1' }).map((e) => e.msg), ['b'])
    // warning 视为 warn
    store.append({ level: 'warning', msg: 'd' })
    assert.deepEqual(store.recent({ level: 'warn' }).map((e) => e.msg), ['d'])
  })
})

test('recent 关键字搜索覆盖 msg / scope / groupId / extra', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    store.append({ scope: 'pipeline', msg: '冻结批次', extra: { batchId: 'b12' } })
    store.append({ scope: 'deliver', msg: '发送成功' })
    assert.deepEqual(store.recent({ keyword: '冻结' }).map((e) => e.msg), ['冻结批次'])
    assert.deepEqual(store.recent({ keyword: 'DELIVER' }).map((e) => e.msg), ['发送成功'])
    assert.deepEqual(store.recent({ keyword: 'b12' }).map((e) => e.msg), ['冻结批次'])
  })
})

test('recent 支持 since / until 时间范围', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    store.append({ at: 1000, msg: 'a' })
    store.append({ at: 2000, msg: 'b' })
    store.append({ at: 3000, msg: 'c' })
    assert.deepEqual(store.recent({ since: 2000 }).map((e) => e.msg), ['c', 'b'])
    assert.deepEqual(store.recent({ until: 2000 }).map((e) => e.msg), ['b', 'a'])
    assert.deepEqual(store.recent({ since: 1500, until: 2500 }).map((e) => e.msg), ['b'])
  })
})

test('落盘到 logs/YYYY-MM-DD.jsonl，每行一个可解析 JSON', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    const at = new Date(2026, 9, 25, 11, 20, 0).getTime()
    store.append({ at, level: 'info', scope: 'pipeline', groupId: '1', msg: '第一条' })
    store.append({ at, level: 'error', scope: 'deliver', groupId: '1', msg: '第二条' })
    const file = join(dir, 'logs', '2026-10-25.jsonl')
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.msg, '第一条')
    assert.equal(first.level, 'info')
    assert.equal(first.at, at)
    assert.equal(JSON.parse(lines[1]).level, 'error')
  })
})

test('落盘失败不抛错，只记录 lastError', () => {
  withTemp((dir) => {
    // 把 logs 路径先占成一个普通文件，mkdir 必然失败
    writeFileSync(join(dir, 'logs'), 'not a dir', 'utf8')
    const store = new LogStore(dir)
    assert.doesNotThrow(() => store.append({ msg: '仍然要进内存' }))
    assert.equal(store.recent({ limit: 1 })[0].msg, '仍然要进内存')
    assert.ok(store.stats().lastError.length > 0)
  })
})

test('rootDir 为空时只用内存缓冲', () => {
  const store = new LogStore('')
  store.append({ msg: '内存' })
  assert.equal(store.recent({ limit: 1 })[0].msg, '内存')
  assert.equal(store.stats().dir, '')
  assert.deepEqual(store.listFiles(), [])
})

test('prune 只保留 keepDays 个自然日', () => {
  withTemp((dir) => {
    mkdirSync(join(dir, 'logs'), { recursive: true })
    const now = new Date(2026, 9, 25, 12, 0, 0).getTime()
    for (const name of ['2026-10-25.jsonl', '2026-10-24.jsonl', '2026-10-19.jsonl', '2026-10-18.jsonl', '2020-01-01.jsonl']) {
      writeFileSync(join(dir, 'logs', name), '\n', 'utf8')
    }
    const store = new LogStore(dir, { keepDays: 7 })
    const removed = store.prune(now)
    assert.equal(removed, 2)
    const left = readdirSync(join(dir, 'logs')).sort()
    // 7 个自然日 = 今天往前 6 天，2026-10-19 是第 7 天，保留
    assert.deepEqual(left, ['2026-10-19.jsonl', '2026-10-24.jsonl', '2026-10-25.jsonl'])
  })
})

test('prune 忽略非日期命名的文件，且 keepDays=1 只留今天', () => {
  withTemp((dir) => {
    mkdirSync(join(dir, 'logs'), { recursive: true })
    const now = new Date(2026, 9, 25, 12, 0, 0).getTime()
    writeFileSync(join(dir, 'logs', 'notes.txt'), 'x', 'utf8')
    writeFileSync(join(dir, 'logs', '2026-10-25.jsonl'), '\n', 'utf8')
    writeFileSync(join(dir, 'logs', '2026-10-24.jsonl'), '\n', 'utf8')
    const store = new LogStore(dir, { keepDays: 1 })
    assert.equal(store.prune(now), 1)
    assert.deepEqual(readdirSync(join(dir, 'logs')).sort(), ['2026-10-25.jsonl', 'notes.txt'])
  })
})

test('clear 只清内存缓冲，不动落盘文件', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    store.append({ msg: 'a' })
    store.append({ msg: 'b' })
    assert.equal(store.clear(), 2)
    assert.equal(store.recent().length, 0)
    assert.equal(store.stats().total, 2)
    assert.equal(store.listFiles().length, 1)
  })
})

test('stats 汇总级别计数与文件数', () => {
  withTemp((dir) => {
    const store = new LogStore(dir)
    store.append({ level: 'info', msg: 'a' })
    store.append({ level: 'error', msg: 'b' })
    store.append({ level: 'error', msg: 'c' })
    const s = store.stats()
    assert.equal(s.total, 3)
    assert.equal(s.memory, 3)
    assert.equal(s.byLevel.error, 2)
    assert.equal(s.byLevel.info, 1)
    assert.equal(s.files, 1)
    assert.equal(s.keepDays, 7)
    assert.equal(s.lastSeq, 3)
  })
})

test('dayKey 输出本地 YYYY-MM-DD', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 9, 0, 0).getTime()), '2026-01-05')
})
