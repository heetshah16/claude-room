# Worker Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker exists when the chat needs one, its live tool calls reach the
room instead of being discarded, and a sidebar shows what each worker is,
what it is doing, and how long it has left.

**Architecture:** The OpenCode driver already holds the room turn it is serving
and already posts `/seat/hook/Stop`. Everything the sidebar needs travels the
same path: a tool part on OpenCode's event stream becomes a
`/seat/hook/PreToolUse` post, which the room turns into an `activity` bus event
tagged with the seat's handle, which the extension's SSE router already
normalises and forwards. Nothing new is invented; one classifier stops
discarding events.

**Tech Stack:** ESM in `src/` (the room), CommonJS in `extension/`. No build
step, no runtime dependencies. `node --test`.

**Spec:** [`docs/design-system.md`](../../design-system.md) — §5 the workers
sidebar; §3 the accessibility floor.

## Global Constraints

- **`src/` is ESM, `extension/` is CommonJS.** Nothing crosses that boundary by
  import; duplicate ~20 lines rather than reach across it.
- **Zero runtime dependencies.**
- **Never `innerHTML`.** Tool names and inputs come from a free model — as
  untrusted as anything in this system.
- **No hex literal in `webview.css`**; every `var()` chain ends in a literal.
- **No two chat modules declare the same top-level name.**
- **The script owns its initial hidden state.**
- **stdout belongs to the MCP protocol** in `server.mjs`, `seat.mjs`,
  `channel.mjs` and `orchestrator-bridge.mjs`; every log line goes to stderr.
- **Kill process trees, not processes.**
- Tests never spawn `claude` or `opencode`, and never open a non-loopback socket.

## Verified before planning

Probed on 2026-09-08 against `opencode` 1.18.29.

**The event stream is rich; the driver throws almost all of it away.** One real
turn emitted `message.part.updated` (14), `message.part.delta` (12),
`message.updated` (9), `session.status` (6), `session.updated`, `session.diff`
(2) and `session.idle` (1). `actionForOpencodeEvent` classifies everything that
is not `session.*` as `ignore`.

**Part shapes, read from stored session logs** (`GET /session/:id/message`) —
across two real worker sessions: `step-start` (20), `reasoning` (20),
`step-finish` (20), `tool` (16), `text` (8), `patch` (4).

A `tool` part:

```json
{ "id": "prt_…", "sessionID": "ses_…", "messageID": "msg_…",
  "type": "tool", "callID": "call_…", "tool": "glob",
  "state": { "status": "completed",
             "input": { "pattern": "**/math.js" },
             "output": "No files found",
             "time": { "start": 1788524542148, "end": 1788524542201 } } }
```

A `step-finish` part carries `cost` and `tokens: {total, input, output,
reasoning}` — real per-step accounting, not an estimate.

`message.part.updated` delivers exactly these objects under `properties.part`,
verified for a `text` part; a `tool` part rides the same envelope.

**Minting a worker seat is one call.** `POST /api/admin/invite` with
`{ name, kind: 'agent', handle, ownerId, delegatable: true }` returns
`{ member, token }`. `ownerId` must be a real member id — `/api/state` returns
it as `you.id`.

**The driver already tracks the turn.** It holds `turn = { promptId }` and posts
`/seat/hook/Stop` with `{ token, prompt_id }`, so a tool hook is the same post
with a different event name.

## A constraint that shapes the lifecycle

`delegate` to a handle that is not **online** fails: `Queue.submit` gates on the
seat being online, and an unknown handle is not even a mention. So a worker
cannot be started lazily *in response to* a delegation — by then it is too late,
and the orchestrator has already been told the handle does not exist.

Nor should one start with the chat: a chat-only session should pay no worktree,
no process, and should not require `opencode` on `PATH` at all.

**So the first worker starts when the user sends their first message.** The
orchestrator can only delegate during a turn, and a turn takes seconds, so the
worker is normally online before it is needed. When it is not, the delegation
fails once with the room's own message and the orchestrator can retry — which is
honest, and visible in the sidebar as a worker still starting.

