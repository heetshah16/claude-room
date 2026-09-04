# Orchestrator Extension Implementation Plan (part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension with a real chat window backed by one long-lived Claude Code session, which supervises a standalone room and can delegate work to it.

**Architecture:** The extension spawns and supervises three kinds of process (room, orchestrator, workers). The orchestrator is one persistent `claude --print --input-format stream-json --output-format stream-json` process; its event stream is parsed and rendered in a webview. It reaches the room only through a thin MCP bridge exposing `delegate`.

**Tech Stack:** Node 22+, plain **CommonJS** JavaScript for the extension (no TypeScript, no bundler — matching this repo's no-build-step ethos), `node --test`, VS Code extension API. The room stays ESM and dependency-free.

**Spec:** `docs/superpowers/specs/2026-09-05-orchestrator-extension-design.md`

**Scope:** This plan covers spec build-order stages 1–3: extension skeleton and supervisor, orchestrator session and chat, and the delegate bridge. Stages 4–5 (workers panel, installer/packaging) are a second plan, written after this one lands.

## Global Constraints

- **The room's suite must stay green.** Baseline: `node --test` → **464 tests, 463 passing, 1 skipped, 0 failures**. Never edit an existing test to make a change pass.
- **`src/` stays dependency-free and ESM.** Nothing in `src/` may import from `extension/`. The extension has its own `package.json` with **no runtime dependencies**.
- `extension/` is **CommonJS** — its `package.json` must NOT set `"type": "module"`, which is what stops the root `"type": "module"` from applying to it.
- **Pure logic must be injectable**: `spawn`, `fetch`, `env`, `platform` are parameters with real defaults, never read from globals inside a function under test. No test may spawn a real binary or open a non-loopback socket.
- **Kill process trees, not processes.** On Windows a `.cmd` shim runs under `cmd.exe`; killing the child orphans the real server. This was observed twice during the OpenCode work.
- **Every model- or room-supplied string is rendered with `textContent`**, never `innerHTML` — the rule `src/ui.mjs` already states, for the same reason.
- Test style: `const { test } = require('node:test')`, `const assert = require('node:assert/strict')`. Test names state the *why*.
- Commit after every task with a `feat:` / `fix:` / `docs:` prefix.

---

### Task 1: Extension scaffold and the stream-json parser

**Files:**
- Create: `extension/package.json`, `extension/README.md`, `extension/.vscodeignore`
- Create: `extension/src/stream.js`
- Test: `extension/test/stream.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createStreamParser({ onEvent })` → `{ push(chunk), end() }`, emitting normalised UI events.

**Background:** These event shapes were captured from the real binary, not invented. A turn emits, in order: `system/init` (carries `session_id`, `tools`, `cwd`), any number of `assistant` messages whose `message.content` is an array of blocks (`thinking`, `tool_use`, `text`), `user` messages carrying `tool_result` blocks, optional `rate_limit_event`, and finally `result` (carries `result` text, `session_id`, `num_turns`, `total_cost_usd`).

Normalising here — rather than in the webview — is what keeps the webview dumb and this logic testable without VS Code.

- [ ] **Step 1: Write `extension/package.json`**

```json
{
  "name": "claude-room-orchestrator",
  "displayName": "Claude Room Orchestrator",
  "description": "Chat with an orchestrating Claude that delegates mechanical work to free-model workers.",
  "version": "0.0.1",
  "private": true,
  "engines": { "vscode": "^1.90.0", "node": ">=22" },
  "categories": ["AI", "Other"],
  "activationEvents": [],
  "main": "./src/extension.js",
  "contributes": {
    "commands": [
      { "command": "claudeRoom.openChat", "title": "Claude Room: Open Orchestrator Chat" },
      { "command": "claudeRoom.restart", "title": "Claude Room: Restart Services" }
    ]
  },
  "scripts": { "test": "node --test test/" }
}
```

Note there is deliberately no `"type"` field: that is what keeps this tree CommonJS under the repo's ESM root.

- [ ] **Step 2: Write the failing test**

```javascript
// extension/test/stream.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createStreamParser } = require('../src/stream.js')

/** Feed whole lines; return every normalised event. */
function run(lines) {
  const seen = []
  const p = createStreamParser({ onEvent: e => seen.push(e) })
  for (const l of lines) p.push(JSON.stringify(l) + '\n')
  return seen
}

test('the session id is surfaced on init, because a restart has to resume it', () => {
  const out = run([{ type: 'system', subtype: 'init', session_id: 'abc', tools: ['Bash'], cwd: '/x' }])
  assert.deepEqual(out, [{ kind: 'session', sessionId: 'abc', tools: ['Bash'], cwd: '/x' }])
})

test('assistant text arrives as text, and thinking as its own kind', () => {
  // The UI renders them differently: prose is the answer, thinking is a
  // disclosure the reader opens only when they want it.
  const out = run([{
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'The answer is 42.' }] },
  }])
  assert.deepEqual(out.map(e => e.kind), ['thinking', 'text'])
  assert.equal(out[1].text, 'The answer is 42.')
})

test('a tool call and its result are correlated by tool_use_id', () => {
  // The webview renders one card per call and fills in its result later;
  // without the correlation the result has no card to land in.
  const out = run([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node -e "1"' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '42', is_error: false }] } },
  ])
  assert.deepEqual(out[0], { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'node -e "1"' } })
  assert.deepEqual(out[1], { kind: 'tool-result', id: 't1', content: '42', isError: false })
})

test('a failing tool result is marked, so the UI can show it as a failure', () => {
  const out = run([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'boom', is_error: true }] } },
  ])
  assert.equal(out[0].isError, true)
})

test('thinking-token deltas become a single running total, not a hundred events', () => {
  // The real binary emits one of these per few tokens. Forwarding each to the
  // webview would be a message storm; the UI only ever shows the latest.
  const out = run([
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 22 },
  ])
  assert.deepEqual(out, [{ kind: 'thinking-tokens', tokens: 5 }, { kind: 'thinking-tokens', tokens: 22 }])
})

test('a rate limit event is surfaced, because a GUI must not just go quiet', () => {
  const out = run([{
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', resetsAt: 1788562200, rateLimitType: 'five_hour' },
  }])
  assert.deepEqual(out, [{ kind: 'rate-limit', status: 'allowed', resetsAt: 1788562200, limitType: 'five_hour' }])
})

test('result ends the turn and carries what the turn cost', () => {
  const out = run([{
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    session_id: 'abc', num_turns: 2, total_cost_usd: 0.01,
  }])
  assert.deepEqual(out, [{ kind: 'turn-end', text: 'done', sessionId: 'abc', turns: 2, costUsd: 0.01, isError: false }])
})

test('a JSON line split across chunks is still parsed', () => {
  // stdout arrives in arbitrary chunks; a parser that assumed whole lines
  // would drop the event that happened to straddle a boundary.
  const seen = []
  const p = createStreamParser({ onEvent: e => seen.push(e) })
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'z', tools: [], cwd: '/' }) + '\n'
  p.push(line.slice(0, 12))
  p.push(line.slice(12))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, 'z')
})

test('a malformed line is skipped rather than killing the stream', () => {
  const seen = []
  const p = createStreamParser({ onEvent: e => seen.push(e) })
  p.push('{not json}\n')
  p.push(JSON.stringify({ type: 'result', result: 'ok', session_id: 's' }) + '\n')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'turn-end')
})

test('an unknown event type is ignored, so a new binary version cannot break the chat', () => {
  assert.deepEqual(run([{ type: 'something_new', payload: 1 }]), [])
})
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test extension/test/stream.test.js`
Expected: FAIL — `Cannot find module '../src/stream.js'`

- [ ] **Step 4: Implement**

```javascript
// extension/src/stream.js
'use strict'

/**
 * Turns Claude Code's `--output-format stream-json` into the small set of
 * events a chat UI actually renders.
 *
 * Normalising here rather than in the webview keeps the webview dumb and this
 * logic testable without VS Code. Every shape below was captured from the real
 * binary; anything unrecognised is dropped, so a newer Claude Code that adds
 * an event type cannot break the chat.
 */
function createStreamParser({ onEvent }) {
  let buf = ''

  function emitBlocks(blocks) {
    for (const b of blocks ?? []) {
      if (b.type === 'text' && b.text) onEvent({ kind: 'text', text: b.text })
      else if (b.type === 'thinking' && b.thinking) onEvent({ kind: 'thinking', text: b.thinking })
      else if (b.type === 'tool_use') onEvent({ kind: 'tool', id: b.id, name: b.name, input: b.input ?? {} })
      else if (b.type === 'tool_result') {
        onEvent({ kind: 'tool-result', id: b.tool_use_id, content: b.content, isError: !!b.is_error })
      }
    }
  }

  function handle(ev) {
    switch (ev?.type) {
      case 'system':
        if (ev.subtype === 'init') {
          onEvent({ kind: 'session', sessionId: ev.session_id, tools: ev.tools ?? [], cwd: ev.cwd })
        } else if (ev.subtype === 'thinking_tokens') {
          onEvent({ kind: 'thinking-tokens', tokens: ev.estimated_tokens ?? 0 })
        }
        return
      // Both assistant and user messages carry a content-block array; the
      // difference is only which block types appear in them.
      case 'assistant':
      case 'user':
        emitBlocks(ev.message?.content)
        return
      case 'rate_limit_event': {
        const i = ev.rate_limit_info ?? {}
        onEvent({ kind: 'rate-limit', status: i.status, resetsAt: i.resetsAt, limitType: i.rateLimitType })
        return
      }
      case 'result':
        onEvent({
          kind: 'turn-end',
          text: typeof ev.result === 'string' ? ev.result : '',
          sessionId: ev.session_id,
          turns: ev.num_turns ?? 0,
          costUsd: ev.total_cost_usd ?? 0,
          isError: !!ev.is_error,
        })
        return
      default:
        return
    }
  }

  return {
    push(chunk) {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue } // a malformed line must not kill the stream
        handle(ev)
      }
    },
    end() { buf = '' },
  }
}

module.exports = { createStreamParser }
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test extension/test/stream.test.js`
Expected: PASS, 10 tests

- [ ] **Step 6: Run the whole suite — the room must be unaffected**

Run: `node --test`
Expected: the room's 464 still pass, plus the new extension tests.

- [ ] **Step 7: Commit**

```bash
git add extension/
git commit -m "feat(extension): scaffold and the stream-json parser"
```

---

### Task 2: Supervisor

**Files:**
- Create: `extension/src/supervisor.js`
- Test: `extension/test/supervisor.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `createSupervisor({ spawn, killTree, log, setTimer, clearTimer })` → `{ start(name, recipe), stop(name), stopAll(), status(name), on(event, cb) }` where `recipe` is `{ cmd, args, opts }`.

**Background:** The extension supervises the room, the orchestrator and each worker. Two failures matter most: a child dying silently while the UI still accepts input, and a killed child orphaning its real process on Windows (observed twice — `child.kill()` kills `cmd.exe` and leaves `opencode serve` holding a worktree and a port).

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test extension/test/supervisor.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// extension/src/supervisor.js
'use strict'
const { EventEmitter } = require('node:events')
const { spawn: nodeSpawn, execFile } = require('node:child_process')

/**
 * Kill a process and everything it started.
 *
 * `child.kill()` is not enough on Windows: a `.cmd` shim runs under cmd.exe,
 * so killing the child kills the shell and leaves the real server running,
 * holding its port and its worktree. That was observed twice while building
 * the OpenCode seat, both times needing a manual hunt.
 */
function defaultKillTree(pid, platform = process.platform) {
  if (!pid) return
  if (platform === 'win32') {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => {})
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
}

function createSupervisor({
  spawn = nodeSpawn,
  killTree = defaultKillTree,
  log = () => {},
} = {}) {
  const bus = new EventEmitter()
  const procs = new Map() // name -> { child, state, error, pid, stopping, order }
  let order = 0

  function start(name, { cmd, args = [], opts = {} }) {
    if (procs.has(name)) stop(name)
    const child = spawn(cmd, args, opts)
    const rec = { child, state: 'running', error: null, pid: child.pid, stopping: false, order: order++ }
    procs.set(name, rec)

    child.on('error', err => {
      rec.error = String(err?.message ?? err)
      rec.state = 'exited'
      log(`${name}: ${rec.error}`)
      if (!rec.stopping) bus.emit('exit', { name, code: null })
    })
    child.on('exit', code => {
      rec.state = rec.stopping ? 'stopped' : 'exited'
      // A stop we asked for is not a crash, and reporting it as one would put
      // an error in front of the user every time they close the window.
      if (!rec.stopping) bus.emit('exit', { name, code })
    })
    return rec
  }

  function stop(name) {
    const rec = procs.get(name)
    if (!rec) return
    rec.stopping = true
    rec.state = 'stopped'
    killTree(rec.pid)
    procs.delete(name)
  }

  return {
    start,
    stop,
    /** Reverse start order: workers depend on the room, so the room goes last. */
    stopAll() {
      const names = [...procs.entries()].sort((a, b) => b[1].order - a[1].order).map(([n]) => n)
      for (const n of names) stop(n)
    },
    status(name) {
      const rec = procs.get(name)
      if (!rec) return { state: 'stopped', pid: null, error: null }
      return { state: rec.state, pid: rec.pid, error: rec.error }
    },
    on: (ev, cb) => bus.on(ev, cb),
  }
}

module.exports = { createSupervisor, defaultKillTree }
```

Note `stop()` deletes the record, so `status()` after a stop reports `stopped` with no pid — which is what the tests assert and what the UI wants.

- [ ] **Step 4: Run to verify pass**

Run: `node --test extension/test/supervisor.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add extension/src/supervisor.js extension/test/supervisor.test.js
git commit -m "feat(extension): process supervisor with tree kill"
```

---

### Task 3: Room client

**Files:**
- Create: `extension/src/room-client.js`
- Test: `extension/test/room-client.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `roomRecipe({ repoRoot, stateDir, port, nodePath })` → `{ cmd, args, opts }` for the supervisor
  - `readOwnerToken(stateDir, { readFile })` → token string or null
  - `createRoomClient({ roomUrl, token, fetchImpl })` → `{ state(), delegate(input), events(onEvent) }`

**Background:** The extension owns `ROOM_STATE_DIR`, so it reads the owner token out of the room's own state rather than scraping stderr the way an operator does today. It opens exactly one SSE subscription and fans it out, so a worker's reply cannot reach the orchestrator before the panel has shown the work.

- [ ] **Step 1: Write the failing test**

```javascript
// extension/test/room-client.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { roomRecipe, readOwnerToken, createRoomClient } = require('../src/room-client.js')

test('the room is launched standalone, because the extension owns its lifecycle', () => {
  // Not as an MCP child of Claude Code: the extension has to choose the port,
  // watch the health and restart it independently of any orchestrator.
  const r = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 4321, nodePath: 'node' })
  assert.equal(r.cmd, 'node')
  assert.ok(r.args[0].endsWith('server.mjs'))
  assert.equal(r.opts.env.ROOM_STANDALONE, '1')
  assert.equal(r.opts.env.ROOM_PORT, '4321')
  assert.equal(r.opts.env.ROOM_HOST, '127.0.0.1')
  assert.equal(r.opts.env.ROOM_STATE_DIR, '/state')
})

