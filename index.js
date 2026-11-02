/**
 * @local/dsh-context-diet — Host-half policy plugin (no client half).
 *
 * Migrates the core idea of `pi-context-diet` onto the DSH 0.2.1-rc.5 seams that
 * actually exist: `agent/pre-step` + durable `tool/result` surface replacement.
 * DSH has no per-request message rewrite and no client-visible cache state, so
 * this plugin rewrites the *durable* model surface once and lets it stay stable.
 *
 * Hard constraints this file is written against (verified against the installed
 * `@deepseek-ai/dsh` 0.2.1-rc.5):
 *   - `preStep()` assembles the prompt BEFORE the waterfall and derives request
 *     messages AFTER it, so surface edits here affect the current request while
 *     prompt edits would not.
 *   - `session.append('tool/result', …, {surfaceOp:{op:'replace',…}, sourceEventSeqs})`
 *     validation (`dsh-session/lib/types/surface.js`) accepts exactly one current
 *     `tool/result` node, requires `sourceEventSeqs` to cover it, and allows ONLY
 *     `message.content` to differ from the shadowed event.
 *   - `compaction/prune` is a known, log-only session event; its shadow-price
 *     protocol requires it to be appended synchronously right before the
 *     replacement. No `compaction/start` bracket is required (the shipped
 *     `dsh-compaction-tool-result-pruner` does exactly this).
 *   - cordis 4.0.5 `inject` is `string[] | Record<string, interceptConfig>`; there
 *     is no required/optional object form, so every use below is also
 *     feature-detected at runtime and degrades instead of throwing.
 *
 * ---------------------------------------------------------------------------
 * `./core.js` contract (pure functions, no DSH imports) — v1
 * ---------------------------------------------------------------------------
 *   STUB_MARKER: string
 *   isStubbed(content: ContentBlock[]): boolean
 *   resolvePolicy(config: object, overrides: object|undefined): Policy
 *      Policy = { enabled, agePolicy:'off'|'approximate'|'always', coldTtlMinutes,
 *                 keepTurns, minChars, stubTailLines, stubErrorLines,
 *                 maxPerPass, neverElide:string[] }
 *   planElisions(snapshot: Snapshot, policy: Policy):
 *      { plans: Array<{ seq, content: ContentBlock[], charsBefore, charsAfter }> }
 *      Snapshot = { now, lastRequestTime, maxTurn, nodes: Array<{
 *                    seq, turn, chars, isError, plain, toolName, message }> }
 *   parseCommand(rawInput: string):
 *      { kind:'status'|'on'|'off'|'now'|'show'|'args'|'compact'
 *             |'keep'|'ttl'|'mode'|'invalid', ... }
 *   measure(content): { chars, lines, textOnly }   // code points, never UTF-16 units
 *   statusText(state: { policy, overrides, stats, lastPass, detailed? }): string
 *
 * If `core.js` is not present yet, the test suite substitutes a contract double
 * (see test/plugin.test.js); keep this contract in sync.
 */

import Schema from '@deepseek-ai/schemastery'
import {
  isStubbed,
  measure,
  parseCommand,
  planElisions,
  resolvePolicy,
  statusText,
} from './core.js'

/** Cordis plugin name; must stay kebab-case and unique in a profile. */
export const name = 'context-diet'

/**
 * Services the policy reads. `tokenMeter` prices shadowed nodes for the
 * shadow-price protocol; `sessionProjections` keeps per-session counters;
 * `commands` exposes the human `/context-diet` surface.
 *
 * All three are host-plane singletons mounted by `@deepseek-ai/dsh-base`
 * (`session-projection`, `commands`, `token-meter`), so declaring them is safe
 * in every base-backed profile and guarantees ordering. cordis 4.0.5 `inject`
 * has no required/optional object form (`string[] | Record<string, intercept>`),
 * so every use is ALSO resolved through `service()` and degrades instead of
 * throwing when a reduced harness exposes no method or no instance.
 */
export const inject = ['tokenMeter', 'sessionProjections', 'commands']

