# Super harness: OpenCode seats and orchestrated delegation

**Status:** approved design, not yet implemented
**Date:** 2026-09-04

## Problem

The room today runs one kind of agent: Claude Code, reached over the
`claude/channel` MCP extension. Every seat costs somebody's Anthropic
subscription, and every task — boilerplate, tests, mechanical refactors —
is paid for at the same rate as architecture and hard debugging.

We want a second harness in the room. OpenCode runs free models, so the
cheap, mechanical, high-volume work can go somewhere that does not draw on
anyone's plan, while Claude keeps the work that actually needs it. The
orchestrating Claude decides which is which.

## What was proven before designing

A throwaway probe (opencode 1.18.27, Windows, free OpenCode Zen tier)
established the following by execution, not by reading docs:

| Fact | Evidence |
|---|---|
| `session.idle` fires per session, carrying `sessionID` | 12s on a text turn, 22s on a tool-using turn |
| `POST /session/:id/prompt_async` returns 204 immediately | fire-and-forget delivery works |
| OpenCode does real work | edited a file through its `edit` tool, confirmed by `git diff` |
| OpenCode calls our `room_reply` MCP tool unchanged | tool called with the exact text, logged by a stand-in for `src/seat.mjs` |
| MCP servers can be registered at runtime | `POST /mcp` with `command`/`cwd`/`environment` |
| **`claude/channel` notifications are silently discarded** | 13 sent to a live idle session over 30s: zero messages, zero tool calls, zero bus events |
| `POST /api/session/:id/wait` is not usable | returns 503 |
| Free models stall hard | `big-pickle` wedged in `busy` forever with no error; `nemotron-3-ultra` parked in `status: retry` after a 502 |
| Sharing one checkout corrupts it | three sessions against one directory wrote `mul()` twice |

Two consequences drive the whole design:

1. **There is no inbox in OpenCode.** Nothing can be pushed into a running
   OpenCode session from an MCP server. Delivery must be an outbound HTTP
   call from a driver we control.
2. **A stalled OpenCode session never ends its own turn.** The room's queue
   serialises per destination, so a wedged seat blocks its destination
   permanently unless the driver imposes its own deadline.

## Portability findings

These are bugs in the code today, not hypotheticals:

- `spawn('opencode', …)` fails **ENOENT** on Windows: npm installs it as a
  `.cmd` shim, and Node does not apply `PATHEXT` to a bare `spawn`.
- Spawning the `.cmd` path explicitly throws **EINVAL synchronously**
  (Node's CVE-2024-27980 mitigation). It bypasses `child.on('error')` and
  crashes the launcher rather than surfacing as a handled failure.
- `shell: true` works, but `scripts/room-seat.mjs` passes MCP config as
  **JSON on argv** (`--mcp-config <json>`), so routing it through a shell
  means quoting a JSON blob through `cmd.exe` — fragile and an injection
  surface.
- `claude` resolving to a real `.exe` (as on the author's machine) is why
  this has never been hit. An npm-installed `claude` fails the same way,
  which means `scripts/room-seat.mjs` and `src/run-model.mjs` (the
  observer) are both broken on such a machine today.

## Design

### 1. `src/spawn.mjs` — portable process launching

New module, pure and injectable so both platforms are testable from either.

```
resolveCommand(name, { env, platform }) -> { path, needsShell } | null
spawnPortable(name, args, opts) -> ChildProcess
```

- `resolveCommand` walks `PATH`; on `win32` it tries each `PATHEXT`
  extension in order, preferring `.exe` over `.cmd`/`.bat`. It returns
  `needsShell: true` only for `.cmd`/`.bat`.
- `spawnPortable` wraps the `spawn` call in `try/catch` because EINVAL
  throws synchronously, and converts it into the same failure shape as an
  `error` event so callers have exactly one path to handle.
- `env` and `platform` are parameters, never read from globals, so a test
  on Linux can assert Windows behaviour and vice versa.

**Argv hygiene.** `scripts/room-seat.mjs` stops putting JSON on argv: the
MCP config is written to a file in the seat's own config directory (beside
`settings.hooks.json`, which is already written there) and passed as
`--mcp-config <path>`. This removes the shell-quoting hazard rather than
escaping around it.

**Retrofit.** `scripts/room-seat.mjs:154` and `src/run-model.mjs:50` both
move to `spawnPortable`. This fixes the observer on npm-installed Claude.

### 2. `scripts/room-opencode-seat.mjs` — the OpenCode driver

A peer of `scripts/room-seat.mjs`. The room core is unchanged: `queue.mjs`,
`fanout.mjs`, `seats.mjs` and `identity.mjs` never learn that a second
harness exists, because the HTTP seat protocol was already the right
boundary.

Responsibilities, in order:

1. Create the seat's `git worktree` (reusing `worktreeFor` from
   `room-seat.mjs`, which moves to a shared module).
