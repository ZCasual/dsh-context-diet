// Parity suite: upstream assertions ported 1:1 from pi-context-diet's own tests.
//
// Run: node --test test/parity.test.js
//
// Purpose: prove that core.js is *behaviourally* equivalent to upstream, not merely
// that it runs. Every test below carries a `// parity: <file>:<line>` comment naming
// the upstream assertion it was ported from:
//   TESTS/core.test.ts    216 assertions, 748 lines
//   TESTS/commands.test.ts parseCommand / completions tables
// DSH deltas that the impl-contract (docs/impl-contract.md) freezes are marked
// `// dsh:` next to the parity trace: 13-field DietConfig, stub prefix
// "context-diet", no compact/warming, footerLine as a pure function.
//
// This file imports ONLY the frozen core.js exports (docs/impl-contract.md §1).
// It is the acceptance sheet for core-port: a red test means core.js is not yet
// faithful. Do NOT weaken an expectation to make it pass; if an expectation is
// wrong, it must be corrected against the upstream source first.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as core from "../core.js";

const {
  DEFAULT_CONFIG,
  DEFAULT_CHARS_PER_TOKEN,
  STUB_MARKER,
  ARG_TOOLS,
  sanitizeConfig,
  measure,
  indexCalls,
  describeCall,
  formatSize,
  formatTokens,
  previewOf,
  stubText,
  isStubbed,
  hasThinking,
  assistantTurnsAfter,
  lastAssistantTimestamp,
  isCold,
  policyOf,
  eligible,
  argChars,
  elideArguments,
  eligibleArgs,
  decide,
  stableStringify,
  callSignature,
  applyElision,
  Calibrator,
  RecoveryMeter,
  parseCommand,
  USAGE,
  completions,
  statusLine,
  footerLine,
} = core;

// ---------------------------------------------------------------------------
// Helpers — ported from TESTS/helpers.ts so the fixtures (ids, chars, ages) are
// the same ones the upstream assertions were written against.
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const text = (t) => [{ type: "text", text: t }];
const big = (chars, seed = "x") => seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);

let counter = 0;
const resetIds = () => {
  counter = 0;
};
beforeEach(resetIds);

const user = (t = "do the thing", ts = 0) => ({ role: "user", content: text(t), timestamp: ts });

/** One agent turn: an assistant message that calls a tool, then the tool's result. */
function turn(opts = {}) {
  const id = `call_${++counter}`;
  const tool = opts.tool ?? "bash";
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: tool, arguments: opts.args ?? { command: `echo step ${counter}` } }],
      timestamp: opts.ts ?? 0,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: tool,
      content: opts.content ?? text(big(opts.chars ?? 4000, `line ${counter}\n`)),
      isError: opts.isError ?? false,
      timestamp: opts.ts ?? 0,
    },
  ];
}

/** A conversation of `n` turns, one every `stepMs`, ending at `endTs`. */
function convo(n, opts = {}) {
  const step = opts.stepMs ?? 20_000;
  const endTs = opts.endTs ?? 0;
  const out = [user("start", endTs - n * step - 1000)];
  for (let i = 0; i < n; i++) out.push(...turn({ chars: opts.chars ?? 4000, ts: endTs - (n - 1 - i) * step }));
  return out;
}

const resultsOf = (messages) => messages.filter((m) => m.role === "toolResult");
const isStub = (m) => JSON.stringify(m?.content ?? "").includes("context-diet:");

/** Freeze a message tree so any mutation throws (upstream uses this to prove no in-place edits). */
function deepFreeze(o) {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const policy = (over = {}) => policyOf({ ...DEFAULT_CONFIG, keepTurns: 5, minChars: 1000, ...over });

const writeArgs = (n) => ({ path: "src/a.ts", content: big(n) });
const editArgs = (n) => ({
  path: "src/a.ts",
  edits: [
    { oldText: big(n / 2), newText: big(n / 2, "y") },
    { oldText: "a", newText: "b" },
  ],
});

const callIds = (m) =>
  m
    .filter((x) => x.role === "assistant")
    .flatMap((x) => (Array.isArray(x.content) ? x.content.filter((p) => p && p.type === "toolCall").map((p) => p.id) : []));

/** The write/edit fixture session used by the upstream eligibleArgs / applyElision tests. */
function argSession() {
  const m = [user()];
  m.push(...turn({ tool: "write", args: writeArgs(5000), chars: 50 }));
  m.push(...turn({ tool: "edit", args: editArgs(3000), chars: 50 }));
  m.push(...turn({ tool: "write", args: writeArgs(300), chars: 50 })); // too small
  m.push(...turn({ tool: "write", args: writeArgs(5000), chars: 50, isError: true })); // failed: may be retried
  m.push(...convo(8, { endTs: NOW }).slice(1));
  return m;
}

const zeroStats = () => ({ lastCount: 0, lastArgCount: 0, lastChars: 0, cumulativeChars: 0, requests: 0, coldStarts: 0 });
const bigStats = () => ({
  lastCount: 37,
  lastArgCount: 0,
  lastChars: 850_000,
  cumulativeChars: 20_400_000,
  requests: 24,
  coldStarts: 3,
});

const previewLog = [
  "Compiling a",
  "Compiling b",
  "error[E0432]: unresolved import `x`",
  "  --> src/lib.rs:1:5",
  "warning: unused",
  "BUILD FAILED in 4s",
  "exit code 1",
].join("\n");

// ===========================================================================
// Frozen constants (contract §1, upstream TS:83-102 / TS:316-325 / TS:381)
// ===========================================================================

describe("frozen constants", () => {
  // parity: TESTS/core.test.ts:82 (DEFAULT_CHARS_PER_TOKEN === 3)
  it("DEFAULT_CHARS_PER_TOKEN is 3", () => {
    assert.equal(DEFAULT_CHARS_PER_TOKEN, 3);
  });

  // parity: TESTS/core.test.ts:386 (ARG_TOOLS is write + edit)
  it("ARG_TOOLS is exactly write and edit", () => {
    assert.deepEqual([...ARG_TOOLS].sort(), ["edit", "write"]);
  });

  // parity: TESTS/core.test.ts:292-298 (single stub template) + impl-contract §1 STUB_MARKER
  it("STUB_MARKER is the one frozen prefix and isStubbed matches only this plugin's stubs", () => {
    assert.equal(STUB_MARKER, "[context-diet:");
    assert.equal(isStubbed(stubText("bash", "cargo test", 12_345, 240)), true);
    assert.equal(isStubbed([{ type: "text", text: "ordinary tool output" }]), false);
    assert.equal(isStubbed(null), false);
  });
});

// ===========================================================================
// b) DEFAULT_CONFIG — all 13 fields, item by item (contract §2)
// ===========================================================================

describe("DEFAULT_CONFIG", () => {
  // parity: TESTS/core.test.ts:83-102 (upstream defaults; DSH keeps the 13 fields of contract §2)
  it("has exactly the 13 DSH fields with the upstream default values", () => {
    const expected = {
      enabled: true,
      mode: "cold",
      keepTurns: 20,
      minChars: 1500,
      cacheTtlMinutes: 5,
      keepErrors: true,
      neverElide: [],
      showStatus: true,
      stubTailLines: 3,
      stubErrorLines: 3,
      elideArgs: true,
      autoProtect: true,
      recoveryThreshold: 0.25,
    };
    assert.deepEqual(DEFAULT_CONFIG, expected);
    assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), Object.keys(expected).sort());
    assert.equal(Object.keys(DEFAULT_CONFIG).length, 13);
  });

  // parity: TESTS/core.test.ts:585-592 (upstream carries these fields and asserts their defaults;
  // DSH deliberately drops them, so their absence is the contract — impl-contract §2)
  it("carries none of the removed compact/warming/maxPerPass fields", () => {
    for (const gone of ["compact", "compactAboveTokens", "warmArbitration", "expectedTurns", "stopWarmingShare", "maxPerPass", "agePolicy"]) {
      assert.equal(gone in DEFAULT_CONFIG, false, `DEFAULT_CONFIG must not carry ${gone}`);
    }
  });
});

