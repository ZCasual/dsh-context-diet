/**
 * Real-Session contract tests: the parts of the Host adapter that only the
 * installed `@deepseek-ai/dsh-session` (0.2.1-rc.5) can prove.
 *
 * Covers the durable replacement protocol (prune shadow price + 1:1
 * `tool/result` replacement), surface/replay idempotency, concurrent passes,
 * rich content, fail-open on a rejected replacement, the compaction lock, and
 * the read-only stats endpoint the Client footer polls.
 *
 * Policy gates (cold/keepTurns/minChars/keepErrors/neverElide/recovery) live in
 * `session.test.js`; the pure core is covered by `parity.test.js`.
 *
 * Run: node --test test/session-contract.test.js
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import {
  MIN,
  NOW,
  Session,
  appendTurn,
  bigText,
  callRoute,
  freezeClock,
  isReplacementSurfaceEvent,
  mountPlugin,
  nextEnter,
  replacedSeqs,
  replacements,
  restoreClock,
  richContent,
  setClock,
  testing,
} from './helpers/harness.js'

beforeEach(() => freezeClock(NOW))
afterEach(() => restoreClock())

const signal = () => new AbortController().signal
const preStep = (session) => ({ agent: { session }, messages: [], turn: 1, step: 1, signal: signal() })
const config = (over = {}) => ({ enabled: true, keepTurns: 1, minChars: 200, ...over })

/** One eligible result (turn 0 of 3): the turn-0 result has two assistant turns after it. */
function oneEligible(options = {}) {
  const session = Session.create(options.id ?? 'contract')
  const results = []
  for (let turn = 0; turn < 3; turn += 1) {
    results.push(appendTurn(session, { turn, callId: `call-${turn}`, content: options.content ?? undefined }))
  }
  return { session, results }
}

/** Mount the plugin with a deterministic token meter and the stats endpoint. */
function mountWithRoute(over = {}) {
  return mountPlugin(config(over), {
    withWebServer: true,
    tokenMeter: { estimateMessage: () => 128 },
  })
}

// ---------------------------------------------------------------------------
// Replacement shape: prune shadow price first, then the 1:1 tool/result replace
// ---------------------------------------------------------------------------

test('a landed replacement is: compaction/prune, then tool/result replace citing the shadowed seq', async () => {
  const { session, results } = oneEligible({ id: 'shape' })
  const targetSeq = results[0].resultSeq
  const original = session.eventAt(targetSeq)
  const originalData = structuredClone(original.data)
  const before = session.ownEvents().length
  const h = mountWithRoute()
  setClock(NOW + 6 * MIN)

  await h.emitPreStep(preStep(session), nextEnter())

  const appended = session.ownEvents().slice(before)
  assert.deepEqual(appended.map((event) => event.type), ['compaction/prune', 'tool/result'])

  const price = appended[0]
  assert.deepEqual(price.data.shadowedRange, { start: targetSeq, end: targetSeq })
  assert.deepEqual(price.data.shadowedSeqs, [targetSeq])
  assert.equal(price.data.shadowedTokenCount, 128, 'priced through the tokenMeter service')

  const replacement = appended[1]
  assert.equal(isReplacementSurfaceEvent(replacement), true)
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: targetSeq, endSeq: targetSeq })
  assert.deepEqual(replacement.sourceEventSeqs, [targetSeq])
  assert.equal(replacement.data.message.source.callId, original.data.message.source.callId, 'call identity preserved')
  assert.equal(replacement.data.turn, original.data.turn)
  assert.equal(replacement.data.step, original.data.step)
  assert.equal(replacement.data.message.role, 'tool')
  assert.equal(replacement.data.message.toolCallId, original.data.message.toolCallId)
  assert.equal(typeof replacement.data.message.id, 'string')

  // Only `message.content` may differ (the platform enforces this too).
  const strip = (event) => ({ ...event.data, message: { ...event.data.message, content: null } })
  assert.deepEqual(strip(replacement), strip(original))

  // The stub is the frozen core template.
  const text = replacement.data.message.content[0].text
  assert.equal(text.startsWith('[context-diet: the output of bash echo probe ('), true, text)
  assert.equal(text.includes('was elided from the context to save tokens. Re-run it if you need it again.'), true, text)
  assert.equal(text.endsWith(']'), true, text)

  // The shadowed log event is unchanged; only the surface points at the copy.
  assert.deepEqual(session.eventAt(targetSeq).data, originalData)
  assert.equal(session.surface.nodes.includes(targetSeq), false)
  assert.equal(session.surface.nodes.includes(replacement.seq), true)
  assert.equal(session.surface.replaceGeneration, 1)
})

