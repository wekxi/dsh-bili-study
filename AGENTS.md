# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsha-bili-study`（中文名「**刷B站学习**」）：每天挑几条值得看的 B站 视频、**读字幕原文**、落六节笔记、
按遗忘曲线排复习，并给一个手机上一屏能看完的面板。

**目标环境是手机**（DSHA / `com.dsh.client` / Linux arm64 glibc / Node 24），桌面 DSH 是顺带的。
所以这个仓库最大的约束不是功能，是 **"手机上不许有装不上的东西"**。

## 帮用户安装时，按这个顺序

1. `dsh plugin --profile <profile> add link:<本目录>`（本地）或 `add github:<owner>/dsha-bili-study`。
2. ⚠️ **必须重启一次 dsh**（bundle 层只在启动时组装）。
3. 进 **设置 → 刷B站学习**：填关键词 → 粘 SESSDATA（见 README 的拿法）→ 点「校验并保存」。
4. 点「现在跑一轮」看它能不能落笔记。跑完去「设置 → 今天学了什么」看一屏摘要。
5. **别擅自打开「自动评论并 @ 我」** —— 那是拿用户的号对外说话，必须用户自己开、自己填 @ 谁。

## 结构

```
index.js        host 半端：11 个工具 + 配置归一化 + 谷时定时器 + 补跑接线 + 模型探测 + /api/bili-study/*
client.js       浏览器半端：settings.section × 2（设置页 / 今天学了什么），含「补跑」「模型提炼」开关与状态行
lib/bili-api.js WBI 签名 / 搜索 / 详情 / 字幕轨 / 字幕体 / 评论 / 发评论
lib/score.js    0-100 可靠性分（口径与 bilibili-study 的 Python 版逐条一致）
lib/notes.js    JSON 笔记库 + 六节渲染 + bigram/BM25 检索 + 1/3/7/16/35 复习阶梯
lib/duty.js     每日一轮编排（搜→判分→挑→抓字幕/兜底→[模型提炼]→写笔记→出报告→可选评论）
lib/refine.js   P3 提炼：固定提示词（ASR 边界）、JSON/分节解析、金句原文校验、失败降级、digest 指令
lib/model.js    P3 宿主模型探测与流式收文本（不存 API key；拿不到就退化成摘句 + digest）
lib/catchup.js  补跑判定（今天跑过没 / 一天一次 / 失败不记已跑 / 窗口外也补）
lib/state.js    家目录 / 配置 / 凭据（掩码）/ 日期与时窗
prompts/duty.md 给模型的每日任务书（铺到家目录，用户可改；含 digest 收尾步骤）
selfcheck.mjs   预检：包契约 + patch + 依赖纯度 + 补跑接线 + 模型提炼 + 两个半端真跑
tests/          纯逻辑单测（node --test；含 client 真渲染；0.2.1 后共 144 条）
```

## 硬约束（改代码前先读）

1. **纯 JS、零原生依赖**。手机装不上 `better-sqlite3` / `sharp` / `canvas`。
   网络用 Node 自带 `fetch`；哈希用 `node:crypto`；存储用 JSON + 原子 rename。
   ⚠️ **不要**为了"更规范"去引 `node:sqlite`：宿主上是实验特性，跨版本不稳。
2. **不依赖 Python**。所有逻辑都在 JS 里（Python 版只是被打分口径参照，不参与运行）。
3. **`dependencies` 必须为空**；`@deepseek-ai/*` 只能放在 `peerDependencies` 且 optional。
   `index.js` 用**动态 import + 降级**拿 `defineTool`/`schemastery`：拿不到也要能注册工具、
   照常跑（我们自己的设置页走 HTTP，不依赖 DSH 内置设置编辑器）。
4. 包契约（DSHA `docs/plugins.md`）：合法 npm 名/版本、`dsh.bundle.patch` 指向真实 patch、
   入口真实存在、归档里不许有越界路径/包外链接。`selfcheck.mjs` 会全查一遍。

## 踩过的坑（别再踩）

- **`ctx.get('dshHomePath')` 是函数**，不是字符串。当字符串用会拼出「函数源码 + \dsha-bili-study」⇒ mkdir ENOENT ⇒ 插件不激活。
- **`apply(ctx, config)` 的 config 字段不保证是标量**（可能是对象/字符串）。必须先 `normalizeConfig()` 再 `.filter()`；
  否则 TypeError 会出现在**定时器回调**里，**直接带走整个宿主进程**。定时器回调必须自己 try/catch。