// ===========================================================================
// c) measure — chars / lines / textOnly (upstream TS:217-229, tests TS:14-33)
// ===========================================================================

describe("measure", () => {
  // parity: TESTS/core.test.ts:15-17
  it("sums text parts and counts lines", () => {
    assert.deepEqual(measure([{ type: "text", text: "a\nb\n" }, { type: "text", text: "c" }]), { chars: 5, lines: 3, textOnly: true });
  });

  // parity: TESTS/core.test.ts:18-23
  it("handles plain strings and empty content", () => {
    assert.deepEqual(measure("a\nb"), { chars: 3, lines: 2, textOnly: true });
    assert.deepEqual(measure(""), { chars: 0, lines: 0, textOnly: true });
    assert.deepEqual(measure(null), { chars: 0, lines: 0, textOnly: true });
    assert.deepEqual(measure(undefined), { chars: 0, lines: 0, textOnly: true });
  });

  // parity: TESTS/core.test.ts:24-28
  it("flags anything that is not text (images and file blocks are never elided)", () => {
    assert.equal(measure([{ type: "text", text: "hi" }, { type: "image", data: "…", mimeType: "image/png" }]).textOnly, false);
    assert.equal(measure([{ type: "text" }]).textOnly, false); // a text part without text is junk
    assert.equal(measure([null]).textOnly, false);
    // dsh: a `file` content block (DSH shape) is also not plain text -> never elided
    assert.equal(measure([{ type: "text", text: big(4000) }, { type: "file", path: "src/a.ts", mimeType: "text/plain" }]).textOnly, false);
  });

  // parity: TESTS/core.test.ts:29-32
  it("counts a trailing newline as no extra line", () => {
    assert.equal(measure("a\n").lines, 1);
    assert.equal(measure("a").lines, 1);
  });

  // parity: TESTS/core.test.ts:14-33 (all values ASCII, so they hold under either char unit)
  // parity: TS:217-229 (`String.length`) — the upstream implementation this assertion pins
  // dsh: spec 12.3 B1 left two options: upstream fidelity (UTF-16 `String.length`) vs code
  // points. core.js chose upstream fidelity, so that is what parity pins here. If the Lead
  // switches to code points, this single assertion flips (😀 = 1) and every threshold that
  // consumes `chars` (minChars, formatSize, savedChars, argChars) must be re-derived.
  it("counts chars in UTF-16 code units (upstream String.length semantics)", () => {
    assert.deepEqual(measure("😀"), { chars: 2, lines: 1, textOnly: true });
    assert.deepEqual(measure("a😀b"), { chars: 4, lines: 1, textOnly: true });
    assert.equal(measure([{ type: "text", text: "😀" }, { type: "text", text: "ok" }]).chars, 4);
  });
});

// ===========================================================================
// formatting helpers used by every stub/footer string (upstream TS:262-325)
// ===========================================================================

describe("formatSize / formatTokens", () => {
  // parity: TESTS/core.test.ts:70-74
  it("formatSize", () => {
    assert.equal(formatSize(500), "500 B");
    assert.equal(formatSize(1500), "1.5 KB");
    assert.equal(formatSize(2_500_000), "2.5 MB");
  });

  // parity: TESTS/core.test.ts:76-79
  it("formatTokens", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(212_000), "212.0k");
    assert.equal(formatTokens(5_100_000), "5.10M");
    assert.equal(formatTokens(3_300_000_000), "3.30B");
  });
});

// ===========================================================================
// a) sanitizeConfig — clamp boundaries and fallbacks (upstream TS:104-139,
//    tests TS:263-297)
// ===========================================================================

describe("sanitizeConfig", () => {
  // parity: TESTS/core.test.ts:264-266
  it("defaults everything for junk input", () => {
    for (const junk of [undefined, null, 5, "x", [], true]) assert.deepEqual(sanitizeConfig(junk), DEFAULT_CONFIG);
  });

  // parity: TESTS/core.test.ts:267-270 (13-field DSH subset per impl-contract §2)
  it("keeps valid values", () => {
    const all = {
      enabled: false,
      mode: "always",
      keepTurns: 7,
      minChars: 800,
      cacheTtlMinutes: 60,
      keepErrors: false,
      neverElide: ["read"],
      showStatus: false,
      stubTailLines: 5,
      stubErrorLines: 2,
      elideArgs: false,
      autoProtect: false,
      recoveryThreshold: 0.5,
    };
    assert.deepEqual(sanitizeConfig(all), all);
  });

  // parity: TESTS/core.test.ts:271-282
  it("clamps numbers and rejects the wrong types", () => {
    const c = sanitizeConfig({ keepTurns: 9999, minChars: 1, cacheTtlMinutes: 0, mode: "sometimes", enabled: "yes", keepErrors: 1 });
    assert.equal(c.keepTurns, 500);
    assert.equal(c.minChars, 200);
    assert.equal(c.cacheTtlMinutes, 1);
    assert.equal(c.mode, "cold");
    assert.equal(c.enabled, true);
    assert.equal(c.keepErrors, true);
    assert.equal(sanitizeConfig({ keepTurns: "ten" }).keepTurns, 20);
    assert.equal(sanitizeConfig({ keepTurns: NaN }).keepTurns, 20);
    assert.equal(sanitizeConfig({ keepTurns: 7.6 }).keepTurns, 8);
  });

  // parity: TESTS/core.test.ts:271-282 + spec 2.2 clampInt table (1..500, 200..1e6, 1..1440)
  it("clamps the other end of every numeric range", () => {
    assert.equal(sanitizeConfig({ keepTurns: 0 }).keepTurns, 1);
    assert.equal(sanitizeConfig({ minChars: 1_000_001 }).minChars, 1_000_000);
    assert.equal(sanitizeConfig({ cacheTtlMinutes: 1441 }).cacheTtlMinutes, 1440);
    assert.equal(sanitizeConfig({ stubTailLines: -1 }).stubTailLines, 0);
  });

  // parity: TESTS/core.test.ts:283-291
  it("clamps the preview, args and recovery settings", () => {
    assert.equal(sanitizeConfig({ stubTailLines: 99, stubErrorLines: -4 }).stubTailLines, 10);
    assert.equal(sanitizeConfig({ stubTailLines: 99, stubErrorLines: -4 }).stubErrorLines, 0);
    assert.equal(sanitizeConfig({ stubTailLines: "x" }).stubTailLines, 3);
    assert.equal(sanitizeConfig({ recoveryThreshold: 5 }).recoveryThreshold, 1);
    assert.equal(sanitizeConfig({ recoveryThreshold: 0 }).recoveryThreshold, 0.05);
    assert.equal(sanitizeConfig({ recoveryThreshold: NaN }).recoveryThreshold, 0.25);
    assert.equal(sanitizeConfig({ recoveryThreshold: "high" }).recoveryThreshold, 0.25);
    assert.equal(sanitizeConfig({ elideArgs: "yes" }).elideArgs, true);
    assert.equal(sanitizeConfig({ autoProtect: 1 }).autoProtect, true);
    assert.equal(sanitizeConfig({ showStatus: 1 }).showStatus, true);
  });

  // parity: TESTS/core.test.ts:292-296
  it("cleans neverElide: strings only, trimmed, unique, at most 50", () => {
    assert.deepEqual(sanitizeConfig({ neverElide: [" read ", "read", "", 5, null, "bash"] }).neverElide, ["read", "bash"]);
    assert.equal(sanitizeConfig({ neverElide: Array.from({ length: 80 }, (_, i) => `t${i}`) }).neverElide.length, 50);
    assert.deepEqual(sanitizeConfig({ neverElide: "read" }).neverElide, []);
  });

  // parity: TESTS/fuzz.test.ts:92-103 (sanitize is idempotent)
  it("is idempotent", () => {
    const raw = { keepTurns: 9999, minChars: -3, neverElide: [" a ", "a", ""], recoveryThreshold: 99, mode: "nope" };
    assert.deepEqual(sanitizeConfig(sanitizeConfig(raw)), sanitizeConfig(raw));
  });
});

// ===========================================================================
// d) previewOf — tail/error selection (upstream TS:281-289, tests TS:319-351)
// ===========================================================================

