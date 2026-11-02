// @ts-check
/**
 * dsh-context-diet — pure strategy core.
 *
 * Platform-neutral: no DSH/Pi imports, no filesystem, no clock, no randomness.
 * The runtime adapter owns messages/state I/O; this module only decides and renders.
 *
 * Strategies implemented here:
 *  - default config + validation/clamping
 *  - Unicode code-point measurement of tool output
 *  - tool-result candidate selection (age, size, error, text-only, protection)
 *  - error-line / tail-line previews
 *  - deterministic elision stubs
 *  - stable stringify / call signatures
 *  - write/edit argument candidates and placeholders
 *  - recovery meter (re-fetch detection + tool protection)
 *  - cold / always / forced decision
 *  - savings formatting / status line
 *
 * All functions are pure. `applyElision` returns a new message array and never
 * mutates its input.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** @typedef {"cold" | "always"} DietMode */

/**
 * @typedef {object} DietConfig
 * @property {boolean} enabled
 * @property {DietMode} mode
 * @property {number} keepTurns
 * @property {number} minChars
 * @property {number} cacheTtlMinutes
 * @property {boolean} keepErrors
 * @property {readonly string[]} neverElide
 * @property {boolean} showStatus
 * @property {number} stubTailLines
 * @property {number} stubErrorLines
 * @property {boolean} elideArgs
 * @property {boolean} autoProtect
 * @property {number} recoveryThreshold
 * @property {boolean} warmArbitration
 * @property {number} expectedTurns
 * @property {number} stopWarmingShare
 * @property {boolean} compact
 * @property {number} compactAboveTokens
 */

/** @type {Readonly<DietConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
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
  warmArbitration: true,
  expectedTurns: 30,
  stopWarmingShare: 0.2,
  compact: false,
  compactAboveTokens: 150000,
});

/** @type {number} */
export const DEFAULT_CHARS_PER_TOKEN = 3;

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
const clampInt = (value, min, max, fallback) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

/**
 * Validate a hand-edited config: keep valid values, default the rest, clamp numbers.
 * @param {unknown} raw
 * @returns {DietConfig}
 */
export function sanitizeConfig(raw) {
  /** @type {Record<string, unknown>} */
  const r =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
  const d = DEFAULT_CONFIG;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    mode: r.mode === "cold" || r.mode === "always" ? r.mode : d.mode,
    keepTurns: clampInt(r.keepTurns, 1, 500, d.keepTurns),
    minChars: clampInt(r.minChars, 200, 1_000_000, d.minChars),
    cacheTtlMinutes: clampInt(r.cacheTtlMinutes, 1, 1440, d.cacheTtlMinutes),
    keepErrors: typeof r.keepErrors === "boolean" ? r.keepErrors : d.keepErrors,
    neverElide: Array.isArray(r.neverElide)
      ? [
          ...new Set(
            r.neverElide
              .filter((x) => typeof x === "string")
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ].slice(0, 50)
      : [],
    showStatus: typeof r.showStatus === "boolean" ? r.showStatus : d.showStatus,
    stubTailLines: clampInt(r.stubTailLines, 0, 10, d.stubTailLines),
    stubErrorLines: clampInt(r.stubErrorLines, 0, 10, d.stubErrorLines),
    elideArgs: typeof r.elideArgs === "boolean" ? r.elideArgs : d.elideArgs,
    autoProtect: typeof r.autoProtect === "boolean" ? r.autoProtect : d.autoProtect,
    recoveryThreshold:
      typeof r.recoveryThreshold === "number" && Number.isFinite(r.recoveryThreshold)
        ? Math.min(1, Math.max(0.05, r.recoveryThreshold))
        : d.recoveryThreshold,
    warmArbitration:
      typeof r.warmArbitration === "boolean" ? r.warmArbitration : d.warmArbitration,
    expectedTurns: clampInt(r.expectedTurns, 1, 500, d.expectedTurns),
    stopWarmingShare:
      typeof r.stopWarmingShare === "number" && Number.isFinite(r.stopWarmingShare)
        ? Math.min(0.9, Math.max(0.05, r.stopWarmingShare))
        : d.stopWarmingShare,
    compact: typeof r.compact === "boolean" ? r.compact : d.compact,
    compactAboveTokens: clampInt(
      r.compactAboveTokens,
      20_000,
      2_000_000,
      d.compactAboveTokens,
    ),
  };
}

// ---------------------------------------------------------------------------
// Unicode-aware measurement
// ---------------------------------------------------------------------------

/**
 * Count Unicode code points (not UTF-16 code units).
 * @param {string} str
 * @returns {number}
 */