/** Deployment-tunable policy. Enabled by default; the settings page can disable it. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  agePolicy: Schema.union(['off', 'approximate', 'always']).default('approximate'),
  coldTtlMinutes: Schema.number().step(1).min(1).max(1440).default(5),
  keepTurns: Schema.number().step(1).min(0).max(500).default(20),
  minChars: Schema.number().step(1).min(200).max(1_000_000).default(1500),
  stubTailLines: Schema.number().step(1).min(0).max(10).default(3),
  stubErrorLines: Schema.number().step(1).min(0).max(10).default(3),
  maxPerPass: Schema.number().step(1).min(1).max(128).default(8),
  neverElide: Schema.array(Schema.string()).default([]),
})

/** Projection key + version for the durable counters (JSON-only state). */
const PROJECTION_KEY = 'contextDiet'
const PROJECTION_VERSION = 1
/** Bounded memory for the re-fetch (recovery) counter. */
const MAX_TRACKED = 64

/**
 * Per-session runtime state that must not outlive the agent: the incremental
 * compaction-lock scan cursor, command overrides, and the last pass summary.
 * Durable counters live in the projection instead.
 */
const sessions = new WeakMap()

function sessionState(session) {
  let state = sessions.get(session)
  if (state === undefined) {
    state = {
      /** Log cursor shared by the compaction lock, call index and recovery meter. */
      scanOffset: 0,
      compactionOpen: false,
      lastRequestTime: 0,
      /** callId -> tool name, for stub/preview labelling. */
      callNames: new Map(),
      /** callId -> { tool, signature }, for recovery attribution. */
      calls: new Map(),
      /** signature -> { tool } of results this plugin already elided. */
      elidedSignatures: new Map(),
      /** tool -> { elided, recovered }. */
      recoveryStats: new Map(),
      protectedTools: new Set(),
      overrides: {},
      forceOnce: false,
      lastPass: undefined,
      passes: 0,
      appends: 0,
      failures: 0,
    }
    sessions.set(session, state)
  }
  return state
}

const RECOVERY_THRESHOLD = 0.25
const RECOVERY_MIN_SAMPLE = 5
/** Bounds so a very long session cannot grow the runtime maps without limit. */
const MAX_CALLS = 4096
const MAX_ELIDED_SIGNATURES = 256

/** Drop the oldest entries until the map is within its cap (insertion order). */
function trimMap(map, cap) {
  while (map.size > cap) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

function recoverySignature(name, args) {
  return `${name}\u0000${typeof args === 'string' ? args : ''}`
}


/**
 * Advance one incremental pass over the session log. One cursor serves the
 * compaction lock, the tool-call index, the last request time, and the recovery
 * meter, so a pre-step never rescans the whole log.
 *
 * Only results this plugin actually stubbed (marker check) count as elisions:
 * native `compaction`/`tool-result-pruner` replacements carry a different stub
 * and must not inflate the recovery meter.
 *
 * @param session - the live session whose log is scanned from `state.scanOffset`.
 * @param state - per-session runtime state carrying the cursor.
 */
function scanLog(session, state) {
  const end = Number(session.seq)
  for (let seq = state.scanOffset; seq < end; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    switch (event.type) {
      case 'compaction/start':
        state.compactionOpen = true
        break
      case 'compaction/end':
      case 'session/end-seed':
        state.compactionOpen = false
        break
      case 'request/header':
        if (typeof event.time === 'number' && event.time > state.lastRequestTime) {
          state.lastRequestTime = event.time
        }
        break
      case 'tool/call': {
        const name = event.data?.name
        if (typeof name !== 'string') break
        const callId = String(event.data.callId ?? '')
        const signature = recoverySignature(name, event.data.arguments)
        state.callNames.set(callId, name)
        state.calls.set(callId, { tool: name, signature })
        trimMap(state.callNames, MAX_CALLS)
        trimMap(state.calls, MAX_CALLS)
        const elided = state.elidedSignatures.get(signature)
        if (elided !== undefined) {
          const stats = state.recoveryStats.get(elided.tool) ?? { elided: 0, recovered: 0 }
          stats.recovered += 1
          state.recoveryStats.set(elided.tool, stats)
          if (
            stats.elided >= RECOVERY_MIN_SAMPLE
            && stats.recovered / stats.elided > RECOVERY_THRESHOLD
          ) {
            state.protectedTools.add(elided.tool)
          }
        }
        break
      }
      case 'tool/result': {
        const op = event.surfaceOp
        if (op === undefined || typeof op !== 'object') break
        const message = event.data?.message
        const blocks = message?.content
        if (!Array.isArray(blocks) || !isStubbed(blocks)) break
        const call = state.calls.get(String(message.source?.callId ?? ''))
        if (call === undefined) break
        const stats = state.recoveryStats.get(call.tool) ?? { elided: 0, recovered: 0 }
        stats.elided += 1
        state.recoveryStats.set(call.tool, stats)
        state.elidedSignatures.set(call.signature, { tool: call.tool })
        trimMap(state.elidedSignatures, MAX_ELIDED_SIGNATURES)
        break
      }
      default:
        break
    }
  }
  if (Number.isFinite(end)) state.scanOffset = end
}

/**
 * Build the pure snapshot `core.planElisions` consumes.
 * @param session - live session; reads only the current surface and derived messages.
 * @param state - per-session scan state carrying the call index and request clock.
 * @param now - wall clock, injected for deterministic tests.
 * @returns snapshot of the current model surface.
 */
function buildSnapshot(session, state, now) {
  const nodes = []
  const surface = session.surface
  let maxTurn = 0

  for (const seq of surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const turn = event.data !== undefined && typeof event.data.turn === 'number' ? event.data.turn : 0
    if (turn > maxTurn) maxTurn = turn
    if (event.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null || message === undefined) continue
    const content = Array.isArray(message.content) ? message.content : []
    const measured = measure(content)
    const replaced = event.surfaceOp !== undefined && typeof event.surfaceOp === 'object'
    const plain = content.every((block) => block !== null && typeof block === 'object' && block.type === 'text')
    const chars = measured.chars
    nodes.push({
      seq,
      turn,
      chars,
      isError: message.isError === true,
      plain,
      replaced,
      toolName: (message.source && state.callNames.get(message.source.callId)) || 'tool',
      message,
    })
  }

  return { now, lastRequestTime: state.lastRequestTime, maxTurn, nodes }
}

/** Best-effort logger: the plugin must never fail a turn because logging did. */
function warn(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
  } catch {
    /* logging is best effort */
  }
}

