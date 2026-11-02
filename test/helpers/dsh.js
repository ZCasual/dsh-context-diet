/**
 * Shared DSH module resolution for the test suite.
 *
 * The plugin imports `@deepseek-ai/schemastery` and the tests import DSH's real
 * `Session` implementation. Neither is a dependency of this package at install
 * time — the Harness supplies them — so a fresh clone has no `node_modules`
 * containing them. This helper finds an installed Harness and installs a
 * `registerHooks` resolver so bare specifiers resolve out of that tree.
 *
 * Resolution order:
 *   1. `DSH_NODE_MODULES` — explicit override, must contain `@deepseek-ai/`.
 *   2. `<repo>/node_modules` — after `npm install` with the devDependencies.
 *   3. `<repo>/node_modules/@deepseek-ai/dsh/node_modules` — npm alias install.
 *   4. `$(npm root -g)/@deepseek-ai/dsh/node_modules` — global Harness install.
 *
 * Every candidate is probed for the same entry file, so a wrong hit fails loudly
 * here instead of producing a confusing resolution error later.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Entry file used to prove a candidate really is a Harness module tree. */
const PROBE = '@deepseek-ai/dsh-session/lib/index.js'
const SESSION_ENTRY = '@deepseek-ai/dsh-session'

function globalNpmRoot() {
  try {
    return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function candidates() {
  const list = []
  if (process.env.DSH_NODE_MODULES) list.push(process.env.DSH_NODE_MODULES)
  list.push(new URL('../node_modules', import.meta.url).pathname)
  list.push(new URL('../node_modules/@deepseek-ai/dsh/node_modules', import.meta.url).pathname)
  const global = globalNpmRoot()
  if (global) {
    list.push(`${global}/@deepseek-ai/dsh/node_modules`)
    list.push(global)
  }
  return [...new Set(list)]
}

const found = candidates().find((root) => existsSync(`${root}/${PROBE}`))

if (found === undefined) {
  throw new Error(
    'no installed DeepSeek Harness modules found.\n'
      + 'Install the Harness globally (`npm i -g @deepseek-ai/dsh`) or run `npm install` here, '
      + `or point DSH_NODE_MODULES at a directory containing ${PROBE}.`,
  )
}

/** Directory that contains `@deepseek-ai/*`. */
export const dshModulesRoot = found

/** A `require` bound to the Harness tree, for resolving bare specifiers. */
export const requireFromDsh = createRequire(`${found}/index.js`)

registerHooks({
  resolve(specifier, context, next) {
    const bare = !specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.includes(':')
    if (bare) {
      try {
        return { url: pathToFileURL(requireFromDsh.resolve(specifier)).href, shortCircuit: true }
      } catch {
        return next(specifier, context)
      }
    }
    return next(specifier, context)
  },
})

/**
 * Import a module out of the Harness tree.
 * @param specifier - a bare package specifier, e.g. `@deepseek-ai/dsh-session`.
 * @returns the resolved module namespace.
 */
export function importFromDsh(specifier) {
  return import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
}

/** The real `Session` class and surface predicates used by the integration tests. */
export const loadSessionModule = () => importFromDsh(SESSION_ENTRY)
