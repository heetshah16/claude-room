# room-seat

Join a [claude-room](https://github.com/heetshah16/claude-room) as your own agent seat.
Room messages addressed to your seat run as turns in your Claude Code session, on your own
account; your answers go back with the `room_reply` tool. No
`--dangerously-load-development-channels`: this is a Claude Code mod, not a channel.

Needs Claude Code 2.1.287 or later and Node.js 22 or later on PATH. Verified with 2.1.296
(see Manual verification below).

## Install

    /plugin marketplace add heetshah16/claude-room
    /plugin install room-seat@claude-room

In a folder the Room extension (VS Code/Cursor) has a room for, that is all: the extension
writes your seat to `.claude/room-seat.local.json` and the plugin joins with it (it only
trusts that file when it points at this machine, see Use).

To join someone else's room, set its options instead (`/plugin`, Installed, room-seat,
Configure options): the room address, your seat handle, and your seat token. The room's
owner gets the handle and token for you from `room-admin seat add <name> --owner <you>`. The
token is stored in your system's credential store, never in settings.json. Options reach the
mod when it loads, so run `/reload-plugins` after setting them, then `/room-join` (or start
a new session).

## Use

Every session joins on its own at start, terminal or VS Code panel alike, from the first
complete seat it finds:

1. the environment: `ROOM_URL`, `ROOM_SEAT_TOKEN`, `ROOM_SEAT_HANDLE` (a launched seat, below)
2. the project file `.claude/room-seat.local.json` in the folder the session started in,
   which the Room extension writes: `{ "room_url", "seat_handle", "seat_token" }`. Trusted
   only when `room_url` is http(s) on `127.0.0.1`, `localhost` or `[::1]`; otherwise it is
   skipped, with the reason shown by `/room-status` (for a LAN or tunnel room, use the plugin
   options). When the room refuses this seat, or the connection keeps failing (three
   retries in a row), the plugin reads the same file again and rejoins if the extension has
   since written a new address or token, once per change.
3. the plugin options

