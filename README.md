# dsh-bili-study（刷B站学习）

> 一个 DSH 插件：每天替你在 B站 挑几条**值得看**的，**读字幕原文**判断，落成结构化笔记，
> 按遗忘曲线安排复习，并在设置页旁边给你一屏「今天学了什么」。
>
> **0.2.0 起会真的「读懂」**：抓到 ai-zh 字幕后，用宿主的模型把 ASR 原文提炼成
> 「要点 / 金句 / 我的判断 / 值不值得再看」，并纠正 `deep fw0V`、`GBT6.1` 这类听错的词；
> 宿主没有模型服务时，用 `bili_study_digest` 把字幕 + 指令交给外部 agent 写（两条路都能走）。
>
> **0.2.1 修的是评论**：0.2.0 在真机上把一段 ASR 原文当评论文案 @ 出去了。现在评论**只引用模型提炼过
> 的要点/金句**，这一条 refine 被跳过/失败就**整条不发**；`mentionName` 留空会自动用登录账号。
>
> **安卓会杀后台？漏跑的那天，下次打开自动补一轮**（补跑口径见下面那节）。
>
> 为 **DSHA（安卓上的 DSH 启动器）** 设计：**纯 JS、零原生依赖、不依赖 Python**，桌面 DSH 同样能用。

## 它能干什么

| # | 能力 | 怎么用 |
|---|---|---|
| 1 | **搜索 + 判分**：按关键词搜近几天视频，给 0-100 可靠性分（识别引流号/标题党） | 工具 `bili_study_search`；设置页填关键词 |
| 2 | **抓字幕 + 判值不值得看**：逐条读字幕原文；**没有 ai-zh 轨道时如实记录并走「简介+评论」兜底，不硬凑** | `bili_study_subtitle` / 每日一轮自动做 |
| 3 | **模型提炼（P3）**：把 ASR 字幕变成「要点 / 金句 / 我的判断 / 值不值得再看」，可用 `refine` 开关；宿主没模型时用 `bili_study_digest` 交给 agent | 设置页「模型提炼」；`bili_study_digest` |
| 4 | **学习笔记沉淀**：六节结构（元信息/要点/时间轴锚点/金句/我的判断/值不值得再看）+ 跨视频检索 | `bili_study_note`、`bili_study_find` |
| 5 | **定时 + 补跑兜底**：谷时每天一轮、出报告；**安卓杀后台/Doze 漏掉的那天，下次打开就补上**；自动评论**默认关**、每轮最多一条、同视频不重复，且**只引用模型提炼过的内容** | 设置页 / `bili_study_daily` |
| 6 | **复习提醒**：笔记带 `next_review`，按 1/3/7/16/35 天阶梯给「今天该复习哪些」 | `bili_study_review` |
| 7 | **手机端报告面板**：「今天学了什么」——一屏摘要，竖屏可读，能看出每条是模型写的还是摘句兜底 | 设置 → 今天学了什么 |

## 装法

### 手机上（DSHA）

三选一，**装完都要重启一次 DSH**（bundle 层要重启才组装）：

1. **插件市场**：粘本仓库的 GitHub 链接（`https://github.com/<你>/dsha-bili-study`）→ 装。
2. **本地导入 zip**：把仓库打成 zip（或 `npm pack` 出来的 tgz）→ DSHA 里「导入本地包」。
3. **命令行**：在 DSHA 的终端里
   ```
   dsha-plugin install <插件目录或包名>
   ```

> 手机上的家目录是 `$DSH_HOME/dsha-bili-study/`。**DSHA 里的 `$DSH_HOME` 落在应用私有目录**
> （常见形如 `/data/user/0/com.dsh.client/files/dsh/`、`/data/data/com.dsh.client/...`，
> 随 DSHA 版本与安装位置不同而不同），所以**不要照抄网上的路径**：
> 打开 **设置 → 刷B站学习 → 拉到最底部「它的地盘」**，那里显示的就是**真实绝对路径**
> （家目录 / 今天的报告 / 笔记库三行）。详见下面「数据放在哪」。

### 桌面上（DSH）

