/**
 * tests/catchup.test.mjs —— 补跑（catch-up）的全部规则，离线断言
 * ============================================================================
 * 背景：DSHA 跑在安卓上，**系统会杀后台、Doze 还会掐定时器**，所以「谷时到点自动跑」
 * 可能永远不触发。补跑就是兜底：今天没跑过 ⇒ 下次插件被激活/打开设置页时补一轮。
 *
 * 这个文件把四条硬约束逐条钉死：
 *   ① 今天未跑 → 补一次；② 今天已跑 → 不重复补；
 *   ③ enabled/手动模式关 → 不补；④ 补跑失败 → **绝不**把状态写成"已跑"。
 *
 * 全部纯逻辑：不联网、不写工作区（假宿主，state 在内存里）。
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CATCHUP_LIMITS, CATCHUP_LOG_LINE, autoRunMode, catchUpStatus,
  planCatchUp, recordCatchUp, runCatchUpOnce, todayRan,
} from '../lib/catchup.js'

/* ─────────────── 夹具 ─────────────── */

/** 2026-10-17 是周六，10-19 是周一（都按**本地时间**构造，避开时区解析歧义）。 */
const T = (h, m = 0, day = 17) => new Date(2026, 9, day, h, m, 0)

/** 一份"能自动跑"的配置；各用例只覆盖自己关心的字段。 */
const CFG = { enabled: true, peakValley: true, noon: true, night: false, perDay: 2, catchUp: true }
const cfgWith = (patch = {}) => ({ ...CFG, ...patch })

/** 假宿主：内存 state + 记录 startRound/log/writeState 的调用。 */
function fakeHost({ cfg = CFG, state = {}, report = false, result = { ok: true }, onRound = null } = {}) {
  const host = {
    cfg,
    state,
    writes: [],
    rounds: [],
    logs: [],
    report,
    result,
    readState: () => (host.state === null ? null : JSON.parse(JSON.stringify(host.state))),
    writeState: (patch) => { host.writes.push(patch); host.state = { ...(host.state || {}), ...patch }; return host.state },
    hasReport: (day) => { host.reportDays = [...(host.reportDays || []), day]; return host.report },
    startRound: async (why) => {
      host.rounds.push(why)
      if (onRound) onRound(host, why)
      return typeof host.result === 'function' ? host.result(why) : host.result
    },
    log: (m) => host.logs.push(String(m)),
  }
  return host
}

const runOnce = (host, over = {}) => runCatchUpOnce({
  cfg: host.cfg,
  now: T(13),
  trigger: 'boot',
  readState: host.readState,
  writeState: host.writeState,
  hasReport: host.hasReport,
  startRound: host.startRound,
  log: host.log,
  ...over,
})

/* ═══════════════ 1. 常量与文案（日志/界面靠它们对齐） ═══════════════ */

test('CATCHUP_LOG_LINE：就是需求里那行明确理由（逐字）', () => {
  assert.equal(CATCHUP_LOG_LINE, 'catch-up: 今天尚无 round，触发补跑')
})

test('CATCHUP_LIMITS：一天最多 3 次、两次失败至少隔 10 分钟', () => {
  assert.equal(CATCHUP_LIMITS.maxAttemptsPerDay, 3)
  assert.equal(CATCHUP_LIMITS.retryCooldownMs, 10 * 60 * 1000)
})

/* ═══════════════ 2. autoRunMode：什么算"自动模式" ═══════════════ */

test('autoRunMode：正常配置 = 自动模式', () => {
  assert.deepEqual(autoRunMode(CFG), { auto: true, why: '自动模式' })
})

test('autoRunMode：enabled=false → 不是自动模式（插件停用不补）', () => {
  const r = autoRunMode(cfgWith({ enabled: false }))
  assert.equal(r.auto, false)
  assert.match(r.why, /停用/)
})

