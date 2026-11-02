/**
 * dsh-context-diet — Host half.
 *
 * This is the DSH adapter around the pure strategy core in `core.js`, which is a
 * faithful port of pi-context-diet. The adapter's whole job is translation:
 *
 *   DSH session surface  →  pi-shaped messages  →  core.decide / core.applyElision
 *                        ←  durable surface replacement
 *
 * Deliberate design points
 * ------------------------
 * 1. **One core.** There is no second "DSH policy" implementation. Every gate
 *    (cold timeout, keepTurns, minChars, keepErrors, neverElide, protected tools,
 *    write/edit argument elision) lives in `core.js`, shared with the parity
 *    tests that were ported from the upstream test suite.
 * 2. **A node is elided once, then stays elided.** pi re-decides on every request
 *    and re-applies to a per-request copy, which keeps the prompt prefix
 *    byte-stable between cold starts. DSH has no per-request surface: the only
 *    writable surface is the durable session log. The adapter therefore lands a
 *    replacement once (`surfaceOp: replace`) and never revisits it, which keeps
 *    the same observable property pi relies on.
 * 3. **Not a compaction plugin.** Nothing here summarises, rewrites or discards
 *    history. The only log-only event written is the platform's
 *    `compaction/prune` shadow price — the native tool-result pruner's own
 *    accounting convention, needed so token accounting does not count both the
 *    original node and its replacement.
 * 4. **Fail open.** A pre-step error must never break a turn.
 */

import Schema from '@deepseek-ai/schemastery'

import {
  ARG_TOOLS,
  Calibrator,
  DEFAULT_CONFIG,
  RecoveryMeter,
  applyElision,
  callSignature,
  charsOfMessages,
  decide,
  describeCandidates,
  describeElided,
  formatTokens,
  hasThinking,
  indexCalls,
  isStubbed,
  measure,
  parseCommand,
  policyOf,
  sanitizeConfig,
  showLines,
  staleTokens,
  statusLine,
  footerLine,
  USAGE,
} from './core.js'

/** Cordis plugin name; also the Loader row id used by the bundle patch. */
export const name = 'context-diet'

/** Only `commands` is required; `tokenMeter`/`webServer` are used when present. */
export const inject = ['commands']

/**
 * Plugin config. Defaults mirror `DEFAULT_CONFIG` in `core.js` (and therefore
 * upstream pi-context-diet); the bounds mirror `sanitizeConfig`.
 *
 * `elideArgs` is deliberately absent. pi can rewrite a stale `write`/`edit`
 * tool call because it owns the per-request messages; DSH cannot: a tool call
 * lives in a `tool/call` event and in the assistant message's `tool-call`
 * blocks, and the platform rejects an `assistant/message` surface replacement
 * with mutually exclusive errors ("sourceEventSeqs must include every shadowed
 * surface node" versus "assistant/message embeds its source stream and cannot
 * carry sourceEventSeqs"). The adapter therefore always runs with
 * `elideArgs: false`, which is also what `statusLine` reports.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled),
  mode: Schema.union(['cold', 'always']).default(DEFAULT_CONFIG.mode),
  keepTurns: Schema.number().step(1).min(1).max(500).default(DEFAULT_CONFIG.keepTurns),
  minChars: Schema.number().step(1).min(200).max(1_000_000).default(DEFAULT_CONFIG.minChars),
  cacheTtlMinutes: Schema.number().step(1).min(1).max(1440).default(DEFAULT_CONFIG.cacheTtlMinutes),
  keepErrors: Schema.boolean().default(DEFAULT_CONFIG.keepErrors),
  neverElide: Schema.array(Schema.string()).default([...DEFAULT_CONFIG.neverElide]),
  showStatus: Schema.boolean().default(DEFAULT_CONFIG.showStatus),
  stubTailLines: Schema.number().step(1).min(0).max(10).default(DEFAULT_CONFIG.stubTailLines),
  stubErrorLines: Schema.number().step(1).min(0).max(10).default(DEFAULT_CONFIG.stubErrorLines),
  autoProtect: Schema.boolean().default(DEFAULT_CONFIG.autoProtect),
  recoveryThreshold: Schema.number().min(0.05).max(1).default(DEFAULT_CONFIG.recoveryThreshold),
})

/**
 * Sanitize a plugin config for the adapter: the user's Config, then session
 * overrides, then the clamps. `elideArgs` is pinned to false because DSH
 * cannot rewrite a tool call's arguments (see the Config comment).
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} [overrides]
 * @returns {object}
 */
