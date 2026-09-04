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

test('an activity event carrying dest (the room\'s own field name) reaches the panel with handle set', () => {
  // src/web.mjs publishes tool activity as `{ ...evt, dest, turnId }` — the
  // seat's handle travels under `dest`, never `handle`. Left unnormalised,
  // the panel's activityTitle falls back to the literal string "worker" for
  // every single tool card, defeating the whole point of per-seat
  // attribution ("'Read src/billing.ts' means nothing unless you can tell
  // which agent ran it").
  const { r, activity } = router()
  r.handle('activity', { tool: 'Edit', dest: 'opencode', turnId: 't1' })
  assert.equal(activity[0].handle, 'opencode')
  assert.equal(activity[0].dest, 'opencode', 'dest is left intact, not replaced')
})

test('an activity event that already carries handle is passed through untouched', () => {
  // A future or already-correct producer may send `handle` directly —
  // normalising must not clobber a value that is already correct, nor
  // invent one from an unrelated `dest` on the same event.
  const { r, activity } = router()
  r.handle('activity', { handle: 'opencode', dest: 'someone-else' })
  assert.equal(activity[0].handle, 'opencode')
})

test('an unknown event is ignored rather than crashing the extension host', () => {
  const { r, activity, results } = router()
  r.handle('something-new', { x: 1 })
  assert.deepEqual([activity.length, results.length], [0, 0])
})