```powershell
dsh plugin --profile work add link:D:\path\to\dsha-bili-study
# 或者装了 npm 包之后
dsh plugin --profile work add dsh-bili-study
```
然后重启一次 `dsh`（`--profile work`），进 **设置 → 刷B站学习**。

## 安卓会杀后台：定时 + 补跑（catch-up）

**问题**：DSHA 跑在安卓上，系统会杀后台进程，Doze/省电模式还会掐掉定时器。
「谷时到点自动跑」在真机上**很可能永远不触发** —— 表现是装好一周一条笔记都没有。

**兜底**：插件每次被激活（宿主启动）、定时器每跳一次、以及**桌面/手机上打开设置页或「今天学了什么」面板**时，
都会先查一遍「今天这一轮跑过没有」（看 `state.json` + `out/<日期>.md` 两处）：
**今天还没跑 + 今天是允许跑的日子 ⇒ 立刻补跑一轮**（就是正常的每日流程）。

| 约束 | 口径 |
|---|---|
| 一天最多补几次 | **成功后当天不再补**（`state.json` 里 `day`/`runs` 就是判据，`out/` 里有当天报告也算） |
| 失败了怎么算 | **不算「已跑」**：`runs` 不写，界面上仍是「今天未跑·待补」；但一天最多试 3 次、每次至少隔 10 分钟（防崩溃循环刷额度） |
| 什么情况下不补 | `enabled=false`（插件停用）、**手动模式**（谷时自动跑关掉 / 两个窗口都关 / 每天 0 条）、设置页把「补跑」关掉 |
| **不在窗口里补不补** | **补**。理由见下 |
| 日志证据 | `study.log` 里会有一行：`catch-up: 今天尚无 round，触发补跑（trigger=boot/tick/settings/panel）` |

**为什么补跑不等下一个谷时窗口？**
等窗口 = 把「定时可能不触发」这个 bug 原样保留：手机上的下一个窗口照样可能被 Doze 掐掉，
而用户打开 App 的那一刻恰恰是**唯一确定活着的时刻**。
补跑这一轮是**纯 JS**（搜索/抓字幕/写笔记，不调模型、不花 token），"谷时"约束针对的是模型调用，
所以错过谷时的代价很小；真正防滥用的是上面的上限（一天一次 / 失败最多 3 次）。

设置页里 **什么时候自己跑 → 补跑：开/关**，旁边一行就是今天的状态：
`今天已跑` / `今天未跑·待补` / `今天未跑·补跑放弃（已试 N 次）` / `今天未跑·只手动跑（不补）`。

## 模型提炼（P3）：两条路，一条都不藏

抓到 ai-zh 字幕后，笔记的「要点 / 金句 / 我的判断 / 值不值得再看」有两种写法：

### 2a 插件内直调宿主模型（宿主有 `llm` 服务时，默认开）

- 每轮挑中的视频抓到字幕后**调一次**宿主的模型；**凭证与模型路由全走宿主**，插件不存任何 API key。
- 默认用宿主当前模型（本项目实测是 `deepseek-official/deepseek-flash`），也可以填 `refineModel` 指定。
- 模型返回必须是严格 JSON（四段固定），**解析失败就优雅降级**：保留摘句兜底笔记 + 状态标 `failed`，
  笔记不会被写坏。
- 笔记里会标 `| 提炼 | 模型提炼（deepseek-official/deepseek-flash）|`，每一节带 `source:model` 标签；
  设置页和「今天学了什么」面板都能看出**这条是模型写的还是摘句兜底**。

### 2b 提示词驱动（宿主没模型服务 / 你想自己控）

工具 **`bili_study_digest`**：给一个 BV 号，返回

- `transcript`：字幕全文，一行一个 `[M:SS] 原文`（分段，默认最多 12000 字）；
- `instruction`：一段写笔记指令（四节格式 + 「用 `bili_study_note add` 一条一节写回」的命令）；
- 元信息（UP/时长/播放/分P）、`truncated`、笔记壳子建没建（`noteState`）。

外部 agent 按 `instruction` 自己生成四节再写回即可（写回命令带 `source=agent`，
面板会标出「外部 agent 按 digest 提炼」）。`prompts/duty.md` 里有一段
「每日收尾：对今天挑中的每条跑一次 digest 并写回」，宿主没模型时 agent 会照这个走。

