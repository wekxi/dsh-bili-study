# DELIVERY —— dsha-bili-study 0.2.0（刷B站学习）

交付目录：`C:\Users\32066\Documents\deepseek-harness\default-workspace\dsha-bili-study`

> 0.1.0 = P1 基础版；0.2.0 = P2 补跑 + P3 模型提炼（见 §七、§八）。本文件保留历史验证记录，
> 最新版本以 §八 为准。

> 一句话：**手机端（DSHA）优先**的 B站 学习插件 —— 每天挑值得看的、读字幕原文、落六节笔记、
> 按 1/3/7/16/35 天排复习，并在设置页旁边给一屏「今天学了什么」。
> 纯 JS、零原生依赖、不依赖 Python；桌面 DSH 也能跑。

---

## 一、能力状态（六项全做，逐项标真实状态）

| # | 能力 | 状态 | 证据 |
|---|---|---|---|
| 1 | 搜索 + 0-100 可靠性分（识别引流号） | **已实现 / 已验证** | 联网：搜「线性代数」19 条带分与打分依据（见 §3.3）；离线：10 个 Python golden 用例逐字一致（§3.2） |
| 2 | 抓字幕原文再判断；无 ai-zh 轨道时如实记录 + 简介/评论兜底 | **已实现 / 逻辑已验证；联网取字幕"未验证"** | 无登录时 `needLogin=true, tracks=[]`（B站 规则），插件如实报并走兜底（§3.3）；解析+渲染用**真实字幕样本**验过（§3.4）。**真登录后的字幕下载未验证**（本机没有用户的 B站 登录态） |
| 3 | 六节笔记 + 跨视频检索索引 | **已实现 / 已验证** | 真实字幕样本渲染出完整六节（§3.4）；检索用 bigram+BM25，单测覆盖跨视频命中与高亮（§3.2） |
| 4 | **定时 + 补跑兜底（Android 后台被杀也能补上）** | **已实现 / 已验证（逻辑 + 真实宿主）**；安卓真机 Doze 下的实际触发未验证 | 谷时窗口逻辑单测；补跑规则 60 个单测（§七）；**真实宿主里 boot 补跑真跑了一轮**（`study.log`: `catch-up: 今天尚无 round，触发补跑（trigger=boot）` → 候选 60 / 挑中 2 / 出报告），重启后不再重复补（§七.4）。**发评论要用户自己的 Cookie，未验证** |
| 5 | 复习提醒（next_review + 遗忘曲线） | **已实现 / 已验证** | 阶梯 1→3→7→16→35→(base×ease) 单测断言到具体日期；`due` 逾期天数覆盖（§3.2） |
| 6 | 手机端「今天学了什么」一屏摘要 | **已实现 / host+client 契约已验证；手机真机渲染未验证** | 真实 DSH 宿主把 client bundle 发到了前端（`plugins/??dsh-bili-study/client.js` 返回 200 / 23324 字节，§3.6）；竖屏单列样式写在 CSS 里。**没有在手机浏览器里截图验收** |
| — | 装到 DSHA（`com.dsh.client`） | **未验证** | 我没有安卓设备。桌面 DSH 上走通了完整链路（§3.6）；手机步骤见 §4 |

打分口径、笔记结构、复习曲线都**从已跑通的 Python 版（`bilibili-study/scripts/`）移植**，不是重新发明。

---

## 二、包与结构

```
dsha-bili-study/
  package.json          name=dsh-bili-study  version=0.1.0  main=index.js
                        dsh.bundle.patch=./cordis.patch.yml
                        dsh.client={platform:web, inject:[runtime,ui-settings,ui-settings-plugins]}
                        dependencies 为空（只用 node: 内置 + 宿主 @deepseek-ai/*）
  cordis.patch.yml      insert: id=bili-study, name=dsh-bili-study, config 默认值
  index.js              host：10 个工具 + 配置归一化 + 谷时定时器 + 补跑接线 + /api/bili-study/*
  client.js             client：settings.section × 2（设置页 / 今天学了什么），含「补跑」开关与状态
  lib/bili-api.js       WBI 签名 / 搜索 / 详情 / 字幕轨 / 字幕体 / 评论 / 发评论
  lib/score.js          0-100 可靠性分（唯一实现，口径 = Python 版）
  lib/notes.js          JSON 笔记库 + 六节渲染 + bigram/BM25 检索 + 复习阶梯
  lib/duty.js           每日一轮：搜→判分→挑→抓字幕/兜底→写笔记→出报告→(可选)评论
  lib/catchup.js        补跑（P2）：今天跑过没 / 一天一次 / 失败不记已跑 / 窗口外也补
  lib/state.js          家目录 / 配置 / 凭据（掩码）/ 日期与时窗
  prompts/duty.md       给模型的每日任务书（铺到家目录，可改）
  README.md  AGENTS.md  LICENSE
  selfcheck.mjs         预检（包契约/patch/依赖纯度/补跑接线/两个半端真跑）
  tests/*.mjs           107 个单测（node --test；含补跑 60 个 + client 真渲染 4 个）
  tests/fixtures/       打分 golden（Python 产物）+ **真实 B站 字幕样本**
```

工具面（10 个，统一 `bili_study_` 前缀，全中文 description，失败给人话报错）：
`bili_study_search` / `_video` / `_subtitle` / `_note`(new/add/list/show) / `_find` / `_review`(due/grade) /
`_daily` / `_login` / `_status` / `_config`。

---

## 三、验证记录（命令 + 真实输出）

> 本机情况：**没有独立 `node.exe`、没有 npm**（只有 DSH Desktop 的 Electron 和它自带的 pnpm）。
> 下面的 `node` 实际是 `ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe"`，它是 **Node v24.18.1**，与 DSHA 的 Node 24 同大版本。
> `_dev/node.cmd` 只是这个包装，**不在交付物里**（收尾已删）。

### 3.1 `node selfcheck.mjs` —— 全绿

```
── 包契约 ─────────────────────────────────────────
✓ name = dsh-bili-study          ✓ version = 0.1.0
✓ main 存在：index.js            ✓ dsh.bundle.patch 存在：./cordis.patch.yml
✓ dsh.client.platform = web      ✓ dsh.client.inject = 3 个
✓ 必需文件齐全（client/patch/prompts/README/AGENTS/lib×5）
── patch 与代码 ───────────────────────────────────
✓ patch 里的 entry id = bili-study
✓ patch 里的 name = dsh-bili-study（与 package.json 一致）
✓ patch 里的 config 字段 13 个   ✓ patch 的 config 字段全部被代码认识
✓ 模块导出的 name = bili-study
── 依赖纯度 ──────────────────────────────────────
✓ dependencies 为空（零运行时依赖）
✓ 模块引用干净（9 个文件，只有相对路径 / node: 内置 / @deepseek-ai/*）
── host 半端（假 ctx 上跑 apply）────────────────────
✓ 10 个工具都注册上了            ✓ 工具名统一 bili_study_ 前缀
✓ 每个工具都有中文 description   ✓ 每个工具的 parameters 都是 object-rooted JSON Schema
✓ 每个工具都声明了 output.render ✓ HTTP 路由挂上了：/api/bili-study (prefix)
✓ 家目录结构建好了（out/ notes/ subs/）
── client 半端（假 window 上跑 factory）──────────────
✓ client id = dsh-bili-study     ✓ factory 是函数
✓ 注册了 2 个 settings.section   ✓ 栏目名：刷B站学习 / 今天学了什么
✓ 每个 section 都带组件          ✓ 样式已挂到 document.head
── 结论 ─────────────────────────────────────────
✓ 全绿：包契约 / patch / 依赖纯度 / host 半端 / client 半端 都过了
```

