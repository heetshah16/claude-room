# Architecture

How the pieces fit, and why they fit that way. For what the project *is* and
how to run it, read [README.md](README.md) first.

Three layers, each usable without the one above it:

```
  extension/          VS Code extension — a chat window, and a supervisor
        │             for everything below
        ▼
  scripts/ + src/     harness drivers — one per kind of agent
        │
        ▼
  src/                the room — turns, identity, cost, transcript
```

The room predates the rest and still runs standalone. The harness drivers
turn "an agent" into "a room member". The extension packages all of it into
something you install.

---

## 1. The room (`src/`)

~6,100 lines, 27 modules, **zero runtime dependencies** beyond
`@modelcontextprotocol/sdk`. It is an HTTP server plus an MCP stdio server.

| Module | Responsibility |
|---|---|
| `server.mjs` | entrypoint; wires everything, owns process lifetime |
| `web.mjs` | every HTTP route and SSE feed |
| `ui.mjs` | the browser client, one self-contained document, no build step |
| `queue.mjs` | one turn per destination, at a time — the serialisation guarantee |
| `turns.mjs` | open/close turns, attribution |
| `identity.mjs` | members, agents, tokens, who may address what |
| `seats.mjs` | which agent seats are live right now |
| `router.mjs` | `@handle` classification — pure, no model call |
| `fanout.mjs` | who sees what: turns, mirrors, briefs |
| `channel.mjs` | the MCP server the host's own Claude Code session loads |
| `ledger.mjs` | token cost, split across participants |
| `decisions.mjs` | recorded decisions, and conflicts against them |
| `observer.mjs`, `brief.mjs` | the room's summary of itself |
| `permissions.mjs` | relaying tool-approval prompts to the room |
| `state.mjs` | durable state: transcript, roster, ledger |
| `spawn.mjs` | portable process launching (see §5) |

### The seat protocol

Everything that is not the host's own session reaches the room over four HTTP
routes:

```
POST /seat/join        handshake; returns a seed of recent history
GET  /seat/events      SSE: turns, mirrors, briefs addressed to this seat
POST /seat/reply       the ONLY way a seat's words enter the room
POST /seat/hook/:evt   lifecycle, notably Stop — which closes the turn
```

That last one is load-bearing and easy to underestimate. `queue.mjs` runs one
turn per destination; if `Stop` never arrives, that destination stays busy
forever and every later message queues behind a turn that already finished.
This has caused real bugs twice.

**Why it is HTTP rather than an in-process interface:** a seat is somebody
else's machine, running somebody else's account. The boundary is the point.

---

## 2. Harness drivers

Two kinds of agent participate, and they are driven **in opposite directions**.

### Claude Code seats — pushed

`src/seat.mjs` runs as an MCP stdio child of a real Claude Code process. The
room pushes work in as a `claude/channel` notification; the agent answers with
the `room_reply` tool. Launched by `scripts/room-seat.mjs`, which gives each
seat its own `CLAUDE_CONFIG_DIR` and its own `git worktree`.

The credential isolation is deliberate and absolute: nothing copies, forwards
or stores a token, and the launcher actively strips `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` so it cannot become the thing that authenticates a
session.

### OpenCode seats — pulled

`src/opencode.mjs` drives `opencode serve` over HTTP. Launched by
`scripts/room-opencode-seat.mjs`.

**This asymmetry is forced, not stylistic.** OpenCode silently discards MCP
notifications it does not understand — verified against the real binary by
firing 13 `claude/channel` notifications at a live idle session and observing
zero messages, zero tool calls, zero bus events. **There is no inbox.** So
delivery must be an outbound call the driver makes:

| room event | driver does |
|---|---|
| `turn` | `POST /session/:id/prompt_async` |
| `mirror`, `brief`, `seed` | held in a bounded buffer, prepended to the next real turn |

| opencode event | driver does |
|---|---|
| `session.idle` | `POST /seat/hook/Stop` — closes the room turn |
| `session.status: retry` | records liveness but **does not** reset the deadline |
| `session.error` | aborts, closes the turn, tells the room |

Two consequences worth knowing before changing any of it:

- **The driver owns a per-turn deadline.** Free models stall: in the design
  probe, two of six real turns wedged — one sat in `busy` forever emitting
  nothing, another parked in `retry` after an upstream 502. `retry` is
  deliberately *not* progress; treating it as progress would mean the deadline
  never fires and the seat blocks its queue destination permanently.
- **`src/seat.mjs` also runs for OpenCode**, in `reply-only` mode. It serves
  `room_reply` and nothing else — the driver owns the room feed, and a second
  connection claiming the same handle would be refused as `handle-taken`,
  leaving the seat deaf.

OpenCode also never surfaces an MCP server's declared `instructions` to its
model, the way Claude Code does. So the rule that `room_reply` is the only
channel to the room has to ride in the prompt body itself. Without that, the
seat does the work and reports nothing — which reads as silence to everyone
waiting.

---

## 3. Delegation

The orchestrator hands scoped work to a seat. Three pieces:

- `src/delegation.mjs` — `validateDelegation` (pure), `renderDelegation`
  (pure), and `createDelegator`, which holds the in-flight records
- the `delegate` tool, on the channel (`channel.mjs`) and over HTTP
  (`POST /api/delegate`, owner-only)
- `src/orchestrator-bridge.mjs` — a thin MCP→HTTP shim, the mirror of
  `seat.mjs` but with no feed and no state

