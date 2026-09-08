// extension/test/permission-modes.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PERMISSION_MODES, DEFAULT_MODE, isKnownMode } = require('../src/permission-modes.js')

// The CLI's own choice list, read off `claude --help` on 2.1.216 (2026-09-08).
const CLI_CHOICES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']

test('every offered mode is one the CLI actually accepts', () => {
  for (const m of PERMISSION_MODES) {
    assert.ok(CLI_CHOICES.includes(m.id), `${m.id} is not a --permission-mode choice`)
  }
})

test('the modes worth having are all present', () => {
  const ids = PERMISSION_MODES.map(m => m.id)
  for (const id of ['auto', 'manual', 'acceptEdits', 'plan']) {
    assert.ok(ids.includes(id), `${id} must be offered`)
  }
})

test('dontAsk is deliberately not offered', () => {
  // The CLI accepts it. Its exact behaviour cannot be stated accurately here,
  // and this is a safety surface: describing it with an invented summary is
  // worse than omitting it. Same rule as the slash-command registry.
  assert.ok(!PERMISSION_MODES.some(m => m.id === 'dontAsk'))
})

test('exactly one mode is marked destructive, and it is bypassPermissions', () => {
  const destructive = PERMISSION_MODES.filter(m => m.destructive)
  assert.deepEqual(destructive.map(m => m.id), ['bypassPermissions'])
})

test('every mode has a label and a summary, so none is offered unexplained', () => {
  for (const m of PERMISSION_MODES) {
    assert.ok(m.label && m.label.length > 0, `${m.id} needs a label`)
    assert.ok(m.summary && m.summary.length > 0, `${m.id} needs a summary`)
  }
})

test('the default is the ordinary prompting mode', () => {
  assert.equal(DEFAULT_MODE, 'manual')
  assert.ok(PERMISSION_MODES.some(m => m.id === DEFAULT_MODE))
})

test('isKnownMode gates what may reach the command line', () => {
  // The mode arrives from the webview and is spliced into argv, so this is a
  // gate rather than a formality.
  assert.equal(isKnownMode('plan'), true)
  assert.equal(isKnownMode('dontAsk'), false, 'not offered means not accepted')
  assert.equal(isKnownMode('--dangerously-skip-permissions'), false)
  assert.equal(isKnownMode(''), false)
  assert.equal(isKnownMode(null), false)
  assert.equal(isKnownMode(undefined), false)
})