### 成本与上限

| 闸 | 默认 | 说明 |
|---|---|---|
| `refine` | **开** | 关掉 = **与 0.1.0 完全一致**：只摘句、**零模型调用** |
| `refinePerRound` | 2 | 每轮最多提炼几条 |
| `perDay` | 2 | 每天最多提炼几条（今天已经调过几次记在 `state.json` 的 `refine.byDay`） |
| `refineMaxChars` | 12000 | 单条喂给模型的字幕上限（字幕太长只喂前面这段，并告诉模型「结尾没提供」） |
| `refineModel` | 空 | 留空 = 宿主默认；可写 `provider/model` 或只写 model |

设置页会显示「本轮模型调用 N 次 / 今天 N 次 / 昨天 N 次」。推理模型会自动选 `low` 思考档
（能拿到模型能力时），避免思考把输出 token 吃光。

### ASR 噪声的边界（写死在提示词里）

- **允许**纠正明显听错的专有名词/数字：`deep fw0V` → `DeepSeek V4.1 Flash`、`GBT6.1` → `GPT-6.1`；
- **不确定**的必须写「可能是…」；
- **不许**补充字幕里没有的事实、数据、人名、结论；
- 金句必须能在字幕原文里找到（允许 ASR 错字，用 bigram 相似度兜底），找不到的**直接丢掉**；
- 时间轴超出视频时长的会被清空；四节合计要求 ≤600 字。

### 评论取文规则（0.2.1：一次真机事故之后写死）

0.2.0 在手机上出过一次事故：`autoComment=true` 的那轮 `refine` 额度被当天前面几轮用完
（`counts.refined=0 / refineCalls=0`），评论文案**退回摘句兜底**，把 ASR 原文
`「今天是26年10月17日dB sk呢发布了一个新的fla」` 原样 @ 出去了
（视频 `BV1n9Jv6QE3A`，rpid `317365880721`）。0.2.1 起：

- 评论**只能**引用 `source: model` 的「要点 / 金句」；这一条视频 refine 被跳过/失败/关闭
  （`refined=0`）⇒ **这一条不发评论**，报告与状态里记 `comment: skipped (no refined content)`，
  `counts.commented` 不增。**宁可少发，不许发噪声。**
- 金句必须能在字幕原文里回溯（复用提炼校验 `quoteInTranscript`），找不到就退回要点。
- 要点/金句里仍混着 ASR 碎片（中文紧贴小写拉丁，如 `dB sk呢`、`新的fla`）⇒ 丢掉；
  一个可用的都不剩就**整条不发**。
- 不再用「知识点」拼评论：那是启发式 bigram，本身就是从 ASR 原文里捞出来的，不是模型提炼物。

### @ 名兜底（0.2.1）

- 「要 @ 谁」留空 ⇒ 自动用**登录账号**（`credential.uname`，保存 Cookie 时从 `nav` 拿到的昵称）。
- 手填的值**不会被改**；若与登录账号不一致，设置页顶部和状态里给一条醒目的
  「@ 名 ≠ 登录名，评论会 @ 错人」。

### 真调通证据（2026-10-17，桌面 DSH 宿主）

用真实样本 `BV1ahFmzqE9z` 的 ai-zh 字幕，宿主 `deepseek-official/deepseek-flash`（`reasoningEffort=low`）：

**0.1.0 的摘句兜底**（ASR 噪声原样进笔记，判断是模板话）：

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

**0.2.0 的模型提炼**（11.5 秒，3597 字提示词 / 130 行字幕）：

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

> 同一段字幕：`scale`/`SCLE` 被纠正成 `skills`，ASR 噪声不再当结论；
> 判断也从模板话变成了「适合谁 / 坑在哪 / 字幕没覆盖什么」。

## 装完在设置页填什么

