// @ts-check
/**
 * dsh-context-diet — pure strategy core.
 *
 * This is the DSH port of the pure-function half of `pi-context-diet`
 * (`extensions/context-diet.ts`): config sanitising, measurement, candidate
 * selection, deterministic stubs, write/edit argument elision, the recovery
 * meter, calibration, the `show` lists, the command parser and the status
 * footer. Zero imports: no DSH, no Pi, no filesystem, no clock, no randomness.
 * Every function is deterministic, and `applyElision` never mutates its input.
 *
 * Why a verbatim port rather than a reimplementation: upstream's cost model
 * rests on exact details — the strict `>` in the cold check and in
 * `shouldProtect`, "one trailing newline is not a line", UTF-16 code-unit
 * lengths, the 1.5..8 chars/token clamp — so the thresholds below are copied
 * from that source, not re-derived.
 *
 * DSH port notes:
 *  - Upstream decides the elided set once per request and then replays it
 *    unchanged on every later request, so the prompt prefix stays byte-stable
 *    between cold starts. DSH has no per-request message rewrite: the frozen
 *    decision set is carried by the durable session surface (`tool/result`
 *    replacement) instead. The decision semantics below are unchanged; only
 *    the moment and the medium of application belong to the adapter.
 *  - The single product brand is `context-diet` (upstream: `pi-context-diet`):
 *    the status head, the stub and the argument placeholder all use it, and
 *    `STUB_MARKER` is that prefix so `isStubbed` recognises generated stubs.
 *  - No compaction and no cache-warming arbitration. Upstream's `compact*`,
 *    `warmArbitration`, `expectedTurns` and `stopWarmingShare` config fields,
 *    their helpers and their status-line segments are deliberately absent:
 *    DSH has no seam for them, so there is nothing here to half-implement.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** @typedef {'cold' | 'always'} DietMode */

/**
 * The settings DSH has semantics for. Field order follows upstream (minus the
 * compaction / warming fields this port does not implement).
 * @typedef {object} DietConfig
 * @property {boolean} enabled
 * @property {DietMode} mode
 * @property {number} keepTurns
 * @property {number} minChars
 * @property {number} cacheTtlMinutes
 * @property {boolean} keepErrors
 * @property {string[]} neverElide
 * @property {boolean} showStatus
 * @property {number} stubTailLines
 * @property {number} stubErrorLines
 * @property {boolean} elideArgs
 * @property {boolean} autoProtect
 * @property {number} recoveryThreshold
 */

/** @type {Readonly<DietConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  mode: 'cold',
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
})

/** Until calibrated from real usage: measured 2.0 to 3.0 on real sessions; 4 would under-count tool output. */
export const DEFAULT_CHARS_PER_TOKEN = 3

/** Prefix shared by every generated stub; `isStubbed` matches on it. */
export const STUB_MARKER = '[context-diet:'

/** Maximum width of the `describeCall` label (upstream hard-codes 80 in `clip`). */
export const MAX_LABEL_CHARS = 80

/** Maximum width of one preview line (upstream `PREVIEW_LINE_CHARS`). */
export const MAX_PREVIEW_LINE_CHARS = 160

/**
 * Clamp a config number to an integer range; anything non-finite falls back.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
const clampInt = (value, min, max, fallback) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback

/**
 * Validate a hand-edited config: keep valid values, default the rest, clamp
 * numbers. Idempotent, and `sanitizeConfig(undefined|null|5|"x"|[]|true)`
 * deep-equals `DEFAULT_CONFIG`.
 * @param {unknown} raw
 * @returns {DietConfig}
 */
export function sanitizeConfig(raw) {
  /** @type {Record<string, unknown>} */
  const r =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {}
  const d = DEFAULT_CONFIG
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    mode: r.mode === 'cold' || r.mode === 'always' ? r.mode : d.mode,
    keepTurns: clampInt(r.keepTurns, 1, 500, d.keepTurns),
    minChars: clampInt(r.minChars, 200, 1_000_000, d.minChars),
    cacheTtlMinutes: clampInt(r.cacheTtlMinutes, 1, 1440, d.cacheTtlMinutes),
    keepErrors: typeof r.keepErrors === 'boolean' ? r.keepErrors : d.keepErrors,
    neverElide: Array.isArray(r.neverElide)
      ? [
          ...new Set(
            r.neverElide
              .filter((x) => typeof x === 'string')
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ].slice(0, 50)
      : [],
    showStatus: typeof r.showStatus === 'boolean' ? r.showStatus : d.showStatus,
    stubTailLines: clampInt(r.stubTailLines, 0, 10, d.stubTailLines),
    stubErrorLines: clampInt(r.stubErrorLines, 0, 10, d.stubErrorLines),
    elideArgs: typeof r.elideArgs === 'boolean' ? r.elideArgs : d.elideArgs,
    autoProtect: typeof r.autoProtect === 'boolean' ? r.autoProtect : d.autoProtect,
    recoveryThreshold:
      typeof r.recoveryThreshold === 'number' && Number.isFinite(r.recoveryThreshold)
        ? Math.min(1, Math.max(0.05, r.recoveryThreshold))
        : d.recoveryThreshold,
  }
}

