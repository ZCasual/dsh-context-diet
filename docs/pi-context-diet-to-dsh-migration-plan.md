# pi-context-diet 迁移到 DSH 的插件开发计划

- 状态：仅规划，不安装 bundle、不启用复杂开发、不修改当前 profile。
- 事实基准：本机 DSH `0.2.1-rc.5`，`reference/pi-context-diet-main/` 版本 `0.3.8`。
- 目标：降低长会话中陈旧工具输出造成的上下文成本，同时保留错误线索、可恢复性和会话回放能力。

## 1. 先确认问题边界

`pi-context-diet` 不是普通摘要器，而是请求级的消息裁剪器：

1. 只在 prompt cache 已冷时决策，默认 TTL 为 5 分钟。
2. 按工具结果年龄、字符数、纯文本、错误状态和保护名单选择陈旧结果。
3. 用确定性 stub 替换结果，保留大小、工具/路径标签、末尾行和错误行。
4. 首次决定后，在后续请求复用同一组 id，保证请求前缀稳定。
5. 统计相同工具调用的重新获取；某工具反复被重新获取时，本会话停止裁剪该工具。
6. 可选地裁剪已成功的旧 `write`/`edit` 参数；可选地调用 Pi 自己的摘要器做空闲会话压缩。
7. Pi 只改发给模型的 messages，磁盘 transcript 不变；自有配置和 custom entry 之外不写工作区。

因此，迁移前必须先做一个产品决策：

> DSH 当前没有 Pi `context` 等价的“只改本次请求、不改持久历史”接口。DSH 的历史改写应走持久化 Session surface replacement；原始事件仍可回放，但当前 UI/模型表面会看到替换后的内容。

如果这个持久化语义不可接受，就不应迁移陈旧裁剪；最多保留 `tokenMeter` 的观测能力。DSH 原生 compaction 本身也会产生 durable replacement，不能宣称它等价于 Pi 的临时请求裁剪。

## 2. DSH 已有能力与覆盖判断

| Pi 能力 | 本地 DSH 能力 | 判断 | 计划动作 |
|---|---|---|---|
| 大工具结果缩成 head + marker + tail | `ctx.toolResultPruner`，默认 `8192 / 4096 / 1024` 字符 | 已覆盖 | 先验证和调参，不重复实现 |
| 上下文接近窗口时做摘要压缩 | `ctx.compaction` + `dsh-compaction-basic` | 已覆盖 | 先验证默认压力策略和失败恢复 |
| 人工立即压缩 | `dsh-command-compact` 的 `/compact` | 已覆盖 | 先确认当前 preset 是否可用 |
| 按会话回放统一计量 | `ctx.tokenMeter.measure()`、`estimateMessage()` | 已覆盖 | 所有未来策略复用，不造 tokenizer |
| 按年龄/轮数淘汰陈旧结果 | 无原生年龄策略 | 未覆盖 | 二期候选 |
| 仅 cache 冷时裁剪 | 无 cache TTL / warming decision 等价 hook | 未覆盖 | 只做近似实验，不承诺精确等价 |
| 决策后的固定集合复用 | durable surface replacement 天然固定 | 部分覆盖 | 以 replacement seq/source 引用替代 Pi id 集合 |
| 重取反馈与工具自动保护 | 无原生 recovery meter | 未覆盖 | 三期再做，先观察数据 |
| chars/token 在线校准 | token-meter 为固定启发式，并按 provider usage 做锚定 | 未覆盖 | 暂不迁移 |
| 旧 `write`/`edit` 参数裁剪 | tool-call 参数不属于可独立替换的 surface 类型 | 不宜迁移 | 明确放弃 |
| 空闲自动压缩和冷却 | compaction 支持 `compactNow`/idle，但实例属于 preset realm | 能力存在、放置复杂 | 不放入一期 |
| Pi JSON 配置 + 斜杠命令 | DSH `Config` + profile/preset patch + `commands` | 机制不同 | 先用静态配置，命令后置 |

原生组件的关键限制：`toolResultPruner` 只在 compaction 压力或 overflow 恢复触发后运行；低于压力阈值的长旧结果不会被裁剪。这正是 Pi 的年龄策略仍有价值的地方，但也是新增插件的理由，而不是重写整个 compaction 子系统的理由。

## 3. 推荐路线：原生优先，策略后置

### 阶段 0：只读基线与决策（当前阶段）

不安装、不改 profile，完成以下基线记录：

