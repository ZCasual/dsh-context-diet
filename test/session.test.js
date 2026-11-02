import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSessionModule } from './helpers/dsh.js'

const { Session } = await loadSessionModule()
const plugin = await import(new URL('../index.js', import.meta.url))

function installPlugin(config = {}) {
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'tokenMeter') return { estimateMessage: (message) => message.content?.[0]?.text?.length ?? 0 }
      return undefined
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => list.splice(list.indexOf(listener), 1)
    },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  plugin.apply(ctx, config)
  return {
    async preStep(agent, next = { kind: 'enter', messages: [] }) {
      let call = () => Promise.resolve(next)
      for (const listener of [...(listeners.get('agent/pre-step') ?? [])].reverse()) {
        const downstream = call
        call = () => listener({ agent, messages: [], turn: 9, step: 1, signal: new AbortController().signal }, downstream)
      }
      return call()
    },
  }
}

function appendTurn(session, turn, callId, output) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: `assistant-${turn}`,
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: JSON.stringify({ command: `echo ${turn}` }) }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      role: 'tool',
      id: `tool-${callId}`,
      content: [{ type: 'text', text: output }],
      source: { kind: 'tool', callId },
      toolCallId: callId,
    },
  }, { surfaceOp: 'append' })
}

test('real Session replacement preserves log and changes only model surface', async () => {
  const session = Session.create('real-session')
  const original = 'old output\n'.repeat(800)
  appendTurn(session, 0, 'old-call', original)
  appendTurn(session, 2, 'recent-call', 'recent')
  const before = session.ownEvents().map((event) => structuredClone(event))
  const agent = { session }
  const mounted = installPlugin({ enabled: true, agePolicy: 'always', keepTurns: 1, minChars: 100 })

  await mounted.preStep(agent)

  assert.equal(session.ownEvents().length, before.length + 2)
  assert.equal(session.ownEvents().filter((event) => event.type === 'tool/result').length, 3)
  assert.deepEqual(session.eventAt(3).data.message.content, [{ type: 'text', text: original }])
  const replacementSeq = session.surface.nodes.find((seq) => seq > before.length - 1)
  assert.ok(replacementSeq !== undefined)
  const replacement = session.eventAt(replacementSeq)
  assert.equal(replacement.type, 'tool/result')
  assert.deepEqual(replacement.sourceEventSeqs, [3])
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.equal(replacement.data.message.source.callId, 'old-call')
  assert.ok(replacement.data.message.content[0].text.includes('[context-diet: result elided]'))
  assert.ok(replacement.data.message.content[0].text.includes('last lines:'))
  assert.equal(session.deriveMessages().some((message) => message.content?.[0]?.text === original), false)
  assert.equal(session.deriveMessages().some((message) => message.content?.[0]?.text?.includes('[context-diet: result elided]')), true)

  const replay = Session.create('replay-session', session.ownEvents())
  assert.deepEqual(replay.surface.nodes, session.surface.nodes)
  assert.deepEqual(replay.deriveMessages(), session.deriveMessages())

  const seqAfterFirstPass = session.seq
  await mounted.preStep(agent)
  assert.equal(session.seq, seqAfterFirstPass, 'a replacement is idempotent on the next step')
})

test('real Session rejects no mutation when the policy is disabled', async () => {
  const session = Session.create('disabled-session')
  appendTurn(session, 0, 'call', 'x'.repeat(5000))
  const before = session.ownEvents().map((event) => structuredClone(event))
  const mounted = installPlugin({ enabled: false, agePolicy: 'always', keepTurns: 0, minChars: 1 })
  await mounted.preStep({ session })
  assert.deepEqual(session.ownEvents(), before)
})
