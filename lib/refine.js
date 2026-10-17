/**
 * lib/refine.js —— P3：把 ASR 字幕原文提炼成**真正的学习笔记**
 * ============================================================================
 * 0.1.0 只会"摘句"：把字幕里信息量最高的几行原样塞进「要点」，ASR 噪声
 * （`deep fw0V`、`GBT6.1` 这种）也跟着进笔记，「我的判断」基本是空的。
 *
 * 这个模块干三件事，全部是**纯函数 + 一次注入的模型调用**，方便离线单测：
 *   ① 拼提示词：把字幕按 `[时间] 原文` 切到 `maxChars` 以内，连同标题/UP/时长喂给模型；
 *   ② 解析 + 校验：模型必须回**严格 JSON**（四段固定）；也兼容分节 Markdown。
 *      🔴 校验的重点是**不许编造**：金句必须能在字幕原文里找到（允许 ASR 错字纠正，
 *         用 bigram 相似度兜底），时间轴超出视频时长就清空，解析失败就**优雅降级**；
 *   ③ 把四节变成 note 对象（`source:model` 标签），或者说出为什么没成。
 *
 * 提示词里写死了 ASR 噪声的处理边界：
 *   - 允许纠正**明显听错**的专有名词/数字（`deep fw0V`→`DeepSeek V4.1 Flash`、
 *     `GBT6.1`→`GPT-6.1`）；
 *   - 不确定的必须写「可能是…」；
 *   - **不许**补充字幕里没有的事实、数据、人名、结论。
 * ============================================================================
 */
import { fmtHms, SECTION_POINTS, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH, SECTION_TIMELINE } from './notes.js'

/** 提示词版本：写进笔记/状态里，回头能看出这条笔记是哪版提示词提炼的。 */
export const REFINE_PROMPT_VERSION = 'bili-study-refine-v1'
/** 提炼产出的四个小节（顺序固定；时间轴锚点仍走启发式）。 */
export const REFINE_SECTIONS = [SECTION_POINTS, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH]
export const REFINE_DEFAULT_MAX_CHARS = 12000
export const REFINE_DEFAULT_PER_ROUND = 2
/** 给模型的固定系统提示（中文；改它要同时升 REFINE_PROMPT_VERSION 并补单测）。 */
export const REFINE_SYSTEM = [
  '你是一位严格的中文学习助理。你会拿到一条 B站 视频的 ASR（自动语音识别）字幕，',
  '任务是把它整理成手机上一屏读完的学习笔记。',
  '你只能依据给出的字幕：字幕没说的内容，一个字都不许补。',
  'ASR 字幕会有同音错字，允许你纠正明显听错的专有名词/数字；不确定的地方写「可能是…」。',
  '你的输出必须是严格 JSON，不要 Markdown 代码块，不要任何解释。',
].join('\n')

/** 四节的英文键名别称（模型偶尔会写英文）。 */
const KEYS = {
  points: ['要点', 'points', 'keypoints', 'key_points', 'summary', '核心要点'],
  quotes: ['金句', 'quotes', 'quote', 'highlights', '高光'],
  judgment: ['我的判断', '判断', 'judgment', 'judgement', '点评', 'comments'],
  worth: ['值不值得再看', '值不值得看', 'worth', 'worthwatching', 'worth_watching', '结论'],
}

/* ─────────────────────────── 字幕 → 提示词素材 ─────────────────────────── */

/**
 * 取字幕里**真的出现过**的原文（按行带时间轴），最多 maxChars 字。
 * @param {Array<{start:number,text:string}>} rows
 * @param {{maxChars?:number}} [opt]
 * @returns {{text:string, lines:number, chars:number, totalLines:number, truncated:boolean}}
 */
export function subtitleTranscript(rows, { maxChars = REFINE_DEFAULT_MAX_CHARS } = {}) {
  const cap = Math.max(200, Number(maxChars) || REFINE_DEFAULT_MAX_CHARS)
  const list = Array.isArray(rows) ? rows : []
  const out = []
  let used = 0
  for (const r of list) {
    const text = String(r?.text ?? '').trim()
    if (!text) continue
    const line = `[${fmtHms(Number(r.start) || 0)}] ${text}`
    if (used + line.length + 1 > cap) break
    out.push(line)
    used += line.length + 1
  }
  return {
    text: out.join('\n'),
    lines: out.length,
    chars: used,
    totalLines: list.filter((r) => String(r?.text ?? '').trim()).length,
    truncated: out.length < list.filter((r) => String(r?.text ?? '').trim()).length,
  }
}

