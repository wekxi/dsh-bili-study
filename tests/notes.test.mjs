/**
 * tests/notes.test.mjs —— 笔记库：六节渲染 / bigram 检索 / 复习阶梯 / 原子写
 * 全部在临时目录里跑，不碰真数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NoteStore, cjkTokens, queryTokens, fmtHms, snippetOf, roundHalfEven,
  SECTION_POINTS, SECTION_TIMELINE, SECTION_QUOTES, SECTION_JUDGMENT, SECTION_WORTH,
} from '../lib/notes.js'

const tmpHome = () => mkdtempSync(join(tmpdir(), 'bili-notes-'))

test('cjkTokens：中文切 bigram、英文按词', () => {
  assert.deepEqual(cjkTokens('跨视频检索'), ['跨视', '视频', '频检', '检索'])
  assert.deepEqual(cjkTokens('Python 3.12 新特性'), ['python', '3.12', '新特', '特性'])
  assert.deepEqual(cjkTokens(''), [])
})

test('queryTokens：去停用词与单字噪声', () => {
  assert.deepEqual(queryTokens('这个 渐进式披露'), ['渐进', '进式', '式披', '披露'])
})

test('roundHalfEven / fmtHms', () => {
  assert.equal(roundHalfEven(2.5), 2)
  assert.equal(roundHalfEven(3.5), 4)
  assert.equal(roundHalfEven(1.15, 1), 1.2)  // 十进制 half-even：1.15 的 .5 位取偶数（1.2）
  assert.equal(fmtHms(221), '3:41')
  assert.equal(fmtHms(3723), '1:02:03')
})

test('六节渲染：顺序固定、金句加 >、时间轴带 [MM:SS]', () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    store.upsertVideo({
      bvid: 'BV1ahFmzqE9z', title: '测试视频', author: 'UP', pubdateText: '2026-10-01',
      durationSec: 2210, score: 82, verdict: '强烈推荐', reasons: ['+12 x'], topics: ['渐进', '披露'],
      play: 12000, like: 300, pageCount: 3, desc: 'd', subtitle: { source: 'subtitle', lang: 'ai-zh', pages: 2, lines: 300 },
    })
    store.addNote('BV1ahFmzqE9z', { section: SECTION_POINTS, body: '第一点' })
    store.addNote('BV1ahFmzqE9z', { section: SECTION_TIMELINE, body: '这句是术语出处', ts: '03:41' })
    store.addNote('BV1ahFmzqE9z', { section: SECTION_QUOTES, body: '核心是把复杂度推给模型' })
    store.addNote('BV1ahFmzqE9z', { section: SECTION_JUDGMENT, body: '讲得实，值得看' })
    store.addNote('BV1ahFmzqE9z', { section: SECTION_WORTH, body: '值得' })
    store.addNote('BV1ahFmzqE9z', { section: '冷知识', body: '额外一条' })
    const md = store.renderMarkdown('BV1ahFmzqE9z')
    const order = ['## 要点', '## 时间轴锚点', '## 金句', '## 我的判断', '## 值不值得再看', '## 其它']
    const idx = order.map((h) => md.indexOf(h))
    assert.ok(idx.every((i) => i >= 0), `六个小节都要在：${JSON.stringify(idx)}`)
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, '小节顺序固定')
    assert.match(md, /- \[03:41\] 这句是术语出处/)
    assert.match(md, /- > 核心是把复杂度推给模型/)
    assert.match(md, /\| BV号 \| \[BV1ahFmzqE9z\]\(https:\/\/www\.bilibili\.com\/video\/BV1ahFmzqE9z\) \|/)
    assert.match(md, /可靠性分 82\/100 强烈推荐/)
    assert.match(md, /字幕 ai-zh/)
    // 渲染视图落盘
    const p = store.saveRendered('BV1ahFmzqE9z')
    assert.ok(existsSync(p))
    assert.equal(readFileSync(p, 'utf8'), md)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('没有字幕的笔记：渲染里必须如实写明"没有可用字幕"', () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    store.upsertVideo({ bvid: 'BV1aaaaaaaaa', title: '无字幕视频', score: 40, verdict: '不建议看(引流嫌疑)', subtitle: { source: 'fallback', lines: 0, pages: 0 } })
    const md = store.renderMarkdown('BV1aaaaaaaaa')
    assert.match(md, /没有可用字幕/)
    assert.match(md, /简介 \+ 评论兜底/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('bigram 检索：跨视频命中 + 高亮片段 + 整串命中加分', () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    store.upsertVideo({ bvid: 'BV1aaaaaaaaa', title: 'Agent 教程', score: 80, verdict: '强烈推荐' })
    store.upsertVideo({ bvid: 'BV1bbbbbbbbb', title: 'RAG 实战', score: 70, verdict: '值得一看' })
    store.addNote('BV1aaaaaaaaa', { section: SECTION_POINTS, body: '渐进式披露是这个设计的核心：先给名字，再看描述' })
    store.addNote('BV1aaaaaaaaa', { section: SECTION_QUOTES, body: '不要在上下文里塞满所有东西' })
    store.addNote('BV1bbbbbbbbb', { section: SECTION_POINTS, body: '检索增强生成要做 chunk 切分' })
    const hits = store.find({ query: '渐进式披露' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].bvid, 'BV1aaaaaaaaa')
    assert.match(hits[0].snippet, /\[\[渐进式披露\]\]/)
    assert.ok(hits[0].score > 0)

    const secHits = store.find({ query: '上下文', section: SECTION_QUOTES })
    assert.equal(secHits.length, 1)
    assert.equal(secHits[0].section, SECTION_QUOTES)

    const none = store.find({ query: '量子力学' })
    assert.deepEqual(none, [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('复习阶梯：1 → 3 → 7 → 16 → 35 天，之后按 ease 推进', () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    store.upsertVideo({ bvid: 'BV1aaaaaaaaa', title: 'T', score: 80 })
    store.ensureReview('BV1aaaaaaaaa', '2026-10-17')
    assert.equal(store.video('BV1aaaaaaaaa').review.nextReview, '2026-10-18', '新笔记默认明天复习')

    const steps = []
    for (let i = 0; i < 5; i += 1) {
      const r = store.grade('BV1aaaaaaaaa', 'good', '2026-10-17')
      steps.push([r.intervalDays, r.nextReview])
    }
    assert.deepEqual(steps, [
      [1, '2026-10-18'],
      [3, '2026-10-20'],
      [7, '2026-10-24'],
      [16, '2026-11-02'],
      [35, '2026-11-21'],
    ])
    const six = store.grade('BV1aaaaaaaaa', 'good', '2026-10-17')
    assert.equal(six.intervalDays, 87.5)                  // base(35) * ease(2.5)
    assert.equal(six.nextReview, '2027-01-13')            // 2026-10-17 + 88 天（round half-even）
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('复习：hard/easy/again 各自的影响', () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    for (const id of ['BV1h', 'BV1e', 'BV1g']) store.upsertVideo({ bvid: id, title: id, score: 70 })

    const h = store.grade('BV1h', 'hard', '2026-10-17')
    assert.equal(h.intervalDays, 1)          // 1 * 0.8 → 至少 1
    assert.equal(h.ease, 2.35)
    const e = store.grade('BV1e', 'easy', '2026-10-17')
    assert.equal(e.intervalDays, 1.3)
    assert.equal(e.nextReview, '2026-10-18')
    assert.equal(e.ease, 2.6)
    const a = store.grade('BV1g', 'again', '2026-10-17')
    assert.equal(a.intervalDays, 0)
    assert.equal(a.nextReview, '2026-10-17')  // 当天再来
    assert.equal(a.reps, 0)
    assert.equal(a.lapses, 1)
    assert.equal(a.ease, 2.3)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('due：只出到期的，逾期天数算对', () => {
  const home = tmpHome()
  try {
    const store = new NoteStore(home)
    store.upsertVideo({ bvid: 'BV1aaaaaaaaa', title: 'A', score: 80 })
    store.upsertVideo({ bvid: 'BV1bbbbbbbbb', title: 'B', score: 80 })
    store.ensureReview('BV1aaaaaaaaa', '2026-10-10')   // 早就该复习
    store.ensureReview('BV1bbbbbbbbb', '2026-10-10')
    store.video('BV1aaaaaaaaa').review.nextReview = '2026-10-10'
    store.video('BV1bbbbbbbbb').review.nextReview = '2026-12-01'  // 还没到
    store.save()
    const due = store.due('2026-10-17', 10)
    assert.equal(due.length, 1)
    assert.equal(due[0].bvid, 'BV1aaaaaaaaa')
    assert.equal(due[0].overdueDays, 7)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('判重 + 原子写：重新打开库，笔记还在', () => {
  const home = tmpHome()
  try {
    const s1 = new NoteStore(home)
    s1.upsertVideo({ bvid: 'BV1aaaaaaaaa', title: 'A', score: 80 })
    s1.addNote('BV1aaaaaaaaa', { section: SECTION_POINTS, body: '持久化测试' })
    s1.markSeen('BV1bbbbbbbbb', '关键词')
    s1.save()
    const s2 = new NoteStore(home)
    assert.equal(s2.notesOf('BV1aaaaaaaaa').length, 1)
    assert.equal(s2.hasSeen('BV1bbbbbbbbb'), true)
    assert.equal(s2.hasSeen('BV1cccccccccc'), false)
    assert.ok(existsSync(join(home, 'notes', 'library.json')))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('snippetOf：高亮命中，没命中就取前 60 字', () => {
  const body = '前面一堆废话，渐进式披露是关键设计。'
  assert.match(snippetOf(body, '渐进式披露'), /\[\[渐进式披露\]\]/)
  assert.equal(snippetOf('短文本', '不存在'), '短文本')
  assert.equal(snippetOf('', 'x'), '')
})
