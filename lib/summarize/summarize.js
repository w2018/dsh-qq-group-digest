import { buildUserPrompt } from './prompt.js'
import { getSystemPrompt } from './prompt-store.js'

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

/**
 * 单次 LLM 调用，聚合文本 delta。
 *
 * 返回 { text, finishKind, reasoningChars }：
 * - finishKind 取 finish.reason.kind（'stop' / 'max-tokens' / 'aborted' / 'error' /
 *   'tool-calls' / ''）。调用方据此判断是不是被 maxTokens 截断 —— 截断的输出虽然
 *   看起来正常，但内容是不完整的，绝不能当成成功结果落盘。
 * - reasoningChars 是推理 delta 的字数。flash 这类模型的推理 token 也计入 maxTokens，
 *   报错时把它带上，才能看出正文额度是被推理吃掉的。
 *
 * 失败仍抛错（finish.reason.kind === 'error' / 'aborted'）。
 */
export async function callOnce(route, systemPrompt, userPrompt, modelCfg, signal) {
  const cfg = modelCfg || {}
  const messages = [await makeUserMessage(userPrompt)]
  const stream = route.llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    system: systemPrompt,
    temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.3,
    maxTokens: Math.max(64, Math.trunc(Number(cfg.maxTokens) || 2048)),
    signal,
    purpose: 'qq-group-digest',
  })

  let raw = ''
  let reasoningChars = 0
  let finishKind = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if ((chunk.type === 'text-delta' || chunk.type === 'text') && typeof chunk.text === 'string') {
      raw += chunk.text
      continue
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoningChars += chunk.text.length
      continue
    }
    if (chunk.type === 'finish' && chunk.reason && typeof chunk.reason.kind === 'string') {
      finishKind = chunk.reason.kind
      if (finishKind === 'error' || finishKind === 'aborted') {
        const detail = chunk.reason.failure && chunk.reason.failure.message
          ? chunk.reason.failure.message
          : (finishKind === 'aborted' ? 'LLM 调用被中断' : 'LLM 调用失败')
        throw new Error(detail)
      }
    }
  }
  return { text: raw, finishKind, reasoningChars }
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

  // 普通总结与 AI 精细版各有一套可编辑的 system prompt；这里只取普通那套。
  const systemPrompt = getSystemPrompt(opts.systemPrompt)
  const userPrompt = buildUserPrompt(records, {
    groupName: opts.groupName,
    groupId: opts.groupId,
    gaps: opts.gaps,
    history: opts.history,
    maxInputChars: modelCfg.maxInputChars,
    maxHistoryChars: modelCfg.maxHistoryChars,
  })

  const totalAttempts = retries + 1
  // 本次批次的基准 maxTokens；第 2 次及以后按 2^(attempt-1) 翻倍（上限 32000）。
  const baseMaxTokens = Math.max(64, Math.trunc(Number(modelCfg.maxTokens) || 2048))
  let lastError = ''
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('timeout')),
      Math.max(5000, Math.trunc(Number(modelCfg.timeoutMs) || 120000)),
    )
    if (typeof timer.unref === 'function') timer.unref()
    // 第 2 次及以后把 maxTokens 翻倍：截断多半是额度不够，重试时加量才有意义。
    const attemptCfg = attempt > 1
      ? Object.assign({}, modelCfg, { maxTokens: Math.min(32000, baseMaxTokens * Math.pow(2, attempt - 1)) })
      : modelCfg
    try {
      const result = await callOnce(route, systemPrompt, userPrompt, attemptCfg, controller.signal)
      if (result.finishKind === 'max-tokens') {
        throw new Error('模型输出被截断（maxTokens 用尽，正文 ' + result.text.length +
          ' 字 / 推理 ' + result.reasoningChars + ' 字）')
      }
      const text = stripFences(result.text)
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
