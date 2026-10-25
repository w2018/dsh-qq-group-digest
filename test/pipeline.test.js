import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { Pipeline } from '../lib/pipeline.js'
import { renderMembersSection } from '../lib/summarize/markdown.js'
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

test('resolveConfig 缺 groups 时报错（friends 允许为空）', () => {
  const { errors } = resolveConfig({ listen: { groups: [] }, delivery: { friends: [] } })
  assert.ok(errors.some((e) => e.includes('listen.groups')))
  // v0.5.0 E.1：投递目标允许为空（网页端与历史记录本身就是可用产物），
  // 空 friends 不能再让插件起不来，所以这里必须**不**报错。
  assert.ok(!errors.some((e) => e.includes('delivery.friends')), 'friends 为空不该报错')
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

test('deliverEntries 多群各发一条独立消息，不合并且每群回填自己的投递结果', async () => {
  const actions = fakeActions(0)
  const llm = fakeLlm([{ text: '群一总结内容足够长的一段文字。' }, { text: '群二总结内容足够长的一段文字。' }])
  const { pipeline } = buildPipeline(
    { listen: { groups: ['100000001', '222333444'] }, batch: { threshold: 2, freezeGraceMs: 0 }, dryRun: false },
    llm,
    actions,
  )
  const collected = []
  pipeline.onGroupSummary = async (e) => collected.push(e)
  pipeline.handleEvent(makeEvent({ groupId: '100000001', msgId: '1', realSeq: 1 }))
  pipeline.handleEvent(makeEvent({ groupId: '222333444', msgId: '2', realSeq: 2 }))
  pipeline.handleEvent(makeEvent({ groupId: '100000001', msgId: '3', realSeq: 3 }))
  pipeline.handleEvent(makeEvent({ groupId: '222333444', msgId: '4', realSeq: 4 }))
  await new Promise((r) => setTimeout(r, 150))

  const out = await pipeline.deliverEntries(collected, 1792825000)
  assert.equal(out.entries.length, 2)
  // 两个群 → 两个好友段？好友只有一个 → 两条消息，每条只含本群内容。
  assert.equal(actions.sent.length, 2)
  const bodies = actions.sent.map((s) => String(s.text || ''))
  assert.ok(bodies.some((b) => b.includes('100000001') && !b.includes('222333444')))
  assert.ok(bodies.some((b) => b.includes('222333444') && !b.includes('100000001')))
  assert.equal(out.perGroup.length, 2)
  assert.ok(out.perGroup.every((x) => x.ok === true))
  pipeline.dispose()
})

test('deliverEntries 单群失败只影响该群的历史回填', async () => {
  const actions = fakeActions(0)
  let n = 0
  const original = actions.sendPrivate
  actions.sendPrivate = async (userId, seg) => {
    n += 1
    if (n === 1) throw new Error('第一个群被风控')
    return original(userId, seg)
  }
  const { pipeline } = buildPipeline(
    { batch: { threshold: 1, freezeGraceMs: 0 }, dryRun: false, delivery: { friends: ['100000002'], retry: { attempts: 1, backoffMs: 1 } } },
    fakeLlm(),
    actions,
  )
  const list = [
    { groupId: '111', batchId: 'b1', groupName: '群一', ok: true, text: '群一正文', count: 1 },
    { groupId: '222', batchId: 'b2', groupName: '群二', ok: true, text: '群二正文', count: 1 },
  ]
  const out = await pipeline.deliverEntries(list, 1792825000)
  assert.equal(out.result.failed.length, 1)
  assert.match(out.result.failed[0].error, /111/)
  const per = out.perGroup.find((x) => x.groupId === '222')
  assert.equal(per.ok, true)
  pipeline.dispose()
})
test('aiDetail：FOCUS 块被解析回填 participants，正文不再追加成员表（v0.5.0 A）', async () => {
  const detail = [
    '# 100000001 · AI大模型交流',
    '',
    '## 高频词条',
    '- ==deepseek==（出现 3 次）：本地模型选型',
    '',
    '## 要点',
    '【张三】主张用 ==本地模型==，@@不建议上云@@。',
    '',
    '## 结论',
    '先用本地模型跑一轮再评估。',
    '',
    '<!--FOCUS',
    '{"111":"主张本地模型","222":"支持先上云"}',
    '-->',
  ].join('\n')
  const llm = fakeLlm([
    { text: '本批讨论了本地模型与上云的取舍，结论是先用本地模型跑一轮再评估效果。' },
    { text: detail },
  ])
  const { pipeline } = buildPipeline(
    { batch: { threshold: 2, freezeGraceMs: 0 }, summary: { aiDetail: true } },
    llm,
  )
  const entries = []
  pipeline.onGroupSummary = async (e) => entries.push(e)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1, text: 'a', userId: 111, nickname: '张三' }))
  pipeline.handleEvent(makeEvent({ msgId: '2', realSeq: 2, text: 'b', userId: 222, nickname: '李四' }))
  await new Promise((r) => setTimeout(r, 250))

  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.aiDetail, true, '应标记为 AI 精细版')
  assert.match(entry.md, /## 高频词条/, '保留 AI 正文')
  // v0.5.0：成员表已移出正文，任何成员表都不该出现在 entry.md 里。
  assert.equal(entry.md.includes('参与成员'), false, '正文不该再拼成员表')
  assert.equal(entry.md.includes('| 成员 | QQ |'), false, '正文不该有成员表表头')
  // FOCUS 只在解析阶段用，注释块本身必须被剥掉。
  assert.ok(!entry.md.includes('FOCUS'), 'FOCUS 注释块不应残留在正文里')
  // 重点信息改由 participants 携带，网页详情页与导出各自渲染。
  const zhang = entry.participants.find((x) => x.id === '111')
  assert.equal(zhang.focus, '主张本地模型')
  const li = entry.participants.find((x) => x.id === '222')
  assert.equal(li.focus, '支持先上云')
  // 导出时才由 renderMembersSection 拼出这张表。
  const section = renderMembersSection(entry.participants)
  assert.match(section, /\| 张三 \| 111 \| 1 \| 主张本地模型 \|/)
  assert.match(section, /\| 李四 \| 222 \| 1 \| 支持先上云 \|/)
  pipeline.dispose()
})

