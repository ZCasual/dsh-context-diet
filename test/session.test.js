/**
 * Real-Session policy tests for the DSH adapter.
 *
 * These drive the actual `@deepseek-ai/dsh-session` `Session` (0.2.1-rc.5) and
 * the real plugin through its `agent/pre-step` waterfall. They are the policy
 * contract: cold gate, keepTurns/minChars/keepErrors/neverElide boundaries,
 * forced passes, recovery protection, footer text and the platform conclusion
 * about write/edit argument elision.
 *
 * Time is controlled by freezing `Date.now` (see `helpers/harness.js`), because
 * both `Session.append` and the core cold gate read it; nothing sleeps.
 *
 * Run: node --test test/session.test.js
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { Calibrator, RecoveryMeter } from '../core.js'
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
  setClock,
  testing,
} from './helpers/harness.js'

beforeEach(() => freezeClock(NOW))
afterEach(() => restoreClock())

const signal = () => new AbortController().signal
const preStep = (session, sig = signal()) => ({ agent: { session }, messages: [], turn: 1, step: 1, signal: sig })

/** Append `turns` identical-shaped turns; each result is `chars` long text. */
function conversation(turns, options = {}) {
  const {
    chars = 4000,
    name = 'bash',
    args = (index) => ({ command: `echo step ${index}` }),
    isError = false,
    content = (index) => [{ type: 'text', text: bigText(`out-${index}`) }],
  } = options
  const session = Session.create(options.id ?? 'session')
  const results = []
  for (let index = 0; index < turns; index += 1) {
    const appended = appendTurn(session, {
      turn: index,
      callId: `call-${index}`,
      name,
      args: args(index),
      content: content(index),
      isError,
      ...(isError ? { error: { name: 'CommandError', code: 'EXIT_1', reason: 'exit status 1' } } : {}),
    })
    results.push(appended)
  }
  return { session, results, chars }
}

const config = (over = {}) => ({ enabled: true, keepTurns: 1, minChars: 200, ...over })

/** A 3-turn session whose turn-0 result is eligible (ages = 2 > keepTurns = 1). */
function threeTurns(over = {}) {
  return conversation(3, over)
}

// ---------------------------------------------------------------------------
// 1) Cold gate: the biggest old bug was "no signal ⇒ cold" (now: no signal ⇒
//    warm/not-elided). These assertions pin the direction.
// ---------------------------------------------------------------------------

test('cold gate: a recent last-assistant timestamp keeps the pass warm (no replacement)', async () => {
  const { session, results } = threeTurns({ id: 'warm' })
  const h = mountPlugin(config())
  const seqBefore = session.seq

  await h.emitPreStep(preStep(session), nextEnter())

  assert.equal(session.seq, seqBefore, 'warm cache: no events appended')
  assert.equal(session.surface.replaceGeneration, 0)
  assert.deepEqual(replacedSeqs(session), [])
  assert.equal(h.warnings.length, 0)
  assert.equal(session.eventAt(results[0].resultSeq).data.message.content[0].text.startsWith('[context-diet:'), false)
})

test('cold gate: exactly at the ttl stays warm, one ms past it elides', async () => {
  const { session, results } = threeTurns({ id: 'ttl' })
  const h = mountPlugin(config()) // cacheTtlMinutes default 5

  setClock(NOW + 5 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.surface.replaceGeneration, 0, 'now - last === ttl is still warm (strict >)')

  setClock(NOW + 5 * MIN + 1)
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.surface.replaceGeneration, 1, 'one ms past the ttl is cold')
  assert.deepEqual(replacedSeqs(session), [results[0].resultSeq])
})

test('cold gate: no assistant timestamp means never cold (no replacement, no idle heuristic)', async () => {
  // A session with a big tool result but no assistant/message event at all:
  // `lastAssistantTimestamp()` is undefined, so `isCold()` is false. This is
  // the opposite of the old DSH behaviour ("no request header ⇒ Infinity ⇒
  // cold"), which would have elided on the very first pass.
  const session = Session.create('no-timestamp')
  const callSeq = session.append('tool/call', {
    turn: 0,
    step: 1,
    callId: 'orphan',
    name: 'bash',
    arguments: JSON.stringify({ command: 'echo orphan' }),
  }).seq
  const resultSeq = session.append(
    'tool/result',
    {
      turn: 0,
      step: 1,
      message: {
        role: 'tool',
        id: 'tool-orphan',
        content: [{ type: 'text', text: bigText('orphan') }],
        source: { kind: 'tool', callId: 'orphan' },
        toolCallId: 'orphan',
      },
    },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] },
  ).seq
  const h = mountPlugin(config())
  const seqBefore = session.seq

  setClock(NOW + 60 * MIN) // a long idle period must not help: there is no timestamp
  await h.emitPreStep(preStep(session), nextEnter())

  assert.equal(session.seq, seqBefore)
  assert.equal(session.surface.replaceGeneration, 0)
  assert.equal(session.eventAt(resultSeq).data.message.content[0].text, bigText('orphan'))
})

