import { formatClock, formatDate } from './prompt.js'

const MAX_MD = 20000
const EMPTY_TEXT = '（本批无有效讨论内容）'
const EMPTY_MEMBERS = '（未记录）'
const NO_VALUE = '—'
const TRUNCATED = '…(截断)'

/** 表格单元格里的竖线会把列切歪，必须转义。 */
function cell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function splitParagraphs(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

function timeRange(entry) {
  const first = Number(entry.firstSec) || Number(entry.at) || 0
  if (!first) return NO_VALUE
  const last = Number(entry.lastSec) || first
  return formatDate(first) + '–' + formatClock(last)
}

function statusText(entry, dryRun) {
  if (entry.ok === false) return '总结失败（降级为原始摘录）'
  if (dryRun) return '预演'
  return '成功'
}

function memberRows(participants) {
  const rows = ['| 成员 | QQ | 发言数 | 本次重点 |', '| :--- | :--- | ---: | :--- |']
  const list = Array.isArray(participants) ? participants : []
  if (list.length === 0) {
    rows.push('| ' + EMPTY_MEMBERS + ' | ' + NO_VALUE + ' | ' + NO_VALUE + ' | ' + NO_VALUE + ' |')
    return rows
  }
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const name = cell(p.name || p.id || '未知')
    const id = cell(p.id || NO_VALUE)
    const count = Math.max(0, Math.trunc(Number(p.count) || 0))
    const focus = cell(String(p.focus || '').trim() || NO_VALUE)
    rows.push('| ' + name + ' | ' + id + ' | ' + count + ' | ' + focus + ' |')
  }
  return rows
}

/**
 * 本地渲染精细版 Markdown（零 LLM 调用）。
 *
 * 输入是 processBundle 组装好的 entry；输出是给设置页/归档看的完整文档。
 * 任何字段缺失都按空处理，保证旧数据也能渲染出结构完整的文档。
 *
 * 注意：正文只有「本批主线 / 要点 / 投递状态」三节，**不含成员表**。
 * 成员表唯一来源是网页详情页的可滚动列表；导出 .md 时由调用方追加
 * renderMembersSection()，避免同一次总结里出现多份成员表。
 */
export function renderDetailedMarkdown(entry, options) {
  const opts = options || {}
  const item = entry && typeof entry === 'object' ? entry : {}
  const groupId = String(item.groupId || '')
  const rawName = String(item.groupName || '').trim()
  // 群名缺失或与群号相同时只显示一次，避免「# 123 · 123」这种重复标题。
  const groupName = rawName || groupId || '未知群'
  const titleParts = []
  if (groupId && rawName && rawName !== groupId) titleParts.push(groupId, rawName)
  else titleParts.push(groupName)
  const dryRun = opts.dryRun === true || item.dryRun === true
  const participants = Array.isArray(item.participants) ? item.participants : []
  const model = String(item.model || '')
  const count = Math.max(0, Math.trunc(Number(item.count) || 0))

  const paragraphs = splitParagraphs(item.text)
  const lead = paragraphs.length > 0 ? paragraphs[0] : EMPTY_TEXT
  const rest = paragraphs.length > 1 ? paragraphs.slice(1).join('\n\n') : '（无）'

  const meta = [timeRange(item), count + ' 条消息', participants.length + ' 位发言人']
  if (model) meta.push(model)

  const lines = []
  lines.push('# ' + titleParts.join(' · '))
  lines.push('')
  lines.push('> ' + meta.join(' · '))
  lines.push('')
  lines.push('## 一、本批主线')
  lines.push(lead)
  lines.push('')
  lines.push('## 二、要点')
  lines.push(rest)
  lines.push('')
  // 成员表不进正文：网页详情页有一份可滚动列表，导出时再由 renderMembersSection 追加。
  // 正文里再写一份会出现「同一批成员表出现两三次」的重复。
  lines.push('## 三、投递状态')
  lines.push('- 状态：' + statusText(item, dryRun))
  lines.push('- 投递成功：' + Math.max(0, Math.trunc(Number(item.delivered) || 0)) + ' 人 / 失败：' + Math.max(0, Math.trunc(Number(item.failed) || 0)) + ' 人')
  lines.push('- 批次：' + (String(item.batchId || '') || NO_VALUE))

  const out = lines.join('\n')
  const maxChars = Math.max(500, Math.trunc(Number(opts.maxChars) || MAX_MD))
  return out.length > maxChars ? out.slice(0, maxChars) + TRUNCATED : out
}

/**
 * 单独渲染「参与成员」小节。
 *
 * 用途：正文（entry.md）不存成员表，只有导出 .md 时才把这张表拼在每条总结之后，
 * 这样导出的文件仍然是自解释的完整文档，而网页详情页不会看到重复的两份。
 */
export function renderMembersSection(participants) {
  const lines = ['', '## 参与成员', '']
  for (const row of memberRows(participants)) lines.push(row)
  lines.push('')
  return lines.join('\n')
}

export { MAX_MD }
