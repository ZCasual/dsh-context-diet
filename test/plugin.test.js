/**
 * Focused tests for the Host-half plugin `index.js`.
 *
 * Runs against the *real* plugin module. Two things are supplied by this file:
 *
 *  1. A resolver hook so the plugin's bare `@deepseek-ai/schemastery` import
 *     resolves out of the installed DSH tree (this workspace is not a package
 *     with node_modules); see `test/helpers/dsh.js`. Override with `DSH_NODE_MODULES`.
 *  2. A `./core.js` contract double when `core.js`
 *     does not exist yet, or exists but does not yet expose the v1 contract
 *     (`REQUIRED_CORE_EXPORTS`). The probe below re-enables the real core
 *     automatically as soon as repo-scout's core lands on contract.
 *
 * Covered here (fast, integration-shaped, no real agent loop):
 *   - named exports only (name/inject/Config/apply, no default)
 *   - no-op when disabled
 *   - safe degradation when services are missing or throw
 *   - dispose removes every registration
 *   - command parsing and command results
 *   - pre-step never mutates the payload it receives
 *   - the 1:1 durable replacement shape (prune + tool/result), abort,
 *     compaction lock, and partial-failure fail-open behaviour
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { registerHooks } from 'node:module'
// Installs the bare-specifier resolver for the installed Harness tree.
import './helpers/dsh.js'

// ---------------------------------------------------------------------------
// Module resolution: installed DSH packages + optional core.js contract double
// ---------------------------------------------------------------------------

const PLUGIN_URL = new URL('../index.js', import.meta.url)
const CORE_URL = new URL('./core.js', PLUGIN_URL)

// Contract double: mirrors the `core.js` v1 contract documented in index.js.
const CORE_DOUBLE_SOURCE = `
export const STUB_MARKER = '[context-diet: result elided]'
export function isStubbed(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'text'
    && typeof b.text === 'string' && b.text.startsWith(STUB_MARKER))
}
const DEFAULTS = {
  enabled: false, agePolicy: 'approximate', coldTtlMinutes: 5, keepTurns: 20,
  minChars: 1500, stubTailLines: 3, stubErrorLines: 3, maxPerPass: 8, neverElide: [],
}
export function resolvePolicy(config, overrides) {
  const policy = { ...DEFAULTS, ...(config || {}), ...(overrides || {}) }
  if (typeof policy.keepTurns !== 'number' || policy.keepTurns < 0) throw new TypeError('keepTurns')
  return policy
}
export function planElisions(snapshot, policy) {
  const plans = []
  for (const node of snapshot.nodes) {
    if (!node.plain || node.isError) continue
    if (node.chars < policy.minChars) continue
    if (node.turn > snapshot.maxTurn - policy.keepTurns) continue
    if (policy.neverElide.includes(node.toolName)) continue
    if (isStubbed(node.message.content)) continue
    plans.push({
      seq: node.seq,
      charsBefore: node.chars,
      charsAfter: 64,
      content: [{ type: 'text', text: STUB_MARKER + ' ' + node.toolName + ' (' + node.chars + ' chars)' }],
    })
    if (plans.length >= policy.maxPerPass * 2) break
  }
  return { plans }
}
export function parseCommand(rawInput) {
  const parts = String(rawInput || '').trim().split(/\\s+/).filter(Boolean)
  const head = parts[0] === undefined ? '' : parts[0]
  const value = parts[1]
  if (head === '' || head === 'status') return { kind: 'status' }
  if (head === 'on' || head === 'off') return { kind: head }
  if (head === 'now') return { kind: 'now' }
  if (head === 'show') return { kind: 'show' }
  if (head === 'args') return { kind: 'args', value }
  if (head === 'compact') {
    if (value === 'on' || value === 'off') return { kind: 'compact', action: value }
    if (value === 'now') return { kind: 'compact', action: 'now' }
    return { kind: 'invalid', message: 'usage: /context-diet compact <on|off|now>' }
  }
  if (head === 'keep') {
    const turns = Number(value)
    return Number.isInteger(turns) && turns > 0
      ? { kind: 'keep', turns }
      : { kind: 'invalid', message: 'usage: /context-diet keep <turns>' }
  }
  if (head === 'ttl') {
    const minutes = Number(value)
    return Number.isInteger(minutes) && minutes > 0
      ? { kind: 'ttl', minutes }
      : { kind: 'invalid', message: 'usage: /context-diet ttl <minutes>' }
  }
  if (head === 'mode') {
    return value === 'off' || value === 'approximate' || value === 'always'
      ? { kind: 'mode', mode: value }
      : { kind: 'invalid', message: 'usage: /context-diet mode <off|approximate|always>' }
  }
  return { kind: 'invalid', message: 'unknown subcommand' }
}
export function statusText(state) {
  const stats = state.stats || { elided: 0, refetched: 0 }
  const pass = state.lastPass ? ' last=' + state.lastPass.applied + '/' + state.lastPass.planned : ''
  return 'context-diet: ' + (state.policy.enabled ? 'on' : 'off')
    + ' mode=' + state.policy.agePolicy + ' keep=' + state.policy.keepTurns
    + ' elided=' + stats.elided + ' refetched=' + stats.refetched + pass
}
`
const CORE_DOUBLE_URL = `data:text/javascript;base64,${Buffer.from(CORE_DOUBLE_SOURCE, 'utf8').toString('base64')}`

/** The v1 core contract `index.js` imports (see its header comment). */
const REQUIRED_CORE_EXPORTS = ['isStubbed', 'parseCommand', 'planElisions', 'resolvePolicy', 'statusText']

