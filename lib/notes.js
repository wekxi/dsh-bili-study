/**
 * lib/notes.js —— 学习笔记库（JSON 文件 + 内存 bigram 检索 + 遗忘曲线复习）
 * ============================================================================
 * 为什么是 JSON 而不是 SQLite：手机（DSHA / Linux arm64）上 `better-sqlite3` 这类
 * 编译型依赖基本装不上，`node:sqlite` 在宿主上还是实验特性、跨版本不稳。
 * 笔记量级是"几百条视频"这个数，整库读进内存做 bigram 检索完全够，而且**零依赖**。
 *
 * 真身只有一个文件：`<家>/notes/library.json`（原子写）。
 * `<家>/notes/<BV号>.md` 是**渲染视图**（给人看/给下一个 AI 看），由本模块重新生成 ——
 * 改笔记请用 `bili_study_note add`，别手改 .md（跟 Python 版同一个纪律）。
 *
 * 六个小节（顺序固定，UI 与工具都依赖这个顺序）：
 *   视频元信息 / 要点 / 时间轴锚点 / 金句 / 我的判断 / 值不值得再看
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addDays, dayKey, readJson, writeJsonAtomic } from './state.js'

export const META_SECTION = '视频元信息'
export const SECTION_POINTS = '要点'
export const SECTION_TIMELINE = '时间轴锚点'
export const SECTION_QUOTES = '金句'
export const SECTION_JUDGMENT = '我的判断'
export const SECTION_WORTH = '值不值得再看'
/** 渲染顺序（`其它` 永远排最后）。 */
export const SECTIONS = [SECTION_POINTS, SECTION_TIMELINE, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH]

/** 复习阶梯：1/3/7/16/35 天，之后按 ease 乘法推进（与 Python 版一致，改之前先读 README）。 */
export const LADDER = [1, 3, 7, 16, 35]
export const LIBRARY_FILE = 'library.json'
export const NOTES_DIR = 'notes'
export const SUBS_DIR = 'subs'

/* ─────────────────────────── 日期/取整小工具 ─────────────────────────── */

/**
 * Python 的 round 是 half-even，JS 的 Math.round 是 half-up —— 复习间隔要用前者的口径。
 * 实现走 Intl 的 roundingMode='halfEven'：**按十进制显示值**做银行家舍入。
 * （Python 是按 double 的精确二进制值舍入；两者只在"十进制 .5 但二进制不精确"的罕见值上差一位，
 *   比如 1.15：这里给 1.2，Python round(1.15,1) 给 1.1。复习间隔/播放量这类值都不会踩到。）
 * 别自己 `x*10` 再取整：浮点乘会把 1.15 变成 11.5，那连"十进制"都算不对。
 */
const halfEvenCache = new Map()
export function roundHalfEven(x, digits = 0) {
  const v = Number(x)
  if (!Number.isFinite(v)) return NaN
  let nf = halfEvenCache.get(digits)
  if (nf === undefined) {
    try {
      nf = new Intl.NumberFormat('en-US', {
        useGrouping: false,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        roundingMode: 'halfEven',
      })
    } catch { nf = null }
    halfEvenCache.set(digits, nf)
  }
  if (nf) return Number(nf.format(v))
  const scale = 10 ** digits
  const scaled = v * scale
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const n = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : (floor % 2 === 0 ? floor : floor + 1)
  return n / scale
}

/* ─────────────────────────── 中文分词（bigram） ─────────────────────────── */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const WORD_RE = /[0-9A-Za-z_][0-9A-Za-z_\-.]*/g

export const STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '就是', '然后', '所以', '因为', '但是', '可以', '一个',
  '什么', '怎么', '这样', '那样', '没有', '不是', '这些', '那些', '现在', '其实', '非常', '真的',
  '一下', '时候', '东西', '问题', '地方', '这里', '那里', '知道', '觉得', '如果', '还是', '已经',
  '大家', '今天', '对吧', '的话', '这种', '一点', '一些', '方面', '情况', '内容', '部分', '方式',
])

