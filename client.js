/**
 * dsh-qq-group-digest —— Client 半身（浏览器 bundle）
 *
 * 落点：设置页里的独立分区 settings.section（id = dsh-qq-group-digest）。
 *   DSH 的「设置」左侧导航会多出一项「QQ 群总结」，点进去就是本面板。
 *
 * 模块 id 必须与 package.json 的 name 逐字一致 —— DSH 的客户端模块加载器
 * （@deepseek-ai/dsh-client-modules）按模块图里的 row.id 取这个 bundle。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-group-digest',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const PLUGIN_ID = 'dsh-qq-group-digest'
    const SLOT_SETTINGS = 'settings.section'
    const SLOT_MAIN = 'main'
    const SLOT_SIDEBAR_PANEL = 'sidebar.panellist'
    const SLOT_SIDEBAR_FOOTER = 'sidebar.footer.action'
    const API = '/api/qq-digest'
    // 与 index.js 的 BACKEND_VERSION 保持一致：不一致说明后端仍是旧代码，需要重启一次 DSH。
    const EXPECTED_BACKEND_VERSION = 4

    /** 样式必须带 data-plugin 归属标记，否则 DSH 的 claimStyles 会算到别的插件头上。 */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]')) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PLUGIN_ID)
      style.textContent = [
        '.qqd-root { display: flex; flex-direction: column; gap: 18px; font-size: 13px; max-width: 860px; }',
        '.qqd-head { display: flex; flex-direction: column; gap: 4px; }',
        '.qqd-title { font-size: 16px; font-weight: 600; }',
        '.qqd-sub { font-size: 12px; opacity: .6; line-height: 1.6; }',
        '.qqd-card { border: 1px solid rgba(127,127,127,0.22); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }',
        '.qqd-card-title { font-size: 13px; font-weight: 600; opacity: .9; display: flex; align-items: center; gap: 8px; }',
        '.qqd-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 5px; font-size: 11px; line-height: 1; background: rgba(127,127,127,0.16); font-weight: 400; }',
        '.qqd-badge[data-kind="ok"] { color: #2e7d32; background: rgba(46,125,50,0.14); }',
        '.qqd-badge[data-kind="off"] { color: #c62828; background: rgba(198,40,40,0.14); }',
        '.qqd-badge[data-kind="warn"] { color: #c77c00; background: rgba(199,124,0,0.14); }',
        '.qqd-row { display: grid; grid-template-columns: 200px 1fr; gap: 10px 14px; align-items: center; }',
        '.qqd-row > .qqd-label { font-size: 12.5px; opacity: .8; }',
        '.qqd-hint { font-size: 11.5px; opacity: .55; line-height: 1.55; grid-column: 1 / -1; margin-top: -4px; }',
        '.qqd-input, .qqd-select { width: 100%; height: 32px; padding: 0 9px; box-sizing: border-box; border-radius: 8px; font: inherit; font-size: 12.5px; color: inherit; background: rgba(127,127,127,0.06); border: 1px solid rgba(127,127,127,0.28); }',
        '.qqd-input:focus, .qqd-select:focus { outline: none; border-color: rgba(127,127,127,0.55); }',
        '.qqd-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
        '.qqd-chips { display: flex; flex-wrap: wrap; gap: 6px; }',
        '.qqd-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px 0 10px; border-radius: 999px; font-size: 12px; background: rgba(127,127,127,0.12); border: 1px solid rgba(127,127,127,0.2); }',
        '.qqd-chip button { border: none; background: transparent; color: inherit; cursor: pointer; opacity: .55; font-size: 13px; line-height: 1; padding: 0 3px; }',
        '.qqd-chip button:hover { opacity: 1; }',
        '.qqd-btn { height: 28px; padding: 0 12px; border-radius: 8px; font-size: 12.5px; cursor: pointer; border: 1px solid rgba(127,127,127,0.4); background: transparent; color: inherit; }',
        '.qqd-btn:hover:not(:disabled) { background: rgba(127,127,127,0.1); }',
        '.qqd-btn:disabled { opacity: .45; cursor: default; }',
        '.qqd-btn[data-variant="primary"] { border-color: transparent; background: rgba(64,132,255,0.9); color: #fff; }',
        '.qqd-btn[data-variant="primary"]:hover:not(:disabled) { background: rgba(64,132,255,1); }',
        '.qqd-btn[data-variant="danger"] { border-color: rgba(198,40,40,0.5); color: #c62828; }',
        '.qqd-tip { font-size: 12px; line-height: 1.5; padding: 7px 10px; border-radius: 8px; background: rgba(127,127,127,0.08); }',
        '.qqd-tip[data-kind="error"] { color: #c62828; background: rgba(198,40,40,0.1); }',
        '.qqd-tip[data-kind="ok"] { color: #2e7d32; background: rgba(46,125,50,0.1); }',
        '.qqd-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 4px; }',
        '.qqd-pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; max-height: 220px; overflow: auto; padding: 10px; border-radius: 8px; background: rgba(127,127,127,0.07); font-family: ui-monospace, Consolas, monospace; }',
        '.qqd-note { font-size: 11.5px; opacity: .5; line-height: 1.6; }',
  '.qqd-member-box { width: 100%; max-height: 180px; overflow-y: auto; border: 1px solid var(--dsh-border, rgba(128,128,128,.25)); border-radius: 8px; box-sizing: border-box; }',
  '.qqd-member-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 0 10px; height: 28px; box-sizing: border-box; border: 0; background: transparent; color: inherit; font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }',
  '.qqd-member-row:hover { background: rgba(128,128,128,.12); }',
  '.qqd-member-row + .qqd-member-row { border-top: 1px solid rgba(128,128,128,.12); }',
  '.qqd-member-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.qqd-member-id { opacity: .55; font-variant-numeric: tabular-nums; flex: none; }',
  '.qqd-member-empty { padding: 10px; font-size: 11.5px; opacity: .5; }',
        '.qqd-card-title[data-clickable="true"] { cursor: pointer; user-select: none; }',
        '.qqd-card-title[data-clickable="true"]:hover { opacity: 1; }',
        '.qqd-caret { display: inline-block; width: 11px; font-size: 10px; opacity: .55; }',
        '.qqd-grow { flex: 1 1 auto; }',
        '.qqd-chip-progress { font-variant-numeric: tabular-nums; opacity: .9; }',
        '.qqd-panel { height: 100%; overflow: auto; padding: 18px 22px 28px; box-sizing: border-box; }',
        '.qqd-sidenav-icon { display: block; }',
        '.qqd-textarea { width: 100%; min-height: 320px; padding: 10px; box-sizing: border-box; border-radius: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.65; color: inherit; background: rgba(127,127,127,0.06); border: 1px solid rgba(127,127,127,0.28); resize: vertical; }',
        '.qqd-textarea:focus { outline: none; border-color: rgba(127,127,127,0.55); }',
        '.qqd-mono { font-family: ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }',
        '.qqd-token { flex: 1 1 220px; min-width: 160px; height: 32px; padding: 0 9px; box-sizing: border-box; border-radius: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: inherit; background: rgba(127,127,127,0.06); border: 1px solid rgba(127,127,127,0.2); }',
        '.qqd-counter { font-size: 11.5px; opacity: .6; font-variant-numeric: tabular-nums; }',
        '.qqd-counter[data-kind="over"] { color: #c62828; opacity: 1; }',
      ].join('\n')
      document.head.appendChild(style)
    }

    async function api(pathname, options) {
      const res = await fetch(API + pathname, options)
      const data = await res.json().catch(function () { return {} })
      if (!res.ok || data.ok === false) {
        const err = new Error((data && data.error) || ('HTTP ' + res.status))
        err.payload = data
        throw err
      }
      return data
    }

    function postJson(pathname, body) {
      return api(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    function Field(props) {
      return h(
        'div',
        { className: 'qqd-row' },
        h('div', { className: 'qqd-label' }, props.label),
        props.children,
        props.hint ? h('div', { className: 'qqd-hint' }, props.hint) : null,
      )
    }

    function NumInput(props) {
      return h('input', {
        className: 'qqd-input',
        type: 'number',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        min: props.min,
        max: props.max,
        step: props.step || 1,
        onChange: function (e) {
          const raw = e.target.value
          props.onChange(raw === '' ? '' : Number(raw))
        },
      })
    }

    function TextInput(props) {
      return h('input', {
        className: 'qqd-input',
        type: props.type || 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        spellCheck: false,
        onChange: function (e) { props.onChange(e.target.value) },
      })
    }

    function Check(props) {
      return h('label', { className: 'qqd-inline', style: { cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: function (e) { props.onChange(e.target.checked) },
        }),
        h('span', { style: { fontSize: 12.5, opacity: 0.8 } }, props.label),
      )
    }

    /**
     * 可折叠卡片。默认折叠（defaultOpen=false），只有「运行状态」「最近一次报告」
     * 传 defaultOpen，其余设置项收起，避免一屏塞满。
     */
    function Card(props) {
      const open = props.open
      const onToggle = props.onToggle
      const collapsible = typeof onToggle === 'function'
      const title = h('div', {
        className: 'qqd-card-title' + (collapsible ? '' : ''),
        'data-clickable': collapsible ? 'true' : 'false',
        onClick: collapsible ? onToggle : undefined,
        role: collapsible ? 'button' : undefined,
        tabIndex: collapsible ? 0 : undefined,
        onKeyDown: collapsible
          ? function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggle()
              }
            }
          : undefined,
      },
        collapsible ? h('span', { className: 'qqd-caret' }, open ? '▾' : '▸') : null,
        h('span', null, props.title),
        h('span', { className: 'qqd-grow' }),
        props.badges || null,
      )
      return h('div', { className: 'qqd-card' },
        title,
        !collapsible || open ? props.children : null,
      )
    }

    /** 群号 / QQ 号列表编辑器：芯片 + 输入框 + 可选下拉。 */
    function IdListEditor(props) {
      const [draft, setDraft] = useState('')
      const items = Array.isArray(props.value) ? props.value : []
      const options = Array.isArray(props.options) ? props.options : []

      const add = function (value) {
        const s = String(value == null ? '' : value).trim()
        if (!s || items.indexOf(s) >= 0) return
        props.onChange(items.concat([s]))
      }
      const remove = function (value) {
        props.onChange(items.filter(function (x) { return x !== value }))
      }
      const labelOf = function (id) {
        const hit = options.find(function (o) { return String(o.value) === String(id) })
        return hit ? hit.label : ''
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        items.length > 0
          ? h('div', { className: 'qqd-chips' },
              items.map(function (id) {
                const sub = labelOf(id)
                const prog = typeof props.progressOf === 'function' ? props.progressOf(id) : null
                return h('span', { className: 'qqd-chip', key: id },
                  prog
                    ? h('span', {
                        className: 'qqd-chip-progress',
                        title: '本群当前累计 ' + prog.pending + ' 条，达到 ' + prog.threshold + ' 条触发总结',
                      }, '[' + prog.pending + '/' + prog.threshold + ']')
                    : null,
                  h('span', null, sub ? sub + '（' + id + '）' : id),
                  h('button', {
                    type: 'button',
                    title: '移除',
                    onClick: function () { remove(id) },
                  }, '×'),
                )
              }),
            )
          : h('div', { className: 'qqd-note' }, props.emptyText || '尚未添加'),
        h('div', { className: 'qqd-inline' },
          h('input', {
            className: 'qqd-input',
            style: { flex: '1 1 160px', minWidth: 140 },
            value: draft,
            placeholder: props.placeholder || '输入数字后回车或点添加',
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) {
              if (e.key === 'Enter') {
                e.preventDefault()
                add(draft)
                setDraft('')
              }
            },
          }),
          h('button', {
            className: 'qqd-btn',
            type: 'button',
            onClick: function () { add(draft); setDraft('') },
          }, '添加'),
          options.length > 0
            ? h('select', {
                className: 'qqd-select',
                style: { flex: '0 1 220px', minWidth: 160 },
                value: '',
                onChange: function (e) {
                  if (e.target.value) add(e.target.value)
                  e.target.value = ''
                },
              },
                h('option', { value: '' }, props.selectLabel || '从列表选择…'),
                options
                  .filter(function (o) { return items.indexOf(String(o.value)) < 0 })
                  .map(function (o) {
                    return h('option', { key: String(o.value), value: String(o.value) }, o.label + '（' + o.value + '）')
                  }),
              )
            : null,
        ),
      )
    }

    /** 信息过滤·按成员排除编辑器：选群 → 搜索并挑选成员 → 芯片展示每个群的排除名单。 */
    function MemberFilterEditor(props) {
      const [pickGroup, setPickGroup] = useState('')
      const [members, setMembers] = useState({ available: [], error: '', loading: false })
      const [query, setQuery] = useState('')
      const [draft, setDraft] = useState('')
      const map = props.value && typeof props.value === 'object' ? props.value : {}
      const listening = Array.isArray(props.listening) ? props.listening : []
      const groupNames = props.groupNames || {}

      const loadMembers = useCallback(function (gid) {
        if (!gid) return
        setMembers(function (prev) { return Object.assign({}, prev, { loading: true, error: '' }) })
        api('/members?groupId=' + encodeURIComponent(gid))
          .then(function (d) {
            setMembers({ available: d.available || [], error: d.error || '', loading: false })
          })
          .catch(function (e) {
            const raw = e && e.message ? e.message : String(e)
            // unknown route 只会在「后端还是旧代码」时出现：/members 路由随插件一起载入，改后端必须重启 DSH。
            const msg = /unknown route/i.test(raw)
              ? '接口未注册（后端仍是旧代码），请重启一次 DSH 后再试'
              : raw
            setMembers({ available: [], error: msg, loading: false })
          })
      }, [])

      const labelOf = function (gid) {
        return groupNames[gid] || gid
      }
      const addMember = function (gid, userId) {
        if (!gid || !userId) return
        const list = Array.isArray(map[gid]) ? map[gid] : []
        const s = String(userId)
        if (list.indexOf(s) >= 0) return
        const next = Object.assign({}, map)
        next[gid] = list.concat([s])
        props.onChange(next)
      }
      const removeMember = function (gid, userId) {
        const list = Array.isArray(map[gid]) ? map[gid] : []
        const next = list.filter(function (x) { return x !== userId })
        const out = Object.assign({}, map)
        if (next.length > 0) out[gid] = next
        else delete out[gid]
        props.onChange(out)
      }

      const filtered = members.available.filter(function (m) {
        if (!query) return true
        const q = query.toLowerCase()
        return m.userId.indexOf(q) >= 0 || (m.nickname || '').toLowerCase().indexOf(q) >= 0 || (m.card || '').toLowerCase().indexOf(q) >= 0
      })

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        Object.keys(map).length > 0
          ? h('div', { className: 'qqd-chips' },
              Object.keys(map).sort().map(function (gid) {
                return (map[gid] || []).map(function (uid) {
                  return h('span', { className: 'qqd-chip', key: gid + ':' + uid },
                    h('span', null, labelOf(gid) + ' · ' + uid),
                    h('button', { type: 'button', title: '移除', onClick: function () { removeMember(gid, uid) } }, '×'),
                  )
                })
              }),
            )
          : h('div', { className: 'qqd-note' }, '未排除任何成员，全部发言计入总结'),
        h('div', { className: 'qqd-inline' },
          h('select', {
            className: 'qqd-select',
            style: { flex: '1 1 200px' },
            value: pickGroup,
            onChange: function (e) {
              const gid = e.target.value
              setPickGroup(gid)
              setMembers({ available: [], error: '', loading: false })
              setQuery('')
              if (gid) loadMembers(gid)
            },
          },
            h('option', { value: '' }, props.groupSelectLabel || '选择要配置的群…'),
            listening.map(function (gid) {
              return h('option', { key: gid, value: gid }, labelOf(gid))
            }),
          ),
        ),
        pickGroup
          ? (members.loading
              ? h('div', { className: 'qqd-note' }, '正在拉取成员列表…')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  members.error
                    ? h('div', { className: 'qqd-note' }, '拉取成员失败：' + members.error)
                    : null,
                  h('input', {
                    className: 'qqd-input',
                    placeholder: '快速搜索成员（昵称 / 群名片 / QQ 号）',
                    value: query,
                    onChange: function (e) { setQuery(e.target.value) },
                  }),
                  filtered.length > 500
                    ? h('div', { className: 'qqd-note' }, '共 ' + filtered.length + ' 人，仅显示前 500 个，可用上方搜索缩小范围')
                    : null,
                  filtered.length === 0
                    ? h('div', { className: 'qqd-member-empty' },
                        members.available.length === 0 ? '该群没有拉到成员数据' : '没有匹配「' + query + '」的成员')
                    : h('div', { className: 'qqd-member-box', role: 'listbox' },
                        filtered
                          .filter(function (m) { return (map[pickGroup] || []).indexOf(m.userId) < 0 })
                          .slice(0, 500)
                          .map(function (m) {
                            const name = m.card || m.nickname || m.userId
                            return h('button', {
                              className: 'qqd-member-row', type: 'button', key: m.userId, role: 'option',
                              title: '排除 ' + name + '（' + m.userId + '）',
                              onClick: function () { addMember(pickGroup, m.userId); setQuery('') },
                            },
                              h('span', { className: 'qqd-member-name' }, name),
                              h('span', { className: 'qqd-member-id' }, m.userId),
                            )
                          }),
                      ),
                ))
          : null,
        h('div', { className: 'qqd-inline' },
          h('input', {
            className: 'qqd-input',
            style: { flex: '1 1 160px', minWidth: 140 },
            value: draft,
            placeholder: '成员不在列表？直接输入 QQ 号',
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) {
              if (e.key === 'Enter') { e.preventDefault(); if (pickGroup) addMember(pickGroup, draft); setDraft('') }
            },
          }),
          h('button', {
            className: 'qqd-btn', type: 'button',
            disabled: !pickGroup,
            title: pickGroup ? '' : '请先在上面选择一个群',
            onClick: function () { addMember(pickGroup, draft); setDraft('') },
          }, '排除'),
        ),
      )
    }

    function SettingsPage() {
      const [loading, setLoading] = useState(true)
      const [saving, setSaving] = useState(false)
      const [busy, setBusy] = useState('')
      const [tip, setTip] = useState('')
      const [tipKind, setTipKind] = useState('ok')
      const [form, setForm] = useState(null)
      const [meta, setMeta] = useState(null)
      const [status, setStatus] = useState(null)
      const [models, setModels] = useState({ providers: [], current: null, error: '' })
      const [groups, setGroups] = useState({ available: [], error: '' })
      const [friends, setFriends] = useState({ available: [], error: '' })
      const [baseline, setBaseline] = useState('')
      const [dirty, setDirty] = useState(false)
      const [recent, setRecent] = useState([])
      const [live, setLive] = useState(null)
      // 提示词与网页服务的密钥不随 form 走：prompt.system 不在 settings 白名单里，
      // token 也绝不能出现在普通保存请求里。
      const [promptSystem, setPromptSystem] = useState('')
      const [promptBaseline, setPromptBaseline] = useState('')
      const [promptMeta, setPromptMeta] = useState({ defaultPrompt: '', maxChars: 20000, minChars: 10 })
      const [showDefault, setShowDefault] = useState(false)
      const [http, setHttp] = useState(null)
      const [plainToken, setPlainToken] = useState('')
      // 卡片折叠状态：只有「运行状态」「最近一次报告」默认展开。
      const [openCards, setOpenCards] = useState({ status: false, recent: true })
      const aliveRef = useRef(true)

      const toggleCard = useCallback(function (key) {
        setOpenCards(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = !next[key]
          return next
        })
      }, [])

      const flash = useCallback(function (message, kind) {
        setTip(message)
        setTipKind(kind || 'ok')
        if ((kind || 'ok') === 'ok') {
          setTimeout(function () { if (aliveRef.current) setTip('') }, 3000)
        }
      }, [])

      const patch = useCallback(function (path, value) {
        setForm(function (prev) {
          if (!prev) return prev
          const next = JSON.parse(JSON.stringify(prev))
          const parts = path.split('.')
          let cur = next
          for (let i = 0; i < parts.length - 1; i += 1) {
            if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
            cur = cur[parts[i]]
          }
          cur[parts[parts.length - 1]] = value
          setDirty(JSON.stringify(next) !== baseline)
          return next
        })
      }, [baseline])

      const loadPrompt = useCallback(async function () {
        try {
          const d = await api('/prompt')
          if (!aliveRef.current) return
          const system = typeof d.system === 'string' ? d.system : ''
          setPromptSystem(system)
          setPromptBaseline(system)
          setPromptMeta({
            defaultPrompt: typeof d.defaultPrompt === 'string' ? d.defaultPrompt : '',
            maxChars: Number(d.maxChars) || 20000,
            minChars: Number(d.minChars) || 10,
          })
        } catch (e) {
          // 后端还是旧代码（没有 /prompt）时静默降级：卡片会显示提示，不影响其它设置。
          if (aliveRef.current) setPromptMeta(function (prev) { return Object.assign({}, prev, { error: e.message || String(e) }) })
        }
      }, [])

      const loadHttp = useCallback(async function () {
        try {
          const d = await api('/http')
          if (!aliveRef.current) return
          setHttp(d)
          setPlainToken('')
        } catch (e) {
          if (aliveRef.current) setHttp({ ok: false, error: e.message || String(e) })
        }
      }, [])

      const loadAll = useCallback(async function () {
        try {
          const data = await api('/settings')
          if (!aliveRef.current) return
          setMeta(data)
          setStatus(data.status || null)
          setForm(data.settings)
          setBaseline(JSON.stringify(data.settings))
          setDirty(false)
          api('/models').then(function (d) { if (aliveRef.current) setModels(d) }).catch(function () {})
          api('/groups').then(function (d) { if (aliveRef.current) setGroups(d) }).catch(function () {})
          api('/friends').then(function (d) { if (aliveRef.current) setFriends(d) }).catch(function () {})
          api('/recent').then(function (d) { if (aliveRef.current) setRecent(d.recent || []) }).catch(function () {})
          api('/status').then(function (d) { if (aliveRef.current) setLive(d) }).catch(function () {})
          loadPrompt()
          loadHttp()
        } catch (error) {
          if (aliveRef.current) flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setLoading(false)
        }
      }, [flash])

      // 只在挂载时拉一次：放进依赖会因数组引用变化反复重置用户正在编辑的内容。
      useEffect(function () {
        aliveRef.current = true
        injectStyles()
        loadAll()
        return function () { aliveRef.current = false }
      }, [])

      const refreshStatus = useCallback(async function () {
        try {
          const d = await api('/status')
          if (!aliveRef.current) return
          setLive(d)
          setStatus({
            started: d.started,
            configErrors: d.configErrors,
            startError: d.startError,
            wsConnected: Boolean(d.ws && d.ws.connected),
          })
        } catch (e) { /* 状态面板不是关键路径 */ }
      }, [])

      const refreshRecent = useCallback(async function () {
        try {
          const d = await api('/recent')
          if (aliveRef.current) setRecent(d.recent || [])
        } catch (e) { /* 同上，静默 */ }
      }, [])

      // 轻量轮询：状态与最近报告 5s 刷新一次，避免「改完配置要切页才能看到」。
      // 只拉只读数据（status/recent），不拉 /settings，避免覆盖用户正在编辑的表单；
      // saving/busy 期间跳过，且用 ref 防止上一轮未完成时叠加请求。
      const pollBusyRef = useRef(false)
      useEffect(function () {
        const timer = setInterval(async function () {
          if (!aliveRef.current || pollBusyRef.current) return
          if (saving || busy) return
          pollBusyRef.current = true
          try {
            await refreshStatus()
            await refreshRecent()
          } finally {
            pollBusyRef.current = false
          }
        }, 5000)
        return function () { clearInterval(timer) }
      }, [saving, busy, refreshStatus, refreshRecent])

      const save = useCallback(async function () {
        if (!form) return
        setSaving(true)
        try {
          // 提示词走专用端点（prompt.system 不在 settings 白名单里）。
          // 它必须先成功：失败就直接中止，绝不报「已保存」这种假成功。
          if (promptSystem !== promptBaseline) {
            await postJson('/prompt', { system: promptSystem })
          }
          const res = await postJson('/settings', { settings: form })
          const dropped = res.droppedFields || []
          if (dropped.length > 0) {
            // 有字段被后端丢弃：绝不能报「已保存」，否则就是假成功。
            flash('部分字段未生效（后端不识别）：' + dropped.join('、') + '。请重启一次 DSH 后重试。', 'error')
          } else {
            flash('已保存并热重载，无需重启 DSH（第 ' + (res.restarts || 1) + ' 次应用）')
          }
          await loadAll()
          await refreshStatus()
        } catch (error) {
          flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setSaving(false)
        }
      }, [form, promptSystem, promptBaseline, flash, loadAll, refreshStatus])

      const reset = useCallback(async function () {
        if (!window.confirm('清空设置页保存的所有覆盖，回到 cordis.patch.yml 里的初始值？')) return
        setSaving(true)
        try {
          await postJson('/settings/reset', {})
          flash('已恢复为初始配置')
          await loadAll()
          await refreshStatus()
        } catch (error) {
          flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setSaving(false)
        }
      }, [flash, loadAll, refreshStatus])

      /** 热重载：重载插件运行态；若宿主能载入新代码，连 lib/ 的改动也一起生效。 */
      const runReload = useCallback(async function () {
        if (!window.confirm('重载插件运行态？正在累计但尚未总结的消息会保留。')) return
        setBusy('reload')
        try {
          const d = await postJson('/reload', {})
          const codeMsg = d.codeReloaded ? '（含代码热更新）' : '（运行态重载；新代码未载入：' + (d.generationError || '宿主限制') + '）'
          flash('已重载' + codeMsg + '，保留未总结消息 ' + (d.carried || 0) + ' 条')
          await loadAll()
          await refreshStatus()
        } catch (error) {
          flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [flash, loadAll, refreshStatus])

      const runFlush = useCallback(async function () {
        setBusy('flush')
        try {
          const d = await postJson('/flush', {})
          flash('已触发总结投递：成功 ' + (d.delivered || 0) + ' 人，失败 ' + (d.failed || 0) + ' 人，共 ' + (d.segments || 0) + ' 段')
          await loadAll()
        } catch (error) {
          flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [flash, loadAll])

      const runTest = useCallback(async function () {
        setBusy('test')
        try {
          const d = await postJson('/test', { text: '[qq-digest] 测试消息：设置页通道正常。' })
          const okList = (d.results || []).filter(function (r) { return r.ok }).map(function (r) { return r.userId })
          const failList = (d.results || []).filter(function (r) { return !r.ok })
          if (failList.length > 0) {
            flash('部分失败：' + failList.map(function (f) { return f.userId + '（' + f.error + '）' }).join('，'), 'error')
          } else {
            flash('测试消息已发送给：' + okList.join('，'))
          }
        } catch (error) {
          flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [flash])

      const promptDirty = promptSystem !== promptBaseline
      const anyDirty = dirty || promptDirty

      /** 恢复默认提示词：二次确认后调 /prompt/reset。 */
      const resetPrompt = useCallback(async function () {
        if (!window.confirm('恢复为内置默认提示词？当前自定义内容会被清空。')) return
        setBusy('prompt')
        try {
          const d = await postJson('/prompt/reset', {})
          flash('已恢复内置默认提示词')
          await loadPrompt()
          if (d && d.system) setPromptSystem(d.system)
        } catch (error) {
          flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [flash, loadPrompt])

      /** 重新生成网页服务密钥：明文只回这一次，提示用户立刻保存。 */
      const regenToken = useCallback(async function () {
        if (!window.confirm('重新生成网页服务的访问密钥？旧密钥立即失效，已登录的浏览器需要重新登录。')) return
        setBusy('token')
        try {
          const d = await postJson('/http/token', {})
          setPlainToken(d.token || '')
          setHttp(d)
          flash('已生成新密钥，请立即复制保存（离开本页后不再显示）')
        } catch (error) {
          flash(error.message || String(error), 'error')
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [flash])

      if (loading || !form) {
        return h('div', { className: 'qqd-root' },
          h('div', { className: 'qqd-head' },
            h('div', { className: 'qqd-title' }, 'QQ 群总结'),
            h('div', { className: 'qqd-sub' }, '加载中…'),
          ),
        )
      }

      const wsOk = Boolean(status && status.wsConnected)
      const errs = (status && status.configErrors) || []
      // 群号 → 群名映射：优先协议端群列表，退回运行态里已见过的群名。
      const groupMap = {}
      ;(groups.available || []).forEach(function (g) { groupMap[String(g.groupId)] = g.groupName || String(g.groupId) })
      const liveGroups = (live && live.pipeline && live.pipeline.groups) || []
      liveGroups.forEach(function (g) {
        const k = String(g.groupId)
        if (!groupMap[k] && g.groupName) groupMap[k] = g.groupName
      })
      const providerOpts = models.providers || []
      const currentProvider = (form.model && form.model.provider) || ''
      const modelOptions = (providerOpts.find(function (p) { return String(p.id) === String(currentProvider) }) || {}).models || []

      // 后端版本不一致 = 磁盘代码比运行中的进程新，新路由 / 新白名单还没生效。
      const staleBackend = meta && typeof meta.backendVersion === 'number'
        ? meta.backendVersion !== EXPECTED_BACKEND_VERSION
        : true

      return h('div', { className: 'qqd-root' },
        h('div', { className: 'qqd-head' },
          h('div', { className: 'qqd-title' }, 'QQ 群总结'),
          h('div', { className: 'qqd-sub' },
            '监听指定 QQ 群，按阈值批次调用 DSH 已配置的模型生成总结，按群组织后私聊推送给指定好友。此页保存后立即生效，不需要重启 DSH。',
          ),
        ),

        staleBackend
          ? h('div', { className: 'qqd-tip', 'data-kind': 'error' },
              '后端仍是旧代码（运行中的进程没载入最新的路由与字段白名单），新增设置项可能保存不生效或拉取失败。请重启一次 DSH。')
          : null,

        h(Card, {
          title: '运行状态',
          // 折叠时徽章仍然显示在标题行，一眼可见「已启动 / 协议端已连接」。
          badges: h('span', { className: 'qqd-inline' },
            h('span', { className: 'qqd-badge', 'data-kind': status && status.started ? 'ok' : 'off' },
              status && status.started ? '已启动' : '未启动'),
            h('span', { className: 'qqd-badge', 'data-kind': wsOk ? 'ok' : 'warn' },
              wsOk ? '协议端已连接' : '协议端未连接'),
          ),
          open: Boolean(openCards.status),
          onToggle: function () { toggleCard('status') },
        },
          errs.length > 0
            ? h('div', { className: 'qqd-tip', 'data-kind': 'error' }, '配置问题：' + errs.join('；'))
            : null,
          meta && meta.settingsFile
            ? h('div', { className: 'qqd-note' }, '覆盖设置文件：' + meta.settingsFile)
            : null,
          h('div', { className: 'qqd-actions' },
            h('button', { className: 'qqd-btn', type: 'button', onClick: refreshStatus }, '刷新状态'),
            h('button', {
              className: 'qqd-btn', type: 'button', disabled: busy === 'reload',
              title: '改了插件代码或想让配置彻底重建时点这里，不需要重启 DSH',
              onClick: runReload,
            }, busy === 'reload' ? '重载中…' : '热重载插件'),
            h('button', { className: 'qqd-btn', type: 'button', disabled: busy === 'flush', onClick: runFlush },
              busy === 'flush' ? '处理中…' : '立即总结并投递'),
            h('button', {
              className: 'qqd-btn', type: 'button', disabled: busy === 'test' || !wsOk,
              title: wsOk ? '' : '需要先连上 QQ 协议端（LuckyLilliaBot）',
              onClick: runTest,
            }, busy === 'test' ? '发送中…' : '发送测试消息'),
          ),
        ),

        h(Card, { title: '协议端连接', open: Boolean(openCards.napcat), onToggle: function () { toggleCard('napcat') } },
          h(Field, { label: 'WebSocket 地址', hint: '对应 LuckyLilliaBot 的 OneBot11 正向 WS host + port，例如 ws://127.0.0.1:3001' },
            h(TextInput, { value: form.napcat && form.napcat.wsUrl, onChange: function (v) { patch('napcat.wsUrl', v) } }),
          ),
          h(Field, {
            label: '访问令牌（Token）',
            hint: meta && meta.tokenSet ? '已保存。留空则沿用原令牌；改动后需与协议端的 token 完全一致。' : '与 LuckyLilliaBot 的 OneBot11 token 完全一致；无令牌则留空。',
          },
            h(TextInput, {
              value: form.napcat && form.napcat.token,
              placeholder: meta && meta.tokenSet ? '（已设置，留空不变）' : '未设置',
              onChange: function (v) { patch('napcat.token', v) },
            }),
          ),
        ),

        h(Card, {
          title: '监听的群',
          badges: h('span', { className: 'qqd-badge' }, '必填'),
          open: Boolean(openCards.groups),
          onToggle: function () { toggleCard('groups') },
        },
          h(IdListEditor, {
            value: form.listen && form.listen.groups,
            onChange: function (v) { patch('listen.groups', v) },
            // 每群进度 [已累计/阈值]：阈值优先取本群实际生效值（含 perGroupOverride）。
            progressOf: function (id) {
              const rows = (live && live.pipeline && live.pipeline.groups) || []
              const hit = rows.find(function (g) { return String(g.groupId) === String(id) })
              const fallbackThreshold = form && form.batch ? form.batch.threshold : null
              const threshold = hit && hit.threshold != null ? hit.threshold : fallbackThreshold
              const pending = hit && hit.pending != null ? hit.pending : 0
              if (threshold == null) return null
              return { pending: pending, threshold: threshold }
            },
            options: (groups.available || []).map(function (g) {
              return { value: g.groupId, label: g.groupName || g.groupId }
            }),
            selectLabel: wsOk ? '从协议端群列表选择…' : '（协议端未连接，无法拉取群列表）',
            emptyText: '尚未添加任何群，插件不会监听',
            placeholder: '输入群号后回车',
          }),
          groups.error ? h('div', { className: 'qqd-note' }, '拉取群列表失败：' + groups.error) : null,
          h(Field, { label: '忽略自己发的消息', hint: '开启后本账号自己的发言不计入总结批次。' },
            h(Check, {
              checked: form.listen && form.listen.ignoreSelf,
              label: '不计入自己的消息',
              onChange: function (v) { patch('listen.ignoreSelf', v) },
            }),
          ),
        ),

        h(Card, {
          title: '信息过滤',
          open: Boolean(openCards.filters),
          onToggle: function () { toggleCard('filters') },
        },
          h(Field, {
            label: '关键词过滤（模糊匹配）',
            hint: '消息文本包含任一关键词（不区分大小写）就被丢弃，不进入总结。回车或点添加。',
          },
            h(IdListEditor, {
              value: form.listen && form.listen.keywords,
              onChange: function (v) { patch('listen.keywords', v) },
              emptyText: '未设置关键词，不过滤',
              placeholder: '输入关键词后回车',
            }),
          ),
          h(Field, {
            label: '按成员排除（不总结这些人）',
            hint: '先选群拉成员列表，再搜索选择要排除的成员；他们的发言不计入总结批次。',
          },
            h(MemberFilterEditor, {
              value: form.listen && form.listen.excludedSenders,
              onChange: function (v) { patch('listen.excludedSenders', v) },
              listening: form.listen && form.listen.groups,
              groupNames: groupMap,
              groupSelectLabel: '选择要配置的群…',
            }),
          ),
        ),

        h(Card, { title: '批次触发', open: Boolean(openCards.batch), onToggle: function () { toggleCard('batch') } },
          h(Field, { label: '阈值（每群累计条数）', hint: '某群累计到这个条数就冻结本批并送去总结。默认 100。' },
            h(NumInput, { value: form.batch && form.batch.threshold, min: 1, max: 100000, onChange: function (v) { patch('batch.threshold', v) } }),
          ),
          h(Field, { label: '宽限期（毫秒）', hint: '达到阈值后等待一小段时间，吸收乱序到达的消息再加入本批。默认 2000。' },
            h(NumInput, { value: form.batch && form.batch.freezeGraceMs, min: 0, max: 60000, step: 100, onChange: function (v) { patch('batch.freezeGraceMs', v) } }),
          ),
          h(Field, { label: '单群缓冲上限', hint: '内存保护：超过此条数强制冻结。默认 500。' },
            h(NumInput, { value: form.batch && form.batch.maxBuffer, min: 1, max: 100000, onChange: function (v) { patch('batch.maxBuffer', v) } }),
          ),
          h(Field, { label: '最长等待（毫秒）', hint: '不足阈值时的兜底：最长等这么久也会总结一次。默认 3600000（1 小时）。' },
            h(NumInput, { value: form.batch && form.batch.maxWaitMs, min: 1000, max: 86400000, step: 60000, onChange: function (v) { patch('batch.maxWaitMs', v) } }),
          ),
        ),

        h(Card, {
          title: '总结用的模型',
          badges: models.current
            ? h('span', { className: 'qqd-badge' }, 'DSH 默认：' + models.current.provider + '/' + models.current.model)
            : null,
          open: Boolean(openCards.model),
          onToggle: function () { toggleCard('model') },
        },
          h('div', { className: 'qqd-hint' }, '留空则使用 DSH 系统设置里的默认模型。凭证由 DSH 管理，此处不需要填 API Key。'),
          h(Field, { label: '提供商' },
            h('select', {
              className: 'qqd-select',
              value: currentProvider,
              onChange: function (e) { patch('model.provider', e.target.value) },
            },
              h('option', { value: '' }, '（用 DSH 默认）'),
              providerOpts.map(function (p) { return h('option', { key: p.id, value: p.id }, p.label || p.id) }),
            ),
          ),
          h(Field, { label: '模型' },
            h('select', {
              className: 'qqd-select',
              value: (form.model && form.model.model) || '',
              onChange: function (e) { patch('model.model', e.target.value) },
            },
              h('option', { value: '' }, '（用 DSH 默认）'),
              modelOptions.map(function (m) { return h('option', { key: m.id, value: m.id }, m.label || m.id) }),
            ),
          ),
          models.error ? h('div', { className: 'qqd-note' }, '拉取模型列表失败：' + models.error) : null,
          h(Field, { label: '温度', hint: '0～2，越低越稳定。总结任务建议 0.2～0.4。' },
            h(NumInput, { value: form.model && form.model.temperature, min: 0, max: 2, step: 0.1, onChange: function (v) { patch('model.temperature', v) } }),
          ),
          h(Field, { label: '最大输出 tokens' },
            h(NumInput, { value: form.model && form.model.maxTokens, min: 64, max: 32000, step: 100, onChange: function (v) { patch('model.maxTokens', v) } }),
          ),
          h(Field, { label: '单次调用超时（毫秒）' },
            h(NumInput, { value: form.model && form.model.timeoutMs, min: 5000, max: 600000, step: 5000, onChange: function (v) { patch('model.timeoutMs', v) } }),
          ),
          h(Field, { label: '失败重试次数', hint: '调用失败后指数退避重试；用尽后降级为原始摘录仍会投递。' },
            h(NumInput, { value: form.model && form.model.retries, min: 0, max: 10, onChange: function (v) { patch('model.retries', v) } }),
          ),
        ),

        h(Card, {
          title: 'AI 提示词',
          badges: promptDirty
            ? h('span', { className: 'qqd-badge', 'data-kind': 'warn' }, '未保存')
            : (promptSystem && promptSystem !== promptMeta.defaultPrompt
                ? h('span', { className: 'qqd-badge', 'data-kind': 'ok' }, '自定义')
                : h('span', { className: 'qqd-badge' }, '内置默认')),
          open: Boolean(openCards.prompt),
          onToggle: function () { toggleCard('prompt') },
        },
          h('div', { className: 'qqd-hint' }, '送给模型的 system prompt。留空即使用内置默认；修改后保存会热重建运行态，不需要重启 DSH。'),
          promptMeta.error
            ? h('div', { className: 'qqd-tip', 'data-kind': 'error' }, '提示词接口不可用（后端仍是旧代码）：' + promptMeta.error)
            : null,
          h('textarea', {
            className: 'qqd-textarea',
            value: promptSystem,
            spellCheck: false,
            placeholder: '留空 = 使用内置默认提示词。点下方「查看默认提示词」可参照默认内容改写。',
            onChange: function (e) { setPromptSystem(e.target.value) },
          }),
          h('div', { className: 'qqd-inline' },
            h('span', {
              className: 'qqd-counter',
              'data-kind': promptSystem.length > (promptMeta.maxChars || 20000) ? 'over' : 'ok',
            }, promptSystem.length + ' / ' + (promptMeta.maxChars || 20000)),
            h('span', { className: 'qqd-grow' }),
            h('button', {
              className: 'qqd-btn', type: 'button',
              onClick: function () { setShowDefault(function (v) { return !v }) },
            }, showDefault ? '收起默认提示词' : '查看默认提示词'),
            h('button', {
              className: 'qqd-btn', type: 'button', 'data-variant': 'danger',
              disabled: saving || busy === 'prompt',
              onClick: resetPrompt,
            }, busy === 'prompt' ? '恢复中…' : '恢复默认'),
          ),
          showDefault
            ? h('div', { className: 'qqd-pre' }, promptMeta.defaultPrompt || '（未取到默认提示词）')
            : null,
          promptSystem.length > 0 && promptSystem.length < (promptMeta.minChars || 10)
            ? h('div', { className: 'qqd-tip', 'data-kind': 'error' },
                '提示词太短：至少 ' + (promptMeta.minChars || 10) + ' 字符，留空则表示恢复默认。')
            : null,
        ),

        h(Card, {
          title: 'HTTP 网页服务',
          badges: h('span', { className: 'qqd-inline' },
            h('span', { className: 'qqd-badge', 'data-kind': form.httpServer && form.httpServer.enabled ? 'ok' : 'off' },
              form.httpServer && form.httpServer.enabled ? '已开启' : '未开启'),
            http && http.listening
              ? h('span', { className: 'qqd-badge', 'data-kind': 'ok' }, '已监听')
              : (http && http.error ? h('span', { className: 'qqd-badge', 'data-kind': 'warn' }, '启动失败') : null),
          ),
          open: Boolean(openCards.http),
          onToggle: function () { toggleCard('http') },
        },
          h('div', { className: 'qqd-hint' }, '插件自带的独立网页服务（配置页 / 日志页 / 总结记录页），与 DSH 自带的 webServer 完全独立。默认关闭。'),
          h(Field, { label: '开启网页服务', hint: '开启后按下面的端口与监听地址对外提供页面。' },
            h(Check, {
              checked: Boolean(form.httpServer && form.httpServer.enabled),
              label: '启用独立 HTTP 网页服务',
              onChange: function (v) { patch('httpServer.enabled', v) },
            }),
          ),
          h(Field, { label: '端口', hint: '1024–65535，默认 1213。保存时会先探测端口是否被占用。' },
            h(NumInput, {
              value: form.httpServer && form.httpServer.port, min: 1024, max: 65535,
              onChange: function (v) { patch('httpServer.port', v) },
            }),
          ),
          h(Field, { label: '监听地址', hint: '0.0.0.0 = 局域网内其它设备也能访问，请确保密钥足够复杂；只给本机用可填 127.0.0.1。' },
            h(TextInput, {
              value: form.httpServer && form.httpServer.host,
              placeholder: '0.0.0.0',
              onChange: function (v) { patch('httpServer.host', v) },
            }),
          ),
          h(Field, { label: '密钥验证', hint: '开启后访问网页需要输入密钥登录；关闭则任何能连上该端口的人都能看。' },
            h(Check, {
              checked: form.httpServer ? form.httpServer.authEnabled !== false : true,
              label: '访问网页需要密钥',
              onChange: function (v) { patch('httpServer.authEnabled', v) },
            }),
          ),
          h(Field, { label: '访问密钥', hint: '密钥不在普通保存里传输。点「重新生成」后新密钥只显示一次，请立刻复制保存。' },
            h('div', { className: 'qqd-inline' },
              h('input', {
                className: 'qqd-token',
                value: plainToken || (http && http.tokenMasked ? http.tokenMasked : ''),
                readOnly: true,
                placeholder: http && http.tokenSet ? '' : '尚未生成',
                onFocus: function (e) { e.target.select() },
              }),
              h('button', {
                className: 'qqd-btn', type: 'button', disabled: busy === 'token',
                onClick: regenToken,
              }, busy === 'token' ? '生成中…' : '重新生成'),
            ),
          ),
          h(Field, { label: '登录有效期（小时）', hint: '登录后保持多久不用重新输入密钥。默认 168（7 天）。' },
            h(NumInput, {
              value: form.httpServer && form.httpServer.sessionHours, min: 1, max: 8760,
              onChange: function (v) { patch('httpServer.sessionHours', v) },
            }),
          ),
          h(Field, { label: '运行状态' },
            h('div', { className: 'qqd-inline' },
              h('span', { className: 'qqd-badge', 'data-kind': http && http.listening ? 'ok' : 'off' },
                http && http.listening
                  ? '已监听 http://' + (http.host === '0.0.0.0' ? '127.0.0.1' : http.host) + ':' + http.port
                  : (http && http.error ? '启动失败：' + http.error : '未监听')),
            ),
          ),
          h('div', { className: 'qqd-note' }, '改动端口或监听地址后，保存会重启 HTTP 服务，已登录的会话可能失效。'),
          h('div', { className: 'qqd-actions' },
            h('button', { className: 'qqd-btn', type: 'button', onClick: loadHttp }, '刷新状态'),
          ),
        ),

        h(Card, {
          title: '投递目标（QQ 私聊）',
          badges: h('span', { className: 'qqd-badge' }, form.dryRun ? '当前预演，不会真发' : '必填'),
          open: Boolean(openCards.delivery),
          onToggle: function () { toggleCard('delivery') },
        },
          h(IdListEditor, {
            value: form.delivery && form.delivery.friends,
            onChange: function (v) { patch('delivery.friends', v) },
            options: (friends.available || []).map(function (f) {
              return { value: f.userId, label: f.remark || f.nickname || f.userId }
            }),
            selectLabel: wsOk ? '从好友列表选择…' : '（协议端未连接，无法拉取好友列表）',
            emptyText: '尚未添加接收人',
            placeholder: '输入 QQ 号后回车',
          }),
          friends.error ? h('div', { className: 'qqd-note' }, '拉取好友列表失败：' + friends.error) : null,
          h(Field, { label: '单条消息最大字数', hint: '超过则按行切分成多条发送。默认 1800。' },
            h(NumInput, { value: form.delivery && form.delivery.maxCharsPerMessage, min: 200, max: 4000, step: 100, onChange: function (v) { patch('delivery.maxCharsPerMessage', v) } }),
          ),
          h(Field, { label: '多群聚合窗口（毫秒）', hint: '多个群在此时间窗内各自出总结时，会一起投递，但**每个群仍单独发一条消息**，不会合并成一条（避免超长截断）。0 = 立即逐个发送。' },
            h(NumInput, { value: form.delivery && form.delivery.aggregateWindowMs, min: 0, max: 600000, step: 500, onChange: function (v) { patch('delivery.aggregateWindowMs', v) } }),
          ),
        ),

        h(Card, { title: '存储与预演', open: Boolean(openCards.storage), onToggle: function () { toggleCard('storage') } },
          h(Field, { label: '消息保留天数', hint: '按群按天的 JSONL 落盘文件，超过天数的会被定期清理。' },
            h(NumInput, { value: form.storage && form.storage.keepDays, min: 1, max: 365, onChange: function (v) { patch('storage.keepDays', v) } }),
          ),
          h(Field, { label: '预演模式（dryRun）', hint: '开启后总结照常生成，但只写入 outbox 文件，不真的发 QQ。建议首次配置时先开。' },
            h(Check, { checked: Boolean(form.dryRun), label: '只写文件，不发 QQ', onChange: function (v) { patch('dryRun', v) } }),
          ),
          h(Field, { label: '侧边栏入口', hint: '开启后 DSH 主界面左侧导航会多出一行「QQ 群总结」，点开即本面板。默认关闭。' },
            h(Check, {
              checked: Boolean(form.ui && form.ui.sidebarEntry),
              label: '在主界面左侧边栏显示入口',
              onChange: function (v) { patch('ui.sidebarEntry', v) },
            }),
          ),
        ),

        tip ? h('div', { className: 'qqd-tip', 'data-kind': tipKind }, tip) : null,

        h('div', { className: 'qqd-actions' },
          h('button', {
            className: 'qqd-btn', type: 'button', 'data-variant': 'primary',
            disabled: saving || !anyDirty, onClick: save,
          }, saving ? '保存中…' : (anyDirty ? '保存并生效' : '已保存')),
          h('button', {
            className: 'qqd-btn', type: 'button', disabled: saving || !anyDirty,
            onClick: function () {
              setForm(JSON.parse(baseline))
              setDirty(false)
              setPromptSystem(promptBaseline)
              flash('已撤销未保存的改动')
            },
          }, '撤销改动'),
          h('button', { className: 'qqd-btn', type: 'button', 'data-variant': 'danger', disabled: saving, onClick: reset }, '恢复初始配置'),
        ),

        recent.length > 0
          ? h(Card, { title: '最近一次报告', open: true },
              (recent[0].reports && recent[0].reports.length > 0)
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                    recent[0].reports.map(function (rep, i) {
                      return h('div', { key: String(rep.groupId) + ':' + i, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                        h('div', { className: 'qqd-note', style: { fontWeight: 600 } },
                          (rep.groupName || rep.groupId) + '　' + (rep.count || 0) + ' 条' + (rep.ok ? '' : '（总结失败，降级摘录）'),
                        ),
                        h('div', { className: 'qqd-pre' }, rep.text || ''),
                      )
                    }),
                  )
                : h('div', { className: 'qqd-pre' }, recent[0].text || ''),
            )
          : null,
      )
    }

    /** 侧边栏行只渲染图标字形：随 props.size / currentColor 变化。 */
    function SidebarIcon(props) {
      const size = Number.isFinite(props && props.size) ? props.size : 16
      return h('svg', {
        className: 'qqd-sidenav-icon',
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2.5 3.5H13.5V12.5H2.5Z', strokeLinejoin: 'round' }),
        h('path', { d: 'M4.5 6.5H11.5', strokeLinecap: 'round' }),
        h('path', { d: 'M4.5 9H9.5', strokeLinecap: 'round' }),
      )
    }

    /** 侧边栏入口点开的整页面板：复用同一套设置界面。 */
    function SidebarPanel() {
      return h('div', { className: 'qqd-panel' }, h(SettingsPage, null))
    }

    const inject = ['slots']

    function apply(ctx) {
      injectStyles()
      const slots = ctx.get('slots')
      if (!slots) {
        console.warn('[qq-group-digest] slots service unavailable, UI skipped')
        return
      }
      slots.inject(SLOT_SETTINGS, function () {
        return slots.register(
          {
            name: SLOT_SETTINGS,
            id: PLUGIN_ID,
            order: 60,
            label: function () { return 'QQ 群总结' },
          },
          SettingsPage,
        )
      })

      installSidebarEntry(ctx, slots)
    }

    /**
     * 侧边栏入口：受 ui.sidebarEntry 开关控制。
     *
     * 原生入口需要 main + sidebar.panellist 两个席位同时就绪；宿主版本较老、
     * 缺 panellist 席位时回退到 sidebar.footer.action。开关状态由 /settings
     * 轮询得到，变化时即时注册/注销，无需刷新页面。
     */
    function installSidebarEntry(ctx, slots) {
      let wanted = false
      let mainReady = false
      let panelListReady = false
      let footerReady = false
      let mainDispose = null
      let rowDispose = null
      let footerDispose = null
      let stopped = false

      const layout = function () {
        return typeof ctx.get === 'function' ? ctx.get('layout') : null
      }
      const leavePanel = function () {
        try {
          const c = layout()
          if (c && c.panelInfo && c.panelInfo.getSnapshot && c.panelInfo.getSnapshot().activePanelId === PLUGIN_ID) {
            c.selectPanel(null)
          }
        } catch (e) { /* 老宿主没有 panel 控制器 */ }
      }
      const disposeRow = function () {
        if (rowDispose) { rowDispose(); rowDispose = null }
      }
      const disposeFooter = function () {
        if (footerDispose) { footerDispose(); footerDispose = null }
      }
      const disposeMain = function () {
        if (mainDispose) { leavePanel(); mainDispose(); mainDispose = null }
      }

      const sync = function () {
        if (stopped) return
        const nativeReady = mainReady && panelListReady
        if (nativeReady) {
          disposeFooter()
          if (wanted && !rowDispose) {
            rowDispose = slots.register(
              { name: SLOT_SIDEBAR_PANEL, id: PLUGIN_ID, order: 60, label: 'QQ 群总结' },
              SidebarIcon,
            )
          } else if (!wanted) {
            disposeRow()
          }
          return
        }
        disposeRow()
        if (footerReady && wanted && !footerDispose) {
          footerDispose = slots.register(
            { name: SLOT_SIDEBAR_FOOTER, id: PLUGIN_ID, order: 0 },
            SidebarIcon,
          )
        } else if (!wanted) {
          disposeFooter()
        }
      }

      const applyWanted = function (next) {
        const v = next === true
        if (v === wanted) return
        wanted = v
        if (wanted) {
          // main 必须先于 panellist 行就绪，否则宿主拒绝选中缺页面的行。
          if (!mainDispose) {
            slots.inject(SLOT_MAIN, function () {
              mainDispose = slots.register(
                { name: SLOT_MAIN, key: PLUGIN_ID, inject: function () { return { presentation: 'panel' } } },
                SidebarPanel,
              )
              mainReady = true
              sync()
              return function () {
                leavePanel()
                mainReady = false
                const d = mainDispose
                mainDispose = null
                sync()
                if (d) d()
              }
            })
          }
        } else {
          disposeRow()
          disposeFooter()
          disposeMain()
        }
        sync()
      }

      // 首次与后续轮询：读 /settings 里的 ui.sidebarEntry。
      const pull = function () {
        api('/settings').then(function (d) {
          const flag = Boolean(d && d.settings && d.settings.ui && d.settings.ui.sidebarEntry)
          applyWanted(flag)
        }).catch(function () { /* 读不到就保持现状 */ })
      }
      pull()
      const timer = setInterval(pull, 8000)
      if (timer && typeof timer.unref === 'function') timer.unref()

      slots.inject(SLOT_SIDEBAR_PANEL, function () {
        panelListReady = true
        sync()
        return function () { panelListReady = false; sync() }
      })
      slots.inject(SLOT_SIDEBAR_FOOTER, function () {
        footerReady = true
        sync()
        return function () { footerReady = false; disposeFooter() }
      })

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            stopped = true
            clearInterval(timer)
            disposeRow()
            disposeFooter()
            disposeMain()
          }
        }, 'qq-digest: sidebar entry')
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.SettingsPage = SettingsPage
    return module.exports
  },
})
