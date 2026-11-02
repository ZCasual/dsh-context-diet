# 独立保真审计：dsh-context-diet vs pi-context-diet

审计人：accuracy-reviewer（独立于实现者）。日期：2026-11-03。
未修改任何源码；本轮只新增本文件，对抗脚本写在 `/tmp`（沙箱每次调用会重建 `/tmp`，脚本已全文内嵌于 §4 以便复现）。

## 0. 方法与证据来源

不用任何"之前说一致"的结论，全部重新读：

| 对象 | 位置 | 读法 |
|---|---|---|
| 上游实现 | `reference/pi-context-diet-main/extensions/context-diet.ts`（1309 行） | 逐函数读源码，取 TS 行号 |
| 上游测试 | `reference/pi-context-diet-main/tests/*.test.ts`（core 748 行、extension 832 行等） | 读断言原文，判断本仓库 parity 是否真搬 |
| 本仓库 core | `dsh-context-diet/core.js`（1246 行） | 逐函数比对 |
| 本仓库适配层 | `dsh-context-diet/index.js`（951 行） | 找"自创语义"：翻译、时间、recovery、stats、fail-open |
| 客户端 | `dsh-context-diet/client.js`（169 行） | 数字来源、空串、轮询、与官方条目关系 |
| DSH 平台事实 | 安装包 `/home/z/.npm-global/lib/node_modules/@deepseek-ai/dsh@0.2.1-rc.5` | `dsh-client-ui-chat`、`dsh-cordis-client-runner`、`dsh-commands`、`dsh-package-manifest` 的 types/clients |
| 声明 | `docs/impl-contract.md`、`docs/upstream-fidelity-spec.md`、`docs/slot-report.md`、`README.md`、`CHANGELOG.md` | 只当作"声称"，逐条与代码对账 |

跑过的命令（全部绿）：

```
npm test                                    # 181 pass / 0 fail
node --test test/parity.test.js             # 105 pass / 0 fail
node --test test/footer.test.js test/plugin.test.js \
            test/session.test.js test/session-contract.test.js   # 65 pass / 0 fail
node /tmp/fid/adversarial.mjs               # 17/17 checks（§4）
```

## 1. 结论

**分层结论（不是笼统的"一致/不一致"）：**

1. **`core.js` 纯函数层：达到"忠实移植"。** 被点名的 16 个函数逐函数比对，除下面已声明的 DSH 差异外，算法、边界、clamp、返回引用语义全部一致；parity 套件抽查到的 trace 与上游断言逐字对应（例：`isCold` 的 4 条断言 = `tests/core.test.ts:158-164`）。它**可以**作为 pi-context-diet 策略核心的 DSH 移植发表。
2. **`index.js` 适配层：目前不能说"1:1 移植"。** 决策算法保真（冷门、keepTurns、keepErrors、neverElide、minChars、applyElision 的落盘形状都正确，5 个对抗用例全过），但**观测数字与跨进程状态**有 3 处未声明的语义偏离（P1-1 统计、P1-2 重启恢复、P1-3 校准），以及 1 处展示缺陷（P2-1 `/show` 尺寸）。这些会让"省了多少 token""保护了哪些工具"与上游不可比。
3. **`client.js` footer：契约正确。** 数字全部来自 Host 的 `footer` 字段（客户端只做字符串切分，零 token 计算）；空串渲染 null；轮询有清理、隐藏页跳过；用自有 id `context-diet` 注册在 `conversation.composer.dock`（list/session），官方 `activity`(order 0) 与 `usage`(order 1) 确实存在（`dsh-client-ui-chat/lib/client.js:13347-13361`），因此"排在其后、不覆盖官方条目"的说法成立；官方百分比是同一 flex 行的内置 `ContextMeter`（`dsh-client-ui-conversation/lib/client.js:19362`），不会被覆盖。仅有一处 manifest 事实错误（P2-3）。

