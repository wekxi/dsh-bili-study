/**
 * tests/client-render.test.mjs —— 浏览器半端真渲染一遍（离线）
 * ============================================================================
 * 为什么要这个：`selfcheck.mjs` 只验到"`settings.section` 注册上了 + 组件是个函数"，
 * **组件体里的 JSX 一次都没执行过** —— 写错一个变量，宿主里就是白屏，而这边的预检全绿。
 * 这里拿一个假 React 把两页真的渲染一遍（useState 用队列喂值，useEffect 不跑），
 * 把它变成一个能在 `node --test` 里抓住的错。
 *
 * 断言的重点是 P2 的「补跑」：设置页要看得到开关与状态，面板也要能看到。
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 假 React：useState 按队列喂值（每个组件渲染前由测试重置），足够跑通纯展示逻辑。 */
function makeReact() {
  let queue = []
  let at = 0
  return {
    __reset(values) { queue = values; at = 0 },
    createElement(tag, props, ...children) { return { tag, props: props || {}, children: children.flat(Infinity) } },
    useState(init) { const v = at < queue.length ? queue[at] : init; at += 1; return [v, () => {}] },
    useEffect() {},
    useMemo(fn) { return fn() },
    Fragment: 'Fragment',
  }
}

/** 把渲染树里的字符串全捡出来（含 label/title/placeholder 这类 props 文案）。 */
function collectStrings(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const n of node) collectStrings(n, out); return out }
  if (typeof node === 'object' && node.tag !== undefined) {
    for (const k of ['label', 'title', 'placeholder', 'note']) {
      const v = node.props?.[k]
      if (typeof v === 'string') out.push(v)
    }
    collectStrings(node.children, out)
  }
  return out
}

/** 载入 client bundle，拿到两个 section 的组件工厂。 */
async function loadSections() {
  let loaded = null
  const prevWindow = globalThis.window
  const prevDoc = globalThis.document
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { appendChild() {} } }
  const sections = []
  try {
    await import(`../client.js?render=${Date.now()}-${Math.random()}`)
    assert.ok(loaded, 'client.js 没有调 window.__ModuleLoader__.load')
    const React = makeReact()
    const mod = loaded.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
    mod.apply({
      effect: (fn) => fn(),
      slots: { inject: (name, fn) => fn(), register: (opts, Component) => { sections.push({ opts, Component }); return {} } },
    })
    return { React, sections }
  } finally {
    globalThis.window = prevWindow
    globalThis.document = prevDoc
  }
}

/** 渲染一个 section：component() 得到元素，再手动调用它的组件函数。 */
function render(React, section, useStates) {
  React.__reset(useStates)
  const element = section.Component()
  assert.equal(typeof element.tag, 'function', 'section 的 component 应该返回一个组件元素')
  return collectStrings(element.tag(element.props))
}

const STATUS = {
  ok: true,
  home: '/tmp/home',
  today: '2026-10-17',
  config: {
    enabled: true, keywords: ['x'], perDay: 2, minScore: 55, days: 7, subtitleLang: 'ai-zh',
    maxPages: 2, peakValley: true, noon: true, night: false, autoComment: false, mentionName: '',
    commentPerRound: 1, commentMinScore: 65, catchUp: true,
    refine: true, refineMaxChars: 12000, refineModel: '', refinePerRound: 2,
  },
  windows: { noon: { label: '中午谷时', start: '12:00', end: '14:00' }, night: { label: '夜间', start: '18:00', end: '09:00' } },
  credential: { loggedIn: false, masked: '', hasCsrf: false, uname: '' },
  running: false,
  ranToday: 0,
  lastRunAt: '',
  lastStatus: '还没跑过',
  catchUp: { enabled: true, todayRan: false, state: 'pending', text: '今天未跑·待补', attempts: 0, lastAt: '', lastError: '' },
  refine: {
    enabled: true, available: true, provider: 'deepseek-official', model: 'deepseek-flash',
    promptVersion: 'bili-study-refine-v1', maxChars: 12000, perRound: 2,
    todayCalls: 2, todayFailed: 0, yesterdayCalls: 1,
    lastRound: { calls: 2, failed: 0, available: true, provider: 'deepseek-official', model: 'deepseek-flash' },
  },
  stats: { learnedTodayCount: 0, dueCount: 0 },
  report: '/tmp/home/out/2026-10-17.md',
  notesDir: '/tmp/home/notes',
}

const TODAY = {
  ok: true, date: '2026-10-17', status: '今天还没跑', lastRunAt: '', counts: null,
  learned: [], due: [], dueCount: 0, totalVideos: 0, totalNotes: 0,
  report: '/tmp/home/out/2026-10-17.md', comment: null, errors: [],
  catchUp: { enabled: true, todayRan: false, state: 'pending', text: '今天未跑·待补', attempts: 0 },
}

test('设置页能真渲染，并带「补跑：开」开关与「今天未跑·待补」状态', async () => {
  const { React, sections } = await loadSections()
  const settings = sections.find((s) => s.opts.id === 'bili-study')
  assert.ok(settings, '没有设置页 section')
  // useState 顺序：useJson 的 data，然后 busy/msg/tone/kws/perDay/minScore/days/mention/perRound/cookie/loginState/loginTone
  const text = render(React, settings, [STATUS, '', '', '', null, null, null, null, null, null, '', '', ''])
  assert.ok(text.includes('补跑：开'), `设置页没出现「补跑：开」：${text.join(' | ').slice(0, 300)}`)
  assert.ok(text.includes('今天：今天未跑·待补'), '设置页没把补跑状态显示出来')
  assert.ok(text.some((t) => t.includes('下次打开')), '补跑那一行没有解释（手机上要看得懂）')
})