/**
 * Resolve one optional service defensively. `inject` lists the policy services,
 * but cordis 4.0.5 has no optional-inject form and a reduced harness (or a
 * focused test) may expose them only through `ctx.get()`.
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service, or undefined when unavailable.
 */
function service(ctx, name) {
  try {
    if (ctx !== undefined && typeof ctx.get === 'function') {
      const found = ctx.get(name)
      if (found !== undefined) return found
    }
  } catch {
    /* fall through to the property form */
  }
  return ctx === undefined ? undefined : ctx[name]
}

/**
 * Apply the elision plan as durable 1:1 `tool/result` replacements.
 *
 * Fail-open by design: every replacement is independently guarded, the first
 * failure stops the pass, and the caller always continues the turn with
 * whatever content is currently on the surface.
 *
 * @param ctx - plugin context (tokenMeter + logger).
 * @param agent - the agent whose session surface is rewritten.
 * @param policy - resolved policy.
 * @param state - per-session runtime state.
 * @param signal - the pre-step abort signal.
 * @returns number of landed replacements.
 */
function elideStale(ctx, agent, policy, state, signal) {
  const session = agent.session
  scanLog(session, state)
  if (state.compactionOpen) return 0

  const snapshot = buildSnapshot(session, state, Date.now())
  if (policy.agePolicy === 'off') return 0
  if (policy.agePolicy === 'approximate') {
    const idleMinutes = snapshot.lastRequestTime === 0
      ? Number.POSITIVE_INFINITY
      : (snapshot.now - snapshot.lastRequestTime) / 60000
    if (idleMinutes < policy.coldTtlMinutes) return 0
  }

  let plans
  try {
    const protectedNeverElide = [...new Set([...(policy.neverElide ?? []), ...state.protectedTools])]
    plans = planElisions(snapshot, { ...policy, neverElide: protectedNeverElide }).plans
  } catch (error) {
    warn(ctx, `context-diet: planner failed: ${String(error)}`)
    return 0
  }
  if (!Array.isArray(plans) || plans.length === 0) return 0

  const meter = service(ctx, 'tokenMeter')
  if (typeof meter?.estimateMessage !== 'function') {
    // Without the meter we cannot price the shadowed node, and a 0-token claim
    // would make `contextBreakdown` add the stub on top of the original price.
    if (!state.pricingWarned) {
      state.pricingWarned = true
      warn(ctx, 'context-diet: tokenMeter.estimateMessage unavailable; skipping the diet pass')
    }
    return 0
  }
  const limit = Math.max(0, Math.min(plans.length, policy.maxPerPass))
  let applied = 0

  for (let index = 0; index < limit; index += 1) {
    if (signal !== undefined && signal.aborted) break
    const plan = plans[index]
    if (plan === undefined) continue

    // Re-read: an earlier replacement (ours or compaction's) may have moved the
    // surface; a stale plan is skipped rather than forced.
    const event = session.eventAt(plan.seq)
    if (event === undefined || event.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null || message === undefined) continue
    if (isStubbed(Array.isArray(message.content) ? message.content : [])) continue
    // Never grow a result: a stub whose previews exceed the original is not a diet.
    if (plan.charsAfter >= plan.charsBefore) continue

    try {
      const generation = session.surface.replaceGeneration
      const priced = typeof meter?.estimateMessage === 'function'
        ? meter.estimateMessage(message)
        : 0
      const shadowedTokenCount = Number.isFinite(priced) ? priced : 0
      // Shadow-price protocol: the claim MUST be appended synchronously before
      // its replacement, so pure projection consumers can subtract it.
      session.append('compaction/prune', {
        shadowedRange: { start: plan.seq, end: plan.seq },
        shadowedSeqs: [plan.seq],
        shadowedTokenCount,
      })
      session.append(
        'tool/result',
        { ...event.data, message: { ...message, content: plan.content } },
        {
          surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq },
          sourceEventSeqs: [plan.seq],
        },
      )
      applied += 1
      state.appends += 1
      if (session.surface.replaceGeneration <= generation) {
        // Defensive: a landed replacement must advance the generation. If it did
        // not, stop instead of re-planning against an unchanged surface.
        warn(ctx, 'context-diet: replacement landed without a surface generation change')
        break
      }
    } catch (error) {
      state.failures += 1
      warn(ctx, `context-diet: replacement rejected at seq ${plan.seq}: ${String(error)}`)
      break
    }
  }

  state.passes += 1
  state.lastPass = { at: Date.now(), planned: plans.length, applied }
  return applied
}

