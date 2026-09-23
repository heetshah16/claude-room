// test/workers.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { createWorkerFleet, nextHandle, worktreeFor, workerRecipe, listWorkersView } from '../src/workers.mjs'
import { worktreeFor as launcherWorktreeFor } from '../scripts/room-seat.mjs'
import { Registry, createMember, createAgentMember, isDelegatable } from '../src/identity.mjs'
import { Seats } from '../src/seats.mjs'
import { loadConfig } from '../src/config.mjs'

function fakeChild(pid = 500) {
  const c = new EventEmitter()
  c.pid = pid
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  return c
}

function fleetHarness({ owner = true, spawnImpl = null } = {}) {
  const registry = new Registry()
  if (owner) registry.add(createMember({ name: 'heet', role: 'owner' }))
  const seats = new Seats()
  const saved = []
  const published = []
  const spawned = []
  const children = []
  const fleet = createWorkerFleet({
    registry,
    seats,
    config: loadConfig({}),
    store: { saveRegistry: r => saved.push(r.all().length) },
    bus: { publish: (e, d) => published.push([e, d]) },
    spawn: spawnImpl ?? ((cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      const c = fakeChild(500 + children.length)
      children.push(c)
      return c
    }),
    repoRoot: '/repo',
    roomUrl: 'http://127.0.0.1:8787',
    log: () => {},
    now: () => 1,
  })
  return { fleet, registry, seats, saved, published, spawned, children }
}

test('nextHandle takes the lowest free number, so a stopped worker\'s handle comes back', () => {
  assert.equal(nextHandle([]), 'worker-1')
  assert.equal(nextHandle(['worker-1', 'worker-2']), 'worker-3')
  assert.equal(nextHandle(['worker-1', 'worker-3']), 'worker-2')
})

test('the fleet derives the same worktree path the launcher actually creates', () => {
  // src/ must not import from scripts/ (the dependency runs the other way), so
  // this two-line function is duplicated. This is the guard against drift: if
  // either side changes, a worker verifies in a directory nobody wrote to.
  for (const h of ['worker-1', '@Worker-2', 'ana agent']) {
    assert.equal(worktreeFor('/repo', h), launcherWorktreeFor('/repo', h))
  }
  assert.equal(worktreeFor('/repo', 'worker-1'), join('/repo', '.worktrees', 'worker-1'))
})

test('the recipe runs the opencode launcher with the seat token, repo and room URL', () => {
  const r = workerRecipe({
    repoRoot: '/repo', handle: 'worker-1', token: 'tok', roomUrl: 'http://r:1',
    nodePath: '/usr/bin/node', launcher: '/room/scripts/room-opencode-seat.mjs', env: { PATH: '/bin' },
  })
  assert.equal(r.cmd, '/usr/bin/node')
  assert.deepEqual(r.args, [
    '/room/scripts/room-opencode-seat.mjs', 'worker-1',
    '--token', 'tok', '--repo', '/repo', '--room', 'http://r:1',
  ])
  assert.equal(r.opts.cwd, '/repo')
  assert.deepEqual(r.opts.stdio, ['ignore', 'pipe', 'pipe'])
})

test('a model is only passed when one was asked for, so the launcher\'s default still wins', () => {
  const bare = workerRecipe({ repoRoot: '/r', handle: 'w', token: 't', roomUrl: 'u' })
  assert.equal(bare.args.includes('--model'), false)
  const pinned = workerRecipe({ repoRoot: '/r', handle: 'w', token: 't', roomUrl: 'u', model: 'opencode/x' })
  assert.deepEqual(pinned.args.slice(-2), ['--model', 'opencode/x'])
})

test('a spawned worker is minted as a delegatable agent seat, addressable the moment spawn returns', async () => {
  // delegatable is unconditional here: a self-spawned worker exists to be
  // delegated to, so making that opt-in would be friction with no decision
  // behind it. And Queue.#addressableHandles unions registry agent handles, so
  // registering the member IS what makes @worker-1 route.
  const { fleet, registry, saved } = fleetHarness()
  const r = await fleet.spawn({})
  assert.deepEqual(r, { ok: true, handle: 'worker-1' })
  const member = registry.byHandle('worker-1')
  assert.ok(member, 'the seat must exist on the roster')
  assert.equal(isDelegatable(member), true)
  assert.equal(member.ownerId, registry.owners()[0].id, 'the cost lands on a real owner')
  assert.equal(saved.length, 1, 'and the roster is persisted, or a restart loses the seat')
})

test('the worker is launched with its own freshly minted token, never a guessed one', async () => {
  const { fleet, registry, spawned } = fleetHarness()
  await fleet.spawn({})
  const member = registry.byHandle('worker-1')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--token') + 1], member.token)
})

test('a second worker gets the next handle rather than colliding with the first', async () => {
  const { fleet } = fleetHarness()
  await fleet.spawn({})
  const second = await fleet.spawn({})
  assert.equal(second.handle, 'worker-2')
})

test('a handle already held by a hand-minted seat is skipped, not reused', async () => {
  // `room-admin seat add worker-1` is a perfectly legal thing to have done.
  const { fleet, registry } = fleetHarness()
  const owner = registry.owners()[0]
  registry.add(createAgentMember({ name: 'worker-1', handle: 'worker-1', ownerId: owner.id }))
  const r = await fleet.spawn({})
  assert.equal(r.handle, 'worker-2')
})

