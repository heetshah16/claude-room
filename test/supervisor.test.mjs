import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSupervisor } from '../src/supervisor.mjs'

/** A child that never exits until the test says so. */
function fakeChild(pid = 100) {
  const c = new EventEmitter()
  c.pid = pid
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.stdin = { write() {}, end() {} }
  return c
}

function harness({ children = [] } = {}) {
  const spawned = []
  const killed = []
  const logged = []
  let i = 0
  const sup = createSupervisor({
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return children[i++] ?? fakeChild(100 + i)
    },
    killTree: pid => killed.push(pid),
    log: s => logged.push(s),
  })
  return { sup, spawned, killed, logged }
}

test('a started child is reported running, with the recipe it was actually given', () => {
  const { sup, spawned } = harness()
  sup.start('worker:worker-1', { cmd: 'node', args: ['launcher.mjs'], opts: { env: { A: '1' } } })
  assert.equal(sup.status('worker:worker-1').state, 'running')
  assert.deepEqual(spawned[0].args, ['launcher.mjs'])
  assert.equal(spawned[0].opts.env.A, '1')
})

test('a child that dies on its own is reported, never silently forgotten', () => {
  // A worker dying while the fleet still lists it as idle is the worst
  // failure this can have: the orchestrator delegates into a corpse.
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  child.emit('exit', 3)
  assert.deepEqual(seen, [{ name: 'worker:worker-1', code: 3 }])
  assert.equal(sup.status('worker:worker-1').state, 'exited')
})

test('a launch error surfaces as an exit rather than an unhandled throw', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('worker:worker-1', { cmd: 'nope', args: [] })
  child.emit('error', new Error('command not found on PATH: nope'))
  assert.equal(seen.length, 1)
  assert.match(sup.status('worker:worker-1').error, /not found on PATH/)
})

test('stopping kills the whole tree, because killing the child orphans opencode', () => {
  // On Windows `opencode` is an npm .cmd shim, so the process we hold is
  // cmd.exe; killing it leaves the real server holding its port and worktree.
  // Observed twice for real while building the OpenCode seat.
  const child = fakeChild(4242)
  const { sup, killed } = harness({ children: [child] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.stop('worker:worker-1')
  assert.deepEqual(killed, [4242])
  assert.equal(sup.status('worker:worker-1').state, 'stopped')
})

test('a stop we asked for is not reported as a crash', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.stop('worker:worker-1')
  child.emit('exit', 0)
  assert.deepEqual(seen, [], 'shutting a worker down is not an incident')
})

test('stopAll tears children down in reverse start order', () => {
  const a = fakeChild(1), b = fakeChild(2), c = fakeChild(3)
  const { sup, killed } = harness({ children: [a, b, c] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.start('worker:worker-2', { cmd: 'node', args: [] })
  sup.start('worker:worker-3', { cmd: 'node', args: [] })
  sup.stopAll()
  assert.deepEqual(killed, [3, 2, 1])
})

test('starting a name twice reaps the first child rather than leaking it', () => {
  const a = fakeChild(1), b = fakeChild(2)
  const { sup, killed } = harness({ children: [a, b] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  assert.deepEqual(killed, [1])
  assert.equal(sup.status('worker:worker-1').pid, 2)
})

test('stderr is drained and logged, so a crash has a reason and not just a code', () => {
  // Nothing else reads the pipe: unread, it fills, and the child stalls.
  const child = fakeChild()
  const { sup, logged } = harness({ children: [child] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  child.stderr.emit('data', 'opencode did not answer\n')
  assert.match(logged.join(''), /did not answer/)
})

test('stdout is kept as a bounded tail, readable through status', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  child.stdout.emit('data', 'x'.repeat(5000))
  child.stdout.emit('data', 'LAST')
  const out = sup.status('worker:worker-1').output
  assert.ok(out.endsWith('LAST'))
  assert.ok(out.length <= 4096, 'a long-lived chatty child must not grow this without limit')
})

test('status for a name that was never started is stopped, not a crash', () => {
  const { sup } = harness()
  assert.deepEqual(sup.status('worker:nope'), { state: 'stopped', pid: null, error: null, output: '' })
})