// ---------------------------------------------------------------------------
// 2) mode=always and /context-diet now
// ---------------------------------------------------------------------------

test('mode=always elides even while the cache is warm', async () => {
  const { session, results } = threeTurns({ id: 'always' })
  const h = mountPlugin(config({ mode: 'always' }))
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.surface.replaceGeneration, 1)
  assert.deepEqual(replacedSeqs(session), [results[0].resultSeq])
})

test('/context-diet now forces exactly one pass, then the gate closes again', async () => {
  const { session, results } = threeTurns({ id: 'force-once' })
  const h = mountPlugin(config())
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.surface.replaceGeneration, 0, 'warm pass: nothing elided')

  const forced = h.registered.command.handler({ agent: { session }, args: 'now' })
  assert.equal(forced.kind, 'success')
  assert.equal(forced.text.includes('eliding stale results on the next step'), true)

  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.surface.replaceGeneration, 1, 'the forced pass elides while still warm')
  assert.deepEqual(replacedSeqs(session), [results[0].resultSeq])

  const seqAfterForcedPass = session.seq
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.seq, seqAfterForcedPass, 'force is consumed by exactly one pass')
  assert.equal(session.surface.replaceGeneration, 1)
})

// ---------------------------------------------------------------------------
// 3) keepTurns: ages == keepTurns is kept; ages > keepTurns is eligible
// ---------------------------------------------------------------------------

test('keepTurns boundary: only results strictly older than keepTurns are elided', async () => {
  const { session, results } = threeTurns({ id: 'keep-turns' })
  const h = mountPlugin(config({ keepTurns: 1 }))
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())

  // turn k has (2 - k) assistant messages after it, so only turn 0 (ages 2 > 1)
  // is eligible; turn 1 (ages 1 === keepTurns) must be kept intact.
  assert.deepEqual(replacedSeqs(session), [results[0].resultSeq])
  assert.equal(session.eventAt(results[1].resultSeq).data.message.content[0].text, bigText('out-1'))
  assert.equal(session.eventAt(results[2].resultSeq).data.message.content[0].text, bigText('out-2'))
})

// ---------------------------------------------------------------------------
// 4) minChars: `chars == minChars` is eligible (core uses `< minChars` to skip)
// ---------------------------------------------------------------------------

test('minChars boundary: exactly minChars is elided, one character less is kept', async () => {
  const exact = 'x'.repeat(2000)
  const under = 'x'.repeat(1999)

  const at = Session.create('min-chars-at')
  const atTurns = []
  for (let turn = 0; turn < 3; turn += 1) {
    atTurns.push(
      appendTurn(at, {
        turn,
        callId: `call-${turn}`,
        content: [{ type: 'text', text: turn === 0 ? exact : 'small' }],
      }),
    )
  }
  const hAt = mountPlugin(config({ minChars: 2000 }))
  setClock(NOW + 6 * MIN)
  await hAt.emitPreStep(preStep(at), nextEnter())
  assert.deepEqual(replacedSeqs(at), [atTurns[0].resultSeq], 'chars === minChars is eligible')

  setClock(NOW) // a fresh session must start on the frozen clock again
  const underSession = Session.create('min-chars-under')
  const underTurns = []
  for (let turn = 0; turn < 3; turn += 1) {
    underTurns.push(
      appendTurn(underSession, {
        turn,
        callId: `call-${turn}`,
        content: [{ type: 'text', text: turn === 0 ? under : 'small' }],
      }),
    )
  }
  const hUnder = mountPlugin(config({ minChars: 2000 }))
  setClock(NOW + 6 * MIN)
  await hUnder.emitPreStep(preStep(underSession), nextEnter())
  assert.deepEqual(replacedSeqs(underSession), [], 'chars === minChars - 1 is too small')
  assert.equal(underSession.eventAt(underTurns[0].resultSeq).data.message.content[0].text, under)
})

// ---------------------------------------------------------------------------
// 5) keepErrors
// ---------------------------------------------------------------------------

