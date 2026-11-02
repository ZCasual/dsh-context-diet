// Unit tests for the pure strategy core in core.js.
//
// Run: node --test test/unit/core.test.js
//
// The core is platform-neutral: no DSH/Pi imports, no fs, no clock, no randomness.
// Everything here drives pure functions over plain message/config objects.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  DEFAULT_CHARS_PER_TOKEN,
  sanitizeConfig,
  codePointLength,
  lineCount,
  measure,
  charsOfMessages,
  indexCalls,
  describeCall,
  hasThinking,
  assistantTurnsAfter,
  previewOf,
  stubText,
  formatSize,
  formatTokens,
  estimateTokens,
  statusLine,
  emptyStats,
  policyOf,
  eligible,
  lastAssistantTimestamp,
  isCold,
  decide,
  argChars,
  elideArguments,
  eligibleArgs,
  stableStringify,
  callSignature,
  applyElision,
  RecoveryMeter,
  STUB_MARKER,
  isStubbed,
  resolvePolicy,
  planElisions,
  parseCommand,
  statusText,
} from "../../core.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const text = (t) => [{ type: "text", text: t }];
const big = (chars, seed = "x") =>
  seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);

let counter = 0;
const resetIds = () => {
  counter = 0;
};

const user = (t = "do the thing", ts = 0) => ({
  role: "user",
  content: text(t),
  timestamp: ts,
});

/** One agent turn: an assistant tool call plus its result. */
function turn(opts = {}) {
  const id = `call_${++counter}`;
  const tool = opts.tool ?? "bash";
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id,
          name: tool,
          arguments: opts.args ?? { command: `echo step ${counter}` },
        },
      ],
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
  for (let i = 0; i < n; i++) {
    out.push(...turn({ chars: opts.chars ?? 4000, ts: endTs - (n - 1 - i) * step }));
  }
  return out;
}

const empty = () => new Set();

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Defaults and validation
// ---------------------------------------------------------------------------

describe("defaults and sanitizeConfig", () => {
  it("DEFAULT_CONFIG carries the documented defaults and is frozen", () => {
    assert.equal(DEFAULT_CONFIG.enabled, true);
    assert.equal(DEFAULT_CONFIG.mode, "cold");
    assert.equal(DEFAULT_CONFIG.keepTurns, 20);
    assert.equal(DEFAULT_CONFIG.minChars, 1500);
    assert.equal(DEFAULT_CONFIG.cacheTtlMinutes, 5);
    assert.equal(DEFAULT_CONFIG.keepErrors, true);
    assert.deepEqual(DEFAULT_CONFIG.neverElide, []);
    assert.equal(DEFAULT_CONFIG.stubTailLines, 3);
    assert.equal(DEFAULT_CONFIG.stubErrorLines, 3);
    assert.equal(DEFAULT_CONFIG.elideArgs, true);
    assert.equal(DEFAULT_CONFIG.autoProtect, true);
    assert.equal(DEFAULT_CONFIG.recoveryThreshold, 0.25);
    assert.equal(DEFAULT_CONFIG.compact, false);
    assert.equal(DEFAULT_CONFIG.compactAboveTokens, 150000);
    assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  });

  it("a missing or non-object value gives the defaults", () => {
    assert.deepEqual(sanitizeConfig(undefined), { ...DEFAULT_CONFIG });
    assert.deepEqual(sanitizeConfig(null), { ...DEFAULT_CONFIG });
    assert.deepEqual(sanitizeConfig("nope"), { ...DEFAULT_CONFIG });
    assert.deepEqual(sanitizeConfig([]), { ...DEFAULT_CONFIG });
  });

  it("junk values fall back and numbers are clamped", () => {
    const c = sanitizeConfig({
      enabled: "yes",
      mode: "sometimes",
      keepTurns: 9999,
      minChars: 1,
      cacheTtlMinutes: 0,
      stubTailLines: 99,
      stubErrorLines: -2,
      recoveryThreshold: 2,
      stopWarmingShare: 0,
      compactAboveTokens: 5,
    });
    assert.equal(c.enabled, true);
    assert.equal(c.mode, "cold");
    assert.equal(c.keepTurns, 500);
    assert.equal(c.minChars, 200);
    assert.equal(c.cacheTtlMinutes, 1);
    assert.equal(c.stubTailLines, 10);
    assert.equal(c.stubErrorLines, 0);
    assert.equal(c.recoveryThreshold, 1);
    assert.equal(c.stopWarmingShare, 0.05);
    assert.equal(c.compactAboveTokens, 20000);
  });

  it("valid booleans, mode and string lists survive", () => {
    const c = sanitizeConfig({
      enabled: false,
      mode: "always",
      keepErrors: false,
      neverElide: [1, "  read ", "read", "", "write"],
      elideArgs: false,
      autoProtect: false,
      compact: true,
      compactAboveTokens: 250000,
    });
    assert.equal(c.enabled, false);
    assert.equal(c.mode, "always");
    assert.equal(c.keepErrors, false);
    assert.deepEqual(c.neverElide, ["read", "write"]);
    assert.equal(c.elideArgs, false);
    assert.equal(c.autoProtect, false);
    assert.equal(c.compact, true);
    assert.equal(c.compactAboveTokens, 250000);
  });
});

