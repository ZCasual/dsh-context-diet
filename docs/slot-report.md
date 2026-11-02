# DSH Web UI 底部状态栏（composer 下方那一行）插槽侦察报告

- 状态：只读侦察 + 可粘贴注册代码。**本次未修改任何源码**（task-7 约束：只写本文件）。
- 事实基准：本机 DSH `@deepseek-ai/dsh` **0.2.1-rc.5**，安装目录 `INSTALL=/home/z/.npm-global/lib/node_modules/@deepseek-ai/dsh`。
- 页面：`http://127.0.0.1:3080`。
- 结论一句话：那一行由 **`conversation.composer.dock`**（list / scope=session）里的两个条目 + 同一 flex 行里紧随其后的 `ContextMeter` 组成；第三方插件用**新的 id**（如 `context-diet`）+ `order` 追加即可，不替换、无 key 限制、无需改官方包。
- 证据引用中的路径缩写（均在 `INSTALL/node_modules/@deepseek-ai/` 下）：
  - `CHAT` = `dsh-client-ui-chat/lib/client.js`
  - `CONV` = `dsh-client-ui-conversation/lib/client.js`
  - `RUN` = `dsh-cordis-client-runner/lib/client.js`（Client 侧内建 inspect provider + slot catalog）
  - `RENDER` = `dsh-client-ui-renderer/lib/client.js`（Slots 服务实现）
  - `CHAT_README` / `CHAT_README_ZH` = `dsh-client-ui-chat/README.md` / `README.zh.md`

---

## 0. TL;DR

| 项 | 结论 | 主要证据 |
|---|---|---|
| 目标 slot | **`conversation.composer.dock`** | `CONV/lib/types/client/contract/slots.d.ts:311-315`（kind=list, scope=session）；`RUN:2959-3013`（inspect catalog：occupants=`activity`/`usage`） |
| 那一行是谁渲染的 | `client-ui-chat` 的 `ActivityPill`（id `activity`, order 0）+ `UsagePill`（id `usage`, order 1）；行尾「20%」是**同容器里另一个子节点** `ContextMeter`（不是本 slot 的条目） | `CHAT:13347-13363`；`CHAT:5788`（`"{turns} 轮 {steps} 步"`）、`CHAT:5789`（`"缓存命中 {percent}%"`）；`CONV:19359-19366`；`CONV:18726`、`CONV:18757-18758` |
| 追加方式 | 新 id 追加，`order: 2`（排在 usage 之后、ContextMeter 之前）；不改官方注册 | `RUN:2964-2983`（id 必填 / order 可选 / label 可选）；`CONV:19362` |
| 是否 list | 是（`kind: "list"`），additive；不会 shadow 官方条目 | `CONV:20128-20131`；`RUN:2960` |
| key 是否受限 | 不受限：`keyDomain: ""`，id 自由；**复用已占用 id 才会替换该 cell** | `RUN:2969`、`RUN:3006` |
| scope | `session`：**没有选中 Session（hero 新会话）时不渲染该 slot** | `CONV:19362`（`variant === "composer" && input !== undefined && sessionId !== undefined`）、`CONV:20128-20131` |
| 需要 inject 的包 | 客户端 manifest 建议 `"inject": ["@deepseek-ai/dsh-client-ui-conversation"]`（slot 声明方）；factory 里 Cordis `inject: ["slots"]`（要 i18n 再加 `"locale"`） | 模板 `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json` + `client.js`；`CONV:20128` |
| 数据来源 | Host 注册 `GET /context-diet/stats`，Client 每 2s 同源轮询，直接渲染返回的 `footer` 字符串（空串→null） | `docs/impl-contract.md:89-107`；`dsh-unlimited-retry/client.js:406-420`、`index.js:1277-1281` |
| 生效方式 | 新 bundle 安装/启用由 `dsh-client-hmr` 同步到已打开页面（**通常无需刷新页面、无需重启 Harness**）；手改 client.js 内容后没有 watcher 盖章 revision 时，**刷新页面**最稳；替换已安装包需要重启 | `dsh-client-hmr/README.md`（"Ordinary plugin enable/disable changes take effect without reloading the page or restarting the Host."；"replacing an installed package requires restart..." 见 skill `host-plugin.md`） |

---

## 1. 方法与限制（inspect 实测记录）

### 1.1 我做过的调用

```
cordis_inspect_list                                   → 有 client 平台 provider: Slots（listSubTree）
cordis_inspect_query(platform=client, provider=Slots, method=listSubTree)                  ×1（无 root）
cordis_inspect_query(platform=client, provider=Slots, method=listSubTree,
                    input={root:"conversation.composer.dock"})                            ×4
cordis_inspect_query(platform=client, provider=Slots, method=listSubTree,
                    input={root:"conversation.input.dock"})                               ×1
```

六次调用的原文返回（2026-11-03 01:03–01:19 CST，跨 16 分钟重试）全部是：

```
Error: Slots.listSubTree: Client inspect query Slots.listSubTree timed out after 10000ms.
Open or reconnect the Harness page, then retry.
```

判读（依据 `dsh-cordis-host-runner/lib/types/inspect-registry.js:129-175`）：

