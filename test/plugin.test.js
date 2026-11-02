/**
 * Host-half unit/integration tests for `index.js` (Cordis contract + adapter
 * surface), using a fake host context — no real Session and no Harness.
 *
 * The real-Session behaviour lives in `session.test.js` / `session-contract.test.js`.
 * The pure strategy (`core.js`) is covered by `parity.test.js` (105 upstream
 * assertions) and is deliberately not re-tested here.
 *
 * Run: node --test test/plugin.test.js
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG } from '../core.js'
import {
  callRoute,
  createCtx,
  mountPlugin,
  plugin,
  testing,
} from './helpers/harness.js'

/** A session-shaped object that is enough for the command handler. */
const fakeSession = (id = 'cmd-session') => ({ id })

/** A session whose surface read throws: proves the abort path never reads it. */
function explodingSession(id = 'boom-session') {
  const session = {
    id,
    touched: false,
    get surface() {
      session.touched = true
      throw new Error('surface must not be read')
    },
    ownEvents() {
      return []
    },
    eventAt() {
      return undefined
    },
    deriveEventMessage() {
      return undefined
    },
  }
  return session
}

/** A minimal idle session: the adapter can read it but has nothing to elide. */
const idleSession = (id = 'idle-session') => ({
  id,
  surface: { nodes: [] },
  ownEvents: () => [],
  eventAt: () => undefined,
  deriveEventMessage: () => undefined,
})

const preStep = (agent, signal = new AbortController().signal) => ({
  agent,
  messages: [],
  turn: 1,
  step: 1,
  signal,
})

// ---------------------------------------------------------------------------
// Cordis plugin contract
// ---------------------------------------------------------------------------

test('exports the Cordis plugin contract: name, inject, Config, apply — no default export', () => {
  assert.equal(plugin.name, 'context-diet')
  assert.deepEqual(plugin.inject, ['commands'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.default, undefined, 'a default export would drop inject in the Loader')
  assert.ok(plugin.Config, 'Config must be a Standard Schema')
  assert.equal(typeof plugin.Config['~standard'], 'object')
})

test('Config defaults mirror the frozen core config, minus the platform-impossible elideArgs', () => {
  const defaults = plugin.Config({})
  assert.equal(defaults.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(defaults.mode, DEFAULT_CONFIG.mode)
  assert.equal(defaults.keepTurns, DEFAULT_CONFIG.keepTurns)
  assert.equal(defaults.minChars, DEFAULT_CONFIG.minChars)
  assert.equal(defaults.cacheTtlMinutes, DEFAULT_CONFIG.cacheTtlMinutes)
  assert.equal(defaults.keepErrors, DEFAULT_CONFIG.keepErrors)
  assert.deepEqual(defaults.neverElide, [])
  assert.equal(defaults.showStatus, DEFAULT_CONFIG.showStatus)
  assert.equal(defaults.stubTailLines, DEFAULT_CONFIG.stubTailLines)
  assert.equal(defaults.stubErrorLines, DEFAULT_CONFIG.stubErrorLines)
  assert.equal(defaults.autoProtect, DEFAULT_CONFIG.autoProtect)
  assert.equal(defaults.recoveryThreshold, DEFAULT_CONFIG.recoveryThreshold)
  assert.equal('elideArgs' in defaults, false, 'DSH cannot rewrite tool-call arguments, so the field is gone')
  assert.equal(Object.keys(defaults).length, 12)
})

test('__testing exposes the adapter contract and drops the removed translation helpers', () => {
  assert.equal(typeof testing.toPiBlock, 'function')
  assert.equal(typeof testing.adapterConfig, 'function')
  assert.equal(typeof testing.readSurface, 'function')
  assert.equal(typeof testing.observeLog, 'function')
  assert.equal(typeof testing.runPass, 'function')
  assert.equal(typeof testing.renderFooter, 'function')
  assert.equal(typeof testing.statsPayload, 'function')
  assert.equal(testing.STATS_ENDPOINT, '/context-diet/stats')
  assert.equal(testing.toDshBlock, undefined, 'assistant/message rewriting is impossible: helper removed')
  assert.equal(testing.changedToolCallIds, undefined)
})

test('adapterConfig pins elideArgs to false and applies the same clamps as the core', () => {
  const defaults = testing.adapterConfig({})
  assert.equal(defaults.elideArgs, false)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.keepTurns, 20)
  assert.equal(testing.adapterConfig({ elideArgs: true }, { elideArgs: true }).elideArgs, false)
  const merged = testing.adapterConfig({ keepTurns: 20, minChars: 1500 }, { keepTurns: 7, enabled: false })
  assert.equal(merged.keepTurns, 7)
  assert.equal(merged.enabled, false)
  assert.equal(testing.adapterConfig({ keepTurns: 9999 }).keepTurns, 500)
  assert.equal(testing.adapterConfig({ minChars: 1 }).minChars, 200)
})

test('toPiBlock translates DSH blocks into the pi shapes the core expects', () => {
  const call = testing.toPiBlock({ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' })
  assert.deepEqual(call, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } })
  assert.deepEqual(testing.toPiBlock({ type: 'tool-call', id: 'c2', name: 'bash', arguments: 'not json' }), {
    type: 'toolCall',
    id: 'c2',
    name: 'bash',
    arguments: {},
  })
  assert.deepEqual(testing.toPiBlock({ type: 'reasoning', text: 'hmm' }), { type: 'thinking', text: 'hmm' })
  const text = { type: 'text', text: 'hi' }
  assert.equal(testing.toPiBlock(text), text, 'plain blocks pass through by identity')
  assert.equal(testing.toPiBlock(null), null)
})

// ---------------------------------------------------------------------------
// Mounting without the optional services
// ---------------------------------------------------------------------------

test('apply succeeds without commands or webServer, and pre-step still continues', async () => {
  const h = mountPlugin({}, { withCommands: false })
  assert.equal(h.registered.command, undefined, 'no commands service: no registration attempted')
  assert.deepEqual(h.routes, [], 'no webServer service: no route mounted')
  const session = idleSession()
  const next = { kind: 'enter', messages: [] }
  const result = await h.emitPreStep(preStep({ session }), next)
  assert.equal(result, next, 'the waterfall always continues')
  assert.deepEqual(h.warnings, [])
})

test('a throwing commands service is caught and the plugin keeps working', async () => {
  const h = mountPlugin(
    {},
    { services: { commands: { register() { throw new Error('command boom') } } } },
  )
  assert.ok(h.warnings.some((line) => line.includes('command unavailable')), JSON.stringify(h.warnings))
  const result = await h.emitPreStep(preStep({ session: idleSession() }), { kind: 'enter' })
  assert.deepEqual(result, { kind: 'enter' })
})

test('apply with a webServer mounts the exact read-only stats route', () => {
  const h = mountPlugin({}, { withWebServer: true })
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].kind, 'exact')
  assert.equal(h.routes[0].path, testing.STATS_ENDPOINT)
  assert.equal(typeof h.routes[0].handler, 'function')
})

