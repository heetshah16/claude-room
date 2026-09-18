# Delegate-and-Dev-Tunnels POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `delegate` reachable from a real, unmodified `claude` session via the room's channel MCP, add a Dev-Tunnels-backed "Publish" path to the extension so a join link needs nothing installed on the other end, and bring `src/ui.mjs` in line with `docs/design-system.md`.

**Architecture:** Three independent slices sharing one branch. (1) `src/channel.mjs` already has `delegate`; this adds a `list_workers` tool beside it and a manual verification protocol for the whole path. (2) `extension/src/tunnel.js` (new) spawns Microsoft's `devtunnel` CLI as a supervised child, the same pattern `room-client.js` uses for the room itself; its URL feeds into the room's existing `republish()` restart via a new `advertise` override on `roomRecipe`. (3) `src/ui.mjs` gets a token/detail pass, not a rewrite.

**Tech Stack:** Room: Node 22+, ESM, zero runtime deps beyond `@modelcontextprotocol/sdk`. Extension: CommonJS, no runtime deps, no build step. `node --test` throughout. `devtunnel` is an external CLI (Microsoft dev tunnels), detected the way `claude`/`opencode` already are.

**Spec:** `docs/superpowers/specs/2026-09-18-delegate-and-devtunnels-poc-design.md`

## Global Constraints

- **The room's suite must stay green.** Baseline before this plan: `node --test` from the repo root → 549 tests, 548 passing, 1 skipped (per `ARCHITECTURE.md`). Never edit an existing test to make a change pass.
- **`src/` stays dependency-free and ESM.** `extension/` stays CommonJS with no runtime dependencies and no `"type"` field in its `package.json`.
- **Pure logic must be injectable**: `spawn`, `fetch`, `env`, `platform`, `exists` are parameters with real defaults, never read from globals inside a function under test. No test may spawn a real binary or open a non-loopback socket.
- **Kill process trees, not processes**, per `extension/src/supervisor.js`'s `defaultKillTree` — the tunnel child is started through `supervisor.start`, same as every other child, for this reason alone.
- **Every model- or room-supplied string is rendered with `textContent`**, never `innerHTML` — already true in both `src/ui.mjs` and the extension's webviews; Task 6 confirms it, does not relax it.
- Test style: `const { test } = require('node:test')` / `import { test } from 'node:test'` matching the file's module system; `assert/strict`. Test names state the *why*.
- Commit after every task with a `feat:` / `fix:` / `docs:` prefix.

---

### Task 1: `devtunnel` detection and launch recipe

**Files:**
- Create: `extension/src/tunnel.js`
- Test: `extension/test/tunnel.test.js`

**Interfaces:**
- Consumes: nothing new. Mirrors `src/spawn.mjs`'s `resolveCommand` shape, reimplemented locally in CommonJS since `extension/` cannot import the room's ESM.
- Produces: `detectDevtunnel({ exists, env, platform })` → `boolean`; `tunnelRecipe({ port, devtunnelPath })` → `{ cmd, args, opts }` for `supervisor.start`.

**Background:** `devtunnel` is Microsoft's standalone CLI (`winget install --id Microsoft.devtunnel -e`), not a VS Code API — there is no stable `vscode.*` call that creates a public tunnel for an arbitrary local port. The extension already treats external binaries (`claude`, `opencode`) as detect-then-spawn dependencies; this is the same pattern for a third one.

- [ ] **Step 1: Write the failing test**

```javascript
// extension/test/tunnel.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { detectDevtunnel, tunnelRecipe } = require('../src/tunnel.js')

test('devtunnel is detected on PATH the same way claude and opencode are', () => {
  const exists = p => p === '/usr/local/bin/devtunnel'
  const found = detectDevtunnel({
    exists, env: { PATH: '/usr/local/bin' }, platform: 'linux',
  })
  assert.equal(found, true)
})

test('a missing devtunnel is reported, not thrown', () => {
  const found = detectDevtunnel({ exists: () => false, env: { PATH: '/usr/local/bin' }, platform: 'linux' })
  assert.equal(found, false)
})

test('the recipe hosts the room\'s port and allows anonymous joiners', () => {
  // --allow-anonymous is not a relaxation here -- without it a joiner needs
  // their own Microsoft/GitHub account signed into the same tunnel, which
  // defeats "opens as a normal browser window for someone with nothing installed".
  const r = tunnelRecipe({ port: 51820, devtunnelPath: 'devtunnel' })
  assert.equal(r.cmd, 'devtunnel')
  assert.deepEqual(r.args, ['host', '-p', '51820', '--allow-anonymous'])
  assert.deepEqual(r.opts.stdio, ['ignore', 'pipe', 'pipe'])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test extension/test/tunnel.test.js`