/** Minimal Standard-Schema-shaped validator for the projection state. */
function createStateSchema() {
  const check = (value) => value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.elided === 'number'
    && typeof value.refetched === 'number'
    && Array.isArray(value.signatures)
    && Array.isArray(value.pending)
  const parse = (value) => {
    if (!check(value)) throw new TypeError('contextDiet projection state is malformed')
    return value
  }
  return {
    parse,
    '~standard': {
      version: 1,
      vendor: 'dsh-context-diet',
      validate: (value) => (check(value) ? { value } : { issues: [{ message: 'malformed contextDiet state' }] }),
    },
  }
}

function initProjectionState() {
  return { elided: 0, refetched: 0, signatures: [], pending: [], tools: {} }
}

/** Signature used for the re-fetch counter: exact tool name + arguments. */
function callSignature(event) {
  const data = event.data
  if (data === undefined || typeof data.name !== 'string') return undefined
  return `${data.name}\u0000${typeof data.arguments === 'string' ? data.arguments : ''}`
}

/**
 * Pure, synchronous fold behind the durable counters. A landed stub is detected
 * by its marker; a later call with the same signature counts as a re-fetch.
 * @param state - previous state (never mutated).
 * @param event - one committed session event.
 * @returns the next state, or the same reference when uninterested.
 */
function foldProjection(state, event) {
  if (event.type === 'tool/call') {
    const signature = callSignature(event)
    if (signature === undefined) return state
    const name = event.data.name
    const pending = [...state.pending, { id: String(event.data.callId ?? ''), signature }].slice(-MAX_TRACKED)
    if (!state.signatures.includes(signature)) return { ...state, pending }
    return {
      ...state,
      pending,
      refetched: state.refetched + 1,
      tools: { ...state.tools, [name]: (state.tools[name] ?? 0) + 1 },
    }
  }
  if (event.type === 'tool/result' && event.surfaceOp !== 'append') {
    const message = event.data === undefined ? undefined : event.data.message
    const blocks = message === undefined ? undefined : message.content
    if (!Array.isArray(blocks) || !isStubbed(blocks)) return state
    const callId = String(message.source?.callId ?? '')
    const entry = state.pending.find((item) => item.id === callId)
    if (entry === undefined) return { ...state, elided: state.elided + 1 }
    if (state.signatures.includes(entry.signature)) return { ...state, elided: state.elided + 1 }
    return {
      ...state,
      elided: state.elided + 1,
      signatures: [...state.signatures, entry.signature].slice(-MAX_TRACKED),
    }
  }
  return state
}