**发布判断：** 若以"整包与上游一致"发布 → **不达标**；若以"core 是 1:1 策略移植，Host 适配层因 DSH 的 durable-surface 模型存在已界定差异"发布 → **达标，但必须先修 P1×3 + P2×3**，并把 README/CHANGELOG 的 "line-by-line port" 限定到 core。当前 README 把 `−x /req` 解释为"当前 surface 每次请求省多少"（README:55-56），与实现不符，属于必须一并修的口径问题（P2-2）。

## 2. 差异表

判定：`= 一致` / `≈ 可接受差异（已声明）` / `≠ 偏离（必修或须改口径）` / `+ DSH 增补`。行号：TS = 上游 `extensions/context-diet.ts`；core/index/client = 本仓库。

| # | 函数/机制 | 上游 | 本仓库 | 判定 | 理由 |
|---|---|---|---|---|---|
| 1 | `DEFAULT_CONFIG` | TS:83-102（18 字段） | core:60-75（13 字段） | ≈ | warmArbitration/expectedTurns/stopWarmingShare/compact/compactAboveTokens 无 DSH seam，impl-contract §2 已声明 |
| 2 | `sanitizeConfig` | TS:108-140 | core:108-170 | ≈ | 共享 13 字段的 clamp 逐条相同（含 neverElide trim/去重/50、recoveryThreshold 0.05..1）；仅少 5 个字段 |
| 3 | `measure` | TS:217-228 | core:189-210 | = | 同为 UTF-16 `String.length`；字符串快路径、textOnly 判定一致 |
| 4 | `indexCalls` / `describeCall` | TS:234-245 / 253-260 | core:212-231 / 244-263 | = | 含 `clip(...,80)`、bash 优先 command |
| 5 | `formatSize` / `formatTokens` / `estimateTokens` | TS:262-267 / 320-327 / 318 | core:265-273 / 275-285 / 287 | = | 数值格式逐字相同；`estimateTokens` 上游导出、本仓库不导出（P3-1） |
| 6 | `previewOf` | TS:281-290 | core:315-357 | = | tail 取末尾、error 行排除 tail 重叠、`ERROR_LINE`/`ALL_CLEAR`、160 clip 全同 |
| 7 | `stubText` | TS:292-299 | core:359-375 | ≈ | 唯一差异是品牌前缀 `[pi-context-diet:` → `[context-diet:`；其余文本逐字一致（impl-contract §0.2 声明） |
| 8 | `hasThinking` / `assistantTurnsAfter` | TS:301-303 / 306-314 | core:390-398 / 401-414 | = | 倒序计数 assistant 完全一致 |
| 9 | `lastAssistantTimestamp` / `isCold` | TS:362-369 / 371-374 | core:416-431 / 433-455 | = | 严格 `>`（恰好等于 TTL 仍 warm） |
| 10 | `policyOf` / `eligible` | TS:339-345 / 347-360 | core:457-472 / 474-493 | = | gate 顺序、`ages[i] <= keepTurns`、`textOnly`、`chars < minChars` 同 |
| 11 | `argChars` / `elideArguments` / `eligibleArgs` | TS:392-398 / 406-419 / 421-444 | core:515-531 / 545-581 / 583-623 | = | 含 edits[]、answered/failed 过滤、hasThinking 保护；占位文本同（marker 前缀随第 7 行） |
| 12 | `decide` | TS:446-462 | core:625-645 | = | 签名与上游一致；`enabled`→`force/cold/always`→`eligible(+args)`，`cold` 是事实而非"是否裁剪" |
| 13 | `stableStringify` / `callSignature` | TS:469-476 / 478 | core:647-662 / 664 | = | 键排序、数组/对象递归一致 |
| 14 | `applyElision` | TS:494-541 | core:691-756 | = | 不改原消息、未命中共享引用、`savedChars=max(0, chars-stub.length)`、`infos` 只在 call 存在时记录、`count+argCount===0` 返回原数组 —— 全同（当前版本已无"stub 必须更小"的额外不变量） |
| 15 | `charsOfMessages` | TS:543-554 | core:758-774 | = | 字符串/JSON 计数同 |
| 16 | `Calibrator` | TS:556-600 | core:776-848 | = | 6 样本门槛、200 窗口、`sxx/sxy` 斜率、1.5..8 clamp、非有限样本丢弃 |
| 17 | `describeElided`/`describeCandidates`/`showLines`/`staleTokens` | TS:614-664 | core:851-949 | = | 排序、`~tokens` 汇总、`none` 文案、args 行前缀一致 |
| 18 | `RecoveryMeter` | TS:734-789 | core:951-1030 | = | `track` 按 id 幂等、`onCall` 命中后同签名全部 `counted`、`elided>=5 && recovered/elided>threshold` |
| 19 | 恢复/持久化 | TS:791-812（`ENTRY_TYPE`/`PROTECT_ENTRY_TYPE`/`restoreState`） | **缺失**；状态只在 `index.js:612` 起的 WeakMap | **≠ P1-2** | 重启/重载后 `elided` 与 `protectedTools` 丢失：`/show` 空白、autoProtect 保护失效（可能再次裁掉被重取的工具）。上游从 session entries 恢复 |
| 20 | `USAGE` / `parseCommand` | TS:831-877 | core:1037-1095 | ≈ | 除 `compact` 分支整体删除（impl-contract §0.3）外，别名 enable/disable、1..500、1..1440、invalid 文案全同 |
| 21 | `TOP_LEVEL` / `completions` | TS:886-921 | core:1097-1160 | ≈ | 内容同（去 compact）；但 DSH `CommandDefinition` 只有 `input?: {hint, attachments?}`（`dsh-commands/lib/types/types.d.ts:20-31`），无补全回调，故该函数**没有调用点**（P3-2，死代码/文档标注） |
| 22 | `statusLine` | TS:953-975 | core:1174-1204 | ≈ | head/body/recovery 逐字同；warming/compaction 两段按 §0.3 删除；品牌前缀改 |
| 23 | footer（上游是 `showStatus` 内联） | TS:997-1023 | core:1231-1265 `footerLine`（+ DSH 增补） | ≈ + | 两形态判据、`🥗`、`−x at the next pause`、`/req · y saved`、`↺n`、`⚠ mode always`、`enabled/showStatus=false → ''` 全对；`compact` 段删除（声明） |
| 24 | 请求→消息翻译 | pi `event.messages`（全量） | index:209-270 `readSurface` 只翻 `assistant/message` + `tool/result` | **≠ P1-3** | 对决策无害（ages 只数 assistant、eligible 只看 toolResult），但 `charsOfMessages` 的分母缺 system/user → 校准系统性偏差；且 `tool/call` 参数 JSON 字符串→对象、`reasoning`→`thinking` 的映射本身正确 |
| 25 | 统计更新 | TS:1063-1093（`lastCount=result.count` 为"本请求内全部已裁"；`cumulativeChars += savedChars` 每请求一次） | index:417-520（`lastCount=landedResults` 为"本次新落盘"；`cumulativeChars +=` 只在落盘那一次） | **≠ P1-1** | 对抗用例 F 实测：surface 内已有 4 条 stub 时 `lastCount=2`（应为 4）；后续无新落盘的请求不再更新/累加 → footer `/req` 与 `saved` 含义与上游不可比 |
| 26 | 校准接入 | TS:1077 `pendingChars = charsOfMessages(result.messages)`（每个 enabled 请求） + TS:1101-1114 `message_end` usage | index:288-336 仅在落盘 pass 设 `pendingChars`，且来自裁剪后的部分消息 | **≠ P1-3** | 实测：第一次落盘后 samples 仍为 0；第二次 pass 后才 +1。`calibrating: N of 6 requests` 实际是"6 次落盘 pass"，数字口径错误 |
| 27 | 冷门时间源 | pi message.timestamp | DSH `event.time`（epoch ms，`dsh-session` 类型注释确认） | = | 对抗用例 B 验证：回拨时钟（now<last）不冷、恰好 TTL 仍 warm、TTL+1ms 冷 |
| 28 | recovery 来源 | `pi.on("tool_call")` + `meter.onCall` | 从日志 `tool/call` 推导 | ≈ | 决策等价（用例 E 证明幂等/无重复）；但跨进程的已裁集合不恢复（同 19），保护无用户可见提示（DSH 无 notify 面，建议命令里显示） |
| 29 | `force` 边界 | TS:1075 每次 enabled 请求后清 | index:426 `messages.length===0` 早退未清 | ≈（P3-3） | 极窄条件下一次陈旧 force 会命中更晚的 pass |
| 30 | 改写时机模型 | 每请求临时改写、warm 不动 | pre-step 持久 surface 替换（+ `compaction/prune` 影子计价） | ≈ + | impl-contract §0 已声明为平台约束下的语义降级；决策算法保真、时机模型不保真，**不得表述为"与原版一致"** |
| 31 | 客户端位置 | — | `conversation.composer.dock`，id `context-diet`，order 2 | = | 官方 activity/usage 存在且 order 0/1（ui-chat:13347-13361）；ContextMeter 在 slot 之后（ui-conversation:19362）；新 id 不覆盖官方条目 |
| 32 | 客户端 manifest | — | `package.json dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-slots` | **≠ P2-3** | 0.2.1-rc.5 未安装该包；`slots` 服务实际由 `dsh-cordis-client-runner` 提供。字段是 informational（`dsh-package-manifest` 类型注明），不会致命，但事实错误 |