describe("previewOf", () => {
  // parity: TESTS/core.test.ts:322-324
  it("keeps the last lines", () => {
    assert.deepEqual(previewOf(text(previewLog), 2, 0), { tail: ["BUILD FAILED in 4s", "exit code 1"], errors: [] });
  });

  // parity: TESTS/core.test.ts:325-330
  it("keeps error lines that are not already in the tail, in order, and only the last N", () => {
    const p = previewOf(text(previewLog), 1, 5);
    assert.deepEqual(p.tail, ["exit code 1"]);
    assert.deepEqual(p.errors, ["error[E0432]: unresolved import `x`", "BUILD FAILED in 4s"]);
    assert.deepEqual(previewOf(text(previewLog), 0, 1).errors, ["BUILD FAILED in 4s"]);
  });

  // parity: TESTS/core.test.ts:331-337
  it("does nothing when both are 0, and copes with strings, junk and empty output", () => {
    assert.deepEqual(previewOf(text(previewLog), 0, 0), { tail: [], errors: [] });
    assert.deepEqual(previewOf("a\nb\nc", 2, 0).tail, ["b", "c"]);
    assert.deepEqual(previewOf(null, 3, 3), { tail: [], errors: [] });
    assert.deepEqual(previewOf([{ type: "image" }, { type: "text" }], 3, 3), { tail: [], errors: [] });
    assert.deepEqual(previewOf("", 3, 3), { tail: [], errors: [] });
  });

  // parity: TESTS/core.test.ts:338-343
  it("trims blank lines and clips very long lines", () => {
    const p = previewOf("\n\n  ok  \n\n" + "x".repeat(300) + "\n", 2, 0);
    assert.equal(p.tail[0], "ok");
    assert.equal(p.tail[1].length, 160);
    assert.equal(p.tail[1].endsWith("…"), true);
  });

  // parity: TESTS/core.test.ts:344-347
  it("recognises errors, failures and exceptions (TypeError, AssertionError, ...)", () => {
    const out = previewOf("Error: boom\nTypeError: x is not a function\nTraceback (most recent call last)\nAssertionError\nUnhandledException\ntest failed\nall good", 0, 10).errors;
    assert.deepEqual(out, ["Error: boom", "TypeError: x is not a function", "Traceback (most recent call last)", "AssertionError", "UnhandledException", "test failed"]);
  });

  // parity: TESTS/core.test.ts:348-351
  it("does not treat an all-clear summary as an error line", () => {
    assert.deepEqual(previewOf("12 passed, 0 failed\n0 errors\n0 failures found\nBuild ok", 0, 10).errors, []);
    assert.deepEqual(previewOf("3 failed, 9 passed", 0, 10).errors, ["3 failed, 9 passed"]);
  });

  // parity: spec 4.2 algorithm (parts are joined with \n before line selection)
  it("joins multi-part text content with newlines before selecting lines", () => {
    const p = previewOf([{ type: "text", text: "a\nerror: x" }, { type: "text", text: "b\nc" }], 1, 1);
    assert.deepEqual(p.tail, ["c"]);
    assert.deepEqual(p.errors, ["error: x"]);
  });
});

// ===========================================================================
// e) stubText — the one frozen template (upstream TS:292-298, tests TS:84-92,
//    TS:352-360)
// ===========================================================================

describe("stubText", () => {
  // parity: TESTS/core.test.ts:84-92 (dsh: brand prefix pi- → context-diet)
  it("is deterministic and uses the exact upstream template", () => {
    const a = stubText("bash", "cargo test", 12_345, 240);
    assert.equal(a, stubText("bash", "cargo test", 12_345, 240));
    assert.equal(
      a,
      "[context-diet: the output of bash cargo test (12.3 KB, 240 lines) was elided from the context to save tokens. Re-run it if you need it again.]",
    );
    assert.equal(stubText("grep", "", 1, 1).includes("output of grep ("), true);
  });

  // parity: TESTS/core.test.ts:352-358 (dsh: brand prefix pi- → context-diet)
  it("shows the preview: error lines first, then the tail", () => {
    const out = stubText("bash", "cargo test", 5000, 120, previewOf(text(previewLog), 2, 2));
    assert.equal(
      out,
      "[context-diet: the output of bash cargo test (5.0 KB, 120 lines) was elided from the context to save tokens. Re-run it if you need it again." +
        "\nerror lines:\n  error[E0432]: unresolved import `x`" +
        "\nlast lines:\n  BUILD FAILED in 4s\n  exit code 1]",
    );
    assert.equal(out.indexOf("error lines:"), out.lastIndexOf("error lines:")); // exactly one error block
    assert.ok(out.indexOf("error lines:") < out.indexOf("last lines:"));
    assert.equal(out.endsWith("]"), true);
  });

  // parity: TESTS/core.test.ts:359
  it("a bare stub has only the header line (no preview sections)", () => {
    assert.equal(stubText("x", "", 1, 1, { tail: [], errors: [] }), stubText("x", "", 1, 1));
    const bare = stubText("x", "", 1, 1);
    assert.equal(bare.includes("error lines:"), false);
    assert.equal(bare.includes("last lines:"), false);
    assert.equal(bare, "[context-diet: the output of x (1 B, 1 lines) was elided from the context to save tokens. Re-run it if you need it again.]");
  });
});

// ===========================================================================
// assistantTurnsAfter — age is "assistant messages strictly after"
// (upstream TS:306-314, tests TS:95-101)
// ===========================================================================

describe("assistantTurnsAfter", () => {
  // parity: TESTS/core.test.ts:95-101
  it("counts the assistant messages that follow each message", () => {
    const m = [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }, { role: "assistant" }, { role: "toolResult" }];
    assert.deepEqual(assistantTurnsAfter(m), [2, 1, 1, 0, 0]);
    assert.deepEqual(assistantTurnsAfter([]), []);
  });
});

// ===========================================================================
// f) eligible — 7 gates (upstream TS:347-360, tests TS:103-149)
// ===========================================================================

describe("eligible", () => {
  // parity: TESTS/core.test.ts:106-113 (keepTurns is a STRICT boundary: ages[i] > keepTurns)
  it("gate keepTurns: elides results older than keepTurns, exactly at the boundary", () => {
    const m = convo(10, { endTs: NOW });
    const ids = eligible(m, policy(), new Set());
    // result k has (9 - k) assistant messages after it: eligible when > 5, i.e. k = 0..3
    assert.equal(ids.length, 4);
    assert.deepEqual(ids, resultsOf(m).map((r) => r.toolCallId).slice(0, 4));
  });

  // parity: TESTS/core.test.ts:114-116
  it("keeps everything in a short conversation", () => {
    assert.deepEqual(eligible(convo(5, { endTs: NOW }), policy(), new Set()), []);
  });

  // parity: TESTS/core.test.ts:117-123 (minChars boundary: 999 skipped, 1000 eligible)
  it("gate minChars: skips small results, keeps results exactly at the threshold", () => {
    const m = [user(), ...turn({ chars: 999 }), ...turn({ chars: 1000 }), ...convo(8, { endTs: NOW }).slice(1)];
    const ids = eligible(m, policy(), new Set());
    const r = resultsOf(m);
    assert.equal(ids.includes(r[0].toolCallId), false);
    assert.equal(ids.includes(r[1].toolCallId), true);
  });

  // parity: TESTS/core.test.ts:124-129
  it("gate isError && keepErrors: keeps errors unless told otherwise", () => {
    const m = [user(), ...turn({ isError: true }), ...convo(8, { endTs: NOW }).slice(1)];
    const err = resultsOf(m)[0].toolCallId;
    assert.equal(eligible(m, policy(), new Set()).includes(err), false);
    assert.equal(eligible(m, policy({ keepErrors: false }), new Set()).includes(err), true);
  });

  // parity: TESTS/core.test.ts:130-137
  it("gate neverElide / non-textOnly: honours neverElide and never touches images", () => {
    const img = [{ type: "text", text: big(5000) }, { type: "image", data: "…", mimeType: "image/png" }];
    const m = [user(), ...turn({ tool: "read" }), ...turn({ content: img }), ...convo(8, { endTs: NOW }).slice(1)];
    const [reads, withImage] = resultsOf(m);
    const ids = eligible(m, policy({ neverElide: ["read"] }), new Set());
    assert.equal(ids.includes(reads.toolCallId), false);
    assert.equal(ids.includes(withImage.toolCallId), false);
  });

  // parity: TESTS/core.test.ts:138-144
  it("gate already: skips ids already elided, and tolerates a result without a call id", () => {
    const m = convo(10, { endTs: NOW });
    const first = resultsOf(m)[0].toolCallId;
    assert.equal(eligible(m, policy(), new Set([first])).includes(first), false);
    const broken = [...m, { role: "toolResult", content: text(big(5000)) }];
    assert.doesNotThrow(() => eligible(broken, policy(), new Set()));
  });

  // parity: TESTS/core.test.ts:145-149
  it("gate pass: a tool result with no tool name is still judged by size and age", () => {
    const m = convo(10, { endTs: NOW });
    delete m.find((x) => x.role === "toolResult").toolName;
    assert.equal(eligible(m, policy({ neverElide: ["bash"] }), new Set()).length, 1); // only the nameless one escapes
  });
});

