import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { Pipeline } from '../lib/pipeline.js'
import { MessageStore } from '../lib/store/messages.js'
import { makeEvent, baseConfig, fakeLlm, fakeCtx, fakeActions, silentLogger } from './helpers.js'

function buildPipeline(overrides, llm, actions) {
  const { config } = resolveConfig(Object.assign(baseConfig(), overrides || {}))
  const dir = mkdtempSync(join(tmpdir(), 'qqd-'))
  const store = new MessageStore(dir)
  const pipeline = new Pipeline({
    ctx: fakeCtx(llm || fakeLlm()),
    config,
    actions: actions || fakeActions(0),
    store,
    logger: silentLogger,
    outboxDir: dir,
  })
  pipeline.start()
  return { pipeline, config, dir }
}

test('resolveConfig 缺 groups/friends 时报错', () => {
  const { errors } = resolveConfig({ listen: { groups: [] }, delivery: { friends: [] } })
  assert.ok(errors.some((e) => e.includes('listen.groups')))
  assert.ok(errors.some((e) => e.includes('delivery.friends')))
})

test('resolveConfig 归一化默认值与非法值', () => {
  const { config, errors } = resolveConfig({
    listen: { groups: ['1', '1', ' 2 '] },
    delivery: { friends: ['9'] },
    batch: { threshold: 0 },
  })
  assert.equal(errors.length, 0)
  assert.deepEqual(config.listen.groups, ['1', '2'])
  assert.equal(config.batch.threshold, 1)
})

test('Pipeline 达阈值后调 LLM 并投递', async () => {
  const llm = fakeLlm([{ text: '本批共 3 条，讨论了部署方案，结论是先用本地模型。' }])
  const actions = fakeActions(0)
  const { pipeline } = buildPipeline({ batch: { threshold: 3, freezeGraceMs: 0 } }, llm, actions)
  for (let i = 1; i <= 3; i += 1) pipeline.handleEvent(makeEvent({ msgId: String(i), realSeq: i, text: 'm' + i }))
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(llm.calls.length, 1, '应调用一次 LLM')
  assert.equal(pipeline.stats.summarizedOk, 1)
  pipeline.dispose()
})

test('Pipeline 去重：同 message_id 重复推送只算一次', async () => {
  const llm = fakeLlm([{ text: '这是一段足够长的总结文本内容。' }])
  const { pipeline } = buildPipeline({ batch: { threshold: 2, freezeGraceMs: 0 } }, llm)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  pipeline.handleEvent(makeEvent({ msgId: '2', realSeq: 2 }))
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(pipeline.stats.duplicate, 1)
  assert.equal(pipeline.stats.accepted, 2)
  assert.equal(llm.calls.length, 1)
  pipeline.dispose()
})

test('Pipeline 忽略白名单外的群和自己的消息', async () => {
  const { pipeline } = buildPipeline({}, null)
  pipeline.handleEvent(makeEvent({ groupId: '999' }))
  pipeline.handleEvent(makeEvent({ userId: 100000000 }))
  assert.equal(pipeline.stats.accepted, 0)
  assert.ok(pipeline.stats.dropped >= 2)
  pipeline.dispose()
})

test('Pipeline LLM 失败时降级为原始摘录仍继续', async () => {
  const llm = fakeLlm([{ throw: '模型挂了' }])
  const entries = []
  const { pipeline } = buildPipeline({ batch: { threshold: 2, freezeGraceMs: 0 } }, llm)
  pipeline.onGroupSummary = async (e) => entries.push(e)
  for (let i = 1; i <= 2; i += 1) pipeline.handleEvent(makeEvent({ msgId: String(i), realSeq: i, text: '内容' + i }))
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(pipeline.stats.summarizedFail, 1)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ok, false)
  assert.match(entries[0].text, /AI 总结失败/)
  pipeline.dispose()
})

test('Pipeline 先落盘：消息写入 JSONL', async () => {
  const { pipeline, dir } = buildPipeline({ batch: { threshold: 100, freezeGraceMs: 0 } }, null)
  pipeline.handleEvent(makeEvent({ msgId: '77001', realSeq: 77001, text: '要落盘的消息' }))
  const files = readdirSync(join(dir, 'messages', '100000001'))
  assert.equal(files.length, 1)
  const content = readFileSync(join(dir, 'messages', '100000001', files[0]), 'utf8')
  assert.match(content, /要落盘的消息/)
  pipeline.dispose()
})

test('Pipeline 多群并发互不阻塞，各自独立计数', async () => {
  const llm = fakeLlm([{ text: '群总结内容足够长的一段文字描述。' }])
  const { pipeline } = buildPipeline(
    { listen: { groups: ['100000001', '222333444'] }, batch: { threshold: 2, freezeGraceMs: 0 } },
    llm,
  )
  pipeline.handleEvent(makeEvent({ groupId: '100000001', msgId: '1', realSeq: 1 }))
  pipeline.handleEvent(makeEvent({ groupId: '222333444', msgId: '2', realSeq: 2 }))
  pipeline.handleEvent(makeEvent({ groupId: '100000001', msgId: '3', realSeq: 3 }))
  pipeline.handleEvent(makeEvent({ groupId: '222333444', msgId: '4', realSeq: 4 }))
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(llm.calls.length, 2)
  const status = pipeline.status()
  assert.equal(status.groups.length, 2)
  pipeline.dispose()
})

test('Pipeline 队列 in-flight 期间再次冻结会合并', async () => {
  let release = null
  const gate = new Promise((r) => {
    release = r
  })
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream() {
      return (async function* gen() {
        await gate
        yield { type: 'text-delta', text: '合并后的总结内容足够长。' }
      })()
    },
  }
  const entries = []
  const { pipeline } = buildPipeline({ batch: { threshold: 1, freezeGraceMs: 0 } }, llm)
  pipeline.onGroupSummary = async (e) => entries.push(e)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  await new Promise((r) => setTimeout(r, 20))
  pipeline.handleEvent(makeEvent({ msgId: '2', realSeq: 2 }))
  pipeline.handleEvent(makeEvent({ msgId: '3', realSeq: 3 }))
  release()
  await new Promise((r) => setTimeout(r, 120))
  pipeline.dispose()
})

test('flushAll 立即冻结并处理 pending', async () => {
  const llm = fakeLlm([{ text: '手动 flush 触发的总结内容。' }])
  const { pipeline } = buildPipeline({ batch: { threshold: 100, freezeGraceMs: 0 } }, llm)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1 }))
  await pipeline.flushAll()
  assert.equal(llm.calls.length, 1)
  pipeline.dispose()
})