- **`defineTool` 的 `parameters` 是"参数描述表"**（`{字段: {type, description}}`），不是 `{type:'object', properties}`。
  传错会抛 JsonSchemaError ⇒ 整条插件不激活。降级路径（没有 defineTool）则要自己转成 object-rooted JSON Schema。
- **工具返回值必须过 `safe()`**：函数/循环引用/类实例都会报 `value is not lossless JSON`。
- **WBI 签名**：nav 拿 `wbi_img` 取文件名 → 64 项置换表取前 32 = mixinKey → 参数加 `wts`、去掉 `!'()*`、
  按 key 排序拼接 + mixinKey 求 md5 = `w_rid`。搜索**先签名版，失败退回无签名旧接口**。
- ⚠️ **匿名调签名版搜索会被"软风控"**：返回 `code=0` 但 `data` 只有 `{ v_voucher }`、**没有 `result`**
  （2026-10-17 实测）。所以判断成败要看 `Array.isArray(data.result)`，不能只看 code=0 ——
  否则界面表现是"搜到 0 条"。无签名的旧接口此刻仍然正常（20 条）。
- **多分P 字幕的时间戳各自从 0 开始**：拼成一条时间轴时必须累加前面分P 的时长（`fetchSubtitlesFor` 里做了）。
- **多关键词会搜到同一条视频**：候选必须按 bvid 去重（保留高分那条），否则会"同一轮挑中两条一样的"。
- **详情页重算的可靠性分要覆盖回报告**：搜索页看不到分P/总时长，分数通常低于详情页；
  不覆盖就会出现「报告写 75 分、笔记里写 81 分」这种自相矛盾（联网冒烟时真撞到过）。
- **知识点是启发式的**（bigram 词频 + 拼接）：拼接结果必须在原文里**真实出现且出现 ≥2 次**，
  否则会拼出「项目录」这种假词。就算这样也可能出半截词 —— 让模型用 `bili_study_note add` 修，别在算法里硬编。
- **评论用旧接口** `/x/v2/reply`；`/x/v2/reply/wbi/main` 要签名且实测 `-403`。
- **发评论**必须带 `csrf=<bili_jct>`（Cookie 里那一项），而且**绝不能重试**（重试 = 可能发两条）。
- **未登录时字幕轨恒为空**（`need_login_subtitle=true`）。这是 B站 规则，不是 bug —— 兜底要**如实标注**。
- 打分口径是**从 Python 版逐条移植**的：连**英文逗号**都照抄了（`', '` 不是 `'，'`），
  因为 `tests/fixtures/score-golden.json` 是拿 Python 原版跑出来的，差一个标点就红。
- `fmtCount` 用 **round-half-even**（Python `'%.1f'` 的口径），别改成 `toFixed`：
  12,500 播放 Python 写 "1.2万"，`toFixed` 会写 "1.3万"。
- Python 的 `\b` 是 Unicode 词边界（汉字算 word char），JS 不是。技术名词正则用
  `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` 复刻，否则「python入门」这种标题会被多给 12 分。
- **补跑失败绝不能写 `day`/`runs`**：那两个字段是「今天跑过没有」的唯一判据（`lib/catchup.js` 的
  `recordCatchUp` 失败时只写 `catchUp.attempts/lastAt/lastError`）。写成"已跑"= 那天永远不会再补。
- **补跑不能 `await` 在 HTTP/定时器里**：设置页每 8 秒轮询 `/status`，`await` 会卡住响应；
  一律 `setImmediate(() => void runCatchUp(...))` + 在 catch 里兜住（宿主不容许未捕获异常）。
- **一天最多补一次**（成功后 `todayRan()` 为真就跳过），失败最多试 3 次、间隔 ≥10 分钟 ——
  否则宿主崩溃-重启循环会把额度和日志刷爆。
- **`dsh` 这个 shim 会忽略你设的 `DSH_HOME`**（它默认把你带回 `desktop` profile，甚至在真实
  `~/.dsh` 下建目录）。隔离预览必须**直接调 `node <DSH app>/node_modules/@deepseek-ai/dsh/lib/bin.js`**。