## 3. 逐项核验到的"真一致"（避免只报坏消息）

- 16 个被点名函数中，除上表第 7/19/20/21/22/23 行的已声明差异外，其余全部一致；`DEFAULT_CONFIG` 的 13 个共享字段默认值逐项相同。
- parity 套件不是"改写过的自证"：抽查 `isCold`（parity.test.js:561-568 vs 上游 core.test.ts:158-164）、`eligible` 边界、`applyElision` 引用语义，断言与注释行号都能对上；105 条全绿。
- 适配层落盘形状正确（对抗用例 C/E 用真实 `Session` 验证）：1:1 `tool/result` 替换、`sourceEventSeqs` 指向被替换节点、`isError` 与 `error` 载荷原样保留、`compaction/prune` 影子价只写一次。
- fail-open 成立：pre-step 内异常被捕获并 warn，始终 `return next()`；`plugin.test.js`/`session.test.js` 已覆盖，审计未发现反例。
- 客户端无自算 token、无覆盖官方条目、无定时器泄漏（卸载清理 interval + visibilitychange 监听）、空 footer 渲染 null。

## 4. 我写的 5 个上游没有的对抗用例（+2 个探针）

脚本（`/tmp/fid/adversarial.mjs`，`/tmp` 每次调用会清空，故全文如下；运行方式 `node /tmp/fid/adversarial.mjs`）：

