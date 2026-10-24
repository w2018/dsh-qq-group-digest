import { formatClock } from '../summarize/prompt.js'

const TITLE_LINE = '每日群聊总结'

/**
 * 把多个群的总结结果组织成一条报告文本。
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
    const title = (g.groupName && String(g.groupName).trim()) || '未命名群'
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