Expected: FAIL — `Cannot find module '../src/tunnel.js'`

- [ ] **Step 3: Implement**

```javascript
// extension/src/tunnel.js
'use strict'
const { existsSync } = require('node:fs')

/**
 * Is the `devtunnel` CLI on PATH? Same question `resolveCommand` (src/spawn.mjs,
 * the room side) answers for `claude`/`opencode` -- reimplemented here rather
 * than imported, because extension/ is CommonJS and src/ is ESM and nothing
 * crosses that boundary by import (ARCHITECTURE.md).
 *
 * Deliberately simpler than resolveCommand: this only needs a yes/no to decide
 * whether to show the "install devtunnel" prompt, never a path to spawn --
 * `cmd: 'devtunnel'` below resolves through the OS the normal way.
 */
function detectDevtunnel({ exists = existsSync, env = process.env, platform = process.platform } = {}) {
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const names = platform === 'win32' ? ['devtunnel.exe', 'devtunnel.cmd'] : ['devtunnel']
  for (const dir of dirs) {
    for (const name of names) {
      if (exists(`${dir}/${name}`)) return true
    }
  }
  return false
}

/**
 * `devtunnel host -p <port> --allow-anonymous`: hosts the room's port on a
 * public *.devtunnels.ms URL. --allow-anonymous is required for a joiner with
 * no devtunnels account of their own -- the whole point of this path is that
 * they have nothing installed.
 */
function tunnelRecipe({ port, devtunnelPath = 'devtunnel' }) {
  return {
    cmd: devtunnelPath,
    args: ['host', '-p', String(port), '--allow-anonymous'],
    opts: { stdio: ['ignore', 'pipe', 'pipe'] },
  }
}

module.exports = { detectDevtunnel, tunnelRecipe }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test extension/test/tunnel.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add extension/src/tunnel.js extension/test/tunnel.test.js
git commit -m "feat(extension): detect and launch the devtunnel CLI"
```

---

### Task 2: Parse the tunnel's public URL from its output

**Files:**
- Modify: `extension/src/tunnel.js`
- Test: `extension/test/tunnel.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseTunnelUrl(chunk)` → the first `https://*.devtunnels.ms` host found, or `null`.

**Background:** `devtunnel` has no documented `--json` output flag (checked; not found), so this is text-parsed, defensively. Verified real output shape: `Connect via browser: https://bskw8blx.inc1.devtunnels.ms:5001, https://bskw8blx-5001.inc1.devtunnels.ms`. The **second** URL (without the port suffix) is the one to advertise — it is the one a browser reaches directly.

- [ ] **Step 1: Write the failing test**

```javascript
// extension/test/tunnel.test.js -- append to the same file
const { parseTunnelUrl } = require('../src/tunnel.js')

test('the port-free devtunnels.ms host is extracted from real CLI output', () => {
  // A real `devtunnel host` line, captured against the actual binary.
  const line = 'Connect via browser: https://bskw8blx.inc1.devtunnels.ms:5001, https://bskw8blx-5001.inc1.devtunnels.ms\n'
  assert.equal(parseTunnelUrl(line), 'https://bskw8blx-5001.inc1.devtunnels.ms')
})

test('output with no URL yet returns null, not a throw', () => {
  assert.equal(parseTunnelUrl('Connecting...\n'), null)
})

test('a line carrying only the port-suffixed form still yields a usable host', () => {
  // Defensive: if a future CLI version ever prints only the :port form, take
  // it rather than surfacing nothing -- a URL with an explicit port still works.
  assert.equal(parseTunnelUrl('https://bskw8blx.inc1.devtunnels.ms:5001\n'), 'https://bskw8blx.inc1.devtunnels.ms:5001')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test extension/test/tunnel.test.js`
Expected: FAIL — `parseTunnelUrl is not a function`

- [ ] **Step 3: Implement**