```js
import {
  NOW, MIN, Session, appendTurn, appendUser, bigText, callRoute, createRes,
  freezeClock, mountPlugin, nextEnter, replacedSeqs, replacements, restoreClock,
  richContent, setClock,
} from '/home/z/CBAT-W/zbh/dsh-context-diet/test/helpers/harness.js'

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const preStep = (session) => ({ agent: { session }, messages: [], turn: 1, step: 1, signal: new AbortController().signal })
const config = (over = {}) => ({ enabled: true, mode: 'always', keepTurns: 1, minChars: 200, ...over })
const prunes = (s) => s.ownEvents().filter((e) => e.type === 'compaction/prune')
const stubs = (s) => s.ownEvents().filter((e) => e.type === 'tool/result'
  && typeof e.data?.message?.content?.[0]?.text === 'string'
  && e.data.message.content[0].text.startsWith('[context-diet:') && e.surfaceOp !== 'append')

// A: keepTurns 边界 + surface 中夹 user 消息
{
  freezeClock(NOW)
  const s = Session.create('A')
  const t0 = appendTurn(s, { turn: 0, callId: 'c0' })
  appendUser(s, 'between 0 and 1', 0)
  appendTurn(s, { turn: 1, callId: 'c1' })
  appendUser(s, 'between 1 and 2', 1)
  appendTurn(s, { turn: 2, callId: 'c2' })
  const h = mountPlugin(config())
  await h.emitPreStep(preStep(s), nextEnter())
  const r = replacedSeqs(s)
  check('A keepTurns=1: age 2 elided, age 1 kept', r.length === 1 && r[0] === t0.resultSeq, JSON.stringify(r))
  restoreClock()
}
// B: 时钟回拨 / 恰好 TTL / TTL+1ms
{
  freezeClock(NOW)
  const s = Session.create('B')
  const t0 = appendTurn(s, { turn: 0, callId: 'b0' })
  appendTurn(s, { turn: 1, callId: 'b1' })
  appendTurn(s, { turn: 2, callId: 'b2' })
  const h = mountPlugin(config({ mode: 'cold' }))
  setClock(NOW - 10 * MIN)
  await h.emitPreStep(preStep(s), nextEnter())
  check('B clock back: never cold', replacedSeqs(s).length === 0)
  setClock(NOW + 5 * MIN)
  await h.emitPreStep(preStep(s), nextEnter())
  check('B exactly at ttl: warm', replacedSeqs(s).length === 0)
  setClock(NOW + 5 * MIN + 1)
  await h.emitPreStep(preStep(s), nextEnter())
  check('B ttl+1ms: cold, oldest elided', replacedSeqs(s).length === 1 && replacedSeqs(s)[0] === t0.resultSeq)
  restoreClock()
}
// C: keepErrors=false 且保留 DSH error 载荷
{
  freezeClock(NOW)
  const s = Session.create('C')
  const error = { name: 'CommandError', code: 'EXIT_1', reason: 'exit status 1' }
  const e0 = appendTurn(s, { turn: 0, callId: 'e0', isError: true, error,
    content: [{ type: 'text', text: `error: boom\n${bigText('err', 300)}` }] })
  appendTurn(s, { turn: 1, callId: 'e1' }); appendTurn(s, { turn: 2, callId: 'e2' })
  const h = mountPlugin(config({ keepErrors: false }))
  await h.emitPreStep(preStep(s), nextEnter())
  const repl = replacements(s).find((e) => e.data?.message?.source?.callId === 'e0')
  check('C error result elided', repl !== undefined)
  if (repl) {
    check('C preserves isError', repl.data.message.isError === true)
    check('C preserves error payload', JSON.stringify(repl.data.error) === JSON.stringify(error))
    const text = repl.data.message.content[0].text
    check('C stub keeps error lines', text.includes('error lines:') && text.includes('boom'))
  }
  check('C one shadow price for the error result', prunes(s).length === 1 && prunes(s)[0].data.shadowedSeqs[0] === e0.resultSeq)
  restoreClock()
}
// D: 富内容（text+image）永不裁剪
{
  freezeClock(NOW)
  const s = Session.create('D')
  appendTurn(s, { turn: 0, callId: 'r0', content: richContent('rich') })
  appendTurn(s, { turn: 1, callId: 'r1' }); appendTurn(s, { turn: 2, callId: 'r2' })
  const h = mountPlugin(config())
  await h.emitPreStep(preStep(s), nextEnter())
  check('D rich result not elided', replacedSeqs(s).length === 0)
  check('D no shadow price for skipped rich result', prunes(s).length === 0)
  check('D surface untouched', s.surface.replaceGeneration === 0)
  restoreClock()
}
// E: 同一 session 两次并发 pre-step
{
  freezeClock(NOW)
  const s = Session.create('E')
  const turns = [0, 1, 2, 3].map((i) => appendTurn(s, { turn: i, callId: `e${i}` }))
  const h = mountPlugin(config())
  await Promise.all([h.emitPreStep(preStep(s), nextEnter()), h.emitPreStep(preStep(s), nextEnter())])
  const r = replacedSeqs(s)
  check('E exactly the two eligible nodes replaced once', r.length === 2 && new Set(r).size === 2, JSON.stringify(r))
  check('E no duplicate node', JSON.stringify(r.slice().sort((a, b) => a - b))
    === JSON.stringify([turns[0].resultSeq, turns[1].resultSeq]))
  check('E one shadow price per replacement', prunes(s).length === 2)
  const before = s.seq
  await h.emitPreStep(preStep(s), nextEnter())
  check('E third pass no-op', s.seq === before, `${before} -> ${s.seq}`)
  restoreClock()
}
// F（探针，不属 5 用例）：stats 语义
{
  freezeClock(NOW)
  const s = Session.create('F')
  for (const i of [0, 1, 2, 3]) appendTurn(s, { turn: i, callId: `f${i}` })
  const h = mountPlugin(config({ mode: 'cold' }), { withWebServer: true })
  const route = h.routes.find((r) => r.path === '/context-diet/stats')
  setClock(NOW + 5 * MIN + 1); await h.emitPreStep(preStep(s), nextEnter())
  for (const i of [4, 5]) appendTurn(s, { turn: i, callId: `f${i}` })
  setClock(NOW + 10 * MIN + 2); await h.emitPreStep(preStep(s), nextEnter())
  setClock(NOW + 15 * MIN + 2); await h.emitPreStep(preStep(s), nextEnter())
  const res = createRes()
  await route.handler({ method: 'GET', url: '/context-diet/stats', headers: {} }, res)
  const p = JSON.parse(res.body)
  console.log(`F: lastCount=${p.stats.lastCount} stubs-in-surface=${stubs(s).length} cumulativeChars=${p.stats.cumulativeChars} requests=${p.stats.requests}`)
  check('F lastCount reports last delta, not all elided in request', p.stats.lastCount === 2 && stubs(s).length === 4)
  restoreClock()
}
```