- 报错里**没有** `no connected Harness page`，说明 `typertGateway.hasLiveClient()` 为 true（有 `answers` 的 Client 事件流在线）；
- 报错里也**没有** `Client failure: ...`（`pending.failure` 为空），说明请求已广播出去、但**没有任何页面回包**；
- 因此这台机器上当前连接的 Client 不是加载了 UI/`dsh-cordis-client-runner` 的 Web 页面（或页面 bundle 未含该 provider 的应答路径）。网络层确实有到 3080 的连接（`ss -tn | grep 3080` 显示 3 条 ESTAB），但页面侧未响应。

按 SKILL 的验证纪律（`references/verification.md`：不启动独立浏览器、不翻个人浏览器 profile、不寻找/复用认证 token），我没有用 cookie/无头浏览器绕过。**本报告的所有 slot 结论改用“源码行号”证据**（task 允许：inspect 摘录**或**源码行号），并在 §7 给出页面恢复后的 inspect 复验协议与期望 JSON。

### 1.2 inspect 的返回结构是确定的（可据此比对）

Client inspect provider 由页面内的 `dsh-cordis-client-runner` 提供：

- `RUN:7075-7101`：`Slots.listSubTree` 的 `query()`；`slots.snapshot(root)` 取树，返回
  `{ requestedRoot: {name, available}, trees: [...], selected: inspectLiveSlot(...), referencedTypes: [] }`；
- `RUN:7155-7184`（`compactSlotTree`）：树节点含 `type/name/kind/scope/purpose/replaceRisk/registration/children`；
- `RUN:7185-7202`（`inspectLiveSlot`）：`selected` 含 `type/name/kind/scope/declaredBy/occupants/catalog`；
- `RUN:1957-1959`（`LiveSlotOccupant` 类型）：
  `{ registrant?: string; key?: string; id?: string; order?: number; priority: number; active: boolean }`；
- 同一文件里的静态 `SLOT_CATALOG`（生成注释见 `RUN:1112`，映射表在 `RUN:7147`）**就是** inspect 返回中 `catalog` 字段的数据源
  （`inspectSlotCatalog()` `RUN:7203-7226` 逐字段拷贝：`registration/ownerProps/standardProps/keyDomain/replaceRisk` 等）。

所以 §2 引用的 catalog 条目（`RUN:2959-3013`）不是二手猜测，它就是 inspect `catalog` 的原始负载。

---

## 2. 目标 slot：`conversation.composer.dock`

### 2.1 类型声明（官方契约）

`CONV/lib/types/client/contract/slots.d.ts:311-315`：

```ts
/** Ambient entries below the composer card. */
'conversation.composer.dock': {
    kind: 'list';
    scope: 'session';
};
```

### 2.2 inspect catalog 原文（`RUN:2959-3013`，与线上 `selected.catalog` 同源）

| 字段 | 值 |
|---|---|
| `kind` | `list` |
| `scope` | `session` |
| `summary/doc` | `Ambient entries below the composer card.` |
| `registerOptions` | `id`（required, string）、`order`（optional, number，默认 0，升序）、`label`（optional, `string \| (() => string)`） |
| `ownerProps` | `[]`（owner 不给额外 props） |
| `standardProps` | `useRemoteAccess`, `useResource`, `useWorkspaces`, `usePanelInfo`, `useSessions`, `useSessionStatus`, `useSessionRetainInfo`, `useSessionAccess`, `useWorkspaceAccess`, `useChat`, `useConversation`, `useInput`, `inputActions`, `useSession`, `sessionId`, `useProjection`, `useAccess`, `useTrajectory` |
| `keyDomain` | `""`（无枚举 key 限制） |
| `declaredBy` | `an entry in 'conversation.composer.bar' (client-ui-conversation), so it exists while that entry is mounted` |
| `occupants`（静态目录） | `client-ui-chat ActivityPill id 'activity'`、`client-ui-chat UsagePill id 'usage'` |
| `replaceRisk` | `none` |
| `example`（原文） | 见 §5 |

`id` 的官方 doc（`RUN:2969`）：

> Your cell key. Use an id of your own: a fresh id is added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it.

即：**新 id = 新增一行内的新条目；复用 `activity`/`usage` = 替换官方条目**。后者是官方支持的“替换”路径，但对本次需求（新增提示）应使用新 id。

### 2.3 这一行到底是哪几个 DOM 节点

渲染点：`CONV:19359-19366`（`InputBar` 组件内部）：

```js
19359: (0, react_jsx_runtime.jsxs)("div", {
19360:   className: InputBar_module_css_default.dock,
19361:   "data-composer-dock": true,
19362:   children: [variant === "composer" && input !== void 0 && sessionId !== void 0
19363:     ? renderSlot("conversation.composer.dock", {}) : null,
19364:     activity ? null : (0, react_jsx_runtime.jsx)(ContextMeter, { useProjection, t })]
19365: })
```

- dock 容器 CSS（`CONV:18901`，`InputBar.module.css`）：
  `.uV2eYG_dock{justify-content:center;align-items:center;gap:12px;max-width:100%;padding-top:4px;display:flex}`
  → 一个**横向 flex 行**，这正是截图里以 `·` 分隔的同一行。
