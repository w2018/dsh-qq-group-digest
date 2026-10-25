/**
 * NapCat action 语义封装。只做参数整形，不做业务判断。
 */
export function createActions(client) {
  return {
    async loginInfo() {
      return client.call('get_login_info', {})
    },
    async groupList() {
      const data = await client.call('get_group_list', {})
      return Array.isArray(data) ? data : []
    },
    async friendList() {
      const data = await client.call('get_friend_list', {})
      return Array.isArray(data) ? data : []
    },
    /** 群成员列表（用于按成员过滤的下拉）。 */
    async groupMemberList(groupId) {
      const data = await client.call('get_group_member_list', { group_id: String(groupId) })
      return Array.isArray(data) ? data : []
    },
    /**
     * 群信息。用于补群名：get_group_list 在部分协议端实现里很慢或缺失，
     * 而单群查询通常稳定可用。拿不到时由调用方忽略。
     */
    async groupInfo(groupId) {
      const data = await client.call('get_group_info', { group_id: String(groupId), no_cache: false })
      return data && typeof data === 'object' ? data : null
    },
    /**
     * 发送私聊消息。
     * segments 用 OneBot11 数组格式；返回 { message_id }。
     * NapCat 对不存在的好友/风控会给出非 0 retcode，由 client 转成 reject。
     */
    async sendPrivate(userId, segments) {
      const data = await client.call('send_private_msg', {
        user_id: String(userId),
        message: Array.isArray(segments) ? segments : [{ type: 'text', data: { text: String(segments == null ? '' : segments) } }],
      })
      return { messageId: data && data.message_id != null ? String(data.message_id) : '' }
    },
  }
}

/** 文本切段：优先按换行切，单段不超 maxChars，保留行完整性。 */
export function splitText(text, maxChars) {
  const limit = Math.max(20, Math.trunc(Number(maxChars) || 1800))
  const source = String(text == null ? '' : text)
  if (source.length <= limit) return [source]
  const out = []
  let current = ''
  for (const line of source.split('\n')) {
    if (current.length + line.length + 1 <= limit) {
      current = current ? current + '\n' + line : line
      continue
    }
    if (current) out.push(current)
    if (line.length <= limit) {
      current = line
      continue
    }
    // 单行超长：硬切
    let rest = line
    while (rest.length > limit) {
      out.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
    current = rest
  }
  if (current) out.push(current)
  return out
}

export function toTextSegments(text) {
  return [{ type: 'text', data: { text: String(text == null ? '' : text) } }]
}