test('keepErrors=true keeps an isError result; keepErrors=false lets it be elided', async () => {
  const kept = Session.create('errors-kept')
  const keptError = appendTurn(kept, {
    turn: 0,
    callId: 'err-0',
    content: [{ type: 'text', text: bigText('failure') }],
    isError: true,
    error: { name: 'CommandError', code: 'EXIT_1', reason: 'exit status 1' },
  })
  appendTurn(kept, { turn: 1, callId: 'k1', content: [{ type: 'text', text: 'small' }] })
  appendTurn(kept, { turn: 2, callId: 'k2', content: [{ type: 'text', text: 'small' }] })
  const hKept = mountPlugin(config())
  setClock(NOW + 6 * MIN)
  await hKept.emitPreStep(preStep(kept), nextEnter())
  assert.deepEqual(replacedSeqs(kept), [], 'default keepErrors keeps the error result')
  assert.equal(kept.eventAt(keptError.resultSeq).data.message.isError, true, 'the error identity is preserved')

  setClock(NOW) // a fresh session must start on the frozen clock again
  const dropped = Session.create('errors-dropped')
  const droppedError = appendTurn(dropped, {
    turn: 0,
    callId: 'err-0',
    content: [{ type: 'text', text: bigText('failure') }],
    isError: true,
    error: { name: 'CommandError', code: 'EXIT_1', reason: 'exit status 1' },
  })
  appendTurn(dropped, { turn: 1, callId: 'd1', content: [{ type: 'text', text: 'small' }] })
  appendTurn(dropped, { turn: 2, callId: 'd2', content: [{ type: 'text', text: 'small' }] })
  const hDropped = mountPlugin(config({ keepErrors: false }))
  setClock(NOW + 6 * MIN)
  await hDropped.emitPreStep(preStep(dropped), nextEnter())
  assert.deepEqual(replacedSeqs(dropped), [droppedError.resultSeq], 'keepErrors=false makes the error result eligible')
  assert.equal(dropped.eventAt(droppedError.resultSeq).data.message.isError, true, 'the shadowed original is untouched')
})

// ---------------------------------------------------------------------------
// 6) neverElide and recovery protection (real tool/call events)
// ---------------------------------------------------------------------------

test('neverElide protects the named tool and leaves other eligible tools elided', async () => {
  const session = Session.create('never-elide')
  const bash = appendTurn(session, {
    turn: 0,
    callId: 'keep-bash',
    name: 'bash',
    content: [{ type: 'text', text: bigText('bash-out') }],
  })
  const read = appendTurn(session, {
    turn: 1,
    callId: 'drop-read',
    name: 'read',
    args: { path: 'big.ts' },
    content: [{ type: 'text', text: bigText('read-out') }],
  })
  appendTurn(session, {
    turn: 2,
    callId: 'bash-recent',
    name: 'bash',
    content: [{ type: 'text', text: 'small' }],
  })
  appendTurn(session, {
    turn: 3,
    callId: 'last',
    name: 'bash',
    content: [{ type: 'text', text: 'small' }],
  })
  const h = mountPlugin(config({ keepTurns: 1, neverElide: ['bash'] }))
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())

  const targets = replacedSeqs(session)
  assert.equal(targets.includes(bash.resultSeq), false, 'neverElide tool is skipped')
  assert.equal(targets.includes(read.resultSeq), true, 'the unprotected tool is elided')
  assert.equal(session.eventAt(bash.resultSeq).data.message.content[0].text, bigText('bash-out'))
})

test('recovery: re-fetching the same signature protects the tool for the rest of the session', async () => {
  const session = Session.create('recovery-protect')
  // Six DISTINCT call signatures are elided (one repayment per signature: a
  // repeated identical call repays every copy at once, so it can only add one
  // recovery event).
  for (let turn = 0; turn < 8; turn += 1) {
    appendTurn(session, {
      turn,
      callId: `r${turn}`,
      name: 'bash',
      args: { command: `cat log-${turn}` },
      content: [{ type: 'text', text: bigText(`repeat-${turn}`) }],
    })
  }
  const h = mountPlugin(config({ keepTurns: 1, minChars: 200 }))
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())
  // 8 turns, keepTurns 1 -> turns 0..5 are old enough (ages 7..2): 6 elided.
  assert.equal(session.surface.replaceGeneration, 6)

  // The agent re-issues two of the identical calls: 2/6 = 33% > 25% with >= 5
  // elided samples, so `bash` must be protected for the rest of the session.
  for (const turn of [8, 9]) {
    appendTurn(session, {
      turn,
      callId: `again-${turn}`,
      name: 'bash',
      args: { command: `cat log-${turn - 8}` },
      content: [{ type: 'text', text: bigText(`refetch-${turn}`) }],
    })
  }
  const generationBefore = session.surface.replaceGeneration
  setClock(NOW + 12 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())

  assert.equal(session.surface.replaceGeneration, generationBefore, 'protected tool: no new replacement')
  const status = h.registered.command.handler({ agent: { session }, args: 'status' })
  assert.equal(status.kind, 'success')
  assert.equal(status.text.includes('protected: bash'), true, status.text)
  assert.equal(status.text.includes('recovery: 2 of 6 elided results re-fetched'), true, status.text)
})

