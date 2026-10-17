/**
 * lib/score.js —— 0-100「可靠性分」：判断一条视频值不值得点开
 * ============================================================================
 * ⚠️ **本文件是打分口径的唯一实现，改规则只改这里。**
 * 口径是从已跑通的 Python 版 `bilibili-study/scripts/bili_score.py` **逐条移植**的，
 * 减分项/加分项与权重一个字都没改 —— 因为那套规则是在真实搜索结果上踩过坑调出来的：
 *
 *   === 减分项（危险信号）===
 *    -35  标题含 "全\d+集" 且集数 > 100        （如"全748集"，资源号凑数）
 *    -12  标题含 "全\d+集" 且集数 50~100
 *    -30  标题含 "\d+天 …(速通|精通|大神|从小白|小白到|入门到)"
 *    -25  标题含 "零基础 …(一周|三天|七天|一个月|速成|速通)"
 *    -20  标题含 "少走\d+%的弯路"
 *    -15  标题含 "存下吧"
 *    -15  标题含 "很难找全 / 很难找齐"
 *    -20  标题含 "允许白嫖 / 白嫖"
 *    -15  标题含 "完整版课程"
 *    -25  标题含 "百度网盘 / 夸克网盘 / 网盘链接"
 *    -15  标题含 "评论区|私信|关注 … 领取|自取"
 *    -10  通用速成话术 "速成 / 速通"（未命中上面更具体的规则时）
 *    -20  播放量 < 1000 却用夸张词
 *    -10  播放量 >= 50 万但点赞率 < 0.5%
 *    -15  分P 数 > 150（灌水合集）
 *    -8   平均每 P < 3 分钟（碎片化凑数）
 *    -10  总时长 > 6 小时且只有 1 个分P
 *
 *   === 加分项（真干货信号）===
 *    +20  简介含代码仓库 / 论文站（github/gitee/gitlab/huggingface/arxiv）
 *    +12  标题含具体技术名词
 *    +8   标题含具体章节（第N章|第N讲|Chapter N）或 arXiv 编号
 *    +12  播放量 >= 5000 且点赞率 >= 2%
 *    +6   播放量 >= 2000 且点赞率 >= 1%
 *    +12  2~60 个分P 且平均每 P >= 10 分钟
 *    +6   有分P 结构且平均每 P >= 5 分钟
 *    +5   简介长度 >= 80 字
 *
 * 移植时两处**故意的**差异（都是为了跟 Python 的字面语义对齐）：
 *   ① Python 的 `\b` 是 Unicode 词边界（汉字算 word char），JS 的 `\b` 只认 ASCII。
 *      照抄会得出不同的分：Python 的 `\bpython\b` 在「python入门」上**不命中**，
 *      而 JS 的会命中。这里的 TECH 正则用 `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` 复刻前者的语义。
 *   ② Python `'%.1f'` 是 round-half-even（12,500 播放 → "1.2万"），JS `toFixed` 是 half-up
 *      （→ "1.3万"）。fmtCount 里手写了 half-even，测试里有对照用例。
 * ============================================================================
 */

/** 技术名词（ASCII 部分要求"整词"，汉字算词边界）。 */
const TECH_RE = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:pytorch|tensorflow|transformer|llama|langchain|rag|docker|kubernetes|k8s|'
  + 'spring|vue|react|mysql|redis|kafka|flutter|rust|golang|python|java|javascript|'
  + 'typescript|cuda|llm|gpt|bert|nlp|opencv|ffmpeg|linux|git|node\\.js)(?![\\p{L}\\p{N}_])'
  + '|c\\+\\+|编译原理|操作系统|计算机网络|数据结构|算法|线性代数|概率论|微积分|离散数学|'
  + '计算机组成|源码|手写|从零实现|底层|原理|论文|实战',
  'iu',
)

const CHAPTER_RE = /第\s*\d+\s*[章节讲课]|[Cc]hapter\s*\d+|arXiv\s*:?\s*\d{4}\.\d{4,5}/
const EXAGGERATE_RE = /必看|神器|封神|天花板|最强|全网最|秒懂|保姆级|硬核|大神|颠覆|绝对|震惊|不看后悔/
const REPO_SITE_RE = /(github\.com|gitee\.com|gitlab\.com|huggingface\.co|arxiv\.org)/

/** 播放量：1.2万 / 3.4亿（half-even，跟 Python 的 '%.1f' 对齐）。 */
export function fmtCount(n) {
  let v
  try { v = Number(n) } catch { return String(n) }
  if (!Number.isFinite(v)) return String(n)
  if (v >= 1e8) return roundedFixed(v / 1e8, 1) + '亿'
  if (v >= 1e4) return roundedFixed(v / 1e4, 1) + '万'
  return String(Math.trunc(v))
}

