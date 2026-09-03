# Super Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode as a second harness in the room — a seat a human can address, and a target the orchestrating Claude can delegate scoped tasks to.

**Architecture:** The room's HTTP seat protocol (`/seat/join`, `/seat/events`, `/seat/reply`, `/seat/hook/*`) is already the boundary, so the room core is untouched. A new driver process translates room events into OpenCode HTTP calls and OpenCode bus events back into room hook calls. OpenCode discards `claude/channel` notifications, so delivery is always an outbound call from the driver; a free-tier model can stall forever, so the driver owns a per-turn deadline.

**Tech Stack:** Node 22+, ESM, `node --test`, `node:assert/strict`, `@modelcontextprotocol/sdk` (the only runtime dependency — do not add others).

**Spec:** `docs/superpowers/specs/2026-09-04-super-harness-design.md`

## Global Constraints

- **Node 22+**, ESM only (`import`, not `require`). `"type": "module"`.
- **No new runtime dependencies.** `@modelcontextprotocol/sdk` is the only one and stays the only one. Test helpers use `node:http`, never a framework.
- **Tests must not require the `opencode` or `claude` binary.** `node --test` runs offline against injected fakes. Real-binary runs are a manual smoke test.
- **Everything OS-agnostic.** Never hard-code `/` or `\` in a path — use `node:path`. Never read `process.platform` or `process.env` directly inside a pure function; take them as parameters so Windows behaviour is testable from POSIX and vice versa.
- **stdout belongs to the MCP protocol** in `src/server.mjs`, `src/seat.mjs` and any new stdio server. Every log line goes to **stderr**.
- **Rejections must be visible, never silent.** A dropped message the sender believes landed is the worst failure this system can have.
- **Fail closed on authorisation.** An absent or unrecognised `delegatable` value means not delegatable.
- Test style: `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`. Test names state the *why*, not the mechanics — match the voice in `test/address-policy.test.mjs`.
- Commit after every task with a `feat:` / `fix:` / `docs:` prefix.

---

### Task 1: Portable command resolution and spawning

**Files:**
- Create: `src/spawn.mjs`
- Test: `test/spawn.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveCommand(name, { env, platform, exists }) -> { path: string, needsShell: boolean } | null`
  - `spawnPortable(name, args, opts, { spawnImpl, env, platform, exists }) -> ChildProcess-like`

**Background:** `spawn('opencode')` fails ENOENT on Windows because npm installs a `.cmd` shim and Node does not apply `PATHEXT` to a bare spawn. Spawning the `.cmd` explicitly throws **EINVAL synchronously** (Node's CVE-2024-27980 mitigation), which bypasses `child.on('error')` and crashes the caller. Both were reproduced on Windows against a real npm install.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/spawn.test.mjs
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/spawn.test.mjs`
Expected: FAIL — `Cannot find module '../src/spawn.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// src/spawn.mjs
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { delimiter, join, extname } from 'node:path'

/** `.cmd` and `.bat` are batch scripts: Node refuses to spawn them without a shell. */
const isBatch = ext => /^\.(cmd|bat)$/i.test(ext)

/**
 * Find the real file a command name refers to, the way the OS would.
 *
 * `env` and `platform` are parameters rather than globals so Windows
 * resolution can be tested from POSIX and vice versa — the whole class of
 * bug this module fixes is one that only appears on the other platform.
 *
 * @returns {{path:string, needsShell:boolean}|null}
 */
export function resolveCommand(name, opts = {}) {
  const {
    env = process.env,
    platform = process.platform,
    exists = existsSync,
  } = opts

  const isWin = platform === 'win32'
  const raw = String(name)

  // An explicit path is an instruction, not a search term.
  const bases = raw.includes('/') || raw.includes('\\')
    ? [raw]
    : (env.PATH || env.Path || '').split(delimiter).filter(Boolean).map(d => join(d, raw))

  if (!isWin) {
    for (const p of bases) if (exists(p)) return { path: p, needsShell: false }
    return null
  }

  // Try real executables before batch shims: a shim forces a shell, and a
  // shell forces quoting, which is an injection surface we would rather not
  // have. Array.sort is stable, so PATHEXT's own order survives within each
  // group.
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .sort((a, b) => Number(isBatch(a)) - Number(isBatch(b)))

  for (const base of bases) {
    const given = extname(base)
    if (given && exists(base)) return { path: base, needsShell: isBatch(given) }
    for (const ext of exts) {
      const p = base + ext
      if (exists(p)) return { path: p, needsShell: isBatch(ext) }
    }
  }
  return null
}

/**
 * A stand-in child that reports a launch failure the same way a real one
 * does. Callers already handle `error`; without this they would have to
 * handle a synchronous throw as well, and the EINVAL case proves they forget.
 */
function failedChild(err) {
  const child = new EventEmitter()
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} })
  child.stdout = stream()
  child.stderr = stream()
  child.stdin = { end() {}, write() {} }
  child.kill = () => false
  queueMicrotask(() => child.emit('error', err))
  return child
}

/**
 * spawn() that works on Windows.
 *
 * Two failures are folded into the `error` event: nothing on PATH, and the
 * synchronous EINVAL Node throws for a `.cmd` spawned without a shell.
 */
export function spawnPortable(name, args = [], opts = {}, deps = {}) {
  const { spawnImpl = nodeSpawn, ...resolveOpts } = deps
  const found = resolveCommand(name, resolveOpts)
  if (!found) return failedChild(new Error(`command not found on PATH: ${name}`))
  try {
    return spawnImpl(found.path, args, { ...opts, shell: found.needsShell })
  } catch (err) {
    return failedChild(err)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/spawn.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/spawn.mjs test/spawn.test.mjs
git commit -m "feat: portable command resolution and spawning"
```

---

### Task 2: Retrofit the existing spawn call sites

**Files:**
- Modify: `src/run-model.mjs:26-37` (`defaultSpawn`) and `:50`
- Modify: `scripts/room-seat.mjs:66-104` (`seatArgs`) and `:154`
- Test: `test/run-model.test.mjs` (add), `test/room-seat.test.mjs` (add)

**Interfaces:**
- Consumes: `spawnPortable` from Task 1.
- Produces: `seatArgs({ configDir, roomUrl, token, handle, repo, settingsPath, mcpConfigPath })` — `mcpConfigPath` defaults to `join(configDir, 'mcp.seat.json')`; the returned `args` now carry that **path**, not JSON.

**Background:** These are live bugs. On a machine where `claude` is an npm `.cmd` shim, both the observer and the seat launcher fail with ENOENT today. Separately, `seatArgs` puts MCP config as JSON on argv, which cannot survive a shell — so the fix is to stop putting it there.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/room-seat.test.mjs — append
test('the MCP config travels as a file path, never as JSON on the command line', () => {
  // argv-borne JSON cannot survive cmd.exe, and escaping it would be an
  // injection surface. A path has neither problem.
  const { args } = seatArgs({
    configDir: '/cfg/ana', roomUrl: 'u', token: 't', handle: 'ana-agent', repo: '/repo',
  })
  const i = args.indexOf('--mcp-config')
  assert.notEqual(i, -1)
  const value = args[i + 1]
  assert.doesNotMatch(value, /[{}]/, 'the config must be a path, not inline JSON')
  assert.match(value, /mcp\.seat\.json$/)
})

test('the mcp config path can be overridden, so the launcher controls where it writes', () => {
  const { args } = seatArgs({
    configDir: '/cfg/ana', roomUrl: 'u', token: 't', handle: 'h', repo: '/r',
    mcpConfigPath: '/tmp/custom.json',
  })
  assert.ok(args.includes('/tmp/custom.json'))
})
```

```javascript
// test/run-model.test.mjs — append (create the file if absent, with the
// same imports as the other tests in it)
import { mcpConfigFor } from '../scripts/room-seat.mjs'

