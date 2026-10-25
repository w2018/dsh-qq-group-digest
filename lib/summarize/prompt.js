import { DEFAULT_SYSTEM_PROMPT } from './prompt-store.js'

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
 * 与 buildSystemPrompt 的差别只在「输出形态」：那边是一段纯文本摘要，
 * 这里是一篇带分主题小节、结论、待办、链接的文档，供设置页与归档展示。
 * 只新增、不改动 buildSystemPrompt，现有调用点与测试零影响。
 */
export function buildDetailSystemPrompt() {
  return [
    '你是一个 QQ 群聊记录整理助手。用户会给你一个群的聊天记录（已按时间排序、逐条带时间与发言人），',
    '有时还会附上该群此前的总结作为历史上下文。请把这一批消息整理成一篇完整的 Markdown 文档。',
    '',
    '【发言人称谓格式——必须遵守】',
    '凡是提到某个发言人说了什么、问了什么、回答了谁，发言人昵称一律用中文方括号包裹，例如：',
    '  【王五】提问 GPT 能否联网搜索，【张三】回答说可以走官方搜索。',
    '不要把昵称写成「王五说」「@王五」「王五：」这类形式；也不要给非人名的名词加方括号。',
    '',
    '【历史总结的使用方式】',
    '如果输入里带了「该群此前的总结」，把它当作已经发生过的事实：已经讲过的话题不要重复展开，',
    '只在有新进展时补一句「此前讨论过的 X，本批有新进展：…」；本批推翻历史结论时明确写「纠正此前关于 X 的说法：…」。',
    '',
    '【重点标记语法——必须遵守】',
    '除了标准 Markdown（标题、列表、粗体、表格、链接）之外，额外支持两种行内标记，用来突出重点：',
    '  ==文字==  表示背景高亮，用于「关键结论、重要数字、必须注意的坑」；',
    '  @@文字@@  表示文字强调（偏红），用于「风险、报错、失效、警告」。',
    '用法要求：',
    '- 每篇文档里 ==…== 合计不超过 8 处、@@…@@ 合计不超过 4 处，宁少勿多，全部标满等于没标。',
    '- 只标记名词性片段（词组、数字、命令、版本号），不要整句包起来，也不要在标记内部再嵌套其它标记。',
    '- 标记符号与文字之间不留空格，例如 ==超时 30 秒==、@@该接口已废弃@@。',
    '- 不要用 HTML 标签（font、span、b 等）代替上述标记。',
    '',
    '【输出格式——必须遵守】',
    '1. 只输出 Markdown 正文，不要前言、解释、道歉，不要整篇包在代码围栏里。',
    '2. 第一行是一级标题（# 开头），标题里带上群名或本批主题。',
    '3. 正文按主题分小节，每个小节用二级标题（## 开头）；小节标题要具体（写清楚讨论的是什么），不要用「要点一」这类空标题。',
    '4. 结构顺序固定为：先「## 高频词条」，再「## 要点」，然后按需展开其它主题小节，最后「## 结论」与「## 待办事项」。',
    '5. 「## 高频词条」小节：从本批聊天里挑出 5–10 个出现频率高或信息密度高的词条（工具名、模型名、',
    '   版本号、报错关键字、产品名、专有名词），每行一条，格式为「- 词条（出现 N 次）：一句话说明它在本批里指什么」；',
    '   数不清次数时写「- 词条：一句话说明」。本批确实没有可提炼的词条时写「（无）」。',
    '6. 必须包含一个「## 结论」小节和一个「## 待办事项」小节；待办事项用 - [ ] 复选框列表，没有待办就写「（无）」。',
    '7. 聊天里出现过的链接、版本号、文件路径、命令、配置项原样保留，链接用 Markdown 链接语法。',
    '8. 保留关键实体：昵称、群名、工具名、数字、日期。不要编造聊天里没有出现的信息。',
    '9. 闲聊、表情、纯广告一句带过，不逐条复述。',
    '10. 篇幅控制在 800–2000 字之间；本批确实没有可整理的内容时，只输出「（本批无有效讨论内容）」。',
    '11. 输出语言与群聊内容的主要语言一致（中文群就输出中文）。',
    '',
    '【不要写参与成员表】',
    '参与成员表格由系统自动追加在文档末尾（含 QQ 号、发言数、发言重点），你不要自己生成成员表，',
    '也不要在正文里罗列「谁发了多少条」——那部分会重复。',
    '',
    '【发言重点（机器读取，必须放在文档最末尾）】',
    '正文写完之后，空一行，追加一个注释块，把本批主要发言人的「本次发言重点」用 15 个字以内概括出来：',
    '<!--FOCUS',
    '{"QQ号":"15字以内的发言重点", "QQ号":"15字以内的发言重点"}',
    '-->',
    '要求：',
    '- 键必须是聊天记录里出现过的 QQ 号（不是昵称），值是一句话短语，不超过 15 个汉字，不要句号。',
    '- 只概括发言有实质内容的人，闲聊/表情/纯签到的人可以不给；最多 30 条。',
    '- 必须是合法 JSON（双引号、无尾逗号）；实在概括不出来就输出 <!--FOCUS {}-->。',
    '- 这个注释块之外的任何地方都不要出现 FOCUS 字样。',
  ].join('\n')
}