- 读取当前 profile 选用的 preset，确认 `token-meter`、`compaction-basic`、`tool-result-pruner`、`command-compact` 的实际 realm 和启用状态。
- 用现有原生能力建立三组样本：短工具结果、超大工具结果、长但尚未达到压力阈值的旧结果。
- 记录 `tokenMeter.measure()` 的 `surfaceTokens`、`projectedTokens`、节点明细和 provider usage 是否可复用。
- 检查原生 pruner 的持久替换、回放结果、错误结果和富内容结果表现。
- 形成产品决策：接受或拒绝“陈旧裁剪会落到 durable surface”。

本阶段的完成标准是有一份基线表，而不是有一个新插件。

### 阶段 1：原生组合调优（低风险、优先于新代码）

目标是先解决“结果太大”和“上下文太接近上限”，不追求 Pi 完全等价。

候选配置：

- `toolResultPruner.thresholdChars/headChars/tailChars`：按真实工具输出分布调节。
- `compaction-basic.thresholdRatio/headroomTokens/retainRatio`：按模型窗口和输出预留调节。
- `compaction-basic.modelPolicies`：对不同 provider/model 分开设置。
- `auto` 与 `/compact`：先保持原生默认行为，避免把摘要策略和裁剪策略同时改变。

这些行在 Web 标准 preset 的 `compaction` isolate group 内。若要持久改动，必须使用 preset bundle patch 或等价的 preset 编辑机制；不能只在 profile patch 里假设深合并。覆盖 preset 时 `config` 整块替换，必须重述完整 `id`、`order` 和 `plugins` 列表。

验收：

- 原生 pruner 在压力触发后把结果稳定缩短，原始日志仍可回放。
- compaction 在压力和 `CONTEXT_WINDOW_EXCEEDED` 恢复路径中可工作。
- `/compact` 的 busy、cancelled、summary、commit、persistence 失败均有可见结算。
- 新会话验证，不用旧 live agent 推断 preset 改动已生效。

### 阶段 2：陈旧结果策略 Spike（只做最小实验）

只有阶段 0 接受 durable surface 语义、且阶段 1 证明原生能力仍不能解决“长但未达压力”的问题，才进入本阶段。

建议插件名称暂定 `dsh-context-diet-policy`，第一版只做：

- 触发：`agent/pre-step`，在本步请求派生前观察当前 Session surface。
- 候选：旧于 `keepTurns`、纯文本、超过 `minChars`、非错误、非受保护工具的 `tool/result`。
- 替换：严格 1:1 的 `tool/result` surface replacement，保持 tool call id、turn/step、错误字段和元数据；replacement 必须引用唯一更早的 `sourceEventSeqs`。
- stub：确定性文本，至少含工具名/调用标签、原大小、尾部若干行，以及“原始结果仍在会话日志中，需要时重新执行/检查”的恢复提示。
- 状态：不新增 session 事件类型；已落地的 surface replacement 本身就是稳定状态。需要跨会话的统计或保护名单时，再增加纯 JSON `sessionProjections` 单元。
- 度量：只调用 `ctx.tokenMeter`，不创建自有 tokenizer。
- 失败策略：任何不确定的 surface 校验、工具配对或 append 失败，都不能静默破坏 agent；Spike 先选择 fail-open（放弃本次策略并继续原流程）还是 fail-closed（明确让 pre-step 失败），并写入验收结果。

放置尚未在 Spike 前最终决定：

- Host 插件可观察所有 agent，但可能无法直接消费 preset isolate 内的 compaction/pruner 服务。
- 将插件放入 preset 的 `compaction` realm 可以复用同一 session/compaction 词汇，但会对每个 preset 和新建 agent 生效，且需要完整 preset composition 变更。
- 首次 Spike 必须先确认 `Agent`/`Session` 的可达 API、listener 顺序、当前 preset realm 和 surface replacement 约束，再决定 Host 还是 preset。

明确不在阶段 2：

- 不裁剪 assistant 中带 `thinking`/`redacted_thinking` 的内容。
- 不裁剪 `write`/`edit` 参数；DSH 当前 surface 类型不支持安全地独立替换 tool-call 参数。
- 不做 cache warming 仲裁；DSH 没有对应的可观察暖机决策。
- 不做自动保护工具；先收集重取数据。
- 不接管 compaction 摘要器、不复制 `dsh-compaction-basic` 的区域事务。
- 不做 Client UI；先用日志、投影和测试确认行为。

### 阶段 3：恢复反馈与可见性（按数据决定）

若 Spike 证明裁剪确实节省上下文且没有明显重取伤害，再考虑：

- `sessionProjections` 记录每个工具的裁剪数、重取数、节省估算和保护状态。
- 通过 `tools/result` 观察最终结果；通过 `tool/call`/相应 session event 建立稳定调用签名。
- 提供只读状态命令或一个小型 Agent 工具，显示当前裁剪和恢复指标；操作逻辑仍由 Host service 统一实现。
- 当工具重取比例达到预设阈值时，仅保护后续结果，不回滚已经持久化的 replacement。