// ===========================================================================
// warm/cold detection (upstream TS:362-374, tests TS:152-164)
// ===========================================================================

describe("cold detection", () => {
  // parity: TESTS/core.test.ts:153-157
  it("finds the last assistant timestamp", () => {
    assert.equal(lastAssistantTimestamp(convo(3, { endTs: NOW })), NOW);
    assert.equal(lastAssistantTimestamp([user()]), undefined);
    assert.equal(lastAssistantTimestamp([{ role: "assistant" }]), undefined);
  });

  // parity: TESTS/core.test.ts:158-164
  it("is cold only after the ttl, and never in a fresh session", () => {
    const m = convo(3, { endTs: NOW });
    assert.equal(isCold(m, NOW + 4 * MIN, 5 * MIN), false);
    assert.equal(isCold(m, NOW + 5 * MIN, 5 * MIN), false); // exactly at the ttl is still warm
    assert.equal(isCold(m, NOW + 5 * MIN + 1, 5 * MIN), true);
    assert.equal(isCold([user()], NOW, 5 * MIN), false);
  });
});

// ===========================================================================
// h) decide — gate order (upstream TS:446-462, tests TS:167-190)
// ===========================================================================

describe("decide", () => {
  const cfg = () => ({ ...DEFAULT_CONFIG, keepTurns: 5 });

  // parity: TESTS/core.test.ts:171-173
  it("does nothing while the cache is warm", () => {
    const long = convo(30, { endTs: NOW });
    assert.deepEqual(decide(long, new Set(), cfg(), { now: NOW + MIN, force: false }), { ids: [], argIds: [], cold: false });
  });

  // parity: TESTS/core.test.ts:174-178
  it("elides stale results when the cache is cold", () => {
    const long = convo(30, { endTs: NOW });
    const d = decide(long, new Set(), cfg(), { now: NOW + 10 * MIN, force: false });
    assert.equal(d.cold, true);
    assert.equal(d.ids.length, 24); // 30 results, the newest 6 kept (> keepTurns after them)
  });

  // parity: TESTS/core.test.ts:179-182
  it("can be forced, and `always` mode ignores the cache", () => {
    const long = convo(30, { endTs: NOW });
    assert.equal(decide(long, new Set(), cfg(), { now: NOW + MIN, force: true }).ids.length, 24);
    assert.equal(decide(long, new Set(), { ...cfg(), mode: "always" }, { now: NOW + MIN, force: false }).ids.length, 24);
  });

  // parity: TESTS/core.test.ts:183-185 (enabled gate comes BEFORE the cold gate: cold stays false)
  it("does nothing when disabled, even when forced and cold", () => {
    const long = convo(30, { endTs: NOW });
    assert.deepEqual(decide(long, new Set(), { ...cfg(), enabled: false }, { now: NOW + 10 * MIN, force: true }), { ids: [], argIds: [], cold: false });
  });

  // parity: TESTS/core.test.ts:186-189
  it("does not re-pick what is already elided", () => {
    const long = convo(30, { endTs: NOW });
    const first = decide(long, new Set(), cfg(), { now: NOW + 10 * MIN, force: false }).ids;
    assert.deepEqual(decide(long, new Set(first), cfg(), { now: NOW + 10 * MIN, force: false }).ids, []);
  });

  // parity: TESTS/core.test.ts:158-164 + 171-189 (cold is a fact: strictly greater, needs a timestamp)
  it("cold is strictly greater than the ttl and needs a timestamp; warm `always` reports cold:false", () => {
    const long = convo(30, { endTs: NOW });
    const warmAlways = decide(long, new Set(), { ...cfg(), mode: "always" }, { now: NOW + MIN, force: false });
    assert.equal(warmAlways.cold, false);
    const noTimestamps = [user(), ...turn({ chars: 4000 })].map(({ timestamp, ...rest }) => rest);
    assert.deepEqual(decide(noTimestamps, new Set(), cfg(), { now: NOW + 10 * MIN, force: true }), { ids: [], argIds: [], cold: false });
  });
});

// ===========================================================================
// i) applyElision — purity, sharing, savedChars, infos (upstream TS:494-536,
//    tests TS:192-244 and TS:462-493)
// ===========================================================================