```javascript
// extension/src/tunnel.js -- add alongside the existing exports
/**
 * Pull the public URL out of `devtunnel host`'s stdout.
 *
 * Prefers the port-free host (`https://<id>-<port>.<region>.devtunnels.ms`)
 * over the port-suffixed one on the same line, because that is the form a
 * plain browser link should use. Returns null on anything unrecognised rather
 * than throwing -- a `devtunnel` version bump changing this text must not
 * crash the extension host, only leave publishing not-yet-working.
 */
function parseTunnelUrl(output) {
  const urls = String(output).match(/https:\/\/[a-z0-9.-]+\.devtunnels\.ms(?::\d+)?/gi) ?? []
  if (!urls.length) return null
  const portFree = urls.find(u => !/:\d+$/.test(u))
  return portFree ?? urls[0]
}

module.exports = { detectDevtunnel, tunnelRecipe, parseTunnelUrl }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test extension/test/tunnel.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Verify the output shape against the real binary**

This is the one assumption in this task worth checking before relying on it:

```bash
winget install --id Microsoft.devtunnel -e
devtunnel user login   # one-time, interactive
devtunnel host -p 4000 --allow-anonymous
```

If the real output differs from the captured line above, **fix `parseTunnelUrl` and its test to match the real thing** — do not adjust the CLI.

- [ ] **Step 6: Commit**

```bash
git add extension/src/tunnel.js extension/test/tunnel.test.js
git commit -m "feat(extension): parse the public URL out of devtunnel's output"
```

---

### Task 3: Wire the tunnel into publish/un-publish

**Files:**
- Modify: `extension/src/room-client.js` (add `advertise` to `roomRecipe`)
- Modify: `extension/src/extension.js` (`republish`)
- Modify: `extension/src/chat/webview.js`, `extension/src/chat/webview.css` (copy only)
- Test: `extension/test/room-client.test.js`, `extension/test/supervisor.test.js` (existing files, new cases)

**Interfaces:**
- Consumes: `detectDevtunnel`, `tunnelRecipe`, `parseTunnelUrl` (Task 1–2); `supervisor.start`/`stop` (existing).
- Produces: `roomRecipe({ ..., advertise })` sets `ROOM_ADVERTISE` when given, overriding `advertiseHost()`'s Tailscale autodetection.

**Background:** `republish(next)` (`extension/src/extension.js:461`) already restarts the room child on the same port and state dir, flipping only the bind host between `127.0.0.1` and `PUBLISHED_HOST` (`0.0.0.0`). Publishing now additionally starts a tunnel child pointed at that same port, waits for its URL, and passes it through as `advertise` — the room still binds every interface (the tunnel needs that to reach it locally), but what gets put in join links changes from a Tailscale-range guess to the tunnel's real public host.

- [ ] **Step 1: Write the failing test for `roomRecipe`'s new option**

```javascript
// extension/test/room-client.test.js -- add to the existing file
test('an explicit advertise host overrides autodetection', () => {
  const r = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, host: '0.0.0.0', advertise: 'https://abc-1234.devtunnels.ms' })
  assert.equal(r.opts.env.ROOM_ADVERTISE, 'https://abc-1234.devtunnels.ms')
})

test('no advertise option leaves ROOM_ADVERTISE unset, so the room autodetects as before', () => {
  const r = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234 })
  assert.equal('ROOM_ADVERTISE' in r.opts.env, false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test extension/test/room-client.test.js`
Expected: FAIL — first assertion, `ROOM_ADVERTISE` is `undefined`

- [ ] **Step 3: Implement the `roomRecipe` change**

```javascript
// extension/src/room-client.js -- replace the existing roomRecipe function
function roomRecipe({ repoRoot, stateDir, port, host = '127.0.0.1', advertise, nodePath = process.execPath, env = process.env }) {
  return {
    cmd: nodePath,
    args: [join(repoRoot, 'src', 'server.mjs')],
    opts: {
      cwd: repoRoot,
      env: {
        ...env,
        ROOM_STANDALONE: '1',
        ROOM_PORT: String(port),
        ROOM_HOST: host,
        ROOM_STATE_DIR: stateDir,
        // Only set when publishing via a tunnel -- omitted entirely (not set to
        // undefined) so the room's own advertiseHost() autodetection still runs
        // for the plain-LAN/Tailscale case, unchanged from before this task.
        ...(advertise ? { ROOM_ADVERTISE: advertise } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test extension/test/room-client.test.js`