| 项 | 填什么 |
|---|---|
| **关注关键词** | 一行一个。留空用内置那组（机器学习 / 算法 / DeepSeek …） |
| **每天最多挑几条** | 手机上建议 1–2（一条视频 2 个分P 的字幕大约 10–20 秒） |
| **最低可靠性分** | 默认 55；想更挑就填 65 |
| **B站 登录（SESSDATA）** | 见下。**不填也能搜、能打分，但拿不到字幕**（B站 规则：未登录不返回字幕轨） |
| **模型提炼** | 默认开；关掉就是 0.1.0 的摘句兜底。旁边能填字幕上限 / 每轮条数 / 指定模型 |
| **自动评论并 @ 我** | 🔴 默认关。开了就是**拿你的号对外发内容**，每轮最多一条；文案只取自模型提炼的要点/金句（没提炼成功就不发）。@ 名留空 = 自动用登录账号 |

### SESSDATA 怎么拿（这是唯一要动一次浏览器的事）

1. 电脑浏览器打开 `https://www.bilibili.com` 并**登录**。
2. `F12` → Application（应用）/ Storage → Cookies → `https://www.bilibili.com`。
3. 复制 `SESSDATA` 的值；想让它能发评论，再复制 `bili_jct` 的值。
4. 拼成 `SESSDATA=xxxx; bili_jct=yyyy` 粘进设置页 → 点「校验并保存」。

凭证只落在 `<家>/credential.json`（chmod 0600，Windows 上是 best-effort），
**不进 profile 配置、不进插件包、设置页只显示掩码**。点「清除凭据」随时删。

## 数据放在哪

```
$DSH_HOME/dsha-bili-study/
  config.json        设置页写的那份（盖过 cordis.patch.yml 里的默认值）
  credential.json    B站 Cookie（0600）——删了就等于登出
  library.json       ⭐ 笔记库真身（原子写）
  notes/<BV号>.md    每条视频的可读笔记（从 library.json 渲染，别手改）
  subs/<BV号>.P01.txt  抓到的字幕原文（只有 save=true 或一轮跑过才写）
  out/<日期>.md      每天的报告
  out/<日期>.json    同上一份的机器可读版（给面板用）
  state.json         今天跑过没有 / 上次结果 / catchUp 补跑记录 / refine 每天的模型调用计数
  study.log          日志（补跑触发、模型提炼成功/失败都记在这里；不记 Cookie、不记 API key）
```

**真实路径不用猜**：设置 → 刷B站学习 → 拉到底「它的地盘」，三行分别是
`家目录` / `今天的报告` / `笔记库`；「今天学了什么」面板底部也有报告路径。
安卓上这些通常在**应用私有目录**（`/data/user/0/com.dsh.client/...`），
文件管理器不一定能直接看到 —— 用下面的导出办法。

### 导出笔记 / 报告

- **桌面**：直接把整个 `$DSH_HOME/dsha-bili-study/` 目录复制走即可（一个 JSON + 一堆 md，没有数据库）。
- **安卓（能开终端时）**：把插件家目录整个拷到共享存储，再用文件管理器/微信传走：
  ```sh
  cp -r "$DSH_HOME/dsha-bili-study" /sdcard/Download/dsha-bili-study-export
  ```
  （`$DSH_HOME` 在 DSHA 的终端里可能没导出，那就照抄设置页显示的家目录绝对路径。）
- **安卓（没有终端）**：在设置页底部抄下「家目录」路径，用 DSHA 自带的文件/工作区面板（若该目录在可访问范围内）
  逐级进入并分享 `notes/`、`out/` 两个文件夹；`library.json` 是笔记库真身，**要一起带走**才能再导入。
- **想只交一份总结**：`out/<日期>.md` 就是当天那轮的报告，单文件可直接读/贴。

**备份**：把整个 `dsha-bili-study/` 目录复制走。⚠️ 别把 `credential.json` 贴到群里/传到公开仓库（里面是你的 SESSDATA）。

## 工具（模型侧）

| 工具 | 干什么 |
|---|---|
| `bili_study_search` | 关键词搜 + 0-100 分 + 打分依据 |
| `bili_study_video` | BV 详情 + 重新打分 + 分P（cid） |
| `bili_study_subtitle` | 抓字幕原文（分页 40 行，带时间轴） |
| `bili_study_digest` | **提示词驱动提炼**：字幕全文（分段）+ 元信息 + 写笔记指令（宿主没模型时用） |
| `bili_study_note` | `new` / `add` / `list` / `show` |
| `bili_study_find` | 在自己笔记里跨视频检索（中文 bigram） |
| `bili_study_review` | `due` 今日清单 / `grade` 打分 |
| `bili_study_daily` | 立刻跑一轮 |
| `bili_study_login` | 存 / 查 / 清 B站 Cookie |
| `bili_study_status` | 今天跑了没、几条、待复习几条 |
| `bili_study_config` | 读 / 改配置 |

