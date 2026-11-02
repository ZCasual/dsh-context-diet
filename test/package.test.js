/**
 * Publishable-package contract: metadata, the published file list, the bundle
 * patch row and the Client wiring in `package.json`.
 *
 * The Client's runtime registration is covered by `footer.test.js`; this file
 * only proves that the package as published actually ships and wires it.
 *
 * Run: node --test test/package.test.js
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
const readme = await readFile(new URL('README.md', root), 'utf8')

test('package identity and repository metadata are publishable', () => {
  assert.equal(manifest.name, 'dsh-context-diet')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.homepage, 'https://github.com/ZCasual/dsh-context-diet#readme')
  assert.equal(manifest.repository.url, 'git+https://github.com/ZCasual/dsh-context-diet.git')
  assert.equal(manifest.bugs.url, 'https://github.com/ZCasual/dsh-context-diet/issues')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.match(manifest.engines.dsh, /0\.2\.1-rc\.5/)
  assert.ok(manifest.engines.node.length > 0)
})

test('the published file list carries both halves, the core, the patch and the licence', () => {
  const files = new Set(manifest.files)
  for (const required of ['index.js', 'core.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md', 'LICENSE']) {
    assert.ok(files.has(required), `files must ship ${required}`)
  }
  assert.ok(manifest.exports['.'], 'the Host entry must be exported')
  assert.equal(manifest.exports['./client'], './client.js', 'the Client half must be resolvable by the loader')
  assert.equal(manifest.main, 'index.js')
})

test('the Client half declares the web platform and the slot-owner packages it injects', () => {
  const client = manifest.dsh.client
  assert.ok(client, 'dsh.client is how the Harness learns about client.js')
  assert.equal(client.platform, 'web')
  assert.equal(client.immediately, true)
  assert.ok(Array.isArray(client.inject))
  assert.equal(client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), true, 'declares the slot owner')
  assert.equal(client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), true)
})

test('the bundle patch row matches the package name and is enabled', () => {
  assert.match(patch, /id:\s*dsh-context-diet/)
  assert.match(patch, /name:\s*'dsh-context-diet'/)
  assert.match(patch, /enabled:\s*true/)
  // A `disabled: true` key would unload the plugin; the comments may still
  // mention the word, so only a real key line counts.
  assert.doesNotMatch(patch, /^\s*disabled:\s*true\s*$/m)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('the README documents install, configuration and the durable-surface limit', () => {
  assert.match(readme, /install_bundle/)
  assert.match(readme, /\/context-diet/)
  assert.match(readme, /enabled: true/)
  assert.match(readme, /not.{0,4}reverted|are not reverted|does not revert|不会.?回滚/i)
  assert.match(readme, /pi-context-diet/)
})
