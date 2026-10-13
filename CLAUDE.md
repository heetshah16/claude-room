# claude-room — working notes for Claude

Read `ARCHITECTURE.md`, `docs/design-system.md`, and `extension/DEVELOPMENT.md` first — this file only adds what those don't cover: practical gotchas discovered while actually running and testing this project.

## Repo shape

- `src/` — the room server (ESM, `.mjs`). Runs standalone (`ROOM_STANDALONE=1`) or as an MCP stdio child.
- `extension/` — the VS Code/Cursor extension (CommonJS, no build step, no `"type"` field). Its one runtime dependency is the room's `@modelcontextprotocol/sdk`, shipped for the bundled room; extension code itself requires nothing.
- `scripts/` — launchers (`room-opencode-seat.mjs` etc.).
- `docs/superpowers/plans/` and `docs/superpowers/specs/` — the design specs and implementation plans this codebase was built from. `.superpowers/sdd/*/progress.md` are the execution ledgers (task-by-task record of what was built, reviewed, and found).

Run tests from the repo root (`node --test`, room-side) and from `extension/` separately (`node --test`, extension-side) — two independent suites, both plain `node:test`, no framework.

## Extension development gotchas (all found the hard way)

- **`extension/room/` is build output — never edit it.** `vsce package` runs `vscode:prepublish` (`scripts/bundle-room.mjs`), which copies the room's runtime files into it; it is git-ignored. From source (F5 / `--extensionDevelopmentPath`) `roomDir()` prefers the checkout's own `src/`, so a stale `extension/room/` can't shadow your edits; only an installed `.vsix` uses the bundled copy.
- **`extension/node_modules` now holds the room's `@modelcontextprotocol/sdk`** (an extension `dependency`, shipped in the package). Run `npm install` in `extension/` before `npx @vscode/vsce package`.

- **A code change to anything under `extension/src/` needs a fresh Extension Development Host launch to take effect.** Node caches `require()`'d modules for the life of the host process; nothing short of relaunching picks up an edit. Room-side (`src/*.mjs`) changes do NOT need this — they take effect on the next spawned room process (any republish or fresh session start reads current disk content).
- **A Windows process the extension kills is not necessarily dead when the kill call returns.** `taskkill /F` used to be fire-and-forget; if you see stale data right after a room restart (an old devtunnel address, ECONNREFUSED spawning a worker), suspect a similar race before anything else — `supervisor.js`'s `stop()` now genuinely awaits the kill, but any *new* process-lifecycle code should keep this in mind.
- **PATH changes don't reach an already-running process.** After `npm install -g` or `winget install` of a missing tool (devtunnel, opencode), the *already-running* Extension Development Host still has its old PATH snapshot. Relaunching the extension host is not enough here either — you need a genuinely new OS process tree, which in practice means relaunching from the Start Menu/a shortcut (Explorer refreshes its cached env on an installer's broadcast), not just reopening a window.
- **`devtunnel user show` has three output states, not two**: `"Not logged in."`, `"Login token expired."` (exit code 0 — indistinguishable from success by exit code alone), and `"Logged in as X using Y."`. Any check needs to allowlist the success string, not blocklist the failure one.
- **Publishing requires `devtunnel user login`** (interactive, opens a browser) before Publish will produce a real address — this is a one-time-per-machine, per-account thing, unrelated to any code state.
- **A worker's own worktree/process is a child of the room's PID.** Killing the room (any restart) kills every worker under it too. Fleet-worker records left in `members.json` from a room that's since restarted are provably dead — the room prunes these at boot now (people's seats are kept).
- **`.claude/room-seat.local.json` is a seat token, git-excluded.** The extension writes it in the open folder (`local-seat.js`); the `room-seat` mod reads it at session start (after env, before plugin options) and re-reads it when the room refuses the token. It is trusted only when `room_url`'s host is `127.0.0.1`, `localhost` or `[::1]`; otherwise it is ignored with a visible reason (security: a committed file must not join you to someone else's room). Never commit it or paste it; `ensureLocalSeat` refuses to write a token into it if git tracks it. The token in it always comes from the room's own `<stateDir>/members.json`, so a deleted file or a `room-admin rotate` is repaired at the next room start (a session already offline on the old token then needs `/room-join`). The room's own `claude` children (orchestrator, observer) carry `ROOM_SEAT_SKIP=1` so the mod never joins them as your seat.
- **A room restart keeps people's seats; only dead fleet workers are pruned** (`staleWorkers`, `src/workers.mjs`). Tokens survive, so seat sessions reconnect on their own.
- The install-tool dialog, once tools are installed, needs one more full relaunch to be seen — see the PATH gotcha above.
- **Mods (`mod/`) need Claude Code 2.1.287+, and their tests are `*.test.tsx`.** Node 24's
  `node --test` runs `*.test.ts` and would fail on `claude-code/testing`; it ignores `.tsx`.
  Run the mod suite with `claude plugin test` from `mod/`. `claude --plugin-dir ./mod`
  hot-reloads on save; an installed copy does not (bump `version` and reinstall).
- **Nothing in `mod/` may import from outside `mod/`** (`test/mod-boundary.test.mjs`): a
  marketplace install copies that directory alone, without `node_modules`.

## Manual testing loop that actually works