- 该行的组成（DOM 顺序）：
  1. `renderSlot("conversation.composer.dock")` → 条目按 `order` 升序：`activity`(0) → `usage`(1) →（我们的）`context-diet`(2)
  2. `ContextMeter`（`CONV:18726` 起，`CONV:18757-18758` 输出 `` `${percent}%` ``）→ 截图行尾的 **`20%`**
- 文案证据（中文 locale 在 bundle 内）：
  - `CHAT:5788` `"stats.counts": "{turns} 轮 {steps} 步"` → 「18 轮 671 步」
  - `CHAT:5789` `"stats.cacheHit": "缓存命中 {percent}%"` → 「缓存命中 96%」
  - `CHAT:5887/6081` `"message.tokensPerSecond": "{tps} tok/s"` → 「239 tok/s」
  - ActivityPill 用 `joined$1(counts, speed)` 以 `·` 连接（`CHAT:7510-7520`、`CHAT:7609-7616`）；UsagePill 用 `joined$1(totalText, cacheHitText)`（`CHAT:7648-7654`）。

结论：截图那行 = `activity` 文本 + `usage` 文本 + `ContextMeter` 的百分比；**前两段属于 `conversation.composer.dock` 的两个条目，第三段不属于该 slot**。我们新增的条目会落在「缓存命中 96%」与「20%」之间——符合“同一行或紧邻位置”。

### 2.4 占用者源码：`client-ui-chat` 的注册

`CHAT:13346-13362`：

```js
13346: const statPillInject = () => ({ hooks: { performanceUsage } });
13347: ctx.slots.inject("conversation.composer.dock", function* () {
13348:   yield ctx.slots.register({
13349:     name: "conversation.composer.dock",
13350:     id: "activity",
13351:     order: 0,
13352:     locale: NS,
13353:     inject: statPillInject
13354:   }, ActivityPill);
13355:   yield ctx.slots.register({
13356:     name: "conversation.composer.dock",
13357:     id: "usage",
13358:     order: 1,
13359:     locale: NS,
13360:     inject: statPillInject
13361:   }, UsagePill);
13362: });
```

组件签名（props 形状）：

- `ActivityPill`（`CHAT:7598`）：`function ActivityPill({ useChat, useProjection, usePerformanceUsage, t })`；
  `ActivityPill` 是 `react.memo` 包裹的函数组件，`useChat`/`useProjection` 是 standardProps 里的 selector hooks，`usePerformanceUsage` 来自条目自己的 `inject: () => ({ hooks: {...} })`，`t` 来自 `locale: NS`。
- `UsagePill`（`CHAT:7636`）：`function UsagePill({ useProjection, usePerformanceUsage, t })`。

样式契约（`CHAT:7406`，`StatsPills.module.css`，即官方两个 pill 的最终样式；建议我们的条目照抄这套 token，避免“外来的”观感）：

```css
.bOPqQW_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
.bOPqQW_pill{border-radius:var(--dsw-radius-sm);max-width:100%;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  white-space:nowrap;background:0 0;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.bOPqQW_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
```

官方约定：每个统计控件在 `data-composer-stat` 上带自己的 id（`CHAT_README:71` / `CHAT_README_ZH:71`），我们沿用 `data-composer-stat="context-diet"` 便于 E2E 和人工核对。

---

## 3. 第三方 bundle 能否安全追加：逐条判定

| 问题 | 判定 | 依据 |
|---|---|---|
| 是 list 还是 single？ | **list**，additive | `CONV/.../slots.d.ts:311-315`；`RUN:2960` |
| 新 id 会替换官方吗？ | 不会；只有复用 `activity`/`usage` 才替换该 cell | `RUN:2969` |
| 是否受 key/id 枚举限制？ | 否，`keyDomain: ""` | `RUN:3006` |
| 需要特殊权限/Guard 吗？ | 不需要；`tool.view.cordis` 那种受限 key 与本 slot 无关 | `RUN:7147-7154` 的 `GUARDED_SLOT_KEYS` 只有 `tool.view.cordis` |
| scope 是 session 还是 root？ | **session** | `CONV:19362`、`CONV:20128-20131` |
| 无 session 时会渲染吗？ | **不会**：`renderSlot` 只在 `variant==="composer" && input!==undefined && sessionId!==undefined` 时调用；hero（新会话）不渲染该 slot。注册本身可以存在（slot 声明随 `conversation.composer.bar` 条目挂载），但条目不会挂载 | `CONV:19362`；`RUN:3009` |
| 需要 `dsh.client.inject` 吗？ | 建议声明 `@deepseek-ai/dsh-client-ui-conversation`（slot 声明方，同时是加载顺序/组合依赖边）。运行期即使不声明也不会崩：`ctx.slots.inject` 会**等待** slot 声明出现 | 模板 `templates/decoration/package.json`；`RENDER:1368-1423`（`inject()` 的等待/重建语义） |
| 需要 priority 吗？ | 新增 id 不需要。`priority` 只决定**同一 cell（同 id）** 多个注册谁胜出；动态生成包由 runner 自动分配（`RUN:276-284`），静态 bundle 可显式传 | `RUN:276-284`；`CHAT_README:71` |
| 会绕过官方样式/布局吗？ | 不会：它只是 dock 这个 flex 行里的一个新 flex item；但**没给条目分配额外空间**，所以内容必须单行、`white-space:nowrap`，长文本会挤 | `CONV:18901` |
| 卸载会残留吗？ | 不会：`register`/`inject` 都挂在插件 fiber 的 `ctx.effect` 上，卸载级联清理 | `RENDER:1368-1423`、`RENDER:1603-1623`（register → `_core.register` + fiber effect） |

