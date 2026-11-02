/**
 * Shared harness for the Host-half integration tests.
 *
 * Supplies three things the production modules do not:
 *
 *  1. Bare-specifier resolution for the installed Harness tree (`./dsh.js`),
 *     needed because this workspace ships no `node_modules`.
 *  2. A fake Cordis host context: event fan-out (`on`), optional services
 *     (`commands`, `tokenMeter`, `connection`, `webServer`), `effect` disposal
 *     and `inject(['webServer'], …)`, so `index.js` can be mounted without a
 *     real Harness.
 *  3. Real-Session fixtures (event shapes taken from what the installed
 *     `dsh-session` 0.2.1-rc.5 actually accepts) plus a controllable clock, so
 *     the cold/warm TTL gate can be tested without sleeping.
 *
 * Everything here is test-only. The production exports are imported, never
 * re-implemented.
 */
import { loadSessionModule } from './dsh.js'

// `./dsh.js` registers the resolver as a side effect of being imported above;
// the dynamic import below therefore resolves `@deepseek-ai/schemastery`.
export const plugin = await import('../../index.js')
export const testing = plugin.__testing

/** Real `Session` class and surface predicates from the installed Harness. */
export const { Session, isAppendSurfaceEvent, isReplacementSurfaceEvent } = await loadSessionModule()

// ---------------------------------------------------------------------------
// Clock: the TTL gate compares Date.now() with the last assistant event time.
// `Session.append` also stamps `time: Date.now()`, so freezing the clock makes
// both sides deterministic. Restore it in afterEach.
// ---------------------------------------------------------------------------

export const NOW = 1_800_000_000_000
export const MIN = 60_000
const realNow = Date.now
let clock = NOW

/** Freeze Date.now at `at` (ms). Call once per test (before creating a Session). */
export function freezeClock(at = NOW) {
  clock = at
  Date.now = () => clock
}

/** Move the frozen clock forward/backwards without restoring real time. */
export function setClock(at) {
  clock = at
}

/** Restore the real Date.now; safe to call even when the clock was not frozen. */
export function restoreClock() {
  Date.now = realNow
}

// ---------------------------------------------------------------------------
// Fake Cordis host context
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {object} [options.services] extra services returned by `ctx.get(name)`
 * @param {boolean} [options.withWebServer] mount a fake `webServer` service
 * @param {boolean} [options.withCommands=true] mount a fake `commands` service
 * @param {object} [options.tokenMeter] override the token meter
 * @param {'warn'|'error'} [options.loggerLevel] which logger methods exist
 */
export function createCtx(options = {}) {
  const listeners = new Map()
  const warnings = []
  const disposers = []
  const routes = []
  const registered = { command: undefined }
  const webServer = options.withWebServer === true
    ? {
        register(definition) {
          routes.push(definition)
          return () => {
            const index = routes.indexOf(definition)
            if (index !== -1) routes.splice(index, 1)
          }
        },
      }
    : undefined
  const services = {
    commands: options.withCommands === false
      ? undefined
      : {
          register(definition) {
            registered.command = definition
            return () => {
              if (registered.command === definition) registered.command = undefined
            }
          },
        },
    tokenMeter: options.tokenMeter ?? {
      estimateMessage: (message) => JSON.stringify(message?.content ?? '').length,
    },
    webServer,
    ...(options.services ?? {}),
  }

  /** @type {any} */
  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
    },
    get(name) {
      return services[name]
    },
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
    inject(names, callback) {
      if (!Array.isArray(names) || !names.includes('webServer')) return
      if (webServer === undefined) return
      callback({ ...ctx, webServer })
    },
    dispose() {
      for (const off of disposers.splice(0).reverse()) off()
      listeners.clear()
    },
  }

  const harness = {
    ctx,
    services,
    warnings,
    registered,
    routes,
    listeners,
    /** Run the `agent/pre-step` waterfall and return `next()`'s result. */
    async emitPreStep(payload, nextResult = { kind: 'enter', messages: [] }) {
      const list = listeners.get('agent/pre-step') ?? []
      let call = () => Promise.resolve(nextResult)
      for (const listener of [...list].reverse()) {
        const downstream = call
        call = () => listener(payload, downstream)
      }
      return call()
    },
    /** Emit a non-waterfall event synchronously (e.g. `agent/disposed`). */
    emit(event, payload) {
      const list = listeners.get(event) ?? []
      for (const listener of [...list]) listener(payload)
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
  }
  return harness
}

