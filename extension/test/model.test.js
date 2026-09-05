// extension/test/model.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseModelList, isRealModel } = require('../src/chat/model.js')

// The exact text the real binary was verified to print for a bare `/model`.
const REAL_OUTPUT =
  'Current model: Haiku 4.5\n' +
  'Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.'

test('the current model line is extracted from the real /model output', () => {
  const { current } = parseModelList(REAL_OUTPUT)
  assert.equal(current, 'Haiku 4.5')
})

test('the available list is parsed from the real /model output, excluding the "full model ID" clause', () => {
  const { available } = parseModelList(REAL_OUTPUT)
  assert.deepEqual(available, [
    'sonnet', 'opus', 'haiku', 'fable', 'best',
    'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan', 'default',
  ])
})

test('a bracketed name like sonnet[1m] is not split on its internal characters', () => {
  const { available } = parseModelList(REAL_OUTPUT)
  assert.ok(available.includes('sonnet[1m]'))
  assert.ok(!available.includes('sonnet[1m'))
})

test('missing "Current model:" line yields a null current rather than throwing', () => {
  const { current } = parseModelList('Usage: /model <name>. Available: sonnet, opus.')
  assert.equal(current, null)
})

test('missing "Available:" line yields an empty list rather than throwing', () => {
  const { available } = parseModelList('Current model: Sonnet 5')
  assert.deepEqual(available, [])
})

test('empty or unrelated text parses to no current model and no list', () => {
  assert.deepEqual(parseModelList(''), { current: null, available: [] })
  assert.deepEqual(parseModelList('some unrelated turn output'), { current: null, available: [] })
})

test('isRealModel accepts an ordinary model name', () => {
  assert.equal(isRealModel('claude-sonnet-5'), true)
  assert.equal(isRealModel('Sonnet 5'), true)
})

test('isRealModel rejects <synthetic>, because that means a local command answered, not a model', () => {
  assert.equal(isRealModel('<synthetic>'), false)
})

test('isRealModel rejects non-string and empty values', () => {
  assert.equal(isRealModel(undefined), false)
  assert.equal(isRealModel(null), false)
  assert.equal(isRealModel(''), false)
})
