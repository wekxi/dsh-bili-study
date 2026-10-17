/**
 * dsha-bili-study —— 浏览器半端（设置页 + 「今天学了什么」面板）
 * ============================================================================
 * ⭐ client bundle **不是 ESM**，是自注册脚本（跟 dsh-bili-scroll 同一个约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                        // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: ['slots'], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 两页都挂在 `settings.section` 这个 list slot 上（id/order 决定顺序）：
 *     · id=bili-study        设置页
 *     · id=bili-study-today  「今天学了什么」—— 设置页旁边的一屏摘要
 *    手机上（DSHA）以竖屏为准：单列、字号 ≥12px、不用长表格、字段都能换行。
 *
 * ⚠️ 输入框一律绑**本地草稿**：页面每 5–10 秒轮询 /status，直接绑 cfg 的话
 *    用户打到一半的字会被服务端那份冲掉（老插件验收时真踩过）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-study',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-study'
    const jget = async (p) => (await fetch(API + p, { credentials: 'same-origin' })).json()
    const jpost = async (p, body) => (await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })).json()

    const CSS = `
[data-bs-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 24px;max-width:680px;}
[data-bs-sec]{display:flex;flex-direction:column;gap:9px;}
[data-bs-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);text-transform:none;}
[data-bs-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-bs-grow]{flex:1;min-width:0;}
[data-bs-label]{font-size:13px;line-height:19px;}
[data-bs-note]{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-word;}
[data-bs-sw]{flex:none;width:40px;height:23px;border-radius:12px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bs-sw][data-on]{background:#3b82f6;}
[data-bs-sw] i{position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bs-sw][data-on] i{left:20px;}
[data-bs-sw][disabled]{opacity:.45;cursor:default;}
[data-bs-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-bs-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:13px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-bs-input]:focus{outline:none;border-color:#3b82f6;}
[data-bs-num]{width:96px;text-align:center;flex:none;}
[data-bs-btn]{padding:8px 13px;border-radius:8px;font-size:12.5px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-bs-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-bs-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-bs-btn][data-danger]{color:#ef4444;}
[data-bs-btn][disabled]{opacity:.5;cursor:default;}
[data-bs-msg]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bs-msg][data-warn]{color:#f59e0b;}
[data-bs-msg][data-good]{color:#22c55e;}
[data-bs-badge]{font-size:11.5px;padding:3px 8px;border-radius:999px;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bs-score]{font-size:12px;font-weight:600;padding:2px 7px;border-radius:6px;flex:none;}
[data-bs-score][data-good]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-bs-score][data-mid]{background:rgba(245,158,11,.16);color:#f59e0b;}
[data-bs-score][data-bad]{background:rgba(239,68,68,.16);color:#ef4444;}
[data-bs-card]{display:flex;flex-direction:column;gap:5px;padding:11px 12px;border-radius:10px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.09));
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.07));}
[data-bs-title]{font-size:13.5px;line-height:19px;font-weight:500;word-break:break-word;}
[data-bs-big]{font-size:20px;font-weight:600;line-height:26px;}
[data-bs-kv]{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-bs-hr]{height:1px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.08));margin:2px 0;}
@media (max-width:420px){ [data-bs-page]{gap:14px;} [data-bs-title]{font-size:13px;} }
`

    const scoreTone = (n) => (n >= 65 ? 'good' : n >= 50 ? 'mid' : 'bad')

    /** 提炼来源 → 手机上一眼能懂的标签（P3）。 */
    const REFINE_LABEL = {
      model: '模型',
      agent: '外部 agent 按 digest 写',
      manual: '人手补写',
      failed: '模型失败·摘句兜底',
      excerpt: '摘句兜底',
      skipped: '额度用完·摘句',
      unavailable: '宿主无模型·摘句',
      off: '提炼关',
    }
    const refineLabel = (v) => REFINE_LABEL[String(v || '')] || String(v || '')

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bs-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-bs-row': '' },
        h('div', { 'data-bs-grow': '' },
          h('div', { 'data-bs-label': '' }, label),
          note ? h('div', { 'data-bs-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    function useJson(path, intervalMs) {
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget(path)
            if (alive && d) setData(d)
          } catch { /* 网络抖动就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 8000)
        return () => { alive = false; clearInterval(t) }
      }, [path, intervalMs])
      return [data, setData]
    }

    const fmtClock = (iso) => {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    /* ────────────── 设置页 ────────────── */

    const DEFAULT_WINDOWS = {
      noon: { label: '中午谷时', start: '12:00', end: '14:00' },
      night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
    }

    function SettingsPage() {
      const [st, setSt] = useJson('/status', 8000)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')
      const [kws, setKws] = React.useState(null)
      const [perDay, setPerDay] = React.useState(null)
      const [minScore, setMinScore] = React.useState(null)
      const [days, setDays] = React.useState(null)
      const [mention, setMention] = React.useState(null)
      const [perRound, setPerRound] = React.useState(null)
      const [cookie, setCookie] = React.useState('')
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')

      const cfg = st?.config
      React.useEffect(() => {
        if (!cfg) return
        if (kws === null) setKws((cfg.keywords || []).join('\n'))
        if (perDay === null) setPerDay(String(cfg.perDay ?? 2))
        if (minScore === null) setMinScore(String(cfg.minScore ?? 55))
        if (days === null) setDays(String(cfg.days ?? 7))
        if (mention === null) setMention(cfg.mentionName || '')
        if (perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
      }, [cfg])

      const say = (text, t) => { setMsg(text); setTone(t || '') }

      const patch = async (p, what) => {
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config) setSt((old) => ({ ...old, config: r.config, ...(r.mention ? { mention: r.mention } : {}) }))
          say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const saveNumbers = async () => {
        const n = Math.max(0, Math.min(Number(perDay) || 0, 10))
        const ms = Math.max(0, Math.min(Number(minScore) || 0, 100))
        const d = Math.max(0, Math.min(Number(days) || 0, 365))
        setPerDay(String(n)); setMinScore(String(ms)); setDays(String(d))
        await patch({ perDay: n, minScore: ms, days: d }, '学习节奏')
      }

      const saveKeywords = async () => {
        const list = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        await patch({ keywords: list }, '关键词')
      }

      const saveLogin = async () => {
        if (!String(cookie || '').trim()) { setLoginTone('warn'); setLoginState('先粘一条 Cookie 进来'); return }
        setBusy('login')
        setLoginTone('')
        setLoginState('正在校验…')
        try {
          const r = await jpost('/credential', { cookie })
          if (r?.ok) {
            setLoginTone('good')
            setLoginState(`登录成功${r.uname ? `：${r.uname}` : ''}`)
            setCookie('')
            setSt((old) => ({ ...old, credential: r.credential }))
          } else {
            setLoginTone('warn')
            setLoginState(r?.error || '校验没通过')
          }
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) } finally { setBusy('') }
      }

      const clearLogin = async () => {
        setBusy('clear')
        try {
          const r = await jpost('/credential/clear', {})
          setLoginTone(''); setLoginState(r?.cleared ? '已清掉本地凭据' : '本来就没存')
          setSt((old) => ({ ...old, credential: r?.credential }))
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) } finally { setBusy('') }
      }

      const runNow = async () => {
        setBusy('run')
        say('')
        try {
          const r = await jpost('/run', {})
          if (r?.ok) say('跑完了：报告已写进 out/ 里', 'good')
          else say(r?.hint || r?.error || '没跑成', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      if (!cfg) return h('div', { 'data-bs-page': '' }, h('div', { 'data-bs-note': '' }, '读设置中…'))

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }
      const sw = (k) => Boolean(cfg[k])
      const cred = st?.credential || {}

      return h('div', { 'data-bs-page': '' },

        /* 顶部状态 */
        h('div', { 'data-bs-row': '' },
          h('span', { 'data-bs-badge': '' }, `今天已学 ${st?.stats?.learnedTodayCount ?? 0} 条`),
          h('span', { 'data-bs-badge': '' }, `待复习 ${st?.stats?.dueCount ?? 0} 条`),
          h('span', { 'data-bs-badge': '' }, cred.loggedIn ? `B站已登录${cred.uname ? `·${cred.uname}` : ''}` : 'B站未登录'),
          h('span', { 'data-bs-badge': '' }, st?.running ? '正在跑…' : (st?.lastRunAt ? `上次 ${fmtClock(st.lastRunAt)}` : '还没跑过')),
          h('span', { 'data-bs-badge': '' }, st?.catchUp?.text || '补跑：—'),
          h('span', { 'data-bs-badge': '' }, st?.refine?.available ? `模型：${st.refine.model || '可用'}` : '模型：不可用'),
          h('div', { 'data-bs-grow': '' }),
          h('button', { 'data-bs-btn': '', 'data-primary': '', disabled: busy === 'run', onClick: runNow }, '现在跑一轮')),
        msg ? h('div', { 'data-bs-msg': '', 'data-good': tone === 'good' ? '' : undefined, 'data-warn': tone === 'warn' ? '' : undefined }, msg) : null,
        st?.mention?.mismatch
          ? h('div', { 'data-bs-msg': '', 'data-warn': '' },
            `⚠️ @ 名（${st.mention.configured}）≠ 登录名（${st.mention.login}），评论会 @ 错人`)
          : null,
        st?.mention?.source === 'credential'
          ? h('div', { 'data-bs-note': '' }, `没填「要 @ 谁」：自动用登录账号「${st.mention.effective}」`)
          : null,
        st?.lastStatus ? h('div', { 'data-bs-note': '' }, `最近一轮：${st.lastStatus}`) : null,

        /* 什么时候自己跑 */
        h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, '什么时候自己跑'),
          h(ToggleRow, {
            label: '谷时自动跑一轮',
            note: '只在 DeepSeek 谷时跑：工作日 12:00–14:00 与 18:00 之后（整个周末也算谷时）；关了就只手动跑',
            on: sw('peakValley'),
            onChange: (v) => patch({ peakValley: v }, '谷时自动跑'),
          }),
          sw('peakValley') ? h('div', { 'data-bs-sub': '' },
            ...['noon', 'night'].map((k) => h(ToggleRow, {
              key: k,
              label: win[k].label,
              note: `${win[k].start} – ${win[k].end}`,
              on: sw(k),
              onChange: (v) => patch({ [k]: v }, win[k].label),
            }))) : null,
          h(ToggleRow, {
            label: `补跑：${sw('catchUp') ? '开' : '关'}`,
            note: '安卓会杀后台、定时可能不触发：今天还没跑，下次打开就补一轮（一天最多一次）',
            on: sw('catchUp'),
            onChange: (v) => patch({ catchUp: v }, '补跑'),
          }),
          h('div', { 'data-bs-note': '' },
            `今天：${st?.catchUp?.text || (sw('catchUp') ? '今天未跑·待补' : '补跑：关')}`
            + (st?.catchUp?.lastError ? `（上次失败：${String(st.catchUp.lastError).slice(0, 60)}）` : ''))),

        /* 每天学多少 */
        h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, '每天学多少'),
          h('div', { 'data-bs-row': '' },
            h('div', { 'data-bs-grow': '' },
              h('div', { 'data-bs-label': '' }, '每天最多挑几条'),
              h('div', { 'data-bs-note': '' }, '填 0 = 不自动挑（还能手动跑）')),
            h('input', {
              'data-bs-input': '', 'data-bs-num': '', type: 'number', min: 0, max: 10, inputMode: 'numeric',
              value: perDay ?? '', onChange: (e) => setPerDay(e.target.value),
            })),
          h('div', { 'data-bs-row': '' },
            h('div', { 'data-bs-grow': '' },
              h('div', { 'data-bs-label': '' }, '最低可靠性分'),
              h('div', { 'data-bs-note': '' }, '低于这个分的不挑（≥80 强烈推荐 / 65 值得看 / <50 引流号）')),
            h('input', {
              'data-bs-input': '', 'data-bs-num': '', type: 'number', min: 0, max: 100, inputMode: 'numeric',
              value: minScore ?? '', onChange: (e) => setMinScore(e.target.value),
            })),
          h('div', { 'data-bs-row': '' },
            h('div', { 'data-bs-grow': '' },
              h('div', { 'data-bs-label': '' }, '只看最近几天发布的'),
              h('div', { 'data-bs-note': '' }, '0 = 不限')),
            h('input', {
              'data-bs-input': '', 'data-bs-num': '', type: 'number', min: 0, max: 365, inputMode: 'numeric',
              value: days ?? '', onChange: (e) => setDays(e.target.value),
            })),
          h('div', { 'data-bs-row': '' },
            h('button', { 'data-bs-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveNumbers }, '保存节奏'))),

        /* 模型提炼（P3） */
        h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, '模型提炼'),
          h(ToggleRow, {
            label: `模型提炼：${sw('refine') ? '开' : '关'}`,
            note: '开了：抓到字幕原文后，用宿主的模型写「要点 / 金句 / 我的判断 / 值不值得再看」；'
              + '关掉 = 只做摘句兜底（和 0.1.0 一样，零模型调用）',
            on: sw('refine'),
            onChange: (v) => patch({ refine: v }, '模型提炼'),
          }),
          sw('refine') ? h('div', { 'data-bs-sub': '' },
            h('div', { 'data-bs-note': '' }, st?.refine?.available
              ? `走宿主模型：${st.refine.provider || '?'} / ${st.refine.model || '?'}（提示词 ${st.refine.promptVersion || '—'}）`
              : `宿主没有可用模型：${st?.refine?.reason || '还没探测'} —— 改用 bili_study_digest 让 agent 写`),
            h('div', { 'data-bs-row': '' },
              h('div', { 'data-bs-grow': '' },
                h('div', { 'data-bs-label': '' }, '单条喂给模型多少字'),
                h('div', { 'data-bs-note': '' }, '字幕太长时只喂前这一段（默认 12000）；手机上别贪多，越短越便宜')),
              h('input', {
                'data-bs-input': '', 'data-bs-num': '', type: 'number', min: 1000, max: 60000, inputMode: 'numeric',
                defaultValue: String(cfg.refineMaxChars ?? 12000),
                onBlur: (e) => {
                  const n = Math.max(1000, Math.min(Number(e.target.value) || 12000, 60000))
                  e.target.value = String(n)
                  patch({ refineMaxChars: n }, '字幕上限')
                },
              })),
            h('div', { 'data-bs-row': '' },
              h('div', { 'data-bs-grow': '' },
                h('div', { 'data-bs-label': '' }, '每轮最多提炼几条'),
                h('div', { 'data-bs-note': '' }, '默认 2；另有「每天最多 perDay 条」的总闸')),
              h('input', {
                'data-bs-input': '', 'data-bs-num': '', type: 'number', min: 0, max: 10, inputMode: 'numeric',
                defaultValue: String(cfg.refinePerRound ?? 2),
                onBlur: (e) => {
                  const n = Math.max(0, Math.min(Number(e.target.value) || 0, 10))
                  e.target.value = String(n)
                  patch({ refinePerRound: n }, '每轮提炼条数')
                },
              })),
            h('div', { 'data-bs-label': '' }, '指定模型（可选）'),
            h('input', {
              'data-bs-input': '', defaultValue: cfg.refineModel || '',
              placeholder: '留空 = 宿主当前默认（如 deepseek-official/deepseek-flash）；也可写 provider/model',
              onBlur: (e) => { const v = String(e.target.value || '').trim(); e.target.value = v; patch({ refineModel: v }, '提炼模型') },
            }),
            h('div', { 'data-bs-note': '' },
              `本轮模型调用 ${st?.refine?.lastRound?.calls ?? 0} 次（失败 ${st?.refine?.lastRound?.failed ?? 0}）`
              + ` · 今天 ${st?.refine?.todayCalls ?? 0} 次 · 昨天 ${st?.refine?.yesterdayCalls ?? 0} 次`))
            : h('div', { 'data-bs-note': '' }, '关着 = 0.1.0 的行为：只摘句、不调模型；想自己写就用 bili_study_digest。')),

        /* 关注什么 */
        h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, '关注什么'),
          h('textarea', {
            'data-bs-input': '', rows: 5, placeholder: '一行一个关键词；留空就用内置那几组（机器学习 / 算法 / DeepSeek …）',
            value: kws ?? '', onChange: (e) => setKws(e.target.value),
          }),
          h('div', { 'data-bs-row': '' },
            h('button', { 'data-bs-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveKeywords }, '保存关键词'))),

        /* 会不会替你说话 */
        h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, '它会不会替你说话'),
          h(ToggleRow, {
            label: '自动评论并 @ 我',
            note: '🔴 默认关。开着就是拿你的 B站 号在视频下发一条评论（每轮最多一条、同一视频只 @ 一次）。'
              + '评论只引用**模型提炼过**的要点/金句；这一轮没提炼成功就整条不发（宁可少发）',
            on: sw('autoComment'),
            onChange: (v) => patch({ autoComment: v }, '自动评论'),
          }),
          sw('autoComment') ? h('div', { 'data-bs-sub': '' },
            h('div', { 'data-bs-row': '' },
              h('div', { 'data-bs-grow': '' },
                h('div', { 'data-bs-label': '' }, '每天最多发几条'),
                h('div', { 'data-bs-note': '' }, '上限 3；发出去的评论删不掉，慎重')),
              h('input', {
                'data-bs-input': '', 'data-bs-num': '', type: 'number', min: 1, max: 3, inputMode: 'numeric',
                value: perRound ?? '',
                onChange: (e) => setPerRound(e.target.value),
                onBlur: () => { const n = Math.max(1, Math.min(Number(perRound) || 1, 3)); setPerRound(String(n)); patch({ commentPerRound: n }, '每天几条评论') },
              })),
            h('div', { 'data-bs-label': '' }, '要 @ 谁（B站 昵称）'),
            h('input', {
              'data-bs-input': '', value: mention ?? '', placeholder: '留空 = 自动用登录账号；都没登录就不发',
              onChange: (e) => setMention(e.target.value),
              onBlur: () => { const v = String(mention || '').trim(); setMention(v); patch({ mentionName: v }, '要 @ 谁') },
            }),
            h('div', { 'data-bs-note': '' },
              `实际会 @：${st?.mention?.effective || '（还没有可用的昵称）'}`
              + (st?.mention?.source === 'credential' ? '（留空，自动用登录账号）' : '')),
            h('div', { 'data-bs-note': '' },
              st?.mention?.mismatch
                ? `⚠️ @ 名 ≠ 登录名（${st.mention.login}），评论会 @ 错人；要改就改上面那一栏`
                : '评论存在的意义就是 @ 你一下；留空会自动用登录账号，两者都没有就不发')) : null),

        /* 登录 */
        h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, 'B站 登录（看字幕要它）'),
          h('div', { 'data-bs-note': '' },
            cred.loggedIn ? `当前：${cred.masked || '已存凭据'}${cred.hasCsrf ? ' · 带 bili_jct（能发评论）' : ' · 没有 bili_jct（不能发评论）'}` : '还没登录。没登录时 B站 一律不返回字幕轨道（不是插件的问题）'),
          h('textarea', {
            'data-bs-input': '', rows: 2, placeholder: '把整条 Cookie 粘这里，形如 SESSDATA=...; bili_jct=...（也可以只粘 SESSDATA 的值）',
            value: cookie, onChange: (e) => setCookie(e.target.value),
          }),
          h('div', { 'data-bs-row': '' },
            h('button', { 'data-bs-btn': '', 'data-primary': '', disabled: busy === 'login', onClick: saveLogin }, '校验并保存'),
            h('button', { 'data-bs-btn': '', 'data-danger': '', disabled: busy === 'clear', onClick: clearLogin }, '清除凭据')),
          loginState ? h('div', { 'data-bs-msg': '', 'data-good': loginTone === 'good' ? '' : undefined, 'data-warn': loginTone === 'warn' ? '' : undefined }, loginState) : null,
          h('div', { 'data-bs-note': '' }, '怎么拿：电脑上登录 bilibili.com → F12 → 应用/存储 → Cookie → 复制 SESSDATA 与 bili_jct 的值。凭证只存在插件家目录的 credential.json（权限收紧），设置页只显示掩码。')),

        /* 它的地盘 */
        h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, '它的地盘'),
          h('div', { 'data-bs-kv': '' },
            `家目录：${st?.home || ''}`,
            h('br'),
            `今天的报告：${st?.report || ''}`,
            h('br'),
            `笔记库：${st?.notesDir || ''}`)),
      )
    }

    /* ────────────── 「今天学了什么」面板 ────────────── */

    function TodayPage() {
      const [d, setD] = useJson('/today', 10000)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')

      const run = async () => {
        setBusy('run')
        setMsg('')
        try {
          const r = await jpost('/run', {})
          if (r?.ok) setMsg('跑完了')
          else setMsg(r?.hint || r?.error || '没跑成')
        } catch (e) { setMsg(String(e?.message ?? e)) } finally { setBusy('') }
      }

      if (!d) return h('div', { 'data-bs-page': '' }, h('div', { 'data-bs-note': '' }, '读中…'))
      const learned = Array.isArray(d.learned) ? d.learned : []
      const due = Array.isArray(d.due) ? d.due : []

      return h('div', { 'data-bs-page': '' },
        h('div', { 'data-bs-row': '' },
          h('div', { 'data-bs-grow': '' },
            h('div', { 'data-bs-big': '' }, `今天学了 ${learned.length} 条`),
            h('div', { 'data-bs-note': '' }, `${d.date || ''} · 待复习 ${d.dueCount ?? 0} 条 · ${d.catchUp?.text || ''} · ${d.status || '还没跑'}`)),
          h('button', { 'data-bs-btn': '', 'data-primary': '', disabled: busy === 'run', onClick: run }, '现在跑一轮')),
        msg ? h('div', { 'data-bs-msg': '' }, msg) : null,

        learned.length ? h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, '今天挑中的'),
          ...learned.slice(0, 6).map((v) => h('div', { 'data-bs-card': '', key: v.bvid },
            h('div', { 'data-bs-row': '' },
              h('span', { 'data-bs-score': '', 'data-good': scoreTone(v.score) === 'good' ? '' : undefined, 'data-mid': scoreTone(v.score) === 'mid' ? '' : undefined, 'data-bad': scoreTone(v.score) === 'bad' ? '' : undefined }, String(v.score ?? '')),
              h('div', { 'data-bs-grow': '' }, h('div', { 'data-bs-title': '' }, v.title || v.bvid))),
            h('div', { 'data-bs-note': '' },
              `${v.verdict || ''}${v.subtitleSource ? ` · ${v.subtitleSource}` : ''}`
              + `${v.refine ? ` · 提炼：${refineLabel(v.refine)}` : ''} · ${v.bvid}`))))
          : h('div', { 'data-bs-msg': '' }, '今天还没有新学的 —— 点右上角跑一轮；没跑成的话，下次打开 App 会自动补跑'),

        due.length ? h('div', { 'data-bs-sec': '' },
          h('div', { 'data-bs-h': '' }, `该复习了（${d.dueCount} 条）`),
          ...due.slice(0, 4).map((v) => h('div', { 'data-bs-card': '', key: v.bvid },
            h('div', { 'data-bs-title': '' }, v.title || v.bvid),
            h('div', { 'data-bs-note': '' }, `应复习 ${v.nextReview}${v.overdueDays ? `（逾期 ${v.overdueDays} 天）` : ''} · 已复习 ${v.reps ?? 0} 次 · ${v.bvid}`))))
          : h('div', { 'data-bs-msg': '' }, '今天没有要复习的'),

        h('div', { 'data-bs-hr': '' }),
        h('div', { 'data-bs-kv': '' },
          `笔记 ${d.totalNotes ?? 0} 条 / 视频 ${d.totalVideos ?? 0} 个`,
          h('br'),
          `报告：${d.report || ''}`),
        d.errors && d.errors.length ? h('div', { 'data-bs-msg': '', 'data-warn': '' }, `这一轮的小故障：${d.errors.slice(0, 2).join(' / ')}`) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-study')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsha-bili-study: 页面样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        // 设置页：左侧导航里那一条
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-study', order: 32, label: '刷B站学习' },
          () => h(SettingsPage),
        ))
        // 「今天学了什么」：紧挨着设置页的一屏摘要（手机竖屏可读）
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-study-today', order: 33, label: '今天学了什么' },
          () => h(TodayPage),
        ))
      },
    }
  },
})