function adapterConfig(base, overrides = {}) {
  return sanitizeConfig({ ...(base ?? {}), ...overrides, elideArgs: false })
}

/** Read-only stats endpoint polled by the Client footer. */
const STATS_ENDPOINT = '/context-diet/stats'

/** How many finished-but-referenced sessions the stats endpoint remembers. */
const MAX_TRACKED_SESSIONS = 8

/** Hard cap on the adapter's call index, so a pathological session stays bounded. */
const MAX_CALL_INDEX = 8192

/**
 * @typedef {object} Stats
 * @property {number} lastCount
 * @property {number} lastArgCount
 * @property {number} lastChars
 * @property {number} cumulativeChars
 * @property {number} requests
 * @property {number} coldStarts
 * @property {number} lastPassAt
 */

/** @returns {Stats} */
const emptyStats = () => ({
  lastCount: 0,
  lastArgCount: 0,
  lastChars: 0,
  cumulativeChars: 0,
  requests: 0,
  coldStarts: 0,
  lastPassAt: 0,
})

/** @param {unknown} value @returns {number} */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Resolve an optional Cordis service without throwing when the composition has
 * no provider for it.
 * @param {object} ctx
 * @param {string} key
 * @returns {any}
 */
function service(ctx, key) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(key)
    return ctx[key]
  } catch {
    return undefined
  }
}

/**
 * @param {object} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  try {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else if (typeof console !== 'undefined') console.warn(message)
  } catch {
    /* a logger must never break the plugin */
  }
}

// ---------------------------------------------------------------------------
// DSH ↔ pi message translation
// ---------------------------------------------------------------------------

/**
 * Translate one DSH content block into the pi-shaped block the core expects.
 *
 * The structural differences that matter to the core are the tool-call block
 * discriminator (`tool-call` vs `toolCall`), its JSON-string arguments, and
 * reasoning blocks, which pi calls `thinking` and must never rewrite.
 * @param {any} block
 * @returns {any}
 */
function toPiBlock(block) {
  if (block === null || typeof block !== 'object') return block
  if (block.type === 'tool-call') {
    let args = {}
    try {
      const parsed = typeof block.arguments === 'string' ? JSON.parse(block.arguments) : block.arguments
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    } catch {
      /* a malformed argument string still identifies the call: {} is enough */
    }
    return { type: 'toolCall', id: block.id, name: block.name, arguments: args }
  }
  if (block.type === 'reasoning') return { type: 'thinking', text: block.text }
  return block
}


/**
 * Build the pi-shaped message list for the current surface, plus the indexes the
 * adapter needs to land replacements.
 *
 * Messages come from the *surface* (so a landed stub is visible and skipped by
 * `isStubbed`), while timestamps come from the event that owns each node, which
 * is what pi's cold check reads.
 * @param {object} session
 * @returns {{ messages: any[], calls: Map<string, object>, resultSeq: Map<string, number>, assistantSeq: Map<string, number> }}
 */
