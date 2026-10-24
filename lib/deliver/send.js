import { writeOutbox } from '../store/messages.js'
import { splitText, toTextSegments } from '../transport/action.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.trunc(ms))))

/**
 * 把报告发给所有配置的好友。
 * 单个好友失败重试 attempts 次；全部失败则写 outbox 文件兜底。
 * 返回 { delivered, failed, outboxFile, segments, dryRun }
 */
export async function deliverReport(actions, text, options) {
  const opts = options || {}
  const friends = Array.isArray(opts.friends) ? opts.friends : []
  const retry = opts.retry || { attempts: 3, backoffMs: 2000 }
  const attempts = Math.max(1, Math.trunc(Number(retry.attempts) || 3))
  const backoffMs = Math.max(0, Math.trunc(Number(retry.backoffMs) || 2000))
  const maxChars = Number(opts.maxCharsPerMessage) || 1800
  const intervalMs = Number(opts.sendIntervalMs) || 0
  const dryRun = opts.dryRun === true
  const outboxDir = opts.outboxDir || ''
  const logger = opts.logger || null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  const segments = splitText(text, maxChars)

  if (dryRun) {
    const file = outboxDir ? writeOutbox(outboxDir, 'dryrun-' + stamp + '.md', text) : ''
    if (logger) logger.info?.('[qq-digest] dryRun=true，报告已写入 ' + (file || '(未配置 outbox)'))
    return { delivered: [], failed: [], outboxFile: file, segments: segments.length, dryRun: true }
  }

  const delivered = []
  const failed = []

  for (const userId of friends) {
    const messageIds = []
    let ok = true
    let lastError = ''

    for (let i = 0; i < segments.length; i += 1) {
      const chunk = segments[i]
      let sent = false
      lastError = ''

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const res = await actions.sendPrivate(userId, toTextSegments(chunk))
          messageIds.push(res && res.messageId ? res.messageId : '')
          sent = true
          break
        } catch (error) {
          lastError = error && error.message ? error.message : String(error)
          if (logger) {
            logger.warn?.('[qq-digest] 发送给 ' + userId + ' 第 ' + (i + 1) + '/' + segments.length + ' 段第 ' + attempt + '/' + attempts + ' 次失败：' + lastError)
          }
          if (attempt < attempts) await sleep(backoffMs * attempt)
        }
      }

      if (!sent) {
        ok = false
        break
      }
      if (intervalMs > 0 && i < segments.length - 1) await sleep(intervalMs)
    }

    if (ok) delivered.push({ userId, segments: segments.length, messageIds })
    else failed.push({ userId, error: lastError || '发送失败' })
  }

  let outboxFile = ''
  if (failed.length > 0 && outboxDir) {
    outboxFile = writeOutbox(outboxDir, 'failed-' + stamp + '.md', text)
    if (logger) logger.warn?.('[qq-digest] 有 ' + failed.length + ' 个好友发送失败，报告已兜底写入 ' + outboxFile)
  }

  return { delivered, failed, outboxFile, segments: segments.length, dryRun: false }
}