test('a pass appends nothing but its prune records and replacements', async () => {
  const { session } = oneEligible({ id: 'events-only' })
  const h = mountWithRoute()
  const before = session.ownEvents().length
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())
  const types = session.ownEvents().slice(before).map((event) => event.type)
  assert.deepEqual(types, ['compaction/prune', 'tool/result'])
})

test('the stub keeps the error lines and tail lines of the original output', async () => {
  const body = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n') + '\nerror: link failed\nexit 2'
  const session = Session.create('preview')
  appendTurn(session, { turn: 0, callId: 'c0', content: [{ type: 'text', text: body }] })
  appendTurn(session, { turn: 1, callId: 'c1', content: [{ type: 'text', text: 'small' }] })
  appendTurn(session, { turn: 2, callId: 'c2', content: [{ type: 'text', text: 'small' }] })
  const h = mountWithRoute({ stubTailLines: 1, stubErrorLines: 2 })
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())

  const replacement = replacements(session)[0]
  const text = replacement.data.message.content[0].text
  // tail = the last line only, so the error line is not shadowed by it
  assert.equal(text.includes('error lines:\n  error: link failed'), true, text)
  assert.equal(text.includes('last lines:\n  exit 2'), true, text)
  assert.equal(text.indexOf('error lines:') < text.indexOf('last lines:'), true)
})

// ---------------------------------------------------------------------------
// Replay and idempotency: a replacement is terminal, not re-planned
// ---------------------------------------------------------------------------

test('replay reconstructs the same surface and a fresh plugin instance appends nothing', async () => {
  const { session } = oneEligible({ id: 'replay' })
  const h = mountWithRoute()
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.surface.replaceGeneration, 1)

  const replay = Session.create('replay-replayed', session.ownEvents())
  assert.deepEqual(replay.surface.nodes, session.surface.nodes)
  assert.equal(replay.surface.replaceGeneration, session.surface.replaceGeneration)
  assert.deepEqual(replay.deriveMessages(), session.deriveMessages())

  const seqBefore = replay.seq
  const nodesBefore = [...replay.surface.nodes]
  const fresh = mountWithRoute() // a different plugin instance: no WeakMap state
  setClock(NOW + 60 * MIN)
  await fresh.emitPreStep(preStep(replay), nextEnter())
  assert.equal(replay.seq, seqBefore, 'nothing left to elide: no new events')
  assert.deepEqual(replay.surface.nodes, nodesBefore)
  assert.equal(replay.surface.replaceGeneration, 1)

  // The original session is terminal too.
  const originalSeq = session.seq
  await fresh.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.seq, originalSeq, 'landed replacements are never re-planned')
})

test('concurrent pre-steps cannot double-replace the same node', async () => {
  const session = Session.create('concurrent')
  const results = []
  for (let turn = 0; turn < 4; turn += 1) {
    results.push(appendTurn(session, { turn, callId: `c${turn}` }))
  }
  // keepTurns 1 over 4 turns -> turns 0 and 1 are eligible (ages 3 and 2).
  const h = mountWithRoute()
  const seqBefore = session.seq
  setClock(NOW + 6 * MIN)

  await Promise.all([
    h.emitPreStep(preStep(session), nextEnter()),
    h.emitPreStep(preStep(session), nextEnter()),
    h.emitPreStep(preStep(session), nextEnter()),
  ])

  assert.equal(session.surface.replaceGeneration, 2, 'both eligible nodes landed exactly once')
  assert.equal(session.seq - seqBefore, 4, 'one prune + one replacement per node, no duplicates')
  const targets = replacedSeqs(session)
  assert.equal(new Set(targets).size, targets.length, 'each target replaced at most once')
  assert.deepEqual(
    [...targets].sort((a, b) => a - b),
    [results[0].resultSeq, results[1].resultSeq].sort((a, b) => a - b),
  )
})

// ---------------------------------------------------------------------------
// Rich content is never elided
// ---------------------------------------------------------------------------

