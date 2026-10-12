# Claude Room Orchestrator

A VS Code extension that packages [claude-room](../README.md) as one chat
window backed by a long-lived Claude Code session. The orchestrating Claude
delegates mechanical work to cheap OpenCode workers instead of doing it all
itself.

## Status

Under active development. This tree is CommonJS (`extension/package.json` has
no `"type"` field), independent of the ESM room server in the repo's `src/`.

**Working:** the chat, with streaming prose, rendered markdown, collapsible
tool cards and a live thinking indicator; a model picker (`/model` works in
headless print mode, and switching genuinely takes effect); process supervision
with tree-kill; crash recovery via `--resume`; and the full delegation round
trip, worker result included.

**Not built yet**, and specified in
[`../docs/superpowers/specs/2026-09-05-orchestrator-parity-design.md`](../docs/superpowers/specs/2026-09-05-orchestrator-parity-design.md):
login detection and guidance, conversation history, skill and slash-command
completions, a settings surface, and the workers panel.

**Unverified:** the webview's appearance. Everything else here has been run
against real binaries; nothing has ever *looked* at the chat.

### If you edit the webview, read this first

The chat is three plain `<script>` tags — `markdown.js`, `model.js`,
`webview.js` — and they **share one global scope**. Two bugs in a row came from
that, and both silently killed the entire chat (no send button, no Enter, no
error the user could see):

1. `markdown.js` exposed itself only through `module.exports`, so
   `window.ClaudeMarkdown` was undefined and `webview.js` threw on its first
   line.
2. `markdown.js` and `model.js` both declared a top-level `const api` — a
   SyntaxError that made the *second* script fail to parse entirely.

Neither was visible to any unit test, because the tests import through
`module.exports` while the browser loads script tags.
[`test/webview-boot.test.js`](test/webview-boot.test.js) now loads all three
together the way a browser does and drives the Enter handler to assert a
message is actually posted. **Keep top-level names unique across those files**,
and if you add a module, add it to that test.

### Your own seat

When a folder is open, starting the room also gives Claude Code in that folder its own
agent seat, `<your-os-user>-claude` (`local-seat.js`), and writes
`<folder>/.claude/room-seat.local.json` (`room_url`, `seat_handle`, `seat_token`) for the
[`room-seat` plugin](../mod/README.md) to join with, with no copy-paste (the plugin only uses the file when it points at this machine). The file is
owner-only where the OS honours that, written atomically, and added to the repo's
`.git/info/exclude` so it is never committed. An existing seat is reused, and the file always gets
the seat's current token from the room's own `members.json`, so a lost file or a `room-admin
rotate` is repaired at the next room start. Nothing is written if git tracks the file, or if
a seat with that handle belongs to someone else. The file holds the loopback address even when the room
is published, since the plugin runs on this machine. If the seat cannot be made, the Claude Room
output channel says `local seat not set up: <reason>` and the room carries on.

## Development

```bash
cd extension
npm test          # 80 tests
```

Or `node --test` from the repo root to run these alongside the room's own
suite in one invocation.

The extension's own code has no runtime `require` beyond Node built-ins and
`vscode`, and no build step. A VS Code API of 1.75 or newer is assumed — see
below for what that means in practice. (`@modelcontextprotocol/sdk` is a
`dependency` only so the bundled room can ship with it; see "Installing".)

## Editors: VS Code and Cursor

This is a standard VS Code extension and it runs in **Cursor** as well, which
is a VS Code fork. The API surface it uses is small and old — `createWebviewPanel`,
`asWebviewUri`, `cspSource`, `storageUri`, `globalStorageUri`, `workspaceState`,
`registerCommand`, `showErrorMessage`, `createOutputChannel` — and the newest
of those (`storageUri`) landed in VS Code **1.48**.

`engines.vscode` is set to `^1.75.0` rather than that true floor, because 1.74
is where VS Code began generating activation events automatically from
`contributes.commands`. That is what lets `activationEvents` stay empty: below
1.74 the commands would appear in the palette and silently do nothing, which is
a much worse failure than refusing to install.

For reference, Cursor 3.17.8 reports itself to extensions as VS Code
**1.128.0**, so it clears that bar comfortably.

### Running it from source (either editor)

Press **F5** with this repo open. `.vscode/launch.json` at the repo root points
the Extension Development Host at `extension/`, which it has to do explicitly
because the extension is not at the repo root.

The equivalent from a terminal:

```bash
code  --extensionDevelopmentPath="<repo>/extension"    # VS Code
cursor --extensionDevelopmentPath="<repo>/extension"   # Cursor
```

From a repo checkout the room is the checkout's own `src/`, even if a stale
`extension/room/` exists, so your edits to `src/` are what runs.

## Installing

- **VS Code:** install from a `.vsix`: `code --install-extension <file>.vsix`,
  or Extensions view → `…` → **Install from VSIX…**. The Marketplace listing is
  0.0.1, which predates the bundled room: it cannot start a room without a
  clone of this repo beside it. Use the `.vsix` until 0.0.2 is published.