describe("applyElision", () => {
  // parity: TESTS/core.test.ts:193-209
  it("replaces chosen results with stubs and leaves everything else alone", () => {
    const m = deepFreeze(convo(10, { endTs: NOW }));
    const ids = new Set(eligible(m, policyOf({ ...DEFAULT_CONFIG, keepTurns: 5 }), new Set()));
    const r = applyElision(m, ids);
    assert.equal(r.count, 4);
    assert.equal(r.argCount, 0);
    assert.ok(r.savedChars > 4 * 3000);
    const elidedOut = resultsOf(r.messages).filter(isStub);
    assert.equal(elidedOut.length, 4);
    for (const e of elidedOut) {
      assert.equal(e.role, "toolResult");
      assert.equal(e.toolName, "bash");
      assert.equal(e.isError, false);
      assert.equal(typeof e.toolCallId, "string");
    }
    // untouched messages are the very same objects
    r.messages.forEach((out, i) => {
      if (!isStub(out)) assert.equal(out, m[i]);
    });
  });

  // parity: TESTS/core.test.ts:210-214 (same array reference when nothing applies)
  it("returns the same array when nothing applies", () => {
    const m = convo(3, { endTs: NOW });
    assert.equal(applyElision(m, new Set()).messages, m);
    assert.equal(applyElision(m, new Set(["no-such-id"])).messages, m);
  });

  // parity: TESTS/core.test.ts:215-219
  it("is deterministic: the same set gives byte-identical output", () => {
    const m = convo(10, { endTs: NOW });
    const ids = new Set(eligible(m, policyOf({ ...DEFAULT_CONFIG, keepTurns: 5 }), new Set()));
    assert.deepEqual(applyElision(m, ids).messages, applyElision(m, ids).messages);
    assert.equal(JSON.stringify(applyElision(m, ids).messages), JSON.stringify(applyElision(m, ids).messages));
  });

  // parity: TESTS/core.test.ts:220-225
  it("names the call in the stub", () => {
    const m = [user(), ...turn({ tool: "read", args: { path: "src/big.ts" }, chars: 9000 })];
    const id = resultsOf(m)[0].toolCallId;
    const out = applyElision(m, new Set([id])).messages[2];
    assert.equal(JSON.stringify(out.content).includes("read src/big.ts"), true);
  });

  // parity: TESTS/core.test.ts:226-232
  it("falls back to the result's own tool name when the call is gone (after compaction)", () => {
    const [, res] = turn({ tool: "grep", chars: 5000 });
    const out = applyElision([res], new Set([res.toolCallId])).messages[0];
    assert.equal(JSON.stringify(out.content).includes("output of grep ("), true);
    const nameless = { ...res };
    delete nameless.toolName;
    assert.equal(JSON.stringify(applyElision([nameless], new Set([res.toolCallId])).messages[0].content).includes("output of tool ("), true);
  });

  // parity: TESTS/core.test.ts:233-238
  it("never touches a result that is not plain text", () => {
    const img = [{ type: "text", text: big(5000) }, { type: "image", data: "…", mimeType: "image/png" }];
    const m = [user(), ...turn({ content: img })];
    const id = resultsOf(m)[0].toolCallId;
    assert.equal(applyElision(m, new Set([id])).messages, m);
  });

  // parity: TESTS/core.test.ts:239-243
  it("savedChars is max(0, chars - stub.length) for results smaller than their stub", () => {
    const m = [user(), ...turn({ chars: 10 })];
    const id = resultsOf(m)[0].toolCallId;
    const r = applyElision(m, new Set([id]));
    assert.equal(r.count, 1); // it is still replaced: upstream does not refuse a big stub
    assert.equal(r.savedChars, 0);
  });

  // parity: spec 3.7 / TS:510-516 (infos only for calls that are still indexed; sig = callSignature)
  it("infos carries id/tool/chars and sig = callSignature(name, args)", () => {
    const m = convo(10, { endTs: NOW });
    const ids = new Set(eligible(m, policyOf({ ...DEFAULT_CONFIG, keepTurns: 5 }), new Set()));
    const r = applyElision(m, ids);
    assert.equal(r.infos.length, 4);
    r.infos.forEach((info, i) => {
      assert.equal(info.id, resultsOf(m)[i].toolCallId);
      assert.equal(info.tool, "bash");
      assert.equal(info.chars, 4000);
      assert.equal(info.sig, callSignature("bash", { command: `echo step ${i + 1}` }));
    });
  });

  // parity: TESTS/core.test.ts:462-474 (argIds elision counts, savings and determinism)
  it("elides the chosen arguments, counts them, and never mutates the originals", () => {
    const m = deepFreeze(argSession());
    const [w, e] = callIds(m);
    const r = applyElision(m, new Set(), { argIds: new Set([w, e]) });
    assert.equal(r.argCount, 2);
    assert.equal(r.count, 0);
    assert.ok(r.savedChars > 7000);
    const out = r.messages.filter((x) => x.role === "assistant").flatMap((x) => x.content).filter((p) => p.type === "toolCall");
    assert.equal(JSON.stringify(out[0].arguments).includes("context-diet"), true);
    assert.equal(out[0].id, w);
    assert.equal(out[2].arguments, m[5].content[0].arguments); // the small write is untouched (same object)
    assert.equal(JSON.stringify(applyElision(m, new Set(), { argIds: new Set([w, e]) }).messages), JSON.stringify(r.messages));
  });

  // parity: TESTS/core.test.ts:433-443 (a thinking-bearing assistant is never rewritten)
  it("never rewrites an assistant message that has thinking blocks", () => {
    const m = argSession();
    const [w] = callIds(m);
    const first = m.find((x) => x.role === "assistant");
    first.content.unshift({ type: "thinking", thinking: "hmm", thinkingSignature: "sig" });
    const [, e] = callIds(m);
    const r = applyElision(deepFreeze(m), new Set(), { argIds: new Set([w, e]) });
    assert.equal(r.argCount, 1); // only the edit call (no thinking) was elided
    assert.equal(r.messages.filter((x) => x.role === "assistant" && JSON.stringify(x.content).includes("context-diet:")).length, 1);
    assert.equal(r.messages[m.indexOf(first)], first);
  });

  // parity: TESTS/core.test.ts:475-480
  it("returns the same array when no argument actually changes", () => {
    const m = [user(), ...turn({ tool: "write", args: { path: "p" }, chars: 10 })];
    const id = callIds(m)[0];
    assert.equal(applyElision(m, new Set(), { argIds: new Set([id]) }).messages, m);
    assert.equal(applyElision(m, new Set(), { argIds: new Set(["unknown"]) }).messages, m);
  });

  // parity: TESTS/core.test.ts:481-484
  it("handles assistant messages without parts and non-object arguments", () => {
    const m = [
      { role: "assistant", content: "plain" },
      { role: "assistant", content: [{ type: "toolCall", id: "x", name: "write" }] },
    ];
    assert.equal(applyElision(m, new Set(), { argIds: new Set(["x"]) }).messages, m);
  });
});

// ===========================================================================
// g) argChars / elideArguments / eligibleArgs (upstream TS:389-443,
//    tests TS:379-460 and TS:485-493)
// ===========================================================================

describe("argChars", () => {
  // parity: TESTS/core.test.ts:379-387
  it("counts file content only", () => {
    assert.equal(argChars("write", writeArgs(900)), 900);
    assert.equal(argChars("edit", editArgs(1000)), 1000 + 2);
    assert.equal(argChars("edit", { oldText: "abc", newText: "de" }), 5); // the older single-edit shape
    assert.equal(argChars("write", {}), 0);
    assert.equal(argChars("write", undefined), 0);
    assert.equal(argChars("edit", { edits: [null, { oldText: 5 }] }), 0);
  });
});

describe("elideArguments", () => {
  // parity: TESTS/core.test.ts:389-404 (dsh: brand prefix pi- → context-diet, lead-confirmed)
  it("replaces content with the exact placeholder and keeps the structure", () => {
    const w = elideArguments("write", writeArgs(5000));
    assert.equal(w.path, "src/a.ts");
    assert.equal(w.content, "[context-diet: 1 lines (5.0 KB) of src/a.ts elided; the file on disk is authoritative]");
    assert.ok(String(w.content).length < 200);
    const e = elideArguments("edit", editArgs(4000));
    assert.equal(e.edits.length, 2);
    assert.equal(e.edits[0].oldText, "[context-diet: 1 lines (2.0 KB) of src/a.ts elided; the file on disk is authoritative]");
    assert.equal(e.edits[0].newText, "[context-diet: 1 lines (2.0 KB) of src/a.ts elided; the file on disk is authoritative]");
  });

  // parity: TESTS/core.test.ts:399-404
  it("keeps the same shape when there is nothing to elide, and falls back to `the file`", () => {
    // upstream: toMatchObject({path:"f"}) — a bare string oldText/newText IS still elided
    assert.equal(elideArguments("edit", { path: "f", oldText: "abc", newText: "def" }).path, "f");
    assert.deepEqual(elideArguments("write", { path: "p" }), { path: "p" }); // nothing to elide: same shape
    assert.deepEqual(elideArguments("edit", { edits: [null, "x", { oldText: 5 }] }), { edits: [null, "x", { oldText: 5 }] });
    assert.deepEqual(elideArguments("write", { file_path: "z.ts", content: "a\nb" }), {
      file_path: "z.ts",
      content: "[context-diet: 2 lines (3 B) of z.ts elided; the file on disk is authoritative]",
    });
    assert.equal(
      elideArguments("write", { content: "x" }).content,
      "[context-diet: 1 lines (1 B) of the file elided; the file on disk is authoritative]",
    );
  });
});