// ---------------------------------------------------------------------------
// 11) Write/edit argument elision: the platform cannot carry it.
//
// Measured conclusion (dsh-session 0.2.1-rc.5): an `assistant/message` surface
// replacement is impossible. Without `sourceEventSeqs` the platform rejects it
// ("surface replace: sourceEventSeqs must include every shadowed surface
// node"); with `sourceEventSeqs` it rejects it too ("assistant/message embeds
// its source stream and cannot carry sourceEventSeqs"). The adapter therefore
// pins `elideArgs: false` and never attempts the rewrite; these tests lock the
// resulting behaviour: fail-open with no half-product.
// ---------------------------------------------------------------------------

test('elideArgs: the adapter never attempts the impossible assistant replacement (no half-product in the log)', async () => {
  const session = Session.create('args-fail-open')
  const bigArgs = { path: 'src/a.ts', content: 'x'.repeat(5000) }
  const write = appendTurn(session, { turn: 0, callId: 'w-call', name: 'write', args: bigArgs, content: [{ type: 'text', text: 'ok' }] })
  appendTurn(session, { turn: 1, callId: 'c1', content: [{ type: 'text', text: 'small' }] })
  appendTurn(session, { turn: 2, callId: 'c2', content: [{ type: 'text', text: 'small' }] })
  const h = mountPlugin(config({ keepTurns: 1, minChars: 200 }))
  const seqBefore = session.seq
  setClock(NOW + 6 * MIN)

  const result = await h.emitPreStep(preStep(session), nextEnter())

  assert.deepEqual(result, nextEnter(), 'fail-open: the waterfall result is unchanged')
  assert.equal(session.seq, seqBefore, 'not a single event appended (no prune, no replacement)')
  assert.equal(session.surface.replaceGeneration, 0)
  assert.deepEqual(h.warnings, [], 'no rejection was even attempted')
  const assistant = session.eventAt(write.assistantSeq)
  assert.deepEqual(assistant.data.message.content[1].arguments, JSON.stringify(bigArgs), 'arguments stay byte-identical')
  const status = h.registered.command.handler({ agent: { session }, args: 'status' })
  assert.equal(status.text.includes('write/edit args kept'), true, status.text)
})

test('elideArgs: the platform itself rejects assistant/message replacement (documented in the test)', () => {
  const session = Session.create('args-platform')
  const write = appendTurn(session, {
    turn: 0,
    callId: 'w-call',
    name: 'write',
    args: { path: 'src/a.ts', content: 'x'.repeat(5000) },
    content: [{ type: 'text', text: 'ok' }],
  })
  const original = session.eventAt(write.assistantSeq)
  const current = session.deriveEventMessage(original)
  const nextMessage = {
    ...current,
    content: [{ type: 'tool-call', id: 'w-call', name: 'write', arguments: JSON.stringify({ path: 'src/a.ts', content: '[elided]' }) }],
  }

  // Without sourceEventSeqs: the replacement does not cover the shadowed node.
  assert.throws(
    () =>
      session.append(
        'assistant/message',
        { ...original.data, message: nextMessage },
        { surfaceOp: { op: 'replace', startSeq: write.assistantSeq, endSeq: write.assistantSeq } },
      ),
    /must include every shadowed surface node/,
  )
  // With sourceEventSeqs: assistant messages may not cite sources at all.
  assert.throws(
    () =>
      session.append(
        'assistant/message',
        { ...original.data, message: nextMessage },
        {
          surfaceOp: { op: 'replace', startSeq: write.assistantSeq, endSeq: write.assistantSeq },
          sourceEventSeqs: [write.assistantSeq],
        },
      ),
    /cannot carry sourceEventSeqs/,
  )
  // The two rules are mutually exclusive: no surface API can rewrite the call.
  assert.equal(session.surface.replaceGeneration, 0)
  assert.equal(session.eventAt(write.assistantSeq).data.message.content[1].arguments.includes('x'.repeat(5000)), true)
})