实测结果：**17/17 checks 通过**。逐例结论：

| 用例 | 目的（上游没有的原因） | 结果 | 说明 |
|---|---|---|---|
| A `keepTurns` 边界 + 夹 user 消息 | 上游 messages 是完整请求；DSH 适配层只翻 assistant+toolResult，须验证年龄等价 | PASS | age=2 裁、age=1 留；user 消息不干扰 |
| B 时钟回拨 / 恰好 TTL / +1ms | DSH 用 `event.time`，上游用 message.timestamp；验证适配层时间源 | PASS | 回拨不冷、等于 TTL 仍 warm、+1ms 才裁（与 core `isCold` 严格一致） |
| C `keepErrors=false` + error 载荷 | DSH `tool/result` 有 `error` 外置载荷且校验"仅 isError 时允许" | PASS | 结果被裁、`isError`/`error` 原样保留、stub 含 error 行、影子价恰好一条 |
| D 富内容（text+image） | DSH image block 真实存在；上游只测过 `{type:"image"}` 假块 | PASS | 不裁、不写影子价、surface 不动 |
| E 并发两次 pre-step | 上游单请求模型没有并发；DSH 每 step 都可能触发 | PASS | 恰好一条/节点、无重复、影子价 2 条、第三次 no-op |
| F（探针）stats 口径 | 上游统计定义 vs 适配层 | **发现 ≠** | 4 条 stub 在 surface 中，`lastCount` 仍为 2（最后一次增量为 2）→ P1-1 |
| G（探针）校准采样 | 上游每请求一采；DSH 仅落盘 pass 采 | **发现 ≠** | 第一次落盘后 `samples=0`，第二次 pass 后才 1；分母仅 14,390 chars，而 billing 475k tokens（含 system/tools/cache）→ P1-3 |