test('aiDetail 关闭时用本地渲染，正文同样不含成员表', async () => {
  const llm = fakeLlm([{ text: '本批讨论了部署方案，结论是先用本地模型跑一轮。' }])
  const { pipeline } = buildPipeline({ batch: { threshold: 1, freezeGraceMs: 0 } }, llm)
  const entries = []
  pipeline.onGroupSummary = async (e) => entries.push(e)
  pipeline.handleEvent(makeEvent({ msgId: '1', realSeq: 1, text: 'a' }))
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].aiDetail, false)
  // 本地渲染路径也走「正文三节、无成员表」的同一套口径。
  assert.match(entries[0].md, /## 三、投递状态/)
  assert.equal(entries[0].md.includes('参与成员'), false)
  pipeline.dispose()
})

test('群名落进持久化群名表，status 与 groupNameOf 都能取到', async () => {
  const { GroupNameStore } = await import('../lib/store/group-names.js')
  const llm = fakeLlm([{ text: '本批讨论了群名同步，结论是没问题。' }])
  const { config } = resolveConfig(baseConfig({ batch: { threshold: 100, freezeGraceMs: 0 } }))
  const dir = mkdtempSync(join(tmpdir(), 'qqd-gn-'))
  const names = new GroupNameStore(dir)
  const pipeline = new Pipeline({
    ctx: fakeCtx(llm),
    config,
    actions: fakeActions(0),
    store: new MessageStore(dir),
    groupNameStore: names,
    logger: silentLogger,
    outboxDir: dir,
  })
  pipeline.start()
  pipeline.handleEvent(makeEvent({ msgId: '9', realSeq: 9, groupName: '测试群名', text: 'x' }))
  assert.equal(names.get('100000001'), '测试群名')
  assert.equal(pipeline.groupNameOf('100000001'), '测试群名')
  assert.equal(pipeline.status().groupNames['100000001'], '测试群名')
  pipeline.dispose()
})
// ── v0.5.0 G：Pipeline 层的过滤计数 ───────────────────────────────

