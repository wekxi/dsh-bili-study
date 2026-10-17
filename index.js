/**
 * dsha-bili-study —— host 半端（服务端插件）
 * ============================================================================
 * 「刷B站学习」：每天挑几条值得看的 B站 视频，**读字幕原文**、落结构化笔记、
 * 排复习，并给一个手机上能一屏看完的「今天学了什么」面板。
 *
 * 这个文件负责四件事：
 *   1. **注册工具**（模型侧）：bili_study_search / _video / _subtitle / _note / _find /
 *      _review / _daily，外加 _login / _status / _config 三个配套。
 *   2. **读配置**：loader 给的那份（cordis.patch.yml 的 config）叠家目录里的 config.json。
 *   3. **定时**：谷时窗口里每天跑一轮 `lib/duty.js`，报告写进 `<家>/out/<日期>.md`。
 *   4. **HTTP**：给设置页与「今天学了什么」面板用的 `/api/bili-study/*`。
 *
 * 三条老教训（抄 dsh-bili-scroll 的注释，都是真栽过的）：
 *   ① `apply(ctx, config)` 传进来的 config 字段值**不保证是标量**（对象/字符串都可能），
 *      拿它直接 `.filter()` 会在**定时器回调里**抛 TypeError ⇒ 整个宿主进程被带走。
 *      ⇒ 逐字段按默认值类型挑一遍，且**定时器回调里绝不让异常外冒**。
 *   ② 工具返回值必须过 `safe()`：塞进函数/循环引用会报 `value is not lossless JSON`。
 *   ③ `defineTool` 的 `parameters` 是**参数描述表**（`{字段: {type, description}}`），
 *      不是 `{ type: 'object', properties: ... }` —— 后者会抛 JsonSchemaError，插件整条不激活。
 * ============================================================================
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BiliClient, BiliError, extractBvid, fmtTs } from './lib/bili-api.js'
import { scoreVideo, fmtCount, VERDICT_LEGEND } from './lib/score.js'
import { NoteStore, SECTIONS, fmtHms } from './lib/notes.js'
import { DUTY_DEFAULTS, runRound, roundStatusText, fetchSubtitlesFor, resolveMention } from './lib/duty.js'
import { catchUpStatus, runCatchUpOnce, todayRan } from './lib/catchup.js'
import { detectHostModel, callHostModel, getService } from './lib/model.js'
import {
  REFINE_DEFAULT_MAX_CHARS, REFINE_DEFAULT_PER_ROUND, REFINE_PROMPT_VERSION,
  buildDigestInstruction, subtitleTranscript,
} from './lib/refine.js'
import {
  HOME_NAME, WINDOWS, addDays, clearCredential, credentialSummary, dayKey, homeDirOf, inWindow,
  loadCredential, normalizeCookie, readJson, saveCredential, writeJsonAtomic,
} from './lib/state.js'

/* ───────────────────────── 宿主依赖（拿不到也要能活） ─────────────────────────
 * 手机上（DSHA）最怕的就是"某个 @deepseek-ai/* 包解析不到 ⇒ 整条插件不激活"。
 * 动态 import + 本地兜底：工具照注册（用 JSON Schema 参数），设置命名空间注册不上就跳过
 * —— 我们自己的设置页走 HTTP，不依赖 DSH 内置的设置编辑器。
 */
let defineTool = null
let z = null
try {
  const m = await import('@deepseek-ai/dsh-tools')
  if (typeof m.defineTool === 'function') defineTool = m.defineTool
} catch (e) {
  // 静默降级：下面的 localDefineTool 用 JSON Schema 参数，功能一致
}
try {
  const m = await import('@deepseek-ai/schemastery')
  z = m.default ?? m
} catch (e) {
  z = null
}

export const name = 'bili-study'
export const inject = ['webServer', 'tools', 'settings']

/** loader 层的默认配置（cordis.patch.yml 里写的也是这一份）。 */
export const CONFIG_DEFAULTS = {
  enabled: true,
  keywords: [],
  perDay: DUTY_DEFAULTS.perDay,
  minScore: DUTY_DEFAULTS.minScore,
  days: DUTY_DEFAULTS.days,
  subtitleLang: DUTY_DEFAULTS.subtitleLang,
  maxPages: DUTY_DEFAULTS.maxPages,
  peakValley: true,
  noon: true,
  night: false,
  autoComment: false,
  mentionName: '',
  commentPerRound: DUTY_DEFAULTS.commentPerRound,
  commentMinScore: DUTY_DEFAULTS.commentMinScore,
  // 补跑：Android 会杀后台 / Doze 掐定时器 ⇒ 今天没跑就下次打开时补一轮（一天最多一次）
  catchUp: true,
  // P3 模型提炼：默认开；关掉 = 与 0.1.0 一致的摘句兜底（不花任何模型调用）
  refine: true,
  refineMaxChars: REFINE_DEFAULT_MAX_CHARS,
  refineModel: '',
  refinePerRound: REFINE_DEFAULT_PER_ROUND,
}

/**
 * 配置 schema（DSH 自带设置页会用）。
 * 🔴 每个字段都要 `.extra('volatile', true)`：settings.update() 只认 volatile 字段，
 *    否则写设置时抛 "Plugin entry … has no volatile fields"。
 *    另外两个条件：loader entry 的 id 必须**等于**命名空间名（我们就是 `bili-study`）+ 本模块导出 Config。
 */
export const Config = z ? z.object({
  enabled: z.boolean().default(true).extra('volatile', true),
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  perDay: z.natural().default(CONFIG_DEFAULTS.perDay).extra('volatile', true),
  minScore: z.natural().default(CONFIG_DEFAULTS.minScore).extra('volatile', true),
  days: z.natural().default(CONFIG_DEFAULTS.days).extra('volatile', true),
  subtitleLang: z.string().default(CONFIG_DEFAULTS.subtitleLang).extra('volatile', true),
  maxPages: z.natural().default(CONFIG_DEFAULTS.maxPages).extra('volatile', true),
  peakValley: z.boolean().default(true).extra('volatile', true),
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(false).extra('volatile', true),
  autoComment: z.boolean().default(false).extra('volatile', true),
  mentionName: z.string().default('').extra('volatile', true),
  commentPerRound: z.natural().default(1).extra('volatile', true),
  commentMinScore: z.natural().default(65).extra('volatile', true),
  catchUp: z.boolean().default(true).extra('volatile', true),
  refine: z.boolean().default(true).extra('volatile', true),
  refineMaxChars: z.natural().default(REFINE_DEFAULT_MAX_CHARS).extra('volatile', true),
  refineModel: z.string().default('').extra('volatile', true),
  refinePerRound: z.natural().default(REFINE_DEFAULT_PER_ROUND).extra('volatile', true),
}) : undefined

/* ───────────────────────── 小工具 ───────────────────────── */

