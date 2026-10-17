/**
 * tests/duty.test.mjs —— 每日一轮（离线）：用真实字幕样本跑一遍"搜→判分→挑→抓字幕/兜底→写笔记→出报告"
 *
 * 网络全部替换成 fake client —— 这一条测试在任何机器上、断网也能跑。
 * 字幕 fixture 是**真实** B站 AI 中文字幕（公开视频 BV1ahFmzqE9z，见 fixtures/README 说明）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoteStore, SECTION_POINTS, SECTION_TIMELINE, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH } from '../lib/notes.js'
import {
  sentencesFromRows, extractMaterial, sentenceScore, buildNoteSections, composeComment,
  keywordPlan, roundStatusText, densityOf, pickTopics, runRound,
  looksLikeAsrNoise, resolveMention,
} from '../lib/duty.js'

const FIX = JSON.parse(readFileSync(new URL('./fixtures/BV1ahFmzqE9z.subtitle.json', import.meta.url), 'utf8'))
const ROWS = FIX.segments
// 0.2.1 事故回归样本：真机发出去的那条评论里的 ASR 原文（见 fixtures 里的 note）
const ACC = JSON.parse(readFileSync(new URL('./fixtures/BV1n9Jv6QE3A.accident.json', import.meta.url), 'utf8'))
const ACC_ROWS = ACC.segments
const tmpHome = () => mkdtempSync(join(tmpdir(), 'bili-duty-'))

/** 假模型返回（评论闸门测试只要「有模型提炼的要点」这一条就够）。 */
const MODEL_JSON = JSON.stringify({
  要点: [{ text: 'DeepSeek V4.1 Flash 把上下文管理讲清楚了', ts: '0:08' }],
  金句: [{ text: '说白了就是先把工具名字给它', ts: '0:17' }],
  我的判断: '值得看，适合写工具调用的人。',
  值不值得再看: '值得二刷。',
})

/* ─────────────── fake client ─────────────── */

/** 只返回一条带字幕的视频（评论闸门用例要确定目标，不靠打分排序）。 */
function onlyFirstVideo(client) {
  client.search = async ({ keyword }) => ({
    keyword,
    totalCount: 1,
    items: [{
      bvid: 'BV1aaaaaaaaa', title: '手写操作系统 第3讲 中断与异常', play: 30000, like: 1200,
      desc: 'github.com/example/repo', durationSec: 1200, pubdate: 1760000000, author: 'UP主',
      url: 'https://www.bilibili.com/video/BV1aaaaaaaaa', pubdateText: '2026-10-09',
    }],
  })
  return client
}

function makeClient({ withSubtitle = true, postOk = true, rows = ROWS } = {}) {
  const posted = []
  const meta = (bvid, title, aid) => ({
    bvid, aid, title, author: 'UP主', mid: 42, pubdate: 1760000000, pubdateText: '2026-10-09',
    durationSec: 1200, totalSec: 1200, pageCount: 1, avgPageSec: 1200,
    desc: '配套代码见 github.com/example/repo ，本课程讲清渐进式披露的核心：先给名字，再看描述，最后才展开细节。',
    tname: '科技', play: 30000, like: 1200, pages: [{ page: 1, cid: 111, part: 'P1', durationSec: 1200 }],
    url: `https://www.bilibili.com/video/${bvid}`,
  })
  const videos = [
    { bvid: 'BV1aaaaaaaaa', title: '手写操作系统 第3讲 中断与异常', play: 30000, like: 1200, desc: 'github.com/x/os', durationSec: 1200, pubdate: 1760000000 },
    { bvid: 'BV1bbbbbbbbb', title: 'MIT 18.06 线性代数 第1章 Introduction', play: 1200000, like: 40000, desc: 'github.com/mit/1806', durationSec: 1200, pubdate: 1760000000 },
  ]
  return {
    posted,
    calls: { search: 0, subtitle: 0, comments: 0 },
    async search({ keyword }) {
      this.calls.search += 1
      return { keyword, totalCount: videos.length, items: videos.map((v) => ({ ...v, author: 'UP主', url: `https://www.bilibili.com/video/${v.bvid}`, pubdateText: '2026-10-09' })) }
    },
    async videoInfo(bvid) {
      return meta(bvid, videos.find((v) => v.bvid === bvid)?.title || bvid, bvid === 'BV1aaaaaaaaa' ? 1001 : 1002)
    },
    async pickSubtitle(bvid) {
      this.calls.subtitle += 1
      if (!withSubtitle || bvid !== 'BV1aaaaaaaaa') return { lang: '', rows: [], needLogin: true }
      return { lang: 'ai-zh', label: '中文（自动生成）', rows, needLogin: false }
    },
    async comments() {
      this.calls.comments += 1
      return [
        { rpid: 1, user: '甲', like: 120, message: '第三章讲得最好，矩阵那段建议二刷', ctime: 1760000000, replyCount: 3 },
        { rpid: 2, user: '乙', like: 30, message: '求讲义', ctime: 1760000000, replyCount: 0 },
      ]
    },
    async sendComment({ aid, message, bvid }) {
      if (!postOk) throw new Error('B站 说没登录（-101）：去设置页把 SESSDATA 重新粘一次')
      posted.push({ aid, message, bvid })
      return { rpid: 9000 + posted.length, message }
    },
  }
}

