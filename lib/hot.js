/**
 * 热重载：把 lib/ 整棵代码树复制到「新一代」目录再 import，从而实现
 * **不重启 DSH** 也能让改过的 index.js / lib/** 代码真正生效。
 *
 * 为什么必须复制：Node 的 ESM 缓存按 URL 记忆模块，而相对导入（'./config.js'）
 * 在解析时会丢掉查询串，所以 import('./runtime.js?v=2') 里 runtime.js 是新的，
 * 它 import 的 config.js 仍然是旧的那一份。把整棵树搬到新目录，所有相对导入
 * 才会落在新路径上，得到完整的新代码。
 */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const KEEP_GENERATIONS = 3

/** 把 lib/ 复制成新一代目录，返回其绝对路径。 */
function materializeGeneration(pluginRoot, storageRoot) {
  const base = join(storageRoot, 'generations')
  mkdirSync(base, { recursive: true })
  const dir = join(base, 'g' + Date.now())
  mkdirSync(dir, { recursive: true })
  cpSync(join(pluginRoot, 'lib'), join(dir, 'lib'), { recursive: true })
  // 关键：$DSH_HOME 下没有 package.json，.js 会被当成 CommonJS；补一个显式声明。
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8')
  return dir
}

/** 只保留最近 N 代，避免 generations 目录无限膨胀。 */
function pruneGenerations(storageRoot, keep) {
  const base = join(storageRoot, 'generations')
  let names = []
  try {
    names = readdirSync(base).filter((n) => n.startsWith('g')).sort()
  } catch {
    return 0
  }
  const limit = Math.max(1, Number(keep) || KEEP_GENERATIONS)
  const dead = names.slice(0, Math.max(0, names.length - limit))
  for (const n of dead) {
    try {
      rmSync(join(base, n), { recursive: true, force: true })
    } catch {
      /* 删不掉不影响主流程 */
    }
  }
  return dead.length
}

/**
 * 载入一代新代码，返回其中的 Runtime 类。
 * 失败（语法错误、缺依赖）时抛错，调用方负责保留旧运行态。
 */
export async function loadGeneration(pluginRoot, storageRoot) {
  const dir = materializeGeneration(pluginRoot, storageRoot)
  const entry = pathToFileURL(join(dir, 'lib', 'runtime.js')).href
  const mod = await import(entry)
  if (!mod || typeof mod.Runtime !== 'function') {
    throw new Error('新一代代码里没有导出 Runtime')
  }
  pruneGenerations(storageRoot, KEEP_GENERATIONS)
  return { Runtime: mod.Runtime, dir }
}
