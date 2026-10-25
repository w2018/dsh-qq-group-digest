import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig, deepMerge, normalizeIdList, storageRoot } from '../lib/config.js'
import { EDITABLE_FIELDS, sanitizeOverride } from '../lib/store/settings.js'

test('deepMerge 递归合并且数组整体替换', () => {
  const out = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 9 }, list: [3] })
  assert.equal(out.a.b, 1)
  assert.equal(out.a.c, 9)
  assert.deepEqual(out.list, [3])
})

test('normalizeIdList 去空去重保序', () => {
  assert.deepEqual(normalizeIdList(['1', ' 2 ', '', '1', null]), ['1', '2'])
})

test('resolveConfig 校验 provider 与 model 必须成对', () => {
  const { errors } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { provider: 'p' } })
  assert.ok(errors.some((e) => e.includes('同时留空或同时填写')))
})

test('resolveConfig 拒绝非法 wsUrl', () => {
  const { errors } = resolveConfig({ napcat: { wsUrl: 'http://x' }, listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.ok(errors.some((e) => e.includes('ws://')))
})

test('resolveConfig dryRun 时允许 friends 为空', () => {
  const { errors } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: [] }, dryRun: true })
  assert.equal(errors.filter((e) => e.includes('delivery.friends')).length, 0)
})

// v0.5.0 方案 E.1：投递目标为空不再算配置错误——网页端与历史记录本身就是可用产物，
// 不能因为没有好友就让插件 startError、管线不启动。
test('resolveConfig 非 dryRun 时 friends 为空也不报错', () => {
  const { config, errors } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: [] }, dryRun: false })
  assert.deepEqual(errors, [])
  assert.deepEqual(config.delivery.friends, [])
})

test('resolveConfig friends 缺省（完全没有 delivery 段）也不报错', () => {
  const { config, errors } = resolveConfig({ listen: { groups: ['1'] } })
  assert.deepEqual(errors, [])
  assert.deepEqual(config.delivery.friends, [])
})

test('resolveConfig friends 全被过滤成空数组后仍不报错', () => {
  const { config, errors } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['', null, '  ', ''] } })
  assert.deepEqual(errors, [])
  assert.deepEqual(config.delivery.friends, [])
})

test('resolveConfig 按群覆盖阈值', () => {
  const { config } = resolveConfig({
    listen: { groups: ['1', '2'] },
    delivery: { friends: ['9'] },
    batch: { threshold: 100, perGroupOverride: { '2': { threshold: 20 } } },
  })
  assert.equal(config.batch.perGroupOverride['2'].threshold, 20)
})

test('storageRoot 支持自定义目录', () => {
  assert.equal(storageRoot({ storage: { dir: 'D:/tmp/x' } }), 'D:/tmp/x')
  assert.match(storageRoot({ storage: { dir: '' } }), /qq-digest$/)
})
test('resolveConfig 清洗 keywords 与 excludedSenders', () => {
  const { config } = resolveConfig({
    listen: { groups: ['1', '100'], keywords: ['广告', '广告', ''], excludedSenders: { '100': ['200', ''], '200': [], '999': ['5'] } },
    delivery: { friends: ['2'] },
  })
  assert.deepEqual(config.listen.keywords, ['广告'])
  // 999 不在监听列表 → 孤儿条目被丢弃；200 空列表 → 丢弃
  assert.deepEqual(config.listen.excludedSenders, { '100': ['200'] })
  // 关键词保留原始大小写（UI 回显一致），匹配时才忽略大小写
  const { config: c2 } = resolveConfig({ listen: { groups: ['1'], keywords: ['VPN'] }, delivery: { friends: ['2'] } })
  assert.deepEqual(c2.listen.keywords, ['VPN'])
})

test('resolveConfig ui.sidebarEntry 默认为 false', () => {
  const { config } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.equal(config.ui.sidebarEntry, false)
})

test('resolveConfig 接受 ui.sidebarEntry=true', () => {
  const { config } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, ui: { sidebarEntry: true } })
  assert.equal(config.ui.sidebarEntry, true)
})

test('resolveConfig ui.sidebarEntry 只认严格 true', () => {
  const { config } = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, ui: { sidebarEntry: 'yes' } })
  assert.equal(config.ui.sidebarEntry, false)
})

test('resolveConfig model.historyCount 默认 1 并 clamp 到 0..10', () => {
  const base = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.equal(base.config.model.historyCount, 1)

  const hi = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { historyCount: 99 } })
  assert.equal(hi.config.model.historyCount, 10)

  const lo = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { historyCount: -5 } })
  assert.equal(lo.config.model.historyCount, 0)

  const mid = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { historyCount: 4 } })
  assert.equal(mid.config.model.historyCount, 4)
})