- 本机 Electron 当 node 用时**必须经 `.cmd`/cmd.exe 启动**：它是 GUI 子系统程序，PowerShell 直接调
  **不等待、也拿不到 stdout**；`Start-Process` 起的后台进程会随那条命令结束被杀掉（要用 managed background job）。
- **P3 的 `ctx.get('llm')` 只能"可选地拿"**：宿主没装 `dsh-llm` 是正常情况，绝不能把它写进 `inject`
  （否则整条插件不激活）。默认模型从 `ctx.get('agentDefaultModel')?.currentSelection()` 拿；
  拿不到再用 `llm.listProviders()`（返回 `{id,name}`）+ `llm.listModels(id)`。
- **推理模型会把输出 token 全花在思考上**：`deepseek-flash` 默认高思考档，`maxTokens=1600` 时
  **正文一个字都没有**（真机上撞到：返回空串、9 秒）。修法：能从 `resolveModelInfo` 拿到
  `reasoning.efforts` 就传 `reasoningEffort:'low'`，输出上限给到 6000；并且 `streamText` 遇到
  "只有 reasoning-delta、没有 text-delta" 要报明确错误，别把空串当"模型没内容"。
- **宿主 stream 的 `messages` 用普通对象即可**（`{id, role:'user', content:[{type:'text',text}]}`），
  不要为了 `createUserMessage` 去 import `@deepseek-ai/dsh-llm`（插件包里解析不到就整条挂）；
  文本在 `text-delta`，终止在 `finish`（`error`/`aborted` 要当失败）。
- **提炼结果必须过三道校验**：JSON/分节解析失败 → 回退摘句并标 `failed`；金句必须能在**喂进去的
  那段字幕**里找到（允许 ASR 错字，bigram Dice ≥0.45），找不到就丢；`ts` 超出视频时长就清空。
  字幕被 `refineMaxChars` 截断时，金句只能来自前半段 —— 这是正确行为，不是 bug。
- **`cfg.refine` 是布尔开关，`store.video().refine` 是对象**（`{source:'model'|'failed'|…}`）。
  两个同名不同型，别在代码里混用；`runRound` 里只有 `cfg.refine === true` 才允许调模型，
  旧测试/旧配置没这个字段时必须走 0.1.0 行为（零调用）。
- 🔴 **评论是对外发言，只能引用模型提炼（`source:model`）的要点/金句**。0.2.0 真机出过事故：
  手机上那轮 refine 额度被当天前面几轮用完（`counts.refined=0 / refineCalls=0`），
  评论文案退回**摘句兜底**，把 ASR 原文 `今天是26年10月17日dB sk呢发布了一个新的fla`
  原样 @ 出去了（BV1n9Jv6QE3A，rpid 317365880721，确实发出去了）。
  现在 `composeComment` 在 `refine !== 'model'` 时返回 **null**，`maybeComment` 记
  `comment: skipped (no refined content)`、`counts.commented` 不增、**一条都不发**。
  别为了"每轮都发一条"把这道闸拆了；评论宁可少发。
- **`mentionName` 空值兜底走 `credential.uname`**（保存 Cookie 时 `nav` 拿到的登录昵称）；
  手填值与登录名不一致只在设置页/状态里**提示**「@ 名 ≠ 登录名，评论会 @ 错人」，**绝不改用户填的值**
  —— 有人就是想 @ 别人。
- `looksLikeAsrNoise()` 是**评论专用**的保守判据（中文紧贴小写拉丁碎片，如 `dB sk呢`、`新的fla`）：
  命中的要点/金句一律不进评论，宁可这一轮不发。**别拿它过滤笔记正文**——笔记本来就要保留原文。
- **真模型验证**：隔离 `DSH_HOME` + `--from-default-profile web` 建 profile，把真实
  `<真 DSH_HOME>/.credentials.yaml` **复制**进隔离家目录（否则 `MISSING_CREDENTIAL`），跑完删掉；
  `.credentials.yaml` 内容一个字都不许打印。验证完把临时调试端点从 `index.js` 删干净再打包。
- **PowerShell 的 `$home` / `$HOME` 是只读自动变量**：`$home = ...` 会报错，`Remove-Item $home`
  会指向 `C:\Users\<你>`（真实撞到过，差点删家目录）。隔离路径一律用 `$iso`/`$pluginHome` 这种名字。

## 测试怎么跑