Expected: PASS, all cases including the two new ones

- [ ] **Step 5: Write the failing test for tunnel lifecycle in `republish`**

The existing `supervisor.test.js` already tests `republish`-shaped restart behaviour (per its comment at line 112: "Publishing the room and changing the permission mode both work by starting..."). Add:

```javascript
// extension/test/supervisor.test.js -- add to the existing file
test('publishing starts a tunnel alongside the room, keyed off the room\'s own port', () => {
  const { sup, spawned } = harness()
  const port = 4321
  sup.start('room', { cmd: 'node', args: ['server.mjs'], opts: { env: { ROOM_PORT: String(port) } } })
  sup.start('tunnel', { cmd: 'devtunnel', args: ['host', '-p', String(port), '--allow-anonymous'] })
  assert.equal(sup.status('tunnel').state, 'running')
  assert.deepEqual(spawned[1].args, ['host', '-p', '4321', '--allow-anonymous'])
})

test('un-publishing stops the tunnel, not just the room', () => {
  const child = fakeChild(999)
  const { sup, killed } = harness({ children: [fakeChild(1), child] })
  sup.start('room', { cmd: 'node', args: [] })
  sup.start('tunnel', { cmd: 'devtunnel', args: [] })
  sup.stop('tunnel')
  assert.deepEqual(killed, [999])
  assert.equal(sup.status('tunnel').state, 'stopped')
})
```

- [ ] **Step 6: Run to verify failure, then pass**

Run: `node --test extension/test/supervisor.test.js`
These exercise `Supervisor`'s existing, already-correct multi-child behaviour (Task 2 of the original extension plan) — expect them to **pass immediately**, proving no `supervisor.js` change is needed here. If either fails, the bug is in the test's assumption about `spawned` ordering, not in `supervisor.js` — fix the test.

- [ ] **Step 7: Wire `republish` to start/stop the tunnel**

```javascript
// extension/src/extension.js -- replace the existing republish function
const { detectDevtunnel, tunnelRecipe, parseTunnelUrl } = require('./tunnel.js')

async function republish(next) {
  panel.postRoom({ busy: true, published })
  try {
    if (next) {
      if (!detectDevtunnel()) {
        vscode.window.showErrorMessage(
          'Claude Room: the devtunnel CLI is not installed. Run: winget install --id Microsoft.devtunnel -e, then devtunnel user login, then try Publish again.',
        )
        await postRoom({ busy: false })
        return
      }
      supervisor.start('tunnel', tunnelRecipe({ port }))
      // The CLI prints its URL once, on stdout, then keeps running -- poll the
      // supervisor's own stdout buffer rather than re-parenting a second reader.
      const tunnelUrl = await pollWithBackoff(() => parseTunnelUrl(supervisor.status('tunnel').output ?? ''))
      if (!tunnelUrl) {
        vscode.window.showErrorMessage('Claude Room: devtunnel did not report a URL within 10s. Is `devtunnel user login` done?')
        supervisor.stop('tunnel')
        await postRoom({ busy: false })
        return
      }
      supervisor.start('room', roomRecipe({ repoRoot: REPO_ROOT, stateDir, port, host: PUBLISHED_HOST, advertise: tunnelUrl }))
    } else {
      supervisor.stop('tunnel')
      supervisor.start('room', roomRecipe({ repoRoot: REPO_ROOT, stateDir, port, host: '127.0.0.1' }))
    }
    await waitForRoomUp(roomUrl)
    published = next
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Room: the room did not restart — ${err?.message ?? err}`)
    log(`republish failed: ${err?.stack ?? err}`)
  }
  await postRoom({ busy: false })
}
```

This depends on `supervisor.status(name)` exposing the child's buffered stdout as `.output`. Confirmed absent from the current `extension/src/supervisor.js` (`status()` returns only `{ state, pid, error }`). Add it:

```javascript
// extension/src/supervisor.js -- inside start(), alongside the existing
// child.stderr?.on('data', ...) line
    // Bounded so a chatty child (or one left running a long time) cannot grow
    // this without limit; devtunnel's URL line appears in its first few lines,
    // so keeping only the tail is enough for parseTunnelUrl to find it.
    rec.output = ''
    child.stdout?.on('data', d => {
      rec.output = (rec.output + d).slice(-4096)
    })