function readSurface(session) {
  /** @type {any[]} */
  const messages = []
  /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
  const calls = new Map()
  /** @type {Map<string, number>} */
  const resultSeq = new Map()
  /** @type {Map<string, number>} */
  const assistantSeq = new Map()

  const nodes = session?.surface?.nodes
  if (nodes === undefined || nodes === null) return { messages, calls, resultSeq, assistantSeq }

  for (const seq of nodes) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (event === undefined || event === null) continue
    const type = event.type
    if (type !== 'tool/result' && type !== 'assistant/message') continue
    let message
    try {
      message = session.deriveEventMessage(event)
    } catch {
      message = undefined
    }
    if (message === undefined || message === null) continue

    const content = Array.isArray(message.content) ? message.content.map(toPiBlock) : message.content

    if (type === 'assistant/message') {
      if (typeof message.id === 'string') assistantSeq.set(message.id, seq)
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === 'toolCall' && typeof part.id === 'string') {
          calls.set(part.id, { name: part.name, args: part.arguments ?? {} })
        }
      }
    } else if (typeof message.toolCallId === 'string') {
      resultSeq.set(message.toolCallId, seq)
    }

    messages.push({
      ...message,
      content,
      role: message.role === 'tool' ? 'toolResult' : message.role,
      timestamp: typeof event.time === 'number' ? event.time : undefined,
      toolName: typeof message.toolCallId === 'string' ? calls.get(message.toolCallId)?.name : undefined,
    })
  }

  // A result may appear before the assistant message that produced it in a
  // repaired surface; label those in a second pass instead of dropping them.
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== undefined) continue
    const call = calls.get(message.toolCallId)
    if (call !== undefined) message.toolName = call.name
  }

  return { messages, calls, resultSeq, assistantSeq }
}

// ---------------------------------------------------------------------------
// Log observation: recovery meter, calibration, compaction lock
// ---------------------------------------------------------------------------

/**
 * Fold the session's new durable events into the adapter state.
 *
 * pi's recovery meter hooks `tool_call` directly; DSH has no equivalent event,
 * so the same signal is derived from the log: a `tool/call` whose signature
 * matches an elided result is a re-fetch. Counting is idempotent per call id,
 * exactly like pi's meter.
 * @param {object} session
 * @param {object} state
 * @param {object} config
 */
function observeLog(session, state, config) {
  let events
  try {
    events = session.ownEvents()
  } catch {
    return
  }
  if (!Array.isArray(events)) return
  for (let i = state.cursor; i < events.length; i += 1) {
    const event = events[i]
    const type = event?.type
    if (type === 'compaction/start') {
      state.compactionOpen = true
      continue
    }
    if (type === 'compaction/end') {
      state.compactionOpen = false
      continue
    }
    if (type === 'tool/call') {
      const data = event.data ?? {}
      let args = {}
      try {
        const parsed = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
      } catch {
        /* keep {} */
      }
      if (typeof data.callId === 'string' && typeof data.name === 'string') {
        if (state.calls.size < MAX_CALL_INDEX) state.calls.set(data.callId, { name: data.name, args })
        const hit = state.meter.onCall(data.name, args)
        if (hit !== undefined && config.autoProtect && !state.protectedTools.has(hit.tool)) {
          if (state.meter.shouldProtect(hit.tool, config.recoveryThreshold, 5)) {
            state.protectedTools.add(hit.tool)
          }
        }
      }
      continue
    }
    if (type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage !== undefined && usage !== null && state.pendingChars > 0) {
        const tokens = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
        if (tokens > 0) state.calibrator.add(state.pendingChars, tokens)
        state.pendingChars = 0
      }
    }
  }
  state.cursor = events.length
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * @param {object} session
 * @param {number} seq
 * @returns {any}
 */
function safeEventAt(session, seq) {
  try {
    return session.eventAt(seq)
  } catch {
    return undefined
  }
}

/**
 * @param {object} session
 * @param {any} event
 * @returns {any}
 */
function safeDerive(session, event) {
  try {
    return session.deriveEventMessage(event) ?? null
  } catch {
    return null
  }
}

/**
 * Append the platform's shadow price for a node that is about to be replaced.
 *
 * This is the native tool-result pruner's convention: a log-only
 * `compaction/prune` record that lets token projections subtract the shadowed
 * node instead of counting the original *and* its replacement. It summarises
 * nothing and deletes nothing — the plugin has no compaction behaviour.
 * @param {object} ctx
 * @param {object} session
 * @param {number} seq
 * @param {any} message
 */
function appendShadowPrice(ctx, session, seq, message) {
  const meter = service(ctx, 'tokenMeter')
  let tokens = 0
  try {
    if (typeof meter?.estimateMessage === 'function') {
      const priced = meter.estimateMessage(message)
      if (Number.isFinite(priced)) tokens = priced
    }
  } catch {
    tokens = 0
  }
  // A 0-token claim would make the projection add the stub on top of the
  // original price. The replacement itself is still safe (the stub is strictly
  // smaller), so skip the claim rather than assert a wrong number.
  if (tokens <= 0) return
  try {
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: tokens,
    })
  } catch {
    /* advisory: never block a replacement for the price record */
  }
}


