# dsh-context-diet

A DeepSeek Harness (DSH) bundle that **elides stale, oversized tool results from the
model-visible session surface** and shows what it saved in the composer footer.

It is a port of [pi-context-diet](https://github.com/sorinirimies/pi-context-diet)
(MIT, Copyright (c) 2026 sorinirimies) to DSH's durable session-surface model. The
policy core is a line-by-line port; the adapter translates DSH events into the
message shapes that core expects.

The goal is not only fewer tokens. A long session re-sends build logs, file dumps
and exploration noise on every step, and that noise competes with the material the
model actually needs. Removing it when the prompt cache is already cold keeps the
working set small and the model focused, at no cache cost.

- Status: **enabled by default**, Host + Client bundle, no build step.
- Version anchor: developed against `@deepseek-ai/dsh` **0.2.1-rc.5**.

## What it does

At the pre-step phase the plugin looks at the current session surface, and when the
prompt cache is cold — the last assistant message is older than `cacheTtlMinutes` —
it replaces old, large, plain-text `tool/result` nodes with a deterministic stub.

A stub keeps the tool identity, the original size, a few tail lines and any error
lines, so an exit status or a failure survives:

```text
[context-diet: the output of bash npm test (5.0 KB, 120 lines) was elided from the
context to save tokens. Re-run it if you need it again.
error lines:
  error[E0432]: unresolved import `x`
last lines:
  BUILD FAILED in 4s
  exit code 1]
```

The replacement is a 1:1 durable `tool/result` surface replacement
(`surfaceOp: { op: 'replace', startSeq, endSeq }`, `sourceEventSeqs: [seq]`),
preceded by the native pruner's log-only `compaction/prune` shadow price. The
original event stays in the log; only the model-visible copy is shorter.

## The footer

The composer footer shows the same three facts pi's status line shows:

| State | Text |
|---|---|
| Nothing elided yet | `🥗 −12.4k at the next pause` (what the next cold start would drop) |
| Nothing to elide | `🥗 on` |
| After a pass | `🥗 −1.9k /req · 286.0k saved` |
| A tool had to be re-fetched | `… ↺3` |
| `mode: always` | `… ⚠ mode always` |

`−x /req` is what the current surface saves on every request; `y saved` is the
cumulative total over the session; `↺n` counts re-fetches. The footer hides itself
when `enabled: false` or `showStatus: false`.

## Protection: what is never elided

The gates are the upstream ones, in the upstream order:

| Gate | Rule |
|---|---|
| Cache warmth | Only when the last assistant message is **strictly older** than `cacheTtlMinutes`; no timestamp means never. |
| Recency | Results from the last `keepTurns` assistant turns stay. |
| Size | Results below `minChars` stay. |
| Errors | `keepErrors: true` (default) keeps every failed result, whatever its size. |
| Tools | `neverElide` names are never touched. |
| Rich content | Images, attachments and any non-plain-text block are never touched. |
| Growth | A stub must be strictly smaller than what it shadows, or the replacement is refused. |
| Re-fetch feedback | When an identical call is re-issued after elision it is counted; at more than `recoveryThreshold` of a tool's elided results (with at least 5 samples) that tool is protected for the rest of the session. |
| Failure | Any error in the pre-step fails open: the turn continues untouched. |

## Commands

| Command | Effect |
|---|---|
| `/context-diet` | Status: settings, per-request and cumulative savings, cold starts, recovery. |
| `/context-diet show` | What is elided now, and what the next cold start would take. |
| `/context-diet on` / `off` | Toggle for this session. |
| `/context-diet now` | One pass on the next step, accepting one cache rewrite. |
| `/context-diet keep <1-500>` | Keep the last N turns for this session. |
| `/context-diet ttl <1-1440>` | Cache lifetime in minutes, for this session. |
| `/context-diet mode <cold\|always>` | `always` ignores the cold gate (only for providers without prompt caching). |
| `/context-diet args <on\|off>` | Reports the platform limit below; arguments are always kept on DSH. |

Command changes are **session-scoped**. DSH keeps plugin configuration in the
profile Config, so a command never rewrites it and never reloads the plugin.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `mode` | `"cold"` | `cold`: elide only when the prompt cache expired (free). `always`: ignore coldness. |
| `keepTurns` | `20` | Keep the results of the last N assistant turns. |
| `minChars` | `1500` | Results smaller than this are not worth a stub. |
| `cacheTtlMinutes` | `5` | Prompt-cache lifetime; a longer idle period means cold. |
| `keepErrors` | `true` | Keep results flagged as errors. |
| `neverElide` | `[]` | Tool names that are never elided. |
| `showStatus` | `true` | Render the composer footer. |
| `stubTailLines` | `3` | Tail lines kept in a stub. |
| `stubErrorLines` | `3` | Error lines kept in a stub. |
| `autoProtect` | `true` | Protect a tool whose results keep being re-fetched. |
| `recoveryThreshold` | `0.25` | Re-fetch share that triggers protection (0.05-1). |

`elideArgs` is not a config key: the adapter pins it to `false` and the
`/context-diet/stats` payload reports that pinned value, so `status` and the footer
agree about what the plugin actually does.

A config override replaces the whole `config` block, so restate every key you keep:

```yaml
- id: dsh-context-diet
  config:
    enabled: true
    mode: cold
    keepTurns: 20
    minChars: 1500
    cacheTtlMinutes: 5
    keepErrors: true
    neverElide: []
    showStatus: true
    stubTailLines: 3
    stubErrorLines: 3
    autoProtect: true
    recoveryThreshold: 0.25
```

## Platform limits (read this)

Two upstream behaviours cannot exist on DSH, and this bundle does not pretend they
do:

1. **No write/edit argument elision.** pi rewrites a stale `write`/`edit` tool call
   because it owns the per-request messages. DSH cannot: a tool call lives in a
   `tool/call` event and in the assistant message's `tool-call` blocks, and an
   `assistant/message` surface replacement is rejected with two mutually exclusive
   rules — *"sourceEventSeqs must include every shadowed surface node"* and
   *"assistant/message embeds its source stream and cannot carry sourceEventSeqs"*.
   The config has no `elideArgs` field; `status` reports `write/edit args kept`.
2. **No cache-warming arbitration.** pi can ask its own cache warmer to stop; DSH
   exposes no equivalent seam, so there is nothing to arbitrate.

The durable-surface model also changes the mechanism, not the outcome: pi re-decides
per request and re-applies to a copy, while DSH lands a replacement once. Both leave
a node elided exactly once and keep the shorter prefix stable between cold starts.

## Install

`plugin_manager action=install_bundle target=/abs/path/dsh-context-diet`, or inside
a profile:

```bash
dsh plugin --profile <profile> add /abs/path/dsh-context-diet
```

Read the returned `application` **and** `warnings`. Only `applied` means live;
`restart-required` needs a full exit and relaunch. Confirm the row:

```bash
dsh --profile <profile> --dump-config | grep -A3 dsh-context-diet
```

## Verify

1. **Footer.** Select a session, then run
   `document.querySelector('[data-composer-dock] [data-composer-stat="context-diet"]')?.textContent`
   in the browser console; it equals the `footer` field of `/context-diet/stats`.
2. **Slot.** `cordis_inspect_query` with `platform: "client"`, `provider: "Slots"`,
   `method: "listSubTree"`, `input: { root: "conversation.composer.dock" }` lists
   `context-diet` beside the shipped `activity` and `usage` entries.
3. **Endpoint.** `GET /context-diet/stats` returns config, stats, recovery,
   the calibrated chars/token and the rendered footer.
4. **Log shape.** A pass appends one `compaction/prune` record and one
   `tool/result` replacement per node, and the original event is still present.
5. **Tests.**

   ```bash
   npm test    # node --test test/*.test.js test/unit/*.test.js
   ```

   The suite resolves `@deepseek-ai/*` from an installed Harness
   (`test/helpers/dsh.js`); set `DSH_NODE_MODULES` to point elsewhere.

## Rollback

1. **Persistent:** `plugin_manager action=remove_bundle target=dsh-context-diet`,
   then restart the harness. The footer disappears with the bundle.
2. **Durable replacements are not reverted.** The replacement nodes are already in
   that session's log, and the model keeps seeing the shorter surface for that
   session. Resume or fork from a point before the replacements, or start a new
   session. Any claim that disabling restores the old surface is false.
3. Nothing outside the session log is written: no config files, no workspace files.

## Durable surface: what changes

| Surface | Effect |
|---|---|
| Model-visible session surface | Old plain-text results become stubs, durably, for this session. |
| Session event log | Append-only; the original events are still there. |
| Human transcript | Unchanged: replacements are model-only. |
| Token accounting | Corrected by the `compaction/prune` shadow price; no private estimator. |
| Other sessions | Untouched. |

## Known limits

- No cache-cold arbitration: the gate is idle time, an approximation of the cache
  lifetime, never a provider fact.
- Only plain-text tool results are candidates; rich content is never partially elided.
- A node that already carries a replacement or a shadow price is skipped, so this
  plugin and the native pruner never fight over the same node.
- Behaviour on DSH versions other than the anchor is unverified.

## Design notes

| Document | Contents |
|---|---|
| [docs/upstream-fidelity-spec.md](docs/upstream-fidelity-spec.md) | Upstream behaviour specification with source line numbers. |
| [docs/parity-report.md](docs/parity-report.md) | Which upstream assertions the parity suite reproduces. |
| [docs/impl-contract.md](docs/impl-contract.md) | Adapter/core interface contract. |
| [docs/slot-report.md](docs/slot-report.md) | Why `conversation.composer.dock` is the right footer slot. |
| [docs/pi-context-diet-to-dsh-migration-plan.md](docs/pi-context-diet-to-dsh-migration-plan.md) | Why a direct port is impossible and how the migration was phased. |

## Security

- Host code runs in-process, outside the workspace sandbox: install only from a
  source you trust.
- The Client reads the same-origin `/context-diet/stats` endpoint. It writes
  nothing, and the endpoint refuses unauthenticated requests.
- No lifecycle scripts, no install-time downloads, no direct `$DSH_HOME` access,
  no filesystem scan and no subprocess.

## License and attribution

MIT. See [LICENSE](LICENSE). This project is a DSH port of
[pi-context-diet](https://github.com/sorinirimies/pi-context-diet) (MIT,
Copyright (c) 2026 sorinirimies); the upstream copyright notice is retained. The
icon is original artwork created for this bundle.

## 中文摘要

- 作用：在每一步开始前，把会话里「陈旧、过大、纯文本、非错误」的工具结果替换成确定性
  stub；只有在提示缓存已冷（最后一条 assistant 消息早于 `cacheTtlMinutes`）时才动手，
  所以不额外付出缓存重建成本。目的不只是省 token，而是减少噪音、提升模型专注度。
- 保护：错误结果默认保留、最近 `keepTurns` 轮保留、小于 `minChars` 保留、富内容不动、
  stub 保留末尾行与错误行、重取超过阈值自动保护该工具、任何异常一律 fail-open。
- 可视化：输入框下方常驻 footer 显示 `🥗 −1.9k /req · 286.0k saved ↺3`，
  未裁剪时显示下一次冷启动可省多少。
- 平台限制：DSH 无法改写 write/edit 工具调用参数（平台两条互斥校验），本插件不假装支持；
  DSH 也没有缓存保温仲裁接口。
- 默认开启；配置走 profile Config，`/context-diet` 命令只影响当前会话。
- 持久语义：替换会改变该会话模型可见的历史；禁用或卸载**不会**回滚已落盘的替换。
- 许可：MIT，派生自 pi-context-diet，声明保留在 `LICENSE`。