---

### Task 1: Stop discarding the worker's tool calls

**Files:**
- Modify: `src/opencode.mjs` (`actionForOpencodeEvent`, and the driver's handler)
- Test: `test/opencode.test.mjs`, `test/opencode-driver.test.mjs`

**Interfaces:**
- `actionForOpencodeEvent(ev, sessionId)` gains
  `{ type: 'tool-start', callId, tool, input }` and
  `{ type: 'tool-end', callId, tool, isError }`.
- The driver posts `/seat/hook/PreToolUse` and `/seat/hook/PostToolUse`.

**Dedup by `callID`.** `message.part.updated` fires repeatedly for one part as
its status changes, so without a per-turn set of seen call ids one tool call
becomes a dozen identical rows.

- [ ] **Step 1: Write the failing test**

```js
// add to test/opencode.test.mjs
test('a tool part becomes a tool-start, so the room can see the work', () => {
  // Shape captured from a real stored session log on 2026-09-08.
  const ev = {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_a',
      part: {
        type: 'tool', callID: 'call_1', tool: 'glob',
        state: { status: 'running', input: { pattern: '**/math.js' } },
      },
    },
  }
  const a = actionForOpencodeEvent(ev, 'ses_a')
  assert.equal(a.type, 'tool-start')
  assert.equal(a.callId, 'call_1')
  assert.equal(a.tool, 'glob')
  assert.deepEqual(a.input, { pattern: '**/math.js' })
})

test('a completed tool part becomes a tool-end', () => {
  const ev = {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_a',
      part: {
        type: 'tool', callID: 'call_1', tool: 'glob',
        state: { status: 'completed', input: {}, output: 'No files found' },
      },
    },
  }
  const a = actionForOpencodeEvent(ev, 'ses_a')
  assert.equal(a.type, 'tool-end')
  assert.equal(a.isError, false)
})

test('a failed tool part is reported as an error, not as a plain finish', () => {
  const ev = {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_a',
      part: { type: 'tool', callID: 'c', tool: 'bash', state: { status: 'error', error: 'boom' } },
    },
  }
  assert.equal(actionForOpencodeEvent(ev, 'ses_a').isError, true)
})

test('a text part is still ignored -- only the room_reply carries words', () => {
  // The worker's prose reaches the room through room_reply, not through here.
  // Mirroring it as activity would duplicate every reply.
  const ev = {
    type: 'message.part.updated',
    properties: { sessionID: 'ses_a', part: { type: 'text', text: 'thinking out loud' } },
  }
  assert.equal(actionForOpencodeEvent(ev, 'ses_a').type, 'ignore')
})

test('another session’s tool part is ignored', () => {
  // One opencode server hosts many sessions; acting on another one's parts
  // would attribute work to the wrong seat.
  const ev = {
    type: 'message.part.updated',
    properties: { sessionID: 'ses_other', part: { type: 'tool', callID: 'c', tool: 'glob', state: { status: 'running' } } },
  }
  assert.equal(actionForOpencodeEvent(ev, 'ses_a').type, 'ignore')
})

test('a tool part with no callID is ignored rather than emitted unidentifiable', () => {
  const ev = {
    type: 'message.part.updated',
    properties: { sessionID: 'ses_a', part: { type: 'tool', tool: 'glob', state: { status: 'running' } } },
  }
  assert.equal(actionForOpencodeEvent(ev, 'ses_a').type, 'ignore')
})
```

And in `test/opencode-driver.test.mjs`, using whatever fake-fetch harness that
file already has:

```js
test('a tool call reaches the room as a PreToolUse hook', async () => {
  const { seat, posts } = makeSeat() // the file's existing helper
  await seat.onRoomEvent({ event: 'turn', data: { text: 'do it', promptId: 'p1' } })
  await seat.onOpencodeEvent({
    type: 'message.part.updated',
    properties: { sessionID: seat.sessionId(), part: {
      type: 'tool', callID: 'c1', tool: 'glob', state: { status: 'running', input: { pattern: '*' } },
    } },
  })
  const hook = posts.find(p => p.url.includes('/seat/hook/PreToolUse'))
  assert.ok(hook, 'the room must be told the worker used a tool')
  assert.equal(hook.body.tool_name, 'glob')
  assert.deepEqual(hook.body.tool_input, { pattern: '*' })
  assert.ok(hook.body.prompt_id, 'the hook must name the turn it belongs to')
})

test('one tool call produces one start, however many times its part updates', async () => {
  // message.part.updated fires repeatedly for one part as its status changes.
  const { seat, posts } = makeSeat()
  await seat.onRoomEvent({ event: 'turn', data: { text: 'do it', promptId: 'p1' } })
  const part = { type: 'tool', callID: 'c1', tool: 'glob', state: { status: 'running', input: {} } }
  for (let i = 0; i < 5; i++) {
    await seat.onOpencodeEvent({ type: 'message.part.updated', properties: { sessionID: seat.sessionId(), part } })
  }
  assert.equal(posts.filter(p => p.url.includes('PreToolUse')).length, 1)
})

test('a tool call outside any turn is dropped rather than attributed to the last one', async () => {
  const { seat, posts } = makeSeat()
  await seat.onOpencodeEvent({
    type: 'message.part.updated',
    properties: { sessionID: seat.sessionId(), part: { type: 'tool', callID: 'c1', tool: 'glob', state: { status: 'running' } } },
  })
  assert.equal(posts.filter(p => p.url.includes('PreToolUse')).length, 0)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/opencode.test.mjs test/opencode-driver.test.mjs`
Expected: FAIL — every tool event currently classifies as `ignore`.

- [ ] **Step 3: Teach the classifier**

In `src/opencode.mjs`, before the final `return { type: 'ignore' }`:

```js
  // A tool call the worker is making. The room already has a route for this --
  // /seat/hook/PreToolUse, the same one a Claude seat's hooks use -- so the
  // whole activity pipeline downstream of it already exists. What was missing
  // was only that this event was being thrown away.
  if (type === 'message.part.updated' && p.part?.type === 'tool') {
    const part = p.part
    // No callID means nothing can be deduplicated or matched to a finish.
    if (!part.callID) return { type: 'ignore' }
    const status = part.state?.status
    if (status === 'completed' || status === 'error') {
      return { type: 'tool-end', callId: part.callID, tool: part.tool, isError: status === 'error' }
    }
    return { type: 'tool-start', callId: part.callID, tool: part.tool, input: part.state?.input ?? {} }
  }
```

In the driver's `onOpencodeEvent`, alongside the existing action handling:

```js
    if (action.type === 'tool-start') {
      // One row per call, however many times its part updates.
      if (!turn || turn.tools?.has(action.callId)) return
      turn.tools.add(action.callId)
      await post(`${roomUrl}/seat/hook/PreToolUse?token=${encodeURIComponent(token)}`,
        { token, prompt_id: promptId, tool_name: action.tool, tool_input: action.input })
      return
    }
    if (action.type === 'tool-end') {
      if (!turn) return
      await post(`${roomUrl}/seat/hook/PostToolUse?token=${encodeURIComponent(token)}`,
        { token, prompt_id: promptId, tool_name: action.tool })
      return
    }
```

and initialise `turn = { promptId, timer: null, tools: new Set() }` where the
turn is armed. A tool event outside a turn is dropped: attributing it to a
previous turn would file the work under the wrong ask.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/opencode.test.mjs test/opencode-driver.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode.mjs test
git commit -m "feat(opencode): a worker's tool calls reach the room"
```

---

### Task 2: Minting and launching a worker

**Files:**
- Create: `extension/src/workers.js`
- Test: `extension/test/workers.test.js`

**Interfaces:**
- Produces:
  - `workerRecipe({ repoRoot, handle, token, roomUrl, model, timeoutMs, nodePath, env })`
    → `{ cmd, args, opts }` for `scripts/room-opencode-seat.mjs`
  - `nextHandle(existing)` → `'worker-1'`, `'worker-2'`, …
  - `createWorkerPool({ roomClient, supervisor, repoRoot, roomUrl, log })`
    → `{ ensureOne(), add(), list(), stop(handle), onChange(fn) }`

- [ ] **Step 1: Write the failing test**

```js
// extension/test/workers.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workerRecipe, nextHandle, createWorkerPool } = require('../src/workers.js')

test('the recipe launches the opencode seat launcher, not opencode directly', () => {
  // scripts/room-opencode-seat.mjs is what creates the worktree, starts
  // `opencode serve`, registers the reply-only seat bridge and runs the driver.
  const r = workerRecipe({
    repoRoot: '/repo', handle: 'worker-1', token: 'seat-tok',
    roomUrl: 'http://127.0.0.1:8787', nodePath: '/usr/bin/node', env: {},
  })
  assert.equal(r.cmd, '/usr/bin/node')
  assert.match(r.args[0], /room-opencode-seat\.mjs$/)
  assert.equal(r.args[1], 'worker-1')
  assert.ok(r.args.includes('--token'))
  assert.equal(r.args[r.args.indexOf('--token') + 1], 'seat-tok')
  assert.equal(r.args[r.args.indexOf('--room') + 1], 'http://127.0.0.1:8787')
})

test('a model and a timeout are passed only when chosen', () => {
  const bare = workerRecipe({ repoRoot: '/repo', handle: 'w', token: 't', roomUrl: 'u', env: {} })
  assert.ok(!bare.args.includes('--model'), 'the launcher has its own default')
  const chosen = workerRecipe({
    repoRoot: '/repo', handle: 'w', token: 't', roomUrl: 'u', model: 'opencode/x', timeoutMs: 60000, env: {},
  })
  assert.equal(chosen.args[chosen.args.indexOf('--model') + 1], 'opencode/x')
  assert.equal(chosen.args[chosen.args.indexOf('--timeout') + 1], '60000')
})

test('the seat token never reaches the environment, only argv', () => {
  // The launcher reads --token; putting it in env too would widen where a
  // seat credential can be read from for no gain.
  const r = workerRecipe({ repoRoot: '/repo', handle: 'w', token: 'seat-tok', roomUrl: 'u', env: { PATH: '/bin' } })
  assert.ok(!JSON.stringify(r.opts.env).includes('seat-tok'))
})

test('handles are allocated in order and skip the ones already taken', () => {
  assert.equal(nextHandle([]), 'worker-1')
  assert.equal(nextHandle(['worker-1']), 'worker-2')
  assert.equal(nextHandle(['worker-2']), 'worker-1', 'a freed handle is reused')
  assert.equal(nextHandle(['worker-1', 'worker-2', 'worker-3']), 'worker-4')
})

test('ensureOne mints a seat and starts exactly one worker', async () => {
  const invites = []
  const started = []
  const pool = createWorkerPool({
    repoRoot: '/repo', roomUrl: 'u', log: () => {},
    roomClient: {
      state: async () => ({ you: { id: 'owner-1' } }),
      invite: async a => { invites.push(a); return { ok: true, token: 'seat-tok', member: { handle: a.handle } } },
    },
    supervisor: { start: (name, recipe) => { started.push({ name, recipe }); return { child: { pid: 1 } } }, stop() {} },
  })
  await pool.ensureOne()
  await pool.ensureOne() // idempotent: a second call must not start a second

  assert.equal(invites.length, 1)
  assert.equal(invites[0].kind, 'agent')
  assert.equal(invites[0].handle, 'worker-1')
  assert.equal(invites[0].ownerId, 'owner-1')
  assert.equal(invites[0].delegatable, true, 'the orchestrator must be allowed to delegate to it')
  assert.equal(started.length, 1)
})

test('a failed mint leaves no half-created worker in the list', async () => {
  const pool = createWorkerPool({
    repoRoot: '/repo', roomUrl: 'u', log: () => {},
    roomClient: {
      state: async () => ({ you: { id: 'owner-1' } }),
      invite: async () => ({ ok: false, errors: ['handle-taken'] }),
    },
    supervisor: { start: () => assert.fail('must not start a worker with no seat'), stop() {} },
  })
  await pool.ensureOne()
  assert.deepEqual(pool.list(), [])
})

test('a pool with no owner id does not invent one', async () => {
  const pool = createWorkerPool({
    repoRoot: '/repo', roomUrl: 'u', log: () => {},
    roomClient: { state: async () => null, invite: async () => assert.fail('must not invite without an owner') },
    supervisor: { start: () => assert.fail('must not start'), stop() {} },
  })
  await pool.ensureOne()
  assert.deepEqual(pool.list(), [])
})

test('listeners are told when the fleet changes, so the sidebar can redraw', async () => {
  const seen = []
  const pool = createWorkerPool({
    repoRoot: '/repo', roomUrl: 'u', log: () => {},
    roomClient: {
      state: async () => ({ you: { id: 'o' } }),
      invite: async a => ({ ok: true, token: 't', member: { handle: a.handle } }),
    },
    supervisor: { start: () => ({ child: { pid: 1 } }), stop() {} },
  })
  pool.onChange(list => seen.push(list.length))
  await pool.ensureOne()
  assert.deepEqual(seen.at(-1), 1)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test extension/test/workers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`workerRecipe` builds argv for `scripts/room-opencode-seat.mjs`, omitting
`--model` and `--timeout` when unset so the launcher's own defaults win.
`createWorkerPool` holds `{ handle, token, state, startedAt }` per worker,
mints through `roomClient.invite`, starts through `supervisor.start`, and fires
`onChange` after any mutation. `ensureOne()` returns immediately if the list is
non-empty.

- [ ] **Step 4: Run tests, then commit**

```bash
node --test extension/test/workers.test.js
git add extension/src/workers.js extension/test/workers.test.js
git commit -m "feat(extension): mint and launch opencode workers"
```

---

### Task 3: The fleet's live state

**Files:**
- Modify: `extension/src/events.js` (forward worker activity with its handle)
- Modify: `extension/src/extension.js` (start on first message; feed the pool)
- Test: `extension/test/events.test.js`, `extension/test/workers.test.js`

**What the sidebar needs per worker:** handle, model, worktree, status
(`starting` / `idle` / `busy`), the current task, and the turn deadline counting
down. Status and task come from the SSE stream the extension already holds:
`delegation` (state `sent`) starts a task, `activity` keeps it alive, and a
`delegation` with state `done` or `abandoned` ends it.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/workers.test.js
test('a delegation marks its worker busy and records the task', () => {
  const pool = poolWith(['worker-1'])
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', task: 'Add tests', id: 'd1' })
  const w = pool.list()[0]
  assert.equal(w.state, 'busy')
  assert.equal(w.task, 'Add tests')
  assert.ok(w.deadlineAt > Date.now(), 'a busy worker has a deadline to count down')
})

test('a finished delegation returns the worker to idle', () => {
  const pool = poolWith(['worker-1'])
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', task: 'Add tests', id: 'd1' })
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'done', id: 'd1', text: 'done' })
  assert.equal(pool.list()[0].state, 'idle')
  assert.equal(pool.list()[0].task, null)
})

test('an abandoned delegation also frees the worker, rather than pinning it busy forever', () => {
  const pool = poolWith(['worker-1'])
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'sent', task: 'x', id: 'd1' })
  pool.applyRoomEvent('delegation', { to: 'worker-1', state: 'abandoned', id: 'd1', reason: 'feed dropped' })
  assert.equal(pool.list()[0].state, 'idle')
})