// ---------------------------------------------------------------------------
// Commands: the whole table (status/show/on/off/now/keep/ttl/mode/args/invalid)
// ---------------------------------------------------------------------------

/** Mount a plugin and return its registered command handler. */
function commandHarness(config = {}) {
  const h = mountPlugin(config)
  assert.ok(h.registered.command, 'the command must be registered')
  const session = fakeSession()
  return {
    h,
    run: (raw) => h.registered.command.handler({ agent: { session }, args: raw }),
  }
}

test('status reports the settings and the always-kept write/edit args', () => {
  const { run } = commandHarness()
  const status = run('status')
  assert.equal(status.kind, 'success')
  assert.equal(status.text.includes('context-diet: on · mode cold · keep last 20 turns'), true, status.text)
  assert.equal(status.text.includes('write/edit args kept'), true, 'adapter pins elideArgs false')
  assert.equal(status.text.includes('this session: 0 results elided'), true)
})

test('status works with no active session (defaults, no crash)', () => {
  const h = mountPlugin({})
  const status = h.registered.command.handler({ args: 'status' })
  assert.equal(status.kind, 'success')
  assert.equal(status.text.startsWith('context-diet: on · mode cold · keep last 20 turns'), true)
})

test('show lists what is elided now and what the next cold start would take', () => {
  const { run } = commandHarness()
  const show = run('show')
  assert.equal(show.kind, 'success')
  assert.equal(show.text.includes('elided now'), true, show.text)
  assert.equal(show.text.includes('next cold start'), true, show.text)
  assert.equal(show.text.includes('elided now: none'), true)
})

test('show without an active session answers instead of throwing', () => {
  const h = mountPlugin({})
  const show = h.registered.command.handler({ args: 'show' })
  assert.equal(show.kind, 'success')
  assert.equal(show.text, 'context-diet: no active session')
})

test('on / off / now / keep / ttl / mode return their exact session-scoped text', () => {
  const { run } = commandHarness()
  assert.deepEqual(run('on'), { kind: 'success', text: 'context-diet: on (this session)' })
  assert.deepEqual(run('off'), { kind: 'success', text: 'context-diet: off (this session)' })
  assert.deepEqual(run('now'), { kind: 'success', text: 'context-diet: eliding stale results on the next step' })
  assert.deepEqual(run('keep 7'), { kind: 'success', text: 'context-diet: keep last 7 turns (this session)' })
  assert.deepEqual(run('ttl 30'), { kind: 'success', text: 'context-diet: cache ttl 30 min (this session)' })
  assert.deepEqual(run('mode always'), { kind: 'success', text: 'context-diet: mode always (this session)' })
})