test('the owner token is read from room state, not scraped from stderr', () => {
  const readFile = () => JSON.stringify({
    members: [
      { id: '1', name: 'bot', role: 'member', token: 'nope' },
      { id: '2', name: 'heet', role: 'owner', token: 'owner-token' },
    ],
  })
  assert.equal(readOwnerToken('/state', { readFile }), 'owner-token')
})

test('a missing or unreadable state file yields null rather than throwing', () => {
  assert.equal(readOwnerToken('/state', { readFile: () => { throw new Error('ENOENT') } }), null)
  assert.equal(readOwnerToken('/state', { readFile: () => 'not json' }), null)
})

test('delegate posts the brief and returns the room verdict verbatim', () => {
  // The room already validates the brief and names the missing field; the
  // client must not paraphrase that, or the orchestrator cannot repair it.
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ ok: false, errors: ['spec.files is required'] }) }
  }
  const c = createRoomClient({ roomUrl: 'http://room', token: 'tok', fetchImpl })
  return c.delegate({ to: '@opencode', class: 'execution', task: 'x' }).then(r => {
    assert.match(calls[0].url, /\/api\/delegate/)
    assert.equal(calls[0].body.to, '@opencode')
    assert.deepEqual(r, { ok: false, errors: ['spec.files is required'] })
  })
})