风险高的反例（**不要**注册进去）：

- `conversation.composer.bar`（single）：注册即替换整个输入框主体（官方 `InputBar`），页面会失去输入能力。`RUN:2923-2956`，`replaceRisk: shadows-shipped-ui`。
- `conversation.input.activity`（single，工具栏活动区）：替换官方 activity 控制并改变 `ContextMeter` 的显示条件（`activity ? null : ContextMeter`）。`CONV:19362`。
- `root`（single）：注册会让整个 AppFrame 消失（`RUN:4912` 的 doc 明确写了这一点）。

---

## 4. 数据从哪来：Host 端点 + 组件 props

> 与 Lead 的实现契约 `docs/impl-contract.md` §4/§5 对齐：数据走 Host HTTP 端点，Client 只渲染 Host 生成的 `footer` 字符串（避免两套格式化）。

### 4.1 Host → Client 数据通路（已定契约）

- Host 注册 `GET /context-diet/stats`（同源、只读；`impl-contract.md:91-105` 给出了完整 JSON：
  `{ schemaVersion, sessionId, config, stats, recovery, estimate, next, footer }`）。
  `footer` 由 Host 用 `footerLine()` 生成（形如 `🥗 −1.9k /req · 286k saved ↺3`）；无活动会话时 `sessionId:null`、`footer:""`。
- Client 每 **2000ms** 轮询；`document.visibilityState !== "visible"` 时暂停；卸载后停止（`impl-contract.md:107`）。
- 实现范式（本仓库已装插件里有先例）：Client 侧 `fetch(STATS_URL, { credentials: "same-origin" })`
  （`/home/z/.dsh/profiles/web/node_modules/dsh-unlimited-retry/client.js:406-420`）；
  Host 侧 `ctx.inject(["webServer"], mountRoutes)`（同插件 `index.js:1277-1281`），并用连接层的
  `connection.requestRejection` 做认证检查（契约要求；未认证请求应 401/403，而不是泄漏数据）。
- 空串 → 组件返回 `null`，**不显示占位数字**（契约 §5）。

### 4.2 组件可用 props（本 slot 的 standardProps，本需求可以不使用）

`conversation.composer.dock` 的 `standardProps`（`RUN:2986-3005`）在 session scope 下全部可用
（`RENDER:680-706` `standardProps()`；`RENDER:773-791` `ContextualEntry` 把 kit 合成为组件 props）：

- 全局：`useSessions`、`useWorkspaces`、`useRemoteAccess`、`usePanelInfo`、`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess`、`useWorkspaceAccess`、`useAccess`
- 本 Session：`sessionId: SessionId`、`useSession`、`useChat`、`useConversation`、`useInput`、`inputActions`、`useProjection`、`useTrajectory`
- 本条目自带的 `inject: () => ({ hooks: { ... }, ...plain })` 会以 `use<Name>` + 原样 props 注入（官方 pill 的 `usePerformanceUsage` 即此路径，`CHAT:13346`）
- `t`：仅当注册时声明 `locale: NS`（`RENDER:742-746`）；不声明就没有 `t`
- 本需求用不到这些：`footer` 已是成品字符串，组件只负责渲染与轮询；`sessionId` 之类的 scope 保证由 slot 本身提供。

### 4.3 备选：改成 session 投影（**本版不做**，留档）

若以后想省掉轮询，可给现有投影补 `wire` 让客户端经 `useProjection('contextDiet')` 读取：

1. 现状：`/home/z/CBAT-W/zbh/dsh-context-diet/index.js:627-650` 已注册 session 投影 `key: 'contextDiet'`，但**没有 `wire` 块**；按 `dsh-session-projection/README.md`，无 `wire` 的单元是 **host-only**，客户端读不到。
2. 需要同时补：(a) 折叠时把 `lastChars/cumulativeChars/requests`（上游 `core.js:412` 的 `Stats`，`core.js:440` 有 `estimateTokens(...)` 现成写法）累进投影状态并 bump `stateVersion`（当前 `createStateSchema()` 只认 `{elided, refetched, signatures, pending}`，`index.js:403-411`）；(b) `wire: { viewSchema, view }` 输出客户端视图；(c) 组件用 `props.useProjection('contextDiet')`。
3. 代价：要动持久投影状态与 `stateVersion`（缓存/回放兼容成本），且 TS 侧需要 `declare module '@deepseek-ai/dsh-session-projection/types'` 合并 `SessionProjectionMap`；而它并不能比 Host 端点多给信息。**结论：首版按契约走 HTTP 轮询。**

---

## 5. 可直接粘贴的注册代码

### 5.1 `client.js`（新增文件；bundle 格式与 `dsh-unlimited-retry/client.js`、官方模板一致）

