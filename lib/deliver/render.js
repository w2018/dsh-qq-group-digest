import { formatClock } from '../summarize/prompt.js'

const TITLE_LINE = '每日群聊总结'

/**
 * 渲染「单个群」的一份报告。多群各自触发时每群单独成文，避免合并后超长被截断。
 *
 * entry: { groupId, groupName, ok, text, count, firstSec, lastSec, error, attempts, model }
 */
export function renderGroupReport(entry, options) {
  const opts = options || {}
  const g = entry || {}
  const nowSec = Math.trunc(Number(opts.now) || Date.now() / 1000)
  // 群名缺失时退回群号，绝不写「未命名群」：用户至少能认出是哪个群。
  const title = (g.groupName && String(g.groupName).trim()) || String(g.groupId || '未知群')
  const lines = []

  lines.push('【' + TITLE_LINE + '】')
  lines.push(title + '（群号 ' + g.groupId + '）')
  lines.push('生成时间：' + formatClock(nowSec) + '　本批 ' + (g.count || 0) + ' 条')
  if (g.firstSec && g.lastSec) {
    lines.push('消息时段：' + formatClock(g.firstSec) + ' - ' + formatClock(g.lastSec))
  }
  lines.push('')

  if (g.ok) {
    lines.push(String(g.text || '').trim())
  } else {
    lines.push('（本批总结失败：' + (g.error || '未知错误') + '，以下为原始摘录）')
    lines.push('')
    lines.push(String(g.text || '').trim() || '（无内容）')
  }

  lines.push('')
  lines.push('（本消息由 dsh-qq-group-digest 自动生成）')
  return lines.join('\n')
}

/**
 * 把多个群的总结结果组织成一条报告文本。
 *
 * 保留此函数供兼容与「合并视图」使用；实际投递已改为按群分别发送（见 renderGroupReport）。
 *
 * groups: [{ groupId, groupName, ok, text, count, firstSec, lastSec, error, attempts, model }]
 */
export function renderReport(groups, options) {
  const opts = options || {}
  const list = Array.isArray(groups) ? groups : []
  const lines = []
  const nowSec = Math.trunc(Number(opts.now) || Date.now() / 1000)

  lines.push('【' + TITLE_LINE + '】')
  lines.push('生成时间：' + formatClock(nowSec) + '　共 ' + list.length + ' 个群')
  lines.push('')

  list.forEach((g, index) => {
    const title = (g.groupName && String(g.groupName).trim()) || String(g.groupId || '未知群')
    lines.push('━━━━━━━━━━━━━━')
    lines.push((index + 1) + '. ' + title + '（群号 ' + g.groupId + '）')

    if (g.ok) {
      lines.push('本批消息：' + (g.count || 0) + ' 条' + (g.firstSec && g.lastSec ? '，时间 ' + formatClock(g.firstSec) + '-' + formatClock(g.lastSec) : ''))
      lines.push('')
      lines.push(String(g.text || '').trim())
    } else {
      lines.push('本批消息：' + (g.count || 0) + ' 条（总结失败：' + (g.error || '未知错误') + '）')
      lines.push('')
      lines.push(String(g.text || '').trim() || '（无内容）')
    }
    lines.push('')
  })

  lines.push('━━━━━━━━━━━━━━')
  lines.push('（本消息由 dsh-qq-group-digest 自动生成）')
  return lines.join('\n')
}