describe("eligibleArgs", () => {
  // parity: TESTS/core.test.ts:418-421
  it("selects old, big, successful write/edit calls only", () => {
    const m = argSession();
    const [w, e] = callIds(m);
    assert.deepEqual(eligibleArgs(m, policy(), new Set()), [w, e]);
  });

  // parity: TESTS/core.test.ts:423-432
  it("skips assistant messages with thinking blocks (signed, must stay byte-identical)", () => {
    for (const type of ["thinking", "redacted_thinking"]) {
      const m = argSession();
      const [w, e] = callIds(m);
      const first = m.find((x) => x.role === "assistant");
      first.content.unshift({ type, thinking: "hmm", thinkingSignature: "sig" });
      assert.deepEqual(eligibleArgs(m, policy(), new Set()), [e]);
      assert.notEqual(w, undefined);
    }
  });

  // parity: TESTS/core.test.ts:444-450
  it("skips young calls, protected tools and already-elided ones", () => {
    const m = argSession();
    const [w, e] = callIds(m);
    assert.deepEqual(eligibleArgs(m.slice(0, 7), policy(), new Set()), []); // nothing is old enough yet
    assert.deepEqual(eligibleArgs(m, policy({ neverElide: ["write"] }), new Set()), [e]);
    assert.deepEqual(eligibleArgs(m, policy(), new Set([w])), [e]);
  });

  // parity: TESTS/core.test.ts:451-460 (other tools / unanswered calls / junk parts)
  it("ignores other tools, unanswered calls and junk parts", () => {
    const m = [
      user(),
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "bashy", name: "bash", arguments: { command: big(5000) } },
          { type: "toolCall", id: "noanswer", name: "write", arguments: writeArgs(5000) },
          { type: "toolCall", name: "write" },
          null,
          { type: "text", text: "hi" },
        ],
      },
      { role: "toolResult", toolCallId: "bashy", content: text("ok") },
      { role: "toolResult", content: text("no id") },
      ...convo(8, { endTs: NOW }).slice(1),
    ];
    assert.deepEqual(eligibleArgs(m, policy(), new Set()), []);
  });

  // parity: TESTS/core.test.ts:485-493 (decide wires eligibleArgs: cold + elideArgs + protectedTools + already)
  it("decide picks up arguments at a cold start, and only when elideArgs is on", () => {
    const m = argSession();
    const cfg = { ...DEFAULT_CONFIG, keepTurns: 5, minChars: 1000 };
    assert.equal(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }).argIds.length, 2);
    assert.deepEqual(decide(m, new Set(), { ...cfg, elideArgs: false }, { now: NOW + 10 * MIN, force: false }).argIds, []);
    assert.equal(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }, { protectedTools: ["write"] }).argIds.length, 1);
    const done = new Set(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }).argIds);
    assert.deepEqual(decide(m, new Set(), cfg, { now: NOW + 10 * MIN, force: false }, { elidedArgs: done }).argIds, []);
  });
});

// ===========================================================================
// stableStringify / callSignature (upstream TS:469-480, tests TS:496-509)
// ===========================================================================

describe("call signatures", () => {
  // parity: TESTS/core.test.ts:498-502
  it("stableStringify sorts keys and handles every JSON type", () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    assert.equal(stableStringify("x"), '"x"');
    assert.equal(stableStringify(undefined), "null");
    assert.equal(stableStringify([]), "[]");
  });

  // parity: TESTS/core.test.ts:503-508
  it("callSignature is the same for the same call whatever the key order", () => {
    assert.equal(callSignature("read", { path: "a", limit: 5 }), callSignature("read", { limit: 5, path: "a" }));
    assert.notEqual(callSignature("read", { path: "a" }), callSignature("read", { path: "b" }));
    assert.notEqual(callSignature("read", { path: "a" }), callSignature("bash", { path: "a" }));
    assert.equal(callSignature("x", undefined), "x:{}");
  });
});

// ===========================================================================
// j) Calibrator (upstream TS:556-600, tests TS:594-642)
// ===========================================================================

describe("Calibrator", () => {
  // parity: TESTS/core.test.ts:599-604
  it("uses the default until it has 6 samples", () => {
    const c = new Calibrator();
    for (let i = 1; i <= 5; i++) c.add(i * 1000, 20_000 + i * 400);
    assert.equal(c.samples(), 5);
    assert.equal(c.charsPerToken(), DEFAULT_CHARS_PER_TOKEN);
    assert.equal(c.isMeasured(), false);
  });

  // parity: TESTS/core.test.ts:605-611
  it("recovers the real ratio, ignoring the fixed system prompt (the intercept), and says it measured it", () => {
    const c = new Calibrator();
    assert.equal(c.isMeasured(), false);
    for (let i = 1; i <= 12; i++) c.add(i * 10_000, 20_000 + (i * 10_000) / 2.5);
    assert.ok(Math.abs(c.charsPerToken() - 2.5) < 1e-5);
    assert.equal(c.isMeasured(), true);
  });

  // parity: TESTS/core.test.ts:612-618 (clamps to 1.5..8 and ignores junk)
  it("clamps to 1.5..8 and ignores junk", () => {
    const lo = new Calibrator();
    for (let i = 1; i <= 8; i++) lo.add(i * 1000, i * 1000 * 5);
    assert.equal(lo.charsPerToken(), 1.5);
    const hi = new Calibrator();
    for (let i = 1; i <= 8; i++) hi.add(i * 100_000, 20_000 + i * 1000);
    assert.equal(hi.charsPerToken(), 8);
    const junk = new Calibrator();
    junk.add(0, 100);
    junk.add(100, 0);
    junk.add(-5, 5);
    junk.add(Infinity, 100);
    junk.add(100, Infinity);
    junk.add(NaN, 100);
    junk.add(100, NaN);
    assert.equal(junk.samples(), 0);
  });

  // parity: TESTS/core.test.ts:625-636 (no variation / no positive slope falls back to the default)
  it("falls back when there is no variation or no positive slope", () => {
    const flat = new Calibrator();
    for (let i = 0; i < 8; i++) flat.add(5000, 25_000 + i);
    assert.equal(flat.charsPerToken(), DEFAULT_CHARS_PER_TOKEN);
    assert.equal(flat.isMeasured(), false);
    const down = new Calibrator();
    for (let i = 1; i <= 8; i++) down.add(i * 1000, 50_000 - i * 1000);
    assert.equal(down.charsPerToken(), DEFAULT_CHARS_PER_TOKEN);
    const constant = new Calibrator(); // tokens never change with size (a provider that reports a fixed number)
    for (let i = 1; i <= 8; i++) constant.add(i * 1000, 5200);
    assert.equal(constant.isMeasured(), false);
    assert.equal(constant.charsPerToken(), DEFAULT_CHARS_PER_TOKEN);
  });

  // parity: TESTS/core.test.ts:637-641
  it("keeps a rolling window of the latest 200 samples", () => {
    const c = new Calibrator();
    for (let i = 1; i <= 250; i++) c.add(i * 100, i * 40);
    assert.equal(c.samples(), 200);
  });

  // parity: TESTS/core.test.ts:605-611 + spec 5.2 (6 samples that grow with chars are enough to measure)
  it("measures from 6 growing samples and lands in 1.5..8", () => {
    const c = new Calibrator();
    for (let i = 1; i <= 6; i++) c.add(i * 1000, 20_000 + i * 400);
    assert.equal(c.samples(), 6);
    assert.equal(c.isMeasured(), true);
    const cpt = c.charsPerToken();
    assert.ok(Number.isFinite(cpt));
    assert.ok(cpt >= 1.5 && cpt <= 8, `charsPerToken ${cpt} must be in 1.5..8`);
  });
});

// ===========================================================================
// k) RecoveryMeter (upstream TS:734-784, tests TS:511-558)
// ===========================================================================