```js
/**
 * dsh-context-diet — browser half.
 *
 * 在输入框卡片下方那行统计（activity · usage · 上下文 %）里追加一个常驻条目。
 * 注册进 conversation.composer.dock（list / scope=session），新 id 追加，不替换官方条目。
 * 数据来自 Host 端点 GET /context-diet/stats 的 footer 字符串（见 docs/impl-contract.md §4）。
 *
 * Bundle format: window.__ModuleLoader__.load({ id, factory })，id 必须等于包名。
 * 只有 platform seed words（react / react/jsx-runtime / @deepseek-ai/dsh-client-store）
 * 可以直接 require；本文件只 require react，因此 dsh.client.external 不需要声明。
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-diet',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const STATS_URL = '/context-diet/stats';
    const POLL_MS = 2000;

    /** 与官方统计行同一行的视觉契约：11–12px、label-secondary，数字用 tabular-nums。 */
    const STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 2px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11.5px',
      lineHeight: '20px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    };
    /** 契约 §5：`−Nk /req` 段用 label-primary 提亮。 */
    const EMPHASIS = { color: 'var(--dsw-alias-label-primary)' };

    /** 只提亮 "−Nk /req" 段；其它形态（🥗 on / at the next pause / ⚠ suffix）原样显示。 */
    function FooterText({ text }) {
      const matched = /^(.*? \/req)([\s\S]*)$/.exec(text);
      if (matched === null) return h('span', { style: STYLE }, text);
      return h('span', { style: STYLE },
        h('span', { style: EMPHASIS }, matched[1]),
        matched[2]);
    }

    function DietDockEntry() {
      const [footer, setFooter] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        let timer = 0;
        const read = async () => {
          if (document.visibilityState !== 'visible') return;   // 后台标签页暂停请求
          try {
            const response = await fetch(STATS_URL, {
              cache: 'no-store',
              credentials: 'same-origin',                        // 认证 cookie 随同源请求
              headers: { accept: 'application/json' },
            });
            if (!response.ok) return;                            // 401/403/5xx：保留上一条文本
            const payload = await response.json();
            if (alive) setFooter(typeof payload?.footer === 'string' ? payload.footer : '');
          } catch {
            /* fail open：网络失败时保持上一条文本，不抛错、不占位 */
          }
        };
        const tick = () => {
          read();
          timer = window.setTimeout(tick, POLL_MS);
        };
        const onVisibility = () => {
          if (document.visibilityState === 'visible') read();
        };
        tick();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          alive = false;
          window.clearTimeout(timer);                            // 卸载即停，不留定时器
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, []);

      if (footer === '') return null;                            // 契约：空串不占位
      return h('span', { 'data-composer-stat': 'context-diet', title: footer },
        h(FooterText, { text: footer }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 只在该 slot 的声明存活期内注册；声明晚到/重建/卸载都会自动跟随。
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'context-diet',   // 必须是自己的 id；不要用 'activity' / 'usage'
          order: 2,             // 0=activity, 1=usage；2 落在 usage 之后
          label: 'Context diet',
        }, DietDockEntry)), 'context-diet: composer dock entry');
      },
    };
  },
});
```

> 条目级 `inject` 是 `ctx.slots.register` 的可选项（官方 pill 用它注入 `usePerformanceUsage`，`CHAT:13346`）：状如 `inject: () => ({ hooks: { statsFeed } })`，组件 props 收到 `useStatsFeed`（`RENDER:736-772`）。本方案由组件自管轮询，故省略；若把轮询提升为共享 store，再补这个字段。

> 若还要 i18n（本 footer 已由 Host 生成，通常不需要）：上面的 `inject` 数组加 `'locale'`，`apply` 里 `const t = ctx.locale.bind('contextDiet'); ctx.effect(() => ctx.locale.register('contextDiet', { zh, en }))`，注册时加 `locale: 'contextDiet'` 即可拿到 `t`（模式见 `dsh-unlimited-retry/client.js:1337-1352`）。

### 5.2 `package.json` 需要的改动（新增 client half 才能被宿主加载）

```diff
   "exports": {
     ".": "./index.js",
+    "./client": "./client.js",
     "./locale/*.json": "./locale/*.json",
     "./icon": "./icon.svg",
     "./package.json": "./package.json"
   },
   "files": [
     "index.js",
+    "client.js",
     "cordis.patch.yml",
     ...
   ],
   "dsh": {
     "manifestVersion": 1,
     "bundle": { "patch": "./cordis.patch.yml" },
+    "client": {
+      "platform": "web",
+      "immediately": true,
+      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
+    }
   }
```

Host 半不需要改 patch：`index.js` 的 `apply()` 已经存在，`cordis.patch.yml` 的 row 不变。

> 注意：改 `exports`/`files` 会牵动 `test/package.test.js` 对包清单的断言（该测试由 test-parity 维护）；落地 client half 时需要同步更新，或先与 Lead 确认顺序。

### 5.3 inject 依赖清单