/**
 * Probe the real core without loading it through the plugin: `core.js` is pure
 * and import-free, so a direct dynamic import is enough. A core on the old
 * Pi-style API (pre-DSH adapter exports) is reported and the contract double is
 * used instead, so this suite stays meaningful while the core is rewritten.
 * @returns whether `./core.js` satisfies the v1 contract.
 */
async function coreProvidesContract() {
  if (!existsSync(CORE_URL)) return false
  try {
    const core = await import(CORE_URL.href)
    return REQUIRED_CORE_EXPORTS.every((name) => typeof core[name] === 'function')
  } catch {
    return false
  }
}

const CORE_READY = await coreProvidesContract()
const useCoreDouble = !CORE_READY

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './core.js' && context.parentURL === PLUGIN_URL.href) {
      if (useCoreDouble) return { url: CORE_DOUBLE_URL, shortCircuit: true }
      return next(specifier, context)
    }
    return next(specifier, context)
  },
})

const plugin = await import(PLUGIN_URL.href)

// ---------------------------------------------------------------------------
// Fakes: a session surface faithful to the replacement contract, plus a ctx
// ---------------------------------------------------------------------------

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

function toolResultEvent(seq, options = {}) {
  const content = options.content ?? [{ type: 'text', text: 'x'.repeat(options.chars ?? 4000) }]
  return {
    type: 'tool/result',
    seq,
    time: options.time ?? 1_000,
    data: {
      turn: options.turn ?? 0,
      step: 0,
      message: {
        role: 'tool',
        content,
        source: { kind: 'tool', callId: options.callId ?? `call-${seq}` },
        ...(options.isError === true ? { isError: true } : {}),
      },
    },
  }
}

/**
 * A recent surface node whose `turn` raises the session's maxTurn, so older
 * tool results fall outside `keepTurns`. DSH derives maxTurn from surface nodes.
 * @param seq - log position.
 * @param turn - the turn this node belongs to.
 * @returns a fake `user/message` event.
 */
function userMessageEvent(seq, turn) {
  return {
    type: 'user/message',
    seq,
    time: 1_500,
    data: { turn, message: { role: 'user', content: [{ type: 'text', text: 'recent' }] } },
  }
}

function createFakeSession(events = []) {
  const log = []
  const cache = new Map()
  const nodes = []
  let replaceGeneration = 0
  for (const event of events) {
    log.push(event)
    cache.set(event.seq, event)
    if (SURFACE_TYPES.has(event.type)) nodes.push(event.seq)
  }
  const session = {
    id: 'session-1',
    get seq() {
      return log.length
    },
    get surface() {
      return { nodes: [...nodes], replaceGeneration, contentGeneration: 0 }
    },
    eventAt(seq) {
      return cache.get(seq)
    },
    deriveEventMessage(event) {
      return event.data?.message ?? null
    },
    append(type, data, opts = {}) {
      if (session.failNextAppend && SURFACE_TYPES.has(type)) {
        session.failNextAppend = false
        throw new Error('surface replacement rejected')
      }
      const seq = log.length
      const event = {
        type,
        seq,
        time: 2_000,
        data,
        ...(opts.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }),
        ...(opts.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
      }
      log.push(event)
      cache.set(seq, event)
      if (SURFACE_TYPES.has(type)) {
        const op = opts.surfaceOp ?? 'append'
        if (op === 'append') nodes.push(seq)
        else {
          const index = nodes.indexOf(op.startSeq)
          if (index === -1) throw new Error(`replace start ${op.startSeq} missing`)
          nodes[index] = seq
          replaceGeneration += 1
        }
      }
      return event
    },
  }
  return session
}