### 3.2 单测 —— `node --test tests/`：43 passed / 0 failed

> P2 之后是 **107 passed / 0 failed**（新增补跑 60 条 + client 真渲染 4 条），见 §七.3。

```
✔ golden：10 个真实口径用例，score/verdict/reasons 与 Python 原版逐字一致
✔ fmtCount：half-even（Python %.1f 口径），12,500 播放必须是 1.2万
✔ fmtDuration：整除不四舍五入（654 秒是 10:54，不是 11:54）
✔ mixinKey：公开的已知向量（7cd0849…+4932caf… → ea1db124af3c7062474693fa704f4ff8）
✔ encWbi：键排序 + wts + 32 位 md5，且 wts 相同则签名稳定
✔ cjkTokens：中文切 bigram、英文按词
✔ bigram 检索：跨视频命中 + 高亮片段 + 整串命中加分
✔ 复习阶梯：1 → 3 → 7 → 16 → 35 天，之后按 ease 推进（断言到 2026-10-18/20/24/11-02/11-21/2027-01-13）
✔ 复习：hard/easy/again 各自的影响        ✔ due：只出到期的，逾期天数算对
✔ 判重 + 原子写：重新打开库，笔记还在
✔ runRound：挑 2 条 → 一条读原文、一条兜底 → 笔记+报告都落盘
✔ runRound：没字幕时 comments 也用上，但结论仍标"没读原文"
✔ runRound：自动评论默认不发；开了之后每轮最多一条、同视频不重复
✔ runRound：搜索全挂也不会崩（把错误写进报告，不抛）
（共 43 条，全部通过；离线、不联网）
```

> 本机沙箱不允许 `node --test` 起子进程（`spawn EPERM`），所以这里用
> `node --test --experimental-test-isolation=none 'tests/*.test.mjs'`（同一套测试，单进程跑）。
> 在普通机器上 `node --test tests/` 即可，无需额外参数。

### 3.3 联网冒烟（不需要登录的公开接口；2026-10-17 实跑）

```
=== 1) 搜索「线性代数」===
[bili] 预热完成，拿到 buvid3,b_nut 个匿名 Cookie
[bili] 签名版搜索被风控（只回了 v_voucher），改用无签名旧接口
命中总数 1000 返回 19
[68] 值得一看 | BV1d7wAzsE8V | 《线性代数》教学视频 3.0版｜宋浩老师 | 播放 6043010 | 2026-03-11
     打分依据: +12 标题含具体技术名词「线性代数」,不是纯情绪标题 ; +6 播放 604.3万、点赞率 1.2%,互动正常
[74] 值得一看 | BV1Et421E7jk | 线性代数基础与解法全集| 长期更新 | 从零开始 … | 播放 8649925
     打分依据: +12 … ; +12 播放 865.0万、点赞率 2.8%,互动健康
[42] 不建议看(引流嫌疑) | BV143Jr61E5A | 【完整版】自考04184-线性代数（经管类）… | 播放 192
     打分依据: -20 播放量仅 192 却堆夸张词,数据与话术不匹配 ; +12 标题含具体技术名词「线性代数」…

=== 2) 详情 ===  {bvid:'BV1d7wAzsE8V', pages:39, totalSec:106602, play:6043010, like:70776}
=== 3) 字幕轨（未登录）===  { needLogin: true, tracks: [] }      ← B站 规则：没登录就不给字幕
=== 4) 评论 ===  3 条真实热评（Millyo_ 1483 赞 / 我见日而不见长安 1071 赞 / BritneyGalaxy 617 赞）

=== 5) 完整跑一轮（真实接口）===
counts: {candidates:20, picked:2, withSubtitle:0, fallback:2, failed:0, due:0, commented:0}
报告：`out/2026-10-17.md`
  > 候选 20 条 · 挑中 2 条 · 2 条走简介+评论兜底。
  ## 1. 【中文配音·中英字幕】伯克利EECS127｜第3讲 线性代数基本定理与谱定理（可靠性 81/100 强烈推荐）
  - 素材：**没有可用 ai-zh 字幕轨** → 只用简介 + 评论兜底（没有假装读过原文）
  ## 2. 【麻省理工】线性代数 全34讲 高清修复版（可靠性 85/100 强烈推荐）
```

**结论**：搜索 / 详情 / 评论 / 整轮编排 + 落盘 都在真接口上跑通了；
**字幕下载这一步被登录挡住了**（未验证，见 §5）。

### 3.4 真实字幕样本 → 提取 → 六节笔记（离线可复现）

样本：`tests/fixtures/BV1ahFmzqE9z.subtitle.json` —— 真实 B站 ai-zh 字幕 130 条
（公开视频 BV1ahFmzqE9z，取自 `bilibili-study` 的 study_fetch 产物，只用于单测）。

```
=== 字幕样本：130 条 | 合成句子：35 句 | 要点 5 | 时间轴 5 | 金句 1 | 知识点 scale/网站/目录/文件夹/skills/agent ===
=== 打分：88 强烈推荐 ===
+20 简介含代码仓库/论文站(github.com) ; +12 播放 18.0万、点赞率 5.0%,互动健康 ; +6 15 个分P、平均 8.0 分钟/集,结构正常

# 【2026版Agent Skills保姆级教程】2小时从会用到会造
| BV号 | [BV1ahFmzqE9z](https://www.bilibili.com/video/BV1ahFmzqE9z) |
| 元信息 | UP主 谭森 · 发布 2026-10-01 · 时长 2:00:00 · 可靠性分 88/100 强烈推荐 |
| 知识点 | scale · 网站 · 目录 · 文件夹 · skills · agent |
| 下次复习 | 2026-10-18（已复习 0 次） |
| 素材 | 字幕 ai-zh（130 条 / 2 个分P） |
## 要点
- [0:00] 大家好我是谭森老师博学谷呢联合黑马程序员啊又给大家带来新的课程了最近呢这个agent skills啊
- [0:19] 就是你把scale放到哪的问题啊…                      （共 5 条，按时间排）
## 时间轴锚点
- [0:08] 可以说是火的不得了那这个scale呢你就可以把它理解为呀在各个行业…   （共 5 条，与要点不重复）
## 金句
- [3:09] > 我们还会完成这样的一个案例这个案例呢其实是我个人的一个痛点啊…
## 我的判断
- 读了字幕原文：35 句，内容密度约 14 字/分钟。
  可靠性分 88/100（强烈推荐）—— 分数只看元数据，不代表内容对；判断依据见笔记底部。
  反复出现的概念：scale、网站、目录、文件夹。
## 值不值得再看
- 值得：分数很高，先看它。 字幕密度 14 字/分钟，是"讲透"的那一类。
```

### 3.5 包清单（`npm pack --dry-run` 的等价物）

本机没有 npm，用 DSH 自带的 pnpm（v11.8.0）跑同一件事：