// ---------------------------------------------------------------------------
// Unicode-aware measurement
// ---------------------------------------------------------------------------

describe("Unicode code-point measurement", () => {
  it("counts code points, not UTF-16 code units", () => {
    assert.equal(codePointLength("abc"), 3);
    assert.equal(codePointLength("a😀b"), 3);
    assert.equal(codePointLength("👨‍👩‍👧‍👦"), 7); // 4 emoji + 3 ZWJ
    assert.equal(codePointLength(""), 0);
  });

  it("counts lines and ignores a single trailing newline", () => {
    assert.equal(lineCount(""), 0);
    assert.equal(lineCount("a"), 1);
    assert.equal(lineCount("a\nb"), 2);
    assert.equal(lineCount("a\nb\n"), 2);
  });

  it("measure() reports code-point chars, lines and plain-text shape", () => {
    assert.deepEqual(measure("a😀b\nc"), { chars: 5, lines: 2, textOnly: true });
    assert.deepEqual(measure(""), { chars: 0, lines: 0, textOnly: true });
    assert.deepEqual(measure([{ type: "text", text: "😀" }]), {
      chars: 1,
      lines: 1,
      textOnly: true,
    });
    assert.deepEqual(measure([{ type: "text", text: "abc" }, { type: "image" }]), {
      chars: 3,
      lines: 1,
      textOnly: false,
    });
    assert.equal(measure(undefined).textOnly, true);
  });

  it("charsOfMessages() sums strings by code point and other content by JSON length", () => {
    assert.equal(charsOfMessages([{ content: "a😀" }, { content: [] }]), 4);
  });
});

// ---------------------------------------------------------------------------
// Call indexing and message metadata
// ---------------------------------------------------------------------------