**The brief is validated, not trusted.** `class: "execution"` requires
non-empty `files` and `tests`, and a rejection names the missing field so the
orchestrator can repair it. This is not bureaucracy: in the end-to-end test the
worker ran the command named in `spec.tests` unprompted and reported the
result.

**Authorisation is two separate paths, and must stay that way.** `addressPolicy`
(`owner-only` / `shared`) governs which *humans* may address a seat, because a
Claude seat spends its owner's subscription. `delegatable` is a distinct,
per-seat opt-in that governs only the orchestrator. Room ownership grants
neither.

**Results are matched by identity, not position.** A pending delegation is
keyed by the id of the message that carries it, and a seat's reply is matched
against the turn that seat is actually running. An earlier version keyed by
handle on the belief that one turn per destination meant one delegation in
flight — false, because `queue.submit` gates a seat on being *online*, never on
being *busy*. That version silently dropped work.

---

## 4. The extension (`extension/`)

~2,000 lines, **CommonJS**, no runtime dependencies, no build step. The room
stays ESM; nothing crosses that boundary by import.

```
VS Code extension host
  ├─ room server        node src/server.mjs   ROOM_STANDALONE=1, port we chose
  ├─ orchestrator       claude --print --input-format stream-json …
  │                       └─ MCP stdio child: src/orchestrator-bridge.mjs
  └─ worker(s)          node scripts/room-opencode-seat.mjs
                          └─ opencode serve (loopback only)
                          └─ MCP stdio child: src/seat.mjs (reply-only)
```

| Module | Responsibility |
|---|---|
| `extension.js` | activation, startup sequence, SSE subscription, lifecycle |
| `supervisor.js` | start/watch/stop children; **kills process trees** |
| `room-client.js` | launch recipe, owner token, HTTP client |
| `orchestrator.js` | the `claude` recipe and the turn/relay interface |
| `stream.js` | `stream-json` → the small event set a chat renders |
| `events.js` | one SSE stream, fanned out to panel and orchestrator |
| `chat/` | the webview: markdown renderer, model picker, panel |

### The orchestrator is not a seat

It streams to its own UI rather than speaking through `room_reply`, so it does
not need to be the room's `@claude` channel. It needs exactly one thing from
the room — the `delegate` tool — which is why the room runs *standalone* under
the extension's control with a thin bridge, rather than being spawned as Claude
Code's MCP child. That inversion is what lets the extension choose the port,
watch health, and restart the room independently.

**One process serves every turn.** Verified: two prompts over one
`claude --print --input-format stream-json` process kept a single `session_id`
and the second turn recalled a fact from the first. A turn is one JSON line on
stdin. This is what makes it a chat rather than a cold start per message.

**`--bare` is unusable here.** It skips ambient hooks and CLAUDE.md discovery,
which is tempting — but it never reads OAuth or the keychain and demands an
`ANTHROPIC_API_KEY`. Reusing the existing subscription login is the point.

### Delegation results reach the chat as a turn

The extension holds **one** SSE subscription and fans it out: worker activity
to the panel, a completed delegation into the orchestrator's conversation as a
labelled user-role turn. One subscription rather than two keeps a single
ordering, so a worker's reply cannot reach the orchestrator before the panel
has shown the work.

---

## 5. Cross-cutting rules

These are load-bearing. Each exists because breaking it caused a real failure.

**Kill process trees, not processes.** On Windows `spawnPortable` routes a
`.cmd` shim through `cmd.exe`; `child.kill()` kills the shell and orphans the
real server, holding its port and its worktree. Observed twice.

**Never put JSON on argv.** `spawnPortable` quotes for `cmd.exe` itself rather
than trusting Node's `shell: true`, which joins arguments with plain spaces and
quotes nothing. MCP config goes to a file and the path is passed.

**stdout belongs to the MCP protocol** in `server.mjs`, `seat.mjs`,
`channel.mjs` and `orchestrator-bridge.mjs`. Every log line goes to stderr; a
stray byte on stdout corrupts the transport.

**Never `innerHTML`.** Message text, tool inputs, tool results and worker
output are all untrusted. `ui.mjs` and the extension's webview both build DOM
nodes and set `textContent`. The markdown renderer returns a `DocumentFragment`
for exactly this reason.

**Browser `<script>` tags share one global scope.** Two chat modules each
declaring a top-level `const api` is a SyntaxError that silently kills the
second script — which cost the chat its send button.
`extension/test/webview-boot.test.js` loads all three together the way a
browser does, and catches it.

**Rejections must be visible.** A dropped message the sender believes landed is
the worst failure this system can have.

---

## 6. Testing

**549 tests** (`node --test` from the repo root), 548 passing, 1 skipped — the
skip is an opt-in six-minute endurance run. 40 room test files (ESM) and 10
extension test files (CommonJS) run in one invocation; Node resolves module
type per nearest `package.json`, and `extension/package.json` deliberately has
no `"type"` field.

Nothing in the suite spawns `claude` or `opencode`, or opens a non-loopback
socket. Fakes are injected: `spawn`, `fetch`, `setTimer`, `env`, `platform`,
`exists`, plus an in-process fake OpenCode server.

**What tests cannot cover, and how it is covered instead.** Several bugs here
were invisible to unit tests because the test exercised one path while
production took another — a fixture inventing a field the real producer never
sent, a module loaded via `module.exports` in tests and a `<script>` tag in
production. The answer has been headless harnesses that compose the real
modules against the real binaries, and mutation checks that prove a test fails
when the behaviour it names is removed. Both are described in
[extension/README.md](extension/README.md).

The one thing still unverified by anything is the **webview's appearance**,
which needs a real VS Code host.