test('G: Pipeline.dropReasons 按原因分别计数', async () => {
  const { pipeline } = buildPipeline(
    {
      listen: {
        groups: ['100000001'],
        ignoreSelf: true,
        keywords: ['广告'],
        excludedSenders: { '100000001': ['666'] },
      },
    },
    null,
  )

  // 各类丢弃各来一条
  pipeline.handleEvent(makeEvent({ groupId: '999999', msgId: 'r1' }))          // group-not-listed
  pipeline.handleEvent(makeEvent({ userId: 100000000, msgId: 'r2' }))         // self-message
  pipeline.handleEvent(makeEvent({ userId: 666, msgId: 'r3' }))               // excluded-sender
  pipeline.handleEvent(makeEvent({ text: '这里有广告', msgId: 'r4' }))         // keyword
  const priv = Object.assign(makeEvent({ msgId: 'r5' }), { message_type: 'private' })
  pipeline.handleEvent(priv)                                                  // message-type
  pipeline.handleEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }) // post-type
  // 一条正常的，不该进 dropReasons
  pipeline.handleEvent(makeEvent({ msgId: 'r6', text: '正常讨论' }))

  const status = pipeline.status()
  const reasons = status.dropReasons
  assert.equal(reasons['group-not-listed'], 1)
  assert.equal(reasons['self-message'], 1)
  assert.equal(reasons['excluded-sender'], 1)
  assert.equal(reasons.keyword, 1)
  assert.equal(reasons['message-type'], 1)
  assert.equal(reasons['post-type'], 1)
  assert.equal(status.stats.dropped, 6, '正常消息不计入 dropped')
  assert.equal(status.stats.accepted, 1)
  pipeline.dispose()
})

test('G: 同类丢弃累加而不是覆盖', () => {
  const { pipeline } = buildPipeline({}, null)
  for (let i = 0; i < 3; i += 1) pipeline.handleEvent(makeEvent({ groupId: '999999', msgId: 'acc' + i }))
  for (let i = 0; i < 2; i += 1) pipeline.handleEvent(makeEvent({ userId: 100000000, msgId: 'self' + i }))
  const reasons = pipeline.status().dropReasons
  assert.equal(reasons['group-not-listed'], 3)
  assert.equal(reasons['self-message'], 2)
  pipeline.dispose()
})

test('G: dropReasons 的 key 是冒号前的段（message-type:private → message-type）', () => {
  const { pipeline } = buildPipeline({}, null)
  pipeline.handleEvent(Object.assign(makeEvent({ msgId: 'k1' }), { message_type: 'private' }))
  pipeline.handleEvent(Object.assign(makeEvent({ msgId: 'k2' }), { message_type: 'discuss' }))
  const reasons = pipeline.status().dropReasons
  // 两种 message_type 归到同一个 key
  assert.equal(reasons['message-type'], 2)
  pipeline.dispose()
})

test('G: 关键词与 excludedSenders 都不命中时消息照常进入批次', async () => {
  const llm = fakeLlm([{ text: '本批只讨论技术，没有被过滤的消息。' }])
  const { pipeline } = buildPipeline(
    {
      listen: { groups: ['100000001'], keywords: ['广告'], excludedSenders: { '100000001': ['666'] } },
      batch: { threshold: 2, freezeGraceMs: 0 },
    },
    llm,
  )
  // msgId 必须是数字：makeEvent 内部会 Number(msgId)，非数字会退化成 NaN，
  // 两条消息的 dedupKey 撞车而被误判成重复。
  pipeline.handleEvent(makeEvent({ msgId: '9001', realSeq: 9001, text: '向量检索怎么做' }))
  pipeline.handleEvent(makeEvent({ msgId: '9002', realSeq: 9002, text: '用 embedding 召回' }))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(pipeline.stats.dropped, 0)
  assert.equal(pipeline.stats.accepted, 2)
  assert.equal(llm.calls.length, 1)
  pipeline.dispose()
})