test('args on is refused with the platform explanation; args off confirms arguments stay kept', () => {
  const { run } = commandHarness()
  const on = run('args on')
  assert.equal(on.kind, 'error')
  assert.equal(on.text.includes('not expressible on the DSH surface'), true, on.text)
  assert.equal(on.text.includes('arguments stay kept'), true, on.text)
  const off = run('args off')
  assert.equal(off.kind, 'success')
  assert.equal(off.text.includes('kept (always on DSH)'), true, off.text)
})

test('invalid commands answer with the full USAGE text', () => {
  const { run } = commandHarness()
  const invalid = run('bogus')
  assert.equal(invalid.kind, 'error')
  assert.equal(invalid.text.includes('Unknown option "bogus"'), true)
  assert.equal(invalid.text.includes('Usage: /context-diet [status] · on · off · now'), true)
  for (const bad of ['keep 0', 'keep 501', 'ttl 0', 'ttl 1441', 'mode sometimes', 'args maybe']) {
    assert.equal(run(bad).kind, 'error', bad)
    assert.equal(run(bad).text.includes('Usage: /context-diet'), true, bad)
  }
})

test('compact is not implemented and is rejected as an unknown option', () => {
  const { run } = commandHarness()
  for (const raw of ['compact', 'compact on', 'compact off', 'compact now']) {
    const result = run(raw)
    assert.equal(result.kind, 'error', raw)
    assert.equal(result.text.includes('Unknown option "compact"'), true, raw)
    assert.equal(result.text.includes('Usage: /context-diet'), true, raw)
  }
})

// ---------------------------------------------------------------------------
// pre-step waterfall: abort, fail-open, disposal
// ---------------------------------------------------------------------------

test('an aborted pre-step changes nothing and never reads the session surface', async () => {
  const session = explodingSession()
  const h = mountPlugin({})
  const controller = new AbortController()
  controller.abort()
  const next = { kind: 'enter', messages: [] }
  const result = await h.emitPreStep(preStep({ session }, controller.signal), next)
  assert.equal(result, next)
  assert.equal(session.touched, false, 'aborted passes must not touch the surface')
  assert.deepEqual(h.warnings, [])
})

test('a throwing pass fails open: the turn still enters, the error is logged', async () => {
  const session = explodingSession()
  const h = mountPlugin({})
  const next = { kind: 'enter', messages: [{ role: 'user' }] }
  const result = await h.emitPreStep(preStep({ session }), next)
  assert.equal(result, next, 'fail-open: next() result is returned unchanged')
  assert.equal(session.touched, true)
  assert.ok(h.warnings.some((line) => line.includes('pre-step failed open')), JSON.stringify(h.warnings))
})

test('a payload without a session is a no-op that still continues', async () => {
  const h = mountPlugin({})
  const next = { kind: 'enter' }
  const result = await h.emitPreStep({ agent: {}, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, next)
  assert.equal(result, next)
  assert.deepEqual(h.warnings, [])
})

test('disposing the plugin removes its listeners and the command registration', () => {
  const h = mountPlugin({})
  assert.equal(h.listenerCount('agent/pre-step'), 1)
  assert.equal(h.listenerCount('agent/disposed'), 1)
  assert.ok(h.registered.command)
  h.ctx.dispose()
  assert.equal(h.listenerCount('agent/pre-step'), 0)
  assert.equal(h.listenerCount('agent/disposed'), 0)
  assert.equal(h.registered.command, undefined, 'the commands disposer ran')
})

test('agent/disposed releases the session from the stats endpoint', async () => {
  const h = mountPlugin({}, { withWebServer: true })
  const route = h.routes[0]
  const session = idleSession('live-session')
  await h.emitPreStep(preStep({ session }), { kind: 'enter' })

  const live = callRoute(route, { url: testing.STATS_ENDPOINT })
  assert.equal(live.res.status, 200)
  assert.equal(live.json.sessionId, 'live-session')
  assert.equal(typeof live.json.footer, 'string')

  h.emit('agent/disposed', { agent: { session } })
  const gone = callRoute(route, { url: testing.STATS_ENDPOINT })
  assert.equal(gone.res.status, 200)
  assert.equal(gone.json.sessionId, null)
  assert.equal(gone.json.footer, '')
})

test('agent/disposed tolerates junk events', () => {
  const h = mountPlugin({})
  assert.doesNotThrow(() => h.emit('agent/disposed', undefined))
  assert.doesNotThrow(() => h.emit('agent/disposed', {}))
  assert.doesNotThrow(() => h.emit('agent/disposed', { agent: {} }))
})
