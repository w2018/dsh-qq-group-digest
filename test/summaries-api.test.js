import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HttpServer } from '../lib/http/server.js'
import { SummaryHistory } from '../lib/store/history.js'
import { GroupNameStore } from '../lib/store/group-names.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
const tmpDirs = []

after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-digest-sumapi-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, 'summaries'), { recursive: true })
  return dir
}

/** 预置一份历史文件：绕过 SummaryHistory 的 20 条上限，直接写盘。 */
function seedGroup(root, groupId, entries) {
  writeFileSync(join(root, 'summaries', groupId + '.json'), JSON.stringify({ groupId, entries }, null, 2), 'utf8')
}

function makeRuntime(root, extra) {
  const o = extra || {}
  return {
    rootDir: root,
    history: o.history === undefined ? new SummaryHistory(join(root, 'summaries')) : o.history,
    groupNames: o.groupNames === undefined ? new GroupNameStore(root) : o.groupNames,
    cfg: {
      httpServer: { enabled: true, port: 0, host: '127.0.0.1', authEnabled: false, token: '', sessionHours: 168 },
    },
    status() {
      return { started: true }
    },
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function withServer(runtime, fn) {
  const port = await freePort()
  runtime.cfg.httpServer.port = port
  const server = new HttpServer({
    getRuntime: () => runtime,
    logStore: null,
    settingsFile: '',
    pluginRoot: '',
    logger: silentLogger,
  })
  await server.start()
  try {
    return await fn('http://127.0.0.1:' + port)
  } finally {
    await server.stop()
  }
}

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

async function getJson(base, path) {
  const res = await fetch(base + path)
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) }
}

function sampleEntry(over) {
  return Object.assign(
    {
      at: 1792916657,
      batchId: 'b1',
      groupName: '',
      count: 12,
      firstSec: 1792916472,
      lastSec: 1792916637,
      ok: true,
      text: '本批讨论了部署方式，结论是先用本地模型。',
      delivered: 1,
      failed: 0,
      outboxFile: '',
      participants: [{ id: '111', name: '张三', count: 7, focus: '主张本地模型' }],
      md: '',
      model: 'p/m',
      attempts: 1,
      aiDetail: false,
    },
    over || {},
  )
}

