import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * client.js 是浏览器半身（不是 ESM 模块），这里做的是**源码级结构断言**：
 * 它守的是 v0.5.0 那个「点插件一片空白」的回归 ——
 * SettingsPage 首帧 loading=true 会走提前 return，若某个 hook 写在这个 return 之后，
 * 首帧不调用、数据到位后才调用，React 会抛
 * 「Rendered more hooks than during the previous render」，整个面板渲染失败变空白。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')
const SRC = readFileSync(CLIENT, 'utf8')
const LINES = SRC.split(/\r?\n/)

/** React hook 调用（排除 xxx.useXxx 这类成员调用）。 */
const HOOK_CALL = /(?:^|[^.\w])(use[A-Z]\w*)\s*\(/

function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** 收集 4 空格缩进的顶层函数边界（组件、hook、工厂函数都在这一层）。 */
function topLevelFunctions() {
  const out = []
  for (let i = 0; i < LINES.length; i++) {
    if (/^ {4}(?:function [A-Za-z_$]\w*\s*\(|const [A-Za-z_$]\w* = function)/.test(LINES[i])) {
      const name =
        (LINES[i].match(/function ([A-Za-z_$]\w*)/) || LINES[i].match(/const ([A-Za-z_$]\w*) =/) || [])[1] || '?'
      out.push({ name, start: i })
    }
  }
  return out
}

/** 第一个提前 return 的行号（6 空格裸 return，或 6 空格 if 块内紧跟的 return）。 */
function firstEarlyReturn(start, end) {
  for (let i = start + 1; i < end; i++) {
    if (isCommentLine(LINES[i])) continue
    if (/^ {6}return\b/.test(LINES[i])) return i
    if (/^ {6}if \(/.test(LINES[i])) {
      for (let j = i + 1; j < Math.min(i + 4, end); j++) {
        if (/^ {8}return\b/.test(LINES[j])) return i
      }
    }
  }
  return Infinity
}

test('client.js 存在且能按 CommonJS 解析（node --check 之外的结构性检查）', () => {
  assert.ok(SRC.includes('__ModuleLoader__.load'), '缺少 DSH 客户端模块注册')
  assert.ok(SRC.includes("id: 'dsh-qq-group-digest'"), '模块 id 必须与 package.json 的 name 逐字一致')
})

test('所有组件 / hook 的 React hook 调用都在第一个提前 return 之前', () => {
  const fns = topLevelFunctions()
  assert.ok(fns.length > 5, '顶层函数数量异常，解析规则可能失效：' + fns.length)

  const bad = []
  for (let k = 0; k < fns.length; k++) {
    const { name, start } = fns[k]
    const end = k + 1 < fns.length ? fns[k + 1].start : LINES.length
    const ret = firstEarlyReturn(start, end)
    if (ret === Infinity) continue
    for (let i = start; i < end; i++) {
      if (isCommentLine(LINES[i])) continue
      if (!HOOK_CALL.test(LINES[i])) continue
      if (i > ret) bad.push(name + ':' + (i + 1) + ' ' + LINES[i].trim())
    }
  }
  assert.deepEqual(bad, [], '以下 hook 写在提前 return 之后，会让设置面板渲染崩溃：\n' + bad.join('\n'))
})

test('SettingsPage 的重连倒计时 hook 在 loading 早退之前', () => {
  const start = LINES.findIndex((l) => /^ {4}function SettingsPage\s*\(/.test(l))
  assert.ok(start > 0, '找不到 SettingsPage')
  // 注释里也写着这句代码，必须跳过注释行，否则会命中注释。
  const early = LINES.findIndex((l, i) => i > start && !isCommentLine(l) && /if \(loading \|\| !form\)/.test(l))
  assert.ok(early > start, '找不到 loading 早退分支')
  const tick = LINES.findIndex((l, i) => i > start && i < early && /useLinkTick\(/.test(l))
  assert.ok(tick > start && tick < early, 'useLinkTick 必须写在 loading 早退之前')
})

test('useLinkTick 只在 active 为真时挂定时器，卸载时清理', () => {
  const start = LINES.findIndex((l) => /^ {4}function useLinkTick\s*\(/.test(l))
  assert.ok(start > 0, '找不到 useLinkTick')
  const body = LINES.slice(start, start + 14).join('\n')
  assert.ok(/if \(!active\) return undefined/.test(body), 'inactive 时必须直接返回，不挂定时器')
  assert.ok(/setInterval/.test(body), '需要每秒重算剩余时间')
  assert.ok(/clearInterval\(timer\)/.test(body), '必须在 cleanup 里清理定时器')
})

test('linkBadgeOf 三态齐全且倒计时不为负', () => {
  const start = LINES.findIndex((l) => /^ {4}function linkBadgeOf\s*\(/.test(l))
  assert.ok(start > 0, '找不到 linkBadgeOf')
  const body = LINES.slice(start, start + 20).join('\n')
  assert.ok(body.includes('协议端已连接'), '缺「已连接」态')
  assert.ok(body.includes('秒后重连'), '缺倒计时文案')
  assert.ok(body.includes('正在重连'), '缺「正在重连…」态')
  assert.ok(body.includes('协议端未连接'), '缺「未连接」态')
  assert.ok(/left > 0/.test(body), '剩余秒数必须判断大于 0，否则会显示「0 秒后重连」')
})

test('两套提示词 tab 都在前端声明（kind 与后端 query 参数一致）', () => {
  const start = LINES.findIndex((l) => /const PROMPT_TABS = /.test(l))
  assert.ok(start > 0, '找不到 PROMPT_TABS')
  const body = LINES.slice(start, start + 14).join('\n')
  assert.ok(body.includes("'summary'"), '缺普通总结 tab')
  assert.ok(body.includes("'detail'"), '缺 AI 精细版 tab')
  assert.ok(SRC.includes("promptQuery"), '提示词请求必须带 kind 查询参数')
})