/** 逐字段按默认值的类型挑一遍（防"config 里是个对象"那类事故）。 */
export function normalizeConfig(src, base = CONFIG_DEFAULTS) {
  const out = { ...base }
  if (!src || typeof src !== 'object') return out
  for (const k of Object.keys(base)) {
    const v = src[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(base[k])) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    } else if (typeof base[k] === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) out[k] = Math.max(0, Math.round(n))
    } else if (typeof base[k] === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
    } else if (typeof base[k] === 'string') {
      if (typeof v === 'string') out[k] = v
    }
  }
  return out
}

/** 工具返回值必须是"无损 JSON"。 */
function safe(v) {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

/** 把内部异常翻成"人话"（模型与用户都看得懂，且带下一步）。 */
export function humanError(e) {
  if (e instanceof BiliError) return e.message
  const msg = String(e?.message ?? e)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|TimeoutError/i.test(msg)) {
    return `连不上 B站（${msg.slice(0, 80)}）：检查手机网络后再试一次`
  }
  if (/ENOENT|EACCES|EPERM/i.test(msg)) return `读写插件家目录失败（${msg.slice(0, 80)}）：确认 DSH 的数据目录可写`
  return msg
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

/** 参数描述表 → 标准 JSON Schema（没有 defineTool 时用）。 */
function parametersToJsonSchema(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, def] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = def || {}
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

const localDefineTool = (spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: parametersToJsonSchema(spec.parameters),
  output: spec.output,
  ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
  execute: spec.execute,
})

/**
 * 0.1.0 → 0.2.0 升级时追加进已有家目录 duty.md 的收尾段。
 * 只在旧文件里没有 `bili_study_digest` 时追加，不覆盖用户改过的内容。
 */
const P3_DUTY_ADDENDUM = `## 每日收尾：模型提炼（P3，0.2.0 升级追加）

先看 \`bili_study_status\` 的 \`refine\`：

- \`refine.available: true\`（宿主有 LLM 服务）：每轮抓到字幕后会自动调一次模型，笔记的
  「要点 / 金句 / 我的判断 / 值不值得再看」由模型写。你只需检查 \`picked[].refine\` 里有没有 \`failed\`。
- \`refine.available: false\`（或使用者把 \`refine\` 关了）：走提示词驱动——
  对今天挑中的每条跑 \`bili_study_digest bvid=<BV号>\`，拿到 \`transcript\` 与 \`instruction\` 后
  **自己**生成四节，再用 \`bili_study_note add ... source=agent\` 一条一节写回。

两条路都守着同一条红线：ASR 字幕允许纠正明显听错的词，**不许补充字幕里没有的事实**；
金句必须来自原文，找不到就别写。`

