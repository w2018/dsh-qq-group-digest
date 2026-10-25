import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveRoute, summarizeBatch } from '../lib/summarize/summarize.js'
import { buildUserPrompt, buildFallbackText, buildDetailSystemPrompt } from '../lib/summarize/prompt.js'
import { fakeLlm, fakeCtx, silentLogger } from './helpers.js'

const recs = [
  { timeSec: 1792821300, senderName: '张三', senderId: '1', text: '今天讨论模型选型' },
  { timeSec: 1792821360, senderName: '李四', senderId: '2', text: '我推荐 deepseek' },
]

test('resolveRoute 优先显式配置', async () => {
  const ctx = fakeCtx(fakeLlm())
  const route = await resolveRoute(ctx, { provider: 'p', model: 'm' })
  assert.equal(route.provider, 'p')
  assert.equal(route.model, 'm')
  assert.equal(route.source, 'explicit')
})

test('resolveRoute 回退到 agentDefaultModel', async () => {
  const ctx = fakeCtx(fakeLlm(), { provider: 'd', model: 'dm' })
  const route = await resolveRoute(ctx, {})
  assert.equal(route.provider, 'd')
  assert.equal(route.source, 'default')
})

test('resolveRoute 回退到首个可用 provider', async () => {
  const ctx = fakeCtx(fakeLlm())
  const route = await resolveRoute(ctx, {})
  assert.equal(route.provider, 'p')
  assert.equal(route.source, 'first-available')
})

test('resolveRoute 没有 llm 时抛 RouteError', async () => {
  await assert.rejects(() => resolveRoute({ get: () => undefined }, { provider: 'p', model: 'm' }), /LLM 服务不可用/)
})

test('summarizeBatch 成功返回文本与路由', async () => {
  const ctx = fakeCtx(fakeLlm([{ text: '本批讨论了模型选型，结论是 deepseek。' }]))
  const res = await summarizeBatch(ctx, recs, {
    groupId: '1',
    groupName: '测试群',
    modelConfig: { provider: 'p', model: 'm', retries: 0 },
    logger: silentLogger,
  })
  assert.equal(res.ok, true)
  assert.equal(res.provider, 'p')
  assert.match(res.text, /deepseek/)
})

test('summarizeBatch 重试后成功', async () => {
  const ctx = fakeCtx(fakeLlm([{ throw: '临时失败' }, { text: '第二次成功，内容足够长的一段总结。' }]))
  const res = await summarizeBatch(ctx, recs, {
    groupId: '1',
    groupName: '测试群',
    modelConfig: { provider: 'p', model: 'm', retries: 1, backoffMs: 10 },
    logger: silentLogger,
  })
  assert.equal(res.ok, true)
  assert.equal(res.attempts, 2)
})

test('summarizeBatch 用尽重试后失败并保留错误', async () => {
  const ctx = fakeCtx(fakeLlm([{ throw: '一直失败' }]))
  const res = await summarizeBatch(ctx, recs, {
    groupId: '1',
    modelConfig: { provider: 'p', model: 'm', retries: 2, backoffMs: 5 },
    logger: silentLogger,
  })
  assert.equal(res.ok, false)
  assert.equal(res.kind, 'call')
  assert.equal(res.attempts, 3)
  assert.match(res.error, /一直失败/)
})

