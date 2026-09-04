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
