// extension/test/workers.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWorkerPool } = require('../src/workers.js')

/**
 * A pool whose room always succeeds.
 *
 * No supervisor: the room owns worker processes now, so the only seam left is
 * the HTTP client.
 */
function fakePool(over = {}) {
  const spawned = []
  const stopped = []
  let n = 0
  const pool = createWorkerPool({
    log: () => {},
    roomClient: {
      spawnWorker: async a => { spawned.push(a ?? {}); return { ok: true, handle: `worker-${++n}` } },
      stopWorker: async h => { stopped.push(h); return { ok: true } },
      ...(over.roomClient ?? {}),
    },
    ...(over.pool ?? {}),
  })
  return { pool, spawned, stopped }
}

test('ensureOne asks the room for a worker, and only ever one', async () => {
  const { pool, spawned } = fakePool()
  await pool.ensureOne()
  await pool.ensureOne() // idempotent
  assert.equal(spawned.length, 1)
  assert.equal(pool.list().length, 1)
})

test('a worker starts in the starting state, not idle', () => {
  // It has no worktree and no opencode yet, and a delegation sent now would
  // fail. Saying "idle" would be a lie the sidebar repeats.
  const { pool } = fakePool()
  return pool.ensureOne().then(() => {
    assert.equal(pool.list()[0].state, 'starting')
  })
})

test('add() asks for a second worker alongside the first', async () => {
  const { pool, spawned } = fakePool()
  await pool.ensureOne()
  await pool.add()
  assert.deepEqual(pool.list().map(w => w.handle), ['worker-1', 'worker-2'])
  assert.equal(spawned.length, 2)
})

test('the handle in the list is the one the room assigned, never a guessed one', async () => {
  // The room allocates handles now. Inventing `worker-1` locally would make
  // the sidebar address a seat that does not exist.
  const { pool } = fakePool({
    roomClient: { spawnWorker: async () => ({ ok: true, handle: 'worker-7' }) },
  })
  await pool.add()
  assert.deepEqual(pool.list().map(w => w.handle), ['worker-7'])
})

test('a chosen model is passed through, an unchosen one is not invented', async () => {
  const { pool, spawned } = fakePool({ pool: { model: 'opencode/mimo-v2.5-free' } })
  await pool.add()
  await pool.add({ model: 'opencode/other' })
  assert.deepEqual(spawned, [{ model: 'opencode/mimo-v2.5-free' }, { model: 'opencode/other' }])
})

test('a refused spawn leaves no half-created worker in the list', async () => {
  const { pool } = fakePool({
    roomClient: { spawnWorker: async () => ({ ok: false, errors: ['no opencode on PATH'] }) },
  })
  const logged = []
  const { pool: loud } = fakePool({
    pool: { log: m => logged.push(String(m)) },
    roomClient: { spawnWorker: async () => ({ ok: false, errors: ['no opencode on PATH'] }) },
  })
  await pool.add()
  await loud.add()
  assert.deepEqual(pool.list(), [], 'a worker the room refused is not a worker')
  assert.match(logged.join('\n'), /no opencode on PATH/, 'the room reason must survive verbatim')
})

test('a spawn that answers without a handle is refused, not listed as blank', async () => {
  const { pool } = fakePool({ roomClient: { spawnWorker: async () => ({ ok: true }) } })
  await pool.add()
  assert.deepEqual(pool.list(), [])
})

test('stop asks the room to reap the worker, then forgets it', async () => {
  const { pool, stopped } = fakePool()
  await pool.ensureOne()
  await pool.stop('worker-1')
  assert.deepEqual(stopped, ['worker-1'])
  assert.deepEqual(pool.list(), [])
})

test('a stop the room refused keeps the worker visible, because it is still running', async () => {
  // Dropping the row would hide a live process holding a worktree. The room is
  // the authority on whether it died; until it says so, it is still there.
  const { pool } = fakePool({
    roomClient: { stopWorker: async () => ({ ok: false, errors: ['unknown handle'] }) },
  })
  await pool.ensureOne()
  await pool.stop('worker-1')
  assert.equal(pool.list().length, 1)
})

test('listeners are told when the fleet changes, so the sidebar can redraw', async () => {
  const { pool } = fakePool()
  const seen = []
  pool.onChange(list => seen.push(list.length))
  await pool.ensureOne()
  await pool.stop('worker-1')
  assert.deepEqual(seen, [1, 0])
})

// --- live state, driven by the room's own event stream ---------------------

async function poolWithOne() {
  const f = fakePool()
  await f.pool.ensureOne()
  return f.pool
}

test('a delegation marks its worker busy and records the task', async () => {
  const pool = await poolWithOne()
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', task: 'Add tests', id: 'd1' })
  const w = pool.list()[0]
  assert.equal(w.state, 'busy')
  assert.equal(w.task, 'Add tests')
  assert.ok(w.deadlineAt > Date.now(), 'a busy worker has a deadline to count down')
})

test('a finished delegation returns the worker to idle', async () => {
  const pool = await poolWithOne()
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', task: 'Add tests', id: 'd1' })
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'done', id: 'd1', text: 'done' })
  assert.equal(pool.list()[0].state, 'idle')
  assert.equal(pool.list()[0].task, null)
  assert.equal(pool.list()[0].deadlineAt, null)
})

