# pi-context-diet 上游行为保真规格（实现者无需再读上游源码）

> **文档定位**：这是一份"行为合同"，不是综述。每一条行为都带 `TS:<行号>`（`reference/pi-context-diet-main/extensions/context-diet.ts`，共 1309 行）或 `TESTS/<文件>:<行号>`（`reference/pi-context-diet-main/tests/*.test.ts`）出处。
> 凡是本文件写出的字符串、阈值、边界数值，都是从源码或测试断言里逐字抄录的；实现时按字面复制，不要"理解后重写"。
>
> **行号基准**：上游 `pi-context-diet` 0.3.8，`extensions/context-diet.ts` 1309 行；测试 3919 行（core 748 / extension 832 / fuzz 332 / vhs 326 / autocomplete 89 / commands 84 / config 67 / readme 74 / helpers 50 / setup 8）。
>
> **为什么要这么严**：上一版 DSH 移植"自认为与原版一致"，实际同时存在（a）另一套 stub 文本与 marker（实际有三套）、（b）另一套 `mode`/`parseCommand`/`statusText`、（c）把 durable surface replacement 当成语义等价物、（d）把 compact/warming 这类上游功能做进了 DSH 版本；同时**上游的 `Calibrator`、`describeElided/describeCandidates/showLines`、`staleTokens`、`restoreState`、`completions` 等整块能力完全没有移植**，`core.js` 前 882 行的忠实实现根本没人调用。本规格第 12 节逐条对齐了这些差异，实现者应把它当作验收清单。

---

## 目录