test('the seat bridge is still what gets loaded, now via the config file body', () => {
  const cfg = mcpConfigFor()
  assert.ok(cfg.mcpServers.seat.command)
  assert.ok(cfg.mcpServers.seat.args.some(a => String(a).includes('seat')))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/room-seat.test.mjs test/run-model.test.mjs`
Expected: FAIL — the `--mcp-config` value is still inline JSON, and `mcpConfigFor` is not exported.

- [ ] **Step 3: Change `scripts/room-seat.mjs`**

Replace the `spawn, execFileSync` import and the `mcpConfig` construction:

```javascript
import { execFileSync } from 'node:child_process'
import { spawnPortable } from '../src/spawn.mjs'
```

```javascript
/**
 * The MCP config body a seat loads. Extracted so the launcher can write it to
 * a file: passing it as JSON on argv cannot survive a Windows shell, and a
 * shell is exactly what an npm-installed `claude` needs.
 */
export function mcpConfigFor() {
  return { mcpServers: { seat: { command: 'node', args: [SEAT_BRIDGE] } } }
}
```

In `seatArgs`, take `mcpConfigPath` and pass it instead of the JSON:

```javascript
export function seatArgs({ configDir, roomUrl, token, handle, repo, settingsPath, mcpConfigPath }) {
  const worktree = worktreeFor(repo, handle)
  const configPath = mcpConfigPath || join(configDir, 'mcp.seat.json')

  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  return {
    cmd: 'claude',
    args: [
      '--dangerously-load-development-channels',
      '--mcp-config', configPath,
      '--settings', settingsPath,
      '--add-dir', worktree,
    ],
    env: {
      ...env,
      CLAUDE_CONFIG_DIR: configDir,
      ROOM_URL: roomUrl,
      ROOM_SEAT_TOKEN: token,
      ROOM_SEAT_HANDLE: handle,
    },
    cwd: worktree,
  }
}
```

In `main()`, write the file before spawning and use `spawnPortable`:

```javascript
  const mcpConfigPath = join(configDir, 'mcp.seat.json')
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigFor(), null, 2))

  const { cmd, args, env } = seatArgs({
    configDir, roomUrl, token, handle, repo, settingsPath, mcpConfigPath,
  })

  const child = spawnPortable(cmd, args, { cwd: worktree, env, stdio: 'inherit' })
  child.on('exit', code => process.exit(code ?? 0))
  child.on('error', err => die(`failed to launch claude: ${err.message}`))
```

- [ ] **Step 4: Change `src/run-model.mjs`**

```javascript
import { spawnPortable } from './spawn.mjs'

function defaultSpawn(cmd, args, prompt) {
  return new Promise(resolve => {
    // spawnPortable rather than a bare spawn: on a machine where `claude` is
    // an npm .cmd shim, a bare spawn fails ENOENT and the observer silently
    // never produces a brief.
    const child = spawnPortable(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', err => resolve({ stdout: '', stderr: String(err.message), code: -1 }))
    child.on('close', code => resolve({ stdout, stderr, code }))
    child.stdin.end(prompt)
  })
}
```

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS. The pre-existing `room-seat` tests must still pass unchanged — `assert.equal(cmd, 'claude')` and `args.some(a => a.includes('seat'))` both still hold, the latter because the path ends in `mcp.seat.json`.

- [ ] **Step 6: Commit**

```bash
git add src/run-model.mjs scripts/room-seat.mjs test/room-seat.test.mjs test/run-model.test.mjs
git commit -m "fix: launch claude portably and keep MCP config off argv"
```

---

### Task 3: Reply-only mode for the seat bridge

**Files:**
- Modify: `src/seat.mjs:128-231` (`createSeat`) and `:243-266` (`main`)
- Test: `test/seat.test.mjs` (add)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createSeat({ roomUrl, token, handle, fetchImpl, mode })` where `mode` is `'full'` (default, unchanged) or `'reply-only'`.

**Background:** For an OpenCode seat the *driver* owns the room feed. If `seat.mjs` also joined, two connections would claim one handle and `Seats.join` would reject the second with `handle-taken` (`src/seats.mjs:24`). Reply-only mode serves the `room_reply` tool and nothing else, so both harnesses keep sharing one implementation of that tool.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/seat.test.mjs — append
test('a reply-only seat never joins or opens a feed, so it cannot collide with its driver', async () => {
  // The OpenCode driver owns the room feed. A second connection claiming the
  // same handle would be rejected as handle-taken, leaving the seat deaf.
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const seat = createSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode',
    fetchImpl, mode: 'reply-only',
  })
  await seat.connect()
  seat.stop()
  assert.equal(calls.length, 0, `reply-only must make no calls of its own, got ${calls.join()}`)
})

