import { writeOutbox } from '../store/messages.js'
import { splitText, toTextSegments } from '../transport/action.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.trunc(ms))))

/**
 * 把「一组文本」逐条发给所有配置的好友。
 *
 * 关键点：每一段文本都独立切分、独立成消息发送 —— 多个群的总结绝不合并在同一条 QQ 消息里，
 * 否则很容易撞上单条消息字数上限被截断。
 *
 * texts: [{ text, groupId, batchId }]
 * 返回 { delivered, failed, outboxFile, segments, dryRun, perGroup }
 */
export async function deliverReportList(actions, texts, options) {
  const opts = options || {}
  const items = (Array.isArray(texts) ? texts : []).filter((it) => it && String(it.text || '').trim())
  if (items.length === 0) {
    return { delivered: [], failed: [], outboxFile: '', segments: 0, dryRun: opts.dryRun === true, perGroup: [] }
  }

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

  // 每条文本各自切段，段数求和用于展示「一共发了几条消息」。
  const plans = items.map((it) => ({
    groupId: String(it.groupId || ''),
    batchId: String(it.batchId || ''),
    text: String(it.text),
    segments: splitText(String(it.text), maxChars),
  }))
  const totalSegments = plans.reduce((n, p) => n + p.segments.length, 0)

  if (dryRun) {
    let file = ''
    if (outboxDir) {
      // 多群时每群一个文件，方便单独查看；单群仍沿用原文件名。
      const files = []
      for (const p of plans) {
        const name = plans.length === 1
          ? 'dryrun-' + stamp + '.md'
          : 'dryrun-' + stamp + '-' + (p.groupId || 'unknown') + '.md'
        try {
          files.push(writeOutbox(outboxDir, name, p.text))
        } catch (error) {
          if (logger) logger.warn?.('[qq-digest] dryRun 写 outbox 失败：' + (error && error.message))
        }
      }
      file = files.filter(Boolean).join(', ')
    }
    if (logger) logger.info?.('[qq-digest] dryRun=true，' + plans.length + ' 个群的报告已写入 ' + (file || '(未配置 outbox)'))
    return {
      delivered: [],
      failed: [],
      outboxFile: file,
      segments: totalSegments,
      dryRun: true,
      perGroup: plans.map((p) => ({ groupId: p.groupId, batchId: p.batchId, segments: p.segments.length, ok: true })),
    }
  }

  const delivered = []
  const failed = []
  const perGroup = plans.map((p) => ({ groupId: p.groupId, batchId: p.batchId, segments: p.segments.length, ok: true, error: '' }))

  for (const userId of friends) {
    const messageIds = []

    // 每个群一份报告，逐份发送；一份失败不影响其它群继续发。
    for (let p = 0; p < plans.length; p += 1) {
      const plan = plans[p]
      const status = perGroup[p]
      let ok = true
      let lastError = ''

      for (let i = 0; i < plan.segments.length; i += 1) {
        const chunk = plan.segments[i]
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
              logger.warn?.('[qq-digest] 群 ' + (plan.groupId || '?') + ' 发给 ' + userId + ' 第 ' + (i + 1) + '/' + plan.segments.length + ' 段第 ' + attempt + '/' + attempts + ' 次失败：' + lastError)
            }
            if (attempt < attempts) await sleep(backoffMs * attempt)
          }
        }

        if (!sent) {
          ok = false
          break
        }
        if (intervalMs > 0 && (i < plan.segments.length - 1 || p < plans.length - 1)) await sleep(intervalMs)
      }

      if (!ok) {
        status.ok = false
        status.error = lastError || '发送失败'
      }
    }

    const bad = perGroup.filter((x) => !x.ok)
    if (bad.length === 0) {
      delivered.push({ userId, segments: totalSegments, messageIds })
    } else {
      failed.push({ userId, error: bad.map((x) => (x.groupId || '?') + ':' + x.error).join('; ') })
    }
  }

  let outboxFile = ''
  if (failed.length > 0 && outboxDir) {
    const files = []
    for (const p of plans) {
      const name = plans.length === 1
        ? 'failed-' + stamp + '.md'
        : 'failed-' + stamp + '-' + (p.groupId || 'unknown') + '.md'
      try {
        files.push(writeOutbox(outboxDir, name, p.text))
      } catch (error) {
        if (logger) logger.warn?.('[qq-digest] 写 outbox 失败：' + (error && error.message))
      }
    }
    outboxFile = files.filter(Boolean).join(', ')
    if (logger) logger.warn?.('[qq-digest] 有 ' + failed.length + ' 个好友发送失败，报告已兜底写入 ' + outboxFile)
  }

  return { delivered, failed, outboxFile, segments: totalSegments, dryRun: false, perGroup }
}

/**
 * 兼容旧调用：把整段文本当「一份报告」发出去。
 * 返回 { delivered, failed, outboxFile, segments, dryRun }
 */
export async function deliverReport(actions, text, options) {
  const res = await deliverReportList(actions, [{ text, groupId: '', batchId: '' }], options)
  return {
    delivered: res.delivered,
    failed: res.failed,
    outboxFile: res.outboxFile,
    segments: res.segments,
    dryRun: res.dryRun,
  }
}