function createHarness(options = {}) {
  const listeners = new Map()
  const disposers = []
  const services = {
    tokenMeter: { estimateMessage: () => 128 },
    sessionProjections: { register: () => () => {}, stateOf: () => undefined },
    commands: {
      register: (definition) => {
        harness.command = definition
        return () => {
          harness.command = undefined
        }
      },
    },
    ...(options.services ?? {}),
  }
  const harness = {
    session: options.session ?? createFakeSession(),
    services,
    command: undefined,
    registered: [],
    ctx: undefined,
  }
  harness.agent = { session: harness.session, status: 'running' }
  harness.ctx = {
    logger: { warn: (message) => harness.warnings.push(message) },
    warnings: [],
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      const off = () => {
        const index = list.indexOf(listener)
        if (index !== -1) list.splice(index, 1)
      }
      disposers.push(off)
      return off
    },
    effect(fn) {
      const dispose = fn()
      const off = () => {
        if (typeof dispose === 'function') dispose()
      }
      disposers.push(off)
      return off
    },
    get(name) {
      return services[name]
    },
    dispose() {
      for (const off of disposers.splice(0).reverse()) off()
      listeners.clear()
    },
    async emitPreStep(payload, nextResult = { kind: 'enter', messages: [] }) {
      const list = listeners.get('agent/pre-step') ?? []
      let call = () => Promise.resolve(nextResult)
      for (const listener of [...list].reverse()) {
        const downstream = call
        call = () => listener(payload, downstream)
      }
      return call()
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
  }
  harness.warnings = harness.ctx.warnings
  return harness
}

/** Test config: enabled, always-on age policy, tiny thresholds. */
const ENABLED = { enabled: true, agePolicy: 'always', keepTurns: 1, minChars: 10, maxPerPass: 4 }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('core contract status (diagnostic)', (t) => {
  t.diagnostic(useCoreDouble
    ? 'core.js is not on the v1 adapter contract yet: integration tests use the contract double'
    : 'core.js satisfies the v1 adapter contract: integration tests use the real core')
})