| 位置 | 声明 | 必要性 | 依据 |
|---|---|---|---|
| `package.json` → `dsh.client.platform` | `"web"` | 必需 | `dsh-client-modules/lib/index.js:65`（`platform` 必须存在） |
| `package.json` → `dsh.client.immediately` | `true` | 建议 | stage-one prefetch，减少首帧闪空；模板同款 |
| `package.json` → `dsh.client.inject` | `["@deepseek-ai/dsh-client-ui-conversation"]` | 建议（组合/到达顺序） | 模板 `templates/decoration/package.json`；slot 由 `client-ui-conversation` 声明（`CONV:20128`） |
| `package.json` → `dsh.client.external` | 不必 | — | 只 require `react`（platform seed word）；模板/参考插件均同 |
| client factory 的 Cordis `inject` | `["slots"]`，要 i18n 再加 `"locale"` | 必需 | `RENDER:1368`（服务名 `slots`）；`CHAT:13347` 用法同款 |
| host 半 Cordis `inject` | 顶层 `['tokenMeter','sessionProjections','commands']` 不变；挂路由用 `ctx.inject(["webServer"], mountRoutes)`（不写进顶层数组，webServer 缺失时降级） | 需要（契约 §4） | `/home/z/CBAT-W/zbh/dsh-context-diet/index.js:74`；`dsh-unlimited-retry/index.js:1277-1281` |

---

## 6. 生效条件（刷新 / 重启）

| 变更 | 生效方式 | 依据 |
|---|---|---|
| 新安装一个带 `dsh.client` 的 bundle（新增行） | `plugin_manager install_bundle` 返回 `application: applied` 后，`dsh-client-hmr` 把新 graph 行推到已打开页面，**通常无需刷新、无需重启** | `dsh-client-hmr/README.md`（"Ordinary plugin enable/disable changes take effect without reloading the page or restarting the Host."） |
| 首次能否显示还取决于页面状态 | 必须**已选中一个 Session**（hero 新会话不渲染 dock） | `CONV:19362` |
| 手改 `client.js` 内容（没有 `pnpm run dev:web` watcher 盖章 revision） | 客户端 bundle 按 `rev` 缓存；没有重建/盖章时页面不会重新拉取 → **刷新页面**最稳；仍不生效则重启 Harness | `dsh-client-hmr/README.md` 的 dev watcher 段；skill `host-plugin.md`："replacing an installed package requires restart to load a fresh JavaScript module generation" |
| 已在 profile 里装过同名包再替换 | 需要重启 Harness 才能换 JS module generation | 同上 |
| 只是启用/禁用行 | HMR 即时生效，无需刷新 | `dsh-client-hmr/README.md` |

**不要**把“slot id 没变”当成“浏览器代码已更新”的证据（skill `host-plugin.md` 明确警告）。

---

## 7. 验证协议（“真的显示了”）

### 7.1 前置

1. 已安装 bundle（`plugin_manager install_bundle`，target 为包目录），返回 `application: applied` 且无 `warnings`。
2. 页面打开且**选中了一个 Session**（hero 页不渲染 dock）。
3. `cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={"root":"conversation.composer.dock"})` 不再超时。

### 7.2 证据 A：inspect occupants 含我们的 id（硬证据）

期望返回（结构来自 `RUN:7075-7101` + `RUN:7185-7202` + `RUN:1957-1959`；`priority` 数值由渲染器分配，**断言时不要写死**）：

```json
{
  "requestedRoot": { "name": "conversation.composer.dock", "available": true },
  "trees": [{
    "type": "slot",
    "name": "conversation.composer.dock",
    "kind": "list",
    "scope": "session",
    "purpose": "Ambient entries below the composer card.",
    "replaceRisk": "none",
    "registration": [
      { "name": "id",    "type": "string",             "required": true  },
      { "name": "order", "type": "number",             "required": false },
      { "name": "label", "type": "string | (() => string)", "required": false }
    ],
    "children": []
  }],
  "selected": {
    "type": "slot",
    "name": "conversation.composer.dock",
    "kind": "list",
    "scope": "session",
    "declaredBy": "an entry in 'conversation.composer.bar' (client-ui-conversation), so it exists while that entry is mounted",
    "occupants": [
      { "registrant": "client-ui-chat", "id": "activity",     "order": 0, "priority": "<n>", "active": true },
      { "registrant": "client-ui-chat", "id": "usage",        "order": 1, "priority": "<n>", "active": true },
      { "registrant": "dsh-context-diet", "id": "context-diet", "order": 2, "priority": "<n>", "active": true }
    ],
    "catalog": { "description": "Ambient entries below the composer card.", "registration": [ "…同上…" ], "standardProps": [ "…" ] }
  },
  "referencedTypes": []
}
```

注：`registrant` 取自注册时的 Cordis fiber 名（`RENDER:1605`：`options.registrant ?? this.ctx.fiber?.name`），实际值取决于 loader row 名（本插件预期 `dsh-context-diet`），**断言时只看 `id`/`order`/`active`，不要依赖 `registrant` 字符串**。
**通过判据**：`selected.occupants` 中存在 `{ id: "context-diet", active: true }`，且 `order === 2`，且官方两条仍在。
**失败判据**：
- `requestedRoot.available === false` → slot 未声明（会话未选中，或 ui-conversation 的 composer.bar 条目没挂载）；
- `occupants` 里没有我们 → 注册没生效（client bundle 未加载 / slot.inject 的 effect 被 dispose / id 拼错）；
- 我们**替换**了 `usage`（occupants 少一条、多一条同 id）→ id 撞了。

### 7.3 证据 B：DOM 文本（用户可见证据）