/* ─────────────── 文本侧 ─────────────── */

test('sentencesFromRows：几字一行的字幕合成句子，保留第一行时间', () => {
  // ⚠️ 只取 P01：B站 字幕时间戳是**每个分P 各自从 0 开始**的，跨分P 拼起来当然不单调
  //    （合并多条分P 时的偏移由 fetchSubtitlesFor 负责，见下面 runRound 那条）
  const onePage = ROWS.filter((r) => String(r.page || '').startsWith('P01'))
  const sents = sentencesFromRows(onePage)
  assert.ok(sents.length > 10, `应该合成出十几句，实际 ${sents.length}`)
  assert.equal(sents[0].text.startsWith('大家好'), true)
  assert.equal(typeof sents[0].start, 'number')
  for (let i = 1; i < sents.length; i += 1) assert.ok(sents[i].start >= sents[i - 1].start, '同一分P 内时间必须单调不减')
  assert.ok(sents.every((s) => s.text.length > 0))
})

test('extractMaterial：要点/时间轴/金句/知识点都能抽出来', () => {
  const sents = sentencesFromRows(ROWS)
  const m = extractMaterial(sents, { keywords: ['skills'] })
  assert.ok(m.points.length >= 3 && m.points.length <= 5, `要点数 ${m.points.length}`)
  assert.ok(m.anchors.length >= 2, `时间轴锚点 ${m.anchors.length}`)
  assert.ok(m.topics.length >= 2, `知识点 ${m.topics.length}`)
  assert.ok(m.points.every((p) => p.text.length > 0))
  // 要点按时间排好
  const starts = m.points.map((p) => p.start)
  assert.deepEqual([...starts].sort((a, b) => a - b), starts)
  // 时间轴锚点彼此不重复、时间单调（跨分P 的偏移由 fetchSubtitlesFor 负责，这里只测单段）
  assert.equal(new Set(m.anchors.map((a) => a.start)).size, m.anchors.length, '锚点不该重复')
  assert.ok(m.anchors.every((a, i2) => i2 === 0 || a.start >= m.anchors[i2 - 1].start), '锚点按时间排')
})

test('sentenceScore / pickTopics / densityOf：口径稳定', () => {
  assert.ok(sentenceScore('核心是先把名字给模型，再看描述') > sentenceScore('然后'))
  assert.ok(sentenceScore('这里用到 Python 3.12 的新特性') > sentenceScore('嗯对就是这样'))
  const topics = pickTopics('渐进式披露 渐进式披露 上下文管理 上下文管理 上下文管理 工具调用', 5)
  assert.ok(topics.some((t) => t.includes('上下文')), '应该拼出「上下文管理」这类长词：' + topics.join('/'))
  assert.equal(densityOf([{ text: '一二三四五' }, { text: '六七八九十' }], 60), 10)   // 10 字 / 1 分钟
})

