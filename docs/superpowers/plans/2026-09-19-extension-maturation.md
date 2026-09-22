# Extension Maturation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the extension from a chat window with a room bolted on into a companion for Claude Code: a room session that runs whether or not a chat is open, a `claudeRoom.room` sidebar view that owns publish/stop-sharing/invite/roster, a worker pool that views what the room owns instead of spawning processes itself, a dormant chat behind a setting, and a `.vsix` a stranger can install.

**Architecture:** A new `extension/src/session.js` owns everything that today hides inside `openChat()` — the room child, the owner token, the single SSE subscription, the worker pool, and `postRoom`/`republish`/`invite` — and exposes it through listener registration (`onRoom`, `onWorkers`, `onActivity`, `onDelegationResult`) so both sidebar views and the (optional) chat consume one session. The two sidebar webviews (`workers-view.js`, `room-view.js`) stay the only VS Code-aware rendering glue, and `extension.js` shrinks to activation, command registration and the vscode-shaped `ui` adapter the session is given. Worker spawning moves out entirely: `room-client.js` gains `spawnWorker`/`stopWorker` against the routes the robustness plan adds, and `workers.js` keeps only the event-driven state it already had.

**Tech Stack:** Node 22+, CommonJS, zero runtime dependencies, no build step. `node --test` with `assert/strict`. Webviews are plain `<script>` tags under a strict CSP. Packaging via `npx @vscode/vsce package`. External CLIs (`claude`, `opencode`, `devtunnel`) are detected, never assumed.

**Spec:** `docs/superpowers/specs/2026-09-19-extension-maturation-design.md`

## Global Constraints

- **Baseline, measured on this branch before Task 1** (`cd extension && node --test`): **263 tests, 262 pass, 0 fail, 1 skipped** (the skip is `skills.test.js`'s opt-in "the real machine has skills" case). The suite must report 0 failures after **every** task; the total may only go up, except where this plan says explicitly which tests are deleted and where their coverage moved.
- **`extension/` is CommonJS**, has **no runtime dependencies**, **no build step**, and **no `"type"` field** in `extension/package.json`. Node resolves module type per nearest `package.json`; adding `"type"` would break the room's ESM suite running in the same `node --test` invocation.
- **Pure logic is injectable.** `spawn`, `fetch`, `env`, `platform`, `exists`, and the clock (`now`, `sleep`) are parameters with real defaults, never read from a global inside a function under test. **No test spawns a real binary or opens a non-loopback socket.**
- **Anything that needs the real `vscode` module stays thin glue** — `extension.js`, `chat/panel.js`, `chat/workers-view.js`, `chat/worker-panel.js`, `chat/room-view.js`. Those files are covered by the recorded manual F5 verification (Task 12), not by unit tests. Every task that edits one says so and gives the exact manual check.
- **Kill process trees, not processes**: every child goes through `supervisor.start` / `supervisor.stop` (`extension/src/supervisor.js:14` `defaultKillTree`). After Task 3 the extension supervises exactly two children: `room` and `tunnel`. Worker processes belong to the room.
- **Every server- or model-supplied string is rendered with `textContent`, never `innerHTML`**, on any path, in any webview.
- **Webview CSP/nonce pattern**: each html file carries `default-src 'none'; … script-src 'nonce-{{nonce}}';` and every `<script>` tag gets the same `{{nonce}}`; the host substitutes `{{cspSource}}`, `{{nonce}}` and one `{{…Uri}}` per script (`workers-view.js:33-43` is the template to copy).
- **Design-system rules** (`docs/design-system.md` §9): theme tokens only — no hex literal in `webview.css`, every fallback chain ending in a literal; SVG icons from `chat/icons.js`, never emoji; state carried by a **word and a shape**, never colour alone; a visible focus ring on every interactive element; an `aria-label` on every icon-only button; exactly one atomic live region per surface, saying something rather than a number.
- **Browser `<script>` tags share one global scope.** `chat-globals.test.js:114` fails the build if two chat modules declare the same top-level name. Every new webview script is a single IIFE with nothing top-level, like `workers-webview.js:10`.
- **Never edit an existing test to make a change pass.** Add tests. Where this plan deletes or moves a test it is because its *subject* was deleted or moved, and the task says so explicitly and names where the coverage now lives. Four places do this: Task 3 (worker spawning moves to the room), Task 7 (the harness's host-file list gains a fourth webview), Task 10 (the room chip's tests move to the Room view's tests).
- **Test style**: `const { test } = require('node:test')` + `const assert = require('node:assert/strict')`. Test names state the *why*, not the *what*.
- **Commit after every task** with a `feat:` / `fix:` / `docs:` prefix.

**Cross-plan interface contract** (the room side is built by `docs/superpowers/plans/`'s robustness plan; this plan only consumes it):

- `POST /api/spawn-worker`, body `{model?}` → `{ok:true,handle}` | `{ok:false,errors}` — owner-only.
- `POST /api/stop-worker`, body `{handle}` → `{ok:true}` | `{ok:false,errors}` — owner-only.

Both are called through `room-client.js` exactly like `delegate`, with the same error-normalising shape. If the room side is not merged yet, Task 3's tests still pass (they use an injected `roomClient`), and the live Add button reports the room's own 404 verbatim rather than pretending.

---

### Task 1: `spawnWorker` / `stopWorker` on the room client

**Files:**
- Modify: `extension/src/room-client.js` (add two methods in the returned object, after `remove` at line 122)
- Test: `extension/test/room-client.test.js` (append; existing cases untouched)

**Interfaces:**
- Consumes: the robustness plan's `POST /api/spawn-worker` and `POST /api/stop-worker`.
- Produces: `spawnWorker({ model }) -> Promise<{ok:true,handle}|{ok:false,errors}>`, `stopWorker(handle) -> Promise<{ok:true}|{ok:false,errors}>`, both routed through the existing `post()` helper (`room-client.js:68-80`) so a non-200 becomes `{ok:false,errors:['… HTTP 503']}` rather than a thrown status.

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/room-client.test.js`:

```javascript

// --- worker provisioning, which the room owns ------------------------------

test('spawning a worker asks the room, because the room owns worker processes', async () => {
  // The extension used to mint a seat and spawn the launcher itself. The room
  // does both now (robustness spec §1), so this is one POST and the room's
  // verdict comes back verbatim -- exactly like delegate.
  let sent = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) }
      return { ok: true, json: async () => ({ ok: true, handle: 'worker-1' }) }
    },
  })
  const r = await client.spawnWorker({ model: 'opencode/mimo-v2.5-free' })
  assert.match(sent.url, /\/api\/spawn-worker\?token=tok/)
  assert.deepEqual(sent.body, { model: 'opencode/mimo-v2.5-free' })
  assert.equal(r.handle, 'worker-1')
})

test('no model means the room picks its own default, not a pinned one', async () => {
  // Sending `model: null` would pin whatever the extension happened to think
  // the default was. An absent field lets the room's own default win.
  let body = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ ok: true, handle: 'worker-1' }) }
    },
  })
  await client.spawnWorker()
  assert.deepEqual(body, {})
})

test('a refused spawn reports the room errors rather than pretending it worked', async () => {
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  const r = await client.spawnWorker({ model: null })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /503/)
})

test('stopping a worker names the handle the room should reap', async () => {
  let sent = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) }
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  const r = await client.stopWorker('worker-2')
  assert.match(sent.url, /\/api\/stop-worker/)
  assert.deepEqual(sent.body, { handle: 'worker-2' })
  assert.equal(r.ok, true)
})
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd extension && node --test test/room-client.test.js
```

Expected: 4 failures, each `TypeError: client.spawnWorker is not a function` / `client.stopWorker is not a function`.

- [ ] **Step 3: Add the two methods**

In `extension/src/room-client.js`, immediately after `remove: memberId => post('/api/admin/remove', { memberId }),` (line 122), insert:

```javascript

    // --- worker provisioning (owner-only) ---
    //
    // The room owns worker processes now: it mints the seat, allocates the
    // handle and spawns `scripts/room-opencode-seat.mjs` under its own
    // supervisor. The extension asks. One implementation of "spawn a worker"
    // serves channel-mode sessions and this extension alike, which is what
    // keeps the extension working standalone with no channel session.
    //
    // `model` is omitted when unset so the room's own default wins; sending
    // null would silently pin whatever the extension believed the default was.
    spawnWorker: ({ model = null } = {}) => post('/api/spawn-worker', model ? { model } : {}),
    stopWorker: handle => post('/api/stop-worker', { handle }),
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd extension && node --test
```

Expected: 267 tests, 266 pass, 0 fail, 1 skipped.

- [ ] **Step 5: Commit**

```bash
git add extension/src/room-client.js extension/test/room-client.test.js
git commit -m "feat(extension): ask the room to spawn and stop workers" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `install.js` — detect the three tools, and say how to get them

**Files:**
- Create: `extension/src/install.js`
- Modify: `extension/src/tunnel.js` (lines 1-23: `detectDevtunnel` becomes a one-line delegate; its export stays)
- Test: `extension/test/install.test.js` (new). `extension/test/tunnel.test.js` is **not** edited and must stay green — it is the proof the generalisation did not break the existing caller.

**Interfaces:**
- Consumes: `fs.existsSync`, `process.env`, `process.platform`, all injectable.
- Produces:
  - `onPath(name, { exists, env, platform }) -> boolean`
  - `detectTools({ exists, env, platform }) -> { claude: boolean, opencode: boolean, devtunnel: boolean }`
  - `installPlan(missing, { platform }) -> Array<{ tool, command, note }>` — `missing` is an array of tool names; the commands are exactly what a human would type.

- [ ] **Step 1: Write the failing tests**

Create `extension/test/install.test.js`:

```javascript
// extension/test/install.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { onPath, detectTools, installPlan } = require('../src/install.js')

test('a tool is found on PATH the same way the room resolves a command', () => {
  const exists = p => p === '/usr/local/bin/claude'
  assert.equal(onPath('claude', { exists, env: { PATH: '/usr/local/bin' }, platform: 'linux' }), true)
  assert.equal(onPath('opencode', { exists, env: { PATH: '/usr/local/bin' }, platform: 'linux' }), false)
})

test('on Windows the shim extensions are what actually exist on disk', () => {
  // `claude` on Windows is a .cmd shim; looking only for the bare name finds
  // nothing and the extension would offer to install something already there.
  const exists = p => p === 'C:/bin/claude.cmd'
  assert.equal(onPath('claude', { exists, env: { Path: 'C:/bin' }, platform: 'win32' }), true)
})

test('detectTools answers for all three, so one dialog can list everything missing', () => {
  const exists = p => p === '/usr/local/bin/claude'
  const found = detectTools({ exists, env: { PATH: '/usr/local/bin' }, platform: 'linux' })
  assert.deepEqual(found, { claude: true, opencode: false, devtunnel: false })
})

test('an empty PATH reports everything missing rather than throwing', () => {
  assert.deepEqual(
    detectTools({ exists: () => false, env: {}, platform: 'linux' }),
    { claude: false, opencode: false, devtunnel: false },
  )
})

test('the plan names the exact command a human would type, per platform', () => {
  const win = installPlan(['devtunnel'], { platform: 'win32' })
  assert.equal(win[0].tool, 'devtunnel')
  assert.equal(win[0].command, 'winget install --id Microsoft.devtunnel -e')
  const mac = installPlan(['devtunnel'], { platform: 'darwin' })
  assert.match(mac[0].command, /brew install/)
})

test('devtunnel carries its one-time login, because installing it is not enough', () => {
  // `devtunnel host` fails until `devtunnel user login` has been done once,
  // and that failure reads like a broken extension rather than a missing step.
  const [plan] = installPlan(['devtunnel'], { platform: 'win32' })
  assert.match(plan.note, /devtunnel user login/)
})

test('an unknown tool is dropped rather than offered as a guessed command', () => {
  // Offering a made-up install command is worse than offering none: it runs.
  assert.deepEqual(installPlan(['kubectl'], { platform: 'linux' }), [])
})

test('nothing missing means nothing to offer', () => {
  assert.deepEqual(installPlan([], { platform: 'win32' }), [])
})
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd extension && node --test test/install.test.js
```

Expected: `Error: Cannot find module '../src/install.js'`.

- [ ] **Step 3: Write `install.js`**

Create `extension/src/install.js`:

```javascript
// extension/src/install.js
//
// Which of the three external binaries this extension needs are actually on
// PATH, and the exact command that installs a missing one.
//
// Generalises tunnel.js's detectDevtunnel: the question "is X on PATH" is the
// same one src/spawn.mjs's resolveCommand answers on the room side,
// reimplemented here because extension/ is CommonJS and src/ is ESM and
// nothing crosses that boundary by import (ARCHITECTURE.md).
//
// Nothing here installs anything. It returns commands; a caller shows them and
// installs only after an explicit confirmation. A silent install of a binary a
// user did not ask for is not a convenience, it is a surprise.
'use strict'
const { existsSync } = require('node:fs')

/** The names each tool actually has on disk, per platform. */
const NAMES = {
  claude: { win32: ['claude.exe', 'claude.cmd'], other: ['claude'] },
  opencode: { win32: ['opencode.exe', 'opencode.cmd'], other: ['opencode'] },
  devtunnel: { win32: ['devtunnel.exe', 'devtunnel.cmd'], other: ['devtunnel'] },
}

/**
 * How to install each tool, per platform, and anything that is still needed
 * afterwards. Verified commands only -- a tool with no known command for a
 * platform is omitted, because a guessed install command gets run.
 */
const INSTALL = {
  claude: {
    all: 'npm install -g @anthropic-ai/claude-code',
    note: 'Then run `claude` once to sign in with your existing subscription.',
  },
  opencode: {
    all: 'npm install -g opencode-ai',
    note: 'Workers run through this; the room needs it only when you add a worker.',
  },
  devtunnel: {
    win32: 'winget install --id Microsoft.devtunnel -e',
    darwin: 'brew install --cask devtunnel',
    other: 'curl -sL https://aka.ms/DevTunnelCliInstall | bash',
    note: 'Then run `devtunnel user login` once — publishing fails until you have.',
  },
}

/** Is `name` on PATH? A yes/no, never a path: spawning resolves through the OS. */
function onPath(name, { exists = existsSync, env = process.env, platform = process.platform } = {}) {
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const candidates = NAMES[name]
  if (!candidates) return false
  const names = platform === 'win32' ? candidates.win32 : candidates.other
  for (const dir of dirs) {
    for (const n of names) {
      if (exists(`${dir}/${n}`)) return true
    }
  }
  return false
}

/** All three answers at once, so one dialog can list everything that is missing. */
function detectTools(deps = {}) {
  return {
    claude: onPath('claude', deps),
    opencode: onPath('opencode', deps),
    devtunnel: onPath('devtunnel', deps),
  }
}

/**
 * The exact commands to offer for `missing`, in the order given.
 *
 * @param {string[]} missing tool names
 * @returns {Array<{tool: string, command: string, note: string}>}
 */
function installPlan(missing, { platform = process.platform } = {}) {
  const plan = []
  for (const tool of missing ?? []) {
    const spec = INSTALL[tool]
    if (!spec) continue // no verified command: offer nothing rather than a guess
    const command = spec.all ?? spec[platform] ?? spec.other
    if (!command) continue
    plan.push({ tool, command, note: spec.note })
  }
  return plan
}

module.exports = { onPath, detectTools, installPlan, NAMES }
```

