# Room and Permission Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the room to a tailnet or LAN, invite people to it and see who
is in it, from a chip in the composer — and switch the orchestrator's permission
mode from another, without losing the conversation.

**Architecture:** Both chips work by restarting a child process. Publishing
restarts the *room* with a different bind address on the same port and state
dir; changing permission mode restarts the *orchestrator* with
`--permission-mode` and `--resume <sessionId>`. Neither tears down the chat.
The recipes stay pure functions; the supervisor already kills process trees.

**Tech Stack:** CommonJS, no build step, no runtime dependencies. `node --test`.
Screenshots via `node extension/harness/shoot.js`.

**Spec:** [`docs/design-system.md`](../../design-system.md) — §8 the room chip
and the permission chip; §1 the chip row; §3 the accessibility floor.

## Global Constraints

- **CommonJS only** in `extension/`; no `"type"` field in its `package.json`.
- **Zero runtime dependencies.**
- **Never `innerHTML`.** A member name is typed by a person and arrives over
  HTTP — untrusted.
- **No hex literal in `webview.css`**; every `var()` fallback chain ends in a
  **literal**, never another `var()`.
- **No emoji as an icon.**
- **No two chat modules declare the same top-level name** — enforced by
  `chat-globals.test.js`.
- **The script owns its initial hidden state**, set at boot, never inherited
  from a `hidden` attribute.
- Tests never spawn `claude` or `opencode`, and **never open a non-loopback
  socket** — which is why nothing below binds `0.0.0.0` in a test.

## Verified before planning

Probed on 2026-09-08 against the real room and the real `claude` binary.

**Publishing is a rebind, not a teardown.** A room restarted with
`ROOM_HOST=0.0.0.0` on the same port and state dir:

| Claim | Result |
|---|---|
| owner token survives | **true** — read back identical from `members.json` |
| `http://127.0.0.1:<port>` still serves | **true** — so the orchestrator's MCP bridge never notices |
| roster survives | **true** — an invited member was still there afterwards |
| advertised address changes | **true** — `joinUrl` in `/api/admin/state` differs |

`advertiseHost` prefers a Tailscale address (100.64.0.0/10) over a LAN one and
falls back to loopback; `ROOM_ADVERTISE` overrides it.

**`--permission-mode` works in print mode.** `plan`, `acceptEdits` and `auto`
each answered normally alongside `--print`. The CLI's full choice list is
`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`.
`/permissions` as a slash command is verified NOT to work headless, so a
restart is the only mechanism.

---

### Task 1: Permission modes, and the orchestrator recipe

**Files:**
- Create: `extension/src/permission-modes.js`
- Modify: `extension/src/orchestrator.js` (`orchestratorRecipe` gains `permissionMode`)
- Test: `extension/test/permission-modes.test.js`, `extension/test/orchestrator.test.js`

**Interfaces:**
- Produces: `window.ClaudePermissions` / `module.exports` =
  `{ PERMISSION_MODES, DEFAULT_MODE, isKnownMode }`.
  `PERMISSION_MODES`: `{ id, label, summary, destructive }[]`.
- `orchestratorRecipe({ …, permissionMode })` adds `--permission-mode <id>` when
  given, and omits the flag entirely when not.

**On `dontAsk`.** The CLI accepts it and this plan deliberately does not offer
it. The same rule the slash-command registry follows applies harder here: this
is a safety surface, and a mode whose exact behaviour cannot be stated
accurately must not be presented with an invented description. It stays
reachable through `settings.json`.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/permission-modes.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PERMISSION_MODES, DEFAULT_MODE, isKnownMode } = require('../src/permission-modes.js')

// The CLI's own choice list, from `claude --help` on 2.1.216.
const CLI_CHOICES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']

test('every offered mode is one the CLI actually accepts', () => {
  for (const m of PERMISSION_MODES) {
    assert.ok(CLI_CHOICES.includes(m.id), `${m.id} is not a --permission-mode choice`)
  }
})