export function codePointLength(str) {
  let n = 0;
  for (const _ of String(str)) n++;
  return n;
}

/**
 * Count lines; one trailing newline does not add a line.
 * @param {string} str
 * @returns {number}
 */
export function lineCount(str) {
  if (str === "") return 0;
  const lines = str.split("\n");
  return lines.length - (str.endsWith("\n") ? 1 : 0);
}

/**
 * @param {unknown} content
 * @returns {Array<Record<string, any>>}
 */
const partsOf = (content) =>
  Array.isArray(content) ? /** @type {Array<Record<string, any>>} */ (content) : [];

/**
 * @param {unknown} content
 * @returns {{ chars: number, lines: number, textOnly: boolean }}
 */
export function measure(content) {
  if (typeof content === "string") {
    return { chars: codePointLength(content), lines: lineCount(content), textOnly: true };
  }
  let chars = 0;
  let lines = 0;
  let textOnly = true;
  for (const p of partsOf(content)) {
    if (p?.type === "text" && typeof p.text === "string") {
      chars += codePointLength(p.text);
      lines += lineCount(p.text);
    } else {
      textOnly = false;
    }
  }
  return { chars, lines, textOnly };
}

/**
 * Approximate characters in a message list; strings by code point, other content by JSON.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @returns {number}
 */
export function charsOfMessages(messages) {
  let n = 0;
  for (const m of messages) {
    const c = m?.content;
    n +=
      typeof c === "string"
        ? codePointLength(c)
        : c === undefined || c === null
          ? 0
          : codePointLength(JSON.stringify(c));
  }
  return n;
}

// ---------------------------------------------------------------------------
// Calls and message metadata
// ---------------------------------------------------------------------------

/**
 * toolCallId -> the assistant call that produced it.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @returns {Map<string, { name: string, args: Record<string, unknown> }>}
 */
export function indexCalls(messages) {
  /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
  const calls = new Map();
  for (const m of messages) {
    if (m?.role !== "assistant") continue;
    for (const p of partsOf(m.content)) {
      if (p?.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string") {
        calls.set(p.id, { name: p.name, args: p.arguments ?? {} });
      }
    }
  }
  return calls;
}

/**
 * @param {string} str
 * @param {number} n
 * @returns {string}
 */
const clip = (str, n) => {
  const one = str.replace(/\s+/g, " ").trim();
  const cps = [...one];
  return cps.length > n ? cps.slice(0, n - 1).join("") + "…" : one;
};

/**
 * Short label for what a tool call did.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {string}
 */
export function describeCall(name, args) {
  /** @param {...string} keys */
  const first = (...keys) => {
    for (const k of keys) {
      if (typeof args[k] === "string" && args[k]) return /** @type {string} */ (args[k]);
    }
    return "";
  };
  const label =
    name === "bash"
      ? first("command")
      : first("path", "file_path", "pattern", "query", "command", "url");
  return label ? clip(label, 80) : "";
}

/**
 * Signed thinking blocks must be sent back byte-identical.
 * @param {Record<string, any>} message
 * @returns {boolean}
 */
export function hasThinking(message) {
  return partsOf(message?.content).some(
    (p) => p?.type === "thinking" || p?.type === "redacted_thinking",
  );
}

/**
 * For every message, how many assistant messages come after it.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @returns {number[]}
 */
export function assistantTurnsAfter(messages) {
  /** @type {number[]} */
  const ages = new Array(messages.length).fill(0);
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    ages[i] = seen;
    if (messages[i]?.role === "assistant") seen++;
  }
  return ages;
}

// ---------------------------------------------------------------------------
// Preview and deterministic stub
// ---------------------------------------------------------------------------

/** @typedef {{ tail: string[], errors: string[] }} Preview */

const ERROR_LINE = /(error|fail|exception|panic|fatal|traceback|assertion)/i;
const ALL_CLEAR = /\b0 (errors?|failed|failures?|failing)\b/i;
const PREVIEW_LINE_CHARS = 160;

/**
 * @param {string} line
 * @returns {string}
 */
const clipLine = (line) => {
  const cps = [...line];
  return cps.length > PREVIEW_LINE_CHARS
    ? cps.slice(0, PREVIEW_LINE_CHARS - 1).join("") + "…"
    : line;
};

/**
 * Last lines and error lines worth keeping from a long output.
 * Deterministic: derived only from the input text.
 * @param {unknown} content
 * @param {number} tailLines
 * @param {number} errorLines
 * @returns {Preview}
 */