test('resolveConfig model.maxHistoryChars 默认 2000 并 clamp 到 0..20000', () => {
  const base = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] } })
  assert.equal(base.config.model.maxHistoryChars, 2000)

  const hi = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { maxHistoryChars: 999999 } })
  assert.equal(hi.config.model.maxHistoryChars, 20000)

  const lo = resolveConfig({ listen: { groups: ['1'] }, delivery: { friends: ['2'] }, model: { maxHistoryChars: -1 } })
  assert.equal(lo.config.model.maxHistoryChars, 0)
})

const BASE = { listen: { groups: ['1'] }, delivery: { friends: ['2'] } }

function resolve(extra) {
  return resolveConfig(Object.assign({}, BASE, extra || {}))
}

test('resolveConfig httpServer 默认关闭、端口 1213、监听 0.0.0.0、鉴权开启', () => {
  const { config, errors } = resolve()
  assert.deepEqual(config.httpServer, {
    enabled: false,
    port: 1213,
    host: '0.0.0.0',
    authEnabled: true,
    token: '',
    sessionHours: 168,
  })
  assert.deepEqual(errors, [])
})

test('resolveConfig httpServer.port clamp 到 1024..65535', () => {
  assert.equal(resolve({ httpServer: { port: 80 } }).config.httpServer.port, 1024)
  assert.equal(resolve({ httpServer: { port: 99999 } }).config.httpServer.port, 65535)
  assert.equal(resolve({ httpServer: { port: 1213 } }).config.httpServer.port, 1213)
  assert.equal(resolve({ httpServer: { port: 'abc' } }).config.httpServer.port, 1213)
})

test('resolveConfig httpServer.host 空值回落 0.0.0.0', () => {
  assert.equal(resolve({ httpServer: { host: '  ' } }).config.httpServer.host, '0.0.0.0')
  assert.equal(resolve({ httpServer: { host: null } }).config.httpServer.host, '0.0.0.0')
  assert.equal(resolve({ httpServer: { host: ' 127.0.0.1 ' } }).config.httpServer.host, '127.0.0.1')
})

test('resolveConfig httpServer.sessionHours clamp 到 1..8760', () => {
  assert.equal(resolve({ httpServer: { sessionHours: 0 } }).config.httpServer.sessionHours, 1)
  assert.equal(resolve({ httpServer: { sessionHours: 999999 } }).config.httpServer.sessionHours, 8760)
  assert.equal(resolve({ httpServer: { sessionHours: 24 } }).config.httpServer.sessionHours, 24)
})

test('resolveConfig httpServer.enabled 只认严格 true，authEnabled 只认严格 false 关闭', () => {
  assert.equal(resolve({ httpServer: { enabled: 'yes' } }).config.httpServer.enabled, false)
  assert.equal(resolve({ httpServer: { enabled: true } }).config.httpServer.enabled, true)
  assert.equal(resolve({ httpServer: { authEnabled: false } }).config.httpServer.authEnabled, false)
  assert.equal(resolve({ httpServer: { authEnabled: 0 } }).config.httpServer.authEnabled, true)
})

test('resolveConfig httpServer.token trim 且允许为空', () => {
  assert.equal(resolve({ httpServer: { token: '  abc  ' } }).config.httpServer.token, 'abc')
  assert.equal(resolve({ httpServer: { token: null } }).config.httpServer.token, '')
  // token 为空是合法状态：不产生任何错误
  assert.deepEqual(resolve({ httpServer: { token: '' } }).errors, [])
})

test('resolveConfig prompt.system 默认为空串（= 用内置默认）', () => {
  const { config } = resolve()
  assert.equal(config.prompt.system, '')
})

test('resolveConfig prompt.system 字符串化并 trim', () => {
  assert.equal(resolve({ prompt: { system: '  自定义提示词  ' } }).config.prompt.system, '自定义提示词')
  assert.equal(resolve({ prompt: { system: 123 } }).config.prompt.system, '123')
  assert.equal(resolve({ prompt: { system: null } }).config.prompt.system, '')
})

test('resolveConfig prompt.system 超过 20000 字符截断并报错', () => {
  const long = 'x'.repeat(20001)
  const { config, errors } = resolve({ prompt: { system: long } })
  assert.equal(config.prompt.system.length, 20000)
  assert.ok(errors.includes('prompt.system 超过 20000 字符'))

  const ok = resolve({ prompt: { system: 'y'.repeat(20000) } })
  assert.equal(ok.config.prompt.system.length, 20000)
  assert.deepEqual(ok.errors, [])
})

test('resolveConfig model.maxTokens 默认 2048，detailMaxTokens 默认 4096', () => {
  const { config } = resolve()
  assert.equal(config.model.maxTokens, 2048)
  assert.equal(config.model.detailMaxTokens, 4096)
})

