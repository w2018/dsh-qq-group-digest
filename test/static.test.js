import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const STATIC = join(import.meta.dirname, '..', 'lib', 'http', 'static')

function read(name) {
  return readFileSync(join(STATIC, name), 'utf8')
}

/** 把 md.js 当浏览器脚本跑起来，拿到挂在 globalThis 上的 API。 */
function loadMd() {
  const src = read('md.js')
  const sandbox = {}
  const fn = new Function('globalThis', 'module', 'window', src + '\nreturn globalThis.mdjs')
  return fn(sandbox, undefined, sandbox)
}

// ── 文件齐不齐 ──────────────────────────────────────────────────

const PAGES = ['index.html', 'login.html', 'logs.html', 'summaries.html']

test('四个页面与 app.css / md.js 都存在且非空', () => {
  for (const name of [...PAGES, 'app.css', 'md.js']) {
    const st = statSync(join(STATIC, name))
    assert.ok(st.isFile(), name + ' 应该是文件')
    assert.ok(st.size > 0, name + ' 不应该为空')
  }
})

test('页面之间不共享内联样式表，统一引用 /app.css', () => {
  for (const name of PAGES) {
    const html = read(name)
    assert.match(html, /<link rel="stylesheet" href="\/app\.css">/, name + ' 缺 app.css 引用')
    assert.doesNotMatch(html, /<style[\s>]/, name + ' 不该内联 <style>')
  }
})

// ── 零外部依赖 ──────────────────────────────────────────────────

test('所有页面不引用任何外部 CDN / 网络资源', () => {
  for (const name of [...PAGES, 'app.css', 'md.js']) {
    const text = read(name)
    const external = [...text.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g)].map((m) => m[1])
    assert.deepEqual(external, [], name + ' 出现了外部资源：' + external.join(', '))
  }
})