// ---------------------------------------------------------------------------
// Messages: what a tool result weighs, what it was, whether it is stale
// ---------------------------------------------------------------------------

/**
 * The few fields of a message this module reads; everything else is passed
 * through untouched.
 * @typedef {object} Message
 * @property {string} role
 * @property {number} [timestamp]
 * @property {unknown} [content]
 * @property {string} [toolCallId]
 * @property {string} [toolName]
 * @property {boolean} [isError]
 */

/**
 * @typedef {object} Part
 * @property {string} [type]
 * @property {string} [text]
 * @property {string} [id]
 * @property {string} [name]
 * @property {Record<string, unknown>} [arguments]
 */

/**
 * @param {unknown} content
 * @returns {Part[]}
 */
const partsOf = (content) => (Array.isArray(content) ? /** @type {Part[]} */ (content) : [])

/**
 * Count lines; one trailing newline does not add a line.
 * @param {string} s
 * @returns {number}
 */
const lineCount = (s) => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0))

/**
 * Size of a tool result's text, and whether it is text only (images are never
 * elided). Character counts are UTF-16 code units (`String.length`), as
 * upstream.
 * @param {unknown} content
 * @returns {{ chars: number, lines: number, textOnly: boolean }}
 */
export function measure(content) {
  if (typeof content === 'string') {
    return { chars: content.length, lines: lineCount(content), textOnly: true }
  }
  let chars = 0
  let lines = 0
  let textOnly = true
  for (const p of partsOf(content)) {
    if (p?.type === 'text' && typeof p.text === 'string') {
      chars += p.text.length
      lines += lineCount(p.text)
    } else {
      textOnly = false
    }
  }
  return { chars, lines, textOnly }
}

/**
 * `toolCallId` → the assistant call that produced it.
 * @param {ReadonlyArray<Message>} messages
 * @returns {Map<string, { name: string, args: Record<string, unknown> }>}
 */
export function indexCalls(messages) {
  /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
  const calls = new Map()
  for (const m of messages) {
    if (m?.role !== 'assistant') continue
    for (const p of partsOf(m.content)) {
      if (p?.type === 'toolCall' && typeof p.id === 'string' && typeof p.name === 'string') {
        calls.set(p.id, { name: p.name, args: p.arguments ?? {} })
      }
    }
  }
  return calls
}

/**
 * Collapse whitespace and cap the length; the ellipsis replaces the last
 * character, so the result is at most `n` code units.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
const clip = (s, n) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/**
 * A short label for what was run: the command, the path, the pattern.
 * @param {string} name
 * @param {Record<string, unknown> | undefined} args
 * @returns {string}
 */
export function describeCall(name, args) {
  const a = args ?? {}
  /**
   * @param {...string} keys
   * @returns {string}
   */
  const first = (...keys) => {
    for (const k of keys) if (typeof a[k] === 'string' && a[k]) return /** @type {string} */ (a[k])
    return ''
  }
  const label =
    name === 'bash'
      ? first('command')
      : first('path', 'file_path', 'pattern', 'query', 'command', 'url')
  return label ? clip(label, MAX_LABEL_CHARS) : ''
}

/**
 * @param {number} chars
 * @returns {string}
 */
