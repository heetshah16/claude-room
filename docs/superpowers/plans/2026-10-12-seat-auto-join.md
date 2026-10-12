# Seat auto-join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session with the room-seat plugin always joins a room by itself — no `/room-join` — and stays joined across room restarts (Publish).

**Architecture:** The Room extension, whenever it starts a room for an open folder, makes sure a seat exists for the local user and writes its connection details to `<folder>/.claude/room-seat.local.json` (git-excluded). The room stops deleting non-worker seats at boot, so that seat's token survives restarts. The room-seat plugin joins at session start from the first source it finds — environment (launched seats), then the project file, then plugin options — and re-reads the project file when its connection is refused or keeps failing, so a new port or token is picked up without user action.

**Tech Stack:** Node 22+ room (ESM), VS Code extension (CommonJS, no build step), Claude Code mod (hooks module), `node:test`, `claude plugin test`.

**Spec:** No separate spec. Decisions are from conversation on 2026-10-12: the user wants joining "always automatic, not a switch".

## Design record

| Decision | Evidence / reason |
|---|---|
| Always auto-join; first session wins | User: "it should always auto join not a switch". A second session for the same seat gets `409` and shows "this handle is already online in another session" (already implemented in feed.mjs) |
| Source order env → project file → plugin options | env = a session launched to be a seat; project file = the Room extension's room for this folder; options = joining someone else's room |
| The extension mints the local seat | It already holds the owner token (`readOwnerToken`) and an admin client (`createRoomClient`); `POST /api/admin/invite` accepts `{ kind:'agent', handle, ownerId }` (`src/admin.mjs:76`) |
| Boot prune keeps non-worker seats | `src/server.mjs:93-95` removes every agent not online at boot, which deleted a person's seat on every restart (seen 2026-10-10 with `panel-agent`); workers are children of the room and really are dead, seats are not |
| Token in a project file | Same exposure as the room's own `settings.hooks.json` hook token; file is added to `.git/info/exclude`, never `.gitignore` |
| Handle `<os-user>-claude` | Unique per person, readable in the room; `claude` alone is the host channel's default handle |

## Global Constraints

- Claude Code ≥ 2.1.287; plugin `room-seat`, tool `mcp__room-seat__room_reply`.
- Nothing in `mod/` imports outside `mod/`; mod tests are `*.test.tsx`.
- Extension code stays CommonJS, no build step.
- The seat token never goes on argv and never into a tracked file.
- The seat is owner-only addressable (only the room owner — the local user — can drive it).
- Root `node --test`, `extension/` `node --test`, and `mod/` `claude plugin test` stay green.

## Review Focus

1. Two sessions open in the same folder — the second must not loop or flap; it shows the 409 reason once.
2. Room restarted by Publish while Claude is joined — the seat must be online again after the restart without user action.
3. A new Cursor session picks a new port — an already-open Claude session must find the room again (re-read the file).
4. A folder that isn't a git repo, or no folder — the extension must not crash; it simply writes no file.
5. Legacy `members.json` with old `worker-N` records lacking the new marker — still pruned.

---

### Task 1: The room keeps people's seats across restarts

**Files:** `src/identity.mjs` (`createAgentMember` takes `worker`), `src/workers.mjs` (fleet marks its members `worker: true`; new exported pure `staleWorkers(agents, isOnline)`), `src/server.mjs:93-95` (prune only `staleWorkers`), tests in `test/workers.test.mjs` / `test/identity.test.mjs`.

**Interfaces:** `staleWorkers(agents, isOnline) → agent[]` — agents with `worker === true`, or a legacy record whose handle matches `/^worker-\d+$/` and has no `worker` field, that are not online.

- [ ] Failing tests: a human-added agent (`worker` absent, handle `ana-agent`) is NOT stale; a fleet worker (`worker: true`) offline IS stale; a legacy `worker-3` with no field IS stale; an online worker is NOT stale; the fleet's minted member has `worker: true`.
- [ ] Implement; prune loop uses `staleWorkers(registry.agents(), h => seats.isOnline(h))`.
- [ ] Root suite green. Commit `fix(room): a restart no longer deletes people's seats, only dead workers`.

### Task 2: The extension writes the local seat for the open folder

**Files:** `extension/src/local-seat.js` (new), `extension/src/room-client.js` (`addSeat({ handle, ownerId })` → `POST /api/admin/invite { name: handle, kind: 'agent', handle, ownerId }`), `extension/src/session.js` (call after every successful room start/restart when `workRepo` is set), tests `extension/test/local-seat.test.js`.

