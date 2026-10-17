/**
 * lib/bili-api.js —— B站 公开接口（纯 JS，零依赖，Node 24 自带 fetch + node:crypto）
 * ============================================================================
 * 这一层是把 `bilibili-study/scripts/` 里**已经跑通**的 Python 链路移植过来的，
 * 口径与坑都照抄，别自己发明：
 *
 *   · 搜索   `/x/web-interface/wbi/search/type?search_type=video`（旧的无签名版作为兜底）
 *   · 详情   `/x/web-interface/view?bvid=`（公开，不需要登录）
 *   · 字幕轨 `/x/player/wbi/v2?bvid=&cid=` —— **未登录时 subtitle.subtitles 恒为空数组**，
 *            这时 `need_login_subtitle=true`；要把这个事实如实往外报，不许硬凑。
 *   · 字幕体 直连 `aisubtitle.hdslb.com`（**不能**在浏览器里 fetch：它不给 CORS 头）
 *   · 评论   `/x/v2/reply`（**旧接口**；`/x/v2/reply/wbi/main` 要 WBI 签名且实测 -403）
 *   · 发评论 `/x/v2/reply/add` 表单 POST，必须带 `csrf=<bili_jct>`（Cookie 里那一项）
 *
 * 反爬纪律（照 Python 版）：
 *   显式浏览器 UA + Referer + Origin；先访问主站预热 Cookie（拿 buvid3）；
 *   失败按 600ms 递增退避重试 3 次；多请求之间 sleep 0.6–1.2s。
 *
 * WBI 签名（bilibili 2023 起的接口防刷）：
 *   1) `/x/web-interface/nav` 拿 `wbi_img.img_url` / `sub_url`，取文件名（去扩展名）= imgKey/subKey
 *   2) 把 imgKey+subKey 按 64 项置换表重排，取前 32 位 = mixinKey
 *   3) 参数加 `wts`（秒），值里 `!'()*` 五个字符去掉，按 key 排序拼接 + mixinKey 求 md5 = `w_rid`
 * ============================================================================
 */
import { createHash } from 'node:crypto'

export const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
export const REFERER = 'https://www.bilibili.com/'

export const EXIT = { OK: 0, ERR: 1, NO_DATA: 4, USAGE: 5 }

/** 人话报错：带上「下一步怎么办」，别只甩 code。 */
export class BiliError extends Error {
  constructor(message, { code, status, kind = 'api', detail } = {}) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.status = status
    this.kind = kind // api | net | auth | risk | no_data | usage
    this.detail = detail
  }
}

const CODE_HINTS = {
  '-101': 'B站 说没登录（-101）：去设置页把 SESSDATA 重新粘一次',
  '-111': 'CSRF 校验失败（-111）：Cookie 里的 bili_jct 过期了，整条 Cookie 重贴一次',
  '-400': '参数有误（-400）：BV 号或 cid 可能写错了',
  '-404': '找不到这个资源（-404）：BV 号不存在或已删除',
  '-412': '被 B站 风控拦了（-412）：等 1–2 分钟再试，别连着刷',
  '-509': '请求太频繁（-509）：歇一会儿再试',
  '-799': '请求被拒（-799）：通常也是风控，换个时间再试',
  62002: '稿件不可见或已删除（62002）',
  12002: '这条视频的评论区关了（12002）',
  12009: 'B站 要求先过验证码才能评论（12009）：这一轮就别发了',
  12015: '这个账号需要先绑定手机才能评论（12015）',
}

export function hintForCode(code, fallback = '') {
  return CODE_HINTS[String(code)] || fallback || `B站 返回 code=${code}`
}

/* ─────────────────────────── WBI 签名 ─────────────────────────── */

/** 64 项置换表（bilibili-API-collect 公开的 mixinKeyEncTab，改了就签不过）。 */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

