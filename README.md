# dsh-context-diet

A DeepSeek Harness (DSH) bundle that **elides stale, oversized tool results from the
model-visible session surface** to cut the tokens a long session re-sends.

It is a port of the policy in [pi-context-diet](https://github.com/sorinirimies/pi-context-diet)
(MIT, Copyright (c) 2026 sorinirimies) to DSH's durable session surface model — **not**
a drop-in equivalent. Read [What it does not do](#what-it-does-not-do) and
[Durable surface: what changes, what does not](#durable-surface-what-changes-what-does-not)
before installing.

- Status: **enabled by default.** Host-only bundle; configuration uses ordinary Cordis Config and session commands.
- Version anchor: developed and tested against `@deepseek-ai/dsh` **0.2.1-rc.5** (`dsh --version`).

## What it does

At the pre-step phase of an agent step, the plugin looks at the current session surface
and picks old, large, plain-text `tool/result` nodes that are outside `keepTurns`, above
`minChars`, not errors, and not covered by `neverElide`. Each selected result is replaced
by a deterministic stub that keeps the tool/call identity, the original size, a few tail
lines and any error lines, plus a hint that the original is still in the session log.

Elision runs only on an elision pass. With `agePolicy: approximate` (the default) a pass
waits until the session has been idle for `coldTtlMinutes` (default 5) — a stand-in for
pi's "the prompt cache is already cold" check, which DSH cannot observe. `/context-diet now`
forces exactly one pass. A pass replaces at most `maxPerPass` results.

The replacement is a **durable** 1:1 `tool/result` surface replacement
(`surfaceOp: { op: 'replace', startSeq, endSeq }`, `sourceEventSeqs: [seq]`), preceded by a
`compaction/prune` shadow-price record — the same convention the native
`dsh-compaction-tool-result-pruner` uses. Because the decision is durable, the shorter
prefix is computed once per node and then stays byte-stable, so the cost of one prefix
rewrite is paid at most once.

## What it does not do

- **No per-request-only elision.** DSH has no equivalent of pi's `context` seam: every
  change this plugin makes is a durable surface replacement visible to later steps and
  to replayed sessions. If that semantic is unacceptable, do not enable this bundle.
- **No new tokenizer.** Token accounting reuses `ctx.tokenMeter` / `estimateMessage`.
- **No new session event type.** No `appendPluginRecord()`. Durable counters live in one
  `sessionProjections` unit; everything else that must survive is the landed replacement
  itself.
- **No assistant, thinking or tool-call argument rewriting.** DSH surface types cannot
  replace tool-call arguments independently.
- **Not a replacement for the native path.** `tokenMeter`, `compaction` / `/compact` and
  `toolResultPruner` come first. This bundle only targets results that are long but below
  the pruner's compaction-pressure threshold.
- **No cache-cold arbitration.** DSH exposes no provider cache state; age is derived from
  event time and is an approximation, never a promise of "zero cache cost".

## Default on

The bundle inserts its row enabled and the plugin Config defaults to `enabled: true`. The
policy runs automatically on eligible agent steps after the approximate idle window.

The `/context-diet on|off` command remains available for a per-session temporary override.
Session overrides disappear on restart. To change the profile default, edit the row through
the normal Cordis patch/config editor; a config override **replaces the whole `config` block**,
so restate every key you need. Do not add `disabled: true` to the bundle row: this plugin is
intended to load and run by default.

Installing this bundle is a trust decision because Host code runs in-process and outside the
workspace sandbox. The default policy still protects recent, small, error and rich-content
results; review the policy settings before using it on unattended sessions.

## Install

`plugin_manager` actions need approval (or `danger-full-access`); `install_bundle` takes
an **absolute package directory**:

```text
plugin_manager action=install_bundle target=/abs/path/dsh-context-diet
```

The CLI equivalent inside a profile is
`dsh plugin --profile <profile> add /abs/path/dsh-context-diet`.
Do not hand-write the profile's `package.json` or `cordis.patch.yml`.

The profile row id is `dsh-context-diet` (the package name). The Cordis plugin's own
`name` export is `context-diet`; that is the name that appears in Loader logs, and it is
what `/context-diet` is called after.

Then:

1. Read the returned `application` **and** `warnings`. Only `applied` means live;
   `restart-required` is not success and needs a full exit/relaunch, not a page refresh.
2. A new bundle member normally needs a restart; expect a second verification pass.
3. Confirm the layer exists:

   ```bash
   dsh --profile <profile> --dump-config | grep -A3 dsh-context-diet
   ```

   Expected: an `# == dsh-context-diet` layer containing the row with `enabled: true`.

## Configure

Use the normal profile patch/config editor to tune the Host plugin. The settings are ordinary
Cordis Config fields; there is no Client UI or custom HTTP configuration endpoint.

A config override **replaces the whole `config` block**, so restate every key you want to keep:

```yaml
- id: dsh-context-diet
  config:
    enabled: true
    agePolicy: approximate
    coldTtlMinutes: 5
    keepTurns: 20
    minChars: 1500
    stubTailLines: 3
    stubErrorLines: 3
    maxPerPass: 8
    neverElide: []
```

The `/context-diet on|off` command only overrides the live session; it does not persist a
profile change. Profile configuration changes follow normal Loader lifecycle rules.

### Configuration (S0)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Change the profile Config or use `/context-diet off` for this session. |
| `agePolicy` | `"approximate"` | `off` never ages results out; `approximate` uses session idle time; `always` elides regardless of idleness. |
| `coldTtlMinutes` | `5` | Idle minutes `approximate` treats as "cache presumptively cold". Not a provider fact. |
| `keepTurns` | `20` | Only results older than this many assistant turns are candidates. |
| `minChars` | `1500` | Minimum original size (characters) before a result is worth stubbing. |
| `stubTailLines` | `3` | Tail lines kept in the stub. |
| `stubErrorLines` | `3` | Error lines kept in the stub. |
| `maxPerPass` | `8` | Hard cap on replacements in one pass, so growth stays gradual. |
| `neverElide` | `[]` | Tool names that are never elided. |

The installed Config schema is authoritative: query it with
`cordis_inspect_query` `provider: "Config"`, `method: "listConfigs"`,
`input: { name: "dsh-context-diet" }`. The table above is meant to stay in sync with the
schema; a repository test is expected to assert it (see the release checklist).

## Commands

The bundle registers one human command (no model turn is started):

```text
/context-diet [status|on|off|now|show|keep <turns>|ttl <minutes>|mode <off|approximate|always>|args|compact <on|off|now>]
```

- `status` / `show` report the current policy, what the last pass did, the elapsed-idle
  trigger and the durable counters. `show` is the detailed form.
- `on` / `off` override `enabled` for this session without touching the config file.
- `now` runs one pass on the next pre-step even if the session is not idle.
- `keep`, `ttl`, `mode` override `keepTurns`, `coldTtlMinutes`, `agePolicy` for this session.
- `args` always reports an error by design: DSH surface types cannot rewrite tool-call
  arguments independently, so write/edit argument elision is not offered.
- `compact` needs the `compaction` service to be visible from the Host plane. When it is
  not (the compaction instance may live in a preset realm), the command says so instead of
  failing silently.

Session-scoped overrides live in memory and disappear on restart; they never rewrite the
bundle's `config`.

## Verify

1. **Behaviour.** In a new session, long sessions stop re-sending the full text of old
   plain-text tool results; each elided result appears as its stub. `/context-diet status`
   shows the policy, the trigger and what the last pass did; `/context-diet show` lists the
   details.
2. **Log integrity.** The original results are still in the session event log as
   append-origin events; the replacements are model-only nodes. Nothing was deleted.
3. **Replacement shape.** Each replacement keeps the tool-call id, error flags and
   metadata, cites the shadowed sequence (`sourceEventSeqs`), and is preceded by a
   `compaction/prune` shadow-price record.
4. **Live config.** `Config.listConfigs` for `dsh-context-diet` shows the resolved schema
   and the row's config after your override.
5. **Repository tests** (run from the repository root, not from the installed profile):

   ```bash
   npm test            # node --test test/*.test.js test/unit/*.test.js
   ```

   The suite resolves `@deepseek-ai/*` from an installed Harness (`test/helpers/dsh.js`);
   set `DSH_NODE_MODULES` to point at another Harness tree.

This bundle has no Client UI. Remaining unverified items are behavior on DSH versions other than the anchor above and use inside a preset realm (the bundle is intended for Host placement).

## Rollback

1. **Immediate:** set the profile Config field `enabled: false`; `/context-diet off` pauses only the current session and does not persist.
2. **Persistent:** `plugin_manager action=remove_bundle target=dsh-context-diet`, then
   restart the harness.
3. **Durable replacements are not reverted** by either step. The replacement nodes are
   already in that session's log and the model keeps seeing the shorter surface for that
   session. To recover the original context, resume/fork from a point before the
   replacements or start a new session. Any claim that disabling restores the old surface
   is false.
4. Nothing outside the session log is written: no config files are created and no
   workspace files are touched.

## Durable surface: what changes, what does not

| Surface | Effect |
|---|---|
| Model-visible session surface | Old results are replaced by stubs, durably, for this session. |
| Session event log (source of truth) | Append-only and unchanged; the replacement is an additional event citing the original. |
| Human transcript / UI history | Unchanged: replacement copies are model-only, so the transcript still shows what was originally displayed. |
| Token accounting | Reflects the shortened surface through `ctx.tokenMeter`; no private estimator. |
| Other sessions | Untouched. The plugin has no cross-session state in S0. |

## Known limits

- No cache-cold detection: a replacement can land while the prompt cache is still warm and
  cost one prefix rewrite. It is then byte-stable, so it is paid at most once.
- Durable semantics are a product change, not just a cost optimisation; some users will
  prefer compaction alone.
- Only plain-text tool results are candidates. Rich content (images, attachments, unknown
  block types) is untouched and never partially elided.
- Error results are never elided.
- Both this plugin and the native pruner/compaction may want the same node. A node that
  already carries a replacement or a `compaction/prune` shadow price is skipped.
- This bundle is Host-only and has no Client UI. Write/edit argument elision is not offered by design, and `/context-diet args` says so. `/context-diet compact` works only when the host plane can see the `compaction` service.
- `engines.dsh` is checked by DSH 0.2.1-rc.5 during installation and profile startup;
  incompatible hosts reject the bundle or require an exact, user-approved version exemption.
  Treat the tested version anchor as a compatibility requirement.

## Compatibility

| Component | Range |
|---|---|
| Node.js | `>=22.19.0` |
| DSH | `>=0.2.1-rc.5 <0.3.0-0` (tested on 0.2.1-rc.5) |
| Placement | Host bundle row; not evaluated inside a preset realm |
| Client | none |

## Security

- Host code runs in-process, outside the workspace sandbox: install only from a source you
  trust, and read the returned `warnings` before enabling.
- No Client UI, lifecycle scripts, install-time downloads, direct `$DSH_HOME` access, filesystem
  scan or subprocess. Profile settings remain under the Harness Loader/config editor.

## Design notes

Repository documents that explain the decisions rather than the usage:

| Document | Contents |
|---|---|
| [docs/pi-context-diet-to-dsh-migration-plan.md](docs/pi-context-diet-to-dsh-migration-plan.md) | Why a direct port is impossible, the durable-surface contract, the phased plan this implementation followed. |
| [docs/plugin-development-research.md](docs/plugin-development-research.md) | The DSH plugin, bundle, Settings and slot facts the implementation was written against. |

## License and attribution

MIT. See [LICENSE](LICENSE). This project is a DSH port of
[pi-context-diet](https://github.com/sorinirimies/pi-context-diet) (MIT,
Copyright (c) 2026 sorinirimies); the upstream copyright notice is retained. The icon is
original artwork created for this bundle.

## Maintainer release checklist

- [ ] `npm test` green (90+ tests: core unit, Host plugin, real-Session contract, package metadata).
- [ ] `node --check index.js core.js`; `locale/*.json` parse; `cordis.patch.yml` valid
      YAML with a unique `id` equal to the package name.
- [ ] `npm pack --dry-run --json`: packed list is exactly `index.js`, `core.js`,
      `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg`, `README.md`,
      `LICENSE`, `package.json` — no tests, no coverage output, no repository docs.
- [ ] `./icon` export resolves to a valid SVG/PNG/JPEG/WebP under 256 KiB.
- [ ] `README` config table matches the Config schema (asserted by test).
- [ ] `engines.dsh` and peer ranges bumped to the version actually tested; target
      `0.x` semver; CHANGELOG entry written.
- [ ] `npm publish --dry-run` clean, then publish from a tag with `--provenance`.
- [x] `repository` / `homepage` / `bugs` point at
      <https://github.com/ZCasual/dsh-context-diet> (asserted by `test/package.test.js`).
- [ ] Tag the release and push: `git tag vX.Y.Z && git push origin main --tags`.

## 中文摘要

- 作用：在每一步开始时，把会话里「陈旧、过大、纯文本、非错误」的工具结果替换成确定性
  stub，减少模型每次重发的 token。
- 默认开启：bundle 行和 Config 都使用 `enabled: true`；没有配置界面。通过 Cordis/profile Config 修改默认策略，或用 `/context-diet off` 只暂停当前会话。
- 安装走 `plugin_manager install_bundle`（绝对路径），读 `application` + `warnings`；
  新 bundle 成员通常需要完整重启，刷新页面不够。
- 持久 surface 限制：替换是持久的，会改变该会话模型可见的历史；原始事件仍在日志里、UI 历史
  不变；禁用或卸载**不会**回滚已落盘的替换，只能从替换前的会话点恢复。
- 版本锚点：DSH `0.2.1-rc.5`，Node `>=22.19.0`；DSH 0.2.1-rc.5 会在安装和 profile 启动时校验 `engines.dsh`，不兼容时拒绝或要求精确版本豁免。
- 许可：MIT，派生自 pi-context-diet（MIT，Copyright (c) 2026 sorinirimies），声明保留在
  `LICENSE`；图标为本项目原创。
