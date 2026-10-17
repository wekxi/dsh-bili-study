/**
 * lib/duty.js —— 每日一轮：搜 → 判分 → 挑 N 条 → 抓字幕/兜底 → 写笔记 → 出报告 →（可选）评论 @
 * ============================================================================
 * ⭐ 这一轮是**纯 JS 算出来的**，不 spawn 任何子进程、不调模型 —— 手机上才跑得稳：
 *    DSHA 的进程随时会被系统杀，起一个 headless 会话那种做法在手机上没有出路。
 *    模型的活（读原文、写判读）留给工具面：`bili_study_daily` 给模型材料，模型再用
 *    `bili_study_note add` 补「我的判断」「金句」。
 *
 * ⭐ 三条红线写死在代码里，不靠自觉：
 *    ① **没有 ai-zh 字幕轨就如实记录，走「简介 + 评论」兜底，绝不硬凑**；
 *    ② 自动评论默认关，开了之后**每轮最多一条、同一视频不重复 @**（`commentLog` + `commented`）；
 *    ③ **评论只能引用模型提炼过（`source:model`）的要点/金句**。这条视频 refine 被跳过/失败
 *       （`refined=0`）就整条不发评论 —— 0.2.0 真机上把 ASR 原文 `dB sk呢` 发出去了，这是修它。
 *
 * 所有网络都过注入进来的 `client`，所有落盘都过注入进来的 `store` —— 单测因此可以完全离线。
 * ============================================================================
 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { scoreVideo, fmtCount, fmtDuration } from './score.js'
import { dayKey } from './state.js'
import {
  SECTION_POINTS, SECTION_TIMELINE, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH,
  cjkTokens, STOPWORDS, fmtHms,
} from './notes.js'
import {
  REFINE_DEFAULT_MAX_CHARS, REFINE_DEFAULT_PER_ROUND, REFINE_PROMPT_VERSION,
  mergeRefinedSections, quoteInTranscript, runRefine,
} from './refine.js'

/** 每日一轮的默认值（index.js 的 Config 默认值也是这一份，别两处各写一份）。 */
export const DUTY_DEFAULTS = {
  keywords: ['机器学习', '计算机网络 公开课', '算法 数据结构', 'DeepSeek', '英语 语法'],
  perDay: 2,
  minScore: 55,
  days: 7,
  subtitleLang: 'ai-zh',
  maxPages: 2,
  autoComment: false,
  mentionName: '',
  commentPerRound: 1,
  commentMinScore: 65,
  // P3：模型提炼（默认开）；关掉 = 与 0.1.0 完全一致的摘句兜底
  refine: true,
  refineMaxChars: REFINE_DEFAULT_MAX_CHARS,
  refineModel: '',
  refinePerRound: REFINE_DEFAULT_PER_ROUND,
}

/* ─────────────────────────── 文本侧（纯函数，可单测） ─────────────────────────── */

const PUNCT = /[。！？!?；;]$/
const SENT_SPLIT = /[。！？!?；;]/

/**
 * 把一行行字幕（每行几秒、几个字）合成"句子"。
 * ⚠️ 合成时必须保留**第一行的起始时间** —— 时间轴锚点全靠它。
 * @param {Array<{start:number,end:number,text:string,page?:number,part?:string}>} rows
 * @returns {Array<{start:number,text:string,page:number,part:string}>}
 */
export function sentencesFromRows(rows) {
  const out = []
  let cur = null
  for (const r of Array.isArray(rows) ? rows : []) {
    const text = String(r?.text ?? '').trim()
    if (!text) continue
    if (!cur) cur = { start: Number(r.start) || 0, text: '', page: Number(r.page) || 0, part: String(r.part || '') }
    cur.text += text
    const tooLong = cur.text.length >= 42
    if (PUNCT.test(text) || tooLong) {
      out.push({ ...cur, text: cur.text.trim() })
      cur = null
    }
  }
  if (cur && cur.text.trim()) out.push({ ...cur, text: cur.text.trim() })
  // 字幕里常有「嗯」「对」这种碎片：太短的并进上一句，别让它们占要点名额
  const merged = []
  for (const s of out) {
    if (s.text.length < 6 && merged.length) merged[merged.length - 1].text += s.text
    else merged.push(s)
  }
  return merged
}

const EXPLAIN_MARKERS = ['就是', '叫做', '称为', '本质', '核心', '关键', '原因', '区别', '方法', '步骤', '注意', '定义', '意味着', '也就是说']
const EMPHASIS_MARKERS = ['记住', '核心是', '本质是', '其实', '一句话', '关键', '注意', '最重要']
const FILLER = /^(然后|那么|所以|好|嗯|对|这个|那个|我们)[，,、]?/

/** 一句话的"信息量"分（启发式，不打分只排序）。 */
export function sentenceScore(text, { keywords = [] } = {}) {
  const t = String(text || '')
  const len = t.length
  let s = 0
  if (len >= 12 && len <= 80) s += 2
  else if (len < 8) s -= 2
  else if (len > 120) s -= 1
  for (const m of EXPLAIN_MARKERS) if (t.includes(m)) { s += 2; break }
  if (/\d/.test(t)) s += 1                                  // 有具体数字/年份
  if (/[A-Za-z]{3,}/.test(t)) s += 1                         // 有英文术语
  if (FILLER.test(t)) s -= 1
  for (const k of keywords) {
    if (!k) continue
    for (const part of String(k).split(/\s+/)) {
      if (part.length >= 2 && t.includes(part)) { s += 1.5; break }
    }
  }
  return s
}

