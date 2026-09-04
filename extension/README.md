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

No runtime dependencies are required. Node 22+ and VS Code 1.90+ are assumed.

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

**Result: not yet run.** Record the actual outcome here (including any
failure) the first time someone runs this.

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

**Result: not yet run.** Record the actual outcome here (including any
failure) the first time someone runs this.