/**
 * round-half-even 的定点格式化（复刻 Python 的 '%.1f'）。
 *
 * 别改成 toFixed：toFixed 用 half-up，12,500 播放会变成 "1.3万"（Python 是 "1.2万"），
 * 而这段文本直接进「打分依据」，差一位就会被用户看出来。
 * 也别自己写 `x*10` 再取整：浮点乘会把 1.15 变成 11.5，就不"银行家"了。
 * 这里用 Intl 的 roundingMode='halfEven'（对 double 的精确十进制值做舍入，跟 Python 同口径）。
 */
const fmtCache = new Map()
function halfEvenFormatter(digits) {
  if (fmtCache.has(digits)) return fmtCache.get(digits)
  let nf = null
  try {
    nf = new Intl.NumberFormat('en-US', {
      useGrouping: false,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      roundingMode: 'halfEven',
    })
  } catch { nf = null }   // 老 Node 不认 roundingMode → 走下面的手写兜底
  fmtCache.set(digits, nf)
  return nf
}

export function roundedFixed(value, digits) {
  const v = Number(value)
  if (!Number.isFinite(v)) return String(value)
  const nf = halfEvenFormatter(digits)
  if (nf) return nf.format(v)
  // 兜底（只有不支持 roundingMode 的老运行时会走到）
  const scale = 10 ** digits
  const scaled = v * scale
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const n = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : (floor % 2 === 0 ? floor : floor + 1)
  const s = String(Math.abs(n)).padStart(digits + 1, '0')
  const head = s.slice(0, s.length - digits) || '0'
  const tail = digits > 0 ? '.' + s.slice(s.length - digits) : ''
  return (n < 0 ? '-' : '') + head + tail
}