test('设置页：补跑关着时显示「补跑：关」', async () => {
  const { React, sections } = await loadSections()
  const settings = sections.find((s) => s.opts.id === 'bili-study')
  const off = { ...STATUS, config: { ...STATUS.config, catchUp: false }, catchUp: { ...STATUS.catchUp, enabled: false, state: 'off', text: '补跑：关' } }
  const text = render(React, settings, [off, '', '', '', null, null, null, null, null, null, '', '', ''])
  assert.ok(text.includes('补跑：关'), `补跑关掉后没显示「补跑：关」：${text.join(' | ').slice(0, 300)}`)
  assert.ok(text.includes('今天：补跑：关'))
})

test('「今天学了什么」页能真渲染，并显示补跑状态', async () => {
  const { React, sections } = await loadSections()
  const today = sections.find((s) => s.opts.id === 'bili-study-today')
  assert.ok(today, '没有「今天学了什么」section')
  // useState 顺序：useJson 的 data、busy、msg
  const text = render(React, today, [TODAY, '', ''])
  assert.ok(text.some((t) => t.includes('今天学了')), '没渲染出「今天学了」')
  assert.ok(text.some((t) => t.includes('今天未跑·待补')), `面板没显示补跑状态：${text.join(' | ').slice(0, 300)}`)
})

test('「今天学了什么」：今天已跑时显示「今天已跑」', async () => {
  const { React, sections } = await loadSections()
  const today = sections.find((s) => s.opts.id === 'bili-study-today')
  const done = { ...TODAY, status: '候选 2 条 · 挑中 2 条', catchUp: { ...TODAY.catchUp, todayRan: true, text: '今天已跑' } }
  const text = render(React, today, [done, '', ''])
  assert.ok(text.some((t) => t.includes('今天已跑')), `面板没显示「今天已跑」：${text.join(' | ').slice(0, 300)}`)
})

/* ─────────────── P3：模型提炼 ─────────────── */

test('设置页：模型提炼开关、宿主模型与调用计数都在', async () => {
  const { React, sections } = await loadSections()
  const settings = sections.find((s) => s.opts.id === 'bili-study')
  const text = render(React, settings, [STATUS, '', '', '', null, null, null, null, null, null, '', '', ''])
  assert.ok(text.includes('模型提炼：开'), `没有提炼开关：${text.join(' | ').slice(0, 400)}`)
  assert.ok(text.some((t) => t.includes('deepseek-official / deepseek-flash')), '没显示宿主模型路由')
  assert.ok(text.some((t) => t.includes('本轮模型调用 2 次')), '没显示本轮调用次数')
  assert.ok(text.some((t) => t.includes('今天 2 次') && t.includes('昨天 1 次')), '没显示今天/昨天消耗')
})

test('设置页：宿主没模型时明确提示改用 bili_study_digest', async () => {
  const { React, sections } = await loadSections()
  const settings = sections.find((s) => s.opts.id === 'bili-study')
  const noModel = {
    ...STATUS,
    refine: { ...STATUS.refine, available: false, reason: '宿主没有 llm 服务', provider: '', model: '', todayCalls: 0, yesterdayCalls: 0, lastRound: null },
  }
  const text = render(React, settings, [noModel, '', '', '', null, null, null, null, null, null, '', '', ''])
  assert.ok(text.some((t) => t.includes('宿主没有可用模型')), '没把不可用原因显示出来')
  assert.ok(text.some((t) => t.includes('bili_study_digest')), '没提示改用 digest')
})

test('设置页：提炼关掉时显示「模型提炼：关」并说明与 0.1.0 一致', async () => {
  const { React, sections } = await loadSections()
  const settings = sections.find((s) => s.opts.id === 'bili-study')
  const off = { ...STATUS, config: { ...STATUS.config, refine: false }, refine: { ...STATUS.refine, enabled: false } }
  const text = render(React, settings, [off, '', '', '', null, null, null, null, null, null, '', '', ''])
  assert.ok(text.includes('模型提炼：关'))
  assert.ok(text.some((t) => t.includes('0.1.0')), '关掉时应该说明是 0.1.0 的摘句行为')
})

test('「今天学了什么」：每条笔记标出 model / 摘句兜底', async () => {
  const { React, sections } = await loadSections()
  const today = sections.find((s) => s.opts.id === 'bili-study-today')
  const data = {
    ...TODAY,
    status: '挑中 2 条',
    learned: [
      { bvid: 'BV1aaaaaaaaa', title: '模型写的那条', score: 80, verdict: '强烈推荐', refine: 'model' },
      { bvid: 'BV1bbbbbbbbb', title: '摘句兜底那条', score: 60, verdict: '一般', refine: 'failed' },
    ],
  }
  const text = render(React, today, [data, '', ''])
  assert.ok(text.some((t) => t.includes('提炼：模型')), '面板没标出模型写的那条')
  assert.ok(text.some((t) => t.includes('提炼：模型失败·摘句兜底')), '面板没标出失败的兜底那条')
})