/** Conservative policy used when `core.resolvePolicy` cannot answer. */
const FALLBACK_POLICY = Object.freeze({
  enabled: false,
  agePolicy: 'off',
  coldTtlMinutes: 5,
  keepTurns: 20,
  minChars: 1500,
  stubTailLines: 3,
  stubErrorLines: 3,
  maxPerPass: 8,
  neverElide: [],
})

function currentConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const value = {}
  for (const key of [
    'enabled', 'agePolicy', 'coldTtlMinutes', 'keepTurns', 'minChars',
    'stubTailLines', 'stubErrorLines', 'maxPerPass', 'neverElide',
  ]) {
    const field = source[key]
    value[key] = field !== null && typeof field === 'object' && typeof field.get === 'function'
      ? field.get()
      : field
  }
  return value
}

/** Resolve the live plugin config plus per-session command overrides into one
 * policy. Volatile Config values are stable references; read their current snapshot
 * for every operation so Settings edits take effect without plugin remount.
 */
function policyFor(config, state) {
  try {
    return resolvePolicy(currentConfig(config), state === undefined ? undefined : state.overrides)
  } catch (error) {
    return FALLBACK_POLICY
  }
}

/** Stats for `status`/`show`: the projection is optional. */
function statsOf(ctx, agent) {
  const projections = service(ctx, 'sessionProjections')
  if (projections === undefined || typeof projections.stateOf !== 'function') return undefined
  try {
    return projections.stateOf(agent.session, PROJECTION_KEY)
  } catch {
    return undefined
  }
}

/**
 * Append the recovery meter's current protection verdict to a status line.
 * Neutral (and byte-identical) when nothing is protected.
 * @param text - base status text.
 * @param state - per-session runtime state.
 * @returns text, with `protected=<tool,…>` when tools are protected.
 */
function withProtection(text, state) {
  const protectedTools = state === undefined ? undefined : state.protectedTools
  if (!(protectedTools instanceof Set) || protectedTools.size === 0) return text
  return `${text} protected=${[...protectedTools].join(',')}`
}

/**
 * `/context-diet` command handler. Every subcommand answers through the command
 * result text; nothing here starts a model turn.
 * @param ctx - plugin context (for optional compaction/service access).
 * @param config - live plugin config.
 * @returns the command handler.
 */
function createCommandHandler(ctx, config) {
  return (invocation) => {
    const agent = invocation.agent
    const state = sessionState(agent.session)
    const policy = policyFor(config, state)
    const command = parseCommand(typeof invocation.rawInput === 'string' ? invocation.rawInput : '')

    switch (command.kind) {
      case 'on':
      case 'off':
        state.overrides = { ...state.overrides, enabled: command.kind === 'on' }
        return { kind: 'success', text: `context-diet ${command.kind}` }
      case 'now':
        state.forceOnce = true
        return { kind: 'success', text: 'context-diet: next pre-step elides eligible results' }
      case 'keep':
        state.overrides = { ...state.overrides, keepTurns: command.turns }
        return { kind: 'success', text: `context-diet: keepTurns=${command.turns}` }
      case 'ttl':
        state.overrides = { ...state.overrides, coldTtlMinutes: command.minutes }
        return { kind: 'success', text: `context-diet: coldTtlMinutes=${command.minutes} (approximate)` }
      case 'mode':
        state.overrides = { ...state.overrides, agePolicy: command.mode }
        return { kind: 'success', text: `context-diet: agePolicy=${command.mode}` }
      case 'args':
        return {
          kind: 'error',
          text: 'context-diet: write/edit argument elision is not expressible on the DSH surface',
        }
      case 'compact': {
        const compaction = service(ctx, 'compaction')
        if (compaction === undefined || typeof compaction.compactNow !== 'function') {
          return {
            kind: 'error',
            text: 'context-diet: compaction service is not visible from the host plane (preset realm)',
          }
        }
        if (command.action === 'on' || command.action === 'off') {
          state.overrides = { ...state.overrides, autoCompact: command.action === 'on' }
          return { kind: 'success', text: `context-diet: autoCompact=${command.action}` }
        }
        const run = compaction.compactNow(agent, new AbortController().signal)
        if (run && typeof run.catch === 'function') {
          run.catch((error) => warn(ctx, `context-diet: compact failed: ${String(error)}`))
        }
        return { kind: 'success', text: 'context-diet: compaction requested' }
      }
      case 'show': {
        const text = statusText({
          policy,
          overrides: state.overrides,
          stats: statsOf(ctx, agent),
          lastPass: state.lastPass,
          detailed: true,
        })
        return { kind: 'success', text: withProtection(text, state) }
      }
      case 'invalid':
        return {
          kind: 'error',
          text: command.message ?? 'usage: /context-diet [status|on|off|now|keep n|ttl min|mode|show]',
        }
      case 'status':
      default: {
        const text = statusText({
          policy,
          overrides: state.overrides,
          stats: statsOf(ctx, agent),
          lastPass: state.lastPass,
        })
        return { kind: 'success', text: withProtection(text, state) }
      }
    }
  }
}