/** 秒 -> M:SS / H:MM:SS。**必须整除**（Python 的 //；PowerShell 的 [int] 是四舍五入，踩过）。 */
export function fmtDuration(sec) {
  const v = Number(sec)
  if (!Number.isFinite(v)) return ''
  const s = Math.trunc(v)
  if (s < 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (x) => String(x).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

export function fmtDate(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return String(ts ?? '')
  const d = new Date(n * 1000)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 搜索结果标题里的 <em class="keyword"> 高亮标签 + HTML 实体。 */
export function cleanHtml(s) {
  if (!s) return ''
  let out = String(s).replace(/<[^>]+>/g, '')
  const ents = [['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' ']]
  for (const [a, b] of ents) out = out.split(a).join(b)
  return out.trim()
}

/**
 * 算 0-100 的可靠性分。
 * @param {{title?:string, desc?:string, play?:number, like?:number, pageCount?:number, avgPageSeconds?:number, durationSeconds?:number}} v
 * @returns {{score:number, verdict:string, reasons:string[]}}
 */
export function scoreVideo(v = {}) {
  const t = v.title || ''
  const d = v.desc || ''
  const play = Number(v.play) || 0
  const like = Number(v.like) || 0
  const pageCount = Number(v.pageCount) || 0
  const avgPageSeconds = Number(v.avgPageSeconds) || 0
  const durationSeconds = Number(v.durationSeconds) || 0

  let score = 50
  const reasons = []
  const hit = (s) => reasons.push(s)

  // ---------- 减分项 ----------
  const mAll = /全\s*(\d{1,5})\s*集/.exec(t)
  if (mAll) {
    const ep = Number(mAll[1])
    if (ep > 100) {
      score -= 35
      hit(`-35 标题「全${ep}集」,上百集的合集基本是资源号凑数`)
    } else if (ep >= 50) {
      score -= 12
      hit(`-12 标题「全${ep}集」大合集,注意内容是否灌水`)
    }
  }

  let speedHit = false
  const mSpeed = /(\d{1,3}|[一二三四五六七八九十两])\s*天[^,。!！?？]{0,8}?(速成|速通|精通|大神|从小白|小白到|入门到|变大神)/.exec(t)
  if (mSpeed) {
    speedHit = true
    score -= 30
    hit(`-30 标题承诺「${mSpeed[0]}」,典型速成话术`)
  }
  if (/零基础[^,。!！]{0,10}?(一周|三天|七天|一个月|速成|速通|速学)/.exec(t)) {
    score -= 25
    hit('-25 标题「零基础+短期速成」组合话术')
  }
  if (/少走\s*\d+\s*%?\s*的?弯路/.exec(t)) {
    score -= 20
    hit('-20 标题「少走N%的弯路」营销话术')
  }
  if (t.includes('存下吧')) {
    score -= 15
    hit('-15 标题「存下吧」收藏党话术')
  }
  if (/很难找全|很难找齐/.exec(t)) {
    score -= 15
    hit('-15 标题「很难找全」稀缺性话术')
  }
  if (/允许白嫖|白嫖/.exec(t)) {
    score -= 20
    hit('-20 标题「允许白嫖」引流话术')
  }
  if (/完整版课程|完整课程/.exec(t)) {
    score -= 15
    hit('-15 标题「完整版课程」,多为搬运/打包资源')
  }
  if (/百度网盘|夸克网盘|网盘链接|网盘分享/.exec(t)) {
    score -= 25
    hit('-25 标题出现网盘,疑似卖资源/引流')
  }
  if (/(评论区|私信|关注)[^,。!！]{0,6}(领取|自取|拿走|拿)/.exec(t)) {
    score -= 15
    hit('-15 标题引导到评论区/私信领取,引流特征')
  }
  if (!speedHit && /速成|速通/.exec(t)) {
    score -= 10
    hit('-10 标题含速成/速通话术')
  }

  if (play < 1000 && EXAGGERATE_RE.test(t)) {
    score -= 20
    hit(`-20 播放量仅 ${fmtCount(play)} 却堆夸张词,数据与话术不匹配`)
  }

  // ---------- 加分项 ----------
  const mRepo = REPO_SITE_RE.exec(d)
  if (mRepo) {
    score += 20
    hit(`+20 简介含代码仓库/论文站(${mRepo[1]})`)
  }

  const mTech = TECH_RE.exec(t)
  if (mTech) {
    score += 12
    hit(`+12 标题含具体技术名词「${mTech[0]}」,不是纯情绪标题`)
  }
  const mChap = CHAPTER_RE.exec(t)
  if (mChap) {
    score += 8
    hit(`+8 标题带具体章节/论文编号「${mChap[0]}」`)
  }

  if (like > 0 && play > 0) {
    const ratio = like / play
    if (play >= 5000 && ratio >= 0.02) {
      score += 12
      hit(`+12 播放 ${fmtCount(play)}、点赞率 ${roundedFixed(ratio * 100, 1)}%,互动健康`)
    } else if (play >= 2000 && ratio >= 0.01) {
      score += 6
      hit(`+6 播放 ${fmtCount(play)}、点赞率 ${roundedFixed(ratio * 100, 1)}%,互动正常`)
    } else if (play >= 500000 && ratio < 0.005) {
      score -= 10
      hit(`-10 播放 ${fmtCount(play)} 但点赞率只有 ${roundedFixed(ratio * 100, 2)}%,疑似标题党/买量`)
    }
  }

  if (durationSeconds >= 21600 && pageCount === 1) {
    score -= 10
    hit(`-10 总时长 ${roundedFixed(durationSeconds / 3600, 1)} 小时却只有 1 个分P,多为直播录像/资源拼接`)
  }

  if (pageCount > 0) {
    const avgMin = avgPageSeconds > 0 ? avgPageSeconds / 60 : 0
    if (pageCount >= 2 && pageCount <= 60 && avgMin >= 10) {
      score += 12
      hit(`+12 ${pageCount} 个分P、平均 ${roundedFixed(avgMin, 1)} 分钟/集,像成体系的真课程`)
    } else if (avgMin >= 5) {
      score += 6
      hit(`+6 ${pageCount} 个分P、平均 ${roundedFixed(avgMin, 1)} 分钟/集,结构正常`)
    }
    if (pageCount > 150) {
      score -= 15
      hit(`-15 分P 多达 ${pageCount},超过 150 集多为灌水合集`)
    }
    if (avgMin > 0 && avgMin < 3) {
      score -= 8
      hit(`-8 平均每集仅 ${roundedFixed(avgMin, 1)} 分钟,碎片化凑数`)
    }
  }

  if ([...d].length >= 80) {
    score += 5
    hit(`+5 简介 ${[...d].length} 字,UP 主认真写了简介`)
  }

  score = Math.max(0, Math.min(100, Math.trunc(score)))
  let verdict
  if (score >= 80) verdict = '强烈推荐'
  else if (score >= 65) verdict = '值得一看'
  else if (score >= 50) verdict = '一般,谨慎'
  else verdict = '不建议看(引流嫌疑)'
  return { score, verdict, reasons }
}

/** 分级口径（README / 工具输出共用一句话）。 */
export const VERDICT_LEGEND = '>=80 强烈推荐 / 65-79 值得一看 / 50-64 一般 / <50 引流嫌疑'