test('buildNoteSections：五节都生成，金句带 >，时间轴带 ts', () => {
  const sents = sentencesFromRows(ROWS)
  const material = extractMaterial(sents)
  material.sentences = sents
  const secs = buildNoteSections({
    meta: { score: 88, verdict: '强烈推荐' },
    material,
    subtitleSource: 'subtitle',
    durationSec: 1200,
  })
  const names = secs.map((s) => s.section)
  for (const want of [SECTION_POINTS, SECTION_TIMELINE, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH]) {
    assert.ok(names.includes(want), `缺小节 ${want}：${names.join(',')}`)
  }
  assert.ok(secs.filter((s) => s.section === SECTION_TIMELINE).every((s) => /^\d+:\d{2}$/.test(s.ts)))
  assert.ok(secs.filter((s) => s.section === SECTION_QUOTES).every((s) => s.body.startsWith('>')))
  assert.match(secs.find((s) => s.section === SECTION_JUDGMENT).body, /读了字幕原文/)
})

test('buildNoteSections：没字幕时明确写"没有可用字幕"，不假装读过原文', () => {
  const secs = buildNoteSections({
    meta: { score: 40, verdict: '不建议看(引流嫌疑)', desc: '简介内容' },
    material: { points: [], anchors: [], quotes: [], topics: [], sentences: [], sentenceCount: 0 },
    subtitleSource: 'fallback',
    durationSec: 600,
  })
  const judge = secs.find((s) => s.section === SECTION_JUDGMENT).body
  assert.match(judge, /没有可用的 ai-zh 字幕轨/)
  assert.doesNotMatch(judge, /读了字幕原文/)
  const worth = secs.find((s) => s.section === SECTION_WORTH).body
  assert.match(worth, /没有字幕原文/)
})

test('composeComment：@ 昵称 + 不超长 + 不泄露私人信息（只认模型提炼的内容）', () => {
  const text = composeComment({
    mentionName: '乌子鱼',
    meta: { title: 'T' },
    material: { points: [{ text: '渐进式披露解决的是上下文膨胀' }], topics: ['渐进'] },
    bvid: 'BV1aaaaaaaaa',
    refine: 'model',
  })
  assert.match(text, /^@乌子鱼 /)
  assert.ok([...text].length <= 140)
  assert.doesNotMatch(text, /C:\\|\.dsh|SESSDATA/)
})

test('0.2.1 评论闸门：refine 缺失时 composeComment 返回 null（绝不拼摘句）', () => {
  const material = { points: [{ text: '今天是26年10月17日dB sk呢发布了一个新的fla' }], topics: ['噪声'] }
  for (const refine of ['excerpt', 'skipped', 'failed', 'off', 'unavailable', '', undefined]) {
    const text = composeComment({ mentionName: '乌子鱼', material, bvid: 'BV1n9Jv6QE3A', refine })
    assert.equal(text, null, `refine=${String(refine)} 时不该生成评论文案`)
  }
  // 没填 @ 名 / 没模型要点 → 也返回 null（调用方据此记 skipped）
  assert.equal(composeComment({ mentionName: '', material, bvid: 'BV1x', refine: 'model' }), null)
  assert.equal(composeComment({ mentionName: '乌子鱼', material: { points: [] }, bvid: 'BV1x', refine: 'model' }), null)
})

test('0.2.1 评论闸门：ASR 噪声片段即便被标成 model 也剔除，剔不干净就整条不发', () => {
  assert.equal(looksLikeAsrNoise('今天是26年10月17日dB sk呢发布了一个新的fla'), true)
  assert.equal(looksLikeAsrNoise('一个新的fla'), true)
  assert.equal(looksLikeAsrNoise('渐进式披露解决的是上下文膨胀'), false)
  assert.equal(looksLikeAsrNoise('DeepSeek V4.1 Flash 把上下文管理讲清楚了'), false)
  // 唯一一条 model 要点是 ASR 噪声 → 没有可引用的内容 → null
  assert.equal(composeComment({
    mentionName: '乌子鱼',
    material: { points: [{ text: '今天是26年10月17日dB sk呢发布了一个新的fla' }] },
    bvid: 'BV1n9Jv6QE3A',
    refine: 'model',
  }), null)
  // 金句必须能在字幕原文里回溯；回溯不了就退回干净的要点
  const text = composeComment({
    mentionName: '乌子鱼',
    material: {
      points: [{ text: '先把工具名字给它，再按需展开描述' }],
      quotes: [{ text: '这句字幕里根本没有的编造金句呀' }],
    },
    bvid: 'BV1aaaaaaaaa',
    refine: 'model',
    transcriptText: '大家好，我是谭森老师。先把工具名字给它，再按需展开描述。',
  })
  assert.match(text, /^@乌子鱼 /)
  assert.ok(text.includes('先把工具名字给它'), `应该退回干净要点：${text}`)
  assert.ok(!text.includes('编造金句'))
})