export function formatSize(chars) {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)} KB`
  return `${chars} B`
}

/**
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * @param {number} chars
 * @param {number} [charsPerToken]
 * @returns {number}
 */
const estimateTokens = (chars, charsPerToken = DEFAULT_CHARS_PER_TOKEN) =>
  Math.round(chars / charsPerToken)

// ---------------------------------------------------------------------------
// Preview and deterministic stub
// ---------------------------------------------------------------------------

/**
 * What survives of an elided output: its last lines and the lines that mention
 * an error.
 * @typedef {object} Preview
 * @property {string[]} tail
 * @property {string[]} errors
 */

/** Lines worth keeping from a long output: errors, failures, exceptions (TypeError, AssertionError…). */
const ERROR_LINE = /(error|fail|exception|panic|fatal|traceback|assertion)/i
/** ...except summaries that say nothing went wrong ("0 failed", "0 errors"). */
const ALL_CLEAR = /\b0 (errors?|failed|failures?|failing)\b/i

/**
 * Deterministic: derived only from the original output, so the same result
 * always gives the same preview.
 * @param {unknown} content
 * @param {number} tailLines
 * @param {number} errorLines
 * @returns {Preview}
 */
export function previewOf(content, tailLines, errorLines) {
  if (tailLines <= 0 && errorLines <= 0) return { tail: [], errors: [] }
  const text =
    typeof content === 'string'
      ? content
      : partsOf(content)
          .map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
          .join('\n')
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  /**
   * @param {string} l
   * @returns {string}
   */
  const clipLine = (l) =>
    l.length > MAX_PREVIEW_LINE_CHARS ? l.slice(0, MAX_PREVIEW_LINE_CHARS - 1) + '…' : l
  const tail = tailLines > 0 ? lines.slice(-tailLines) : []
  const errors =
    errorLines > 0
      ? lines
          .filter(
            (l, i) =>
              ERROR_LINE.test(l) &&
              !ALL_CLEAR.test(l) &&
              !(tailLines > 0 && i >= lines.length - tailLines),
          )
          .slice(-errorLines)
          .map(clipLine)
      : []
  return { tail: tail.map(clipLine), errors }
}

/**
 * Deterministic: the same inputs always give the same text, so the prompt
 * prefix stays stable. Errors are rendered before the tail.
 * @param {string} name
 * @param {string} label
 * @param {number} chars
 * @param {number} lines
 * @param {Preview} [preview]
 * @returns {string}
 */
export function stubText(name, label, chars, lines, preview) {
  const what = label ? `${name} ${label}` : name
  let out = `${STUB_MARKER} the output of ${what} (${formatSize(chars)}, ${lines} lines) was elided from the context to save tokens. Re-run it if you need it again.`
  if (preview?.errors.length) {
    out += `\nerror lines:\n${preview.errors.map((l) => `  ${l}`).join('\n')}`
  }
  if (preview?.tail.length) {
    out += `\nlast lines:\n${preview.tail.map((l) => `  ${l}`).join('\n')}`
  }
  return out + ']'
}

/**
 * Is this content already one of our stubs? (DSH addition: the adapter needs
 * it to tell an already-elided result from a fresh one.)
 * @param {unknown} content
 * @returns {boolean}
 */
export function isStubbed(content) {
  if (typeof content === 'string') return content.startsWith(STUB_MARKER)
  return partsOf(content).some(
    (p) => p?.type === 'text' && typeof p.text === 'string' && p.text.startsWith(STUB_MARKER),
  )
}

/**
 * Assistant messages with thinking blocks must be sent back byte-identical
 * (signed), so they are never rewritten.
 * @param {Message} m
 * @returns {boolean}
 */
export function hasThinking(m) {
  return partsOf(m?.content).some(
    (p) => p?.type === 'thinking' || p?.type === 'redacted_thinking',
  )
}

/**
 * For every message, how many assistant messages come after it.
 * @param {ReadonlyArray<Message>} messages
 * @returns {number[]}
 */
export function assistantTurnsAfter(messages) {
  /** @type {number[]} */
  const ages = new Array(messages.length).fill(0)
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    ages[i] = seen
    if (messages[i]?.role === 'assistant') seen++
  }
  return ages
}

/**
 * @param {ReadonlyArray<Message>} messages
 * @returns {number | undefined}
 */
export function lastAssistantTimestamp(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant' && typeof m.timestamp === 'number') return m.timestamp
  }
  return undefined
}

/**
 * The prompt cache is cold when the last assistant message is older than its
 * lifetime (strictly older: exactly at the TTL is still warm), and there is no
 * signal at all means "not cold".
 * @param {ReadonlyArray<Message>} messages
 * @param {number} now
 * @param {number} ttlMs
 * @returns {boolean}
 */
export function isCold(messages, now, ttlMs) {
  const last = lastAssistantTimestamp(messages)
  return last !== undefined && now - last > ttlMs
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Policy
 * @property {number} keepTurns
 * @property {number} minChars
 * @property {boolean} keepErrors
 * @property {ReadonlySet<string>} neverElide
 */

/**
 * `protectedTools` are tools protected for this session by the recovery meter,
 * on top of the configured ones.
 * @param {DietConfig} c
 * @param {Iterable<string>} [protectedTools]
 * @returns {Policy}
 */
export function policyOf(c, protectedTools = []) {
  return {
    keepTurns: c.keepTurns,
    minChars: c.minChars,
    keepErrors: c.keepErrors,
    neverElide: new Set([...c.neverElide, ...protectedTools]),
  }
}

/**
 * Tool results that may be elided now: old enough, big enough, plain text, not
 * an error, not protected and not already elided.
 * @param {ReadonlyArray<Message>} messages
 * @param {Policy} policy
 * @param {ReadonlySet<string>} already
 * @returns {string[]}
 */
export function eligible(messages, policy, already) {
  const ages = assistantTurnsAfter(messages)
  /** @type {string[]} */
  const ids = []
  messages.forEach((m, i) => {
    if (m?.role !== 'toolResult' || typeof m.toolCallId !== 'string') return
    if (already.has(m.toolCallId) || ages[i] <= policy.keepTurns) return
    if (m.isError && policy.keepErrors) return
    if (m.toolName && policy.neverElide.has(m.toolName)) return
    const size = measure(m.content)
    if (!size.textOnly || size.chars < policy.minChars) return
    ids.push(m.toolCallId)
  })
  return ids
}

// ---------------------------------------------------------------------------
// Stale write / edit arguments
// ---------------------------------------------------------------------------

/** Tools whose arguments carry file content that the file on disk already holds. */
export const ARG_TOOLS = new Set(['write', 'edit'])

/**
 * @typedef {object} EditArg
 * @property {unknown} [oldText]
 * @property {unknown} [newText]
 */

/**
 * @param {unknown} v
 * @returns {number}
 */
const strLen = (v) => (typeof v === 'string' ? v.length : 0)

/**
 * How many characters of file content a write / edit call carries.
 * @param {string} name
 * @param {Record<string, unknown> | undefined} args
 * @returns {number}
 */
export function argChars(name, args) {
  if (!args) return 0
  if (name === 'write') return strLen(args.content)
  let n = strLen(args.oldText) + strLen(args.newText)
  if (Array.isArray(args.edits)) {
    for (const e of /** @type {EditArg[]} */ (args.edits)) {
      n += strLen(e?.oldText) + strLen(e?.newText)
    }
  }
  return n
}

/**
 * The placeholder that replaces elided file content.
 * @param {unknown} v
 * @param {string} path
 * @returns {string}
 */
const elidedArg = (v, path) => {
  const text = typeof v === 'string' ? v : ''
  return `${STUB_MARKER} ${lineCount(text)} lines (${formatSize(text.length)}) of ${path || 'the file'} elided; the file on disk is authoritative]`
}

/**
 * The same call with its bulky content replaced by a short placeholder.
 * `write` without a string `content` is returned as the same object.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
export function elideArguments(name, args) {
  const a = args ?? {}
  const path =
    typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : ''
  if (name === 'write') {
    return typeof a.content === 'string' ? { ...a, content: elidedArg(a.content, path) } : a
  }
  /** @type {Record<string, unknown>} */
  const out = { ...a }
  if (typeof out.oldText === 'string') out.oldText = elidedArg(out.oldText, path)
  if (typeof out.newText === 'string') out.newText = elidedArg(out.newText, path)
  if (Array.isArray(a.edits)) {
    out.edits = /** @type {EditArg[]} */ (a.edits).map((e) =>
      e && typeof e === 'object'
        ? {
            ...e,
            ...(typeof e.oldText === 'string'
              ? { oldText: elidedArg(e.oldText, path) }
              : {}),
            ...(typeof e.newText === 'string'
              ? { newText: elidedArg(e.newText, path) }
              : {}),
          }
        : e,
    )
  }
  return out
}

/**
 * Tool-call ids whose write / edit arguments may be elided: old enough, big
 * enough, and the call succeeded (a failed or unanswered call may be retried,
 * so its arguments are kept).
 * @param {ReadonlyArray<Message>} messages
 * @param {Policy} policy
 * @param {ReadonlySet<string>} already
 * @returns {string[]}
 */
export function eligibleArgs(messages, policy, already) {
  const ages = assistantTurnsAfter(messages)
  /** @type {Set<string>} */
  const failed = new Set()
  /** @type {Set<string>} */
  const answered = new Set()
  for (const m of messages) {
    if (m.role !== 'toolResult' || typeof m.toolCallId !== 'string') continue
    answered.add(m.toolCallId)
    if (m.isError) failed.add(m.toolCallId)
  }
  /** @type {string[]} */
  const ids = []
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || ages[i] <= policy.keepTurns) return
    if (hasThinking(m)) return // signed thinking blocks: the API rejects any edit to the message
    for (const p of partsOf(m.content)) {
      if (p?.type !== 'toolCall' || typeof p.id !== 'string' || typeof p.name !== 'string') continue
      if (!ARG_TOOLS.has(p.name) || policy.neverElide.has(p.name) || already.has(p.id)) continue
      if (!answered.has(p.id) || failed.has(p.id)) continue
      if (argChars(p.name, p.arguments) < policy.minChars) continue
      ids.push(p.id)
    }
  })
  return ids
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/**
 * Which new results (and write / edit arguments) to elide on this request.
 * None unless the cache is cold, it was forced, or mode is `always`. `cold` is
 * a fact about the cache, not "whether elision happens".
 * @param {ReadonlyArray<Message>} messages
 * @param {ReadonlySet<string>} elided
 * @param {DietConfig} config
 * @param {{ now: number, force: boolean }} ctx
 * @param {{ elidedArgs?: ReadonlySet<string>, protectedTools?: Iterable<string> }} [extra]
 * @returns {{ ids: string[], argIds: string[], cold: boolean }}
 */
export function decide(messages, elided, config, ctx, extra = {}) {
  if (!config.enabled) return { ids: [], argIds: [], cold: false }
  const cold = isCold(messages, ctx.now, config.cacheTtlMinutes * 60_000)
  if (!(ctx.force || cold || config.mode === 'always')) return { ids: [], argIds: [], cold }
  const policy = policyOf(config, extra.protectedTools)
  return {
    ids: eligible(messages, policy, elided),
    argIds: config.elideArgs ? eligibleArgs(messages, policy, extra.elidedArgs ?? new Set()) : [],
    cold,
  }
}

// ---------------------------------------------------------------------------
// Applying the elision
// ---------------------------------------------------------------------------

/**
 * Stable JSON: object keys sorted, so the same call always gives the same
 * signature.
 * @param {unknown} v
 * @returns {string}
 */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v)
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/**
 * @param {string} name
 * @param {unknown} args
 * @returns {string}
 */
export const callSignature = (name, args) => `${name}:${stableStringify(args ?? {})}`

/**
 * An elided tool result, remembered so a later identical call can be
 * recognised as a re-fetch.
 * @typedef {object} ElidedInfo
 * @property {string} id
 * @property {string} tool
 * @property {string} sig
 * @property {number} chars
 */

/**
 * @typedef {object} ApplyOptions
 * @property {ReadonlySet<string>} [argIds]
 * @property {{ tail: number, errors: number }} [preview]
 */

/**
 * Replace the chosen results (and arguments) with stubs. Original messages are
 * never mutated; untouched ones are shared by reference. The same input always
 * produces the same bytes.
 * @param {Message[]} messages
 * @param {ReadonlySet<string>} elided
 * @param {ApplyOptions} [opts]
 * @returns {{ messages: Message[], count: number, argCount: number, savedChars: number, infos: ElidedInfo[] }}
 */
export function applyElision(messages, elided, opts = {}) {
  const argIds = opts.argIds ?? new Set()
  if (elided.size === 0 && argIds.size === 0) {
    return { messages, count: 0, argCount: 0, savedChars: 0, infos: [] }
  }
  const calls = indexCalls(messages)
  let count = 0
  let argCount = 0
  let savedChars = 0
  /** @type {ElidedInfo[]} */
  const infos = []
  const out = messages.map((m) => {
    if (m.role === 'toolResult' && typeof m.toolCallId === 'string' && elided.has(m.toolCallId)) {
      const size = measure(m.content)
      if (!size.textOnly) return m
      const call = calls.get(m.toolCallId)
      const tool = m.toolName ?? call?.name ?? 'tool'
      const preview = opts.preview
        ? previewOf(m.content, opts.preview.tail, opts.preview.errors)
        : undefined
      const text = stubText(
        tool,
        call ? describeCall(call.name, call.args) : '',
        size.chars,
        size.lines,
        preview,
      )
      count++
      savedChars += Math.max(0, size.chars - text.length)
      if (call) infos.push({ id: m.toolCallId, tool, sig: callSignature(call.name, call.args), chars: size.chars })
      return { ...m, content: [{ type: 'text', text }] }
    }
    if (m.role === 'assistant' && argIds.size > 0 && Array.isArray(m.content) && !hasThinking(m)) {
      let changed = false
      const content = /** @type {Part[]} */ (m.content).map((p) => {
        if (
          p?.type !== 'toolCall' ||
          typeof p.id !== 'string' ||
          typeof p.name !== 'string' ||
          !argIds.has(p.id) ||
          !p.arguments
        ) {
          return p
        }
        const before = JSON.stringify(p.arguments).length
        const next = elideArguments(p.name, p.arguments)
        if (next === p.arguments) return p
        changed = true
        argCount++
        savedChars += Math.max(0, before - JSON.stringify(next).length)
        return { ...p, arguments: next }
      })
      return changed ? { ...m, content } : m
    }
    return m
  })
  return count + argCount === 0
    ? { messages, count: 0, argCount: 0, savedChars: 0, infos: [] }
    : { messages: out, count, argCount, savedChars, infos }
}

/**
 * Characters of message content in a request (what this module can see; the
 * provider adds its own framing).
 * @param {ReadonlyArray<Message>} messages
 * @returns {number}
 */
export function charsOfMessages(messages) {
  let n = 0
  for (const m of messages) {
    const c = m?.content
    n += typeof c === 'string' ? c.length : c === undefined || c === null ? 0 : JSON.stringify(c).length
  }
  return n
}

// ---------------------------------------------------------------------------
// Calibration: how many characters make a token, measured from real usage
// ---------------------------------------------------------------------------

/**
 * Learns characters-per-token from (characters sent, tokens the provider
 * billed) pairs of one session: the slope of tokens over characters, so the
 * fixed system prompt drops out as the intercept.
 */
export class Calibrator {
  /** @type {Array<[number, number]>} */
  #points = []

  /**
   * @param {number} chars
   * @param {number} tokens
   * @returns {void}
   */
  add(chars, tokens) {
    // Finite only: one Infinity or NaN from a provider would poison every later estimate.
    if (chars > 0 && tokens > 0 && Number.isFinite(chars) && Number.isFinite(tokens)) {
      this.#points.push([chars, tokens])
    }
    if (this.#points.length > 200) this.#points.shift()
  }

  /** @returns {number} */
  samples() {
    return this.#points.length
  }

  /**
   * Slope of tokens over characters (sxx / sxy), or undefined when there are
   * too few or unusable samples.
   * @returns {number | undefined}
   */
  #measure() {
    const n = this.#points.length
    if (n < 6) return undefined
    const mx = this.#points.reduce((a, p) => a + p[0], 0) / n
    const my = this.#points.reduce((a, p) => a + p[1], 0) / n
    let sxx = 0
    let sxy = 0
    for (const [x, y] of this.#points) {
      sxx += (x - mx) ** 2
      sxy += (x - mx) * (y - my)
    }
    const slope = sxx / sxy
    // Huge values can overflow the sums: a ratio that is not a finite positive number is unusable.
    return sxx === 0 || sxy <= 0 || !Number.isFinite(slope) || slope <= 0 ? undefined : slope
  }

  /** True once the ratio comes from the data (enough samples, and tokens that actually grow with characters). */
  isMeasured() {
    return this.#measure() !== undefined
  }

  /** Characters per token: measured when possible, else the default. Clamped to 1.5..8. */
  charsPerToken() {
    const m = this.#measure()
    return m === undefined ? DEFAULT_CHARS_PER_TOKEN : Math.min(8, Math.max(1.5, m))
  }
}

// ---------------------------------------------------------------------------
// Show: what is elided right now, and what is next
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Shown
 * @property {'result' | 'args'} kind
 * @property {string} tool
 * @property {string} label
 * @property {number} chars
 */

/**
 * The biggest things currently elided (results and write/edit arguments),
 * measured from the ORIGINAL messages.
 * @param {ReadonlyArray<Message>} messages
 * @param {ReadonlySet<string>} elided
 * @param {ReadonlySet<string>} elidedArgs
 * @returns {Shown[]}
 */
export function describeElided(messages, elided, elidedArgs) {
  const calls = indexCalls(messages)
  /** @type {Shown[]} */
  const out = []
  for (const m of messages) {
    if (m?.role === 'toolResult' && typeof m.toolCallId === 'string' && elided.has(m.toolCallId)) {
      const call = calls.get(m.toolCallId)
      out.push({
        kind: 'result',
        tool: m.toolName ?? call?.name ?? 'tool',
        label: call ? describeCall(call.name, call.args) : '',
        chars: measure(m.content).chars,
      })
    } else if (m?.role === 'assistant') {
      for (const p of partsOf(m.content)) {
        if (
          p?.type === 'toolCall' &&
          typeof p.id === 'string' &&
          elidedArgs.has(p.id) &&
          typeof p.name === 'string'
        ) {
          out.push({
            kind: 'args',
            tool: p.name,
            label: describeCall(p.name, p.arguments ?? {}),
            chars: argChars(p.name, p.arguments),
          })
        }
      }
    }
  }
  return out.sort((a, b) => b.chars - a.chars)
}

/**
 * The next candidates: stale, big, not elided yet (what the next cold start
 * would take).
 * @param {ReadonlyArray<Message>} messages
 * @param {Policy} policy
 * @param {ReadonlySet<string>} elided
 * @param {ReadonlySet<string>} elidedArgs
 * @param {boolean} includeArgs
 * @returns {Shown[]}
 */
export function describeCandidates(messages, policy, elided, elidedArgs, includeArgs) {
  const ids = new Set(eligible(messages, policy, elided))
  const argIds = new Set(includeArgs ? eligibleArgs(messages, policy, elidedArgs) : [])
  return describeElided(messages, ids, argIds)
}

/**
 * @param {string} title
 * @param {ReadonlyArray<Shown>} items
 * @param {number} limit
 * @param {number} cpt
 * @returns {string[]}
 */
export function showLines(title, items, limit, cpt) {
  if (items.length === 0) return [`${title}: none`]
  const total = items.reduce((n, x) => n + x.chars, 0)
  const rows = items
    .slice(0, limit)
    .map(
      (x) =>
        `  ${x.kind === 'args' ? 'args ' : ''}${x.tool}${x.label ? ` ${x.label}` : ''}  ${formatSize(x.chars)}`,
    )
  const more = items.length > limit ? [`  … and ${items.length - limit} more`] : []
  return [`${title}: ${items.length} (~${formatTokens(estimateTokens(total, cpt))} tokens)`, ...rows, ...more]
}

/**
 * Tokens of stale, elidable output (results and write/edit arguments) that a
 * cold start would drop.
 * @param {ReadonlyArray<Message>} messages
 * @param {Policy} policy
 * @param {ReadonlySet<string>} elided
 * @param {ReadonlySet<string>} elidedArgs
 * @param {boolean} includeArgs
 * @param {number} charsPerToken
 * @returns {number}
 */
export function staleTokens(messages, policy, elided, elidedArgs, includeArgs, charsPerToken) {
  return estimateTokens(
    describeCandidates(messages, policy, elided, elidedArgs, includeArgs).reduce(
      (n, x) => n + x.chars,
      0,
    ),
    charsPerToken,
  )
}

// ---------------------------------------------------------------------------
// Recovery meter: did the agent need what was elided?
// ---------------------------------------------------------------------------

/**
 * Remembers what was elided and notices when the agent re-issues the identical
 * call. Each such re-fetch costs the output again, so the meter turns "did
 * this hurt?" into a number, and it can tell which tool to stop eliding.
 */
export class RecoveryMeter {
  /** @type {Map<string, ElidedInfo[]>} */
  #bySig = new Map()
  /** @type {Set<string>} */
  #tracked = new Set()
  /** @type {Set<string>} */
  #counted = new Set()
  /** @type {Map<string, { elided: number, recovered: number }>} */
  perTool = new Map()
  recovered = 0
  recoveredChars = 0

  /**
   * Idempotent: call it with everything currently elided on each request.
   * @param {ReadonlyArray<ElidedInfo>} infos
   * @returns {void}
   */
  track(infos) {
    for (const info of infos) {
      if (this.#tracked.has(info.id)) continue
      this.#tracked.add(info.id)
      let matches = this.#bySig.get(info.sig)
      if (!matches) {
        matches = []
        this.#bySig.set(info.sig, matches)
      }
      matches.push(info)
      const t = this.perTool.get(info.tool) ?? { elided: 0, recovered: 0 }
      t.elided++
      this.perTool.set(info.tool, t)
    }
  }

  /**
   * A tool is about to run: is it the identical call to something that was
   * elided (and not yet counted)? One call answers every elided copy of the
   * same output.
   * @param {string} tool
   * @param {unknown} args
   * @returns {ElidedInfo | undefined}
   */
  onCall(tool, args) {
    const matches = this.#bySig.get(callSignature(tool, args))
    const hit = matches?.find((m) => !this.#counted.has(m.id))
    if (!hit) return undefined
    for (const m of matches) this.#counted.add(m.id)
    this.recovered++
    this.recoveredChars += hit.chars
    const t = this.perTool.get(hit.tool)
    if (t) t.recovered++
    return hit
  }

  /** @returns {number} */
  elided() {
    return this.#tracked.size
  }

  /**
   * True when this tool's results keep being re-fetched: enough samples and a
   * share strictly above the threshold.
   * @param {string} tool
   * @param {number} threshold
   * @param {number} [minSample]
   * @returns {boolean}
   */
  shouldProtect(tool, threshold, minSample = 5) {
    const t = this.perTool.get(tool)
    return !!t && t.elided >= minSample && t.recovered / t.elided > threshold
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Command
 * @property {'status' | 'on' | 'off' | 'now' | 'keep' | 'ttl' | 'mode' | 'args' | 'show' | 'invalid'} kind
 * @property {number} [turns]
 * @property {number} [minutes]
 * @property {DietMode} [mode]
 * @property {boolean} [on]
 * @property {string} [message]
 */

export const USAGE =
  'Usage: /context-diet [status] · on · off · now · keep <turns> · ttl <minutes> · mode <cold|always> · args <on|off> · show'

/**
 * @param {string} [args]
 * @returns {Command}
 */
export function parseCommand(args) {
  const [cmd, p1] = (args ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  switch (cmd) {
    case undefined:
    case 'status':
      return { kind: 'status' }
    case 'on':
    case 'enable':
      return { kind: 'on' }
    case 'off':
    case 'disable':
      return { kind: 'off' }
    case 'now':
      return { kind: 'now' }
    case 'keep': {
      const n = Number(p1)
      return Number.isInteger(n) && n >= 1 && n <= 500
        ? { kind: 'keep', turns: n }
        : { kind: 'invalid', message: 'Usage: /context-diet keep <turns> (1 to 500)' }
    }
    case 'ttl': {
      const n = Number(p1)
      return Number.isInteger(n) && n >= 1 && n <= 1440
        ? { kind: 'ttl', minutes: n }
        : { kind: 'invalid', message: 'Usage: /context-diet ttl <minutes> (1 to 1440)' }
    }
    case 'mode':
      return p1 === 'cold' || p1 === 'always'
        ? { kind: 'mode', mode: p1 }
        : { kind: 'invalid', message: 'Usage: /context-diet mode <cold|always>' }
    case 'show':
      return { kind: 'show' }
    case 'args':
      return p1 === 'on' || p1 === 'off'
        ? { kind: 'args', on: p1 === 'on' }
        : { kind: 'invalid', message: 'Usage: /context-diet args <on|off>' }
    default:
      return { kind: 'invalid', message: `Unknown option "${cmd}". ${USAGE}` }
  }
}

/**
 * @typedef {object} CompletionItem
 * @property {string} value
 * @property {string} label Required by hosts that call `label.endsWith(...)` when applying a completion.
 * @property {string} [description]
 */

/** @type {ReadonlyArray<CompletionItem>} */
const TOP_LEVEL = [
  { value: 'status', label: 'status', description: 'Show settings and savings' },
  { value: 'on', label: 'on', description: 'Turn context-diet on' },
  { value: 'off', label: 'off', description: 'Turn it off (nothing is elided)' },
  { value: 'now', label: 'now', description: 'Elide stale results on the next request (one cache rewrite)' },
  { value: 'keep ', label: 'keep', description: 'Always keep the last N assistant turns' },
  { value: 'ttl ', label: 'ttl', description: 'Prompt-cache lifetime in minutes' },
  { value: 'mode ', label: 'mode', description: 'cold (free) or always' },
  { value: 'args ', label: 'args', description: 'Also elide stale write/edit arguments (on or off)' },
  { value: 'show', label: 'show', description: 'List what is elided and what is next' },
]

/**
 * `prefix` is the whole argument text typed so far (the host replaces it with
 * `value`).
 * @param {string} [prefix]
 * @returns {CompletionItem[] | null}
 */
export function completions(prefix) {
  const text = (prefix ?? '').toLowerCase().replace(/^\s+/, '')
  /** @type {ReadonlyArray<CompletionItem>} */
  const pool = text.startsWith('mode ')
    ? [
        { value: 'mode cold', label: 'cold', description: 'Elide only when the prompt cache is already cold (free)' },
        { value: 'mode always', label: 'always', description: 'Elide whenever eligible (providers without prompt caching)' },
      ]
    : text.startsWith('args ')
      ? [
          { value: 'args on', label: 'on', description: 'Elide stale write content and edit old/new text' },
          { value: 'args off', label: 'off', description: 'Keep write and edit arguments in the context' },
        ]
      : TOP_LEVEL
  const out = pool.filter((i) => i.value.startsWith(text))
  return out.length > 0 ? out : null
}

// ---------------------------------------------------------------------------
// Stats, status line and footer
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Stats
 * @property {number} lastCount
 * @property {number} lastArgCount
 * @property {number} lastChars
 * @property {number} cumulativeChars
 * @property {number} requests
 * @property {number} coldStarts
 * @property {number} [lastPassAt] DSH addition: epoch ms of the last deciding pass.
 */

/**
 * @typedef {object} RecoverySummary
 * @property {number} recovered
 * @property {number} elided
 * @property {number} recoveredChars
 * @property {string[]} protectedTools
 */

/**
 * @typedef {object} Extra
 * @property {number} [charsPerToken]
 * @property {number} [samples]
 * @property {boolean} [measured]
 * @property {number | { chars?: number, tokens?: number }} [next] Tokens (or `{chars,tokens}`) a cold start would drop; computed by the adapter with `staleTokens`.
 * @property {number} [nextTokens] Alias of `next`.
 * @property {number} [nextChars] Stale characters; converted with charsPerToken.
 */

/**
 * Human-readable status text (the body of `/context-diet status`).
 * @param {DietConfig} config
 * @param {Stats} stats
 * @param {RecoverySummary} [recovery]
 * @param {Extra} [extra]
 * @returns {string}
 */
export function statusLine(config, stats, recovery, extra) {
  const cpt = extra?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const head = `context-diet: ${config.enabled ? 'on' : 'off'} · mode ${config.mode} · keep last ${config.keepTurns} turns · cache ttl ${config.cacheTtlMinutes} min · min ${formatSize(config.minChars)} · write/edit args ${config.elideArgs ? 'elided' : 'kept'}`
  const args = stats.lastArgCount > 0 ? ` + ${stats.lastArgCount} write/edit arguments` : ''
  const body = `this session: ${stats.lastCount} results${args} elided (~${formatTokens(estimateTokens(stats.lastChars, cpt))} tokens kept out of every request), ~${formatTokens(estimateTokens(stats.cumulativeChars, cpt))} tokens saved over ${stats.requests} requests · ${stats.coldStarts} cold start${stats.coldStarts === 1 ? '' : 's'}`
  const lines = [head, body]
  if (extra) {
    const calibrated = extra.measured
      ? `${cpt.toFixed(2)} chars/token measured from ${extra.samples} requests`
      : (extra.samples ?? 0) < 6
        ? `${cpt.toFixed(2)} chars/token assumed (calibrating: ${extra.samples} of 6 requests)`
        : `${cpt.toFixed(2)} chars/token assumed (the provider's usage did not vary with context size)`
    lines.push(calibrated)
  }
  if (!recovery) return lines.join('\n')
  const rate = recovery.elided > 0 ? Math.round((100 * recovery.recovered) / recovery.elided) : 0
  const guard =
    recovery.protectedTools.length > 0
      ? ` · protected: ${recovery.protectedTools.join(', ')}`
      : ''
  lines.push(
    `recovery: ${recovery.recovered} of ${recovery.elided} elided results re-fetched (${rate}%, ~${formatTokens(estimateTokens(recovery.recoveredChars, cpt))} tokens to re-fetch, once)${guard}`,
  )
  return lines.join('\n')
}