- [ ] **Step 4: Point `detectDevtunnel` at it, keeping its export**

In `extension/src/tunnel.js`, replace lines 1-23 (the `require` and the whole `detectDevtunnel` body) with:

```javascript
'use strict'
const { onPath } = require('./install.js')

/**
 * Is the `devtunnel` CLI on PATH?
 *
 * Kept as its own export because `republish` reads better asking this exact
 * question, but the lookup itself is install.js's `onPath` -- one PATH walk
 * for all three tools rather than three copies of it.
 */
function detectDevtunnel(deps = {}) {
  return onPath('devtunnel', deps)
}
```

- [ ] **Step 5: Run the whole suite**

```bash
cd extension && node --test
```

Expected: 275 tests, 274 pass, 0 fail, 1 skipped. `tunnel.test.js`'s two `detectDevtunnel` cases pass unchanged — that is the point of this step.

- [ ] **Step 6: Commit**

```bash
git add extension/src/install.js extension/src/tunnel.js extension/test/install.test.js
git commit -m "feat(extension): detect claude, opencode and devtunnel, and name the install commands" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: the worker pool becomes a viewer with a thin client

**Files:**
- Modify: `extension/src/workers.js` — delete `workerRecipe` (lines 38-66), `nextHandle` (lines 69-75), `ownerId` (lines 107-110), `spawn` (lines 112-166) and `stopAll` (lines 187-191); rewrite `add`/`ensureOne`/`stop`; drop the `supervisor`, `repoRoot` and `roomUrl` deps from `createWorkerPool` (lines 82-86); drop `const { join } = require('node:path')` (line 18)
- Modify: `extension/src/extension.js` line 391 — the `createWorkerPool({...})` call loses `supervisor`, `repoRoot`, `roomUrl`
- Test: `extension/test/workers.test.js` — rewrite the fixture and the provisioning half; the event-driven half (lines 165-298) is untouched

**Tests deleted here, and why** (each one's subject is deleted, not weakened):
- `'the recipe launches the seat launcher, not opencode directly'` (line 31), `'a model and a timeout are passed only when chosen'` (line 47), `'the seat token never reaches the environment, only argv'` (line 62), `'the worker runs in the repo, which is where its worktree is made'` (line 72) — all cover `workerRecipe`, which is deleted. **Its coverage moves to the room side**: the robustness plan ports this logic to ESM and tests it there (`spawn_worker`, robustness spec §1). Nothing in `extension/` builds a worker recipe any more.
- `'handles are allocated in order and reuse a freed one'` (line 77) — covers `nextHandle`, deleted for the same reason; handle allocation is the room's.
- `'a pool that cannot learn the owner id does not invent one'` (line 124) — `ownerId` is deleted; the room knows its own owner.
- `'a spawn that throws does not leave the worker listed as live'` (line 138) — there is no local spawn to throw. Its *intent* (a failed start must not leave a phantom row) is preserved by the rewritten `'a refused spawn leaves no half-created worker in the list'`.

**Interfaces:**
- Consumes: `roomClient.spawnWorker({model})`, `roomClient.stopWorker(handle)` (Task 1).
- Produces: `createWorkerPool({ roomClient, model, timeoutMs, log, now })` with `ensureOne()`, `add({model})`, `stop(handle)`, `list()`, `detail(handle)`, `onChange(fn)`, `applyRoomEvent(event, data)` — the last four unchanged in behaviour and signature.

- [ ] **Step 1: Rewrite the provisioning tests (they fail first)**

Replace `extension/test/workers.test.js` lines 1-163 (everything above the `// --- live state` banner) with:

```javascript
// extension/test/workers.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWorkerPool } = require('../src/workers.js')

/**
 * A pool whose room always succeeds.
 *
 * No supervisor: the room owns worker processes now, so the only seam left is
 * the HTTP client.
 */
function fakePool(over = {}) {
  const spawned = []
  const stopped = []
  let n = 0
  const pool = createWorkerPool({
    log: () => {},
    roomClient: {
      spawnWorker: async a => { spawned.push(a ?? {}); return { ok: true, handle: `worker-${++n}` } },
      stopWorker: async h => { stopped.push(h); return { ok: true } },
      ...(over.roomClient ?? {}),
    },
    ...(over.pool ?? {}),
  })
  return { pool, spawned, stopped }
}

test('ensureOne asks the room for a worker, and only ever one', async () => {
  const { pool, spawned } = fakePool()
  await pool.ensureOne()
  await pool.ensureOne() // idempotent
  assert.equal(spawned.length, 1)
  assert.equal(pool.list().length, 1)
})

test('a worker starts in the starting state, not idle', () => {
  // It has no worktree and no opencode yet, and a delegation sent now would
  // fail. Saying "idle" would be a lie the sidebar repeats.
  const { pool } = fakePool()
  return pool.ensureOne().then(() => {
    assert.equal(pool.list()[0].state, 'starting')
  })
})

test('add() asks for a second worker alongside the first', async () => {
  const { pool, spawned } = fakePool()
  await pool.ensureOne()
  await pool.add()
  assert.deepEqual(pool.list().map(w => w.handle), ['worker-1', 'worker-2'])
  assert.equal(spawned.length, 2)
})

test('the handle in the list is the one the room assigned, never a guessed one', async () => {
  // The room allocates handles now. Inventing `worker-1` locally would make
  // the sidebar address a seat that does not exist.
  const { pool } = fakePool({
    roomClient: { spawnWorker: async () => ({ ok: true, handle: 'worker-7' }) },
  })
  await pool.add()
  assert.deepEqual(pool.list().map(w => w.handle), ['worker-7'])
})

test('a chosen model is passed through, an unchosen one is not invented', async () => {
  const { pool, spawned } = fakePool({ pool: { model: 'opencode/mimo-v2.5-free' } })
  await pool.add()
  await pool.add({ model: 'opencode/other' })
  assert.deepEqual(spawned, [{ model: 'opencode/mimo-v2.5-free' }, { model: 'opencode/other' }])
})

test('a refused spawn leaves no half-created worker in the list', async () => {
  const { pool } = fakePool({
    roomClient: { spawnWorker: async () => ({ ok: false, errors: ['no opencode on PATH'] }) },
  })
  const logged = []
  const { pool: loud } = fakePool({
    pool: { log: m => logged.push(String(m)) },
    roomClient: { spawnWorker: async () => ({ ok: false, errors: ['no opencode on PATH'] }) },
  })
  await pool.add()
  await loud.add()
  assert.deepEqual(pool.list(), [], 'a worker the room refused is not a worker')
  assert.match(logged.join('\n'), /no opencode on PATH/, 'the room reason must survive verbatim')
})

test('a spawn that answers without a handle is refused, not listed as blank', async () => {
  const { pool } = fakePool({ roomClient: { spawnWorker: async () => ({ ok: true }) } })
  await pool.add()
  assert.deepEqual(pool.list(), [])
})

test('stop asks the room to reap the worker, then forgets it', async () => {
  const { pool, stopped } = fakePool()
  await pool.ensureOne()
  await pool.stop('worker-1')
  assert.deepEqual(stopped, ['worker-1'])
  assert.deepEqual(pool.list(), [])
})

test('a stop the room refused keeps the worker visible, because it is still running', async () => {
  // Dropping the row would hide a live process holding a worktree. The room is
  // the authority on whether it died; until it says so, it is still there.
  const { pool } = fakePool({
    roomClient: { stopWorker: async () => ({ ok: false, errors: ['unknown handle'] }) },
  })
  await pool.ensureOne()
  await pool.stop('worker-1')
  assert.equal(pool.list().length, 1)
})

test('listeners are told when the fleet changes, so the sidebar can redraw', async () => {
  const { pool } = fakePool()
  const seen = []
  pool.onChange(list => seen.push(list.length))
  await pool.ensureOne()
  await pool.stop('worker-1')
  assert.deepEqual(seen, [1, 0])
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd extension && node --test test/workers.test.js
```

Expected: the provisioning cases fail with `TypeError: roomClient.state is not a function` (the old `spawn` still calls `ownerId`), and `'the handle in the list…'` fails with `worker-1 !== worker-7`.

- [ ] **Step 3: Rewrite the pool**

In `extension/src/workers.js`: delete line 18 (`const { join } = require('node:path')`), delete `workerRecipe` (38-66) and `nextHandle` (69-75), and replace the header comment block (lines 1-16), the `createWorkerPool` signature (82-86), `ownerId`/`spawn` (107-166) and the `ensureOne`/`add`/`stop`/`stopAll` entries (169-191) as follows.

Header (replacing lines 1-16):

```javascript
// extension/src/workers.js
//
// The worker fleet, as the extension sees it: what exists, what each one is
// doing, and what it has done.
//
// Nothing is spawned here. The room mints the seat, allocates the handle and
// runs `scripts/room-opencode-seat.mjs` under its own supervisor; this asks it
// to, over HTTP, through room-client.js. One implementation of "spawn a
// worker" serves channel-mode sessions and this extension alike, and the
// extension no longer supervises processes the room owns.
//
// The live state is driven entirely by the room's own event stream, which the
// session already subscribes to once. `applyRoomEvent` is pure over this
// module's own state, which is what makes the whole thing testable without a
// socket or a real worker.
```

Signature (replacing lines 77-86):

```javascript
/**
 * @param {{roomClient: object, model?: string, timeoutMs?: number,
 *          log?: Function, now?: () => number}} deps
 */
function createWorkerPool({
  roomClient,
  model = null, timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  log = () => {}, now = Date.now,
}) {
```

`spawn` (replacing lines 106-166):

```javascript
  /**
   * Ask the room for a worker and record what it gave back.
   *
   * The handle comes from the response, never from a local counter: the room
   * allocates it, and a guessed one would address a seat that does not exist.
   */
  async function spawn({ model: wanted = model } = {}) {
    const r = await roomClient.spawnWorker(wanted ? { model: wanted } : {})
    if (!r?.ok || !r.handle) {
      log(`could not start a worker: ${r?.errors?.[0] ?? 'the room did not return a handle'}`)
      return null // a worker the room refused is not a worker
    }

    workers.set(r.handle, {
      handle: r.handle,
      model: wanted,
      // The room always makes it here; the path is shown, the directory is
      // not this process's to know.
      worktree: `.worktrees/${r.handle}`,
      // Not idle: there is no worktree and no opencode yet, and a delegation
      // sent now would fail. "Idle" would be a lie the sidebar repeats.
      state: 'starting',
      task: null,
      lastTool: null,
      deadlineAt: null,
      startedAt: now(),
      // What the orchestrator actually asked for, kept as fields rather than
      // as the prose the model received. Outlives the delegation: "what was it
      // asked to do" is still the question after the answer arrives.
      brief: null,
      transcript: [],
      toolsUsed: [],
    })
    changed()
    return r.handle
  }
```

The lifecycle entries (replacing lines 168-191, keeping `list`, `detail`, `onChange`, `applyRoomEvent` exactly as they are):

```javascript
  return {
    /** Start a worker if there are none. Idempotent. */
    async ensureOne() {
      if (workers.size > 0) return null
      return spawn()
    },

    /** Start another worker alongside the existing ones. */
    add(opts = {}) {
      return spawn(opts)
    },

    /**
     * Ask the room to stop a worker, and forget it only if it agreed.
     *
     * Dropping the row on a refusal would hide a live process holding a
     * worktree; the room is the authority on whether it actually died.
     */
    async stop(handle) {
      if (!workers.has(handle)) return
      const r = await roomClient.stopWorker(handle)
      if (!r?.ok) {
        log(`could not stop ${handle}: ${r?.errors?.[0] ?? 'unknown error'}`)
        return
      }
      workers.delete(handle)
      changed()
    },
```

Finally, change the export line 272 to:

```javascript
module.exports = { createWorkerPool, DEFAULT_TURN_TIMEOUT_MS, MAX_TRANSCRIPT }
```

- [ ] **Step 4: Update the one call site**

In `extension/src/extension.js`, replace line 391:

```javascript
  const pool = createWorkerPool({ roomClient, supervisor, repoRoot: REPO_ROOT, roomUrl, log })
```

with:

```javascript
  const pool = createWorkerPool({ roomClient, log })
```

and replace the `pool.stopAll()` call in the dispose handler (lines 552-558) with:

```javascript
  panel.onDidDispose(() => {
    stopFeed()
    // The workers are NOT stopped here any more: the room owns them, the
    // sidebar outlives the chat, and killing a fleet because a chat window
    // closed would throw away work in progress.
    if (session?.panel === panel) session = null
  })
```