test('a reply-only seat still delivers room_reply, which is its entire job', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const seat = createSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode',
    fetchImpl, mode: 'reply-only',
  })
  const res = await seat.callTool('room_reply', { text: 'hello from opencode' })
  assert.equal(res.isError, undefined)
  assert.equal(calls[0].url, 'http://room/seat/reply')
  assert.equal(calls[0].body.text, 'hello from opencode')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/seat.test.mjs`
Expected: FAIL — `seat.callTool is not a function`, and reply-only still joins.

- [ ] **Step 3: Implement**

In `createSeat`, accept `mode` and extract the tool body so it is callable directly (which is also what makes it testable without an MCP client):

```javascript
export function createSeat({ roomUrl, token, handle, fetchImpl = fetch, mode = 'full' }) {
  const replyOnly = mode === 'reply-only'
```

Extract the existing `room_reply` handler body into a named function and have both the MCP handler and the new `callTool` use it:

```javascript
  async function roomReply(a) {
    try {
      const res = await fetchImpl(`${roomUrl}/seat/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, text: String(a.text ?? ''), to: a.to ? String(a.to) : undefined }),
      })
      if (!res.ok) return { content: [{ type: 'text', text: `room_reply failed: ${res.status}` }], isError: true }
      return { content: [{ type: 'text', text: 'sent' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true }
    }
  }
```

Change `connect()` to skip join and feed in reply-only mode, and expose `callTool`:

```javascript
    async connect() {
      await mcp.connect(new StdioServerTransport())
      // A reply-only seat is a tool surface and nothing more: its driver owns
      // the room feed, and a second join would be refused as handle-taken.
      if (replyOnly) return

      const res = await fetchImpl(`${roomUrl}/seat/join`, { /* unchanged */ })
      ...
      openFeed()
    },
    callTool(name, args) {
      if (name === 'room_reply') return roomReply(args ?? {})
      return Promise.resolve({ content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true })
    },
```

In `main()`, read the mode from the environment:

```javascript
  const mode = process.env.ROOM_SEAT_MODE === 'reply-only' ? 'reply-only' : 'full'
  const seat = createSeat({ roomUrl, token, handle, mode })
```

- [ ] **Step 4: Run the suite**

Run: `node --test test/seat.test.mjs`
Expected: PASS, including every pre-existing test — full mode must be byte-for-byte unchanged in behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/seat.mjs test/seat.test.mjs
git commit -m "feat: reply-only mode for the seat bridge"
```

---

### Task 4: Pure mappers for the OpenCode driver

**Files:**
- Create: `src/opencode.mjs`
- Test: `test/opencode.test.mjs`

**Interfaces:**
- Consumes: `buildNotification` from `src/channel.mjs`.
- Produces:
  - `parseModel(spec) -> { providerID, modelID }` (throws on a spec with no `/`)
  - `promptFromTurn(messages, roomName) -> string | null`
  - `class PendingContext { constructor(max = 20); add(kind, text, from); drain() -> { text, dropped } }`
  - `actionForOpencodeEvent(ev, sessionId) -> { type: 'end-turn'|'retry'|'error'|'busy'|'ignore', ... }`

- [ ] **Step 1: Write the failing tests**

```javascript
// test/opencode.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseModel, promptFromTurn, PendingContext, actionForOpencodeEvent,
} from '../src/opencode.mjs'

test('a model spec splits on the first slash, so model ids may contain slashes', () => {
  assert.deepEqual(parseModel('opencode/mimo-v2.5-free'),
    { providerID: 'opencode', modelID: 'mimo-v2.5-free' })
  assert.deepEqual(parseModel('openrouter/meta/llama-3'),
    { providerID: 'openrouter', modelID: 'meta/llama-3' })
})

test('a model spec without a provider is refused rather than guessed at', () => {
  assert.throws(() => parseModel('mimo'), /provider\/model/)
})

test('a turn is rendered exactly as the channel renders it, so both harnesses see one room', () => {
  // Reusing channel.mjs's renderer is deliberate: a second, hand-maintained
  // copy is how the brief notification drifted once already.
  const one = promptFromTurn([{ name: 'heet', memberId: 'm1', id: 'x', content: 'do the thing' }], 'room')
  assert.equal(one, 'do the thing')

  const many = promptFromTurn([
    { name: 'heet', memberId: 'm1', id: 'x', content: 'do the thing' },
    { name: 'ana', memberId: 'm2', id: 'y', content: 'and this too' },
  ], 'room')
  assert.equal(many, '[heet] do the thing\n[ana] and this too')
})

test('an empty batch produces no prompt at all', () => {
  assert.equal(promptFromTurn([], 'room'), null)
})

test('context accumulates until it is drained, then starts empty again', () => {
  const p = new PendingContext(20)
  p.add('mirror', 'ana-agent said something', 'ana-agent')
  p.add('brief', 'two open threads')
  const first = p.drain()
  assert.match(first.text, /ana-agent said something/)
  assert.match(first.text, /two open threads/)
  assert.equal(first.dropped, 0)
  assert.equal(p.drain().text, '')
})

test('context is bounded, so a seat nobody addresses cannot grow a prompt forever', () => {
  // Mirrors arrive for every turn in the room whether or not this seat is
  // ever addressed. Unbounded, the first prompt would eventually exceed the
  // context window.
  const p = new PendingContext(3)
  for (let i = 1; i <= 5; i++) p.add('mirror', `event ${i}`)
  const { text, dropped } = p.drain()
  assert.equal(dropped, 2)
  assert.doesNotMatch(text, /event 1/)
  assert.match(text, /event 5/)
  assert.match(text, /2 earlier/, 'the drop must be visible, not silent')
})

test('idle for our session ends the turn', () => {
  const a = actionForOpencodeEvent(
    { type: 'session.idle', properties: { sessionID: 'ses_a' } }, 'ses_a')
  assert.equal(a.type, 'end-turn')
})

test('idle for someone else\'s session is ignored, so two seats never end each other\'s turns', () => {
  // One opencode server can host many sessions. Acting on a sessionID we do
  // not own is the same bug class as a seat ending the local channel's turn.
  const a = actionForOpencodeEvent(
    { type: 'session.idle', properties: { sessionID: 'ses_b' } }, 'ses_a')
  assert.equal(a.type, 'ignore')
})

test('retry is reported as its own state, never as progress', () => {
  // A model retrying a 502 forever is stalled. If retry counted as progress
  // the deadline would never fire and the queue destination would wedge.
  const a = actionForOpencodeEvent(
    { type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'retry', attempt: 2 } } },
    'ses_a')
  assert.equal(a.type, 'retry')
  assert.equal(a.attempt, 2)
})

test('a session error is surfaced with its payload', () => {
  const a = actionForOpencodeEvent(
    { type: 'session.error', properties: { sessionID: 'ses_a', error: { name: 'UnknownError' } } },
    'ses_a')
  assert.equal(a.type, 'error')
  assert.equal(a.error.name, 'UnknownError')
})

test('unknown event types are ignored rather than crashing the driver', () => {
  assert.equal(actionForOpencodeEvent({ type: 'file.edited', properties: {} }, 'ses_a').type, 'ignore')
  assert.equal(actionForOpencodeEvent(null, 'ses_a').type, 'ignore')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/opencode.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// src/opencode.mjs
import { buildNotification } from './channel.mjs'

/**
 * `provider/model`, split on the FIRST slash — a model id may itself contain
 * slashes (`openrouter/meta/llama-3`), so splitting on all of them loses the
 * back half.
 */
export function parseModel(spec) {
  const s = String(spec)
  const i = s.indexOf('/')
  if (i <= 0 || i === s.length - 1) {
    throw new Error(`model must be provider/model, got: ${s}`)
  }
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

/**
 * The text of a room turn, rendered exactly as `channel.mjs` renders it for a
 * Claude seat. Reused rather than reimplemented so the two harnesses cannot
 * end up seeing differently-shaped versions of the same room.
 */
export function promptFromTurn(messages, roomName) {
  const nt = buildNotification(messages ?? [], roomName)
  return nt ? nt.params.content : null
}

const LABEL = { mirror: 'mirror', brief: 'brief', seed: 'seed' }

/**
 * Room events that are NOT a request — mirrors, briefs, the join seed.
 *
 * OpenCode has no inbox, so these cannot be delivered on their own: sending
 * one would start a turn nobody asked for. They wait here and ride along with
 * the next real turn.
 *
 * Bounded, because they arrive whether or not this seat is ever addressed.
 * Drops are counted and reported rather than hidden, mirroring how `pending`
 * already tells a Claude seat how stale its brief is.
 */
export class PendingContext {
  #max
  #items = []
  #dropped = 0

  constructor(max = 20) {
    this.#max = Math.max(1, Number(max) || 20)
  }

  add(kind, text, from) {
    if (!text || !String(text).trim()) return
    const label = LABEL[kind] ?? 'context'
    this.#items.push(from ? `[${label} from @${from}] ${text}` : `[${label}] ${text}`)
    while (this.#items.length > this.#max) {
      this.#items.shift()
      this.#dropped++
    }
  }

  drain() {
    if (!this.#items.length && !this.#dropped) return { text: '', dropped: 0 }
    const dropped = this.#dropped
    const lines = [...this.#items]
    if (dropped) lines.unshift(`(${dropped} earlier room events dropped)`)
    this.#items = []
    this.#dropped = 0
    return {
      dropped,
      text: [
        '--- room context: background only, never a request ---',
        ...lines,
        '--- end room context ---',
      ].join('\n'),
    }
  }
}

/**
 * One opencode bus event -> what the driver should do about it.
 *
 * Pure, so every branch is testable without a socket. Events for another
 * session are ignored outright: one opencode server hosts many sessions, and
 * acting on someone else's sessionID would end the wrong turn.
 */
export function actionForOpencodeEvent(ev, sessionId) {
  const type = ev?.type
  const p = ev?.properties ?? {}
  if (!type) return { type: 'ignore' }
  if (p.sessionID && sessionId && p.sessionID !== sessionId) return { type: 'ignore' }

  if (type === 'session.idle') return { type: 'end-turn' }
  if (type === 'session.error') return { type: 'error', error: p.error ?? null }
  if (type === 'session.status') {
    const st = p.status?.type
    // Retry is alive-but-not-progressing. Naming it separately is what stops
    // the deadline from being reset by a model that is failing in a loop.
    if (st === 'retry') return { type: 'retry', attempt: p.status?.attempt ?? 0 }
    return { type: 'busy' }
  }
  return { type: 'ignore' }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/opencode.test.mjs`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/opencode.mjs test/opencode.test.mjs
git commit -m "feat: pure mappers between room events and opencode"
```

---

### Task 5: The driver core — delivering turns and ending them

**Files:**
- Modify: `src/opencode.mjs` (add `createOpenCodeSeat`)
- Test: `test/opencode-driver.test.mjs`

**Interfaces:**
- Consumes: `parseModel`, `promptFromTurn`, `PendingContext`, `actionForOpencodeEvent` from Task 4.
- Produces:
  ```
  createOpenCodeSeat({
    roomUrl, token, handle, opencodeUrl,
    model = 'opencode/mimo-v2.5-free',
    roomName = 'room',
    maxPendingContext = 20,
    turnTimeoutMs = 300000,
    fetchImpl = fetch,
    setTimer = setTimeout, clearTimer = clearTimeout,
  }) -> {
    onRoomEvent(ev): Promise<void>,
    onOpencodeEvent(ev): Promise<void>,
    sessionId(): string|null,
    busy(): boolean,
  }
  ```
  `ev` for `onRoomEvent` is `{ event, data }`, the same shape `seatNotification` takes.

**Note:** `connect()`/`stop()` are added in Task 7. This task builds and tests the logic with events fed in directly, so no sockets are involved.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/opencode-driver.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeSeat } from '../src/opencode.mjs'

/** A fetch stand-in that records calls and answers the routes the driver uses. */
function recorder({ sessionId = 'ses_a' } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: u, method: init.method ?? 'GET', body })
    if (u.endsWith('/session')) {
      return { ok: true, status: 200, json: async () => ({ id: sessionId }) }
    }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  return { calls, fetchImpl, find: re => calls.filter(c => re.test(c.url)) }
}

const seatOf = (r, over = {}) => createOpenCodeSeat({
  roomUrl: 'http://room', token: 'tok', handle: 'opencode',
  opencodeUrl: 'http://oc', fetchImpl: r.fetchImpl, ...over,
})

const turn = content => ({
  event: 'turn',
  data: { room: 'room', messages: [{ name: 'heet', memberId: 'm1', id: 'x', content }] },
})

test('a room turn becomes one prompt on a session the driver creates once', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('add a mul function'))
  await seat.onRoomEvent(turn('and a div function'))

  assert.equal(r.find(/\/session$/).length, 1, 'the session is created once and reused')
  const prompts = r.find(/prompt_async/)
  assert.equal(prompts.length, 2)
  assert.equal(prompts[0].body.parts[0].text, 'add a mul function')
  assert.deepEqual(prompts[0].body.model, { providerID: 'opencode', modelID: 'mimo-v2.5-free' })
})

test('mirrors ride along with the next turn rather than starting one of their own', async () => {
  // OpenCode has no inbox. Sending a mirror on its own would start a turn
  // nobody asked for, and bill a model for reading gossip.
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent({ event: 'mirror', data: { text: 'ana-agent finished the parser', from: 'ana-agent' } })
  assert.equal(r.find(/prompt_async/).length, 0, 'a mirror alone must not prompt')

  await seat.onRoomEvent(turn('now do the tests'))
  const sent = r.find(/prompt_async/)[0].body.parts[0].text
  assert.match(sent, /ana-agent finished the parser/)
  assert.match(sent, /now do the tests/)
  assert.ok(sent.indexOf('ana-agent finished') < sent.indexOf('now do the tests'),
    'context comes first, the request last')
})

test('idle closes the room turn by posting Stop, which is what drains the queue', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('do it'))
  assert.equal(seat.busy(), true)

  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  const stops = r.find(/\/seat\/hook\/Stop/)
  assert.equal(stops.length, 1)
  assert.equal(seat.busy(), false)
})