/**
 * Tokens a cold start would drop, as handed in by the adapter.
 * @param {Extra | undefined} extra
 * @param {number} cpt
 * @returns {number}
 */
const nextTokensOf = (extra, cpt) => {
  const raw = extra?.next ?? extra?.nextTokens
  if (typeof raw === 'number') return raw
  if (raw && typeof raw === 'object') {
    if (typeof raw.tokens === 'number') return raw.tokens
    if (typeof raw.chars === 'number') return estimateTokens(raw.chars, cpt)
  }
  if (typeof extra?.nextChars === 'number') return estimateTokens(extra.nextChars, cpt)
  return 0
}

/**
 * The one-line footer `showStatus` (upstream TS:1001-1020) renders, as plain
 * text for a DSH client to display verbatim. Two shapes:
 *  - nothing elided yet: `🥗 −<next> at the next pause` (or `🥗 on` when a cold
 *    start would drop nothing);
 *  - something elided: `🥗 −<last> /req · <saved> saved`, plus ` ↺<recovered>`
 *    and ` ⚠ mode always` when they apply.
 * Returns `''` when the feature or the status line is turned off.
 * @param {DietConfig} config
 * @param {Stats} stats
 * @param {RecoverySummary} [recovery]
 * @param {Extra} [extra]
 * @returns {string}
 */
export function footerLine(config, stats, recovery, extra) {
  if (!config?.enabled || !config?.showStatus) return ''
  const cpt = extra?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const s = stats ?? {}
  const warn = config.mode === 'always' ? ' ⚠ mode always' : ''
  if ((s.lastCount ?? 0) + (s.lastArgCount ?? 0) === 0) {
    const next = nextTokensOf(extra, cpt)
    const text = next > 0 ? `−${formatTokens(next)} at the next pause` : 'on'
    return `🥗 ${text}${warn}`
  }
  const recoveredCount = recovery?.recovered ?? 0
  const recovered = recoveredCount > 0 ? ` ↺${recoveredCount}` : ''
  const last = formatTokens(estimateTokens(s.lastChars ?? 0, cpt))
  const total = formatTokens(estimateTokens(s.cumulativeChars ?? 0, cpt))
  return `🥗 −${last} /req · ${total} saved${recovered}${warn}`
}
