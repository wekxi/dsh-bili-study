/**
 * tests/refine.test.mjs —— P3：模型提炼（离线）
 * ============================================================================
 * 这里不打网络、不碰真模型：
 *   · 提示词拼装 / ASR 纠正边界 / 解析失败降级 → 纯函数直接测；
 *   · 一次完整的一轮 → 用 fake client + fake 模型调用跑 `runRound`；
 *   · 宿主探测 / 流式收文本 → 只测我们自己的适配层，不测 DSH 的适配器。
 *
 * 红线用例（这些挂了说明"不许编造"破了）：
 *   · 金句不在字幕原文里 → 必须被丢掉；
 *   · 模型输出不是 JSON/分节 → 必须 failed，且保留摘句兜底；
 *   · refine=false → **零**模型调用，笔记与 0.1.0 一致。
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoteStore, SECTION_POINTS, SECTION_TIMELINE, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH } from '../lib/notes.js'
import { runRound } from '../lib/duty.js'
import {
  REFINE_PROMPT_VERSION, REFINE_SYSTEM, buildRefinePrompt, subtitleTranscript,
  parseRefineOutput, validateRefine, refineSectionsFrom, mergeRefinedSections,
  runRefine, buildDigestInstruction, quoteInTranscript, tsToSeconds,
} from '../lib/refine.js'
import { detectHostModel, streamText } from '../lib/model.js'

const FIX = JSON.parse(readFileSync(new URL('./fixtures/BV1ahFmzqE9z.subtitle.json', import.meta.url), 'utf8'))
const ROWS = FIX.segments
const tmpHome = () => mkdtempSync(join(tmpdir(), 'bili-refine-'))

/* ─────────────── 假模型返回 ─────────────── */

const GOOD_JSON = JSON.stringify({
  要点: [
    { text: '渐进式披露：先给名字，再看描述，最后才展开细节', ts: '1:23' },
    { text: '上下文膨胀的根因是工具描述一次性全塞进去', ts: '5:06' },
    { text: 'DeepSeek V4.1 Flash 是字幕里 deep fw0V 的正确写法（这是 ASR 纠正）', ts: '9:10' },
  ],
  金句: [{ text: '我是谭森老师', ts: '0:12' }],
  我的判断: '值得看：讲清了上下文管理的取舍，适合已经会写工具调用的人；坑是前半段语速偏快。',
  值不值得再看: '值得二刷：把 5:06 那段的取舍再过一遍。',
})

/** 取字幕里真实存在的一句话（用来做"合规金句"）。 */
function aRealQuote() {
  const line = ROWS.map((r) => String(r.text || '')).find((t) => t.length >= 6 && t.length <= 30)
  return line || ROWS[0].text
}

/* ─────────────── 提示词 ─────────────── */

test('buildRefinePrompt：写死 ASR 纠正边界 + 不许编造 + 四节 + 严格 JSON', () => {
  const tr = subtitleTranscript(ROWS, { maxChars: 4000 })
  const prompt = buildRefinePrompt({
    title: 'Agent Skills 教程', author: '陈森老师', durationText: '19:23',
    url: 'https://www.bilibili.com/video/BV1ahFmzqE9z', keywords: ['skills'],
    transcript: tr.text, totalLines: tr.totalLines, truncated: tr.truncated, maxChars: 4000,
  })
  assert.match(prompt, /ASR/)
  assert.match(prompt, /deep fw0V/)
  assert.match(prompt, /DeepSeek V4\.1 Flash/)
  assert.match(prompt, /GBT6\.1/)
  assert.match(prompt, /GPT-6\.1/)
  assert.match(prompt, /不确定的必须写成「可能是…」|可能是…/)
  assert.match(prompt, /不许补充字幕里没有的事实/)
  assert.match(prompt, /严格 JSON/)
  for (const sec of ['"要点"', '"金句"', '"我的判断"', '"值不值得再看"']) assert.ok(prompt.includes(sec), `提示词缺 ${sec}`)
  assert.match(prompt, /600 字/)
  assert.match(prompt, /\[0:0?0?\]/) // 字幕带时间轴
  assert.match(prompt, /Agent Skills 教程/)
})

