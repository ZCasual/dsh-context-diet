/**
 * Client-half static + registration contract (`client.js`).
 *
 * The Client is a browser bundle loaded through `window.__ModuleLoader__`; it
 * cannot be imported as an ES module. These tests therefore (a) check the
 * manifest wiring that makes DSH load it, (b) evaluate the bundle in a sandbox
 * with a fake `window`/`require`, and (c) drive its `apply()` against fake
 * `slots`/`locale` services to prove the composer-dock registration shape.
 *
 * Renderer behaviour (polling, visibility, interval cleanup, empty-string →
 * null) is locked by source assertions because the component needs React/DOM;
 * the Host endpoint it consumes is covered by `session-contract.test.js`.
 *
 * Run: node --test test/footer.test.js
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const clientSource = await readFile(new URL('client.js', root), 'utf8')
const STATS_ENDPOINT = '/context-diet/stats'

/** Evaluate the Client bundle the way the Harness loader does. */
function loadClientBundle() {
  let definition
  const fakeWindow = {
    __ModuleLoader__: {
      load(candidate) {
        definition = candidate
      },
    },
    setInterval: () => 1,
    clearInterval: () => {},
  }
  // The bundle is a script, not a module: compiling it also proves the syntax.
  new Function('window', clientSource)(fakeWindow)
  assert.ok(definition, 'client.js must call window.__ModuleLoader__.load')
  return definition
}

// ---------------------------------------------------------------------------
// Manifest wiring: package.json is what makes the Harness load the Client half
// ---------------------------------------------------------------------------

test('the package exposes the Client half through exports, files and dsh.client', () => {
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.files.includes('client.js'), true)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), true)
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), true)
})

test('the bundle is parseable and registers under the package name', () => {
  const definition = loadClientBundle()
  assert.equal(definition.id, manifest.name, 'the loader id must be the package name')
  assert.equal(typeof definition.factory, 'function')
})

// ---------------------------------------------------------------------------
// Runtime registration: what the Client actually mounts
// ---------------------------------------------------------------------------

/** Call the bundle factory with a fake `react` require. */
function loadClientModule() {
  const definition = loadClientBundle()
  const fakeReact = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  }
  const require = (specifier) => {
    assert.equal(specifier, 'react', 'only the react seed word may be required')
    return fakeReact
  }
  return definition.factory(require)
}

test('the Client module exports its services, constants and polling period', () => {
  const client = loadClientModule()
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(client.NS, 'contextDietFooter')
  assert.equal(client.STATS_URL, STATS_ENDPOINT)
  assert.equal(client.POLL_MS, 2000)
})

test('apply registers a composer-dock entry under its own id and order (never replaces activity/usage)', () => {
  const client = loadClientModule()
  const effects = []
  const localeRegistrations = []
  const slotInjections = []
  const registrations = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      bind(namespace) {
        return (key) => `${namespace}.${key}`
      },
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        slotInjections.push(name)
        callback()
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }

  client.apply(ctx)

  assert.deepEqual(slotInjections, ['conversation.composer.dock'])
  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].namespace, client.NS)
  assert.equal(localeRegistrations[0].dictionaries.en.label, 'Context diet')
  assert.equal(localeRegistrations[0].dictionaries.zh.label, '上下文节食')

  assert.equal(registrations.length, 1)
  const { definition, component } = registrations[0]
  assert.equal(definition.name, 'conversation.composer.dock')
  assert.equal(definition.id, 'context-diet')
  assert.equal(definition.order, 2, 'order 2 puts it after the official activity(0)/usage(1) entries')
  assert.equal(definition.locale, client.NS)
  assert.equal(typeof definition.label, 'function')
  assert.equal(definition.label(), 'contextDietFooter.label')
  assert.equal(typeof definition.inject, 'function')
  const injected = definition.inject()
  assert.equal(typeof injected.feed, 'function', 'the entry-level inject supplies the Host reader')
  assert.equal(typeof component, 'function')

  // Both registrations are bound to the plugin fiber: unloading must dispose them.
  assert.equal(effects.length, 2)
  assert.ok(effects[0].includes('dictionaries'))
  assert.ok(effects[1].includes('composer dock'))
})

// ---------------------------------------------------------------------------
// Source-level contract for the parts that need React/DOM to execute
// ---------------------------------------------------------------------------

test('the Client reads the Host endpoint and renders its footer verbatim', () => {
  assert.equal(clientSource.includes(STATS_ENDPOINT), true)
  assert.equal(clientSource.includes("cache: 'no-store'"), true)
  assert.equal(clientSource.includes("credentials: 'same-origin'"), true)
  assert.equal(clientSource.includes("typeof payload?.footer === 'string'"), true)
  assert.equal(clientSource.includes('data-composer-stat'), true)
  assert.equal(clientSource.includes('data-composer-dock-entry'), true)
})

test('the Client polls only while the tab is visible and clears the interval on unmount', () => {
  assert.equal(clientSource.includes('document.visibilityState'), true)
  assert.equal(clientSource.includes("document.visibilityState !== 'visible'"), true)
  assert.equal(clientSource.includes('window.setInterval'), true)
  assert.equal(clientSource.includes('window.clearInterval'), true)
  assert.equal(clientSource.includes('visibilitychange'), true)
  assert.equal(clientSource.includes('removeEventListener'), true)
  assert.equal(clientSource.includes('POLL_MS = 2000'), true)
})

test('an empty footer renders nothing (null), never a placeholder', () => {
  assert.equal(clientSource.includes("typeof footer !== 'string' || footer === ''"), true)
  assert.equal(clientSource.includes('return null'), true)
})

test('the Client never claims the official dock ids', () => {
  assert.equal(clientSource.includes('"id": "activity"'), false)
  assert.equal(clientSource.includes('"id": "usage"'), false)
  assert.equal(clientSource.includes("id: 'activity'"), false)
  assert.equal(clientSource.includes("id: 'usage'"), false)
})

test('the Client styles with DSH theme tokens, not hard-coded colours', () => {
  assert.equal(clientSource.includes('--dsw-alias-label-secondary'), true)
  assert.equal(clientSource.includes('--dsw-alias-label-primary'), true)
  assert.equal(/fontSize: '\d+(?:\.\d+)?px'/.test(clientSource), true)
})