**Interfaces:**
- `seatHandle(username) → string` — lowercase, `[a-z0-9-]` only, collapsed dashes, suffix `-claude` (e.g. `Admin` → `admin-claude`).
- `ensureLocalSeat({ client, workRepo, roomUrl, username, fs, git }) → Promise<{ ok, handle?, file?, reason? }>`:
  1. `adminState()`; find the owner (`role === 'owner'`) and an agent with `handle === seatHandle(username)`.
  2. If the file exists and its token belongs to that agent (compare against admin state if the token is exposed; otherwise trust the file when the handle exists) → rewrite only `room_url` if it changed.
  3. Else create the seat with `addSeat` and write `{ room_url, seat_handle, seat_token }` to `<workRepo>/.claude/room-seat.local.json` (create `.claude/`).
  4. Add `.claude/room-seat.local.json` to `<git-common-dir>/info/exclude` if absent (same approach as `scripts/room-seat.mjs` `excludeWorktrees`; CommonJS copy is acceptable here — record it).
  5. Never throws; any failure returns `{ ok:false, reason }` and session.js logs it to the Output channel.
- `room_url` is always the loopback URL `http://127.0.0.1:<port>` (even when published).

- [ ] Failing tests with an injected client + temp dirs: creates seat and file on first run; second run reuses (no second invite) and updates `room_url` on a new port; no `workRepo` → no file, no call; a non-git folder → file written, exclude skipped, no throw; client failure → `{ ok:false }`, no throw.
- [ ] Implement and wire into session.js start + publish/unpublish restarts. Extension suite green. Commit `feat(extension): give Claude in the open folder its own seat`.

### Task 3: The plugin always joins

**Files:** `mod/hooks/register.js`, `mod/tests/room-seat.test.tsx`, `mod/.claude-plugin/plugin.json` (version `0.3.0`), `mod/README.md`.

**Interfaces:** at `session.start`, join from the first complete source: env (`ROOM_URL`/`ROOM_SEAT_TOKEN`/`ROOM_SEAT_HANDLE`) → project file `.claude/room-seat.local.json` (via `$.fs.read`, relative to the session cwd) → plugin options. `/room-status` names the source. When the source is the project file and the feed reports `fatal`, or `retrying` three times in a row, re-read the file; if `room_url` or `seat_token` changed, leave and join with the new values (at most once per change — no tight loop).

- [ ] Failing tests: file only → joins at start with its values; env beats file; file beats options; options alone → joins at start (no `/room-join` needed); fatal + changed file → rejoins once with new token; fatal + unchanged file → stays offline with the reason (no rejoin loop); three `retrying` + changed `room_url` → rejoins; unreadable/invalid JSON file → falls through to options, no throw.
- [ ] `claude plugin validate ./mod` and `claude plugin test` green; root boundary test green. Commit `feat(mod): join the room automatically, from the Room extension's seat file`.

### Task 4: Docs and real end-to-end

- [ ] Docs: `mod/README.md` (auto-join sources, one session wins, the project file), `extension/README.md` (the extension creates your seat and the file), root `README.md` seat section, `CLAUDE.md` gotcha (the file, git-excluded; prune keeps seats).
- [ ] Real check (headless, scripted): standalone room from the repo with `ROOM_REPO` = a temp git repo; run `ensureLocalSeat` against it (Node, from the extension module); start `claude -p --input-format stream-json --plugin-dir mod` in that repo with no env → seat online by itself; addressed message → reply; restart the room on the same port and state → seat back online by itself, second message answered; a second headless session in the same repo → shows the 409 reason, first stays online. Record in `mod/README.md`.
- [ ] Commit `docs: seats join automatically`.

### Task 5: Release (controller + user)

- [ ] Bump extension to `0.0.3`; package; verify contents; `cursor --install-extension` (controller).
- [ ] Publish extension 0.0.3 to Open VSX (needs a valid token — the earlier one may be revoked) and, if a token is provided, the VS Code Marketplace.
- [ ] Push to GitHub; user runs `/plugin marketplace update claude-room`, `/plugin update room-seat@claude-room` (or reinstall), `/reload-plugins`.
- [ ] User check: restart Cursor, open the project → Claude panel `/room-status` shows `online as @<user>-claude` without `/room-join`.