1. [术语与总体模型](#1-术语与总体模型)
2. [配置全表（含 sanitize 钳制）](#2-配置全表含-sanitize-钳制)
3. [判定流程（gate 顺序与公式）](#3-判定流程gate-顺序与公式)
4. [stub 渲染精确规则](#4-stub-渲染精确规则)
5. [Calibrator](#5-calibrator)
6. [RecoveryMeter](#6-recoverymeter)
7. [Stats 字段与更新时机](#7-stats-字段与更新时机)
8. [footer 状态行](#8-footer-状态行)
9. [命令集、输出文本、autocomplete](#9-命令集输出文本autocomplete)
10. [会话状态恢复](#10-会话状态恢复)
11. [Cache warming / compaction（本项目不做，标注）](#11-cache-warming--compaction本项目不做标注)
12. [DSH 移植差异清单（缺失 / 偏离 / 多余）](#12-dsh-移植差异清单缺失--偏离--多余)
13. [附录 A：上游导出清单与测试断言索引](#附录-a上游导出清单与测试断言索引)

---

## 1. 术语与总体模型

### 1.1 词表（全部来自源码命名，实现时沿用）

| 术语 | 含义 | 出处 |
|---|---|---|
| **elision / 裁剪** | 把一条 `toolResult` 消息的 `content` 替换成一个确定性 stub 文本；不改消息以外字段 | TS:494-536 |
| **elided set** | 已决定裁剪的 `toolCallId` 集合，会话级，持久化到 custom entry | TS:982, 1070-1072 |
| **elidedArgs set** | 已决定裁剪参数的 toolCall id 集合 | TS:983 |
| **stub** | 替换文本，含大小、行数、tool+label，可选 error/tail 预览 | TS:292-298 |
| **cold / 冷启动** | 最后一条 assistant 消息的时间戳距今 **严格大于** `cacheTtlMinutes*60000` | TS:371-374 |
| **candidate** | 通过全部 gate、可被裁剪的 toolResult（或 write/edit 调用） | TS:347-360, 421-443 |
| **protected tool** | 本会话被 recovery meter 拉黑、永不再裁的工具名 | TS:1209-1214, 339-344 |
| **re-fetch / recovery** | agent 重新发出与某条已裁剪结果**完全相同签名**的 tool call | TS:764-774 |
| **force** | `/context-diet now` 设置的一次性旁路：跳过 cold gate | TS:1274-1277, 1068-1075 |
| **footer / 状态行** | `ctx.ui.setStatus("context-diet", ...)` 的一行文本 | TS:997-1023 |
| **prompt prefix 稳定性** | 同一 elided set 在后续请求里产生字节相同的前缀 | TS:1069-1076, TESTS/extension.test.ts:106-124 |

### 1.2 总体模型：一次请求，一个决策，之后原样重放

上游只有 **一个**改写点：`pi.on("context", …)`（TS:1063-1097）。每个请求到达时：

```
1. 若 !config.enabled           → 直接返回 undefined（请求原样发送）
2. 记录 lastMessages = 本次请求的 messages（footer 的"下次预算"要用）
3. decision = decide(messages, elided, config, {now: Date.now(), force}, {elidedArgs, protectedTools})
4. 若 decision.ids/argIds 非空 → 并入 elided / elidedArgs，appendEntry 持久化，cold 时 coldStarts++
5. force = false（一次性）
6. result = applyElision(messages, elided, {argIds: elidedArgs, preview:{tail:stubTailLines, errors:stubErrorLines}})
7. pendingChars = charsOfMessages(result.messages)     // 供 Calibrator
8. 若 result.count + result.argCount === 0 → 清零 last*，刷新 footer，返回 undefined
9. 否则 meter.track(result.infos)；更新 stats；刷新 footer；返回 {messages: result.messages}
```

关键不变式（测试逐条锁定）：

- **原始消息永不就地修改**：`applyElision` 用 `map` 生成新数组，未命中的消息保持**同一对象引用**（TESTS/core.test.ts:207-208，`deepFreeze` 下运行）。
- **命中集合只增不减**（本会话内），且 warm 期间**绝不新增**（TESTS/extension.test.ts:106-124）。
- **同样输入 → 字节相同输出**（`stubText`、`previewOf`、`stableStringify` 都是纯函数；TESTS/core.test.ts:215-219, 361-372）。
- **前缀在两次 cold start 之间字节稳定**：120 轮模拟会话断言只发生 2 次 cold start，且非决策步的前缀逐字节相等，总发送字符 < baseline×0.7（TESTS/extension.test.ts:126-154）。
- **失败必须 fail-open**：`context`/`tool_call`/`message_end`/`cache_warming_decision`/`showStatus` 全部 `try/catch` 后返回 `undefined`，让 pi 原样继续（TS:1094-1096, 1110-1112, 1216-1219, 1020-1022）。

### 1.3 为什么是"静默提升专注度"，而不只是省 token

这一点决定了所有取舍，实现者必须理解（否则会"优化"掉 preview、recovery、`keepErrors`）：

1. **成本结构**：prompt 的 95.6% 是 cache read，工具结果占其中 29%；陈旧输出被重读数百次。真正贵的是"历史长度"，不是单条结果（README "Why"）。
2. **不能随便改历史**：改旧消息会作废 prompt cache，一次 cache 重写的价格远高于省下的读。所以只在 cache **已经冷**、反正要整段重写的那一刻裁剪（TS:9-12）——此时更短的前缀是**免费**的。这让"省 token"从"有代价的牺牲"变成"零代价的清理"。
3. **但清掉的内容可能是"刚需"**，所以三个安全装置是功能的一部分，不是装饰：
   - stub 保留 **最后 N 行 + 错误行**，退出码/失败原因不丢（TS:268-289）；
   - **recovery meter** 如实报告"你裁掉的东西被要回去了几次、代价多少"，并按工具自动拉黑（TS:729-785）；
   - 陈旧 `write`/`edit` 参数也裁——磁盘上的文件才是真相，旧内容纯属死重（TS:376-443）。
4. **"静默"**：零 prompt token（从不改 system prompt、从不新增消息、磁盘 transcript 不动，TS:14-15）；不打断、不询问、不产生额外模型调用；模型只看到更短的历史 + 一句"它被裁了、需要就重跑"。
5. **"提升专注度"**：留下的都是决策相关信息（路径、命令、错误、末行），删掉的是大段日志噪声；于是上下文预算更多给当前任务，而不是给 200 轮前的构建输出。footer 上的 `−1.9k /req` 只是副产品，`↺n` 与 "recovery" 行才是诚实性证明。
6. **可测的边界**：如果"省 token"是唯一目标，压缩策略会退化成"删得越多越好"，从而破坏（a）错误可见性、（b）`keepTurns` 的近期性、（c）前缀稳定性。上游宁可**少裁**（`minChars` 1500、`keepTurns` 20、错误默认保留、preview 保底）也不破坏这三者。第 3、4、6 节的所有 gate 都是这三条约束的编码。

### 1.4 运行时职责划分（Pi → 可移植核心）

上游把"纯策略"和"Pi API"写在同一个文件里。移植时唯一正确的切法是：

- **纯函数（必须 1:1 复刻，可单测）**：`sanitizeConfig`、`measure`、`lineCount`、`indexCalls`、`describeCall`、`formatSize`、`formatTokens`、`estimateTokens`、`previewOf`、`stubText`、`hasThinking`、`assistantTurnsAfter`、`policyOf`、`eligible`、`lastAssistantTimestamp`、`isCold`、`argChars`、`elideArguments`、`eligibleArgs`、`decide`、`stableStringify`、`callSignature`、`applyElision`、`Calibrator`、`RecoveryMeter`、`describeElided`、`describeCandidates`、`showLines`、`staleTokens`、`statusLine`、`parseCommand`、`completions`、`restoreState`。
- **适配层（平台相关）**：`readConfig/loadConfig/saveConfig/resolveAgentDir`、`context`/`message_end`/`tool_call`/`session_start` 挂载、footer、命令注册、`appendEntry`。

---

## 2. 配置全表（含 sanitize 钳制）

### 2.1 字段、类型、默认值

`DietConfig` 定义 TS:46-81，默认值 TS:83-102。**字段顺序即默认对象的字面顺序**（fuzz 测试用 `Object.keys(DEFAULT_CONFIG)` 生成配置，TESTS/fuzz.test.ts:37）。

| 字段 | 类型 | 默认值 | 语义（源码原文要点） | TS 行 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；关闭时 `context` 直接返回 undefined，footer 置空 | 83-84, 453, 1000-1003 |
| `mode` | `"cold"｜"always"` | `"cold"` | `cold`：只在 cache 已冷时裁（免费）；`always`：只要符合条件就裁（仅用于无 prompt cache 的 provider） | 44, 48-49, 83-85, 455 |
| `keepTurns` | number(int) | `20` | 最近 N 个 assistant 轮次的结果永远保留 | 50-51, 86, 352 |
| `minChars` | number(int) | `1500` | 小于此字符数的结果不值得 stub | 52-53, 87, 356 |
| `cacheTtlMinutes` | number(int) | `5` | prompt cache 生存期；停顿超过它即视为冷 | 54-55, 88, 454 |
| `keepErrors` | boolean | `true` | 保留 `isError` 结果（通常短而重要） | 56-57, 89, 353 |
| `neverElide` | string[] | `[]` | 永不裁剪的工具名 | 58-59, 90, 354 |
| `showStatus` | boolean | `true` | 是否渲染 footer | 60, 91, 1000 |
| `stubTailLines` | number(int) | `3` | stub 保留的末行数 | 61-62, 92, 1076 |
| `stubErrorLines` | number(int) | `3` | stub 保留的错误行数（上限即此值） | 63-64, 93, 1076 |
| `elideArgs` | boolean | `true` | 同时裁剪陈旧 `write` 内容与 `edit` old/new 文本 | 65-66, 94, 459 |
| `autoProtect` | boolean | `true` | 结果反复被重取时，本会话停止裁剪该工具 | 67-68, 95, 1209 |
| `recoveryThreshold` | number(float) | `0.25` | 工具被拉黑所需的重取占比（需足够样本） | 69-70, 96, 1209, 783 |
| `warmArbitration` | boolean | `true` | 允许覆盖 pi 的空闲 cache 保温决策 | 71-72, 97, 1120 |
| `expectedTurns` | number(int) | `30` | 会话预计还剩多少轮，用于保温/停止估计 | 73-74, 98, 1131 |
| `stopWarmingShare` | number(float) | `0.2` | 无模型价格时，陈旧上下文占比达到它即停止保温 | 75-76, 99, 1132 |
| `compact` | boolean | `false` | 用 pi 自己的摘要器压缩空闲大会话（有损，opt-in） | 77-78, 100 |
| `compactAboveTokens` | number(int) | `150_000` | 超过此 token 数的空闲会话才压缩 | 79-80, 101 |

> **本项目（DSH）处理建议**：`compact*`、`warmArbitration`、`expectedTurns`、`stopWarmingShare` 四项在 DSH 没有对应 seam（无 `ctx.compact()` 的宿主摘要器调用面、无 `cache_warming_decision` 事件、无 provider cache TTL 事实）。规格要求：**要么不实现并把这些字段从配置面彻底删除，要么实现但标注"近似"**；不可像现状那样保留默认值 + 在 `statusLine` 里输出"arbitrated"字样却不做任何仲裁。`compact` 明确列为"本项目不做，应删除"（见 11、12 节）。

### 2.2 sanitizeConfig 的钳制规则（TS:104-139）

`clampInt(v,min,max,fallback)`：仅当 `typeof v === "number" && Number.isFinite(v)` 时 `Math.min(max, Math.max(min, Math.round(v)))`，否则 fallback（TS:104-105）。逐字段：

| 字段 | 规则 | 边界（测试断言） | TS 行 |
|---|---|---|---|
| `enabled` | 非 boolean → 默认 `true` | `{enabled:"yes"}` → true（TESTS/core.test.ts:272,277） | 112 |
| `mode` | 非 `"cold"`/`"always"` → `"cold"` | `{mode:"sometimes"}` → "cold"（:272,276） | 113 |
| `keepTurns` | clamp 1..500 | 9999→500；`"ten"`→20；`NaN`→20；`7.6`→8（:272-281） | 114 |
| `minChars` | clamp 200..1_000_000 | 1→200（:274） | 115 |
| `cacheTtlMinutes` | clamp 1..1440 | 0→1（:275） | 116 |
| `keepErrors` | 非 boolean → true | `1`→true（:278） | 117 |
| `neverElide` | 仅 string；`trim()`；去空；`Set` 去重；截断 50；非数组→`[]` | `[" read ","read","",5,null,"bash"]`→`["read","bash"]`；80 项→50 项；`"read"`→`[]`（:292-296） | 118-120 |
| `showStatus` | 非 boolean → true | | 121 |
| `stubTailLines` | clamp 0..10 | 99→10；`"x"`→3（:284-285） | 122 |
| `stubErrorLines` | clamp 0..10 | -4→0（:284） | 123 |
| `elideArgs` | 非 boolean → true | `"yes"`→true（:290） | 124 |
| `autoProtect` | 非 boolean → true | `1`→true（:290） | 125 |
| `recoveryThreshold` | 非有限 number → 0.25；否则 clamp 0.05..1（**不取整**） | 5→1；0→0.05；NaN→0.25；`"high"`→0.25（:286-289） | 126-129 |
| `warmArbitration` | 非 boolean → true | `1`→true（:589） | 130 |
| `expectedTurns` | clamp 1..500 | 9999→500；0→1；`"x"`→30（:587-589） | 131 |
| `stopWarmingShare` | 非有限 number → 0.2；否则 clamp 0.05..0.9 | 5→0.9；0→0.05；NaN→0.2（:587-589） | 132-135 |
| `compact` | 非 boolean → false | `"yes"`→false（:589） | 136 |
| `compactAboveTokens` | clamp 20_000..2_000_000 | 1→20000；9e9→2000000（:587-588） | 137 |

补充不变量（fuzz 断言）：**sanitize 幂等**，且输出里每个字段类型与默认值一致、数字有限且 ≥0（TESTS/fuzz.test.ts:92-103）；`sanitizeConfig(undefined|null|5|"x"|[]|true)` 全部等于 `DEFAULT_CONFIG`（TESTS/core.test.ts:264-266）。实现注意：`Object.freeze` 过的 `DEFAULT_CONFIG` 不能被 `sanitizeConfig` 直接返回（DSH `core.js:53` 冻结了对象，却又返回新对象，OK；但 `readConfig` 的 `toEqual(DEFAULT_CONFIG)` 依赖数组字段的深度相等）。

### 2.3 配置持久化（TS:141-189）——Pi 专属，DSH 用 Schema Config 替代

| 行为 | 细节 | TS 行 |
|---|---|---|
| 路径解析 | `PI_CODING_AGENT_DIR` > `$XDG_CONFIG_HOME/pi/agent` > `~/.pi/agent`；空字符串视为未设置 | 142-146 |
| 文件名 | `<agentDir>/context-diet.json` | 148 |
| 读取 | 文件缺失（ENOENT）→ 默认配置且 **无 problem**；其他读错误 → 默认配置 + `problem: "cannot read <path> (<code>)"` | 154-161 |
| JSON 非法 | 默认配置 + `problem: "<path> is not valid JSON"` | 162-166 |
| 写入 | 原子：`mkdir -p` → 写 `<target>.<pid>.<ts>.tmp` → `rename`；失败时 `rm(tmp)` 后 rethrow | 173-189 |
| 写入格式 | `JSON.stringify(config, null, 2) + "\n"`（文件以 `}\n` 结尾） | 179 |
| 保存失败 | 命令层 catch 后 notify：`context-diet: could not save the setting (<msg>); it applies to this session only`（设置仍对本会话生效） | 1228-1234 |
| session_start 问题提示 | 有 UI 且 `problem` 存在 → notify `<problem>; using the defaults (a /context-diet setting command will overwrite it)`，级别 warning | 1050-1053 |

DSH 侧：使用 Schemastery `Config`（`index.js:77-87`），**没有** `readConfig` 的 problem 语义，也没有原子写；这是允许的替代，但必须保证：配置校验等价于本表 2.2（当前 DSH 不等价，见 12 节 D6）。

### 2.4 常量表

| 常量 | 值 | 用途 | TS 行 |
|---|---|---|---|
| `DEFAULT_CHARS_PER_TOKEN` | `3` | 未校准前的 chars/token（实测 2.0-3.0；用 4 会低估工具输出） | 316-318 |
| `PREVIEW_LINE_CHARS` | `160` | stub 预览单行最大宽度 | 278 |
| `ERROR_LINE` | `/(error\|fail\|exception\|panic\|fatal\|traceback\|assertion)/i` | 错误行识别 | 275 |
| `ALL_CLEAR` | `/\b0 (errors?\|failed\|failures?\|failing)\b/i` | "0 failed / 0 errors" 不算错误行 | 277 |
| `ARG_TOOLS` | `Set(["write","edit"])` | 参数裁剪白名单 | 381 |
| `ENTRY_TYPE` | `"context-diet"` | session custom entry 类型（持久化 id 集合） | 791 |
| `PROTECT_ENTRY_TYPE` | `"context-diet-protect"` | 保护工具 entry | 792 |
| `COMPACT_INSTRUCTIONS` | 见 11.2 | pi 摘要器指令（本项目不做） | 706-707 |
| `COMPACT_COOLDOWN_TURNS` | `20` | 两次压缩之间的最小轮数 | 710 |
| `timing.compactDelayMs` | `750` | agent_end 后延迟再检查（可被测试改小） | 978 |
| `minSample`（`shouldProtect` 默认参） | `5` | 拉黑所需最少样本 | 781 |
| Calibrator 最少样本 | `6` | `measure()` 门槛 | 576 |
| Calibrator 窗口 | `200` | 滚动样本上限 | 566 |
| chars/token clamp | `1.5 .. 8` | | 598 |

---

## 3. 判定流程（gate 顺序与公式）

### 3.1 消息形状与测量

- 只读字段：`role`、`timestamp`、`content`、`toolCallId`、`toolName`、`isError`（TS:196-204）。
- `partsOf(content)`：`Array.isArray(content) ? content : []`（TS:214）。
- `lineCount(s)`：`s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0)`（TS:231）。即**一个结尾换行不算额外行**。
- `measure(content)`（TS:217-229）：
  - `typeof content === "string"` → `{chars: content.length, lines: lineCount(content), textOnly: true}`；
  - 否则遍历 parts：`p.type === "text" && typeof p.text === "string"` → 累加 `p.text.length` 与 `lineCount(p.text)`；**任何其他 part（image、thinking、null、无 text 的 text part）→ `textOnly=false`**；
  - 空/undefined/null content → `{0,0,true}`。
  - 断言：`measure([{text:"a\nb\n"},{text:"c"}]) = {chars:5, lines:3, textOnly:true}`；`measure("")={0,0,true}`；`[{type:"text"}]` → textOnly false；`[null]` → false；图片 → false（TESTS/core.test.ts:14-33）。
  - **注意**：`chars` 是 `String.length`，即 **UTF-16 code unit 计数**。DSH 现状改成码点计数（`core.js:153-157`），会让 `minChars` 边界、`formatSize`、`savedChars` 与上游统计漂移（emoji/CJK 扩展面），必须显式决策（12 节 D2）。
- `indexCalls(messages)`：`toolCallId → {name, args}`，只扫 `role==="assistant"` 且 part 为 `type==="toolCall"` 且 `id`/`name` 都是 string；`args` 缺省 `{}`（TS:234-245）。tolerate 坏 part。
- `describeCall(name,args)`（TS:253-260）：
  - `name === "bash"` → 取 `args.command`；
  - 其他工具 → 依次尝试 `path, file_path, pattern, query, command, url`，取第一个非空 string；
  - 取到后 `clip(label, 80)`，取不到 → `""`。
  - `clip(s,n)`：`s.replace(/\s+/g," ").trim()`，若长度 > n 则 `slice(0, n-1) + "…"`（结果总长恰为 n，**UTF-16 计**）（TS:247-250）。
  - 断言：`describeCall("bash",{command:"a   b\n  c"})==="a b c"`；200 字符命令 → 长度 80 且以 `…` 结尾；`describeCall("weird",{n:5})===""`（TESTS/core.test.ts:51-66）。
- `hasThinking(m)`：content 里存在 `type==="thinking"` 或 `type==="redacted_thinking"` → true（TS:301-303）。**带 thinking 的 assistant 消息绝不改写**（签名需要字节一致）。

### 3.2 轮次年龄：`assistantTurnsAfter`（TS:306-314）

```
ages = new Array(len).fill(0); seen = 0
for i from len-1 downto 0:
    ages[i] = seen
    if messages[i].role === "assistant": seen++
```

- 语义：某消息**之后**还有几条 assistant 消息。
- 断言：`[user, assistant, toolResult, assistant, toolResult]` → `[2,1,1,0,0]`；`[]` → `[]`（TESTS/core.test.ts:95-101）。
- **边界**：`eligible` 用 `ages[i] <= policy.keepTurns` 跳过，即**年龄必须严格大于 keepTurns**。10 轮会话 keepTurns=5 → 前 4 条结果可裁（结果 k 后面有 9-k 个 assistant；9-k>5 → k=0..3）；30 轮 keepTurns=5 → 24 条（TESTS/core.test.ts:106-113, 174-178）。

### 3.3 冷判定

```
lastAssistantTimestamp(messages): 从后往前找 role==="assistant" && typeof timestamp==="number"；没有 → undefined
isCold(messages, now, ttlMs)   : last !== undefined && now - last > ttlMs      // 严格大于
```

TS:362-374。断言：`now+5min` 恰好等于 TTL → **warm**（false）；`now+5min+1` → cold；无 assistant 时间戳 → false（TESTS/core.test.ts:158-164）。ttl 用 `config.cacheTtlMinutes * 60_000`（TS:454）。

### 3.4 `decide` 的 gate 顺序（TS:446-462）

输入：`messages, elided: Set, config, {now, force}, {elidedArgs?, protectedTools?}`。
输出：`{ids: string[], argIds: string[], cold: boolean}`（**恰好这三个键**，测试用 `toEqual`）。

```
1. if (!config.enabled)              return {ids:[], argIds:[], cold:false}
2. cold = isCold(messages, now, cacheTtlMinutes*60_000)
3. if (!(force || cold || mode==="always")) return {ids:[], argIds:[], cold}
4. policy = policyOf(config, extra.protectedTools)
5. ids    = eligible(messages, policy, elided)
6. argIds = config.elideArgs ? eligibleArgs(messages, policy, extra.elidedArgs ?? new Set()) : []
7. return {ids, argIds, cold}
```

- gate 顺序不可交换：`enabled` 先于 cold 判定（因此 disabled 时 `cold` 恒为 `false`，见断言）；`force` 与 `mode==="always"` 并列，任一即可越过 cold。
- 断言：warm → `{ids:[],argIds:[],cold:false}`；cold → ids 24；force → 24 且 `cold` 仍按实际（可能 false）；`mode:"always"` warm → 24；disabled+force → 三个空（TESTS/core.test.ts:171-189）。
- 注意：`cold` 是**事实**，不是"是否生效"；`mode:"always"` 的 warm 请求也会 `cold:false`，因此不计 `coldStarts`。

### 3.5 `eligible` 内部 gate 顺序（TS:347-360）

遍历消息，命中下列任一即**跳过**（顺序即源码顺序，`already`/age 最先）：

| # | 条件 | 细节 | 行 |
|---|---|---|---|
| 1 | `role !== "toolResult"` 或 `typeof toolCallId !== "string"` | 非结果 / 无 id 直接忽略 | 351 |
| 2 | `already.has(toolCallId)` | 已裁剪过的不再选 | 352 |
| 3 | `ages[i] <= keepTurns` | 近期结果保留 | 352 |
| 4 | `m.isError && keepErrors` | 错误结果保留（`keepErrors:false` 时才可裁） | 353 |
| 5 | `m.toolName && neverElide.has(m.toolName)` | 保护名单；结果**没有** `toolName` 时逃过此 gate（测试锁定） | 354 |
| 6 | `!size.textOnly` | 富内容（图片等）永不裁 | 355-356 |
| 7 | `size.chars < minChars` | 小于阈值不裁；**恰好等于阈值可裁** | 356 |

- 断言：999 字符不裁、1000 字符裁（minChars=1000）（TESTS/core.test.ts:117-123）；`isError:true` 默认不裁，`keepErrors:false` 才裁（:124-129）；`neverElide:["read"]` 时 read 结果不裁，带 image 的结果也不裁（:130-137）；已 elided 的不再选；无 `toolCallId` 的 toolResult 不抛异常；**删掉第一条结果的 toolName 后，只有它能逃过 `neverElide:["bash"]`**（:145-149）。
- `policyOf`：`neverElide: new Set([...c.neverElide, ...protectedTools])`（TS:339-344）——运行期保护名单与配置名单合并，无优先级差别。

### 3.6 `eligibleArgs`（write/edit 参数裁剪，TS:421-443）

预扫描：遍历 `toolResult` 建立 `answered = Set(toolCallId)` 与 `failed = Set(toolCallId)`（`isError`）。

逐条遍历 `assistant` 消息，按顺序跳过：

| # | 条件 | 语义 | 行 |
|---|---|---|---|
| 1 | `ages[i] <= keepTurns` | 近期调用保留 | 432 |
| 2 | `hasThinking(m)` | 带签名 thinking 的消息整体不得改动 | 433 |
| 3 | 对每个 part：非 `toolCall` / `id` 或 `name` 非 string | 忽略坏 part | 435 |
| 4 | `!ARG_TOOLS.has(name)` | 只处理 write/edit | 436 |
| 5 | `neverElide.has(name)` | 配置/运行期保护的工具名 | 436 |
| 6 | `already.has(id)` | 已裁参数不再选 | 436 |
| 7 | `!answered.has(id) \|\| failed.has(id)` | **未回答或失败**的调用可能被重试 → 保留 | 437 |
| 8 | `argChars(name, args) < minChars` | 参数字数不够不裁 | 438 |

`argChars`（TS:392-398）：`write` → `strLen(args.content)`；否则 `strLen(args.oldText)+strLen(args.newText)`，再累加 `args.edits[*].oldText/newText`（兼容两种 edit 形状）。`strLen` = `typeof v === "string" ? v.length : 0`。

断言：会话前 4 组（write 大、edit 大、write 小、write 失败）+ 8 轮旧对话 → 只选前两个（TESTS/core.test.ts:407-421）；带 thinking 的 assistant 里两个调用都不选，只有另一个 assistant 的 edit 选（:423-432）；`m.slice(0,7)` 不够老 → `[]`；`neverElide:["write"]` → 只剩 edit；`already` 生效（:444-450）；bash/unanswered/无参数 part 都被忽略（:451-460）。
`decide` 联动：cold 时 `argIds` 长度 2；`elideArgs:false` → 0；`protectedTools:["write"]` → 1；把已选 argIds 传入 → 0（TESTS/core.test.ts:485-493）。

### 3.7 `applyElision` 的二次校验与输出契约（TS:494-536）

```
if (elided.size===0 && argIds.size===0) return {messages, 0,0,0, []}     // 同一数组引用
calls = indexCalls(messages)
out = messages.map(m => {
  if (m.role==="toolResult" && toolCallId in elided):
      size = measure(m.content)
      if (!size.textOnly) return m                    // 二次校验：富内容不动
      call = calls.get(id)
      tool = m.toolName ?? call?.name ?? "tool"       // 回调丢失时回退
      preview = opts.preview ? previewOf(m.content, tail, errors) : undefined
      text = stubText(tool, call ? describeCall(call.name, call.args) : "", size.chars, size.lines, preview)
      count++
      savedChars += max(0, size.chars - text.length)
      if (call) infos.push({id, tool, sig: callSignature(call.name, call.args), chars: size.chars})
      return {...m, content: [{type:"text", text}]}   // 只改 content
  if (m.role==="assistant" && argIds.size>0 && Array.isArray(m.content) && !hasThinking(m)):
      ... 对每个 toolCall part：if (!argIds.has(id) || !arguments) 原样；before=JSON.stringify(args).length；next=elideArguments(...)；if (next===args) 原样；changed=true；argCount++；savedChars += max(0, before - JSON.stringify(next).length)；返回 {...p, arguments: next}
      return changed ? {...m, content} : m
  return m
})
if (count+argCount === 0) return {messages, 0,0,0, []}   // 同一数组引用
return {messages: out, count, argCount, savedChars, infos}
```

- `infos` 只在**能找到原调用**时记录（`call` 存在），供 recovery meter 使用；被 compaction 抹掉调用的结果仍会被 stub（用 `toolName` 回退），但不会进 infos（TS:510-517）。
- 断言：10 轮会话裁 4 条，`savedChars > 4*3000`；未命中的消息是**同一对象**；`applyElision(m, new Set())` 与 `applyElision(m, new Set(["no-such-id"]))` 都返回**原数组引用**；两次调用 JSON 字节相同；stub 里出现 `read src/big.ts`；调用丢失时回退 `grep` / `tool`（TESTS/core.test.ts:192-244）。
- `savedChars` 永不为负（小结果被 stub 时是 0，而不是跳过）：`applyElision` 仍会替换并计数（TESTS/core.test.ts:239-243）。**注意这与 DSH 现状的"stub 必须更小、否则跳过"不同**（12 节 D10）。

### 3.8 判定流程的"证据表"（实现后用这些数值自测）

| 场景 | 输入 | 期望 | 出处 |
|---|---|---|---|
| warm 不裁 | 30 轮，now = endTs+1min | `decide` 空、cold=false | TESTS/core.test.ts:171-173 |
| cold 全裁 | 30 轮，now = endTs+10min，keepTurns 5 | ids = 24 | :174-178 |
| force 越过 warm | 同上但 force | ids = 24 | :179-181 |
| always 越过 warm | mode always | ids = 24 | :181 |
| disabled 优先 | enabled false + force + cold | 全空、cold=false | :183-185 |
| 幂等 | 把首次结果作为 already | ids = [] | :186-189 |
| 端到端 | pi 层 30 轮 | 24 个 stub、一次 appendEntry、cold=true、footer 有 🥗 | TESTS/extension.test.ts:92-104 |
| warm 期间集合冻结 | 首请求后 +1min，会话增长 3 轮 | 前段字节相同、仍 24 个 stub、无新 entry | :106-118 |
| 再次停顿 | 再 +20min | stub 数 >24、第 2 个 entry | :119-124 |

---

## 4. stub 渲染精确规则

### 4.1 `stubText`（TS:292-298）——逐字模板

```js
what = label ? `${name} ${label}` : name
out  = `[pi-context-diet: the output of ${what} (${formatSize(chars)}, ${lines} lines) was elided from the context to save tokens. Re-run it if you need it again.`
if (preview?.errors.length) out += `\nerror lines:\n${preview.errors.map(l => `  ${l}`).join("\n")}`
if (preview?.tail.length)   out += `\nlast lines:\n${preview.tail.map(l => `  ${l}`).join("\n")}`
return out + "]"
```

硬性要点：

1. 前缀固定 `[pi-context-diet: `，结尾固定 `]`，**整个 stub 是一段文本**（无换行结尾）。
2. 头部固定句式：`the output of <what> (<size>, <N> lines) was elided from the context to save tokens. Re-run it if you need it again.`
3. **errors 段在 tail 段之前**；每段标题行 `error lines:` / `last lines:`；每条预览行前**两个空格**。
4. 两段都为空/未传 preview → 只有一行头部（"bare stub"）。
5. `what`：有 label 用 `<tool> <label>`；无 label 只用 tool 名。
6. 确定性：同样输入逐字节相同；`stubText("bash","cargo test",12345,240)` 与 `stubText("x","",1,1,{tail:[],errors:[]})` 分别断言相同/等价（TESTS/core.test.ts:84-92, 352-360）。

断言原文（可直接当快照测试）：

| 输入 | 期望片段 | 出处 |
|---|---|---|
| `stubText("bash","cargo test",12345,240)` | 以 `[pi-context-diet: the output of bash cargo test (12.3 KB, 240 lines)` 开头；含 `Re-run it`；结尾 `]` | TESTS/core.test.ts:85-91, 353-358 |
| `stubText("grep","",1,1)` | 含 `output of grep (` | :91 |
| `stubText("bash","cargo test",5000,120,previewOf(log,2,2))` | 以 `[pi-context-diet: the output of bash cargo test (5.0 KB, 120 lines)` 开头 | :353-354 |
| 同上 | 含 `error lines:\n  error[E0432]`；含 `last lines:\n  BUILD FAILED in 4s\n  exit code 1`；`error lines:` 在 `last lines:` 之前；结尾 `]` | :355-358 |
| `applyElision` 后 | stub 含 `error: link failed` 与 `exit 2`；`savedChars > body.length*0.8` | :361-372 |

### 4.2 `previewOf`（TS:281-289）——tail / error 选择算法

```
if (tailLines <= 0 && errorLines <= 0) return {tail:[], errors:[]}
text = typeof content==="string" ? content
     : parts.map(p => p?.type==="text" && typeof p.text==="string" ? p.text : "").join("\n")
lines = text.split("\n").map(l => l.trim()).filter(Boolean)     // 去空行、逐行 trim
clipLine(l) = l.length > 160 ? l.slice(0,159)+"…" : l
tail   = tailLines  > 0 ? lines.slice(-tailLines).map(clipLine) : []
errors = errorLines > 0
         ? lines.filter((l,i) => ERROR_LINE.test(l)
                              && !ALL_CLEAR.test(l)
                              && !(tailLines > 0 && i >= lines.length - tailLines))
                .slice(-errorLines)
                .map(clipLine)
         : []
```

- **tail**：末 N 行（N=stubTailLines）。
- **errors**：全文中匹配 `ERROR_LINE`、且不匹配 `ALL_CLEAR`、且**不在 tail 覆盖范围内**（避免重复）的行，按原顺序取**最后** M 行（M=stubErrorLines）。即 error 段是"从尾部往前"的最近 M 条。
- **越界保护**：`slice(-N)` 自然截断；不存在的行不会产生空串。
- 断言：log 7 行 → `previewOf(text(log),2,0).tail = ["BUILD FAILED in 4s","exit code 1"]`；`(1,5)` → tail `["exit code 1"]`、errors `["error[E0432]: unresolved import `x`","BUILD FAILED in 4s"]`；`(0,1)` → errors `["BUILD FAILED in 4s"]`（TESTS/core.test.ts:320-330）。
- 断言：`previewOf(text(log),0,0)` 空；字符串输入可用；`null`/`[{type:"image"},{type:"text"}]`/`""` → 空；空白行被去掉（`"\n\n  ok  \n\n"+"x".repeat(300)` → tail[0]==="ok"）；超长行截成恰好 160 且以 `…` 结尾（:331-343）。
- 断言：错误识别覆盖 `Error:`、`TypeError:`、`Traceback`、`AssertionError`、`UnhandledException`、`test failed`（注意大小写不敏感 + 子串匹配，`UnhandledException` 命中 `exception`）（:344-347）。
- 断言：`"12 passed, 0 failed"`、`"0 errors"`、`"0 failures found"` 不算错误行；`"3 failed, 9 passed"` 算（:348-351）。
- fuzz 不变量：`p.tail.length <= tailLines`、`p.errors.length <= errorLines`；每行 ≤160 字符、不含 `\n`、已 trim、非空（TESTS/fuzz.test.ts:169-183）。

### 4.3 大小与 token 格式化

| 函数 | 规则 | 断言 | 行 |
|---|---|---|---|
| `formatSize(chars)` | `>=1e6` → `(x/1e6).toFixed(1)+" MB"`；`>=1000` → `(x/1000).toFixed(1)+" KB"`；否则 `` `${chars} B` `` | 500→`500 B`；1500→`1.5 KB`；2_500_000→`2.5 MB` | 262-266；TESTS/core.test.ts:70-74 |
| `formatTokens(n)` | `>=1e9` → 2 位 + `B`；`>=1e6` → 2 位 + `M`；`>=1e3` → 1 位 + `k`；否则 `String(n)` | 950→`950`；212_000→`212.0k`；5_100_000→`5.10M`；3_300_000_000→`3.30B` | 320-325；:75-79 |
| `estimateTokens(chars,cpt=3)` | `Math.round(chars/cpt)` | 4000→1333；4000,4→1000 | 317-318；:80-82 |

格式化函数必须对任意非负数不产出 `NaN`（fuzz TESTS/fuzz.test.ts:185-191）。

### 4.4 参数占位符 `elidedArg`（TS:400-403）

```
`[pi-context-diet: ${lineCount(text)} lines (${formatSize(text.length)}) of ${path || "the file"} elided; the file on disk is authoritative]`
```

- `elideArguments`（TS:406-418）：`write` → 只替换 `content`（非 string 则原样返回**同一对象**）；`edit` → 复制对象，替换 `oldText`/`newText`（若为 string），`edits` 数组逐项替换（保留其他键；非对象项原样）。
- `path` 取 `args.path` 或 `args.file_path`，都无 → `"the file"`。
- 断言：`String(w.content)` 含 `pi-context-diet` 与 `src/a.ts`，长度 <200；`e.edits[0].oldText/newText` 含标记；`elideArguments("write",{path:"p"})` 与输入深度相等；junk edits 原样；`file_path` 生效；无 path → 含 `the file`（TESTS/core.test.ts:389-404）。
- `applyElision` 对参数的 `savedChars` 用 `JSON.stringify(before).length - JSON.stringify(after).length`，clamp ≥0（TS:523-528）。
- 断言：两次 apply 输出字节相同、`argCount=2`、`count=0`、`savedChars>7000`、原对象未被修改（deepFreeze）（TESTS/core.test.ts:462-480）。
- **带 thinking 的 assistant 消息整体不参与**（`applyElision` 里再判一次）；断言 `argCount=1` 且第一个 assistant 是同一对象（:433-443）。

### 4.5 裁剪宽度的实现约束

- stub 宽度没有上限（`stubTailLines`/`stubErrorLines` 各 ≤10、单行 ≤160，因此最坏约 1 头 + 10×2 行 ≈ 2-3 KB），上游**不**因 stub 比原结果大而放弃（只有 `savedChars` clamp 到 0）。
- 预览行 `trim()` 后输出，因此缩进信息会丢；`describeCall` 的 label 会折叠内部空白。

---

## 5. Calibrator

### 5.1 目的与公式（TS:552-600）

从"本次请求发送的字符数"与"provider 计费的 input token 数"的样本对，拟合 `tokens ≈ intercept + slope*chars` 的**斜率**，**截距（固定 system prompt）自然消掉**。因为要的是 chars/token，代码直接算 `sxx/sxy`（即 `slope` 的倒数）：

```
points: Array<[chars, tokens]>   // 最多 200 对，超出 shift 掉最旧
add(chars, tokens):
    if chars>0 && tokens>0 && Number.isFinite(chars) && Number.isFinite(tokens): points.push
    if points.length > 200: points.shift()
samples() = points.length

measure():
    n = points.length; if n < 6: return undefined
    mx = mean(x); my = mean(y)
    sxx = Σ(x-mx)^2 ; sxy = Σ(x-mx)(y-my)
    slope = sxx / sxy
    if sxx===0 || sxy<=0 || !Number.isFinite(slope) || slope<=0: return undefined
    return slope

isMeasured() = measure() !== undefined
charsPerToken() = measure() === undefined ? 3 : clamp(measure(), 1.5, 8)
```

### 5.2 退化行为

| 情形 | 行为 | 断言 |
|---|---|---|
| 样本 <6 | 用 3；`isMeasured()===false` | 5 个样本仍返回 3（TESTS/core.test.ts:599-604） |
| tokens 不随 chars 变化（常数） | `sxx>0` 但 `sxy≈0` → 非有限/≤0 → undefined → 3 | :633-636 |
| 负相关 | `sxy<0` → undefined → 3 | :630-632 |
| chars 全相同 | `sxx===0` → undefined → 3 | :626-635 |
| 单点 Infinity/NaN | `add` 直接丢弃，不污染后续 | TESTS/fuzz.test.ts:299-310 |
| 巨大数值溢出 | `measure` 返回 undefined，不返回 NaN | 同上 |
| 正常拟合 | 12 个样本、tokens=20000+chars/2.5 → `charsPerToken()≈2.5`，`isMeasured()===true` | TESTS/core.test.ts:605-611 |
| clamp 下界 | tokens=chars*5（斜率 5 token/char）→ 1.5 | :612-615 |
| clamp 上界 | 20 样本、chars=100k*i、tokens=20000+1000*i → 8 | :616-618 |
| 滚动窗口 | 250 次 add → `samples()===200` | :637-641 |
| fuzz 不变量 | `charsPerToken()` 永远 finite 且在 [1.5,8] | TESTS/fuzz.test.ts:320-331 |

### 5.3 接入点（TS:1099-1114）

- **每次发请求**（`context` 事件末尾，TS:1077）：`pendingChars = charsOfMessages(result.messages)`——注意是 `applyElision` **之后**真正要发送的消息内容字符数（`charsOfMessages`：string 取 length，其余 `JSON.stringify(content).length`，TS:543-550）。
- **每次 assistant 消息结束**（`message_end`，TS:1101-1114）：
  ```
  if (m.role !== "assistant") return undefined        // 只观察 assistant
  turnsSinceCompaction++                              // 压缩冷却计数（本项目不做）
  tokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  if (pendingChars > 0 && tokens > 0) calibrator.add(pendingChars, tokens)
  pendingChars = 0                                    // 无论是否采用都清零
  return undefined                                    // 绝不能返回消息（否则会替换消息）
  ```
- 断言：status 在 0 样本时显示 `3.00 chars/token assumed (calibrating: 0 of 6 requests)`；11 个 3000 字符请求后显示 `2.50 chars/token measured from 11 requests`（TESTS/extension.test.ts:507-519）；固定 token 数（5200）→ `3.00 chars/token assumed (the provider's usage did not vary with context size)` 且**不含** `measured`（:521-530）；非 assistant、无 usage、junk 都不抛异常且返回 undefined（:532-541）。

### 5.4 使用点

`cpt()` 只用于**展示与估算**：footer（TS:1018）、statusLine（TS:954）、showLines（TS:643）、staleTokens（TS:658）。它**不**影响裁剪决策（决策用字符阈值），因此校准失败不影响正确性，只影响显示的美观程度。

> **DSH 注意**：若 DSH 拿不到 provider 计费 token（只有本地估计），则 Calibrator 无法 measured。此时正确做法是**保留 `samples/measured` 语义但永远不声明 measured**，或整体删除并把所有 token 数字标注为 "estimated (3 chars/token)"。**不允许**用本地估计喂给 Calibrator 再宣称 measured。

---

## 6. RecoveryMeter

### 6.1 状态（TS:734-749）

| 字段 | 结构 | 含义 |
|---|---|---|
| `bySig` | `Map<sig, ElidedInfo[]>` | 同一签名的所有已裁剪副本 |
| `tracked` | `Set<id>` | 已登记的结果 id（幂等键） |
| `counted` | `Set<id>` | 已被某次 re-fetch"偿还"的 id |
| `perTool` | `Map<tool, {elided, recovered}>` | 按工具统计 |
| `recovered` | number | 重取事件数（不是结果数） |
| `recoveredChars` | number | 重取代价（命中的那条原始字符数） |

`ElidedInfo = {id, tool, sig, chars}`；`sig = callSignature(name, args) = \`${name}:${stableStringify(args ?? {})}\``，`stableStringify` 对对象键排序（TS:469-478）。断言：同一调用不同键序签名相同；不同 path 或不同工具名签名不同；`callSignature("x", undefined) === "x:{}"`（TESTS/core.test.ts:496-509）。

### 6.2 `track(infos)`——幂等（TS:752-761）

```
for info of infos:
    if tracked.has(info.id) continue
    tracked.add(info.id)
    (bySig.get(sig) ?? bySig.set(sig, []).get(sig)).push(info)
    perTool[tool].elided++          // 该工具被裁剪的结果数 +1
```

- **调用方每次请求都传入"当前所有已裁剪结果"**；去重靠 `tracked`。
- 断言：`track([a]); track([a])` → `elided()===1`、`perTool.bash.elided===1`（TESTS/core.test.ts:533-539）。

### 6.3 `onCall(tool, args)`——命中与"一次偿还"（TS:764-774）

```
matches = bySig.get(signature(tool,args))
hit     = matches?.find(m => !counted.has(m.id))
if (!hit) return undefined
for m of matches: counted.add(m.id)        // 一次调用偿还同签名的所有副本
recovered++ ; recoveredChars += hit.chars
perTool[hit.tool].recovered++              // 记到命中的那条的工具名下
return hit
```

- 语义：agent 重新执行**完全相同**的调用，说明被裁的那条输出又被需要了。同签名有多个副本时，一次调用只算一次（避免高估）。
- 断言：命中后 `recovered=1`、`recoveredChars=4000`、`perTool={bash:{1,1}, read:{1,0}}`、再次 `onCall` 同参 → undefined（已 counted）（TESTS/core.test.ts:514-525）；不同命令/不同工具 → undefined 且 `recovered` 不变（:526-532）；两个同签名副本 → 一次命中后第二次 undefined（:540-546）。

### 6.4 `elided()` 与 `shouldProtect`（TS:776-784）

```
elided() = tracked.size
shouldProtect(tool, threshold, minSample = 5) =
    perTool[tool] 存在
 && perTool[tool].elided >= minSample
 && perTool[tool].recovered / perTool[tool].elided > threshold      // 严格大于
```

- 断言：8 条 bash 结果全裁，2 条重取 → 2/8=25% **不**触发 (`>` 而非 `>=`)；3/8 触发；threshold 0.5 时 3/8 不触发；`minSample=20` 时样本不足 → false；未知工具 → false（TESTS/core.test.ts:547-558）。

### 6.5 接入与副作用（TS:1202-1220）

`pi.on("tool_call")`（只观察，永不阻断；返回 `undefined`）：

```
if (!config.enabled) return undefined
hit = meter.onCall(event.toolName, event.input)
if (!hit) return undefined
if (config.autoProtect && !protectedTools.has(hit.tool)
    && meter.shouldProtect(hit.tool, config.recoveryThreshold)) {
    protectedTools.add(hit.tool)
    pi.appendEntry(PROTECT_ENTRY_TYPE, {tool: hit.tool, at: Date.now()})
    const t = meter.perTool.get(hit.tool)
    if (ctx.hasUI) ctx.ui.notify(
        `context-diet: protecting ${hit.tool} results for the rest of the session (${t.recovered} of ${t.elided} elided ones were re-fetched)`,
        "warning")
}
showStatus(ctx)         // 只有命中时才刷新 footer
return undefined
```

- 保护只影响**后续**选择：`policyOf` 会把 `protectedTools` 并入 `neverElide`；**已裁剪的不回滚**（前缀稳定优先）。
- 断言：recoveryThreshold 0.1 时 2 次重取（2/24=8.3%）不保护、3 次（12.5%）保护一次、`data.tool==="bash"`、notify 含 `protecting bash results for the rest of the session`、`/context-diet` 显示 `protected: bash`；下次 cold start 不再裁 bash，已裁的 24 条仍是 stub（TESTS/extension.test.ts:372-391）；`autoProtect:false` 时只计数不保护，footer 仍有 `↺6`（:393-399）；重取 1 次后 footer `↺1`，status 显示 `recovery: 1 of 24 elided results re-fetched (4%`（:353-360）；不匹配的调用不计数（:362-370）；无 UI 时不 notify 但仍保护并 append（:410-424）；junk event/坏 UI 不抛（:410-417）；每次 track 只统计**插件自己 stub 的**结果（infos 只来自 `applyElision`，见 3.7）。

---

## 7. Stats 字段与更新时机

### 7.1 字段与初值（TS:927-938）

| 字段 | 初值 | 含义 |
|---|---|---|
| `requests` | 0 | **发生裁剪**的请求数 |
| `cumulativeChars` | 0 | 本会话累计节省字符数 |
| `lastChars` | 0 | 最近一次请求节省字符数 |
| `lastCount` | 0 | 最近一次请求裁剪的结果条数 |
| `lastArgCount` | 0 | 最近一次请求裁剪的参数条数 |
| `coldStarts` | 0 | 发生"冷启动决策"的次数 |
| `warmStops?` | 缺省 | 停止保温次数（本项目不做） |
| `compactions?` | 缺省 | 压缩次数（本项目不做） |

### 7.2 更新矩阵（唯一实现位置：`context` handler，TS:1063-1097）

| 时机 | 条件 | 动作 | 行 |
|---|---|---|---|
| session_start | 总是 | 全新 `emptyStats()`（重启清零） | 1040 |
| decide 产出非空 | `ids.length>0 \|\| argIds.length>0` | 并入集合；`appendEntry(ENTRY_TYPE, {ids, argIds, cold, at})`；`decision.cold` → `coldStarts++` | 1069-1074 |
| 每次 enabled 请求 | 总是 | `force = false` | 1075 |
| apply 后 | `pendingChars` 总是更新 | `pendingChars = charsOfMessages(result.messages)` | 1077 |
| 本次请求无 stub | `count + argCount === 0` | **`lastCount=0; lastArgCount=0; lastChars=0`**；刷新 footer；返回 undefined；**不** `meter.track`、**不** `requests++`、**不**加 `cumulativeChars` | 1078-1085 |
| 有 stub | 否则 | `meter.track(infos)`；`requests++`；`lastCount=count`；`lastArgCount=argCount`；`lastChars=savedChars`；`cumulativeChars += savedChars`；刷新 footer；返回新消息 | 1086-1093 |

### 7.3 "本轮已无 stub 则清零"规则（必须单测）

- 语义：某次请求里**没有任何**已裁剪内容（例如历史被 compaction 换成了摘要），footer 不能再显示旧收益；`last*` 归零，但 `cumulativeChars`/`requests`/`coldStarts` **保留**（历史事实）。
- 断言：先裁 24 条 → footer 含 `/req`；随后请求一个 3 轮短会话（无任何 stub）→ 返回 undefined，footer **不含** `/req`，`/context-diet` 显示 `this session: 0 results elided`（TESTS/extension.test.ts:822-831）。
- 注意顺序：`coldStarts` 的 `++` 发生在清零分支之前，因此"冷启动但本次请求无可裁项"（例如 `minChars` 全不满足）仍可能 `coldStarts+1`，而 `last*` 为 0、`requests` 不变。这是上游既有语义，不要"修正"。

### 7.4 与 footer 的关系

footer 的两形态判据就是 `stats.lastCount + stats.lastArgCount === 0`（TS:1008），因此 7.2 的清零规则直接决定 footer 形态；`stats.lastChars` 只有 `>0` 时才有意义（形态 B 显示 `−x`）。

---

## 8. footer 状态行

### 8.1 前置条件与 setStatus key（TS:997-1023）

```
showStatus(ctx):
  try:
    if (!ctx.hasUI) return                       // 无 UI：完全不调用 setStatus（测试断言 statuses===[]）
    if (!config.enabled || !config.showStatus):
        ctx.ui.setStatus("context-diet", "")     // 置空
        return
    ...见下
  catch: ignore                                  // UI 异常绝不改变发给模型的内容
```

- key 固定 `"context-diet"`（不是插件名 `dsh-context-diet`，也不是别的）。
- 断言：无 UI → `statuses` 为空数组；`showStatus:false` → 所有 status 都是 `""`；`enabled:false` → 最后一条是 `""`（TESTS/extension.test.ts:210-217, 447-461）；UI 抛异常时结果仍被裁剪（:203-208）；session_start 遇到坏 UI 不崩（:219-221, 485-491）。

### 8.2 形态 A：本次请求没有已裁剪内容（`lastCount+lastArgCount===0`）

```
warn    = config.mode === "always" ? theme.fg("warning", " ⚠ mode always") : ""
compact = config.compact ? theme.fg("dim", ` · compact ≥${formatTokens(compactAboveTokens)}`) : ""
next = lastMessages
     ? staleTokens(lastMessages, policyOf(config, protectedTools), elided, elidedArgs, config.elideArgs, cpt())
     : 0
text = next > 0
     ? `${fg("accent", `−${formatTokens(next)}`)} ${fg("dim", "at the next pause")}`
     : fg("dim", "on")
setStatus("context-diet", `${fg(warn ? "warning" : "success", "🥗")} ${text}${compact}${warn}`)
```

- **`next` 是"下一次冷启动会裁掉多少 token"**：`staleTokens` = `estimateTokens(Σ describeCandidates(...).chars, cpt)`（TS:652-664），候选即"通过全部 gate 且尚未裁剪"的结果 + （`elideArgs` 时）参数。
- 断言：session start（尚未有请求）→ 含 `"on"`、不含 ⚠；warm 请求后（有 24 条待裁）→ 匹配 `/🥗 −\d/` 且含 `"at the next pause"`；再请求一个没有任何陈旧内容的短会话 → 含 `"on"`、不含 `"at the next pause"`（TESTS/extension.test.ts:463-472）。
- 断言：compact on 时含 `compact ≥120.0k` / `≥150.0k`；compact off 时不含 `compact`（:474-483）。
- 注意：`next` 用 `protectedTools` 与 `elided`/`elidedArgs` 一起过滤，所以被保护工具不会再显示"下次可省"。

### 8.3 形态 B：本次请求有已裁剪内容（`lastCount+lastArgCount>0`）

```
recovered = meter.recovered > 0 ? fg("warning", ` ↺${meter.recovered}`) : ""
setStatus("context-diet",
  `${fg("success","🥗")} ${fg("accent", `−${formatTokens(estimateTokens(stats.lastChars, cpt()))}`)} ` +
  `${fg("dim", `/req · ${formatTokens(estimateTokens(stats.cumulativeChars, cpt()))} saved`)}` +
  `${recovered}${compact}${warn}`)
```

- 拼接顺序：`🥗 ` → `−X` → 空格 → `/req · Y saved` → `↺n`（带前导空格）→ ` · compact ≥Z`（带前导空格）→ ` ⚠ mode always`（带前导空格）。
- `X = estimateTokens(lastChars, cpt)`；`Y = estimateTokens(cumulativeChars, cpt)`；两者都用**当前** `cpt()`（校准后数字会变，属预期）。
- 断言：裁剪后 footer 含 `🥗`；`↺1`（重取 1 次后）；`/req`；`−`（TESTS/extension.test.ts:92-104, 353-360, 474-483, 822-831）。

### 8.4 颜色语义（`ctx.ui.theme.fg(color, text)`）

| 颜色 | 用途 | 语义 |
|---|---|---|
| `success` | `🥗`（形态 B），形态 A 无警告时的 `🥗` | 正常/省钱中 |
| `warning` | 形态 A 有 `⚠` 时的 `🥗`；`↺n`；` ⚠ mode always` | 需要人注意（缓存被反复重写 / 裁剪被要回） |
| `accent` | `−X`（两形态） | 数字/收益 |
| `dim` | `at the next pause` / `on` / `/req · Y saved` / ` · compact ≥Z` | 次要说明 |

**`⚠ mode always` 触发条件**：`config.mode === "always"`（与 enabled/showStatus 无关，但二者为 false 时整行不显示）；字符串**逐字**为 `" ⚠ mode always"`（含 U+26A0 + 空格 + 小写 `mode always`，前导空格）。断言：always 模式在**任何裁剪发生之前**就含 `⚠ mode always`；裁剪后仍含；cold 模式不含 `⚠`；从命令切到 always 后立即出现、切回 cold 后消失（TESTS/extension.test.ts:439-445, 493-500）。

### 8.5 与 session_start 的联动（TS:1032-1060）

- session_start 末尾调用一次 `showStatus(ctx)`（TS:1049），因此**尚未有请求时 footer 就存在**：形态 A + `on`（`lastMessages` 为 undefined → `next=0`）。
- 若 `enabled && mode==="always"` 且有 UI → notify：
  `context-diet: mode is 'always', which rewrites the prompt cache on every pass. Use it only without prompt caching; switch back with /context-diet mode cold`（warning）（TS:1054-1056）。
- 断言：always 启动后 `notes.at(-1)` 含 `mode is 'always'` 与 `/context-diet mode cold`（TESTS/extension.test.ts:433-437）；default cold 启动 `notes` 为空（:447-452）。

---

## 9. 命令集、输出文本、autocomplete

### 9.1 `parseCommand(args)`（TS:834-877）

规范化：`(args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)` → `[cmd, p1]`，多余参数忽略。

| 输入（规范化后） | 结果 | 说明 |
|---|---|---|
| 无 / `""` / `"status"` | `{kind:"status"}` | 默认 |
| `on` / `enable` | `{kind:"on"}` | 别名 |
| `off` / `disable` | `{kind:"off"}` | 别名 |
| `now` | `{kind:"now"}` | |
| `keep <n>` | `Number.isInteger(n) && 1<=n<=500` → `{kind:"keep",turns:n}`，否则 invalid | `keep 1.5`/`keep 0`/`keep 501`/`keep x` invalid（TESTS/commands.test.ts:15-18） |
| `ttl <n>` | 整数 1..1440 → `{kind:"ttl",minutes:n}`，否则 invalid | `ttl 1441`/`2.5` invalid（:24-29） |
| `mode <cold\|always>` | 精确匹配 → `{kind:"mode",mode}`，否则 invalid | 大小写不敏感（:30-35） |
| `show` | `{kind:"show"}` | |
| `compact <on\|off\|now>` | `{kind:"compact",action}`，否则 invalid | （本项目不做） |
| `args <on\|off>` | `{kind:"args",on: p1==="on"}`，否则 invalid | |
| 其他 | `{kind:"invalid", message: \`Unknown option "${cmd}". ${USAGE}\`}` | |
| `keep/ttl/mode/args/compact` 缺参数 | invalid + 对应 Usage 文本 | 单行 `Usage: /context-diet keep <turns> (1 to 500)` 等 |

`USAGE`（TS:831-832，逐字）：

```
Usage: /context-diet [status] · on · off · now · keep <turns> · ttl <minutes> · mode <cold|always> · args <on|off> · show · compact <on|off|now>
```

其它 invalid 文案：`Usage: /context-diet keep <turns> (1 to 500)`、`Usage: /context-diet ttl <minutes> (1 to 1440)`、`Usage: /context-diet mode <cold|always>`、`Usage: /context-diet args <on|off>`、`Usage: /context-diet compact <on|off|now>`（TS:852, 858, 863, 869, 873）。

### 9.2 命令 handler 行为（TS:1222-1308）

`persist()`（TS:1228-1235）：`saveConfig(config)` 成功或失败后**总是** `showStatus(ctx)`；失败 notify warning `context-diet: could not save the setting (<msg>); it applies to this session only`。

| 命令 | 副作用 | notify 文本（逐字，级别 info） | 行 |
|---|---|---|---|
| `status`（默认） | 无 | `statusLine(config, stats, summary(), {charsPerToken, samples, measured})` | 1237-1239 |
| `show` | 无 | 无请求时 `context-diet: nothing to show yet (no request has been made)`；否则 `showLines("elided now", now, 8, cpt)` + `showLines("next cold start would elide", next, 5, cpt)` 用 `\n` 连接 | 1240-1249 |
| `on` | `config.enabled=true`，persist | `context-diet on` | 1268-1273 |
| `off` | `config.enabled=false`，persist | `context-diet off (the next request sends the full history again)` | 同上 |
| `now` | `force = true` | `context-diet: stale results will be elided on the next request (this one request rewrites the cache)` | 1274-1277 |
| `keep n` | `config.keepTurns=n`，persist | `context-diet: keeping the results of the last <n> assistant turns` | 1278-1282 |
| `ttl n` | `config.cacheTtlMinutes=n`，persist | `context-diet: prompt cache assumed to expire after <n> min` | 1283-1287 |
| `mode cold` | `config.mode="cold"`，persist | `context-diet: eliding only when the prompt cache is already cold (free)` | 1288-1297 |
| `mode always` | `config.mode="always"`，persist | `context-diet: eliding whenever eligible (use this only without prompt caching: every pass rewrites the cache)` | 同上 |
| `args on` | `config.elideArgs=true`，persist | `context-diet: stale write/edit arguments will be elided too (the next cold start decides)` | 1298-1302 |
| `args off` | `config.elideArgs=false`，persist | `context-diet: stale write/edit arguments will stay in the context (the next cold start decides)` | 同上 |
| `invalid` | 无 | `cmd.message`，级别 **warning** | 1303-1305 |
| `compact …` | 见 11 节 | 本项目不做 | 1250-1267 |

断言：`keep 7`→文件里 `keepTurns:7` 且提示含 `last 7 assistant turns`；`ttl 60`→`60 min`；`mode always`→含 `only without prompt caching`；`mode cold`→含 `already cold (free)`（TESTS/extension.test.ts:233-244）；坏输入全部提示含 `Usage`（:252-258）；`args off` 后配置 `elideArgs:false`、提示 `stay in the context`，且随后请求不裁参数（:312-321）；保存失败仍有提示 + 本会话生效（:789-799）。

### 9.3 `statusLine`（TS:953-975）——status 命令的正文

```
head = `pi-context-diet: ${enabled?"on":"off"} · mode ${mode} · keep last ${keepTurns} turns · cache ttl ${cacheTtlMinutes} min · min ${formatSize(minChars)} · write/edit args ${elideArgs?"elided":"kept"}`
args = stats.lastArgCount > 0 ? ` + ${stats.lastArgCount} write/edit arguments` : ""
body = `this session: ${lastCount} results${args} elided (~${formatTokens(estimateTokens(lastChars,cpt))} tokens kept out of every request), ~${formatTokens(estimateTokens(cumulativeChars,cpt))} tokens saved over ${requests} requests · ${coldStarts} cold start${coldStarts===1?"":"s"}`
lines = [head, body]
if (extra) lines.push(`${calibrated} · ${warm} · ${compaction}`)
if (recovery) lines.push(`recovery: ${recovered} of ${elided} elided results re-fetched (${rate}%, ~${formatTokens(estimateTokens(recoveredChars,cpt))} tokens to re-fetch, once)${protected?" · protected: "+list:""}`)
```

- `calibrated` 三态：measured → `<cpt.toFixed(2)> chars/token measured from <samples> requests`；samples<6 → `<cpt> chars/token assumed (calibrating: <samples> of 6 requests)`；否则 → `<cpt> chars/token assumed (the provider's usage did not vary with context size)`。
- `warm` 两态：`warming: stopped <warmStops??0>×, when letting the cache expire is cheaper` / `warming: not arbitrated`。（本项目不做 → 整段应删除，或改成"未实现"的明确文案。）
- `compaction` 两态：`compaction: on above <formatTokens(compactAboveTokens)> tokens, <compactions??0> done` / `compaction: off (opt-in)`。（本项目不做 → 删除。）
- `rate = elided>0 ? Math.round(100*recovered/elided) : 0`；`protected` 列表来自 `summary()`，**已排序**（TS:1025-1030）。
- 断言：`37 results elided (~283.3k tokens kept out of every request)`、`~6.80M tokens saved over 24 requests · 3 cold starts`、`3 results + 4 write/edit arguments elided`、`1 cold start`、`recovery: 2 of 40 elided results re-fetched (5%, ~12.0k tokens to re-fetch, once)`、`protected: bash, read`、`0 of 0 ... (0%`（TESTS/core.test.ts:306-316, 576-582）。

### 9.4 `show` 的输出（`showLines`，TS:639-645）

```
if (items.length === 0) return [`${title}: none`]
total = Σ chars
rows  = items.slice(0,limit).map(x => `  ${x.kind==="args"?"args ":""}${x.tool}${x.label?` ${x.label}`:""}  ${formatSize(x.chars)}`)
more  = items.length>limit ? [`  … and ${items.length-limit} more`] : []
return [`${title}: ${items.length} (~${formatTokens(estimateTokens(total,cpt))} tokens)`, ...rows, ...more]
```

- 列表来源：`describeElided(messages, elided, elidedArgs)`（结果 + 参数，按原始 chars 降序，TS:614-630）与 `describeCandidates(...)`（尚未裁剪的候选，TS:633-637）。
- 断言：`showLines("elided now", items, 2, 3)[0]==="elided now: 4 (~4.0k tokens)"`；行 `"  args bash cmd 0  3.0 KB"`、`"  bash cmd 1  3.0 KB"`、`"  … and 2 more"`；空 → `["x: none"]`；无 label → `"  read  100 B"`（两个空格分隔）（TESTS/core.test.ts:676-685）。
- 断言：`show` 首次（无请求）→ `nothing to show yet`；裁剪后 → 含 `elided now: 24`、`bash echo step 1`、`… and 16 more`（24 条 limit 8）、`next cold start would elide: none`；再次冷启动后 `elided now: 54`（TESTS/extension.test.ts:743-764）。

### 9.5 autocomplete（TS:879-921）

数据结构：`{value, label, description}`——**`label` 是必填**，因为 pi 的 autocomplete 会调用 `label.endsWith(...)`；缺 label 会让真实 provider 崩溃（TESTS/autocomplete.test.ts:42-48 是这条回归测试）。

`TOP_LEVEL`（顺序即展示顺序，`value` 对带参命令**带尾随空格**）：

| value | label | description（逐字） |
|---|---|---|
| `status` | `status` | `Show settings and savings` |
| `on` | `on` | `Turn context-diet on` |
| `off` | `off` | `Turn it off (nothing is elided)` |
| `now` | `now` | `Elide stale results on the next request (one cache rewrite)` |
| `keep ` | `keep` | `Always keep the last N assistant turns` |
| `ttl ` | `ttl` | `Prompt-cache lifetime in minutes` |
| `mode ` | `mode` | `cold (free) or always` |
| `args ` | `args` | `Also elide stale write/edit arguments (on or off)` |
| `show` | `show` | `List what is elided and what is next` |
| `compact ` | `compact` | `Compact an idle, big session (opt-in): on, off or now`（本项目不做，删除） |

二级补全（`value` 是**完整参数文本**，因为它们要替换整段已输入内容）：

| 前缀 | 选项（value / label / description） |
|---|---|
| `mode ` | `mode cold` / `cold` / `Elide only when the prompt cache is already cold (free)`；`mode always` / `always` / `Elide whenever eligible (providers without prompt caching)` |
| `args ` | `args on` / `on` / `Elide stale write content and edit old/new text`；`args off` / `off` / `Keep write and edit arguments in the context` |
| `compact ` | （本项目不做，删除） |

算法（TS:900-921）：

```
text = (prefix ?? "").toLowerCase().replace(/^\s+/, "")     // 只去前导空白，不 trim 尾部
pool = text.startsWith("mode ") ? [mode 两项]
     : text.startsWith("compact ") ? [compact 三项]
     : text.startsWith("args ") ? [args 两项]
     : TOP_LEVEL
out = pool.filter(i => i.value.startsWith(text))
return out.length > 0 ? out : null
```

- 断言：`completions("")` 的 labels 顺序为 `["status","on","off","now","keep","ttl","mode","args","show","compact"]`；`completions("mo")` → `["mode "]`；`completions("k")` → `["keep "]`；`completions("  ST")` → `["status"]`；`completions("zzz")===null`；`completions(undefined)` 不返回 null；`completions("mode a")` → `["mode always"]`；`completions("mode x")===null`；`completions("a")` → `["args "]`（TESTS/commands.test.ts:49-84）。
- 真实 provider 断言：任意已输入串上应用任意补全项后，命令行仍以 `/context-diet` 开头、且（除非是"还缺参数"的 `keep/ttl/mode/args/compact` 空参）`parseCommand` 结果不是 invalid；`mode ` 的两项有 description；`keep` 补全后光标在尾随空格之后（TESTS/autocomplete.test.ts:49-89）。
- 命令注册 description（TS:1223，逐字）：`Elide stale tool results when the prompt cache is cold: status, on/off, now, keep, ttl, mode, args, show, compact`（本项目删掉 `, compact`）。

---

## 10. 会话状态恢复

### 10.1 持久化写入（TS:1070-1072, 1210-1211）

| 事件 | 写入 | 数据形状 |
|---|---|---|
| 决定裁剪 | `pi.appendEntry(ENTRY_TYPE, {...})` | `{ids: string[], argIds: string[], cold: boolean, at: number}` |
| 保护工具 | `pi.appendEntry(PROTECT_ENTRY_TYPE, {...})` | `{tool: string, at: number}` |

`ENTRY_TYPE = "context-diet"`，`PROTECT_ENTRY_TYPE = "context-diet-protect"`（TS:791-792）。
只有**真正新增裁剪**时才写 entry（`ids`/`argIds` 非空，TS:1069）；已生效的集合在后续 warm 请求中不重复写。

### 10.2 `restoreState(entries)`（TS:795-810）

```
state = {ids:Set, argIds:Set, protectedTools:Set}
for e of entries:
    if (e?.type !== "custom") continue                  // 只看 custom entry
    if (e.customType === ENTRY_TYPE):
        for key of ["ids","argIds"]:
            list = e.data?.[key]
            if (Array.isArray(list)) for id of list: if (typeof id === "string") set.add(id)
    else if (e.customType === PROTECT_ENTRY_TYPE && typeof e.data?.tool === "string"):
        state.protectedTools.add(e.data.tool)
return state
```

- 容错：非 custom、缺失 data、非数组、非 string、null/undefined entry 全部忽略；重复 id 自动去重。
- 断言：混合 entry（含 `type:"message"`、其他 customType、`data.ids:"no"`、无 data、null/undefined）→ `ids=["a","b","c"]`、`argIds=["a1"]`、`protectedTools=["bash"]`（TESTS/core.test.ts:246-260, 561-575）；`restoreIds([]).size===0`；fuzz 保证集合里只有 string（TESTS/fuzz.test.ts:280-295）。

### 10.3 session_start 的完整初始化顺序（TS:1032-1060，**顺序即语义**）

```
1. loaded = await readConfig()               // 配置读盘（失败也返回默认值 + problem）
2. state = restoreState(ctx.sessionManager?.getEntries?.() ?? [])
3. elided = state.ids; elidedArgs = state.argIds; protectedTools = state.protectedTools
4. meter = new RecoveryMeter()
5. stats = emptyStats()
6. force = false
7. calibrator = new Calibrator()
8. lastMessages = undefined; pendingChars = 0
9. turnsSinceCompaction = COMPACT_COOLDOWN_TURNS; compactInFlight = false; clearTimeout(compactTimer)
10. showStatus(ctx)                           // 恢复后的 footer（形态 A，on / 下次预算）
11. try { if (loaded.problem && hasUI) notify(...); if (enabled && mode==="always" && hasUI) notify(...) } catch {}
```

要点：**只有 ids/argIds/protectedTools 跨会话恢复**；`meter`、`stats`、`calibrator`、`force`、`lastMessages` 全部重置。`protectedTools` 恢复的意义：避免重启后继续裁"被证明有害"的工具；`elided/elidedArgs` 恢复的意义：**同一个前缀在恢复后仍然字节相同**，不制造新的 cache miss。

### 10.4 断言

- 恢复后同一对话的首次请求输出与重启前**逐字节相同**（`resumed.messages).toEqual(first.messages)`，且当时 cache 是 warm）（TESTS/extension.test.ts:156-165）。
- 恢复 was `context-diet-protect` entry → 所有 bash 已被保护 → 请求无裁剪、返回 undefined（:401-408）。
- 无 entries / junk entries 不抛（fuzz）。

---

## 11. Cache warming / compaction（本项目不做，标注）

> 结论先行：**这两块在 DSH 移植中一律标注"本项目不做，应删除"**。理由：DSH 没有 `cache_warming_decision` 事件（无 pi 的空闲保温决策可覆盖）、没有宿主摘要器 `ctx.compact()` 的宿主面等价物（`compaction` 实例在 preset realm），也没有 provider cache TTL 的可靠事实。保留半套实现只会制造"看似一致"的假象。

### 11.1 `shouldStopWarming`（TS:681-699）——若将来实现，公式在此

```
if (action !== "warm" || staleTokens <= 0) return false
priced = prices && cacheRead>0 && cacheWrite>0
if (priced && 所有关键数字有限 && missCost>0 && continuationProbability 有限):
    R = cacheRead/1e6; W = cacheWrite/1e6; p = clamp(continuationProbability, 0, 1)
    return warmCost + p*staleTokens*(R*expectedTurns + W) > p*missCost
return contextTokens>0 && staleTokens/contextTokens >= shareFallback
```

决策语义：只把 pi 的 `"warm"` 改成 `"stop"`，永不做反向；`staleTokens` 来自 `staleTokens(lastMessages, policyOf(config, protectedTools), elided, elidedArgs, config.elideArgs, cpt())`（TS:652-664, 1118-1140）。断言数值：base（warmCost .1, missCost 1.2, p .8, stale 100k, prices {.3,3.75}, turns 30）→ `0.1+0.8*100k*(0.3e-6*30+3.75e-6)=1.12 > 0.96` → true；stale 10k → false；无价格时 `stale/context >= 0.2` 才停（60_000/300_000 触发、59_000 不触发）；`action:"stop"` 恒 false（TESTS/core.test.ts:695-730）。

`staleTokens` 公式（TS:652-664）：

```
estimateTokens( Σ describeCandidates(messages, policy, elided, elidedArgs, includeArgs).chars, charsPerToken )
```

断言：会话（9000+3000 结果 + 4000 参数）→ `staleTokens(..., true, 3) = round(13000/3)`、`false` → `round(12000/3)`、排除已裁结果 → `round(4000/3)`（TESTS/core.test.ts:686-692）。

### 11.2 Compaction（TS:701-723, 1142-1200）——本项目不做，应删除

- `COMPACT_INSTRUCTIONS`（TS:706-707）原文：`Summarise this session so the work can continue. Keep: file paths and function names, decisions and why they were made, open tasks and next steps, errors that were hit and how they were fixed, and the user's preferences. Drop: raw tool output, logs, and exploration that led nowhere.`
- `COMPACT_COOLDOWN_TURNS = 20`；`shouldCompact(i)` 条件：`enabled && compact && !inFlight && idle && !pending && tokens!==null && tokens >= threshold && turnsSinceCompaction >= 20`（TS:712-723）。
- `agent_end` 后 `setTimeout(compactDelayMs=750)` 再检查（TS:1173-1191）；`session_compact` 重置冷却（:1193-1195）；`session_shutdown` 清 timer（:1197-1200）；`startCompaction` 同步异常兜底（:1145-1155）。
- 断言：默认不压缩；150k 且 idle → 压缩一次并带 `customInstructions`；busy/pending/未知 tokens → 不压缩；in-flight 与冷却不重复；失败可重试并 notify（TESTS/extension.test.ts:596-711）。
- **DSH 落地要求**：删除 `core.js` 的 `compact`/`compactAboveTokens` 字段与 `statusLine` 的 compaction 段、删除 `index.js` 的 `compact` 命令分支与 `autoCompact` override、删除 README/命令表/autocomplete 中的 `compact`，并删除或改写相关测试。

---

## 12. DSH 移植差异清单（缺失 / 偏离 / 多余）

对照物：`dsh-context-diet/core.js`（1136 行）、`dsh-context-diet/index.js`（708 行），行号均指当前工作区文件。
判定符号：**A=缺失（上游有、DSH 完全没有）**，**B=偏离（有但语义不同，必须改）**，**C=多余（上游没有，应删除或标注）**，**D=本项目不做（compact / warming，标注并删除）**。

### 12.1 结构性总览（这三条最重要）

1. **改写时机从"每请求一次、只改请求"变成"每 step 一次、持久改写 session surface"**（`index.js:654-677` 的 `agent/pre-step` + `index.js:369-381` 的 `session.append('tool/result', …, {surfaceOp:{op:'replace'}})`）。这不是"实现细节差异"：上游的整个成本模型（cache 已冷才动手、之后字节稳定）建立在"临时请求改写"上；DSH 版本永久落盘，`session log` 也被改写（只保留 `sourceEventSeqs` 溯源），UI/回放语义改变。**规格要求：在 README 与代码注释里明确这是 DSH 平台约束下的语义降级，不得声称"与原版一致"**；能保真的是决策算法（第 3-6 节），不是时机模型。
2. **存在两套并行且互相矛盾的实现**：`core.js:1-882` 是一套基本忠实的 Pi 风格纯函数（`decide/applyElision/RecoveryMeter/statusLine`，仅 B1/B2 两处偏离），`core.js:884-1136` 又是另一套 DSH 契约（`STUB_MARKER/planElisions/parseCommand/statusText`）；`index.js` 只 import 后者（`index.js:50-57`），前者**全部是死代码**。这正是"自以为一致"的根源：单测测的是死代码，运行时走的是另一套。**必须二选一**：要么删掉 DSH 契约、把 adapter 直接架在第 3-6 节的函数上；要么删掉 Pi 风格那套。推荐前者（保留第 1.4 节的纯函数清单）。
3. **stub 文本/marker 有第三套**：`core.js:897` `STUB_MARKER = "[context-diet: result elided]"`，`dshStubText`（`core.js:985-1000`）与 `stubText`（`core.js:367-377`，前缀 `dsh-context-diet:`）都**不是**上游文本（上游：`[pi-context-diet: the output of …`）。任何"与原版一致"的断言都会失败。

### 12.2 A：缺失（上游有、DSH 无）

| # | 缺失项 | 上游出处 | DSH 现状 | 影响 / 动作 |
|---|---|---|---|---|
| A1 | `Calibrator`（chars/token 在线校准） | TS:552-600 | `core.js`/`index.js` 均无此符号（grep 0 次） | 所有 token 数字都是固定 3 换算，`statusLine` 的 measured/calibrating 文案与 5.x 断言无法实现。动作：实现 Calibrator + `pendingChars`/`message_end` 接入；若拿不到 provider usage，则删除"measured"分支并明说 estimated |
| A2 | `describeElided` / `describeCandidates` / `showLines` | TS:606-645 | grep 0 | `/context-diet show` 无法列出"当前已裁/下次会裁"。动作：1:1 移植（纯函数，无平台依赖） |
| A3 | `staleTokens` | TS:652-664 | grep 0 | footer 形态 A 的"下次预算 `−x at the next pause`"无法实现。动作：移植 |
| A4 | `restoreState` / `restoreIds` / `ENTRY_TYPE` / `PROTECT_ENTRY_TYPE` / `appendEntry` | TS:791-812, 1070-1072, 1211 | grep 0；`index.js:100-129` 用 `WeakMap` 存 `protectedTools/overrides`，进程内重启即丢 | 重启/热重载后保护名单与决策集合丢失 → 前缀稳定性与"不再裁有害工具"失效。动作：若 DSH 允许自定义 session event/projection，则持久化 protect 结论；否则至少把 `protectedTools` 与决策集合落到 projection（并文档化"surface replacement 本身已是持久状态"） |
| A5 | footer 状态行（两形态、颜色、`⚠ mode always`、`setStatus`） | TS:997-1023 | `index.js` 无任何 status/notify 展示（无 `setStatus` 等价物） | 用户看不到 `🥗 −x /req · y saved ↺n`、看不到"下次停顿省多少"、`mode always` 不再有任何警示。动作：接 DSH 的 Client/status 面；若本轮无 UI，则必须在 README 明确"footer 不可用"，并保留 8.x 的文本生成函数以便未来接 UI（不要留着不实现的 config 字段） |
| A6 | `parseCommand` 的上游语义（别名、范围、USAGE、大小写） | TS:834-877 | `core.js:1066-1107` 是另一套（见 B7） | 命令行为不兼容。动作：按 9.1 重写（保留 DSH 需要的 `mode` 适配层，见 B6） |
| A7 | `completions` / autocomplete | TS:879-921 | grep 0；`index.js:690-706` 注册命令只有 name/description/handler | 无参数补全。动作：若 DSH `commands` 服务支持补全则移植（注意 `label` 必填）；否则文档标注缺失 |
| A8 | `keepErrors` 语义 | TS:56-57, 353 | `planElisions` 硬编码跳过 `isError`（`core.js:1025`）；`Config` 无该字段（`index.js:77-87`） | `keepErrors:false` 无法表达。动作：加配置并传入 planner |
| A9 | `elideArgs`（write/edit 参数裁剪）与 `argChars/elideArguments/eligibleArgs` | TS:376-443 | `core.js:575-688` 有忠实实现但**未被 index 使用**；`index.js:569-573` 命令直接返回错误；`Config` 无该字段 | 上游默认开启且是主要节省项（write content / edit old/new text）。动作：若 DSH surface 确实无法替换 tool-call 参数，则（a）删除 core 里那套死代码，（b）在 README/命令里明确"不支持"，（c）不得把 `args` 留在命令表里当成功命令 |
| A10 | `statusLine` 的三段式（calibrated / warm / compaction + recovery 行） | TS:953-975 | `core.js:436-466` 有函数但 `index.js` 用 `statusText`（`core.js:1114-1136`）；且 warm 段被改成 `warming: arbitrated`、compaction 段丢了 `N done` | `status` 输出与上游断言（9.3）不一致。动作：以 `statusLine` 为准重写展示；warm/compaction 两段按 D 类删除或标注 |
| A11 | `savedChars`/`requests`/`cumulativeChars`/`lastCount`/`lastArgCount`/`coldStarts` 统计 | TS:927-938, 1086-1091 | 只有 projection `{elided, refetched}`（`index.js:425-427, 443-472`） | `status` 无法给出"省了多少、多少请求、几次冷启动"，也无法实现 7.3 的清零规则。动作：补齐字段与更新时机 |
| A12 | `mode: "cold"` 语义与 `cacheTtlMinutes` 的真实 gate | TS:371-374, 454-455 | `agePolicy: off\|approximate\|always`（`index.js:79`），TTL 比较的是"距上次请求的空闲"而非"最后 assistant 时间戳" | 见 B5/B6。动作：明确 DSH 无法获得 provider cache 事实；要么保留 `mode` 名称并在文档写"近似"，要么重命名（迁移计划已建议 `agePolicy`）但**必须同时改掉 footer/status/命令文案里的 `mode cold`**，不能一处叫 cold、一处叫 approximate |

### 12.3 B：偏离（有实现但语义不同，必须修）

| # | 偏离项 | 上游（行号） | DSH 现状（文件:行） | 判定 |
|---|---|---|---|---|
| B1 | 字符计数单位 | `String.length`（UTF-16 code unit）：measure TS:218-227、clip TS:249、clipLine TS:285、argChars TS:389、stubTS savedChars TS:515/528、charsOfMessages TS:547 | `codePointLength`（`core.js:153-157`，全站使用；`test/unit/core.test.js:199-238` 还专门锁定码点语义） | 影响 `minChars` 边界（emoji/扩展面字符）、`formatSize`、`savedChars`、footprint。**二选一并全局统一**：要保真 → 改回 `.length` 并改测试；要"更好" → 保留码点，但必须改掉"与上游一致"的声明，并重算所有阈值（3 chars/token 的基线也会变） |
| B2 | stub 文本 / marker | `[pi-context-diet: the output of …`（TS:294）；参数占位 `[pi-context-diet: N lines (size) of path elided; …`（TS:402） | 三套：`[dsh-context-diet: …`（`core.js:369, 608`）、`[context-diet: result elided]`（`core.js:897, 991`）、上两者混用 | **必须统一为一套**，且文本逐字对齐第 4.1/4.4 节（除品牌前缀可改为 `dsh-context-diet`，需全局唯一且 `isStubbed` 只认这套）。当前 `planElisions`+`dshStubText` 与 `stubText` 并存 → 模型偶然看到两种句式 |
| B3 | `decide` 签名与冷判定归属 | `decide(messages, elided, config, {now, force}, {elidedArgs, protectedTools})`，内部 `isCold`，返回 `{ids,argIds,cold}`（TS:446-462） | `decide(messages, state, config, {cold, force})`（`core.js:549-568`）多出 `reason`、cold 由外部传；`index.js` 完全不调用它 | 若保留双套，`isCold` 永远不被调用；`reason` 是上游没有的键（会破坏 `toEqual`）。动作：恢复上游签名（或删除该套，见 12.1-2） |
| B4 | 触发频率 / 集合冻结 | 每请求一次；warm 期间集合不增长（TS:1063-1097；TESTS/extension.test.ts:106-124） | 每 `agent/pre-step` 一次（`index.js:654-677`），一个 agent turn 内多次工具调用会多次 plan + 多次 append | 破坏"一次决策、之后原样重放"；同轮内持续改写 surface，cache/前缀稳定性下降，`requests`/saved 统计含义也变。动作：加"每 agent turn 只决策一次"的门闩（按 `request/header` 或 step 边界），或在文档中明确降级并删掉相关承诺 |
| B5 | 冷判定的"无信号"默认 | 无 assistant 时间戳 → `isCold=false`（**不裁**）（TS:371-374；TESTS/core.test.ts:163） | `lastRequestTime===0` → `idleMinutes=Infinity` → 视为 cold（`index.js:316-321`） | 方向相反：新会话/缺失事件时 DSH 会立刻裁。动作：缺失信号应 conservative=false（不裁），或明确改为"首次请求不裁" |
| B6 | `mode` 取值 | `cold｜always`（TS:44；命令/文案见 9.2） | `off｜approximate｜always`（`index.js:79`, `core.js:1099-1104`） | DSH 无 cache 事实是客观约束，但当前 `off` 与 `enabled:false` 重叠、`approximate` 与 `cold` 语义不同名。动作：选定一种并**全站一致**（Config/命令/footer/status/README/测试）；若保留 `off|approximate|always`，则 footer 里不得再出现 `mode cold` 文案 |
| B7 | `keepTurns` 语义 | assistant 消息计数，`ages>keepTurns`（TS:352, 432） | `event.data.turn > maxTurn - keepTurns` 跳过（`core.js:1029`），且 `Config` 允许 0（`index.js:81` min(0)，上游 clamp 1..500 TS:114） | turn 差值与 assistant 计数不等价（一轮可有多个 tool 结果/无 assistant 消息）；keepTurns=0 是上游非法值。动作：改用"assistant 事件计数"计算年龄（或在 snapshot 里提供等价 ages），并 clamp 1..500 |
| B8 | 已裁剪判定 | elided id 集合 + 持久化恢复（TS:982, 1070-1072, 795-810） | `isStubbed(content)` 看 marker + `node.replaced`（`core.js:904-916, 1025`） | 依赖 stub 文本恰好以 marker 开头 → 与 B2 耦合；且 marker 变更会让历史 stub 被重复裁/漏裁。动作：统一 marker 常量 + 迁移/识别旧 marker；`isStubbed` 只做"是否已是本插件 stub"的判定，不要兼作版本识别 |
| B9 | recovery 签名 | `ground truth`：`stableStringify(args)` 全字段（TS:469-478） | `\`${name}\u0000${typeof args==='string'?args:''}\``（`index.js:146-148, 430-434`）：**args 为对象时签名丢失参数** | 同工具不同参数会被误判为 re-fetch（虚高 recovers → 误拉黑）。动作：改用 `stableStringify`（注意 DSH 里 args 可能是 JSON 字符串，应先 parse 再稳定化） |
| B10 | recovery 去重/计数 | 一次命中把同签名所有副本标 `counted`；`recovered` 是**事件数**，`recoveredChars` 只加命中条目（TS:764-774） | 每个 `tool/call` 事件都 `recovered++`（`index.js:190-201`），无 `counted` 去重；`elided` 计数来自历史扫描 | 会高估重取率、过早保护。动作：按 6.2/6.3 实现（track/onCall），或至少加 counted 集合与"同签名只算一次" |
| B11 | autoProtect 触发条件 | `config.autoProtect && !already && shouldProtect(tool, config.recoveryThreshold)`，且 **notify + appendEntry**（TS:1209-1214） | 硬编码 0.25/5，无 `autoProtect` 开关，不 notify、不持久化（`index.js:131-132, 193-200`） | 阈值不可配、用户不知道被保护、重启丢失。动作：加配置 + notify + 持久化（见 A4/A9） |
| B12 | 统计清零规则 | 本轮无 stub → `lastCount/lastArgCount/lastChars=0`（TS:1078-1085；TESTS/extension.test.ts:822-831） | 无对应概念（无 last*） | footer/status 会显示陈旧收益。动作：随 A11 一起实现 |
| B13 | `force` 的作用域 | 只跳过**下一次请求**的 cold gate，之后 warm 请求集合不变（TS:1274-1277, 1075；TESTS/extension.test.ts:167-177） | `state.forceOnce` 让下一次 pre-step 用 `agePolicy:"always"`（`index.js:666-669`）；但每次 pre-step 都重新 plan，本轮后续 step 会继续裁 | force 变成"整轮持续生效"；且 `now` 的提示文案也不同（`index.js:559`）。动作：把 force 绑定到"一次请求"边界；文案对齐 9.2 |
| B14 | `minChars` 校验 | sanitize clamp 200..1e6（TS:115）；`eligible` 用 `< minChars` 跳过（TS:356） | `resolvePolicy` 不 clamp（`core.js:943-976`），overrides 绕过 Config schema（`index.js:506-512`）；`planElisions` 用 `< minChars`（`core.js:1027`） | override 可传入 0/负数/NaN 之类破坏决策。动作：在 `resolvePolicy` 里对全部字段实施 2.2 的钳制（含 `neverElide` trim/去重/50 上限） |
| B15 | `neverElide` 清洗 | trim/去空/去重/≤50（TS:118-120） | `resolvePolicy` 只保证是数组（`core.js:952`） | 手改配置可留空串/重复项。动作：照 2.2 实现 |
| B16 | `savedChars` 与"stub 必须更小" | 命中即替换，`savedChars=max(0, chars-stub.length)`（TS:515） | 额外不变量：stub 更小才裁（`core.js:1046-1047`、`index.js:359`） | 小结果（preview 很长时）上游会裁、DSH 不裁 → 行为差异；同时 `savedChars` 语义改变。动作：去掉额外不变量，或文档化为"DSH 保守化"并补单测 |
| B17 | `maxPerPass` 节流 | 无上限：一次冷启动把全部候选裁掉（TS:446-462） | `maxPerPass` 默认 8、planner cap 2×（`core.js:1017-1021, 1054`；`index.js:343`） | 需要多轮才收敛，`coldStarts`/节省统计与上游不可比；且"一次决策"语义丢失。动作：默认改为无上限（或足够大），或明确文档化为渐进式并放弃"一次决策"承诺 |
| B18 | `statusText` 格式 | `statusLine` 三段/多行（9.3） | 单行 `context-diet: on mode=… keep=… elided=… refetched=…`（`core.js:1114-1136`） | 所有 status 断言语义不同（`test/unit/core.test.js:910-931`、`test/plugin.test.js:432-446` 锁定的是 DSH 格式）。动作：以 9.3 为准重写，测试同步改 |
| B19 | 命令 invalid 文案 | `Unknown option "<cmd>". <USAGE>`（大写 Usage，TS:875） | `usage: unknown subcommand`（小写，`core.js:1106`） | 用户提示不同；`readme.test.ts` 那类"文档里所有命令都能解析"的测试也无从复用。动作：对齐 9.1 |
| B20 | `keep`/`ttl` 上界 | 1..500 / 1..1440（TS:850-859） | 仅 `>0`（`core.js:1086-1097`） | `keep 100000` 会被接受，行为异常（等于永不裁/永不冷…）。动作：加上界 |
| B21 | 别名 | `enable`/`disable`（TS:840-845） | 无（`core.js:1074` 只认 on/off） | 文档/肌肉记忆兼容性。动作：补别名（或文档删掉） |
| B22 | 持久化写入时机 | 只在"新增裁剪"时 append entry（TS:1069-1072） | 每次 pre-step 都可能 append（`index.js:374-381`），且 append 的是 replacement 事件而非决策记录 | replay/审计语义不同；`surface replaceGeneration` 检查（`index.js:384-389`）是 DSH 特有防御（可保留）。动作：文档化；不要声称 replay 与上游等价 |
| B23 | `show` 的内容 | 两个列表（elided now / next cold start）（TS:1240-1249） | `statusText({detailed:true})`，忽略 `detailed`（`core.js:1114-1136`, `index.js:592-601`） | 用户拿不到清单。动作：见 A2/A3 |
| B24 | `provider usage` 接入 | `message_end` 里 `input+cacheRead+cacheWrite`（TS:1101-1114） | 无；projection 只有 elided/refetched | 同 A1 |

### 12.4 C：多余（上游没有，应删除或明确标注）

| # | 多余项 | DSH 位置 | 判定 |
|---|---|---|---|
| C1 | `STUB_MARKER` / `isStubbed` / `DSH_DEFAULTS` / `resolvePolicy` / `dshStubText` / `planElisions` / `statusText` 这整套 DSH 契约 | `core.js:884-1136`（约 253 行，占 22%） | 与 12.1-2 重叠，且与忠实实现冲突。**删除或合并**；合并后 `planElisions` 的 snapshot 形状可以保留（作为 adapter 输入），但决策必须走 3.5 的 gate 顺序 |
| C2 | `maxPerPass` 配置 + `cap = maxPerPass*2` | `core.js:931, 956-962, 1017-1021, 1054`；`index.js:85, 343` | 上游无此概念。删除（或文档化为 DSH 限流，见 B17） |
| C3 | `agePolicy` 三值 `off/approximate/always` | `core.js:923-933, 1098-1105`；`index.js:79` | 见 B6；若保留必须全站改名 |
| C4 | `compaction/prune` shadow-price 事件 + `shadowedTokenCount` | `index.js:333-373` | 这是 **DSH 平台的计费正确性要求**（不写会让 contextBreakdown 重复计价），属于"允许且必需"的偏离；保留，但要在规格/注释里标为"平台必需，非上游行为" |
| C5 | `tokenMeter.estimateMessage` 依赖 + 拿不到就跳过整轮 | `index.js:333-342` | 平台必需（否则计费错），保留；但要注意它会让"没装 token-meter 的 profile"完全不裁剪，需文档化 |
| C6 | `projection`（`contextDiet` key、`elided`/`refetched`/`signatures`/`pending`/`tools`）与 `foldProjection` | `index.js:89-93, 402-472` | 上游状态在内存 + custom entry。projection 可以作为 DSH 的持久化替代（好事），但字段名/语义必须与 Stats 对齐（A11/B12），且 `createStateSchema` 只校验 4 个字段却 init 出 5 个（`tools` 未校验）——修 schema |
| C7 | `sessions` WeakMap 运行态（`scanOffset/callNames/calls/elidedSignatures/recoveryStats/protectedTools/overrides/forceOnce/lastPass/passes/appends/failures`） | `index.js:100-129` | 增量扫描是 DSH 必要优化；但 `protectedTools/overrides` 放这里 = 重载即丢（见 A4）。保留扫描游标，迁移保护名单/override 到持久层或明确"会话内"语义 |
| C8 | `MAX_TRACKED=64 / MAX_CALLS=4096 / MAX_ELIDED_SIGNATURES=256` 硬上限 | `index.js:93, 134-135, 137-144` | 上游只有 Calibrator 的 200 窗口。这些是防内存膨胀的合理加固；保留但文档化（会影响长会话的重取识别准确率） |
| C9 | `trimMap` / `recoverySignature` 与 `callSignature` 重复实现 | `index.js:137-148, 430-434` | 两处同义函数 → 抽成一个（并修 B9） |
| C10 | `statusLine`（`core.js:436-466`）与 `statusText`（`core.js:1114-1136`）并存；`emptyStats` 导出但无人用；`decide/applyElision/RecoveryMeter/Calibrator(未实现)/describe*` 全部未被 index 引用 | `core.js:415-424, 436-466, 549-568, 734-803, 813-882` | 双实现漂移的直接来源。**收敛为一套** |
| C11 | `compaction`/`autoCompact` 命令与 override | `index.js:574-591` | 见 D 类：本项目不做，应删除 |
| C12 | `warmArbitration`/`expectedTurns`/`stopWarmingShare` 配置 + `statusLine` 的 `warming: arbitrated` 文案 | `core.js:67-69, 127-135, 448-450` | 无实现的功能配置 = 谎报。删除字段与文案，或实现 11.1（但 DSH 没有 seam，见 D 类） |
| C13 | `docs/` 里"与原版一致"的表述、README 的 `mode <off\|approximate\|always>` / `args` / `compact` 命令表 | `README.md:145, 155-156, 220` | 与实现和上游都不一致。随 A/B/D 一起重写 |

### 12.5 D：本项目不做（compact / cache warming）——标注"应删除"

| # | 项目 | 上游 | DSH 现状 | 动作 |
|---|---|---|---|---|
| D1 | `compact` 配置（`compact`, `compactAboveTokens`） | TS:77-80, 100-101, 136-137 | `core.js:70-71, 134-140` 保留默认值；`statusLine` 输出 compaction 段（`core.js:451-453`） | **删除字段与展示**。DSH 的 compaction 属于 preset realm 的独立服务，不是本插件职责 |
| D2 | `shouldCompact` / `COMPACT_INSTRUCTIONS` / `COMPACT_COOLDOWN_TURNS` / `timing.compactDelayMs` / `agent_end` / `session_compact` / `session_shutdown` / `startCompaction` | TS:701-723, 978, 1142-1200 | 未移植（好） | 保持未移植；并在 CHANGELOG/README 写明"不接管 compaction" |
| D3 | `/context-diet compact on\|off\|now` 命令、`autoCompact` override | TS:866-869, 1250-1267 | `core.js:1078-1085` 解析 + `index.js:574-591` 实现（调 `compaction.compactNow`） | **删除**：命令、Config 里的隐含 override、README/autocomplete 条目、相关测试（`test/plugin.test.js:445-446, 503-544` 等） |
| D4 | `cache_warming_decision` / `shouldStopWarming` / `staleTokens` 驱动保温 | TS:681-699, 1116-1140 | 未实现；但 `warmArbitration` 等配置保留 | 删除配置与 `statusLine` 文案（见 C12）；`staleTokens` 本身要保留（footer 形态 A 需要，见 A3） |

### 12.6 受影响的现有测试/文档（改实现时必须同步改，否则会"测绿了但行为错"）

| 文件 | 锁定的现状 | 与规格冲突处 | 处理 |
|---|---|---|---|
| `test/unit/core.test.js:791-931` | `STUB_MARKER`、`resolvePolicy` 新语义、`planElisions`、`parseCommand`（off/approximate/always）、`statusText` 单行 | C1、B6、B7、B18、B19、D3 | 重写为第 4/9/3 节的断言 |
| `test/unit/core.test.js:199-238` | 码点计数 | B1 | 二选一后改测试与实现 |
| `test/unit/core.test.js:471-525` | `decide(messages, state, config, {cold,force})` + `reason` | B3 | 恢复上游签名或删除该套 |
| `test/plugin.test.js:426-446` | `args` 返回 error、`compact now` 返回 error、`statusText` 形态 | A9、D3、B18 | 随实现更新 |
| `test/plugin.test.js:503-544` | compaction 锁/`compaction/prune` | C4 保留、C11/D3 删除命令 | 保留锁与 shadow price 测试，删命令测试 |
| `README.md:145, 155-156, 220` | 命令表含 `args`/`compact`、`mode off\|approximate\|always` | 9.1/9.2、D3 | 重写命令表与"限制"段 |
| `cordis.patch.yml:1-3` | 注释称"row and plugin Config default to enabled" | 与 2.1 `enabled:true` 一致（OK） | 保留，但若删 compact 需同步注释 |

> **验收顺序建议**：先做 B2（单一 stub 文本）+ B1（字符单位）+ C10（收敛实现），再做 A1-A3/A11/B3-B12（决策与统计），最后 A4/A5/A6/A7（持久化、footer、命令、补全），D1-D4 全程同步删除。每步都用第 3.8 节与各节的"断言原文"当回归基线。

---

## 附录 A：上游导出清单与测试断言索引

### A.1 上游模块导出（`extensions/context-diet.ts`，供移植时对照签名）

值：`DEFAULT_CONFIG`、`sanitizeConfig`、`resolveAgentDir`、`readConfig`、`loadConfig`、`saveConfig`、`measure`、`indexCalls`、`describeCall`、`formatSize`、`previewOf`、`stubText`、`hasThinking`、`assistantTurnsAfter`、`DEFAULT_CHARS_PER_TOKEN`、`estimateTokens`、`formatTokens`、`policyOf`、`eligible`、`lastAssistantTimestamp`、`isCold`、`ARG_TOOLS`、`argChars`、`elideArguments`、`eligibleArgs`、`decide`、`stableStringify`、`callSignature`、`applyElision`、`charsOfMessages`、`Calibrator`、`describeElided`、`describeCandidates`、`showLines`、`staleTokens`、`shouldStopWarming`、`COMPACT_INSTRUCTIONS`、`COMPACT_COOLDOWN_TURNS`、`shouldCompact`、`RecoveryMeter`、`ENTRY_TYPE`、`PROTECT_ENTRY_TYPE`、`restoreState`、`restoreIds`、`USAGE`、`parseCommand`、`completions`、`timing`、`statusLine`、`default`（插件本体）。
类型（仅 TS）：`Mode`、`DietConfig`、`Message`、`Policy`、`Preview`、`ElidedInfo`、`ApplyOptions`、`Shown`、`WarmInput`、`Command`、`CompletionItem`、`Stats`、`RecoverySummary`、`Extra`（`Part` 是文件内私有接口，TS:206）。
`emptyStats` 未导出（TS:938），但 `Stats` 的初值语义以其为准。

### A.2 关键测试断言速查（实现后必须全绿）

| 断言 | 期望 | 出处 |
|---|---|---|
| `measure([{text:"a\nb\n"},{text:"c"}])` | `{5,3,true}` | core:16 |
| `measure("a\n")` | lines 1 | core:30 |
| `describeCall` 长命令 | 长度 80、`…` 结尾 | core:60-62 |
| `formatSize/formatTokens` | 见 4.3 | core:70-79 |
| `eligible` 边界 | keepTurns 严格大于；minChars 含等于 | core:106-149 |
| `isCold` 边界 | 等于 TTL 仍 warm | core:158-164 |
| `decide` 全 gate | 24/24/24/0/0 | core:171-189 |
| `applyElision` 不改原对象 | 未命中同一引用 | core:207-208 |
| `savedChars >= 0` | 小结果 0 且仍替换 | core:239-243 |
| `sanitizeConfig` 全钳制 | 见 2.2 | core:263-297 |
| `statusLine` 文本 | 见 9.3 | core:306-316, 576-582 |
| `previewOf` tail/errors | 见 4.2 | core:320-351 |
| `stubText` 文本 | 见 4.1 | core:352-360 |
| `eligibleArgs` | write/edit、thinking、answered/failed | core:407-460 |
| `RecoveryMeter` | 幂等/一次偿还/阈值 | core:514-558 |
| `restoreState` | 三集合 | core:561-575 |
| `Calibrator` | 见 5.2 | core:594-642 |
| `showLines` | 见 9.4 | core:676-685 |
| `staleTokens` | round(Σ/3) | core:686-692 |
| 端到端 | 24 stub、1 entry、cold、footer | ext:92-124 |
| 前缀稳定 120 轮 | 2 次 cold start、<70% 字符 | ext:126-154 |
| 恢复后字节相同 | `toEqual` | ext:156-165 |
| force 一次性 | 24 后不再增长 | ext:167-177 |
| 关闭后全量发送 | `undefined` + `enabled:false` | ext:184-193 |
| footer 两形态 | `at the next pause` / `/req` | ext:463-472, 822-831 |
| `⚠ mode always` | 裁剪前后都在 | ext:439-445 |
| 校准文案 | measured / calibrating / 不变化 | ext:507-530 |
| 保护工具 | 3/24 触发、notify、持久化 | ext:372-408 |
| 命令文本 | 见 9.2 | ext:223-258, 312-321 |
| `show` 输出 | 见 9.4 | ext:743-764 |
| autocomplete | label 必填、顺序、null | commands:49-84, autocomplete:42-89 |
| 文档默认值 | 与 `DEFAULT_CONFIG` 相等 | readme:69-72 |

### A.3 一句话记录（给 Lead 汇报用）

1. 上游的"免费"来自 **cache 已冷才裁剪**：冷判定是 `now - 最后 assistant 时间戳 > ttl`，严格大于，且无时间戳时**不裁**；DSH 现状把"无请求头（0）"当 Infinity → 立刻裁，方向相反。
2. 上游一次请求只决策一次、warm 期间集合冻结、前缀字节稳定；DSH 每 pre-step 都 plan/append，且首页双实现（core.js 前 882 行是死代码，index.js 只走另一套契约）。
3. 上游 stub 文本只有一种：`[pi-context-diet: the output of <tool> <label> (<size>, <N> lines) was elided from the context to save tokens. Re-run it if you need it again.` + 可选 `error lines:`（在前）/ `last lines:`（在后），每行两空格缩进；DSH 有三套不同文本/marker。
4. 上游丢失的 8 个纯函数必须补：`Calibrator`、`describeElided/describeCandidates/showLines`、`staleTokens`、`restoreState`、`completions`、`shouldStopWarming`（末项标注不做）；DSH 的 `recoverySignature` 在 args 为对象时丢参数，会把同工具不同调用误判为重取 → 误拉黑。
5. compact（`/context-diet compact`、`compact*` 配置、`statusLine` compaction 段、README 条目）与 cache warming 仲裁在 DSH 无 seam，规格判定 **"本项目不做，应删除"**；同期删除 `maxPerPass`/`agePolicy` 这类自造语义或全站改名，不得再用 "mode cold" 文案。