test('the modes the user asked for are all present', () => {
  const ids = PERMISSION_MODES.map(m => m.id)
  for (const id of ['auto', 'manual', 'acceptEdits', 'plan']) {
    assert.ok(ids.includes(id), `${id} must be offered`)
  }
})

test('dontAsk is deliberately not offered', () => {
  // Its exact behaviour cannot be stated accurately, and this is a safety
  // surface. Same rule as the slash-command registry, applied harder.
  assert.ok(!PERMISSION_MODES.some(m => m.id === 'dontAsk'))
})

test('exactly one mode is marked destructive, and it is bypassPermissions', () => {
  const destructive = PERMISSION_MODES.filter(m => m.destructive)
  assert.deepEqual(destructive.map(m => m.id), ['bypassPermissions'])
})

test('every mode has a label and a summary, so none is offered unexplained', () => {
  for (const m of PERMISSION_MODES) {
    assert.ok(m.label && m.label.length > 0, `${m.id} needs a label`)
    assert.ok(m.summary && m.summary.length > 0, `${m.id} needs a summary`)
  }
})

test('the default is the ordinary prompting mode', () => {
  assert.equal(DEFAULT_MODE, 'manual')
  assert.ok(PERMISSION_MODES.some(m => m.id === DEFAULT_MODE))
})

test('isKnownMode gates what may reach the command line', () => {
  assert.equal(isKnownMode('plan'), true)
  assert.equal(isKnownMode('dontAsk'), false, 'not offered means not accepted')
  assert.equal(isKnownMode('--dangerously-skip-permissions'), false)
  assert.equal(isKnownMode(''), false)
  assert.equal(isKnownMode(null), false)
})
```

And to `extension/test/orchestrator.test.js`:

```js
test('a permission mode reaches the command line', () => {
  const { args } = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://127.0.0.1:1', token: 't',
    sessionId: 'sid', workspace: '/ws', mcpConfigPath: '/tmp/mcp.json',
    permissionMode: 'plan',
  })
  const at = args.indexOf('--permission-mode')
  assert.ok(at !== -1, 'the flag must be present')
  assert.equal(args[at + 1], 'plan')
})

test('no permission mode means no flag at all, not an empty one', () => {
  // `--permission-mode ""` is an error, and passing the CLI's own default
  // explicitly would silently pin it if that default ever changes.
  const { args } = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://127.0.0.1:1', token: 't',
    sessionId: 'sid', workspace: '/ws', mcpConfigPath: '/tmp/mcp.json',
  })
  assert.ok(!args.includes('--permission-mode'))
})

test('an unknown permission mode is refused rather than passed through', () => {
  assert.throws(() => orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://127.0.0.1:1', token: 't',
    sessionId: 'sid', workspace: '/ws', mcpConfigPath: '/tmp/mcp.json',
    permissionMode: '--dangerously-skip-permissions',
  }), /permission mode/)
})

test('a permission-mode change resumes the conversation rather than losing it', () => {
  const { args } = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://127.0.0.1:1', token: 't',
    sessionId: 'new', priorSessionId: 'old', workspace: '/ws',
    mcpConfigPath: '/tmp/mcp.json', permissionMode: 'auto',
  })
  assert.ok(args.includes('--resume'))
  assert.equal(args[args.indexOf('--resume') + 1], 'old')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test extension/test/permission-modes.test.js extension/test/orchestrator.test.js`
Expected: FAIL — module not found, and no `--permission-mode` in the args.

- [ ] **Step 3: Write `permission-modes.js`**

```js
// extension/src/permission-modes.js
//
// The permission modes the chip offers, and the gate on what may reach the
// command line.
//
// `/permissions` is verified NOT to work in print mode, so there is no
// in-session way to change this: the chip restarts the orchestrator with
// `--permission-mode` and `--resume <sessionId>`, which keeps the
// conversation. That restart path already exists for crash recovery.
//
// The CLI accepts acceptEdits, auto, bypassPermissions, manual, dontAsk and
// plan. `dontAsk` is deliberately absent: its exact behaviour cannot be stated
// accurately here, and describing a safety setting with an invented summary is
// worse than not offering it. It stays reachable through settings.json.
'use strict'