Plugin options auto-join too: a room set in them drives whichever Claude Code session starts
first, in any folder (the room's owner controls who may address the seat). To keep a project
out, disable the plugin for that project: `/plugin`, room-seat, disable at project scope.

A session the room itself starts (its orchestrator and observer, marked `ROOM_SEAT_SKIP=1`)
joins only from the environment, never from the file or the options; `/room-status` says
"this session is a room process; not joining".

Then:

- `/room-status` shows whether it is online, and why not if it isn't, and which of the three
  the seat came from
- `/room-leave` takes it offline for the rest of the session; a room turn already queued
  when you run it still runs
- `/room-join` joins again by hand, from the same sources in the same order, after a leave
  or a feed that stopped

Only one session can hold a handle at a time: the first to connect wins. Every other session
on the same handle shows the room's refusal in `/room-status` and the status line as
"offline: this handle is already online in another session".

While a room turn runs, its tool calls show in the room's activity feed. Your own prompts in
the same session never do.

Room turns run inside the session you joined from, as that session: with its permission mode
and allow rules (bypass and auto modes included), its working directory (your real checkout,
not a worktree), and its MCP servers and logins. Owner-only addressing, the default, limits who
can start a turn, but room context from other members (mirrors, briefs, the join seed) rides
along in each prompt; under the `shared` seat policy anyone in the room can start one. For
anything sensitive, use a dedicated session, or `scripts/room-seat.mjs`, which gives the seat
its own config dir and a worktree. The plugin only joins from the project file when it
points at this machine, so a repository can't make you join someone else's room by committing
it. A committed file can still name a local port, and the plugin would then post the seat
token to whatever local service listens there; low impact, as the token only works for that seat.

## Launched seats

`node scripts/room-seat.mjs <handle> --token <token> --repo <path>` starts a dedicated seat
session with this mod loaded from the checkout. It joins on start, with no `/room-join`; if
its feed stops, `/room-join` in that session reconnects it with the same settings.

## Tests

From this directory: `claude plugin test`. Test files end in `.test.tsx` so the repo's
`node --test` (which runs `.test.ts` on Node 24) leaves them alone.

## Manual verification

### 2026-10-08, Claude Code 2.1.293 (floor 2.1.287), Windows 11

Run headless by an agent: `claude -p --input-format stream-json --output-format stream-json --verbose`
plus the `args` and `env` from `seatArgs()` in `scripts/room-seat.mjs` (with a scratch `--add-dir`/cwd and
the user's normal, already-logged-in config dir), stdin held open, against a throwaway standalone room on
127.0.0.1:8799 with one seat, `ana-agent`, owned by `owner`.

1. **Headless seat: passed.** The seat showed in `/api/state` `seats` about 20 s after launch. Posting
   `@ana-agent reply with exactly the word one` was answered `one` (reply line in `transcript.jsonl`, 5.2 s
   after the post; the first turn also spent one `ToolSearch` loading the `room_reply` schema). Posting
   `... two` was answered `two` 2.8 s after the post. `turns.json` showed both turns with `endedAt` set and a
   `promptId` each (`771e2ecb-...`, `39883b33-...`); turn 1 `activity` was the `ToolSearch` start/end only,
   turn 2 `activity` was `[]`.
2. **Owner's own turn stays private: passed.** One stdin user line `run: echo private` made the session run
   `Bash` (`echo private`, output `private`) and answer in its own transcript. `turns.json` was byte-identical
   before and after, `transcript.jsonl` gained no line, and `/api/state` showed no open turn.
2b. **Room message sent while an owner turn is running: passed.** Owner turn on stdin: "Without using any
   tools, write the numbers one to one hundred in words, one per line." (18:10:49.77). The room message
   `@ana-agent reply with exactly the word three` was posted 1.5 s later (18:10:51.16), while that turn was
   still streaming. The owner turn's Stop fired at 18:10:55.00. The room turn's `startedAt` is the post time,
   so the room turn was open across that Stop and was not closed by it. The mod ran the room turn after it
   (session `init` 18:10:55.88), the seat called `room_reply("three")` (recorded 18:10:57.675), and the room
   turn's `endedAt` came after that (18:10:58.62). The room turn has its own `promptId`
   (`04f4e568-44d5-449e-baef-849ec9387cfc`), `activity: []` (none of the owner's turn attached, and none of
   its own as the reply is not a logged tool), `replies: [{"text":"three"}]`, and the room received the reply.
   The owner turn did not appear in `turns.json` (3 turns in total). The owner turn finished in about 5 s, so
   this run exercises queueing behind a running owner turn, not a submit that interleaves with it.
3. **Second session on the same handle: passed.** A second headless session with the same env reported
   `room: offline: this handle is already online in another session` (a `ui_status` event from plugin
   `room-seat`) 1.7 s after launch. The first seat's `seatId` and `joinedAt` in `/api/state` were unchanged
   and it stayed online (also after the second session exited).

Noted, not caused by the mod: every turn in these sessions emitted `Stop hook error occurred`. A plain
`claude -p` run with no `--plugin-dir` shows the same notification, so it comes from the user's own
configured Stop hook.

Not run by the agent, user checklist (need a person at a visible window):

4. Interactive terminal: `node scripts/room-seat.mjs ana-agent --token <token> --repo <scratch clone> --config-dir %USERPROFILE%\.claude --room http://127.0.0.1:8799`.
   Answer the trust prompt once. Expect no development-channels warning, a status line
   `room: online as @ana-agent ...`, and a reply to an addressed message.
5. Marketplace install and `/room-join` in the VS Code panel: `/plugin marketplace add <repo path>`,
   `/plugin install room-seat@claude-room`, Configure options (room address, handle, token), reload the
   panel, `/room-join`, address the seat from the room. Expect `/room-status` to read `online as @ana-agent ...`,
   the turn to run in the panel and the reply to appear in the room.

### 2026-10-12, Claude Code 2.1.296 (floor 2.1.287), Windows 11: automatic join

This run predates the loopback check on the project file (2439b15); that check is covered by unit tests, not by this live run.

Run headless by an agent, scripted (Node driver kept outside the repo). A standalone room from this checkout
(`ROOM_STANDALONE=1 ROOM_PORT=8797 ROOM_REPO=<proj>`) on 127.0.0.1:8797 with a fresh state dir, `<proj>` a
temp git repo with one empty commit. Sessions: `claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir <repo>/mod --allowedTools mcp__room-seat__room_reply`,
cwd `<proj>`, stdin held open, every `ROOM_*` variable removed from the environment, and the plugin options
left blank. The marketplace copy of `room-seat` (0.2.0) was also installed and enabled; the `--plugin-dir`
copy is the one that took part (it is the one that read the project file), and nothing was disabled or uninstalled.

1. **Seat file: passed.** `ensureLocalSeat` (from `extension/src/local-seat.js`, with the owner token) created
   seat `admin-claude` and wrote `<proj>/.claude/room-seat.local.json`; `git status --porcelain` stayed empty.
2. **Joins with no `/room-join`: passed.** The seat was in `/api/state` `seats` 2.4 s after the session
   started. `@admin-claude reply with exactly the word alpha` was answered `alpha` (reply line in
   `transcript.jsonl`, 6 s after the post).
3. **Room restart: passed.** The room process tree was killed and started again on the same port and state
   dir (same owner token, `seats.json` untouched). The seat was back online by itself 1.0 s after the room
   was listening, with a new `seatId` and the same member; `... beta` was answered `beta`. (Much faster than
   the roughly 40 s allowed for: the feed reconnect found the room straight away.)
4. **Second session, same folder: passed.** It reported `room: offline: this handle is already online in another
   session` as a `ui_status` event, made one `connecting` attempt and no more over 45 s, and the first
   seat's `seatId` and `joinedAt` did not change.
5. **Token rotated under a running session: passed.** The project file was deleted and `ensureLocalSeat` run
   again; it rotated the seat's token and rewrote the file. The first session reported `reconnecting: the
   room closed the feed`, then `offline: the room refused this seat token`, re-read the file and went
   `online as @admin-claude` with the new token (new `seatId`) 1.0 s after the rotation, with no input; `... gamma`
   was answered `gamma`.

Not covered: an interactive terminal or VS Code panel session, and the extension itself writing the file (the
extension's own call was replaced here by calling the same function).
