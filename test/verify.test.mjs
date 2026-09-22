import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { verifyDelegation, splitCommand, truncateTail, MAX_OUTPUT } from '../src/verify.mjs'

/** A child under our control: nothing here launches a real process. */
function fakeChild() {
  const c = new EventEmitter()
  c.pid = 777
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  return c
}

/**
 * A spawn that records its calls and hands each child a scripted outcome.
 * `script` is one entry per expected command.
 */
function fakeSpawn(script = []) {
  const calls = []
  let i = 0
  const spawn = (name, args, opts) => {
    calls.push({ name, args, opts })
    const child = fakeChild()
    const step = script[i++] ?? { code: 0 }
    if (step.hang) return child
    queueMicrotask(() => {
      if (step.stdout) child.stdout.emit('data', step.stdout)
      if (step.stderr) child.stderr.emit('data', step.stderr)
      if (step.error) child.emit('error', new Error(step.error))
      else child.emit('exit', step.code)
    })
    return child
  }
  return { spawn, calls }
}

test('a command string becomes a program plus argv, so no shell is ever involved', () => {
  // A shell would mean quoting an orchestrator-authored string, which is the
  // injection surface src/spawn.mjs exists to avoid.
  assert.deepEqual(splitCommand('node --test math.test.mjs'), ['node', '--test', 'math.test.mjs'])
})

test('a quoted path with a space stays one argument, because this repo has one', () => {
  assert.deepEqual(
    splitCommand('node --test "C:\\My Repo\\math.test.mjs"'),
    ['node', '--test', 'C:\\My Repo\\math.test.mjs'],
  )
})

test('an empty or blank command produces no tokens rather than an empty program name', () => {
  assert.deepEqual(splitCommand('   '), [])
  assert.deepEqual(splitCommand(null), [])
})

test('a class with no tests reports that nothing ran, and claims nothing', async () => {
  // reasoning/verification delegations have nothing mechanical to check.
  // ok:null is the honest answer; ok:false would libel them.
  const { spawn, calls } = fakeSpawn()
  const r = await verifyDelegation({ tests: [], cwd: '/w', spawn })
  assert.deepEqual(r, { ran: false, ok: null, exitCode: null, output: '', timedOut: false })
  assert.equal(calls.length, 0)
})

test('a passing command is verified, and runs in the worktree it was given', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 0, stdout: 'pass 12\n' }])
  const r = await verifyDelegation({ tests: ['node --test'], cwd: '/repo/.worktrees/worker-1', spawn })
  assert.equal(r.ran, true)
  assert.equal(r.ok, true)
  assert.equal(r.exitCode, 0)
  assert.match(r.output, /pass 12/)
  assert.equal(calls[0].name, 'node')
  assert.deepEqual(calls[0].args, ['--test'])
  assert.equal(calls[0].opts.cwd, '/repo/.worktrees/worker-1')
})

test('the first failing command stops the run, because the rest is noise', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 1, stderr: 'not ok 3\n' }, { code: 0 }])
  const r = await verifyDelegation({ tests: ['npm test', 'npm run lint'], cwd: '/w', spawn })
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 1)
  assert.match(r.output, /not ok 3/, 'the real output is what makes a failure repairable')
  assert.equal(calls.length, 1, 'the second command must not run after the first failed')
})

test('every command must pass before the work is called verified', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 0 }, { code: 0 }])
  const r = await verifyDelegation({ tests: ['npm test', 'npm run lint'], cwd: '/w', spawn })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
})

test('stderr counts as output too, because a runner puts the failure on either stream', async () => {
  const { spawn } = fakeSpawn([{ code: 1, stdout: 'ran 4\n', stderr: 'AssertionError\n' }])
  const r = await verifyDelegation({ tests: ['npm test'], cwd: '/w', spawn })
  assert.match(r.output, /ran 4/)
  assert.match(r.output, /AssertionError/)
})

test('output is truncated to the last 2048 bytes, so a chatty suite cannot flood the channel', async () => {
  // The tail, not the head: a test runner prints its failure summary last.
  const { spawn } = fakeSpawn([{ code: 1, stdout: 'x'.repeat(9000) + 'TAIL' }])
  const r = await verifyDelegation({ tests: ['npm test'], cwd: '/w', spawn })
  assert.ok(Buffer.byteLength(r.output) <= MAX_OUTPUT)
  assert.ok(r.output.endsWith('TAIL'))
})

test('truncation counts bytes, not code units, so multibyte output is still bounded', () => {
  const out = truncateTail('\u3042'.repeat(2000), 2048)
  assert.ok(Buffer.byteLength(out) <= 2048)
})

test('a hanging command is killed and reported as a timeout, not left wedging the delegation', async () => {
  // Spec §2.4: verification has its own deadline, independent of the worker's
  // turn deadline. A test command that never returns must not hold a
  // delegation open forever.
  const { spawn } = fakeSpawn([{ hang: true }])
  const killed = []
  const r = await verifyDelegation({
    tests: ['npm test'], cwd: '/w', timeoutMs: 20, spawn, killTree: pid => killed.push(pid),
  })
  assert.equal(r.timedOut, true)
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, null)
  assert.deepEqual(killed, [777], 'the tree goes, not just the process we happen to hold')
})

test('a command that cannot be launched is a failure with a reason, never a crash', async () => {
  const { spawn } = fakeSpawn([{ error: 'command not found on PATH: pytest' }])
  const r = await verifyDelegation({ tests: ['pytest'], cwd: '/w', spawn })
  assert.equal(r.ok, false)
  assert.match(r.output, /not found on PATH/)
})

test('a blank entry in tests is skipped rather than spawning an empty program', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 0 }])
  const r = await verifyDelegation({ tests: ['  ', 'npm test'], cwd: '/w', spawn })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'npm')
})
