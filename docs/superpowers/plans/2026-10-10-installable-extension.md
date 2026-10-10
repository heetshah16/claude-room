# Installable Claude Room extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Claude Room extension works when installed from a `.vsix` (VS Code Marketplace, Open VSX / Cursor), with no clone of this repo, and its workers operate on the folder the user has open.

**Architecture:** At package time a copy step puts the room (`src/`, `mod/lib/` and the rest of `mod/` the room needs, `scripts/room-opencode-seat.mjs`) into `extension/room/`, and the room's one dependency (`@modelcontextprotocol/sdk`) becomes a dependency of the extension package so `vsce` ships it in `extension/node_modules`. At runtime the extension prefers a repo checkout next to it (development, F5) and otherwise uses the bundled copy. The room is started with `ROOM_REPO` = the first open workspace folder, so worker worktrees land in the user's project.

**Tech Stack:** Node 22+ (room, ESM), VS Code extension API (CommonJS, no build step), `@vscode/vsce`, `node:test`.

**Spec:** No separate spec; the design record below carries the decisions and their evidence (found 2026-10-10 while trying to install the extension in Cursor).

## Design record

| Decision | Evidence |
|---|---|
| The installed extension cannot start a room today | `vsce package` output (41 files) holds only `extension/`; `room-client.js:27` runs `<REPO_ROOT>/src/server.mjs` with `REPO_ROOT = path.join(__dirname,'..','..')` (`extension.js:30`), which is `~/.cursor/extensions` when installed |
| Workers branch off the wrong repo | `roomRecipe` sets `cwd: repoRoot` and no `ROOM_REPO`; the room uses `config.repoRoot = ROOM_REPO \|\| process.cwd()` for worktrees |
| Copy at package time, not a bundler | The extension's rule is "no build step"; a copy keeps every room file byte-identical to `src/` and readable in the installed package |
| Prefer the checkout, fall back to the bundle | From source (F5) a stale `extension/room/` from an earlier package must never shadow live `src/` edits |
| Ship the SDK via the extension's own `dependencies` | `vsce` includes production `node_modules` of the extension folder; `src/*.mjs` resolve `@modelcontextprotocol/sdk` by walking up to `extension/node_modules` |
| Node is Electron-as-node | `roomRecipe` uses `process.execPath`; the extension host already runs with `ELECTRON_RUN_AS_NODE`, so the bundled room runs exactly as it does from source |
| `.claude/` must not ship | the current package contains `extension/.claude/settings.local.json` |

## Global Constraints

- Extension code stays CommonJS with no build step; the new dependency is the room's, never `require`d by extension code.
- From a checkout, the extension must run the checkout's `src/` (never a stale bundle).
- The packaged `.vsix` must contain: `room/src/server.mjs`, `room/src/orchestrator-bridge.mjs`, `room/mod/lib/protocol.mjs`, `room/scripts/room-opencode-seat.mjs`, `node_modules/@modelcontextprotocol/sdk`; and must not contain: `.claude/`, any `*.test.*`, `room/mod/.claude-plugin/types/`.
- Workers' worktrees go in the first open workspace folder; with no folder open, spawning a worker fails with a visible reason (no worktree in the extension's install folder).
- Root `node --test`, `extension/` `node --test`, and `mod/` `claude plugin test` stay green.

## Review Focus

1. A stale `extension/room/` left from a previous package while running from source — the checkout must win. Test: Task 1, `roomDir` prefers the checkout.
2. No workspace folder open — the room must not put worktrees inside the extension install. Test: Task 1, `roomRecipe` omits `ROOM_REPO` when none, and Task 3 checks the spawn error.
3. A file the room imports at runtime is missing from the bundle (e.g. `mod/lib`, the opencode launcher). Test: Task 2's bundle test boots the bundled room from a temp dir with no repo nearby.
4. Test files or local settings leaking into the package. Test: Task 3's package content check.
5. The bundled room reads a different `package.json` "type" — `.mjs` must not depend on one. Test: Task 2's boot check.