test('autoRunMode：peakValley=false = 手动模式', () => {
  const r = autoRunMode(cfgWith({ peakValley: false }))
  assert.equal(r.auto, false)
  assert.match(r.why, /手动模式/)
})

test('autoRunMode：两个谷时窗口都关 = 手动模式', () => {
  const r = autoRunMode(cfgWith({ noon: false, night: false }))
  assert.equal(r.auto, false)
  assert.match(r.why, /窗口/)
})

test('autoRunMode：只要开着一个窗口就算自动模式', () => {
  assert.equal(autoRunMode(cfgWith({ noon: false, night: true })).auto, true)
})

test('autoRunMode：perDay=0（只能手动挑）→ 不自动', () => {
  const r = autoRunMode(cfgWith({ perDay: 0 }))
  assert.equal(r.auto, false)
  assert.match(r.why, /0 条/)
})

/* ═══════════════ 3. todayRan：状态文件 + out/ 报告，两处都看 ═══════════════ */

test('todayRan：状态文件写的是今天且 runs=1 → 跑过', () => {
  assert.equal(todayRan({ state: { day: '2026-10-17', runs: 1 }, today: '2026-10-17' }), true)
})

test('todayRan：状态文件是昨天的（哪怕 runs=5）→ 今天没跑过', () => {
  assert.equal(todayRan({ state: { day: '2026-10-16', runs: 5 }, today: '2026-10-17' }), false)
})

test('todayRan：day 是今天但 runs=0 → 没跑过', () => {
  assert.equal(todayRan({ state: { day: '2026-10-17', runs: 0 }, today: '2026-10-17' }), false)
})

test('todayRan：状态文件丢了，但 out/ 里有今天的报告 → 算跑过', () => {
  assert.equal(todayRan({ state: {}, today: '2026-10-17', hasReport: true }), true)
})

test('todayRan：state 是 null/空 → 不炸，且算没跑过', () => {
  assert.equal(todayRan({ state: null, today: '2026-10-17' }), false)
  assert.equal(todayRan({ today: '2026-10-17' }), false)
})

/* ═══════════════ 4. planCatchUp：该不该补（核心） ═══════════════ */

test('planCatchUp：今天没跑过 → 补一次，理由就是 CATCHUP_LOG_LINE', () => {
  const plan = planCatchUp({ cfg: CFG, state: {}, now: T(13) })
  assert.equal(plan.run, true)
  assert.equal(plan.reason, CATCHUP_LOG_LINE)
  assert.equal(plan.why, 'catch-up')
  assert.equal(plan.day, '2026-10-17')
  assert.equal(plan.attempt, 1)
})

test('planCatchUp：今天已跑（状态文件）→ 不重复补', () => {
  const plan = planCatchUp({ cfg: CFG, state: { day: '2026-10-17', runs: 1 }, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /今天已经跑过/)
})

test('planCatchUp：今天已跑（只有 out/ 报告）→ 不重复补', () => {
  const plan = planCatchUp({ cfg: CFG, state: {}, now: T(13), hasReport: true })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /今天已经跑过/)
})