test('resolveConfig maxTokens / detailMaxTokens 按各自区间 clamp', () => {
  assert.equal(resolve({ model: { maxTokens: 1 } }).config.model.maxTokens, 64)
  assert.equal(resolve({ model: { maxTokens: 999999 } }).config.model.maxTokens, 32000)
  assert.equal(resolve({ model: { maxTokens: 100 } }).config.model.maxTokens, 100)
  assert.equal(resolve({ model: { detailMaxTokens: 1 } }).config.model.detailMaxTokens, 512)
  assert.equal(resolve({ model: { detailMaxTokens: 999999 } }).config.model.detailMaxTokens, 32000)
  assert.equal(resolve({ model: { detailMaxTokens: 3000 } }).config.model.detailMaxTokens, 3000)
})

test('resolveConfig prompt.detailSystem 默认为空串（= 用内置默认）', () => {
  assert.equal(resolve().config.prompt.detailSystem, '')
})

test('resolveConfig prompt.detailSystem 与 system 同规则：字符串化 + trim', () => {
  assert.equal(resolve({ prompt: { detailSystem: '  自定义精细版  ' } }).config.prompt.detailSystem, '自定义精细版')
  assert.equal(resolve({ prompt: { detailSystem: 123 } }).config.prompt.detailSystem, '123')
  assert.equal(resolve({ prompt: { detailSystem: null } }).config.prompt.detailSystem, '')
})

test('resolveConfig prompt.detailSystem 超过 20000 字符截断并报错', () => {
  const long = 'x'.repeat(20001)
  const { config, errors } = resolve({ prompt: { detailSystem: long } })
  assert.equal(config.prompt.detailSystem.length, 20000)
  assert.ok(errors.includes('prompt.detailSystem 超过 20000 字符'))

  const ok = resolve({ prompt: { detailSystem: 'y'.repeat(20000) } })
  assert.equal(ok.config.prompt.detailSystem.length, 20000)
  assert.deepEqual(ok.errors, [])
})

test('prompt.system 与 prompt.detailSystem 互相独立', () => {
  const { config, errors } = resolve({
    prompt: { system: '普通版', detailSystem: 'x'.repeat(20001) },
  })
  assert.equal(config.prompt.system, '普通版')
  assert.equal(config.prompt.detailSystem.length, 20000)
  assert.deepEqual(errors, ['prompt.detailSystem 超过 20000 字符'])
})

test('resolveConfig summary.aiDetail 默认 false，只认严格 true', () => {
  assert.equal(resolve().config.summary.aiDetail, false)
  assert.equal(resolve({ summary: { aiDetail: true } }).config.summary.aiDetail, true)
  assert.equal(resolve({ summary: { aiDetail: 'true' } }).config.summary.aiDetail, false)
  assert.equal(resolve({ summary: { aiDetail: 1 } }).config.summary.aiDetail, false)
})

test('EDITABLE_FIELDS 收录 httpServer.* 与 summary.aiDetail，但不含 prompt.system', () => {
  const paths = EDITABLE_FIELDS.map(([path]) => path)
  for (const path of [
    'httpServer.enabled',
    'httpServer.port',
    'httpServer.host',
    'httpServer.authEnabled',
    'httpServer.sessionHours',
    'summary.aiDetail',
  ]) {
    assert.ok(paths.includes(path), path + ' 必须在可编辑白名单里')
  }
  // prompt.system / prompt.detailSystem 走单独端点，避免通用保存流程误清空
  assert.ok(!paths.includes('prompt.system'))
  assert.ok(!paths.includes('prompt.detailSystem'))
  assert.ok(!paths.includes('httpServer.token'))
})

test('EDITABLE_FIELDS 收录 model.detailMaxTokens', () => {
  const paths = EDITABLE_FIELDS.map(([path]) => path)
  assert.ok(paths.includes('model.maxTokens'))
  assert.ok(paths.includes('model.detailMaxTokens'))
})

test('sanitizeOverride 保留 httpServer 字段并丢弃 token / prompt.system', () => {
  const got = sanitizeOverride({
    httpServer: { enabled: true, port: 1213, host: ' 0.0.0.0 ', authEnabled: 'true', sessionHours: 24, token: 'secret' },
    prompt: { system: '自定义' },
    summary: { aiDetail: true },
  })
  assert.deepEqual(got.override.httpServer, {
    enabled: true,
    port: 1213,
    host: '0.0.0.0',
    authEnabled: true,
    sessionHours: 24,
  })
  assert.equal(got.override.summary.aiDetail, true)
  assert.equal(got.override.prompt, undefined)
  assert.ok(got.dropped.includes('httpServer.token'))
  assert.ok(got.dropped.includes('prompt.system'))
})

test('sanitizeOverride 丢弃 prompt.detailSystem 但保留 model.detailMaxTokens', () => {
  const got = sanitizeOverride({
    prompt: { detailSystem: '自定义精细版' },
    model: { detailMaxTokens: 5000 },
  })
  assert.equal(got.override.prompt, undefined)
  assert.ok(got.dropped.includes('prompt.detailSystem'))
  assert.equal(got.override.model.detailMaxTokens, 5000)
})
