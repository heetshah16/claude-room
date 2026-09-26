// extension/test/supervisor.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createSupervisor } = require('../src/supervisor.js')

/** A child that never exits until told to. */
function fakeChild(pid = 100) {
  const c = new EventEmitter()
  c.pid = pid
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.stdin = { write() {}, end() {} }
  c.kill = () => { c.killed = true }
  return c
}

function harness({ children = [] } = {}) {
  const spawned = []
  const killed = []
  let i = 0
  const sup = createSupervisor({
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return children[i++] ?? fakeChild(100 + i)
    },
    killTree: pid => killed.push(pid),
    log: () => {},
    setTimer: (fn, ms) => setTimeout(fn, ms).unref?.() ?? 0,
    clearTimer: () => {},
  })
  return { sup, spawned, killed }
}

test('a started child is reported running, with the recipe it was given', () => {
  const { sup, spawned } = harness()
  sup.start('room', { cmd: 'node', args: ['server.mjs'], opts: { env: { A: '1' } } })
  assert.equal(sup.status('room').state, 'running')
  assert.deepEqual(spawned[0].args, ['server.mjs'])
  assert.equal(spawned[0].opts.env.A, '1')
})

test('a child that exits is reported, never silently forgotten', () => {
  // The room dying while the chat still accepts input is the worst failure
  // this design can have, so an exit has to become a visible event.
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('room', { cmd: 'node', args: [] })
  child.emit('exit', 3)
  assert.deepEqual(seen, [{ name: 'room', code: 3 }])
  assert.equal(sup.status('room').state, 'exited')
})

test('a spawn error surfaces as an exit rather than an unhandled throw', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('room', { cmd: 'nope', args: [] })
  child.emit('error', new Error('ENOENT'))
  assert.equal(seen.length, 1)
  assert.match(sup.status('room').error, /ENOENT/)
})

test('stopping kills the whole tree, because killing the child orphans the server', () => {
  // On Windows a .cmd shim runs under cmd.exe: child.kill() kills the shell
  // and leaves the real process holding its port and worktree.
  const child = fakeChild(4242)
  const { sup, killed } = harness({ children: [child] })
  sup.start('worker', { cmd: 'opencode', args: [] })
  sup.stop('worker')
  assert.deepEqual(killed, [4242])
  assert.equal(sup.status('worker').state, 'stopped')
})

test('stopAll stops every child, in reverse start order', () => {
  // Workers depend on the room; tearing the room down first would make every
  // worker's last act a pile of failed requests.
  const a = fakeChild(1), b = fakeChild(2), c = fakeChild(3)
  const { sup, killed } = harness({ children: [a, b, c] })
  sup.start('room', { cmd: 'r', args: [] })
  sup.start('orchestrator', { cmd: 'o', args: [] })
  sup.start('worker', { cmd: 'w', args: [] })
  sup.stopAll()
  assert.deepEqual(killed, [3, 2, 1])
})

test('an intentional stop does not report an exit, so shutdown is quiet', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('room', { cmd: 'r', args: [] })
  sup.stop('room')
  child.emit('exit', 0)
  assert.deepEqual(seen, [], 'a stop we asked for is not a crash')
})

test('starting a name twice replaces the old child rather than leaking it', () => {
  const a = fakeChild(1), b = fakeChild(2)
  const { sup, killed } = harness({ children: [a, b] })
  sup.start('room', { cmd: 'r', args: [] })
  sup.start('room', { cmd: 'r', args: [] })
  assert.deepEqual(killed, [1], 'the first child must be reaped')
  assert.equal(sup.status('room').pid, 2)
})

// --- restarting a child in place -------------------------------------------
//
// Publishing the room and changing the permission mode both work by starting
// the same name again with different arguments. Neither may look like a crash.

test('starting a name that is already running replaces it, killing the old tree', () => {
  const h = harness()
  const first = h.sup.start('room', { cmd: 'node', args: [], opts: { env: { ROOM_HOST: '127.0.0.1' } } })
  h.sup.start('room', { cmd: 'node', args: [], opts: { env: { ROOM_HOST: '0.0.0.0' } } })

  assert.deepEqual(h.killed, [first.pid], 'the old room must be reaped, not orphaned')
  assert.equal(h.spawned.length, 2)
  assert.equal(h.spawned[1].opts.env.ROOM_HOST, '0.0.0.0')
})

test('replacing a child does not report the old one as having crashed', () => {
  // Without this the chat shows "room exited unexpectedly" every single time
  // the user publishes, which reads as the feature being broken.
  const oldChild = fakeChild(1)
  const newChild = fakeChild(2)
  const h = harness({ children: [oldChild, newChild] })
  const exits = []
  h.sup.on('exit', e => exits.push(e))

  h.sup.start('room', { cmd: 'node', args: [], opts: {} })
  h.sup.start('room', { cmd: 'node', args: [], opts: {} })
  oldChild.emit('exit', 0) // the replaced process finally dies

  assert.deepEqual(exits, [], 'a replaced child is not a crash')
})

test('the replacement is still watched, so a real crash after one is reported', () => {
  const oldChild = fakeChild(1)
  const newChild = fakeChild(2)
  const h = harness({ children: [oldChild, newChild] })
  const exits = []
  h.sup.on('exit', e => exits.push(e))

  h.sup.start('room', { cmd: 'node', args: [], opts: {} })
  h.sup.start('room', { cmd: 'node', args: [], opts: {} })
  newChild.emit('exit', 1)

  assert.deepEqual(exits, [{ name: 'room', code: 1 }], 'the live child must still be watched')
})

// --- publishing through a tunnel -------------------------------------------

test('publishing starts a tunnel alongside the room, keyed off the room\'s own port', () => {
  const { sup, spawned } = harness()
  const port = 4321
  sup.start('room', { cmd: 'node', args: ['server.mjs'], opts: { env: { ROOM_PORT: String(port) } } })
  sup.start('tunnel', { cmd: 'devtunnel', args: ['host', '-p', String(port), '--allow-anonymous'] })
  assert.equal(sup.status('tunnel').state, 'running')
  assert.deepEqual(spawned[1].args, ['host', '-p', '4321', '--allow-anonymous'])
})

test('un-publishing stops the tunnel, not just the room', () => {
  const child = fakeChild(999)
  const { sup, killed } = harness({ children: [fakeChild(1), child] })
  sup.start('room', { cmd: 'node', args: [] })
  sup.start('tunnel', { cmd: 'devtunnel', args: [] })
  sup.stop('tunnel')
  assert.deepEqual(killed, [999])
  assert.equal(sup.status('tunnel').state, 'stopped')
})

test('stdout is buffered and readable through status, bounded so it cannot grow forever', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  sup.start('tunnel', { cmd: 'devtunnel', args: [] })
  child.stdout.emit('data', 'Connect via browser: https://abc-1234.devtunnels.ms\n')
  assert.match(sup.status('tunnel').output, /devtunnels\.ms/)
})

test('stderr is buffered and readable through status too, the same way stdout is', () => {
  // devtunnel prints why it failed on stderr, not stdout -- a caller cannot
  // explain a failure with a channel that was thrown away.
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  sup.start('tunnel', { cmd: 'devtunnel', args: [] })
  child.stderr.emit('data', 'Error: not logged in\n')
  assert.match(sup.status('tunnel').errOutput, /not logged in/)
})
