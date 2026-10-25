import { DEFAULT_SYSTEM_PROMPT, getDetailSystemPrompt } from './prompt-store.js'

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
 *
 * 正文已抽到 prompt-store.js 的 DEFAULT_SYSTEM_PROMPT（单一真源，供设置页与网页端
 * 编辑/重置）。这里保留原导出签名，现有调用点与测试零改动。
 */
export function buildSystemPrompt() {
  return DEFAULT_SYSTEM_PROMPT
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

/**
 * 精细版（summary.aiDetail=true）的 system prompt：要求模型直接产出完整的 Markdown 文档。
 *
 * 正文已抽到 prompt-store.js 的 DEFAULT_DETAIL_SYSTEM_PROMPT（单一真源，供设置页与
 * 网页端按 kind=detail 编辑/重置）。这里保留原导出签名并支持 override，
 * 现有调用点与测试零改动。
 */
export function buildDetailSystemPrompt(override) {
  return getDetailSystemPrompt(override)
}
