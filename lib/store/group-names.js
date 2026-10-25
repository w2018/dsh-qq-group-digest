import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE_NAME = 'group-names.json'

/**
 * 群号 → 群名 的持久化映射表。
 *
 * 存在理由：QQ 的群消息事件不一定带 group_name（部分事件类型、部分协议端实现都不带），
 * 而总结记录、报告标题、设置页都需要群名。历史上群名只活在 pipeline 的内存 Map 里，
 * 一重启就没了，落盘的总结只能看到群号，或者被兜底成「未命名群」。
 *
 * 这里把群名单独存成一个小文件，任何拿到群名的地方（协议端群列表、消息事件、
 * 历史记录）都可以调 set()/merge() 补齐，读的地方统一走 get()。
 *
 * 落盘位置：<rootDir>/group-names.json，结构 { "<群号>": "<群名>" }。
 */
export class GroupNameStore {
  constructor(rootDir) {
    this.root = String(rootDir || '')
    this.file = this.root ? join(this.root, FILE_NAME) : ''
    this.map = new Map()
    this.loaded = false
    this.dirty = false
    this.timer = null
  }

  ensure() {
    if (!this.root) return
    mkdirSync(this.root, { recursive: true })
  }

  /** 惰性加载；文件缺失/损坏都当成空表。 */
  load() {
    if (this.loaded) return this.map
    this.loaded = true
    if (!this.file) return this.map
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [gid, name] of Object.entries(parsed)) {
          const id = String(gid || '').trim()
          const val = String(name == null ? '' : name).trim()
          if (id && val) this.map.set(id, val)
        }
      }
    } catch {
      /* 没有文件或内容坏了都从空表开始 */
    }
    return this.map
  }

  /** 取群名，没有返回空串（调用方自行兜底成群号）。 */
  get(groupId) {
    this.load()
    return this.map.get(String(groupId || '').trim()) || ''
  }

  /** 写入单个群名；空名不覆盖已有值，返回是否发生变化。 */
  set(groupId, name) {
    const id = String(groupId || '').trim()
    const val = String(name == null ? '' : name).trim()
    if (!id || !val) return false
    this.load()
    if (this.map.get(id) === val) return false
    this.map.set(id, val)
    this.dirty = true
    this.scheduleFlush()
    return true
  }

  /** 批量合并（例如协议端群列表返回的 [{group_id, group_name}] 先转成对象）。 */
  merge(obj) {
    const src = obj && typeof obj === 'object' ? obj : {}
    let changed = 0
    for (const [gid, name] of Object.entries(src)) {
      if (this.set(gid, name)) changed += 1
    }
    return changed
  }

  /** 全表副本（普通对象，便于 JSON 序列化）。 */
  all() {
    this.load()
    const out = {}
    for (const [gid, name] of this.map) out[gid] = name
    return out
  }

  /** 延迟写盘，避免消息风暴里每条消息都写一次文件。 */
  scheduleFlush() {
    if (this.timer || !this.file) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 500)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.file || !this.dirty) return false
    try {
      this.ensure()
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.all(), null, 2), 'utf8')
      renameSync(tmp, this.file)
      this.dirty = false
      return true
    } catch {
      /* 落盘失败不影响运行，下次 set() 会再试 */
      return false
    }
  }

  /** 进程退出/重建前调用，把待写内容刷盘。 */
  dispose() {
    this.flush()
  }
}