/** 去重（同一句话的前 12 个字相同就当成重复）。 */
function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const it of list) {
    const key = String(it.text || '').replace(/\s+/g, '').slice(0, 12)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/**
 * 从字幕句子里抽出四类素材：要点 / 时间轴锚点 / 金句 / 知识点。
 * 全是启发式，目的只是"给人一个能扫一眼的骨架"，不假装是内容总结。
 * ⚠️ 三条小节之间**互相去重**：否则同一句会被同时塞进「要点」和「时间轴锚点」，
 *    笔记看起来像复读（真实样本上撞到过）。
 */
export function extractMaterial(sentences, { keywords = [], maxPoints = 5, maxAnchors = 6, maxQuotes = 3, topicsLimit = 6 } = {}) {
  const list = (Array.isArray(sentences) ? sentences : []).filter((s) => s && String(s.text || '').trim())
  const scored = list.map((s) => ({ ...s, weight: sentenceScore(s.text, { keywords }) }))
  const used = new Set()
  const keyOf = (s) => String(s.text || '').replace(/\s+/g, '').slice(0, 10)
  const take = (arr) => {
    const out = []
    for (const s of arr) {
      const k = keyOf(s)
      if (!k || used.has(k)) continue
      used.add(k)
      out.push(s)
    }
    return out
  }

  const points = take([...scored].sort((a, b) => b.weight - a.weight).slice(0, maxPoints * 3))
    .slice(0, maxPoints)
    .sort((a, b) => a.start - b.start)

  // 时间轴锚点：把整条视频按位置分成 maxAnchors 段，每段取最高分的一句（跳过已用过的）
  const anchors = []
  if (scored.length) {
    const total = Math.max(1, Number(list[list.length - 1].start) || 1)
    const buckets = new Map()
    for (const s of scored) {
      if (used.has(keyOf(s))) continue
      const idx = Math.min(maxAnchors - 1, Math.floor((s.start / total) * maxAnchors))
      const prev = buckets.get(idx)
      if (!prev || s.weight > prev.weight) buckets.set(idx, s)
    }
    for (const idx of [...buckets.keys()].sort((a, b) => a - b)) {
      const got = take([buckets.get(idx)])
      if (got.length) anchors.push(got[0])
    }
  }

  const quotes = take(scored
    .filter((s) => s.text.length >= 10 && s.text.length <= 70 && EMPHASIS_MARKERS.some((m) => s.text.includes(m)))
    .sort((a, b) => b.weight - a.weight))
    .slice(0, maxQuotes)

  const topics = pickTopics(list.map((s) => s.text).join('。'), topicsLimit)

  return { points, anchors, quotes, topics, sentenceCount: list.length }
}

/** 中文里没信息量的虚词：bigram 的任意一半是它们就丢掉（"的一/后呢/的这"就是这么来的）。 */
// 只放真正的语气/结构虚词：放多了会误杀真术语（比如「向量」「对齐」里的字），所以这里刻意保守。
const FUNC_CHARS = new Set([...'的了呢啊吧吗呀哦嗯呃哎唉哈嘛啦么着这那我你他们一两个些种点'])

/**
 * 关键词/知识点：bigram 词频 → **把能接起来的 bigram 拼回长词** → 取 top。
 * 为什么需要拼：bigram 只有两字，"文件夹"会被拆成"文件"+"件夹"，
 * 直接输出就变成两个半截词（真实样本上就是这样）；拼起来才像话。
 */
export function pickTopics(text, limit = 6) {
  const freq = new Map()
  for (const tok of cjkTokens(String(text ?? ''))) {
    if (tok.length < 2) continue
    if (STOPWORDS.has(tok)) continue
    if (/^\d+$/.test(tok)) continue
    if (/^[a-z]{1,2}$/.test(tok)) continue
    if ([...tok].some((ch) => FUNC_CHARS.has(ch))) continue
    freq.set(tok, (freq.get(tok) || 0) + 1)
  }
  const cands = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const textLower = String(text ?? '').toLowerCase()
  const consumed = new Set()
  const merged = []
  for (const [tok, n] of cands) {
    if (consumed.has(tok)) continue
    consumed.add(tok)
    const steps = [tok]
    let score = n
    const minFreq = () => Math.max(2, n * 0.5)
    // 向右接（"文件" + "件夹"）
    for (let guard = 0; guard < 4 && steps[steps.length - 1].length < 7; guard += 1) {
      const term = steps[steps.length - 1]
      const next = cands.find(([t, k]) => !consumed.has(t) && t[0] === term[term.length - 1] && k >= minFreq())
      if (!next) break
      steps.push(term + next[0][1])
      consumed.add(next[0])
      score = Math.max(score, next[1])
    }
    // 再向左接（先被扫到的是后半截时，比如 "件夹" 先来）
    for (let guard = 0; guard < 4 && steps[steps.length - 1].length < 7; guard += 1) {
      const term = steps[steps.length - 1]
      const prev = cands.find(([t, k]) => !consumed.has(t) && t[t.length - 1] === term[0] && k >= minFreq())
      if (!prev) break
      steps.push(prev[0][0] + term)
      consumed.add(prev[0])
      score = Math.max(score, prev[1])
    }
    // ⚠️ 只认**原文里真的出现过**的拼接结果：不然会把"项目"+"目录"拼成"项目录"
    //    （真实样本上出现过这种假词）。从最长往回找第一个真出现的形态。
    let term = steps[0]
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (textLower.includes(steps[i].toLowerCase())) { term = steps[i]; break }
    }
    // 「反复出现的概念」就该真的反复出现：整词只出现一次的不要（否则会捞出"基本定理与谱定"这种半截长词）
    if (textLower.split(term.toLowerCase()).length - 1 < 2) continue
    merged.push([term, score])
  }
  merged.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const out = []
  for (const [term] of merged) {
    // 长词吞掉自己的碎片（"线性代数" 已经包含了 "线性"）
    if (out.some((o) => o.includes(term) || term.includes(o))) continue
    out.push(term)
    if (out.length >= limit) break
  }
  return out
}

/** 内容密度：每分钟多少字（用来判断这条视频是"讲透"还是"水"）。 */
export function densityOf(sentences, durationSec) {
  const chars = (Array.isArray(sentences) ? sentences : []).reduce((a, s) => a + String(s.text || '').length, 0)
  const minutes = Math.max(1, (Number(durationSec) || 0) / 60)
  return Math.round((chars / minutes) * 10) / 10
}

/**
 * 生成六个小节里的后五节（元信息由 notes.js 从 meta 渲染）。
 * @param {{meta:object, material:object, subtitleSource:'subtitle'|'fallback'|'none', durationSec:number, keywords?:string[]}} p
 */