test('exports the cordis plugin contract with no default export', () => {
  assert.equal(plugin.name, 'context-diet')
  assert.deepEqual(plugin.inject, ['tokenMeter', 'sessionProjections', 'commands'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.default, undefined, 'a default export would drop inject in the Loader')
  assert.ok(plugin.Config, 'Config must be a Standard Schema')
  assert.equal(typeof plugin.Config['~standard'], 'object')
  const defaults = plugin.Config({})
  assert.equal(defaults.enabled, true, 'context diet is on by default')
  assert.equal(defaults.agePolicy, 'approximate')
  assert.equal(defaults.keepTurns, 20)
  assert.deepEqual(defaults.neverElide, [])
  for (const field of Object.values(plugin.Config.dict)) {
    assert.notEqual(field.meta.volatile, true, 'settings writes use the configEditor endpoint path')
  }
})

test('no-op when disabled: no appends, payload untouched, next result preserved', async () => {
  const session = createFakeSession([toolResultEvent(0, { turn: 0, chars: 9000 })])
  const h = createHarness({ session })
  plugin.apply(h.ctx, {})
  const payload = { agent: h.agent, messages: [{ role: 'user' }], turn: 3, step: 1, signal: new AbortController().signal }
  const nextResult = { kind: 'enter', messages: payload.messages }
  const result = await h.ctx.emitPreStep(payload, nextResult)
  assert.equal(result, nextResult, 'must return the next() result unchanged')
  assert.equal(session.seq, 1, 'no events appended while disabled')
  assert.equal(h.ctx.listenerCount('agent/pre-step'), 1)
})

test('missing services degrade: apply succeeds and pre-step still continues', async () => {
  const h = createHarness({ services: { tokenMeter: undefined, sessionProjections: undefined, commands: undefined }, session: createFakeSession([]) })
  assert.doesNotThrow(() => plugin.apply(h.ctx, ENABLED))
  const payload = { agent: h.agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const result = await h.ctx.emitPreStep(payload, { kind: 'enter', messages: [] })
  assert.equal(result.kind, 'enter')
  assert.equal(h.command, undefined, 'no command registered without commands service')
})

test('a throwing service is caught: projection/command failures do not fail apply', () => {
  const h = createHarness({
    services: {
      sessionProjections: { register: () => { throw new Error('projection boom') } },
      commands: { register: () => { throw new Error('command boom') } },
    },
  })
  assert.doesNotThrow(() => plugin.apply(h.ctx, ENABLED))
  assert.ok(h.warnings.some((line) => line.includes('projection unavailable')))
  assert.ok(h.warnings.some((line) => line.includes('command unavailable')))
})

test('dispose removes listeners and the command registration', () => {
  let commandDisposed = false
  const h = createHarness({
    services: {
      commands: {
        register: () => {
          h.command = { name: 'context-diet' }
          return () => {
            commandDisposed = true
            h.command = undefined
          }
        },
      },
    },
  })
  plugin.apply(h.ctx, ENABLED)
  assert.ok(h.command, 'command registered')
  assert.equal(h.ctx.listenerCount('agent/pre-step'), 1)
  h.ctx.dispose()
  assert.equal(h.ctx.listenerCount('agent/pre-step'), 0, 'pre-step listener removed')
  assert.equal(commandDisposed, true, 'command disposer ran')
  assert.equal(h.command, undefined)
})

test('projection registration is bound to the plugin fiber', () => {
  let projectionDisposed = false
  const h = createHarness({
    services: {
      sessionProjections: {
        register: () => () => {
          projectionDisposed = true
        },
        stateOf: () => undefined,
      },
    },
  })
  plugin.apply(h.ctx, ENABLED)
  assert.equal(projectionDisposed, false, 'unit stays registered while the plugin is active')
  h.ctx.dispose()
  assert.equal(projectionDisposed, true, 'unit unregisters with the plugin (no cross-unload leak)')
})

test('command parsing: status/on/off/now/keep/ttl/mode/show/args/compact/invalid', () => {
  const h = createHarness()
  plugin.apply(h.ctx, ENABLED)
  const run = (rawInput) => h.command.handler({ agent: h.agent, rawInput, commandId: 'c1' })

  assert.equal(run('').kind, 'success')
  assert.match(run('').text, /context-diet: on/)
  assert.equal(run('status').kind, 'success')
  assert.match(run('show').text, /elided=0/)

  assert.deepEqual(run('on'), { kind: 'success', text: 'context-diet on' })
  assert.deepEqual(run('off'), { kind: 'success', text: 'context-diet off' })
  assert.equal(run('now').kind, 'success')
  assert.match(run('keep 5').text, /keepTurns=5/)
  assert.match(run('ttl 30').text, /coldTtlMinutes=30/)
  assert.match(run('mode always').text, /agePolicy=always/)

  assert.equal(run('args on').kind, 'error', 'argument elision is unsupported on the DSH surface')
  assert.match(run('args on').text, /not expressible/)
  assert.equal(run('compact now').kind, 'error', 'compaction lives in the preset realm')
  assert.match(run('compact now').text, /preset realm/)

  const invalid = run('bogus')
  assert.equal(invalid.kind, 'error')
  assert.match(invalid.text, /usage|unknown/)
})

test('pre-step does not mutate the payload it receives', async () => {
  const session = createFakeSession([toolResultEvent(0, { turn: 0, chars: 9000 })])
  const h = createHarness({ session })
  plugin.apply(h.ctx, { ...ENABLED, agePolicy: 'always' })
  const messages = [{ role: 'user', content: 'hi' }]
  const signal = new AbortController().signal
  const payload = { agent: h.agent, messages, turn: 2, step: 1, signal }
  const snapshot = JSON.stringify(payload, (key, value) => (key === 'signal' ? '[signal]' : value))
  const nextResult = { kind: 'enter', messages }
  const result = await h.ctx.emitPreStep(payload, nextResult)
  assert.equal(result, nextResult)
  assert.deepEqual(payload.messages, messages, 'messages array untouched')
  assert.equal(payload.turn, 2)
  assert.equal(JSON.stringify(payload, (key, value) => (key === 'signal' ? '[signal]' : value)), snapshot)
})

test('elides an eligible stale result as prune + 1:1 tool/result replacement', async () => {
  const original = toolResultEvent(0, { turn: 0, chars: 9000, callId: 'call-a' })
  const session = createFakeSession([original, userMessageEvent(1, 5)])
  const h = createHarness({ session })
  plugin.apply(h.ctx, { ...ENABLED, agePolicy: 'always' })
  await h.ctx.emitPreStep({ agent: h.agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal }, { kind: 'enter', messages: [] })

  assert.equal(session.seq, 4, 'prune + replacement appended; warnings=' + JSON.stringify(h.warnings))
  const prune = session.eventAt(2)
  const replacement = session.eventAt(3)
  assert.equal(prune.type, 'compaction/prune')
  assert.deepEqual(prune.data.shadowedSeqs, [0])
  assert.deepEqual(prune.data.shadowedRange, { start: 0, end: 0 })
  assert.equal(prune.data.shadowedTokenCount, 128, 'priced through tokenMeter')

  assert.equal(replacement.type, 'tool/result')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
  assert.deepEqual(replacement.sourceEventSeqs, [0])
  assert.deepEqual(replacement.data.message.source, original.data.message.source, 'call identity preserved')
  assert.equal(replacement.data.turn, original.data.turn, 'turn/step metadata preserved')
  assert.notDeepEqual(replacement.data.message.content, original.data.message.content, 'content changed')
  assert.deepEqual(session.surface.nodes, [3, 1], 'surface now points at the replacement')
})

test('aborted pre-step does nothing', async () => {
  const session = createFakeSession([toolResultEvent(0, { turn: 0, chars: 9000 })])
  const h = createHarness({ session })
  plugin.apply(h.ctx, ENABLED)
  const controller = new AbortController()
  controller.abort()
  await h.ctx.emitPreStep({ agent: h.agent, messages: [], turn: 2, step: 1, signal: controller.signal }, { kind: 'enter', messages: [] })
  assert.equal(session.seq, 1)
})

test('an open compaction bracket defers the pass', async () => {
  const session = createFakeSession([
    { type: 'compaction/start', seq: 0, time: 1, data: {} },
    toolResultEvent(1, { turn: 0, chars: 9000 }),
  ])
  const h = createHarness({ session })
  plugin.apply(h.ctx, ENABLED)
  await h.ctx.emitPreStep({ agent: h.agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal }, { kind: 'enter', messages: [] })
  assert.equal(session.seq, 2, 'no appends while compaction owns the surface')
})

test('partial failure fails open: earlier replacement stays, turn continues', async () => {
  const session = createFakeSession([
    toolResultEvent(0, { turn: 0, chars: 9000, callId: 'call-a' }),
    toolResultEvent(1, { turn: 0, chars: 9000, callId: 'call-b' }),
    userMessageEvent(2, 5),
  ])
  const h = createHarness({ session })
  plugin.apply(h.ctx, { ...ENABLED, maxPerPass: 4 })
  session.failNextAppend = false
  // Fail the *second* replacement's tool/result append.
  const realAppend = session.append
  let surfaceAppends = 0
  session.append = (type, data, opts) => {
    if (SURFACE_TYPES.has(type)) {
      surfaceAppends += 1
      if (surfaceAppends === 2) throw new Error('rejected by surface validator')
    }
    return realAppend(type, data, opts)
  }
  const nextResult = { kind: 'enter', messages: [] }
  const result = await h.ctx.emitPreStep({ agent: h.agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal }, nextResult)
  assert.equal(result, nextResult, 'fail-open: turn still enters')
  assert.equal(session.eventAt(3).type, 'compaction/prune', 'first prune landed')
  assert.equal(session.eventAt(4).type, 'tool/result', 'first replacement landed')
  assert.ok(h.warnings.some((line) => line.includes('rejected at seq')), 'failure is logged')
})