test('subtitleTranscript：按 maxChars 截断、保留时间轴、标 truncated', () => {
  const tr = subtitleTranscript(ROWS, { maxChars: 600 })
  assert.ok(tr.text.length <= 600)
  assert.ok(tr.lines > 0 && tr.lines < tr.totalLines)
  assert.equal(tr.truncated, true)
  assert.match(tr.text.split('\n')[0], /^\[\d+:\d{2}\] /)
  const full = subtitleTranscript(ROWS, { maxChars: 100000 })
  assert.equal(full.truncated, false)
  assert.equal(full.lines, full.totalLines)
})

/* ─────────────── 解析 / 校验 ─────────────── */

test('parseRefineOutput：严格 JSON / 代码块 / 前后带话都能解析', () => {
  for (const raw of [GOOD_JSON, '```json\n' + GOOD_JSON + '\n```', '好的，结果如下：\n' + GOOD_JSON + '\n希望有帮助。']) {
    const got = parseRefineOutput(raw)
    assert.equal(got.ok, true)
    assert.equal(got.data.points.length, 3)
    assert.equal(got.data.quotes.length, 1)
    assert.match(got.data.judgment, /值得看/)
  }
})

test('parseRefineOutput：分节 Markdown 也能当兜底', () => {
  const raw = [
    '## 要点',
    '- 1:23 渐进式披露解决上下文膨胀',
    '- 5:06 工具描述要按需加载',
    '## 金句',
    '- [0:12] 我是谭森老师',
    '## 我的判断',
    '值得看，适合会写工具调用的人。',
    '## 值不值得再看',
    '值得二刷。',
  ].join('\n')
  const got = parseRefineOutput(raw)
  assert.equal(got.ok, true)
  assert.equal(got.format, 'sections')
  assert.equal(got.data.points.length, 2)
  assert.equal(got.data.points[0].ts, '1:23')
  assert.equal(got.data.quotes.length, 1)
  assert.match(got.data.judgment, /值得看/)
})

test('parseRefineOutput：既不是 JSON 也没有标题 → ok:false（不许瞎猜）', () => {
  for (const raw of ['', '我不知道', '{"foo":1}', '这是一段没有结构的总结。']) {
    const got = parseRefineOutput(raw)
    assert.equal(got.ok, false, `不该解析成功：${raw.slice(0, 20)}`)
    assert.ok(got.reason)
  }
})

test('quoteInTranscript / validateRefine：编造的金句必须被丢掉', () => {
  assert.equal(quoteInTranscript('我是谭森老师', subtitleTranscript(ROWS).text), true)
  assert.equal(quoteInTranscript('我从来没说过这句话呀朋友', subtitleTranscript(ROWS).text), false)
  const checked = validateRefine({
    points: [{ text: '要点一', ts: '1:23' }],
    quotes: [
      { text: aRealQuote(), ts: '0:12' },
      { text: '这句字幕里绝对没有的编造句', ts: '2:00' },
    ],
    judgment: '值得看。',
    worth: '值得二刷。',
  }, { transcriptText: subtitleTranscript(ROWS).text, durationSec: 1200 })
  assert.equal(checked.quotes.length, 1, '编造的金句应该被丢掉')
  assert.ok(checked.warnings.some((w) => /未在字幕原文里找到/.test(w)))
})