test('every Stop for one turn quotes one id, so a redelivered idle cannot double-charge', async () => {
  // ledger.record is idempotent per promptId. A reconnect that replays
  // session.idle must not be billed twice.
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('do it'))
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })

  const stops = r.find(/\/seat\/hook\/Stop/)
  assert.equal(stops.length, 1, 'a second idle for a turn already ended is ignored')
  assert.ok(stops[0].body.prompt_id, 'the Stop must carry an id for ledger idempotency')
})

test('an idle with no turn in flight is ignored, so a stray event cannot end nothing', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  assert.equal(r.find(/Stop/).length, 0)
})

test('a session error ends the turn and says so in the room', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('do it'))
  await seat.onOpencodeEvent({
    type: 'session.error',
    properties: { sessionID: 'ses_a', error: { name: 'ProviderAuthError' } },
  })
  assert.equal(r.find(/Stop/).length, 1, 'the queue must drain even on failure')
  const said = r.find(/\/seat\/reply/)
  assert.equal(said.length, 1, 'a failure the room cannot see is a seat that just went quiet')
  assert.match(said[0].body.text, /ProviderAuthError/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/opencode-driver.test.mjs`
Expected: FAIL — `createOpenCodeSeat is not a function`

- [ ] **Step 3: Implement**

Append to `src/opencode.mjs`:

```javascript
import { randomUUID } from 'node:crypto'

export const DEFAULT_MODEL = 'opencode/mimo-v2.5-free'
export const DEFAULT_TURN_TIMEOUT_MS = 300_000

/**
 * One OpenCode session, driven as a room seat.
 *
 * The room pushes work to a Claude seat through a channel notification. That
 * path does not exist here: OpenCode discards notifications it does not know,
 * so delivery is an outbound HTTP call this driver makes. Everything else —
 * the reply path, the queue, cost — is the room's existing seat protocol,
 * unchanged.
 */
export function createOpenCodeSeat({
  roomUrl,
  token,
  handle,
  opencodeUrl,
  model = DEFAULT_MODEL,
  roomName = 'room',
  maxPendingContext = 20,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  const modelRef = parseModel(model)
  const pending = new PendingContext(maxPendingContext)
  let sessionId = null
  let turn = null // { promptId } while one is in flight

  const post = (url, body) => fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

  async function ensureSession() {
    if (sessionId) return sessionId
    const res = await fetchImpl(`${opencodeUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `room seat ${handle}` }),
    })
    if (!res.ok) throw new Error(`could not create an opencode session: ${res.status}`)
    const body = await res.json()
    sessionId = body?.id ?? null
    if (!sessionId) throw new Error('opencode created a session with no id')
    return sessionId
  }

  /** The room's only way to hear from this seat. */
  function say(text) {
    return post(`${roomUrl}/seat/reply`, { token, text })
  }

  /**
   * Closes the room turn. Without this the destination stays busy and every
   * later message for this seat queues behind a turn that already finished —
   * the same failure the missing Stop hook caused for Claude seats.
   */
  async function endTurn(promptId) {
    await post(`${roomUrl}/seat/hook/Stop?token=${encodeURIComponent(token)}`,
      { token, prompt_id: promptId })
  }

  async function finish(promptId) {
    clearTimer(turn?.timer)
    turn = null
    await endTurn(promptId)
  }

  async function onRoomEvent(ev) {
    const kind = ev?.event
    const data = ev?.data ?? {}

    // Not requests: they wait for the next real turn.
    if (kind === 'mirror') return void pending.add('mirror', data.text, data.from)
    if (kind === 'brief') return void pending.add('brief', data.text)
    if (kind === 'seed') return void pending.add('seed', data.text)
    if (kind !== 'turn') return

    const body = promptFromTurn(data.messages ?? [], data.room ?? roomName)
    if (!body) return

    const id = await ensureSession()
    const { text: context } = pending.drain()
    const promptId = `oc-${randomUUID()}`

    turn = { promptId, timer: null }
    turn.timer = setTimer(() => { void onDeadline(promptId) }, turnTimeoutMs)

    await post(`${opencodeUrl}/session/${id}/prompt_async`, {
      model: modelRef,
      parts: [{ type: 'text', text: context ? `${context}\n\n${body}` : body }],
    })
  }

  async function onDeadline(promptId) {
    // Guard against a deadline that fires for a turn already finished.
    if (!turn || turn.promptId !== promptId) return
    log(`turn ${promptId} exceeded ${turnTimeoutMs}ms — aborting`)
    try {
      if (sessionId) await post(`${opencodeUrl}/session/${sessionId}/abort`, {})
    } catch {
      // The abort is best-effort. Draining the room queue is not.
    }
    await say(`no response after ${Math.round(turnTimeoutMs / 1000)}s — the turn was abandoned.`)
    await finish(promptId)
  }

  async function onOpencodeEvent(ev) {
    const action = actionForOpencodeEvent(ev, sessionId)
    if (action.type === 'ignore' || action.type === 'busy') return
    // Retry means the provider is failing in a loop. It is deliberately NOT
    // progress: resetting the deadline here is exactly how a wedged seat
    // would block its queue destination forever.
    if (action.type === 'retry') {
      log(`provider retry (attempt ${action.attempt})`)
      return
    }
    if (!turn) return
    const { promptId } = turn

    if (action.type === 'error') {
      const name = action.error?.name ?? 'unknown error'
      await say(`the turn failed: ${name}`)
      await finish(promptId)
      return
    }
    if (action.type === 'end-turn') await finish(promptId)
  }

  return {
    onRoomEvent,
    onOpencodeEvent,
    sessionId: () => sessionId,
    busy: () => turn !== null,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/opencode-driver.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/opencode.mjs test/opencode-driver.test.mjs
git commit -m "feat: opencode seat driver core"
```

---

### Task 6: Stall handling

**Files:**
- Test: `test/opencode-stall.test.mjs`
- Modify: `src/opencode.mjs` only if a test exposes a gap

**Interfaces:**
- Consumes: `createOpenCodeSeat` from Task 5, including its injectable `setTimer` / `clearTimer`.
- Produces: no new API.

**Background:** In the probe, two of six real turns wedged: one model stalled mid-tool-loop and sat in `busy` forever with no error, another parked in `status: retry` after an upstream 502. A wedged seat blocks its queue destination permanently. Task 5 wrote the deadline; this task is where it is actually *proven*, because it is the requirement most likely to be quietly skipped once the happy path works.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/opencode-stall.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeSeat } from '../src/opencode.mjs'

/** A controllable clock: nothing fires until the test says so. */
function clock() {
  let next = 1
  const timers = new Map()
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimer: id => timers.delete(id),
    pending: () => timers.size,
    fireAll() {
      const due = [...timers.values()]
      timers.clear()
      for (const t of due) t.fn()
    },
  }
}

function recorder() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null })
    if (u.endsWith('/session')) return { ok: true, status: 200, json: async () => ({ id: 'ses_a' }) }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  return { calls, fetchImpl, find: re => calls.filter(c => re.test(c.url)) }
}

const turn = { event: 'turn', data: { room: 'room', messages: [{ name: 'heet', memberId: 'm', id: 'i', content: 'go' }] } }

