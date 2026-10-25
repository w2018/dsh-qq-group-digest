export function makeEvent(overrides) {
  const o = overrides || {}
  const groupId = o.groupId != null ? o.groupId : '100000001'
  const msgId = o.msgId != null ? o.msgId : String(1000 + Math.floor(Math.random() * 100000))
  const realSeq = o.realSeq !== undefined ? o.realSeq : Number(msgId)
  return {
    self_id: 100000000,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: Number(groupId),
    group_name: o.groupName || 'AI大模型交流',
    user_id: o.userId != null ? Number(o.userId) : 111,
    time: o.time != null ? Number(o.time) : 1792821339,
    message_id: Number(msgId),
    real_id: Number(msgId),
    real_seq: realSeq == null ? undefined : String(realSeq),
    raw_message: o.text || 'hi',
    message: [{ type: 'text', data: { text: o.text || 'hi' } }],
    sender: { user_id: o.userId != null ? Number(o.userId) : 111, nickname: o.nickname || '张三', card: '', role: 'member' },
  }
}

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

export function baseConfig(overrides) {
  return Object.assign(
    {
      napcat: { wsUrl: 'ws://127.0.0.1:3001', token: '' },
      listen: { groups: ['100000001'], ignoreSelf: true },
      batch: { threshold: 5, freezeGraceMs: 0, maxBuffer: 50, maxWaitMs: 600000 },
      model: { provider: 'p', model: 'm', retries: 0, backoffMs: 100 },
      delivery: { friends: ['100000002'], aggregateWindowMs: 0 },
      storage: { dir: '' },
      dryRun: true,
    },
    overrides || {},
  )
}

/** 假的 llm 服务：按队列返回文本或抛错。 */
export function fakeLlm(script) {
  const queue = Array.isArray(script) ? script.slice() : [{ type: 'text', text: '默认总结内容，足够长的一段话。' }]
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream(options) {
      calls.push({ provider: options.provider, model: options.model, system: options.system, maxTokens: options.maxTokens })
      const item = queue.length > 1 ? queue.shift() : queue[0]
      return (async function* gen() {
        if (item && item.throw) throw new Error(item.throw)
        if (item && item.type === 'error') {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: item.message || '模型错误' } } }
          return
        }
        if (item && item.reasoning) yield { type: 'reasoning-delta', text: item.reasoning }
        yield { type: 'text-delta', text: item && item.text ? item.text : '兜底总结' }
        yield { type: 'finish', reason: { kind: (item && item.finishKind) || 'stop' } }
      })()
    },
  }
}

export function fakeCtx(llm, defaultModel) {
  const services = { llm }
  if (defaultModel) services.agentDefaultModel = { currentSelection: () => defaultModel }
  return {
    logger: silentLogger,
    get: (name) => services[name],
    reflect: { get: (name) => services[name] },
  }
}

export function fakeActions(failTimes) {
  let remaining = Number(failTimes) || 0
  const sent = []
  return {
    sent,
    async loginInfo() { return { user_id: 100000000, nickname: '测试机器人' } },
    async groupList() { return [] },
    async friendList() { return [] },
    async sendPrivate(userId, segments) {
      if (remaining > 0) {
        remaining -= 1
        throw new Error('发送被风控')
      }
      sent.push({ userId, text: segments.map((s) => s.data.text).join('') })
      return { messageId: String(Date.now()) }
    },
  }
}