test('elideArgs: an assistant message with a reasoning block is never rewritten', async () => {
  const session = Session.create('args-reasoning')
  appendTurn(session, {
    turn: 0,
    callId: 'w-call',
    name: 'write',
    args: { path: 'a.ts', content: 'x'.repeat(3000) },
    content: [{ type: 'text', text: 'ok' }],
    assistantBlocks: [{ type: 'reasoning', text: 'thinking about it' }],
  })
  appendTurn(session, { turn: 1, callId: 'c1', content: [{ type: 'text', text: 'small' }] })
  appendTurn(session, { turn: 2, callId: 'c2', content: [{ type: 'text', text: 'small' }] })
  const h = mountPlugin(config({ keepTurns: 1, minChars: 200 }))
  const seqBefore = session.seq
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())
  assert.equal(session.seq, seqBefore, 'reasoning-bearing assistant messages are left untouched')
})

// ---------------------------------------------------------------------------
// 12) Footer: rendered from the Host state, not by the Client.
// ---------------------------------------------------------------------------

test('footer: after a replacement it reads "🥗 −x /req · y saved"', async () => {
  const { session } = threeTurns({ id: 'footer-saved' })
  const h = mountPlugin(config(), { withWebServer: true })
  setClock(NOW + 6 * MIN)
  await h.emitPreStep(preStep(session), nextEnter())
  const payload = callRoute(h.routes[0]).json
  assert.equal(typeof payload.footer, 'string')
  assert.match(payload.footer, /^🥗 −[\d.]+(?:k|M)? \/req · [\d.]+(?:k|M)? saved$/, payload.footer)
  assert.equal(payload.stats.lastCount, 1)
  assert.equal(payload.stats.requests, 1)
  assert.equal(payload.stats.lastChars > 0, true)
})

test('footer: with nothing elided yet it advertises the next-pause budget', async () => {
  const { session } = threeTurns({ id: 'footer-next' })
  const h = mountPlugin(config(), { withWebServer: true })
  await h.emitPreStep(preStep(session), nextEnter()) // warm: nothing elided
  const payload = callRoute(h.routes[0]).json
  assert.match(payload.footer, /^🥗 −[\d.]+(?:k|M)? at the next pause$/, payload.footer)
  assert.equal(payload.stats.lastCount, 0)
})

test('footer: an empty session (nothing to elide) says it is on', async () => {
  const session = Session.create('footer-on')
  const h = mountPlugin(config(), { withWebServer: true })
  await h.emitPreStep(preStep(session), nextEnter())
  const payload = callRoute(h.routes[0]).json
  assert.equal(payload.footer, '🥗 on')
})

test('footer: showStatus=false and enabled=false render the empty string', async () => {
  const hiddenSession = Session.create('footer-hidden')
  const hHidden = mountPlugin(config({ showStatus: false }), { withWebServer: true })
  await hHidden.emitPreStep(preStep(hiddenSession), nextEnter())
  assert.equal(callRoute(hHidden.routes[0]).json.footer, '')

  const offSession = Session.create('footer-off')
  const hOff = mountPlugin(config({ enabled: false }), { withWebServer: true })
  await hOff.emitPreStep(preStep(offSession), nextEnter())
  assert.equal(callRoute(hOff.routes[0]).json.footer, '')
})

test('footer: renderFooter is a pure function over the adapter state (no Session needed)', () => {
  const state = {
    calibrator: new Calibrator(),
    stats: { lastCount: 2, lastArgCount: 0, lastChars: 3000, cumulativeChars: 9000, requests: 2, coldStarts: 1, lastPassAt: 0 },
    lastMessages: [],
    elided: new Set(['a']),
    elidedArgs: new Set(),
    protectedTools: new Set(),
    meter: new RecoveryMeter(),
  }
  const text = testing.renderFooter(state, testing.adapterConfig({}))
  assert.match(text, /^🥗 −1\.0k \/req · 3\.0k saved$/, text)
  state.stats.lastCount = 0
  state.stats.lastChars = 0
  assert.equal(testing.renderFooter(state, testing.adapterConfig({})), '🥗 on')
  assert.equal(testing.renderFooter(state, testing.adapterConfig({ showStatus: false })), '')
})