test('a room with no owner refuses to spawn, because the cost would land nowhere', async () => {
  const { fleet, spawned } = fleetHarness({ owner: false })
  const r = await fleet.spawn({})
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /owner/)
  assert.equal(spawned.length, 0, 'nothing may be launched for a seat nobody pays for')
})

test('a launch failure revokes the seat it just minted, leaving no phantom on the roster', async () => {
  // A seat with no process is worse than no seat: the orchestrator sees a
  // handle in the roster and delegates into something that will never answer.
  const { fleet, registry } = fleetHarness({
    spawnImpl: () => { throw new Error('EINVAL') },
  })
  const r = await fleet.spawn({})
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /EINVAL/)
  assert.equal(registry.byHandle('worker-1'), null)
})

test('a worker is listed as starting until its seat joins, which is how readiness is discovered', async () => {
  // Spawn returns once the process is LAUNCHED, matching delegate's own
  // fire-and-forget shape. Readiness is a fact about the seat feed, and
  // Seats already owns that fact.
  const { fleet, registry, seats } = fleetHarness()
  await fleet.spawn({})
  assert.equal(fleet.list()[0].state, 'starting')
  seats.join(registry.byHandle('worker-1'), { write() {} })
  assert.equal(fleet.list()[0].state, 'online')
})

test('a worker that dies on its own is listed as exited rather than silently left online', async () => {
  const { fleet, children, published } = fleetHarness()
  await fleet.spawn({})
  children[0].emit('exit', 1)
  const row = fleet.list()[0]
  assert.equal(row.state, 'exited')
  assert.equal(row.exitCode, 1)
  assert.ok(
    published.some(([e, d]) => e === 'worker' && d.handle === 'worker-1' && d.state === 'exited'),
    'the room must say so, or a browser shows a worker that no longer exists',
  )
})

test('stopping a worker kills its tree, retires its seat and frees the handle', async () => {
  const { fleet, registry, seats, children } = fleetHarness()
  await fleet.spawn({})
  const member = registry.byHandle('worker-1')
  let ended = 0
  seats.join(member, { end() { ended++ }, write() {} })

  assert.deepEqual(fleet.stop('worker-1'), { ok: true })
  assert.equal(ended, 1, 'the seat feed goes with the process')
  assert.equal(registry.byHandle('worker-1'), null, 'and the credential dies with it')
  assert.deepEqual(fleet.list(), [])
  const next = await fleet.spawn({})
  assert.equal(next.handle, 'worker-1', 'the handle is genuinely free again')
  assert.equal(children.length, 2)
})

test('stopping a worker this fleet does not own is refused, never a silent no-op', async () => {
  const { fleet } = fleetHarness()
  const r = fleet.stop('worker-9')
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /worker-9/)
})

test('stopAll stops every worker, so shutting the room down does not orphan opencode', async () => {
  const { fleet } = fleetHarness()
  await fleet.spawn({})
  await fleet.spawn({})
  fleet.stopAll()
  assert.deepEqual(fleet.list(), [])
})

test('a room-wide worker model is used when set, and the launcher default when not', async () => {
  const { fleet, spawned } = fleetHarness()
  await fleet.spawn({ model: 'opencode/other-free' })
  assert.deepEqual(spawned[0].args.slice(-2), ['--model', 'opencode/other-free'])
})

test('every online seat is listed as online, whatever kind of seat it is', () => {
  const rows = listWorkersView({
    onlineSeats: [{ handle: 'claude-1' }, { handle: 'worker-1' }],
    isBusy: h => h === 'worker-1',
    fleetWorkers: [],
  })
  assert.deepEqual(rows, [
    { handle: 'claude-1', busy: false, state: 'online' },
    { handle: 'worker-1', busy: true, state: 'online' },
  ])
})

test('a fleet worker still starting is listed, though no seat feed exists for it yet', () => {
  const rows = listWorkersView({
    onlineSeats: [],
    isBusy: () => false,
    fleetWorkers: [{ handle: 'worker-1', state: 'starting', model: null, worktree: '/w', exitCode: null, startedAt: 1 }],
  })
  assert.deepEqual(rows, [{ handle: 'worker-1', busy: false, state: 'starting' }])
})

test('a fleet worker that exited is listed as exited, not silently dropped', () => {
  const rows = listWorkersView({
    onlineSeats: [],
    isBusy: () => false,
    fleetWorkers: [{ handle: 'worker-1', state: 'exited', model: null, worktree: '/w', exitCode: 1, startedAt: 1 }],
  })
  assert.deepEqual(rows, [{ handle: 'worker-1', busy: false, state: 'exited' }])
})

test('a fleet worker that is online is never listed twice', () => {
  const rows = listWorkersView({
    onlineSeats: [{ handle: 'worker-1' }],
    isBusy: () => true,
    fleetWorkers: [{ handle: 'worker-1', state: 'online', model: null, worktree: '/w', exitCode: null, startedAt: 1 }],
  })
  assert.deepEqual(rows, [{ handle: 'worker-1', busy: true, state: 'online' }])
})

test('with no fleet at all, the view is exactly what seats.online() already gave', () => {
  const rows = listWorkersView({ onlineSeats: [{ handle: 'claude-1' }], isBusy: () => false, fleetWorkers: [] })
  assert.deepEqual(rows, [{ handle: 'claude-1', busy: false, state: 'online' }])
})
