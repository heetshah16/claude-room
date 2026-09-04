# OpenCode seats — operator guide

An OpenCode seat is a second kind of agent seat in the room: instead of a Claude Code
process, `scripts/room-opencode-seat.mjs` drives an `opencode serve` instance in its own
worktree, talking the same HTTP seat protocol every Claude seat uses. See the "OpenCode
seats" section of the root [README](../README.md#opencode-seats) for what it is and how to
launch one; this file is the operator detail — prerequisites, the free-model reliability
warning, and troubleshooting.

## Prerequisites

- **Node 22+** on the machine running the seat (same floor as the rest of the room).
- **The `opencode` binary on `PATH`.** `npm i -g opencode-ai` is the normal way to get it.
  Verify with `opencode --version`.
- **A delegatable or addressable seat already registered** — `node scripts/room-admin.mjs
  seat add <name> --owner <member> --delegatable`. See the README for the full flag set.
  Note that `seat add` always prints a launch command naming `room-seat.mjs` — it has no
  way to know which harness you intend to run — so for an OpenCode seat, ignore that line
  and launch with `room-opencode-seat.mjs` instead, reusing the same `--token` it printed.
- Unlike a Claude seat, **no `/login` and no credential** — OpenCode's free models need
  none. The isolation that matters here is the worktree, not an account: two agents
  writing one checkout silently clobber each other, which is why the seat always works in
  `.worktrees/<handle>`.

## Free models are unreliable — use `--timeout`

The OpenCode Zen free tier is where the room gets a no-cost model from, and free models are
not uniformly usable. During design, some models sat in `busy` forever with no error at
all, and others parked in `status: retry` after an upstream 502 and never recovered.
`opencode/mimo-v2.5-free` (the default — see `DEFAULT_MODEL` in `src/opencode.mjs`) was the
only one that reliably completed a tool-using turn in that testing, which is why it is the
default rather than a recommendation to try others blind.

Even the default model is not guaranteed to finish quickly, and a stalled model is not a
bug in this codebase — it is what the driver is built to survive. Each turn gets a
deadline (`--timeout <ms>`, default 300000 = 5 minutes, `DEFAULT_TURN_TIMEOUT_MS`); if
nothing progresses the turn before it fires, the driver aborts the OpenCode session, tells
the room the turn was abandoned, and closes it — the room's queue is never left wedged
behind a seat that will not finish. `status: retry` is deliberately **not** treated as
progress: a model failing in a retry loop must not keep resetting the deadline, or a
wedged seat would block its destination forever. Lower `--timeout` for a room where you'd
rather find out fast; raise it if you are using a slower but more capable paid model.

## `--attach` — reusing a running server

By default the seat launches its own `opencode serve` on a free loopback port and stops it
on shutdown. On Windows that shutdown uses `taskkill /T`, because `opencode` is an npm
`.cmd` shim and the process the launcher holds is an interpreter — killing only that one
orphans the real server, which goes on holding the worktree and the port until you hunt it
down by hand. Pass `--attach <url>` (e.g. `--attach http://127.0.0.1:4096`) to point the seat
at an `opencode serve` you started yourself instead — useful for keeping one server warm
across several seat-driver restarts while you iterate, or for driving a server you are
also poking at through OpenCode's own UI. With `--attach`, the seat never spawns or kills
that process; only the driver (the room connection and the MCP bridge registration) starts
and stops.

## Why the server binds loopback only