test('md.js 不 import / require 任何第三方包', () => {
  const src = read('md.js')
  assert.doesNotMatch(src, /^\s*import\s/m)
  assert.doesNotMatch(src, /\brequire\(['"](?!\.)/)
})

// ── 公共约定 ────────────────────────────────────────────────────

test('页面声明中文与移动端 viewport', () => {
  for (const name of PAGES) {
    const html = read(name)
    assert.match(html, /<html lang="zh-CN">/, name + ' 缺 lang')
    assert.match(html, /<meta name="viewport"/, name + ' 缺 viewport')
    assert.match(html, /<meta charset="utf-8">/, name + ' 缺 charset')
  }
})

test('顶部导航在三个主页面之间互通', () => {
  for (const name of ['index.html', 'logs.html', 'summaries.html']) {
    const html = read(name)
    assert.match(html, /href="\/"/, name + ' 缺「配置」入口')
    assert.match(html, /href="\/logs"/, name + ' 缺「日志」入口')
    assert.match(html, /href="\/summaries"/, name + ' 缺「总结记录」入口')
    assert.match(html, /id="btn-logout"/, name + ' 缺退出登录')
  }
})

test('每个页面都处理 401 → 跳转 /login', () => {
  for (const name of ['index.html', 'logs.html', 'summaries.html']) {
    const html = read(name)
    assert.match(html, /401/, name + ' 没有 401 判断')
    assert.match(html, /location\.replace\('\/login'\)/, name + ' 没有跳转 /login')
  }
})

test('页面里的接口路径全部以 /api/ 开头', () => {
  for (const name of PAGES) {
    const html = read(name)
    // 抓 fetch('/x') 与 api('/x') 的第一段
    const paths = [...html.matchAll(/\b(?:fetch|api)\(\s*'([^']+)'/g)].map((m) => m[1])
    for (const p of paths) {
      assert.ok(p.startsWith('/api/'), name + ' 出现了非 /api 的请求：' + p)
    }
  }
})

test('页面里用到的元素 id 都在 HTML 中定义过', () => {
  for (const name of PAGES) {
    const html = read(name)
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
    const refs = new Set()
    for (const m of html.matchAll(/\$\('#([\w-]+)'\)/g)) refs.add(m[1])
    for (const m of html.matchAll(/getElementById\('([\w-]+)'\)/g)) refs.add(m[1])
    const missing = [...refs].filter((r) => !ids.has(r))
    assert.deepEqual(missing, [], name + ' 引用了不存在的 id：' + missing.join(', '))
  }
})

test('所有页面都有加载 / 空 / 失败三态文案', () => {
  const shared = read('app.css')
  assert.match(shared, /\.qd-state/, 'app.css 缺三态样式')
  assert.match(shared, /\.qd-spinner/, 'app.css 缺加载动画')
  for (const name of ['logs.html', 'summaries.html']) {
    const html = read(name)
    assert.match(html, /'loading'/, name + ' 缺加载态')
    assert.match(html, /'empty'/, name + ' 缺空态')
    assert.match(html, /'err'/, name + ' 缺失败态')
  }
})

// ── 样式 ────────────────────────────────────────────────────────

test('app.css 用 CSS 变量 + 深色模式 + 窄屏响应式', () => {
  const css = read('app.css')
  assert.match(css, /:root\s*\{/)
  assert.match(css, /--qd-bg:/)
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/)
  assert.match(css, /@media\s*\(max-width:\s*900px\)/)
})

test('app.css 里用到的每个 CSS 变量都有定义', () => {
  const css = read('app.css')
  const defined = new Set([...css.matchAll(/(--qd-[\w-]+)\s*:/g)].map((m) => m[1]))
  const used = new Set([...css.matchAll(/var\((--qd-[\w-]+)/g)].map((m) => m[1]))
  const missing = [...used].filter((v) => !defined.has(v))
  assert.deepEqual(missing, [], '未定义的变量：' + missing.join(', '))
})

test('app.css 的类名统一 qd- 前缀，不和 client.js 的 qqd- 撞车', () => {
  const css = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))
  const wrong = [...names].filter((n) => n.startsWith('qqd-'))
  assert.deepEqual(wrong, [], '不该出现 qqd- 前缀：' + wrong.join(', '))
})

// ── md.js ───────────────────────────────────────────────────────

test('md.js 挂出 renderMarkdown', () => {
  const md = loadMd()
  assert.equal(typeof md.renderMarkdown, 'function')
  assert.equal(typeof md.escapeHtml, 'function')
  assert.equal(typeof md.safeUrl, 'function')
})

test('md.js 渲染标题 / 列表 / 代码 / 表格', () => {
  const md = loadMd()
  assert.match(md.renderMarkdown('# 标题'), /<h1[^>]*>标题<\/h1>/)
  assert.match(md.renderMarkdown('## 二级'), /<h2[^>]*>二级<\/h2>/)
  assert.match(md.renderMarkdown('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/)
  assert.match(md.renderMarkdown('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/)
  assert.match(md.renderMarkdown('**粗**'), /<strong>粗<\/strong>/)
  assert.match(md.renderMarkdown('\x60code\x60'), /<code>code<\/code>/)
  assert.match(md.renderMarkdown('\x60\x60\x60js\nvar a = 1\n\x60\x60\x60'), /<pre><code class="language-js">/)
  const table = md.renderMarkdown('| a | b |\n| :--- | ---: |\n| 1 | 2 |')
  assert.match(table, /<table>/)
  assert.match(table, /<th[^>]*>a<\/th>/)
  assert.match(table, /text-align:right/)
})

test('md.js 先转义再渲染，脚本标签不会变成真标签', () => {
  const md = loadMd()
  const out = md.renderMarkdown('<script>alert(1)</script>')
  assert.doesNotMatch(out, /<script>/)
  assert.match(out, /&lt;script&gt;/)
  // 属性注入也挡掉
  const attr = md.renderMarkdown('[x](https://a.com/" onmouseover="alert(1))')
  assert.doesNotMatch(attr, /onmouseover="alert/)
})

test('md.js 的 safeUrl 挡掉 javascript: 与 data:', () => {
  const md = loadMd()
  assert.equal(md.safeUrl('javascript:alert(1)'), '')
  assert.equal(md.safeUrl('JaVaScRiPt:alert(1)'), '')
  assert.equal(md.safeUrl('data:text/html;base64,xxx'), '')
  assert.equal(md.safeUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(md.safeUrl('/logs'), '/logs')
  // 危险链接降级成纯文本，不生成 <a>
  const out = md.renderMarkdown('[点我](javascript:alert(1))')
  assert.doesNotMatch(out, /<a /)
  assert.match(out, /点我/)
})

test('md.js 对空输入与纯文本不抛错', () => {
  const md = loadMd()
  assert.equal(md.renderMarkdown(''), '')
  assert.equal(md.renderMarkdown(null), '')
  assert.match(md.renderMarkdown('普通一行'), /普通一行/)
})

// ── 登录页 ─────────────────────────────────────────────────────

test('login.html 走 /api/login 并提示锁定', () => {
  const html = read('login.html')
  assert.match(html, /\/api\/login/)
  assert.match(html, /id="token"/)
  assert.match(html, /id="submit"/)
  assert.match(html, /id="login-form"/)
  assert.match(html, /id="msg"/)
  assert.match(html, /锁定/)
})

// ── 配置页 ─────────────────────────────────────────────────────

test('index.html 有九张卡片且读 /api/settings', () => {
  const html = read('index.html')
  const cards = [...html.matchAll(/data-card="([\w-]+)"/g)].map((m) => m[1])
  const unique = [...new Set(cards)]
  assert.equal(unique.length, 9, '卡片数量应为 9，实际：' + unique.join(','))
  assert.match(html, /\/api\/settings/)
  assert.match(html, /method: 'POST'/)
})

test('index.html 的最近报告按群分块，不合并成一段', () => {
  const html = read('index.html')
  assert.match(html, /qd-report-block/)
  assert.match(html, /recent\.groups/)
  // 不能再用 join('、') 把群名拼成一串
  assert.doesNotMatch(html, /\.map\(function \(g\) \{ return g\.groupName \|\| g\.groupId \}\)\.join/)
})

test('index.html 群进度指示带 pending / threshold', () => {
  const html = read('index.html')
  assert.match(html, /g\.pending/)
  assert.match(html, /g\.threshold/)
  assert.match(html, /qd-progress-bar/)
})

// ── 日志页 ─────────────────────────────────────────────────────

test('logs.html 支持筛选、SSE 实时、导出与分页', () => {
  const html = read('logs.html')
  assert.match(html, /id="f-level"/)
  assert.match(html, /id="f-group"/)
  assert.match(html, /id="f-keyword"/)
  assert.match(html, /\/api\/logs\?/)
  assert.match(html, /new EventSource\('\/api\/logs\/stream/)
  assert.match(html, /\.jsonl/)
  assert.match(html, /var PAGE_SIZE = 500/)
})

// ── 总结记录页 ─────────────────────────────────────────────────

test('summaries.html 按群分组展示，每个群各自成篇', () => {
  const html = read('summaries.html')
  assert.match(html, /function groupLabel/)
  assert.match(html, /qd-sumgroup/)
  // 分组渲染要建 buckets，而不是把所有 item 平铺
  assert.match(html, /buckets\[gid\]/)
  // 群名与群号一起显示
  assert.match(html, /groupLabel\(item\.groupName, item\.groupId\)/)
})

test('summaries.html 详情只取单群单批，不做跨群拼接', () => {
  const html = read('summaries.html')
  assert.match(html, /'\/api\/summaries\/' \+ encodeURIComponent\(groupId\)/)
  assert.match(html, /item\.md/)
  // 不该出现把多个 md 拼起来的写法
  assert.doesNotMatch(html, /md\.join\(/)
})

test('summaries.html 顶部显示当前是 AI 精细还是本地渲染', () => {
  const html = read('summaries.html')
  assert.match(html, /id="sum-mode"/)
  assert.match(html, /summary\.aiDetail/)
  assert.match(html, /AI 精细总结/)
  assert.match(html, /本地渲染总结/)
})

test('summaries.html 有复制 / 下载 / 原始 / 上一条 / 下一条 / 窄屏返回', () => {
  const html = read('summaries.html')
  for (const id of ['btn-copy', 'btn-download', 'btn-raw', 'btn-prev', 'btn-next', 'btn-back']) {
    assert.match(html, new RegExp('id="' + id + '"'), '缺按钮 ' + id)
  }
  assert.match(html, /navigator\.clipboard/)
  assert.match(html, /text\/markdown/)
})

test('summaries.html 用 md.js 渲染，并对链接加 rel=noopener', () => {
  const html = read('summaries.html')
  assert.match(html, /<script src="\/md\.js"><\/script>/)
  assert.match(html, /window\.renderMarkdown/)
  assert.match(html, /noopener noreferrer/)
})

// ── 总结记录页：普通总结 / AI 精细版 内容视图切换 ─────────────

test('summaries.html 有「普通总结 / AI 精细版」两个 tab，默认选中普通总结', () => {
  const html = read('summaries.html')
  assert.match(html, /id="sum-tabs"/)
  assert.match(html, /id="tab-normal"[\s\S]{0,220}data-active="true"/)
  assert.match(html, /id="tab-detail"[\s\S]{0,220}data-active="false"/)
  assert.match(html, /kind: 'normal'/, 'state.kind 默认必须是 normal')
  // 复用现有的 .qd-tabs / .qd-tab 样式类，不新造一套 tab 组件
  assert.match(html, /class="qd-tabs"/)
  assert.match(html, /class="qd-tab"/)
})

test('summaries.html 切换 tab 只改视图状态，不跳转、不重新拉列表', () => {
  const html = read('summaries.html')
  assert.match(html, /function syncTabs/)
  assert.match(html, /function switchKind/)
  assert.match(html, /dataset\.active = on \? 'true' : 'false'/)
  assert.match(html, /setAttribute\('aria-selected'/)
  const body = html.slice(html.indexOf('function switchKind'))
  const seg = body.slice(0, body.indexOf(";['#tab-normal'"))
  assert.doesNotMatch(seg, /location\.(href|replace)/, '切换 tab 不能改路由')
  assert.doesNotMatch(seg, /loadList\(/, '切换 tab 不能重新请求列表')
})

test('summaries.html 两种内容取自同一条记录的不同字段，而不是两次请求', () => {
  const html = read('summaries.html')
  assert.match(html, /var detailMd = String\(item\.md \|\| ''\)/)
  assert.match(html, /var plainText = String\(item\.text \|\| ''\)/)
  assert.match(html, /function renderCurrent/)
  // 切换后只重渲染详情区
  assert.match(html, /if \(state\.currentDetail\) renderCurrent\(\)/)
})

test('summaries.html 某一项为空时只影响自己，给出占位并提示切到另一视图', () => {
  const html = read('summaries.html')
  assert.match(html, /只有普通总结正文/)
  assert.match(html, /没有单独保存普通总结正文/)
  assert.match(html, /这条记录的 AI 精细版正文为空/)
})

test('summaries.html 参与成员表只在 AI 精细版视图追加', () => {
  const html = read('summaries.html')
  assert.match(html, /if \(state\.kind === 'detail'\) renderParticipants\(view, item\.participants\)/)
})

test('summaries.html 的 tab 在窄屏下均分整行（响应式）', () => {
  const css = read('app.css')
  assert.match(css, /\.qd-sumtabs/)
  assert.match(css, /@media \(max-width: 900px\)[\s\S]{0,200}\.qd-sumtabs \.qd-tab \{ flex: 1 1 0/)
})

// ── 服务端静态路由约定 ─────────────────────────────────────────

test('server.js 的静态路由与本目录的文件一一对应', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'lib', 'http', 'server.js'), 'utf8')
  assert.match(server, /rel = '\/index\.html'/)
  assert.match(server, /rel = '\/login\.html'/)
  assert.match(server, /rel = '\/logs\.html'/)
  assert.match(server, /rel = '\/summaries\.html'/)
  // MIME 表要覆盖这三种扩展名，否则浏览器会按 octet-stream 下载
  assert.match(server, /'\.html': 'text\/html/)
  assert.match(server, /'\.css': 'text\/css/)
  assert.match(server, /'\.js': 'text\/javascript/)
})