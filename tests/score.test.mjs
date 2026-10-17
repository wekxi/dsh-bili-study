/**
 * tests/score.test.mjs —— 打分数值：与 Python 原版（bilibili-study/scripts/bili_score.py）逐字对照
 *
 * golden 用例是拿 Python 原版跑出来的（`tests/fixtures/score-golden.json`），
 * 连 score / verdict / reasons 的**标点**都一起比 —— 口径不许飘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scoreVideo, fmtCount, fmtDuration, fmtDate, cleanHtml, roundedFixed } from '../lib/score.js'

const golden = JSON.parse(readFileSync(new URL('./fixtures/score-golden.json', import.meta.url), 'utf8'))

test('golden：10 个真实口径用例，score/verdict/reasons 与 Python 原版逐字一致', () => {
  assert.equal(golden.cases.length, 10)
  for (const c of golden.cases) {
    const got = scoreVideo(c.input)
    assert.equal(got.score, c.expect.score, `${c.id}: score`)
    assert.equal(got.verdict, c.expect.verdict, `${c.id}: verdict`)
    assert.deepEqual(got.reasons, c.expect.reasons, `${c.id}: reasons`)
  }
})

test('分级阈值：80/65/50 三档的边界', () => {
  assert.equal(scoreVideo({ title: '手写操作系统 第3讲 中断与异常', desc: 'github.com/x/y', play: 20000, like: 600 }).verdict, '强烈推荐')
  const low = scoreVideo({ title: '全999集 资源', desc: '', play: 10, like: 0 })
  assert.equal(low.verdict, '不建议看(引流嫌疑)')
  assert.ok(low.score < 50)
})

test('fmtCount：half-even（Python %.1f 口径），12,500 播放必须是 1.2万', () => {
  assert.equal(fmtCount(12500), '1.2万')
  assert.equal(fmtCount(13500), '1.4万')      // 1.35 → 1.4（偶数位在 4）
  assert.equal(fmtCount(999), '999')
  assert.equal(fmtCount(10000), '1.0万')
  assert.equal(fmtCount(123456789), '1.2亿')
  assert.equal(roundedFixed(2.25, 1), '2.2')  // half-even：2.25 → 2.2
  assert.equal(roundedFixed(2.35, 1), '2.4')
})

test('fmtDuration：整除不四舍五入（654 秒是 10:54，不是 11:54）', () => {
  assert.equal(fmtDuration(654), '10:54')
  assert.equal(fmtDuration(59), '0:59')
  assert.equal(fmtDuration(3600), '1:00:00')
  assert.equal(fmtDuration(3661), '1:01:01')
  assert.equal(fmtDuration(-1), '')
})

test('fmtDate：秒 → 本地日期', () => {
  const d = new Date(2026, 9, 17, 12, 0, 0)
  assert.equal(fmtDate(d.getTime() / 1000), '2026-10-17')
})

test('cleanHtml：搜索结果里的 <em> 高亮与 HTML 实体', () => {
  assert.equal(cleanHtml('<em class="keyword">线性代数</em> &amp; 习题'), '线性代数 & 习题')
  assert.equal(cleanHtml(''), '')
})