export function buildNoteSections({ meta, material, subtitleSource, durationSec, keywords = [] }) {
  const out = []
  const hasSub = subtitleSource === 'subtitle'
  // 只有真读了字幕才写时间轴锚点；兜底路径的"要点"是从评论里捡的，没有可靠时间点
  const tsOf = (start) => (hasSub && Number.isFinite(Number(start)) ? fmtHms(start) : '')
  const tsSecOf = (start) => (hasSub && Number.isFinite(Number(start)) ? Math.round(Number(start)) : -1)

  for (const p of material?.points || []) {
    out.push({ section: SECTION_POINTS, body: p.text, ts: tsOf(p.start), tsSec: tsSecOf(p.start), tags: '' })
  }
  for (const a of material?.anchors || []) {
    out.push({ section: SECTION_TIMELINE, body: a.text, ts: tsOf(a.start), tsSec: tsSecOf(a.start), tags: '' })
  }
  for (const q of material?.quotes || []) {
    out.push({ section: SECTION_QUOTES, body: `> ${q.text}`, ts: tsOf(q.start), tsSec: tsSecOf(q.start), tags: '' })
  }

  const density = densityOf(material?.sentences || [], durationSec)
  const judge = []
  if (hasSub) {
    judge.push(`读了字幕原文：${material?.sentenceCount || 0} 句，内容密度约 ${density} 字/分钟。`)
    judge.push(`可靠性分 ${meta.score}/100（${meta.verdict}）—— 分数只看元数据，不代表内容对；判断依据见笔记底部。`)
    if (material?.topics?.length) judge.push(`反复出现的概念：${material.topics.slice(0, 4).join('、')}。`)
    judge.push('这一轮是自动抓取 + 启发式判读；要更细的结论，让模型读 `bili_study_subtitle` 原文后用 `bili_study_note add` 补。')
  } else if (subtitleSource === 'fallback') {
    judge.push('**这条视频没有可用的 ai-zh 字幕轨**，所以我不假装读过原文 —— 下面只有简介与评论里的信息。')
    judge.push(`可靠性分 ${meta.score}/100（${meta.verdict}）。`)
    if (meta.desc) judge.push(`简介（原文摘录，未改写）：${String(meta.desc).slice(0, 200)}`)
    judge.push('想真读一遍的话：先在设置页确认已登录 B站（没登录时字幕轨道恒为空），再手动跑 `bili_study_subtitle`。')
  } else {
    judge.push('没抓到任何素材（接口失败/视频不可见），这条先挂着，回头重试。')
  }
  out.push({ section: SECTION_JUDGMENT, body: judge.join('\n'), ts: '', tsSec: -1, tags: '' })

  const worth = []
  if (meta.score >= 80) worth.push('值得：分数很高，先看它。')
  else if (meta.score >= 65) worth.push('值得看一看，按复习阶梯排上了。')
  else if (meta.score >= 50) worth.push('可看可不看：分数一般，等复习日再决定。')
  else worth.push('不建议花时间：元数据像引流号。')
  if (hasSub && density >= 8) worth.push(`字幕密度 ${density} 字/分钟，是"讲透"的那一类。`)
  else if (hasSub && density < 3) worth.push(`字幕密度只有 ${density} 字/分钟，可能大半是演示/留白。`)
  if (!hasSub) worth.push('没有字幕原文，判断只能停在元数据层面，别当结论。')
  out.push({ section: SECTION_WORTH, body: worth.join(' '), ts: '', tsSec: -1, tags: '' })

  return out
}

/**
 * 「这串字像不像没提炼过的 ASR 原文」——中文里**紧贴/空格拼着**小写拉丁碎片
 * （`dB sk呢`、`新的fla`、`deep fw0V` 这类）就当成噪声。
 *
 * 为什么评论要用这么保守的判据：0.2.0 真机把 `今天是26年10月17日dB sk呢发布了一个新的fla`
 * 原样 @ 给用户了。评论是**对外发言**，宁可少发一条，也不许把听写噪声贴出去。
 * 模型提炼后的要点一般不会这样中英混贴；真被误杀，代价只是这一轮不评论。
 */
export function looksLikeAsrNoise(text) {
  const s = String(text ?? '')
  if (!s) return false
  if (/[\u4e00-\u9fff][A-Za-z]{2,}/.test(s)) return true      // 新的fla / 用GPT
  if (/[A-Za-z]{2,}[\u4e00-\u9fff]/.test(s)) return true      // sk呢 / DeepSeek模型
  if (/[A-Za-z]{1,3}\s+[A-Za-z]{1,3}(?=[\u4e00-\u9fff])/.test(s)) return true // dB sk呢
  if (/\d[A-Za-z]{2,}[\u4e00-\u9fff]/.test(s)) return true    // 17日dB呢 这类
  return false
}

/**
 * 「要 @ 谁」的兜底口径（0.2.1）。
 * - 手填了就用**原值**（绝不动用户填的字），只在与登录账号不一致时给提示；
 * - 没填就用登录账号 `credential.uname`；
 * - 都没有 → 没有名字，评论不发。
 * @param {{mentionName?:string, uname?:string}} p
 * @returns {{name:string, source:'config'|'credential'|'none', configured:string, login:string, mismatch:boolean, warn:string}}
 */
export function resolveMention({ mentionName = '', uname = '' } = {}) {
  const configured = String(mentionName ?? '').trim()
  const login = String(uname ?? '').trim()
  if (configured) {
    const mismatch = Boolean(login && configured !== login)
    return {
      name: configured,
      source: 'config',
      configured,
      login,
      mismatch,
      warn: mismatch ? `@ 名（${configured}）≠ 登录名（${login}），评论会 @ 错人` : '',
    }
  }
  if (login) {
    return { name: login, source: 'credential', configured: '', login, mismatch: false, warn: '' }
  }
  return {
    name: '',
    source: 'none',
    configured: '',
    login: '',
    mismatch: false,
    warn: '没有任何昵称可用：没填「要 @ 谁」，也没登录 B站',
  }
}