/**
 * Mount the policy plugin.
 *
 * @param ctx - the plugin context.
 * @param config - validated plugin config (may be absent in focused tests).
 */
export function apply(ctx, config) {
  const live = config === undefined || config === null ? {} : config

  // 1) Durable counters (optional service: degrade to no counters).
  const projections = service(ctx, 'sessionProjections')
  if (projections !== undefined && typeof projections.register === 'function') {
    // The service registers on its own fiber, so bind the returned disposer to
    // ours; otherwise the unit would outlive this plugin across unload/HMR.
    const mountProjection = () => {
      try {
        return projections.register({
          key: PROJECTION_KEY,
          stateSchema: createStateSchema(),
          init: initProjectionState,
          apply: foldProjection,
          stateVersion: PROJECTION_VERSION,
        })
      } catch (error) {
        warn(ctx, `context-diet: projection unavailable: ${String(error)}`)
        return undefined
      }
    }
    if (ctx.effect) ctx.effect(mountProjection)
    else mountProjection()
  }

  // 2) Pre-step policy: observe, replace, and always continue the turn.
  ctx.on('agent/pre-step', async (payload, next) => {
    let state
    try {
      const agent = payload === undefined ? undefined : payload.agent
      const signal = payload === undefined ? undefined : payload.signal
      if (agent === undefined || agent.session === undefined) return next()
      if (signal !== undefined && signal.aborted) return next()
      state = sessionState(agent.session)
      // Keep the compaction lock, call index and recovery meter current even
      // while the policy is off, so toggling it on does not start cold.
      scanLog(agent.session, state)
      const policy = policyFor(live, state)
      const forced = state.forceOnce
      if (!policy.enabled && !forced) return next()
      const effective = forced ? { ...policy, enabled: true, agePolicy: 'always' } : policy
      if (forced) state.forceOnce = false
      elideStale(ctx, agent, effective, state, signal)
    } catch (error) {
      // Fail-open: a policy error must never break the turn.
      if (state !== undefined) state.failures += 1
      warn(ctx, `context-diet: pre-step failed open: ${String(error)}`)
    }
    return next()
  })

  // 3) Drop per-session runtime state with the agent.
  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (agent !== undefined && agent.session !== undefined) sessions.delete(agent.session)
    } catch {
      /* best effort */
    }
  })

  // 4) Human surface (optional service: degrade to no command).
  const commands = service(ctx, 'commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    const mount = () => {
      try {
        const dispose = commands.register({
          name: 'context-diet',
          description: 'Inspect or tune stale tool-result elision for this session.',
          handler: createCommandHandler(ctx, live),
        })
        return typeof dispose === 'function' ? dispose : undefined
      } catch (error) {
        warn(ctx, `context-diet: command unavailable: ${String(error)}`)
        return undefined
      }
    }
    if (ctx.effect) ctx.effect(mount)
    else mount()
  }

}