test('validateRefine：时间轴越界清空、条数/篇幅有上限', () => {
  const checked = validateRefine({
    points: [
      { text: '早', ts: '0:30' },
      { text: '晚', ts: '99:30' },
      ...Array.from({ length: 9 }, (_, i) => ({ text: `要点${i}`, ts: '' })),
    ],
    quotes: [],
    judgment: '判断'.repeat(400),
    worth: '结论',
  }, { transcriptText: subtitleTranscript(ROWS).text, durationSec: 600 })
  assert.ok(checked.points.length <= 6)
  assert.equal(checked.points.find((p) => p.text === '晚').tsSec, -1)
  assert.equal(checked.points.find((p) => p.text === '晚').ts, '')
  assert.ok(checked.judgment.length <= 501)
})

test('tsToSeconds：M:SS 与 H:MM:SS 都认', () => {
  assert.equal(tsToSeconds('1:23'), 83)
  assert.equal(tsToSeconds('[01:02:03]'), 3723)
  assert.equal(tsToSeconds('abc'), -1)
})

/* ─────────────── 一次提炼 ─────────────── */

test('runRefine：成功 → 四节 + source:model + 提示词版本', async () => {
  const seen = []
  const r = await runRefine({
    call: async (p) => { seen.push(p); return GOOD_JSON },
    model: 'deepseek-official/deepseek-flash',
    video: { bvid: 'BV1ahFmzqE9z', title: 'Agent Skills', author: '陈森老师', durationText: '19:23' },
    rows: ROWS, maxChars: 5000, durationSec: 1200,
  })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'model')
  assert.equal(seen.length, 1)
  assert.ok(seen[0].prompt.includes('ASR'))
  assert.ok(seen[0].maxTokens > 0)
  const names = r.sections.map((s) => s.section)
  for (const want of [SECTION_POINTS, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH]) assert.ok(names.includes(want))
  assert.ok(r.sections.every((s) => s.tags === 'source:model'))
  assert.equal(r.sections.find((s) => s.section === SECTION_QUOTES).body.startsWith('> '), true)
})

test('runRefine：模型调用抛错 → failed，不产生任何 note 节', async () => {
  const r = await runRefine({
    call: async () => { throw new Error('模型 529 过载') },
    video: { bvid: 'BV1ahFmzqE9z' }, rows: ROWS, durationSec: 1200,
  })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'failed')
  assert.match(r.error, /529/)
  assert.equal(r.sections, undefined)
})

test('runRefine：返回无法解析 → failed（不写坏笔记）', async () => {
  const r = await runRefine({
    call: async () => '我就是不按格式回，你拿我怎么办',
    video: { bvid: 'BV1ahFmzqE9z' }, rows: ROWS, durationSec: 1200,
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /解析失败/)
})

test('mergeRefinedSections：替换四节但保留启发式时间轴锚点', () => {  const base = [
    { section: SECTION_POINTS, body: '旧要点', ts: '0:01', tsSec: 1 },
    { section: SECTION_TIMELINE, body: '锚点', ts: '0:02', tsSec: 2 },
    { section: SECTION_JUDGMENT, body: '旧判断', ts: '', tsSec: -1 },
  ]
  const merged = mergeRefinedSections(base, refineSectionsFrom(validateRefine({
    points: [{ text: '新要点', ts: '1:00' }], quotes: [], judgment: '新判断', worth: '新结论',
  })))
  const secs = merged.map((s) => s.section)
  assert.ok(secs.includes(SECTION_TIMELINE))
  assert.ok(!merged.some((s) => s.body === '旧要点'))
  assert.ok(merged.some((s) => s.body === '新要点'))
  assert.ok(merged.some((s) => s.body === '新判断'))
})

/* ─────────────── 宿主模型适配层 ─────────────── */

test('detectHostModel：没有 ctx / 没有 llm → available:false（不抛）', async () => {
  for (const ctx of [undefined, {}, { get: () => undefined }]) {
    const got = await detectHostModel(ctx)
    assert.equal(got.available, false)
    assert.ok(got.reason)
  }
})

test('detectHostModel：默认模型 / 配置里的 provider/model 都能认', async () => {
  const llm = {
    stream: async function* () {},
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
  }
  const ctx = {
    get: (k) => (k === 'llm' ? llm : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } : undefined),
  }
  const got = await detectHostModel(ctx)
  assert.equal(got.available, true)
  assert.equal(got.provider, 'deepseek-official')
  assert.equal(got.model, 'deepseek-flash')

  const ov = await detectHostModel(ctx, { override: 'deepseek-official/deepseek-v4.1-flash' })
  assert.equal(ov.provider, 'deepseek-official')
  assert.equal(ov.model, 'deepseek-v4.1-flash')
  assert.equal(ov.source, 'config')

  const onlyModel = await detectHostModel(ctx, { override: 'deepseek-v4.1-flash' })
  assert.equal(onlyModel.provider, 'deepseek-official')
  assert.equal(onlyModel.model, 'deepseek-v4.1-flash')
})