```
$ pnpm pack --dry-run
package: dsh-bili-study@0.1.0
Tarball Contents
AGENTS.md          client.js          cordis.patch.yml   index.js
lib/bili-api.js    lib/duty.js        lib/notes.js       lib/score.js
lib/state.js       LICENSE            package.json       prompts/duty.md   README.md
Tarball Details
dsh-bili-study-0.1.0.tgz
```

核对：**patch 与入口都在**、`lib/` 与 `prompts/` 都在、**没有** `node_modules`、**没有**越界路径、
`dependencies` 为空（原生模块为零）。`selfcheck.mjs` 另外静态扫过一遍模块引用（只允许相对路径 / `node:` / `@deepseek-ai/*` / client 的 `react`）。

### 3.6 桌面 DSH 安装冒烟（**只动隔离的 DSH_HOME，没碰你的 `profiles\desktop`**）

> ⚠️ 关键：`dsh` 这个 shim 默认 profile 是 `desktop`（`DSH_DESKTOP_DEFAULT_PROFILE=desktop`）。
> 直接跑 `dsh plugin …` 会去锁 `C:\Users\32066\.dsh\profiles\desktop\package.json.lock` —— 我在无沙箱权限下被 EPERM 挡住（什么都没写），
> **之后所有命令都显式带 `--profile work`，并且把 `DSH_HOME` 指到工作区内的沙箱目录**，
> 因此真实的 `~/.dsh`（含 `profiles\desktop`、`profiles\work`）**一个字节都没动**。

```
$env:DSH_HOME=<workspace>/_dev/dshhome          # 隔离沙箱
$ node <dsh>/lib/bin.js plugin --profile work add link:<插件目录>
  dependencies:
  + dsh-bili-study link:C:/Users/.../dsha-bili-study     Done in 421ms using pnpm v11.8.0

$ node <dsh>/lib/bin.js --profile work --dump-config | grep -A6 dsh-bili-study
# == dsh-bili-study
- id: bili-study
  name: dsh-bili-study
  config: { enabled: true, perDay: 2, minScore: 55, days: 7, subtitleLang: ai-zh, … }
  ⇒ bundle patch 被正确叠加、entry 真的插进配置树

$ node <dsh>/lib/bin.js --profile work --port 43994 --host 127.0.0.1 --no-open
  dsh web: http://127.0.0.1:43994/?token=…

$ curl http://127.0.0.1:43994/api/bili-study/status
{"ok":true,"home":"…\\_dev\\dshhome\\dsha-bili-study","today":"2026-10-17",
 "config":{"enabled":true,"perDay":2,"minScore":55,…},"credential":{"loggedIn":false},…}
  ⇒ 插件在**真实宿主里激活成功**（工具注册在路由之前，路由能应答 = 10 个工具都注册上了）
  study.log: 已挂载（家=…，每天 2 条，峰谷=开，自动评论=关；依赖：defineTool=ok schemastery=ok settings=缺失）

$ 带 token 取首页 → __DSH_BOOT__ 里：
{"id":"dsh-bili-study","url":"plugins/??dsh-bili-study/client.js&rev=8938b99186e9",
 "inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-settings",…]}
$ curl "…/plugins/??dsh-bili-study/client.js&rev=8938b99186e9"
bundle HTTP 200, 23324 bytes   ← 就是我们写的 client.js（window.__ModuleLoader__.load({id:'dsh-bili-study'…})）
  ⇒ 浏览器半端被宿主接受并真的发给前端（两页 settings.section 由它注册）

$ node <dsh>/lib/bin.js plugin --profile work remove dsh-bili-study
  - dsh-bili-study link:…   Done in 353ms
$ node <dsh>/lib/bin.js --profile work --dump-config | grep bili-study
  (空)                                    ← 卸干净了
```

注：`settings=缺失` 指的是 0.2.x 的 `ctx.settings.register()` **这个方法已经不存在**（新版插件设置走
`export const Config` + `configEditor`）；我们两条路都留着，自带的设置页不依赖它。

---

## 四、在手机上怎么装与验收（DSHA / `com.dsh.client`）

**这三步我没法替你做（没有安卓设备），所以标"未验证"。** 按顺序走：

1. **装包**（三选一）
   - **插件市场**：DSHA 里粘仓库地址 `https://github.com/<你的账号>/dsha-bili-study` → 装
   - **本地导入 zip**：把 `dsha-bili-study/` 压成 zip → DSHA「导入本地包」
   - **命令行**：DSHA 终端里 `dsha-plugin install <插件目录或包名>`
2. **重启一次 DSH**（bundle 层只在启动时组装；不重启则设置里看不到这两页）。
3. 进 **设置 → 刷B站学习**，按这个顺序填：
   1) **关注关键词**：一行一个（先填 1–3 个，比如 `线性代数`、`计算机网络 公开课`），点「保存关键词」
   2) **每天最多挑几条** 填 `1`（手机网络下一天一条刚好），最低分 `55`，点「保存节奏」
   3) **谷时自动跑** 保持开（默认只开「中午谷时 12:00–14:00」），也可以只手动跑
   4) **B站 登录**：粘 `SESSDATA=...; bili_jct=...` → 「校验并保存」（**要看到"登录成功：<昵称>"才算成**）。
      不填也能搜、能打分，但**拿不到字幕**（B站 规则：未登录不返回字幕轨）
   5) 点右上「现在跑一轮」，等 10–60 秒
4. 进 **设置 → 今天学了什么**：应该看到「今天学了 N 条」和条目卡片；点「现在跑一轮」可以再跑一轮。
5. 「验收通过」的判据：
   - 设置页顶部三个徽章有数（今天已学 / 待复习 / B站已登录）
   - 跑完一轮后 `今天学了什么` 出现条目，且每条带分数徽章
   - 至少一条的备注是「读了字幕（ai-zh）」——**如果全是"没有可用 ai-zh 字幕轨"，先回第 3 步查登录**
   - 点开某条能看到六节笔记（笔记文件在插件家目录 `notes/<BV号>.md`，家目录路径显示在设置页底部）
6. **（可选）自动评论**：默认关。要开就必须同时填「要 @ 谁」，且**这是拿你的号对外发内容**（每轮最多一条、同视频不重复）。

排障：设置页底部有「家目录 / 今天的报告 / 笔记库」三个真实路径；日志是同目录的 `study.log`。
挂载失败时先看 `study.log` 里 `已挂载（… 依赖：defineTool=… schemastery=…）` 那一行。

---

## 五、未验证清单（说清楚卡在哪）