test('列表与详情的 groupName 从群名表补齐，群名表为空时回退条目旧值', async () => {
  const root = makeRoot()
  seedGroup(root, '100000001', [sampleEntry({ batchId: 'b1', groupName: '' })])
  seedGroup(root, '100000002', [sampleEntry({ batchId: 'b2', groupName: '条目里的旧群名' })])
  const names = new GroupNameStore(root)
  names.set('100000001', '群名表里的新群名')

  const runtime = makeRuntime(root, { groupNames: names })
  await withServer(runtime, async (base) => {
    const list = await getJson(base, '/api/summaries')
    assert.equal(list.status, 200)
    const byGroup = Object.fromEntries(list.json.items.map((x) => [x.groupId, x.groupName]))
    assert.equal(byGroup['100000001'], '群名表里的新群名', '群名表优先')
    assert.equal(byGroup['100000002'], '条目里的旧群名', '群名表没有时回退条目')

    const detail = await getJson(base, '/api/summaries/100000001/b1')
    assert.equal(detail.status, 200)
    assert.equal(detail.json.item.groupName, '群名表里的新群名')
    // 旧记录没有 md，详情要即时渲染一份；v0.5.0 起正文不含成员表。
    assert.match(detail.json.item.md, /^# 100000001/)
    assert.equal(detail.json.item.md.includes('参与成员'), false, '详情正文不再带成员表')
  })
})

test('groupNames 为 null 时列表仍 200，groupName 回退空串不崩', async () => {
  const root = makeRoot()
  seedGroup(root, '100000001', [sampleEntry({ groupName: '' })])
  const runtime = makeRuntime(root, { groupNames: null })
  await withServer(runtime, async (base) => {
    const list = await getJson(base, '/api/summaries')
    assert.equal(list.status, 200)
    assert.equal(list.json.items[0].groupName, '')
  })
})

test('POST /api/summaries/export 多条用 --- 分隔并带来源注释', async () => {
  const root = makeRoot()
  seedGroup(root, '100000001', [
    sampleEntry({ batchId: 'b1', md: '# 第一条\n\n正文一' }),
    sampleEntry({ batchId: 'b2', md: '# 第二条\n\n正文二' }),
  ])
  const runtime = makeRuntime(root)
  await withServer(runtime, async (base) => {
    const r = await post(base, '/api/summaries/export', {
      items: [
        { groupId: '100000001', batchId: 'b1' },
        { groupId: '100000001', batchId: 'b2' },
        { groupId: '999999', batchId: 'nope' },
      ],
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.count, 2, '不存在的条目静默跳过')
    assert.match(r.json.filename, /^qq-digest-export-\d{8}-\d{4}\.md$/)
    assert.match(r.json.markdown, /<!-- 100000001 b1 -->/)
    assert.match(r.json.markdown, /<!-- 100000001 b2 -->/)
    assert.equal(r.json.markdown.split('\n\n---\n\n').length, 2, '两条之间恰好一个分隔符')
    // 导出时才追加成员表，且整份导出里每条只追加一次。
    assert.equal(r.json.markdown.split('参与成员').length - 1, 2, '每条记录各一份成员表')
    assert.match(r.json.markdown, /\| 张三 \| 111 \| 7 \| 主张本地模型 \|/)
    assert.ok(r.json.markdown.indexOf('正文一') < r.json.markdown.indexOf('正文二'), '按请求顺序')
  })
})

test('POST /api/summaries/export 入参非法与空结果分别 400 / 404', async () => {
  const root = makeRoot()
  seedGroup(root, '100000001', [sampleEntry({ batchId: 'b1' })])
  const runtime = makeRuntime(root)
  await withServer(runtime, async (base) => {
    assert.equal((await post(base, '/api/summaries/export', {})).status, 400)
    assert.equal((await post(base, '/api/summaries/export', { items: [] })).status, 400)
    assert.equal((await post(base, '/api/summaries/export', { items: [{ groupId: '', batchId: '' }] })).status, 400)
    // 整群导出没有明确语义，显式拒绝而不是悄悄导全量
    assert.equal((await post(base, '/api/summaries/export', { groupId: '100000001', all: true })).status, 400)
    const missing = await post(base, '/api/summaries/export', { items: [{ groupId: '100000001', batchId: 'zzz' }] })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.ok, false)
  })
})

test('POST /api/summaries/delete 按条目删除，重复项只删一次', async () => {
  const root = makeRoot()
  seedGroup(root, '100000001', [
    sampleEntry({ batchId: 'b1', text: '一' }),
    sampleEntry({ batchId: 'b2', text: '二' }),
  ])
  const runtime = makeRuntime(root)
  await withServer(runtime, async (base) => {
    const r = await post(base, '/api/summaries/delete', {
      items: [
        { groupId: '100000001', batchId: 'b1' },
        { groupId: '100000001', batchId: 'b1' },
      ],
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.deleted, 1)

    const list = await getJson(base, '/api/summaries')
    assert.equal(list.json.items.length, 1)
    assert.equal(list.json.items[0].batchId, 'b2')

    // 磁盘上也真的删了
    const raw = JSON.parse(readFileSync(join(root, 'summaries', '100000001.json'), 'utf8'))
    assert.equal(raw.entries.length, 1)
    assert.equal(raw.entries[0].batchId, 'b2')
  })
})

test('POST /api/summaries/delete 整群删除与入参校验', async () => {
  const root = makeRoot()
  seedGroup(root, '100000001', [sampleEntry({ batchId: 'b1' }), sampleEntry({ batchId: 'b2' })])
  seedGroup(root, '100000002', [sampleEntry({ batchId: 'b3' })])
  const runtime = makeRuntime(root)
  await withServer(runtime, async (base) => {
    assert.equal((await post(base, '/api/summaries/delete', {})).status, 400)
    assert.equal((await post(base, '/api/summaries/delete', { all: true })).status, 400, '缺 groupId')

    const r = await post(base, '/api/summaries/delete', { groupId: '100000001', all: true })
    assert.equal(r.status, 200)
    assert.equal(r.json.deleted, 2)

    const list = await getJson(base, '/api/summaries')
    assert.deepEqual(list.json.items.map((x) => x.groupId), ['100000002'], '其它群不受影响')
  })
})

test('history 不可用时删除端点返回 400 而不是 500', async () => {
  const root = makeRoot()
  seedGroup(root, '100000001', [sampleEntry({ batchId: 'b1' })])
  const runtime = makeRuntime(root, { history: null })
  await withServer(runtime, async (base) => {
    const r = await post(base, '/api/summaries/delete', { items: [{ groupId: '100000001', batchId: 'b1' }] })
    assert.equal(r.status, 400)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /历史存储不可用/)
    // 文件没被误删
    assert.equal(existsSync(join(root, 'summaries', '100000001.json')), true)
  })
})