const PERMISSION_MODES = [
  { id: 'auto', label: 'Auto', summary: 'Claude decides which actions need asking', destructive: false },
  { id: 'acceptEdits', label: 'Accept edits', summary: 'File edits apply without asking; other actions still ask', destructive: false },
  { id: 'plan', label: 'Plan', summary: 'Plan first — nothing is changed', destructive: false },
  { id: 'manual', label: 'Manual', summary: 'Ask before every action', destructive: false },
  { id: 'bypassPermissions', label: 'Bypass all', summary: 'Skip every permission check', destructive: true },
]

/** The ordinary prompting mode; `manual` is the CLI's alias for its default. */
const DEFAULT_MODE = 'manual'

/**
 * Whether a string may be passed as `--permission-mode`.
 *
 * The mode arrives from the webview, and it is spliced into a command line, so
 * it is checked against the offered list rather than merely being non-empty --
 * a value like `--dangerously-skip-permissions` must never survive this.
 */
function isKnownMode(mode) {
  return PERMISSION_MODES.some(m => m.id === mode)
}

const permissionsApi = { PERMISSION_MODES, DEFAULT_MODE, isKnownMode }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = permissionsApi
}
if (typeof window !== 'undefined') {
  window.ClaudePermissions = permissionsApi
}
```

- [ ] **Step 4: Teach `orchestratorRecipe` the flag**

In `extension/src/orchestrator.js`, require `isKnownMode`, accept
`permissionMode` in the options, and build:

```js
  // Refused rather than passed through: this string arrives from the webview
  // and is spliced into a command line.
  if (permissionMode && !isKnownMode(permissionMode)) {
    throw new Error(`unknown permission mode: ${permissionMode}`)
  }
  const permissionArgs = permissionMode ? ['--permission-mode', permissionMode] : []
```

then splice `...permissionArgs` into `args` after `...resumeArgs`. Omitting the
flag entirely when none is given matters: passing the CLI's own default
explicitly would silently pin it if that default ever changed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test extension/test/permission-modes.test.js extension/test/orchestrator.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/permission-modes.js extension/src/orchestrator.js extension/test
git commit -m "feat(extension): permission modes, and the flag that carries them"
```

---

### Task 2: The room recipe's bind address, and the admin client

**Files:**
- Modify: `extension/src/room-client.js` (`roomRecipe` gains `host`; admin calls)
- Test: `extension/test/room-client.test.js`

**Interfaces:**
- `roomRecipe({ …, host = '127.0.0.1' })` → sets `ROOM_HOST`.
- `createRoomClient(...)` gains `adminState()`, `invite({name, role})`,
  `rotate(memberId)`, `remove(memberId)`.
- Produces: `PUBLISHED_HOST = '0.0.0.0'`.

- [ ] **Step 1: Write the failing test**

Add to `extension/test/room-client.test.js`:

