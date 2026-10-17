/**
 * tests/wbi.test.mjs —— WBI 签名 + 时间轴格式化 + B站 接口的纯函数部分
 *
 * WBI 的已知向量来自 bilibili-API-collect 的公开示例：
 *   imgKey = 7cd084941338484aae1ad9425b84077c
 *   subKey = 4932caff0ff746eab6f01bf08b70ac45
 *   → mixinKey = ea1db124af3c7062474693fa704f4ff8
 * （本机实测 nav 接口返回的正是这两个 key，所以这条向量是活的，不是编的）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIXIN_KEY_ENC_TAB, mixinKey, wbiKeysFromImgUrl, sanitizeWbiValue, encWbi, fmtTs, parseTs,
  extractBvid, durationTextToSec, parseSearchItems, cleanComment, normalizeView, withinDays,
  subtitleRowsFromBody, hintForCode,
} from '../lib/bili-api.js'

test('置换表是 64 项且每个下标只出现一次', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64)
  assert.equal(new Set(MIXIN_KEY_ENC_TAB).size, 64)
  assert.deepEqual(MIXIN_KEY_ENC_TAB.slice(0, 10), [46, 47, 18, 2, 53, 8, 23, 32, 15, 50])
})

test('mixinKey：公开的已知向量', () => {
  const mix = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  assert.equal(mix, 'ea1db124af3c7062474693fa704f4ff8')
})

test('wbiKeysFromImgUrl：从 nav 的 wbi_img 里取文件名', () => {
  const k = wbiKeysFromImgUrl(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  )
  assert.deepEqual(k, { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' })
})

test('sanitizeWbiValue：只去 !\'()* 这五个字符', () => {
  assert.equal(sanitizeWbiValue("a!b'c(d)e*f"), 'abcdef')
  assert.equal(sanitizeWbiValue('线性代数 18.06'), '线性代数 18.06')
})

test('encWbi：键排序 + wts + 32 位 md5，且 wts 相同则签名稳定', () => {
  const mix = 'ea1db124af3c7062474693fa704f4ff8'
  const q1 = encWbi({ b: '2', a: '1', keyword: '线性代数' }, mix, 1700000000)
  const q2 = encWbi({ keyword: '线性代数', a: '1', b: '2' }, mix, 1700000000)
  assert.equal(q1, q2, '参数顺序不该影响签名')
  assert.match(q1, /^a=1&b=2&keyword=%E7%BA%BF%E6%80%A7%E4%BB%A3%E6%95%B0&wts=1700000000&w_rid=[0-9a-f]{32}$/)
  assert.notEqual(q1, encWbi({ b: '2', a: '1', keyword: '线性代数' }, mix, 1700000001), 'wts 变了签名要变')
})

test('fmtTs：百分秒格式化与 Python 版一致', () => {
  assert.equal(fmtTs(0), '[00:00.00]')
  assert.equal(fmtTs(0.28), '[00:00.28]')
  assert.equal(fmtTs(61.5), '[01:01.50]')
  assert.equal(fmtTs(3900.05), '[65:00.05]')   // 超过 1 小时按总分钟数显示
  assert.equal(fmtTs(-3), '[00:00.00]')
})

test('parseTs：MM:SS / H:MM:SS → 秒', () => {
  assert.equal(parseTs('03:41'), 221)
  assert.equal(parseTs('1:02:03'), 3723)
  assert.equal(parseTs('[12:31]'), 751)
  assert.equal(parseTs('乱写'), -1)
})

test('extractBvid：BV 号与整条链接', () => {
  assert.equal(extractBvid('BV1ahFmzqE9z'), 'BV1ahFmzqE9z')
  assert.equal(extractBvid('https://www.bilibili.com/video/BV1ahFmzqE9z?spm=1'), 'BV1ahFmzqE9z')
  assert.equal(extractBvid('bv1ahFmzqE9z'), 'BV1ahFmzqE9z')
  assert.equal(extractBvid('没有号'), '')
})

test('durationTextToSec：搜索结果里的 "12:34" / "1:02:03"', () => {
  assert.equal(durationTextToSec('12:34'), 754)
  assert.equal(durationTextToSec('1:02:03'), 3723)
  assert.equal(durationTextToSec(''), 0)
})

test('parseSearchItems：标题去高亮、BV 过滤、字段归一', () => {
  const rows = parseSearchItems([
    { bvid: 'BV1ahFmzqE9z', title: '<em class="keyword">线性代数</em> 第1讲', author: '某UP', play: 12345, like: 300, duration: '12:34', pubdate: 1760000000, description: 'a &amp; b' },
    { bvid: 'not-a-bv', title: '垃圾条目' },
    null,
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '线性代数 第1讲')
  assert.equal(rows[0].play, 12345)
  assert.equal(rows[0].durationSec, 754)
  assert.equal(rows[0].desc, 'a & b')
  assert.equal(rows[0].url, 'https://www.bilibili.com/video/BV1ahFmzqE9z')
})

test('cleanComment：折叠空白 + 解实体', () => {
  assert.equal(cleanComment('  a\n\n  b&nbsp;c  '), 'a b c')
})

test('normalizeView：详情 → 扁平 meta（分P/平均时长/统计）', () => {
  const meta = normalizeView({
    bvid: 'BV1ahFmzqE9z', aid: 116044177936465, title: 'T', owner: { name: 'UP', mid: 42 },
    pubdate: 1760000000, duration: 3600, desc: 'D', tname: '科技',
    stat: { view: 1000, like: 50, coin: 5, favorite: 6, danmaku: 7, reply: 8 },
    pages: [{ page: 1, cid: 111, part: 'P1', duration: 1800 }, { page: 2, cid: 222, part: 'P2', duration: 1800 }],
  }, 'BV1ahFmzqE9z')
  assert.equal(meta.aid, 116044177936465)
  assert.equal(meta.pageCount, 2)
  assert.equal(meta.totalSec, 3600)
  assert.equal(meta.avgPageSec, 1800)
  assert.equal(meta.play, 1000)
  assert.equal(meta.pages[1].cid, 222)
  assert.equal(meta.url, 'https://www.bilibili.com/video/BV1ahFmzqE9z')
})

test('subtitleRowsFromBody：字幕 JSON → 片段数组（空行丢掉）', () => {
  const rows = subtitleRowsFromBody([{ from: 0.28, to: 1.5, content: '大家好' }, { from: 1.5, to: 2, content: '  ' }, { from: 2, to: 3, content: '我是谭森老师' }])
  assert.deepEqual(rows, [{ start: 0.28, end: 1.5, text: '大家好' }, { start: 2, end: 3, text: '我是谭森老师' }])
  assert.deepEqual(subtitleRowsFromBody(undefined), [])
})

test('withinDays：发布时间窗口', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  const twoDaysAgo = Math.floor(now / 1000) - 2 * 86400
  assert.equal(withinDays(twoDaysAgo, 7, now), true)
  assert.equal(withinDays(twoDaysAgo, 1, now), false)
  assert.equal(withinDays(0, 7, now), true, '没有发布时间就不拦')
})

test('hintForCode：常见错误码都有中文人话', () => {
  assert.match(hintForCode(-101), /没登录/)
  assert.match(hintForCode(-412), /风控/)
  assert.match(hintForCode(62002), /不可见|已删除/)
})
