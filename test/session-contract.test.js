/**
 * Real-Session contract tests for the Host-half plugin.
 *
 * The sibling `session.test.js` covers two happy paths against a real `Session`.
 * This file adds the contracts that only a real Session can prove, using the
 * exact event vocabulary and payload shapes the installed harness writes
 * (`tool/call` before `tool/result`, `request/header` for the idle gate,
 * surface replacement intents, replay through `Session.create`):
 *
 *   - replay: a log with landed replacements reconstructs the same surface
 *   - idempotency: a fresh plugin instance on a replayed session appends nothing
 *   - error results are never elided and keep their failure identity
 *   - rich content (non-text blocks) is never elided and stays byte-identical
 *   - the approximate idle gate uses the latest `request/header` time
 *   - concurrent pre-steps cannot double-replace the same node
 *   - the shadow-price + replacement shape matches the native pruner convention
 *   - a rejected replacement fails open and never breaks the turn
 *   - multi-pass elision respects `maxPerPass` without duplicates
 *   - re-fetch feedback protects a tool that keeps being called again
 *
 * Run: node --test test/session-contract.test.js
 * (from a checkout whose package root contains `index.js` and `core.js`)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSessionModule } from './helpers/dsh.js'

const { Session, isAppendSurfaceEvent, isReplacementSurfaceEvent } = await loadSessionModule()
const plugin = await import(new URL('../index.js', import.meta.url))

/** Tool-result message in the shape `createToolResultMessage` produces. */
function toolMessage(callId, content, isError = false) {
  return {
    role: 'tool',
    id: `tool-${callId}`,
    content,
    source: { kind: 'tool', callId },
    toolCallId: callId,
    ...(isError ? { isError: true } : {}),
  }
}

/**
 * Append one canonical turn: boundary events, the assistant message, the
 * `tool/call` the loop writes before dispatch, and the model-ordered
 * `tool/result` that cites it.
 */