| 项 | 状态 | 卡在哪 / 怎么补 |
|---|---|---|
| **DSHA 真机安装与运行** | 未验证 | 没有安卓设备。已验证的是同一份代码在桌面 DSH 0.2.0-rc.2 宿主里完整激活（§3.6）。手机上按 §4 走一遍即可 |
| **真登录后抓 B站 字幕** | 未验证 | 本机没有用户 B站 登录态；未登录时 B站 对任何视频都返回空字幕轨（实测 `need_login_subtitle=true`）。字幕的解析/合成/渲染已用真实字幕样本验过（§3.4）。补法：设置页填 SESSDATA 后跑 `bili_study_subtitle` |
| **发评论（自动 @）** | 未验证 | 需要带 `bili_jct` 的登录 Cookie，且会**对外发内容**，不该拿用户账号试。代码层有：默认关、每轮上限、同视频不重复、失败不重试、错误如实报（单测覆盖限流逻辑） |
| **手机浏览器里的实际渲染** | 未验证 | 只验证到"client.js 被宿主接收并下发"（§3.6 / §七.4）。手机上的字号/换行没截图确认 |
| **`node --test tests/`（默认多进程模式）** | 未验证 | 本机沙箱禁止 spawn 子进程（`EPERM`），用 `--test-isolation=none` 跑同一套（P2 后 107 条）。普通机器无需这个开关 |
| **安卓真机 Doze/后台被杀下的补跑触发** | 未验证 | 没有安卓设备。"补跑逻辑"有 60 条单测；"真实宿主里的 boot 补跑 + 重启不重复补"已在隔离的桌面宿主跑通（§七.4）。真机上系统到底多久杀一次、Doze 会不会连启动都拖住，得你自己观察 `study.log` 里 `catch-up:` 那几行 |

---

## 六、红线遵守记录

