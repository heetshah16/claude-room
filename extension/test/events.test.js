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

// --- the fleet also needs to see these events ------------------------------

test('every room event is offered to an observer, including ones the panel ignores', () => {
  // The worker pool needs `delegation` in all its states, and the panel does
  // not. A second SSE subscription would give the two different orderings --
  // ARCHITECTURE.md is explicit that one subscription and one ordering is what
  // keeps a worker's reply from reaching the orchestrator before the panel has
  // shown the work. So the router fans out instead.
  const seen = []
  const router = createEventRouter({
    onWorkerActivity: () => {},
    onDelegationResult: () => {},
    onRoomEvent: (event, data) => seen.push([event, data.state ?? data.kind]),
  })
  router.handle('delegation', { id: 'd1', to: 'worker-1', state: 'sent', task: 't' })
  router.handle('delegation', { id: 'd1', to: 'worker-1', state: 'done', text: 'ok' })
  router.handle('activity', { dest: 'worker-1', kind: 'tool-start', tool: 'glob' })

  assert.deepEqual(seen, [
    ['delegation', 'sent'],
    ['delegation', 'done'],
    ['activity', 'tool-start'],
  ])
})

test('the observer sees activity with a normalised handle, like the panel does', () => {
  // src/web.mjs sends the seat's handle as `dest`; everything downstream keys
  // off `handle`. Normalising once means neither consumer has to guess.
  let got = null
  const router = createEventRouter({
    onWorkerActivity: () => {},
    onDelegationResult: () => {},
    onRoomEvent: (event, data) => { if (event === 'activity') got = data },
  })
  router.handle('activity', { dest: 'worker-2', kind: 'tool-start', tool: 'glob' })
  assert.equal(got.handle, 'worker-2')
})

test('a router with no observer still works, so the panel alone is a valid wiring', () => {
  const router = createEventRouter({ onWorkerActivity: () => {}, onDelegationResult: () => {} })
  assert.doesNotThrow(() => router.handle('delegation', { id: 'd', to: 'w', state: 'sent' }))
})

test('an unrecognised room event reaches the observer rather than being dropped', () => {
  // The room is allowed to grow event types. The pool can ignore what it does
  // not know; the router must not decide that for it.
  const seen = []
  const router = createEventRouter({
    onWorkerActivity: () => {},
    onDelegationResult: () => {},
    onRoomEvent: e => seen.push(e),
  })
  router.handle('cost', { promptId: 'p1' })
  assert.deepEqual(seen, ['cost'])
})