这一阶段才评估 UI 徽章/面板。UI 必须通过 Client slot 和 Host projection wire 数据，不能让 Client 自己折叠 session log。

### 阶段 4：不建议的扩展方向

以下功能在当前 DSH 版本不纳入迁移计划，除非后续版本提供直接 seam：

- Pi `context` 式只改单次请求而不改 durable transcript。
- `cache_warming_decision` 式缓存保温/冷却成本仲裁。
- 旧 `write`/`edit` 参数的独立历史裁剪。
- 在线 chars/token 回归校准。
- 重新实现 compaction-basic 的摘要模型、区域锁、溢出恢复和持久化协议。

## 4. 配置与数据设计原则

未来插件的配置应使用 Schemastery `Config`，而不是 Pi 风格的独立 JSON 文件。第一版可只保留：

```text
enabled: boolean = false        # Spike 默认关闭
keepTurns: integer = 20
minChars: integer = 1500
stubTailLines: integer = 3
stubErrorLines: integer = 3
neverElide: string[] = []
```

`mode: cold|always` 不应直接照搬：DSH 没有可靠的 cache cold 状态。若确实需要实验，只命名为 `agePolicy: off|approximate`，并在 UI/README 中明确它是基于事件时间的近似，而不是 provider cache 事实。

不要新增自定义 session event 类型。持久化状态优先级：

1. 原生 surface replacement 和 `compaction/*` 协议（若确实处于 compaction realm）。
2. `sessionProjections` 派生统计状态。
3. 普通 Host storage service（若不是 session-derived 数据）。
4. 不使用第三方 `appendPluginRecord()` 作为一般插件持久化方案。

## 5. 风险、停止条件和回退

| 风险 | 处理 |
|---|---|
| durable replacement 改变 UI/回放语义 | 阶段 0 先让用户确认；拒绝则停止迁移陈旧策略 |
| surface replacement 被工具配对或 source 引用校验拒绝 | 立即回退到只处理新结果的 `tools/post-execute` Spike；它不能实现年龄淘汰，但风险更小 |
| Host/preset isolate 造成服务不可见 | 先 inspect/最小测试，再决定 composition；不靠猜测插入插件 |
| replacement 让 token projection 漂移 | 复用原生 `compaction/prune` shadow-price 协议，或先把统计标为估算；不能伪造精确账本 |
| 事件时间不能代表 cache TTL | 文档中标为近似；不宣称“零 cache 成本” |
| 重取率升高 | 保护后续工具，必要时默认关闭策略；不自动回滚历史 |
| 新 preset 只影响新 agent | 每次 composition 变更都用新会话验证；旧会话只做回放对照 |
| Host 代码在进程内执行 | 安装/启用前保留用户审批，先做静态和 fake-session 测试 |

任一阶段若不能证明“模型看到的内容更短且回放可解释”，就停在上一阶段，不继续增加 UI、命令或自适应策略。

## 6. 首期验收清单

在真正编写插件之前，必须完成：

- [ ] 当前 profile/preset 的 compaction realm 和四个原生行已通过 inspect 确认。
- [ ] 原生 pruner、原生 compaction、`/compact` 的基线结果已记录。
- [ ] 用户明确接受或拒绝 durable surface replacement 语义。
- [ ] 选定 Host 或 preset 放置，并说明为什么依赖服务在同一 realm 可见。
- [ ] 写出 `agent/pre-step`、Session append、projection 和失败路径的精确 inspect 证据。
- [ ] 先以纯函数测试候选选择、stub、Unicode/富内容/错误/工具配对边界。
- [ ] 再以 fake Session 测试 1:1 replacement、幂等、重放和失败回退。
- [ ] 最后才 author bundle；安装前不执行 profile 修改、不运行未批准的 build script。
- [ ] 新会话验证 capability；根据 `application` 与 `warnings` 报告安装结果，不能用安装成功替代功能验证。

## 7. 当前结论

**推荐的最终决策是：暂不移植 Pi 的完整实现。先使用和调优 DSH 原生 token-meter + compaction-basic + tool-result-pruner；只有“低于压力阈值但陈旧工具结果仍然占据大量上下文”被基线证据证明是实际问题，才做一个默认关闭、只处理旧大纯文本 tool/result 的小型策略 Spike。**

这条路线保留 Pi 的核心经验，但尊重 DSH 的持久 surface、projection、preset isolate 和 compaction 事务约束，避免把两个运行时的 hook 语义强行拼接。