/** 从 nav 的 wbi_img 里取 imgKey/subKey（`https://i0.hdslb.com/bfs/wbi/<key>.png` → `<key>`）。 */
export function wbiKeysFromImgUrl(imgUrl = '', subUrl = '') {
  const name = (u) => String(u || '').split('/').pop().replace(/\.\w+$/, '')
  return { imgKey: name(imgUrl), subKey: name(subUrl) }
}

/** imgKey + subKey → mixinKey（重排后取前 32 位）。 */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey || ''}${subKey || ''}`
  if (raw.length < 64) throw new BiliError('WBI 密钥不足 64 位，接口返回的 img/sub 有问题（等几分钟重试）', { kind: 'api' })
  let out = ''
  for (const i of MIXIN_KEY_ENC_TAB) out += raw[i]
  return out.slice(0, 32)
}

/** WBI 要求：值里的 `!'()*` 去掉（**键和值都过一遍**，跟官方算法一致）。 */
export function sanitizeWbiValue(v) {
  return String(v ?? '').replace(/[!'()*]/g, '')
}

/**
 * 给参数签名，返回带 `wts` 与 `w_rid` 的查询串。
 * ⚠️ 编码用 `encodeURIComponent`（空格 → %20）；B站 两种都吃，但 `%20` 更稳。
 */
export function encWbi(params, mix, wts) {
  const mixed = { ...params, wts: String(wts ?? Math.floor(Date.now() / 1000)) }
  const keys = Object.keys(mixed).filter((k) => mixed[k] !== undefined && mixed[k] !== null).sort()
  const query = keys
    .map((k) => `${encodeURIComponent(sanitizeWbiValue(k))}=${encodeURIComponent(sanitizeWbiValue(mixed[k]))}`)
    .join('&')
  const wRid = createHash('md5').update(query + mix, 'utf8').digest('hex')
  return `${query}&w_rid=${wRid}`
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 秒 → [MM:SS.cc]（与 Python 版 fmt_ts 完全一致：先四舍五入到百分秒，再整除）。 */
export function fmtTs(seconds) {
  let t = Number(seconds)
  if (!Number.isFinite(t) || t < 0) t = 0
  const totalCs = Math.round(t * 100)
  const mins = Math.floor(totalCs / 6000)
  const rest = totalCs % 6000
  const p = (n) => String(n).padStart(2, '0')
  return `[${p(mins)}:${p(Math.floor(rest / 100))}.${p(rest % 100)}]`
}

/** 'MM:SS' / 'H:MM:SS' → 秒；认不出来返回 -1。 */
export function parseTs(text) {
  const parts = String(text ?? '').trim().replace(/^\[|\]$/g, '').split(':')
  if (!parts.length || parts.length > 3) return -1
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n))) return -1
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
  if (nums.length === 2) return nums[0] * 60 + nums[1]
  return nums[0]
}

/** 从 BV 号或整条链接里抽 BV 号。⚠️ 大小写敏感：只把前缀规范成 BV。 */
export function extractBvid(text) {
  const m = /[Bb][Vv][0-9A-Za-z]{10}/.exec(String(text ?? ''))
  return m ? 'BV' + m[0].slice(2) : ''
}

/** 把字幕 JSON（{body:[{from,to,content}]}）变成统一的片段数组。 */
export function subtitleRowsFromBody(body) {
  const rows = []
  for (const it of Array.isArray(body) ? body : []) {
    const text = String(it?.content ?? '').replace(/\r/g, ' ').replace(/\n/g, ' ').trim()
    if (!text) continue
    const start = Number(it?.from) || 0
    const end = Number(it?.to) || start
    rows.push({ start, end, text })
  }
  return rows
}

/* ─────────────────────────── 客户端 ─────────────────────────── */