describe("indexCalls, describeCall, hasThinking, assistantTurnsAfter", () => {
  it("maps tool call ids to name and arguments, ignoring malformed parts", () => {
    const msgs = [
      { role: "user", content: text("go") },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "noise" },
          { type: "toolCall", name: "missing-id" },
        ],
      },
    ];
    const calls = indexCalls(msgs);
    assert.equal(calls.size, 1);
    assert.deepEqual(calls.get("c1"), { name: "bash", args: { command: "ls" } });
  });

  it("labels a call by command, path, pattern or query and clips long labels", () => {
    assert.equal(describeCall("bash", { command: "npm test" }), "npm test");
    assert.equal(describeCall("read", { path: "src/a.js" }), "src/a.js");
    assert.equal(describeCall("grep", { pattern: "TODO" }), "TODO");
    assert.equal(describeCall("write", { file_path: "a.js", content: "x" }), "a.js");
    assert.equal(describeCall("bash", {}), "");
    const long = describeCall("bash", { command: "y".repeat(200) });
    assert.equal([...long].length, 80);
    assert.equal(long.endsWith("…"), true);
  });

  it("detects signed thinking blocks", () => {
    assert.equal(hasThinking({ content: [{ type: "thinking", thinking: "x" }] }), true);
    assert.equal(
      hasThinking({ content: [{ type: "redacted_thinking", data: "x" }] }),
      true,
    );
    assert.equal(hasThinking({ content: [{ type: "text", text: "x" }] }), false);
    assert.equal(hasThinking({}), false);
  });

  it("counts assistant messages after each message", () => {
    const msgs = ["user", "assistant", "toolResult", "assistant", "toolResult"].map(
      (role) => ({ role }),
    );
    assert.deepEqual(assistantTurnsAfter(msgs), [2, 1, 1, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Preview and deterministic stub
// ---------------------------------------------------------------------------

describe("previewOf and stubText", () => {
  it("keeps the last lines and non-trivially failing error lines", () => {
    const content =
      "ok\nTypeError: boom\n0 failed\nanother error line\nlast line\n";
    const p = previewOf(content, 2, 3);
    assert.deepEqual(p.tail, ["another error line", "last line"]);
    assert.deepEqual(p.errors, ["TypeError: boom"]);
  });

  it("returns empty previews when both budgets are zero", () => {
    assert.deepEqual(previewOf("error\nx", 0, 0), { tail: [], errors: [] });
  });

  it("clips preview lines by code point without splitting surrogate pairs", () => {
    const p = previewOf(`ok\n${"😀".repeat(200)}\n`, 1, 0);
    assert.equal([...p.tail[0]].length, 160);
    assert.equal(p.tail[0].endsWith("…"), true);
  });

  it("stubText is deterministic and says what was elided", () => {
    const a = stubText("bash", "npm test", 12345, 130, {
      tail: ["done"],
      errors: ["Error: nope"],
    });
    const b = stubText("bash", "npm test", 12345, 130, {
      tail: ["done"],
      errors: ["Error: nope"],
    });
    assert.equal(a, b);
    assert.match(a, /dsh-context-diet/);
    assert.match(a, /bash npm test/);
    assert.match(a, /12\.3 KB/);
    assert.match(a, /130 lines/);
    assert.match(a, /error lines:/);
    assert.match(a, /Error: nope/);
    assert.match(a, /last lines:/);
    assert.match(a, /done/);
  });

  it("stubText works without a label or preview", () => {
    const s = stubText("read", "", 10, 1);
    assert.match(s, /read/);
    assert.doesNotMatch(s, /last lines:/);
    assert.doesNotMatch(s, /error lines:/);
  });
});

// ---------------------------------------------------------------------------
// Formatting and stats
// ---------------------------------------------------------------------------

describe("formatting", () => {
  it("formats sizes", () => {
    assert.equal(formatSize(999), "999 B");
    assert.equal(formatSize(1500), "1.5 KB");
    assert.equal(formatSize(1_500_000), "1.5 MB");
  });

  it("formats token counts", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(1_500_000), "1.50M");
    assert.equal(formatTokens(1_500_000_000), "1.50B");
  });

  it("estimates tokens from a calibrated or default ratio", () => {
    assert.equal(estimateTokens(300), 100);
    assert.equal(estimateTokens(300, 2), 150);
    assert.equal(DEFAULT_CHARS_PER_TOKEN, 3);
  });

  it("emptyStats starts at zero", () => {
    assert.deepEqual(emptyStats(), {
      requests: 0,
      cumulativeChars: 0,
      lastChars: 0,
      lastCount: 0,
      lastArgCount: 0,
      coldStarts: 0,
    });
  });

  it("statusLine reports settings, savings and the recovery meter", () => {
    const config = sanitizeConfig({});
    const stats = {
      requests: 3,
      cumulativeChars: 3000,
      lastChars: 300,
      lastCount: 2,
      lastArgCount: 0,
      coldStarts: 1,
    };
    const line = statusLine(
      config,
      stats,
      { recovered: 1, elided: 4, recoveredChars: 50, protectedTools: [] },
      { charsPerToken: 3, samples: 6, measured: true },
    );
    assert.match(line, /dsh-context-diet: on/);
    assert.match(line, /mode cold/);
    assert.match(line, /keep last 20 turns/);
    assert.match(line, /cache ttl 5 min/);
    assert.match(line, /recovery: 1 of 4 elided results re-fetched \(25%/);
    assert.match(line, /3\.00 chars\/token measured from 6 requests/);
  });
});

// ---------------------------------------------------------------------------
// Policy and candidate selection
// ---------------------------------------------------------------------------

describe("eligible", () => {
  it("keeps results younger than or exactly at the keepTurns boundary", () => {
    resetIds();
    const config = sanitizeConfig({ keepTurns: 1, minChars: 200 });
    const msgs = convo(5);
    const ids = eligible(msgs, policyOf(config), empty());
    assert.equal(ids.length, 3); // ages 4, 3, 2 are eligible; 1 and 0 are not
  });

  it("skips small results, errors (unless allowed), images and already-elided tools", () => {
    resetIds();
    const config = sanitizeConfig({ keepTurns: 1, minChars: 200 });
    const policy = policyOf(config);

    const oldSmall = [user(), ...turn({ chars: 100 }), ...convo(2)];
    assert.equal(eligible(oldSmall, policy, empty()).length, 0);

    const withError = [user(), ...turn({ chars: 4000, isError: true }), ...convo(2)];
    assert.equal(eligible(withError, policy, empty()).length, 0);
    assert.equal(
      eligible(withError, policyOf({ ...config, keepErrors: false }), empty()).length,
      1,
    );

    const imageTurn = turn({ content: [{ type: "image", data: "x" }] });
    const bigTurn = turn({ chars: 4000 });
    const withImage = [user(), ...imageTurn, ...bigTurn, ...convo(2)];
    const got = eligible(withImage, policy, empty());
    assert.deepEqual(got, [bigTurn[1].toolCallId]);

    const msgs = [user(), ...convo(5)];
    const first = new Set(eligible(msgs, policy, empty()).slice(0, 1));
    assert.equal(eligible(msgs, policy, first).length, 2);
  });

  it("honours neverElide and requires a toolCallId", () => {
    resetIds();
    const config = sanitizeConfig({ keepTurns: 1, minChars: 200 });
    const msgs = [user(), ...convo(3)];
    assert.equal(eligible(msgs, policyOf({ ...config, neverElide: ["bash"] }), empty()).length, 0);

    const orphan = [...msgs, { role: "toolResult", content: text(big(4000)) }];
    const ids = eligible(orphan, policyOf(config), empty());
    assert.equal(ids.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Cold detection and decision
// ---------------------------------------------------------------------------

describe("lastAssistantTimestamp and isCold", () => {
  it("finds the last assistant timestamp", () => {
    const msgs = [
      { role: "assistant", timestamp: 10 },
      { role: "toolResult", timestamp: 20 },
      { role: "assistant", timestamp: 30 },
    ];
    assert.equal(lastAssistantTimestamp(msgs), 30);
    assert.equal(lastAssistantTimestamp([{ role: "user", timestamp: 1 }]), undefined);
  });

  it("is cold only strictly after the TTL", () => {
    const msgs = [{ role: "assistant", timestamp: 0 }];
    assert.equal(isCold(msgs, 300_000, 300_000), false);
    assert.equal(isCold(msgs, 300_001, 300_000), true);
    assert.equal(isCold([], 10, 300_000), false);
  });
});

describe("decide", () => {
  const config = () => sanitizeConfig({ keepTurns: 1, minChars: 200 });
  const state = (elided = []) => ({
    elided: new Set(elided),
    elidedArgs: new Set(),
    protectedTools: new Set(),
  });

  it("does nothing when disabled", () => {
    resetIds();
    const d = decide(convo(5), state(), { ...config(), enabled: false }, { cold: true });
    assert.deepEqual(d, { ids: [], argIds: [], cold: true, reason: "disabled" });
  });

  it("does nothing while warm in cold mode", () => {
    resetIds();
    const d = decide(convo(5), state(), config(), { cold: false, force: false });
    assert.equal(d.reason, "warm");
    assert.deepEqual(d.ids, []);
  });

  it("elides when cold", () => {
    resetIds();
    const d = decide(convo(5), state(), config(), { cold: true });
    assert.equal(d.reason, "cold");
    assert.equal(d.ids.length, 3);
    assert.deepEqual(d.argIds, []);
  });

  it("mode always ignores coldness; force elides once while warm", () => {
    resetIds();
    const always = decide(convo(5), state(), { ...config(), mode: "always" }, { cold: false });
    assert.equal(always.reason, "always");
    assert.equal(always.ids.length, 3);

    const forced = decide(convo(5), state(), config(), { cold: false, force: true });
    assert.equal(forced.reason, "forced");
    assert.equal(forced.ids.length, 3);
  });

  it("does not re-pick already elided results and honours protected tools", () => {
    resetIds();
    const msgs = convo(5);
    const first = decide(msgs, state(), config(), { cold: true });
    const again = decide(msgs, state(first.ids.slice(0, 2)), config(), { cold: true });
    assert.equal(again.ids.length, 1);

    const protectedState = { ...state(), protectedTools: new Set(["bash"]) };
    assert.equal(decide(msgs, protectedState, config(), { cold: true }).ids.length, 0);
  });
});

// ---------------------------------------------------------------------------
// write / edit argument candidates and placeholders
// ---------------------------------------------------------------------------

describe("argument elision", () => {
  it("measures write and edit argument payloads by code point", () => {
    assert.equal(argChars("write", { content: "a😀" }), 2);
    assert.equal(argChars("edit", { oldText: "ab", newText: "c" }), 3);
    assert.equal(
      argChars("edit", {
        edits: [{ oldText: "11", newText: "2" }, { newText: "4444" }],
      }),
      7,
    );
    assert.equal(argChars("read", { path: "a" }), 0);
  });

  it("replaces write content and edit text with deterministic placeholders", () => {
    const w = elideArguments("write", { content: "x".repeat(10), path: "src/a.js" });
    assert.notEqual(w, undefined);
    assert.match(w.content, /dsh-context-diet/);
    assert.match(w.content, /elided/);
    assert.match(w.content, /src\/a\.js/);
    assert.match(w.content, /10 B/);
    assert.equal(w.path, "src/a.js");

    const e = elideArguments("edit", {
      oldText: "old",
      newText: "new",
      path: "src/b.js",
    });
    assert.match(e.oldText, /dsh-context-diet/);
    assert.match(e.newText, /dsh-context-diet/);
    assert.equal(e.path, "src/b.js");

    const multi = elideArguments("edit", {
      edits: [{ oldText: "aa", newText: "b" }],
      path: "c.js",
    });
    assert.match(multi.edits[0].oldText, /dsh-context-diet/);
    assert.match(multi.edits[0].newText, /dsh-context-diet/);
  });

  it("only proposes completed, successful, old and large write/edit calls", () => {
    resetIds();
    const config = sanitizeConfig({ keepTurns: 1, minChars: 200 });
    const writeId = "write_1";
    const base = [
      user(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: writeId,
            name: "write",
            arguments: { path: "a.js", content: big(4000) },
          },
        ],
      },
      { role: "toolResult", toolCallId: writeId, toolName: "write", content: text("ok") },
      ...convo(3),
    ];
    const ids = eligibleArgs(base, policyOf(config), empty());
    assert.deepEqual(ids, [writeId]);

    const failed = base.map((m) =>
      m.toolCallId === writeId ? { ...m, isError: true } : m,
    );
    assert.deepEqual(eligibleArgs(failed, policyOf(config), empty()), []);

    const unanswered = base.filter((m) => m.role !== "toolResult");
    assert.deepEqual(eligibleArgs(unanswered, policyOf(config), empty()), []);
  });

  it("skips assistant messages with signed thinking blocks", () => {
    resetIds();
    const config = sanitizeConfig({ keepTurns: 1, minChars: 200 });
    const id = "write_1";
    const msgs = [
      user(),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          {
            type: "toolCall",
            id,
            name: "write",
            arguments: { path: "a.js", content: big(4000) },
          },
        ],
      },
      { role: "toolResult", toolCallId: id, toolName: "write", content: text("ok") },
      ...convo(3),
    ];
    assert.deepEqual(eligibleArgs(msgs, policyOf(config), empty()), []);
  });
});

// ---------------------------------------------------------------------------
// Signature and deterministic transformation
// ---------------------------------------------------------------------------

describe("stableStringify and callSignature", () => {
  it("sorts object keys recursively and preserves arrays", () => {
    assert.equal(
      stableStringify({ b: 1, a: { d: 2, c: 3 }, list: [2, { z: 1, a: 2 }] }),
      '{"a":{"c":3,"d":2},"b":1,"list":[2,{"a":2,"z":1}]}',
    );
    assert.equal(stableStringify(undefined), "null");
  });

  it("is insensitive to argument key order", () => {
    assert.equal(
      callSignature("bash", { b: 1, a: 2 }),
      callSignature("bash", { a: 2, b: 1 }),
    );
    assert.notEqual(callSignature("bash", { command: "a" }), callSignature("bash", { command: "b" }));
  });
});

describe("applyElision", () => {
  it("returns new messages and never mutates the input", () => {
    resetIds();
    const msgs = deepFreeze(convo(4));
    const ids = eligible(msgs, policyOf(sanitizeConfig({ keepTurns: 1, minChars: 200 })), empty());
    const state = { elided: new Set(ids), elidedArgs: new Set(), protectedTools: new Set() };
    const res = applyElision(msgs, state, { preview: { tail: 1, errors: 1 } });
    assert.equal(res.count, 2);
    assert.ok(res.savedChars > 0);
    assert.equal(res.infos.length, 2);
    const stub = res.messages.filter((m) => m.role === "toolResult")[0];
    assert.match(stub.content[0].text, /dsh-context-diet/);
  });

  it("is a no-op that returns the same array when nothing is selected", () => {
    const msgs = deepFreeze(convo(2));
    const res = applyElision(msgs, { elided: new Set(), elidedArgs: new Set() });
    assert.equal(res.messages, msgs);
    assert.equal(res.count, 0);
  });

  it("is deterministic for the same inputs", () => {
    resetIds();
    const msgs = deepFreeze(convo(3));
    const state = {
      elided: new Set(["call_1", "call_2"]),
      elidedArgs: new Set(),
      protectedTools: new Set(),
    };
    assert.deepEqual(applyElision(msgs, state).messages, applyElision(msgs, state).messages);
  });

  it("elides stale write arguments and keeps the original message intact", () => {
    resetIds();
    const id = "write_1";
    const msgs = deepFreeze([
      user(),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id,
            name: "write",
            arguments: { path: "a.js", content: "x".repeat(4000) },
          },
        ],
      },
      { role: "toolResult", toolCallId: id, toolName: "write", content: text("ok") },
      ...convo(2),
    ]);
    const res = applyElision(msgs, {
      elided: new Set(),
      elidedArgs: new Set([id]),
    });
    assert.equal(res.argCount, 1);
    const call = res.messages[1].content[0];
    assert.match(call.arguments.content, /dsh-context-diet/);
    assert.equal(msgs[1].content[0].arguments.content.length, 4000);
  });

  it("never rewrites non-text or signed-thinking content", () => {
    resetIds();
    const image = turn({ content: [{ type: "image", data: "x" }] });
    const msgs = deepFreeze([user(), ...image, ...convo(2)]);
    const res = applyElision(msgs, {
      elided: new Set([image[1].toolCallId]),
      elidedArgs: new Set(),
    });
    assert.equal(res.count, 0);
    assert.equal(res.messages, msgs);
  });
});

// ---------------------------------------------------------------------------
// Recovery meter
// ---------------------------------------------------------------------------

describe("RecoveryMeter", () => {
  const info = (id, tool, args, chars = 100) => ({
    id,
    tool,
    sig: callSignature(tool, args),
    chars,
  });

  it("tracks elided results idempotently", () => {
    const m = new RecoveryMeter();
    const i = info("a", "bash", { command: "x" });
    m.track([i]);
    m.track([i]);
    assert.equal(m.elided(), 1);
  });

  it("counts only an identical re-issued call, once", () => {
    const m = new RecoveryMeter();
    m.track([info("a", "bash", { command: "x" }, 120)]);
    assert.equal(m.onCall("bash", { command: "y" }), undefined);
    const hit = m.onCall("bash", { command: "x" });
    assert.equal(hit.id, "a");
    assert.equal(m.recovered, 1);
    assert.equal(m.recoveredChars, 120);
    assert.deepEqual(m.perTool.get("bash"), { elided: 1, recovered: 1 });
    assert.equal(m.onCall("bash", { command: "x" }), undefined);
  });

  it("marks every elided copy of one signature counted after a single re-issue", () => {
    const m = new RecoveryMeter();
    m.track([info("a", "bash", { command: "x" }), info("b", "bash", { command: "x" })]);
    assert.equal(m.onCall("bash", { command: "x" }).id, "a");
    assert.equal(m.recovered, 1);
    assert.equal(m.onCall("bash", { command: "x" }), undefined);
  });

  it("protects a tool once enough samples show repeated re-fetches", () => {
    const m = new RecoveryMeter();
    for (let i = 0; i < 5; i++) m.track([info(`a${i}`, "bash", { command: `x${i}` })]);
    m.onCall("bash", { command: "x0" });
    m.onCall("bash", { command: "x1" });
    assert.equal(m.shouldProtect("bash", 0.25), true);
    assert.equal(m.shouldProtect("bash", 0.5), false);

    const few = new RecoveryMeter();
    for (let i = 0; i < 4; i++) few.track([info(`b${i}`, "read", { path: `p${i}` })]);
    few.onCall("read", { path: "p0" });
    assert.equal(few.shouldProtect("read", 0.25), false);
  });
});

// ---------------------------------------------------------------------------
// policyOf / empty stats parity
// ---------------------------------------------------------------------------

describe("policyOf", () => {
  it("merges configured and session-protected tools", () => {
    const p = policyOf(sanitizeConfig({ neverElide: ["read"] }), ["bash"]);
    assert.equal(p.neverElide.has("read"), true);
    assert.equal(p.neverElide.has("bash"), true);
    assert.equal(p.keepTurns, 20);
  });
});

// ---------------------------------------------------------------------------
// DSH adapter contract (v1) — consumed by index.js
// ---------------------------------------------------------------------------

describe("DSH contract: STUB_MARKER and isStubbed", () => {
  it("recognises only text blocks that start with the marker", () => {
    assert.equal(STUB_MARKER, "[context-diet: result elided]");
    assert.equal(
      isStubbed([{ type: "text", text: `${STUB_MARKER} bash (9.0 KB, 3 lines)` }]),
      true,
    );
    assert.equal(isStubbed([{ type: "text", text: "ordinary output" }]), false);
    assert.equal(isStubbed([{ type: "image", data: "x" }]), false);
    assert.equal(isStubbed("a string"), false);
    assert.equal(isStubbed([]), false);
  });
});

describe("DSH contract: resolvePolicy", () => {
  it("defaults to the enabled, approximate policy", () => {
    const p = resolvePolicy(undefined, undefined);
    assert.equal(p.enabled, true);
    assert.equal(p.agePolicy, "approximate");
    assert.equal(p.coldTtlMinutes, 5);
    assert.equal(p.keepTurns, 20);
    assert.equal(p.minChars, 1500);
    assert.equal(p.maxPerPass, 8);
    assert.deepEqual(p.neverElide, []);
  });

  it("merges config then per-session overrides", () => {
    const p = resolvePolicy({ enabled: true, keepTurns: 5 }, { keepTurns: 2, agePolicy: "always" });
    assert.equal(p.enabled, true);
    assert.equal(p.keepTurns, 2);
    assert.equal(p.agePolicy, "always");
  });

  it("throws on an unusable keepTurns", () => {
    assert.throws(() => resolvePolicy({ keepTurns: "5" }), TypeError);
    assert.throws(() => resolvePolicy({ keepTurns: -1 }), TypeError);
  });
});

describe("DSH contract: planElisions", () => {
  const node = (over = {}) => ({
    seq: 0,
    turn: 0,
    chars: 9000,
    isError: false,
    plain: true,
    toolName: "tool",
    message: { content: [{ type: "text", text: "x".repeat(9000) }] },
    ...over,
  });
  const snapshot = (nodes, maxTurn = 3) => ({ now: 0, lastRequestTime: 0, maxTurn, nodes });
  const policy = (over = {}) =>
    resolvePolicy({ enabled: true, agePolicy: "always", keepTurns: 1, minChars: 10, maxPerPass: 4, ...over });

  it("plans a plain, old, large, non-error result as a marker stub", () => {
    const { plans } = planElisions(snapshot([node({ seq: 7 })]), policy());
    assert.equal(plans.length, 1);
    assert.equal(plans[0].seq, 7);
    assert.equal(plans[0].charsBefore, 9000);
    assert.equal(plans[0].content.length, 1);
    assert.equal(plans[0].content[0].type, "text");
    assert.equal(plans[0].content[0].text.startsWith(STUB_MARKER), true);
    assert.equal(plans[0].charsAfter, [...plans[0].content[0].text].length);
    assert.match(plans[0].content[0].text, /9\.0 KB/);
  });

  it("skips recent, small, error, protected, non-plain and already-stubbed nodes", () => {
    const { plans } = planElisions(
      snapshot([
        node({ seq: 0, turn: 3 }), // too recent (maxTurn 3 - keepTurns 1 = 2)
        node({ seq: 1, chars: 5 }), // too small
        node({ seq: 2, isError: true }),
        node({ seq: 3, toolName: "read" }), // neverElide
        node({ seq: 4, plain: false }),
        node({
          seq: 5,
          message: { content: [{ type: "text", text: `${STUB_MARKER} already` }] },
        }),
        node({ seq: 6 }), // the only eligible one
      ]),
      policy({ neverElide: ["read"] }),
    );
    assert.deepEqual(plans.map((p) => p.seq), [6]);
  });

  it("caps the plan list at twice maxPerPass", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node({ seq: i }));
    const { plans } = planElisions(snapshot(nodes), policy({ maxPerPass: 2 }));
    assert.equal(plans.length, 4);
  });
});

