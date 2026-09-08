// extension/test/workers.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workerRecipe, nextHandle, createWorkerPool } = require('../src/workers.js')

/** A pool whose room and supervisor always succeed. */
function fakePool(over = {}) {
  const invites = []
  const started = []
  const stopped = []
  const pool = createWorkerPool({
    repoRoot: '/repo',
    roomUrl: 'http://127.0.0.1:8787',
    log: () => {},
    roomClient: {
      state: async () => ({ you: { id: 'owner-1' } }),
      invite: async a => { invites.push(a); return { ok: true, token: 'seat-tok', member: { handle: a.handle } } },
      ...(over.roomClient ?? {}),
    },
    supervisor: {
      start: (name, recipe) => { started.push({ name, recipe }); return { child: { pid: 42 } } },
      stop: name => stopped.push(name),
      ...(over.supervisor ?? {}),
    },
    ...(over.pool ?? {}),
  })
  return { pool, invites, started, stopped }
}

test('the recipe launches the seat launcher, not opencode directly', () => {
  // scripts/room-opencode-seat.mjs is what creates the worktree, starts
  // `opencode serve`, registers the reply-only seat bridge, and runs the
  // driver. Launching opencode here would reimplement all four.
  const r = workerRecipe({
    repoRoot: '/repo', handle: 'worker-1', token: 'seat-tok',
    roomUrl: 'http://127.0.0.1:8787', nodePath: '/usr/bin/node', env: {},
  })
  assert.equal(r.cmd, '/usr/bin/node')
  assert.match(String(r.args[0]).split(/[\\/]/).pop(), /^room-opencode-seat\.mjs$/)
  assert.equal(r.args[1], 'worker-1')
  assert.equal(r.args[r.args.indexOf('--token') + 1], 'seat-tok')
  assert.equal(r.args[r.args.indexOf('--room') + 1], 'http://127.0.0.1:8787')
  assert.equal(r.args[r.args.indexOf('--repo') + 1], '/repo')
})

test('a model and a timeout are passed only when chosen', () => {
  // Omitted means the launcher's own defaults win. Passing them explicitly
  // would silently pin whatever they happen to be today.
  const bare = workerRecipe({ repoRoot: '/repo', handle: 'w', token: 't', roomUrl: 'u', env: {} })
  assert.ok(!bare.args.includes('--model'))
  assert.ok(!bare.args.includes('--timeout'))

  const chosen = workerRecipe({
    repoRoot: '/repo', handle: 'w', token: 't', roomUrl: 'u',
    model: 'opencode/other-model', timeoutMs: 60000, env: {},
  })
  assert.equal(chosen.args[chosen.args.indexOf('--model') + 1], 'opencode/other-model')
  assert.equal(chosen.args[chosen.args.indexOf('--timeout') + 1], '60000')
})

test('the seat token never reaches the environment, only argv', () => {
  // The launcher reads --token. Putting it in env as well would widen where a
  // seat credential can be read from, for nothing.
  const r = workerRecipe({
    repoRoot: '/repo', handle: 'w', token: 'seat-tok', roomUrl: 'u', env: { PATH: '/bin' },
  })
  assert.ok(!JSON.stringify(r.opts.env).includes('seat-tok'))
  assert.equal(r.opts.env.PATH, '/bin', 'the inherited environment is preserved')
})

test('the worker runs in the repo, which is where its worktree is made', () => {
  const r = workerRecipe({ repoRoot: '/repo', handle: 'w', token: 't', roomUrl: 'u', env: {} })
  assert.equal(r.opts.cwd, '/repo')
})

test('handles are allocated in order and reuse a freed one', () => {
  assert.equal(nextHandle([]), 'worker-1')
  assert.equal(nextHandle(['worker-1']), 'worker-2')
  assert.equal(nextHandle(['worker-2']), 'worker-1', 'a freed handle is reused')
  assert.equal(nextHandle(['worker-1', 'worker-2', 'worker-3']), 'worker-4')
})

test('ensureOne mints a seat and starts exactly one worker', async () => {
  const { pool, invites, started } = fakePool()
  await pool.ensureOne()
  await pool.ensureOne() // idempotent

  assert.equal(invites.length, 1)
  assert.equal(invites[0].kind, 'agent')
  assert.equal(invites[0].handle, 'worker-1')
  assert.equal(invites[0].ownerId, 'owner-1')
  assert.equal(invites[0].delegatable, true, 'the orchestrator must be allowed to delegate to it')
  assert.equal(started.length, 1)
  assert.equal(pool.list().length, 1)
})

test('a worker starts in the starting state, not idle', () => {
  // It is not idle: it has no worktree and no opencode yet, and a delegation
  // sent now would fail. Saying "idle" would be a lie the sidebar repeats.
  const { pool } = fakePool()
  return pool.ensureOne().then(() => {
    assert.equal(pool.list()[0].state, 'starting')
  })
})

test('add() starts a second worker alongside the first', async () => {
  const { pool, started } = fakePool()
  await pool.ensureOne()
  await pool.add()
  assert.deepEqual(pool.list().map(w => w.handle), ['worker-1', 'worker-2'])
  assert.equal(started.length, 2)
})

test('a failed mint leaves no half-created worker in the list', async () => {
  const { pool, started } = fakePool({
    roomClient: { invite: async () => ({ ok: false, errors: ['handle-taken'] }) },
  })
  await pool.ensureOne()
  assert.deepEqual(pool.list(), [], 'a worker with no seat is not a worker')
  assert.equal(started.length, 0, 'nothing may be spawned without a seat token')
})

test('a pool that cannot learn the owner id does not invent one', async () => {
  // invite requires a real ownerId; guessing would mint a seat owned by
  // nobody, whose cost lands nowhere.
  const { pool, started } = fakePool({
    roomClient: {
      state: async () => null,
      invite: async () => assert.fail('must not invite without an owner'),
    },
  })
  await pool.ensureOne()
  assert.deepEqual(pool.list(), [])
  assert.equal(started.length, 0)
})

test('a spawn that throws does not leave the worker listed as live', async () => {
  // opencode missing from PATH is the common case, and it must degrade to
  // "no workers" rather than to a row that will never do anything.
  const { pool } = fakePool({
    supervisor: { start: () => { throw new Error('command not found on PATH: opencode') } },
  })
  await pool.ensureOne()
  assert.deepEqual(pool.list(), [])
})

test('stop removes the worker and reaps its process tree', async () => {
  const { pool, stopped } = fakePool()
  await pool.ensureOne()
  pool.stop('worker-1')
  assert.deepEqual(pool.list(), [])
  assert.deepEqual(stopped, ['worker:worker-1'])
})

test('listeners are told when the fleet changes, so the sidebar can redraw', async () => {
  const { pool } = fakePool()
  const seen = []
  pool.onChange(list => seen.push(list.length))
  await pool.ensureOne()
  pool.stop('worker-1')
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