export class BiliClient {
  /**
   * @param {{cookie?:string, fetchImpl?:Function, log?:Function, timeoutMs?:number, retries?:number}} opts
   */
  constructor(opts = {}) {
    this.cookie = opts.cookie || ''
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    this.log = opts.log || (() => {})
    this.timeoutMs = Number(opts.timeoutMs) || 20000
    this.retries = Number(opts.retries) || 3
    this.baseDelayMs = Number(opts.baseDelayMs) || 600
    this._jar = {}          // 预热拿到的 buvid3 等（不覆盖用户 Cookie）
    this._wbi = null        // {mix, at}
    this._lastAt = 0
    this._ua = opts.userAgent || UA
    if (!this.fetchImpl) throw new BiliError('这台机器的 Node 没有 fetch（需要 Node 18+ / 手机上是 Node 24）', { kind: 'net' })
  }

  get headers() {
    const cookie = this.cookieHeader
    const h = {
      'User-Agent': this._ua,
      Referer: REFERER,
      Origin: 'https://www.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    if (cookie) h.Cookie = cookie
    return h
  }

  /** 用户 Cookie + 预热得到的 buvid3 之类合并（用户那份优先）。 */
  get cookieHeader() {
    const jar = Object.entries(this._jar)
    if (!jar.length) return this.cookie
    const user = new Set((this.cookie || '').split(';').map((s) => s.split('=')[0].trim()).filter(Boolean))
    const extra = jar.filter(([k]) => !user.has(k)).map(([k, v]) => `${k}=${v}`)
    return [this.cookie, ...extra].filter(Boolean).join('; ')
  }

  /** 两次请求之间至少隔 ms 毫秒（防 412；也顺手给同一个客户端的调用排队）。 */
  async throttle(ms = 600) {
    const wait = this._lastAt + ms - Date.now()
    if (wait > 0) await sleep(wait)
    this._lastAt = Date.now()
  }

  async requestJson(url, { method = 'GET', body = null, headers = {}, retries = null, throttleMs = 600 } = {}) {
    const attempts = retries === null ? this.retries : Math.max(1, retries)
    let lastErr = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.throttle(throttleMs)
        const res = await this.fetchImpl(url, {
          method,
          headers: { ...this.headers, ...headers },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        const text = await res.text()
        if (res.status === 412 || res.status === 429) {
          lastErr = new BiliError(hintForCode(-412), { kind: 'risk', status: res.status })
        } else if (!res.ok) {
          lastErr = new BiliError(`B站 接口返回 HTTP ${res.status}`, { kind: 'net', status: res.status, detail: text.slice(0, 200) })
        } else {
          let data
          try { data = JSON.parse(text) } catch { throw new BiliError('B站 返回的不是 JSON（多半是风控页）', { kind: 'net', detail: text.slice(0, 120) }) }
          if (data && (data.code === -412 || data.code === -509)) {
            lastErr = new BiliError(hintForCode(data.code), { kind: 'risk', code: data.code })
          } else {
            return data
          }
        }
      } catch (e) {
        if (e instanceof BiliError && e.kind === 'risk') lastErr = e
        else if (e instanceof BiliError && e.kind === 'net' && e.status && e.status < 500) throw e
        else lastErr = new BiliError(`连不上 B站（${e?.name === 'TimeoutError' ? '超时' : e?.message ?? e}）：检查网络后重试`, { kind: 'net', detail: String(e?.message ?? e) })
      }
      if (attempt < attempts) {
        const wait = this.baseDelayMs * attempt
        this.log(`[bili] 第 ${attempt} 次失败：${lastErr?.message ?? ''}；${wait}ms 后重试`)
        await sleep(wait)
      }
    }
    throw lastErr || new BiliError('请求失败（原因未知）', { kind: 'net' })
  }

  /** 预热主站：拿 buvid3 等匿名 Cookie，能显著降低搜索接口 412 的概率。 */
  async preheat() {
    if (Object.keys(this._jar).length) return
    try {
      const res = await this.fetchImpl('https://www.bilibili.com/', {
        headers: { 'User-Agent': this._ua, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      for (const c of list) {
        const [pair] = String(c).split(';')
        const i = pair.indexOf('=')
        if (i > 0) {
          const k = pair.slice(0, i).trim()
          const v = pair.slice(i + 1).trim()
          if (['buvid3', 'buvid4', 'b_nut', 'buvid_fp', 'sid'].includes(k)) this._jar[k] = v
        }
      }
      this.log(`[bili] 预热完成，拿到 ${Object.keys(this._jar).join(',') || '0'} 个匿名 Cookie`)
    } catch (e) {
      this.log(`[bili] 预热失败（不影响后续，只是 412 概率高一点）：${e?.message ?? e}`)
    }
  }

  /** nav：登录态 + WBI 密钥。未登录时 code=-101，但 data 里仍有 wbi_img（可以照样签名）。 */
  async nav() {
    const data = await this.requestJson('https://api.bilibili.com/x/web-interface/nav')
    const d = data?.data || {}
    const keys = wbiKeysFromImgUrl(d?.wbi_img?.img_url, d?.wbi_img?.sub_url)
    if (keys.imgKey && keys.subKey) {
      this._wbi = { ...keys, mix: mixinKey(keys.imgKey, keys.subKey), at: Date.now() }
    }
    return {
      code: data?.code,
      isLogin: Boolean(d.isLogin),
      uname: d.uname || '',
      mid: Number(d.mid) || 0,
      keys,
    }
  }

  /** 确保有 mixinKey（缓存 30 分钟；nav 失败时抛人话错误）。 */
  async ensureWbi() {
    if (this._wbi && Date.now() - this._wbi.at < 30 * 60 * 1000) return this._wbi.mix
    const n = await this.nav()
    if (!this._wbi) {
      throw new BiliError('拿不到 WBI 签名密钥（nav 接口没给 wbi_img）：等 1 分钟再试，或检查网络', { code: n.code, kind: 'api' })
    }
    return this._wbi.mix
  }

  /** 带 WBI 签名的 GET。 */
  async signedGet(path, params, opts = {}) {
    const mix = await this.ensureWbi()
    const url = `https://api.bilibili.com${path}?${encWbi(params, mix)}`
    return this.requestJson(url, opts)
  }

  /* ───────────── 搜索 ───────────── */

  /**
   * 关键词搜视频。
   * @param {{keyword:string, order?:string, page?:number, days?:number}} q
   * @returns {Promise<{keyword:string,totalCount:number,items:object[]}>}
   */
  async search(q) {
    const keyword = String(q?.keyword ?? '').trim()
    if (!keyword) throw new BiliError('关键词是空的：至少给一个词再搜', { kind: 'usage' })
    const order = q?.order || 'totalrank'
    const page = Math.max(1, Number(q?.page) || 1)
    await this.preheat()

    let data = null
    try {
      data = await this.signedGet('/x/web-interface/wbi/search/type', {
        search_type: 'video', keyword, order, page,
      })
    } catch (e) {
      this.log(`[bili] 签名版搜索失败（${e?.message ?? e}），退回无签名接口`)
    }
    // ⚠️ 2026-10-17 实测：匿名（没登录）调**签名版**搜索，B站 会回 code=0 但 `data` 只有
    //    `{ v_voucher: '...' }`（风控要验证码），**没有 result**。不判 result 就会"搜到 0 条"。
    //    无签名的旧接口此刻仍然正常返回 20 条 —— 所以这里必须按 result 判，而不是只看 code。
    const signedOk = data && data.code === 0 && Array.isArray(data?.data?.result)
    if (!signedOk) {
      if (data && data.code === 0) this.log('[bili] 签名版搜索被风控（只回了 v_voucher），改用无签名旧接口')
      // 旧接口（无签名）—— 实测目前仍可用，作为兜底
      const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video'
        + `&order=${encodeURIComponent(order)}&page=${page}&keyword=${encodeURIComponent(keyword)}`
      data = await this.requestJson(url)
    }
    if (data?.code !== 0) {
      throw new BiliError(hintForCode(data?.code, `搜索接口返回 code=${data?.code} ${data?.message ?? ''}`), { code: data?.code, kind: 'api' })
    }
    const items = parseSearchItems(data?.data?.result)
    const filtered = q?.days ? items.filter((it) => withinDays(it.pubdate, q.days)) : items
    return { keyword, totalCount: Number(data?.data?.numResults) || 0, items: filtered }
  }

  /* ───────────── 详情 ───────────── */

  /**
   * 稿件详情（公开数据，不需要登录）。
   * @returns {Promise<object>} 扁平化的 meta（字段名跟 notes 里存的一份对齐）
   */
  async videoInfo(bvidRaw) {
    const bvid = extractBvid(bvidRaw)
    if (!bvid) throw new BiliError(`这不像一个 BV 号：「${String(bvidRaw ?? '').slice(0, 40)}」。示例：BV1ahFmzqE9z`, { kind: 'usage' })
    let data
    try {
      data = await this.requestJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
    } catch (e) {
      if (e instanceof BiliError) throw e
      throw new BiliError(`取 ${bvid} 的详情失败：${e?.message ?? e}`, { kind: 'net' })
    }
    if (data?.code !== 0) {
      throw new BiliError(hintForCode(data?.code, `取详情失败 code=${data?.code}`), { code: data?.code, kind: data?.code === 62002 ? 'no_data' : 'api' })
    }
    return normalizeView(data.data, bvid)
  }

  /* ───────────── 字幕 ───────────── */

  /**
   * 取某个分P 的字幕轨道清单。
   * ⚠️ **未登录时 subtitles 恒为 []**，`needLogin` 会是 true —— 这是 B站 的规则，不是 bug。
   */
  async subtitleTracks(bvidRaw, cid) {
    const bvid = extractBvid(bvidRaw)
    if (!bvid || !cid) throw new BiliError('取字幕轨道需要 bvid 和 cid（分P 的 cid 从 bili_study_video 里拿）', { kind: 'usage' })
    let data = null
    try {
      data = await this.signedGet('/x/player/wbi/v2', { bvid, cid })
    } catch (e) {
      this.log(`[bili] 签名版 player 接口失败（${e?.message ?? e}），退回无签名`)
    }
    if (!data || data.code !== 0) {
      data = await this.requestJson(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`)
    }
    if (data?.code !== 0) {
      throw new BiliError(hintForCode(data?.code, `取字幕轨道失败 code=${data?.code}`), { code: data?.code, kind: 'api' })
    }
    const d = data.data || {}
    const tracks = (d?.subtitle?.subtitles || []).map((s) => ({
      lan: s.lan || '',
      label: s.lan_doc || s.lan || '',
      url: s.subtitle_url || s.subtitle_url_v2 || '',
      isAi: /^ai-/.test(String(s.lan || '')),
    }))
    return { needLogin: Boolean(d.need_login_subtitle), loginMid: Number(d.login_mid) || 0, tracks }
  }

  /** 直连下载字幕 JSON 并规范化成片段数组（不在浏览器里 fetch —— 它不给 CORS 头）。 */
  async fetchSubtitle(url) {
    let u = String(url || '')
    if (!u) throw new BiliError('字幕地址是空的（这条视频没有可下载的字幕）', { kind: 'no_data' })
    if (u.startsWith('//')) u = 'https:' + u
    else if (u.startsWith('http://')) u = 'https://' + u.slice('http://'.length)
    const data = await this.requestJson(u, { throttleMs: 300 })
    // 字幕体不带 code 字段，直接是 {body:[...]}
    const rows = subtitleRowsFromBody(data?.body)
    if (!rows.length) throw new BiliError('字幕文件是空的（0 条），这条视频等于没字幕', { kind: 'no_data' })
    return rows
  }

  /**
   * 一条视频的可用字幕：按语言优先级挑第一个存在的轨道。
   * @returns {Promise<{lang:string, rows:object[]}|null>} null = 确实没有
   */
  async pickSubtitle(bvid, cid, langs = ['ai-zh', 'zh-CN', 'zh-Hans', 'ai-en']) {
    const info = await this.subtitleTracks(bvid, cid)
    if (!info.tracks.length) return { lang: '', rows: [], needLogin: info.needLogin }
    const wanted = [...langs]
    const ordered = [
      ...wanted.map((l) => info.tracks.find((t) => t.lan === l)).filter(Boolean),
      ...info.tracks.filter((t) => /^zh|^ai-zh/.test(t.lan)),
      ...info.tracks,
    ]
    const seen = new Set()
    for (const t of ordered) {
      if (!t || seen.has(t.url)) continue
      seen.add(t.url)
      try {
        const rows = await this.fetchSubtitle(t.url)
        return { lang: t.lan, label: t.label, rows, needLogin: info.needLogin }
      } catch (e) {
        this.log(`[bili] 字幕轨道 ${t.lan} 下载失败：${e?.message ?? e}`)
      }
    }
    return { lang: '', rows: [], needLogin: info.needLogin }
  }

  /* ───────────── 评论 ───────────── */

  /** 取热门评论（旧接口 /x/v2/reply；**别**改成 wbi/main，那个要签名且实测 -403）。 */
  async comments({ oid, aid, num = 20, sort = 'hot' }) {
    const id = Number(oid || aid) || 0
    if (!id) throw new BiliError('取评论需要 aid（视频的 av 号，详情接口里有）', { kind: 'usage' })
    const ps = Math.max(1, Math.min(Number(num) || 20, 50))
    const sortCode = sort === 'time' ? 0 : 2
    const data = await this.requestJson(
      `https://api.bilibili.com/x/v2/reply?type=1&oid=${id}&sort=${sortCode}&ps=${ps}&pn=1`,
      { throttleMs: 800 },
    )
    if (data?.code !== 0) {
      if (data?.code === 12002) return []
      throw new BiliError(hintForCode(data?.code, `取评论失败 code=${data?.code}`), { code: data?.code, kind: 'api' })
    }
    return (data?.data?.replies || []).map((r) => ({
      rpid: Number(r.rpid) || 0,
      user: r?.member?.uname || '',
      like: Number(r.like) || 0,
      message: cleanComment(r?.content?.message),
      ctime: Number(r.ctime) || 0,
      replyCount: Number(r.rcount) || 0,
    }))
  }

  /* ───────────── 发评论（会对外发声，必须被上层限流） ───────────── */

  /**
   * 发一条评论（或回复某条评论）。**这是"@ 本人"那一下**。
   * @param {{aid:number, message:string, root?:number, bvid?:string}} p
   */
  async sendComment({ aid, message, root = 0, bvid = '' }) {
    const csrf = this.cookieHeader.split(';').map((s) => s.trim()).find((s) => s.startsWith('bili_jct='))
    if (!csrf) throw new BiliError('发评论需要 Cookie 里的 bili_jct（csrf），现在这条 Cookie 里没有：整条 Cookie 重贴一次', { kind: 'auth' })
    const text = String(message || '').trim()
    if (!text) throw new BiliError('评论内容是空的，不发', { kind: 'usage' })
    if ([...text].length > 500) throw new BiliError('评论超过 500 字了，B站 会拒；压短一点', { kind: 'usage' })
    const form = new URLSearchParams({ oid: String(aid), type: '1', message: text, csrf: csrf.slice('bili_jct='.length), plat: '1' })
    if (root) { form.set('root', String(root)); form.set('parent', String(root)) }
    const res = await this.requestJson('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      body: form,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(bvid ? { Referer: `https://www.bilibili.com/video/${bvid}` } : {}),
      },
      throttleMs: 1500,
      retries: 1, // 发评论**绝不重试**：重试可能发两条出去
    })
    if (res?.code !== 0) {
      throw new BiliError(hintForCode(res?.code, `发评论失败 code=${res?.code} ${res?.message ?? ''}`), { code: res?.code, kind: 'api' })
    }
    return { rpid: Number(res?.data?.rpid) || 0, message: text }
  }
}

/* ─────────────────────────── 纯函数（可单测） ─────────────────────────── */

/** 搜索结果 → 扁平条目（标题去高亮标签、播放/点赞转数字）。 */
export function parseSearchItems(result) {
  const rows = []
  for (const item of Array.isArray(result) ? result : []) {
    if (!item) continue
    const bvid = String(item.bvid || '')
    if (!bvid.startsWith('BV')) continue
    const title = cleanSearchTitle(item.title)
    rows.push({
      bvid,
      title,
      author: String(item.author || ''),
      mid: Number(item.mid) || 0,
      play: Number(item.play) || 0,
      like: Number(item.like) || 0,
      duration: String(item.duration || ''),
      durationSec: durationTextToSec(item.duration),
      pubdate: Number(item.pubdate) || 0,
      pubdateText: Number(item.pubdate) ? new Date(Number(item.pubdate) * 1000).toISOString().slice(0, 10) : '',
      desc: cleanComment(item.description),
      tname: String(item.typename || ''),
      url: `https://www.bilibili.com/video/${bvid}`,
    })
  }
  return rows
}

export function cleanSearchTitle(s) {
  return cleanComment(String(s || '').replace(/<[^>]+>/g, ''))
}

const HTML_ENTS = [['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' ']]
export function cleanComment(s) {
  let out = String(s ?? '')
  for (const [a, b] of HTML_ENTS) out = out.split(a).join(b)
  return out.replace(/\s+/g, ' ').trim()
}

/** '12:34' / '1:02:03' → 秒（搜索结果里的 duration 是文本）。 */
export function durationTextToSec(text) {
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim())
  if (!m) return 0
  if (m[3]) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number(m[1]) * 60 + Number(m[2])
}

/** 详情接口 data → 扁平 meta。 */
export function normalizeView(d, bvid) {
  const dd = d || {}
  const stat = dd.stat || {}
  const pages = (dd.pages || []).map((p) => ({
    page: Number(p.page) || 0,
    cid: Number(p.cid) || 0,
    part: String(p.part || ''),
    durationSec: Number(p.duration) || 0,
  }))
  const totalSec = pages.reduce((a, p) => a + p.durationSec, 0) || Number(dd.duration) || 0
  const pageCount = pages.length || 1
  return {
    bvid: dd.bvid || bvid,
    aid: Number(dd.aid) || 0,
    title: String(dd.title || ''),
    author: String(dd?.owner?.name || ''),
    mid: Number(dd?.owner?.mid) || 0,
    pubdate: Number(dd.pubdate) || 0,
    pubdateText: Number(dd.pubdate) ? new Date(Number(dd.pubdate) * 1000).toISOString().slice(0, 10) : '',
    durationSec: Number(dd.duration) || totalSec,
    totalSec,
    pageCount,
    avgPageSec: pageCount ? Math.round(totalSec / pageCount) : 0,
    desc: String(dd.desc || '').trim(),
    tname: String(dd.tname || ''),
    play: Number(stat.view) || 0,
    like: Number(stat.like) || 0,
    coin: Number(stat.coin) || 0,
    favorite: Number(stat.favorite) || 0,
    danmaku: Number(stat.danmaku) || 0,
    reply: Number(stat.reply) || 0,
    pages,
    url: `https://www.bilibili.com/video/${dd.bvid || bvid}`,
  }
}

/** 发布时间在最近 days 天内（0/未给 = 不过滤）。 */
export function withinDays(pubdateSec, days, now = Date.now()) {
  if (!days || !pubdateSec) return true
  return now / 1000 - Number(pubdateSec) <= Number(days) * 86400
}
