import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCommand, spawnPortable } from '../src/spawn.mjs'

const WIN = {
  platform: 'win32',
  env: { PATH: 'C:\\bin;C:\\other', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
}
const NIX = { platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' } }

test('a bare name resolves to the npm .cmd shim on Windows, and says it needs a shell', () => {
  // The whole reason this module exists: `spawn('opencode')` finds nothing on
  // Windows, because Node does not apply PATHEXT to a bare spawn.
  const found = resolveCommand('opencode', {
    ...WIN,
    exists: p => p === 'C:\\bin\\opencode.cmd',
  })
  assert.equal(found.path, 'C:\\bin\\opencode.cmd')
  assert.equal(found.needsShell, true)
})

test('a real executable is preferred over a shim, so no shell is involved when one is avoidable', () => {
  // A shell means quoting, and quoting means an injection surface. Take the
  // .exe whenever the machine offers one.
  const found = resolveCommand('claude', {
    ...WIN,
    exists: p => p === 'C:\\bin\\claude.exe' || p === 'C:\\bin\\claude.cmd',
  })
  assert.equal(found.path, 'C:\\bin\\claude.exe')
  assert.equal(found.needsShell, false)
})

test('PATH is searched in order, so an earlier directory wins', () => {
  const found = resolveCommand('opencode', {
    ...WIN,
    exists: p => p === 'C:\\bin\\opencode.exe' || p === 'C:\\other\\opencode.exe',
  })
  assert.equal(found.path, 'C:\\bin\\opencode.exe')
})

test('on POSIX a bare name resolves with no extension and never needs a shell', () => {
  const found = resolveCommand('opencode', {
    ...NIX,
    exists: p => p === '/usr/local/bin/opencode',
  })
  assert.equal(found.path, '/usr/local/bin/opencode')
  assert.equal(found.needsShell, false)
})

test('a path with a separator is used as given rather than searched for on PATH', () => {
  const found = resolveCommand('/opt/oc/opencode', {
    ...NIX,
    exists: p => p === '/opt/oc/opencode',
  })
  assert.equal(found.path, '/opt/oc/opencode')
})

test('a missing command resolves to null rather than throwing', () => {
  assert.equal(resolveCommand('nope', { ...NIX, exists: () => false }), null)
})

test('a synchronous EINVAL is delivered as an error event, not a crash', async () => {
  // Node throws EINVAL synchronously when asked to spawn a .cmd without a
  // shell. A caller that only registered child.on('error') would die instead
  // of handling it, so spawnPortable must convert it into the event shape
  // every caller already handles.
  const boom = () => {
    const err = new Error('spawn EINVAL')
    err.code = 'EINVAL'
    throw err
  }
  const child = spawnPortable('opencode', ['--version'], {}, {
    ...WIN,
    exists: p => p === 'C:\\bin\\opencode.cmd',
    spawnImpl: boom,
  })
  const err = await new Promise(resolve => child.on('error', resolve))
  assert.equal(err.code, 'EINVAL')
})

test('a command that cannot be found reports it as an error event too', async () => {
  const child = spawnPortable('nope', [], {}, {
    ...NIX,
    exists: () => false,
    spawnImpl: () => assert.fail('must not spawn when nothing was resolved'),
  })
  const err = await new Promise(resolve => child.on('error', resolve))
  assert.match(err.message, /not found/)
})

test('the failure stub carries usable streams, so callers need no special case', async () => {
  // run-model.mjs does child.stdout.on(...) unconditionally. A null stream
  // there would turn a missing binary into a TypeError.
  const child = spawnPortable('nope', [], {}, { ...NIX, exists: () => false })
  assert.doesNotThrow(() => child.stdout.on('data', () => {}))
  assert.doesNotThrow(() => child.stdin.end('x'))
  await new Promise(resolve => child.on('error', resolve))
})

test('a shell is requested only for the shim, never for a real executable', () => {
  const seen = []
  const spy = (path, args, opts) => { seen.push(opts.shell); return { on() {} } }
  spawnPortable('claude', [], {}, {
    ...WIN, exists: p => p === 'C:\\bin\\claude.exe', spawnImpl: spy,
  })
  spawnPortable('opencode', [], {}, {
    ...WIN, exists: p => p === 'C:\\bin\\opencode.cmd', spawnImpl: spy,
  })
  assert.deepEqual(seen, [false, true])
})
