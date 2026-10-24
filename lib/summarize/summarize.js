import { buildSystemPrompt, buildUserPrompt } from './prompt.js'

export function getSvc(ctx, serviceName) {
  if (!ctx || !serviceName) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(serviceName)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    /* 落到下一档 */
  }
  try {
    return ctx.reflect?.get?.(serviceName) ?? undefined
  } catch {
    return undefined
  }
}

export class RouteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RouteError'
  }
}

/**
 * 解析模型路由：
 * 1) 显式 provider + model
 * 2) DSH 的 agentDefaultModel.currentSelection()
 * 3) 第一个能列出模型的 provider 的第一个模型
 */
export async function resolveRoute(ctx, modelCfg) {
  const llm = getSvc(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new RouteError('DSH LLM 服务不可用（ctx.llm.stream 缺失）')
  }
  const cfg = modelCfg || {}
  if (cfg.provider && cfg.model) {
    return { provider: String(cfg.provider), model: String(cfg.model), llm, source: 'explicit' }
  }
  try {
    const def = getSvc(ctx, 'agentDefaultModel')
    if (def && typeof def.currentSelection === 'function') {
      const sel = def.currentSelection()
      if (sel && sel.provider && sel.model) {
        return { provider: String(sel.provider), model: String(sel.model), llm, source: 'default' }
      }
    }
  } catch {
    /* 继续 */
  }
  if (cfg.fallbackToDefault === false) {
    throw new RouteError('未配置模型且 fallbackToDefault=false')
  }
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() || [] : []
  for (const p of providers) {
    try {
      const models = (await llm.listModels(p.id)) || []
      if (models.length > 0) {
        return { provider: String(p.id), model: String(models[0].id), llm, source: 'first-available' }
      }
    } catch {
      /* 试下一个 */
    }
  }
  throw new RouteError('DSH 里没有可用的模型：请先在 设置 → 模型 里配置一个提供商')
}

/** 把文本包成 llm.stream 认识的 user message；拿不到 dsh-llm 时退回同形状普通对象。 */
export async function makeUserMessage(text) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') {
      return mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'qq-group-digest' } })
    }
  } catch {
    /* 链接安装通常解析不到，走兜底 */
  }
  return {
    id: 'qq-digest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'qq-group-digest' },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.trunc(ms))))

/** 单次 LLM 调用，聚合文本 delta。失败抛错（含 finish.reason.kind === 'error'）。 */
export async function callOnce(route, systemPrompt, userPrompt, modelCfg, signal) {
  const cfg = modelCfg || {}
  const messages = [await makeUserMessage(userPrompt)]
  const stream = route.llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    system: systemPrompt,
    temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.3,
    maxTokens: Math.max(64, Math.trunc(Number(cfg.maxTokens) || 1200)),
    signal,
    purpose: 'qq-group-digest',
  })

  let raw = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if ((chunk.type === 'text-delta' || chunk.type === 'text') && typeof chunk.text === 'string') {
      raw += chunk.text
      continue
    }
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const detail = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : 'LLM 调用失败'
      throw new Error(detail)
    }
  }
  return raw
}

function stripFences(text) {
  const fence = String.fromCharCode(96).repeat(3)
  let out = String(text || '').trim()
  if (out.startsWith(fence)) {
    const nl = out.indexOf('\n')
    out = nl >= 0 ? out.slice(nl + 1) : out.slice(fence.length)
  }
  if (out.endsWith(fence)) out = out.slice(0, out.length - fence.length)
  return out.trim()
}

/**
 * 总结一批记录，带重试与错误分类。
 * 返回 { ok, kind, text, provider, model, attempts, error, routeSource }
 */
export async function summarizeBatch(ctx, records, options) {
  const opts = options || {}
  const modelCfg = opts.modelConfig || {}
  const logger = opts.logger || null
  const retries = Math.max(0, Math.trunc(Number(modelCfg.retries) || 0))
  const backoffMs = Math.max(100, Math.trunc(Number(modelCfg.backoffMs) || 2000))

  let route
  try {
    route = await resolveRoute(ctx, modelCfg)
  } catch (error) {
    return { ok: false, kind: 'route', text: '', provider: '', model: '', attempts: 0, error: error.message }
  }

  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(records, {
    groupName: opts.groupName,
    groupId: opts.groupId,
    gaps: opts.gaps,
    history: opts.history,
    maxInputChars: modelCfg.maxInputChars,
    maxHistoryChars: modelCfg.maxHistoryChars,
  })

  const totalAttempts = retries + 1
  let lastError = ''
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('timeout')),
      Math.max(5000, Math.trunc(Number(modelCfg.timeoutMs) || 120000)),
    )
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const raw = await callOnce(route, systemPrompt, userPrompt, modelCfg, controller.signal)
      const text = stripFences(raw)
      if (!text || text.length < 10) {
        lastError = '模型返回空内容或过短（' + text.length + ' 字）'
        throw new Error(lastError)
      }
      if (logger) {
        logger.info?.('[qq-digest] 群 ' + opts.groupId + ' 总结成功（第 ' + attempt + ' 次，' + route.provider + '/' + route.model + '）')
      }
      return { ok: true, kind: 'ok', text, provider: route.provider, model: route.model, attempts: attempt, error: '', routeSource: route.source }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error)
      if (logger) logger.warn?.('[qq-digest] 群 ' + opts.groupId + ' 第 ' + attempt + '/' + totalAttempts + ' 次总结失败：' + lastError)
      if (attempt < totalAttempts) await sleep(backoffMs * Math.pow(2, attempt - 1))
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, kind: 'call', text: '', provider: route.provider, model: route.model, attempts: totalAttempts, error: lastError, routeSource: route.source }
}