## 5. 发布前必修清单（按严重度）

### P1（阻塞；不修则不能称"移植"）

1. **统计语义对齐（TS:1086-1091 vs index.js:499-507）**：`lastCount/lastChars` 现在记录"本次新落盘"，上游记录"本请求内全部已裁"；`cumulativeChars` 现在只加一次，上游每请求累加。对外后果：footer `−x /req` 在后续冷启动后不变（少报），`/status` 的 "over N requests" 中 N 实际是"落盘次数"。修法（二选一）：(a) 每条 elided 记录原始 chars（map），每 pass 用"surface 中 stub 数 + 原始 chars 之和"重算 `last*`，并按上游语义累加 `cumulativeChars`；(b) 明确改口径：README/statusLine 改为 DSH 语义（"本次移除 / 会话内一次性移除"），并删掉 "over N requests" 措辞。
2. **重启/重载恢复（TS:791-812 缺失）**：`elided`/`protectedTools` 只在 WeakMap。后果：`/show` 空、autoProtect 保护丢失（可能再次裁掉正在被重取的工具，违背 §6 保护承诺）。修法：用 `sessionProjections`（或等价持久层）存 `{elidedIds, protectedTools}`，或每次 pass 从 surface stub 重建 `elided` + 持久化 protected 结论。
3. **校准接入（TS:1077/1101-1114 vs index.js:288-336,507）**：`pendingChars` 只在落盘 pass 设置，且分母只含 assistant+toolResult。后果：`calibrating N of 6 requests` 名不副实，`measured` 的 chars/token 可能被大偏置（本轮实测 14.4k chars vs 475k billed tokens）。修法：每次 pass 设 `pendingChars = charsOfMessages(完整翻译消息)`（`readSurface` 需纳入 user/system），或删除 measured 分支、所有 token 数字标注 "estimated (3 chars/token)"（fidelity-spec §5 明确要求不得用偏置样本宣称 measured）。