2. Start `opencode serve` on a free port via `spawnPortable`, or attach to
   an existing one given `--attach <url>`. The port is chosen by binding
   `127.0.0.1:0`, reading the assigned port, and releasing it before
   launching — never a fixed default, so two seats on one machine cannot
   collide. The server is bound to loopback only: it has no auth by
   default (`OPENCODE_SERVER_PASSWORD` is unset) and must not be reachable
   from the tailnet.
   The model is per seat: `--model <provider/model>`, default
   `opencode/mimo-v2.5-free` — the only free model that completed a
   tool-using turn reliably in the probe.
3. Register `src/seat.mjs` in **reply-only mode** with that server via
   `POST /mcp`, passing `ROOM_URL`, `ROOM_SEAT_TOKEN`, `ROOM_SEAT_HANDLE`
   in `environment`. Paths passed here must be native paths — the probe
   showed POSIX-style paths fail MCP spawn on Windows with a bare
   `Connection closed`.
4. `POST /seat/join` and open `GET /seat/events` — the driver, not
   `seat.mjs`, owns the room feed.
5. Open `GET /event` on the opencode server and translate both directions.

**Translation table**

| room event | driver action |
|---|---|
| `turn` | `POST /session/:id/prompt_async` with the batch rendered as text |
| `mirror`, `brief`, `seed` | held in a pending-context buffer and prepended to the *next* prompt, never sent on their own — OpenCode has no inbox, so an unprompted send would start a turn nobody asked for |

A `turn` is rendered exactly as `buildNotification` renders one for the
channel (`channel.mjs:31-37`): a single message verbatim, or `[name] text`
lines when several people spoke while the seat was busy. Reusing that
rendering is deliberate — two harnesses seeing differently-shaped versions
of the same room is how the mirror/brief semantics would drift apart.

The pending-context buffer is **bounded** (most recent N events, default
20, oldest dropped). A seat that is never addressed would otherwise
accumulate every mirror in the room forever and eventually send a prompt
larger than its context window. Dropped events are counted, and the count
travels with the next prompt, mirroring how `pending` already tells a
Claude seat how stale its brief is.

| opencode event | driver action |
|---|---|
| `session.idle` for our session | `POST /seat/hook/Stop` — closes the room turn |
| `session.status: retry` | record liveness, **do not** reset the deadline |
| `session.error` | abort, close the turn with a visible failure |

`room_reply` needs no translation: OpenCode calls the tool, `seat.mjs`
POSTs `/seat/reply`, done.

**Turn identity for cost.** The room's ledger is idempotent per
`promptId` (`ledger.mjs:91`) so a re-fired Stop cannot double-charge.
OpenCode has no `prompt_id`, so the driver mints one id per turn when it
sends the prompt and quotes that same id on every `Stop` for that turn.
A reconnect that re-delivers `session.idle` therefore cannot double-charge,
and no extra round trip is needed to read an id back out of the session. Free-tier usage records as zero
cost, but the turn is still recorded so the activity feed and the queue
behave identically for both harnesses.

### 3. `src/seat.mjs` — reply-only mode

`seat.mjs` currently serves the `room_reply` tool *and* holds the SSE feed.
For an OpenCode seat the driver owns the feed, so a second joining
connection would collide on `handle-taken` (`seats.mjs:24`).

Add `ROOM_SEAT_MODE=reply-only`: serve the tool, skip `/seat/join` and
skip `openFeed()`. Both modes keep sharing one implementation of the tool
and one definition of its description — a hand-maintained duplicate is
exactly how `buildBriefNotification` drifted once already.

### 4. Delegation

A `delegate` tool on the host channel (`src/channel.mjs`):

```
delegate({
  to:    "@opencode",
  class: "execution",            // reasoning | execution | verification
  task:  "one-line statement",
  spec:  { files, interface, tests, do_not_touch }
})
```

- The room records a delegation and enqueues a turn to the target seat's
  destination, tagged `kind="delegation"`.
- The seat's reply returns to `@claude` as `kind="delegation-result"`,
  carrying the delegation id.
- `class` never routes. Routing is `to`, chosen by the orchestrating
  Claude. `class` does two narrower jobs: it labels the delegation in the
  ledger and activity feed, and it selects which `spec` fields are
  required (below). There is deliberately no separate classifier model —
  the orchestrating Claude already holds the repo, the plan and the room
  context, and a second pass would decide with strictly less information.