- [ ] **Step 5: Run the whole suite**

```bash
cd extension && node --test
```

Expected: 275 tests, 274 pass, 0 fail, 1 skipped (7 provisioning tests deleted, 7 added, 4 net-new: the totals happen to match at 275 — what matters is **0 failures**). `workers-format.test.js` and the event half of `workers.test.js` pass untouched.

- [ ] **Step 6: Commit**

```bash
git add extension/src/workers.js extension/src/extension.js extension/test/workers.test.js
git commit -m "feat(extension): the worker pool views the room's fleet instead of spawning it" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `session.js` — the room, lifted out of `openChat()` (nothing consumes it yet)

**Files:**
- Create: `extension/src/session.js`
- Test: `extension/test/session.test.js` (new)

This is the first half of the strangler: `session.js` is written and tested while `extension.js` keeps its own copies of the same code, so the suite cannot break. Task 5 switches the consumer over and deletes the originals. `republish` is ported **verbatim, bug included** (`published` surviving a failed restart); Task 6 fixes it with its own failing test, so the fix is attributable rather than smuggled into a move.

**Interfaces:**
- Consumes: `roomRecipe`, `readOwnerToken`, `createRoomClient`, `PUBLISHED_HOST` (`room-client.js:129`); `detectDevtunnel`, `tunnelRecipe`, `parseTunnelUrl` (`tunnel.js:55`); `createEventRouter` (`events.js:86`); `createWorkerPool` (`workers.js`, Task 3); a `supervisor` (`supervisor.js:93`); a `ui` adapter `{ showError, showInfo, copy }`.
- Produces: `createSession(deps) -> { start, stop, postRoom, republish, invite, onRoom, onWorkers, onActivity, onDelegationResult, isPublished, roomUrl, token, roomClient, pool }`.

- [ ] **Step 1: Write the failing tests**

Create `extension/test/session.test.js`:

```javascript
// extension/test/session.test.js
//
// Everything that used to be unreachable inside openChat(): starting the room,
// waiting for it, the one SSE subscription, and the room controls. All of it is
// testable here because the only two things that genuinely need VS Code -- a
// dialog and the clipboard -- arrive as `ui`.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSession } = require('../src/session.js')

/** An SSE body: one `getReader()` handing out the frames, then done. */
function sseBody(frames) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    getReader: () => ({
      read: async () => (i < frames.length
        ? { done: false, value: encoder.encode(frames[i++]) }
        : { done: true, value: undefined }),
    }),
  }
}

function harness(over = {}) {
  const started = []
  const stopped = []
  const errors = []
  const infos = []
  const copied = []
  let clock = 0
  const session = createSession({
    repoRoot: '/repo',
    stateDir: '/state',
    supervisor: {
      start: (name, recipe) => { started.push({ name, recipe }); return { child: { pid: 1 } } },
      stop: name => stopped.push(name),
      status: () => ({ output: 'Connect via browser: https://abc-1234.inc1.devtunnels.ms\n' }),
      ...(over.supervisor ?? {}),
    },
    ui: {
      showError: m => errors.push(String(m)),
      showInfo: m => infos.push(String(m)),
      copy: async t => copied.push(String(t)),
    },
    pickPort: async () => 51820,
    readToken: () => 'owner-token',
    detectTunnel: () => true,
    // No real waiting anywhere: the clock advances a second per read, so a
    // poll that is going to time out does so immediately.
    sleep: async () => {},
    now: () => (clock += 1000),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    log: () => {},
    ...over,
  })
  return { session, started, stopped, errors, infos, copied }
}

test('start launches the room on a port nothing else holds, then waits for its token', async () => {
  const { session, started } = harness()
  const r = await session.start()
  assert.equal(r.ok, true)
  assert.equal(session.roomUrl, 'http://127.0.0.1:51820')
  assert.equal(session.token, 'owner-token')
  assert.equal(started[0].name, 'room')
  assert.equal(started[0].recipe.opts.env.ROOM_PORT, '51820')
  assert.equal(started[0].recipe.opts.env.ROOM_HOST, '127.0.0.1')
})

test('a room that never writes its token fails loudly instead of hanging', async () => {
  // Hanging here is the worst outcome: a sidebar that never says anything and
  // a room process nobody stops.
  const { session, stopped } = harness({ readToken: () => null })
  const r = await session.start()
  assert.equal(r.ok, false)
  assert.match(r.error, /owner token/)
  assert.deepEqual(stopped, ['room'], 'the half-started room must not be left running')
})

