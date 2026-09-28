# claude-room — working notes for Claude

Read `ARCHITECTURE.md`, `docs/design-system.md`, and `extension/README.md` first — this file only adds what those don't cover: practical gotchas discovered while actually running and testing this project.

## Repo shape

- `src/` — the room server (ESM, `.mjs`). Runs standalone (`ROOM_STANDALONE=1`) or as an MCP stdio child.
- `extension/` — the VS Code/Cursor extension (CommonJS, zero runtime deps, no build step, no `"type"` field).
- `scripts/` — launchers (`room-opencode-seat.mjs` etc.).
- `docs/superpowers/plans/` and `docs/superpowers/specs/` — the design specs and implementation plans this codebase was built from. `.superpowers/sdd/*/progress.md` are the execution ledgers (task-by-task record of what was built, reviewed, and found).

Run tests from the repo root (`node --test`, room-side) and from `extension/` separately (`node --test`, extension-side) — two independent suites, both plain `node:test`, no framework.

## Extension development gotchas (all found the hard way)

- **A code change to anything under `extension/src/` needs a fresh Extension Development Host launch to take effect.** Node caches `require()`'d modules for the life of the host process; nothing short of relaunching picks up an edit. Room-side (`src/*.mjs`) changes do NOT need this — they take effect on the next spawned room process (any republish or fresh session start reads current disk content).
- **A Windows process the extension kills is not necessarily dead when the kill call returns.** `taskkill /F` used to be fire-and-forget; if you see stale data right after a room restart (an old devtunnel address, ECONNREFUSED spawning a worker), suspect a similar race before anything else — `supervisor.js`'s `stop()` now genuinely awaits the kill, but any *new* process-lifecycle code should keep this in mind.
- **PATH changes don't reach an already-running process.** After `npm install -g` or `winget install` of a missing tool (devtunnel, opencode), the *already-running* Extension Development Host still has its old PATH snapshot. Relaunching the extension host is not enough here either — you need a genuinely new OS process tree, which in practice means relaunching from the Start Menu/a shortcut (Explorer refreshes its cached env on an installer's broadcast), not just reopening a window.
- **`devtunnel user show` has three output states, not two**: `"Not logged in."`, `"Login token expired."` (exit code 0 — indistinguishable from success by exit code alone), and `"Logged in as X using Y."`. Any check needs to allowlist the success string, not blocklist the failure one.
- **Publishing requires `devtunnel user login`** (interactive, opens a browser) before Publish will produce a real address — this is a one-time-per-machine, per-account thing, unrelated to any code state.
- **A worker's own worktree/process is a child of the room's PID.** Killing the room (any restart) kills every worker under it too. Agent-member records left in `members.json` from a room that's since restarted are provably dead — the room prunes these at boot now.
- The install-tool dialog, once tools are installed, needs one more full relaunch to be seen — see the PATH gotcha above.

## Manual testing loop that actually works

1. Quit all Cursor/VS Code windows fully (check Task Manager).
2. `cursor --new-window --extensionDevelopmentPath="<repo>/extension" "<repo>"` (or F5 from the repo root).
3. Confirm the window title says `[Extension Development Host]` before trusting anything you see in it.
4. The "Claude Room" **Output channel** (View → Output → pick "Claude Room") is the single most useful piece of live evidence — it shows every `supervisor.js`-managed child process's stderr, room restarts, and worker lifecycle lines. Ask for its exact text rather than a description when debugging.

## Where things stand (as of 2026-09-28)

- The extension-maturation plan (13 tasks: Room/Workers sidebar views, `session.js`, chat going dormant behind `claudeRoom.enableChat`, `.vsix` packaging) is functionally complete and merged to `master`. **Task 12 (the real F5 manual walkthrough) and Task 13 (README/ARCHITECTURE/design-system doc catch-up) were never formally closed out** — the docs these would update (`extension/README.md`'s Status/Manual verification sections, `ARCHITECTURE.md`'s module table, `docs/design-system.md`) still describe an earlier state of the extension.
- The delegation-skills plan (5 tasks) is unblocked (its prerequisites — `spawn_worker`/`verified`/`likelySucceeded` — landed with the delegation-robustness plan) but not started.
- Two cosmetic malformed-commit-message defects remain un-amended by design (found during earlier work, never fixed per this repo's "never amend without being asked" rule) — not worth chasing further, but see git history around `34c4e74` and `0799b7e` if it ever matters.
- `graphify-out/` holds a live knowledge graph of this repo. Update it after a batch of changes with `/graphify --update` (incremental — only re-extracts changed files) rather than a full rebuild.