`opencode serve` is started with `--hostname 127.0.0.1` unconditionally
(`opencodeSeatArgs` in `src/opencode.mjs`), never on the room's own bind address. That is
deliberate, not an oversight: **the server runs with no authentication at all** unless you
set `OPENCODE_SERVER_PASSWORD` yourself. Exposing it on the tailnet the room listens on
would hand out an unauthenticated shell over that worktree to anyone who can reach the
port. You will see OpenCode print its own warning to the same effect on every start:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
```

That warning is expected and is not something this project's launcher can suppress or
needs to — it is accurate.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `opencode-seat: failed to launch opencode: command not found on PATH: opencode` | `opencode` isn't installed, or isn't on `PATH` for the shell the seat is launched from. On Windows this is exactly the bare-ENOENT case `src/spawn.mjs` exists to turn into a clean, handled error instead of a crash. | `npm i -g opencode-ai`, then confirm `opencode --version` works in the **same** shell you launch the seat from. |
| Seat process starts, `opencode serve` comes up, but the model never replies and the room shows `Connection closed` from OpenCode's own logs around `POST /mcp` | A POSIX-style path (forward slashes) was passed as the bridge command instead of a native one. OpenCode spawns `command: ['node', bridgePath]` itself; on Windows a path built with `/` instead of `\` fails that spawn with no further diagnostic than `Connection closed`. `scripts/room-opencode-seat.mjs` builds `SEAT_BRIDGE` with `node:path`'s `join`, which is native-safe — this failure mode is a hazard for custom launchers or a modified bridge path, not the shipped script. | Make sure any custom `bridgePath` you pass to `connect()` is built with `node:path` (`join`/`resolve`), never a hand-written string with forward slashes, when running on Windows. |
| The seat shows online in the room, but a turn never completes and no reply arrives | Check `GET <opencode-url>/session/<id>/message` for a `session.status` of `retry` (the room-side symptom is the turn sitting open past its deadline, then closing with "no response after Ns — the turn was abandoned"). Retry is a provider failing in a loop, not a stall the driver can push through. | Wait for the deadline to close the turn cleanly (it will — that is the designed behaviour, not a hang), then retry the message, possibly on a different model with `--model <provider/model>`. Lowering `--timeout` makes this visible sooner. |
| The seat completes real work (`git diff` in `.worktrees/<handle>` shows the edit) but nothing appears in the room | The model finished its turn without calling the `room_reply` MCP tool, even though the tool was available and the `room` MCP bridge shows `connected` (`GET <opencode-url>/mcp`). This was the *original* failure with `mimo-v2.5-free`, and it is fixed: OpenCode never surfaces an MCP server's declared `instructions` to the model, so the driver now appends the reply directive to every turn's prompt body and the re-run had both turns reply. It remains possible with a weak model, which is why the recipe is still here. | Check the session's message log (`GET <opencode-url>/session/<id>/message`) for a `tool` part naming the `room` MCP server. If it never appears, the model produced a normal text answer instead of using the tool — a model-following-instructions problem, not a wedge; the turn still closes cleanly at `session.idle` or the deadline. Try a stronger model with `--model <provider/model>`. |
| `opencode-seat: opencode exited with code N` right after startup | `opencode serve` died on its own. The launcher watches the child and reports this rather than letting the driver post into a dead socket — which used to show up as every turn burning its full deadline and then reporting "no response after 300s", a diagnosis that has nothing to do with the actual failure. | Read `opencode serve`'s own output above the message; the usual causes are a port taken between `freePort()` and the launch, or a worktree the server cannot open. |

## Recorded smoke test

Run 2026-09-04, opencode 1.18.27, Windows, model `opencode/mimo-v2.5-free` (the default),
against a standalone room (`ROOM_STANDALONE=1`) on this checkout — whose path contains
spaces (`...\Desktop\multi user claude\...`), specifically to exercise the path-quoting
risk called out above.

What worked:

- The room-admin `seat add ... --delegatable` and `room-opencode-seat.mjs` launch sequence
  worked exactly as documented; no code changes were needed to get a seat online.
- `opencode serve` started fine from the space-containing worktree path via
  `spawnPortable` — no ENOENT, no EINVAL.
- The `room` MCP bridge registered via `POST /mcp` with `command: ['node', bridgePath]`
  connected successfully (`GET /mcp` reported `{"room":{"status":"connected"}}`) **despite**
  the space in the path — the `Connection closed` failure mode above did not occur here,
  because the bridge path was built with `node:path`'s `join`, producing a native
  backslash path rather than a POSIX one.
- Two turns addressed to `@opencode` (`add a mul(a,b) function to math.js`, then
  `also add a div(a,b) function to the same math.js file, and reply to confirm when done`)
  both ran real tool calls (`glob`, `read`, `write`/`edit`) and produced the correct code —
  confirmed by `git diff` in `.worktrees/opencode` showing `mul` and then `div` added to
  (the model's own choice of location) `src/math.js`. Neither turn stalled: both completed
  in under a minute, well inside the 120s timeout used for this run, and the room's `busy`
  flag cleared normally afterward — the turn was closed via `session.idle`, not the
  deadline.

What did not work, on the first run:

- **In neither turn did the model call `room_reply`.** The room showed the seat online and
  the turn closing cleanly, but no reply message ever appeared — `replyCount: 0` on both
  turns in `/api/turn`. This held even on the second turn, which explicitly asked the seat
  to "reply to confirm when done." The model's own transcript (`GET /session/:id/message`)
  showed a final `text` part ("Done. Added `div(a, b)` to `src/math.js`.") that never left
  OpenCode — it was never wrapped in a call to the `room` MCP tool, even though the tool
  was registered and the bridge was connected.

### The cause, and the fix

Not a model-quality problem, as first assumed. **OpenCode does not surface an MCP server's
declared `instructions` to its model the way Claude Code does.** `src/channel.mjs` states
the one rule that matters — your transcript does not reach the room, `room_reply` is the
only channel to it — in exactly the place OpenCode ignores. The seat was never told.

The driver now appends that directive to the prompt body itself (`REPLY_DIRECTIVE` in
`src/opencode.mjs`), after the context and the request so it is the last thing the model
reads. Re-verified against the same binary and the same model: **both turns called
`room_reply`, including the one that did not ask for a reply**, and both replies landed in
the room attributed to the seat.

Net effect for an operator: an OpenCode seat on this model does the coding work and
reports it back to the room. That is one model on one machine and not a guarantee — a weak
model can still end a turn without using a tool, so the troubleshooting row above keeps the
"check the worktree with `git diff`" recipe for when it happens.

Still unproven: none of this was exercised through the `delegate` tool. Its rendered brief
carries the same "report what you changed with `room_reply`" instruction inline
(`src/delegation.mjs`), and the return path that hands the seat's reply back to `@claude`
as a `delegation-result` is covered by tests — but no live run has yet gone
`delegate(...)` → real seat → real `room_reply` → `delegation-result` end to end.