test('0.2.1 mentionName 兜底：空值用 credential.uname；不一致只提示、不改用户填的值', () => {
  const auto = resolveMention({ mentionName: '', uname: '小小鲸鱼娘' })
  assert.equal(auto.name, '小小鲸鱼娘')
  assert.equal(auto.source, 'credential')
  assert.equal(auto.mismatch, false)

  const manual = resolveMention({ mentionName: '乌子鱼不在家', uname: '小小鲸鱼娘' })
  assert.equal(manual.name, '乌子鱼不在家', '用户手填的值不许被改掉')
  assert.equal(manual.source, 'config')
  assert.equal(manual.mismatch, true)
  assert.match(manual.warn, /@ 名.*≠ 登录名.*@ 错人/)

  const none = resolveMention({ mentionName: '', uname: '' })
  assert.equal(none.name, '')
  assert.equal(none.source, 'none')
  assert.match(none.warn, /要 @ 谁|没登录/)
})

test('keywordPlan：按天轮转（不会每轮都只搜第一个词）', () => {
  const kws = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(keywordPlan(kws, '2026-10-17', 3).length, 3)
  const d1 = keywordPlan(kws, '2026-10-17', 3)
  const d2 = keywordPlan(kws, '2026-10-18', 3)
  assert.notDeepEqual(d1, d2, '换一天应该换一组关键词')
  assert.deepEqual(keywordPlan(['只有一'], '2026-10-17', 3), ['只有一'])
})

/* ─────────────── 整轮 ─────────────── */

