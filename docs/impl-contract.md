# 实现契约（Lead 定义，供 core-port / host-adapter / client-footer / test-parity 共用）

本文件是重构期间的唯一接口事实来源。任何一方要改这里，必须先改本文件并向 lead 说明。

## 0. 顶层决定

1. **一个核心**：`core.js` 是 pi-context-diet 纯函数的忠实移植（无 import、无 I/O）。旧 `index.js` 里第二套"Dsh*"契约（`planElisions`/`resolvePolicy`/`dshStubText` 等）**全部删除**。
2. **一个文本**：stub 文本只有一套，模板逐字取上游 `TS:292-298`，仅把产品前缀 `pi-context-diet` 换成 `context-diet`。
3. **与 compact 无关**：`compact*` 配置、`/context-diet compact`、statusLine 的 compaction 段、warming 仲裁全部不实现；`grep -i compact` 在源码中只允许出现在"平台必需的 compaction/prune shadow price"注释和检测原生 pruner stub 的地方。
4. **命名对齐上游**：`mode`（`cold|always`）、`cacheTtlMinutes` 替代 `agePolicy`；删除 `maxPerPass`；`keepTurns` 下限改为 1（上游 clamp 1..500）。

## 1. core.js 导出（冻结）

常量：
- `DEFAULT_CONFIG`（冻结对象，18 项里只保留 DSH 有语义的 13 项，见 §2）
- `DEFAULT_CHARS_PER_TOKEN = 3`
- `STUB_MARKER = "[context-diet:"`（前缀匹配用）
- `ARG_TOOLS = Set(['write','edit'])`
- `MAX_LABEL_CHARS = 80`、`MAX_PREVIEW_LINE_CHARS = 160`（按上游实际值，见规格 §4.2/§4.5）

函数（签名与上游一致）：
```
sanitizeConfig(raw) -> DietConfig
measure(content) -> {chars, lines, textOnly}
indexCalls(messages) -> Map<callId,{name,args}>
describeCall(name,args) -> string
formatSize(chars) -> string
formatTokens(n) -> string
previewOf(content,tailLines,errorLines) -> {tail:string[],errors:string[]}
stubText(name,label,chars,lines,preview) -> string
isStubbed(content) -> boolean          // DSH 增补：识别本插件 stub
hasThinking(m) -> boolean
assistantTurnsAfter(messages) -> number[]
lastAssistantTimestamp(messages) -> number|undefined
isCold(messages,now,ttlMs) -> boolean
eligible(messages,policy,already) -> string[]
argChars(name,args) -> number
elideArguments(name,args) -> object
eligibleArgs(messages,policy,already) -> string[]
decide(messages,elided,config,{now,force},{elidedArgs,protectedTools}) -> {ids,argIds,cold}
stableStringify(v) -> string
callSignature(name,args) -> string
applyElision(messages,elided,{argIds,preview}) -> {messages,count,argCount,savedChars,infos}
charsOfMessages(messages) -> number
class Calibrator { add(chars,tokens); samples(); isMeasured(); charsPerToken() }
describeElided(messages,elided,elidedArgs) -> Shown[]
describeCandidates(messages,policy,elided,elidedArgs,includeArgs) -> Shown[]
showLines(title,items,limit,cpt) -> string[]
staleTokens(messages,policy,elided,elidedArgs,includeArgs,cpt) -> number
class RecoveryMeter { track(infos); onCall(tool,args); elided(); shouldProtect(tool,threshold,minSample=5) }
parseCommand(args) -> Command
USAGE -> string
completions(prefix) -> CompletionItem[]|null
statusLine(config,stats,recovery?,extra?) -> string
footerLine(config,stats,recovery?,extra?) -> string   // DSH 增补：把上游 showStatus 的两种形态变成纯函数
```

`policyOf(config, protectedTools)` 保留为内部函数并导出（上游亦导出）。

## 2. DietConfig（13 项）

| 字段 | 默认 | clamp |
|---|---|---|
| enabled | true | boolean |
| mode | "cold" | cold\|always |
| keepTurns | 20 | 1..500 |
| minChars | 1500 | 200..1_000_000 |
| cacheTtlMinutes | 5 | 1..1440 |
| keepErrors | true | boolean |
| neverElide | [] | 去重，≤50 |
| showStatus | true | boolean |
| stubTailLines | 3 | 0..10 |
| stubErrorLines | 3 | 0..10 |
| elideArgs | true | boolean |
| autoProtect | true | boolean |
| recoveryThreshold | 0.25 | 0.05..1 |