```js
const { PUBLISHED_HOST } = require('../src/room-client.js')

test('the room binds loopback unless told otherwise', () => {
  const { opts } = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, env: {} })
  assert.equal(opts.env.ROOM_HOST, '127.0.0.1')
})

test('publishing binds every interface, on the same port and state dir', () => {
  // Verified against a real room: same port and state dir means the owner
  // token and the roster both survive, and 127.0.0.1 keeps serving -- so the
  // orchestrator's MCP bridge never notices the restart.
  const loopback = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, env: {} })
  const published = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, host: PUBLISHED_HOST, env: {} })
  assert.equal(published.opts.env.ROOM_HOST, '0.0.0.0')
  assert.equal(published.opts.env.ROOM_PORT, loopback.opts.env.ROOM_PORT)
  assert.equal(published.opts.env.ROOM_STATE_DIR, loopback.opts.env.ROOM_STATE_DIR)
})

test('adminState reads the roster', async () => {
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async url => {
      assert.match(url, /\/api\/admin\/state\?token=tok/)
      return { ok: true, json: async () => ({ ok: true, members: [{ name: 'ana', role: 'member' }] }) }
    },
  })
  const state = await client.adminState()
  assert.equal(state.members[0].name, 'ana')
})

test('invite posts a name and a role and returns the join link', async () => {
  let body = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ ok: true, joinUrl: 'http://100.1.2.3:1/?token=x' }) }
    },
  })
  const r = await client.invite({ name: 'ana', role: 'member' })
  assert.deepEqual(body, { name: 'ana', role: 'member' })
  assert.equal(r.joinUrl, 'http://100.1.2.3:1/?token=x')
})

test('a failed admin call reports the failure instead of pretending it worked', async () => {
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  })
  const r = await client.invite({ name: 'ana', role: 'member' })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /403/)
})

test('adminState returns null on failure rather than a half-empty roster', async () => {
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(await client.adminState(), null)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test extension/test/room-client.test.js`
Expected: FAIL — `PUBLISHED_HOST` undefined, `adminState` not a function.

- [ ] **Step 3: Implement**

In `roomRecipe`, take `host = '127.0.0.1'` and set `ROOM_HOST: host`. Export
`const PUBLISHED_HOST = '0.0.0.0'` with a comment recording the verification.
In `createRoomClient`, add the four admin calls reusing the existing `post`
helper, plus a `get` twin for `adminState` that returns `null` on any failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/room-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/room-client.js extension/test/room-client.test.js
git commit -m "feat(extension): bind address on the room recipe, and admin calls"
```

---

### Task 3: Restarting a child without losing the chat

**Files:**
- Modify: `extension/src/extension.js`
- Modify: `extension/src/chat/panel.js` (new posts and inbound types)
- Test: `extension/test/supervisor.test.js` (restart-in-place)

**Interfaces:**
- New inbound: `{type:'publish', published:boolean}`, `{type:'invite', name, role}`,
  `{type:'permission-mode', mode}`, `{type:'room-refresh'}`.
- New outbound: `{type:'room', room:{name, published, advertised, members, busy}}`.

**The two restarts.**

*Room:* `supervisor.start('room', roomRecipe({ …, host }))` with the same port
and state dir. `supervisor.start` already stops an existing child of that name
first, and kills process trees. Wait for the room to answer again, then re-post
the roster. The SSE feed reconnects on its own existing 1s retry loop, so
nothing else needs doing.

*Orchestrator:* stop it, then start it again with `priorSessionId` set to the
id already in `workspaceState`, plus the new `permissionMode`. Rebuild
`createOrchestrator` around the new child and repoint `panel`'s `onInput`.

**The trap:** `session.orchestrator` is closed over by `panel.onInput`. That
closure was written as `text => orchestrator?.send(text)` against a `let`, so
reassigning `orchestrator` is enough — do not create a second panel.

- [ ] **Step 1: Write the failing test**

Add to `extension/test/supervisor.test.js`:

```js
test('starting a name that is already running replaces it, killing the old tree', () => {
  const killed = []
  const spawned = []
  const sup = createSupervisor({
    spawn: (cmd, args, opts) => { const c = fakeChild(); spawned.push({ cmd, opts }); return c },
    killTree: pid => killed.push(pid),
  })
  const first = sup.start('room', { cmd: 'node', args: [], opts: { env: { ROOM_HOST: '127.0.0.1' } } })
  sup.start('room', { cmd: 'node', args: [], opts: { env: { ROOM_HOST: '0.0.0.0' } } })
  assert.deepEqual(killed, [first.pid], 'the old room must be reaped, not orphaned')
  assert.equal(spawned.length, 2)
  assert.equal(spawned[1].opts.env.ROOM_HOST, '0.0.0.0')
})