test('a room that never listens fails rather than handing back a dead client', async () => {
  const { session } = harness({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  const r = await session.start()
  assert.equal(r.ok, false)
  assert.match(r.error, /start listening/)
})

test('starting twice reuses the one room, because two would fight over the state dir', async () => {
  const { session, started } = harness()
  await session.start()
  await session.start()
  assert.equal(started.filter(s => s.name === 'room').length, 1)
})

test('one subscription feeds the pool, the activity listeners and the relay', async () => {
  // ARCHITECTURE.md: one subscription, one ordering. A second would let a
  // worker's reply reach the orchestrator before the panel showed the work.
  const frames = [
    'event: delegation\ndata: {"id":"d1","to":"worker-1","state":"sent","task":"Add tests"}\n\n',
    'event: delegation\ndata: {"id":"d1","to":"worker-1","state":"done","text":"added 4"}\n\n',
  ]
  let feeds = 0
  const { session } = harness({
    fetchImpl: async url => {
      if (String(url).includes('/events')) {
        feeds++
        return { ok: true, status: 200, body: sseBody(frames) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, handle: 'worker-1' }) }
    },
  })
  const activity = []
  const results = []
  session.onActivity(a => activity.push(a))
  session.onDelegationResult(d => results.push(d))
  await session.start()
  await session.pool.add()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(feeds, 1, 'exactly one subscription')
  assert.equal(activity[0].kind, 'delegation-sent')
  assert.equal(results[0].text, 'added 4')
  assert.equal(session.pool.list()[0].state, 'idle', 'the pool saw the same stream')
})

test('a malformed frame does not kill the feed', async () => {
  const frames = [
    'event: delegation\ndata: {not json}\n\n',
    'event: delegation\ndata: {"id":"d1","to":"w","state":"done","text":"ok"}\n\n',
  ]
  const { session } = harness({
    fetchImpl: async url => (String(url).includes('/events')
      ? { ok: true, status: 200, body: sseBody(frames) }
      : { ok: true, status: 200, json: async () => ({}) }),
  })
  const results = []
  session.onDelegationResult(d => results.push(d))
  await session.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(results.length, 1)
})

test('stop ends the feed rather than reconnecting against a room nobody started', async () => {
  let feeds = 0
  const { session } = harness({
    fetchImpl: async url => {
      if (String(url).includes('/events')) { feeds++; return { ok: true, status: 200, body: sseBody([]) } }
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  await session.start()
  session.stop()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(feeds, 1)
})

test('the roster is reported as unknown when the call failed, never as empty', async () => {
  // "Nobody is here" because the room was briefly restarting is a confident
  // lie about who can read the room.
  const { session } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/state')
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  const rooms = []
  session.onRoom(r => rooms.push(r))
  await session.start()
  await session.postRoom()
  assert.equal(rooms.at(-1).members, null)
})

test('the advertised address comes from a join link, not from a local guess', async () => {
  const { session } = harness({
    fetchImpl: async url => {
      if (String(url).includes('/api/admin/state')) {
        return { ok: true, status: 200, json: async () => ({
          members: [{ id: 'm0', name: 'you', role: 'owner', joinUrl: 'https://abc-1234.inc1.devtunnels.ms/?token=SECRET' }],
        }) }
      }
      return { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }
    },
  })
  const rooms = []
  session.onRoom(r => rooms.push(r))
  await session.start()
  await session.postRoom()
  assert.equal(rooms.at(-1).advertised, 'https://abc-1234.inc1.devtunnels.ms/?token=SECRET')
  assert.deepEqual(rooms.at(-1).members, [{ id: 'm0', name: 'you', role: 'owner' }])
})

test('an invite goes to the clipboard, never through a listener', async () => {
  // The token IS the identity: it must not reach anything that renders.
  const { session, copied, infos } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/invite')
      ? { ok: true, status: 200, json: async () => ({ ok: true, joinUrl: 'https://x/?token=SECRETTOKEN' }) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  const rooms = []
  session.onRoom(r => rooms.push(r))
  await session.start()
  await session.invite({ name: 'ana', role: 'member' })
  assert.deepEqual(copied, ['https://x/?token=SECRETTOKEN'])
  assert.match(infos.join(' '), /clipboard/)
  assert.ok(!JSON.stringify(rooms).includes('SECRETTOKEN'))
})

test('a refused invite says so instead of copying nothing and claiming success', async () => {
  const { session, copied, errors } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/invite')
      ? { ok: false, status: 403, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  await session.start()
  await session.invite({ name: 'ana', role: 'member' })
  assert.deepEqual(copied, [])
  assert.match(errors.join(' '), /could not invite ana/)
})

test('publishing without devtunnel installed says how to get it and changes nothing', async () => {
  const { session, started, errors } = harness({ detectTunnel: () => false })
  await session.start()
  await session.republish(true)
  assert.equal(session.isPublished(), false)
  assert.equal(started.filter(s => s.name === 'tunnel').length, 0)
  assert.match(errors.join(' '), /winget install --id Microsoft\.devtunnel/)
})

test('publishing starts the tunnel and restarts the room on the same port and state dir', async () => {
  // Same port and same state dir is what keeps the owner token, the roster and
  // http://127.0.0.1:<port> alive across the restart.
  const { session, started } = harness()
  await session.start()
  await session.republish(true)
  const tunnel = started.find(s => s.name === 'tunnel')
  const rooms = started.filter(s => s.name === 'room')
  assert.deepEqual(tunnel.recipe.args, ['host', '-p', '51820', '--allow-anonymous'])
  assert.equal(rooms.length, 2)
  assert.equal(rooms[1].recipe.opts.env.ROOM_HOST, '0.0.0.0')
  assert.equal(rooms[1].recipe.opts.env.ROOM_PORT, '51820')
  assert.equal(rooms[1].recipe.opts.env.ROOM_STATE_DIR, '/state')
  assert.equal(rooms[1].recipe.opts.env.ROOM_ADVERTISE, 'https://abc-1234.inc1.devtunnels.ms')
  assert.equal(session.isPublished(), true)
})

test('a tunnel that never prints a URL is stopped rather than left hosting blind', async () => {
  const { session, stopped, errors } = harness({
    supervisor: { status: () => ({ output: 'Connecting...\n' }) },
  })
  await session.start()
  await session.republish(true)
  assert.ok(stopped.includes('tunnel'))
  assert.equal(session.isPublished(), false)
  assert.match(errors.join(' '), /devtunnel user login/)
})

test('stop sharing stops the tunnel and rebinds the room to loopback', async () => {
  const { session, started, stopped } = harness()
  await session.start()
  await session.republish(true)
  await session.republish(false)
  assert.ok(stopped.includes('tunnel'))
  assert.equal(started.filter(s => s.name === 'room').at(-1).recipe.opts.env.ROOM_HOST, '127.0.0.1')
  assert.equal(session.isPublished(), false)
})

test('the busy state is announced before the restart, so no click lands twice', async () => {
  const { session } = harness()
  const rooms = []
  await session.start()
  session.onRoom(r => rooms.push(r))
  await session.republish(true)
  assert.equal(rooms[0].busy, true)
  assert.equal(rooms.at(-1).busy, false)
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd extension && node --test test/session.test.js
```

Expected: `Error: Cannot find module '../src/session.js'`.

- [ ] **Step 3: Write `session.js`**

Create `extension/src/session.js`:

```javascript
// extension/src/session.js
//
// The room session: the room process, its owner token, the one SSE
// subscription, the worker fleet, and the publish/invite controls.
//
// All of this used to be closures inside extension.js's openChat(), which meant
// the room only existed while a chat window was open -- and the sidebar, which
// registers at activation, had nothing to show. The chat is optional now
// (spec §4), so this owns the lifetime and the chat attaches to it.
//
// Nothing here requires the `vscode` module. The two things that genuinely do
// -- a dialog and the clipboard -- arrive as `ui`, which is what makes every
// line below testable without an extension host.
'use strict'
const net = require('node:net')

const { roomRecipe, readOwnerToken, createRoomClient, PUBLISHED_HOST } = require('./room-client.js')
const { detectDevtunnel, tunnelRecipe, parseTunnelUrl } = require('./tunnel.js')
const { createEventRouter } = require('./events.js')
const { createWorkerPool } = require('./workers.js')

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Binds 127.0.0.1:0 and releases it, so the room gets a port nothing else is using. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}

/**
 * Reads Server-Sent Events by hand off a fetch Response's streaming body.
 *
 * Deliberately NOT `src/seat.mjs`'s `readFrames`, even though the shape is
 * identical: `src/seat.mjs` is ESM and this extension is CommonJS. This is the
 * same ~20 lines, duplicated on purpose: do not "fix" this by reaching across
 * the module-system boundary.
 *
 * Frames are separated by a blank line; only `event:`/`data:` lines matter, so
 * a bare `: comment` keep-alive is silently skipped.
 */
async function readEventStream(body, onFrame) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = null
      let data = null
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length)
        else if (line.startsWith('data: ')) data = line.slice('data: '.length)
      }
      if (data !== null) onFrame(event, data)
    }
  }
}

/**
 * One SSE subscription to the room's event feed, fanned out through `router`.
 * Reconnects on any drop with a fixed delay -- the feed matters for as long as
 * the session lives, so a dropped connection is worth retrying.
 *
 * @returns {() => void} stop -- aborts the subscription and any pending retry.
 */
function subscribeToRoomEvents(roomClient, router, { fetchImpl, sleep }) {
  let stopped = false
  let controller = null

  async function connectOnce() {
    controller = new AbortController()
    try {
      const res = await fetchImpl(
        `${roomClient.roomUrl}/events?token=${encodeURIComponent(roomClient.token)}`,
        { signal: controller.signal },
      )
      if (!res.ok || !res.body) throw new Error(`room events feed failed: HTTP ${res.status}`)
      await readEventStream(res.body, (event, raw) => {
        if (!event) return // the room always sends event:; only OpenCode's raw feed omits it
        let data
        try { data = JSON.parse(raw) } catch { return } // a malformed frame must not kill the feed
        router.handle(event, data)
      })
    } catch {
      // Aborted by stop(), a network error, or a bad response -- every case is
      // handled the same way below: try again unless told to stop.
    }
  }

  ;(async () => {
    while (!stopped) {
      await connectOnce()
      if (stopped) return
      await sleep(1000)
    }
  })()

  return () => {
    stopped = true
    controller?.abort()
  }
}

/** Polls `fn` with exponential backoff until it returns truthy or `timeoutMs` elapses. */
async function pollWithBackoff(fn, { timeoutMs = 10_000, startMs = 150, maxMs = 1000, sleep = realSleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs
  let delay = startMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (now() >= deadline) return null
    await sleep(delay)
    delay = Math.min(delay * 2, maxMs)
  }
}

/**
 * @param {{repoRoot: string, stateDir: string, supervisor: object,
 *          ui: {showError: Function, showInfo: Function, copy: Function},
 *          log?: Function, fetchImpl?: Function, pickPort?: Function,
 *          readToken?: Function, detectTunnel?: Function,
 *          sleep?: Function, now?: () => number}} deps
 */
function createSession({
  repoRoot,
  stateDir,
  supervisor,
  ui,
  log = () => {},
  fetchImpl = (...args) => fetch(...args),
  pickPort = pickFreePort,
  readToken = readOwnerToken,
  detectTunnel = detectDevtunnel,
  sleep = realSleep,
  now = Date.now,
}) {
  const roomListeners = new Set()
  const workerListeners = new Set()
  const activityListeners = new Set()
  const resultListeners = new Set()

  const emit = (set, ...args) => {
    for (const fn of set) {
      try { fn(...args) } catch { /* a listener must not take the session down */ }
    }
  }
  const listen = (set, fn) => { set.add(fn); return () => set.delete(fn) }

  let port = null
  let stopFeed = null
  let published = false

  /**
   * Waits for the room's HTTP server to be listening at all. Any response --
   * even the 401 an unauthenticated /api/state gets -- proves the process is
   * up; the token wait below is what waits for it to finish booting.
   */
  async function waitForRoomUp(roomUrl) {
    const ok = await pollWithBackoff(async () => {
      try {
        await fetchImpl(`${roomUrl}/api/state`)
        return true
      } catch {
        return false
      }
    }, { sleep, now })
    if (!ok) throw new Error('the room did not start listening within 10s')
  }

  /**
   * readOwnerToken returns null until the room has written its roster -- absent
   * on the very first boot. Fail loudly rather than hanging forever.
   */
  async function waitForOwnerToken() {
    const token = await pollWithBackoff(() => readToken(stateDir), { sleep, now })
    if (!token) throw new Error('the room did not write its owner token within 10s')
    return token
  }

  async function start() {
    if (api.roomClient) return { ok: true, roomUrl: api.roomUrl, token: api.token }

    try {
      port = await pickPort()
    } catch (err) {
      return { ok: false, error: `could not find a free port: ${err?.message ?? err}` }
    }
    const roomUrl = `http://127.0.0.1:${port}`
    supervisor.start('room', roomRecipe({ repoRoot, stateDir, port }))

    let token
    try {
      await waitForRoomUp(roomUrl)
      token = await waitForOwnerToken()
    } catch (err) {
      supervisor.stop('room')
      return { ok: false, error: err?.message ?? String(err) }
    }

    const roomClient = createRoomClient({ roomUrl, token, fetchImpl })
    const pool = createWorkerPool({ roomClient, log, now })
    pool.onChange(list => emit(workerListeners, list))

    // One SSE subscription, fanned out by the router: worker activity to
    // whoever is showing it, a finished delegation to whoever relays it, and
    // every frame to the pool. One subscription is one ordering, which is what
    // keeps a worker's reply from arriving before the work that produced it.
    const router = createEventRouter({
      onWorkerActivity: a => emit(activityListeners, a),
      onDelegationResult: d => emit(resultListeners, d),
      onRoomEvent: (event, data) => pool.applyRoomEvent(event, data),
    })
    stopFeed = subscribeToRoomEvents(roomClient, router, { fetchImpl, sleep })

    api.roomUrl = roomUrl
    api.token = token
    api.roomClient = roomClient
    api.pool = pool
    return { ok: true, roomUrl, token }
  }

  /** Everything a room surface renders, in one message. */
  async function postRoom(extra = {}) {
    const state = await api.roomClient?.adminState()
    emit(roomListeners, {
      published,
      // Taken from a join link rather than recomputed here: the room is the
      // only thing that knows which address it decided to advertise.
      advertised: state?.members?.[0]?.joinUrl ?? null,
      // null adminState means the call failed, not that the room is empty --
      // so send null and let the surface say it does not know.
      members: state
        ? state.members.map(m => ({ id: m.id, name: m.name, role: m.role }))
        : null,
      ...extra,
    })
  }

  /**
   * Publishing rebinds; it does not tear down. The room restarts with a
   * different bind address on the SAME port and state dir, so the owner token,
   * the roster and http://127.0.0.1:<port> all survive and the SSE feed
   * reconnects on its own existing retry loop.
   */
  async function republish(next) {
    emit(roomListeners, { busy: true, published })
    try {
      if (next) {
        if (!detectTunnel()) {
          ui.showError(
            'Claude Room: the devtunnel CLI is not installed. Run: winget install --id Microsoft.devtunnel -e, then devtunnel user login, then try Publish again.',
          )
          await postRoom({ busy: false })
          return
        }
        supervisor.start('tunnel', tunnelRecipe({ port }))
        // The CLI prints its URL once, on stdout, then keeps running -- poll the
        // supervisor's own stdout buffer rather than re-parenting a second reader.
        const tunnelUrl = await pollWithBackoff(
          () => parseTunnelUrl(supervisor.status('tunnel').output ?? ''),
          { sleep, now },
        )
        if (!tunnelUrl) {
          ui.showError('Claude Room: devtunnel did not report a URL within 10s. Is `devtunnel user login` done?')
          supervisor.stop('tunnel')
          await postRoom({ busy: false })
          return
        }
        supervisor.start('room', roomRecipe({ repoRoot, stateDir, port, host: PUBLISHED_HOST, advertise: tunnelUrl }))
      } else {
        supervisor.stop('tunnel')
        supervisor.start('room', roomRecipe({ repoRoot, stateDir, port, host: '127.0.0.1' }))
      }
      await waitForRoomUp(api.roomUrl)
      published = next
    } catch (err) {
      // The room not coming back is the one failure here that matters, and it
      // must not be silent.
      ui.showError(`Claude Room: the room did not restart — ${err?.message ?? err}`)
      log(`republish failed: ${err?.stack ?? err}`)
    }
    await postRoom({ busy: false })
  }

  async function invite({ name, role = 'member' }) {
    const r = await api.roomClient.invite({ name, role })
    if (!r?.ok) {
      ui.showError(`Claude Room: could not invite ${name} — ${r?.errors?.[0] ?? 'unknown error'}`)
      return
    }
    // The token IS the identity, so it goes to the clipboard rather than to any
    // surface, where it would be visible to anyone reading over a shoulder.
    await ui.copy(r.joinUrl)
    ui.showInfo(`Claude Room: join link for ${name} copied to the clipboard.`)
    await postRoom()
  }

  /** Ends the SSE subscription. The room child is the supervisor's to stop. */
  function stop() {
    stopFeed?.()
    stopFeed = null
  }

  const api = {
    roomUrl: null,
    token: null,
    roomClient: null,
    pool: null,
    start,
    stop,
    postRoom,
    republish,
    invite,
    isPublished: () => published,
    onRoom: fn => listen(roomListeners, fn),
    onWorkers: fn => listen(workerListeners, fn),
    onActivity: fn => listen(activityListeners, fn),
    onDelegationResult: fn => listen(resultListeners, fn),
  }
  return api
}

module.exports = { createSession, pickFreePort }
```

- [ ] **Step 4: Run them and watch them pass**

```bash
cd extension && node --test
```

Expected: 292 tests, 291 pass, 0 fail, 1 skipped. Nothing outside `session.test.js` changes — `extension.js` still runs its own copies.

- [ ] **Step 5: Commit**

```bash
git add extension/src/session.js extension/test/session.test.js
git commit -m "feat(extension): a room session that does not need a chat window" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `openChat()` consumes the session, and the originals are deleted

**Files:**
- Modify: `extension/src/extension.js` — delete `readEventStream` (118-139), `subscribeToRoomEvents` (149-185), `pickFreePort` (188-197), `pollWithBackoff` (200-210), `waitForRoomUp` (218-228), `waitForOwnerToken` (235-239), and inside `openChat` the port/room/token block (253-276), the `createRoomClient`/`createWorkerPool` block (387-391), the router+feed (427-434), `postRoom` (445-460), `republish` (462-499) and `invite` (501-513); add the `ui` adapter and an `ensureSession` helper
- Test: none. **This file needs the real `vscode` module and cannot be unit tested** — it is covered by the manual check below and by Task 12's walkthrough.

**Interfaces:**
- Consumes: `createSession` (Task 4).
- Produces: a module-level `roomSession` and `ensureSession(context)`; `openChat` now only starts the orchestrator and opens the webview.

- [ ] **Step 1: Add the session plumbing to `extension.js`**

Replace the require block's last lines (after line 26) by adding:

```javascript
const { createSession } = require('./session.js')
```

and replace the module state (lines 34-38) with:

```javascript
let supervisor = null
let output = null
let roomSession = null // the room, its feed and its fleet — outlives any chat
let chat = null // { panel } — the live chat session, if one is open
let activeWorkersView = null // the sidebar, which outlives any session
let activeOpenWorker = null // opens a worker's tab, once a chat exists
```

Then add, below `log` (line 42):

```javascript
/**
 * The two things session.js genuinely needs VS Code for. Passing them in is
 * what keeps every other line of that file testable outside an extension host.
 */
const vscodeUi = {
  showError: m => vscode.window.showErrorMessage(m),
  showInfo: m => vscode.window.showInformationMessage(m),
  copy: t => vscode.env.clipboard.writeText(t),
}

/**
 * The room, started once and shared. Returns null (having already said why)
 * when it could not start, so every caller can simply check.
 */
async function ensureSession(context) {
  if (roomSession) return roomSession
  const storageDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath
  const stateDir = path.join(storageDir, 'room-state')
  fs.mkdirSync(stateDir, { recursive: true })

  const s = createSession({ repoRoot: REPO_ROOT, stateDir, supervisor, ui: vscodeUi, log })
  const started = await s.start()
  if (!started.ok) {
    vscode.window.showErrorMessage(`Claude Room: ${started.error}`)
    return null
  }
  roomSession = s
  s.onWorkers(list => activeWorkersView?.postWorkers(list))
  return s
}
```

Rename every remaining `session?.` reference that means *the chat* to `chat?.` — lines 53, 58 (the supervisor `exit` handler), 65, 67 (the Workers view callbacks), 90-92 (`deactivate`), 96-98 (`restart`), 242-244, 424, 534, 557, 560. The `exit` handler becomes:

```javascript
  supervisor.on('exit', ({ name, code }) => {
    log(`${name} exited unexpectedly (code ${code ?? 'unknown'})`)
    chat?.panel.postFatal(
      `${name} exited unexpectedly (code ${code ?? 'unknown'}). Run "Claude Room: Restart Services" to continue.`,
    )
    // The room dying takes the SSE feed with it; stop reconnecting against a
    // process that is not coming back on its own.
    if (name === 'room') roomSession?.stop()
  })
```

and `deactivate` / `restart`:

```javascript
function deactivate() {
  roomSession?.stop()
  roomSession = null
  chat = null
  supervisor?.stopAll()
}

async function restart(context) {
  roomSession?.stop()
  roomSession = null
  chat = null
  supervisor.stopAll()
  if (await ensureSession(context)) await openChat(context)
}
```

- [ ] **Step 2: Rewrite `openChat` to attach to the session**

Replace `extension/src/extension.js` lines 241-276 (the top of `openChat` through the token block) with:

```javascript
async function openChat(context) {
  if (chat) {
    chat.panel.reveal()
    return
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]
  if (!workspace) {
    vscode.window.showErrorMessage('Claude Room: open a folder before starting a chat.')
    return
  }

  const session = await ensureSession(context)
  if (!session) return
  const { roomUrl, token, roomClient, pool } = session
  const storageDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath
  const stateDir = path.join(storageDir, 'room-state')
```

Delete lines 387-391 (`createRoomClient`, the pool comment and `createWorkerPool`) — both now come from the session. Replace the router and feed (lines 427-434) with:

```javascript
  // The session holds the one subscription; the chat just asks to hear from it.
  const offActivity = session.onActivity(a => panel.postActivity(a))
  const offResults = session.onDelegationResult(d => orchestrator.relay(d))
```

Delete `postRoom` (445-460), `republish` (462-499) and `invite` (501-513) in full, along with the `let published = false` on line 443 and the `--- the room chip and the permission chip ---` comment block (436-442), which now describes only the permission chip:

```javascript
  // --- the permission chip ----------------------------------------------
  //
  // Changing the permission mode restarts the ORCHESTRATOR with
  // --permission-mode and --resume. It does not tear down the chat.
```

Rewire the control handler (542-547) and the dispose handler:

```javascript
  panel.onControl(async msg => {
    if (msg.type === 'permission-mode') return setPermissionMode(String(msg.mode ?? ''))
  })

  panel.postPermissionMode(permissionMode)

  panel.onDidDispose(() => {
    offActivity()
    offResults()
    // The room, the feed and the fleet all belong to the session and keep
    // running: the sidebar is the front door, not this window.
    if (chat?.panel === panel) chat = null
  })

  chat = { panel, orchestrator, roomUrl, token, stateDir, pool }
```

Also update the `pool.onChange` block (416-422) to use the session's listener, since the pool's own `onChange` is already wired to `activeWorkersView` in `ensureSession`:

```javascript
  const offWorkers = session.onWorkers(list => {
    panel.postWorkers(list)
    // A worker whose tab is open sees every change, not only the ones that
    // happen to arrive while it is focused.
    for (const handle of workerPanels.keys()) pushWorker(handle)
  })
```

and call `offWorkers()` in the dispose handler alongside `offActivity()`.

- [ ] **Step 3: Confirm nothing else referenced the deleted helpers**

```bash
cd extension && grep -n "pollWithBackoff\|waitForRoomUp\|waitForOwnerToken\|pickFreePort\|readEventStream\|subscribeToRoomEvents\|detectDevtunnel\|PUBLISHED_HOST\|tunnelRecipe\|parseTunnelUrl\|createEventRouter\|createRoomClient" src/extension.js
```

Expected: **no output**. If anything prints, it is a leftover reference; delete it (and its now-unused `require`) before continuing. `extension.js`'s requires should keep only: `vscode`, `node:path`, `node:fs`, `node:crypto`, `node:os`, `createSupervisor`, `orchestratorRecipe`/`bridgeMcpConfig`/`createOrchestrator`, `createChatPanel`, `discoverSkills`, `saveAttachment`, `isKnownMode`/`DEFAULT_MODE`, `createWorkersView`, `createWorkerPanel`, `createSession`. Remove `node:net` and the `room-client.js`, `tunnel.js`, `events.js`, `workers.js` requires.

- [ ] **Step 4: Run the suite and the parse check**

```bash
cd extension && node --check src/extension.js && node --test
```

Expected: `node --check` silent, then 292 tests, 291 pass, 0 fail, 1 skipped.

- [ ] **Step 5: Manual check (this file cannot be unit tested)**

Press **F5** from the repo root with a folder open. Run **"Claude Room: Open Orchestrator Chat"**. Confirm: the chat opens, the "Claude Room" output channel shows no `room did not start` error, a message streams back, and the Workers sidebar still lists a worker after the first turn. Note the result; Task 12 records it in the README.

- [ ] **Step 6: Commit**

```bash
git add extension/src/extension.js
git commit -m "refactor(extension): openChat attaches to the room session instead of owning it" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `published` reflects what actually happened

**Files:**
- Modify: `extension/src/session.js` — the `catch` in `republish`
- Test: `extension/test/session.test.js` (append)

Spec §6: `republish()` never reset `published` when a room restart failed, so it could stay `true` after the room did not come back — and after **Stop sharing** failed, when the tunnel really had stopped. The state must come from the outcome, not the intent.

**Interfaces:** unchanged. `isPublished()` and the `published` field of every `onRoom` message become truthful after a failure.

- [ ] **Step 1: Write the failing tests**

Append to `extension/test/session.test.js`:

```javascript

// --- published state comes from the outcome, never from the intent ---------

/** A harness whose room never comes back after the publish restart. */
function deadRoomHarness() {
  let up = true
  return {
    ...harness({
      fetchImpl: async url => {
        if (String(url).includes('/api/state') && !up) throw new Error('ECONNREFUSED')
        if (String(url).includes('/events')) return { ok: true, status: 200, body: sseBody([]) }
        return { ok: true, status: 200, json: async () => ({}) }
      },
    }),
    kill: () => { up = false },
  }
}

test('a publish whose room never comes back is not reported as published', async () => {
  // Reporting "published" for a room that is not serving tells the owner their
  // work is shared when nothing is reachable at all.
  const h = deadRoomHarness()
  await h.session.start()
  h.kill()
  await h.session.republish(true)
  assert.equal(h.session.isPublished(), false)
  assert.match(h.errors.join(' '), /did not restart/)
})

test('a failed publish stops the tunnel it started, so nothing points at a dead port', async () => {
  const h = deadRoomHarness()
  await h.session.start()
  h.kill()
  await h.session.republish(true)
  assert.ok(h.stopped.includes('tunnel'))
})

test('a failed stop-sharing reports local, because the tunnel really did stop', async () => {
  // The tunnel is down whatever the room did next. Staying "published" here is
  // the exact lie this fix exists to remove.
  const h = deadRoomHarness()
  await h.session.start()
  await h.session.republish(true)
  assert.equal(h.session.isPublished(), true)
  h.kill()
  await h.session.republish(false)
  assert.equal(h.session.isPublished(), false)
})

test('the failure is reported to listeners too, not only to the dialog', async () => {
  const h = deadRoomHarness()
  await h.session.start()
  const rooms = []
  h.session.onRoom(r => rooms.push(r))
  h.kill()
  await h.session.republish(true)
  assert.equal(rooms.at(-1).published, false)
  assert.equal(rooms.at(-1).busy, false)
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd extension && node --test test/session.test.js
```

Expected: `'a failed stop-sharing reports local…'` fails with `true !== false`, and `'a failed publish stops the tunnel…'` fails because the tunnel is left running.

- [ ] **Step 3: Set the state from the outcome**

In `extension/src/session.js`, replace the `catch` block of `republish` with:

```javascript
    } catch (err) {
      // State from what actually happened, not from what was asked for. A
      // failed publish leaves a tunnel pointing at a room that is not serving,
      // so it is stopped; a failed stop-sharing has still stopped the tunnel.
      // Either way sharing is not working, and saying "published" would be a
      // confident lie about who can reach this room.
      if (next) supervisor.stop('tunnel')
      published = false
      ui.showError(`Claude Room: the room did not restart — ${err?.message ?? err}`)
      log(`republish failed: ${err?.stack ?? err}`)
    }
```

- [ ] **Step 4: Run the suite**

```bash
cd extension && node --test
```

Expected: 296 tests, 295 pass, 0 fail, 1 skipped. The Task 4 publish/stop-sharing cases still pass — the success paths are unchanged.

- [ ] **Step 5: Commit**

```bash
git add extension/src/session.js extension/test/session.test.js
git commit -m "fix(extension): report the room as local when a republish did not come back" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: the `claudeRoom.room` sidebar view

**Files:**
- Create: `extension/src/chat/room.html`, `extension/src/chat/room-webview.js`, `extension/src/chat/room-view.js`
- Modify: `extension/src/chat/webview.css` (append one 5-line rule beside the sidebar block at line 742)
- Modify: `extension/package.json` (`contributes.views.claudeRoom`, lines 37-45)
- Modify: `extension/test/harness-fixtures.test.js` line 17 — `HOST_FILES` gains `'room-view.js'`. This is the test's own contract list ("these files define the protocol between the extension host and its webviews"); there are four webviews now, so the list has four entries. No assertion is weakened: the check still derives what a fixture may contain from source.
- Test: `extension/test/room-view-boot.test.js` (new)

**Interfaces:**
- Consumes: `window.ClaudeIcons.icon` (`icons.js:71`); the `{type:'room', room:{published, advertised, members, busy}}` message the session's `onRoom` produces.
- Produces: `createRoomView({ context, onPublish, onInvite, onRefresh }) -> { provider, postRoom }`, mirroring `createWorkersView` (`workers-view.js:25`); webview → host messages `{type:'publish', published}`, `{type:'invite', role}`, `{type:'room-refresh'}`.

- [ ] **Step 1: Write the failing tests**

Create `extension/test/room-view-boot.test.js`:

```javascript
// extension/test/room-view-boot.test.js
//
// Does room-webview.js survive to the end and wire its controls?
//
// The same smoke test webview-boot.test.js runs for the chat, for the same
// reason: a script that throws on its first line leaves a view that looks
// present and does nothing. The fake DOM is duplicated rather than shared,
// because webview-boot.test.js guards a real historical bug and is not worth
// refactoring to make this file shorter.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const CHAT = join(__dirname, '..', 'src', 'chat')

function fakeElement(id) {
  const listeners = new Map()
  return {
    id,
    textContent: '',
    hidden: false,
    disabled: false,
    className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    listeners,
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
    },
    appendChild(c) { this.children.push(c); return c },
    setAttribute() {},
    removeAttribute() {},
  }
}

function bootRoomView() {
  const elements = new Map()
  const get = id => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  const document = {
    getElementById: get,
    createElement: tag => fakeElement(tag),
    // icons.js builds real <svg> nodes in the SVG namespace.
    createElementNS: (ns, tag) => Object.assign(fakeElement(tag), { ns }),
    body: fakeElement('body'),
    addEventListener() {},
  }
  const msgHandlers = {}
  const window = {
    addEventListener: (ev, fn) => { (msgHandlers[ev] = msgHandlers[ev] || []).push(fn) },
    document,
  }
  const posted = []
  const sandbox = {
    window,
    document,
    console,
    acquireVsCodeApi: () => ({ postMessage: m => posted.push(m), getState: () => null, setState() {} }),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  for (const f of ['icons.js', 'room-webview.js']) {
    vm.runInContext(readFileSync(join(CHAT, f), 'utf8'), sandbox, { filename: f })
  }
  return {
    get,
    posted,
    handleMessage: msg => (msgHandlers.message || []).forEach(fn => fn(msg)),
    fire: (el, ev, arg = {}) => (el.listeners.get(ev) || []).forEach(fn => fn(arg)),
  }
}

const roomMsg = room => ({ data: { type: 'room', room } })

test('room-webview.js runs to completion instead of dying on a missing global', () => {
  assert.doesNotThrow(() => bootRoomView())
})

test('a revealed view asks the host for the current room rather than waiting', () => {
  // A WebviewView is destroyed and rebuilt whenever the sidebar is collapsed
  // and reopened. Waiting for the next change means waiting forever.
  const boot = bootRoomView()
  assert.ok(boot.posted.some(m => m.type === 'room-refresh'))
})

test('publishing asks the host, naming the state being moved to', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  boot.fire(boot.get('publish-btn'), 'click')
  assert.ok(boot.posted.some(m => m.type === 'publish' && m.published === true))
})

test('the button says what it will do, so Stop sharing is never a guess', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: true, advertised: 'https://x-1.devtunnels.ms/?token=T', members: [] }))
  assert.match(boot.get('publish-btn').textContent, /Stop sharing/)
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  assert.match(boot.get('publish-btn').textContent, /Publish with Dev Tunnels/)
})

test('a restart in progress disables the button rather than queueing a second one', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ busy: true, published: false }))
  assert.equal(boot.get('publish-btn').disabled, true)
})

test('the room reports its state in words, not only by colour', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: true, advertised: 'https://x-1.devtunnels.ms/?token=T', members: [] }))
  assert.match(JSON.stringify(boot.get('room-state')), /published/)
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  assert.match(JSON.stringify(boot.get('room-state')), /local only/)
})

test('a join token never reaches the view, only the host part does', () => {
  // The token IS the identity. It goes to the clipboard, never on screen.
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({
    published: true, advertised: 'https://abc-1234.inc1.devtunnels.ms/?token=SECRETTOKEN', members: [],
  }))
  const rendered = JSON.stringify([boot.get('room-address'), boot.get('room-state'), boot.get('room-summary')])
  assert.ok(!rendered.includes('SECRETTOKEN'), 'the token must not be rendered anywhere')
  assert.ok(rendered.includes('abc-1234.inc1.devtunnels.ms'), 'the address itself should be shown')
})

test('the local address is shown before publishing, because it is the whole decision', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  assert.match(boot.get('room-address').textContent, /127\.0\.0\.1/)
})

test('a failed roster says so rather than claiming the room is empty', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: null }))
  assert.match(JSON.stringify(boot.get('room-members')), /could not read the roster/)
})

test('a member name is rendered as text, never as markup', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [
    { id: '1', name: '<img src=x onerror=alert(1)>', role: 'member' },
  ] }))
  assert.ok(JSON.stringify(boot.get('room-members')).includes('<img src=x onerror=alert(1)>'),
    'the name must survive as literal text')
})

test('the live region says something, not a number', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [
    { id: '1', name: 'you', role: 'owner' },
    { id: '2', name: 'ana', role: 'member' },
  ] }))
  assert.match(boot.get('room-summary').textContent, /local only · 2 members/)
})

test('inviting asks the host, because a webview cannot show a native prompt', () => {
  const boot = bootRoomView()
  boot.fire(boot.get('invite-btn'), 'click')
  assert.ok(boot.posted.some(m => m.type === 'invite'))
})

test('room-view.js substitutes a uri for every script tag room.html declares', () => {
  // A `{{fooUri}}` the provider never substitutes reaches the browser verbatim
  // as a src, which loads nothing and takes the view's globals down with it.
  const html = readFileSync(join(CHAT, 'room.html'), 'utf8')
  const provider = readFileSync(join(CHAT, 'room-view.js'), 'utf8')
  for (const [, name] of html.matchAll(/src="\{\{(\w+)Uri\}\}"/g)) {
    assert.ok(provider.includes(`{{${name}Uri}}`), `room.html loads {{${name}Uri}}, but room-view.js never substitutes it`)
  }
})

test('room.html carries the same strict CSP every other webview does', () => {
  const html = readFileSync(join(CHAT, 'room.html'), 'utf8')
  assert.match(html, /default-src 'none'/)
  assert.match(html, /script-src 'nonce-\{\{nonce\}\}'/)
  for (const [, tag] of html.matchAll(/<script([^>]*)>/g)) {
    assert.match(tag, /nonce="\{\{nonce\}\}"/, 'every script tag needs the nonce')
  }
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd extension && node --test test/room-view-boot.test.js
```

Expected: every case fails with `ENOENT: no such file or directory, open '…/src/chat/room-webview.js'`.

- [ ] **Step 3: Write `room.html`**

Create `extension/src/chat/room.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!--
  Same strict CSP as every other webview, and for the same reason: the
  advertised address and every member name come from the room over HTTP, and a
  member name is typed by a person. All of it is rendered with textContent.
-->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src {{cspSource}}; style-src {{cspSource}}; font-src {{cspSource}}; script-src 'nonce-{{nonce}}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="{{styleUri}}">
<title>Room</title>
</head>
<body class="sidebar">
  <div class="side-head">
    <span class="panel-title">Room</span>
    <!-- An icon AND the state word: colour alone is not something everyone
         can read, and a lone dot says nothing to a screen reader. -->
    <span id="room-state" class="panel-total side-state"></span>
  </div>
  <!--
    One atomic status region for the whole view, announcing something
    meaningful ("Room local only · 2 members") rather than a bare number.
  -->
  <div id="room-summary" class="side-summary" role="status" aria-atomic="true"></div>
  <button id="publish-btn" class="wide-btn" type="button"></button>
  <div id="room-address" class="room-address"></div>
  <div id="room-note" class="room-note"></div>
  <div class="panel-sep"></div>
  <div class="panel-title">Members</div>
  <div id="room-members" class="room-members"></div>
  <button id="invite-btn" class="wide-btn" type="button">Invite…</button>
  <script nonce="{{nonce}}" src="{{iconsUri}}"></script>
  <script nonce="{{nonce}}" src="{{scriptUri}}"></script>
</body>
</html>
```

- [ ] **Step 4: Write `room-webview.js`**

Create `extension/src/chat/room-webview.js`:

```javascript
// extension/src/chat/room-webview.js
//
// The Room sidebar, inside the webview's sandboxed context.
//
// Moved out of the chat's Room popover (webview.js) when the chat went dormant:
// publishing and inviting are the product's front door, not a chat feature.
//
// The advertised address and every member name arrive from the room over HTTP,
// and a member name is typed by a person -- all of it goes through textContent,
// never innerHTML. One IIFE, nothing top-level: <script> tags share one global
// scope with icons.js.
'use strict'
;(function () {
  const vscode = acquireVsCodeApi()
  const { icon } = window.ClaudeIcons

  const stateEl = document.getElementById('room-state')
  const summaryEl = document.getElementById('room-summary')
  const publishEl = document.getElementById('publish-btn')
  const addressEl = document.getElementById('room-address')
  const noteEl = document.getElementById('room-note')
  const membersEl = document.getElementById('room-members')
  const inviteEl = document.getElementById('invite-btn')

  let room = { published: false, advertised: null, members: null, busy: false }

  /** The host part of a join link, which is what "published to" actually means. */
  function hostOf(joinUrl) {
    if (!joinUrl) return null
    // Deliberately not `new URL(...).host`: the link carries a token in its
    // query string, and nothing here should be one slip away from rendering it.
    const m = /^https?:\/\/([^/?#]+)/.exec(String(joinUrl))
    return m ? m[1] : null
  }

  function summarise(where) {
    const state = room.busy
      ? 'Room restarting'
      : room.published
        ? `Room published to ${where ?? 'an unknown address'}`
        : 'Room local only'
    if (room.members === null) return `${state} · roster unavailable`
    const n = room.members.length
    return `${state} · ${n} member${n === 1 ? '' : 's'}`
  }

  function render() {
    const where = hostOf(room.advertised)

    // The state word, with a shape beside it. `radio` broadcasts; `circle-dot`
    // sits still. Both are decorative -- the word carries the fact.
    stateEl.textContent = ''
    stateEl.appendChild(icon(room.published ? 'radio' : 'circle-dot', document))
    const word = document.createElement('span')
    word.textContent = room.busy ? 'restarting…' : room.published ? 'published' : 'local only'
    stateEl.appendChild(word)

    publishEl.textContent = room.published ? 'Stop sharing' : 'Publish with Dev Tunnels'
    publishEl.disabled = !!room.busy

    // The address is the whole decision: publishing to a devtunnels.ms URL
    // means something very different from staying on loopback, and this is what
    // tells them apart. Shown for both states so it is legible BEFORE the
    // button is pressed, not only after.
    addressEl.textContent = room.published
      ? (where ?? 'address unknown')
      : '127.0.0.1 — reachable only from this machine'
    noteEl.textContent = room.busy
      ? 'Restarting the room…'
      : 'Restarts the room (about a second). Anything already connected reconnects.'

    summaryEl.textContent = summarise(where)

    membersEl.textContent = ''
    if (room.members === null) {
      // null means the roster call FAILED. Saying "nobody is here" would be a
      // confident lie about who can read the room.
      const unknown = document.createElement('div')
      unknown.className = 'room-member muted'
      unknown.textContent = room.busy ? 'checking…' : 'could not read the roster'
      membersEl.appendChild(unknown)
      return
    }
    for (const m of room.members) {
      const row = document.createElement('div')
      row.className = 'room-member'
      const name = document.createElement('span')
      // A member name is typed by a person and arrives over HTTP. textContent.
      name.textContent = m.name
      const role = document.createElement('span')
      role.className = 'room-role'
      role.textContent = m.role
      row.appendChild(name)
      row.appendChild(role)
      membersEl.appendChild(row)
    }
  }

  publishEl.addEventListener('click', () => {
    if (room.busy) return
    vscode.postMessage({ type: 'publish', published: !room.published })
  })

  inviteEl.addEventListener('click', () => {
    // The host owns the prompt: a webview cannot show a native input box, and a
    // bespoke one here would be a worse version of one VS Code already has.
    vscode.postMessage({ type: 'invite', role: 'member' })
  })

  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'room') {
      // Merged, not replaced: republish posts a partial `{busy}` and the roster
      // it was already showing must not blink out for the duration.
      room = { ...room, ...msg.room }
      render()
    }
  })

  // The script owns its own initial state rather than inheriting it from the
  // markup, and a revealed view asks for the current room rather than waiting
  // for a change that might never come.
  render()
  vscode.postMessage({ type: 'room-refresh' })
})()
```

- [ ] **Step 5: Write `room-view.js`**

Create `extension/src/chat/room-view.js`:

```javascript
// extension/src/chat/room-view.js
//
// The Room sidebar view.
//
// Built exactly like chat/workers-view.js -- a WebviewView so it shares the
// chat's stylesheet, its icons and its row formatting, rather than a TreeView
// that could render none of them. Its own view rather than a header inside
// Workers: each view keeps one purpose.
//
// This file and workers-view.js are the only places besides chat/panel.js that
// touch the VS Code webview API; everything it renders lives in
// room-webview.js, inside the webview's own sandbox.
'use strict'
const vscode = require('vscode')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

const nonce = () => randomBytes(16).toString('base64')

/**
 * @param {{context: object, onPublish: Function, onInvite: Function, onRefresh: Function}} deps
 * @returns {{provider: object, postRoom: Function}}
 */
function createRoomView({ context, onPublish, onInvite, onRefresh }) {
  const extensionRoot = context.extensionUri?.fsPath ?? context.extensionPath
  const chatDir = join(extensionRoot, 'src', 'chat')

  let view = null
  /** The last room state posted, replayed when the view is revealed again. */
  let last = { published: false, advertised: null, members: null, busy: false }

  function html(webview) {
    const uri = f => String(webview.asWebviewUri(vscode.Uri.file(join(chatDir, f))))
    const n = nonce()
    return readFileSync(join(chatDir, 'room.html'), 'utf8')
      .split('{{cspSource}}').join(webview.cspSource)
      .split('{{nonce}}').join(n)
      .split('{{styleUri}}').join(uri('webview.css'))
      .split('{{iconsUri}}').join(uri('icons.js'))
      .split('{{scriptUri}}').join(uri('room-webview.js'))
  }

  const provider = {
    resolveWebviewView(webviewView) {
      view = webviewView
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(chatDir)],
      }
      webviewView.webview.html = html(webviewView.webview)
      webviewView.webview.onDidReceiveMessage(msg => {
        if (msg?.type === 'publish') return onPublish?.(!!msg.published)
        if (msg?.type === 'invite') return onInvite?.({ role: String(msg.role ?? 'member') })
        // The view is destroyed and rebuilt whenever the sidebar is collapsed
        // and reopened, so it asks for the current room rather than waiting.
        if (msg?.type === 'room-refresh') {
          post(last)
          onRefresh?.()
        }
      })
      // A revealed view starts empty; replay immediately.
      post(last)
    },
  }

  function post(room) {
    // Merged so a partial `{busy: true}` does not blank the roster.
    last = { ...last, ...room }
    // The view may not be resolved yet (the sidebar has never been opened) or
    // may have been disposed. Neither is worth an exception.
    try { view?.webview?.postMessage({ type: 'room', room: last }) } catch { /* not visible */ }
  }

  return { provider, postRoom: post }
}

module.exports = { createRoomView }
```

- [ ] **Step 6: Add the one CSS rule and the view contribution**

Append to `extension/src/chat/webview.css`, directly after the `.side-empty` rule (line 769):

```css
/* The state word with its icon beside it, in the view header. */
.side-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

In `extension/package.json`, replace the `views` block (lines 37-45) with:

```json
    "views": {
      "claudeRoom": [
        {
          "id": "claudeRoom.room",
          "name": "Room",
          "type": "webview"
        },
        {
          "id": "claudeRoom.workers",
          "name": "Workers",
          "type": "webview"
        }
      ]
    }
```

In `extension/test/harness-fixtures.test.js`, extend the contract list on line 17:

```javascript
const HOST_FILES = ['panel.js', 'worker-panel.js', 'workers-view.js', 'room-view.js']
```

- [ ] **Step 7: Run the suite**

```bash
cd extension && node --test
```

Expected: 310 tests, 309 pass, 0 fail, 1 skipped. `chat-globals.test.js` passes untouched — it reads `webview.html`, which does not load the new script.

- [ ] **Step 8: Commit**

```bash
git add extension/src/chat/room.html extension/src/chat/room-webview.js extension/src/chat/room-view.js extension/src/chat/webview.css extension/package.json extension/test/room-view-boot.test.js extension/test/harness-fixtures.test.js
git commit -m "feat(extension): a Room sidebar view with publish, stop sharing, invite and the roster" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: both views drive the session, with or without a chat

**Files:**
- Modify: `extension/src/extension.js` — register the Room view, start the session on first reveal of either view, wire Add/Stop and openWorker without a chat
- Test: none. **Glue that needs the real `vscode` module**; covered by the manual check below and Task 12.

**Interfaces:**
- Consumes: `createRoomView` (Task 7), `ensureSession` (Task 5), `session.pool.add/stop`, `session.postRoom/republish/invite`.
- Produces: `claudeRoom.room` and `claudeRoom.workers` both functional with no chat open.

- [ ] **Step 1: Register the Room view and start the session on reveal**

In `extension/src/extension.js`, add to the requires:

```javascript
const { createRoomView } = require('./chat/room-view.js')
```

and add a module-level `let activeRoomView = null` beside `activeWorkersView`.

Replace the view registration inside `activate` (lines 63-86) with:

```javascript
  // Registered at activation, not per chat: the sidebar exists whether or not a
  // chat is open, and a view registered later would never appear.
  //
  // The room itself starts on the FIRST REVEAL of either view, not at
  // activation: a process for someone who never opens the panel is a cost with
  // no benefit, and both views ask for their state the moment they resolve.
  const workersView = createWorkersView({
    context,
    onAdd: () => withSession(context, s => s.pool.add()),
    onOpen: handle => vscode.commands.executeCommand('claudeRoom.openWorker', handle),
    onRefresh: () => withSession(context, s => {
      workersView.postWorkers(s.pool.list())
    }),
  })
  activeWorkersView = workersView

  const roomView = createRoomView({
    context,
    onPublish: next => withSession(context, s => s.republish(next)),
    onInvite: async ({ role }) => {
      // The host owns the prompt: only it can show a native input box.
      const name = await vscode.window.showInputBox({
        prompt: 'Name for the join link',
        placeHolder: 'ana',
      })
      if (!name) return // cancelled: minting a seat nobody asked for helps nobody
      await withSession(context, s => s.invite({ name, role }))
    },
    onRefresh: () => withSession(context, s => s.postRoom()),
  })
  activeRoomView = roomView

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeRoom.room', roomView.provider),
    vscode.window.registerWebviewViewProvider('claudeRoom.workers', workersView.provider),
    vscode.commands.registerCommand('claudeRoom.openChat', () => openChat(context)),
    vscode.commands.registerCommand('claudeRoom.restart', () => restart(context)),
    vscode.commands.registerCommand('claudeRoom.openWorker', handle => {
      // The sidebar exists before any chat does. Without a chat there is no
      // worker tab to open, so say so rather than doing nothing at all.
      if (!activeOpenWorker) {
        vscode.window.showInformationMessage('Claude Room: worker tabs open from the orchestrator chat.')
        return
      }
      activeOpenWorker(String(handle ?? ''))
    }),
    output,
    { dispose: () => supervisor?.stopAll() },
  )
```

Add `withSession` beside `ensureSession`:

```javascript
/**
 * Run `fn` against the room session, starting it if this is the first ask.
 *
 * Every sidebar action goes through here, which is what makes "first reveal of
 * either view" the thing that starts the room -- rather than activation, which
 * would run a process for someone who never opens the panel.
 */
async function withSession(context, fn) {
  try {
    const s = await ensureSession(context)
    if (!s) return
    await fn(s)
  } catch (err) {
    log(`sidebar action failed: ${err?.stack ?? err}`)
    vscode.window.showErrorMessage(`Claude Room: ${err?.message ?? err}`)
  }
}
```

and extend `ensureSession` to feed the Room view as well:

```javascript
  roomSession = s
  s.onWorkers(list => activeWorkersView?.postWorkers(list))
  s.onRoom(room => activeRoomView?.postRoom(room))
  // The first paint: the views are already asking, and the answer needs the
  // roster the session has only just become able to read.
  s.postRoom().catch(err => log(`room state failed: ${err?.message ?? err}`))
  return s
```

- [ ] **Step 2: Add a Stop control to the workers sidebar**

The Room view owns publishing; stopping a worker belongs on the worker row. In `extension/src/chat/workers.html`, add a per-row stop affordance by giving the head a trailing button — in `extension/src/chat/workers-webview.js`, after the `status` element is appended (line 68), insert:

```javascript
      const stop = document.createElement('button')
      stop.className = 'icon-btn'
      stop.type = 'button'
      stop.setAttribute('aria-label', `Stop ${w.title}`)
      stop.title = `Stop ${w.title}`
      stop.appendChild(icon('x', document))
      stop.addEventListener('click', e => {
        // The row itself opens the worker; stopping it must not do both.
        e.stopPropagation()
        vscode.postMessage({ type: 'stop-worker', handle: raw.handle })
      })
      head.appendChild(stop)
```

and in `extension/src/chat/workers-view.js`, add to the message handler (after line 55):

```javascript
        if (msg?.type === 'stop-worker') return onStop?.(String(msg.handle ?? ''))
```

taking `onStop` in the destructured deps on line 25. Wire it in `extension.js`'s `createWorkersView` call:

```javascript
    onStop: handle => withSession(context, s => s.pool.stop(handle)),
```

- [ ] **Step 3: Run the suite and the parse check**

```bash
cd extension && node --check src/extension.js && node --check src/chat/workers-view.js && node --test
```

Expected: 310 tests, 309 pass, 0 fail, 1 skipped. `workers-format.test.js` is unaffected (the stop button is DOM, not formatting).

- [ ] **Step 4: Manual check (glue that needs a real host)**

Press **F5**. **Without opening the chat**: click the Claude Room icon in the activity bar. Confirm —
1. the **Room** view appears above **Workers** and says `local only`, `127.0.0.1 — reachable only from this machine`, and lists you as owner;
2. the "Claude Room" output channel shows the room starting;
3. **Invite…** prompts for a name and reports a link copied to the clipboard;
4. **⊕** in Workers adds a worker (it will report the room's error verbatim if the robustness plan's routes are not merged yet — that is the correct behaviour, not a bug);
5. clicking a worker row with no chat open says worker tabs open from the chat, rather than doing nothing.

- [ ] **Step 5: Commit**

```bash
git add extension/src/extension.js extension/src/chat/workers-view.js extension/src/chat/workers-webview.js
git commit -m "feat(extension): the sidebar starts and drives the room without a chat window" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: harness fixtures and screenshots for the Room view

**Files:**
- Create: `extension/harness/room.html`
- Modify: `extension/harness/fixtures.js` — the `room` fixture (lines 164-174), `PAGES` (207-212), `INTERACTIONS` (219-224)
- Test: `extension/test/harness-fixtures.test.js` runs unchanged and covers the new entries (it derives everything from source)

**Interfaces:**
- Consumes: `room-webview.js`, `icons.js`, `webview.css` — the real files, loaded exactly as the view loads them.
- Produces: PNGs at `extension/harness/shots/room-{dark,light}-{sidebar,wide}.png` and `room-local-*`.

- [ ] **Step 1: Write the harness page**

Create `extension/harness/room.html` (the same shape as `harness/workers.html`, loading the real stylesheet and the real script):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!--
  The REAL room stylesheet and the REAL room script, so what is screenshotted
  here is what ships. Only acquireVsCodeApi and the theme tokens are faked,
  exactly as index.html and workers.html do it.
-->
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./theme.css">
<link rel="stylesheet" href="../src/chat/webview.css">
<link rel="stylesheet" href="./viewport.css">
<title>Room</title>
</head>
<body class="sidebar">
  <div class="side-head">
    <span class="panel-title">Room</span>
    <span id="room-state" class="panel-total side-state"></span>
  </div>
  <div id="room-summary" class="side-summary" role="status" aria-atomic="true"></div>
  <button id="publish-btn" class="wide-btn" type="button"></button>
  <div id="room-address" class="room-address"></div>
  <div id="room-note" class="room-note"></div>
  <div class="panel-sep"></div>
  <div class="panel-title">Members</div>
  <div id="room-members" class="room-members"></div>
  <button id="invite-btn" class="wide-btn" type="button">Invite…</button>
  <script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => null, setState() {} })</script>
  <script src="../src/chat/icons.js"></script>
  <script src="../src/chat/room-webview.js"></script>
  <script src="./replay.js"></script>
</body>
</html>
```

- [ ] **Step 2: Repoint the fixtures**

In `extension/harness/fixtures.js`, replace the `room` fixture (lines 164-174) with:

```javascript
  // The Room sidebar, published. The address is a real `devtunnel host` URL
  // shape -- a browser link that needs nothing installed on the other end.
  room: [
    { type: 'room', room: {
      published: true,
      advertised: 'https://bskw8blx-5001.inc1.devtunnels.ms/?token=REDACTED',
      members: [
        { id: 'm0', name: 'you', role: 'owner' },
        { id: 'm1', name: 'ana', role: 'member' },
        { id: 'm2', name: 'sam', role: 'viewer' },
      ],
    } },
  ],
  // Local, with a roster that could not be read -- the state that must never
  // render as "nobody is here".
  'room-local': [
    { type: 'room', room: { published: false, advertised: null, members: null } },
  ],
```

In `PAGES` (lines 207-212), add:

```javascript
  // 320px is the design-system's narrow floor for a sidebar; the wide shot
  // catches a member row that only wraps badly when it has room not to.
  room: { file: 'room.html', widths: [{ name: 'sidebar', px: 320 }, { name: 'wide', px: 900 }] },
  'room-local': { file: 'room.html', widths: [{ name: 'sidebar', px: 320 }, { name: 'wide', px: 900 }] },
```

In `INTERACTIONS` (lines 219-224), **delete** the `room: ['room-chip'],` line — the Room view is a view, not a popover, so there is nothing to click before the shot.

- [ ] **Step 3: Run the fixture tests**

```bash
cd extension && node --test test/harness-fixtures.test.js
```

Expected: 5 passing. `'every fixture is a list of messages shaped like what panel.js posts'` accepts `room` because `room-view.js` posts `{type:'room'}` and joined `HOST_FILES` in Task 7.

- [ ] **Step 4: Shoot the Room view in both themes at both widths**

```bash
node extension/harness/shoot.js room
node extension/harness/shoot.js room-local
```

Expected: eight paths printed, `extension/harness/shots/room-dark-sidebar.png` … `room-local-light-wide.png`. **Open all eight.** Check against `docs/design-system.md` §9: no clipped address at 320px (`.room-address` sets `overflow-wrap: anywhere`), the state icon aligned with its word, the button text readable in both themes, the roster failure legible as a sentence. Fix any CSS problem here, in `webview.css`, with tokens only — then re-shoot.

- [ ] **Step 5: Run the whole suite**

```bash
cd extension && node --test
```

Expected: 310 tests, 309 pass, 0 fail, 1 skipped.

- [ ] **Step 6: Commit**

```bash
git add extension/harness/room.html extension/harness/fixtures.js extension/src/chat/webview.css
git commit -m "test(extension): screenshot the Room view in both themes at 320px and full width" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: the chat goes dormant, and the Room chip leaves the composer

**Files:**
- Modify: `extension/package.json` — add `contributes.configuration` and `contributes.menus.commandPalette`
- Modify: `extension/src/extension.js` — an early return in `openChat`
- Modify: `extension/src/chat/webview.html` — delete `#room-panel` (lines 45-57) and `#room-chip` (lines 69-70)
- Modify: `extension/src/chat/webview.js` — delete the room element refs (45-52), the `POPOVERS` room entry (421), the `room` message branch (558-562), the whole `--- the room chip ---` section (585-661) and the `renderRoom()` boot call (952)
- Modify: `extension/src/chat/panel.js` — `CONTROL_TYPES` (13) drops `publish`/`invite`/`room-refresh`; `postRoom` (100) is deleted
- Modify: `extension/src/chat/webview.css` — the stale tailnet prose in the `.room-address` comment (694-697)
- Modify: `extension/harness/index.html` — delete the same `#room-panel` and `#room-chip` markup (53-65, 77-78)
- Modify: `extension/test/webview-boot.test.js` — the six room-chip cases (lines 315-375) are deleted and the popover-exclusivity case is replaced

**Tests deleted here, and why:** `'opening the room popover asks the host for a fresh roster'`, `'publishing asks the host, naming the state being moved to'`, `'the room chip reports published state in words, not only colour'`, `'a join token never reaches the panel, only the host part does'`, `'a failed roster says so rather than claiming the room is empty'` and `'a member name is rendered as text, never as markup'` all test a chip that no longer exists. **Every one of them has an equivalent against the Room view in `test/room-view-boot.test.js`, added in Task 7** — check them off one by one before deleting. `'only one chip-owned popover is open at a time'` is replaced wholesale (not tweaked) because one of its three popovers is gone; the replacement still proves mutual exclusivity between the two that remain.

**Interfaces:**
- Produces: setting `claudeRoom.enableChat` (boolean, default `false`), gating the `claudeRoom.openChat` command in the palette and at the call site.

- [ ] **Step 1: Replace the popover test and delete the six chip tests**

In `extension/test/webview-boot.test.js`, delete lines 313-375 and put in their place:

```javascript
// --- the permission chip ---------------------------------------------------
//
// The room chip moved to the claudeRoom.room sidebar view when the chat went
// dormant; its cases live in test/room-view-boot.test.js now.

test('only one chip-owned popover is open at a time', () => {
  // Two open at once would stack over the composer and hide what is typed.
  const boot = bootWebview()
  boot.fire(boot.get('context-chip'), 'click')
  assert.equal(boot.get('context-panel').hidden, false)
  boot.fire(boot.get('permission-chip'), 'click')
  assert.equal(boot.get('permission-panel').hidden, false)
  assert.equal(boot.get('context-panel').hidden, true)
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd extension && node --test test/webview-boot.test.js
```

Expected: `'only one chip-owned popover is open at a time'` passes already (the chip still exists and simply is not clicked), and the suite is green — this step's failure arrives in Step 3, when `webview.js` loses the room code and `closePopovers` would otherwise dereference a missing element. Run it again after Step 3 to prove the boot still completes.

- [ ] **Step 3: Remove the Room chip from the chat**

`extension/src/chat/webview.html`: delete the `#room-panel` block (lines 45-57) and the `#room-chip` button (lines 69-70).

`extension/src/chat/webview.js`: delete lines 45-52 (`roomChipEl` … `inviteBtnEl`), the `[roomChipEl, roomPanelEl],` entry in `POPOVERS` (line 421), the `msg.type === 'room'` branch (558-562), the entire `// --- the room chip ---` section (585-661, i.e. `let room`, `hostOf`, `renderRoom`, and the three listeners), and the `renderRoom()` call at line 952.

`extension/src/chat/panel.js`: line 13 becomes

```javascript
// Messages from the permission chip that only the extension host can act on.
// An allowlist rather than a prefix test: these reach a process spawn, so an
// unrecognised type must fall on the floor rather than be forwarded.
const CONTROL_TYPES = new Set(['permission-mode'])
```

and delete `postRoom: room => post({ type: 'room', room }),` (line 100). The comment on lines 84-86 becomes:

```javascript
    // permission-mode: restarts the orchestrator, which only the extension
    // host can do.
```

`extension/src/chat/webview.css`: replace the `.room-address` comment (lines 694-697) with:

```css
/* The advertised address, shown before anything is committed: a devtunnels.ms
   URL works for anyone with a browser, no account or VPN required on their
   end. Lives in the Room view now; the chat no longer has a room chip. */
```

`extension/harness/index.html`: delete the `#room-panel` block (53-65) and the `#room-chip` button (77-78), so the harness page keeps matching the real one.

- [ ] **Step 4: Gate the command**

In `extension/package.json`, add after `contributes.commands` (line 27):

```json
    "configuration": {
      "title": "Claude Room",
      "properties": {
        "claudeRoom.enableChat": {
          "type": "boolean",
          "default": false,
          "description": "Show the orchestrator chat window. Off by default: Claude Code's own UI is the chat, and this extension's job is the Room and Workers views. The chat still works if you turn this on."
        }
      }
    },
    "menus": {
      "commandPalette": [
        {
          "command": "claudeRoom.openChat",
          "when": "config.claudeRoom.enableChat"
        }
      ]
    },
```

In `extension/src/extension.js`, at the very top of `openChat`, before the `if (chat)` check:

```javascript
  // Dormant by default (spec §4). The `when` clause hides this from the
  // palette, but a keybinding or another extension can still invoke a command
  // directly -- so refuse here too, and say where the switch is rather than
  // failing silently.
  if (!vscode.workspace.getConfiguration('claudeRoom').get('enableChat')) {
    vscode.window.showInformationMessage(
      'Claude Room: the orchestrator chat is off. Turn on "claudeRoom.enableChat" in Settings to use it — the Room and Workers views work without it.',
    )
    return
  }
```

- [ ] **Step 5: Run the suite**

```bash
cd extension && node --check src/chat/webview.js && node --test
```

Expected: 304 tests, 303 pass, 0 fail, 1 skipped (six chip cases deleted from `webview-boot.test.js`; their coverage lives in `room-view-boot.test.js`). `chat-globals.test.js` passes — `webview.js` no longer reads any global the html stopped loading.

- [ ] **Step 6: Manual check**

Press **F5**. Confirm: the command palette does **not** offer "Claude Room: Open Orchestrator Chat"; the sidebar's Room and Workers views still work; setting `claudeRoom.enableChat` to `true` in Settings makes the command appear and open a chat with no Room chip in the composer.

- [ ] **Step 7: Commit**

```bash
git add extension/package.json extension/src/extension.js extension/src/chat/webview.html extension/src/chat/webview.js extension/src/chat/panel.js extension/src/chat/webview.css extension/harness/index.html extension/test/webview-boot.test.js
git commit -m "feat(extension): the chat goes dormant behind claudeRoom.enableChat and gives up the Room chip" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: the install prompt and a `.vsix` a stranger can use

**Files:**
- Modify: `extension/src/extension.js` — a `claudeRoom.installTools` command and a one-time check on first session start
- Modify: `extension/package.json` — `publisher`, `repository`, `license`, and the new command
- Modify: `extension/.vscodeignore`
- Test: none for the glue (it is `vscode.window.showWarningMessage` plus a terminal); `install.js` itself is covered by Task 2.

**Interfaces:**
- Consumes: `detectTools`, `installPlan` (Task 2).
- Produces: command `claudeRoom.installTools`; a `.vsix` from `npx @vscode/vsce package`.

- [ ] **Step 1: Wire the consent dialog**

In `extension/src/extension.js`, add to the requires:

```javascript
const { detectTools, installPlan } = require('./install.js')
```

and add below `withSession`:

```javascript
/**
 * Offer to install what is missing -- and only after an explicit yes.
 *
 * Nothing is ever installed silently: the dialog names each tool, the exact
 * command, and where it comes from, and the commands run in a visible terminal
 * so they can be read, cancelled, or copied out and run by hand instead.
 */
async function offerMissingTools({ force = false } = {}) {
  const found = detectTools()
  const missing = Object.keys(found).filter(k => !found[k])
  if (!missing.length) {
    if (force) vscode.window.showInformationMessage('Claude Room: claude, opencode and devtunnel are all on PATH.')
    return
  }
  const plan = installPlan(missing)
  if (!plan.length) return

  const detail = plan.map(p => `${p.tool}\n  ${p.command}\n  ${p.note}`).join('\n\n')
  const choice = await vscode.window.showWarningMessage(
    `Claude Room: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on PATH.`,
    { modal: true, detail: `${detail}\n\nRunning these opens a terminal; nothing is installed until you say so.` },
    'Run these commands',
    'Copy commands',
  )
  if (choice === 'Copy commands') {
    await vscode.env.clipboard.writeText(plan.map(p => p.command).join('\n'))
    vscode.window.showInformationMessage('Claude Room: install commands copied to the clipboard.')
    return
  }
  if (choice !== 'Run these commands') return // dismissed: install nothing

  const terminal = vscode.window.createTerminal('Claude Room: install')
  terminal.show()
  for (const p of plan) terminal.sendText(p.command)
}
```

Register the command in `activate`'s `context.subscriptions.push(...)` list:

```javascript
    vscode.commands.registerCommand('claudeRoom.installTools', () => offerMissingTools({ force: true })),
```

and call it once, without awaiting, at the end of a successful `ensureSession` (after `s.postRoom()`):

```javascript
  // Asked once, when the room first starts, and never again in this window: a
  // dialog on every activation would be nagging rather than helping.
  offerMissingTools().catch(err => log(`tool check failed: ${err?.message ?? err}`))
```

- [ ] **Step 2: Make the manifest packageable**

`vsce package` refuses without a publisher and warns without a repository or license. In `extension/package.json`, add after `"version": "0.0.1",`:

```json
  "publisher": "claude-room",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/heet-shah/claude-room.git"
  },
```

and add the command to `contributes.commands`:

```json
      {
        "command": "claudeRoom.installTools",
        "title": "Claude Room: Check Required Tools"
      }
```

Also update the stale `description` (line 4), since the chat is no longer the product:

```json
  "description": "Run, share and watch a Claude Room: publish the room, invite people, and see what the workers are doing.",
```

- [ ] **Step 3: Keep the harness and the dev deps out of the package**

Replace `extension/.vscodeignore` with:

```
.vscode/**
test/**
**/*.test.js
harness/**
node_modules/**
package-lock.json
.gitignore
**/tsconfig.json
**/.eslintrc*
**/*.map
```

`node_modules/**` is safe to exclude outright: this extension has **no runtime dependencies**, only `@vscode/test-cli` and `@vscode/test-electron` as devDependencies. `harness/**` is a screenshot rig that spawns Chrome; it has no business in a shipped package.

- [ ] **Step 4: Package it**

```bash
cd extension && npx @vscode/vsce package
```

Expected: `DONE  Packaged: …/extension/claude-room-orchestrator-0.0.1.vsix` plus a file listing. Confirm the listing contains `src/**`, `media/room.svg`, `package.json`, `README.md` and **no** `test/`, `harness/` or `node_modules/`. This step needs network access the first time (npx fetches vsce); if it is unavailable, record that and run it before the branch is finished — the `.vsix` is the deliverable for spec §5.

Then install it into the editor and confirm a cold install works:

```
Ctrl+Shift+P → "Extensions: Install from VSIX…" → pick the .vsix → reload
```

Confirm the Claude Room icon appears in the activity bar and the Room view resolves. Uninstall afterwards so the development host is not shadowed by an installed copy.

- [ ] **Step 5: Run the suite**

```bash
cd extension && node --check src/extension.js && node --test
```

Expected: 304 tests, 303 pass, 0 fail, 1 skipped.

- [ ] **Step 6: Commit**

```bash
git add extension/src/extension.js extension/package.json extension/.vscodeignore
git commit -m "feat(extension): offer the missing tools on consent, and package to a vsix" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

(If the `.vsix` was produced, do **not** commit it — add nothing binary to the tree.)

---

### Task 12: run the F5 walkthrough for real, and write down what happened

**Files:**
- Modify: `extension/README.md` — a new "Room and Workers views (2026-09-19)" section under **Manual verification**

Spec §7: this has never been done for these surfaces. Record it honestly, failures included. Nothing here is automated; the output of this task is the record.

**The single-instance gotcha, before anything else.** Cursor and VS Code reuse a running instance: pressing F5 while one is already open can silently attach the Extension Development Host to the *wrong* window, or refuse to open a second one. So:

1. Fully quit every Cursor/VS Code window first (check the tray and Task Manager for stragglers), **or** launch with `--new-window`.
2. Before trusting anything you see, confirm the window title contains **`[Extension Development Host]`** and that the folder open in it is this repo. A shot of the wrong window looks exactly like a working feature.

- [ ] **Step 1: Launch a clean host**

```bash
# quit all editors first, then:
cursor --new-window --extensionDevelopmentPath="C:/Users/admin/OneDrive/Desktop/claude-room/extension" "C:/Users/admin/OneDrive/Desktop/claude-room"
```

(or `code` in place of `cursor`; or press **F5** from the repo root, which uses `.vscode/launch.json`).

- [ ] **Step 2: Walk the surfaces and record each answer**

Work through this list, writing the actual result beside each — including "did not work":

```
1. The window title says [Extension Development Host] and the workspace is claude-room.
2. The Claude Room icon is in the activity bar; clicking it shows Room above Workers.
3. Room says "local only", shows 127.0.0.1, and lists you as owner.
4. The output channel "Claude Room" shows the room starting, with no error.
5. If a tool is missing from PATH, the consent dialog appears, names it and its
   command, and installs NOTHING until "Run these commands" is clicked.
6. Publish with Dev Tunnels: the button disables, the state reads "restarting…",
   and within a few seconds the address becomes a *.devtunnels.ms host.
7. Open that address in a browser on another device. It loads the room.
8. Stop sharing: the address returns to 127.0.0.1 and the state to "local only".
9. Kill the devtunnel process by hand mid-publish, then publish again: the view
   must end up saying "local only", never "published" (Task 6).
10. Invite…: prompts for a name, says the link is on the clipboard, and the new
    member appears in the roster. The token appears nowhere on screen.
11. Workers ⊕ adds a worker; its row appears as "starting" and becomes busy/idle.
12. The row's stop button removes it, and the room reports no orphan process.
13. Set claudeRoom.enableChat = true: the chat command appears and opens a chat
    with no Room chip; delegation still renders. Set it back to false.
14. Close the window: no stray `node`, `claude`, `opencode` or `devtunnel`
    process is left behind.
```

- [ ] **Step 3: Write the record into the README**

Add to `extension/README.md`, after the Task 7 section (line 209), a section that states plainly what passed, what failed, and what is still unverified — in the voice of the existing records, which say "sending was broken" where it was. Include the single-instance gotcha and the title check, because the next person will hit it.

- [ ] **Step 4: Commit**

```bash
git add extension/README.md
git commit -m "docs(extension): record the F5 walkthrough of the Room and Workers views" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: the documentation catches up

**Files:**
- Modify: `extension/README.md` — the intro (lines 1-25), the "If you edit the webview" module list (29-45), the test count (51), and an "Installing" note about the setting
- Modify: `docs/design-system.md` — §8 becomes the Room **view**, §5 gains the Stop control, §4's chip row loses the Room chip
- Modify: `ARCHITECTURE.md` — §4's module table and process tree, §6's test count

- [ ] **Step 1: `extension/README.md`**

Replace the opening paragraph (lines 3-6) with a description of what this is now:

```markdown
A VS Code extension that runs, shares and shows a [claude-room](../README.md):
the room process, the Room and Workers sidebar views, publishing over Dev
Tunnels, invites, and the worker fleet. Claude Code's own UI is the chat; this
extension's job is to show and control the room around it.
```

Under **Status**, replace the Working/Not built/Unverified block (13-25) with the current truth: the Room and Workers views, the session that runs without a chat, publish/stop-sharing/invite, workers spawned by the room, the chat dormant behind `claudeRoom.enableChat`, and packaging via `vsce`. State the measured test count from the final run.

In "If you edit the webview", extend the module list to name the four webviews (`webview.js`, `workers-webview.js`, `worker-webview.js`, `room-webview.js`) and the two tests that guard them (`chat-globals.test.js`, `webview-boot.test.js`, plus `room-view-boot.test.js` for the Room view).

Add under "Installing it properly": the `.vsix` ships with the chat off; `claudeRoom.enableChat` turns it on.

- [ ] **Step 2: `docs/design-system.md`**

- §4 "The chip row" (line 173): remove the Room chip from the row and note in one line that publishing and invites moved to the Room view, so the composer carries only what a message needs.
- §5 "Surface: the workers sidebar" (277): the container now holds **two** views, Room above Workers; add the per-row stop control to the sketch and note that ⊕ and the stop button are HTTP calls to the room, which owns worker processes.
- §8: retitle to **"Surface: the Room view"**, redraw the sketch as a sidebar view rather than a popover, and keep every rule that survives the move verbatim — the address shown before committing, the state word in the header, the clipboard-only join link, the host-part-only regex, and "a roster that could not be read says so". Add the one new rule: **published state is set from the outcome of the restart, never from the intent**, with a pointer to `session.js`'s `republish`.

- [ ] **Step 3: `ARCHITECTURE.md`**

- §4's process tree (lines 165-172): worker processes hang off the **room**, not the extension host.
- §4's module table (174-183): add `session.js` ("the room, its token, the one SSE subscription, the fleet, publish/invite — independent of any chat"), `install.js` ("which external tools are on PATH, and how to get them"), and change `extension.js`'s row to "activation, commands, the two sidebar views, the vscode adapter". Change `room-client.js`'s row to mention worker spawn/stop.
- §6's test count: re-measure and write the real number.

```bash
cd "C:/Users/admin/OneDrive/Desktop/claude-room" && node --test 2>&1 | tail -8
```

- [ ] **Step 4: Verify the docs match the code**

```bash
cd extension && grep -rn "room-chip\|publishBtnEl\|workerRecipe\|nextHandle" src/ ../docs/design-system.md ../ARCHITECTURE.md README.md
```

Expected: **no output**. Any hit is documentation describing code that no longer exists.

- [ ] **Step 5: Commit**

```bash
git add extension/README.md docs/design-system.md ARCHITECTURE.md
git commit -m "docs: the Room view, the session, and the room's ownership of workers" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec section | Task(s) |
|---|---|
| §1 Lift the session out of `openChat()` | 4 (create + test), 5 (consume + delete the originals), 8 (start on first reveal) |
| §2 A `claudeRoom.room` sidebar view | 7 (view, html, script, `package.json` contribution), 8 (wired to the session), 9 (screenshots) |
| §3 Worker pool becomes a viewer with a thin client | 1 (`spawnWorker`/`stopWorker`), 3 (delete `spawn`/`ownerId`/`workerRecipe`/`nextHandle`), 8 (Add/Stop call the room) |
| §4 The chat becomes dormant | 10 (`claudeRoom.enableChat`, `when` clause, early return, chip removed, tests moved) |
| §5 Installer and packaging | 2 (`detectTools`/`installPlan`), 11 (consent dialog, `.vscodeignore`, `vsce package`) |
| §6 Parked debt: stale tailnet prose | 10 (`webview.css` comment, with the chip) |
| §6 Parked debt: `published` after a failed restart | 6 (four failing tests, then the fix) |
| §7 Verification: unit tests | 1, 2, 3, 4, 6, 7 |
| §7 Verification: harness screenshots | 9 (dark + light, 320px + 900px) |
| §7 Verification: the F5 walkthrough, recorded | 12 |
| Docs | 13 |

## Existing tests each task touches

| Task | Existing test files touched | Effect |
|---|---|---|
| 1 | `room-client.test.js` | appended only |
| 2 | `tunnel.test.js` | **not edited**; passing it unchanged is the proof the generalisation is safe |
| 3 | `workers.test.js` | provisioning half rewritten (subjects deleted; `workerRecipe`/`nextHandle` coverage moves to the room side), event half untouched |
| 4 | none | new file only |
| 5 | none | `extension.js` has no unit tests; manual check in-step |
| 6 | `session.test.js` | appended only |
| 7 | `harness-fixtures.test.js` | `HOST_FILES` gains the fourth webview — a contract list, not an assertion |
| 8 | none | glue; manual check in-step |
| 9 | `harness-fixtures.test.js` | not edited; it validates the new fixtures from source |
| 10 | `webview-boot.test.js` | six room-chip cases deleted (equivalents live in `room-view-boot.test.js`), popover case replaced |
| 11 | none | glue and packaging |
| 12, 13 | none | documentation |