/**
 * Decide, then land the replacements durably.
 * @param {object} ctx
 * @param {object} agent
 * @param {object} state
 * @param {object} config
 * @param {{ force?: boolean, signal?: AbortSignal }} [options]
 * @returns {number} landed surface nodes
 */
function runPass(ctx, agent, state, config, options = {}) {
  const session = agent?.session
  if (session === undefined || session === null) return 0

  observeLog(session, state, config)
  if (state.compactionOpen) return 0

  const force = options.force === true || state.force === true
  const { messages, calls, resultSeq, assistantSeq } = readSurface(session)
  if (messages.length === 0) return 0

  state.calls = calls
  state.resultSeq = resultSeq
  state.assistantSeq = assistantSeq
  state.lastMessages = messages

  const decision = decide(messages, state.elided, config, { now: Date.now(), force }, {
    elidedArgs: state.elidedArgs,
    protectedTools: state.protectedTools,
  })

  if (decision.ids.length === 0 && decision.argIds.length === 0) {
    // pi clears the per-request savings when nothing elided is in this request
    // any more (a compaction may have replaced the surface under us), so the
    // footer never advertises savings that are no longer real.
    const live = messages.filter((m) => m.role === 'toolResult' && isStubbed(m.content)).length
    if (live === 0) {
      state.stats.lastCount = 0
      state.stats.lastArgCount = 0
      state.stats.lastChars = 0
    }
    state.force = false
    return 0
  }

  const applied = applyElision(messages, new Set(decision.ids), {
    argIds: new Set(decision.argIds),
    preview: { tail: config.stubTailLines, errors: config.stubErrorLines },
  })
  if (applied.count === 0 && applied.argCount === 0) {
    state.force = false
    return 0
  }

  let landedResults = 0
  let landedArgs = 0

  // ---- tool results: 1:1 durable replacement ----
  for (const info of applied.infos) {
    if (options.signal !== undefined && options.signal.aborted) break
    const seq = state.resultSeq.get(info.id)
    if (seq === undefined) continue
    const next = applied.messages.find((m) => m.role === 'toolResult' && m.toolCallId === info.id)
    if (next === undefined) continue
    const event = safeEventAt(session, seq)
    if (event === undefined) continue
    const current = safeDerive(session, event)
    if (current === null || isStubbed(current.content)) continue
    try {
      appendShadowPrice(ctx, session, seq, current)
      session.append(
        'tool/result',
        { ...event.data, message: { ...current, content: next.content } },
        { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
      )
      state.elided.add(info.id)
      landedResults += 1
    } catch (error) {
      warn(ctx, `context-diet: replacement rejected at seq ${seq}: ${String(error)}`)
      break
    }
  }

  // Write/edit argument elision is not expressible on this platform: see the
  // Config comment. `applyElision` never receives argIds, so `landedArgs` stays
  // 0 and the statistics report results only.

  if (landedResults + landedArgs === 0) {
    state.force = false
    return 0
  }

  state.meter.track(applied.infos)
  state.stats.requests += 1
  state.stats.lastCount = landedResults
  state.stats.lastArgCount = landedArgs
  state.stats.lastChars = applied.savedChars
  state.stats.cumulativeChars += applied.savedChars
  state.stats.lastPassAt = Date.now()
  if (decision.cold) state.stats.coldStarts += 1
  state.pendingChars = charsOfMessages(applied.messages)
  state.force = false
  return landedResults + landedArgs
}

// ---------------------------------------------------------------------------
// Footer / stats
// ---------------------------------------------------------------------------

/** @param {object} state */
function recoveryOf(state) {
  return {
    recovered: state.meter.recovered,
    elided: state.meter.elided(),
    recoveredChars: state.meter.recoveredChars,
    protectedTools: [...state.protectedTools].sort(),
  }
}

/** @param {object} state */
function calibratorExtra(state) {
  return {
    charsPerToken: state.calibrator.charsPerToken(),
    samples: state.calibrator.samples(),
    measured: state.calibrator.isMeasured(),
  }
}

/**
 * Render the footer exactly the way pi's `showStatus` does.
 * @param {object} state
 * @param {object} config
 * @returns {string}
 */
function renderFooter(state, config) {
  const cpt = state.calibrator.charsPerToken()
  let next = 0
  if (state.stats.lastCount + state.stats.lastArgCount === 0 && state.lastMessages.length > 0) {
    try {
      next = staleTokens(
        state.lastMessages,
        policyOf(config, state.protectedTools),
        state.elided,
        state.elidedArgs,
        config.elideArgs,
        cpt,
      )
    } catch {
      next = 0
    }
  }
  return footerLine(config, state.stats, recoveryOf(state), {
    ...calibratorExtra(state),
    next,
  })
}

/** @param {object} state @param {object} config */
function refreshFooter(state, config) {
  try {
    state.footer = renderFooter(state, config)
  } catch {
    state.footer = ''
  }
}

/**
 * @param {object} state
 * @param {object} config
 * @returns {object} the JSON served to the Client
 */
function statsPayload(state, config) {
  return {
    schemaVersion: 1,
    config,
    stats: { ...state.stats },
    recovery: recoveryOf(state),
    estimate: calibratorExtra(state),
    footer: state.footer,
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const base = config ?? {}

  /** session → adapter state. WeakMap: a finished session is collectable. */
  const sessions = new WeakMap()
  /** sessionId → { session, state }, bounded, for the stats endpoint. */
  const byId = new Map()

  /**
   * @param {object} session
   * @returns {object}
   */
  function stateOf(session) {
    const existing = sessions.get(session)
    if (existing !== undefined) return existing
    const state = {
      /** ownEvents() entries already folded (recovery + calibration + lock). */
      cursor: 0,
      /** toolCallId → { name, args } as the original call. */
      calls: new Map(),
      /** toolCallId → the surface seq that currently holds its result. */
      resultSeq: new Map(),
      /** assistant message id → surface seq, for write/edit argument replacement. */
      assistantSeq: new Map(),
      /** callIds already replaced (pi's `elided` set). */
      elided: new Set(),
      /** callIds whose write/edit arguments were replaced. */
      elidedArgs: new Set(),
      /** tools protected for the rest of the session by the recovery meter. */
      protectedTools: new Set(),
      meter: new RecoveryMeter(),
      calibrator: new Calibrator(),
      stats: emptyStats(),
      /** Characters of the request the provider is answering (calibration). */
      pendingChars: 0,
      /** Set by `/context-diet now`. */
      force: false,
      /** Session-scoped overrides (never persisted; DSH keeps config in the profile). */
      overrides: {},
      /** A native compaction bracket is open: do not touch the surface. */
      compactionOpen: false,
      /** pi-shaped snapshot of the last pass, for the footer's next-pause budget. */
      lastMessages: [],
      /** Last rendered footer text ('' when the plugin has nothing to say). */
      footer: '',
      /** Monotonic use counter, so eviction drops the least recently active entry. */
      used: 0,
    }
    sessions.set(session, state)
    const id = session?.id
    if (typeof id === 'string' && id.length > 0) {
      byId.delete(id)
      byId.set(id, { session, state })
      while (byId.size > MAX_TRACKED_SESSIONS) {
        const oldest = byId.keys().next().value
        if (oldest === undefined) break
        byId.delete(oldest)
      }
    }
    return state
  }

  /** @returns {{ session: any, state: object } | undefined} */
  function latest() {
    let best
    for (const entry of byId.values()) {
      if (best === undefined || entry.state.used >= best.state.used) best = entry
    }
    return best
  }

  // 1) The policy pass: observe, decide, land replacements, always continue.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload?.agent
      if (agent?.session !== undefined && agent.session !== null) {
        const state = stateOf(agent.session)
        state.used += 1
        const cfg = adapterConfig(base, state.overrides)
        if (payload?.signal?.aborted !== true) {
          runPass(ctx, agent, state, cfg, { signal: payload?.signal })
          refreshFooter(state, cfg)
        }
      }
    } catch (error) {
      warn(ctx, `context-diet: pre-step failed open: ${String(error)}`)
    }
    return next()
  })

  // 2) A disposed agent releases its endpoint entry (the WeakMap collects the
  //    state by itself once the session is gone).
  ctx.on('agent/disposed', (event = {}) => {
    try {
      const session = event?.agent?.session
      if (session === undefined || session === null) return
      sessions.delete(session)
      const id = session.id
      if (typeof id === 'string') byId.delete(id)
    } catch {
      /* best effort */
    }
  })

  // 3) The human surface: `/context-diet …`.
  const commands = service(ctx, 'commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    const mount = () => {
      try {
        const dispose = commands.register({
          name: 'context-diet',
          description: 'Show and tune stale tool-result elision for this session.',
          handler: createCommandHandler(ctx, base, stateOf, (session) => {
            const state = stateOf(session)
            state.used += 1
            return state
          }),
        })
        return typeof dispose === 'function' ? dispose : undefined
      } catch (error) {
        warn(ctx, `context-diet: command unavailable: ${String(error)}`)
        return undefined
      }
    }
    if (typeof ctx.effect === 'function') ctx.effect(mount)
    else mount()
  }

  // 4) The read-only stats endpoint that feeds the Client footer.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        mountStatsRoute(webCtx, base, latest, byId)
      })
    } catch (error) {
      warn(ctx, `context-diet: stats route unavailable: ${String(error)}`)
    }
  }
}