test('replacing a child does not report the old one as having crashed', () => {
  // Without this the chat shows "room exited unexpectedly" every time the user
  // publishes, which reads as the feature being broken.
  const exits = []
  const children = []
  const sup = createSupervisor({
    spawn: () => { const c = fakeChild(); children.push(c); return c },
    killTree: () => {},
  })
  sup.on('exit', e => exits.push(e))
  sup.start('room', { cmd: 'node', args: [], opts: {} })
  sup.start('room', { cmd: 'node', args: [], opts: {} })
  children[0].emit('exit', 0) // the old process finally dies
  assert.deepEqual(exits, [], 'a replaced child is not a crash')
})
```

Use whatever `fakeChild` helper the file already has; if there is none, an
`EventEmitter` with a `pid` and `{ stdin, stdout, stderr }` stubs is enough.

- [ ] **Step 2: Run to verify the second one fails**

Run: `node --test extension/test/supervisor.test.js`
Expected: the first passes (`start` already stops first); the second FAILS,
because `stop()` deletes the record before the old child's `exit` fires, so
`rec.stopping` is no longer consulted and the exit is reported as a crash.

- [ ] **Step 3: Fix the supervisor**

In `stop()`, the record is removed from `procs` immediately. Keep the record's
`stopping` flag reachable by the already-registered `exit` handler — it closes
over `rec`, so the flag survives; the bug is only that `start()` calls `stop()`
*before* replacing, and the new record then shares the name. Verify against the
real code and make the minimal change that satisfies the test.

- [ ] **Step 4: Wire the extension host**

Add to `extension.js`, inside `openChat`:

```js
  let published = false
  let permissionMode = context.workspaceState.get('claudeRoom.permissionMode') ?? null

  async function postRoom() {
    const state = await roomClient.adminState()
    panel.postRoom({
      name: state?.roomName ?? 'room',
      published,
      // The advertised address comes from a join link rather than being
      // recomputed here: the room is the only thing that knows what it chose.
      advertised: state?.members?.[0]?.joinUrl ?? null,
      members: (state?.members ?? []).map(m => ({ id: m.id, name: m.name, role: m.role })),
    })
  }

  async function republish(next) {
    panel.postRoom({ busy: true })
    published = next
    supervisor.start('room', roomRecipe({
      repoRoot: REPO_ROOT, stateDir, port,
      host: next ? PUBLISHED_HOST : '127.0.0.1',
    }))
    await waitForRoomUp(roomUrl)
    await postRoom()
  }

  async function setPermissionMode(mode) {
    if (!isKnownMode(mode)) return
    permissionMode = mode
    await context.workspaceState.update('claudeRoom.permissionMode', mode)
    const prior = context.workspaceState.get(SESSION_KEY) ?? sessionId
    const proc = supervisor.start('orchestrator', orchestratorRecipe({
      repoRoot: REPO_ROOT, roomUrl, token,
      sessionId: crypto.randomUUID(), priorSessionId: prior,
      workspace: workspace.uri.fsPath, mcpConfigPath, permissionMode,
    }))
    // Reassign the SAME binding the panel's onInput closes over. A second
    // panel here would leave the first one wired to a dead process.
    orchestrator = createOrchestrator({ child: proc.child, onEvent: e => panel.postStream(e) })
    panel.postPermissionMode(mode)
  }