test('a session that never idles is aborted and its room turn is closed anyway', async () => {
  // The exact probe failure: the model stalled mid tool-loop, stayed "busy"
  // forever, and emitted nothing. Without this the destination never drains.
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl, setTimer: c.setTimer, clearTimer: c.clearTimer, turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  assert.equal(seat.busy(), true)

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))

  assert.equal(r.find(/\/abort$/).length, 1, 'the stalled session must be aborted')
  assert.equal(r.find(/\/seat\/hook\/Stop/).length, 1, 'the room queue must drain')
  assert.equal(r.find(/\/seat\/reply/).length, 1, 'the room must be told, not left guessing')
  assert.equal(seat.busy(), false)
})

test('a provider retrying in a loop does NOT get its deadline reset', async () => {
  // A model retrying a 502 forever is stalled, not working. Treating retry as
  // progress would mean the deadline never fires.
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl, setTimer: c.setTimer, clearTimer: c.clearTimer, turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  const armed = c.pending()

  for (let i = 1; i <= 3; i++) {
    await seat.onOpencodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'retry', attempt: i } },
    })
  }
  assert.equal(c.pending(), armed, 'retry must not arm a fresh deadline')

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))
  assert.equal(r.find(/Stop/).length, 1, 'the retrying turn still times out')
})

test('a turn that finishes normally disarms its deadline', async () => {
  // Otherwise a later deadline would fire against a turn that already ended
  // and abort a session that had moved on to the next one.
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl, setTimer: c.setTimer, clearTimer: c.clearTimer, turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  assert.equal(c.pending(), 0, 'a finished turn must leave no timer behind')

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))
  assert.equal(r.find(/\/abort$/).length, 0, 'nothing should be aborted after a clean finish')
})

test('a deadline that fires for an already-finished turn does nothing', async () => {
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl,
    // A timer that ignores clearing, to simulate the race where a deadline is
    // already on the callback queue when the turn ends.
    setTimer: fn => { c.setTimer(fn, 0); return 'stuck' },
    clearTimer: () => {},
    turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))
  assert.equal(r.find(/Stop/).length, 1, 'the turn must be ended exactly once')
})
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/opencode-stall.test.mjs`
Expected: PASS if Task 5 was implemented correctly. **If any test fails, fix `src/opencode.mjs` — do not weaken the test.** The likely gap is `finish()` not clearing the timer, or `onDeadline` not comparing `turn.promptId`.

- [ ] **Step 3: Commit**

```bash
git add test/opencode-stall.test.mjs src/opencode.mjs
git commit -m "test: prove a stalled opencode seat cannot wedge the room queue"
```

---

### Task 7: Wiring and the launcher

**Files:**
- Modify: `src/opencode.mjs` (add `connect()` / `stop()` to `createOpenCodeSeat`)
- Create: `scripts/room-opencode-seat.mjs`
- Create: `test/helpers/fake-opencode.mjs`
- Test: `test/opencode-connect.test.mjs`

**Interfaces:**
- Consumes: `createOpenCodeSeat` (Tasks 5-6), `spawnPortable` (Task 1), `worktreeFor` and `mcpConfigFor` (Task 2), reply-only mode (Task 3).
- Produces:
  - `createOpenCodeSeat(...)` also returns `connect(): Promise<void>` and `stop(): void`
  - `opencodeSeatArgs({ port, cwd }) -> { cmd, args, env, cwd }`
  - `startFakeOpencode() -> { url, close(), emit(type, properties), prompts, aborts, mcp }`

- [ ] **Step 1: Write the fake OpenCode server**

```javascript
// test/helpers/fake-opencode.mjs
// A stand-in for `opencode serve`, implementing only the routes the driver
// uses. Tests must never need the real binary: it is a network dependency, a
// model dependency, and — as the probe showed — unreliable on the free tier.
import { createServer } from 'node:http'

export async function startFakeOpencode() {
  const prompts = []
  const aborts = []
  const mcp = []
  const feeds = new Set()

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const json = () => { try { return JSON.parse(body || '{}') } catch { return {} } }

      if (req.method === 'GET' && path === '/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        feeds.add(res)
        req.on('close', () => feeds.delete(res))
        return
      }
      if (req.method === 'POST' && path === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'ses_fake' }))
      }
      if (req.method === 'POST' && path.endsWith('/prompt_async')) {
        prompts.push(json())
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'POST' && path.endsWith('/abort')) {
        aborts.push(path)
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'POST' && path === '/mcp') {
        mcp.push(json())
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ room: { status: 'connected' } }))
      }
      res.writeHead(404)
      res.end()
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    prompts, aborts, mcp,
    emit(type, properties = {}) {
      const frame = `data: ${JSON.stringify({ id: 'evt_1', type, properties })}\n\n`
      for (const f of feeds) f.write(frame)
    },
    async close() {
      for (const f of feeds) f.end()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
```

- [ ] **Step 2: Write the failing connect test**

```javascript
// test/opencode-connect.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeSeat, opencodeSeatArgs } from '../src/opencode.mjs'
import { startFakeOpencode } from './helpers/fake-opencode.mjs'

const settle = () => new Promise(r => setTimeout(r, 50))

test('the driver registers the reply-only bridge with opencode when it connects', async () => {
  // The bridge is what lets opencode call room_reply. Registering it in
  // reply-only mode is what stops it claiming the handle the driver holds.
  const oc = await startFakeOpencode()
  const roomCalls = []
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: oc.url,
    fetchImpl: async (url, init) => {
      if (String(url).startsWith(oc.url)) return fetch(url, init)
      roomCalls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ seed: null }) }
    },
  })
  await seat.connect()
  await settle()

  assert.equal(oc.mcp.length, 1)
  const cfg = oc.mcp[0]
  assert.equal(cfg.name, 'room')
  assert.equal(cfg.config.environment.ROOM_SEAT_MODE, 'reply-only')
  assert.equal(cfg.config.environment.ROOM_SEAT_TOKEN, 'tok')
  assert.ok(roomCalls.some(u => u.includes('/seat/join')), 'the driver joins the room itself')

  seat.stop()
  await oc.close()
})

test('an idle arriving over the real event stream ends the room turn', async () => {
  // End to end over an actual socket: the pure mapper tests prove the
  // decision, this proves the wiring that delivers it.
  const oc = await startFakeOpencode()
  const stops = []
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: oc.url,
    fetchImpl: async (url, init) => {
      const u = String(url)
      if (u.startsWith(oc.url)) return fetch(url, init)
      if (u.includes('/seat/hook/Stop')) stops.push(u)
      return { ok: true, status: 200, json: async () => ({ seed: null }) }
    },
  })
  await seat.connect()
  await settle()

  await seat.onRoomEvent({
    event: 'turn',
    data: { room: 'room', messages: [{ name: 'heet', memberId: 'm', id: 'i', content: 'go' }] },
  })
  assert.equal(oc.prompts.length, 1)

  oc.emit('session.idle', { sessionID: 'ses_fake' })
  await settle()
  assert.equal(stops.length, 1)

  seat.stop()
  await oc.close()
})

test('the launcher binds opencode to loopback, because it runs without a password', () => {
  // `opencode serve` has no auth unless OPENCODE_SERVER_PASSWORD is set. On a
  // tailnet-bound room, a tailnet-bound opencode would be an open shell.
  const { args } = opencodeSeatArgs({ port: 4096, cwd: '/repo/.worktrees/opencode' })
  assert.ok(args.includes('serve'))
  const i = args.indexOf('--hostname')
  assert.equal(args[i + 1], '127.0.0.1')
  assert.ok(args.includes('4096'))
})
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/opencode-connect.test.mjs`
Expected: FAIL — `seat.connect is not a function`, `opencodeSeatArgs` not exported.

- [ ] **Step 4: Add `connect`/`stop` and `opencodeSeatArgs` to `src/opencode.mjs`**

Reuse `readFrames` from `src/seat.mjs` — export it there (`export async function readFrames`) rather than writing a second SSE parser.

```javascript
import { readFrames } from './seat.mjs'

// inside createOpenCodeSeat, before the return:

  let stopped = false
  let roomCtrl = null
  let ocCtrl = null
  let backoffMs = 500
  let retryTimer = null

  /** Registers the reply-only bridge so opencode can call room_reply. */
  async function registerBridge(bridgePath) {
    await post(`${opencodeUrl}/mcp`, {
      name: 'room',
      config: {
        type: 'local',
        command: ['node', bridgePath],
        environment: {
          ROOM_URL: roomUrl,
          ROOM_SEAT_TOKEN: token,
          ROOM_SEAT_HANDLE: handle,
          // Reply-only: the driver owns the room feed. A second join would be
          // refused as handle-taken and this seat would go deaf.
          ROOM_SEAT_MODE: 'reply-only',
        },
        enabled: true,
      },
    })
  }

  function feed(url, onEvent, label) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal })
        if (!res.ok || !res.body) throw new Error(`${label} feed failed: ${res.status}`)
        backoffMs = 500
        await readFrames(res.body, (event, raw) => {
          let data
          try { data = JSON.parse(raw) } catch { return }
          void onEvent(event, data)
        })
      } catch {
        // A dropped feed is normal: sleep/wake, a restart, a wifi blip.
      }
      if (!stopped) {
        retryTimer = setTimer(() => feed(url, onEvent, label), backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    })()
    return ctrl
  }