- **没碰** `C:\Users\32066\.dsh\profiles\desktop\`：第一次误跑 `dsh plugin --help` 默认指向 desktop，
  被沙箱 EPERM 挡下（没写成功）；之后全部用 `--profile work` + 隔离 `DSH_HOME`，真 `~/.dsh` 未改。
- **没碰** `bilibili-study/notes/` 与 `bili_subs/`（真实学习数据）：字幕样本取自 `fetched/` 里的
  **公开视频**抓取产物，另有 `.agents/skills` 只读。
- **没碰** `D:\我的备份\`。
- 自动评论**默认关**，且 README 明写"会对外发内容"。
- 所有"已验证"都附了命令与真实输出；做不到的（手机、登录后字幕、发评论）一律标**未验证**并写清补法。

---

## 七、P2 增补（补跑 / 手机安装包 / 桌面预览）

### 七.1 改了什么、为什么

**起因（真机约束）**：这插件最终要装进安卓的 DSHA。**系统会杀后台、Doze 还会掐定时器**，
所以「谷时到点自动跑」在手机上很可能**永远不触发** —— 用户看到的是"装了一周，一条笔记都没有"。
P1 的定时器只在宿主进程活着时才有意义，而安卓上宿主进程恰恰最不可靠。

| 文件 | 改了什么 |
|---|---|
| `lib/catchup.js` **（新增）** | 补跑的**全部规则**（纯逻辑、IO 全注入）：`autoRunMode` / `todayRan` / `planCatchUp` / `recordCatchUp` / `catchUpStatus` / `runCatchUpOnce`，外加常量 `CATCHUP_LIMITS`、`CATCHUP_LOG_LINE` |
| `index.js` | ① 配置加 `catchUp`（默认开）；② 三个触发点接线：**宿主启动 5 秒后**、**定时器每一跳**、**设置页/面板轮询 `/status`/`/today` 时**；③ `/status` 与 `/today` 都多一个 `catchUp` 字段（`enabled/todayRan/state/text/attempts/lastAt/lastError`）；④ 挂载日志多打一项 `补跑=开/关` |
| `client.js` | 设置页「什么时候自己跑」多一行 **`补跑：开/关`** 开关 + 一行状态（`今天：今天已跑` / `今天未跑·待补` / `今天未跑·补跑放弃…` / `今天未跑·只手动跑（不补）`）；顶部徽章也加一条；「今天学了什么」面板显示同一状态，空态文案改成"下次打开 App 会自动补跑" |
| `cordis.patch.yml` | 默认配置加 `catchUp: true`（14 个字段了） |
| `selfcheck.mjs` | 必需文件加 `lib/catchup.js`；新增"补跑接线"检查（导出齐不齐、日志文案逐字、**凌晨窗口外仍判定该补跑**、`/status` 里带 `catchUp` 且跟着 config 走）；预检时传 `catchUp:false` + 把启动补跑推到 10 分钟后，**保证预检不联网** |
| `tests/catchup.test.mjs` **（新增 60 条）** | 补跑规则逐条：未跑→补、已跑→不补、enabled/手动模式/关开关→不补、**窗口外也补**、一天最多一次、失败**不记已跑**、失败 3 次后放弃、busy 不算一次尝试、异常不冒泡…… |
| `tests/client-render.test.mjs` **（新增 4 条）** | 假 React 把两页**真渲染**一遍（P1 的 selfcheck 只验了"组件是函数"，JSX 体一次都没执行过） |
| `README.md` / `AGENTS.md` | 安卓家目录真实路径 + 怎么在设置页看到 + 导出笔记/报告的三种办法；「Android 会杀后台：定时 + 补跑」一节（含**为什么不等下一个窗口**）；「本地预览（桌面）」一节（可照抄的命令 + 怎么关）；踩坑补 6 条 |
| `_dev/pack.ps1`（脚手架，**不进包**） | 打 zip：先跑 selfcheck（不绿不打）；只打必需文件；打完**在同一进程里**重开 zip 做结构 + 内容校验；打印路径/大小/条目数 |

**补跑口径（写死在代码里，不靠自觉）**：

| 约束 | 实现 |
|---|---|
| 一天最多补一次（幂等，防重复扣额度） | 判据是 `state.json` 的 `day`/`runs` + `out/<今天>.md` **两处**（`todayRan()`）；成功后当天不再补 |
| 补跑失败**不**记成"已跑" | 失败时只写 `catchUp.attempts/lastAt/lastError`，**绝不碰 `day`/`runs`**（单测断言"合并后 `todayRan()` 仍为 false"） |
| 防崩溃循环 | 一天最多试 3 次，两次失败至少隔 10 分钟；`busy`（别人正在跑）不算一次尝试 |
| 尊重配置 | `enabled=false` 不补；**手动模式**（`peakValley=false` / 两个窗口都关 / `perDay=0`）不补；设置页「补跑」关掉不补 |
| 日志留证据 | `study.log` 一行：`catch-up: 今天尚无 round，触发补跑（trigger=boot/tick/settings/panel）` |
| 界面可见可控 | 设置页开关 + 状态行 + 顶部徽章；`/status`、`/today` 都有 `catchUp.text` |

**「不在窗口里要不要补」的选择：立刻补，不等下一个窗口。**
理由：等窗口 = 把"定时可能不触发"这个 bug 原样保留 —— 手机上的下一个窗口照样可能被 Doze 掐掉，
而"用户打开 App"的那一刻是**唯一确定活着的时刻**。补跑这一轮是纯 JS（不调模型、不花 token），
"谷时"约束针对的是模型调用，所以错过谷时代价很小；真正防滥用的是上限（一天一次 / 失败最多 3 次）。
这段理由同时写进了 `README.md` 与 `lib/catchup.js` 的头注释。

### 七.2 `selfcheck.mjs` —— 全绿（含新增的 3 条补跑检查）

```
✓ patch 里的 config 字段 14 个
✓ patch 的 config 字段全部被代码认识
✓ 模块引用干净（11 个文件，只有相对路径 / node: 内置 / @deepseek-ai/*）
── host 半端（假 ctx 上跑 apply）
✓ 10 个工具都注册上了
✓ HTTP 路由挂上了：/api/bili-study (prefix)
✓ lib/catchup.js 导出齐全（计划/执行/记录/文案）
✓ 补跑日志文案与需求逐字一致
✓ 今天没跑过 + 凌晨窗口外 → 仍判定该补跑（安卓兜底口径）
✓ /api/bili-study/status 应答 200（工具注册在路由之前，这条通了说明整条链都活了）
✓ 状态里带补跑：补跑：关
✓ 补跑开关跟着 config 走（本次预检传的是关闭）
── client 半端（假 window 上跑 factory）
✓ 注册了 2 个 settings.section   ✓ 栏目名：刷B站学习 / 今天学了什么
── 结论
✓ 全绿：包契约 / patch / 依赖纯度 / host 半端 / client 半端 都过了
```

### 七.3 单测 —— 107 passed / 0 failed（P1 的 43 + 新增 64）

```
$ node --test-isolation=none --test tests/*.test.mjs
ℹ tests 107   ℹ pass 107   ℹ fail 0
```

新增的 64 条：

- `tests/catchup.test.mjs` **60 条**：`CATCHUP_LOG_LINE` 逐字、`autoRunMode` 6 种、`todayRan` 5 种、
  `planCatchUp` 17 种（含"凌晨窗口外也补"、"周末也补"、"冷却期"、"试满 3 次放弃"、"昨天次数不算今天"、
  "脏数据 `lastOk=true` 但有没 runs 仍补"）、`recordCatchUp` 6 条（**失败只写 catchUp 一个键**、截断 300 字、跨天归零）、
  `catchUpStatus` 7 条、`runCatchUpOnce` 14 条（**成功后同一天再调不重复跑**、**失败 runs 不动**、冷却、
  3 次放弃、busy 不记、异常兜住、已跑不调 startRound、trigger 进日志……）。
- `tests/client-render.test.mjs` **4 条**：设置页真渲染出「补跑：开」+「今天未跑·待补」；
  关掉时显示「补跑：关」；「今天学了什么」页显示补跑状态与「今天已跑」。

> 本机沙箱不允许 `node --test` 起子进程（`spawn EPERM`），所以用 `--test-isolation=none` 单进程跑同一套；
> 普通机器直接 `node --test tests/` 即可。

### 七.4 桌面预览实测（**只动隔离的 `%TEMP%` 家目录，没碰你的 `~/.dsh`**）

命令序列（README「本地预览（桌面）」有可照抄版）：

```powershell
$env:DSH_HOME = Join-Path $env:TEMP 'dsha-bili-preview'          # 隔离家目录
cmd /c "`"$node`" `"$dshBin`" --profile preview --from-default-profile web --dump-config"
cmd /c "`"$node`" `"$dshBin`" plugin --profile preview add link:$plugin"
cmd /c "`"$node`" `"$dshBin`" --profile preview --host 127.0.0.1 --port 4399 --no-open"
#   → dsh web: http://127.0.0.1:4399/?token=…
```

⚠️ 两个坑（都记进 AGENTS.md 了）：**`dsh` 这个 shim 会忽略 `DSH_HOME`**（默认回 `desktop` profile，
第一次试探就这样在真实 `~/.dsh` 上被 EPERM 挡住、什么都没写）⇒ 必须直接调 `bin.js`；
本机 Electron 当 node 用时是 GUI 子系统程序，**PowerShell 直接调不等待也拿不到 stdout** ⇒ 经 `.cmd`/cmd.exe 起。

实测输出（2026-10-17，全部真实）：

```
$ curl "http://127.0.0.1:4399/api/bili-study/status"          # 刚起来时
{... "config":{"enabled":true,"perDay":2,"peakValley":true,"noon":true,"night":false,"catchUp":true},
 "running":true,"ranToday":0,
 "catchUp":{"enabled":true,"todayRan":false,"state":"pending","text":"今天未跑·待补","attempts":0} ...}
   ⇒ 插件在真实宿主里激活；**boot 补跑已经开始跑**（running:true）

# 约 30 秒后再看
{"running":false,"ranToday":1,
 "catchUp":{"enabled":true,"todayRan":true,"state":"done","text":"今天已跑",
            "attempts":0,"lastAt":"2026-10-17T11:44:09.848Z","lastError":""}}
   ⇒ 一轮跑完，状态变「今天已跑」

$ study.log
2026-10-17T11:43:39Z  已挂载（家=…\dsha-bili-preview\dsha-bili-study，每天 2 条，峰谷=开，补跑=开，自动评论=关；依赖：defineTool=ok schemastery=ok settings=缺失）
2026-10-17T11:43:44Z  catch-up: 今天尚无 round，触发补跑（trigger=boot）      ← 需求要的那一行
2026-10-17T11:44:14Z  一轮结束（catch-up）：候选 60 条 · 挑中 2 条 · 2 条走简介+评论兜底

$ state.json
{ "day":"2026-10-17", "runs":1, "lastWhy":"catch-up",
  "catchUp":{ "day":"2026-10-17","attempts":0,"lastOk":true,"lastError":"" } }
$ out/2026-10-17.md  ← 报告真的落盘（挑中 2 条，都是"没有可用 ai-zh 字幕轨 → 简介+评论兜底"，没假装读过原文）
$ notes/BV1cVpy6QEj9.md  notes/BV1orJi6UEkW.md  ← 两篇六节笔记

# 浏览器半端：真被宿主发出去
$ curl -c jar -L "http://127.0.0.1:4399/?token=…" -o index.html          → HTTP 200 / 35083 bytes
index.html 里：{"id":"dsh-bili-study","url":"plugins/??dsh-bili-study/client.js&rev=792e61769ed3", …}
$ curl -b jar "…/plugins/??dsh-bili-study/client.js&rev=792e61769ed3" -o client.js
client.js HTTP 200 / 24048 bytes
   ⇒ 就是本仓库的 client.js（P1 是 23324 字节，P2 多了补跑的开关与状态行）
bundle 里数到：补跑：×3、今天未跑·待补×1、下次打开×2
   ⇒ 设置页/面板两页由它注册，两页都能拿到补跑状态

# 幂等：设置页轮询 3 次 + **重启一次宿主**
poll 0/1/2 => catchUp=今天已跑, ranToday=1, running=False
重启后 study.log 只有一行「已挂载」；`catch-up: 今天尚无 round` 仍然是 2 行（一次是中途被杀那轮、一次是成功那轮）
   ⇒ 重启不会重复补（这正是安卓上最怕的重复扣额度）

# 收尾：进程已关（端口 4399 无监听，HTTP 000），没有后台常驻
```

> 第一次起服务时进程被我那条命令结束后连带收掉了，重启用 managed background job 跑完；
> 两次都在 `study.log` 里留下了 `trigger=boot`，正好证明"**跑到一半被杀 = 不算已跑，下次还会补**"。

### 七.5 手机安装包

`_dev/pack.ps1` 先跑 `selfcheck.mjs`（不绿不打），再按 `package.json` 的 `files` 打：

```
=== ZIP ===
absolute path : C:\Users\32066\Documents\deepseek-harness\default-workspace\dsha-bili-study-0.1.0.zip
size          : 84133 bytes (82.2 KB)
entries       : 14
entry list    : AGENTS.md  client.js  cordis.patch.yml  index.js
                lib/bili-api.js  lib/catchup.js  lib/duty.js  lib/notes.js
                lib/score.js  lib/state.js  LICENSE  package.json
                prompts/duty.md  README.md
```

打完之后**在同一进程里重开 zip 校验**（写入位置在 workspace 之外，DSH 的 Windows 沙箱会拒绝之后
从沙箱内再读它，所以校验必须当场做）：

```
zip structure OK (root has package.json + cordis.patch.yml; no tests/_dev/out/DELIVERY)
zip content OK   (package.json parses, patch keeps catchUp, catchup log line + UI shipped)
```

- 根目录确实有 `package.json` 与 `cordis.patch.yml`（DSHA 按根目录识别包）；
- **没有** `tests/`、`DELIVERY.md`、`node_modules/`、`_dev/`、`out/`、`selfcheck.mjs`；
- 条目路径没有绝对路径/`..`/反斜杠越界；
- zip 里的 `package.json` 能解析、`dsh.bundle.patch` 仍在、`cordis.patch.yml` 保留 `catchUp: true`、
  `lib/catchup.js` 里有那行日志文案、`client.js` 里有「补跑」UI。

### 七.6 P2 的红线

- **没碰** `C:\Users\32066\.dsh\profiles\desktop\`：全程 `DSH_HOME=<TEMP>\dsha-bili-preview` + `--profile preview`。
  第一次试探时 `dsh` shim 想去真实 `~/.dsh\profiles\web` 建目录，被沙箱 EPERM 挡下（没写成功），
  之后一律直调 `bin.js`；已确认 `C:\Users\32066\profiles`、`C:\Users\32066\dsha-bili-study` 都不存在。
- **没碰** `C:\Users\32066\.agents\skills\bilibili-study\` 的真实数据 与 `D:\我的备份\`。
- 预览进程**已关掉**（端口 4399 无监听），隔离家目录留在 `%TEMP%`（不删也不影响任何东西，README 写了怎么清）。
- 补跑**不改**自动评论默认值（仍然默认关）；补跑本身只跑"纯 JS 那一轮"，不发任何对外内容。

---

## 八、P3 增补：模型提炼（0.2.0）

### 八.1 改了什么、为什么

0.1.0 的「要点」是把字幕原句按启发式排序后**原样摘句**，ASR 噪声（`scale`/`SCLE`/`cloud code`、
`deep fw0V`、`GBT6.1`）直接进笔记，「我的判断」是模板话。0.2.0 把"读懂"补上，两条路：

- **2a 插件内直调宿主模型**（`refine` 默认开）：一条视频抓到字幕后调一次 `ctx.get('llm').stream()`，
  模型路由来自宿主（`agentDefaultModel` 或 `refineModel`），**插件不存 API key**。
  产出写进「要点 / 金句 / 我的判断 / 值不值得再看」四节，附 `source:model` 标签与视频记录里的
  `refine:{source:'model',provider,model,…}`；时间轴锚点仍保留启发式那份（来自真实字幕时间）。
- **2b 提示词驱动**（`bili_study_digest`）：返回字幕全文（分段）+ 元信息 + 写笔记指令，
  外部 agent 自己生成四节后用 `bili_study_note add ... source=agent` 写回（面板标「外部 agent 按 digest 提炼」）。
  `prompts/duty.md` 补了「每日收尾跑 digest」；**升级时**如果家目录里的 `duty.md` 还是旧版（没有
  `bili_study_digest` 字样），只在文件末尾**追加**这段、不覆盖用户自己的修改。
- 配置：`refine` / `refineMaxChars`（12000）/ `refineModel`（空=宿主默认）/ `refinePerRound`（2）；
  每天总量以 `perDay` 为上限，计数写 `state.json` 的 `refine.byDay`。
- 失败降级：模型调用失败、返回不是 JSON/分节、四节全空 ⇒ **保留摘句兜底**、标 `refine: failed`，
  不写坏笔记；`refine=false` 时**零模型调用**，行为与 0.1.0 一致（回归测试守）。
- ASR 边界写死在提示词（`REFINE_PROMPT_VERSION=bili-study-refine-v1`）：允许纠正明显听错的词，
  不确定写「可能是…」，**不许补字幕里没有的事实**；金句必须能在原文里找到（bigram Dice ≥0.45），
  找不到直接丢；`ts` 超出视频时长清空；四节 ≤600 字。
- 推理模型坑（真机撞到并修掉）：`deepseek-flash` 默认高思考档，`maxTokens=1600` 时**正文为空**
  （只有 reasoning）。现在能拿到模型能力就传 `reasoningEffort:'low'`、输出上限 6000，
  并在"只有思考没有正文"时报明确错误而不是当空内容。

新增文件：`lib/refine.js`（提示词/解析/校验/digest 指令）、`lib/model.js`（宿主探测/流式收文本）。
改动：`index.js`（新工具、配置、探测、计数）、`lib/duty.js`（一轮里的提炼接线）、`lib/notes.js`
（笔记/记录渲染提炼来源）、`client.js`（模型提炼设置项/成本/来源标签）、`prompts/duty.md`、
`selfcheck.mjs`、`_dev/pack.ps1`、README/AGENTS。

### 八.2 单测 —— 138 passed / 0 failed

```text
node --test --test-isolation=none tests/*.test.mjs
ℹ tests 138
ℹ pass 138
ℹ fail 0
```

- 原 107 条**一条没破**（P1 43 + P2 64）。
- 新增 27 条提炼（提示词 ASR 边界、JSON/分节解析、解析失败降级、金句编造丢弃、时间轴越界、
  `refine=false` 零调用、`refinePerRound` 限流、`dailyRemaining=0`、失败回退、无字幕不提炼、
  宿主探测、reasoningEffort、流式收文本）+ 4 条 client 真渲染（开/关/无模型/面板来源）。
- `node --test tests/` 在本机沙箱会因 `spawn EPERM` 起不了子进程，故用单进程模式；目录要写 glob。

### 八.3 `selfcheck.mjs` —— 全绿（新增 P3 检查）

```text
✓ 11 个工具都注册上了（含 P3 的 bili_study_digest）
✓ lib/refine.js 导出齐全（提示词/解析/校验/降级/digest）
✓ 提炼提示词写死了 ASR 纠正边界 + 不许编造 + 严格 JSON + 600 字上限
✓ 模型返回解析（严格 JSON）
✓ 解析失败能识别（会降级回摘句，不写坏笔记）
✓ bili_study_digest 工具的参数声明齐全
✓ prompts/duty.md 带「每日收尾跑 digest 写回」的指令
✓ 旧版 duty.md 升级：保留用户内容 + 追加 digest 收尾段
✓ 状态里能看见宿主模型：deepseek-official/deepseek-flash
✓ 状态里带模型调用计数（本轮/今天/昨天）
✓ 状态里带模型提炼（默认开，deepseek-official/deepseek-flash）
✓ 提炼提示词版本：bili-study-refine-v1
✓ client.js 带 P3 设置项（开关 / 字幕上限 / 每轮上限 / 指定模型 / 提炼来源 / digest 提示）
✓ 全绿：包契约 / patch / 依赖纯度 / host 半端 / client 半端 都过了
```

### 八.4 模型路：**真的调通了**（不是 mock）

隔离 `DSH_HOME=%TEMP%\dsha-bili-p3` + `--profile preview --from-default-profile web` + 本插件，
把真实 `~/.dsh/.credentials.yaml` 复制进隔离家目录（内容未打印），起在 **127.0.0.1:4421**（没碰 4399 预览）。

`GET /api/bili-study/status`：

```json
{"refine":{"enabled":true,"available":true,"provider":"deepseek-official",
 "model":"deepseek-flash","reasoningEffort":"low","promptVersion":"bili-study-refine-v1"}}
```

用真实 AI 字幕样本 `BV1ahFmzqE9z`（130 行 / 2714 字，提示词 3597 字）跑一次 `runRefine`：

```text
ok=true  status=model  ms=11508  format=json  warnings=0
```

**提炼前（0.1.0 摘句兜底，ASR 噪声原样入笔记）**：

```text
## 要点
[0:00] 大家好我是谭森老师博学谷呢联合黑马程序员啊又给大家带来新的课程了最近呢这个agent skills啊
[0:45] 同样把你的scale呢扔到这个文件夹下就可以了那换成其他的cursor哎那就是这样的一个目录
## 我的判断
读了字幕原文：35 句，内容密度约 167.4 字/分钟。
可靠性分 72/100（值得一看）—— 分数只看元数据，不代表内容对；判断依据见笔记底部。
## 值不值得再看
值得看一看，按复习阶梯排上了。 字幕密度 167.4 字/分钟，是"讲透"的那一类。
```

**提炼后（0.2.0，模型四节）**：

```text
## 要点
[0:10] Agent Skills 可理解为各行业专家把工作经验和做事流程打包成的提示词，直接拿来用。
[0:49] 字幕称各行业已累积 13 万多个 skills 并持续增加，可在网站按分类查看。
[2:40] 字幕称 25 年 12 月 18 日官方将 Agent Skills 发布为跨平台、跨产品可复用标准。
[0:16] 跨智能体一通百通，关键是 skills 放哪：OpenCode 项目下 .opencode/skills，Claude Code 项目下 .claude/skills。
## 金句
[0:13] 这个 skills 呢你就可以把它理解为呀，在各个行业各个领域里的这些专家大佬们，把他们的工作经验、做事流程打包成了一份提示词。
## 我的判断
适合想快速了解 Agent Skills 概念、数量生态和跨智能体放置目录的人。字幕只覆盖开头概念、目录说明和课程目标，
造 skills 与周报案例未展开，实操质量字幕不足以判断。若想学"会造 skills"，需看正片验证。
## 值不值得再看
一遍就够，字幕里的关键信息仅概念、数量和目录放置，重复看收益低。
```

> 这条验证是"真实字幕 + 真实宿主 + 真实凭证"；**B站 登录态下的真实视频抓取未验证**
> （本机没有用户的 B站 Cookie，隔离家目录里也没放）。提炼本身不依赖 B站 登录。
> 临时调试端点验证完已从 `index.js` 删除，打包内容里没有它。

### 八.5 宿主里的 client / API 验证

- `dsh-bili-study/client.js` 出现在宿主的 preload URL 里，合并 bundle `HTTP 200 / 418,553 bytes`；
  单独文件 `client.js` 28,056 bytes。
- `GET /api/bili-study/today` 200，带 `config.refine=true`、`refine.available=true`、`learned` 列表。
- `GET /api/bili-study/status` 200，带 `refine`、`catchUp`、`stats`。
- 收尾：预览进程已关，4421 无监听；隔离家目录与临时 curl/jar 文件已清掉。

### 八.6 手机安装包（0.2.0）

```text
=== ZIP ===
absolute path : C:\Users\32066\Documents\deepseek-harness\default-workspace\dsh-bili-study-0.2.0.zip
size          : 109236 bytes (106.7 KB)
entries       : 16
entry list    : AGENTS.md  client.js  cordis.patch.yml  index.js
                lib/bili-api.js  lib/catchup.js  lib/duty.js  lib/model.js
                lib/notes.js  lib/refine.js  lib/score.js  lib/state.js
                LICENSE  package.json  prompts/duty.md  README.md

zip structure OK (root has package.json + cordis.patch.yml; no tests/_dev/out/DELIVERY)
zip content OK   (package.json parses, patch keeps catchUp+refine, digest tool + refine UI shipped)
```

- 版本 0.2.0；根目录有 `package.json` + `cordis.patch.yml`；**没有** `tests/`、`DELIVERY.md`、
  `_dev/`、`out/`、`selfcheck.mjs`；条目路径没有越界。
- 打完后在同一进程里重开 zip 校验（workspace 外的文件之后可能读不到）。

### 八.7 P3 的红线

- **没碰** `C:\Users\32066\.dsh\profiles\desktop\`：只在 `%TEMP%\dsha-bili-p3` 里建 `preview` profile；
  真实家目录的 `.credentials.yaml` **只复制**进隔离家目录，未打印、未修改。
- **没碰** `C:\Users\32066\.agents\skills\bilibili-study\` 与 `D:\我的备份\`。
- **没碰** 用户已起的 4399 预览实例（本机验证用 4421，已关）。
- 自动评论仍然**默认关**；`refine` 的加入没有改它。
- 插件**不存 API key**；日志不打印 Cookie / SESSDATA / API key；模型输出写进笔记前过"金句原文校验"。
- `refine=false` 与 0.1.0 行为一致（单测守：零模型调用、摘句笔记、报告写「提炼：关着」）。


## 九、0.2.1 补丁：评论闸门 + @ 名兜底（事故修复）

### 九.1 事故（真机已发生）

手机 DSHA 上 `autoComment=true` 跑了一轮，插件从**用户账号**发出一条评论，正文是一段**原始 ASR 噪声**：

```text
@乌子鱼不在家 code这块，讲得最实的一句是「今天是26年10月17日dB sk呢发布了一个新的fla」，要点我记进笔记了（BV1n9Jv6QE3A）。
```

- 视频：`BV1n9Jv6QE3A`；rpid：`317365880721`；**确实已经发出去了**（删不掉）。
- 当轮 `counts.refined=0 / refineCalls=0`，`refine.lastRound.reason =
  "本轮提炼额度用完"`：当天前面几轮已经把 `refinePerRound` 的额度用完。
- 根因：评论文案在 refine 被跳过时**退回摘句兜底**，`composeComment` 直接拿
  `material.points[0].text`（ASR 原句）拼进「」里 @ 出去。
- 另一处：`mentionName` 配的是旧号「乌子鱼不在家」，而实际登录账号是「小小鲸鱼娘」，
  评论 @ 错了人。

### 九.2 修复点

1. **评论绝不许引用未提炼的 ASR 原文**（`lib/duty.js`）
   - `composeComment()` 现在要求 `refine === 'model'`；否则返回 **null**，不再拼 excerpt。
   - `maybeComment()` 只挑 `p.refine === 'model'` 的条目；当轮 `refined=0` 时记
     `comment: { posted:false, skipped:true, reason:'skipped (no refined content)', why:… }`，
     `counts.commented` **不增**，**一个网络请求都不发**。
   - 评论只读带 `source:model` 标签的「要点 / 金句」；金句必须能在字幕原文里回溯
     （复用 `lib/refine.js` 的 `quoteInTranscript`），回溯不了就退回要点。
   - 新增 `looksLikeAsrNoise()`：中文紧贴小写拉丁碎片（`dB sk呢`、`新的fla`）一律不进评论；
     一个可用的都不剩就整条不发。**宁可少发，不许发噪声。**
   - 不再用 `topics` 拼评论（启发式 bigram 本身就是从 ASR 原文里捞的）。
   - 报告「这一轮的评论」一节写 `**跳过发评论**：skipped (no refined content)：…`；
     状态行（`roundStatusText`）带「评论跳过（no refined content）」。
2. **`mentionName` 自动兜底**（`lib/duty.js` 的 `resolveMention()` + `index.js`）
   - 留空 ⇒ 自动用 `credential.uname`（保存 Cookie 时 `nav` 拿到的登录昵称）。
   - 手填值**原样保留**；与登录名不一致时 `status.mention = {mismatch:true, warn:'@ 名（…）≠ 登录名（…），评论会 @ 错人'}`，
     设置页顶部与「会不会替你说话」一栏都有醒目提示。
3. **版本 0.2.1**：`package.json` 升版，重打 `dsh-bili-study-0.2.1.zip`（16 个条目，规则同 0.1.0/0.2.0：
   不含 `tests/`、`DELIVERY.md`、`_dev/`、`out/`、`selfcheck.mjs`）。

### 九.3 单测 —— 144 passed / 0 failed（原 138 条全在）

```text
node --test --test-isolation=none tests/*.test.mjs
ℹ tests 144
ℹ pass 144
ℹ fail 0
```

新增 6 条（全部离线、纯函数/夹具级，**没有发任何真实评论**）+ 2 条既有评论测试按新规则原地更新。
关键用例输出：

```text
✔ composeComment：@ 昵称 + 不超长 + 不泄露私人信息（只认模型提炼的内容）  ← 既有测试，按新规则加 refine
✔ 0.2.1 评论闸门：refine 缺失时 composeComment 返回 null（绝不拼摘句）
✔ 0.2.1 评论闸门：ASR 噪声片段即便被标成 model 也剔除，剔不干净就整条不发
✔ 0.2.1 mentionName 兜底：空值用 credential.uname；不一致只提示、不改用户填的值
✔ 0.2.1：refine 被跳过（refined=0）→ counts.commented 不增，记 skipped (no refined content)
✔ 0.2.1 事故回归：事故字幕 + refine=0 时评论文案为 null，报告/评论里没有 ASR 原文
✔ 0.2.1：mentionName 空值 → 自动 @ 登录账号；填了但和登录名不一致 → posted 里带醒目提示
```

事故回归用例用的是新增夹具 `tests/fixtures/BV1n9Jv6QE3A.accident.json`（按事故评论原文重建的
字幕片段，**不是真实字幕文件**）。断言：

- `refine` 被跳过时 `r.comment.skipped === true`、`reason === 'skipped (no refined content)'`、
  `client.posted.length === 0`、`r.counts.commented === 0`；
- `r.comment` 与报告「这一轮的评论」一节都**不含** `dB sk` / `新的fla`；
- 摘句素材里**确实**能找到事故原句（证明用例真的覆盖到噪声），但 `composeComment(..., refine:'excerpt')`
  返回 `null`；就算误标成 `model`、只要引用的还是那段噪声，也返回 `null`。

同一夹具的纯函数探针输出（真实输出，不是描述）：

```text
噪声句（摘句素材里确实有）: 今天是26年10月17日dB sk呢发布了一个新的fla。
excerpt → 文案: null
model+噪声 → 文案: null
model+干净要点 → 文案: @小小鲸鱼娘 讲得最实的一点是「DeepSeek V4.1 Flash 把上下文管理讲清」，要点我记进笔记了（BV1n9Jv6QE3A）。
looksLikeAsrNoise 噪声/正常: true / false
mention 空值: {"name":"小小鲸鱼娘","source":"credential","configured":"","login":"小小鲸鱼娘","mismatch":false,"warn":""}
mention 不一致: {"name":"乌子鱼不在家","source":"config","configured":"乌子鱼不在家","login":"小小鲸鱼娘","mismatch":true,"warn":"@ 名（乌子鱼不在家）≠ 登录名（小小鲸鱼娘），评论会 @ 错人"}
```

> 138 条旧测试里，评论相关的两条是**按新规则原地更新**的：0.2.0 时它们预期
> 「没有 refine 也能发一条」——那正是这次事故的行为。现在这两条都注入假模型、
> 并断言「refine 缺失 → 不发」。其余 136 条一条未动。

### 九.4 `selfcheck.mjs` —— 全绿（新增 0.2.1 检查）

```text
✓ version = 0.2.1
✓ lib/duty.js 导出齐全（评论文案 / @ 名兜底 / ASR 噪声判定）
✓ 评论闸门：refine 缺失（摘句兜底）→ composeComment 返回 null
✓ 评论闸门：模型提炼的要点可以生成评论文案
✓ 评论闸门：就算标成 model，ASR 混合噪声（dB sk呢 / 新的fla）也剔除 → 整条不发
✓ @ 名兜底：空值自动用登录账号 credential.uname
✓ @ 名与登录名不一致：保留用户填的值 + 醒目提示（@ 名（乌子鱼不在家）≠ 登录名（小小鲸鱼娘），评论会 @ 错人）
✓ 状态里带 @ 名兜底信息（source=none，effective=（未登录/未填））
✓ 状态里能看见 @ 名提示：没有任何昵称可用：没填「要 @ 谁」，也没登录 B站
✓ client.js 带 0.2.1 的 @ 名兜底提示 + 「评论只引用模型提炼内容」说明
✓ 全绿：包契约 / patch / 依赖纯度 / host 半端 / client 半端 都过了
```

`_dev/pack.ps1` 的 zip 内容校验也加了两条：`index.js` 必须带 `mentionStatus`、
`lib/duty.js` 必须带评论闸门文案，否则拒绝出包。

### 九.5 手机安装包（0.2.1）

```text
=== ZIP ===
absolute path : C:\Users\32066\Documents\deepseek-harness\default-workspace\dsh-bili-study-0.2.1.zip
size          : 114169 bytes (111.5 KB)
entries       : 16
entry list    : AGENTS.md  client.js  cordis.patch.yml  index.js
                lib/bili-api.js  lib/catchup.js  lib/duty.js  lib/model.js
                lib/notes.js  lib/refine.js  lib/score.js  lib/state.js
                LICENSE  package.json  prompts/duty.md  README.md

zip structure OK (root has package.json + cordis.patch.yml; no tests/_dev/out/DELIVERY)
zip content OK   (package.json parses, patch keeps catchUp+refine, digest tool + refine UI + comment gate shipped)
```

### 九.6 0.2.1 的红线

- **没有真的发任何评论**：所有验证都是纯函数 / fake client / 夹具级；测试里的 `sendComment`
  只在「模型提炼成功 + 明确放行」的用例里被调用，且是 fake。
- `autoComment` 默认仍是 **关**（`CONFIG_DEFAULTS` / `cordis.patch.yml` / `Config` 三处都没动）。
- 日志/报告不打印 Cookie / SESSDATA；评论正文里不出现账号路径等私人信息（既有断言仍在）。
- **没碰** `C:\Users\32066\.dsh\profiles\desktop\`、`C:\Users\32066\.agents\skills\bilibili-study\`
  的真实数据、`D:\我的备份\`；也没动手机上的插件实例（手机仍是 0.2.0，0.2.1 由用户自己部署）。