---

### Task 1: Find the room, and point workers at the open folder

**Files:**
- Modify: `extension/src/room-client.js` (new `roomDir`, `roomRecipe` takes `workRepo`), `extension/src/session.js` (pass `workRepo` through its three `roomRecipe` calls), `extension/src/extension.js` (use `roomDir`, pass the workspace folder)
- Test: `extension/test/room-client.test.js`, `extension/test/session.test.js`

**Interfaces:**
- `roomDir(extensionDir: string, exists = fs.existsSync): string` — `path.join(extensionDir, '..')` when `<that>/src/server.mjs` exists, else `path.join(extensionDir, 'room')`.
- `roomRecipe({ repoRoot, stateDir, port, host, advertise, nodePath, env, workRepo })` — adds `ROOM_REPO: workRepo` to env only when `workRepo` is a non-empty string.
- `createSession({ ..., workRepo })` forwards it to every `roomRecipe` call.

- [ ] **Step 1: Failing tests** in `extension/test/room-client.test.js`:

```js
const path = require('node:path')
const { roomDir } = require('../src/room-client.js')

test('from a checkout the room is the repo next to the extension, even if a bundle exists', () => {
  const ext = path.join('/repo', 'extension')
  const exists = p => p === path.join('/repo', 'src', 'server.mjs') || p === path.join(ext, 'room', 'src', 'server.mjs')
  assert.equal(roomDir(ext, exists), path.join('/repo'))
})

test('installed, the room is the copy bundled inside the extension', () => {
  const ext = path.join('/home/u/.cursor/extensions', 'claude-room.claude-room-orchestrator-0.0.2')
  assert.equal(roomDir(ext, () => false), path.join(ext, 'room'))
})

test('the room is told which repo workers work in, and only when there is one', () => {
  const withRepo = roomRecipe({ repoRoot: '/room', stateDir: '/s', port: 1, env: {}, workRepo: '/proj' })
  assert.equal(withRepo.opts.env.ROOM_REPO, '/proj')
  assert.equal(withRepo.opts.cwd, '/room')
  const without = roomRecipe({ repoRoot: '/room', stateDir: '/s', port: 1, env: {} })
  assert.equal('ROOM_REPO' in without.opts.env, false)
})
```