## 打分口径

跟 `bilibili-study` 技能的 Python 版**逐条一致**（`tests/fixtures/score-golden.json` 是拿 Python 原版跑出来的对照）：

```
减分：全748集(-35) 七天从小白到大神(-30) 零基础+速成(-25) 网盘(-25) 白嫖(-20)
      少走N%弯路(-20) 存下吧/很难找全(-15) 完整版课程(-15) 评论区领取(-15) 速成(-10)
      播放<1000 堆夸张词(-20) 高播放超低点赞率(-10) 分P>150(-15) 平均每P<3分钟(-8)
      单P 直播录像>6h(-10)
加分：简介有 github/arxiv(+20) 标题有技术名词(+12) 有章节号(+8) 互动健康(+12/+6)
      2-60个分P且平均>=10分钟(+12) 简介>=80字(+5)
分级：>=80 强烈推荐 / 65-79 值得一看 / 50-64 一般 / <50 引流嫌疑
```

⚠️ 分数只衡量**元数据可信度**，不是内容质量结论。

## 已知限制（诚实版）

- **DSHA 真机安装未验证**：本仓库在 Windows + 桌面 DSH 上做的验证（见 `DELIVERY.md`），
  手机上的安装路径/权限需要你在设备上走一遍。
- **字幕依赖登录态**：未登录时 B站 一律不返回字幕轨（`need_login_subtitle=true`），
  插件会如实报，不会硬凑。
- **自动评论**：发评论的接口在没登录/风控时会被拒绝，错误会如实报出来；
  这是唯一会**对外发内容**的功能，默认关。0.2.1 起评论只引用模型提炼过的要点/金句，
  这一轮没提炼成功就**整条不发**（0.2.0 曾把 ASR 原文发出去，见上面「评论取文规则」）。
- 只支持单条 BV / 关键词搜索；**不支持 UP 主订阅、番剧、直播**。
- **定时在安卓上可能不触发**（系统杀后台 / Doze），所以有**补跑兜底**：
  今天没跑过的日子，下次插件被激活、定时器跳、或你打开设置页时补一轮（一天最多一次）。
  补跑**不等下一个谷时窗口**（理由见上面那节）；真机上的定时行为仍需你自己观察。
- 笔记检索是 bigram + BM25-lite，不是语义检索：换个说法可能搜不到（同一个词一定能搜到）。
- 「知识点」那一行是**启发式**（bigram 词频 + 拼接，只认原文里真出现且出现 ≥2 次的词），
  偶尔会切出半截词；想要准的就让模型读完原文后用 `bili_study_note add` 补/改。
- 每日一轮的**机械活**（搜索/判分/抓字幕/写笔记/复习）是**纯 JS**，不 spawn 子进程；
  0.2.0 起「提炼」这一小步可以调宿主模型（`refine` 默认开、有上限、失败自动回退摘句），
  **关掉 `refine` 就回到 0.1.0 的零模型调用**。
- 模型提炼**不是事实核验**：它只能读字幕、不能看画面；字幕本身漏掉的内容它不会知道，
  「我的判断」也可能出错。金句做了「必须在原文里找到」的校验，要点/判断仍需你自己扫一眼。
- 宿主没有 LLM 服务时，插件不会自己存 API key、也不会偷偷联网找模型：只走摘句兜底，
  想用模型就自己跑 `bili_study_digest`（提示词驱动）。

## 本地预览（桌面）

想在电脑上先点一下界面，**又不想动你现有的 profile**：用隔离的 `DSH_HOME` + 一个只装本插件的 profile + 指定端口。
下面这套是**实测过**的（Windows + DSH Desktop 2.0.17；验证细节见 `DELIVERY.md` §P2）。

