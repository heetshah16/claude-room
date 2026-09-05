# Claude Room Orchestrator

A VS Code extension that packages [claude-room](../README.md) as one chat
window backed by a long-lived Claude Code session. The orchestrating Claude
delegates mechanical work to cheap OpenCode workers instead of doing it all
itself.

## Status

This extension is under active development. This tree is CommonJS
(`extension/package.json` has no `"type"` field), independent of the ESM
room server rooted at the repo's top level in `src/`.

## Development

```bash
cd extension
node --test
```

(`node --test test/` does not reliably discover files when the repo path
contains spaces on Windows — run bare `node --test` from `extension/`
instead, which auto-discovers `test/*.test.js`.)

No runtime dependencies are required. Node 22+ and a VS Code API of 1.75 or
newer are assumed — see below for what that means in practice.

## Editors: VS Code and Cursor

This is a standard VS Code extension and it runs in **Cursor** as well, which
is a VS Code fork. The API surface it uses is small and old — `createWebviewPanel`,
`asWebviewUri`, `cspSource`, `globalStorageUri`, `workspaceState`,
`registerCommand`, `showErrorMessage`, `createOutputChannel` — and the newest
of those (`globalStorageUri`) landed in VS Code **1.44**.

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

### Installing it properly

There is no build step, so packaging is just:

```bash
cd extension
npx @vscode/vsce package        # produces claude-room-orchestrator-0.0.1.vsix
```

Then in either editor: `Ctrl+Shift+P` → **"Extensions: Install from VSIX…"**.
Cursor supports VSIX installation the same way VS Code does.

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

**What was NOT verified — the actual F5 walkthrough was not run.** Nobody
has pressed F5 to launch an Extension Development Host against this build.
The steps below are what to run by hand; until someone runs them, treat the
webview rendering, the SSE wiring, and the tree-kill-on-close behavior as
unverified in a real VS Code window.

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
