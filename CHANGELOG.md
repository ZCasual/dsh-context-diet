# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