/**
 * 评论正文（短、干净、纯文本 @；不透露任何私人信息）。
 *
 * 🔴 0.2.1 铁律：文案**只能**来自 `refine === 'model'` 的「要点 / 金句」。
 *    · refine 缺失（excerpt/skipped/failed/off/unavailable）⇒ 返回 null，绝不拼摘句；
 *    · 金句必须在字幕原文里能回溯（复用 refine.js 的 `quoteInTranscript`），找不到就换要点；
 *    · 要点/金句里若还是混着 ASR 噪声（`dB sk呢` 这种）⇒ 丢掉；一个可用的都不剩 ⇒ 返回 null；
 *    · 不用 `topics`：那是启发式 bigram，本身就是从 ASR 原文里捞的，不是模型提炼物。
 *
 * @returns {string|null} null = 这一条不发评论
 */
export function composeComment({ mentionName, meta, material, bvid, refine, transcriptText = '' }) {
  const name = String(mentionName || '').trim()
  if (!name) return null
  if (String(refine || material?.source || '') !== 'model') return null

  const asText = (v) => String(typeof v === 'string' ? v : v?.text ?? '').trim()
  const points = (Array.isArray(material?.points) ? material.points : []).map(asText).filter(Boolean)
  const quotes = (Array.isArray(material?.quotes) ? material.quotes : [])
    .map((q) => asText(q).replace(/^>\s*/, '')).filter(Boolean)

  // 金句先过「能在字幕里回溯」+ 噪声两道；要点只需过噪声（要点本来就是模型改写过的话）。
  const quote = quotes.find((q) => !looksLikeAsrNoise(q)
    && (!transcriptText || quoteInTranscript(q, transcriptText)))
  const point = points.find((p) => !looksLikeAsrNoise(p))
  const said = quote || point
  if (!said) return null

  const kind = quote ? '讲得最实的一句是' : '讲得最实的一点是'
  const quoteOf = (n) => [...said].slice(0, n).join('')
  let text = `@${name} ${kind}「${quoteOf(28)}」，要点我记进笔记了（${bvid}）。`
  if ([...text].length > 140) text = `@${name} ${kind}「${quoteOf(16)}」，要点记进笔记了（${bvid}）。`
  if ([...text].length > 140 || looksLikeAsrNoise(text)) return null
  return text
}

/* ─────────────────────────── 一句话状态 ─────────────────────────── */