test('runRound：挑 2 条 → 一条读原文、一条兜底 → 笔记+报告都落盘', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const client = makeClient()
    const cfg = { keywords: ['skills', '线性代数'], perDay: 2, minScore: 50, days: 7, subtitleLang: 'ai-zh', maxPages: 1, autoComment: false }
    const r = await runRound({ cfg, client, store, home, now: new Date('2026-10-17T13:00:00'), deadlineMs: 60000 })

    assert.equal(r.picked.length, 2, `应该挑 2 条，实际 ${r.picked.length}`)
    assert.equal(r.counts.withSubtitle, 1)
    assert.equal(r.counts.fallback, 1)
    assert.equal(r.counts.failed, 0, JSON.stringify(r.errors))

    const withSub = r.picked.find((p) => p.bvid === 'BV1aaaaaaaaa')
    const without = r.picked.find((p) => p.bvid === 'BV1bbbbbbbbb')
    assert.equal(withSub.subtitleSource, 'subtitle')
    assert.equal(withSub.lang, 'ai-zh')
    assert.equal(withSub.lines, ROWS.length)
    assert.equal(without.subtitleSource, 'fallback')

    // 笔记落盘
    assert.ok(existsSync(withSub.notePath), '渲染后的 .md 应该存在')
    const md = readFileSync(withSub.notePath, 'utf8')
    assert.match(md, /## 要点/)
    assert.match(md, /## 时间轴锚点/)
    assert.match(md, /字幕 ai-zh/)
    const md2 = readFileSync(without.notePath, 'utf8')
    assert.match(md2, /没有可用字幕/)
    assert.match(md2, /简介 \+ 评论兜底/)

    // 报告
    assert.ok(existsSync(r.report))
    const report = readFileSync(r.report, 'utf8')
    assert.match(report, /今天的 B站 学习报告 · 2026-10-17/)
    assert.match(report, /读了字幕原文/)
    assert.match(report, /没有可用 ai-zh 字幕轨/)
    assert.ok(existsSync(r.reportJson))

    // 复习排上了
    assert.equal(store.video('BV1aaaaaaaaa').review.nextReview, '2026-10-18')
    assert.equal(r.due.length, 0, '刚学的不该立刻到期')

    // 判重：再跑一轮不会再挑这两条
    const r2 = await runRound({ cfg, client, store, home, now: new Date('2026-10-17T13:30:00'), deadlineMs: 60000 })
    assert.equal(r2.picked.length, 0, `第二轮不该再挑，实际 ${r2.picked.map((p) => p.bvid)}`)
    assert.match(roundStatusText(r2), /挑中 0 条/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：没字幕时 comments 也用上，但结论仍标"没读原文"', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const client = makeClient({ withSubtitle: false })
    const cfg = { keywords: ['x'], perDay: 2, minScore: 50, days: 7, maxPages: 1 }
    const r = await runRound({ cfg, client, store, home, now: new Date('2026-10-17T13:00:00') })
    assert.equal(r.counts.withSubtitle, 0)
    assert.equal(r.counts.fallback, 2)
    for (const p of r.picked) {
      const md = readFileSync(p.notePath, 'utf8')
      assert.doesNotMatch(md, /读了字幕原文/, `${p.bvid} 不许假装读过原文`)
    }
    assert.ok(client.calls.comments >= 2, '兜底时应该去翻评论')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('runRound：自动评论默认不发；开了之后每轮最多一条、同视频不重复', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const client = makeClient()
    const base = { keywords: ['x'], perDay: 2, minScore: 50, days: 7, maxPages: 1 }

    const off = await runRound({ cfg: { ...base, autoComment: false, mentionName: '乌子鱼' }, client, store, home, now: new Date('2026-10-17T13:00:00') })
    assert.equal(off.comment.posted, false)
    assert.match(off.comment.why, /自动评论关着/)

    const noName = await runRound({ cfg: { ...base, autoComment: true, mentionName: '' }, client, store, home, now: new Date('2026-10-17T13:10:00') })
    assert.equal(noName.comment.posted, false)
    assert.match(noName.comment.why, /要 @ 谁/)

    // 换一个干净的家，正式测"发一条"（0.2.1：必须有模型提炼才允许发）
    rmSync(home, { recursive: true, force: true })
    const home2 = tmpHome()
    const store2 = new NoteStore(home2)
    const client2 = makeClient()
    const refineOn = { available: true, provider: 'deepseek-official', model: 'deepseek-flash', call: async () => MODEL_JSON }
    const commentCfg = { ...base, autoComment: true, mentionName: '乌子鱼', commentPerRound: 1, refine: true, refinePerRound: 2 }
    const on = await runRound({ cfg: commentCfg, client: client2, store: store2, home: home2, now: new Date('2026-10-17T13:20:00'), refine: refineOn })
    assert.equal(on.comment.posted, true)
    assert.equal(on.picked.find((p) => p.bvid === 'BV1aaaaaaaaa').refine, 'model')
    assert.equal(client2.posted.length, 1)
    assert.match(client2.posted[0].message, /^@乌子鱼 /)
    assert.match(client2.posted[0].message, /要点我记进笔记了/)
    assert.doesNotMatch(client2.posted[0].message, /然后|嗯|这个那个/, '评论不许拿摘句原文凑')
    assert.ok([...client2.posted[0].message].length <= 140)
    assert.equal(on.counts.commented, 1)

    // 同一天再跑一轮（换一批新视频）也不会超过每日上限
    const vids = ['BV1ccccccccc', 'BV1ddddddddd']
    client2.search = async ({ keyword }) => ({
      keyword, totalCount: vids.length,
      items: vids.map((b) => ({ bvid: b, title: `新视频 ${b} 手写操作系统`, play: 30000, like: 1200, desc: 'github.com/x', durationSec: 1200, pubdate: 1760000000, url: `https://www.bilibili.com/video/${b}` })),
    })
    client2.videoInfo = async (bvid) => ({
      bvid, aid: 2000, title: `新视频 ${bvid} 手写操作系统`, author: 'UP', pubdate: 1760000000, pubdateText: '2026-10-09',
      durationSec: 1200, totalSec: 1200, pageCount: 1, avgPageSec: 1200, desc: 'github.com/x',
      play: 30000, like: 1200, pages: [{ page: 1, cid: 222, part: 'P1', durationSec: 1200 }], url: `https://www.bilibili.com/video/${bvid}`,
    })
    client2.pickSubtitle = async () => ({ lang: 'ai-zh', rows: ROWS, needLogin: false })
    const second = await runRound({ cfg: commentCfg, client: client2, store: store2, home: home2, now: new Date('2026-10-17T18:00:00'), refine: refineOn })
    assert.equal(second.comment.posted, false)
    assert.match(second.comment.why, /今天已经发过 1 条/)
    assert.equal(client2.posted.length, 1, '上限是每天 1 条，不能发第二条')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('0.2.1：refine 被跳过（refined=0）→ counts.commented 不增，记 skipped (no refined content)', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const client = makeClient()
    const cfg = {
      keywords: ['x'], perDay: 2, minScore: 50, days: 7, maxPages: 1,
      autoComment: true, mentionName: '', commentPerRound: 1, commentMinScore: 0,
      refine: true, refinePerRound: 2,
    }
    // dailyRemaining=0 = 当天前面几轮把提炼额度用完了（真机事故同款状态）
    const r = await runRound({
      cfg, client, store, home, now: new Date('2026-10-17T13:00:00'), uname: '小小鲸鱼娘',
      refine: { available: true, provider: 'deepseek-official', model: 'deepseek-flash', dailyRemaining: 0, call: async () => MODEL_JSON },
    })
    const withSub = r.picked.filter((p) => p.subtitleSource === 'subtitle')
    assert.ok(withSub.length >= 1)
    assert.ok(withSub.every((p) => p.refine === 'skipped'), '额度用完的条目应该标 skipped')
    assert.equal(r.counts.refined, 0)
    assert.equal(r.comment.posted, false)
    assert.equal(r.comment.skipped, true)
    assert.equal(r.comment.reason, 'skipped (no refined content)')
    assert.match(r.comment.why, /skipped \(no refined content\)/)
    assert.equal(r.counts.commented, 0, '跳过评论时 counts.commented 必须保持 0')
    assert.equal(client.posted.length, 0, '一条评论都不许发')
    // 报告与状态里都能看见原因
    const report = readFileSync(r.report, 'utf8')
    assert.match(report, /跳过发评论/)
    assert.match(report, /skipped \(no refined content\)/)
    assert.match(roundStatusText(r), /评论跳过（no refined content）/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('0.2.1 事故回归：事故字幕 + refine=0 时评论文案为 null，报告/评论里没有 ASR 原文', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const client = onlyFirstVideo(makeClient({ rows: ACC_ROWS }))
    const cfg = {
      keywords: ['x'], perDay: 1, minScore: 50, days: 7, maxPages: 1,
      autoComment: true, mentionName: '乌子鱼不在家', commentPerRound: 1, commentMinScore: 0,
      refine: true, refinePerRound: 2,
    }
    const r = await runRound({
      cfg, client, store, home, now: new Date('2026-10-17T13:00:00'), uname: '小小鲸鱼娘',
      refine: { available: true, provider: 'deepseek-official', model: 'deepseek-flash', dailyRemaining: 0, call: async () => MODEL_JSON },
    })
    assert.equal(r.picked.length, 1)
    assert.equal(r.picked[0].bvid, 'BV1aaaaaaaaa')
    assert.equal(r.picked[0].refine, 'skipped')
    assert.equal(r.comment.posted, false)
    assert.equal(r.comment.skipped, true)
    assert.equal(client.posted.length, 0, '事故条件下一条评论都不许发')
    assert.equal(r.counts.commented, 0)
    // 评论对象里不许夹带任何 ASR 片段
    assert.doesNotMatch(JSON.stringify(r.comment), /dB sk|新的fla/)
    // 报告「这一轮的评论」一节里也不许出现
    const commentSection = readFileSync(r.report, 'utf8').split('## 这一轮的评论')[1] || ''
    assert.doesNotMatch(commentSection, /dB sk|新的fla/)

    // 素材层证据：摘句兜底里**确实**有事故原文，但 composeComment 拒绝拿它拼文案
    const sents = sentencesFromRows(ACC_ROWS)
    const excerpt = extractMaterial(sents, { keywords: ['x'], maxPoints: 20 })
    const noisy = excerpt.points.find((p) => /dB sk/.test(p.text) && /新的fla/.test(p.text))
    assert.ok(noisy, `事故字幕的摘句里应该有 ASR 原文：${excerpt.points.map((p) => p.text).join(' / ')}`)
    assert.equal(composeComment({
      mentionName: '乌子鱼不在家', material: excerpt, bvid: 'BV1n9Jv6QE3A', refine: 'excerpt',
    }), null, 'refine 缺失时不许拼 excerpt')
    // 就算被误标成 model，只要引用的还是这段噪声 → 剔除不了就整条不发
    assert.equal(composeComment({
      mentionName: '乌子鱼不在家',
      material: { points: [{ text: noisy.text }] },
      bvid: 'BV1n9Jv6QE3A',
      refine: 'model',
      transcriptText: ACC_ROWS.map((row) => row.text).join('\n'),
    }), null)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('0.2.1：mentionName 空值 → 自动 @ 登录账号；填了但和登录名不一致 → posted 里带醒目提示', async () => {
  const refineOn = { available: true, provider: 'deepseek-official', model: 'deepseek-flash', call: async () => MODEL_JSON }
  const base = {
    keywords: ['x'], perDay: 1, minScore: 50, days: 7, maxPages: 1,
    autoComment: true, commentPerRound: 1, commentMinScore: 0, refine: true, refinePerRound: 2,
  }
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const client = onlyFirstVideo(makeClient())
    const auto = await runRound({
      cfg: { ...base, mentionName: '' }, client, store, home,
      now: new Date('2026-10-17T13:00:00'), uname: '小小鲸鱼娘', refine: refineOn,
    })
    assert.equal(auto.comment.posted, true)
    assert.match(client.posted[0].message, /^@小小鲸鱼娘 /, '留空应该自动 @ 登录账号')
    assert.equal(auto.comment.mention.source, 'credential')
    assert.equal(auto.comment.mention.mismatch, false)
  } finally { rmSync(home, { recursive: true, force: true }) }

  const home2 = tmpHome()
  try {
    const store2 = new NoteStore(home2)
    const client2 = onlyFirstVideo(makeClient())
    const manual = await runRound({
      cfg: { ...base, mentionName: '乌子鱼不在家' }, client: client2, store: store2, home: home2,
      now: new Date('2026-10-17T13:00:00'), uname: '小小鲸鱼娘', refine: refineOn,
    })
    assert.equal(manual.comment.posted, true)
    assert.match(client2.posted[0].message, /^@乌子鱼不在家 /, '手填的值不许被登录名覆盖')
    assert.equal(manual.comment.mention.mismatch, true)
    assert.match(manual.comment.mention.warn, /@ 名（乌子鱼不在家）≠ 登录名（小小鲸鱼娘）/)
    assert.match(readFileSync(manual.report, 'utf8'), /@ 名.*≠ 登录名.*@ 错人/)
  } finally { rmSync(home2, { recursive: true, force: true }) }
})

test('runRound：搜索全挂也不会崩（把错误写进报告，不抛）', async () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    const client = {
      async search() { throw new Error('被 B站 风控拦了（-412）：等 1–2 分钟再试') },
      async videoInfo() { throw new Error('不该走到这') },
      async pickSubtitle() { return { rows: [] } },
      async comments() { return [] },
      async sendComment() { throw new Error('不该走到这') },
    }
    const r = await runRound({ cfg: { keywords: ['x'], perDay: 2, minScore: 50, days: 7, maxPages: 1 }, client, store, home, now: new Date('2026-10-17T13:00:00') })
    assert.equal(r.picked.length, 0)
    assert.equal(r.counts.failed, 0)
    assert.ok(r.errors.length >= 1)
    assert.match(r.errors[0], /风控/)
    assert.ok(existsSync(r.report))
    assert.match(readFileSync(r.report, 'utf8'), /这一轮的小故障/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
