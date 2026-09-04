import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCommand, spawnPortable, quoteForCmd } from '../src/spawn.mjs'

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

test('a real executable is spawned directly, with no shell and no cmd.exe anywhere', () => {
  // The point this has always defended: a shell means quoting, and quoting is
  // an injection surface. When the machine offers a real .exe, nothing about
  // the launch may involve an interpreter.
  const seen = []
  const spy = (file, args, opts) => { seen.push({ file, args, opts }); return { on() {} } }
  spawnPortable('claude', ['--add-dir', 'C:\\My Repo'], {}, {
    ...WIN, exists: p => p === 'C:\\bin\\claude.exe', spawnImpl: spy,
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].file, 'C:\\bin\\claude.exe')
  assert.deepEqual(seen[0].args, ['--add-dir', 'C:\\My Repo'])
  assert.equal(seen[0].opts.shell, false)
  assert.equal(seen[0].opts.windowsVerbatimArguments, undefined)
})

test('the .cmd shim goes through cmd.exe explicitly, never through Node shell:true', () => {
  // Node's shell:true joins argv with plain spaces and quotes NOTHING, so
  // `--add-dir C:\My Repo` arrives at the shim as two arguments. Driving
  // cmd.exe ourselves with windowsVerbatimArguments is what keeps our
  // quoting intact.
  const seen = []
  const spy = (file, args, opts) => { seen.push({ file, args, opts }); return { on() {} } }
  spawnPortable('opencode', ['--add-dir', 'C:\\My Repo'], {}, {
    ...WIN, exists: p => p === 'C:\\bin\\opencode.cmd', spawnImpl: spy,
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].file, 'cmd.exe')
  assert.equal(seen[0].opts.shell, false, 'shell:true is exactly what this replaces')
  assert.equal(seen[0].opts.windowsVerbatimArguments, true)
  assert.deepEqual(seen[0].args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(seen[0].args[3], '"C:\\bin\\opencode.cmd --add-dir "C:\\My Repo""')
})

test('an argument with a space survives the shim path instead of being split in two', () => {
  // The bug in the field: this repo\'s own path contains a space, and
  // scripts/room-seat.mjs passes three such paths (--mcp-config, --settings,
  // --add-dir). Unquoted, each became two arguments and the seat launched
  // with a corrupted argv.
  assert.equal(quoteForCmd('C:\\Program Files\\node\\node.exe'), '"C:\\Program Files\\node\\node.exe"')
})

test('a plain argument is passed through untouched, so ordinary launches read normally', () => {
  assert.equal(quoteForCmd('--add-dir'), '--add-dir')
})

test('an embedded double quote is doubled, so cmd never leaves the quoted region', () => {
  // `\"` would satisfy the argv splitter but not cmd, which knows no backslash
  // escapes: cmd would close the quoted region there and read the rest of the
  // line — including the NEXT argument — unquoted. `""` is read as one literal
  // quote by both parsers and leaves the quote state balanced.
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""')
})

test('a quote in one argument cannot smuggle a second command into the next one', () => {
  // Not cosmetic: under `\"` escaping, ['x"y', 'a b& echo PWNED'] really did
  // run `echo PWNED` — the unbalanced quote left `&` outside any quoted region.
  // Verified against a real cmd.exe; both arguments now round-trip intact.
  const line = ['x"y', 'a b& echo PWNED'].map(quoteForCmd).join(' ')
  assert.equal(line, '"x""y" "a b& echo PWNED"')
  // Every quote in the line pairs up, which is what denies cmd an unquoted
  // region to find a metacharacter in.
  assert.equal((line.match(/"/g) ?? []).length % 2, 0)
})

test('a cmd.exe metacharacter outside quotes is escaped, closing the injection surface', () => {
  // configDir embeds an unsanitised handle. Unescaped, `a&calc` would run
  // calc.exe as a second command rather than being passed to the seat.
  assert.equal(quoteForCmd('a&calc'), 'a^&calc')
  assert.equal(quoteForCmd('a|b'), 'a^|b')
  // Inside a quoted region cmd does not parse the metacharacter, and a caret
  // there would be passed through as a literal character instead.
  assert.equal(quoteForCmd('a b&c'), '"a b&c"')
})