**`spec` is the load-bearing field.** Delegated work fails because the
brief was thin far more often than because the model was weak. So the
tool validates it rather than trusting it: `class: "execution"` requires
non-empty `files` and `tests`, and a `delegate` call missing them is
rejected with a message naming what is missing. `reasoning` and
`verification` require only `task`. Rejection is visible in the room, not
silent — an orchestrator that cannot write a real brief should be told so
while it still has the context to fix it.

**Authorisation.** `identity.mjs` already has `addressPolicy` with
`owner-only` (the default) and `shared`. Human addressing is unchanged:
`owner-only` continues to mean only the owner may address the seat.

Delegation is a *separate* path, gated by a new per-seat `delegatable`
flag that the owner opts into at launch (`--delegatable`). This preserves
the principle stated at `identity.mjs:105-110` — that room ownership must
not by itself grant access to someone else's seat — while letting the
orchestrator route work with the owner's explicit consent. A seat that is
not `delegatable` rejects `delegate` with a visible reason, never
silently.

### 5. Stall handling

The single most important correctness requirement, because the probe hit
it twice in six attempts.

- The driver holds a per-turn deadline, `ROOM_OPENCODE_TURN_TIMEOUT_MS`,
  default 300000.
- `session.status: retry` marks the seat alive but **not progressing**. It
  must not reset the deadline: a model retrying forever is still stalled,
  and treating retry as progress reintroduces the exact bug.
- On deadline: `POST /session/:id/abort`, then `POST /seat/hook/Stop` so
  the queue drains, and a `room_reply`-equivalent failure notice so the
  room can see what happened rather than watching a seat go quiet.
- Losing the opencode event feed is treated as a drop and reconnected with
  backoff, matching `seat.mjs`'s existing behaviour for the room feed.

## Build order

Each stage is independently useful and independently verifiable, so a
stall at any point still leaves the room better than it started.

1. **`src/spawn.mjs` + retrofit.** Fixes a live bug on npm-installed
   Claude, touches no new concepts, and everything later depends on it.
2. **`seat.mjs` reply-only mode.** Small, contained, testable on its own.
3. **The OpenCode driver, without delegation.** At the end of this stage
   `@opencode` is a real room member a human can address — the two-harness
   room, working, with no orchestration yet.
4. **Stall handling.** Deliberately its own stage rather than folded into
   3, because it is the requirement most likely to be quietly skipped once
   the happy path works.
5. **`delegate` + `delegatable`.** The orchestrator lane, on top of a seat
   that is already known to be solid.

## Testing

- **Pure mappers, both directions** — room event to prompt text, opencode
  event to room hook call. No sockets.
- **`resolveCommand`** driven by injected `env` and `platform`, so Windows
  and POSIX resolution are both covered from a single machine. Includes
  the `.cmd` case that returns `needsShell`, and the `.exe`-preferred case.
- **Injectable `fetch`**, following `createSeat` (`seat.mjs:128`), so the
  driver can be constructed and exercised without a real socket.
- **A fake opencode server** — an in-process HTTP server implementing
  `/session`, `/session/:id/prompt_async`, `/event` and `/mcp`, in the
  style of `test/helpers/room.mjs`. `node --test` must never require the
  real binary.
- **Stall tests** are first-class: a session that never idles must trip the
  deadline and drain the queue; a session that sits in `retry` must not
  have its deadline reset.
- **Real-binary runs stay a manual smoke test**, documented honestly in the
  README alongside the existing two-account gap. The probe's findings came
  from the real binary; the suite does not depend on it.

## Out of scope

- The dual-solution / judge lane (Solution A vs Solution B, Claude
  arbitrating). It is the most expensive pattern and the least proven:
  two independent solutions to one spec diverge structurally, so a judge
  reading both tends to re-implement rather than pick. Revisit only for
  narrow units where the judge can be *test execution* rather than
  reading, and only after `session.fork`/`revert` have been exercised the
  way `session.idle` now has been.
- Any change to how the shared `@claude` session is billed or addressed.

## Risks

- **Free-tier reliability is poor.** The design contains the blast radius
  with deadlines and aborts, but a room that delegates heavily to a
  stalling model will feel slow. Model choice is configurable per seat for
  this reason.
- **`delegatable` is a new authorisation surface.** It must fail closed:
  absent or unrecognised means not delegatable.
- **OpenCode's API is young.** `/api/session/:id/wait` already returns 503
  despite being in the spec. The design depends only on endpoints the
  probe actually exercised.