```

```javascript
    async connect({ bridgePath } = {}) {
      if (bridgePath) await registerBridge(bridgePath)

      const res = await fetchImpl(`${roomUrl}/seat/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, handle }),
      })
      if (res.ok) {
        const body = await res.json()
        if (body?.seed?.text) pending.add('seed', body.seed.text)
      }

      roomCtrl = feed(
        `${roomUrl}/seat/events?token=${encodeURIComponent(token)}`,
        (event, data) => onRoomEvent({ event, data }),
        'room',
      )
      // opencode's bus frames carry the event type inside `data`, not on an
      // `event:` line, so the frame's event name is ignored here.
      ocCtrl = feed(`${opencodeUrl}/event`, (_event, data) => onOpencodeEvent(data), 'opencode')
    },
    stop() {
      stopped = true
      if (retryTimer) clearTimer(retryTimer)
      clearTimer(turn?.timer)
      roomCtrl?.abort()
      ocCtrl?.abort()
    },
```

Add the launcher recipe:

```javascript
/**
 * The spawn recipe for this seat's own `opencode serve`.
 *
 * Bound to loopback deliberately: the server runs with no password unless
 * OPENCODE_SERVER_PASSWORD is set, so exposing it on the tailnet the room
 * itself listens on would hand out an unauthenticated shell.
 */
export function opencodeSeatArgs({ port, cwd }) {
  return {
    cmd: 'opencode',
    args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    env: { ...process.env },
    cwd,
  }
}
```

- [ ] **Step 5: Write `scripts/room-opencode-seat.mjs`**

```javascript
#!/usr/bin/env node
/**
 * OpenCode seat launcher — the peer of scripts/room-seat.mjs.
 *
 * Starts `opencode serve` bound to loopback in this seat's own worktree,
 * registers src/seat.mjs with it in reply-only mode so OpenCode can reach
 * room_reply, and runs the driver that translates between the two.
 *
 *   room-opencode-seat <handle> --token <token> [--repo <path>]
 *                      [--room <url>] [--model provider/model]
 *                      [--attach <url>] [--timeout <ms>]
 *
 * Unlike a Claude seat there is no credential to isolate — OpenCode's free
 * models need none — so the isolation that matters here is the worktree:
 * two agents writing one checkout silently clobber each other.
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnPortable } from '../src/spawn.mjs'
import { createOpenCodeSeat, opencodeSeatArgs, DEFAULT_MODEL, DEFAULT_TURN_TIMEOUT_MS } from '../src/opencode.mjs'
import { worktreeFor } from './room-seat.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEAT_BRIDGE = join(__dirname, '..', 'src', 'seat.mjs')

const log = s => process.stderr.write(`opencode-seat: ${s}\n`)
const die = msg => { log(msg); process.exit(1) }

/** Ask the OS for a free port, then release it. Two seats must never collide. */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

function ensureWorktree(repo, handle) {
  const dir = worktreeFor(repo, handle)
  if (!existsSync(dir)) execFileSync('git', ['worktree', 'add', dir], { cwd: repo, stdio: 'inherit' })
  return dir
}

/** Wait for `opencode serve` to answer, rather than racing it. */
async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/config`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

async function main() {
  const argv = process.argv.slice(2)
  const handle = argv[0]
  if (!handle || handle.startsWith('-')) {
    die('usage: room-opencode-seat <handle> --token <token> [--repo <path>] [--room <url>] [--model provider/model] [--attach <url>] [--timeout <ms>]')
  }
  const flag = name => {
    const i = argv.indexOf(name)
    return i === -1 ? null : argv[i + 1]
  }

  const token = flag('--token') || process.env.ROOM_SEAT_TOKEN
  if (!token) die('no seat token. Pass --token <token> (from `room-admin seat add`).')

  const repo = resolve(flag('--repo') || process.cwd())
  const roomUrl = flag('--room') || process.env.ROOM_URL || 'http://127.0.0.1:8787'
  const model = flag('--model') || process.env.ROOM_OPENCODE_MODEL || DEFAULT_MODEL
  const turnTimeoutMs = Number(flag('--timeout') || process.env.ROOM_OPENCODE_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS)
  const attach = flag('--attach')

  const worktree = ensureWorktree(repo, handle)

  let child = null
  let opencodeUrl = attach
  if (!attach) {
    const port = await freePort()
    opencodeUrl = `http://127.0.0.1:${port}`
    const { cmd, args, env, cwd } = opencodeSeatArgs({ port, cwd: worktree })
    log(`starting opencode serve on ${opencodeUrl} in ${cwd}`)
    child = spawnPortable(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', err => die(`failed to launch opencode: ${err.message}`))
    if (!(await waitForServer(opencodeUrl))) die(`opencode did not answer on ${opencodeUrl}`)
  }

  const seat = createOpenCodeSeat({
    roomUrl, token, handle, opencodeUrl, model, turnTimeoutMs, log,
  })
  await seat.connect({ bridgePath: SEAT_BRIDGE })
  log(`"${handle}" connected to ${roomUrl} using ${model}`)

  const shutdown = () => {
    seat.stop()
    child?.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
```

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS, everything green.

- [ ] **Step 7: Commit**

```bash
git add src/opencode.mjs src/seat.mjs scripts/room-opencode-seat.mjs test/helpers/fake-opencode.mjs test/opencode-connect.test.mjs
git commit -m "feat: opencode seat launcher and event wiring"
```

---

### Task 8: The `delegatable` flag

**Files:**
- Modify: `src/identity.mjs:73-80` (`createAgentMember`), and export `isDelegatable`
- Modify: `src/admin.mjs` — accept `--delegatable` on `seat add`
- Test: `test/identity.test.mjs` (add)

**Interfaces:**
- Consumes: nothing.
- Produces: `isDelegatable(agent) -> boolean`; `createAgentMember({ name, handle, ownerId, delegatable })`.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/identity.test.mjs — append
import { createAgentMember, isDelegatable } from '../src/identity.mjs'

test('a seat is not delegatable unless its owner said so', () => {
  // Fail closed. Delegation lets the orchestrator put work on someone else's
  // seat; that must be opt-in, never a default or an accident.
  const a = createAgentMember({ name: 'oc', handle: 'opencode', ownerId: 'm1' })
  assert.equal(isDelegatable(a), false)
})

test('an owner can opt a seat into delegation', () => {
  const a = createAgentMember({ name: 'oc', handle: 'opencode', ownerId: 'm1', delegatable: true })
  assert.equal(isDelegatable(a), true)
})

test('a delegatable value that is not a boolean true is refused', () => {
  // A value from an older state file, or a string "false", must not open the
  // gate. Anything unrecognised means no.
  for (const bad of ['true', 1, {}, null, undefined]) {
    const a = { ...createAgentMember({ name: 'oc', handle: 'opencode', ownerId: 'm1' }), delegatable: bad }
    assert.equal(isDelegatable(a), false, `delegatable=${JSON.stringify(bad)} must not pass`)
  }
})

test('a non-agent is never delegatable, whatever its fields say', () => {
  assert.equal(isDelegatable({ kind: 'human', delegatable: true }), false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/identity.test.mjs`
Expected: FAIL — `isDelegatable is not a function`

- [ ] **Step 3: Implement**

```javascript
export function createAgentMember({ name, handle, ownerId, delegatable = false }) {
  return {
    ...createMember({ name, role: 'member' }),
    kind: 'agent',
    handle: normalizeHandle(handle),
    ownerId,
    // Opt-in, per seat. `owner-only` addressing still governs humans; this
    // governs only the orchestrator, and only because the owner said yes.
    delegatable: delegatable === true,
  }
}

/**
 * Whether the orchestrator may put work on this seat.
 *
 * Strict `=== true` so a string, a number, or a field carried forward from an
 * older state file cannot open the gate. Authorisation fails closed.
 */
export const isDelegatable = a => isAgent(a) && a.delegatable === true
```

In `src/admin.mjs`, thread a `delegatable` boolean through the `seat add` path into `createAgentMember`, and surface it in the seat listing output.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/identity.test.mjs test/admin.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/identity.mjs src/admin.mjs test/identity.test.mjs
git commit -m "feat: per-seat delegatable flag, failing closed"
```

---

### Task 9: Delegation validation and rendering

**Files:**
- Create: `src/delegation.mjs`
- Test: `test/delegation.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TASK_CLASSES = ['reasoning', 'execution', 'verification']`
  - `validateDelegation(input) -> { ok: boolean, errors: string[] }`
  - `renderDelegation(input) -> string`

**Background:** Delegated work fails because the brief was thin far more often than because the model was weak. So the tool validates the brief rather than trusting it, and rejects visibly while the orchestrator still holds the context to fix it.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/delegation.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDelegation, renderDelegation, TASK_CLASSES } from '../src/delegation.mjs'

const exec = {
  to: '@opencode', class: 'execution', task: 'add mul() to math.js',
  spec: { files: ['math.js'], tests: ['npm test'] },
}

test('a well-formed execution delegation is accepted', () => {
  assert.deepEqual(validateDelegation(exec), { ok: true, errors: [] })
})

test('an execution delegation without files or tests is refused, and says which', () => {
  // The whole failure mode this guards: a one-line brief handed to a weak
  // model, which then invents an interface nobody asked for.
  const r = validateDelegation({ to: '@opencode', class: 'execution', task: 'do the thing' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /files/.test(e)))
  assert.ok(r.errors.some(e => /tests/.test(e)))
})

test('reasoning and verification need only a task, because there is no code to scope', () => {
  for (const cls of ['reasoning', 'verification']) {
    const r = validateDelegation({ to: '@claude', class: cls, task: 'why does the feed drop?' })
    assert.equal(r.ok, true, `${cls} should not require files`)
  }
})

test('an unknown class is refused rather than treated as execution', () => {
  const r = validateDelegation({ to: '@opencode', class: 'vibes', task: 'x' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes(TASK_CLASSES.join(', '))))
})

test('a missing target or empty task is refused', () => {
  assert.equal(validateDelegation({ class: 'reasoning', task: 'x' }).ok, false)
  assert.equal(validateDelegation({ to: '@oc', class: 'reasoning', task: '   ' }).ok, false)
})

test('the rendered brief carries every part of the spec the worker needs', () => {
  const text = renderDelegation({
    ...exec,
    spec: { ...exec.spec, interface: 'export function mul(a,b)', do_not_touch: ['add.js'] },
  })
  assert.match(text, /add mul\(\) to math\.js/)
  assert.match(text, /math\.js/)
  assert.match(text, /npm test/)
  assert.match(text, /export function mul/)
  assert.match(text, /add\.js/)
})

test('the brief omits sections that were not supplied, rather than printing empty headings', () => {
  const text = renderDelegation({ to: '@oc', class: 'reasoning', task: 'explain the fork' })
  assert.doesNotMatch(text, /Do not touch/)
  assert.doesNotMatch(text, /Interface/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/delegation.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// src/delegation.mjs

/**
 * What kind of work this is. The class never routes — `to` does that, chosen
 * by the orchestrator, which holds more context than any classifier would.
 * The class labels the ledger entry and decides which spec fields are
 * mandatory, and nothing else.
 */
export const TASK_CLASSES = ['reasoning', 'execution', 'verification']

const nonEmptyList = v => Array.isArray(v) && v.filter(x => String(x ?? '').trim()).length > 0

/**
 * Delegated work fails because the brief was thin far more often than because
 * the model was weak. So a brief is validated, not trusted — and a rejection
 * is returned to the orchestrator while it still has the context to fix it.
 */
export function validateDelegation(input = {}) {
  const errors = []
  const { to, task, spec = {} } = input
  const cls = input.class

  if (!to || !String(to).trim()) errors.push('to is required: the @handle to delegate to')
  if (!TASK_CLASSES.includes(cls)) errors.push(`class must be one of ${TASK_CLASSES.join(', ')}`)
  if (!task || !String(task).trim()) errors.push('task is required: one line saying what to do')

  if (cls === 'execution') {
    if (!nonEmptyList(spec.files)) errors.push('spec.files is required for execution: which files may be touched')
    if (!nonEmptyList(spec.tests)) errors.push('spec.tests is required for execution: how the work is verified')
  }

  return { ok: errors.length === 0, errors }
}

const section = (heading, lines) =>
  lines?.length ? `\n${heading}:\n${lines.map(l => `- ${l}`).join('\n')}` : ''

/** The text the worker seat actually receives. */
export function renderDelegation({ task, class: cls, spec = {} }) {
  const parts = [`Delegated task (${cls}): ${String(task).trim()}`]
  parts.push(section('Files you may change', spec.files))
  if (spec.interface && String(spec.interface).trim()) {
    parts.push(`\nInterface to conform to:\n${spec.interface}`)
  }
  parts.push(section('Verify with', spec.tests))
  parts.push(section('Do not touch', spec.do_not_touch))
  parts.push('\nWhen you are done, report what you changed with room_reply.')
  return parts.filter(Boolean).join('\n')
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/delegation.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/delegation.mjs test/delegation.test.mjs
git commit -m "feat: delegation brief validation and rendering"
```

---

### Task 10: The `delegate` tool

**Files:**
- Modify: `src/channel.mjs:107-152` (tool list) and `:154-176` (call handler)
- Modify: `src/queue.mjs:124-133` (the address-policy gate)
- Modify: `src/server.mjs:118-137` (`createChannel` wiring)
- Test: `test/delegation-routing.test.mjs`

**Interfaces:**
- Consumes: `validateDelegation`, `renderDelegation` (Task 9); `isDelegatable` (Task 8).
- Produces: `createChannel({ config, onReply, onDecision, onDelegate })`, where `onDelegate(input) -> { ok: boolean, id?: string, errors?: string[] }`; `queue.submit(member, text, { delegation: true })`.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/delegation-routing.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Queue } from '../src/queue.mjs'
import { Seats } from '../src/seats.mjs'
import { Registry, createMember, createAgentMember } from '../src/identity.mjs'
import { loadConfig } from '../src/config.mjs'

function setup({ delegatable }) {
  const registry = new Registry()
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const agent = registry.add(createAgentMember({
    name: 'opencode', handle: 'opencode', ownerId: ana.id, delegatable,
  }))
  const seats = new Seats()
  seats.join(agent, { id: 'c1' })
  const orchestrator = { id: 'orchestrator', name: 'claude', role: 'member', muted: false }
  const queue = new Queue({
    config: loadConfig({ ROOM_HANDLES: 'claude' }), registry, seats,
    ledger: null, decisions: null,
  })
  return { queue, orchestrator, ana, agent }
}

test('the orchestrator may put work on a seat whose owner opted in', () => {
  const { queue, orchestrator } = setup({ delegatable: true })
  const r = queue.submit(orchestrator, '@opencode add mul() to math.js', { delegation: true })
  assert.equal(r.ok, true, `expected queued, got ${r.reason}`)
})

test('the orchestrator is refused a seat that never opted in', () => {
  // Room ownership must not by itself reach someone else's seat, and neither
  // may the orchestrator. Delegation is consent, not authority.
  const { queue, orchestrator } = setup({ delegatable: false })
  const r = queue.submit(orchestrator, '@opencode add mul() to math.js', { delegation: true })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-delegatable')
})

test('delegatable does NOT loosen who may address the seat by hand', () => {
  // The two paths are separate on purpose: opting into delegation must not
  // quietly turn an owner-only seat into a shared one.
  const { queue, agent } = setup({ delegatable: true })
  const stranger = { id: 'other', name: 'sam', role: 'member', muted: false }
  const r = queue.submit(stranger, '@opencode do a thing')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-your-seat')
})

test('an owner addressing their own delegatable seat still works', () => {
  const { queue, ana } = setup({ delegatable: true })
  assert.equal(queue.submit(ana, '@opencode do a thing').ok, true)
})
```

```javascript
// test/delegation-routing.test.mjs — the tool surface
import { createChannel } from '../src/channel.mjs'

test('a delegate call with a thin brief is rejected with the reason, not silently dropped', async () => {
  let seen = null
  const channel = createChannel({
    config: loadConfig({}),
    onReply() {}, onDecision() {},
    onDelegate(input) { seen = input; return { ok: false, errors: ['spec.files is required for execution'] } },
  })
  const res = await channel.callTool('delegate', {
    to: '@opencode', class: 'execution', task: 'do the thing',
  })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /spec\.files/)
  assert.equal(seen.to, '@opencode')
})

test('the delegate tool is advertised alongside room_reply', async () => {
  const channel = createChannel({
    config: loadConfig({}), onReply() {}, onDecision() {}, onDelegate: () => ({ ok: true, id: 'd1' }),
  })
  const names = (await channel.listTools()).map(t => t.name)
  assert.ok(names.includes('delegate'))
  assert.ok(names.includes('room_reply'))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/delegation-routing.test.mjs`
Expected: FAIL — `channel.callTool` / `channel.listTools` do not exist, `delegation` option ignored.

- [ ] **Step 3: Change the queue gate**

In `src/queue.mjs`, replace the agent branch:

```javascript
    const agent = this.registry?.byHandle(c.handle)
    if (agent) {
      if (opts.delegation) {
        // Delegation is a different authorisation question from addressing.
        // The orchestrator does not own this seat and never will, so the
        // owner-only test would always refuse it; what the owner grants
        // instead is an explicit, per-seat opt-in.
        if (!isDelegatable(agent)) {
          return { ok: false, reason: 'not-delegatable', message: null, conflicts: [] }
        }
      } else if (addressPolicyOf(agent) === 'owner-only' && !ownsSeat(member, agent)) {
        return { ok: false, reason: 'not-your-seat', message: null, conflicts: [] }
      }
      if (!this.seats?.isOnline(c.handle)) return { ok: false, reason: 'seat-offline', message: null, conflicts: [] }
    }
```

Import `isDelegatable` alongside the existing identity imports.

- [ ] **Step 4: Add the tool to `src/channel.mjs`**

Add `onDelegate` to the factory signature. Extract the tool list into a constant and the call handling into a named function so both the MCP handlers and the new test surface use one implementation:

```javascript
  const DELEGATE_TOOL = {
    name: 'delegate',
    description:
      'Hand a scoped task to another seat in the room. Use it for work that does not need this session: boilerplate, tests, mechanical refactors, documentation, lint and build fixes. The spec is what determines whether the result is usable - name the files, the interface, and how it will be verified. A thin brief is rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The @handle to delegate to' },
        class: { type: 'string', enum: TASK_CLASSES, description: 'reasoning, execution, or verification' },
        task: { type: 'string', description: 'One line stating what to do' },
        spec: {
          type: 'object',
          description: 'The brief. files and tests are REQUIRED when class is execution.',
          properties: {
            files: { type: 'array', items: { type: 'string' }, description: 'Files the worker may change' },
            interface: { type: 'string', description: 'The signature or contract to conform to' },
            tests: { type: 'array', items: { type: 'string' }, description: 'Commands that verify the work' },
            do_not_touch: { type: 'array', items: { type: 'string' }, description: 'Files that must not change' },
          },
        },
      },
      required: ['to', 'class', 'task'],
    },
  }

  async function callTool(name, a = {}) {
    if (name === 'room_reply') { /* existing body */ }
    if (name === 'room_decision') { /* existing body */ }
    if (name === 'delegate') {
      const result = onDelegate?.(a) ?? { ok: false, errors: ['delegation is not enabled in this room'] }
      if (!result.ok) {
        // Visible, and specific. An orchestrator told only "rejected" cannot
        // repair the brief; one told which field is missing can.
        return {
          content: [{ type: 'text', text: `delegate rejected:\n- ${(result.errors ?? []).join('\n- ')}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: `delegated ${result.id} to ${a.to}` }] }
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
```

Return `listTools` and `callTool` from `createChannel` alongside the existing members, and have the MCP request handlers delegate to them.

Also extend the channel `INSTRUCTIONS` with a paragraph explaining when to delegate — matching the voice of the existing text.

- [ ] **Step 5: Wire it in `src/server.mjs`**

```javascript
import { validateDelegation, renderDelegation } from './delegation.mjs'

// Reserved identity for work the orchestrator hands out, so a delegation is
// attributable in the ledger and the feed rather than appearing to come from
// a human who never typed it.
const ORCHESTRATOR = { id: 'orchestrator', name: 'claude', role: 'member', muted: false }
```

```javascript
  onDelegate(input) {
    const check = validateDelegation(input)
    if (!check.ok) return { ok: false, errors: check.errors }

    const handle = String(input.to).replace(/^@/, '').toLowerCase()
    const text = `@${handle} ${renderDelegation(input)}`
    const r = queue.submit(ORCHESTRATOR, text, { delegation: true })
    if (!r.ok) return { ok: false, errors: [`could not delegate to @${handle}: ${r.reason}`] }

    store.appendMessage(r.message)
    bus.publish('message', r.message)
    return { ok: true, id: r.message.id }
  },
```

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS. Pay attention to `test/address-policy.test.mjs` — it must be unchanged and still green, because delegation must not have loosened human addressing.

- [ ] **Step 7: Commit**

```bash
git add src/channel.mjs src/queue.mjs src/server.mjs test/delegation-routing.test.mjs
git commit -m "feat: delegate tool routing work to a consenting seat"
```

---

### Task 11: Documentation and the manual smoke test

**Files:**
- Modify: `README.md`
- Create: `docs/opencode-seat.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update `README.md`**

Extend the architecture diagram to show an OpenCode seat beside the Claude seats. Add a section covering:

- What an OpenCode seat is, and that it needs no Anthropic credential — which is why the "Is sharing a session allowed?" question does not arise for it at all.
- Launching one: `node scripts/room-opencode-seat.mjs opencode --token <token> --repo <path>`
- `room-admin seat add opencode --owner <member> --delegatable`
- That `owner-only` still governs who may address it by hand, and `--delegatable` governs only the orchestrator.
- The `delegate` tool, with one worked example.

Update the **Status** section honestly. It currently says 365 tests; state the new count from `node --test`, and add to the known-gaps paragraph:

> Not yet run for real: an OpenCode seat driven end to end by the real
> `opencode` binary inside a live room. The driver's logic is covered by the
> suite against a fake server, and the protocol was verified against the real
> binary during design, but the two have not been run together.

- [ ] **Step 2: Write `docs/opencode-seat.md`**

A short operator guide: prerequisites (`npm i -g opencode-ai`), the free-tier model list and the warning that free models stall (with `--timeout` as the mitigation), `--attach` for reusing a running server, the loopback-binding rationale, and a troubleshooting table covering ENOENT on Windows, `Connection closed` from `POST /mcp` when a POSIX-style path is passed on Windows, and a seat that goes quiet (check for `retry` status).

- [ ] **Step 3: Run the manual smoke test and record the result**

This is the one step that needs the real binary. Record the actual outcome in `docs/opencode-seat.md` — including a failure, if that is what happens.

```bash
npm i -g opencode-ai
node src/server.mjs &                        # or your usual room launch
node scripts/room-admin.mjs seat add opencode --owner <member> --delegatable
node scripts/room-opencode-seat.mjs opencode --token <token> --repo .
# then, from a browser in the room:  @opencode add a mul(a,b) to math.js
```

Confirm: the seat appears online, the turn completes, `git diff` in
`.worktrees/opencode` shows the edit, and the room shows the reply.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/opencode-seat.md
git commit -m "docs: opencode seats and delegation"
```

---

## Plan self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| `src/spawn.mjs` portable launching | 1 |
| Argv hygiene, retrofit both call sites | 2 |
| `seat.mjs` reply-only mode | 3 |
| Translation table, turn rendering, bounded pending context | 4, 5 |
| Session creation, prompt delivery, model selection | 5, 7 |
| Turn identity for cost (`prompt_id` minted per turn) | 5 |
| Stall handling: deadline, retry-is-not-progress, abort | 5, 6 |
| Feed reconnection with backoff | 7 |
| Port selection, loopback binding | 7 |
| `delegatable`, failing closed | 8 |
| `delegate` tool, class-dependent spec validation | 9, 10 |
| Authorisation split (addressing vs delegation) | 10 |
| Fake opencode server, no binary in `node --test` | 7 |
| README honesty about the untested path | 11 |

Out-of-scope items (judge lane, fork/revert) have no tasks, as intended.

**Type consistency** — `createOpenCodeSeat` returns `onRoomEvent`, `onOpencodeEvent`, `sessionId()`, `busy()` in Task 5 and gains `connect()`/`stop()` in Task 7; every test uses those names. `promptId` is the internal field, `prompt_id` the wire field posted to `/seat/hook/Stop` — the split is deliberate and consistent. `isDelegatable` is used identically in Tasks 8 and 10. `readFrames` is exported from `src/seat.mjs` in Task 7 and imported there only.
