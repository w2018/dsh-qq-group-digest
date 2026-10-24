
const fs = require('fs')
const clientSrc = fs.readFileSync('D:/Harness_Work/dsh-qq-group-digest/client.js', 'utf8')

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: 'Fragment',
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
}

const registered = []
const fakeSlots = {
  inject: (name, fn) => { fn() },
  register: (meta, component) => { registered.push({ meta, component }); return meta },
}

let loaded = null
const fakeWindow = { __ModuleLoader__: { load: (def) => { loaded = def } } }
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ setAttribute: () => {}, textContent: '' }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
}

const fn = new Function('window', 'document', 'require', clientSrc)
fn(fakeWindow, fakeDocument, (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

const results = []
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail: detail === undefined ? '' : String(detail) })
}

check('调用 __ModuleLoader__.load', loaded !== null)
check('模块 id 与包名一致', loaded && loaded.id === 'dsh-qq-group-digest', loaded && loaded.id)
check('factory 是函数', loaded && typeof loaded.factory === 'function')
if (!loaded || typeof loaded.factory !== 'function') {
  for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name)
  process.exit(1)
}

const mod = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require in factory: ' + name)
})

check('factory 返回 exports', mod && typeof mod === 'object')
check('导出 apply', typeof mod.apply === 'function')
check('导出 inject 数组', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('inject 含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))

mod.apply({ get: (n) => (n === 'slots' ? fakeSlots : undefined) })

check('注册到 settings.section', registered.length === 1 && registered[0].meta.name === 'settings.section',
  registered.length === 1 ? registered[0].meta.name : 'count=' + registered.length)
const meta = registered.length === 1 ? registered[0].meta : {}
check('id 正确', meta.id === 'dsh-qq-group-digest', meta.id)
check('order 是数字', typeof meta.order === 'number', meta.order)
check('label 是函数', typeof meta.label === 'function')
check('label() 返回「QQ 群总结」', typeof meta.label === 'function' && meta.label() === 'QQ 群总结',
  typeof meta.label === 'function' ? meta.label() : '')
check('注册了组件', registered.length === 1 && (typeof registered[0].component === 'function' || typeof registered[0].component === 'object'))
check('导出 SettingsPage', typeof mod.SettingsPage === 'function')

let threw = null
const regBefore = registered.length
try { mod.apply({ get: () => undefined }) } catch (e) { threw = e }
check('缺 slots 服务时不抛异常', threw === null, threw && threw.message)
check('缺 slots 服务时不注册', registered.length === regBefore, 'count=' + registered.length)

// 样式归属标记：data-plugin 必须写，否则 DSH 的 claimStyles 会算错插件。
check('源码含 data-plugin 归属标记', clientSrc.includes('data-plugin'))
check('API 前缀为 /api/qq-digest', clientSrc.includes("'/api/qq-digest'"))

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
process.exitCode = failed.length === 0 ? 0 : 1