```

and route them from the panel's message handler.

- [ ] **Step 5: Verify, and commit**

```bash
node --test
git add extension/src extension/test
git commit -m "feat(extension): publish the room and switch permission mode by restart"
```

---

### Task 4: The two popovers

**Files:**
- Modify: `extension/src/chat/webview.html`, `webview.js`, `webview.css`
- Modify: `extension/harness/index.html`, `extension/harness/fixtures.js`
- Test: `extension/test/webview-boot.test.js`

**Layout.** Both chips sit in the existing chip row and open a popover anchored
above it, exactly as the context chip does. One popover open at a time; Esc
closes and returns focus to the chip.

```
◉ Room · Local                      ⚡ Auto
┌──────────────────────────────┐    ┌────────────────────────┐
│ Room  auth-work              │    │ ⚡ Auto                 │
│ ● Local only (127.0.0.1)     │    │   Claude decides…      │
│                              │    │ ✎ Accept edits         │
│ [ Publish to tailnet ]       │    │ ▣ Plan                 │
│   100.x.y.z:51820            │    │ ✋ Manual              │
│   restarts the room (~1s);   │    │ ⚠ Bypass all           │
│   the chat keeps going       │    └────────────────────────┘
│ ──────────────────────────── │
│ MEMBERS                      │
│ ● you              owner     │
│ + Invite…                    │
└──────────────────────────────┘
```

- [ ] **Step 1: Write the failing tests**

```js
test('the room chip opens its popover and closes the other one', () => {
  const boot = bootWebview()
  boot.fire(boot.get('context-chip'), 'click')
  assert.equal(boot.get('context-panel').hidden, false)
  boot.fire(boot.get('room-chip'), 'click')
  assert.equal(boot.get('room-panel').hidden, false)
  assert.equal(boot.get('context-panel').hidden, true, 'only one popover at a time')
})

test('publishing asks the host, and shows a busy state rather than lying', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'room', room: { name: 'r', published: false, members: [] } } })
  boot.fire(boot.get('room-chip'), 'click')
  boot.fire(boot.get('publish-btn'), 'click')
  assert.ok(boot.posted.some(m => m.type === 'publish' && m.published === true))
})

test('the room chip reports published state in words, not only colour', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'room', room: { name: 'r', published: true, advertised: 'http://100.1.2.3:8787/?token=x', members: [] } } })
  assert.match(boot.get('room-chip').textContent, /Published/)
})

test('a member name is rendered as text, never as markup', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'room', room: { name: 'r', published: false, members: [
    { id: '1', name: '<img src=x onerror=alert(1)>', role: 'member' },
  ] } } })
  // Nothing asserts on innerHTML because nothing may set it; this asserts the
  // name survived as literal text.
  const rows = boot.get('room-members').children
  assert.ok(JSON.stringify(rows).includes('<img src=x onerror=alert(1)>'))
})

test('choosing a permission mode tells the host and updates the chip', () => {
  const boot = bootWebview()
  boot.fire(boot.get('permission-chip'), 'click')
  const rows = boot.get('permission-list').children
  boot.fire(rows[0], 'click')
  assert.ok(boot.posted.some(m => m.type === 'permission-mode'))
})

test('bypass all asks for confirmation before it is sent', () => {
  // It is the one destructive entry, and must never be a single click.
  const boot = bootWebview()
  boot.fire(boot.get('permission-chip'), 'click')
  const bypass = [...boot.get('permission-list').children].find(r => JSON.stringify(r).includes('Bypass'))
  boot.fire(bypass, 'click')
  assert.ok(!boot.posted.some(m => m.type === 'permission-mode' && m.mode === 'bypassPermissions'),
    'one click must not enable bypass')
})
```

- [ ] **Step 2–4: Implement, style, and shoot**

Follow the context panel's structure exactly — it is the pattern for a
chip-owned popover. Add `room` and `permission-modes` fixtures with
`INTERACTIONS` clicking each chip, then:

```bash
node --test
node extension/harness/shoot.js room
node extension/harness/shoot.js permission-modes
```

**Read the PNGs.** Check the destructive row is distinguishable by more than
colour, that a long join URL wraps rather than widening the popover, and that
both fit at 380px.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/harness
git commit -m "feat(chat): room and permission chips"
```

---

## Verification

```bash
node --test                       # 0 failures
node extension/harness/shoot.js   # every fixture, both themes, both widths
```

Read every PNG against design §9.

**Left for the user's own pass, because no test may bind a non-loopback
socket:** that publishing actually makes the room reachable from another
machine, that a join link opens for a second person, and that a permission-mode
change really does keep the conversation — the recipe is asserted, the resumed
transcript is not.
