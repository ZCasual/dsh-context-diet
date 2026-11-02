# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-03

A correctness release: the policy core is now a line-by-line port of
pi-context-diet, verified by a parity suite, and the savings are visible in the UI.

### Added

- **Composer footer.** A resident `🥗 −1.9k /req · 286.0k saved ↺3` readout in
  `conversation.composer.dock`, with the "at the next pause" budget before the first
  pass, the `↺n` re-fetch count and the `⚠ mode always` warning. Fed by a read-only
  `GET /context-diet/stats` endpoint.
- **Parity suite** (`test/parity.test.js`, 105 cases) ported from the upstream test
  suite, each case annotated with the upstream source line it reproduces.
- **Cold gate**, `keepErrors`, `elideArgs`, `autoProtect`, `recoveryThreshold`,
  `showStatus` and a real chars-per-token **calibrator** driven by provider usage.
- `/context-diet show`: what is elided now and what the next cold start would take.

### Changed

- Policy names now match upstream: `mode` (`cold`/`always`) and `cacheTtlMinutes`
  replace the invented `agePolicy`; `keepTurns` is clamped to 1-500.
- One core. The duplicate DSH policy contract (`planElisions`, `resolvePolicy`,
  `dshStubText`) is gone; the adapter only translates messages.
- One stub format, byte-identical to upstream apart from the `context-diet` brand.
- The recovery meter now derives re-fetches from the log, so it survives a restart.

### Removed

- **Compaction.** `compact` configuration, `/context-diet compact`, the status-line
  compaction segment and the cache-warming arbitration are gone: DSH has no seam for
  them, and this plugin is not a compaction tool.
- **Write/edit argument elision.** The platform rejects `assistant/message` surface
  replacement with two mutually exclusive rules, so argument elision can never land.
  The config field is gone and `/context-diet args on` reports the limit.

### Fixed

- The cold gate no longer treats an unknown timestamp as "infinitely idle" and
  elides on the very first step; it waits for a real timestamp, like upstream.
- A re-fetch whose arguments were an object could no longer match its elided copy.

## [0.1.0] - 2026-11-03

First public release.

### Added

- Host-half Cordis plugin that replaces old, oversized, plain-text `tool/result`
  nodes with deterministic stubs on the model-visible session surface.
- Durable, replay-safe replacement using `surfaceOp: { op: 'replace', startSeq, endSeq }`
  plus `sourceEventSeqs`, preceded by the native `compaction/prune` shadow price.
- Strategy core (`core.js`) with no imports: eligibility, planning, stub rendering,
  the recovery meter, command parsing and status rendering.
- `/context-diet` command: `status`, `show`, `on`, `off`, `now`, `keep`, `ttl`, `mode`,
  `args`, `compact`.
- Durable counters in one `sessionProjections` unit, so `/context-diet status`
  survives a restart.
- Re-fetch feedback: a tool whose identical call is re-issued after elision is
  protected from further elision in that session.
- Bundle patch that inserts the row enabled, and a Config schema whose defaults
  keep the policy active without further configuration.
- Locale metadata for English and Chinese, an icon, and MIT licensing with the
  upstream `pi-context-diet` notice retained.
- Test suite: strategy unit tests, Host plugin tests, real-`Session` contract tests
  (replay, idempotency, concurrency, fail-open) and package metadata assertions.

### Notes

- No Client half: this release ships no browser UI. Configuration is ordinary
  Cordis Config plus the session command.
- Disabling or uninstalling does **not** revert replacements that already landed in
  a session; the originals stay in the log but the model keeps the shorter surface.