describe("RecoveryMeter", () => {
  const info = (id, tool = "bash", cmd = id, chars = 4000) => ({ id, tool, sig: callSignature(tool, { command: cmd }), chars });

  // parity: TESTS/core.test.ts:514-525
  it("counts a re-fetch once, with its cost, and attributes it to the tool", () => {
    const m = new RecoveryMeter();
    m.track([info("a"), info("b", "read")]);
    assert.equal(m.elided(), 2);
    const hit = m.onCall("bash", { command: "a" });
    assert.equal(hit?.id, "a");
    assert.equal(m.recovered, 1);
    assert.equal(m.recoveredChars, 4000);
    assert.deepEqual(m.perTool.get("bash"), { elided: 1, recovered: 1 });
    assert.deepEqual(m.perTool.get("read"), { elided: 1, recovered: 0 });
    assert.equal(m.onCall("bash", { command: "a" }), undefined); // already counted
  });

  // parity: TESTS/core.test.ts:526-532
  it("ignores calls that match nothing that was elided", () => {
    const m = new RecoveryMeter();
    m.track([info("a")]);
    assert.equal(m.onCall("bash", { command: "other" }), undefined);
    assert.equal(m.onCall("read", { command: "a" }), undefined);
    assert.equal(m.recovered, 0);
  });

  // parity: TESTS/core.test.ts:533-539
  it("track is idempotent", () => {
    const m = new RecoveryMeter();
    m.track([info("a")]);
    m.track([info("a")]);
    assert.equal(m.elided(), 1);
    assert.equal(m.perTool.get("bash").elided, 1);
  });

  // parity: TESTS/core.test.ts:540-546
  it("one re-fetch answers every elided copy of the same output", () => {
    const m = new RecoveryMeter();
    m.track([info("a1", "bash", "ls"), info("a2", "bash", "ls")]);
    assert.notEqual(m.onCall("bash", { command: "ls" }), undefined);
    assert.equal(m.recovered, 1);
    assert.equal(m.onCall("bash", { command: "ls" }), undefined);
  });

  // parity: TESTS/core.test.ts:547-558 (strictly greater than threshold; enough samples)
  it("shouldProtect needs enough samples and a high enough share", () => {
    const m = new RecoveryMeter();
    m.track(Array.from({ length: 8 }, (_, i) => info(`i${i}`, "bash", `c${i}`)));
    assert.equal(m.shouldProtect("bash", 0.25), false); // nothing re-fetched
    for (const c of ["c0", "c1"]) m.onCall("bash", { command: c });
    assert.equal(m.shouldProtect("bash", 0.25), false); // 2/8 = 25%: not above the threshold
    m.onCall("bash", { command: "c2" });
    assert.equal(m.shouldProtect("bash", 0.25), true); // 3/8
    assert.equal(m.shouldProtect("bash", 0.5), false);
    assert.equal(m.shouldProtect("bash", 0.1, 20), false); // too few samples
    assert.equal(m.shouldProtect("read", 0.1), false); // unknown tool
  });

  // parity: spec 6.4 (elided >= minSample, default 5; share must be strictly greater)
  it("needs at least 5 elided samples even when the share is high", () => {
    const four = new RecoveryMeter();
    four.track(Array.from({ length: 4 }, (_, i) => info(`f${i}`)));
    for (const c of ["f0", "f1", "f2", "f3"]) four.onCall("bash", { command: c });
    assert.equal(four.shouldProtect("bash", 0.25), false); // 4/4 but only 4 samples
    const five = new RecoveryMeter();
    five.track(Array.from({ length: 5 }, (_, i) => info(`g${i}`)));
    for (const c of ["g0", "g1"]) five.onCall("bash", { command: c });
    assert.equal(five.shouldProtect("bash", 0.25), true); // 2/5 = 40% > 25%, 5 samples
  });
});

// ===========================================================================
// l) parseCommand / USAGE / completions (upstream TS:831-921,
//    tests/commands.test.ts:5-84)
// ===========================================================================

describe("USAGE", () => {
  // parity: TESTS/core.test.ts:831-832 (dsh: the compact segment is removed per impl-contract §0.3)
  it("is the upstream usage text without the compact command", () => {
    assert.equal(
      USAGE,
      "Usage: /context-diet [status] · on · off · now · keep <turns> · ttl <minutes> · mode <cold|always> · args <on|off> · show",
    );
    assert.equal(/compact/.test(USAGE), false);
  });
});

describe("parseCommand", () => {
  // parity: TESTS/commands.test.ts:7-9
  it("defaults to status", () => {
    for (const a of [undefined, "", "   ", "status", " STATUS "]) assert.deepEqual(parseCommand(a), { kind: "status" });
  });

  // parity: TESTS/commands.test.ts:10-15
  it("on / off and their aliases", () => {
    assert.deepEqual(parseCommand("on"), { kind: "on" });
    assert.deepEqual(parseCommand("enable"), { kind: "on" });
    assert.deepEqual(parseCommand("off"), { kind: "off" });
    assert.deepEqual(parseCommand("disable"), { kind: "off" });
    assert.deepEqual(parseCommand("now"), { kind: "now" });
  });

  // parity: TESTS/commands.test.ts:16-21
  it("keep <turns> (integer 1..500)", () => {
    assert.deepEqual(parseCommand("keep 20"), { kind: "keep", turns: 20 });
    assert.deepEqual(parseCommand("KEEP  1"), { kind: "keep", turns: 1 });
    assert.deepEqual(parseCommand("keep 500"), { kind: "keep", turns: 500 });
    for (const bad of ["keep", "keep 0", "keep 501", "keep 1.5", "keep x", "keep -3"]) assert.equal(parseCommand(bad).kind, "invalid", bad);
    assert.equal(parseCommand("keep").message, "Usage: /context-diet keep <turns> (1 to 500)");
  });

  // parity: TESTS/commands.test.ts:22-27
  it("ttl <minutes> (integer 1..1440)", () => {
    assert.deepEqual(parseCommand("ttl 5"), { kind: "ttl", minutes: 5 });
    assert.deepEqual(parseCommand("ttl 1440"), { kind: "ttl", minutes: 1440 });
    for (const bad of ["ttl", "ttl 0", "ttl 1441", "ttl 2.5", "ttl soon"]) assert.equal(parseCommand(bad).kind, "invalid", bad);
    assert.equal(parseCommand("ttl").message, "Usage: /context-diet ttl <minutes> (1 to 1440)");
  });

  // parity: TESTS/commands.test.ts:28-33
  it("mode <cold|always>", () => {
    assert.deepEqual(parseCommand("mode cold"), { kind: "mode", mode: "cold" });
    assert.deepEqual(parseCommand("mode ALWAYS"), { kind: "mode", mode: "always" });
    for (const bad of ["mode", "mode sometimes"]) assert.equal(parseCommand(bad).kind, "invalid", bad);
    assert.equal(parseCommand("mode").message, "Usage: /context-diet mode <cold|always>");
  });

  // parity: TESTS/commands.test.ts:34-39
  it("args <on|off>", () => {
    assert.deepEqual(parseCommand("args on"), { kind: "args", on: true });
    assert.deepEqual(parseCommand("ARGS  OFF"), { kind: "args", on: false });
    for (const bad of ["args", "args maybe"]) assert.equal(parseCommand(bad).kind, "invalid", bad);
    assert.equal(parseCommand("args").message, "Usage: /context-diet args <on|off>");
  });

  // parity: TESTS/commands.test.ts:40-42
  it("show", () => {
    assert.deepEqual(parseCommand("show"), { kind: "show" });
  });

  // parity: TESTS/commands.test.ts:43-47
  it("unknown words say what is valid", () => {
    const c = parseCommand("bogus");
    assert.equal(c.kind, "invalid");
    assert.equal(c.message, `Unknown option "bogus". ${USAGE}`);
    assert.ok(c.message.includes("keep <turns>"));
  });

  // parity: TESTS/commands.test.ts:40-46 (upstream parses compact on|off|now);
  // dsh: impl-contract §0.3 removes the command, so this asserts the removal explicitly
  it("compact is gone (not implemented on DSH) and reports as an unknown option", () => {
    for (const a of ["compact", "compact on", "compact off", "compact now"]) {
      const c = parseCommand(a);
      assert.equal(c.kind, "invalid", a);
      assert.equal(c.message.includes('Unknown option "compact"'), true, a);
    }
  });

  // parity: spec 9.1 (extra arguments are ignored; casing is normalised)
  it("ignores extra arguments and is case-insensitive", () => {
    assert.deepEqual(parseCommand("keep 7 junk"), { kind: "keep", turns: 7 });
    assert.deepEqual(parseCommand("  NOW  "), { kind: "now" });
  });
});