```powershell
node selfcheck.mjs     # 会真跑 apply() 与 client 工厂；不联网（P3 起会验提炼提示词/解析/digest）
node --test tests/     # 纯逻辑；不联网（fixtures 里有真实字幕样本）

# 本机/沙箱禁止 --test 起子进程（spawn EPERM）时用单进程模式；目录要写成 glob：
node --test --test-isolation=none tests/*.test.mjs
```

⚠️ 本机（这台 Windows）没有独立 `node.exe`，开发时用 `_dev/node.cmd` 这个包装
（`ELECTRON_RUN_AS_NODE=1` + DSH Desktop 的 Electron）跑——**那是临时脚手架，不在交付物里**。
同样地，本机没有 npm，`npm pack --dry-run` 用 DSH 自带的 pnpm 顶替：
`<DSH app>/node_modules/pnpm/bin/pnpm.cjs pack --dry-run`（会按 `files` 列出打进包里的文件）。

## 客户端半端在真实宿主里怎么核（比"重启看日志"省事）

设置页/面板是 client bundle，靠 `dsh.client` + `exports['./client']` 被宿主扫到。要确认它真被发出去
（下面是**实测过**的一整套，README「本地预览（桌面）」有可直接照抄的版本）：

1. 起一个**隔离的 DSH_HOME**（绝不用真 `~/.dsh`）：`$env:DSH_HOME = Join-Path $env:TEMP 'dsha-bili-preview'`
2. ⚠️ **别用 `dsh` 这个 shim**（它忽略 `DSH_HOME`、默认回 `desktop` profile）。直接调 bin.js：
   `node "<DSH app>/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile preview --from-default-profile web --dump-config`
3. `… bin.js plugin --profile preview add link:<本目录>` → `--dump-config` 里应出现 `- id: bili-study` 与你的 config
4. `… bin.js --profile preview --host 127.0.0.1 --port 4399 --no-open` → 控制台打一条带 `?token=` 的 URL；
   用 `curl -c jar -L "<url>"` 拿会话 Cookie，再抓 `/` 里的 `__DSH_BOOT__`，
   会看到 `{"id":"dsh-bili-study","url":"plugins/??dsh-bili-study/client.js&rev=…"}`；
   抓那个 URL 应返回 200 且内容就是你的 client.js（P3 之后约 28KB）。
5. `curl http://127.0.0.1:4399/api/bili-study/status` 有 JSON = host 半端整条都活了
   （工具注册在路由之前，路由能应答就说明 11 个工具都注册成功），看 `catchUp.text` 是否 `今天未跑·待补`，
   以及 `refine.available/provider/model/reasoningEffort`。
6. **模型路的真证据**：隔离家目录里放一份 `.credentials.yaml`（从真实 DSH_HOME 复制，别打印），
   `status.refine.available` 应为 true；用一个 `BILI_STUDY_DEBUG_REFINE=1` 才挂的临时端点
   拿真实字幕跑一次 `runRefine`，确认返回四节。**验证完删掉临时端点再打包**。
7. 收尾（别留常驻）：`taskkill /T /F /PID <监听 4399 的 PID>` + 删掉隔离家目录。

## 真机（DSHA）上要记住的两件事

1. **家目录是 `$DSH_HOME/dsha-bili-study/`，而 DSHA 的 `$DSH_HOME` 在应用私有目录**
   （`/data/user/0/com.dsh.client/...` 这类，随版本/安装位置变）。别把桌面路径写进提示词；
   设置页底部「它的地盘」显示的就是真实绝对路径。导出笔记/报告的三种办法见 README「导出笔记 / 报告」。
2. **定时在安卓上不可靠**（杀后台 + Doze）⇒ 一切"每天自动跑"的承诺都必须有补跑兜底：
   宿主启动 / 定时器 tick / 设置页打开时会查"今天跑过没有"，没跑就补一轮（`lib/catchup.js`）。
   不要在别处另写一套判据 —— "今天跑过没有"只认 `state.json` 的 `day`+`runs` 与 `out/<日期>.md`。

## 数据纪律

- 配置/凭据/笔记/报告**只写插件家目录**，绝不写进包目录（装进 node_modules 后可能只读，升级会覆盖）。
- 写 JSON 一律 `writeJsonAtomic`（临时文件 + rename）：手机端随时被杀进程。
- 笔记 `.md` 是**渲染视图**，改内容只能走 `bili_study_note add`。