test('tool activity is recorded against the worker that ran it', () => {
  const pool = poolWith(['worker-1', 'worker-2'])
  pool.applyRoomEvent('activity', { handle: 'worker-2', kind: 'tool-start', tool: 'glob' })
  assert.equal(pool.list()[1].lastTool, 'glob')
  assert.equal(pool.list()[0].lastTool, null, 'the other worker must be untouched')
})

test('an event for an unknown handle is ignored rather than inventing a worker', () => {
  const pool = poolWith(['worker-1'])
  pool.applyRoomEvent('activity', { handle: 'ghost', kind: 'tool-start', tool: 'glob' })
  assert.equal(pool.list().length, 1)
})
```

- [ ] **Step 2–4: Implement, verify, commit**

`applyRoomEvent(event, data)` is pure over the pool's own state, which is what
makes it testable without a socket. Wire it from the existing router: the
router currently forwards worker activity to the panel only, so give it a
second callback rather than a second subscription — one SSE subscription and
one ordering is a property [ARCHITECTURE.md](../../../ARCHITECTURE.md) states
deliberately.

In `extension.js`, start the first worker on the first user message:

```js
  onInput: text => {
    orchestrator?.send(text)
    // The orchestrator can only delegate during a turn, and a turn takes
    // seconds, so a worker started here is normally online before it is
    // needed. Deliberately not at chat open: a chat-only session should pay
    // no worktree, no process, and should not need opencode on PATH at all.
    pool.ensureOne().catch(err => log(`worker start failed: ${err?.message ?? err}`))
  },