test('an abandoned delegation frees the worker rather than pinning it busy', async () => {
  const pool = await poolWithOne()
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', task: 'x', id: 'd1' })
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'abandoned', id: 'd1', reason: 'feed dropped' })
  assert.equal(pool.list()[0].state, 'idle')
})

test('activity marks a starting worker as live, since it is plainly working', async () => {
  const pool = await poolWithOne()
  assert.equal(pool.list()[0].state, 'starting')
  pool.applyRoomEvent('activity', { handle: 'worker-1', kind: 'tool-start', tool: 'glob' })
  assert.notEqual(pool.list()[0].state, 'starting')
})

test('tool activity is recorded against the worker that ran it', async () => {
  const f = fakePool()
  await f.pool.ensureOne()
  await f.pool.add()
  f.pool.applyRoomEvent('activity', { handle: 'worker-2', kind: 'tool-start', tool: 'glob' })
  assert.equal(f.pool.list()[1].lastTool, 'glob')
  assert.equal(f.pool.list()[0].lastTool, null, 'the other worker must be untouched')
})

test('an event for an unknown handle is ignored rather than inventing a worker', async () => {
  const pool = await poolWithOne()
  pool.applyRoomEvent('activity', { handle: 'ghost', kind: 'tool-start', tool: 'glob' })
  assert.equal(pool.list().length, 1)
})

test('applying a room event notifies listeners, so the sidebar follows along', async () => {
  const pool = await poolWithOne()
  const seen = []
  pool.onChange(list => seen.push(list[0].state))
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', task: 't', id: 'd1' })
  assert.deepEqual(seen, ['busy'])
})

// --- what the detail view shows --------------------------------------------

test('the brief is kept as fields, which is what makes a thin one look thin', async () => {
  const pool = await poolWithOne()
  pool.applyRoomEvent('delegation', {
    to: 'worker-1', state: 'sent', id: 'd1', task: 'Add tests', class: 'execution',
    spec: { files: ['src/parser.mjs'], tests: ['node --test'], do_not_touch: ['src/server.mjs'] },
  })
  const d = pool.detail('worker-1')
  assert.equal(d.brief.task, 'Add tests')
  assert.equal(d.brief.class, 'execution')
  assert.deepEqual(d.brief.spec.files, ['src/parser.mjs'])
})

test('the brief survives the delegation finishing, so it can still be read', async () => {
  // The question "what was it actually asked to do" outlives the answer.
  const pool = await poolWithOne()
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', id: 'd1', task: 'Add tests', class: 'execution', spec: {} })
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'done', id: 'd1', text: 'added 4 cases' })
  assert.equal(pool.detail('worker-1').brief.task, 'Add tests')
})

test('tool calls and the reply land in the transcript, in order', async () => {
  const pool = await poolWithOne()
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', id: 'd1', task: 'Add tests', class: 'execution', spec: {} })
  pool.applyRoomEvent('activity', { handle: 'worker-1', kind: 'tool-start', tool: 'read', input: { file_path: 'src/parser.mjs' } })
  pool.applyRoomEvent('activity', { handle: 'worker-1', kind: 'tool-start', tool: 'write', input: { file_path: 'test/parser.test.mjs' } })
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'done', id: 'd1', text: 'added 4 cases' })

  assert.deepEqual(pool.detail('worker-1').transcript.map(e => [e.kind, e.tool ?? e.text]), [
    ['brief', 'Add tests'],
    ['tool', 'read'],
    ['tool', 'write'],
    ['reply', 'added 4 cases'],
  ])
})

test('an abandoned delegation is recorded as such, not as a silent stop', async () => {
  const pool = await poolWithOne()
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', id: 'd1', task: 't', class: 'reasoning', spec: {} })
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'abandoned', id: 'd1', reason: 'feed dropped' })
  const last = pool.detail('worker-1').transcript.at(-1)
  assert.equal(last.kind, 'abandoned')
  assert.match(last.text, /feed dropped/)
})

test('the transcript is bounded, so a long-lived worker cannot grow without limit', async () => {
  const pool = await poolWithOne()
  for (let i = 0; i < 600; i++) {
    pool.applyRoomEvent('activity', { handle: 'worker-1', kind: 'tool-start', tool: `t${i}` })
  }
  const t = pool.detail('worker-1').transcript
  assert.ok(t.length <= 500, `transcript grew to ${t.length}`)
  assert.equal(t.at(-1).tool, 't599', 'the most recent entries are the ones kept')
})

test('detail for an unknown handle is null rather than an empty shell', async () => {
  const pool = await poolWithOne()
  assert.equal(pool.detail('ghost'), null)
})

test('the tools a worker has actually used are collected', async () => {
  // Not a declared capability list: the launcher picks opencode's port
  // internally, so its /config is not reachable from here. What it HAS used is
  // both reachable and more honest.
  const pool = await poolWithOne()
  pool.applyRoomEvent('activity', { handle: 'worker-1', kind: 'tool-start', tool: 'read' })
  pool.applyRoomEvent('activity', { handle: 'worker-1', kind: 'tool-start', tool: 'write' })
  pool.applyRoomEvent('activity', { handle: 'worker-1', kind: 'tool-start', tool: 'read' })
  assert.deepEqual(pool.detail('worker-1').toolsUsed, ['read', 'write'])
})