test('streamText：text-delta 拼成文本；finish=error 抛错', async () => {
  const ok = {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '要点' }
      yield { type: 'text-delta', index: 0, text: '在这' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  assert.equal(await streamText(ok, { provider: 'p', model: 'm', prompt: 'x' }), '要点在这')

  const bad = {
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '限流' } } }
    },
  }
  await assert.rejects(() => streamText(bad, { provider: 'p', model: 'm', prompt: 'x' }), /RATE_LIMIT/)
})

test('detectHostModel：模型支持低思考档 → 自动选 low（省钱、少被推理吃光 token）', async () => {
  const llm = {
    stream: async function* () {},
    listProviders: () => [{ id: 'deepseek-official' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    resolveModelInfo: async () => ({ provider: 'deepseek-official', id: 'deepseek-flash', name: 'Flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }),
  }
  const ctx = { get: (k) => (k === 'llm' ? llm : undefined) }
  const got = await detectHostModel(ctx)
  assert.equal(got.available, true)
  assert.equal(got.reasoningEffort, 'low')
})

test('streamText：只吐思考不吐正文 → 明确报错（别把空串当"模型说没内容"）', async () => {
  const onlyReasoning = {
    stream: async function* () {
      yield { type: 'reasoning-delta', index: 0, text: '想了很多' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  await assert.rejects(
    () => streamText(onlyReasoning, { provider: 'p', model: 'm', prompt: 'x', maxTokens: 10 }),
    /只输出了思考过程/,
  )
})

test('streamText：把 reasoningEffort 原样传给宿主（提炼用 low，别走高思考）', async () => {
  let seen = null
  const llm = {
    stream: async function* (options) {
      seen = options
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const out = await streamText(llm, { provider: 'p', model: 'm', prompt: 'x', reasoningEffort: 'low' })
  assert.equal(out, 'ok')
  assert.equal(seen.reasoningEffort, 'low')
})

/* ─────────────── 整轮（fake client + fake 模型） ─────────────── */

function makeClient({ withSubtitle = true } = {}) {
  const meta = (bvid, title) => ({
    bvid, aid: bvid === 'BV1aaaaaaaaa' ? 1001 : 1002, title, author: 'UP主', mid: 42,
    pubdate: 1760000000, pubdateText: '2026-10-09', durationSec: 1200, totalSec: 1200,
    pageCount: 1, avgPageSec: 1200, desc: 'github.com/example/repo 讲渐进式披露与上下文管理。',
    tname: '科技', play: 30000, like: 1200,
    pages: [{ page: 1, cid: bvid === 'BV1aaaaaaaaa' ? 111 : 222, part: 'P1', durationSec: 1200 }],
    url: `https://www.bilibili.com/video/${bvid}`,
  })
  const videos = [
    { bvid: 'BV1aaaaaaaaa', title: '手写操作系统 第3讲 中断与异常' },
    { bvid: 'BV1bbbbbbbbb', title: '手写操作系统 第4讲 进程调度' },
  ]
  return {
    async search({ keyword }) {
      return {
        keyword, totalCount: videos.length,
        items: videos.map((v) => ({
          ...v, play: 30000, like: 1200, desc: 'github.com/x/os', durationSec: 1200,
          pubdate: 1760000000, author: 'UP主', url: `https://www.bilibili.com/video/${v.bvid}`, pubdateText: '2026-10-09',
        })),
      }
    },
    async videoInfo(bvid) {
      return meta(bvid, videos.find((v) => v.bvid === bvid)?.title || bvid)
    },
    async pickSubtitle() {
      if (!withSubtitle) return { lang: '', rows: [], needLogin: true }
      return { lang: 'ai-zh', label: '中文（自动生成）', rows: ROWS, needLogin: false }
    },
    async comments() { return [] },
    async sendComment() { throw new Error('不该走到这') },
  }
}

const CFG = {
  keywords: ['skills', '线性代数'], perDay: 2, minScore: 50, days: 7,
  subtitleLang: 'ai-zh', maxPages: 1, autoComment: false,
  refine: true, refinePerRound: 2, refineMaxChars: 12000, refineModel: '',
}

test('runRound：refine 开 + 模型可用 → 四节是模型写的，标记 source:model', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    let calls = 0
    const r = await runRound({
      cfg: CFG, client: makeClient(), store, home,
      now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000,
      refine: {
        available: true, provider: 'deepseek-official', model: 'deepseek-flash',
        call: async () => { calls += 1; return GOOD_JSON },
      },
    })
    assert.equal(r.counts.withSubtitle, 2)
    assert.equal(calls, 2, '两条带字幕的都应提炼')
    assert.equal(r.counts.refined, 2)
    assert.equal(r.counts.refineFailed, 0)
    const p = r.picked[0]
    assert.equal(p.refine, 'model')
    assert.match(p.refineModel, /deepseek-official\/deepseek-flash/)
    const md = readFileSync(p.notePath, 'utf8')
    assert.match(md, /## 要点/)
    assert.match(md, /source:model/)
    assert.match(md, /模型提炼/)
    assert.doesNotMatch(md, /这一轮是自动抓取 \+ 启发式判读/)
    assert.match(readFileSync(r.report, 'utf8'), /提炼：\*\*模型\*\*/)
    assert.equal(store.video(p.bvid).refine.source, 'model')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：refine=false → 零模型调用，行为与 0.1.0 一致', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    let calls = 0
    const r = await runRound({
      cfg: { ...CFG, refine: false }, client: makeClient(), store, home,
      now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000,
      refine: {
        available: true, provider: 'deepseek-official', model: 'deepseek-flash',
        call: async () => { calls += 1; return GOOD_JSON },
      },
    })
    assert.equal(calls, 0, 'refine 关着就不许调模型')
    assert.equal(r.counts.refineCalls, 0)
    assert.equal(r.counts.refined, 0)
    assert.ok(r.picked.every((p) => p.refine === 'off'))
    const md = readFileSync(r.picked[0].notePath, 'utf8')
    assert.doesNotMatch(md, /source:model/)
    assert.match(md, /这一轮是自动抓取 \+ 启发式判读/)
    assert.match(readFileSync(r.report, 'utf8'), /提炼：关着/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：refinePerRound=1 → 只调一次，另一条标 skipped', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    let calls = 0
    const r = await runRound({
      cfg: { ...CFG, refinePerRound: 1 }, client: makeClient(), store, home,
      now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000,
      refine: {
        available: true, provider: 'deepseek-official', model: 'deepseek-flash',
        call: async () => { calls += 1; return GOOD_JSON },
      },
    })
    assert.equal(calls, 1)
    assert.equal(r.counts.refineCalls, 1)
    assert.equal(r.picked.filter((p) => p.refine === 'model').length, 1)
    assert.equal(r.picked.filter((p) => p.refine === 'skipped').length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：dailyRemaining=0 → 一条都不调（每天总量闸）', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    let calls = 0
    const r = await runRound({
      cfg: CFG, client: makeClient(), store, home,
      now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000,
      refine: {
        available: true, provider: 'deepseek-official', model: 'deepseek-flash', dailyRemaining: 0,
        call: async () => { calls += 1; return GOOD_JSON },
      },
    })
    assert.equal(calls, 0)
    assert.ok(r.picked.every((p) => p.refine === 'skipped'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：模型提炼失败 → 保留摘句兜底，笔记不写坏，状态标 failed', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const r = await runRound({
      cfg: CFG, client: makeClient(), store, home,
      now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000,
      refine: {
        available: true, provider: 'deepseek-official', model: 'deepseek-flash',
        call: async () => '这种输出根本没法解析',
      },
    })
    assert.equal(r.counts.refineFailed, 2)
    assert.equal(r.counts.refined, 0)
    const p = r.picked[0]
    assert.equal(p.refine, 'failed')
    const md = readFileSync(p.notePath, 'utf8')
    assert.match(md, /模型提炼失败/)
    assert.match(md, /这一轮是自动抓取 \+ 启发式判读/) // 摘句兜底还在
    assert.equal(store.video(p.bvid).refine.source, 'failed')
    assert.ok(r.errors.some((e) => /模型提炼失败/.test(e)))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：没有字幕的条目不会被提炼（别对元数据编造）', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    let calls = 0
    const r = await runRound({
      cfg: CFG, client: makeClient({ withSubtitle: false }), store, home,
      now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000,
      refine: {
        available: true, provider: 'deepseek-official', model: 'deepseek-flash',
        call: async () => { calls += 1; return GOOD_JSON },
      },
    })
    assert.equal(calls, 0)
    assert.ok(r.picked.every((p) => p.refine === 'excerpt'))
    assert.equal(r.counts.fallback, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：宿主没有模型（available:false）→ 摘句兜底 + unavailable', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const r = await runRound({
      cfg: CFG, client: makeClient(), store, home,
      now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000,
      refine: { available: false, reason: '宿主没有 llm 服务' },
    })
    assert.equal(r.counts.refineCalls, 0)
    assert.ok(r.picked.every((p) => p.refine === 'unavailable'))
    assert.match(readFileSync(r.report, 'utf8'), /宿主没有可用模型/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('NoteStore.markRefine：外部 agent 写回的笔记能标出来源', () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    store.upsertVideo({ bvid: 'BV1agent0001', title: 'agent 写的', score: 70, verdict: '值得一看' })
    store.addNote('BV1agent0001', { section: SECTION_POINTS, body: '要点' })
    store.markRefine('BV1agent0001', { source: 'agent', via: 'digest' })
    const md = store.renderMarkdown('BV1agent0001')
    assert.match(md, /外部 agent 按 digest 提炼/)
    assert.doesNotMatch(md, /摘句兜底/)
    assert.equal(store.video('BV1agent0001').refine.via, 'digest')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

/* ─────────────── 提示词驱动（digest） ─────────────── */

test('buildDigestInstruction：四节格式 + 写回命令 + ASR 边界', () => {
  const text = buildDigestInstruction({ bvid: 'BV1ahFmzqE9z', title: 'Agent Skills', transcript: '' })
  assert.match(text, /bili_study_note action=new bvid=BV1ahFmzqE9z/)
  for (const sec of ['section=要点', 'section=金句', 'section=我的判断', 'section=值不值得再看']) {
    assert.ok(text.includes(sec), `缺写回命令：${sec}`)
  }
  assert.ok(text.includes('source=agent'), '写回命令要带 source=agent，面板才能标出外部 agent')
  assert.match(text, /ASR/)
  assert.match(text, /deep fw0V/)
  assert.match(text, /不许补充/)
  assert.match(text, /transcript/)
  assert.equal(REFINE_PROMPT_VERSION, 'bili-study-refine-v1')
  assert.ok(REFINE_SYSTEM.includes('严格 JSON'))
  assert.ok(existsSync(new URL('./fixtures/BV1ahFmzqE9z.subtitle.json', import.meta.url)))
})
