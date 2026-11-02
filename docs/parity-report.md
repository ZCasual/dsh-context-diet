# parity.test.js 验收报告（上游行为等价证明）

> 结论先行：`test/parity.test.js` 把上游 `tests/core.test.ts`（748 行）与 `tests/commands.test.ts`
> 里可移植的纯逻辑断言逐条搬到 DSH，每条注明上游 `file:line`。当前 **105 / 105 全绿**。
> 这份报告是给 core-port 的验收记录，也是"不是自认为一致"的证据索引：任何一条断言变红，
> 都能追溯到上游源码的具体行号，而不是本仓库自造的期望值。

- 测试文件：`test/parity.test.js`（1276 行，ESM + `node:test`）
- 运行：`node --test test/parity.test.js`
- 被测对象：`core.js` 的冻结导出（只 import 契约 §1 列出的符号，不 import DSH/Pi 运行时）
- 上游基线：`/home/z/CBAT-W/zbh/reference/pi-context-diet-main/{extensions/context-diet.ts,tests/core.test.ts,tests/commands.test.ts}`

## 1. 当前结果

| 指标 | 值 |
|---|---|
| 用例总数 | 105 |
| 通过 | 105 |
| 失败 | 0 |
| skip / todo | 0 / 0 |
| 断言来源 | 直接搬运 `TESTS/core.test.ts` 80 条、`TESTS/commands.test.ts` 13 条、`TESTS/extension.test.ts`（footer 形态）7 条、`TESTS/fuzz.test.ts`（sanitize 幂等）1 条；其余 4 条按上游源码行/规格推导（注释标注 `TS:`/`spec`），全部不发明阈值 |

最后一次失败（已由 core-port 修复，保留为验收记录）：

| 项 | 内容 |
|---|---|
| 用例 | `statusLine > reports settings and savings` |
| 位置 | `core.js:1176`（`statusLine` 的 head 模板） |
| 实际 | `pi-context-diet: on · mode cold · …` |
| 期望 | `context-diet: on · mode cold · keep last 20 turns · cache ttl 5 min · min 1.5 KB · write/edit args elided` |
| 依据 | lead 裁决：凡上游字面量 `pi-context-diet` 一律替换为 `context-diet`，其余文字逐字保留 |
| 状态 | **已修复（core-port 确认：statusLine/stubText/elidedArg 三处品牌统一为 `context-diet`，`STUB_MARKER='[context-diet:'`），105/105** |

## 2. 覆盖矩阵（a–m ↔ 上游行号）

| 任务项 | describe 块 | 用例数 | 上游出处 |
|---|---|---|---|
| b) 冻结常量 | frozen constants | 3 | core.test.ts:82, 386；impl-contract §1 |
| b) DEFAULT_CONFIG 13 项 | DEFAULT_CONFIG | 2 | core.test.ts:83-102；impl-contract §2 |
| c) measure（textOnly/chars/lines） | measure | 5 | core.test.ts:14-33；TS:217-229 |
| 格式化（stub/footer 依赖） | formatSize / formatTokens | 2 | core.test.ts:70-79 |
| a) sanitizeConfig | sanitizeConfig | 7 | core.test.ts:263-297；TS:104-139；fuzz:92-103 |
| d) previewOf | previewOf | 7 | core.test.ts:319-351；TS:281-289 |
| e) stubText 逐字 | stubText | 3 | core.test.ts:84-92, 352-360；TS:292-298 |
| 轮次年龄 | assistantTurnsAfter | 1 | core.test.ts:95-101；TS:306-314 |
| f) eligible 7 个 gate | eligible | 7 | core.test.ts:103-149；TS:347-360 |
| h) 冷判定 | cold detection | 2 | core.test.ts:152-164；TS:362-374 |
| h) decide 全 gate | decide | 6 | core.test.ts:167-190；TS:446-462 |
| i) applyElision 纯函数契约 | applyElision | 12 | core.test.ts:192-244, 433-443, 462-493；TS:494-536 |
| g) argChars | argChars | 1 | core.test.ts:379-387；TS:392-398 |
| g) elideArguments 占位符逐字 | elideArguments | 2 | core.test.ts:389-404；TS:400-418 |
| g) eligibleArgs | eligibleArgs | 5 | core.test.ts:407-460, 485-493；TS:421-443 |
| RecoveryMeter 签名 | call signatures | 2 | core.test.ts:496-509；TS:469-480 |
| j) Calibrator | Calibrator | 6 | core.test.ts:594-642；TS:556-600 |
| k) RecoveryMeter | RecoveryMeter | 6 | core.test.ts:511-558；TS:734-784 |
| l) USAGE | USAGE | 1 | core.test.ts:831-832（dsh：删 compact 段） |
| l) parseCommand 全表 | parseCommand | 10 | commands.test.ts:5-47；TS:834-877 |
| l) completions | completions | 4 | commands.test.ts:48-84；TS:879-921（dsh：删 compact 项） |
| m) statusLine 三段 | statusLine | 4 | core.test.ts:306-316, 576-582；TS:953-975 |
| m) footerLine 两形态 | footerLine | 7 | extension.test.ts:92-104, 353-360, 439-472, 493-500；TS:997-1023；impl-contract §3 |