### P2（发布前应修；影响用户可见数字/事实）

4. **`/show` 的 "elided now" 尺寸在第二次 pass 起缩水**：`state.lastMessages` 每次都从已含 stub 的 surface 重读，`describeElided` 于是测到 stub 大小（实测首 pass 显示 5.1 KB，第二次 pass 后会变成 ~229 B）。修法：保留落盘时的 `infos.chars`（或原始消息）供 `describeElided` 使用。
5. **文档口径（README:55-56、index.js statusLine 文案）**：`−x /req` 被解释为"当前 surface 每次请求省多少"，实际是"最后一次落盘的量"；`cumulative over the session` 与上游"逐请求累加"不同。随 P1-1 的方案同步改。
6. **`dsh.client.inject` 事实错误（package.json）**：列出 `@deepseek-ai/dsh-client-ui-slots`，0.2.1-rc.5 无此包（`slots` 由 `dsh-cordis-client-runner` 提供）。字段为 informational（`dsh-package-manifest` 注明），不致命，但应删除或换成实际包名。

### P3（可随后修；不阻塞）

7. `estimateTokens` 上游导出、本仓库未导出（core:287）；要么导出，要么在 impl-contract §1 注明"内部函数"。
8. `completions()` 无调用点（DSH `CommandDefinition.input` 只有 `{hint, attachments?}`，无补全回调）：删除或 README 标注"DSH 无命令补全"。
9. `force` 在 `messages.length === 0` 早退时不清（index.js:426），极端情况下作用于更晚的 pass。
10. 客户端轮询无 in-flight 去重/AbortController（2s 周期，隐藏页已跳过，卸载已清理）：可加一个 in-flight 标记。
11. `recovery` 保护发生时不通知用户（DSH 无 notify 面）：建议 `/context-diet status` 增加 `protected:` 列表（当前 statusLine 已有 protected 段，`show` 可复用）。

## 6. 复现

```
cd /home/z/CBAT-W/zbh/dsh-context-diet
npm test                                              # 181/181
node --test test/parity.test.js                       # 105/105
node /tmp/fid/adversarial.mjs                         # 17/17（脚本见 §4）
# 说明：本会话 /tmp 每次 bash 调用会重建，需与脚本写入同一次调用运行
```