test('summarizeBatch 处理 finish.error 帧', async () => {
  const ctx = fakeCtx(fakeLlm([{ type: 'error', message: '模型拒绝' }]))
  const res = await summarizeBatch(ctx, recs, {
    groupId: '1',
    modelConfig: { provider: 'p', model: 'm', retries: 0 },
    logger: silentLogger,
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /模型拒绝/)
})

test('summarizeBatch 把过短返回视为失败', async () => {
  const ctx = fakeCtx(fakeLlm([{ text: '嗯' }]))
  const res = await summarizeBatch(ctx, recs, {
    groupId: '1',
    modelConfig: { provider: 'p', model: 'm', retries: 0 },
    logger: silentLogger,
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /过短/)
})

test('buildUserPrompt 含群名群号时间范围', () => {
  const text = buildUserPrompt(recs, { groupName: '测试群', groupId: '123', maxInputChars: 2000 })
  assert.match(text, /测试群/)
  assert.match(text, /123/)
  assert.match(text, /张三/)
})

test('buildUserPrompt 超长时保留最近消息', () => {
  const many = []
  for (let i = 0; i < 500; i += 1) {
    many.push({ timeSec: 1792821300 + i, senderName: 'u' + i, senderId: String(i), text: '这是一条比较长的测试消息内容 ' + i })
  }
  const text = buildUserPrompt(many, { groupName: 'g', groupId: '1', maxInputChars: 1500 })
  assert.ok(text.length <= 2200)
  assert.match(text, /已省略最早/)
})

test('buildFallbackText 给出统计与最近消息', () => {
  const text = buildFallbackText(recs, { groupName: '测试群', groupId: '123', errorMessage: '超时' })
  assert.match(text, /AI 总结失败/)
  assert.match(text, /【张三】1 条/)
  assert.match(text, /超时/)
})
test('buildUserPrompt 传 history 时带上此前的总结块', () => {
  const text = buildUserPrompt(recs, {
    groupName: '测试群',
    groupId: '123',
    maxInputChars: 4000,
    history: [
      { firstSec: 1792810000, count: 12, text: '上一批讨论了 deepseek 的上下文长度。' },
    ],
  })
  assert.match(text, /【该群此前的总结/)
  assert.match(text, /deepseek 的上下文长度/)
  assert.match(text, /12 条消息/)
  // 历史块必须排在群聊记录之前，模型先读历史再读本批。
  assert.ok(text.indexOf('【该群此前的总结') < text.indexOf('群聊记录如下：'))
})

test('buildUserPrompt 不传 history 时不出现历史总结块', () => {
  const text = buildUserPrompt(recs, { groupName: '测试群', groupId: '123', maxInputChars: 4000 })
  assert.equal(text.includes('【该群此前的总结'), false)
})

test('buildUserPrompt history 为空数组时不出现历史总结块', () => {
  const text = buildUserPrompt(recs, { groupName: '测试群', groupId: '123', history: [] })
  assert.equal(text.includes('【该群此前的总结'), false)
})

test('buildUserPrompt 多条历史按时间升序渲染（最近的在最后）', () => {
  const text = buildUserPrompt(recs, {
    groupName: '测试群',
    groupId: '123',
    maxInputChars: 8000,
    history: [
      { firstSec: 1792800000, count: 3, text: '最旧的一条历史' },
      { firstSec: 1792810000, count: 4, text: '最新的一条历史' },
    ],
  })
  assert.ok(text.indexOf('最旧的一条历史') < text.indexOf('最新的一条历史'))
})

test('buildUserPrompt 历史超出 maxHistoryChars 预算时从最旧的开始丢弃', () => {
  const text = buildUserPrompt(recs, {
    groupName: '测试群',
    groupId: '123',
    maxInputChars: 20000,
    maxHistoryChars: 400,
    history: [
      { firstSec: 1792800000, count: 3, text: 'A'.repeat(600) },
      { firstSec: 1792810000, count: 4, text: 'B'.repeat(100) },
    ],
  })
  assert.equal(text.includes('A'.repeat(600)), false)
  assert.match(text, /B{100}/)
})

test('buildDetailSystemPrompt 要求「高频词条」小节并排在要点之前', () => {
  const sp = buildDetailSystemPrompt()
  assert.match(sp, /高频词条/)
  assert.ok(sp.indexOf('## 高频词条') < sp.indexOf('## 要点'), '高频词条小节必须排在要点小节之前')
  assert.match(sp, /5–10 个/)
})

test('buildDetailSystemPrompt 声明 ==高亮== 与 @@强调@@ 两种标记语法', () => {
  const sp = buildDetailSystemPrompt()
  assert.match(sp, /==文字==/)
  assert.match(sp, /@@文字@@/)
  assert.match(sp, /不超过 8 处/)
  assert.match(sp, /不超过 4 处/)
})

test('buildDetailSystemPrompt 要求模型输出 FOCUS 注释块且不写成员表', () => {
  const sp = buildDetailSystemPrompt()
  assert.match(sp, /FOCUS/)
  assert.match(sp, /15 个字以内/)
  assert.match(sp, /不要自己生成成员表/)
})