/**
 * @param {object} webCtx
 * @param {Record<string, unknown>} base
 * @param {() => ({ session: any, state: object } | undefined)} latest
 * @param {Map<string, { session: any, state: object }>} byId
 */
function mountStatsRoute(webCtx, base, latest, byId) {
  webCtx.effect(
    () =>
      webCtx.webServer.register({
        kind: 'exact',
        path: STATS_ENDPOINT,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
            res.end()
            return
          }
          const rejection = rejectionFor(webCtx, req)
          if (rejection !== undefined) {
            sendJson(res, rejection, {
              code: rejection === 403 ? 'forbidden' : 'unauthenticated',
              message: rejection === 403
                ? 'the request did not come from a trusted origin'
                : 'dsh web authentication required',
            }, req.method === 'HEAD')
            return
          }
          const entry = resolveEntry(req, latest, byId)
          if (entry === undefined) {
            sendJson(res, 200, {
              schemaVersion: 1,
              sessionId: null,
              config: adapterConfig(base),
              stats: emptyStats(),
              recovery: { recovered: 0, elided: 0, recoveredChars: 0, protectedTools: [] },
              estimate: { charsPerToken: 3, samples: 0, measured: false },
              footer: '',
            }, req.method === 'HEAD')
            return
          }
          const cfg = adapterConfig(base, entry.state.overrides)
          refreshFooter(entry.state, cfg)
          sendJson(
            res,
            200,
            { sessionId: entry.session?.id ?? null, ...statsPayload(entry.state, cfg) },
            req.method === 'HEAD',
          )
        },
      }),
    'context-diet: stats route',
  )
}