and in `extension/test/session.test.js`, one test that a session created with `workRepo: '/proj'` starts the room with `ROOM_REPO: '/proj'` (use the file's existing fake supervisor and assert on the recipe passed to `supervisor.start('room', …)`).

- [ ] **Step 2:** `cd extension && node --test test/room-client.test.js test/session.test.js` — FAIL (`roomDir` is not a function; no `ROOM_REPO`).

- [ ] **Step 3: Implement.** In `room-client.js` add (and export):

```js
// Where the room's code is. From a checkout (F5) the repo sits right above the
// extension and must win, so a stale bundle never shadows live src/ edits.
// Installed, there is no repo above it: the room ships inside the extension.
function roomDir(extensionDir, exists = fs.existsSync) {
  const checkout = path.join(extensionDir, '..')
  return exists(path.join(checkout, 'src', 'server.mjs')) ? checkout : path.join(extensionDir, 'room')
}
```

and in `roomRecipe`'s env: `...(typeof workRepo === 'string' && workRepo ? { ROOM_REPO: workRepo } : {}),`. In `session.js` add `workRepo` to `createSession`'s parameters and pass it in all three `roomRecipe({...})` calls. In `extension.js` replace the `REPO_ROOT` block with:

```js
// The room's code: the checkout above this extension when run from source,
// else the copy bundled into the package. See roomDir.
const REPO_ROOT = roomDir(path.join(__dirname, '..'))
```

and in `ensureSession` pass `workRepo: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` to `createSession`.

- [ ] **Step 4:** focused tests PASS; then `cd extension && node --test` → `fail 0`.
- [ ] **Step 5: Commit** `feat(extension): find the room bundled or in the checkout, and run workers in the open folder`.

---

### Task 2: Bundle the room into the extension at package time

**Files:**
- Create: `scripts/bundle-room.mjs`
- Modify: `extension/package.json` (`version` 0.0.2, `dependencies`, `scripts["vscode:prepublish"]`), `extension/.vscodeignore`, `.gitignore` (add `extension/room/`)
- Test: `test/bundle-room.test.mjs`

**Interfaces:**
- `bundleRoom({ repo: string, out: string }): string[]` — copies into `out`: `src/**/*.mjs`, `mod/lib/**`, `mod/feed.mjs`, `mod/hooks/**`, `mod/.claude-plugin/plugin.json`, `scripts/room-opencode-seat.mjs`, and `package.json` (for `"type": "module"`); returns the copied relative paths. Removes `out` first. Skips `*.test.*`, `tests/`, `.claude-plugin/types/`.
- CLI: `node scripts/bundle-room.mjs` writes to `<repo>/extension/room`.

- [ ] **Step 1: Failing test** `test/bundle-room.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bundleRoom } from '../scripts/bundle-room.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))

test('the bundle has everything the room imports at runtime, and no tests', () => {
  const out = mkdtempSync(join(tmpdir(), 'room-bundle-'))
  try {
    bundleRoom({ repo: REPO, out })
    for (const f of ['src/server.mjs', 'src/orchestrator-bridge.mjs', 'mod/lib/protocol.mjs', 'scripts/room-opencode-seat.mjs', 'package.json']) {
      assert.ok(existsSync(join(out, f)), `missing ${f}`)
    }
    assert.equal(existsSync(join(out, 'mod', 'tests')), false)
    assert.equal(existsSync(join(out, 'mod', '.claude-plugin', 'types')), false)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('the bundled room boots on its own, with no repo around it', async () => {
  const out = mkdtempSync(join(tmpdir(), 'room-bundle-'))
  try {
    bundleRoom({ repo: REPO, out })
    // The SDK resolves from the repo's node_modules via NODE_PATH-free symlink-free
    // lookup only if it sits above `out`; point it at the repo's copy explicitly.
    const child = spawn(process.execPath, [join(out, 'src', 'server.mjs')], {
      env: { ...process.env, ROOM_STANDALONE: '1', ROOM_PORT: '0', ROOM_STATE_DIR: join(out, 'state'),
             NODE_PATH: join(REPO, 'node_modules') },
    })
    const err = []
    child.stderr.on('data', d => err.push(String(d)))
    const listening = await new Promise(resolve => {
      const t = setTimeout(() => resolve(false), 10_000)
      child.stderr.on('data', () => { if (/listening on/.test(err.join(''))) { clearTimeout(t); resolve(true) } })
      child.on('exit', () => { clearTimeout(t); resolve(false) })
    })
    child.kill()
    assert.ok(listening, `bundled room did not start:\n${err.join('')}`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
```

Note for the implementer: ESM ignores `NODE_PATH`. If the boot test fails with `ERR_MODULE_NOT_FOUND` for `@modelcontextprotocol/sdk`, create the temp dir *inside* the repo (e.g. `mkdtempSync(join(REPO, '.bundle-test-'))`, git-ignored via `.gitignore` entry `.bundle-test-*/`) so resolution walks up to the repo's `node_modules`, and drop `NODE_PATH`. Record which one you used.

- [ ] **Step 2:** `node --test test/bundle-room.test.mjs` — FAIL (no `scripts/bundle-room.mjs`).

- [ ] **Step 3: Implement `scripts/bundle-room.mjs`** with `node:fs` `cpSync`/`rmSync`/`readdirSync` only (no dependencies), exporting `bundleRoom` and running it for `<repo>/extension/room` when invoked directly (same `isMain` pattern as `src/seat.mjs`). Log the file count to stderr.

- [ ] **Step 4: Wire packaging.** `extension/package.json`: `"version": "0.0.2"`, `"dependencies": { "@modelcontextprotocol/sdk": "<same range as the root package.json>" }`, `"scripts": { "test": "node --test", "vscode:prepublish": "node ../scripts/bundle-room.mjs" }`. `extension/.vscodeignore`: add `.claude/**`, `**/*.test.mjs`, `**/*.test.tsx`, `room/mod/tests/**`, `room/mod/.claude-plugin/types/**` (keep `node_modules/**` OUT of the ignore list — delete that line so production `node_modules` ship; `vsce` excludes devDependencies itself). `.gitignore`: add `extension/room/`. Run `cd extension && npm install` and commit `extension/package-lock.json`.

- [ ] **Step 5:** `node --test test/bundle-room.test.mjs` PASS; root `node --test` and `extension/` `node --test` `fail 0` (the extension suite must not pick up `extension/room/**/*.test.*` — the bundle excludes tests, verify the count is unchanged).
- [ ] **Step 6: Commit** `feat(extension): ship the room inside the package`.

---

### Task 3: Package, inspect, and boot from the package

No new code unless a check fails.

- [ ] **Step 1:** `cd extension && npx --yes @vscode/vsce package --out <scratch>/claude-room-0.0.2.vsix`, then `npx --yes @vscode/vsce ls`. Expected: the Global Constraints' must-contain list present, must-not-contain list absent. Record the file count and `.vsix` size.
- [ ] **Step 2: Boot from the unpacked package.** Unzip the `.vsix` to a temp dir far from the repo; run `<tmp>/extension/room/src/server.mjs` with `ROOM_STANDALONE=1 ROOM_PORT=0 ROOM_STATE_DIR=<tmp>/state`; expect "listening on". This is the real proof that nothing resolves back into the checkout.
- [ ] **Step 3: Workers in the open folder, from the package.** Same unpacked room with `ROOM_REPO=<a fresh temp git repo>`; seat-add nothing, just `POST /api/spawn-worker` as owner; expect the worktree under `<temp repo>/.worktrees/worker-1` and none under the unpacked extension. Then the same without `ROOM_REPO` and with cwd = the unpacked room dir: expect the spawn to fail with a visible reason (not a worktree inside the extension). Stop everything; confirm no `opencode`/room process survives.
- [ ] **Step 4:** Record results in `extension/README.md` under a dated "Installed package verification" entry; commit `docs(extension): verify the packaged extension runs without the repo`.

---

### Task 4: Docs

**Files:** `extension/README.md` (install section: VS Code Marketplace, Cursor via Open VSX or `cursor --install-extension <file>.vsix`; workers use the first open folder), `CLAUDE.md` (gotchas: the room is copied into `extension/room/` at package time by `vscode:prepublish`; from source the checkout wins; `extension/node_modules` now holds the room's SDK).

- [ ] **Step 1:** Write both, factually matching Tasks 1-3.
- [ ] **Step 2: Commit** `docs: installing the extension in VS Code and Cursor`.

---

### Task 5: Install in Cursor and publish (user-run steps)

- [ ] **Step 1 (agent):** `cursor --install-extension <scratch>/claude-room-0.0.2.vsix --force`; confirm with `cursor --list-extensions --show-versions`.
- [ ] **Step 2 (user):** Fully restart Cursor, open a project folder, open the Claude Room view; the "Claude Room" Output channel shows the room starting from the installed path. Spawn a worker; its worktree appears in the open project.
- [ ] **Step 3 (user, needs credentials):** publish 0.0.2 to the VS Code Marketplace (`vsce publish`) and to Open VSX (`npx ovsx publish <vsix> -p <token>`; needs an Open VSX account and the `claude-room` namespace) so Cursor's library finds it.