/**
 * Mount `index.js` on a fake context.
 * @param {Record<string, unknown>} [config]
 * @param {Parameters<typeof createCtx>[0]} [options]
 */
export function mountPlugin(config = {}, options = {}) {
  const harness = createCtx(options)
  plugin.apply(harness.ctx, config)
  return harness
}

/** Fake `webServer` service that records registered routes (for standalone use). */
export function createFakeWebServer() {
  const routes = []
  return {
    routes,
    register(definition) {
      routes.push(definition)
      return () => {
        const index = routes.indexOf(definition)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  }
}

/** Fake `res` capturing status, headers and body. */
export function createRes() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body
      return this
    },
  }
}

/**
 * Invoke one captured exact route.
 * @param {{handler: Function}} route
 * @param {{method?: string, url?: string, headers?: Record<string, string>}} [req]
 */
export function callRoute(route, req = {}) {
  const request = {
    method: req.method ?? 'GET',
    url: req.url ?? testing.STATS_ENDPOINT,
    headers: req.headers ?? {},
    socket: {},
  }
  const res = createRes()
  route.handler(request, res)
  let json
  if (typeof res.body === 'string' && res.body.length > 0) json = JSON.parse(res.body)
  return { req: request, res, json }
}

// ---------------------------------------------------------------------------
// Real-Session fixtures (shapes accepted by dsh-session 0.2.1-rc.5)
// ---------------------------------------------------------------------------

export const bigText = (label = 'output', lines = 400) =>
  Array.from({ length: lines }, (_, index) => `${label} line ${index}`).join('\n')

/** Append a user message; `user/message` data *is* the message. */
export function appendUser(session, text = 'do the thing', turn = 0) {
  return session.append(
    'user/message',
    {
      role: 'user',
      id: `user-${turn}`,
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    { surfaceOp: 'append' },
  )
}

/**
 * Append one canonical turn: boundaries, the assistant message (with its
 * `tool-call` block, which the adapter indexes), the `tool/call` dispatch event
 * (which the recovery meter observes) and the `tool/result`.
 *
 * @param {object} session real Session
 * @param {object} options
 * @param {number} options.turn
 * @param {string} options.callId
 * @param {string} [options.name] tool name
 * @param {Record<string, unknown>} [options.args] tool arguments
 * @param {Array<object>} [options.content] tool-result content blocks
 * @param {boolean} [options.isError]
 * @param {object} [options.error] tool/result error payload
 * @param {Array<object>} [options.assistantBlocks] extra assistant blocks prepended
 * @param {string} [options.assistantText]
 * @returns {{assistantSeq: number, callSeq: number, resultSeq: number}}
 */
export function appendTurn(session, options) {
  const {
    turn,
    step = 1,
    callId,
    name = 'bash',
    args = { command: 'echo probe' },
    content,
    isError = false,
    error,
    assistantBlocks = [],
    assistantText,
  } = options
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  const assistantSeq = session.append(
    'assistant/message',
    {
      turn,
      step,
      message: {
        role: 'assistant',
        id: `assistant-${turn}-${callId}`,
        content: [
          ...assistantBlocks,
          { type: 'text', text: assistantText ?? `working on ${turn}` },
          { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) },
        ],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  ).seq
  const callSeq = session.append('tool/call', {
    turn,
    step,
    callId,
    name,
    arguments: JSON.stringify(args),
  }).seq
  const resultSeq = session.append(
    'tool/result',
    {
      turn,
      step,
      message: {
        role: 'tool',
        id: `tool-${callId}`,
        content: content ?? [{ type: 'text', text: bigText(`out-${turn}`) }],
        source: { kind: 'tool', callId },
        toolCallId: callId,
        ...(isError ? { isError: true } : {}),
      },
      ...(error === undefined ? {} : { error }),
    },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] },
  ).seq
  return { assistantSeq, callSeq, resultSeq }
}

/** `{kind: 'enter', messages: []}` — the value a pre-step waterfall returns. */
export const nextEnter = () => ({ kind: 'enter', messages: [] })

/** Content blocks for a rich (non plain-text) tool result. */
export const richContent = (label = 'rich') => [
  { type: 'text', text: bigText(`${label}-before`, 120) },
  { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
  { type: 'text', text: bigText(`${label}-after`, 120) },
]

/** Number of replacement surface events in the log. */
export const replacements = (session) =>
  session.ownEvents().filter((event) => isReplacementSurfaceEvent(event))

/** Surface seqs that have been replaced (the shadowed originals). */
export const replacedSeqs = (session) =>
  replacements(session).map((event) => event.surfaceOp.startSeq)