```powershell
# 0) 变量（本机没有独立 node.exe 时用 DSH Desktop 的 Electron 当 node：ELECTRON_RUN_AS_NODE=1；
#    普通机器把 $node 换成 node 即可）
$plugin  = 'C:\Users\32066\Documents\deepseek-harness\default-workspace\dsha-bili-study'
$dshBin  = "$env:LOCALAPPDATA\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
$node    = "$plugin\_dev\node.cmd"          # 临时脚手架，不在交付物里

# 1) ⚠️ 隔离家目录：绝不碰真实的 ~/.dsh
$env:DSH_HOME = Join-Path $env:TEMP 'dsha-bili-preview'
Remove-Item -Recurse -Force $env:DSH_HOME -ErrorAction SilentlyContinue

# 2) 建一个"只装本插件"的 profile（从 web 模板起，再加本插件）
#    第一步只是建 profile，输出很长，只看最后没报错即可
cmd /c "`"$node`" `"$dshBin`" --profile preview --from-default-profile web --dump-config" | Select-Object -First 2
cmd /c "`"$node`" `"$dshBin`" plugin --profile preview add link:$plugin"

# 3) 起服务：挑一个没被占用的端口（下例 4399；已经有人在用就换 4421 之类），--no-open 不弹浏览器
cmd /c "`"$node`" `"$dshBin`" --profile preview --host 127.0.0.1 --port 4399 --no-open"
#    → 控制台打印：dsh web: http://127.0.0.1:4399/?token=xxxxxxxx
#    → 浏览器打开那条带 token 的 URL，进 设置 → 「刷B站学习」/「今天学了什么」两页
```

不想开浏览器时的两条检查（`<token>` 换成上面打印的）：

```powershell
# 插件在宿主里活没活（11 个工具注册在路由之前，这里能应答就说明整条链都活了）
curl.exe -sS "http://127.0.0.1:4399/api/bili-study/status"
# 顺手看模型提炼探没探到：refine.available / provider / model / reasoningEffort
# 浏览器半端有没有真的被发出去（返回 200 且字节数 ≈ 28KB = 你的 client.js）
curl.exe -c jar.txt -L "http://127.0.0.1:4399/?token=<token>" -o index.html
curl.exe -b jar.txt "http://127.0.0.1:4399/plugins/??dsh-bili-study/client.js&rev=<rev>" -o client.js -w "%{http_code} %{size_download}`n"
```

**怎么关 / 清理**（别留常驻进程）：

```powershell
# 前台起的服务：在它那个窗口按 Ctrl+C
# 后台起的（Start-Job / 别处的 pwsh）：先找 PID 再连子进程一起收
Get-NetTCPConnection -LocalPort 4399 -State Listen | Select-Object OwningProcess
taskkill /T /F /PID <那个 PID>
# 清理隔离环境（profile + 预览写的笔记/报告全在这儿，删了就没了）
Remove-Item -Recurse -Force (Join-Path $env:TEMP 'dsha-bili-preview')
```

> ⚠️ 别用 `dsh` 这个 shim 起预览：它默认把你带到 `desktop` profile（还可能改 `DSH_HOME`），
> 等于动你真实的 `~/.dsh`。要**直接调 DSH 自带的 `bin.js`**（上面 `$dshBin`）。
> 预览时插件会真的联网跑一轮（这也是补跑的证据），跑到的是隔离家目录，不会污染你的数据。

## 卸载

```powershell
dsh plugin --profile work remove dsh-bili-study   # 桌面
```
手机上在插件管理里停用/卸载。
数据不会自动删：想清干净就手动删 `$DSH_HOME/dsha-bili-study/`。

## 开发

```powershell
node selfcheck.mjs        # 包契约 / patch / 依赖纯度 / 补跑接线 / 模型提炼 / 两个半端真跑一遍
node --test tests/        # 单测（打分 / WBI / 笔记 / 检索 / 复习 / 每日一轮 / 补跑 / 提炼 / client 渲染）

# 本机没有独立 node.exe、或沙箱禁止 --test 起子进程（spawn EPERM）时，用单进程模式：
node --test --test-isolation=none tests/*.test.mjs
```
细节与踩坑见 `AGENTS.md`。