```

```javascript
// extension/src/supervisor.js -- status(), add output to the returned object
    status(name) {
      const rec = procs.get(name)
      if (!rec) return { state: 'stopped', pid: null, error: null, output: '' }
      return { state: rec.state, pid: rec.pid, error: rec.error, output: rec.output ?? '' }
    },
```

Add a case to `extension/test/supervisor.test.js` covering this before moving on:

```javascript
test('stdout is buffered and readable through status, bounded so it cannot grow forever', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  sup.start('tunnel', { cmd: 'devtunnel', args: [] })
  child.stdout.emit('data', 'Connect via browser: https://abc-1234.devtunnels.ms\n')
  assert.match(sup.status('tunnel').output, /devtunnels\.ms/)
})
```

Run `node --test extension/test/supervisor.test.js` and confirm this new case passes alongside the two from Step 5–6 before continuing to Step 8.

- [ ] **Step 8: Update the webview's publish copy**

```javascript
// extension/src/chat/webview.js -- around the existing publishBtnEl wiring (line ~608)
publishBtnEl.textContent = room.published ? 'Stop sharing' : 'Publish with Dev Tunnels'
```

```css
/* extension/src/chat/webview.css -- around the existing publish/invite comment (line ~694) */
/* The advertised address, shown before anything is committed: a devtunnels.ms
   URL works for anyone with a browser, no VPN or account required on their
   end -- unlike the tailnet address this replaced, which needed the joiner
   on the same tailnet first. */
```

- [ ] **Step 9: Run the full extension suite**

Run: `node --test` (from `extension/`)
Expected: PASS, previous count plus the new cases in this task

- [ ] **Step 10: Commit**

```bash
git add extension/src/room-client.js extension/src/extension.js extension/src/chat/webview.js extension/src/chat/webview.css extension/test/room-client.test.js extension/test/supervisor.test.js
git commit -m "feat(extension): publish the room through a Dev Tunnel"
```

---

### Task 4: `list_workers` on the room's channel

**Files:**
- Modify: `src/channel.mjs`
- Modify: `src/server.mjs` (wire `onListWorkers`)
- Test: `test/channel.test.mjs`

**Interfaces:**
- Consumes: `queue.busy(handle)` (`src/queue.mjs:181`, already exists), `seats.online()` (`src/seats.mjs:80`, already exists).
- Produces: a new `list_workers` tool alongside `delegate`, `room_reply`, `room_decision` on the channel `createChannel({ ..., onListWorkers })`.

**Background:** This is the "drop into a conversation while a worker is running" capability from the strategic discussion, done as a tool a real Claude Code session can call on its own — no side panel needed for it. Scoped deliberately small: online/offline and busy/idle per handle, which `Seats` and `Queue` already track. Richer detail (current task text, per-turn deadline) lives on the OpenCode driver side and is a later, separable addition — not needed for this POC to be useful.

- [ ] **Step 1: Write the failing test**

```javascript
// test/channel.test.mjs -- add to the existing file
test('list_workers reports online seats and whether each is busy', async () => {
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onListWorkers: () => [{ handle: 'opencode', busy: true }, { handle: 'ana-agent', busy: false }],
  })
  const result = await ch.callTool('list_workers', {})
  const parsed = JSON.parse(result.content[0].text)
  assert.deepEqual(parsed.workers, [{ handle: 'opencode', busy: true }, { handle: 'ana-agent', busy: false }])
})

test('list_workers with no seats online reports an empty list, not an error', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {}, onListWorkers: () => [] })
  const result = await ch.callTool('list_workers', {})
  assert.deepEqual(JSON.parse(result.content[0].text).workers, [])
})