/**
 * 拼一次提炼的提示词（**写进代码里的固定提示词**，不靠用户自己编）。
 * @param {{title?:string,author?:string,durationText?:string,url?:string,keywords?:string[],
 *          transcript:string,totalLines?:number,truncated?:boolean,maxChars?:number}} p
 * @returns {string}
 */
export function buildRefinePrompt({
  title = '', author = '', durationText = '', url = '', keywords = [],
  transcript = '', totalLines = 0, truncated = false, maxChars = REFINE_DEFAULT_MAX_CHARS,
} = {}) {
  const kws = (Array.isArray(keywords) ? keywords : []).filter(Boolean).slice(0, 6)
  const L = []
  L.push('【任务】把下面这条 B站 视频的 ASR 字幕整理成一份手机上一屏能读完的学习笔记。')
  L.push('')
  L.push('【视频】')
  L.push(`- 标题：${title || '（未知）'}`)
  if (author) L.push(`- UP主：${author}`)
  if (durationText) L.push(`- 时长：${durationText}`)
  if (url) L.push(`- 链接：${url}`)
  if (kws.length) L.push(`- 我关心的关键词：${kws.join('、')}`)
  L.push('')
  L.push('【硬性规则，必须全部遵守】')
  L.push('1. 这是自动语音识别（ASR）字幕，会有同音错字。**允许纠正明显听错的词**，例如 '
    + '`deep fw0V` → `DeepSeek V4.1 Flash`、`GBT6.1` → `GPT-6.1` 这类；'
    + '但只改你高度确信是听错的地方，**不确定的必须写成「可能是…」**。')
  L.push('2. **只许依据下面的字幕**。不许补充字幕里没有的事实、数据、人名、产品名、结论；'
    + '字幕没提到就写「字幕没提到」，绝对不许编造原文没有的内容。')
  L.push('3. 输出必须是**严格 JSON**（不要 Markdown 代码块、不要前后解释），键固定为：'
    + '`"要点"`、`"金句"`、`"我的判断"`、`"值不值得再看"`。')
  L.push('4. 「要点」3–6 条，每条 ≤60 字，是**能独立看懂的知识点**，不是摘抄；'
    + '能定位到时间就带 `"ts":"M:SS"`（取自字幕里的时间轴），定位不到就写 `""`。')
  L.push('5. 「金句」1–3 条，必须是**字幕原文**（只准按规则 1 改 ASR 错字），带 `"ts"`。')
  L.push('6. 「我的判断」2–4 句：值不值得看、适合谁看、坑/短板在哪；'
    + '若字幕信息不足，直接写「字幕不足以判断」，不要瞎猜。')
  L.push('7. 「值不值得再看」一句话结论（值得二刷 / 一遍就够 / 建议跳过），并给一句理由。')
  L.push('8. 四节加起来不超过 600 字，不写「本视频介绍了…」这种空话。')
  L.push('')
  L.push('【输出格式示例】')
  L.push('{"要点":[{"text":"…","ts":"1:23"}],"金句":[{"text":"…","ts":"4:05"}],'
    + '"我的判断":"…","值不值得再看":"…"}')
  L.push('')
  L.push(`【字幕（时间轴 + 原文）${totalLines ? `，共 ${totalLines} 条，这里给 ${transcript ? transcript.split('\n').length : 0} 条` : ''}】`)
  if (truncated) {
    L.push(`（字幕较长，只提供前 ${maxChars} 字；**结尾部分没有提供，不要对结尾下结论**。）`)
  }
  L.push(transcript || '（没有拿到字幕原文）')
  return L.join('\n')
}

/* ─────────────────────────── 解析模型返回 ─────────────────────────── */

const TS_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?/