页面 DevTools Console（或任何 E2E 断言）：

```js
// 0) 先确认数据端点（同源、带 cookie）
await (await fetch('/context-diet/stats', { credentials: 'same-origin' })).json();
// 期望 { schemaVersion:1, sessionId:"…", footer:"🥗 −1.9k /req · 286k saved ↺3", … }
// 1) 行容器存在
const dock = document.querySelector('[data-composer-dock]');           // CONV:19361
// 2) 我们的条目在容器内，且文本正确
const el = dock.querySelector('[data-composer-stat="context-diet"]');
el?.textContent;          // 期望匹配 /^🥗 −\d+(\.\d+)?k \/req( · \d+k saved)?( ↺\d+)?$/
// 3) 官方两个条目仍在其前面（顺序证据）
[...dock.children].map(n => n.getAttribute('data-composer-stat'));
// 期望 ["activity", "usage", "context-diet"]（ContextMeter 是第 4 个子节点，无该属性）
// 4) 同一行：容器是 flex 行
getComputedStyle(dock).display;   // "flex"
```

人工核对：该文本应出现在「缓存命中 NN%」与「NN%」（ContextMeter）之间；字号/颜色按 `impl-contract.md` §5（11–12px、`label-secondary`、`−Nk /req` 用 `label-primary`），与两侧统计并排时视觉可接受；浅色/深色主题各看一次。

### 7.4 证据 C：无回退/无崩溃

- 页面 Console 无 `slot ... crashed` / `slot factory occurrence crashed`（`RENDER:650-660` 的边界捕获日志）。
- 卸载插件（disable）后条目消失、官方两个条目仍在（证明不是替换）。
- 端点返回 `footer: ""`（无活动会话 / 无裁剪）时组件 `return null`，**不显示占位 0**。
- 切到后台标签页 ≥2s：DevTools Network 里 `/context-diet/stats` 请求暂停；切回后恢复。
- 禁用插件后：Network 不再出现该端点的周期请求（定时器已清）。

---

## 8. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **无 session 不显示** | 新会话 hero 页看不到；用户会以为是坏的 | 明确口径：这是 session 级环境信息；或备选 `shell.overlay`（root scope） |
| 2 | 该行**没有弹性空间**（flex 行、nowrap、gap 12px） | 窄窗口会挤压/溢出，甚至挤掉 ContextMeter | 文案保持短（目标 ≤ 28 字符）；`max-width` + `text-overflow:ellipsis`；窄屏可用 `@media` 隐藏 `saved` 段 |
| 3 | 官方**替换语义**的双刃剑 | 误用 id `activity`/`usage` 会顶掉官方统计；误注册 `order` 相同值的同 id 也可能抢 cell | 用新 id `context-diet`；代码里写死断言 id 不等于官方 id |
| 4 | **HMR/缓存**导致“代码改了页面没变” | 误判为“slot 不支持” | 先刷新页面；仍不变再重启 Harness；inspect 看 occupants 的 `active` |
| 5 | （仅备选方案）投影 wire 改动 | 若 `stateVersion` 未 bump 或 `view` 返回新对象引用，会触发无谓发布/缓存不兼容 | `view` 保持引用稳定（README 的 `Object.is` 说明）；bump `stateVersion` |
| 5b | **轮询成本 / 后台耗电** | 每 2s 一个同源 GET；标签页在前台时才有请求 | 按契约 `visibilityState` 暂停；`cache: "no-store"` 避免中间层缓存 |
| 5c | 端点认证 | 若不做 `connection.requestRejection` 检查，其他用户/远程客户端可读会话统计 | Host 侧按 `impl-contract.md:91` 用连接层拒绝未认证请求 |
| 6 | （仅备选方案）`useProjection` 类型表 | TS 侧 key 不在 `SessionProjectionMap` | 运行期无碍；如用 TS 则 declare module 合并 |
| 7 | 与官方同一行竞争焦点/点击 | 我们的 span 不可点击，无焦点问题；若加按钮需自己处理 pointer events | 首版保持纯文本 |
| 8 | 版本漂移 | slot 契约随 DSH 版本变（本报告基于 0.2.1-rc.5） | `engines.dsh` 已锁 `>=0.2.1-rc.5 <0.3.0-0`；升级后按 §7 复验 |

---

## 9. 备选 slot（≥2）与不推荐项

### 备选 A：`conversation.input.dock` —— 输入框卡片**上方**的整行（最接近“紧邻位置”）

- 契约（`RUN:3339-3398`）：`kind: list`，`scope: session`，`registerOptions` 同 `id/order/label`，`ownerProps: InputZone = { readonly session: SessionSnapshot; readonly input: InputState }`，`standardProps` 与目标 slot 相同（含 `useChat/useProjection/sessionId` 等）。
- 现状 occupants：`QueueDock id 'queue'`、`TodoDock id 'todo'`、`GoalDock id 'goal'`、`experimental-client-ui-claude-code-mods Band id 'claude-code-mods'`（`RUN:3390-3395`）。
- 适用：希望提示**单独占一行卡片**、带边框/背景，而不是塞进统计行。`replaceRisk: none`。
- 代价：视觉上比那一行更高、更显眼；`QueueDock/TodoDock` 已占用时多一块面板，可能显得拥挤。