test('a non-ok HTTP response becomes a readable failure, not a thrown status', () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const c = createRoomClient({ roomUrl: 'http://room', token: 't', fetchImpl })
  return c.delegate({ to: '@x', class: 'reasoning', task: 'y' }).then(r => {
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /503/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test extension/test/room-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// extension/src/room-client.js
'use strict'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * The room, launched standalone under the extension's control.
 *
 * Deliberately NOT spawned as Claude Code's MCP child, which is how the CLI
 * runs it: that inverts control, leaving the extension unable to choose the
 * port, watch the health, or restart the room independently.
 */
function roomRecipe({ repoRoot, stateDir, port, nodePath = process.execPath, env = process.env }) {
  return {
    cmd: nodePath,
    args: [join(repoRoot, 'src', 'server.mjs')],
    opts: {
      cwd: repoRoot,
      env: {
        ...env,
        ROOM_STANDALONE: '1',
        ROOM_PORT: String(port),
        ROOM_HOST: '127.0.0.1',
        ROOM_STATE_DIR: stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  }
}

/** The owner's token, from the room's own persisted roster. */
function readOwnerToken(stateDir, { readFile = p => readFileSync(p, 'utf8') } = {}) {
  try {
    const raw = readFile(join(stateDir, 'members.json'))
    const parsed = JSON.parse(raw)
    const members = Array.isArray(parsed) ? parsed : (parsed.members ?? [])
    return members.find(m => m.role === 'owner')?.token ?? null
  } catch {
    return null // absent on first boot; the caller retries
  }
}

function createRoomClient({ roomUrl, token, fetchImpl = fetch }) {
  const q = `token=${encodeURIComponent(token)}`

  async function post(path, body) {
    try {
      const res = await fetchImpl(`${roomUrl}${path}?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!res.ok) return { ok: false, errors: [`${path} failed: HTTP ${res.status}`] }
      return await res.json()
    } catch (err) {
      return { ok: false, errors: [String(err?.message ?? err)] }
    }
  }

  return {
    async state() {
      try {
        const res = await fetchImpl(`${roomUrl}/api/state?${q}`)
        return res.ok ? await res.json() : null
      } catch { return null }
    },
    // The room's verdict travels verbatim: it names the missing spec field,
    // and paraphrasing it would leave the orchestrator unable to repair the brief.
    delegate: input => post('/api/delegate', input),
    roomUrl,
    token,
  }
}

module.exports = { roomRecipe, readOwnerToken, createRoomClient }
```

- [ ] **Step 4: Verify the state-file assumption against the real room**

The `members.json` shape above is an assumption. Confirm it before relying on it:

```bash
node -e "const {Store}=require('node:fs');" 2>/dev/null; \
ROOM_STANDALONE=1 ROOM_PORT=0 ROOM_STATE_DIR=/tmp/roomcheck node src/server.mjs & sleep 3; \
cat /tmp/roomcheck/members.json | head -5; kill %1
```

If the file name or shape differs, **fix `readOwnerToken` and its test to match the real thing** — do not adjust the room.

- [ ] **Step 5: Run to verify pass**

Run: `node --test extension/test/room-client.test.js`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add extension/src/room-client.js extension/test/room-client.test.js
git commit -m "feat(extension): room launch recipe and HTTP client"
```

---

### Task 4: `POST /api/delegate` and the orchestrator bridge

**Files:**
- Modify: `src/web.mjs` (add the route)
- Create: `src/orchestrator-bridge.mjs`
- Test: `test/delegate-route.test.mjs`

**Interfaces:**
- Consumes: the existing `delegator.delegate(input)` from `src/delegation.mjs`, already wired in `src/server.mjs`.
- Produces: `POST /api/delegate` (owner-authenticated), and a stdio MCP server exposing the `delegate` tool.

**Background:** The orchestrator reaches the room through exactly one tool. The bridge is the mirror of `src/seat.mjs`: a thin MCP→HTTP shim holding no state and no feed. Everything it forwards to — validation, the authorisation gate, the result path — already exists and is unchanged.

- [ ] **Step 1: Write the failing test**

```javascript
// test/delegate-route.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done } from './helpers/room.mjs'

test('an owner can delegate over HTTP, which is how the orchestrator reaches the room', async () => {
  const calls = []
  const h = harness({}, null, { onDelegate: input => { calls.push(input); return { ok: true, id: 'del-1' } } })
  const base = await listen(h.server)
  const res = await post(base, `/api/delegate?token=${h.ownerToken}`, {
    to: '@opencode', class: 'execution', task: 'add mul()',
    spec: { files: ['math.js'], tests: ['npm test'] },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, id: 'del-1' })
  assert.equal(calls[0].to, '@opencode')
  done(h)
})

test('the room verdict travels verbatim, so a thin brief names its missing field', async () => {
  const h = harness({}, null, {
    onDelegate: () => ({ ok: false, errors: ['spec.files is required for execution'] }),
  })
  const base = await listen(h.server)
  const res = await post(base, `/api/delegate?token=${h.ownerToken}`, { to: '@x', class: 'execution', task: 'y' })
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.errors[0], /spec\.files/)
  done(h)
})

test('a non-owner cannot delegate, because delegation spends someone else\'s seat', async () => {
  const h = harness({}, null, { onDelegate: () => ({ ok: true, id: 'x' }) })
  const base = await listen(h.server)
  const res = await post(base, `/api/delegate?token=${h.anaToken}`, { to: '@x', class: 'reasoning', task: 'y' })
  assert.equal(res.status, 403)
  done(h)
})

test('an unauthenticated delegate is refused', async () => {
  const h = harness({}, null, { onDelegate: () => ({ ok: true, id: 'x' }) })
  const base = await listen(h.server)
  const res = await post(base, '/api/delegate?token=nope', { to: '@x', class: 'reasoning', task: 'y' })
  assert.equal(res.status, 401)
  done(h)
})
```

The harness may need an `ownerToken`/`anaToken` accessor and an `onDelegate` hook. Add them the same way `onSeatReply` was added — additive, default-compatible, no existing caller changed.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/delegate-route.test.mjs`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the route to `src/web.mjs`**

Place it beside the other `/api/` routes, following their existing auth pattern:

```javascript
      if (req.method === 'POST' && path === '/api/delegate') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        // Delegation puts work on somebody else's seat and spends the room's
        // time; it is an owner action, like every other /api/admin route.
        if (member.role !== 'owner') return json(res, 403, { error: 'owner-only' })
        let body = {}
        try {
          const read = await readBody(req)
          if (read.tooLarge) return json(res, 413, { error: 'body too large' })
          body = JSON.parse(read.buf.toString('utf8') || '{}')
        } catch {
          return json(res, 400, { error: 'bad json' })
        }
        // The verdict travels verbatim - it names the missing spec field, and
        // an orchestrator told only "rejected" cannot repair the brief.
        return json(res, 200, onDelegate?.(body) ?? { ok: false, errors: ['delegation is not enabled'] })
      }
```

Add `onDelegate` to `createWeb`'s destructured deps, and wire it in `src/server.mjs` to `delegator.delegate`.

- [ ] **Step 4: Write `src/orchestrator-bridge.mjs`**

```javascript
#!/usr/bin/env node
/**
 * The orchestrator's bridge to the room.
 *
 * The mirror of src/seat.mjs, and deliberately thinner: a seat needs a feed
 * because the room drives it, whereas the orchestrator is driven by a human in
 * the extension's chat. It needs exactly one thing from the room - the ability
 * to hand work to a seat - so this holds no state and opens no stream.
 *
 * stdout belongs to the MCP protocol; every log line goes to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASK_CLASSES } from './delegation.mjs'

const INSTRUCTIONS = `You orchestrate. Design, decide, and verify yourself; hand mechanical work to a worker seat with the delegate tool.

Delegate boilerplate, tests, mechanical refactors, documentation, and lint or build fixes. Keep architecture, ambiguous requirements, hard debugging, and final integration decisions.

The spec is what makes delegated work usable. Name the files, the interface to conform to, and the command that verifies it. A thin brief is rejected, and the rejection names the field it needs.`

export function createBridge({ roomUrl, token, fetchImpl = fetch }) {
  const mcp = new Server(
    { name: 'orchestrator', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'delegate',
      description:
        'Hand a scoped task to a worker seat. Use it for work that does not need this session: boilerplate, tests, mechanical refactors, documentation, lint and build fixes. Name the files, the interface and how it will be verified - a thin brief is rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The @handle to delegate to' },
          class: { type: 'string', enum: TASK_CLASSES },
          task: { type: 'string', description: 'One line stating what to do' },
          spec: {
            type: 'object',
            description: 'files and tests are REQUIRED when class is execution.',
            properties: {
              files: { type: 'array', items: { type: 'string' } },
              interface: { type: 'string' },
              tests: { type: 'array', items: { type: 'string' } },
              do_not_touch: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['to', 'class', 'task'],
      },
    }],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name !== 'delegate') {
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
    try {
      const res = await fetchImpl(`${roomUrl}/api/delegate?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.params.arguments ?? {}),
      })
      if (!res.ok) {
        return { content: [{ type: 'text', text: `delegate failed: HTTP ${res.status}` }], isError: true }
      }
      const body = await res.json()
      if (!body.ok) {
        return {
          content: [{ type: 'text', text: `delegate rejected:\n- ${(body.errors ?? []).join('\n- ')}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: `delegated ${body.id} to ${req.params.arguments?.to}` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true }
    }
  })

  return { mcp, connect: () => mcp.connect(new StdioServerTransport()) }
}

const log = s => process.stderr.write(`orchestrator-bridge: ${s}\n`)

async function main() {
  const roomUrl = process.env.ROOM_URL
  const token = process.env.ROOM_TOKEN
  if (!roomUrl) { log('missing ROOM_URL'); process.exit(1) }
  if (!token) { log('missing ROOM_TOKEN'); process.exit(1) }
  await createBridge({ roomUrl, token }).connect()
  log(`connected to ${roomUrl}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
```

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS. The room's existing 464 must be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/web.mjs src/server.mjs src/orchestrator-bridge.mjs test/delegate-route.test.mjs
git commit -m "feat: HTTP delegate route and the orchestrator MCP bridge"
```

---

### Task 5: Orchestrator session

**Files:**
- Create: `extension/src/orchestrator.js`
- Test: `extension/test/orchestrator.test.js`

**Interfaces:**
- Consumes: `createStreamParser` (Task 1).
- Produces: `orchestratorRecipe({ repoRoot, roomUrl, token, sessionId, workspace, mcpConfigPath })` → `{ cmd, args, opts }`, and `createOrchestrator({ child, onEvent })` → `{ send(text), relay(result), sessionId() }`.

**Background:** One long-lived process serves every turn — verified against the real binary: two prompts, one `session_id`, and the second turn recalled a fact from the first. A turn is one JSON line on stdin. `--bare` is unusable because it never reads OAuth, and reusing the existing login is the point.

- [ ] **Step 1: Write the failing test**

```javascript
// extension/test/orchestrator.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { orchestratorRecipe, createOrchestrator } = require('../src/orchestrator.js')

function fakeChild() {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.written = []
  c.stdin = { write: s => c.written.push(s), end() {} }
  return c
}

test('the session is persistent and bidirectional, not one process per turn', () => {
  // Verified against the real binary: one process, one session id, and the
  // second turn recalled a fact from the first. A cold start per message is
  // what makes a chat feel like a terminal.
  const r = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://room', token: 'tok',
    sessionId: 'sess-1', workspace: '/ws', mcpConfigPath: '/cfg/mcp.json',
  })
  assert.equal(r.cmd, 'claude')
  assert.ok(r.args.includes('--print'))
  assert.equal(r.args[r.args.indexOf('--input-format') + 1], 'stream-json')
  assert.equal(r.args[r.args.indexOf('--output-format') + 1], 'stream-json')
  assert.equal(r.args[r.args.indexOf('--session-id') + 1], 'sess-1')
  assert.equal(r.args[r.args.indexOf('--mcp-config') + 1], '/cfg/mcp.json')
})

test('--bare is never used, because it would forfeit the user\'s login', () => {
  // --bare skips hooks and CLAUDE.md, but it also never reads OAuth or the
  // keychain and demands an API key. Reusing the existing subscription login
  // is the entire reason this is pleasant to install.
  const r = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'u', token: 't', sessionId: 's', workspace: '/ws', mcpConfigPath: '/c',
  })
  assert.ok(!r.args.includes('--bare'))
  assert.equal(r.opts.env.ANTHROPIC_API_KEY, undefined)
})

test('the bridge is told where the room is, through the environment', () => {
  const r = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://room:1', token: 'tok', sessionId: 's',
    workspace: '/ws', mcpConfigPath: '/c',
  })
  assert.equal(r.opts.env.ROOM_URL, 'http://room:1')
  assert.equal(r.opts.env.ROOM_TOKEN, 'tok')
})

test('a turn is one JSON line on stdin', () => {
  const child = fakeChild()
  const o = createOrchestrator({ child, onEvent: () => {} })
  o.send('add a mul function')
  assert.equal(child.written.length, 1)
  const msg = JSON.parse(child.written[0])
  assert.equal(msg.type, 'user')
  assert.equal(msg.message.content[0].text, 'add a mul function')
  assert.ok(child.written[0].endsWith('\n'), 'the line must be terminated or it is never read')
})

test('stdout is parsed into UI events', () => {
  const child = fakeChild()
  const seen = []
  createOrchestrator({ child, onEvent: e => seen.push(e) })
  child.stdout.emit('data', JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] },
  }) + '\n')
  assert.deepEqual(seen, [{ kind: 'text', text: 'hi' }])
})

test('a worker result is relayed as a turn the orchestrator can tell apart from a person', () => {
  // It arrives as a user-role turn because that is what it is - somebody
  // reporting back - but it must be labelled, or the orchestrator will thank
  // the human for work the human did not do.
  const child = fakeChild()
  const o = createOrchestrator({ child, onEvent: () => {} })
  o.relay({ handle: 'opencode', text: 'added mul(), tests pass' })
  const msg = JSON.parse(child.written[0])
  const text = msg.message.content[0].text
  assert.match(text, /opencode/)
  assert.match(text, /added mul/)
  assert.match(text, /worker/i, 'the orchestrator must be able to tell this is not the human')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test extension/test/orchestrator.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// extension/src/orchestrator.js
'use strict'
const { createStreamParser } = require('./stream.js')

const SYSTEM_PROMPT = `You are the orchestrator in a room that also has cheap worker seats.

Design, decide and verify yourself. Hand mechanical work - boilerplate, tests, mechanical refactors, documentation, lint and build fixes - to a worker with the delegate tool. Keep architecture, ambiguous requirements, hard debugging and final integration decisions.

When you delegate, say so in your reply. Your live output is visible only to the person here; anyone else in the room sees only what you actually state, so decisions must be said, not merely thought.`

/**
 * One long-lived Claude Code process, serving every turn of the chat.
 *
 * Verified against the real binary: two prompts over one process kept one
 * session_id and the second turn recalled a fact from the first.
 *
 * `--bare` is deliberately absent. It would skip the user's hooks and
 * CLAUDE.md, which is tempting - but it also never reads OAuth or the keychain
 * and requires an API key, and reusing the existing subscription login is the
 * whole reason this is pleasant to install.
 */
function orchestratorRecipe({
  repoRoot, roomUrl, token, sessionId, workspace, mcpConfigPath,
  env = process.env, claudePath = 'claude',
}) {
  return {
    cmd: claudePath,
    args: [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', sessionId,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--mcp-config', mcpConfigPath,
      '--add-dir', workspace,
    ],
    opts: {
      cwd: workspace,
      env: { ...env, ROOM_URL: roomUrl, ROOM_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  }
}

/** The MCP config naming the bridge — written to disk, never passed as argv JSON. */
function bridgeMcpConfig(repoRoot) {
  const { join } = require('node:path')
  return { mcpServers: { orchestrator: { command: 'node', args: [join(repoRoot, 'src', 'orchestrator-bridge.mjs')] } } }
}

function userTurn(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
}

function createOrchestrator({ child, onEvent }) {
  let sessionId = null
  const parser = createStreamParser({
    onEvent: e => {
      if (e.kind === 'session') sessionId = e.sessionId
      onEvent(e)
    },
  })
  child.stdout.on('data', d => parser.push(String(d)))

  return {
    send(text) { child.stdin.write(userTurn(text)) },
    /**
     * A worker's report, handed to the orchestrator as a turn.
     *
     * Labelled, because it arrives on the same channel a person's message
     * does: unlabelled, the orchestrator would credit the human with work a
     * worker did.
     */
    relay({ handle, text }) {
      child.stdin.write(userTurn(`[worker @${handle} reports] ${text}`))
    },
    sessionId: () => sessionId,
  }
}

module.exports = { orchestratorRecipe, bridgeMcpConfig, createOrchestrator, SYSTEM_PROMPT }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test extension/test/orchestrator.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add extension/src/orchestrator.js extension/test/orchestrator.test.js
git commit -m "feat(extension): persistent orchestrator session"
```

---

### Task 6: Extension host and chat webview

**Files:**
- Create: `extension/src/extension.js`
- Create: `extension/src/chat/panel.js`, `extension/src/chat/webview.html`, `extension/src/chat/webview.js`, `extension/src/chat/webview.css`
- Test: manual (documented below) — this is the VS Code API glue, deliberately thin

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: the `claudeRoom.openChat` command.

**Background:** All logic lives in the modules already built and tested. This task is the thin layer that wires them to VS Code and renders. Keeping it thin is what keeps the rest testable.

- [ ] **Step 1: Write `extension/src/extension.js`**

Responsibilities, in order, on `claudeRoom.openChat`:
1. resolve `repoRoot` (the extension's own directory's parent) and `workspace` (`vscode.workspace.workspaceFolders[0]`)
2. pick a free port by binding `127.0.0.1:0` and releasing it
3. `supervisor.start('room', roomRecipe({...}))`
4. poll `GET /api/state` until it answers, then `readOwnerToken` (absent on the very first boot until the room writes its roster — retry with backoff, and fail loudly after ~10s rather than hanging)
5. write the bridge MCP config to the extension's storage path
6. `supervisor.start('orchestrator', orchestratorRecipe({...}))` with a `crypto.randomUUID()` session id
7. open the webview and stream events into it
8. on `supervisor.on('exit')`, show the failure in the chat — never let the UI keep accepting input against a dead process
9. on deactivate, `supervisor.stopAll()`

- [ ] **Step 2: Write the webview**

Requirements:
- a message list, an input box, a send button; Enter sends, Shift+Enter newlines
- `text` events append to the current assistant message **without resetting scroll** if the user has scrolled up
- `thinking` renders as a collapsed disclosure
- `tool` renders a card with the tool name and its input; `tool-result` fills that card in, matched by id; `isError` styles it as a failure
- `thinking-tokens` drives a live indicator; `turn-end` clears it and shows cost
- `rate-limit` with a non-`allowed` status shows a banner with the reset time
- **all VS Code theme variables** (`--vscode-editor-background`, `--vscode-foreground`, …) so it matches the editor
- **every server-supplied string set with `textContent`**, never `innerHTML` — same rule as `src/ui.mjs`, same reason
- a strict CSP `<meta>` limiting scripts to the webview's own nonce

- [ ] **Step 3: Manual verification — record the result**

```
1. Open this repo in VS Code, F5 to launch the Extension Development Host.
2. Run "Claude Room: Open Orchestrator Chat".
3. Ask: "What files are in src/? Just list them."
4. Confirm: prose streams in; the Glob/Bash tool call renders as a card with
   its result; the thinking indicator appears and clears; cost shows at the end.
5. Close the window; confirm no `node` or `claude` process is left behind
   (Task 2's tree-kill).
```

Record what actually happened — including a failure — in `extension/README.md`.

- [ ] **Step 4: Commit**

```bash
git add extension/src/extension.js extension/src/chat/ extension/README.md
git commit -m "feat(extension): chat webview and extension host"
```

---

### Task 7: Wire delegation into the chat

**Files:**
- Modify: `extension/src/extension.js`
- Create: `extension/src/events.js`
- Test: `extension/test/events.test.js`

**Interfaces:**
- Consumes: `createRoomClient` (Task 3), `createOrchestrator.relay` (Task 5).
- Produces: `createEventRouter({ onWorkerActivity, onDelegationResult })` → `{ handle(event, data) }`.

**Background:** One SSE subscription, fanned out. A single ordering of room events is what stops a worker's reply reaching the orchestrator before the panel has shown the work.

- [ ] **Step 1: Write the failing test**

```javascript
// extension/test/events.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createEventRouter } = require('../src/events.js')

function router() {
  const activity = []
  const results = []
  return {
    r: createEventRouter({
      onWorkerActivity: a => activity.push(a),
      onDelegationResult: d => results.push(d),
    }),
    activity, results,
  }
}

test('a completed delegation is routed to the orchestrator, once', () => {
  const { r, results } = router()
  r.handle('delegation', { id: 'd1', to: 'opencode', state: 'done', text: 'added mul()' })
  assert.deepEqual(results, [{ id: 'd1', handle: 'opencode', text: 'added mul()' }])
})

test('a delegation being sent is activity, not a result', () => {
  // Relaying "sent" back to the orchestrator would tell it its own request was
  // an answer, and it would reply to itself.
  const { r, results, activity } = router()
  r.handle('delegation', { id: 'd1', to: 'opencode', state: 'sent', task: 'add mul()' })
  assert.deepEqual(results, [])
  assert.equal(activity.length, 1)
})

test('an abandoned delegation is reported so the chat does not wait forever', () => {
  const { r, results } = router()
  r.handle('delegation', { id: 'd1', to: 'opencode', state: 'abandoned', reason: 'seat-disconnected' })
  assert.equal(results[0].failed, true)
  assert.match(results[0].text, /seat-disconnected/)
})

test('worker tool calls become activity for the panel', () => {
  const { r, activity } = router()
  r.handle('activity', { handle: 'opencode', tool: 'Edit', input: { file: 'math.js' } })
  assert.equal(activity[0].tool, 'Edit')
})

test('an unknown event is ignored rather than crashing the extension host', () => {
  const { r, activity, results } = router()
  r.handle('something-new', { x: 1 })
  assert.deepEqual([activity.length, results.length], [0, 0])
})
```

- [ ] **Step 2: Run to verify failure, implement, verify pass**

Implement `createEventRouter` so each test passes. Route `delegation` events by `state` (`sent` → activity, `done` → result, `abandoned` → failed result), and everything else the panel understands to activity.

- [ ] **Step 3: Wire into `extension.js`**

Open one SSE subscription to `${roomUrl}/events?token=...` using the same by-hand frame reader as `src/seat.mjs` (`readFrames`), feed each frame to the router, and connect `onDelegationResult` to `orchestrator.relay(...)`.

- [ ] **Step 4: Manual verification — record the result**

```
1. Launch the Extension Development Host and open the chat.
2. Ask the orchestrator to delegate: "Delegate adding a mul(a,b) function to
   math.js to @opencode - give it files and tests."
3. Confirm: the delegate tool card appears; the worker's result comes back as
   a relayed turn; the orchestrator responds to it.
```

This needs a worker running, which is the next plan's Task 1 — until then, verify with `scripts/room-opencode-seat.mjs` launched by hand against the extension's room port.

- [ ] **Step 5: Commit**

```bash
git add extension/src/events.js extension/test/events.test.js extension/src/extension.js
git commit -m "feat(extension): route worker results back into the chat"
```

---

## Plan self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 repo layout, CommonJS extension | 1 |
| §2 process model, Supervisor, tree kill | 2 |
| §3 orchestrator session, stream-json, `--append-system-prompt`, no `--bare` | 1, 5 |
| §3 crash recovery via our own session id | 5 |
| §4 `orchestrator-bridge.mjs`, `POST /api/delegate` | 4 |
| §4 result relayed as a labelled user turn | 5, 7 |
| §4/§6 one SSE subscription, fanned out | 7 |
| §5 chat webview, textContent, theme vars | 6 |
| §6 workers panel | **deferred to plan 2** (spec stage 4) |
| §7 installer | **deferred to plan 2** (spec stage 5) |
| §8 solo/room modes | solo only here; sharing is plan 2 |

**Type consistency** — `createStreamParser({onEvent})` is produced in Task 1 and consumed in Task 5 under that exact name. `roomRecipe`/`orchestratorRecipe` both return `{cmd, args, opts}`, the shape `supervisor.start` takes. `createRoomClient(...).delegate` returns the room's `{ok, id?, errors?}` verbatim, which is what Task 4's route returns and what Task 7's router does not touch.

**Known assumption to verify during Task 3** — the owner token is read from `members.json`. Task 3 Step 4 checks that against a real room before the code depends on it, and says to fix the client rather than the room if it differs.
