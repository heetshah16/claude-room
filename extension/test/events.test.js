// extension/test/events.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createEventRouter } = require('../src/events.js')

function router() {
  const activity = []
  const results = []
  return {
    r: createEventRouter({
      onWorkerActivity: a => activity.push(a),
      onDelegationResult: d => results.push(d),
    }),
    activity, results,
  }
}

test('a completed delegation is routed to the orchestrator, once', () => {
  const { r, results } = router()
  r.handle('delegation', { id: 'd1', to: 'opencode', state: 'done', text: 'added mul()' })
  assert.deepEqual(results, [{ id: 'd1', handle: 'opencode', text: 'added mul()' }])
})

test('a delegation being sent is activity, not a result', () => {
  // Relaying "sent" back to the orchestrator would tell it its own request was
  // an answer, and it would reply to itself.
  const { r, results, activity } = router()
  r.handle('delegation', { id: 'd1', to: 'opencode', state: 'sent', task: 'add mul()' })
  assert.deepEqual(results, [])
  assert.equal(activity.length, 1)
})

test('an abandoned delegation is reported so the chat does not wait forever', () => {
  const { r, results } = router()
  r.handle('delegation', { id: 'd1', to: 'opencode', state: 'abandoned', reason: 'seat-disconnected' })
  assert.equal(results[0].failed, true)
  assert.match(results[0].text, /seat-disconnected/)
})

test('worker tool calls become activity for the panel', () => {
  const { r, activity } = router()
  r.handle('activity', { handle: 'opencode', tool: 'Edit', input: { file: 'math.js' } })
  assert.equal(activity[0].tool, 'Edit')
})

test('an unknown event is ignored rather than crashing the extension host', () => {
  const { r, activity, results } = router()
  r.handle('something-new', { x: 1 })
  assert.deepEqual([activity.length, results.length], [0, 0])
})