不实现：warmArbitration / expectedTurns / stopWarmingShare / compact / compactAboveTokens（无 DSH seam，README 说明）。

## 3. Stats 与 footer

Stats 字段（与上游同名）：`lastCount,lastArgCount,lastChars,cumulativeChars,requests,coldStarts`；DSH 增补 `lastPassAt`。

`footerLine` 两形态（对齐 TS:1012-1020）：
- 无裁剪（lastCount+lastArgCount===0）：`🥗 −<next> at the next pause`，`next = staleTokens(...)`；next=0 时 `🥗 on`；config.enabled=false 或 showStatus=false 时返回空串。
- 有裁剪：`🥗 −<estimateTokens(lastChars)> /req · <estimateTokens(cumulativeChars)> saved` + ` ↺<recovered>`（recovered>0）+ ` ⚠ mode always`（mode==="always"）。
- 颜色由 Client 负责（纯函数只返回带 `segments` 的结构或纯文本）；**决定**：`footerLine` 返回纯文本（emoji+数字），Client 直接渲染，避免两套格式化。

## 4. Host ↔ Client 契约

Host 注册 webServer exact 路由 `GET /context-diet/stats`（只读，无需写权限；带 `connection.requestRejection` 检查，未认证返回 401/403）：

```json
{
  "schemaVersion": 1,
  "sessionId": "<id or null>",
  "config": { ...13 项... },
  "stats": { "lastCount":0,"lastArgCount":0,"lastChars":0,"cumulativeChars":0,"requests":0,"coldStarts":0 },
  "recovery": { "recovered":0,"elided":0,"recoveredChars":0,"protectedTools":[] },
  "estimate": { "charsPerToken":3,"samples":0,"measured":false },
  "next": { "chars":0,"tokens":0 },
  "footer": "🥗 −1.9k /req · 286k saved ↺3"
}
```
`footer` 由 Host 直接用 `footerLine()` 生成，Client 不自算。没有活动会话时 `sessionId:null`、`footer:""`、`next.chars:0`。

Client 每 2000ms 轮询；`document.visibilityState !== "visible"` 时暂停。

## 5. Client 渲染位置

见 `docs/slot-report.md`（slot-scout 产出）。要求：
- 常驻、只读、不可点击（或点击打开只读详情，非必需）。
- 空字符串时渲染 null，不占位。
- 使用 `--dsw-alias-*` 主题 token；`font-size: 11-12px`，颜色 `--dsw-alias-label-secondary`；`−Nk /req` 用 `--dsw-alias-label-primary` 强调。
- 卸载后 2000ms 内停止轮询，不留定时器。

## 6. 测试契约

1. `test/unit/core.test.js`：全部按上游断言改写（阈值边界、clamp、stub 逐字、preview 选择、Calibrator 7 类退化、RecoveryMeter 幂等与 shouldProtect、parseCommand 全表、statusLine/footerLine 文本）。
2. `test/parity.test.js`：把上游 `tests/core.test.ts` 里可移植断言逐条搬过来（每条注明上游行号），用来证明"不是自认为一致"。
3. `test/plugin.test.js` / `session.test.js` / `session-contract.test.js`：真实 Session，覆盖 cold gate、force、keepTurns、keepErrors、neverElide、恢复、并发、fail-open、replay 幂等。
4. `test/footer.test.js`：Host 端点 + footerLine + Client 静态契约（manifest、slot 名、轮询停止、空串返回 null）。
5. 全部 `node --test` 绿；`npm pack --dry-run` 只含预期文件。

## 7. 验收门（Lead 执行）

- `npm test` 全绿
- `npm run check` 语法
- `node --test` 无 skip
- 安装到 profile：`application: applied`
- `Slots.listSubTree(<目标 slot>)` 返回 occupants 含 `context-diet`
- 页面刷新后用户可见 footer 文本（截图或 DOM 证据）
- 卸载/禁用后轮询停止、footer 消失
