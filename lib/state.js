/**
 * lib/state.js —— 插件的"家"、配置文件、B站凭据、日期/时段小工具
 * ============================================================================
 * 三条纪律（都是踩过坑的）：
 *   ① **配置/凭据/报告/日志都放插件自己的家**：`$DSH_HOME/dsha-bili-study/`，
 *      绝不写进插件包目录（装进 node_modules 后可能只读，升级也会被覆盖）。
 *   ② **SESSDATA 不进 profile 配置**：它只落在 `<家>/credential.json`（权限收紧 0600），
 *      设置页与工具输出只看到掩码。理由：profile 的 cordis.patch.yml 可能被同步/贴群里。
 *   ③ **写 JSON 一律"临时文件 + rename"**：手机端随时可能被杀进程，半截文件会让笔记库当场报废。
 * ============================================================================
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 家目录名（`$DSH_HOME/<这个名字>`）。改它会丢掉已有笔记，别改。 */
export const HOME_NAME = 'dsha-bili-study'

/**
 * 谷时窗口（北京时间 / 设备本地时间）—— 想改就改这一处，设置页会读同一份。
 * 口径沿用「刷B站」插件：**工作日 9–12 / 14–18 是高峰，其余（含整个周末）都是谷时**。
 * ⚠️ 这一轮的活是纯 JS 算的、不花 token，但只要它顺手调模型（写判读/评论）就会花，
 *    所以默认仍然只在谷时跑。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * 解析 `ctx.get('dshHomePath')`。
 * 🔴 宿主给的是**函数**（`dshHomePath(...segments)`），不是字符串 —— 当字符串用会拼出
 *    「函数源码 + \dsha-bili-study」这种路径，mkdir ENOENT，整个插件不激活（老插件踩过）。
 */
export function homeDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p(HOME_NAME)
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, HOME_NAME)
    }
  } catch { /* 拿不到就走下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), HOME_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 原子写：先写 `.tmp` 再 rename（同目录 rename 在 POSIX/Windows 上都是原子的）。 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  try { renameSync(tmp, file) } catch (e) {
    try { unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
    throw e
  }
}

/** 本地日期 YYYY-MM-DD。 */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 'YYYY-MM-DD' 加减天数，返回同格式字符串。 */
export function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number)
  const t = new Date(y, (m || 1) - 1, d || 1)
  t.setDate(t.getDate() + Number(n || 0))
  return dayKey(t)
}

/** 两个日期字符串相差几天（b - a）。 */
export function daysBetween(a, b) {
  const pa = Date.parse(`${a}T00:00:00`), pb = Date.parse(`${b}T00:00:00`)
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return 0
  return Math.round((pb - pa) / 86400000)
}

/** 'HH:MM' → 当天分钟数（解析不出来给 null）。 */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 现在在不在这个窗口里（支持跨零点，比如 18:00–09:00）。 */
export function inWindow(now, win) {
  const start = minutesOf(win?.start), end = minutesOf(win?.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/* ───────────────────────── B站凭据 ───────────────────────── */

export const CREDENTIAL_FILE = 'credential.json'

export function credentialPath(home) {
  return join(home, CREDENTIAL_FILE)
}

/**
 * 把用户粘贴的东西规范成一条 Cookie。
 * 接受三种：① 整条 `SESSDATA=...; bili_jct=...`  ② 只有 SESSDATA 的值
 *          ③ 带 `Cookie:` 前缀 / 换行（从 F12 复制过来常见）
 */
export function normalizeCookie(input) {
  let s = String(input ?? '').trim().replace(/^cookie\s*:\s*/i, '').replace(/[\r\n]+/g, ' ')
  if (!s) return ''
  if (!s.includes('=')) s = `SESSDATA=${s}`
  return parseCookie(s)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** Cookie 字符串 → [name, value] 列表（顺序保留）。 */
export function parseCookie(cookie) {
  const out = []
  for (const part of String(cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k && v) out.push([k, v])
  }
  return out
}

export function cookieValue(cookie, name) {
  const hit = parseCookie(cookie).find(([k]) => k.toLowerCase() === String(name).toLowerCase())
  return hit ? hit[1] : ''
}

/**
 * 掩码：给设置页 / 工具输出看的样子。
 * 只暴露"有没有 SESSDATA / 有没有 bili_jct / 值有多长"，**一个字符都不露**。
 */
export function maskCookie(cookie) {
  const sess = cookieValue(cookie, 'SESSDATA')
  const csrf = cookieValue(cookie, 'bili_jct')
  const parts = []
  if (sess) parts.push(`SESSDATA=${'*'.repeat(Math.min(8, sess.length))}…（${sess.length} 字符）`)
  if (csrf) parts.push(`bili_jct=${'*'.repeat(6)}…`)
  return parts.join('  ') || '（空）'
}

export function loadCredential(home) {
  const cred = readJson(credentialPath(home), null)
  if (!cred || typeof cred.cookie !== 'string' || !cred.cookie) return null
  return cred
}

/** 存凭据：0600（同机同用户可见）。Windows 上 chmod 只影响只读位，best-effort。 */
export function saveCredential(home, { cookie, uname = '', mid = 0 }) {
  const file = credentialPath(home)
  mkdirSync(home, { recursive: true })
  writeJsonAtomic(file, {
    version: 1,
    cookie: normalizeCookie(cookie),
    uname,
    mid,
    savedAt: new Date().toISOString(),
  })
  try { chmodSync(file, 0o600) } catch { /* 有些文件系统不支持，忽略 */ }
  return file
}

export function clearCredential(home) {
  const file = credentialPath(home)
  if (!existsSync(file)) return false
  try { unlinkSync(file); return true } catch { return false }
}

/** 给设置页 / 工具用的摘要 —— 永远不会带出完整 Cookie。 */
export function credentialSummary(home, cred = loadCredential(home)) {
  if (!cred) return { loggedIn: false, masked: '', hasCsrf: false, uname: '', mid: 0, savedAt: '' }
  return {
    loggedIn: true,
    masked: maskCookie(cred.cookie),
    hasCsrf: Boolean(cookieValue(cred.cookie, 'bili_jct')),
    uname: cred.uname || '',
    mid: cred.mid || 0,
    savedAt: cred.savedAt || '',
  }
}
