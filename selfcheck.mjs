#!/usr/bin/env node
/**
 * selfcheck.mjs —— 装上之前先在本机把"宿主会做的事"真跑一遍
 * ============================================================================
 * 用法：`node selfcheck.mjs`（不需要 dsh 在跑，也不需要联网）
 * 退出码：0 = 全绿；1 = 有问题（打印 ✗ 与建议）
 *
 * 检查四类事（都是"装上之后才会炸"的那类）：
 *   ① **包契约**：name/version/main/dsh.bundle.patch/dsh.client 齐备，入口与 patch 真实存在
 *   ② **patch 与代码对得上**：patch 里的 id/name 与 package.json、settings 命名空间一致；
 *      patch 里出现的每个 config 字段都在 CONFIG_DEFAULTS 里（拼错的字段会被静默忽略）
 *   ③ **依赖纯度**：`dependencies` 必须为空 / 只允许 `@deepseek-ai/*` 与 node: 内置模块；
 *      不许出现原生模块；不许出现包外的绝对路径（手机上必然翻车的两条）
 *   ④ **两个半端真跑**：假 ctx 上跑 apply()（工具/路由都注册上），假 window 上跑 client 工厂
 *      （两页都挂到 settings.section）—— 这比"重启一次看日志"快得多
 * ============================================================================
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(tmpdir(), `dsha-bili-study-selfcheck-${process.pid}`)
let failures = 0
const ok = (msg) => console.log(`✓ ${msg}`)
const bad = (msg, hint = '') => {
  failures += 1
  console.log(`✗ ${msg}${hint ? `\n    → ${hint}` : ''}`)
}
const head = (msg) => console.log(`\n── ${msg} ${'─'.repeat(Math.max(0, 60 - msg.length))}`)

try {
  /* ───────────── ① 包契约 ───────────── */
  head('包契约')
  const pkgPath = join(HERE, 'package.json')
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (e) { bad('package.json 读不出来/不是合法 JSON', String(e.message)); throw e }

  if (/^[a-z0-9][a-z0-9._-]*$/.test(String(pkg.name))) ok(`name = ${pkg.name}`)
  else bad(`name 不是合法 npm 名：${pkg.name}`, '只能小写字母/数字/-._，不能有空格与大写')
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(pkg.version))) ok(`version = ${pkg.version}`)
  else bad(`version 不是 semver：${pkg.version}`)

  const main = pkg.main || 'index.js'
  if (existsFile(join(HERE, main))) ok(`main 存在：${main}`)
  else bad(`main 指向的文件不存在：${main}`)

  const patchRel = pkg?.dsh?.bundle?.patch
  if (typeof patchRel === 'string' && existsFile(join(HERE, patchRel))) ok(`dsh.bundle.patch 存在：${patchRel}`)
  else bad('dsh.bundle.patch 缺失或指向不存在的文件', 'DSHA 的包契约要求它指向真实存在的 patch')

  if (pkg?.dsh?.client?.platform === 'web') ok('dsh.client.platform = web')
  else bad('dsh.client.platform 必须是 web')
  if (Array.isArray(pkg?.dsh?.client?.inject) && pkg.dsh.client.inject.length) ok(`dsh.client.inject = ${pkg.dsh.client.inject.length} 个`)
  else bad('dsh.client.inject 为空', 'client bundle 需要注入 dsh-client-runtime / ui-settings 等')

  for (const f of ['client.js', 'cordis.patch.yml', 'prompts/duty.md', 'README.md', 'AGENTS.md', 'lib/score.js', 'lib/bili-api.js', 'lib/notes.js', 'lib/duty.js', 'lib/state.js', 'lib/catchup.js', 'lib/refine.js', 'lib/model.js']) {
    if (!existsFile(join(HERE, f))) bad(`缺文件：${f}`)
  }
  if (failures === 0) ok('必需文件齐全（client/patch/prompts/README/AGENTS/lib×8）')

  /* ───────────── ② patch 与代码对得上 ───────────── */
  head('patch 与代码')
  const patch = readFileSync(join(HERE, patchRel), 'utf8')
  const idHit = /-\s*id:\s*([\w-]+)/.exec(patch)
  const nameHit = /\bname:\s*([\w./@-]+)/.exec(patch)
  if (idHit) ok(`patch 里的 entry id = ${idHit[1]}`)
  else bad('patch 里没有 id（insert 条目缺 id）')
  if (nameHit && nameHit[1] === pkg.name) ok(`patch 里的 name = ${nameHit[1]}（与 package.json 一致）`)
  else bad(`patch 里的 name（${nameHit?.[1] ?? '缺失'}）与 package.json 的 name（${pkg.name}）不一致`)

  const patchConfigKeys = []
  const cfgBlock = /config:\s*([\s\S]*)$/.exec(patch)
  if (cfgBlock) {
    for (const line of cfgBlock[1].split(/\r?\n/)) {
      const m = /^\s{6,}([\w]+):/.exec(line)
      if (m) patchConfigKeys.push(m[1])
    }
  }
  ok(`patch 里的 config 字段 ${patchConfigKeys.length} 个`)

  /* 动态 import index.js（宿主依赖拿不到也能活 —— 这就是为了手机上不炸） */
  let mod
  try { mod = await import(`./index.js?selfcheck=${Date.now()}`) } catch (e) {
    bad('import index.js 失败', String(e?.message ?? e)); throw e
  }
  if (mod.name === 'bili-study') ok(`模块导出的 name = ${mod.name}`)
  else bad(`模块 name 应该是 bili-study，实际是 ${mod.name}`, 'loader entry 的 id 与 settings 命名空间要对上')

  const cfgKeys = Object.keys(mod.CONFIG_DEFAULTS ?? {})
  const strayKeys = patchConfigKeys.filter((k) => !cfgKeys.includes(k))
  if (strayKeys.length) bad(`patch 里有代码不认识的 config 字段：${strayKeys.join(', ')}`, '拼错的字段会被静默忽略，用户以为改了其实没改')
  else ok('patch 的 config 字段全部被代码认识')
  if (mod.Config === undefined) console.log('  · 提示：没解析到 @deepseek-ai/schemastery（本机没装宿主），Config 走 undefined —— 这是设计好的降级，不算失败')

  /* ───────────── ③ 依赖纯度（手机上最容易翻车的地方） ───────────── */
  head('依赖纯度')
  const deps = Object.keys(pkg.dependencies ?? {})
  if (deps.length === 0) ok('dependencies 为空（零运行时依赖）')
  else if (deps.every((d) => d.startsWith('@deepseek-ai/'))) ok(`dependencies 只有宿主包：${deps.join(', ')}`)
  else bad(`dependencies 里有非宿主包：${deps.filter((d) => !d.startsWith('@deepseek-ai/')).join(', ')}`, '手机装不上编译型依赖')

  const NATIVE = ['better-sqlite3', 'sqlite3', 'sharp', 'canvas', 'bcrypt', 'node-gyp', 'node-pre-gyp', 'ffi-napi', 'serialport', 'puppeteer', 'playwright']
  const files = listFiles(HERE).filter((f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.yml') || f.endsWith('.json'))
  const shipped = files.filter((f) => !f.includes('node_modules') && !f.includes('tests/') && !f.endsWith('selfcheck.mjs'))
  let importProblems = []
  for (const rel of shipped) {
    const text = readFileSync(join(HERE, rel), 'utf8')
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:') || spec.startsWith('#')) continue
      if (spec.startsWith('@deepseek-ai/')) continue
      // client bundle 里的 'react' 由宿主（浏览器那半边）提供，不是 npm 依赖
      if (spec === 'react') continue
      importProblems.push(`${rel} → ${spec}`)
    }
    for (const n of NATIVE) {
      if (new RegExp(`['"]${n}['"]`).test(text)) importProblems.push(`${rel} → 原生模块 ${n}`)
    }
    if (/\b[Cc]:\\Users\\/.test(text) || /\/Users\/[A-Za-z0-9_.-]+\//.test(text)) importProblems.push(`${rel} → 硬编码了本机绝对路径`)
  }
  if (importProblems.length) bad(`依赖/路径问题：\n    ${importProblems.join('\n    ')}`)
  else ok(`模块引用干净（${shipped.length} 个文件，只有相对路径 / node: 内置 / @deepseek-ai/*）`)

  /* ───────────── ④ 两个半端真跑 ───────────── */
  head('host 半端（假 ctx 上跑 apply）')
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const tools = []
  const routes = []
  // P3：假 ctx 也装一套「宿主模型」，用来验探测链路（不联网、不真调模型）
  const fakeLlm = {
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
  }
  const fakeCtx = {
    get: (k) => {
      if (k === 'dshHomePath') return (...seg) => join(SANDBOX, ...seg)
      if (k === 'llm') return fakeLlm
      if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
    tools: { register: (t) => { tools.push(t); return t } },
    webServer: { register: (r) => { routes.push(r); return { dispose() {} } } },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    settings: { register: () => ({}) },
  }
  // ⚠️ 预检不联网：把补跑关掉 + 把"启动补跑"的定时器推到很久以后（这段只验接线，真逻辑在单测里）
  process.env.BILI_STUDY_CATCHUP_DELAY_MS = '600000'
  // P3 升级路径：先放一份「0.1.0 时代、没有 digest 段」的家目录任务书，apply 后应被**追加**而不是覆盖
  mkdirSync(join(SANDBOX, 'dsha-bili-study'), { recursive: true })
  writeFileSync(join(SANDBOX, 'dsha-bili-study', 'duty.md'), '# 我的旧任务书\n\n用户自己写的，别覆盖\n', 'utf8')
  try { mod.apply(fakeCtx, { catchUp: false }) } catch (e) {
    bad('host 半端 apply() 抛错（宿主里就是那句 "1 entry did not activate"）', String(e?.stack ?? e).split('\n').slice(0, 4).join('\n    '))
  }
  {
    const WANT = ['bili_study_search', 'bili_study_video', 'bili_study_subtitle', 'bili_study_note',
      'bili_study_find', 'bili_study_review', 'bili_study_daily', 'bili_study_login', 'bili_study_status',
      'bili_study_config', 'bili_study_digest']
    const got = tools.map((t) => t?.name)
    const missing = WANT.filter((n) => !got.includes(n))
    if (missing.length) bad(`少了工具：${missing.join(', ')}`)
    else ok(`${WANT.length} 个工具都注册上了（含 P3 的 bili_study_digest）`)
    if (got.some((n) => !String(n).startsWith('bili_study_'))) bad(`有工具没用统一前缀：${got.filter((n) => !String(n).startsWith('bili_study_')).join(', ')}`)
    else ok('工具名统一 bili_study_ 前缀')

    const noDesc = tools.filter((t) => !/[\u4e00-\u9fff]/.test(String(t?.description || '')))
    if (noDesc.length) bad(`这些工具没有中文 description：${noDesc.map((t) => t.name).join(', ')}`)
    else ok('每个工具都有中文 description')

    const badSchema = tools.filter((t) => !t?.parameters || t.parameters.type !== 'object' || typeof t.parameters.properties !== 'object')
    if (badSchema.length) bad(`这些工具的 parameters 不是标准 JSON Schema：${badSchema.map((t) => t.name).join(', ')}`, 'defineTool 那一侧会被编译成 JSON Schema；降级路径也必须产出同样的形状')
    else ok('每个工具的 parameters 都是 object-rooted JSON Schema')

    const noOutput = tools.filter((t) => typeof t?.output?.render !== 'function')
    if (noOutput.length) bad(`这些工具没声明 output.render：${noOutput.map((t) => t.name).join(', ')}`, '宿主 register 会直接 TypeError')
    else ok('每个工具都声明了 output.render')

    if (routes.length && routes[0].path === '/api/bili-study') ok(`HTTP 路由挂上了：${routes[0].path} (${routes[0].kind})`)
    else bad('HTTP 路由没挂上（设置页会一片空白）')

    /* 补跑（P2）：接线对不对，走真实 HTTP 路由验一遍 */
    let catchupMod = null
    try { catchupMod = await import(`./lib/catchup.js?selfcheck=${Date.now()}`) } catch (e) { bad('import lib/catchup.js 失败', String(e?.message ?? e)) }
    if (catchupMod) {
      const need = ['planCatchUp', 'runCatchUpOnce', 'recordCatchUp', 'catchUpStatus', 'todayRan', 'CATCHUP_LOG_LINE']
      const lost = need.filter((k) => catchupMod[k] === undefined)
      if (lost.length) bad(`lib/catchup.js 少了导出：${lost.join(', ')}`)
      else ok('lib/catchup.js 导出齐全（计划/执行/记录/文案）')
      if (catchupMod.CATCHUP_LOG_LINE === 'catch-up: 今天尚无 round，触发补跑') ok('补跑日志文案与需求逐字一致')
      else bad(`补跑日志文案不对：${catchupMod.CATCHUP_LOG_LINE}`)
      const plan = catchupMod.planCatchUp({
        cfg: { enabled: true, peakValley: true, noon: true, night: false, perDay: 2, catchUp: true },
        state: {}, now: new Date('2026-10-17T03:30:00'), hasReport: false,
      })
      if (plan.run) ok('今天没跑过 + 凌晨窗口外 → 仍判定该补跑（安卓兜底口径）')
      else bad(`补跑判定不对：${plan.reason}`, '补跑不能在窗口外就不补 —— 那等于把安卓上的 bug 留着')
    }

    /* P3：模型提炼（提示词 / 解析 / 降级 / 工具面） */
    let refineMod = null
    try { refineMod = await import(`./lib/refine.js?selfcheck=${Date.now()}`) } catch (e) { bad('import lib/refine.js 失败', String(e?.message ?? e)) }
    if (refineMod) {
      const need = ['REFINE_PROMPT_VERSION', 'REFINE_SECTIONS', 'REFINE_SYSTEM', 'buildRefinePrompt',
        'subtitleTranscript', 'parseRefineOutput', 'validateRefine', 'refineSectionsFrom',
        'mergeRefinedSections', 'runRefine', 'buildDigestInstruction']
      const lost = need.filter((k) => refineMod[k] === undefined)
      if (lost.length) bad(`lib/refine.js 少了导出：${lost.join(', ')}`)
      else ok('lib/refine.js 导出齐全（提示词/解析/校验/降级/digest）')

      const prompt = refineMod.buildRefinePrompt({ title: 't', transcript: '[0:01] hello' })
      const missingRules = ['ASR', 'deep fw0V', 'DeepSeek V4.1 Flash', 'GPT-6.1', '不许补充', '严格 JSON', '600 字']
        .filter((needle) => !prompt.includes(needle))
      if (missingRules.length) bad(`提炼提示词缺关键约束：${missingRules.join(', ')}`, 'ASR 纠正边界与"不许编造"必须写死在提示词里')
      else ok('提炼提示词写死了 ASR 纠正边界 + 不许编造 + 严格 JSON + 600 字上限')

      const good = refineMod.parseRefineOutput(JSON.stringify({
        要点: [{ text: '要点', ts: '1:23' }], 金句: [], 我的判断: '判断', 值不值得再看: '结论',
      }))
      if (good.ok && good.data.points.length === 1) ok('模型返回解析（严格 JSON）')
      else bad('约定 JSON 解析不出来')
      const badOut = refineMod.parseRefineOutput('完全不是约定的结构')
      if (!badOut.ok) ok('解析失败能识别（会降级回摘句，不写坏笔记）')
      else bad('解析失败没被判出来', '失败必须走降级路径')

      const digestCmd = refineMod.buildDigestInstruction({ bvid: 'BV1ahFmzqE9z', transcript: '' })
      if (digestCmd.includes('source=agent')) ok('digest 写回命令带 source=agent（面板能标出外部 agent）')
      else bad('digest 写回命令没带 source=agent', '两条路都要能看出笔记来源')
    }

    /* 0.2.1：评论闸门（不许引用未提炼的 ASR 原文）+ mentionName 兜底 */
    let dutyMod = null
    try { dutyMod = await import(`./lib/duty.js?selfcheck=${Date.now()}`) } catch (e) { bad('import lib/duty.js 失败', String(e?.message ?? e)) }
    if (dutyMod) {
      const need = ['composeComment', 'resolveMention', 'looksLikeAsrNoise']
      const lost = need.filter((k) => dutyMod[k] === undefined)
      if (lost.length) bad(`lib/duty.js 少了 0.2.1 的导出：${lost.join(', ')}`)
      else ok('lib/duty.js 导出齐全（评论文案 / @ 名兜底 / ASR 噪声判定）')

      const excerptMaterial = { points: [{ text: '今天是26年10月17日dB sk呢发布了一个新的fla' }], topics: ['噪声'] }
      const guarded = dutyMod.composeComment({ mentionName: '乌子鱼', material: excerptMaterial, bvid: 'BV1n9Jv6QE3A', refine: 'excerpt' })
      if (guarded === null) ok('评论闸门：refine 缺失（摘句兜底）→ composeComment 返回 null')
      else bad(`refine 缺失时居然生成了评论文案：${String(guarded).slice(0, 80)}`, '0.2.0 真机就是把 ASR 原文这样发出去的')

      const goodComment = dutyMod.composeComment({
        mentionName: '乌子鱼',
        material: { points: [{ text: '渐进式披露解决的是上下文膨胀' }] },
        bvid: 'BV1aaaaaaaaa',
        refine: 'model',
      })
      if (typeof goodComment === 'string' && goodComment.startsWith('@乌子鱼 ')) ok('评论闸门：模型提炼的要点可以生成评论文案')
      else bad(`模型提炼的内容反而生成不了文案：${String(goodComment)}`)

      const dirty = dutyMod.composeComment({
        mentionName: '乌子鱼', material: excerptMaterial, bvid: 'BV1n9Jv6QE3A', refine: 'model',
      })
      if (dirty === null) ok('评论闸门：就算标成 model，ASR 混合噪声（dB sk呢 / 新的fla）也剔除 → 整条不发')
      else bad(`ASR 噪声没被剔除：${String(dirty).slice(0, 100)}`, '评论是对外发言，宁可少发')

      const autoMention = dutyMod.resolveMention({ mentionName: '', uname: '小小鲸鱼娘' })
      if (autoMention.name === '小小鲸鱼娘' && autoMention.source === 'credential') ok('@ 名兜底：空值自动用登录账号 credential.uname')
      else bad(`@ 名空值时没有兜底到登录账号：${JSON.stringify(autoMention)}`)
      const clash = dutyMod.resolveMention({ mentionName: '乌子鱼不在家', uname: '小小鲸鱼娘' })
      if (clash.name === '乌子鱼不在家' && clash.mismatch && /@ 错人/.test(clash.warn)) {
        ok(`@ 名与登录名不一致：保留用户填的值 + 醒目提示（${clash.warn}）`)
      } else bad('@ 名不一致时没有提示或改了用户填的值', JSON.stringify(clash))
    }

    const noteTool = tools.find((t) => t.name === 'bili_study_note')
    if (noteTool?.parameters?.properties?.source) ok('bili_study_note 支持 source=（model/agent/manual）')
    else bad('bili_study_note 没有 source 参数', '外部 agent 写回时无法标注来源')

    const digestTool = tools.find((t) => t.name === 'bili_study_digest')
    if (digestTool && digestTool.parameters?.properties?.bvid) ok('bili_study_digest 工具的参数声明齐全')
    else bad('bili_study_digest 工具缺失或参数不对', '提示词驱动那条路就断了')
    if (/bili_study_digest/.test(readFileSync(join(HERE, 'prompts', 'duty.md'), 'utf8'))) ok('prompts/duty.md 带「每日收尾跑 digest 写回」的指令')
    else bad('prompts/duty.md 没写 digest 收尾步骤', '宿主没模型时 agent 不知道要做什么')

    const statusTool = tools.find((t) => t.name === 'bili_study_status')
    if (statusTool) {
      try {
        const st = await statusTool.execute({})
        if (st?.refine?.available && st.refine.provider === 'deepseek-official' && st.refine.model === 'deepseek-flash') {
          ok(`状态里能看见宿主模型：${st.refine.provider}/${st.refine.model}`)
        } else {
          bad('状态里的 refine 探测不对（假 ctx 明明装了 llm + 默认模型）', `实际：${JSON.stringify(st?.refine ?? null)}`)
        }
        if (typeof st?.refine?.todayCalls === 'number' && typeof st?.refine?.yesterdayCalls === 'number') {
          ok('状态里带模型调用计数（本轮/今天/昨天）')
        } else bad('状态里没有模型调用计数', '设置页要显示轻量成本')
      } catch (e) { bad('bili_study_status 执行抛错', String(e?.message ?? e)) }
    }

    if (routes.length && typeof routes[0].handler === 'function') {
      const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b) } }
      try {
        await routes[0].handler({ method: 'GET', url: '/api/bili-study/status', on() {}, destroy() {} }, res)
        const st = JSON.parse(res.body || '{}')
        if (res.code === 200 && st.ok) ok('/api/bili-study/status 应答 200（工具注册在路由之前，这条通了说明整条链都活了）')
        else bad(`status 应答不对（code=${res.code}）`, '设置页会一片空白')
        if (st?.catchUp && typeof st.catchUp.text === 'string' && st.catchUp.text) ok(`状态里带补跑：${st.catchUp.text}`)
        else bad('状态里没有补跑信息', '设置页要能看见「今天已跑 / 今天未跑·待补」')
        if (st?.catchUp?.enabled === false) ok('补跑开关跟着 config 走（本次预检传的是关闭）')
        else bad('config.catchUp=false 没传到 /status 上', '用户关了补跑，界面必须显示「补跑：关」')
        if (st?.refine && st.refine.enabled === true && st.refine.available === true) {
          ok(`状态里带模型提炼（默认开，${st.refine.provider}/${st.refine.model}）`)
        } else bad('状态里的 refine 不可用/缺失', '设置页看不出「模型直调」还是「摘句兜底」')
        if (st?.refine?.promptVersion) ok(`提炼提示词版本：${st.refine.promptVersion}`)
        else bad('状态里没有提炼提示词版本')
        if (st?.mention && typeof st.mention.effective === 'string' && typeof st.mention.mismatch === 'boolean') {
          ok(`状态里带 @ 名兜底信息（source=${st.mention.source}，effective=${st.mention.effective || '（未登录/未填）'}）`)
          if (st.mention.warn) ok(`状态里能看见 @ 名提示：${st.mention.warn}`)
          else bad('没登录也没填 @ 名时，状态里没有提示', '设置页要能看出「评论会发不出去」')
        } else bad('状态里没有 mention（@ 名兜底）信息', '设置页无法提示 @ 错人')
      } catch (e) {
        bad('GET /api/bili-study/status 抛错', String(e?.message ?? e))
      }
    }

    const home = join(SANDBOX, 'dsha-bili-study')
    if (existsFile(join(home, 'out')) && existsFile(join(home, 'notes'))) ok('家目录结构建好了（out/ notes/ subs/）')
    else bad('家目录没建出来（手机上会写不进去）')
    try {
      const dutyHome = readFileSync(join(home, 'duty.md'), 'utf8')
      if (dutyHome.includes('用户自己写的，别覆盖') && dutyHome.includes('bili_study_digest')) {
        ok('旧版 duty.md 升级：保留用户内容 + 追加 digest 收尾段')
      } else {
        bad('duty.md 升级路径不对', '要么覆盖了用户内容，要么没追加 P3 收尾段')
      }
    } catch (e) { bad('家目录 duty.md 读不出来', String(e?.message ?? e)) }
  }

  /* client 半端 */
  head('client 半端（假 window 上跑 factory）')
  let loaded = null
  const prevWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  try { await import(`./client.js?selfcheck=${Date.now()}`) } catch (e) {
    bad('client.js 一 import 就抛错（浏览器里会是空白页）', String(e?.message ?? e))
  }
  globalThis.window = prevWindow
  if (!loaded) {
    bad('client.js 没有调用 window.__ModuleLoader__.load({...})')
  } else {
    if (loaded.id === pkg.name) ok(`client id = ${loaded.id}（与 package.json 一致）`)
    else bad(`client id（${loaded.id}）必须等于 package.json 的 name（${pkg.name}）`)
    if (typeof loaded.factory === 'function') ok('factory 是函数')
    else bad('load({...}) 里没有 factory')

    const clientSrc = readFileSync(join(HERE, 'client.js'), 'utf8')
    const refineUi = ['模型提炼', 'refineMaxChars', 'refinePerRound', 'refineModel', 'bili_study_digest', '提炼：']
      .filter((needle) => !clientSrc.includes(needle))
    if (refineUi.length) bad(`client.js 缺 P3 的开关/状态：${refineUi.join(', ')}`, '设置页必须能开关提炼、填上限、看调用次数')
    else ok('client.js 带 P3 设置项（开关 / 字幕上限 / 每轮上限 / 指定模型 / 提炼来源 / digest 提示）')

    const mentionUi = ['≠ 登录名', '自动用登录账号', '实际会 @', '宁可少发']
    const lostMentionUi = mentionUi.filter((needle) => !clientSrc.includes(needle))
    if (lostMentionUi.length) bad(`client.js 缺 0.2.1 的 @ 名提示/评论规则：${lostMentionUi.join(', ')}`, '设置页要显眼地提示「@ 名 ≠ 登录名，评论会 @ 错人」')
    else ok('client.js 带 0.2.1 的 @ 名兜底提示 + 「评论只引用模型提炼内容」说明')

    const fakeReact = {
      createElement: (...a) => ({ tag: a[0], props: a[1] }),
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useMemo: (f) => f(),
      Fragment: 'Fragment',
    }
    let clientMod
    try {
      clientMod = loaded.factory((n) => {
        if (n === 'react') return fakeReact
        throw new Error(`client.js require 了没预料到的包：${n}`)
      })
    } catch (e) { bad('factory(require) 抛错', String(e?.message ?? e)) }
    if (clientMod && typeof clientMod.apply === 'function') ok('factory 返回了带 apply() 的对象')
    else bad('factory 必须返回 { inject, apply }')

    if (clientMod) {
      const slots = []
      const styles = []
      const prevDoc = globalThis.document
      globalThis.document = {
        createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
        head: { appendChild: (n) => styles.push(n) },
      }
      try {
        clientMod.apply({
          effect: (fn) => { try { return fn() } catch { return undefined } },
          slots: {
            inject: (name, fn) => { fn() },
            register: (opts, Component) => { slots.push({ ...opts, component: Component }); return {} },
          },
        })
      } catch (e) { bad('client.apply(ctx) 抛错', String(e?.message ?? e)) }
      globalThis.document = prevDoc

      if (slots.length >= 2) ok(`注册了 ${slots.length} 个 settings.section`)
      else bad(`只注册了 ${slots.length} 个 settings.section（设置页 + 今天学了什么 两页都要）`)
      const noLabel = slots.filter((s) => !s.label)
      if (noLabel.length) bad('有 section 没给 label（左侧导航会空着）')
      else ok(`栏目名：${slots.map((s) => s.label).join(' / ')}`)
      const noComp = slots.filter((s) => typeof s.component !== 'function')
      if (noComp.length) bad('有 section 没给组件函数')
      else ok('每个 section 都带组件')
      if (styles.length) ok('样式已挂到 document.head')
      else bad('没有把样式挂上（页面会没样子）')
    }
  }

  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 清不掉就留着 */ }

  head('结论')
  if (failures) {
    console.log(`✗ ${failures} 处问题（上面每条都带「怎么办」）`)
    process.exit(1)
  }
  console.log('✓ 全绿：包契约 / patch / 依赖纯度 / host 半端 / client 半端 都过了')
  console.log('  （真机安装仍需在手机上走一遍：见 DELIVERY.md「在手机上怎么装与验收」）')
  process.exit(0)
} catch (e) {
  console.error(`\n✗ selfcheck 自己崩了：${e?.stack ?? e}`)
  process.exit(1)
}

/* ───────────── 小工具 ───────────── */
function existsFile(p) {
  try { return statSync(p).isFile() || statSync(p).isDirectory() } catch { return false }
}
function listFiles(dir, base = '') {
  const out = []
  for (const name of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${name.name}` : name.name
    if (name.isDirectory()) {
      if (['node_modules', '.git'].includes(name.name)) continue
      out.push(...listFiles(dir, rel))
    } else out.push(rel)
  }
  return out
}