test('rich content (image and file blocks) is never elided and stays byte-identical', async () => {
  const session = Session.create('rich')
  const content = [...richContent('rich'), { type: 'file', path: 'src/big.ts', mediaType: 'text/plain' }]
  appendTurn(session, { turn: 0, callId: 'rich-call', content })
  appendTurn(session, { turn: 1, callId: 'c1', content: [{ type: 'text', text: 'small' }] })
  appendTurn(session, { turn: 2, callId: 'c2', content: [{ type: 'text', text: 'small' }] })
  const h = mountWithRoute()
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())

  assert.equal(session.surface.replaceGeneration, 0, 'a non-plain result is not a candidate')
  const original = session.ownEvents().find((event) => event.type === 'tool/result')
  assert.deepEqual(original.data.message.content, content)
})

// ---------------------------------------------------------------------------
// Fail-open: a rejected replacement never breaks the turn
// ---------------------------------------------------------------------------

test('a rejected replacement fails open: the turn enters, no surface change, the rejection is logged', async () => {
  const { session } = oneEligible({ id: 'rejected' })
  const targetSeq = session.ownEvents().find((event) => event.type === 'tool/result').seq
  const seqBefore = session.seq
  const originalAppend = session.append.bind(session)
  let rejected = 0
  session.append = (type, data, intent) => {
    if (type === 'tool/result' && intent?.surfaceOp !== undefined && typeof intent.surfaceOp === 'object') {
      rejected += 1
      throw new Error('session rejected the replacement')
    }
    return originalAppend(type, data, intent)
  }

  const h = mountWithRoute()
  setClock(NOW + 6 * MIN)
  const next = { kind: 'enter', messages: [{ role: 'user' }] }
  const result = await h.emitPreStep(preStep(session), next)

  assert.equal(rejected, 1, 'exactly one replacement was attempted, then the loop stopped')
  assert.equal(result, next, 'fail-open: the next() result is returned unchanged')
  assert.equal(session.surface.replaceGeneration, 0, 'no surface change landed')
  assert.equal(session.seq - seqBefore, 1, 'only the shadow price landed; no half-written replacement exists')
  assert.equal(session.eventAt(targetSeq).data.message.content[0].text, bigText('out-0'), 'the shadowed content is intact')
  assert.ok(h.warnings.some((line) => line.includes('replacement rejected')), JSON.stringify(h.warnings))
})

// ---------------------------------------------------------------------------
// Compaction lock: the native pruner owns the surface during a bracket
// ---------------------------------------------------------------------------

test('an open compaction bracket defers the pass until compaction/end', async () => {
  const { session } = oneEligible({ id: 'bracket' })
  session.append('compaction/start', { compactionId: 'compact-1', turn: null })
  const h = mountWithRoute()
  setClock(NOW + 6 * MIN)
  const seqDuringBracket = session.seq
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.seq, seqDuringBracket, 'no elision while a compaction holds the lock')
  assert.equal(session.surface.replaceGeneration, 0)

  session.append('compaction/end', { compactionId: 'compact-1', turn: null })
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.surface.replaceGeneration, 1, 'the next pass after the bracket elides')
})

// ---------------------------------------------------------------------------
// Stats endpoint (read-only, unauthenticated requests rejected, no session)
// ---------------------------------------------------------------------------

