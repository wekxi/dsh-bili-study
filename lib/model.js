/**
 * lib/model.js —— 探测 / 调用**宿主**的模型服务（P3-2a）
 * ============================================================================
 * 红线：插件**自己绝不存 API key**。模型路由与凭证全部来自宿主：
 *   · `ctx.get('llm')`        —— @deepseek-ai/dsh-llm 的 LlmRuntime（流式调用）
 *   · `ctx.get('agentDefaultModel')` —— 用户当前选的默认模型（deepseek-official/deepseek-flash）
 *
 * 拿不到 llm 服务时**不是错误**：插件退化成「摘句兜底」，并让外部 agent 走
 * `bili_study_digest`（提示词驱动）。所以这里所有探测都 try/catch，绝不抛。
 *
 * 调用形态（与 dsh-session-title-llm / dsh-compaction-basic 同一条路）：
 *   for await (const chunk of llm.stream({ provider, model, messages, system, maxTokens }))
 *   文本在 text-delta 里，终止状态在 finish 里（error/aborted 要当失败）。
 * ============================================================================
 */

/** 安全地取一个宿主服务（没有就 undefined，不抛）。 */
export function getService(ctx, name) {
  try {
    const v = ctx?.get?.(name)
    if (v !== undefined && v !== null) return v
  } catch { /* 服务还没挂 / 已 dispose：当成没有 */ }
  try {
    const v = ctx?.[name]
    if (v !== undefined && v !== null && typeof v === 'object') return v
  } catch { /* getter 抛错也当成没有 */ }
  return undefined
}

function providerId(entry) {
  if (!entry) return ''
  if (typeof entry === 'string') return entry
  return String(entry.id || entry.provider || entry.name || '')
}

/**
 * 探测宿主模型：有没有 llm 服务、默认走哪个 provider/model。
 * @param {object} ctx 插件 ctx
 * @param {{override?:string}} [opt] override：配置里的 refineModel（`provider/model` 或只写 model）
 * @returns {Promise<{available:boolean, provider:string, model:string, source:string, reason:string}>}
 */
export async function detectHostModel(ctx, { override = '' } = {}) {
  const llm = getService(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    return { available: false, provider: '', model: '', source: 'none', reason: '宿主没有 llm 服务（这个版本不支持插件内直调）' }
  }

  let provider = ''
  let model = ''
  let source = 'default'
  try {
    const sel = getService(ctx, 'agentDefaultModel')?.currentSelection?.()
    if (sel && typeof sel.provider === 'string' && sel.provider) {
      provider = sel.provider
      model = String(sel.model || '')
    }
  } catch { /* 没有默认模型选择就继续往下找 */ }

  const ov = String(override || '').trim()
  if (ov) {
    if (ov.includes('/')) {
      const idx = ov.indexOf('/')
      provider = ov.slice(0, idx).trim()
      model = ov.slice(idx + 1).trim()
    } else {
      model = ov
    }
    source = 'config'
  }

  if (!provider) {
    try {
      const list = await llm.listProviders?.()
      const first = Array.isArray(list) ? list[0] : null
      provider = providerId(first)
    } catch { /* 忽略：下面统一报 */ }
  }
  if (!provider) {
    return { available: false, provider: '', model: '', source, reason: '宿主没有已注册的模型提供方' }
  }

  if (!model) {
    try {
      const models = await llm.listModels?.(provider)
      model = String(Array.isArray(models) ? (models[0]?.id || models[0]?.model || '') : '')
    } catch { /* 忽略：下面统一报 */ }
  }
  if (!model) {
    return { available: false, provider, model: '', source, reason: `提供方 ${provider} 没有报出可用模型（可在设置里手填 refineModel）` }
  }
  // 顺手问一下这个模型支不支持「低思考」：提炼字幕不需要长推理，低档更省钱也更快。
  // 拿不到能力信息就不传 reasoningEffort（让它走适配器默认）。
  let reasoningEffort = ''
  try {
    const info = await llm.resolveModelInfo?.(provider, model)
    const efforts = info?.reasoning?.efforts
    if (Array.isArray(efforts) && efforts.some((e) => e.id === 'low')) reasoningEffort = 'low'
  } catch { /* 没这个接口 / 不支持推理：不传 */ }
  return { available: true, provider, model, source, reason: '', reasoningEffort }
}

/**
 * 把一次流式调用收成纯文本。
 * @param {object} llm 宿主 llm 服务
 * @param {{provider:string,model:string,system?:string,prompt:string,maxTokens?:number,signal?:AbortSignal}} p
 * @returns {Promise<string>}
 */
export async function streamText(llm, { provider, model, system = '', prompt, maxTokens = 1600, reasoningEffort = '', signal }) {
  const messages = [{
    // 与 dsh 的 createUserMessage 同形；不依赖品牌类型（拿不到 dsh-llm 包也能构造）
    id: `bili-study-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text: String(prompt ?? '') }],
  }]
  const options = {
    provider, model, messages,
    ...(system ? { system } : {}),
    ...(Number(maxTokens) > 0 ? { maxTokens: Number(maxTokens) } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(signal ? { signal } : {}),
  }
  let text = ''
  let reasoning = 0
  let sawDelta = false
  let failure = null
  let finishKind = ''
  for await (const chunk of llm.stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      sawDelta = true
    } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text.length
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      // 有的适配器只发 block-end；有 delta 时不要重复拼接
      if (!sawDelta) text += chunk.block.text
    } else if (chunk.type === 'finish') {
      finishKind = String(chunk.reason?.kind || '')
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const f = chunk.reason?.failure || {}
        failure = new Error(`模型调用失败：${f.code ? `[${f.code}] ` : ''}${f.message || kind}`)
      }
    }
  }
  if (failure) throw failure
  if (!text.trim()) {
    // 推理模型常见坑：思考把 token 吃完了，正文一个字没吐出来。别把空串当成"模型什么都没说"。
    if (reasoning > 0) {
      throw new Error(`模型只输出了思考过程（${reasoning} 字），没有正文：把 refineMaxChars 调小或换非推理模型再试`)
    }
    if (finishKind === 'max-tokens') throw new Error('模型输出被 maxTokens 截断，没有正文')
  }
  return text.trim()
}

/**
 * 带超时的一次模型调用（abort 之后 stream 会收尾，不会挂住一轮）。
 * @param {{llm:object, route:{provider:string,model:string}, system?:string, prompt:string,
 *          maxTokens?:number, timeoutMs?:number}} p
 */
export async function callHostModel({ llm, route, system = '', prompt, maxTokens = 1600, timeoutMs = 90000 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  if (!route?.provider || !route?.model) throw new Error('模型路由不完整（provider/model）')
  const ac = new AbortController()
  const timer = setTimeout(() => {
    try { ac.abort(new Error('模型调用超时')) } catch { /* 忽略 */ }
  }, Math.max(5000, Number(timeoutMs) || 90000))
  timer.unref?.()
  try {
    return await streamText(llm, {
      provider: route.provider, model: route.model,
      system, prompt, maxTokens, signal: ac.signal,
      reasoningEffort: route.reasoningEffort || '',
    })
  } finally {
    clearTimeout(timer)
  }
}