test('planCatchUp：enabled=false → 不补（哪怕今天没跑）', () => {
  const plan = planCatchUp({ cfg: cfgWith({ enabled: false }), state: {}, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /停用/)
})

test('planCatchUp：补跑开关关着 → 不补', () => {
  const plan = planCatchUp({ cfg: cfgWith({ catchUp: false }), state: {}, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /开关/)
})

test('planCatchUp：手动模式（peakValley=false）→ 不补', () => {
  const plan = planCatchUp({ cfg: cfgWith({ peakValley: false }), state: {}, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /手动模式/)
})

test('planCatchUp：两个窗口都关 → 不补', () => {
  const plan = planCatchUp({ cfg: cfgWith({ noon: false, night: false }), state: {}, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /窗口/)
})

test('planCatchUp：perDay=0 → 不补', () => {
  const plan = planCatchUp({ cfg: cfgWith({ perDay: 0 }), state: {}, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /0 条/)
})

test('planCatchUp：上一轮还在跑 → 不补（不叠加）', () => {
  const plan = planCatchUp({ cfg: CFG, state: {}, now: T(13), running: true })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /还在跑/)
})

test('planCatchUp：⭐ 不在任何窗口里也补（凌晨 03:30，只有中午窗口开着）', () => {
  const plan = planCatchUp({ cfg: CFG, state: {}, now: T(3, 30) })
  assert.equal(plan.run, true, '补跑不等下一个窗口：安卓上等窗口 = 永远不跑')
})

test('planCatchUp：⭐ 周末也补（代码里没有工作日判断）', () => {
  const sunday = new Date(2026, 9, 18, 22, 0, 0)
  assert.equal(sunday.getDay(), 0, '夹具断言：2026-10-18 必须是周日')
  assert.equal(planCatchUp({ cfg: CFG, state: {}, now: sunday }).run, true)
})

test('planCatchUp：刚失败过（冷却期内）→ 等一下再补', () => {
  const state = { catchUp: { day: '2026-10-17', attempts: 1, lastAt: T(12, 58).toISOString(), lastOk: false, lastError: '被风控' } }
  const plan = planCatchUp({ cfg: CFG, state, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /分钟后再试/)
})

test('planCatchUp：失败但冷却期过了 → 允许再补（attempt=2）', () => {
  const state = { catchUp: { day: '2026-10-17', attempts: 1, lastAt: T(12, 30).toISOString(), lastOk: false, lastError: '被风控' } }
  const plan = planCatchUp({ cfg: CFG, state, now: T(13) })
  assert.equal(plan.run, true)
  assert.equal(plan.attempt, 2)
})

test('planCatchUp：今天已经试满 3 次 → 放弃（不再消耗）', () => {
  const state = { catchUp: { day: '2026-10-17', attempts: 3, lastAt: T(10).toISOString(), lastOk: false, lastError: '连不上' } }
  const plan = planCatchUp({ cfg: CFG, state, now: T(13) })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /放弃/)
})

test('planCatchUp：昨天失败的 attempts 不算今天头上（新的一天重新计数）', () => {
  const state = { catchUp: { day: '2026-10-16', attempts: 3, lastAt: T(10, 0, 16).toISOString(), lastOk: false } }
  const plan = planCatchUp({ cfg: CFG, state, now: T(13) })
  assert.equal(plan.run, true)
  assert.equal(plan.attempt, 1)
})

test('planCatchUp：状态里 lastOk=true 但今天没有 runs（脏数据）→ 仍然补，别信错字段', () => {
  const state = { catchUp: { day: '2026-10-17', attempts: 1, lastAt: T(12, 59).toISOString(), lastOk: true } }
  assert.equal(planCatchUp({ cfg: CFG, state, now: T(13) }).run, true)
})

test('planCatchUp：state 为 null（文件坏了）→ 当成没跑过，补一次', () => {
  assert.equal(planCatchUp({ cfg: CFG, state: null, now: T(13) }).run, true)
})

test('planCatchUp：limits 可注入（这里把上限压到 1 次）', () => {
  const state = { catchUp: { day: '2026-10-17', attempts: 1, lastAt: T(10).toISOString(), lastOk: false } }
  const plan = planCatchUp({ cfg: CFG, state, now: T(13), limits: { maxAttemptsPerDay: 1, retryCooldownMs: 0 } })
  assert.equal(plan.run, false)
  assert.match(plan.reason, /放弃/)
})

/* ═══════════════ 5. recordCatchUp：失败绝不写成"已跑" ═══════════════ */

test('recordCatchUp：失败 → lastOk=false、attempts+1、带 error', () => {
  const patch = recordCatchUp({}, { ok: false, now: T(13), error: '连不上 B站' })
  assert.equal(patch.catchUp.day, '2026-10-17')
  assert.equal(patch.catchUp.attempts, 1)
  assert.equal(patch.catchUp.lastOk, false)
  assert.match(patch.catchUp.lastError, /连不上/)
})

test('recordCatchUp：⭐ 失败只写 catchUp 一个键，绝不碰 day / runs', () => {
  const before = { day: '2026-10-16', runs: 4, lastResult: { date: '2026-10-16' } }
  const patch = recordCatchUp(before, { ok: false, now: T(13), error: 'x' })
  assert.deepEqual(Object.keys(patch), ['catchUp'])
  // 合并后"今天跑过没有"仍然是 false ⇒ 之后还能补
  assert.equal(todayRan({ state: { ...before, ...patch }, today: '2026-10-17' }), false)
})

test('recordCatchUp：同一天连续失败 → attempts 累加', () => {
  let state = {}
  for (let i = 0; i < 3; i += 1) {
    state = { ...state, ...recordCatchUp(state, { ok: false, now: T(10 + i), error: `e${i}` }) }
  }
  assert.equal(state.catchUp.attempts, 3)
})

test('recordCatchUp：成功 → lastOk=true、错误清空', () => {
  const prev = { catchUp: { day: '2026-10-17', attempts: 1, lastAt: T(10).toISOString(), lastOk: false, lastError: '旧错' } }
  const patch = recordCatchUp(prev, { ok: true, now: T(13) })
  assert.equal(patch.catchUp.lastOk, true)
  assert.equal(patch.catchUp.lastError, '')
  assert.equal(patch.catchUp.attempts, 1, '成功不额外计一次失败')
})

test('recordCatchUp：换天后 attempts 归零', () => {
  const prev = { catchUp: { day: '2026-10-16', attempts: 3, lastAt: T(10, 0, 16).toISOString(), lastOk: false } }
  const patch = recordCatchUp(prev, { ok: false, now: T(13, 0, 18), error: 'x' })
  assert.equal(patch.catchUp.day, '2026-10-18')
  assert.equal(patch.catchUp.attempts, 1)
})

test('recordCatchUp：异常信息截断到 300 字（state 别无限长）', () => {
  const patch = recordCatchUp({}, { ok: false, now: T(13), error: 'x'.repeat(900) })
  assert.equal(patch.catchUp.lastError.length, 300)
})

/* ═══════════════ 6. catchUpStatus：设置页那一行短文案 ═══════════════ */

test('catchUpStatus：开关关着 → 补跑：关', () => {
  assert.deepEqual(catchUpStatus({ cfg: cfgWith({ catchUp: false }), state: {}, today: '2026-10-17', hasReport: false }),
    { state: 'off', text: '补跑：关', attempts: 0 })
})

test('catchUpStatus：今天已跑 → 今天已跑', () => {
  const s = catchUpStatus({ cfg: CFG, state: { day: '2026-10-17', runs: 1 }, today: '2026-10-17' })
  assert.equal(s.state, 'done')
  assert.equal(s.text, '今天已跑')
})

test('catchUpStatus：今天没跑 → 今天未跑·待补', () => {
  const s = catchUpStatus({ cfg: CFG, state: {}, today: '2026-10-17' })
  assert.equal(s.state, 'pending')
  assert.equal(s.text, '今天未跑·待补')
})

test('catchUpStatus：失败过 → 文案带"已试 N 次"', () => {
  const s = catchUpStatus({ cfg: CFG, state: { catchUp: { day: '2026-10-17', attempts: 1, lastOk: false } }, today: '2026-10-17' })
  assert.equal(s.state, 'retry')
  assert.match(s.text, /已试 1 次/)
})

test('catchUpStatus：试满 3 次 → 放弃文案', () => {
  const s = catchUpStatus({ cfg: CFG, state: { catchUp: { day: '2026-10-17', attempts: 3, lastOk: false } }, today: '2026-10-17' })
  assert.equal(s.state, 'gaveup')
  assert.match(s.text, /放弃/)
})

test('catchUpStatus：手动模式 → 明说不补', () => {
  const s = catchUpStatus({ cfg: cfgWith({ peakValley: false }), state: {}, today: '2026-10-17' })
  assert.equal(s.state, 'manual')
  assert.match(s.text, /只手动跑/)
})

test('catchUpStatus：文案都短（手机上一行放得下）', () => {
  const samples = [
    catchUpStatus({ cfg: CFG, state: {}, today: '2026-10-17' }),
    catchUpStatus({ cfg: CFG, state: { day: '2026-10-17', runs: 1 }, today: '2026-10-17' }),
    catchUpStatus({ cfg: CFG, state: { catchUp: { day: '2026-10-17', attempts: 2 } }, today: '2026-10-17' }),
  ]
  for (const s of samples) assert.ok([...s.text].length <= 24, `太长：${s.text}`)
})

/* ═══════════════ 7. runCatchUpOnce：完整流程（带假宿主） ═══════════════ */

test('runCatchUpOnce：今天没跑 → 真的跑一轮，日志留理由，状态记成功', async () => {
  const host = fakeHost()
  const r = await runOnce(host)
  assert.equal(r.ran, true)
  assert.equal(r.ok, true)
  assert.deepEqual(host.rounds, ['catch-up'], 'startRound 的 why 必须是 catch-up')
  assert.equal(host.logs.length, 1)
  assert.equal(host.logs[0], `${CATCHUP_LOG_LINE}（trigger=boot）`)
  assert.equal(host.state.catchUp.lastOk, true)
  assert.equal(host.state.catchUp.day, '2026-10-17')
})

test('runCatchUpOnce：hasReport 是按"今天"问的（不是常量）', async () => {
  const host = fakeHost()
  await runOnce(host)
  assert.deepEqual(host.reportDays, ['2026-10-17'])
})

test('runCatchUpOnce：⭐ 跑成功后同一天再调 → 不重复跑（跟真实 startRound 一样会写 runs）', async () => {
  const host = fakeHost({
    onRound: (h) => { h.state = { ...h.state, day: '2026-10-17', runs: Number(h.state.runs || 0) + 1 } },
  })
  const first = await runOnce(host)
  assert.equal(first.ran, true)
  const second = await runOnce(host, { trigger: 'settings' })
  assert.equal(second.ran, false)
  assert.match(second.reason, /今天已经跑过/)
  assert.equal(host.rounds.length, 1, '一天只能补一次')
})

test('runCatchUpOnce：⭐ 补跑失败 → 不写"已跑"，runs 不动', async () => {
  const host = fakeHost({ result: { ok: false, error: '被 B站 风控（-412）' } })
  const r = await runOnce(host)
  assert.equal(r.ran, true)
  assert.equal(r.ok, false)
  assert.match(r.error, /风控/)
  assert.equal(host.state.catchUp.lastOk, false)
  assert.match(host.state.catchUp.lastError, /风控/)
  assert.equal(host.state.runs, undefined, 'runs 是 startRound 成功才写的，这里绝不能有')
  assert.equal(host.state.day, undefined)
  // 状态没写成"已跑" ⇒ 界面上仍是"今天未跑·待补"
  const s = catchUpStatus({ cfg: CFG, state: host.state, today: '2026-10-17' })
  assert.notEqual(s.state, 'done')
  assert.equal(host.logs.some((l) => /补跑失败/.test(l)), true)
})

test('runCatchUpOnce：失败后立刻再调 → 冷却期挡住（attempts 还是 1）', async () => {
  const host = fakeHost({ result: { ok: false, error: '连不上' } })
  await runOnce(host)
  const again = await runOnce(host, { trigger: 'settings' })
  assert.equal(again.ran, false)
  assert.match(again.reason, /分钟后再试/)
  assert.equal(host.rounds.length, 1)
})

test('runCatchUpOnce：冷却期过了再试、失败 3 次后彻底放弃（不会无限重试）', async () => {
  const host = fakeHost({ result: { ok: false, error: '连不上' } })
  const nows = [T(9), T(9, 30), T(10, 30), T(11, 30), T(12, 30)]
  const out = []
  for (const now of nows) out.push(await runOnce(host, { now }))
  assert.deepEqual(out.slice(0, 3).map((r) => r.ran), [true, true, true])
  assert.deepEqual(out.slice(3).map((r) => r.ran), [false, false], '第 4、5 次必须跳过')
  assert.match(out[4].reason, /放弃/)
  assert.equal(host.rounds.length, 3, '一天最多试 3 次')
})

test('runCatchUpOnce：startRound 返回 busy（别人正在跑）→ 不当成一次尝试', async () => {
  const host = fakeHost({ result: { ok: false, busy: true } })
  const r = await runOnce(host)
  assert.equal(r.ran, false)
  assert.equal(r.busy, true)
  assert.equal(host.writes.length, 0, 'busy 不该写 catchUp 状态（否则白白消耗当天次数）')
})

test('runCatchUpOnce：startRound 直接抛异常 → 兜住并记失败，不冒泡', async () => {
  const host = fakeHost()
  host.startRound = async () => { throw new Error('宿主炸了') }
  const r = await runOnce(host)
  assert.equal(r.ran, true)
  assert.equal(r.ok, false)
  assert.match(host.state.catchUp.lastError, /宿主炸了/)
})

test('runCatchUpOnce：今天已跑过 → 压根不调 startRound', async () => {
  const host = fakeHost({ state: { day: '2026-10-17', runs: 1 } })
  const r = await runOnce(host)
  assert.equal(r.ran, false)
  assert.equal(host.rounds.length, 0)
  assert.equal(host.logs.length, 0, '跳过时不往 study.log 写噪音')
})

test('runCatchUpOnce：report 存在也算跑过', async () => {
  const host = fakeHost({ report: true })
  const r = await runOnce(host)
  assert.equal(r.ran, false)
  assert.equal(host.rounds.length, 0)
})

test('runCatchUpOnce：enabled=false → 不跑、不写状态', async () => {
  const host = fakeHost({ cfg: cfgWith({ enabled: false }) })
  const r = await runOnce(host)
  assert.equal(r.ran, false)
  assert.match(r.reason, /停用/)
  assert.equal(host.rounds.length, 0)
  assert.equal(host.writes.length, 0)
})

test('runCatchUpOnce：手动模式（peakValley=false）→ 不跑', async () => {
  const host = fakeHost({ cfg: cfgWith({ peakValley: false }) })
  const r = await runOnce(host)
  assert.equal(r.ran, false)
  assert.match(r.reason, /手动模式/)
  assert.equal(host.rounds.length, 0)
})

test('runCatchUpOnce：running=true → 不跑', async () => {
  const host = fakeHost()
  const r = await runOnce(host, { running: true })
  assert.equal(r.ran, false)
  assert.equal(host.rounds.length, 0)
})

test('runCatchUpOnce：readState 是 null/抛错都不炸', async () => {
  const host = fakeHost()
  host.readState = () => { throw new Error('state.json 坏了') }
  const r = await runOnce(host)
  assert.equal(r.ran, true)
  assert.equal(r.ok, true)
})

test('runCatchUpOnce：writeState 抛错也不影响"这一轮已经跑成"', async () => {
  const host = fakeHost()
  host.writeState = () => { throw new Error('盘满') }
  const r = await runOnce(host)
  assert.equal(r.ran, true)
  assert.equal(r.ok, true)
  assert.equal(host.logs.some((l) => /没记进状态/.test(l)), true)
})

test('runCatchUpOnce：trigger 会进日志，三种入口都认得', async () => {
  for (const trigger of ['boot', 'tick', 'settings']) {
    const host = fakeHost()
    await runOnce(host, { trigger })
    assert.match(host.logs[0], new RegExp(`trigger=${trigger}`))
  }
})