/* ───────────────────────── 插件主体 ───────────────────────── */

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const home = homeDirOfSafe(ctx)
  const cfgFile = join(home, 'config.json')
  const stateFile = join(home, 'state.json')
  const logFile = join(home, 'study.log')
  const outDir = join(home, 'out')
  mkdirSync(outDir, { recursive: true })

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去不致命 */ }
    try { ctx.logger?.info?.(`[bili-study] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  // config 三层：默认值 ← loader 给的那份 ← 家目录 config.json（设置页写的）
  let cfg = normalizeConfig(readJson(cfgFile, {}), normalizeConfig(config, { ...CONFIG_DEFAULTS }))
  const saveCfg = (patch) => {
    cfg = normalizeConfig({ ...cfg, ...(patch || {}) }, cfg)
    writeJsonAtomic(cfgFile, cfg)
    // 改了模型相关设置就重新探测（开火后不管；失败也只是标成不可用）
    setImmediate(() => { try { void ensureModel(true) } catch { /* 已兜住 */ } })
    return cfg
  }

  // 把每日任务书铺进家目录（用户可以改；改过的不会被覆盖）
  try {
    const from = join(pluginDir, 'prompts', 'duty.md')
    const to = join(home, 'duty.md')
    if (existsSync(from) && !existsSync(to)) copyFileSync(from, to)
    else if (existsSync(from)) {
      // 0.1.0 → 0.2.0 升级：已有家目录里那份可能没有 digest 收尾段。
      // 只在缺这一段时**追加**，绝不覆盖用户自己的修改。
      const cur = readFileSync(to, 'utf8')
      if (!cur.includes('bili_study_digest')) {
        appendFileSync(to, `\n\n${P3_DUTY_ADDENDUM}\n`, 'utf8')
        log('已把 P3「digest 收尾」追加进家目录 duty.md（原有内容保留）')
      }
    }
  } catch (e) { log(`铺 duty.md 失败：${e?.message ?? e}`) }

  // 设置命名空间：
  //   · DSH 0.2.x（桌面 2.0.17 / DSHA 0.2.0-rc.2）：**只要导出 Config** 就够了 ——
  //     内置「插件设置」页会读 configEditor 里的 entry schema（`volatileForm` 那条路），
  //     这里再调 `settings.register` 反而没用：新版 SettingsForms 上根本没有这个方法（实测）。
  //   · 老版本（dsh-bili-scroll 那个年代的 API）才有 `settings.register(...)`；有就顺手调一下。
  //   两条路都失败也不影响我们自己的设置页 —— 它走 `/api/bili-study/*`，不依赖服务端这套。
  try {
    if (z && Config && typeof ctx.settings?.register === 'function') {
      ctx.settings.register('bili-study', Config, { base: {}, applies: 'live' })
      log('已注册设置命名空间 bili-study（老版 settings.register 接口）')
    }
  } catch (e) {
    if (!/already registered/i.test(String(e?.message ?? e))) log(`注册设置命名空间失败：${e?.message ?? e}`)
  }

  const store = new NoteStore(home)

  /* ── B站 客户端（凭据变了就换一个） ── */
  let clientCache = null
  let clientKey = ''
  const bili = () => {
    const cred = loadCredential(home)
    const key = cred?.cookie || ''
    if (clientCache && key === clientKey) return clientCache
    clientKey = key
    clientCache = new BiliClient({ cookie: key, log })
    return clientCache
  }
  const credential = () => credentialSummary(home)

  /** 「要 @ 谁」的兜底状态（0.2.1）：空值用登录账号；手填与登录名不一致只提示、不改值。 */
  const mentionStatus = () => {
    const m = resolveMention({ mentionName: cfg.mentionName, uname: credential().uname })
    return {
      configured: m.configured,
      effective: m.name,
      source: m.source,
      login: m.login,
      mismatch: m.mismatch,
      warn: m.warn,
      autoComment: Boolean(cfg.autoComment),
    }
  }

  /* ── P3：宿主模型探测（不存任何 API key；拿不到就退化成摘句 + digest） ── */
  const modelState = { ready: false, at: 0, info: { available: false, provider: '', model: '', source: 'none', reason: '还没探测' } }
  let modelPending = null
  const ensureModel = (force = false) => {
    if (!force && modelState.ready && Date.now() - modelState.at < 60_000) return Promise.resolve(modelState.info)
    if (modelPending) return modelPending
    modelPending = (async () => {
      let info
      try {
        info = await detectHostModel(ctx, { override: cfg.refineModel })
      } catch (e) {
        info = { available: false, provider: '', model: '', source: 'none', reason: humanError(e) }
      }
      modelState.info = info
      modelState.ready = true
      modelState.at = Date.now()
      return info
    })().finally(() => { modelPending = null })
    return modelPending
  }
  const hostModelInfo = () => modelState.info

  /** 提炼消耗的轻量计数（今天/昨天），给设置页看「本轮调用几次、昨天用了多少」。 */
  const refineStats = () => {
    const st = readState()
    const today = dayKey()
    const prev = st.refine && typeof st.refine === 'object' ? st.refine : {}
    const byDay = prev.byDay && typeof prev.byDay === 'object' ? prev.byDay : {}
    const t = byDay[today] || (prev.day === today ? { calls: prev.calls || 0, failed: prev.failed || 0 } : {})
    const y = byDay[addDays(today, -1)] || {}
    const last = st.lastResult && st.lastResult.date === today ? st.lastResult : null
    return {
      todayCalls: Number(t.calls || 0),
      todayFailed: Number(t.failed || 0),
      yesterdayCalls: Number(y.calls || 0),
      lastRound: last?.refine || null,
    }
  }

  const refineStatus = () => {
    const info = hostModelInfo()
    return {
      enabled: cfg.refine !== false,
      available: Boolean(info.available),
      provider: info.provider || '',
      model: info.model || '',
      reasoningEffort: info.reasoningEffort || '',
      source: info.source || 'none',
      reason: info.reason || '',
      promptVersion: REFINE_PROMPT_VERSION,
      maxChars: cfg.refineMaxChars,
      perRound: cfg.refinePerRound,
      digestTool: 'bili_study_digest',
      ...refineStats(),
    }
  }

  /* ── 状态 ── */
  const readState = () => readJson(stateFile, {})
  const writeState = (patch) => {
    const st = { ...readState(), ...patch }
    writeJsonAtomic(stateFile, st)
    return st
  }
  let running = null

  const lastResult = () => {
    const st = readState()
    if (st.day !== dayKey()) return null
    return st.lastResult || null
  }

  /* ── 补跑：今天跑过没有（状态文件 + out/ 报告，两处都看） ── */
  const hasReportFor = (day) => {
    try {
      return existsSync(join(outDir, `${day}.md`)) || existsSync(join(outDir, `${day}.json`))
    } catch { return false }
  }
  const catchUpInfo = () => {
    const today = dayKey()
    const st = readState()
    const hasReport = hasReportFor(today)
    const got = catchUpStatus({ cfg, state: st, today, hasReport })
    const memo = st.catchUp?.day === today ? st.catchUp : null
    return {
      enabled: cfg.catchUp !== false,
      todayRan: todayRan({ state: st, today, hasReport }),
      ...got,
      lastAt: String(memo?.lastAt || ''),
      lastError: String(memo?.lastError || ''),
    }
  }

  const status = () => {
    // 设置页一打开就能看到真实的模型状态：还没探测 / 上次不可用且已过 30 秒 → 后台再探一次
    if (cfg.refine !== false && (!modelState.ready || (!modelState.info.available && Date.now() - modelState.at > 30_000))) {
      setImmediate(() => { try { void ensureModel(true) } catch { /* 已兜住 */ } })
    }
    const st = readState()
    const today = dayKey()
    const stats = store.stats(today)
    return {
      ok: true,
      home,
      today,
      config: cfg,
      windows: WINDOWS,
      credential: credential(),
      running: Boolean(running),
      ranToday: st.day === today ? Number(st.runs || 0) : 0,
      lastRunAt: st.lastRunAt || '',
      lastWhy: st.lastWhy || '',
      lastStatus: st.lastResult ? roundStatusText(st.lastResult) : '还没跑过',
      catchUp: catchUpInfo(),
      refine: refineStatus(),
      mention: mentionStatus(),
      stats,
      report: join(outDir, `${today}.md`),
      notesDir: join(home, 'notes'),
      log: logFile,
      legend: VERDICT_LEGEND,
    }
  }

  /* ── 跑一轮（工具与定时器共用；带并发闸） ── */
  const startRound = async (why) => {
    if (running) return { ok: false, busy: true, hint: '上一轮还没跑完，等它收尾' }
    running = (async () => {
      const startedAt = new Date()
      try {
        // P3：每轮先确认宿主模型（60 秒缓存；refine 关着就不探测）
        let hostModel = { available: false, provider: '', model: '', reason: 'refine 关着' }
        if (cfg.refine !== false) {
          try { hostModel = await ensureModel() } catch (e) { hostModel = { available: false, provider: '', model: '', reason: humanError(e) } }
        }
        const stats = refineStats()
        const perDay = Math.max(0, Math.min(Number(cfg.perDay) || 0, 10))
        const result = await runRound({
          cfg: { ...cfg, keywords: cfg.keywords.length ? cfg.keywords : DUTY_DEFAULTS.keywords },
          client: bili(),
          store,
          home,
          now: startedAt,
          log,
          // 0.2.1：mentionName 空值时用登录账号兜底；不一致只在状态里提示，不改用户填的值
          uname: credential().uname,
          refine: {
            available: Boolean(hostModel.available),
            provider: hostModel.provider || '',
            model: hostModel.model || '',
            reasoningEffort: hostModel.reasoningEffort || '',
            reason: hostModel.reason || '',
            // 每天最多提炼 perDay 条；今天的用量已经在 state.refine 里
            dailyRemaining: Math.max(0, perDay - stats.todayCalls),
            call: hostModel.available
              ? (p) => callHostModel({
                llm: getService(ctx, 'llm'),
                route: {
                  provider: hostModel.provider,
                  model: hostModel.model,
                  reasoningEffort: hostModel.reasoningEffort || '',
                },
                system: p.system, prompt: p.prompt, maxTokens: p.maxTokens,
              })
              : null,
          },
        })
        const today = dayKey(startedAt)
        const prevState = readState()
        const prevRefine = prevState.refine && typeof prevState.refine === 'object' ? prevState.refine : {}
        const byDay = { ...(prevRefine.byDay && typeof prevRefine.byDay === 'object' ? prevRefine.byDay : {}) }
        const prevToday = byDay[today] || (prevRefine.day === today ? { calls: prevRefine.calls || 0, failed: prevRefine.failed || 0 } : {})
        const calls = Number(prevToday.calls || 0) + Number(result.counts.refineCalls || 0)
        const failed = Number(prevToday.failed || 0) + Number(result.counts.refineFailed || 0)
        byDay[today] = { calls, failed }
        // 只留最近 7 天，免得 state.json 越滚越大
        const keep = Object.keys(byDay).sort().slice(-7)
        const trimmed = {}
        for (const k of keep) trimmed[k] = byDay[k]
        writeState({
          day: today,
          runs: (readState().day === today ? Number(readState().runs || 0) : 0) + 1,
          lastRunAt: startedAt.toISOString(),
          lastWhy: why,
          refine: {
            day: today,
            calls,
            failed,
            model: hostModel.available ? `${hostModel.provider}/${hostModel.model}` : '',
            byDay: trimmed,
          },
          lastResult: {
            date: result.date,
            counts: result.counts,
            picked: result.picked.map((p) => ({
              bvid: p.bvid, title: p.title, score: p.score, verdict: p.verdict, subtitleSource: p.subtitleSource,
              refine: p.refine, refineModel: p.refineModel, refineError: p.refineError,
            })),
            refine: result.refine,
            comment: result.comment,
            errors: result.errors.slice(0, 5),
            report: result.report,
          },
        })
        log(`一轮结束（${why}）：${roundStatusText(result)}`)
        return { ok: true, why, ...result }
      } catch (e) {
        log(`一轮失败（${why}）：${e?.stack ?? e}`)
        return { ok: false, why, error: humanError(e) }
      } finally {
        running = null
      }
    })()
    return running
  }

  /* ── 补跑（三个触发点：宿主启动 / 定时器 tick / 设置页打开） ──
   * 🔴 一律"开火后不管"：await 它会卡住启动/HTTP；异常必须在这里兜住（宿主不容许外冒）。
   *    幂等由 lib/catchup.js 的 planCatchUp 保证：今天跑过就跳过、一天最多补一次、失败最多 3 次。
   */
  const runCatchUp = (trigger) => {
    try {
      return runCatchUpOnce({
        cfg,
        trigger,
        now: new Date(),
        readState,
        writeState,
        hasReport: hasReportFor,
        startRound,
        running: Boolean(running),
        log,
      }).catch((e) => {
        log(`补跑判断出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
        return { ran: false, reason: '补跑判断出错' }
      })
    } catch (e) {
      log(`补跑判断出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
      return Promise.resolve({ ran: false, reason: '补跑判断出错' })
    }
  }

  /* ─────────────── 工具面 ─────────────── */

  const define = defineTool || localDefineTool
  const tool = (spec) => ctx.tools.register(define({
    ...spec,
    output: textOutput,
    async execute(args, exec) {
      try {
        const out = await spec.execute(args || {}, exec)
        return safe(out)
      } catch (e) {
        throw new Error(humanError(e))
      }
    },
  }))

  tool({
    name: 'bili_study_search',
    description: '按关键词搜 B站 视频并给 0-100「可靠性分」（识别引流号/标题党）。'
      + '多个关键词用 ; 分隔。分数>=80 强烈推荐、65+ 值得一看、50+ 一般、<50 引流嫌疑。'
      + '⚠️ 分数只看标题/简介/播放点赞，不代表内容对；要下结论得再看字幕。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词（多个用 ; 分隔，比如 "线性代数; MIT 18.06"）', required: true },
      num: { type: 'number', description: '每个关键词显示几条（默认 5，最大 20）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ pubdate=最新 / click=播放' },
      days: { type: 'number', description: '只要最近几天发布的（默认 0 = 不限）' },
      minScore: { type: 'number', description: '只返回分数 >= 该值的结果（默认 0）' },
    },
    async execute(args) {
      const keywords = String(args.keyword ?? '').split(/[;；|]/).map((s) => s.trim()).filter(Boolean)
      if (!keywords.length) throw new Error('关键词是空的：至少给一个词')
      const num = Math.max(1, Math.min(Number(args.num) || 5, 20))
      const minScore = Number(args.minScore) || 0
      const client = bili()
      const blocks = []
      for (const kw of keywords.slice(0, 4)) {
        const r = await client.search({ keyword: kw, order: String(args.order || 'totalrank'), days: Number(args.days) || 0 })
        const rows = r.items.map((it) => {
          const sc = scoreVideo({ title: it.title, desc: it.desc, play: it.play, like: it.like })
          return { ...it, score: sc.score, verdict: sc.verdict, reasons: sc.reasons }
        }).filter((it) => it.score >= minScore).slice(0, num)
        blocks.push({ keyword: kw, totalCount: r.totalCount, results: rows })
      }
      return {
        ok: true,
        legend: VERDICT_LEGEND,
        blocks,
        hint: blocks.some((b) => b.results.length) ? '看中哪条就 bili_study_video 看详情，再 bili_study_subtitle 读原文' : '这个关键词没搜到够分的结果，换个词或降低 minScore',
      }
    },
  })

  tool({
    name: 'bili_study_video',
    description: '看一个 BV 的详情并重新打分（详情里能看到分P/总时长，分通常比搜索页更准）。'
      + '返回标题/UP/播放/点赞/分P 结构/打分依据，以及每个分P 的 cid（抓字幕要用）。',
    parameters: { bvid: { type: 'string', description: 'BV 号或整条视频链接', required: true } },
    async execute(args) {
      const meta = await bili().videoInfo(args.bvid)
      const sc = scoreVideo({
        title: meta.title, desc: meta.desc, play: meta.play, like: meta.like,
        pageCount: meta.pageCount, avgPageSeconds: meta.avgPageSec, durationSeconds: meta.totalSec,
      })
      let subProbe = null
      try {
        const info = await bili().subtitleTracks(meta.bvid, meta.pages[0]?.cid)
        subProbe = { needLogin: info.needLogin, tracks: info.tracks.map((t) => t.lan) }
      } catch (e) { subProbe = { error: humanError(e) } }
      return {
        ok: true,
        bvid: meta.bvid,
        title: meta.title,
        author: meta.author,
        url: meta.url,
        pubdate: meta.pubdateText,
        duration: fmtHms(meta.totalSec),
        pages: meta.pages.slice(0, 20),
        pageCount: meta.pageCount,
        play: meta.play,
        playText: fmtCount(meta.play),
        like: meta.like,
        reply: meta.reply,
        desc: meta.desc.slice(0, 500),
        score: sc.score,
        verdict: sc.verdict,
        reasons: sc.reasons,
        subtitle: subProbe,
        verdictNote: '分数只衡量元数据可信度，不是内容质量结论',
      }
    },
  })

  tool({
    name: 'bili_study_subtitle',
    description: '抓一条视频的字幕**原文**（默认 ai-zh，逐行带时间轴）。'
      + '⚠️ 默认只回前 40 行，避免把几百 KB 灌进上下文；要看后面用 offset 翻。'
      + '没有字幕轨时**如实报**（未登录时 B站 一律不给字幕轨），不会假装拿到了。',
    parameters: {
      bvid: { type: 'string', description: 'BV 号或链接', required: true },
      page: { type: 'number', description: '第几个分P（从 1 开始，默认 1）' },
      lang: { type: 'string', description: '语言轨道（默认 ai-zh）' },
      offset: { type: 'number', description: '从第几行开始（默认 0）' },
      maxLines: { type: 'number', description: '返回多少行（默认 40，最大 200）' },
      save: { type: 'boolean', description: 'true = 顺手把全文存到 <家>/subs/ 下' },
    },
    async execute(args) {
      const client = bili()
      const meta = await client.videoInfo(args.bvid)
      const pageNo = Math.max(1, Number(args.page) || 1)
      const pg = meta.pages.find((p) => p.page === pageNo) || meta.pages[0]
      if (!pg) throw new Error('这条视频没有分P 信息，抓不了字幕')
      const info = await client.subtitleTracks(meta.bvid, pg.cid)
      if (!info.tracks.length) {
        return {
          ok: false,
          bvid: meta.bvid,
          page: pg.page,
          needLogin: info.needLogin,
          tracks: [],
          reason: info.needLogin
            ? 'B站 说这条要登录才给字幕轨（need_login_subtitle=true）—— 去设置页把 SESSDATA 粘上再试'
            : '这条视频确实没有字幕轨（直播录像/番剧常见），可以换语言轨道试，或者只按简介+评论判断',
          honest: true,
        }
      }
      const langs = [String(args.lang || cfg.subtitleLang || 'ai-zh'), 'ai-zh', 'zh-CN', 'zh-Hans', 'ai-en']
      const got = await client.pickSubtitle(meta.bvid, pg.cid, langs)
      if (!got?.rows?.length) {
        return { ok: false, bvid: meta.bvid, tracks: info.tracks.map((t) => t.lan), reason: '字幕地址都下载失败了（多半是 auth_key 过期，重试一次）', honest: true }
      }
      let saved = ''
      if (args.save) {
        const dir = join(home, 'subs')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${meta.bvid}.P${String(pg.page).padStart(2, '0')}.txt`)
        const text = got.rows.map((r) => `${fmtTs(r.start)} ${r.text}`).join('\n') + '\n'
        writeText(file, text)
        saved = file
      }
      const offset = Math.max(0, Number(args.offset) || 0)
      const maxLines = Math.max(1, Math.min(Number(args.maxLines) || 40, 200))
      const slice = got.rows.slice(offset, offset + maxLines).map((r) => `${fmtTs(r.start)} ${r.text}`)
      return {
        ok: true,
        bvid: meta.bvid,
        title: meta.title,
        page: pg.page,
        part: pg.part,
        lang: got.lang,
        totalPages: meta.pageCount,
        totalLines: got.rows.length,
        offset,
        returned: slice.length,
        lines: slice,
        saved,
        hint: got.rows.length > offset + slice.length ? `还有 ${got.rows.length - offset - slice.length} 行，用 offset=${offset + slice.length} 继续` : '读完了',
      }
    },
  })

  tool({
    name: 'bili_study_digest',
    description: '**提示词驱动**的提炼素材：给一个 BV 号，抓字幕原文并按 `[时间] 原文` 分段返回，'
      + '外加一段「写笔记指令」（四节格式 + 用 bili_study_note add 写回的步骤）。'
      + '宿主没有模型服务时走这条路：你（agent）读完字幕自己生成四节，再写回插件。'
      + '宿主有模型时插件会自己提炼（配置 refine），这个工具也能用来人工复核/补写。',
    parameters: {
      bvid: { type: 'string', description: 'BV 号或整条视频链接', required: true },
      page: { type: 'number', description: '只取第几个分P（默认 0 = 按设置读前几个分P）' },
      maxChars: { type: 'number', description: `字幕最多给多少字（默认 12000，最少 1000）` },
      lang: { type: 'string', description: '字幕轨道（默认 ai-zh）' },
      save: { type: 'boolean', description: 'true = 顺手把字幕全文存到 <家>/subs/ 下' },
    },
    timeoutMs: 120000,
    async execute(args) {
      const bvid = extractBvid(args.bvid)
      if (!bvid) throw new Error('digest 要带 bvid')
      const client = bili()
      const meta = await client.videoInfo(bvid)
      const pageNo = Math.max(0, Number(args.page) || 0)
      let useMeta = meta
      if (pageNo > 0) {
        const pg = meta.pages.find((p) => p.page === pageNo)
        if (!pg) throw new Error(`这条只有 ${meta.pageCount} 个分P，没有 P${pageNo}`)
        useMeta = { ...meta, pages: [pg] }
      }
      const got = await fetchSubtitlesFor({
        client,
        meta: useMeta,
        cfg: { ...cfg, maxPages: pageNo > 0 ? 1 : Math.max(1, Number(cfg.maxPages) || 1), subtitleLang: String(args.lang || cfg.subtitleLang || 'ai-zh') },
        log,
      })
      if (got.source !== 'subtitle' || !got.rows?.length) {
        return {
          ok: false,
          bvid,
          title: meta.title,
          needLogin: Boolean(got.needLogin),
          reason: got.needLogin
            ? 'B站 说这条要登录才给字幕轨（need_login_subtitle=true）—— 去设置页把 SESSDATA 粘上再试'
            : '这条没有可用的 ai-zh 字幕轨，digest 没材料可给（不要凭空写笔记）',
          honest: true,
        }
      }
      const maxChars = Math.max(1000, Math.min(Number(args.maxChars) || cfg.refineMaxChars || REFINE_DEFAULT_MAX_CHARS, 60000))
      const tr = subtitleTranscript(got.rows, { maxChars })
      let saved = ''
      if (args.save) {
        const dir = join(home, 'subs')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${bvid}.digest.txt`)
        writeText(file, got.rows.map((r) => `${fmtTs(r.start)} ${r.text}`).join('\n') + '\n')
        saved = file
      }
      return {
        ok: true,
        bvid,
        title: meta.title,
        url: meta.url,
        author: meta.author,
        pubdate: meta.pubdateText,
        duration: fmtHms(meta.totalSec),
        pageCount: meta.pageCount,
        lang: got.lang,
        pages: got.pages,
        lines: got.lines,
        chars: tr.chars,
        totalLines: tr.totalLines,
        truncated: tr.truncated,
        // 分段字幕：一行一个 `[M:SS] 原文`
        transcript: tr.text,
        instruction: buildDigestInstruction({
          bvid, title: meta.title, transcript: '', truncated: tr.truncated, maxChars,
        }),
        noteState: store.has(bvid) ? { exists: true, sections: countSections(store, bvid) } : { exists: false, hint: `先 bili_study_note action=new bvid=${bvid}` },
        saved,
        hint: '把 transcript 读成四节，然后按 instruction 里的命令用 bili_study_note add 写回；金句必须原文，判断要写「值不值得看/适合谁/坑在哪」',
      }
    },
  })

  tool({
    name: 'bili_study_note',
    description: '学习笔记：action=new 建壳子（会先抓元信息+打分）、add 追加一条、list 列出、show 看整份。'
      + '六个小节固定为：要点 / 时间轴锚点 / 金句 / 我的判断 / 值不值得再看（元信息自动渲染）。'
      + '写笔记请用 add，**别手改 .md**（.md 是从 library.json 渲染出来的）。',
    parameters: {
      action: { type: 'string', enum: ['new', 'add', 'list', 'show'], description: 'new/add/list/show（默认 list）' },
      bvid: { type: 'string', description: 'BV 号（new/add/show 必填）' },
      section: { type: 'string', description: `小节名：${SECTIONS.join(' / ')}` },
      body: { type: 'string', description: '这条笔记的正文（add 必填）' },
      ts: { type: 'string', description: '时间轴锚点，如 03:41（可省）' },
      tags: { type: 'string', description: '标签，逗号分隔（可省）' },
      source: { type: 'string', description: '这条是谁写的：model=模型直调 / agent=外部 agent 按 digest 写 / manual=人手补（可省；好让面板标出来源）' },
    },
    async execute(args) {
      const action = String(args.action || 'list')
      if (action === 'list') {
        const bvid = extractBvid(args.bvid)
        if (!bvid) {
          return {
            ok: true,
            count: store.listVideos().length,
            videos: store.listVideos().slice(0, 50).map((v) => ({
              bvid: v.bvid, title: v.title, learnedAt: v.learnedAt, score: v.score,
              sections: countSections(store, v.bvid), nextReview: v.review?.nextReview || '',
            })),
            hint: '看某一条用 action=show&bvid=...；加内容用 action=add',
          }
        }
        return { ok: true, bvid, notes: store.notesOf(bvid), sections: countSections(store, bvid) }
      }
      const bvid = extractBvid(args.bvid)
      if (!bvid) throw new Error('action=new/add/show 都要带 bvid')
      if (action === 'new') {
        if (!store.has(bvid)) {
          const meta = await bili().videoInfo(bvid)
          const sc = scoreVideo({
            title: meta.title, desc: meta.desc, play: meta.play, like: meta.like,
            pageCount: meta.pageCount, avgPageSeconds: meta.avgPageSec, durationSeconds: meta.totalSec,
          })
          store.upsertVideo({ ...meta, score: sc.score, verdict: sc.verdict, reasons: sc.reasons })
          store.ensureReview(bvid)
          store.save()
        }
        const path = store.saveRendered(bvid)
        return { ok: true, bvid, created: true, notePath: path, sections: countSections(store, bvid), file: store.renderMarkdown(bvid) }
      }
      if (action === 'add') {
        if (!store.has(bvid)) {
          throw new Error(`还没有 ${bvid} 的笔记壳子：先 action=new&bvid=${bvid}（或直接跑 bili_study_daily）`)
        }
        const note = store.addNote(bvid, { section: args.section, body: args.body, ts: args.ts, tags: args.tags })
        // P3：外部 agent 按 digest 写回时标 source=agent，面板上就能看出是模型/agent/摘句兜底
        const src = String(args.source || '').trim().toLowerCase()
        if (['model', 'agent', 'manual'].includes(src)) {
          store.markRefine(bvid, {
            source: src,
            via: src === 'agent' ? 'digest' : src === 'model' ? 'plugin' : 'note-tool',
            ...(src === 'model' ? {} : { model: '' }),
          })
        }
        store.save()
        const path = store.saveRendered(bvid)
        return { ok: true, bvid, added: note, source: src || '', notePath: path, sections: countSections(store, bvid) }
      }
      if (action === 'show') {
        if (!store.has(bvid)) return { ok: false, bvid, reason: '这条还没有笔记（先 action=new 或跑一轮 daily）' }
        return { ok: true, bvid, notePath: store.saveRendered(bvid), markdown: store.renderMarkdown(bvid).slice(0, 6000) }
      }
      throw new Error(`不认识的 action：${action}（只认 new/add/list/show）`)
    },
  })

  tool({
    name: 'bili_study_find',
    description: '在**自己学过的笔记**里跨视频检索（中文 bigram，不是去公网搜视频）。'
      + '返回命中的视频、小节、带 [[高亮]] 的片段、时间轴锚点与分数。',
    parameters: {
      query: { type: 'string', description: '要找的内容（例如「渐进式披露」「矩阵的秩」）', required: true },
      limit: { type: 'number', description: '返回几条（默认 8）' },
      bvid: { type: 'string', description: '只在这条视频的笔记里找（可省）' },
      section: { type: 'string', description: '只在这个小节里找（可省）' },
    },
    async execute(args) {
      const hits = store.find({
        query: String(args.query ?? ''),
        limit: Number(args.limit) || 8,
        bvid: extractBvid(args.bvid),
        section: String(args.section || ''),
      })
      return {
        ok: true,
        query: args.query,
        count: hits.length,
        hits,
        hint: hits.length ? '这是你自己笔记里的原文，不是网上的' : '笔记里没有命中：换个词，或者这条还没学过',
      }
    },
  })

  tool({
    name: 'bili_study_review',
    description: '复习：action=due 看今天该复习哪些（1/3/7/16/35 天阶梯）；'
      + 'action=grade 评一次分（good/hard/easy/again），下一次复习日期自动往后推。',
    parameters: {
      action: { type: 'string', enum: ['due', 'grade'], description: 'due=今日清单（默认）/ grade=评分' },
      bvid: { type: 'string', description: 'grade 时要评的那条' },
      grade: { type: 'string', enum: ['good', 'hard', 'easy', 'again'], description: 'good 正常想起来 / hard 勉强 / easy 太简单 / again 忘了（当天再来）' },
      days: { type: 'number', description: 'due：往后看几天（默认 0 = 只到今天）' },
      limit: { type: 'number', description: 'due：最多几条（默认 20）' },
    },
    async execute(args) {
      const action = String(args.action || 'due')
      if (action === 'due') {
        const limit = Math.max(1, Number(args.limit) || 20)
        const ahead = Math.max(0, Number(args.days) || 0)
        const today = dayKey()
        const list = store.due(addDays(today, ahead), limit)
        return {
          ok: true,
          today,
          count: list.length,
          due: list,
          ladder: '1/3/7/16/35 天 + ease 微调',
          hint: list.length ? '复习完用 action=grade&bvid=...&grade=good 打卡' : '今天没有要复习的，去看看今天新学的',
        }
      }
      if (action === 'grade') {
        const bvid = extractBvid(args.bvid)
        if (!bvid) throw new Error('grade 要带 bvid')
        const g = String(args.grade || 'good')
        if (!['good', 'hard', 'easy', 'again'].includes(g)) throw new Error('grade 只认 good / hard / easy / again')
        const r = store.grade(bvid, g)
        store.save()
        store.saveRendered(bvid)
        return { ok: true, ...r }
      }
      throw new Error(`不认识的 action：${action}（只认 due/grade）`)
    },
  })

  tool({
    name: 'bili_study_daily',
    description: '**立刻跑一轮每日学习**（搜 → 判分 → 挑几条 → 抓字幕/兜底 → 写笔记 → 出报告，可选评论 @）。'
      + '跑完报告在 <家>/out/<日期>.md。日常它会自己按窗口跑，这个工具用于"我现在就想看一份"。',
    parameters: {},
    timeoutMs: 240000,
    async execute() {
      const r = await startRound('manual')
      if (!r.ok && r.busy) return { ok: false, busy: true, hint: r.hint }
      if (!r.ok) return { ok: false, error: r.error }
      return {
        ok: true,
        date: r.date,
        counts: r.counts,
        status: roundStatusText(r),
        picked: r.picked.map((p) => ({
          bvid: p.bvid, title: p.title, score: p.score, verdict: p.verdict,
          subtitleSource: p.subtitleSource === 'subtitle' ? `读了字幕(${p.lang})` : p.subtitleSource === 'fallback' ? '没有 ai-zh 字幕，走简介+评论兜底' : (p.error || '没抓到'),
          refine: p.refine,
          refineModel: p.refineModel || '',
          refineError: p.refineError || '',
          topics: p.topics,
        })),
        refine: r.refine,
        due: r.due,
        comment: r.comment,
        mention: r.mention || mentionStatus(),
        report: r.report,
        errors: r.errors,
      }
    },
  })

  tool({
    name: 'bili_study_login',
    description: '把 B站 登录 Cookie（SESSDATA，带 bili_jct 更好）存进插件自己的家目录，并校验是否有效。'
      + '⚠️ 只接受本人主动提供的 Cookie；不传 cookie 就是"看现在登录的是谁 + 提示怎么拿"。'
      + '凭证只落 <家>/credential.json（0600），设置页与工具输出一律只给掩码。',
    parameters: {
      cookie: { type: 'string', description: '整条 Cookie（`SESSDATA=...; bili_jct=...`）或只有 SESSDATA 的值' },
      clear: { type: 'boolean', description: 'true = 删掉本地凭据' },
    },
    async execute(args) {
      if (args.clear) {
        const removed = clearCredential(home)
        clientCache = null
        clientKey = ''
        return { ok: true, cleared: removed, credential: credential() }
      }
      if (!args.cookie) {
        const cur = credential()
        let nav = null
        if (cur.loggedIn) {
          try {
            const n = await bili().nav()
            nav = { isLogin: n.isLogin, uname: n.uname, mid: n.mid }
          } catch (e) { nav = { error: humanError(e) } }
        }
        return {
          ok: true,
          credential: cur,
          nav,
          howToGet: '电脑上打开 bilibili.com 并登录 → F12 → Application/存储 → Cookies → 复制 SESSDATA 与 bili_jct 的值，拼成 `SESSDATA=...; bili_jct=...` 粘进来',
        }
      }
      const cookie = normalizeCookie(args.cookie)
      if (!cookie.includes('SESSDATA=')) throw new Error('这条里没有 SESSDATA：确认粘的是 B站 的 Cookie')
      const probe = new BiliClient({ cookie, log })
      const n = await probe.nav()
      if (!n.isLogin) {
        throw new Error('这个 Cookie 校验没通过（nav 说 isLogin=false）：多半是 SESSDATA 抄错或已过期，重新复制一次')
      }
      const file = saveCredential(home, { cookie, uname: n.uname, mid: n.mid })
      clientCache = null
      clientKey = ''
      log(`已保存 B站 凭据（${n.uname || n.mid}）`)
      return { ok: true, saved: file, credential: credential(), uname: n.uname, mid: n.mid, hint: '字幕要有登录态才给；现在可以跑 bili_study_daily 了' }
    },
  })

  tool({
    name: 'bili_study_status',
    description: '看「刷B站学习」今天的状态：跑了没跑、挑了几条、今天该复习几条、登录了没有、报告在哪、下次窗口什么时候开。',
    parameters: {},
    async execute() {
      // 看一眼宿主模型到底能不能用（拿不到也只是标成不可用，不抛）
      try { await ensureModel() } catch { /* 已兜住 */ }
      const st = status()
      const now = new Date()
      return {
        ...st,
        windowsOpen: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, {
          label: w.label, start: w.start, end: w.end, switchOn: Boolean(cfg[k]), opening: inWindow(now, w),
        }])),
      }
    },
  })

  tool({
    name: 'bili_study_config',
    description: '读 / 改「刷B站学习」的设置。不给 patch 就是读；给了就改（只认 schema 里的字段）。'
      + '例：`{"perDay":2,"minScore":55,"days":7,"keywords":["线性代数"],"peakValley":true,"autoComment":false}`',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) saveCfg(args.patch)
      try { await ensureModel() } catch { /* 已兜住 */ }
      return { ok: true, config: cfg, windows: WINDOWS, home, credential: credential(), refine: refineStatus(), mention: mentionStatus() }
    },
  })

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 回调里**绝不许**让异常外冒：未捕获异常会杀掉整个宿主进程（老插件真出过这件事）。
   */
  const tick = () => {
    try {
      if (!cfg.enabled || !cfg.peakValley) return
      if (running) return
      // 补跑：安卓上这一跳可能根本没被系统放行过，所以**每一天**见到就补（plan 自己判幂等）
      runCatchUp('tick')
      if (running) return
      const now = new Date()
      const today = dayKey(now)
      const st = readState()
      for (const k of ['noon', 'night']) {
        if (!cfg[k]) continue
        if (!inWindow(now, WINDOWS[k])) continue
        const key = `${today}:${k}`
        if (st.windows?.[key]) continue
        const windows = { ...(st.windows || {}), [key]: true }
        writeState({ windows })
        log(`窗口 ${WINDOWS[k].label} 到点，开跑`)
        startRound(`window:${k}`)
        return
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }
  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'bili-study: 谷时定时器')
    setTimeout(() => { try { tick() } catch { /* 启动时补一跳 */ } }, 15_000).unref?.()
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── P3：开机探一次宿主模型（拿不到也只是一条状态，不影响任何功能） ─────────────── */
  {
    try {
      const modelTimer = setTimeout(() => {
        try { if (cfg.refine !== false) void ensureModel(true) } catch { /* 已兜住 */ }
      }, 1500)
      modelTimer.unref?.()
      ctx.effect?.(() => () => clearTimeout(modelTimer), 'bili-study: 模型探测')
    } catch (e) { log(`模型探测没排上：${e?.message ?? e}`) }
  }

  /* ─────────────── 补跑：宿主启动那一刻就查一次 ───────────────
   * 这是安卓上最关键的一条路径：App 被打开（进程刚起来）时，插件才第一次有机会判断
   * "今天到底跑过没有"。延迟 5 秒给宿主把 web/工具装完的时间；`unref` 不拖住退出。
   */
  {
    const raw = Number(process.env.BILI_STUDY_CATCHUP_DELAY_MS ?? 5000)
    const delayMs = Number.isFinite(raw) && raw >= 0 ? raw : 5000
    try {
      const bootTimer = setTimeout(() => { runCatchUp('boot') }, delayMs)
      bootTimer.unref?.()
      ctx.effect?.(() => () => clearTimeout(bootTimer), 'bili-study: 启动补跑')
    } catch (e) { log(`启动补跑没排上：${e?.message ?? e}`) }
  }

  /* ─────────────── HTTP（设置页 / 今日面板用） ─────────────── */
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  const todayPanel = () => {
    const today = dayKey()
    const st = readState()
    const stats = store.stats(today)
    const result = st.lastResult && st.lastResult.date === today ? st.lastResult : null
    return {
      ok: true,
      date: today,
      status: result ? roundStatusText(result) : '今天还没跑',
      lastRunAt: st.lastRunAt || '',
      counts: result?.counts || null,
      learned: result?.picked?.length
        ? result.picked
        : stats.learnedToday.map((v) => ({
          bvid: v.bvid, title: v.title, score: v.score, verdict: v.verdict, subtitleSource: '',
          refine: v.refine?.source || 'excerpt', refineModel: v.refine?.model || '',
        })),
      due: stats.due,
      dueCount: stats.dueCount,
      totalVideos: stats.totalVideos,
      totalNotes: stats.totalNotes,
      report: join(outDir, `${today}.md`),
      comment: result?.comment || null,
      errors: result?.errors || [],
      catchUp: catchUpInfo(),
      refine: refineStatus(),
      mention: mentionStatus(),
      config: {
        perDay: cfg.perDay, autoComment: cfg.autoComment, mentionName: cfg.mentionName,
        peakValley: cfg.peakValley, catchUp: cfg.catchUp, refine: cfg.refine,
        refineMaxChars: cfg.refineMaxChars, refinePerRound: cfg.refinePerRound, refineModel: cfg.refineModel,
      },
    }
  }

  const handle = async (req, res, url) => {
    const p = url.pathname
    if (req.method === 'GET' && p === '/api/bili-study/status') {
      sendJson(res, 200, status())
      // 设置页/面板每 8 秒轮询这里 —— 也就是"用户打开了插件"：顺手判一次补跑（幂等，plan 说了算）
      setImmediate(() => { void runCatchUp('settings') })
      return
    }
    if (req.method === 'GET' && p === '/api/bili-study/today') {
      sendJson(res, 200, todayPanel())
      setImmediate(() => { void runCatchUp('panel') })
      return
    }

    if (req.method === 'GET' && p === '/api/bili-study/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: WINDOWS, home, credential: credential(), refine: refineStatus(), mention: mentionStatus() })
    }
    if (req.method === 'POST' && p === '/api/bili-study/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of Object.keys(CONFIG_DEFAULTS)) if (k in body) patch[k] = body[k]
      if ('perDay' in patch) patch.perDay = Math.max(0, Math.min(Number(patch.perDay) || 0, 10))
      if ('minScore' in patch) patch.minScore = Math.max(0, Math.min(Number(patch.minScore) || 0, 100))
      if ('days' in patch) patch.days = Math.max(0, Math.min(Number(patch.days) || 0, 365))
      if ('commentPerRound' in patch) patch.commentPerRound = Math.max(1, Math.min(Number(patch.commentPerRound) || 1, 3))
      if ('refineMaxChars' in patch) patch.refineMaxChars = Math.max(1000, Math.min(Number(patch.refineMaxChars) || REFINE_DEFAULT_MAX_CHARS, 60000))
      if ('refinePerRound' in patch) patch.refinePerRound = Math.max(0, Math.min(Number(patch.refinePerRound) || 0, 10))
      if ('refineModel' in patch) patch.refineModel = String(patch.refineModel ?? '').trim().slice(0, 120)
      saveCfg(patch)
      log(`设置已更新：${JSON.stringify(patch)}`)
      return sendJson(res, 200, { ok: true, config: cfg, refine: refineStatus(), mention: mentionStatus() })
    }

    if (req.method === 'POST' && p === '/api/bili-study/run') {
      const r = await startRound('manual')
      if (!r.ok) return sendJson(res, 200, { ok: false, busy: r.busy, error: r.error, hint: r.hint })
      return sendJson(res, 200, { ok: true, date: r.date, counts: r.counts, status: roundStatusText(r), report: r.report })
    }

    if (req.method === 'POST' && p === '/api/bili-study/credential') {
      const body = await readBody(req)
      const cookie = normalizeCookie(body.cookie || '')
      if (!cookie.includes('SESSDATA=')) return sendJson(res, 400, { ok: false, error: '这条里没有 SESSDATA：确认粘的是 B站 的 Cookie' })
      try {
        const probe = new BiliClient({ cookie, log })
        const n = await probe.nav()
        if (!n.isLogin) return sendJson(res, 200, { ok: false, error: '校验没通过（isLogin=false）：SESSDATA 可能抄错或过期，重新复制一次' })
        saveCredential(home, { cookie, uname: n.uname, mid: n.mid })
        clientCache = null
        clientKey = ''
        log(`设置页保存了凭据（${n.uname || n.mid}）`)
        return sendJson(res, 200, { ok: true, credential: credential(), uname: n.uname })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: humanError(e) })
      }
    }
    if (req.method === 'POST' && p === '/api/bili-study/credential/clear') {
      const removed = clearCredential(home)
      clientCache = null
      clientKey = ''
      return sendJson(res, 200, { ok: true, cleared: removed, credential: credential() })
    }

    if (req.method === 'POST' && p === '/api/bili-study/review') {
      const body = await readBody(req)
      const bvid = extractBvid(body.bvid)
      if (!bvid) return sendJson(res, 400, { ok: false, error: '要带 bvid' })
      try {
        const r = store.grade(bvid, String(body.grade || 'good'))
        store.save()
        store.saveRendered(bvid)
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: humanError(e) })
      }
    }

    if (req.method === 'GET' && p === '/api/bili-study/report') {
      const today = dayKey()
      try {
        const md = readFileSync(join(outDir, `${today}.md`), 'utf8')
        return sendJson(res, 200, { ok: true, date: today, markdown: md.slice(0, 20000) })
      } catch {
        return sendJson(res, 200, { ok: false, error: '今天还没有报告' })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${p}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-study',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          log(`HTTP 处理出错：${e?.stack ?? e}`)
          sendJson(res, 500, { ok: false, error: humanError(e) })
        }
      },
    }), 'bili-study: /api/bili-study 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  // 把这行留着：排障时第一眼看的就是「宿主依赖到底解析到没有」
  log(`已挂载（家=${home}，每天 ${cfg.perDay} 条，峰谷=${cfg.peakValley ? '开' : '关'}，补跑=${cfg.catchUp ? '开' : '关'}，模型提炼=${cfg.refine ? '开' : '关'}，自动评论=${cfg.autoComment ? '开' : '关'}；依赖：defineTool=${defineTool ? 'ok' : '降级'} schemastery=${z ? 'ok' : '降级'} settings=${typeof ctx.settings?.register === 'function' ? 'ok' : '缺失'} llm=${typeof ctx.get('llm')?.stream === 'function' ? 'ok' : '缺失'}）`)
}

/* ───────────────────────── 文件小工具 ───────────────────────── */

function writeText(file, text) {
  writeFileSync(file, text, 'utf8')
  return file
}

/** homeDirOf 的"绝不抛"版本（家里建不出来也要让插件活着，只是功能全废）。 */
function homeDirOfSafe(ctx) {
  try {
    return homeDirOf(ctx)
  } catch (e) {
    const fallback = join(process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh'), HOME_NAME)
    try { mkdirSync(fallback, { recursive: true }) } catch { /* 真建不出来就认了 */ }
    return fallback
  }
}

function countSections(store, bvid) {
  const out = {}
  for (const n of store.notesOf(bvid)) out[n.section] = (out[n.section] || 0) + 1
  return out
}