test('the stats route is an exact GET path returning the Host-formatted payload', async () => {
  const h = mountWithRoute()
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].kind, 'exact')
  assert.equal(h.routes[0].path, testing.STATS_ENDPOINT)
  assert.equal(testing.STATS_ENDPOINT, '/context-diet/stats')

  const { session } = oneEligible({ id: 'endpoint-session' })
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())

  const { res, json } = callRoute(h.routes[0], { url: testing.STATS_ENDPOINT })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(json.schemaVersion, 1)
  assert.equal(json.sessionId, 'endpoint-session')
  assert.equal(typeof json.config, 'object')
  assert.equal(json.config.keepTurns, 1)
  assert.equal(json.config.minChars, 200)
  // The endpoint reports the adapter's effective config: `elideArgs` is pinned
  // to false because DSH cannot rewrite a tool-call's arguments (see the
  // Config comment in index.js), matching what statusLine renders ("kept").
  assert.equal(json.config.elideArgs, false, 'adapter pins elideArgs false')
  const configKeys = Object.keys(json.config)
  assert.equal(configKeys.filter((key) => key !== 'elideArgs').length, 12, 'the 12 Config fields')
  assert.equal(configKeys.length, 13, 'plus the pinned elideArgs = the 13 fields of impl-contract §2')
  // No legacy adapter config may leak into the payload.
  for (const legacy of ['agePolicy', 'maxPerPass', 'compact', 'compactAboveTokens', 'warmArbitration', 'expectedTurns', 'stopWarmingShare']) {
    assert.equal(legacy in json.config, false, `legacy config key "${legacy}" must not be served`)
  }
  assert.deepEqual(Object.keys(json.stats).sort(), [
    'coldStarts',
    'cumulativeChars',
    'lastArgCount',
    'lastChars',
    'lastCount',
    'lastPassAt',
    'requests',
  ])
  assert.equal(json.stats.lastCount, 1)
  assert.equal(json.stats.requests, 1)
  assert.equal(json.stats.lastChars > 0, true)
  assert.deepEqual(Object.keys(json.recovery).sort(), ['elided', 'protectedTools', 'recovered', 'recoveredChars'])
  assert.equal(json.recovery.elided, 1)
  assert.deepEqual(Object.keys(json.estimate).sort(), ['charsPerToken', 'measured', 'samples'])
  assert.equal(json.estimate.charsPerToken, 3)
  assert.match(json.footer, /^🥗 −[\d.]+(?:k|M)? \/req · [\d.]+(?:k|M)? saved$/)
})

test('the stats route reports "no session" as null/empty instead of failing', async () => {
  const h = mountWithRoute()
  const { res, json } = callRoute(h.routes[0], { url: testing.STATS_ENDPOINT })
  assert.equal(res.status, 200)
  assert.equal(json.sessionId, null)
  assert.equal(json.footer, '')
  assert.equal(json.stats.lastCount, 0)
  assert.equal(json.stats.requests, 0)
  assert.deepEqual(json.recovery.protectedTools, [])
})

test('the stats route selects the session named by ?sessionId, else the most recent one', async () => {
  const h = mountWithRoute()
  const first = Session.create('session-a')
  const second = Session.create('session-b')
  await h.emitPreStep(preStep(first), nextEnter())
  await h.emitPreStep(preStep(second), nextEnter())

  const latest = callRoute(h.routes[0], { url: testing.STATS_ENDPOINT }).json
  assert.equal(latest.sessionId, 'session-b', 'the most recently active session wins')

  const explicit = callRoute(h.routes[0], { url: `${testing.STATS_ENDPOINT}?sessionId=session-a` }).json
  assert.equal(explicit.sessionId, 'session-a')
})

test('the stats route is read-only: POST/PUT/DELETE return 405 with an Allow header', async () => {
  const h = mountWithRoute()
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { res, json } = callRoute(h.routes[0], { method })
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.allow, 'GET, HEAD')
    assert.equal(json, undefined, 'no JSON body for a method rejection')
  }
})

test('HEAD returns headers with no body', async () => {
  const h = mountWithRoute({})
  const { res } = callRoute(h.routes[0], { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(res.body, undefined)
  assert.equal(typeof res.headers['content-length'], 'string')
})

test('an unauthenticated request (connection.requestRejection 401) is rejected', async () => {
  const h = mountPlugin(config(), {
    withWebServer: true,
    services: { connection: { requestRejection: () => 401 } },
  })
  const { res, json } = callRoute(h.routes[0], { url: testing.STATS_ENDPOINT })
  assert.equal(res.status, 401)
  assert.equal(json.code, 'unauthenticated')
  assert.equal(json.message.includes('authentication required'), true)
})

test('a cross-origin request (connection.requestRejection 403) is rejected as forbidden', async () => {
  const h = mountPlugin(config(), {
    withWebServer: true,
    services: { connection: { requestRejection: () => 403 } },
  })
  const { res, json } = callRoute(h.routes[0], { url: testing.STATS_ENDPOINT })
  assert.equal(res.status, 403)
  assert.equal(json.code, 'forbidden')
})

test('an admitted request from the connection check proceeds normally', async () => {
  const h = mountPlugin(config(), {
    withWebServer: true,
    services: { connection: { requestRejection: () => undefined } },
  })
  const { res } = callRoute(h.routes[0], { url: testing.STATS_ENDPOINT })
  assert.equal(res.status, 200)
})