export function previewOf(content, tailLines, errorLines) {
  if (tailLines <= 0 && errorLines <= 0) return { tail: [], errors: [] };
  const text =
    typeof content === "string"
      ? content
      : partsOf(content)
          .map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
          .join("\n");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const tail =
    tailLines > 0 ? lines.slice(-tailLines).map(clipLine) : [];
  const errors =
    errorLines > 0
      ? lines
          .filter(
            (line, i) =>
              ERROR_LINE.test(line) &&
              !ALL_CLEAR.test(line) &&
              !(tailLines > 0 && i >= lines.length - tailLines),
          )
          .slice(-errorLines)
          .map(clipLine)
      : [];
  return { tail, errors };
}

/**
 * Deterministic one-paragraph stub replacing an elided tool output.
 * @param {string} name
 * @param {string} label
 * @param {number} chars
 * @param {number} lines
 * @param {Preview} [preview]
 * @returns {string}
 */
export function stubText(name, label, chars, lines, preview) {
  const what = label ? `${name} ${label}` : name;
  let out = `[dsh-context-diet: the output of ${what} (${formatSize(chars)}, ${lines} lines) was elided from the context to save tokens. Re-run it if you need it again.`;
  if (preview?.errors.length) {
    out += `\nerror lines:\n${preview.errors.map((line) => `  ${line}`).join("\n")}`;
  }
  if (preview?.tail.length) {
    out += `\nlast lines:\n${preview.tail.map((line) => `  ${line}`).join("\n")}`;
  }
  return out + "]";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * @param {number} chars
 * @returns {string}
 */
export function formatSize(chars) {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)} KB`;
  return `${chars} B`;
}

/**
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * @param {number} chars
 * @param {number} [charsPerToken]
 * @returns {number}
 */
export const estimateTokens = (chars, charsPerToken = DEFAULT_CHARS_PER_TOKEN) =>
  Math.round(chars / charsPerToken);

/** @typedef {{ requests: number, cumulativeChars: number, lastChars: number, lastCount: number, lastArgCount: number, coldStarts: number }} Stats */

/** @returns {Stats} */
export function emptyStats() {
  return {
    requests: 0,
    cumulativeChars: 0,
    lastChars: 0,
    lastCount: 0,
    lastArgCount: 0,
    coldStarts: 0,
  };
}

/** @typedef {{ recovered: number, elided: number, recoveredChars: number, protectedTools: string[] }} RecoverySummary */

/**
 * Human-readable status line.
 * @param {DietConfig} config
 * @param {Stats} stats
 * @param {RecoverySummary} [recovery]
 * @param {{ charsPerToken: number, samples: number, measured: boolean }} [extra]
 * @returns {string}
 */
export function statusLine(config, stats, recovery, extra) {
  const cpt = extra?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const head = `dsh-context-diet: ${config.enabled ? "on" : "off"} · mode ${config.mode} · keep last ${config.keepTurns} turns · cache ttl ${config.cacheTtlMinutes} min · min ${formatSize(config.minChars)} · write/edit args ${config.elideArgs ? "elided" : "kept"}`;
  const args = stats.lastArgCount > 0 ? ` + ${stats.lastArgCount} write/edit arguments` : "";
  const body = `this session: ${stats.lastCount} results${args} elided (~${formatTokens(estimateTokens(stats.lastChars, cpt))} tokens kept out of every request), ~${formatTokens(estimateTokens(stats.cumulativeChars, cpt))} tokens saved over ${stats.requests} requests · ${stats.coldStarts} cold start${stats.coldStarts === 1 ? "" : "s"}`;
  const lines = [head, body];
  if (extra) {
    const calibrated = extra.measured
      ? `${extra.charsPerToken.toFixed(2)} chars/token measured from ${extra.samples} requests`
      : extra.samples < 6
        ? `${extra.charsPerToken.toFixed(2)} chars/token assumed (calibrating: ${extra.samples} of 6 requests)`
        : `${extra.charsPerToken.toFixed(2)} chars/token assumed (the provider's usage did not vary with context size)`;
    const warm = config.warmArbitration
      ? "warming: arbitrated"
      : "warming: not arbitrated";
    const compaction = config.compact
      ? `compaction: on above ${formatTokens(config.compactAboveTokens)} tokens`
      : "compaction: off (opt-in)";
    lines.push(`${calibrated} · ${warm} · ${compaction}`);
  }
  if (!recovery) return lines.join("\n");
  const rate = recovery.elided > 0 ? Math.round((100 * recovery.recovered) / recovery.elided) : 0;
  const guard =
    recovery.protectedTools.length > 0
      ? ` · protected: ${recovery.protectedTools.join(", ")}`
      : "";
  lines.push(
    `recovery: ${recovery.recovered} of ${recovery.elided} elided results re-fetched (${rate}%, ~${formatTokens(estimateTokens(recovery.recoveredChars, cpt))} tokens to re-fetch, once)${guard}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Policy and candidate selection
// ---------------------------------------------------------------------------

/** @typedef {{ keepTurns: number, minChars: number, keepErrors: boolean, neverElide: ReadonlySet<string> }} Policy */

/**
 * @param {DietConfig} config
 * @param {Iterable<string>} [protectedTools]
 * @returns {Policy}
 */
export function policyOf(config, protectedTools = []) {
  return {
    keepTurns: config.keepTurns,
    minChars: config.minChars,
    keepErrors: config.keepErrors,
    neverElide: new Set([...config.neverElide, ...protectedTools]),
  };
}

/**
 * Tool results that may be elided: old enough, big enough, plain text, not an
 * error, not protected and not already elided.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @param {Policy} policy
 * @param {ReadonlySet<string>} already
 * @returns {string[]}
 */
export function eligible(messages, policy, already) {
  const ages = assistantTurnsAfter(messages);
  /** @type {string[]} */
  const ids = [];
  messages.forEach((m, i) => {
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") return;
    if (already.has(m.toolCallId) || ages[i] <= policy.keepTurns) return;
    if (m.isError && policy.keepErrors) return;
    if (m.toolName && policy.neverElide.has(m.toolName)) return;
    const size = measure(m.content);
    if (!size.textOnly || size.chars < policy.minChars) return;
    ids.push(m.toolCallId);
  });
  return ids;
}

/**
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @returns {number | undefined}
 */
export function lastAssistantTimestamp(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && typeof m.timestamp === "number") return m.timestamp;
  }
  return undefined;
}

/**
 * The prompt cache is cold when the last assistant message is older than its TTL.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @param {number} now
 * @param {number} ttlMs
 * @returns {boolean}
 */
export function isCold(messages, now, ttlMs) {
  const last = lastAssistantTimestamp(messages);
  return last !== undefined && now - last > ttlMs;
}

/** @typedef {{ elided: ReadonlySet<string>, elidedArgs: ReadonlySet<string>, protectedTools: ReadonlySet<string> }} DietState */
/** @typedef {{ cold?: boolean, force?: boolean }} Gate */
/** @typedef {{ ids: string[], argIds: string[], cold: boolean, reason: "disabled" | "warm" | "forced" | "cold" | "always" }} Decision */

/**
 * Decide what to elide for this request. The adapter supplies coldness and the
 * one-shot force flag; the core never reads a clock.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @param {DietState | undefined} state
 * @param {DietConfig} config
 * @param {Gate} [gate]
 * @returns {Decision}
 */
export function decide(messages, state, config, gate = {}) {
  const elided = state?.elided ?? new Set();
  const elidedArgs = state?.elidedArgs ?? new Set();
  const protectedTools = state?.protectedTools ?? new Set();
  const cold = Boolean(gate.cold);
  const forced = Boolean(gate.force);
  if (!config.enabled) {
    return { ids: [], argIds: [], cold, reason: "disabled" };
  }
  if (!(forced || cold || config.mode === "always")) {
    return { ids: [], argIds: [], cold, reason: "warm" };
  }
  const policy = policyOf(config, protectedTools);
  return {
    ids: eligible(messages, policy, elided),
    argIds: config.elideArgs ? eligibleArgs(messages, policy, elidedArgs) : [],
    cold,
    reason: forced ? "forced" : cold ? "cold" : "always",
  };
}

// ---------------------------------------------------------------------------
// write / edit argument candidates and placeholders
// ---------------------------------------------------------------------------

/** @type {ReadonlySet<string>} */
export const ARG_TOOLS = new Set(["write", "edit"]);

/**
 * @param {unknown} value
 * @returns {number}
 */
const strLen = (value) => (typeof value === "string" ? codePointLength(value) : 0);

/**
 * How many characters of file content a write/edit call carries.
 * @param {string} name
 * @param {Record<string, any> | undefined} args
 * @returns {number}
 */
export function argChars(name, args) {
  if (!args) return 0;
  if (name === "write") return strLen(args.content);
  let n = strLen(args.oldText) + strLen(args.newText);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      n += strLen(edit?.oldText) + strLen(edit?.newText);
    }
  }
  return n;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
const elidedArg = (value, path) => {
  const text = typeof value === "string" ? value : "";
  return `[dsh-context-diet: ${lineCount(text)} lines (${formatSize(codePointLength(text))}) of ${path || "the file"} elided; the file on disk is authoritative]`;
};

/**
 * The same call with its bulky file content replaced by a short placeholder.
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
export function elideArguments(name, args) {
  const path =
    typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : "";
  if (name === "write") {
    return typeof args.content === "string"
      ? { ...args, content: elidedArg(args.content, path) }
      : args;
  }
  /** @type {Record<string, any>} */
  const out = { ...args };
  if (typeof out.oldText === "string") out.oldText = elidedArg(out.oldText, path);
  if (typeof out.newText === "string") out.newText = elidedArg(out.newText, path);
  if (Array.isArray(args.edits)) {
    out.edits = args.edits.map((edit) =>
      edit && typeof edit === "object"
        ? {
            ...edit,
            ...(typeof edit.oldText === "string"
              ? { oldText: elidedArg(edit.oldText, path) }
              : {}),
            ...(typeof edit.newText === "string"
              ? { newText: elidedArg(edit.newText, path) }
              : {}),
          }
        : edit,
    );
  }
  return out;
}

/**
 * Tool-call ids whose write/edit arguments may be elided: old enough, big
 * enough, answered successfully, not signed-thinking and not protected.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @param {Policy} policy
 * @param {ReadonlySet<string>} already
 * @returns {string[]}
 */
export function eligibleArgs(messages, policy, already) {
  const ages = assistantTurnsAfter(messages);
  /** @type {Set<string>} */
  const failed = new Set();
  /** @type {Set<string>} */
  const answered = new Set();
  for (const m of messages) {
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    answered.add(m.toolCallId);
    if (m.isError) failed.add(m.toolCallId);
  }
  /** @type {string[]} */
  const ids = [];
  messages.forEach((m, i) => {
    if (m?.role !== "assistant" || ages[i] <= policy.keepTurns) return;
    if (hasThinking(m)) return;
    for (const p of partsOf(m.content)) {
      if (p?.type !== "toolCall" || typeof p.id !== "string" || typeof p.name !== "string") {
        continue;
      }
      if (!ARG_TOOLS.has(p.name) || policy.neverElide.has(p.name) || already.has(p.id)) {
        continue;
      }
      if (!answered.has(p.id) || failed.has(p.id)) continue;
      if (argChars(p.name, p.arguments) < policy.minChars) continue;
      ids.push(p.id);
    }
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Stable signatures
// ---------------------------------------------------------------------------

/**
 * JSON with object keys sorted, so the same call always gives the same text.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * @param {string} name
 * @param {unknown} args
 * @returns {string}
 */
export const callSignature = (name, args) => `${name}:${stableStringify(args ?? {})}`;

/** @typedef {{ id: string, tool: string, sig: string, chars: number }} ElidedInfo */

// ---------------------------------------------------------------------------
// Deterministic transformation
// ---------------------------------------------------------------------------

/**
 * Replace selected results (and write/edit arguments) with stubs.
 * Originals are never mutated; untouched messages share identity.
 * @param {ReadonlyArray<Record<string, any>>} messages
 * @param {DietState | undefined} state
 * @param {{ preview?: { tail: number, errors: number } }} [opts]
 * @returns {{ messages: ReadonlyArray<Record<string, any>>, count: number, argCount: number, savedChars: number, infos: ElidedInfo[] }}
 */
export function applyElision(messages, state, opts = {}) {
  const elided = state?.elided ?? new Set();
  const argIds = state?.elidedArgs ?? new Set();
  if (elided.size === 0 && argIds.size === 0) {
    return { messages, count: 0, argCount: 0, savedChars: 0, infos: [] };
  }
  const calls = indexCalls(messages);
  let count = 0;
  let argCount = 0;
  let savedChars = 0;
  /** @type {ElidedInfo[]} */
  const infos = [];
  const out = messages.map((m) => {
    if (m?.role === "toolResult" && typeof m.toolCallId === "string" && elided.has(m.toolCallId)) {
      const size = measure(m.content);
      if (!size.textOnly) return m;
      const call = calls.get(m.toolCallId);
      const tool = m.toolName ?? call?.name ?? "tool";
      const preview = opts.preview
        ? previewOf(m.content, opts.preview.tail, opts.preview.errors)
        : undefined;
      const text = stubText(
        tool,
        call ? describeCall(call.name, call.args) : "",
        size.chars,
        size.lines,
        preview,
      );
      count++;
      savedChars += Math.max(0, size.chars - codePointLength(text));
      if (call) {
        infos.push({
          id: m.toolCallId,
          tool,
          sig: callSignature(call.name, call.args),
          chars: size.chars,
        });
      }
      return { ...m, content: [{ type: "text", text }] };
    }
    if (m?.role === "assistant" && argIds.size > 0 && Array.isArray(m.content)) {
      if (hasThinking(m)) return m;
      let changed = false;
      const content = m.content.map((p) => {
        if (
          p?.type !== "toolCall" ||
          typeof p.id !== "string" ||
          typeof p.name !== "string" ||
          !argIds.has(p.id) ||
          !p.arguments
        ) {
          return p;
        }
        const before = codePointLength(JSON.stringify(p.arguments));
        const next = elideArguments(p.name, p.arguments);
        if (next === p.arguments) return p;
        changed = true;
        argCount++;
        savedChars += Math.max(0, before - codePointLength(JSON.stringify(next)));
        return { ...p, arguments: next };
      });
      return changed ? { ...m, content } : m;
    }
    return m;
  });
  if (count + argCount === 0) {
    return { messages, count: 0, argCount: 0, savedChars: 0, infos: [] };
  }
  return { messages: out, count, argCount, savedChars, infos };
}

// ---------------------------------------------------------------------------
// Recovery meter
// ---------------------------------------------------------------------------

/**
 * Remembers what was elided and notices when the agent re-issues the identical
 * call. Pure logic: the adapter owns storage/lifetime.
 */
export class RecoveryMeter {
  constructor() {
    /** @type {Map<string, ElidedInfo[]>} */
    this.bySig = new Map();
    /** @type {Set<string>} */
    this.tracked = new Set();
    /** @type {Set<string>} */
    this.counted = new Set();
    /** @type {Map<string, { elided: number, recovered: number }>} */
    this.perTool = new Map();
    this.recovered = 0;
    this.recoveredChars = 0;
  }

  /**
   * Idempotent: call it with everything currently elided on each request.
   * @param {ReadonlyArray<ElidedInfo>} infos
   * @returns {void}
   */
  track(infos) {
    for (const info of infos) {
      if (this.tracked.has(info.id)) continue;
      this.tracked.add(info.id);
      const bucket = this.bySig.get(info.sig);
      if (bucket) bucket.push(info);
      else this.bySig.set(info.sig, [info]);
      const tool = this.perTool.get(info.tool) ?? { elided: 0, recovered: 0 };
      tool.elided++;
      this.perTool.set(info.tool, tool);
    }
  }

  /**
   * A tool is about to run: is it the identical call to something elided?
   * @param {string} tool
   * @param {unknown} args
   * @returns {ElidedInfo | undefined}
   */
  onCall(tool, args) {
    const matches = this.bySig.get(callSignature(tool, args));
    const hit = matches?.find((m) => !this.counted.has(m.id));
    if (!hit) return undefined;
    for (const m of matches) this.counted.add(m.id);
    this.recovered++;
    this.recoveredChars += hit.chars;
    const toolStats = this.perTool.get(hit.tool);
    if (toolStats) toolStats.recovered++;
    return hit;
  }

  /** @returns {number} */
  elided() {
    return this.tracked.size;
  }

  /**
   * @param {string} tool
   * @param {number} threshold
   * @param {number} [minSample]
   * @returns {boolean}
   */
  shouldProtect(tool, threshold, minSample = 5) {
    const stats = this.perTool.get(tool);
    return (
      !!stats &&
      stats.elided >= minSample &&
      stats.recovered / stats.elided > threshold
    );
  }
}

// ---------------------------------------------------------------------------
// DSH adapter contract (v1)
// ---------------------------------------------------------------------------
//
// The DSH host half in `index.js` consumes a small, DSH-shaped contract:
//   STUB_MARKER, isStubbed(content), resolvePolicy(config, overrides),
//   planElisions(snapshot, policy), parseCommand(rawInput), statusText(state)
//
// It is implemented on top of the platform-neutral pieces above so both
// surfaces share one strategy: the Pi-style API stays pure and unchanged,
// while the DSH adapter gets a durable-surface snapshot planner.

/** Marker that prefixes every durable DSH stub; `isStubbed` relies on it. */
export const STUB_MARKER = "[context-diet: result elided]";

/**
 * Is this content already an elision stub?
 * @param {unknown} content
 * @returns {boolean}
 */
export function isStubbed(content) {
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith(STUB_MARKER),
    )
  );
}

/**
 * DSH policy defaults. Enabled by default; `agePolicy` is an
 * approximation because DSH has no provider cache-cold signal.
 * @type {Readonly<{ enabled: boolean, agePolicy: "off" | "approximate" | "always", coldTtlMinutes: number, keepTurns: number, minChars: number, stubTailLines: number, stubErrorLines: number, maxPerPass: number, neverElide: readonly string[] }>}
 */
export const DSH_DEFAULTS = Object.freeze({
  enabled: true,
  agePolicy: "approximate",
  coldTtlMinutes: 5,
  keepTurns: 20,
  minChars: 1500,
  stubTailLines: 3,
  stubErrorLines: 3,
  maxPerPass: 8,
  neverElide: [],
});

/**
 * Resolve the live plugin config plus per-session command overrides into one
 * policy. `keepTurns` is the only field the adapter cannot guess around, so a
 * bad value throws; everything else falls back to `DSH_DEFAULTS`.
 * @param {Record<string, unknown> | undefined} config
 * @param {Record<string, unknown> | undefined} overrides
 * @returns {{ enabled: boolean, agePolicy: string, coldTtlMinutes: number, keepTurns: number, minChars: number, stubTailLines: number, stubErrorLines: number, maxPerPass: number, neverElide: string[] }}
 */
export function resolvePolicy(config, overrides) {
  const policy = {
    ...DSH_DEFAULTS,
    ...(config ?? {}),
    ...(overrides ?? {}),
  };
  if (typeof policy.keepTurns !== "number" || policy.keepTurns < 0) {
    throw new TypeError("keepTurns");
  }
  if (!Array.isArray(policy.neverElide)) policy.neverElide = [];
  if (typeof policy.minChars !== "number" || !Number.isFinite(policy.minChars)) {
    policy.minChars = DSH_DEFAULTS.minChars;
  }
  if (
    typeof policy.maxPerPass !== "number" ||
    !Number.isFinite(policy.maxPerPass) ||
    policy.maxPerPass < 0
  ) {
    policy.maxPerPass = DSH_DEFAULTS.maxPerPass;
  }
  if (
    typeof policy.stubTailLines !== "number" ||
    !Number.isFinite(policy.stubTailLines)
  ) {
    policy.stubTailLines = DSH_DEFAULTS.stubTailLines;
  }
  if (
    typeof policy.stubErrorLines !== "number" ||
    !Number.isFinite(policy.stubErrorLines)
  ) {
    policy.stubErrorLines = DSH_DEFAULTS.stubErrorLines;
  }
  return policy;
}

/**
 * Deterministic DSH stub: starts with `STUB_MARKER`, names the tool, and keeps
 * the configured tail/error preview lines (code-point safe).
 * @param {{ toolName?: string, message?: { content?: unknown } }} node
 * @param {{ stubTailLines: number, stubErrorLines: number }} policy
 * @returns {string}
 */
function dshStubText(node, policy) {
  const content = node?.message?.content;
  const size = measure(content);
  const preview = previewOf(content, policy.stubTailLines, policy.stubErrorLines);
  const tool = typeof node?.toolName === "string" && node.toolName ? node.toolName : "tool";
  let text =
    `${STUB_MARKER} ${tool} (${formatSize(size.chars)}, ${size.lines} lines) was elided from the ` +
    `model-visible context; the original result remains in the session log.`;
  if (preview.errors.length) {
    text += `\nerror lines:\n${preview.errors.map((line) => `  ${line}`).join("\n")}`;
  }
  if (preview.tail.length) {
    text += `\nlast lines:\n${preview.tail.map((line) => `  ${line}`).join("\n")}`;
  }
  return text;
}

/** @typedef {{ now?: number, lastRequestTime?: number, maxTurn?: number, nodes: ReadonlyArray<{ seq: number, turn: number, chars: number, isError: boolean, plain: boolean, replaced?: boolean, toolName?: string, message?: { content?: unknown } }> }} Snapshot */

/**
 * Plan 1:1 durable `tool/result` replacements for one DSH session snapshot.
 * The adapter applies at most `policy.maxPerPass` plans and owns validation.
 * @param {Snapshot} snapshot
 * @param {ReturnType<typeof resolvePolicy>} policy
 * @returns {{ plans: Array<{ seq: number, charsBefore: number, charsAfter: number, content: Array<{ type: "text", text: string }> }> }}
 */
export function planElisions(snapshot, policy) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const maxTurn = typeof snapshot?.maxTurn === "number" ? snapshot.maxTurn : 0;
  const neverElide = Array.isArray(policy?.neverElide) ? policy.neverElide : [];
  const keepTurns = typeof policy?.keepTurns === "number" ? policy.keepTurns : 0;
  const minChars = typeof policy?.minChars === "number" ? policy.minChars : 0;
  const maxPerPass =
    typeof policy?.maxPerPass === "number" && Number.isFinite(policy.maxPerPass)
      ? Math.max(0, policy.maxPerPass)
      : 0;
  const cap = maxPerPass * 2;
  /** @type {Array<{ seq: number, charsBefore: number, charsAfter: number, content: Array<{ type: "text", text: string }> }>} */
  const plans = [];
  for (const node of nodes) {
    if (!node || node.replaced === true || node.plain !== true || node.isError === true) continue;
    const chars = typeof node.chars === "number" ? node.chars : 0;
    if (chars < minChars) continue;
    const turn = typeof node.turn === "number" ? node.turn : 0;
    if (turn > maxTurn - keepTurns) continue;
    if (typeof node.toolName === "string" && neverElide.includes(node.toolName)) continue;
    const content =
      node.message !== undefined && Array.isArray(node.message.content)
        ? node.message.content
        : [];
    if (isStubbed(content)) continue;
    const stub = dshStubText(node, {
      stubTailLines:
        typeof policy?.stubTailLines === "number" ? policy.stubTailLines : DSH_DEFAULTS.stubTailLines,
      stubErrorLines:
        typeof policy?.stubErrorLines === "number"
          ? policy.stubErrorLines
          : DSH_DEFAULTS.stubErrorLines,
    });
    // Same invariant as the native tool-result pruner: a replacement must be
    // strictly smaller than what it shadows, or the "diet" grows the prompt.
    const stubChars = codePointLength(stub);
    if (stubChars >= chars) continue;
    plans.push({
      seq: node.seq,
      charsBefore: chars,
      charsAfter: stubChars,
      content: [{ type: "text", text: stub }],
    });
    if (plans.length >= cap) break;
  }
  return { plans };
}

/** @typedef {{ kind: "status" } | { kind: "on" } | { kind: "off" } | { kind: "now" } | { kind: "show" } | { kind: "args", value?: string } | { kind: "compact", action: "on" | "off" | "now" } | { kind: "keep", turns: number } | { kind: "ttl", minutes: number } | { kind: "mode", mode: "off" | "approximate" | "always" } | { kind: "invalid", message: string }} DshCommand */

/**
 * Parse the human `/context-diet ...` argument text for the DSH adapter.
 * @param {unknown} rawInput
 * @returns {DshCommand}
 */
export function parseCommand(rawInput) {
  const parts = String(rawInput ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const head = parts[0] === undefined ? "" : parts[0];
  const value = parts[1];
  if (head === "" || head === "status") return { kind: "status" };
  if (head === "on" || head === "off") return { kind: head };
  if (head === "now") return { kind: "now" };
  if (head === "show") return { kind: "show" };
  if (head === "args") return { kind: "args", value };
  if (head === "compact") {
    if (value === "on" || value === "off") return { kind: "compact", action: value };
    if (value === "now") return { kind: "compact", action: "now" };
    return {
      kind: "invalid",
      message: "usage: /context-diet compact <on|off|now>",
    };
  }
  if (head === "keep") {
    const turns = Number(value);
    return Number.isInteger(turns) && turns > 0
      ? { kind: "keep", turns }
      : { kind: "invalid", message: "usage: /context-diet keep <turns>" };
  }
  if (head === "ttl") {
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes > 0
      ? { kind: "ttl", minutes }
      : { kind: "invalid", message: "usage: /context-diet ttl <minutes>" };
  }
  if (head === "mode") {
    return value === "off" || value === "approximate" || value === "always"
      ? { kind: "mode", mode: value }
      : {
          kind: "invalid",
          message: "usage: /context-diet mode <off|approximate|always>",
        };
  }
  return { kind: "invalid", message: "usage: unknown subcommand" };
}

/**
 * Status/show text for the DSH adapter.
 * @param {{ policy?: Record<string, any>, overrides?: Record<string, any>, stats?: { elided?: number, refetched?: number }, lastPass?: { applied?: number, planned?: number } | null, detailed?: boolean }} state
 * @returns {string}
 */
export function statusText(state) {
  const policy = state?.policy ?? DSH_DEFAULTS;
  const stats = state?.stats ?? { elided: 0, refetched: 0 };
  const elided = typeof stats.elided === "number" ? stats.elided : 0;
  const refetched = typeof stats.refetched === "number" ? stats.refetched : 0;
  const pass =
    state?.lastPass !== undefined && state.lastPass !== null
      ? ` last=${state.lastPass.applied ?? 0}/${state.lastPass.planned ?? 0}`
      : "";
  return (
    "context-diet: " +
    (policy.enabled ? "on" : "off") +
    " mode=" +
    (policy.agePolicy ?? DSH_DEFAULTS.agePolicy) +
    " keep=" +
    (policy.keepTurns ?? DSH_DEFAULTS.keepTurns) +
    " elided=" +
    elided +
    " refetched=" +
    refetched +
    pass
  );
}
