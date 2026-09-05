// extension/test/stream-model.test.js
//
// Coverage for the `model` event added to createStreamParser for the model
// picker (design doc: orchestrator-parity, section 3). Kept in its own file
// rather than editing stream.test.js, which must stay unedited so the
// existing baseline can be trusted untouched.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createStreamParser } = require('../src/stream.js')

function run(lines) {
  const seen = []
  const p = createStreamParser({ onEvent: e => seen.push(e) })
  for (const l of lines) p.push(JSON.stringify(l) + '\n')
  return seen
}

test('an assistant message carrying a real model surfaces a model event before its text', () => {
  const out = run([{
    type: 'assistant',
    message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Sonnet 5' }] },
  }])
  assert.deepEqual(out[0], { kind: 'model', model: 'claude-sonnet-5' })
  assert.equal(out[1].kind, 'text')
})

test('<synthetic> is not surfaced as a model, because a local slash command answered, not the model', () => {
  const out = run([{
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'Current model: Haiku 4.5' }] },
  }])
  assert.deepEqual(out.map(e => e.kind), ['text'])
})

test('an assistant message with no model field emits no model event', () => {
  const out = run([{
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }] },
  }])
  assert.deepEqual(out.map(e => e.kind), ['text'])
})

test('a user message never emits a model event even if it somehow carried a model field', () => {
  const out = run([{
    type: 'user',
    message: { model: 'claude-sonnet-5', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
  }])
  assert.deepEqual(out.map(e => e.kind), ['tool-result'])
})

test('existing event shapes are unaffected: tool_use/tool_result correlation still works with a model field present', () => {
  const out = run([
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done', is_error: false }] } },
  ])
  assert.deepEqual(out[0], { kind: 'model', model: 'claude-opus-5' })
  assert.deepEqual(out[1], { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'x' } })
  assert.deepEqual(out[2], { kind: 'tool-result', id: 't1', content: 'done', isError: false })
})