- **Cursor (and any Open VSX editor):** Cursor installs from Open VSX, not the
  VS Code Marketplace, so the Marketplace listing does not appear in its
  library. Install a `.vsix` today: `cursor --install-extension <file>.vsix`.
  Publishing to Open VSX (`npx ovsx publish <file>.vsix -p <token>`, which needs
  an Open VSX account and namespace) is not done yet, so it is not listed there.
- **Building the `.vsix` yourself:**

  ```bash
  cd extension
  npm install                     # the room's SDK ships in the package's node_modules
  npx @vscode/vsce package        # produces claude-room-orchestrator-0.0.2.vsix (~4.9 MB)
  ```

  `vsce package` runs `vscode:prepublish` (`node ../scripts/bundle-room.mjs`),
  which copies the room's runtime files into `extension/room/` (git-ignored
  build output). Installed from a `.vsix`, the extension runs that bundled
  copy; no repo checkout is needed.

### What it needs on your machine

- **Workers:** open a folder that is a git repository. The room is started with
  `ROOM_REPO` set to the first open workspace folder, and worker worktrees go in
  `<that folder>/.worktrees/<handle>`. If it is not a git repo, spawning is
  refused with "workers need a git repository: <path> is not one — open a git
  project folder (or set ROOM_REPO) and try again". With no folder open,
  adding a worker is refused with "Open a folder first: Claude Room workers
  run in your open project's git repository." Refusals show as an error
  notification as well as in the Claude Room Output channel.
- **Worker tools on PATH:** `git`, `opencode`, and `node` (18 or newer).
  Each worker's OpenCode registers the room's reply bridge as `node <bridge>`,
  so workers need a system Node even though the room itself does not (see
  below). The orchestrator chat's MCP bridge runs under `node` too.
- **What workers leave in your repo:** each worker creates a branch named after
  it (`worker-1`, `worker-2`, …) and a worktree at `.worktrees/worker-N`.
  `.worktrees/` is added to the repo's local exclude file
  (`.git/info/exclude`, never your tracked `.gitignore`), so it stays out of
  `git status` and `git add -A`. Stopping a worker does not delete either; to
  clean one up, from the repo root:

  ```bash
  git worktree remove .worktrees/worker-1
  git branch -D worker-1
  ```
- **Orchestrator chat:** `claude` on PATH.
- **Node.js:** not needed for the room itself. It is launched with the editor's
  own `process.execPath`. Workers and the chat bridge do need it, as above.
- **Room state:** kept per workspace (VS Code's workspace storage), so two
  windows on two folders run two independent rooms. With no folder open it
  falls back to the extension's global storage.

## Manual verification

The automated suite covers every pure module (`stream.js`, `supervisor.js`,
`room-client.js`, `orchestrator.js`, `events.js`). `extension.js` and
`src/chat/panel.js` require the real `vscode` module and can only run inside
a VS Code Extension Development Host, which cannot be launched from a
terminal or CI. What was actually checked for this pair of tasks:

- `node --check` on every CommonJS file in `extension/src` — confirms each
  parses as valid JavaScript.
- Requiring `stream.js`, `supervisor.js`, `room-client.js`, `orchestrator.js`
  and `events.js` outside VS Code and asserting their exports — confirms the
  pure module wiring is sound.
- Requiring `extension.js` and `src/chat/panel.js` outside VS Code and
  confirming they fail with `Cannot find module 'vscode'` — confirms they
  only depend on the `vscode` API being present, not on anything else being
  wrong.
- The full repository suite (`node --test` from the repo root) still passes
  at the same count as before these two tasks, plus the new `events.test.js`
  cases.

**The F5 walkthrough has since been run, in Cursor, and it found two real
bugs.** What it established:

- the extension loads and activates in Cursor (3.17.8, reporting VS Code
  1.128.0), and the command opens the chat panel
- the panel needs a folder open in that window — without one it correctly says
  so rather than failing obscurely
- **sending was broken.** Both script-loading bugs described under "If you edit
  the webview" were found this way and nowhere else. They are fixed, and
  `test/webview-boot.test.js` now guards the class.
- **the layout did not match Claude Code.** It rendered as an unstyled form: a
  bare textarea, a rectangular Send button, and a large empty area. That drove
  the markdown renderer and the composer restyle.

Still not re-confirmed by eye **after** those fixes. The steps below remain the
thing to run; record what you see.

### Task 6 steps (chat webview + extension host)

```
1. Open this repo in VS Code, F5 to launch the Extension Development Host.
2. Run "Claude Room: Open Orchestrator Chat".
3. Ask: "What files are in src/? Just list them."
4. Confirm: prose streams in; the Glob/Bash tool call renders as a card with
   its result; the thinking indicator appears and clears; cost shows at the
   end.
5. Close the window; confirm no `node` or `claude` process is left behind
   (Task 2's tree-kill).
```

**Result: partially verified — everything except the webview itself.**

A headless harness composed this extension's own modules (`createSupervisor`,
`roomRecipe`, `readOwnerToken`, `createRoomClient`, `bridgeMcpConfig`,
`orchestratorRecipe`, `createOrchestrator`) against the **real** `server.mjs`
and the **real** `claude` binary, with only VS Code absent. It passed:

- the room started, wrote its roster, and `readOwnerToken` found the token in it
- the orchestrator started and reported back the session id we generated
- a real turn ran end to end: `Read` tool call → tool result → text →
  turn-end, and the answer contained the file's actual contents
- **every** event kind `stream.js` handles was exercised — `session`,
  `thinking-tokens`, `tool`, `tool-result`, `rate-limit`, `text`, `turn-end`
- `stopAll()` left both statuses `stopped` with null pids, and a process sweep
  found no strays: tree-kill confirmed against real processes

**Still unverified: the webview.** Steps 3–4 above (streaming render, tool
cards, thinking indicator, cost) need a real VS Code host and have not been
run. Record the outcome here the first time someone does.

### Task 7 steps (delegation wired into the chat)

```
1. Launch the Extension Development Host and open the chat.
2. Ask the orchestrator to delegate: "Delegate adding a mul(a,b) function to
   math.js to @opencode - give it files and tests."
3. Confirm: the delegate tool card appears; the worker's result comes back as
   a relayed turn; the orchestrator responds to it.
```

This needs a worker seat running — until the OpenCode worker task (next
plan's Task 1) exists, verify by hand with `scripts/room-opencode-seat.mjs`
launched against the extension's room port (visible in the "Claude Room"
output channel).

**Result: the relay is verified; only the chat rendering of it is not.**

A second headless harness ran a **real** room, a **real** OpenCode worker
(`opencode/mimo-v2.5-free`), a **real** `POST /api/delegate`, and the room's
**real** SSE feed through this extension's own `createEventRouter`. It passed:

- the delegation result came back with an id matching the call
- the relayed line was
  ``[worker @opencode reports] Added `export function mul(a, b)` to `math.js`
  (returns `a * b`). Syntax verified with `node --check math.js` — passed.``
- the worker ran the command named in `spec.tests` without being asked to
- activity events carried `handles: opencode`, confirming the `dest`→`handle`
  normalisation

That check exists because the first whole-branch review found this exact path
was broken: the delegation event carried no `text`, so the orchestrator was
being told `[worker @opencode reports] undefined`. The unit test could not see
it — its fixture invented a `text` field the real producer never sent. The
harness above talks to the real producer, which is why it would have caught it.

**Still unverified: the chat rendering** of the delegate tool card and the
relayed turn, which needs a real VS Code host.

## Installed package verification (2026-10-10)

Packaged with `npx @vscode/vsce package` (0.0.2) and run from an unzipped copy far from the checkout.

- Package: 3189 files, 4.91 MB (5,150,258 bytes). `vsce ls`: 3187 files.
- Contents: `room/src/server.mjs`, `room/src/orchestrator-bridge.mjs`, `room/mod/lib/protocol.mjs`, `room/scripts/room-opencode-seat.mjs` and `node_modules/@modelcontextprotocol/sdk` present; no `.claude/`, no `*.test.*` outside node_modules, no `room/mod/.claude-plugin/types/`.
- Boot: `ROOM_STANDALONE=1 ROOM_PORT=0 ROOM_STATE_DIR=<tmp>` on the unpacked `room/src/server.mjs` printed "listening on http://127.0.0.1:<port>".
- Worker with `ROOM_REPO=<fresh temp git repo>`: `POST /api/spawn-worker` returned `{"ok":true,"handle":"worker-1"}`; worktree created at `<repo>/.worktrees/worker-1`, opencode connected; nothing created inside the unpacked extension.
- Worker without `ROOM_REPO` (cwd = unpacked `room/`): the POST still returned `{"ok":true,"handle":"worker-1"}`, but the seat crashed on `git worktree add <room>/.worktrees/worker-1` (status 128, git's own message not surfaced), the room logged "worker-1 exited with code 1", and no `.worktrees` was created in the extension. At that commit the failure was visible only in the room log, not in the spawn response.
  After the fix (bf5794d) the same POST returns `ok:false` with "workers need a git repository: <path> is not one — open a git project folder (or set ROOM_REPO) and try again"; nothing is minted or spawned and no `.worktrees` is created (checked against a standalone room with `ROOM_REPO` set to a non-git temp dir).
- Cleanup note: in the test harness only the room's own PID was killed, which left the worker's `seat.mjs` and `opencode serve` running; they had to be stopped by hand. The extension's supervisor kills the whole process tree (`taskkill /F /T`), so this is a harness artifact, not verified against the extension itself. No stray processes remain.