`TS:` 前缀 = `extensions/context-diet.ts` 行号；`core.test.ts:` / `commands.test.ts:` / `extension.test.ts:` = 上游测试行号；`fuzz:` = `tests/fuzz.test.ts`。

## 3. DSH 决策与上游的差异（已在测试中锁定，均经 lead 拍板）

| 决策 | 锁定的期望 | 位置 |
|---|---|---|
| 13 项 DietConfig | `Object.keys(DEFAULT_CONFIG).length === 13`，且不含 `compact*`/`warmArbitration`/`expectedTurns`/`stopWarmingShare`/`maxPerPass`/`agePolicy` | DEFAULT_CONFIG |
| 品牌前缀全局替换 | stub / 参数占位符 / statusLine 一律 `context-diet`（无 `pi-`、无 `dsh-`）；`STUB_MARKER === "[context-diet:"` | stubText / elideArguments / statusLine / frozen constants |
| 字符单位 = 上游 UTF-16 `String.length` | `measure("😀").chars === 2`、`measure("a😀b").chars === 4`（**不改 code point**，lead 2026-11-03 裁决） | measure |
| 不做 compact / warming | `parseCommand("compact …")` 为 invalid；`USAGE` / `completions` / `statusLine` 中不出现 compact/warming | USAGE / parseCommand / completions / statusLine |
| `footerLine` 是纯函数 | 空串 `''`（不是 null）；形态 A 的 next 由 `extra.next`（tokens）传入（实现宽松兼容 `{next:number}` / `{next:{chars,tokens}}` / `{nextTokens}` / `{nextChars}`，测试锁定 `{next:1900}`）；形态 B 拼接顺序 `saved ↺n ⚠ mode always` | footerLine |
| 契约 §3 之外不锁定第三段 | `statusLine(..., extra)` 只做反向断言：`/compact|warming/i` 必须不匹配，具体文案留给实现 | statusLine |

## 4. 验收用法

```bash
cd /home/z/CBAT-W/zbh/dsh-context-diet
node --test test/parity.test.js     # 期望 105/105，0 skip
```

- 变红 = core.js 偏离上游或偏离 lead 决策；**禁止改测试期望让它变绿**，除非先改上游依据/lead 决策。
- 每条 `it()` 上方都有 `// parity: <上游文件>:<行号>` 注释；`// dsh:` 注释标出 DSH 相对上游的差异点。
- 本文件只 import `core.js` 的冻结导出；`core.js` 增删导出是契约变更，须先改 `docs/impl-contract.md`。

## 5. 未覆盖项（不属于本文件职责）

- `describeElided` / `describeCandidates` / `showLines` / `staleTokens` / `restoreState` / `isStubbed` 的完整断言 → `test/unit/core.test.js`。
- DSH 真实 Session（cold gate、force、恢复、replay、并发）→ `test/plugin.test.js` / `session.test.js` / `session-contract.test.js`。
- Host 端点 + Client 渲染静态契约 → `test/footer.test.js`。
