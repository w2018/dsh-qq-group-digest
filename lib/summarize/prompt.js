function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

export function formatClock(sec) {
  const d = new Date(Number(sec) * 1000)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

export function formatDate(sec) {
  const d = new Date(Number(sec) * 1000)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + formatClock(sec)
}

/**
 * 群聊总结的 system prompt。
 *
 * 两个硬约束来自实际使用反馈：
 * 1. 发言者必须用【】包裹，读者扫读时能一眼分清「谁说的」和「说了什么」；
 * 2. 每次都会附带该群上一次的总结，模型必须把它当既成事实，避免重复叙述。
 */
export function buildSystemPrompt() {
  return [
    '你是一个 QQ 群聊记录摘要助手。用户会给你一个群的聊天记录（已按时间排序、逐条带时间与发言人），',
    '有时还会附上该群此前的总结作为历史上下文。请输出一段中文总结。',
    '',
    '【发言人称谓格式——必须遵守】',
    '凡是提到某个发言人说了什么、问了什么、回答了谁，发言人昵称一律用中文方括号包裹，例如：',
    '  【王五】提问 GPT 能否联网搜索，【张三】回答说可以走官方搜索。',
    '不要把昵称写成「王五说」「@王五」「王五：」这类形式；也不要给非人名的名词加方括号。',
    '',
    '【历史总结的使用方式】',
    '如果输入里带了「该群此前的总结」，它是同一个群更早一批消息的结论，请把它当作已经发生过的事实：',
    '1. 已经讲过的话题不要重复展开，只在有新进展时补一句「此前讨论过的 X，本批有新进展：…」；',
    '2. 本批如果推翻了历史结论，明确写「纠正此前关于 X 的说法：…」；',
    '3. 历史里出现过、本批仍在延续的关键实体（人名、工具名、项目名、待办），继续沿用，不要换称呼；',
    '4. 不要复述历史总结的原文，也不要写「与上次总结相同」这类空话。',
    '',
    '【输出格式】',
    '1. 只输出总结正文，不要前言、解释、道歉，不要 markdown 代码围栏，不要「以下是总结」这类引导语。',
    '2. 结构：先用一句话概括本批主线，再用 3-8 条要点列出关键信息（谁说了什么、结论、待办、待确认的问题）。',
    '3. 保留关键实体：昵称、群名、工具名、链接、数字、日期、版本号。不要编造未出现的信息。',
    '4. 闲聊、表情、纯广告一句带过，不逐条复述。',
    '5. 如果本批确实没有可总结的信息，只输出「本批次无有效讨论内容」。',
    '6. 输出语言与群聊内容的主要语言一致（中文群就输出中文）。',
    '7. 总长度控制在 600 字以内。',
  ].join('\n')
}

function renderHistory(history, options) {
  const opts = options || {}
  const maxChars = Math.max(200, Math.trunc(Number(opts.maxHistoryChars) || 2000))
  const list = Array.isArray(history) ? history : []
  if (list.length === 0) return []

  const blocks = []
  let used = 0
  // 从最新一条往回取，超预算就停：越近的历史越重要。
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const h = list[i]
    const head = '· ' + (h.firstSec ? formatDate(h.firstSec) : '更早') + '，' + (h.count || 0) + ' 条消息'
    const body = String(h.text || '').trim()
    const block = head + '\n' + body
    if (used + block.length > maxChars && blocks.length > 0) break
    used += block.length
    blocks.unshift(block)
  }
  if (blocks.length === 0) return []
  return ['【该群此前的总结（供参考，不要复述）】', blocks.join('\n\n'), '']
}

/**
 * 把一批记录渲染成模型输入。
 * 超长时从最早的消息开始丢弃，保留最近的消息（群聊总结更看重近期上下文）。
 */
export function buildUserPrompt(records, options) {
  const opts = options || {}
  const maxChars = Math.max(500, Math.trunc(Number(opts.maxInputChars) || 12000))
  const groupName = opts.groupName || ''
  const groupId = opts.groupId || ''
  const gaps = Array.isArray(opts.gaps) ? opts.gaps : []
  const dropped = Number(opts.dropped) || 0
  const list = Array.isArray(records) ? records : []
  const history = Array.isArray(opts.history) ? opts.history : []

  const header = []
  header.push('群名：' + (groupName || '(未获取)'))
  header.push('群号：' + groupId)
  if (list.length > 0) {
    header.push('时间范围：' + formatClock(list[0].timeSec) + ' - ' + formatClock(list[list.length - 1].timeSec))
  }
  header.push('消息条数：' + list.length)
  if (gaps.length > 0) {
    const text = gaps.map((g) => g[0] + '-' + g[1]).join('、')
    header.push('缺失序号：' + text + '（这些消息未收到，可能已撤回或推送丢失）')
  }
  header.push('')

  const historyLines = renderHistory(history, { maxHistoryChars: opts.maxHistoryChars })
  const rendered = list.map((r) => '[' + formatClock(r.timeSec) + '] ' + r.senderName + ': ' + r.text)
  const headerText = header.join('\n')
  const historyText = historyLines.length > 0 ? historyLines.join('\n') + '\n' : ''
  const budget = Math.max(200, maxChars - headerText.length - historyText.length)
  const lines = []
  let used = 0
  let cut = 0
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const line = rendered[i]
    const cost = line.length + 1
    if (used + cost > budget) {
      cut = i + 1
      break
    }
    used += cost
    lines.unshift(line)
  }
  if (cut + dropped > 0) {
    header.push('（注意：为控制长度，已省略最早 ' + (cut + dropped) + ' 条消息）')
  }
  return header.join('\n') + '\n' + historyText + '群聊记录如下：\n' + lines.join('\n')
}

/** 降级用：AI 失败时生成原始摘录文本。 */
export function buildFallbackText(records, options) {
  const opts = options || {}
  const list = Array.isArray(records) ? records : []
  const groupName = opts.groupName || ''
  const groupId = opts.groupId || ''
  const counters = new Map()
  for (const r of list) {
    const key = r.senderName || r.senderId || '未知'
    counters.set(key, (counters.get(key) || 0) + 1)
  }
  const top = [...counters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const tail = list.slice(-10).map((r) => '  ' + formatClock(r.timeSec) + ' 【' + r.senderName + '】：' + r.text)

  const lines = []
  lines.push('（AI 总结失败，以下为原始摘录）')
  lines.push('群名：' + (groupName || '(未获取)') + '　群号：' + groupId)
  if (list.length > 0) {
    lines.push('时间范围：' + formatClock(list[0].timeSec) + ' - ' + formatClock(list[list.length - 1].timeSec))
  }
  lines.push('消息条数：' + list.length)
  lines.push('发言统计：' + top.map(([name, n]) => '【' + name + '】' + n + ' 条').join(' / '))
  lines.push('最近 10 条：')
  lines.push(tail.join('\n'))
  if (opts.errorMessage) lines.push('失败原因：' + opts.errorMessage)
  return lines.join('\n')
}
