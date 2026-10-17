/**
 * lib/catchup.js —— 「补跑」：Android 把后台杀掉之后，把漏掉的那一轮补上
 * ============================================================================
 * 为什么要有这个文件（真机约束，不是锦上添花）：
 *   DSHA 跑在安卓上。**系统会杀后台进程，Doze/省电模式还会掐掉定时器**，
 *   所以「谷时到点自动跑」在真机上很可能**永远不触发**。表现就是：装好一周，
 *   一条笔记都没有 —— 用户以为插件坏了。
 *
 * ⭐ 补跑的口径（写死在这里，index.js 只负责调用）：
 *   ① **一天最多补一次**：成功后当天不再补（`todayRan()` 为真就跳过），
 *      失败也不记成"已跑"（`runs`/`day` 只在真跑成时才由 startRound 写），
 *      但一天最多试 `maxAttemptsPerDay` 次、两次之间至少隔 `retryCooldownMs`，
 *      免得宿主崩溃-重启循环把额度和日志刷爆。
 *   ② **尊重开关**：`enabled=false` 不补；`peakValley=false`（=手动模式）、
 *      两个谷时窗口都关（也是手动模式）、`perDay=0`（只能手动挑）都不补；
 *      设置页的「补跑」开关关掉也不补。
 *   ③ **不在窗口里也立刻补**（见 README「为什么补跑不等下一个窗口」）：
 *      等窗口 = 把"定时可能不触发"这个 bug 原样保留。补跑这一轮是纯 JS
 *      （搜/抓字幕/写笔记），不调模型、不花 token；"谷时"约束针对的是模型调用。
 *      真正防滥用的是上限：一天一次 + 失败最多 3 次。
 *   ④ **日志留证据**：每次真的触发都往 `study.log` 写一行 `CATCHUP_LOG_LINE`，
 *      带上是哪条路径触发的（boot / tick / settings）。
 *
 * 这个文件是**纯逻辑**（不碰网络、不碰文件），index.js 把 IO 注进来 —— 所以补跑
 * 的全部规则都能在 `tests/catchup.test.mjs` 里离线断言。
 * ============================================================================
 */
import { dayKey } from './state.js'

/** 补跑的上限口径（单测会传更小的值，别把时间写死在实现里）。 */
export const CATCHUP_LIMITS = {
  /** 一天最多试几次（只数失败；成功就当天封板了）。 */
  maxAttemptsPerDay: 3,
  /** 两次失败之间至少隔多久（毫秒）—— 防崩溃循环。 */
  retryCooldownMs: 10 * 60 * 1000,
}

/** 日志里那一行明确理由（测试逐字断言，别改文案）。 */
export const CATCHUP_LOG_LINE = 'catch-up: 今天尚无 round，触发补跑'

/**
 * 当前算不算"自动模式"（只有自动模式才补跑）。
 * 手动模式的三种表现：谷时自动跑关掉、两个窗口都关、每天 0 条。
 * @returns {{auto: boolean, why: string}}
 */
export function autoRunMode(cfg = {}) {
  if (cfg.enabled === false) return { auto: false, why: '插件已停用（enabled=false）' }
  if (cfg.peakValley !== true) return { auto: false, why: '谷时自动跑关着（等同手动模式）' }
  if (!cfg.noon && !cfg.night) return { auto: false, why: '两个谷时窗口都关着（等同手动模式）' }
  if (!(Number(cfg.perDay) >= 1)) return { auto: false, why: '每天 0 条（只能手动跑）' }
  return { auto: true, why: '自动模式' }
}

/**
 * 今天到底跑过没有：**状态文件 + out/ 报告**两条都看。
 * （状态文件可能因为升级/清缓存丢了，报告在就说明真跑过。）
 */
export function todayRan({ state = {}, today = dayKey(), hasReport = false } = {}) {
  const st = state && typeof state === 'object' ? state : {}
  const byState = st.day === today && Number(st.runs || 0) > 0
  return Boolean(byState || hasReport)
}

const skip = (reason, extra = {}) => ({ run: false, reason, why: 'skip', ...extra })

/**
 * 该不该补跑。**纯函数**：给同样的输入永远同样的结论（幂等的根）。
 *
 * @param {{
 *   cfg?: object, state?: object, now?: Date, hasReport?: boolean,
 *   running?: boolean, limits?: {maxAttemptsPerDay?:number, retryCooldownMs?:number},
 * }} p
 * @returns {{run:boolean, reason:string, day:string, attempt?:number, why:string}}
 */
export function planCatchUp({
  cfg = {}, state = {}, now = new Date(), hasReport = false, running = false,
  limits = CATCHUP_LIMITS,
} = {}) {
  const today = dayKey(now)
  if (cfg.enabled === false) return skip('补跑跳过：插件已停用', { day: today })
  if (cfg.catchUp === false) return skip('补跑跳过：补跑开关关着', { day: today })
  const mode = autoRunMode(cfg)
  if (!mode.auto) return skip(`补跑跳过：${mode.why}`, { day: today })
  if (running) return skip('补跑跳过：上一轮还在跑', { day: today })
  if (todayRan({ state, today, hasReport })) return skip('补跑跳过：今天已经跑过', { day: today })

  const memo = state?.catchUp && state.catchUp.day === today ? state.catchUp : null
  const attempts = Math.max(0, Number(memo?.attempts || 0))
  const maxAttempts = Math.max(1, Number(limits?.maxAttemptsPerDay ?? CATCHUP_LIMITS.maxAttemptsPerDay))
  const cooldown = Math.max(0, Number(limits?.retryCooldownMs ?? CATCHUP_LIMITS.retryCooldownMs))
  if (attempts >= maxAttempts) {
    return skip(`补跑放弃：今天已经试了 ${attempts} 次都没成（明天再来，或现在手动点一轮）`, { day: today, attempts })
  }
  const lastAt = memo?.lastAt ? Date.parse(memo.lastAt) : 0
  if (memo?.lastOk === false && Number.isFinite(lastAt) && lastAt > 0 && now.getTime() - lastAt < cooldown) {
    const waitMin = Math.max(1, Math.ceil((cooldown - (now.getTime() - lastAt)) / 60000))
    return skip(`补跑等一下：${waitMin} 分钟后再试（上次没跑成）`, { day: today, attempts })
  }
  return { run: true, reason: CATCHUP_LOG_LINE, day: today, attempt: attempts + 1, why: 'catch-up' }
}