/**
 * Pick the session the footer describes: an explicit `sessionId` query wins,
 * otherwise the most recently active one.
 * @param {any} req
 * @param {() => ({ session: any, state: object } | undefined)} latest
 * @param {Map<string, { session: any, state: object }>} byId
 * @returns {{ session: any, state: object } | undefined}
 */
function resolveEntry(req, latest, byId) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const wanted = url.searchParams.get('sessionId')
    if (typeof wanted === 'string' && wanted.length > 0) return byId.get(wanted)
  } catch {
    /* fall through to the most recently active session */
  }
  return latest()
}

/**
 * @param {object} webCtx
 * @param {any} req
 * @returns {number | undefined} 401/403 when the request is not admitted
 */
function rejectionFor(webCtx, req) {
  const connection = service(webCtx, 'connection')
  if (typeof connection?.requestRejection !== 'function') return undefined
  try {
    return connection.requestRejection(req)
  } catch {
    return undefined
  }
}

/**
 * @param {any} res
 * @param {number} status
 * @param {unknown} value
 * @param {boolean} [head]
 */
function sendJson(res, status, value, head = false) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(head ? undefined : body)
}

/**
 * `/context-diet` handler.
 *
 * Command changes are session-scoped on purpose: DSH keeps plugin
 * configuration in the profile Config (edited through the Loader), so a command
 * never rewrites it, and a command therefore never reloads the plugin under the
 * user's feet.
 * @param {object} ctx
 * @param {Record<string, unknown>} base
 * @param {(session: any) => object} stateOf
 * @param {(session: any) => object} touch
 * @returns {(input: any) => any}
 */
