/**
 * The OpenCode launcher's process lifecycle.
 *
 * Nothing here may touch the real `opencode` binary — it is a network and
 * model dependency, and the probe showed it is unreliable. These tests cover
 * only what the launcher does with the child process handle it holds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { killTree } from '../scripts/room-opencode-seat.mjs'

test('shutdown on Windows reaps the whole process tree, not just the shim it holds', () => {
  // Observed for real during the smoke test: `opencode` is an npm .cmd shim,
  // so the handle we hold is an interpreter. Killing it orphaned the actual
  // `opencode serve`, which went on holding the worktree and the port until
  // strays were hunted down by hand.
  const calls = []
  killTree({ pid: 4242, kill: () => calls.push('kill') }, {
    platform: 'win32',
    spawn: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { on() {} } },
  })
  assert.deepEqual(calls, ['taskkill /T /F /PID 4242'])
})

test('shutdown on POSIX still uses child.kill(), because there is no shim to orphan', () => {
  const calls = []
  killTree({ pid: 7, kill: () => calls.push('kill') }, {
    platform: 'linux',
    spawn: () => assert.fail('taskkill does not exist off Windows'),
  })
  assert.deepEqual(calls, ['kill'])
})

test('a kill that fails is swallowed, because shutdown must never hang or throw', () => {
  // The likeliest failure is "the process is already gone", which is exactly
  // the case where refusing to exit would be worst.
  assert.doesNotThrow(() => killTree({ pid: 9, kill() { throw new Error('ESRCH') } }, {
    platform: 'linux',
  }))
  assert.doesNotThrow(() => killTree({ pid: 9 }, {
    platform: 'win32',
    spawn() { throw new Error('taskkill missing') },
  }))
})

test('a launcher that never started a child has nothing to kill', () => {
  // `--attach <url>` reuses somebody else's server; killing it would take
  // down a process this launcher does not own.
  assert.doesNotThrow(() => killTree(null, {
    platform: 'win32',
    spawn: () => assert.fail('must not kill anything when no child was started'),
  }))
})
