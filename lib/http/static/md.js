/**
 * md.js —— 极简 Markdown 渲染器（零依赖，浏览器端 <script src> 直接用）
 *
 * 设计原则：
 * 1. 先转义、后渲染。所有用户内容在进入标签拼装前都已经过 escapeHtml，
 *    只有本文件自己生成的标签会出现在输出里，因此不存在 XSS 注入面。
 * 2. 链接与图片额外做协议白名单（只放行 http/https/mailto 与相对路径），
 *    挡住 javascript: / data: 这类伪协议。
 * 3. 支持：h1-h6、粗体、斜体、删除线、行内代码、代码块、无序/有序列表、
 *    引用、表格、水平线、链接、图片、段落与硬换行。
 * 4. 不做 HTML 透传：原文里的 <div> 会被转义成 &lt;div&gt; 显示出来。
 *
 * 导出：window.renderMarkdown(text) → html
 */
(function (root) {
  'use strict'

  var TICK = String.fromCharCode(96)

  /** HTML 转义：& 必须先换，否则会把后面的转义结果再转一遍。 */
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /** 把 &amp; / &lt; 等实体还原，供 safeUrl 判断协议时使用。 */
  function unescapeEntities(text) {
    return String(text == null ? '' : text)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  }

  /** 链接/图片地址白名单：相对路径与 http(s)/mailto 放行，其余一律丢弃。 */
  function safeUrl(raw) {
    var url = String(raw == null ? '' : raw).trim()
    if (!url) return ''
    // 去掉可能夹在中间的控制字符，避免 java\nscript: 这类绕过。
    url = url.replace(/[\u0000-\u0020\u007f]+/g, '')
    if (/^(https?:|mailto:)/i.test(url)) return url
    if (/^\/\//.test(url)) return ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return ''
    return url
  }

  // ── 行内渲染 ────────────────────────────────────────────────

  /**
   * 行内元素渲染。顺序很重要：
   * 行内代码先摘出来占位，避免代码里的 * 和 [ 被当成语法。
   */
  function renderInline(text) {
    var stash = []
    var src = String(text == null ? '' : text)

    // 1) 行内代码，先替换成占位符
    var codeRe = new RegExp('(' + TICK + '+)([\\s\\S]*?)\\1', 'g')
    src = src.replace(codeRe, function (_all, _ticks, code) {
      var idx = stash.length
      stash.push('<code>' + escapeHtml(code.replace(/^ | $/g, '')) + '</code>')
      return '\u0000' + idx + '\u0000'
    })

    // 2) 先整体转义，之后的替换只处理纯文本里的语法标记
    var out = escapeHtml(src)

    // 3) 图片，必须在链接之前。URL 允许一层平衡括号（如 wiki 链接）。
    out = out.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (_all, alt, url, title) {
      var src2 = safeUrl(unescapeEntities(url))
      if (!src2) return alt
      var t = title ? ' title="' + escapeHtml(unescapeEntities(title)) + '"' : ''
      return '<img src="' + escapeHtml(src2) + '" alt="' + alt + '"' + t + '>'
    })

    // 4) 链接
    out = out.replace(/\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (_all, label, url, title) {
      var href = safeUrl(unescapeEntities(url))
      if (!href) return label
      var t = title ? ' title="' + escapeHtml(unescapeEntities(title)) + '"' : ''
      return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"' + t + '>' + label + '</a>'
    })

    // 5) 自动链接（转义后尖括号已变成 &lt; &gt;）
    out = out.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, function (_all, url) {
      var href = safeUrl(url)
      if (!href) return _all
      return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>'
    })

    // 6) 粗体
    out = out.replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, '<strong>$1</strong>')

    // 7) 斜体（负向断言避开已生成的标签与列表标记）
    out = out.replace(/(^|[^*\w])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![*\w])/g, '$1<em>$2</em>')
    out = out.replace(/(^|[^_\w])_([^\s_](?:[^_]*?[^\s_])?)_(?![_\w])/g, '$1<em>$2</em>')

    // 8) 删除线
    out = out.replace(/~~([^\s~](?:[\s\S]*?[^\s~])?)~~/g, '<del>$1</del>')

    // 8.1) 高亮 ==文本== → <mark>（背景色标记，标准 Markdown 没有）
    //      首尾不能是空白或 =，避免把 "a == b" 这类比较式误判成语法。
    out = out.replace(/==([^\s=](?:[\s\S]*?[^\s=])?)==/g, '<mark class="qd-md-mark">$1</mark>')

    // 8.2) 强调 @@文本@@ → <span class="qd-md-key">（强调色，通常偏红/橙）
    //      同样要求首尾非空白非 @；必须排在 == 之后，两者互不干扰。
    out = out.replace(/@@([^\s@](?:[\s\S]*?[^\s@])?)@@/g, '<span class="qd-md-key">$1</span>')

    // 9) 行尾两个空格 → 硬换行
    out = out.replace(/ {2,}\n/g, '<br>\n')

    // 10) 还原行内代码占位符
    out = out.replace(/\u0000(\d+)\u0000/g, function (_all, idx) {
      var got = stash[Number(idx)]
      return got == null ? '' : got
    })

    return out
  }

  // ── 块级渲染 ────────────────────────────────────────────────

  var RE_FENCE = new RegExp('^(\\s*)(' + TICK + '{3,}|~{3,})\\s*([^\\s' + TICK + ']*)\\s*$')
  var RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
  var RE_HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/
  var RE_QUOTE = /^\s{0,3}>\s?(.*)$/
  var RE_UL = /^(\s*)[-*+]\s+(.*)$/
  var RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
  var RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

  /** 拆表格行：去掉首尾竖线后按未转义的 | 切开。 */
  function splitRow(line) {
    var text = String(line || '').trim()
    if (text.charAt(0) === '|') text = text.slice(1)
    if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1)
    var cells = []
    var buf = ''
    var inCode = false
    for (var i = 0; i < text.length; i += 1) {
      var ch = text.charAt(i)
      // 行内代码里的竖线不是分隔符
      if (ch === TICK) {
        inCode = !inCode
        buf += ch
        continue
      }
      if (!inCode && ch === '\\' && text.charAt(i + 1) === '|') {
        buf += '|'
        i += 1
        continue
      }
      if (!inCode && ch === '|') {
        cells.push(buf.trim())
        buf = ''
        continue
      }
      buf += ch
    }
    cells.push(buf.trim())
    return cells
  }

  function alignOf(sepCell) {
    var s = String(sepCell || '').trim()
    var left = s.charAt(0) === ':'
    var right = s.charAt(s.length - 1) === ':'
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return ''
  }

  /**
   * 渲染 Markdown 源文本为 HTML。
   * @param {string} text
   * @returns {string}
   */
  function renderMarkdown(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
    var lines = src.split('\n')
    var out = []
    var i = 0

    while (i < lines.length) {
      var line = lines[i]

      if (!line.trim()) {
        i += 1
        continue
      }

      // 代码块
      var fence = RE_FENCE.exec(line)
      if (fence) {
        var marker = fence[2]
        var lang = fence[3] || ''
        var body = []
        i += 1
        while (i < lines.length) {
          var close = RE_FENCE.exec(lines[i])
          if (close && close[2].charAt(0) === marker.charAt(0) && close[2].length >= marker.length && !close[3]) {
            i += 1
            break
          }
          body.push(lines[i])
          i += 1
        }
        var cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : ''
        out.push('<pre><code' + cls + '>' + escapeHtml(body.join('\n')) + '</code></pre>')
        continue
      }

      // 水平线（必须在列表之前判断）
      if (RE_HR.test(line)) {
        out.push('<hr>')
        i += 1
        continue
      }

      // 标题
      var heading = RE_HEADING.exec(line)
      if (heading) {
        var level = heading[1].length
        var htext = heading[2].replace(/\s+#+\s*$/, '').trim()
        out.push('<h' + level + '>' + renderInline(htext) + '</h' + level + '>')
        i += 1
        continue
      }

      // 引用（连续行合并）
      if (RE_QUOTE.test(line)) {
        var quoted = []
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          quoted.push(RE_QUOTE.exec(lines[i])[1])
          i += 1
        }
        out.push('<blockquote>' + renderBlocks(quoted.join('\n')) + '</blockquote>')
        continue
      }

      // 表格：表头行 + 分隔行
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var head = splitRow(line)
        var sep = splitRow(lines[i + 1])
        if (head.length === sep.length && head.length > 0) {
          var aligns = sep.map(alignOf)
          var rows = []
          i += 2
          while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
            rows.push(splitRow(lines[i]))
            i += 1
          }
          var thtml = ['<table><thead><tr>']
          for (var c = 0; c < head.length; c += 1) {
            var a = aligns[c] ? ' style="text-align:' + aligns[c] + '"' : ''
            thtml.push('<th' + a + '>' + renderInline(head[c]) + '</th>')
          }
          thtml.push('</tr></thead>')
          if (rows.length > 0) {
            thtml.push('<tbody>')
            for (var r = 0; r < rows.length; r += 1) {
              thtml.push('<tr>')
              for (var k = 0; k < head.length; k += 1) {
                var av = aligns[k] ? ' style="text-align:' + aligns[k] + '"' : ''
                thtml.push('<td' + av + '>' + renderInline(rows[r][k] == null ? '' : rows[r][k]) + '</td>')
              }
              thtml.push('</tr>')
            }
            thtml.push('</tbody>')
          }
          thtml.push('</table>')
          out.push(thtml.join(''))
          continue
        }
      }

      // 列表
      if (RE_UL.test(line) || RE_OL.test(line)) {
        var consumed = renderList(lines, i)
        out.push(consumed.html)
        i = consumed.next
        continue
      }

      // 段落
      var para = [line]
      i += 1
      while (i < lines.length) {
        var cur = lines[i]
        if (!cur.trim()) break
        if (RE_FENCE.test(cur) || RE_HEADING.test(cur) || RE_HR.test(cur) || RE_QUOTE.test(cur)) break
        if (RE_UL.test(cur) || RE_OL.test(cur)) break
        if (cur.indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) break
        para.push(cur)
        i += 1
      }
      out.push('<p>' + renderInline(para.join('\n')) + '</p>')
    }

    return out.join('\n')
  }

  /** 引用块里递归渲染：单段时去掉多余的 <p> 包裹。 */
  function renderBlocks(text) {
    var html = renderMarkdown(text)
    var onlyP = /^<p>([\s\S]*)<\/p>$/.exec(html)
    return onlyP ? onlyP[1] : html
  }

  /**
   * 从第 start 行起渲染一个列表（含嵌套）。
   * 返回 { html, next }。
   */
  function renderList(lines, start) {
    var first = lines[start]
    var ordered = RE_OL.test(first) && !RE_UL.test(first)
    var m0 = ordered ? RE_OL.exec(first) : RE_UL.exec(first)
    var baseIndent = m0[1].length
    var items = []
    var i = start

    while (i < lines.length) {
      var line = lines[i]

      if (!line.trim()) {
        var ahead = i + 1
        while (ahead < lines.length && !lines[ahead].trim()) ahead += 1
        if (ahead >= lines.length) break
        var probe = RE_UL.exec(lines[ahead]) || RE_OL.exec(lines[ahead])
        if (!probe || probe[1].length < baseIndent) break
        i = ahead
        continue
      }

      // 只接受与当前列表同类型的标记，否则视为新列表（有序/无序切换）。
      var m = ordered ? RE_OL.exec(line) : RE_UL.exec(line)
      if (!m) {
        var alt = ordered ? RE_UL.exec(line) : RE_OL.exec(line)
        // 缩进处的「另一种列表」→ 真正的嵌套列表
        if (alt && alt[1].length > baseIndent && items.length > 0) {
          var altSub = renderList(lines, i)
          items[items.length - 1].push({ nested: altSub.html })
          i = altSub.next
          continue
        }
        if (items.length > 0 && /^\s{2,}/.test(line)) {
          // 缩进续行：并进上一项
          items[items.length - 1].push({ cont: line.replace(/^\s+/, '') })
          i += 1
          continue
        }
        break
      }

      var indent = m[1].length
      if (indent < baseIndent) break
      if (indent > baseIndent) {
        var sub = renderList(lines, i)
        if (items.length === 0) break
        items[items.length - 1].push({ nested: sub.html })
        i = sub.next
        continue
      }

      // RE_UL 的分组是 [indent, text]，RE_OL 是 [indent, num, text]，取值要分开。
      items.push([ordered ? m[3] : m[2]])
      i += 1
    }

    var tag = ordered ? 'ol' : 'ul'
    var html = ['<' + tag + '>']
    for (var n = 0; n < items.length; n += 1) {
      var parts = items[n]
      var bodyParts = []
      var subHtml = ''
      var contLines = []
      for (var p = 0; p < parts.length; p += 1) {
        if (parts[p] && typeof parts[p] === 'object' && parts[p].nested) subHtml += parts[p].nested
        else if (parts[p] && typeof parts[p] === 'object' && parts[p].cont !== undefined) contLines.push(parts[p].cont)
        else bodyParts.push(parts[p])
      }
      var inner = bodyParts.length > 0 ? renderInline(bodyParts.join('\n')) : ''
      if (contLines.length > 0) inner += renderInline(contLines.join('\n'))
      html.push('<li>' + inner + subHtml + '</li>')
    }
    html.push('</' + tag + '>')
    return { html: html.join(''), next: i }
  }

  /** 取纯文本（用于列表预览），渲染后剥标签。 */
  function toPlainText(text) {
    return unescapeEntities(renderMarkdown(text).replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
  }

  var api = {
    renderMarkdown: renderMarkdown,
    renderInline: renderInline,
    escapeHtml: escapeHtml,
    safeUrl: safeUrl,
    toPlainText: toPlainText,
  }

  if (typeof module === 'object' && module && module.exports) module.exports = api
  root.renderMarkdown = renderMarkdown
  root.mdjs = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