### 备选 B：`conversation.input.right` —— 输入框工具行里、发送按钮之前

- 契约（`RUN:3671-3727`）：`kind: list`，`scope: session`，`id/order/label`，`ownerProps: []`，`standardProps` 同上；官方当前 **occupants 为空**。
- 适用：想要“常驻但不打扰”的小徽标；`order` 放在模型选择器/发送按钮之间。
- 代价：工具行空间紧张（`@container (width<=560px)` 会缩 gap，`CONV:18901`），只适合极短文本（如 `🥗 286k`），长文案会被挤。

### 备选 C：`shell.overlay` —— 帧级浮层（**root scope，无 session 也渲染**）

- 契约（`RUN:5481-5539`）：`kind: list`，`scope: root`，`id/order/label`，`ownerProps: []`；doc 原文说 “a badge, a toast stack or a status pill all belong here … The layer itself is click-through — entries opt back into pointer events”。
- 适用：必须“随时随地可见”（包括 hero/无会话页）且在页面右下/右上做悬浮胶囊。
- 代价：需要自己定位（`position: fixed`），与 composer 那一行不是同一行；`replaceRisk: none`，但容易遮挡内容。

### 不推荐（会破坏官方 UI）

| slot | 原因 |
|---|---|
| `conversation.composer.bar` | `kind: single`，occupants=`InputBar`；注册即替换整个输入框（`RUN:2923-2956`，`replaceRisk: shadows-shipped-ui`） |
| `conversation.input.activity` | `kind: single`，替换工具栏活动区，并连带改变 `ContextMeter` 的渲染（`CONV:19362`） |
| `root` | `kind: single`，注册会让 AppFrame 整体消失（`RUN:4912` 的 doc 已明说） |

---

## 10. 复验清单（页面恢复后 5 分钟跑完）

1. 打开 `http://127.0.0.1:3080`，进入一个已有消息的 Session；Console 里 `await (await fetch('/context-diet/stats',{credentials:'same-origin'})).json()` 应返回 `footer`。
2. `cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={"root":"conversation.composer.dock"})` → 按 §7.2 断言 occupants。
3. Console 跑 §7.3 的四行断言。
4. 深/浅主题各截一屏，确认与官方两段统计同色同字号。
5. 禁用插件 → 条目消失、官方两条仍在；重新启用 → 条目回来（验证 disposer 干净）。

---

## 附录：关键源码位置索引

| 内容 | 位置 |
|---|---|
| slot 契约（kind/scope） | `CONV/lib/types/client/contract/slots.d.ts:311-315` |
| inspect catalog（`conversation.composer.dock` 全量） | `RUN:2959-3013` |
| inspect 输出构造（trees/selected/occupants） | `RUN:7075-7101`、`RUN:7155-7184`、`RUN:7185-7202` |
| `LiveSlotOccupant` 形状 | `RUN:1957-1959` |
| 官方注册（activity/usage） | `CHAT:13347-13363` |
| ActivityPill / UsagePill 组件与 props | `CHAT:7598-7634`、`CHAT:7636-7680` |
| 中文统计文案 | `CHAT:5788-5789`、`CHAT:5887` |
| 统计 pill 样式 token | `CHAT:7406` |
| dock 渲染 + ContextMeter 兄弟节点 | `CONV:19359-19366` |
| 输入框 dock 容器 CSS（flex 行） | `CONV:18901` |
| ContextMeter（`NN%`） | `CONV:18726`、`CONV:18757-18758` |
| composer.bar 条目声明子 slot | `CONV:20128-20131` |
| `slots.inject` 等待/重建语义 | `RENDER:1368-1423` |
| standardProps 合成 | `RENDER:680-706`、`RENDER:736-772`、`RENDER:773-791` |
| 动态包的 priority 自动分配 | `RUN:276-284` |
| 官方说明（两个条目/order/替换/data-composer-stat） | `CHAT_README.md:71`、`README.zh.md:71` |
| client manifest 字段（platform/immediately/inject/external） | `dsh-client-modules/lib/types/client/manifest.d.ts:43-66` |
| HMR 生效条件 | `dsh-client-hmr/README.md`（Use this package） |
| 插件模板（package.json + client.js） | `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/` |
| 现有投影（host-only，无 wire） | `/home/z/CBAT-W/zbh/dsh-context-diet/index.js:627-650` |
| Host→Client 数据契约（端点 JSON / 轮询 / footer） | `/home/z/CBAT-W/zbh/dsh-context-diet/docs/impl-contract.md` §4–§5 |
| 同源 fetch + host 路由先例 | `dsh-unlimited-retry/client.js:406-420`、`dsh-unlimited-retry/index.js:1277-1281` |

---

### 附：本次交付的边界

- 本文件之外**未写任何文件、未改任何源码、未安装/启用插件**（task-7 约束）。
- §5 的 `client.js` 与 `package.json` diff 是可直接落地的完整改动；§4.1 的 Host 端点 `GET /context-diet/stats`（`footer` 字符串）是显示真实数字的前置条件（契约见 `docs/impl-contract.md` §4–§5）。落地顺序建议：Host 端点 → client half → `install_bundle` → §7 验证。