/**
 * 中文 bigram 分词（FTS 口径的移植版）。
 * 为什么非要切 bigram：整串汉字当一个 token 时，"跨视频检索"这条笔记用"检索"两个字永远搜不到；
 * 切成 bigram 后 "跨视频检索"→"跨视 视频 频检 检索"，查 "视频检索"→"视频 频检 检索"，三个都命中。
 */
export function cjkTokens(text) {
  const s = String(text ?? '')
  const out = []
  let pos = 0
  CJK_RE.lastIndex = 0
  let m
  while ((m = CJK_RE.exec(s)) !== null) {
    for (const w of s.slice(pos, m.index).match(WORD_RE) || []) out.push(w.toLowerCase())
    const seg = m[0]
    if (seg.length === 1) out.push(seg)
    else for (let i = 0; i < seg.length - 1; i += 1) out.push(seg.slice(i, i + 2))
    pos = m.index + seg.length
  }
  for (const w of s.slice(pos).match(WORD_RE) || []) out.push(w.toLowerCase())
  return out
}

/** 查询词 → 去重后的 token（去掉停用词与单字噪声；英文保留）。 */
export function queryTokens(query) {
  const seen = new Set()
  const out = []
  for (const t of cjkTokens(query)) {
    if (!t || STOPWORDS.has(t)) continue
    if (t.length === 1 && !/[0-9A-Za-z]/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/* ─────────────────────────── 笔记库 ─────────────────────────── */

function emptyLibrary() {
  return { version: 1, updatedAt: new Date().toISOString(), videos: {}, seen: {} }
}

export class NoteStore {
  /** @param {string} home 插件家目录 */
  constructor(home) {
    this.home = home
    this.dir = join(home, NOTES_DIR)
    this.subsDir = join(home, SUBS_DIR)
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(this.subsDir, { recursive: true })
    this.file = join(this.dir, LIBRARY_FILE)
    this.lib = emptyLibrary()
    this._dirty = false
    this.load()
  }

  load() {
    const raw = readJson(this.file, null)
    if (!raw || typeof raw !== 'object' || !raw.videos || typeof raw.videos !== 'object') {
      this.lib = emptyLibrary()
    } else {
      this.lib = { ...emptyLibrary(), ...raw, videos: raw.videos, seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {} }
    }
    return this
  }

  save() {
    this.lib.updatedAt = new Date().toISOString()
    writeJsonAtomic(this.file, this.lib)
    this._dirty = false
    return this
  }

  /** 有没有这条视频的笔记。 */
  has(bvid) {
    return Boolean(this.lib.videos[bvid])
  }

  video(bvid) {
    return this.lib.videos[bvid] || null
  }

  listVideos() {
    return Object.values(this.lib.videos).sort((a, b) => String(b.learnedAt || '').localeCompare(String(a.learnedAt || '')))
  }

  /**
   * 建/更新一条视频的元信息（保留已有笔记与复习状态）。
   * @returns {object} 这条视频的完整记录
   */
  upsertVideo(meta) {
    const bvid = meta?.bvid
    if (!bvid) throw new Error('upsertVideo 需要 bvid')
    const now = new Date().toISOString()
    const prev = this.lib.videos[bvid]
    const rec = {
      bvid,
      aid: Number(meta.aid) || prev?.aid || 0,
      title: meta.title || prev?.title || bvid,
      author: meta.author || prev?.author || '',
      mid: Number(meta.mid) || prev?.mid || 0,
      pubdate: meta.pubdate || prev?.pubdate || 0,
      pubdateText: meta.pubdateText || prev?.pubdateText || '',
      durationSec: Number(meta.durationSec) || prev?.durationSec || 0,
      url: meta.url || prev?.url || `https://www.bilibili.com/video/${bvid}`,
      desc: meta.desc !== undefined ? meta.desc : prev?.desc || '',
      tname: meta.tname || prev?.tname || '',
      score: Number.isFinite(Number(meta.score)) ? Number(meta.score) : prev?.score ?? -1,
      verdict: meta.verdict || prev?.verdict || '',
      reasons: Array.isArray(meta.reasons) ? meta.reasons : prev?.reasons || [],
      play: Number(meta.play) || prev?.play || 0,
      like: Number(meta.like) || prev?.like || 0,
      pageCount: Number(meta.pageCount) || prev?.pageCount || 0,
      topics: Array.isArray(meta.topics) ? meta.topics : prev?.topics || [],
      learnedAt: prev?.learnedAt || dayKey(),
      updatedAt: now,
      subtitle: meta.subtitle || prev?.subtitle || null,
      // P3：这条笔记的四节是模型写的还是摘句兜底（{source:'model'|'failed'|'excerpt'…}）
      refine: meta.refine || prev?.refine || null,
      notes: prev?.notes || [],
      review: prev?.review || null,
      commented: prev?.commented || null,
    }
    this.lib.videos[bvid] = rec
    this._dirty = true
    return rec
  }

  /**
   * 加一条笔记。
   * @param {string} bvid
   * @param {{section:string, body:string, ts?:string, tsSec?:number, tags?:string}} n
   */
  addNote(bvid, { section, body, ts = '', tsSec = -1, tags = '' }) {
    const rec = this.lib.videos[bvid]
    if (!rec) throw new Error(`还没有 ${bvid} 这条视频的笔记壳子：先用 action=new 建一下`)
    const text = String(body ?? '').trim()
    if (!text) throw new Error('正文是空的，不记')
    const sec = String(section || '').trim() || SECTION_POINTS
    const id = rec.notes.reduce((a, n) => Math.max(a, Number(n.id) || 0), 0) + 1
    rec.notes.push({
      id,
      section: sec,
      body: text,
      ts: String(ts || '').trim(),
      tsSec: Number.isFinite(Number(tsSec)) ? Number(tsSec) : -1,
      tags: String(tags || '').trim(),
      created: new Date().toISOString(),
    })
    rec.updatedAt = new Date().toISOString()
    this._dirty = true
    return rec.notes[rec.notes.length - 1]
  }

  notesOf(bvid) {
    const rec = this.lib.videos[bvid]
    if (!rec) return []
    return [...rec.notes].sort((a, b) => {
      const aHas = a.tsSec >= 0, bHas = b.tsSec >= 0
      if (aHas !== bHas) return aHas ? -1 : 1
      if (aHas && a.tsSec !== b.tsSec) return a.tsSec - b.tsSec
      return a.id - b.id
    })
  }

  /**
   * 标记这条笔记的四节是谁写的：model（插件直调）/ agent（外部 agent 按 digest 写）/
   * failed / excerpt / skipped…（P3 两条路都要能看出处）。
   */
  markRefine(bvid, info = {}) {
    const rec = this.lib.videos[bvid]
    if (!rec) return null
    const prev = rec.refine && typeof rec.refine === 'object' ? rec.refine : {}
    rec.refine = { ...prev, ...info, at: info.at || new Date().toISOString() }
    rec.updatedAt = new Date().toISOString()
    this._dirty = true
    return rec.refine
  }

  /* ───────────── 复习（1/3/7/16/35 天阶梯 + ease 微调） ───────────── */

  ensureReview(bvid, today = dayKey()) {
    const rec = this.lib.videos[bvid]
    if (!rec) throw new Error(`没有 ${bvid} 的笔记，先建笔记再排复习`)
    if (!rec.review) {
      rec.review = { nextReview: addDays(today, 1), intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, lastReview: '', lastGrade: '' }
      this._dirty = true
    }
    return rec.review
  }

  /** 今天（含逾期）该复习哪些。 */
  due(today = dayKey(), limit = 20) {
    return this.listVideos()
      .filter((v) => v.review && v.review.nextReview && v.review.nextReview <= today)
      .sort((a, b) => String(a.review.nextReview).localeCompare(String(b.review.nextReview)))
      .slice(0, Math.max(1, Number(limit) || 20))
      .map((v) => ({
        bvid: v.bvid,
        title: v.title,
        url: v.url,
        nextReview: v.review.nextReview,
        intervalDays: v.review.intervalDays,
        reps: v.review.reps,
        ease: v.review.ease,
        overdueDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${v.review.nextReview}T00:00:00`)) / 86400000)),
        score: v.score,
      }))
  }

  /**
   * 评一次分 → 下一次复习日期。
   * 曲线（与 README / prompts/duty.md 写死的同一条，别只改一边）：
   *   good → 踩阶梯 LADDER[reps-1]（1/3/7/16/35 天），超出阶梯后 base*ease
   *   easy → 阶梯档 × 1.3（最多 60 天）
   *   hard → 阶梯档 × 0.8（至少 1 天；ease 下调 0.15）
   *   again→ 当天再来（reps 清零、lapses+1、ease 下调 0.2）
   */
  grade(bvid, grade, today = dayKey()) {
    const g = ['good', 'hard', 'easy', 'again'].includes(grade) ? grade : 'good'
    const rv = this.ensureReview(bvid, today)
    let reps = Number(rv.reps) || 0
    let ease = Number(rv.ease) || 2.5
    let lapses = Number(rv.lapses) || 0
    const base = Number(rv.intervalDays) || 0
    let interval
    if (g === 'again') {
      reps = 0
      lapses += 1
      ease = Math.max(1.3, ease - 0.2)
      interval = 0
    } else {
      if (g === 'hard') ease = Math.max(1.3, ease - 0.15)
      else if (g === 'easy') ease = Math.min(3.0, ease + 0.1)
      reps += 1
      const idx = reps - 1
      const step = idx < LADDER.length ? LADDER[idx] : Math.max(1, base) * ease
      if (g === 'hard') interval = Math.max(1, step * 0.8)
      else if (g === 'easy') interval = Math.min(60, step * 1.3)
      else interval = step
    }
    interval = roundHalfEven(interval, 2)
    const nextReview = interval < 1 ? today : addDays(today, Math.max(1, roundHalfEven(interval, 0)))
    rv.intervalDays = interval
    rv.ease = Math.round(ease * 100) / 100
    rv.reps = reps
    rv.lapses = lapses
    rv.lastReview = today
    rv.lastGrade = g
    rv.nextReview = nextReview
    this._dirty = true
    return { bvid, grade: g, intervalDays: interval, nextReview, reps, ease: rv.ease, lapses }
  }

  /* ───────────── 跨视频检索（bigram + BM25-lite） ───────────── */

  /** 把整库摊成"可检索文档"：一条笔记一个文档（标题/小节/标签/正文都算）。 */
  _docs() {
    const docs = []
    for (const v of Object.values(this.lib.videos)) {
      for (const n of v.notes) {
        docs.push({ video: v, note: n })
      }
    }
    return docs
  }

  /**
   * 在自己的笔记里检索（不是去公网搜视频！）。
   * @param {{query:string, limit?:number, bvid?:string, section?:string, tag?:string}} q
   */
  find(q) {
    const query = String(q?.query ?? '').trim()
    if (!query) throw new Error('检索词是空的：给个词（比如「渐进式披露」）再搜')
    const tokens = queryTokens(query)
    if (!tokens.length) return []
    let docs = this._docs()
    if (q.bvid) docs = docs.filter((d) => d.video.bvid === q.bvid)
    if (q.section) docs = docs.filter((d) => d.note.section === q.section)
    if (q.tag) docs = docs.filter((d) => String(d.note.tags || '').includes(q.tag))

    const prepared = docs.map((d) => {
      const body = `${d.note.body}`
      const tf = new Map()
      for (const t of cjkTokens(`${d.video.title} ${d.note.section} ${d.note.tags} ${body}`)) {
        tf.set(t, (tf.get(t) || 0) + 1)
      }
      return { ...d, tf, len: body.length, body }
    })
    const N = prepared.length || 1
    const avgLen = prepared.reduce((a, d) => a + d.len, 0) / N || 1
    const df = new Map()
    for (const t of tokens) {
      df.set(t, prepared.reduce((a, d) => a + (d.tf.has(t) ? 1 : 0), 0))
    }
    const k1 = 1.2, b = 0.75
    const results = []
    for (const d of prepared) {
      let s = 0
      for (const t of tokens) {
        const f = d.tf.get(t) || 0
        if (!f) continue
        const n = df.get(t) || 0
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)))
      }
      if (!s) continue
      const lowerBody = d.body.toLowerCase()
      const lowerTitle = String(d.video.title || '').toLowerCase()
      if (lowerBody.includes(query.toLowerCase())) s += 3            // 整串命中，明显更相关
      if (lowerTitle.includes(query.toLowerCase())) s += 2
      results.push({
        bvid: d.video.bvid,
        title: d.video.title,
        url: d.video.url,
        learnedAt: d.video.learnedAt,
        section: d.note.section,
        body: d.note.body,
        ts: d.note.ts,
        tags: d.note.tags,
        noteId: d.note.id,
        score: Math.round(s * 1000) / 1000,
        snippet: snippetOf(d.note.body, query, tokens),
      })
    }
    results.sort((a, b2) => b2.score - a.score)
    return results.slice(0, Math.max(1, Number(q.limit) || 10))
  }

  /* ───────────── 判重（每日一轮用） ───────────── */

  hasSeen(bvid) {
    return Boolean(this.lib.seen?.[bvid] || this.lib.videos?.[bvid])
  }

  markSeen(bvid, keyword = '') {
    this.lib.seen = this.lib.seen || {}
    this.lib.seen[bvid] = { at: new Date().toISOString(), keyword }
    this._dirty = true
  }

  /* ───────────── 渲染（library.json → .md） ───────────── */

  renderMarkdown(bvid) {
    const v = this.video(bvid)
    if (!v) return ''
    const L = []
    L.push(`# ${v.title || bvid}`, '')
    L.push('| 项 | 值 |')
    L.push('|---|---|')
    L.push(`| BV号 | [${bvid}](${v.url || `https://www.bilibili.com/video/${bvid}`}) |`)
    const meta = []
    if (v.author) meta.push(`UP主 ${v.author}`)
    if (v.pubdateText) meta.push(`发布 ${v.pubdateText}`)
    if (v.durationSec) meta.push(`时长 ${fmtHms(v.durationSec)}`)
    if (Number(v.score) >= 0) meta.push(`可靠性分 ${v.score}/100 ${v.verdict || ''}`.trim())
    if (meta.length) L.push(`| 元信息 | ${meta.join(' · ')} |`)
    L.push(`| 学习日期 | ${v.learnedAt || ''} |`)
    if (v.topics?.length) L.push(`| 知识点 | ${v.topics.join(' · ')} |`)
    if (v.review) L.push(`| 下次复习 | ${v.review.nextReview || '—'}（已复习 ${v.review.reps || 0} 次） |`)
    if (v.subtitle) {
      const src = v.subtitle.source === 'ai-zh' || v.subtitle.lang
        ? `字幕 ${v.subtitle.lang || '未知轨道'}`
        : v.subtitle.source === 'fallback'
          ? '**没有可用字幕**，本笔记只用简介 + 评论兜底'
          : '无字幕'
      const where = v.subtitle.file ? ` \`${v.subtitle.file}\`` : ''
      L.push(`| 素材 | ${src}${where}（${v.subtitle.lines || 0} 条 / ${v.subtitle.pages || 0} 个分P） |`)
    }
    if (v.refine) {
      // 手机上要一眼看出「这条是模型读出来的，还是摘句兜底」
      const r = v.refine
      let label
      if (r.source === 'model') label = `模型提炼（${String(r.model || '').replace(/\|/g, '/') || '宿主模型'}）`
      else if (r.source === 'agent') label = `外部 agent 按 digest 提炼（${String(r.model || '未标注模型').replace(/\|/g, '/')}）`
      else if (r.source === 'manual') label = '人手补写'
      else if (r.source === 'failed') label = `模型提炼失败，已回退摘句兜底：${String(r.error || '').replace(/\|/g, '/').slice(0, 120)}`
      else if (r.source === 'unavailable') label = '宿主没有可用模型，摘句兜底'
      else if (r.source === 'skipped') label = '本轮模型额度用完，摘句兜底'
      else if (r.source === 'off') label = '模型提炼关着，摘句兜底'
      else label = '摘句兜底（启发式）'
      const at = r.at ? ` · ${String(r.at).slice(0, 16).replace('T', ' ')}` : ''
      L.push(`| 提炼 | ${label}${at} |`)
    }
    L.push('')

    const bySection = (sec) => this.notesOf(bvid).filter((n) => n.section === sec)
    for (const sec of SECTIONS) {
      const items = bySection(sec)
      if (!items.length) continue
      L.push(`## ${sec}`)
      for (const n of items) {
        let line = String(n.body || '').replace(/\r/g, '')
        if (sec === SECTION_QUOTES && !line.startsWith('>')) line = '> ' + line.replace(/\n/g, '\n> ')
        const head = n.ts ? `[${n.ts}] ` : ''
        const tag = n.tags ? `  \`#${String(n.tags).replace(/,/g, '` `#')}\`` : ''
        if (line.includes('\n')) L.push(`- ${head}${line}`.replace(/\n/g, '\n  '))
        else L.push(`- ${head}${line}${tag}`)
      }
      L.push('')
    }
    const others = this.notesOf(bvid).filter((n) => !SECTIONS.includes(n.section))
    if (others.length) {
      L.push('## 其它')
      for (const n of others) L.push(`- **${n.section}** ${n.body}${n.tags ? ` \`#${n.tags}\`` : ''}`)
      L.push('')
    }
    L.push('---')
    L.push('*由 dsha-bili-study 从 `notes/library.json` 渲染；改笔记请用 `bili_study_note add`，别手改本文件。*')
    return L.join('\n') + '\n'
  }

  /** 写 `<notes>/<bvid>.md`，返回路径。 */
  saveRendered(bvid) {
    const md = this.renderMarkdown(bvid)
    if (!md) return ''
    const p = join(this.dir, `${bvid}.md`)
    writeFileSync(p, md, 'utf8')
    return p
  }

  /* ───────────── 统计（给面板用） ───────────── */

  stats(today = dayKey()) {
    const vids = this.listVideos()
    const learnedToday = vids.filter((v) => v.learnedAt === today)
    const due = this.due(today, 999)
    return {
      totalVideos: vids.length,
      totalNotes: vids.reduce((a, v) => a + (v.notes?.length || 0), 0),
      learnedToday: learnedToday.map((v) => ({ bvid: v.bvid, title: v.title, score: v.score, verdict: v.verdict, url: v.url })),
      learnedTodayCount: learnedToday.length,
      dueCount: due.length,
      due: due.slice(0, 8),
    }
  }
}

/* ─────────────────────────── 纯函数 ─────────────────────────── */

/** 秒 → M:SS / H:MM:SS（整除，不能四舍五入）。 */
export function fmtHms(sec) {
  const v = Number(sec)
  if (!Number.isFinite(v) || v < 0) return ''
  const s = Math.trunc(v)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p = (x) => String(x).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`
}

/** 在**原文**里取一段带 [[高亮]] 的片段（FTS 的 snippet() 切的是 bigram 化文本，人读不了）。 */
export function snippetOf(body, query, tokens = [], width = 60) {
  const text = String(body ?? '').replace(/\r/g, '')
  if (!text) return ''
  const cands = [query, ...String(query ?? '').split(/\s+/).filter((t) => t.length >= 2), ...tokens]
  for (const c of cands) {
    if (!c) continue
    const i = text.indexOf(c)
    if (i >= 0) {
      const a = Math.max(0, i - Math.floor(width / 3))
      const b = Math.min(text.length, i + c.length + width)
      return `${text.slice(a, i)}[[${text.slice(i, i + c.length)}]]${text.slice(i + c.length, b)}`
    }
  }
  return text.slice(0, width)
}

/** 一条视频的小节数量分布（工具输出用）。 */
export function sectionCounts(bvid, store) {
  const out = {}
  for (const n of store.notesOf(bvid)) out[n.section] = (out[n.section] || 0) + 1
  return out
}

/** 判断文件里有没有这条视频的笔记（只读文件，用于 store 之外的快速检查）。 */
export function libraryExists(home) {
  return existsSync(join(home, NOTES_DIR, LIBRARY_FILE))
}

export function readLibraryRaw(home) {
  try { return JSON.parse(readFileSync(join(home, NOTES_DIR, LIBRARY_FILE), 'utf8')) } catch { return null }
}