describe("completions", () => {
  // parity: TESTS/commands.test.ts:50-58 (dsh: the compact entry is removed)
  it("offers every implemented command at the top level, each with a string value and label", () => {
    const items = completions("");
    assert.notEqual(items, null);
    assert.deepEqual(items.map((i) => i.label), ["status", "on", "off", "now", "keep", "ttl", "mode", "args", "show"]);
    for (const i of items) {
      assert.equal(typeof i.value, "string");
      assert.equal(typeof i.label, "string");
      assert.ok(i.description && i.description.length > 3);
    }
  });

  // parity: TESTS/commands.test.ts:59-65
  it("filters by prefix and returns null when nothing matches", () => {
    assert.deepEqual(completions("mo").map((i) => i.value), ["mode "]);
    assert.deepEqual(completions("k").map((i) => i.value), ["keep "]);
    assert.deepEqual(completions("  ST").map((i) => i.value), ["status"]);
    assert.equal(completions("zzz"), null);
    assert.notEqual(completions(undefined), null);
  });

  // parity: TESTS/commands.test.ts:66-71
  it("completes the mode argument with the full argument text", () => {
    assert.deepEqual(completions("mode ").map((i) => i.value), ["mode cold", "mode always"]);
    assert.deepEqual(completions("mode a").map((i) => i.value), ["mode always"]);
    assert.equal(completions("mode x"), null);
    assert.deepEqual(completions("sh").map((i) => i.value), ["show"]);
  });

  // parity: TESTS/commands.test.ts:82-84 (dsh: compact completions are removed)
  it("completes the args argument too, and no longer offers compact", () => {
    assert.deepEqual(completions("args ").map((i) => i.value), ["args on", "args off"]);
    assert.deepEqual(completions("args of").map((i) => i.value), ["args off"]);
    assert.equal(completions("args x"), null);
    assert.deepEqual(completions("a").map((i) => i.value), ["args "]);
    assert.equal(completions("compact"), null);
    assert.equal(completions("co"), null);
  });
});

// ===========================================================================
// m) statusLine (upstream TS:953-975, tests TS:306-316 and TS:576-582)
// ===========================================================================

describe("statusLine", () => {
  // parity: TESTS/core.test.ts:306-316 (dsh: brand prefix pi- → context-diet)
  it("reports settings and savings", () => {
    const s = statusLine(DEFAULT_CONFIG, { requests: 24, cumulativeChars: 20_400_000, lastChars: 850_000, lastCount: 37, lastArgCount: 0, coldStarts: 3 });
    assert.equal(s.startsWith("context-diet: on · mode cold · keep last 20 turns · cache ttl 5 min · min 1.5 KB · write/edit args elided"), true);
    assert.equal(s.includes("37 results elided (~283.3k tokens kept out of every request)"), true);
    assert.equal(s.includes("~6.80M tokens saved over 24 requests · 3 cold starts"), true);
  });

  // parity: TESTS/core.test.ts:311-315
  it("reports off / kept args / singular cold start / argument counts", () => {
    const none = { requests: 0, cumulativeChars: 0, lastChars: 0, lastCount: 0, lastArgCount: 0, coldStarts: 1 };
    assert.equal(statusLine({ ...DEFAULT_CONFIG, enabled: false }, none).includes("off ·"), true);
    assert.equal(statusLine({ ...DEFAULT_CONFIG, elideArgs: false }, none).includes("write/edit args kept"), true);
    assert.equal(statusLine(DEFAULT_CONFIG, none).includes("1 cold start"), true);
    assert.equal(statusLine(DEFAULT_CONFIG, { ...none, lastCount: 3, lastArgCount: 4 }).includes("3 results + 4 write/edit arguments elided"), true);
  });

  // parity: TESTS/core.test.ts:576-582
  it("includes the recovery summary", () => {
    const base = { requests: 4, cumulativeChars: 400_000, lastChars: 100_000, lastCount: 5, lastArgCount: 0, coldStarts: 1 };
    const line = statusLine(DEFAULT_CONFIG, base, { recovered: 2, elided: 40, recoveredChars: 36_000, protectedTools: ["bash", "read"] });
    assert.equal(line.includes("recovery: 2 of 40 elided results re-fetched (5%, ~12.0k tokens to re-fetch, once)"), true);
    assert.equal(line.includes("protected: bash, read"), true);
    assert.equal(statusLine(DEFAULT_CONFIG, base, { recovered: 0, elided: 0, recoveredChars: 0, protectedTools: [] }).includes("0 of 0 elided results re-fetched (0%"), true);
  });

  // parity: TESTS/core.test.ts:585-592 / 720-730 (the only upstream places that mention
  // compaction or warming) + spec 9.3; dsh: impl-contract §0.3 — they are not implemented,
  // so no wording about them may ever appear in the status text.
  it("never mentions compaction or warming (those features are not implemented)", () => {
    const base = { requests: 4, cumulativeChars: 400_000, lastChars: 100_000, lastCount: 5, lastArgCount: 0, coldStarts: 1 };
    const recovery = { recovered: 0, elided: 0, recoveredChars: 0, protectedTools: [] };
    const extra = { charsPerToken: 2.5, samples: 12, measured: true };
    assert.doesNotMatch(statusLine(DEFAULT_CONFIG, base, recovery, extra), /compact|warming/i);
    assert.doesNotMatch(statusLine({ ...DEFAULT_CONFIG, mode: "always" }, base, recovery, extra), /compact|warming/i);
  });
});

// ===========================================================================
// m) footerLine — the two upstream showStatus shapes as a pure function
//    (impl-contract §3, upstream TS:997-1023 / tests extension.test.ts:439-472)
// ===========================================================================

describe("footerLine", () => {
  // parity: TESTS/extension.test.ts:447-461 + impl-contract §3 (showStatus=false / enabled=false → "")
  it("returns an empty string (not null) when disabled or when the status is hidden", () => {
    const off = footerLine({ ...DEFAULT_CONFIG, enabled: false }, zeroStats());
    assert.equal(typeof off, "string");
    assert.equal(off, "");
    const hidden = footerLine({ ...DEFAULT_CONFIG, showStatus: false }, zeroStats());
    assert.equal(typeof hidden, "string");
    assert.equal(hidden, "");
    const hiddenBig = footerLine({ ...DEFAULT_CONFIG, showStatus: false }, bigStats());
    assert.equal(hiddenBig, "");
  });

  // parity: TESTS/extension.test.ts:463-472 (form A, no candidates → "on")
  it("form A: says it is on when nothing would be elided at the next pause", () => {
    assert.equal(footerLine(DEFAULT_CONFIG, zeroStats()), "🥗 on");
  });

  // parity: TESTS/extension.test.ts:463-472 + impl-contract §3 (next = tokens a cold start would drop)
  it("form A: shows −<next> at the next pause", () => {
    assert.equal(footerLine(DEFAULT_CONFIG, zeroStats(), undefined, { next: 1900 }), "🥗 −1.9k at the next pause");
    assert.equal(footerLine(DEFAULT_CONFIG, zeroStats(), undefined, { next: 0 }), "🥗 on");
  });

  // parity: TESTS/extension.test.ts:92-104 + TS:1016-1019 (form B: −x /req · y saved)
  it("form B: shows −<x> /req · <y> saved", () => {
    assert.equal(footerLine(DEFAULT_CONFIG, bigStats()), "🥗 −283.3k /req · 6.80M saved");
  });

  // parity: TESTS/extension.test.ts:353-360 (↺n when something was re-fetched)
  it("form B: appends ↺<recovered> when a re-fetch was counted", () => {
    const recovery = { recovered: 3, elided: 40, recoveredChars: 36_000, protectedTools: [] };
    assert.equal(footerLine(DEFAULT_CONFIG, bigStats(), recovery), "🥗 −283.3k /req · 6.80M saved ↺3");
    assert.equal(footerLine(DEFAULT_CONFIG, bigStats(), { ...recovery, recovered: 0 }), "🥗 −283.3k /req · 6.80M saved");
  });

  // parity: TESTS/extension.test.ts:439-445, 493-500 + spec 8.4 (⚠ mode always, exact wording, both forms)
  it("form B: appends the exact warning in always mode", () => {
    const always = { ...DEFAULT_CONFIG, mode: "always" };
    const line = footerLine(always, bigStats());
    assert.equal(line, "🥗 −283.3k /req · 6.80M saved ⚠ mode always");
    const recovery = { recovered: 3, elided: 40, recoveredChars: 36_000, protectedTools: [] };
    assert.equal(footerLine(always, bigStats(), recovery), "🥗 −283.3k /req · 6.80M saved ↺3 ⚠ mode always");
  });

  // parity: TESTS/extension.test.ts:439-445 (warning exists before any elision too) + lead decision
  it("form A: always mode still carries the warning", () => {
    const always = { ...DEFAULT_CONFIG, mode: "always" };
    assert.equal(footerLine(always, zeroStats()).includes("⚠ mode always"), true);
    assert.equal(footerLine(always, zeroStats(), undefined, { next: 1900 }).includes("⚠ mode always"), true);
  });
});