1. Quit all Cursor/VS Code windows fully (check Task Manager).
2. `cursor --new-window --extensionDevelopmentPath="<repo>/extension" "<repo>"` (or F5 from the repo root).
3. Confirm the window title says `[Extension Development Host]` before trusting anything you see in it.
4. The "Claude Room" **Output channel** (View → Output → pick "Claude Room") is the single most useful piece of live evidence — it shows every `supervisor.js`-managed child process's stderr, room restarts, and worker lifecycle lines. Ask for its exact text rather than a description when debugging.

## Testing in a real Cursor window without a person

`scripts/dev/cursor-window.ps1` drives ONE Cursor window by title (command palette, typing,
window-only screenshots) and refuses every keystroke unless that window is in the foreground,
so nothing is ever typed into another app. The loop that worked (2026-10-13): `git worktree add
--detach .worktrees/gui-check master` (inside this trusted repo, so no trust prompt), `cursor
--new-window <that folder>` (add `--extensionDevelopmentPath=<repo>/extension` to run the
checkout instead of the installed copy), then palette "Focus on Room View" → "Claude Code: Open
in New Tab" → type `/room-status`. Read the screenshot after every step; close with palette
"Close Window" and confirm. Never screenshot the whole desktop (it shows the user's private apps).
The room's process is `Cursor.exe` running `…/server.mjs` (the extension uses `process.execPath`),
not `node.exe`. `scripts/dev/seat-latency.cjs` measures a seat's reply time from the room's own
`turns.json`.

## Where things stand (as of 2026-10-13)

- **Released:** extension **0.0.5** on Open VSX (namespace `claude-room`, unverified) and
  installed in the user's Cursor; plugin `room-seat` **0.3.1** from the GitHub marketplace
  (`heetshah16/claude-room`). `master` = `origin/master` = `origin/orchestrator-parity`.
  Publish with the token in the user-scope env var `OVSX_PAT` (never echo it):
  `OVSX_PAT=… npx ovsx publish <vsix>`. The VS Code Marketplace is still on 0.0.1 (needs an
  Azure DevOps PAT from the user).
- **Seats join on their own.** Opening the Room view starts the room, which writes
  `.claude/room-seat.local.json`; any Claude Code session started after that in the folder joins
  as `@<os-user>-claude`. Verified in a real Cursor window on 0.0.4: `/room-status` → "online as
  @admin-claude … (seat from the project file)", a room message answered in ~7 s. Plan:
  `docs/superpowers/plans/2026-10-12-seat-auto-join.md`; ledger (git-ignored)
  `.superpowers/sdd/2026-10-12-seat-auto-join/progress.md` has every ruling and deferred minor.
- **room-seat 0.3.1 (merged 2026-10-13):** `room_reply` registered with `isDeferred: false` (no
  ToolSearch before the first reply) and `REPLY_DIRECTIVE` ends the turn after `room_reply`.
  Measured 7.1 s → 5.1 s first reply, room busy 10.1 s → 6.4 s. Release loop for a mod change:
  bump `mod/.claude-plugin/plugin.json`, push, then `claude plugin marketplace update
  claude-room` + `claude plugin update room-seat@claude-room` (sessions need a restart).
  Bump the version with `sed`, not PowerShell 5.1 `Set-Content -Encoding utf8` (it adds a BOM).
- **`extension/README.md` is the public Open VSX page** (written for people who have never heard
  of Claude Room); development notes live in `extension/DEVELOPMENT.md` (left out of the
  package). Keep claims there true to the code, and republish to change the store page.
- **Installing the extension does not install the `room-seat` plugin**: that is a manual
  one-time `/plugin` step (the README says so). Auto-offering it is a candidate feature.
- **The core idea is verified end to end (user, 2026-10-13):** room messages reach seats and
  seats delegate tasks to workers.
- **Next session's topic (user's call): brainstorm room-turn latency** (re-measure on 0.3.1 first) — what remains is model
  thinking (Opus 5.5 High, ~3 s even for one word), the user's own hooks (~1.2 s per prompt), and
  the closing message Claude writes after `room_reply` (the room's turn stays open until Stop).
- **Known open issues:**
  - If the room process dies, `extension.js` keeps the dead `roomSession` until "Claude Room:
    Restart" (the exit handler stops it but does not clear it).
  - `.mcp.json` uses `${CLAUDE_PROJECT_DIR}`, which Claude Code does not expand, so the `room` MCP
    server never connects in this repo (fix proposed in `src/server.mjs`, never approved — it
    would start a room on 8787 in every session here).
  - Reused `.worktrees/worker-N` are never moved to the current HEAD; Publish restarts the room,
    which kills its workers; env-sourced seats (`ROOM_URL` etc.) have no loopback check.
- **Older plans:** extension-maturation is merged; its Task 13 doc catch-up is partly done
  (`docs/design-system.md` still has no Room-view surface). The delegation-skills plan (5 tasks)
  is unblocked but not started.
- Two cosmetic malformed-commit-message defects remain un-amended by design (never amend without
  being asked) — see git history around `34c4e74` and `0799b7e` if it ever matters.
- `graphify-out/` (git-ignored) holds a knowledge graph of this repo, refreshed 2026-10-13 (1,451
  nodes, 118 communities). Update it after a batch of changes with `/graphify --update`
  (incremental). `.graphifyignore` keeps out `videos/` (the user's local explainer-video project,
  never staged). On Windows run graphify's Python from a script file with a `__main__` guard, not
  stdin, or its process pool fails.