function appendTurn(session, options) {
  const {
    turn,
    step = 1,
    callId,
    name = 'bash',
    args = { command: 'echo probe' },
    content,
    isError = false,
    error,
    meta,
  } = options
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    turn,
    step,
    message: {
      role: 'assistant',
      id: `assistant-${turn}-${callId}`,
      content: [{ type: 'text', text: `working on ${turn}` }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  const callSeq = session.append('tool/call', {
    turn,
    step,
    callId,
    name,
    arguments: JSON.stringify(args),
  }).seq
  session.append('tool/result', {
    turn,
    step,
    message: toolMessage(callId, content, isError),
    ...(error === undefined ? {} : { error }),
    ...(meta === undefined ? {} : { meta }),
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  return callSeq
}

const bigText = (label = 'output', lines = 400) =>
  Array.from({ length: lines }, (_, index) => `${label} line ${index}`).join('\n')

/** Mount the plugin with the minimal host surface it reads. */
function mount(config = {}, services = {}) {
  const listeners = []
  const warnings = []
  const registered = { command: undefined, projection: undefined }
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    get(name) {
      if (name === 'commands' && services.commands === undefined) {
        services.commands = {
          register(definition) {
            registered.command = definition
            return () => { if (registered.command === definition) registered.command = undefined }
          },
        }
      }
      if (name === 'sessionProjections' && services.sessionProjections === undefined) {
        services.sessionProjections = {
          register(definition) {
            registered.projection = definition
            return () => { if (registered.projection === definition) registered.projection = undefined }
          },
          stateOf: () => undefined,
        }
      }
      if (services[name] !== undefined) return services[name]
      if (name === 'tokenMeter') {
        return { estimateMessage: (message) => JSON.stringify(message?.content ?? '').length }
      }
      return undefined
    },
    on(name, listener) {
      if (name === 'agent/pre-step') listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  plugin.apply(ctx, config)
  return {
    warnings,
    listeners,
    registered,
    async preStep(agent, next = { kind: 'enter', messages: [] }) {
      let call = () => Promise.resolve(next)
      for (const listener of [...listeners].reverse()) {
        const downstream = call
        call = () => listener(
          { agent, messages: [], turn: 99, step: 1, signal: new AbortController().signal },
          downstream,
        )
      }
      return call()
    },
  }
}

const baseConfig = Object.freeze({
  enabled: true,
  agePolicy: 'always',
  coldTtlMinutes: 0,
  keepTurns: 0,
  minChars: 100,
  stubTailLines: 3,
  stubErrorLines: 3,
  maxPerPass: 8,
  neverElide: [],
})

const originals = (session) => session.ownEvents()
  .filter((event) => event.type === 'tool/result' && isAppendSurfaceEvent(event))

test('replay: a landed replacement reconstructs the same surface and model input', async () => {
  const session = Session.create('replay-contract')
  appendTurn(session, { turn: 0, callId: 'c-old', content: [{ type: 'text', text: bigText('old') }] })
  appendTurn(session, { turn: 2, callId: 'c-new', content: [{ type: 'text', text: 'short' }] })

  const mounted = mount(baseConfig)
  await mounted.preStep({ session })

  const before = originals(session)
    .map((event) => ({ seq: event.seq, content: structuredClone(event.data.message.content) }))
  assert.equal(session.surface.replaceGeneration, 1, 'exactly one replacement landed')

  const replay = Session.create('replay-contract-replay', session.ownEvents())
  assert.deepEqual(replay.surface.nodes, session.surface.nodes)
  assert.equal(replay.surface.replaceGeneration, session.surface.replaceGeneration)
  assert.deepEqual(replay.deriveMessages(), session.deriveMessages())

  // The append-origin transcript is model-independent: the original content is
  // still recoverable, and only the surface moved.
  assert.deepEqual(
    originals(session).map((event) => ({ seq: event.seq, content: event.data.message.content })),
    before,
  )
  assert.equal(replacementEvents(session).length, 1)
  assert.equal(originals(session).length, 2)
})

function replacementEvents(session) {
  return session.ownEvents().filter(
    (event) => event.type === 'tool/result' && isReplacementSurfaceEvent(event),
  )
}

test('idempotency: a fresh plugin instance on a replayed session appends nothing', async () => {
  const session = Session.create('idem-contract')
  appendTurn(session, { turn: 0, callId: 'a', content: [{ type: 'text', text: bigText('a') }] })
  appendTurn(session, { turn: 1, callId: 'b', content: [{ type: 'text', text: bigText('b') }] })

  await mount({ ...baseConfig, maxPerPass: 8 }).preStep({ session })
  assert.equal(session.surface.replaceGeneration, 2, 'both eligible nodes landed')

  const sessionSeqAfterFirstPass = session.seq
  const replay = Session.create('idem-contract-replay', session.ownEvents())
  const seqBefore = replay.seq
  const nodesBefore = [...replay.surface.nodes]
  const generationBefore = replay.surface.replaceGeneration

  // A different plugin instance has none of the first instance's WeakMap state:
  // idempotency has to come from the log, not from memory. Nothing is left to
  // elide, so the pass must append nothing and rewrite no node twice.
  await mount({ ...baseConfig, maxPerPass: 8 }).preStep({ session: replay })
  assert.equal(replay.seq, seqBefore, 'no new events on the replayed session')
  assert.deepEqual(replay.surface.nodes, nodesBefore)
  assert.equal(replay.surface.replaceGeneration, generationBefore)

  // A later pass on the original session is also a no-op: landed replacements
  // are terminal, not re-planned.
  await mount({ ...baseConfig, maxPerPass: 8 }).preStep({ session })
  assert.equal(session.seq, sessionSeqAfterFirstPass, 'the original session is also terminal')
  assert.equal(session.surface.replaceGeneration, generationBefore)
})

test('error results are never elided and keep their failure identity', async () => {
  const session = Session.create('error-contract')
  appendTurn(session, {
    turn: 0,
    callId: 'err',
    content: [{ type: 'text', text: bigText('failure', 300) }],
    isError: true,
    error: { name: 'CommandError', code: 'EXIT_1', reason: 'exit status 1' },
  })
  const seqBefore = session.seq
  const mounted = mount({ ...baseConfig, minChars: 1, stubTailLines: 0, stubErrorLines: 0 })
  await mounted.preStep({ session })

  assert.equal(session.seq, seqBefore, 'an error result is not a candidate')
  assert.equal(session.surface.replaceGeneration, 0)
  const event = session.ownEvents().find((candidate) => candidate.type === 'tool/result')
  assert.deepEqual(event.data.error, { name: 'CommandError', code: 'EXIT_1', reason: 'exit status 1' })
  assert.equal(event.data.message.isError, true)
})

test('rich content is never elided and stays byte-identical', async () => {
  const session = Session.create('rich-contract')
  const content = [
    { type: 'text', text: bigText('before-image', 200) },
    { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'text', text: bigText('after-image', 200) },
  ]
  appendTurn(session, { turn: 0, callId: 'rich', content })
  const seqBefore = session.seq
  const mounted = mount({ ...baseConfig, minChars: 1 })
  await mounted.preStep({ session })

  assert.equal(session.seq, seqBefore, 'a non-plain result is not a candidate')
  const event = session.ownEvents().find((candidate) => candidate.type === 'tool/result')
  assert.deepEqual(event.data.message.content, content, 'image and text blocks are untouched')
})

test('the approximate idle gate uses the latest request/header time', async () => {
  const warm = Session.create('warm-contract')
  appendTurn(warm, { turn: 0, callId: 'warm', content: [{ type: 'text', text: bigText('warm') }] })
  warm.append('request/header', { header: { config: { provider: 'test-provider', model: 'test-model' } }, reason: 'initial' })

  const warmMounted = mount({
    ...baseConfig,
    agePolicy: 'approximate',
    coldTtlMinutes: 60,
    minChars: 1,
  })
  await warmMounted.preStep({ session: warm })
  assert.equal(warm.surface.replaceGeneration, 0, 'a just-seen request is treated as warm')

  // fully expired TTL: the same session becomes eligible without any log change
  const coldMounted = mount({
    ...baseConfig,
    agePolicy: 'approximate',
    coldTtlMinutes: 0,
    minChars: 1,
  })
  await coldMounted.preStep({ session: warm })
  assert.equal(warm.surface.replaceGeneration, 1, 'expired idle window lets the pass run')
})

test('concurrent pre-steps cannot double-replace the same node', async () => {
  const session = Session.create('concurrent-contract')
  for (const turn of [0, 1, 2]) {
    appendTurn(session, { turn, callId: `c${turn}`, content: [{ type: 'text', text: bigText(`c${turn}`) }] })
  }
  const mounted = mount(baseConfig)
  const seqBefore = session.seq
  await Promise.all([
    mounted.preStep({ session }),
    mounted.preStep({ session }),
    mounted.preStep({ session }),
  ])

  assert.equal(session.surface.replaceGeneration, 3)
  assert.equal(session.seq - seqBefore, 6, 'one shadow price + one replacement per node, no duplicates')
  const perTarget = replacementEvents(session).map((event) => event.surfaceOp.startSeq)
  assert.deepEqual([...perTarget].sort((a, b) => a - b), [...new Set(perTarget)].sort((a, b) => a - b))
})

test('each replacement follows the native shadow-price convention', async () => {
  const session = Session.create('shape-contract')
  appendTurn(session, {
    turn: 0,
    callId: 'shape',
    content: [{ type: 'text', text: bigText('shape') }],
    meta: { card: 'diff', lines: 3 },
  })
  await mount(baseConfig).preStep({ session })

  const events = session.ownEvents()
  const replacement = events.find((event) => event.type === 'tool/result' && isReplacementSurfaceEvent(event))
  assert.ok(replacement, 'a replacement landed')
  const price = events[replacement.seq - 1]
  assert.equal(price.type, 'compaction/prune')
  assert.deepEqual(price.data.shadowedRange, {
    start: replacement.surfaceOp.startSeq,
    end: replacement.surfaceOp.startSeq,
  })
  assert.deepEqual(price.data.shadowedSeqs, [replacement.surfaceOp.startSeq])
  assert.equal(typeof price.data.shadowedTokenCount, 'number')

  assert.deepEqual(replacement.surfaceOp, {
    op: 'replace',
    startSeq: replacement.surfaceOp.startSeq,
    endSeq: replacement.surfaceOp.startSeq,
  })
  assert.deepEqual(replacement.sourceEventSeqs, [replacement.surfaceOp.startSeq])
  assert.equal(replacement.data.message.source.callId, 'shape')
  assert.deepEqual(replacement.data.meta, { card: 'diff', lines: 3 }, 'tool-private meta survives')
  assert.match(replacement.data.message.content[0].text, /\[context-diet: result elided\]/)
  const original = events[replacement.surfaceOp.startSeq]
  assert.equal(original.data.message.content[0].text, bigText('shape'), 'the shadowed event is unchanged')
})

test('a rejected replacement fails open and never breaks the turn', async () => {
  const session = Session.create('failopen-contract')
  appendTurn(session, { turn: 0, callId: 'reject', content: [{ type: 'text', text: bigText('reject') }] })
  const seqBefore = session.seq
  const originalAppend = session.append.bind(session)
  let rejected = 0
  session.append = (type, data, intent) => {
    if (type === 'tool/result' && intent !== undefined && typeof intent.surfaceOp === 'object') {
      rejected += 1
      throw new Error('session rejected the replacement')
    }
    return originalAppend(type, data, intent)
  }

  const mounted = mount(baseConfig)
  const decision = await mounted.preStep({ session })

  assert.equal(rejected, 1, 'the plugin attempted one replacement and stopped')
  assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'the turn still enters with the original decision')
  assert.equal(session.surface.replaceGeneration, 0, 'no surface change landed')
  assert.equal(session.seq - seqBefore, 1, 'only the shadow price landed; the failure is reported, not hidden')
  assert.ok(
    mounted.warnings.some((message) => message.includes('replacement rejected')),
    `a rejection warning is emitted, got: ${JSON.stringify(mounted.warnings)}`,
  )
})

test('multi-pass elision respects maxPerPass without duplicates', async () => {
  const session = Session.create('budget-contract')
  for (let turn = 0; turn < 12; turn += 1) {
    appendTurn(session, { turn, callId: `b${turn}`, content: [{ type: 'text', text: bigText(`b${turn}`) }] })
  }
  const mounted = mount({ ...baseConfig, maxPerPass: 5 })
  const landed = []
  for (let pass = 0; pass < 5; pass += 1) {
    const before = session.surface.replaceGeneration
    await mounted.preStep({ session })
    landed.push(session.surface.replaceGeneration - before)
  }
  assert.deepEqual(landed, [5, 5, 2, 0, 0])
  const targets = replacementEvents(session).map((event) => event.surfaceOp.startSeq)
  assert.equal(new Set(targets).size, 12, 'every eligible node replaced exactly once')
})

test('re-fetch feedback protects a tool that keeps being called again', async () => {
  const session = Session.create('recovery-contract')
  const args = { command: 'cat big.log' }
  for (let turn = 0; turn < 6; turn += 1) {
    appendTurn(session, {
      turn,
      callId: `r${turn}`,
      name: 'bash',
      args,
      content: [{ type: 'text', text: bigText(`repeat-${turn}`) }],
    })
  }
  const mounted = mount({ ...baseConfig, keepTurns: 0 })
  await mounted.preStep({ session })
  assert.equal(session.surface.replaceGeneration, 6, 'all six identical calls start elided')

  // The agent re-issues the identical call three times: 3/6 > 25% with >= 5
  // samples, so `bash` must be protected for the rest of the session.
  for (let turn = 6; turn < 9; turn += 1) {
    appendTurn(session, {
      turn,
      callId: `r${turn}`,
      name: 'bash',
      args,
      content: [{ type: 'text', text: bigText(`refetch-${turn}`) }],
    })
  }
  const generationBefore = session.surface.replaceGeneration
  await mounted.preStep({ session })

  const protectedTurns = [6, 7, 8]
  const elidedNew = replacementEvents(session)
    .filter((event) => event.surfaceOp.startSeq > 0)
    .map((event) => session.eventAt(event.surfaceOp.startSeq))
    .filter((event) => event !== undefined && protectedTurns.includes(event.data.turn))
  assert.deepEqual(elidedNew, [], 'a protected tool is no longer elided in this session')
  assert.equal(session.surface.replaceGeneration, generationBefore, 'protected tool: no new replacement')
})

test('a pass appends only its shadow price and replacement events', async () => {
  const session = Session.create('events-contract')
  appendTurn(session, { turn: 0, callId: 'e1', content: [{ type: 'text', text: bigText('e1') }] })
  appendTurn(session, { turn: 1, callId: 'e2', content: [{ type: 'text', text: bigText('e2') }] })
  const before = session.seq
  await mount(baseConfig).preStep({ session })

  const appended = session.ownEvents().filter((event) => event.seq >= before)
  assert.deepEqual(appended.map((event) => event.type), [
    'compaction/prune',
    'tool/result',
    'compaction/prune',
    'tool/result',
  ])
  assert.equal(appended.length, 4)
  assert.equal(appended.every((event) => event.type === 'tool/result' || event.type === 'compaction/prune'), true)
})

test('agePolicy off is inert except for a forced /context-diet now pass', async () => {
  const session = Session.create('command-contract')
  appendTurn(session, { turn: 0, callId: 'cmd', content: [{ type: 'text', text: bigText('cmd') }] })
  const mounted = mount({ ...baseConfig, agePolicy: 'off' })
  const run = (rawInput) => mounted.registered.command.handler({ agent: { session }, rawInput })

  await mounted.preStep({ session })
  assert.equal(session.surface.replaceGeneration, 0, 'agePolicy off: no automatic pass')

  const forced = run('now')
  assert.equal(forced.kind, 'success')
  await mounted.preStep({ session })
  assert.equal(session.surface.replaceGeneration, 1, '/context-diet now forces exactly one pass')
  await mounted.preStep({ session })
  assert.equal(session.surface.replaceGeneration, 1, 'the forced pass is consumed once')

  const status = run('status')
  assert.equal(status.kind, 'success')
  assert.ok(status.text.length > 0, 'status answers with text')
  const args = run('args')
  assert.equal(args.kind, 'error', 'write/edit argument elision is refused explicitly')
})

test('/context-diet off pauses and on resumes without a config change', async () => {
  const session = Session.create('toggle-contract')
  appendTurn(session, { turn: 0, callId: 't0', content: [{ type: 'text', text: bigText('t0') }] })
  const mounted = mount(baseConfig)
  const run = (rawInput) => mounted.registered.command.handler({ agent: { session }, rawInput })

  assert.equal(run('off').kind, 'success')
  appendTurn(session, { turn: 1, callId: 't1', content: [{ type: 'text', text: bigText('t1') }] })
  await mounted.preStep({ session })
  assert.equal(session.surface.replaceGeneration, 0, '/context-diet off pauses elision for the session')

  assert.equal(run('on').kind, 'success')
  await mounted.preStep({ session })
  assert.equal(session.surface.replaceGeneration, 2, '/context-diet on resumes and catches up')
})

test('durable counters fold deterministically over the real log', async () => {
  const session = Session.create('projection-contract')
  const args = { command: 'echo same' }
  appendTurn(session, { turn: 0, callId: 'p1', name: 'bash', args, content: [{ type: 'text', text: bigText('p1') }] })
  const mounted = mount(baseConfig)
  await mounted.preStep({ session })
  assert.equal(session.surface.replaceGeneration, 1)

  const definition = mounted.registered.projection
  assert.ok(definition !== undefined, 'the projection unit is registered with the plugin fiber')
  assert.equal(definition.key, 'contextDiet')
  assert.equal(definition.stateVersion, 1)

  const fold = () => session.ownEvents().reduce(
    (state, event) => definition.apply(state, event),
    definition.init(),
  )
  const first = fold()
  assert.equal(first.elided, 1, 'one landed stub is counted once')
  assert.equal(first.refetched, 0)

  appendTurn(session, { turn: 1, callId: 'p2', name: 'bash', args, content: [{ type: 'text', text: bigText('p2') }] })
  const second = fold()
  assert.equal(second.elided, 1)
  assert.equal(second.refetched, 1, 'an identical re-issued call is a re-fetch')

  assert.deepEqual(fold(), second, 'folding the same log twice is deterministic')
  assert.deepEqual(definition.stateSchema['~standard'].validate(second).issues, undefined)
})

test('neverElide matches the real tool/call name, not the message source only', async () => {
  const session = Session.create('never-elide-contract')
  appendTurn(session, { turn: 0, callId: 'keep-bash', name: 'bash', content: [{ type: 'text', text: bigText('bash') }] })
  appendTurn(session, { turn: 1, callId: 'drop-read', name: 'read', content: [{ type: 'text', text: bigText('read') }] })
  const bashSeq = session.ownEvents()
    .filter((event) => event.type === 'tool/result' && isAppendSurfaceEvent(event))
    .map((event) => event.seq)[0]
  await mount({ ...baseConfig, neverElide: ['bash'] }).preStep({ session })

  assert.equal(session.surface.replaceGeneration, 1)
  const replacedTargets = replacementEvents(session).map((event) => event.surfaceOp.startSeq)
  assert.equal(replacedTargets.includes(bashSeq), false, 'the protected tool is skipped')
  const bashEvent = session.eventAt(bashSeq)
  assert.equal(bashEvent.data.message.content[0].text, bigText('bash'), 'protected content untouched')
})

test('an open compaction bracket defers the pass until compaction/end', async () => {
  const session = Session.create('compaction-bracket-contract')
  appendTurn(session, { turn: 0, callId: 'locked', content: [{ type: 'text', text: bigText('locked') }] })
  session.append('compaction/start', { compactionId: 'compact-1', turn: null })
  await mount(baseConfig).preStep({ session })
  assert.equal(session.surface.replaceGeneration, 0, 'no elision while a compaction holds the lock')

  session.append('compaction/end', { compactionId: 'compact-1', turn: null })
  await mount(baseConfig).preStep({ session })
  assert.equal(session.surface.replaceGeneration, 1, 'the next pass after the bracket elides')
})
