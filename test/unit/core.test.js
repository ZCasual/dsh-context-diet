// Unit guard for the frozen `core.js` module surface.
//
// Run: node --test test/unit/core.test.js
//
// Behavioural coverage of the pure core lives in `test/parity.test.js` (105
// assertions ported 1:1 from pi-context-diet's own test suite, each citing its
// upstream file:line) and must not be duplicated here — `docs/impl-contract.md
// §6` makes parity the single source of behavioural truth for the core.
//
// This file exists to catch the failure mode that started the rewrite: the
// module drifting away from the frozen contract (renamed/removed exports,
// re-added legacy DSH API, changed constants). If an export here changes, the
// contract document must change first.

import assert from 'node:assert/strict'
import test from 'node:test'

import * as core from '../../core.js'

/**
 * The frozen `core.js` surface, exactly as `docs/impl-contract.md §1` lists it.
 * Sorted; additions and removals are contract changes, not refactors.
 */
const FROZEN_VALUES = [
  'ARG_TOOLS',
  'DEFAULT_CHARS_PER_TOKEN',
  'DEFAULT_CONFIG',
  'MAX_LABEL_CHARS',
  'MAX_PREVIEW_LINE_CHARS',
  'STUB_MARKER',
  'USAGE',
]

const FROZEN_FUNCTIONS = [
  'applyElision',
  'argChars',
  'assistantTurnsAfter',
  'callSignature',
  'charsOfMessages',
  'completions',
  'decide',
  'describeCall',
  'describeCandidates',
  'describeElided',
  'elideArguments',
  'eligible',
  'eligibleArgs',
  'footerLine',
  'formatSize',
  'formatTokens',
  'hasThinking',
  'indexCalls',
  'isCold',
  'isStubbed',
  'lastAssistantTimestamp',
  'measure',
  'parseCommand',
  'policyOf',
  'previewOf',
  'sanitizeConfig',
  'showLines',
  'stableStringify',
  'staleTokens',
  'statusLine',
  'stubText',
]

const FROZEN_CLASSES = ['Calibrator', 'RecoveryMeter']

/** Legacy DSH-adapter API deleted by the rewrite; it must never come back. */
const REMOVED = ['planElisions', 'resolvePolicy', 'dshStubText', 'statusText', 'emptyStats', 'DSH_DEFAULTS', 'estimateTokens']

test('core.js exports exactly the frozen contract surface (no more, no less)', () => {
  const expected = [...FROZEN_VALUES, ...FROZEN_FUNCTIONS, ...FROZEN_CLASSES].sort()
  const actual = Object.keys(core).sort()
  assert.deepEqual(actual, expected)
})

test('every frozen export has the expected kind', () => {
  for (const name of FROZEN_FUNCTIONS) {
    assert.equal(typeof core[name], 'function', `${name} must be a function`)
  }
  for (const name of FROZEN_CLASSES) {
    assert.equal(typeof core[name], 'function', `${name} must be a class`)
    assert.equal(typeof core[name].prototype, 'object')
  }
  assert.equal(typeof core.DEFAULT_CONFIG, 'object')
  assert.equal(typeof core.USAGE, 'string')
  assert.equal(core.ARG_TOOLS instanceof Set, true)
})

test('the removed legacy DSH-adapter API is gone', () => {
  for (const name of REMOVED) {
    assert.equal(name in core, false, `${name} was deleted by the rewrite and must not return`)
  }
})

test('the frozen constants keep their upstream values', () => {
  assert.equal(core.DEFAULT_CHARS_PER_TOKEN, 3)
  assert.equal(core.STUB_MARKER, '[context-diet:')
  assert.equal(core.MAX_LABEL_CHARS, 80)
  assert.equal(core.MAX_PREVIEW_LINE_CHARS, 160)
  assert.deepEqual([...core.ARG_TOOLS].sort(), ['edit', 'write'])
  assert.equal(core.DEFAULT_CONFIG.enabled, true)
  assert.equal(core.DEFAULT_CONFIG.mode, 'cold')
  assert.equal(core.DEFAULT_CONFIG.keepTurns, 20)
  assert.equal(core.DEFAULT_CONFIG.minChars, 1500)
  assert.equal(Object.keys(core.DEFAULT_CONFIG).length, 13, 'DSH keeps 13 config fields (contract §2)')
  assert.equal(Object.isFrozen(core.DEFAULT_CONFIG), true)
})

test('DEFAULT_CONFIG carries no compact/warming/maxPerPass leftovers', () => {
  for (const gone of ['compact', 'compactAboveTokens', 'warmArbitration', 'expectedTurns', 'stopWarmingShare', 'maxPerPass', 'agePolicy']) {
    assert.equal(gone in core.DEFAULT_CONFIG, false, `${gone} must not be part of the frozen config`)
  }
})

test('isStubbed recognises only this plugin\'s stub marker', () => {
  assert.equal(core.isStubbed([{ type: 'text', text: `${core.STUB_MARKER} the output of bash (1 B, 1 lines) was elided]` }]), true)
  assert.equal(core.isStubbed('ordinary tool output'), false)
  assert.equal(core.isStubbed([{ type: 'text', text: 'ordinary tool output' }]), false)
  assert.equal(core.isStubbed([{ type: 'image' }]), false)
  assert.equal(core.isStubbed(null), false)
})