```

---

### Task 4: The sidebar

**Files:**
- Modify: `extension/package.json` (`viewsContainers`, `views`)
- Create: `extension/src/chat/workers-view.js` (the `WebviewViewProvider`)
- Create: `extension/src/chat/workers.html`, `workers-webview.js`
- Modify: `extension/harness/` (a `workers` fixture and page)
- Test: `extension/test/workers-view.test.js`

**Layout** (design §5) — three lines per worker, status as dot **and** word:

```
WORKERS                                        ⊕   ⟳
─────────────────────────────────────────────────────
● @worker-1                            busy · 2:14
  mimo-v2.5-free · .worktrees/worker-1
  ▸ Add tests for parser.mjs

○ @worker-2                                    idle
  mimo-v2.5-free · .worktrees/worker-2
```

Empty state: *"No workers yet. One starts automatically when you send your
first message."*

- [ ] **Step 1: Contribute the view**

```json
"viewsContainers": {
  "activitybar": [
    { "id": "claudeRoom", "title": "Claude Room", "icon": "media/room.svg" }
  ]
},
"views": {
  "claudeRoom": [
    { "id": "claudeRoom.workers", "name": "Workers", "type": "webview" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```js
// extension/test/workers-view.test.js — the row formatting, pure
const { formatWorker, countdown } = require('../src/chat/workers-view-format.js')

test('a busy worker shows its remaining time, not its elapsed time', () => {
  // The deadline is what decides whether a stalled free model gets killed;
  // elapsed time decides nothing.
  assert.equal(countdown(134_000), '2:14')
  assert.equal(countdown(59_000), '0:59')
  assert.equal(countdown(0), '0:00')
  assert.equal(countdown(-5000), '0:00', 'an overdue worker reads as out of time, not negative')
})

test('status is a word as well as a dot', () => {
  const w = formatWorker({ handle: 'worker-1', state: 'busy', model: 'm', worktree: '/w', task: 't', deadlineAt: Date.now() + 134_000 })
  assert.match(w.status, /busy/)
})

test('a starting worker says so rather than looking idle', () => {
  assert.match(formatWorker({ handle: 'w', state: 'starting', model: null, worktree: null }).status, /starting/)
})
```

- [ ] **Step 3–5: Implement, shoot, commit**

Add a `workers` harness page and fixture, shoot at both themes and widths, and
**read the PNGs**: the sidebar is the one surface whose real width is ~300px,
so check a long worktree path truncates rather than widening it.

---

## Verification

```bash
node --test                       # 0 failures
node extension/harness/shoot.js   # every fixture, both themes, both widths
```

**Left for the user's own pass:** that a worker actually spawns, takes a real
delegation, and streams its tool calls into the sidebar. Nothing in the suite
spawns `opencode`, so the pipeline is asserted piece by piece and never end to
end.