/** `1:23` / `01:02:03` / `[1:23]` → 秒；认不出来给 -1。 */
export function tsToSeconds(ts) {
  const m = TS_RE.exec(String(ts ?? ''))
  if (!m) return -1
  const a = Number(m[1])
  const b = Number(m[2])
  const c = m[3] === undefined ? null : Number(m[3])
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c
}

function stripFences(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json|JSON)?\s*/g, '')
    .replace(/```/g, '')
    .trim()
}

function asText(v) {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\n')
  if (v && typeof v === 'object') {
    for (const k of ['text', 'content', 'body', 'value', '结论']) {
      if (typeof v[k] === 'string') return v[k].trim()
    }
  }
  return ''
}

/** 一条要点/金句：字符串或 {text, ts}。 */
function asItem(v) {
  if (typeof v === 'string') return { text: v.trim(), ts: '' }
  if (v && typeof v === 'object') {
    const text = asText(v)
    const ts = String(v.ts ?? v.time ?? v.timestamp ?? '').trim()
    return { text, ts }
  }
  return { text: '', ts: '' }
}

function pickKey(obj, names) {
  for (const n of names) if (obj && Object.prototype.hasOwnProperty.call(obj, n)) return obj[n]
  return undefined
}

/** 从任意文本里抠出第一个 JSON 对象（模型常在前后带一句话）。 */
function firstJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 分节 Markdown 兜底：`## 要点` / `要点：` 这种。 */
function parseSectionsText(raw) {
  const lines = String(raw ?? '').replace(/\r/g, '').split('\n')
  const heads = []
  const headRe = /^\s*(?:#{1,4}\s*)?(?:[-*]\s*)?(?:\*\*)?(要点|金句|我的判断|值不值得再看)(?:\*\*)?\s*[:：]?\s*(.*)$/
  for (let i = 0; i < lines.length; i += 1) {
    const m = headRe.exec(lines[i])
    if (m) heads.push({ name: m[1], start: i, inline: m[2].trim() })
  }
  if (!heads.length) return null
  const bucket = {}
  for (let i = 0; i < heads.length; i += 1) {
    const h = heads[i]
    const body = []
    if (h.inline) body.push(h.inline)
    for (let j = h.start + 1; j < (heads[i + 1]?.start ?? lines.length); j += 1) body.push(lines[j])
    bucket[h.name] = body.join('\n').trim()
  }
  return bucket
}

/**
 * 解析模型返回。先按严格 JSON，再退回分节 Markdown；都不行就 `ok:false`。
 * @returns {{ok:true, format:string, data:object} | {ok:false, reason:string, raw:string}}
 */
export function parseRefineOutput(raw) {
  const text = stripFences(raw)
  if (!text) return { ok: false, reason: '模型什么都没返回', raw: '' }

  const obj = firstJsonObject(text)
  if (obj && typeof obj === 'object') {
    const pointsRaw = pickKey(obj, KEYS.points)
    const quotesRaw = pickKey(obj, KEYS.quotes)
    const judgment = asText(pickKey(obj, KEYS.judgment))
    const worth = asText(pickKey(obj, KEYS.worth))
    if (pointsRaw !== undefined || quotesRaw !== undefined || judgment || worth) {
      return {
        ok: true,
        format: 'json',
        data: {
          points: (Array.isArray(pointsRaw) ? pointsRaw : pointsRaw === undefined ? [] : [pointsRaw]).map(asItem),
          quotes: (Array.isArray(quotesRaw) ? quotesRaw : quotesRaw === undefined ? [] : [quotesRaw]).map(asItem),
          judgment,
          worth,
        },
      }
    }
  }

  const bucket = parseSectionsText(text)
  if (bucket) {
    const splitItems = (s) => String(s || '')
      .split(/\n+/)
      .map((x) => x.replace(/^\s*(?:[-*]|\d+[.、)])\s*/, '').trim())
      .filter(Boolean)
      .map((x) => {
        // 形如「1:23 内容」或「[1:23] 内容」的要点：时间轴单独拿出来
        const m = /^[[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s+(.*)$/.exec(x)
        return m ? { text: m[2].trim(), ts: m[1] } : { text: x, ts: '' }
      })
    return {
      ok: true,
      format: 'sections',
      data: {
        points: splitItems(bucket['要点']),
        quotes: splitItems(bucket['金句']),
        judgment: String(bucket['我的判断'] || '').trim(),
        worth: String(bucket['值不值得再看'] || '').trim(),
      },
    }
  }

  return { ok: false, reason: '模型输出既不是约定的 JSON，也没有四节标题', raw: text.slice(0, 500) }
}

/* ─────────────────────────── 校验（不许编造） ─────────────────────────── */

const PUNCT_RE = /[\s，。！？、；：""''‘’“”（）()\[\]【】《》〈〉…—\-~·,.!?;:'"]+/g

function normForMatch(text) {
  return String(text ?? '').replace(PUNCT_RE, '').toLowerCase()
}

function bigrams(text) {
  const s = String(text ?? '')
  const out = []
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2))
  return out
}

/** 金句是不是字幕原文（允许 ASR 错字：bigram Dice 相似度）。 */
export function quoteInTranscript(quote, transcriptText) {
  const q = normForMatch(quote)
  const t = normForMatch(transcriptText)
  if (!q || !t) return false
  if (t.includes(q)) return true
  if (q.length < 8) return false
  const a = bigrams(q)
  if (!a.length) return false
  const pool = new Map()
  for (const b of bigrams(t)) pool.set(b, (pool.get(b) || 0) + 1)
  let hit = 0
  for (const b of a) {
    const n = pool.get(b) || 0
    if (n > 0) { hit += 1; pool.set(b, n - 1) }
  }
  return (2 * hit) / (a.length + a.length) >= 0.45
}

function clampText(text, max) {
  const s = String(text ?? '').replace(/\r/g, '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 把解析出来的四节洗干净（不编造 / 时间轴不越界 / 篇幅上限）。
 * @param {{points?:Array,quotes?:Array,judgment?:string,worth?:string}} data
 * @param {{transcriptText?:string,durationSec?:number,maxPoints?:number,maxQuotes?:number}} opt
 * @returns {{points:Array,quotes:Array,judgment:string,worth:string,warnings:string[]}}
 */
export function validateRefine(data, { transcriptText = '', durationSec = 0, maxPoints = 6, maxQuotes = 3 } = {}) {
  const warnings = []
  const points = []
  const quotes = []
  const limit = Number(durationSec) > 0 ? Number(durationSec) + 5 : 0

  for (const p of (Array.isArray(data?.points) ? data.points : []).slice(0, 20)) {
    const text = clampText(p?.text, 200)
    if (!text) continue
    let tsSec = p?.tsSec !== undefined ? Number(p.tsSec) : tsToSeconds(p?.ts)
    if (!Number.isFinite(tsSec) || tsSec < 0 || (limit && tsSec > limit)) tsSec = -1
    points.push({ text, ts: tsSec >= 0 ? fmtHms(tsSec) : '', tsSec })
    if (points.length >= maxPoints) break
  }

  for (const q of (Array.isArray(data?.quotes) ? data.quotes : []).slice(0, 10)) {
    const text = clampText(String(q?.text ?? '').replace(/^>\s*/, ''), 120)
    if (!text) continue
    // 🔴 金句必须来自原文：找不到就丢掉，并在 warnings 里说明（宁可少一条，也不许编）
    if (transcriptText && !quoteInTranscript(text, transcriptText)) {
      warnings.push(`金句未在字幕原文里找到，已丢弃：${text.slice(0, 30)}`)
      continue
    }
    let tsSec = q?.tsSec !== undefined ? Number(q.tsSec) : tsToSeconds(q?.ts)
    if (!Number.isFinite(tsSec) || tsSec < 0 || (limit && tsSec > limit)) tsSec = -1
    quotes.push({ text, ts: tsSec >= 0 ? fmtHms(tsSec) : '', tsSec })
    if (quotes.length >= maxQuotes) break
  }

  let judgment = clampText(data?.judgment, 500)
  let worth = clampText(data?.worth, 240)
  if (points.length > 3 && judgment.length > 0) {
    const total = points.reduce((a, p) => a + p.text.length, 0) + quotes.reduce((a, q) => a + q.text.length, 0)
      + judgment.length + worth.length
    if (total > 900) warnings.push(`四节合计 ${total} 字，超过 600 字的建议上限（手机上一屏读不完）`)
  }
  if (!points.length && !judgment) {
    return { points, quotes, judgment, worth, warnings: [...warnings, '模型没给出任何要点或判断'] }
  }
  return { points, quotes, judgment, worth, warnings }
}

/* ─────────────────────────── 四节 → note 对象 ─────────────────────────── */

/**
 * @param {{points:Array,quotes:Array,judgment:string,worth:string}} checked
 * @param {{source?:string}} [opt]
 * @returns {Array<{section:string,body:string,ts:string,tsSec:number,tags:string}>}
 */
export function refineSectionsFrom(checked, { source = 'model' } = {}) {
  const out = []
  const tag = source === 'model' ? 'source:model' : `source:${source}`
  for (const p of checked?.points || []) {
    out.push({ section: SECTION_POINTS, body: p.text, ts: p.ts || '', tsSec: Number.isFinite(p.tsSec) ? p.tsSec : -1, tags: tag })
  }
  for (const q of checked?.quotes || []) {
    out.push({ section: SECTION_QUOTES, body: `> ${q.text}`, ts: q.ts || '', tsSec: Number.isFinite(q.tsSec) ? q.tsSec : -1, tags: tag })
  }
  if (checked?.judgment) out.push({ section: SECTION_JUDGMENT, body: checked.judgment, ts: '', tsSec: -1, tags: tag })
  if (checked?.worth) out.push({ section: SECTION_WORTH, body: checked.worth, ts: '', tsSec: -1, tags: tag })
  return out
}

/**
 * 用模型四节替换启发式四节；**时间轴锚点保留启发式那份**（它来自真实字幕时间，
 * 而模型给的时间只落在要点/金句上）。
 */
export function mergeRefinedSections(baseSections, refinedSections) {
  const replace = new Set(REFINE_SECTIONS)
  const kept = (Array.isArray(baseSections) ? baseSections : []).filter((s) => !replace.has(s.section))
  return [...refinedSections, ...kept]
}

/* ─────────────────────────── 一次提炼（可注入模型调用） ─────────────────────────── */

/**
 * 对一条视频做一次提炼。模型调用由外部注入（宿主 llm / 测试假函数），不在这里发网络。
 * @param {{
 *   call: (p:{system:string,prompt:string,maxTokens:number})=>Promise<string>,
 *   model?: string, video?: object, rows?: Array<{start:number,text:string}>,
 *   keywords?: string[], maxChars?: number, durationSec?: number, log?: Function,
 * }} p
 * @returns {Promise<object>} ok:true → {status:'model', sections, data, warnings, ms…}；
 *                            ok:false → {status:'failed', error, raw, …}
 */
export async function runRefine({
  call, model = '', video = {}, rows = [], keywords = [],
  maxChars = REFINE_DEFAULT_MAX_CHARS, durationSec = 0, log = () => {},
} = {}) {
  if (typeof call !== 'function') return { ok: false, status: 'failed', error: '没有可用的模型调用' }
  const started = Date.now()
  const transcript = subtitleTranscript(rows, { maxChars })
  if (!transcript.text) return { ok: false, status: 'failed', error: '字幕是空的，没东西可提炼' }
  const prompt = buildRefinePrompt({
    title: video.title, author: video.author, durationText: video.durationText,
    url: video.url, keywords, transcript: transcript.text,
    totalLines: transcript.totalLines, truncated: transcript.truncated, maxChars,
  })
  let raw = ''
  try {
    // 输出上限给足：推理模型会先思考再写正文，1600 很容易被思考吃光（真机上撞到过）。
    // 这是上限不是用量；提示词里已经要求 ≤600 字。
    raw = String(await call({ system: REFINE_SYSTEM, prompt, maxTokens: 6000 }) ?? '')
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300)
    log(`[refine] ${video.bvid || ''} 模型调用失败：${error}`)
    return { ok: false, status: 'failed', error, promptChars: prompt.length, transcriptChars: transcript.chars, ms: Date.now() - started, model }
  }
  const parsed = parseRefineOutput(raw)
  if (!parsed.ok) {
    log(`[refine] ${video.bvid || ''} 解析失败：${parsed.reason}`)
    return {
      ok: false, status: 'failed', error: `模型输出解析失败：${parsed.reason}`,
      raw: String(raw).slice(0, 1200), promptChars: prompt.length, transcriptChars: transcript.chars,
      ms: Date.now() - started, model,
    }
  }
  const checked = validateRefine(parsed.data, { transcriptText: transcript.text, durationSec })
  if (!checked.points.length && !checked.judgment) {
    return {
      ok: false, status: 'failed', error: '模型没给出任何要点或判断',
      raw: String(raw).slice(0, 1200), promptChars: prompt.length, transcriptChars: transcript.chars,
      ms: Date.now() - started, model,
    }
  }
  const sections = refineSectionsFrom(checked)
  log(`[refine] ${video.bvid || ''} 提炼完成（${sections.length} 节，${checked.warnings.length} 条告警，${Date.now() - started}ms）`)
  return {
    ok: true, status: 'model', sections, data: checked, warnings: checked.warnings,
    raw: String(raw).slice(0, 1200), promptChars: prompt.length, transcriptChars: transcript.chars,
    transcriptLines: transcript.lines, transcriptTruncated: transcript.truncated,
    ms: Date.now() - started, model, format: parsed.format,
  }
}

/**
 * 提示词驱动（P3-2b）：给**外部 agent** 的一段"写笔记指令"。
 * @param {{bvid:string,title?:string,transcript:string,truncated?:boolean,maxChars?:number}} p
 */
export function buildDigestInstruction({ bvid = '', title = '', transcript = '', truncated = false, maxChars = REFINE_DEFAULT_MAX_CHARS } = {}) {
  const L = []
  L.push('【你要做的事】把下面这条 B站 视频的 ASR 字幕读成真正的学习笔记，再用工具写回插件。')
  L.push(`视频：${title || bvid}（${bvid}）`)
  L.push('')
  L.push('【硬性规则】')
  L.push('1. 这是 ASR 字幕，允许纠正明显听错的专有名词/数字（例如 `deep fw0V` → `DeepSeek V4.1 Flash`、`GBT6.1` → `GPT-6.1`）；不确定的写「可能是…」。')
  L.push('2. 只依据下面给出的字幕，**不许补充字幕里没有的事实/数据/人名/结论**。')
  L.push('3. 输出四节：要点（3–6 条，能带 `ts` 就带）/ 金句（必须原文 + ts）/ 我的判断（值不值得看、适合谁、坑在哪）/ 值不值得再看（一句话）。四节合计 ≤600 字。')
  L.push('4. 写回**一小节一条**，别把整段总结塞进一条；金句正文前面加 `> `，并带 `ts`。')
  L.push('')
  L.push('【写回步骤】')
  L.push(`1. 还没有笔记壳子就先建：bili_study_note action=new bvid=${bvid}`)
  L.push(`2. 每节一条：bili_study_note action=add bvid=${bvid} section=要点 body="…" ts="1:23" source=agent`)
  L.push(`3. 金句：bili_study_note action=add bvid=${bvid} section=金句 body="> …" ts="4:05" source=agent`)
  L.push(`4. 判断：bili_study_note action=add bvid=${bvid} section=我的判断 body="…" source=agent`)
  L.push(`5. 结论：bili_study_note action=add bvid=${bvid} section=值不值得再看 body="…" source=agent`)
  L.push('（`source=agent` 会让面板标出「外部 agent 按 digest 提炼」，别漏。）')
  L.push('')
  if (truncated) L.push(`（字幕只给了前 ${maxChars} 字，后面没提供；不要对结尾下结论。）`)
  if (transcript) {
    L.push('【字幕（时间轴 + 原文）】')
    L.push(transcript)
  } else {
    L.push('【字幕（时间轴 + 原文）】见本工具返回的 `transcript` 字段（一行一个 `[M:SS] 原文`）。')
  }
  return L.join('\n')
}