/**
 * 把一次补跑的结果记进状态（返回要给 writeState 的 patch）。
 * 🔴 失败时**只加 attempts / lastError**，绝不碰 `day` / `runs`
 *    —— 那两个字段是"今天跑过没有"的唯一依据，写错就会整天不再补。
 */
export function recordCatchUp(state = {}, { ok = false, now = new Date(), error = '' } = {}) {
  const today = dayKey(now)
  const prev = state?.catchUp && state.catchUp.day === today ? state.catchUp : { day: today, attempts: 0 }
  const attempts = Math.max(0, Number(prev?.attempts || 0)) + (ok ? 0 : 1)
  return {
    catchUp: {
      day: today,
      attempts,
      lastAt: now.toISOString(),
      lastOk: Boolean(ok),
      lastError: ok ? '' : String(error ?? '').slice(0, 300),
    },
  }
}

/**
 * 设置页/状态工具上那一行短文案（手机上要一眼看懂）。
 * 主三态就是需求里的：`补跑：关` / `今天已跑` / `今天未跑·待补`。
 * @returns {{state: 'off'|'done'|'pending'|'retry'|'gaveup'|'manual', text: string, attempts: number}}
 */
export function catchUpStatus({ cfg = {}, state = {}, today = dayKey(), hasReport = false, limits = CATCHUP_LIMITS } = {}) {
  const memo = state?.catchUp?.day === today ? state.catchUp : null
  const attempts = Math.max(0, Number(memo?.attempts || 0))
  if (cfg.catchUp === false) return { state: 'off', text: '补跑：关', attempts }
  if (todayRan({ state, today, hasReport })) return { state: 'done', text: '今天已跑', attempts }
  const mode = autoRunMode(cfg)
  if (!mode.auto) return { state: 'manual', text: '今天未跑·只手动跑（不补）', attempts }
  const maxAttempts = Math.max(1, Number(limits?.maxAttemptsPerDay ?? CATCHUP_LIMITS.maxAttemptsPerDay))
  if (attempts >= maxAttempts) return { state: 'gaveup', text: `今天未跑·补跑放弃（已试 ${attempts} 次）`, attempts }
  if (attempts > 0) return { state: 'retry', text: `今天未跑·待补（已试 ${attempts} 次没成）`, attempts }
  return { state: 'pending', text: '今天未跑·待补', attempts }
}

/**
 * 跑一次补跑（index.js 的三个触发点都走这里）。
 * IO 全部注入：`readState/writeState/hasReport/startRound/log` —— 因此单测能拿假宿主跑完整流程。
 *
 * @param {{
 *   cfg?: object, now?: Date, trigger?: string,
 *   readState?: Function, writeState?: Function, hasReport?: (day:string)=>boolean,
 *   startRound?: (why:string)=>Promise<object>, running?: boolean, log?: Function,
 *   limits?: object,
 * }} p
 */
export async function runCatchUpOnce({
  cfg = {}, now = new Date(), trigger = 'boot',
  readState = () => ({}), writeState = () => ({}), hasReport = () => false,
  startRound = async () => ({ ok: false, error: '没有 startRound' }),
  running = false, log = () => {}, limits = CATCHUP_LIMITS,
} = {}) {
  let state = {}
  try { state = readState() || {} } catch { state = {} }
  const day = dayKey(now)
  let reported = false
  try { reported = Boolean(hasReport(day)) } catch { reported = false }

  const plan = planCatchUp({ cfg, state, now, hasReport: reported, running, limits })
  if (!plan.run) return { ran: false, ...plan }

  log(`${plan.reason}（trigger=${trigger}）`)
  let result
  try {
    result = await startRound(plan.why)
  } catch (e) {
    result = { ok: false, error: String(e?.message ?? e) }
  }
  if (result?.busy) return { ran: false, busy: true, reason: '补跑跳过：上一轮还在跑', plan }

  const ok = Boolean(result?.ok)
  let patch = null
  try {
    // 用传进来的 now 记时间戳（不另取 new Date()）：注入同一个时钟，单测才能精确断言冷却期
    patch = recordCatchUp(readState() || {}, { ok, now, error: result?.error })
    writeState(patch)
  } catch (e) {
    log(`补跑结果没记进状态（不影响这一轮本身）：${e?.message ?? e}`)
  }
  if (!ok) log(`补跑失败（**不**记为已跑，稍后还能再补）：${String(result?.error ?? '未知原因').slice(0, 200)}`)
  return { ran: true, ok, error: result?.error || '', patch, plan }
}
