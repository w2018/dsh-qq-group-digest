const PLAIN_LABELS = {
  image: '[图片]',
  face: '[表情]',
  mface: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  forward: '[合并转发]',
  json: '[卡片]',
  xml: '[卡片]',
  markdown: '[卡片]',
  shake: '[戳一戳]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
  location: '[位置]',
  music: '[音乐]',
  contact: '[名片]',
  reply: '[回复]',
}

/** 把 OneBot11 的 message 段数组压成一行可读文本。 */
export function renderSegments(segments) {
  if (!Array.isArray(segments)) return ''
  const parts = []
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    const type = String(seg.type || '')
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    if (type === 'text') {
      const text = String(data.text == null ? '' : data.text)
      if (text) parts.push(text)
      continue
    }
    if (type === 'at') {
      const qq = String(data.qq == null ? '' : data.qq)
      if (qq === 'all') parts.push('@全体成员')
      else if (data.name) parts.push('@' + String(data.name))
      else parts.push('@' + qq)
      continue
    }
    parts.push(PLAIN_LABELS[type] || ('[' + type + ']'))
  }
  return parts.join('').trim()
}

/**
 * 把 NapCat 推来的原始事件规范化为内部 MessageRecord。
 * 返回 { record } 或 { dropped: '<原因>' }，dropped 的也用于缺口判定的抑制。
 */
export function normalizeEvent(event, options) {
  const opts = options || {}
  const groups = opts.groups instanceof Set ? opts.groups : new Set(opts.groups || [])
  const arrival = Number.isFinite(opts.arrival) ? opts.arrival : 0

  if (!event || typeof event !== 'object') return { dropped: 'not-an-object' }

  // 只吃群消息事件；notice / request / meta_event 一律丢弃。
  const postType = String(event.post_type || '')
  if (postType !== 'message') return { dropped: 'post-type:' + (postType || 'unknown') }

  const messageType = String(event.message_type || '')
  if (messageType !== 'group') return { dropped: 'message-type:' + (messageType || 'unknown') }

  const groupId = event.group_id == null ? '' : String(event.group_id)
  if (!groupId) return { dropped: 'no-group-id' }
  if (groups.size > 0 && !groups.has(groupId)) return { dropped: 'group-not-listed' }

  const sender = event.sender && typeof event.sender === 'object' ? event.sender : {}
  const senderId = String(sender.user_id == null ? event.user_id == null ? '' : event.user_id : sender.user_id)
  // selfId 优先用调用方（已登录账号），否则退回事件自带的 self_id
  const selfIdRaw = opts.selfId != null && String(opts.selfId) !== '' ? opts.selfId : event.self_id
  const selfId = selfIdRaw == null ? '' : String(selfIdRaw)
  if (opts.ignoreSelf !== false && selfId && senderId === selfId) return { dropped: 'self-message' }

  const rawId = event.message_id != null ? event.message_id : event.real_id
  const msgId = rawId == null ? '' : String(rawId)
  if (!msgId || msgId === '0') return { dropped: 'no-message-id' }

  const timeSec = Number.isFinite(Number(event.time)) ? Math.trunc(Number(event.time)) : Math.trunc(Date.now() / 1000)
  const realSeqRaw = event.real_seq != null ? event.real_seq : null
  const realSeqNum = realSeqRaw == null ? NaN : Number(realSeqRaw)
  const realSeq = Number.isFinite(realSeqNum) ? Math.trunc(realSeqNum) : null

  const message = event.message != null ? event.message : event.raw_message
  let text = ''
  if (Array.isArray(message)) text = renderSegments(message)
  else if (typeof message === 'string') text = message.trim()

  const segments = Array.isArray(event.message) ? event.message : []
  const senderName = String(sender.card || sender.nickname || senderId || '未知')

  return {
    record: {
      groupId,
      groupName: String(event.group_name || ''),
      msgId,
      realSeq,
      timeSec,
      senderId,
      senderName,
      role: String(sender.role || ''),
      text: text || '[空消息]',
      segmentTypes: segments.map((s) => (s && s.type ? String(s.type) : '')),
      rawMessage: typeof event.raw_message === 'string' ? event.raw_message : '',
      arrival,
    },
  }
}