export function roundStatusText(result) {
  if (!result) return '还没跑过'
  const c = result.counts || {}
  const parts = [`候选 ${c.candidates ?? 0} 条`, `挑中 ${c.picked ?? 0} 条`]
  if (c.withSubtitle) parts.push(`${c.withSubtitle} 条读了字幕`)
  if (c.fallback) parts.push(`${c.fallback} 条走简介+评论兜底`)
  if (c.failed) parts.push(`${c.failed} 条没抓成`)
  if (c.refined) parts.push(`${c.refined} 条模型提炼`)
  if (c.refineFailed) parts.push(`${c.refineFailed} 条提炼失败`)
  if (c.due) parts.push(`今天该复习 ${c.due} 条`)
  if (result.comment?.posted) parts.push('评论 1 条')
  else if (result.comment?.skipped) parts.push('评论跳过（no refined content）')
  return parts.join(' · ')
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

/**
 * 跑一轮。
 * @param {{
 *   cfg: object, client: import('./bili-api.js').BiliClient, store: import('./notes.js').NoteStore,
 *   home: string, now?: Date, log?: Function, deadlineMs?: number,
 *   uname?: string,   // 登录账号昵称（来自 credential.uname）：mentionName 空值时兜底用
 *   refine?: {
 *     available:boolean, provider?:string, model?:string, reason?:string,
 *     call?: (p:{system:string,prompt:string,maxTokens:number})=>Promise<string>,
 *     dailyRemaining?: number,
 *   } | null,
 * }} p
 * @returns {Promise<object>} 一轮的结构化结果（报告 JSON 就是它）
 */
export async function runRound({ cfg, client, store, home, now = new Date(), log = () => {}, deadlineMs = 180000, refine = null, uname = '' }) {
  const startedAt = new Date()
  const today = dayKey(now)
  // 0.2.1：@ 名兜底（空值 → 登录账号；不一致只提示、不改用户填的值）
  const mention = resolveMention({ mentionName: cfg.mentionName, uname })
  const outDir = join(home, 'out')
  mkdirSync(outDir, { recursive: true })
  const keywords = (Array.isArray(cfg.keywords) ? cfg.keywords : []).map((k) => String(k).trim()).filter(Boolean)
  const pickKeywords = keywordPlan(keywords, today, 3)
  // P3：模型提炼的预算。三条闸：① 配置 refine 开没开 ② 宿主有没有模型 ③ 每轮/每天上限
  const refineWanted = cfg.refine === true
  const refinePerRound = Math.max(0, Math.min(Number(cfg.refinePerRound ?? REFINE_DEFAULT_PER_ROUND) || 0, 10))
  const refineMaxChars = Math.max(1000, Math.min(Number(cfg.refineMaxChars) || REFINE_DEFAULT_MAX_CHARS, 60000))
  const refineReady = refineWanted && Boolean(refine) && refine.available !== false && typeof refine.call === 'function'
  const dailyRemaining = refine && Number.isFinite(Number(refine.dailyRemaining))
    ? Math.max(0, Number(refine.dailyRemaining))
    : null
  const refineBudget = refineReady
    ? Math.min(refinePerRound, dailyRemaining === null ? refinePerRound : dailyRemaining)
    : 0
  const refineState = {
    enabled: refineWanted,
    available: refineReady,
    provider: String(refine?.provider || ''),
    model: String(refine?.model || ''),
    promptVersion: REFINE_PROMPT_VERSION,
    budget: refineBudget,
    calls: 0,
    failed: 0,
    skipped: 0,
    reason: !refineWanted
      ? 'refine 关着（走摘句兜底）'
      : !refine
        ? '这一轮没接模型（可改用 bili_study_digest 让外部 agent 写）'
        : refine.available === false
          ? String(refine.reason || '宿主没有可用模型')
          : refineBudget === 0
            ? '本轮提炼额度用完'
            : '',
  }
  const result = {
    date: today,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    keywords: pickKeywords,
    counts: {
      candidates: 0, scored: 0, picked: 0, withSubtitle: 0, fallback: 0, failed: 0, due: 0, commented: 0,
      refined: 0, refineFailed: 0, refineCalls: 0,
    },
    picked: [],
    due: [],
    comment: null,
    mention, // {name, source, configured, login, mismatch, warn}
    errors: [],
    refine: refineState,
    report: '',
    reportJson: '',
  }
  const deadline = Date.now() + Math.max(30000, Number(deadlineMs) || 180000)

  // 1) 搜 + 判分
  const candidates = []
  for (const kw of pickKeywords) {
    if (Date.now() > deadline) { result.errors.push('时间用完了，后面的关键词没搜'); break }
    try {
      const r = await client.search({ keyword: kw, order: 'pubdate', days: Number(cfg.days) || 7 })
      for (const it of r.items) {
        const sc = scoreVideo({
          title: it.title, desc: it.desc, play: it.play, like: it.like,
        })
        candidates.push({ ...it, keyword: kw, score: sc.score, verdict: sc.verdict, reasons: sc.reasons })
      }
      log(`[duty] 关键词「${kw}」拿到 ${r.items.length} 条（近 ${cfg.days || 7} 天）`)
    } catch (e) {
      result.errors.push(`搜「${kw}」失败：${e?.message ?? e}`)
      log(`[duty] 搜「${kw}」失败：${e?.message ?? e}`)
    }
  }
  result.counts.candidates = candidates.length

  // 2) 挑：够分 + 没看过 + 按分数
  //    ⚠️ 先去重：多个关键词会搜到同一条视频（实测第二次关键词必然重叠），不去重会"挑中两条一样的"
  const byBvid = new Map()
  for (const c of candidates) {
    const prev = byBvid.get(c.bvid)
    if (!prev || c.score > prev.score) byBvid.set(c.bvid, c)
  }
  const minScore = Number(cfg.minScore) || 0
  const fresh = [...byBvid.values()]
    .filter((c) => c.score >= minScore)
    .filter((c) => !store.hasSeen(c.bvid))
    .sort((a, b) => b.score - a.score || b.play - a.play)
  const perDay = Math.max(0, Math.min(Number(cfg.perDay) || 0, 10))
  const picks = fresh.slice(0, perDay)
  // 分数够但今天没名额的，记成 seen —— 否则明天又从头挑同样这几条
  for (const c of fresh.slice(perDay)) store.markSeen(c.bvid, c.keyword)
  result.counts.scored = candidates.length

  // 3) 每条：详情 → 字幕（含兜底）→ 写笔记
  //    字幕原文留一份在内存里，只给「评论金句回溯校验」用（不进报告、不落盘）
  const transcripts = new Map()
  for (const pick of picks) {
    if (Date.now() > deadline) { result.errors.push(`时间用完了，${pick.bvid} 没抓`); break }
    const item = {
      bvid: pick.bvid, title: pick.title, url: pick.url, score: pick.score, verdict: pick.verdict,
      subtitleSource: 'none', lang: '', notePath: '', pages: 0, lines: 0, topics: [], error: '',
    }
    try {
      const meta = await client.videoInfo(pick.bvid)
      // 详情里的分通常更高（能看到分P/时长），要一并重算并保留
      const rescored = scoreVideo({
        title: meta.title, desc: meta.desc, play: meta.play, like: meta.like,
        pageCount: meta.pageCount, avgPageSeconds: meta.avgPageSec, durationSeconds: meta.totalSec,
      })
      const subtitle = await fetchSubtitlesFor({ client, meta, cfg, log })
      item.subtitleSource = subtitle.source
      item.lang = subtitle.lang || ''
      item.pages = subtitle.pages || 0
      item.lines = subtitle.lines || 0
      if (subtitle.source === 'subtitle' && subtitle.rows?.length) {
        transcripts.set(pick.bvid, subtitle.rows.map((r) => String(r?.text ?? '').trim()).filter(Boolean).join('\n'))
      }
      // ⚠️ 详情页能算出的分比搜索页高（能看到分P/总时长），报告与笔记必须用同一个数，
      //    否则会出现「报告写 75 分、笔记里写 81 分」这种自相矛盾（联网冒烟时真撞到过）。
      item.score = rescored.score
      item.verdict = rescored.verdict

      let material
      if (subtitle.source === 'subtitle') {
        const sentences = sentencesFromRows(subtitle.rows)
        material = extractMaterial(sentences, { keywords: [pick.keyword, ...keywords] })
        material.sentences = sentences
      } else {
        material = extractMaterial([], { keywords: [pick.keyword] })
        if (subtitle.source === 'fallback') {
          material.points = (subtitle.comments || []).slice(0, 3).map((c) => ({ text: `评论区：${c.message}`, start: 0 }))
          material.topics = pickTopics(`${meta.title} ${meta.desc} ${(subtitle.comments || []).map((c) => c.message).join(' ')}`, 6)
        }
        material.sentences = []
      }
      item.topics = material.topics || []

      const baseSections = buildNoteSections({
        meta: { ...meta, score: rescored.score, verdict: rescored.verdict },
        material,
        subtitleSource: subtitle.source === 'subtitle' ? 'subtitle' : subtitle.source,
        durationSec: meta.totalSec,
        keywords: [pick.keyword],
      })

      /* ── P3：读到真字幕才提炼；失败就**保留摘句兜底**，绝不把笔记写坏 ── */
      let noteSections = baseSections
      let refineSource = 'excerpt'
      let refineInfo = null
      if (subtitle.source === 'subtitle') {
        if (!refineWanted) {
          refineSource = 'off'
        } else if (!refineReady) {
          refineSource = 'unavailable'
        } else if (refineState.calls >= refineBudget) {
          refineSource = 'skipped'
          refineState.skipped += 1
        } else {
          refineState.calls += 1
          result.counts.refineCalls += 1
          const rr = await runRefine({
            call: refine.call,
            model: `${refineState.provider}/${refineState.model}`.replace(/^\/|\/$/g, ''),
            video: {
              bvid: pick.bvid,
              title: meta.title,
              author: meta.author,
              url: meta.url,
              durationText: fmtDuration(meta.totalSec),
            },
            rows: subtitle.rows,
            keywords: [pick.keyword, ...keywords],
            maxChars: refineMaxChars,
            durationSec: meta.totalSec,
            log,
          })
          if (rr.ok) {
            refineSource = 'model'
            noteSections = mergeRefinedSections(baseSections, rr.sections)
            refineInfo = {
              source: 'model',
              provider: refineState.provider,
              model: refineState.model,
              promptVersion: REFINE_PROMPT_VERSION,
              at: new Date().toISOString(),
              ms: rr.ms,
              transcriptChars: rr.transcriptChars,
              transcriptTruncated: Boolean(rr.transcriptTruncated),
              warnings: Array.isArray(rr.warnings) ? rr.warnings.slice(0, 5) : [],
            }
            result.counts.refined += 1
            log(`[duty] ${pick.bvid} 模型提炼成功（${rr.ms}ms，${rr.transcriptChars} 字字幕）`)
          } else {
            refineSource = 'failed'
            refineInfo = {
              source: 'failed',
              provider: refineState.provider,
              model: refineState.model,
              promptVersion: REFINE_PROMPT_VERSION,
              at: new Date().toISOString(),
              error: String(rr.error || '未知错误').slice(0, 300),
              ms: rr.ms,
            }
            refineState.failed += 1
            result.counts.refineFailed += 1
            result.errors.push(`${pick.bvid} 模型提炼失败（已回退摘句）：${refineInfo.error.slice(0, 160)}`)
            log(`[duty] ${pick.bvid} 模型提炼失败，已回退摘句：${refineInfo.error}`)
          }
        }
      }
      item.refine = refineSource
      item.refineModel = refineInfo?.model ? `${refineInfo.provider}/${refineInfo.model}` : ''
      item.refineError = refineInfo?.error || ''

      const rec = store.upsertVideo({
        ...meta,
        score: rescored.score,
        verdict: rescored.verdict,
        reasons: rescored.reasons,
        topics: material.topics || [],
        subtitle: subtitle.metaForNote || null,
        refine: refineInfo || { source: refineSource === 'excerpt' ? 'excerpt' : refineSource, at: new Date().toISOString() },
      })
      for (const sec of noteSections) {
        store.addNote(pick.bvid, sec)
      }
      store.ensureReview(pick.bvid, today)
      item.notePath = store.saveRendered(pick.bvid)
      store.markSeen(pick.bvid, pick.keyword)
      if (subtitle.source === 'subtitle') result.counts.withSubtitle += 1
      else if (subtitle.source === 'fallback') result.counts.fallback += 1
      item.title = rec.title
    } catch (e) {
      item.error = String(e?.message ?? e)
      item.subtitleSource = 'none'
      result.counts.failed += 1
      result.errors.push(`${pick.bvid}：${item.error}`)
      log(`[duty] ${pick.bvid} 没抓成：${item.error}`)
      store.markSeen(pick.bvid, pick.keyword) // 失败的也记下，免得每轮都撞同一条
    }
    result.picked.push(item)
  }
  result.counts.picked = result.picked.length
  store.save()

  // 4) 今天的复习清单
  result.due = store.due(today, 20)
  result.counts.due = result.due.length

  // 5) 评论（默认关；每轮最多一条；同视频不重复；只引用模型提炼过的内容）
  result.comment = await maybeComment({ cfg, client, store, result, today, log, mention, transcripts })

  // 6) 出报告
  result.finishedAt = new Date().toISOString()
  const mdPath = join(outDir, `${today}.md`)
  const jsonPath = join(outDir, `${today}.json`)
  result.report = mdPath
  result.reportJson = jsonPath
  writeFileSync(mdPath, buildReportMarkdown(result, store), 'utf8')
  writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n', 'utf8')
  return result
}

/** 关键词按天轮转（每天挑 3 个，避免每轮都只搜第一个词）。 */
export function keywordPlan(keywords, day, n = 3) {
  const list = (Array.isArray(keywords) ? keywords : []).filter(Boolean)
  if (list.length <= n) return list
  const seed = Number(String(day).replace(/-/g, '')) || 0
  const start = seed % list.length
  const out = []
  for (let i = 0; i < n; i += 1) out.push(list[(start + i) % list.length])
  return out
}

/**
 * 抓一条视频的字幕；抓不到就如实返回 fallback/none（**不硬凑**）。
 * @returns {Promise<{source:'subtitle'|'fallback'|'none', lang?:string, rows?:object[], pages?:number, lines?:number, comments?:object[], metaForNote?:object}>}
 */
export async function fetchSubtitlesFor({ client, meta, cfg, log = () => {} }) {
  const maxPages = Math.max(1, Math.min(Number(cfg.maxPages) || 1, 10))
  const pages = (meta.pages || []).slice(0, maxPages)
  const allRows = []
  let lang = ''
  let triedNeedLogin = false
  // ⚠️ B站 的字幕时间戳是**每个分P 各自从 0 开始**的。多个分P 拼成一条时间轴时必须加偏移，
  //    否则「时间轴锚点」会出现时间倒退（单测里踩到过）。
  let offsetSec = 0
  for (const p of pages) {
    const pageDuration = Number(p?.durationSec) || 0
    if (!p?.cid) { offsetSec += pageDuration; continue }
    try {
      const got = await client.pickSubtitle(meta.bvid, p.cid, [cfg.subtitleLang || 'ai-zh', 'zh-CN', 'zh-Hans', 'ai-en'])
      if (got?.needLogin) triedNeedLogin = true
      if (got?.rows?.length) {
        lang = got.lang || lang
        allRows.push(...got.rows.map((r) => ({ ...r, start: r.start + offsetSec, end: (r.end || r.start) + offsetSec, page: p.page, part: p.part })))
      }
    } catch (e) {
      log(`[duty] ${meta.bvid} P${p.page} 取字幕失败：${e?.message ?? e}`)
    }
    offsetSec += pageDuration
  }
  if (allRows.length) {
    const chars = allRows.reduce((a, r) => a + String(r.text || '').length, 0)
    return {
      source: 'subtitle',
      lang: lang || cfg.subtitleLang || 'ai-zh',
      rows: allRows,
      pages: new Set(allRows.map((r) => r.page)).size,
      lines: allRows.length,
      metaForNote: {
        source: 'subtitle', lang: lang || cfg.subtitleLang || 'ai-zh',
        pages: new Set(allRows.map((r) => r.page)).size, lines: allRows.length, chars,
      },
    }
  }

  // —— 兜底：简介 + 评论（**并如实标注**没有 ai-zh 轨道）——
  let comments = []
  try {
    comments = await client.comments({ aid: meta.aid, num: 8 })
  } catch (e) {
    log(`[duty] ${meta.bvid} 评论也没取到：${e?.message ?? e}`)
  }
  const hasAnyMaterial = Boolean(meta.desc) || comments.length > 0
  return {
    source: hasAnyMaterial ? 'fallback' : 'none',
    lang: '',
    rows: [],
    pages: 0,
    lines: 0,
    comments,
    needLogin: triedNeedLogin,
    metaForNote: {
      source: hasAnyMaterial ? 'fallback' : 'none',
      lang: '',
      pages: 0,
      lines: 0,
      chars: 0,
      note: triedNeedLogin ? '未登录时 B站 不返回字幕轨道（need_login_subtitle=true）' : '这条视频没有 ai-zh 字幕轨',
    },
  }
}

/**
 * 评论：默认关、每轮最多一条、同视频不重复 @，
 * 🔴 并且**只引用模型提炼过（source:model）的要点/金句**；这一轮 refine 被跳过/失败就整条不发。
 */
async function maybeComment({ cfg, client, store, result, today, log, mention = null, transcripts = new Map() }) {
  const who = mention || resolveMention({ mentionName: cfg.mentionName })
  const base = { mention: who }
  const skippedNoRefined = () => ({
    posted: false,
    skipped: true,
    reason: 'skipped (no refined content)',
    ...base,
  })

  if (!cfg.autoComment) return { posted: false, ...base, why: '自动评论关着（设置页可开）' }
  if (!who.name) return { posted: false, ...base, why: who.warn || '没有可用的 @ 昵称' }
  const cap = Math.max(1, Math.min(Number(cfg.commentPerRound) || 1, 3))
  const logRows = Array.isArray(store.lib.commentLog) ? store.lib.commentLog : []
  const todayCount = logRows.filter((r) => String(r.at || '').startsWith(today)).length
  if (todayCount >= cap) return { posted: false, ...base, why: `今天已经发过 ${todayCount} 条（上限 ${cap}）` }
  const minScore = Number(cfg.commentMinScore) || 65
  const eligible = result.picked.filter((p) => p.subtitleSource === 'subtitle' && p.score >= minScore && !p.error)
  if (!eligible.length) return { posted: false, ...base, why: `这一轮没有够分（>=${minScore}）且读到字幕的条目` }
  // 🔴 0.2.1：只有本轮的「模型提炼成功」条目才有评论资格。refine skipped/failed/off/unavailable/excerpt
  //    一律跳过 —— 评论绝不引用未提炼的 ASR 原文（0.2.0 真机把 `dB sk呢` 发出去过）。
  const target = eligible.find((p) => p.refine === 'model')
  if (!target) {
    const why = `${'skipped (no refined content)'}：这一轮 ${eligible.length} 条读到了字幕，但模型提炼被跳过/失败/关闭（refined=0），不拿 ASR 原文发评论`
    log(`[duty] ${why}`)
    return { ...skippedNoRefined(), why }
  }
  const rec = store.video(target.bvid)
  if (rec?.commented) return { posted: false, ...base, why: '这条视频已经 @ 过一次了' }
  // 笔记里只认带 `source:model` 标签的要点/金句；摘句兜底、外部 agent 写的一律不进评论
  const modelNotes = store.notesOf(target.bvid).filter((n) => String(n.tags || '').includes('source:model'))
  const material = {
    points: modelNotes.filter((n) => n.section === SECTION_POINTS).map((n) => ({ text: n.body })),
    quotes: modelNotes.filter((n) => n.section === SECTION_QUOTES).map((n) => ({ text: String(n.body).replace(/^>\s*/, '') })),
  }
  const text = composeComment({
    mentionName: who.name,
    meta: rec || target,
    material,
    bvid: target.bvid,
    refine: target.refine,
    transcriptText: transcripts.get(target.bvid) || '',
  })
  if (!text) {
    const why = 'skipped (no refined content)：模型提炼的要点/金句里没有能安全引用的内容（疑似 ASR 原文），整条不发'
    log(`[duty] ${why}（${target.bvid}）`)
    return { ...skippedNoRefined(), why }
  }
  try {
    const aid = rec?.aid || 0
    if (!aid) throw new Error('拿不到 aid，发不了评论')
    const r = await client.sendComment({ aid, message: text, bvid: target.bvid })
    if (rec) { rec.commented = { at: new Date().toISOString(), rpid: r.rpid }; }
    store.lib.commentLog = [...logRows, { bvid: target.bvid, at: new Date().toISOString(), rpid: r.rpid }]
    store.save()
    result.counts.commented = 1
    log(`[duty] 已评论 @${who.name}：${target.bvid} rpid=${r.rpid}`)
    return { posted: true, bvid: target.bvid, rpid: r.rpid, text, mention: who, onlyRefined: true }
  } catch (e) {
    log(`[duty] 评论失败：${e?.message ?? e}`)
    return { posted: false, ...base, why: `评论没发出去：${e?.message ?? e}` }
  }
}

/* ─────────────────────────── 报告 ─────────────────────────── */

export function buildReportMarkdown(result, store) {
  const L = []
  const c = result.counts || {}
  L.push(`# 今天的 B站 学习报告 · ${result.date}`, '')
  L.push(`> ${roundStatusText(result)}。`)
  L.push('')
  if (result.errors?.length) {
    L.push('**这一轮的小故障**（不影响别的条目）：')
    for (const e of result.errors.slice(0, 8)) L.push(`- ${e}`)
    L.push('')
  }
  if (!result.picked?.length) {
    L.push('这一轮没挑到新东西（候选都不够分、或者都看过了）。')
    L.push('')
  }
  result.picked.forEach((p, i) => {
    L.push(`## ${i + 1}. ${p.title || p.bvid}（可靠性 ${p.score}/100 ${p.verdict || ''}）`)
    L.push('')
    const rec = store?.video?.(p.bvid) || null
    const bits = [`[${p.bvid}](${p.url})`]
    if (rec?.author) bits.push(`UP ${rec.author}`)
    if (rec?.play) bits.push(`播放 ${fmtCount(rec.play)}`)
    if (rec?.durationSec) bits.push(`时长 ${fmtDuration(rec.durationSec)}`)
    if (rec?.pubdateText) bits.push(`发布 ${rec.pubdateText}`)
    L.push(`- ${bits.join(' · ')}`)
    if (p.subtitleSource === 'subtitle') L.push(`- 素材：**读了字幕原文**（${p.lang}，${p.lines} 条 / ${p.pages} 个分P）`)
    else if (p.subtitleSource === 'fallback') L.push('- 素材：**没有可用 ai-zh 字幕轨** → 只用简介 + 评论兜底（没有假装读过原文）')
    else if (p.error) L.push(`- 素材：没抓成 —— ${p.error}`)
    else L.push('- 素材：什么都没抓到')
    if (p.refine === 'model') L.push(`- 提炼：**模型**（${p.refineModel || '宿主模型'}）`)
    else if (p.refine === 'failed') L.push(`- 提炼：模型失败 → 已回退摘句兜底（${String(p.refineError || '').slice(0, 120)}）`)
    else if (p.refine === 'unavailable') L.push('- 提炼：宿主没有可用模型 → 摘句兜底（可用 `bili_study_digest` 让外部 agent 写）')
    else if (p.refine === 'skipped') L.push('- 提炼：本轮模型额度用完 → 摘句兜底')
    else if (p.refine === 'off') L.push('- 提炼：关着（摘句兜底）')
    if (p.topics?.length) L.push(`- 反复出现的概念：${p.topics.join('、')}`)
    if (p.notePath) L.push(`- 笔记：\`${p.notePath}\``)
    L.push('')
    for (const sec of [SECTION_POINTS, SECTION_TIMELINE, SECTION_QUOTES]) {
      const items = (store?.notesOf?.(p.bvid) || []).filter((n) => n.section === sec)
      if (!items.length) continue
      L.push(`**${sec}**`)
      for (const n of items.slice(0, 6)) {
        if (sec === SECTION_QUOTES) L.push(`- ${n.ts ? `[${n.ts}] ` : ''}${String(n.body).replace(/^>\s*/, '「')}${String(n.body).startsWith('>') ? '」' : ''}`)
        else L.push(`- ${n.ts ? `[${n.ts}] ` : ''}${n.body}`)
      }
      L.push('')
    }
    const j = (store?.notesOf?.(p.bvid) || []).find((n) => n.section === SECTION_JUDGMENT)
    if (j) { L.push(`**我的判断**：${j.body.split('\n')[0]}`); L.push('') }
  })

  if (result.due?.length) {
    L.push('## 今天该复习')
    L.push('')
    for (const d of result.due.slice(0, 10)) {
      L.push(`- [${d.bvid}](${d.url}) ${d.title} —— 应复习日 ${d.nextReview}${d.overdueDays ? `（逾期 ${d.overdueDays} 天）` : ''}`)
    }
    L.push('')
    L.push('复习完用 `bili_study_review` 传 `action=grade` 打个分（good/hard/easy/again），日期会自动往后推。')
    L.push('')
  } else {
    L.push('## 今天没有要复习的')
    L.push('')
  }

  L.push('## 这一轮的评论')
  L.push('')
  if (result.comment?.posted) L.push(`- 发了 1 条：${result.comment.text}（rpid ${result.comment.rpid}）`)
  else if (result.comment?.skipped) L.push(`- **跳过发评论**：${result.comment.why}`)
  else L.push(`- 没发（${result.comment?.why || '未开启'}）`)
  if (result.comment?.mention?.warn && result.comment.mention.mismatch) L.push(`- ⚠️ ${result.comment.mention.warn}`)
  L.push('')
  L.push('---')
  L.push(`数据：搜索关键词 ${(result.keywords || []).join('、') || '—'}；候选 ${c.candidates || 0} 条；落笔记 ${c.picked || 0} 条；`
    + `读原文 ${c.withSubtitle || 0} 条、兜底 ${c.fallback || 0} 条、失败 ${c.failed || 0} 条。`)
  if (result.refine) {
    const r = result.refine
    L.push(`提炼：模型 ${c.refined || 0} 条、失败 ${c.refineFailed || 0} 条、调用 ${c.refineCalls || 0} 次`
      + `（${r.available ? `${r.provider}/${r.model}` : `不可用：${r.reason || '—'}`}；每轮上限 ${r.budget ?? 0} 条）。`)
  }
  L.push('')
  L.push('说明：可靠性分是**元数据层面**的可信度提示（标题/简介/播放点赞/分P），不等于内容正确性；')
  L.push('没拿到字幕的条目只做了简介+评论兜底，**没有**声称读过原文。')
  L.push('模型提炼会纠正 ASR 明显听错的词、不确定处标「可能是…」，且**不许**补字幕里没有的事实；')
  L.push('金句要能在字幕原文里找到，找不到的会被丢掉。')
  L.push('评论只能引用**模型提炼过**的要点/金句；这一轮 refine 被跳过/失败（refined=0）就整条不发，宁可少发。')
  return L.join('\n') + '\n'
}