function createCommandHandler(ctx, base, stateOf, touch) {
  return (input) => {
    try {
      const agent = input?.agent ?? input?.session?.agent
      const session = agent?.session ?? input?.session
      const state = session === undefined || session === null ? undefined : touch(session)
      const argText = typeof input?.args === 'string' ? input.args : (input?.text ?? '')
      const command = parseCommand(argText)
      const config = state === undefined ? adapterConfig(base) : adapterConfig(base, state.overrides)

      if (command.kind === 'invalid') return { kind: 'error', text: `context-diet: ${command.message}` }

      if (command.kind === 'status') {
        return {
          kind: 'success',
          text: state === undefined
            ? statusLine(config, emptyStats())
            : statusLine(config, state.stats, recoveryOf(state), calibratorExtra(state)),
        }
      }

      if (command.kind === 'show') {
        if (state === undefined) return { kind: 'success', text: 'context-diet: no active session' }
        const messages = state.lastMessages
        const elided = describeElided(messages, state.elided, state.elidedArgs)
        const candidates = describeCandidates(
          messages,
          policyOf(config, state.protectedTools),
          state.elided,
          state.elidedArgs,
          config.elideArgs,
        )
        const cpt = state.calibrator.charsPerToken()
        const text = [
          ...showLines('elided now', elided, 10, cpt),
          '',
          ...showLines('next cold start', candidates, 10, cpt),
        ].join('\n')
        return { kind: 'success', text: `context-diet:\n${text}` }
      }

      if (state === undefined) return { kind: 'error', text: 'context-diet: no active session' }

      switch (command.kind) {
        case 'on':
          state.overrides = { ...state.overrides, enabled: true }
          refreshFooter(state, adapterConfig(base, state.overrides))
          return { kind: 'success', text: 'context-diet: on (this session)' }
        case 'off':
          state.overrides = { ...state.overrides, enabled: false }
          refreshFooter(state, adapterConfig(base, state.overrides))
          return { kind: 'success', text: 'context-diet: off (this session)' }
        case 'now':
          state.force = true
          return { kind: 'success', text: 'context-diet: eliding stale results on the next step' }
        case 'keep':
          state.overrides = { ...state.overrides, keepTurns: command.turns }
          return { kind: 'success', text: `context-diet: keep last ${command.turns} turns (this session)` }
        case 'ttl':
          state.overrides = { ...state.overrides, cacheTtlMinutes: command.minutes }
          return { kind: 'success', text: `context-diet: cache ttl ${command.minutes} min (this session)` }
        case 'mode':
          state.overrides = { ...state.overrides, mode: command.mode }
          refreshFooter(state, adapterConfig(base, state.overrides))
          return { kind: 'success', text: `context-diet: mode ${command.mode} (this session)` }
        case 'args':
          // Always kept on DSH: the platform rejects the assistant/message
          // replacement that would be needed. Say so instead of pretending.
          return {
            kind: command.on ? 'error' : 'success',
            text: command.on
              ? 'context-diet: write/edit argument elision is not expressible on the DSH surface; arguments stay kept'
              : 'context-diet: write/edit args kept (always on DSH)',
          }
        default:
          return { kind: 'error', text: USAGE }
      }
    } catch (error) {
      warn(ctx, `context-diet: command failed: ${String(error)}`)
      return { kind: 'error', text: `context-diet: ${String(error?.message ?? error)}` }
    }
  }
}

/** Exported for tests: the adapter's translation and pass contract. */
export const __testing = {
  toPiBlock,
  adapterConfig,
  readSurface,
  observeLog,
  runPass,
  renderFooter,
  statsPayload,
  STATS_ENDPOINT,
  args: { ARG_TOOLS, callSignature, formatTokens, indexCalls, measure },
}