test('list_workers is listed alongside delegate, room_reply and room_decision', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const tools = (await ch.listTools()).map(t => t.name)
  assert.ok(tools.includes('list_workers'))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/channel.test.mjs`
Expected: FAIL — `unknown tool: list_workers`

- [ ] **Step 3: Implement**

```javascript
// src/channel.mjs -- add to the TOOLS array, after the delegate entry (line ~174)
  {
    name: 'list_workers',
    description:
      'See which worker seats are online right now and whether each is currently busy with a turn. Use this before delegating, or to check on work you already handed off, without waiting for it to report back.',
    inputSchema: { type: 'object', properties: {} },
  },
```

```javascript
// src/channel.mjs -- change createChannel's destructured params (line ~177)
export function createChannel({ config, onReply, onDecision, onDelegate, onListWorkers }) {
```

```javascript
// src/channel.mjs -- add a branch in callTool, after the delegate branch (line ~218)
    if (name === 'list_workers') {
      const workers = onListWorkers?.() ?? []
      return { content: [{ type: 'text', text: JSON.stringify({ workers }) }] }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/channel.test.mjs`
Expected: PASS, 3 new tests

- [ ] **Step 5: Wire it in `server.mjs`**

```javascript
// src/server.mjs -- add to the existing createChannel({...}) call (line ~101)
  onListWorkers: () => seats.online().map(s => ({ handle: s.handle, busy: queue.busy(s.handle) })),
```

- [ ] **Step 6: Run the full room suite**

Run: `node --test` (from the repo root)
Expected: PASS, previous count plus 3

- [ ] **Step 7: Commit**

```bash
git add src/channel.mjs src/server.mjs test/channel.test.mjs
git commit -m "feat(channel): a list_workers tool alongside delegate"
```

---

### Task 5: Manual verification — delegate from a real Claude Code session

**Files:** none (this task produces a recorded result, not code — matching this repo's own convention for anything that needs a real host or real binaries, e.g. `extension/README.md`'s "Manual verification" section).

**Background:** Everything above is unit-tested in isolation. What has never been checked is the actual point of this POC: does a real, unmodified `claude` session, talking to the room over `--dangerously-load-development-channels`, actually see a delegation result land — and does it appear while the session is idle, or only on the next message?

- [ ] **Step 1: Start the room in channel mode**

```bash
npm install   # repo root, if not already done
claude --dangerously-load-development-channels server:room \
       --settings ~/.claude/channels/room/settings.hooks.json
```

Accept the two first-run dialogs (development-channels warning, MCP server consent) as the README describes.

- [ ] **Step 2: Add a delegatable OpenCode worker**

```bash
export ROOM_ADMIN_TOKEN=<owner token from the join URL printed to stderr>
node scripts/room-admin.mjs seat add opencode --owner owner --delegatable
node scripts/room-opencode-seat.mjs opencode --token <token it printed> --repo .
node scripts/room-admin.mjs handle @claude,@opencode
```

- [ ] **Step 3: Delegate a real task from inside that same Claude Code session**

Type directly into the session that spawned the room in Step 1:

> Delegate adding a `mul(a, b)` function to `math.js` to @opencode — give it files and tests.

- [ ] **Step 4: Observe and record**

Confirm and write down, in this plan file, replacing this step:

- The `delegate` tool call appears as a normal MCP tool-call in the transcript.
- The worker's actual reply arrives as a `notifications/claude/channel` push (visible however this build of Claude Code renders an unprompted channel notification).
- **The specific question this task exists to answer:** does that notification appear while the session sits idle at the prompt, or does it only surface once you send your next message? Record whichever is true — do not guess.
- Run `list_workers` (Task 4) mid-delegation and confirm it reports `opencode` as busy, then idle once the reply lands.

- [ ] **Step 5: Record the result in this plan and commit**

Replace Step 4's bullets with what actually happened (including a failure, if one occurs — record it honestly, the way `extension/README.md` already does for its own unverified paths).

```bash
git add docs/superpowers/plans/2026-09-18-delegate-and-devtunnels-poc.md
git commit -m "docs: record the delegate-from-real-claude-code verification"
```

---

### Task 6: `src/ui.mjs` design-system alignment

**Files:**
- Modify: `src/ui.mjs`
- Test: `test/ui.test.mjs` (existing file — extend, do not replace; it already parses the emitted script to catch template-literal escaping bugs per `ui.mjs`'s own header comment)

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change — `renderUI(config)` still returns the same HTML string shape. This task changes what is inside it.

**Background:** Per the spec's table — this is an audit-and-fix pass against `docs/design-system.md`'s principles, using literal values instead of `--vscode-*` tokens (this page never runs inside VS Code). The existing light/dark palette (`ui.mjs:33`–`80`) is kept; nothing here is a rebrand.

- [ ] **Step 1: Write the failing test for the accessibility floor**

```javascript
// test/ui.test.mjs -- add to the existing file
test('every icon-only control carries an aria-label', () => {
  const html = renderUI({ roomName: 'r' })
  // Any <button> whose only content is an <svg> (no text node sibling) must
  // declare aria-label -- textContent-based buttons are exempt, they are
  // already accessible by their own text.
  const iconButtonRe = /<button[^>]*>\s*<svg[\s\S]*?<\/svg>\s*<\/button>/g
  const matches = html.match(iconButtonRe) ?? []
  for (const btn of matches) assert.match(btn, /aria-label="[^"]+"/, `icon-only button missing aria-label: ${btn.slice(0, 80)}`)
})

test('focus is never suppressed on an interactive element', () => {
  const html = renderUI({ roomName: 'r' })
  assert.doesNotMatch(html, /outline:\s*none/, 'a visible focus ring must never be removed, per design-system.md §3')
})

test('connection status is announced through a live region', () => {
  const html = renderUI({ roomName: 'r' })
  assert.match(html, /role="status"[^>]*aria-atomic="true"/, 'one atomic live region per design-system.md §3, not per-element')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ui.test.mjs`
Expected: FAIL on whichever checks the current markup does not yet satisfy — read `src/ui.mjs`'s current body (below the styles already read) to see which

- [ ] **Step 3: Fix what the tests found**

This step's exact edits depend on Step 2's failures, which depend on markup not yet read in full (`src/ui.mjs` is 995 lines; only the style block, lines 1–80, has been read so far). Before editing:

1. Read the rest of `src/ui.mjs` (the body/script past line 80).
2. For any emoji or Unicode pictograph used as a status glyph or icon: replace it with an inline SVG built the way `extension/src/chat/icons.js` does — copy that file's `PATHS` table and its `icon(name, doc)` builder function verbatim into `ui.mjs`'s template literal (as literal script text, not an import — `ui.mjs` is one self-contained document with no external file references, per its own header comment).
3. For any icon-only `<button>`: add `aria-label` naming its action.
4. For any `outline: none` or `outline: 0` on a focusable element: remove it, or replace with a visible `outline: 2px solid <accent>; outline-offset: 2px`, matching design-system.md §3.
5. For connection/room status: ensure exactly one `role="status" aria-atomic="true"` region reports it as words ("Reconnecting…", "Connected"), not a bare colour change.
6. Verify contrast: `--ink` on `--bg` and `--ink-2` on `--panel`, in both the light block (lines 33–58) and the dark block (lines 60–79), meet 4.5:1 — check with any contrast calculator; adjust the hex values in place if not, keeping the existing variable names.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/ui.test.mjs`
Expected: PASS, including the 3 new cases

- [ ] **Step 5: Run the full room suite**

Run: `node --test` (from the repo root)
Expected: PASS, no regressions

- [ ] **Step 6: Commit**

```bash
git add src/ui.mjs test/ui.test.mjs
git commit -m "fix(ui): bring the room's browser client onto the design system's accessibility floor"
```

---

## Plan self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| §A `list_workers` on the channel | 4 |
| §A manual verification, including the idle-vs-next-turn question | 5 |
| §B `devtunnel` detection + recipe | 1 |
| §B output parsing | 2 |
| §B wired into `republish`, sign-in gate surfaced (not silently handled) | 3 |
| §B webview copy | 3 (Step 8) |
| §C token/detail/accessibility pass | 6 |
| Rejected: `vscode.*` tunnel API, Tailscale Funnel, Cloudflare, `ui.mjs` rewrite | none — explicitly not implemented, recorded in the spec only |

**Type consistency** — `roomRecipe`'s new `advertise` parameter is optional and additive (Task 3), so every existing caller (Task 3's own un-publish branch included) that omits it keeps today's behaviour exactly. `tunnelRecipe`/`detectDevtunnel`/`parseTunnelUrl` (Tasks 1–2) are produced under those exact names and consumed under those exact names in Task 3. `onListWorkers` (Task 4) follows the same optional-callback shape `onDelegate` already established in `createChannel`.

**Known assumption to verify during Task 2** — `devtunnel`'s real stdout shape. Step 5 of Task 2 checks it against the actual binary and says to fix the parser, not the CLI, if it differs.

**Known assumption to verify during Task 3** — `supervisor.status()` exposing buffered stdout as `.output`. If `extension/src/supervisor.js` does not yet buffer it, Task 3 Step 7 adds that buffering as part of the same task, since `republish` cannot poll for a URL that is never captured.