describe("DSH contract: parseCommand", () => {
  it("parses every documented subcommand", () => {
    assert.deepEqual(parseCommand(""), { kind: "status" });
    assert.deepEqual(parseCommand("status"), { kind: "status" });
    assert.deepEqual(parseCommand("on"), { kind: "on" });
    assert.deepEqual(parseCommand("off"), { kind: "off" });
    assert.deepEqual(parseCommand("now"), { kind: "now" });
    assert.deepEqual(parseCommand("show"), { kind: "show" });
    assert.deepEqual(parseCommand("args on"), { kind: "args", value: "on" });
    assert.deepEqual(parseCommand("keep 5"), { kind: "keep", turns: 5 });
    assert.deepEqual(parseCommand("ttl 30"), { kind: "ttl", minutes: 30 });
    assert.deepEqual(parseCommand("mode always"), { kind: "mode", mode: "always" });
    assert.deepEqual(parseCommand("compact off"), { kind: "compact", action: "off" });
    assert.deepEqual(parseCommand("compact now"), { kind: "compact", action: "now" });
  });

  it("reports invalid values with a usage message", () => {
    assert.equal(parseCommand("keep 0").kind, "invalid");
    assert.match(parseCommand("keep 0").message, /usage/);
    assert.equal(parseCommand("ttl x").kind, "invalid");
    assert.equal(parseCommand("mode sometimes").kind, "invalid");
    assert.equal(parseCommand("compact nope").kind, "invalid");
    assert.equal(parseCommand("bogus").kind, "invalid");
    assert.match(parseCommand("bogus").message, /usage/);
  });
});

describe("DSH contract: statusText", () => {
  it("renders policy, counters and the last pass", () => {
    const p = resolvePolicy({ enabled: true, keepTurns: 3 }, undefined);
    assert.equal(
      statusText({ policy: p, stats: { elided: 2, refetched: 1 } }),
      "context-diet: on mode=approximate keep=3 elided=2 refetched=1",
    );
    assert.match(
      statusText({
        policy: p,
        stats: { elided: 0, refetched: 0 },
        lastPass: { applied: 1, planned: 3 },
      }),
      /last=1\/3/,
    );
  });

  it("defaults counters and survives a missing policy", () => {
    assert.match(statusText({}), /context-diet: on/);
    assert.match(statusText({}), /elided=0 refetched=0/);
  });
});

