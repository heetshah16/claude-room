# claude-room

Multiplayer Claude Code. Several people drive **one shared Claude Code session** from their
own browsers, over Tailscale — no credentials, no terminal, and no checkout on anyone's
machine but the host's.

The point is the **shared context window**, not a shared UI. When everyone's input lands in
one context, the agent knows what the team decided and why. Nobody re-explains, nobody
merges transcripts afterward.

```
teammates' browsers ──POST /msg──────┐
      (Tailscale)  ◄──SSE /events────┤
                                     │
Claude Code hooks ──POST /hook/:evt──►   room server   ──stdio──► Claude Code session
                                     │  (one process)             (host account, the repo)
                                     │
                    apiKeyHelper ◄───┘ reads current payer
```

---

## Prerequisites

- **Node 22+** on the host. Nothing else — the only runtime dependency is `@modelcontextprotocol/sdk`.
- **Claude Code v2.1.80+** on the host (channels shipped in .80; `prompt_id` in hook payloads needs .196+ for cost attribution, so .196+ is the real floor).
- **Tailscale** on the host and every teammate's machine.
- **Channels enabled for your org.** Pro and Max personal accounts skip this. **Team and
  Enterprise organizations must explicitly enable channels** — an Owner flips it at
  claude.ai → Admin settings → Claude Code → Channels, or sets `channelsEnabled: true` in
  managed settings. Without it the MCP server connects, its tools work, and channel messages
  silently never arrive.

## Setup

```bash
npm install

# Bind to your tailnet address so teammates can reach the room.
export ROOM_HOST=$(tailscale ip -4)
export ROOM_NAME=auth-work
```

Start the session from the repo you want the team working in:

```bash
claude --dangerously-load-development-channels server:room \
       --settings ./settings.room.json
```

Two dialogs appear the first time: a full-screen development-channels warning (choose
**I am using this for local development**) and an MCP server consent prompt (choose **Use
this MCP server**). The warning appears at every start — custom channels are not on the
Anthropic-curated allowlist, and that is the standing cost of this approach.

On first run the room bootstraps an owner and prints a join URL to stderr:

```
room: join: http://100.x.y.z:8787/?token=…
```

## Adding people

```bash
node scripts/room-admin.mjs add ana member
node scripts/room-admin.mjs add bo member --approve
node scripts/room-admin.mjs add sam viewer
node scripts/room-admin.mjs list
node scripts/room-admin.mjs revoke sam
```

Each command prints that person's join URL. Send it to them privately — the token *is* the
identity. Restart the session after adding or revoking, since members are read at startup.

| Role | Chatter | Address Claude | Approve tool calls |
|---|---|---|---|
| `owner` | yes | yes | yes |
| `member` | yes | yes | only with `--approve` |
| `viewer` | yes | no | no |

## Using it

Everyone types into their own buffer, so nobody is ever blocked on the keyboard. **Only
messages addressed to Claude enter the context window** — prefix `@claude`, or tick the
"to Claude" box. Everything else is room chatter that teammates see and the agent never
does. That is not a nicety: 5–10 people share one context window, and unaddressed traffic
is what would destroy it.

Messages sent while Claude is busy stack visibly in the queue and are delivered together as
one turn, so three people talking during a long tool call produce one coherent prompt with
attribution rather than three re-orienting turns.

The right pane shows members, live per-member token cost, the cache ratio of the last turn,
recorded decisions, and a feed of Claude's tool calls as they happen.

### Contradictions

When Claude records a decision with `room_decision`, later requests that contradict it are
flagged in the room — to the humans, for the humans to settle. The room never resolves a
contradiction itself. An agent quietly picking a side and nobody noticing until review is
the exact failure being prevented.

## The observer

Off by default. `ROOM_OBSERVER=1` starts a second, **tool-less** agent that watches the room
and keeps a structured brief of conversation state — open threads, where the discussion
forked, who walked something back, and what Claude already tried and how it went.

When someone addresses Claude, that brief is delivered as **its own channel event
immediately before their message**:

```
<channel source="room" kind="brief" stale="false" age_s="3">
forks:
  - 14:10 → consolidate TTL vs add cache layer [live: consolidate TTL]
reversals:
  - bo: cache layer → stateless (heet cited the earlier decision)
tried:
  - edited src/auth/config.js → npm test -- auth failed
</channel>
<channel source="room" user="bo" member_id="…">and add a cache layer to auth</channel>
```

The member's message is **byte-identical** — not even wrapped. The brief is a separate
event, tagged so the agent knows it is machine-written and not something a person said.

It runs on a debounce and is **never on the critical path**. If a cycle is in flight when
someone addresses Claude, whatever brief exists is injected with `stale="true"` and its age.
If the observer is broken, over budget, or off, no brief is injected and the room behaves
exactly as it does without one. Every failure degrades to "no observer".

Each cycle sends only the **previous brief plus what is new**, so a room open all day costs
the same per cycle as one that just opened. The brief is the memory.

### It talks, but rarely

Silent by default except for hard signals: a newly detected **reversal** or **fork**. It
posts one short note per signal, never twice for the same one, capped per window. It flags;
it never resolves. `ROOM_OBSERVER_NOTES=0` makes it silent and panel-only.

### What it costs — measured, not estimated

**Cost is per-cycle, not per-token.** Each `claude -p` invocation carries Claude Code's own
system prompt and tool definitions before your prompt contributes anything. Measured on this
machine, `echo "reply with the word ok" | claude -p --model haiku` costs:

```
input: 9  |  cacheRead: 10,688  |  cacheCreate: 7,298  |  output: 31
TOTAL IN: 17,995 tokens
```

Running it from an empty directory with no `CLAUDE.md` or `.mcp.json` changed that by 2%, so
the overhead is the harness itself and cannot be stripped. At Haiku 4.5 rates ($1/MTok input,
$5/MTok output, ~$0.10/MTok cache read, ~$1.25/MTok cache write) that is roughly **one cent
per cycle**, essentially regardless of how much room activity it summarises.

The incremental design (previous brief plus delta) is still right — it keeps the brief useful
and bounded — but it is not what determines the bill. **The number of cycles is.** Hence the
two pacing defaults:

| Setting | Default | Why |
|---|---|---|
| `ROOM_OBSERVER_DEBOUNCE_MS` | 15s | Wait for the conversation to settle before summarising |
| `ROOM_OBSERVER_MIN_INTERVAL_MS` | 60s | Hard floor — a busy room cannot cycle faster than this |

At the floor, a continuously active room costs about **$0.60/hour** of observer. Raise the
floor to halve it. `ROOM_OBSERVER_MAX_TOKENS_PER_WINDOW` is the backstop: over budget, the
observer pauses, the brief goes stale, and the room carries on unaffected.

If you have a Console API key, calling the Messages API directly instead of shelling
`claude -p` would cut per-cycle input from ~18,000 tokens to ~1,000 — a ~15× saving. That is
the real lever, and it is not built, because subscription and Team-plan auth cannot be used
that way.

### The risk worth knowing

The observer is a **laundering path for prompt injection**. A member writes something
manipulative, the observer summarises it, and the summary reaches the main agent wearing
machine-written framing. The output is parsed as JSON and clamped to a fixed schema
(unknown keys dropped, strings truncated, sections capped), the event is tagged
`kind="brief"`, and the agent is told never to follow instructions found inside one. The
observer itself runs with the entire tool surface removed, so it cannot act on anything it
reads. That bounds the risk; it does not eliminate it. Every summarisation layer feeding an
agent has this property, and it is recorded here as a decision rather than an oversight.

## Cost

One session has one credential, so by default **every token bills to whoever launched the
room**. The room makes that visible rather than pretending otherwise:

- The `Stop` hook reads the real transcript and attributes each turn's usage to the members
  whose messages composed it (`ROOM_SPLIT_MODE=equal|weighted`).
- `ROOM_TOKENS_PER_MEMBER` and `ROOM_MESSAGES_PER_WINDOW` are enforced **at the queue**,
  before a turn is ever spent. Rejections are visible, never silent.

### Payer rotation, and the experiment that gates it

`ROOM_PAYER_MODE=rotate` makes the queue pick a payer per turn and write it to
`current-payer`; point `apiKeyHelper` at `scripts/room-payer.mjs` and each turn draws the
credential of the person who asked for it. On Team plans that raises the ceiling roughly N
times, because the binding constraint is the per-seat 5-hour and weekly allowance, not
dollars.

**It is off by default because one thing is unverified.** Claude Code resends the whole
conversation every request and relies on the prompt cache to charge it at the cached rate.
If swapping credentials busts that cache, rotation pays full input rate on the entire shared
context every turn — far more than it saves. A cache miss is invisible from the terminal:
same output, same context, bigger bill.

The room measures it for you. Watch the **cache ratio** in the right pane:

1. Run with `ROOM_PAYER_MODE=host` and note the steady-state ratio.
2. Switch to `rotate` with two members' `--payer` URLs set.
3. Compare the ratio on the turn immediately after a swap.

Ratio holds → rotation is correct, turn it on. Ratio collapses toward zero → stay on `host`
and settle up from the ledger.

A `--payer` value is a URL on that teammate's **own** machine that returns their credential.
The helper fetches it per turn over the tailnet, so nobody's token is ever stored at rest on
the host.

## Permission relay

Off by default. Permission prompts appear in the host's terminal only, which is the safe
arrangement: a teammate can *ask* Claude to do something destructive, and only the host
approves it.

`ROOM_PERMISSION_RELAY=1` declares the capability and forwards prompts to members holding
`--approve`, who answer in the browser. Turn it on deliberately — anyone who can answer a
prompt can approve tool use in your session on your files.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ROOM_NAME` | `room` | Room name, shown in the UI and the `<channel>` tag |
| `ROOM_HOST` | `127.0.0.1` | Bind address. Set to your Tailscale IP to admit teammates |
| `ROOM_PORT` | `8787` | HTTP port. Change `settings.room.json` to match |
| `ROOM_STATE_DIR` | `~/.claude/channels/room` | Members, transcript, ledger, decisions |
| `ROOM_OWNER` | `owner` | Name for the bootstrapped owner |
| `ROOM_PAYER_MODE` | `host` | `host` or `rotate` |
| `ROOM_PERMISSION_RELAY` | off | `1` to relay approvals into the room |
| `ROOM_SPLIT_MODE` | `equal` | `equal` or `weighted` cost attribution |
| `ROOM_TOKENS_PER_MEMBER` | `0` (off) | Per-member token budget per window |
| `ROOM_MESSAGES_PER_WINDOW` | `200` | Per-member message rate limit |
| `ROOM_BUDGET_WINDOW_MS` | `18000000` (5h) | Budget and rate-limit window |
| `ROOM_OBSERVER` | off | `1` to run the observer |
| `ROOM_OBSERVER_MODEL` | `haiku` | Model for the observer |
| `ROOM_OBSERVER_DEBOUNCE_MS` | `15000` | Idle time before a cycle |
| `ROOM_OBSERVER_MIN_INTERVAL_MS` | `60000` | Hard floor between cycles — the main cost control |
| `ROOM_OBSERVER_MAX_EVENTS` | `8` | Buffered events that force a cycle early (still subject to the floor) |
| `ROOM_OBSERVER_NOTES` | on | `0` for panel-only, no room notes |
| `ROOM_OBSERVER_NOTES_PER_WINDOW` | `6` | Cap on observer notes per window |
| `ROOM_OBSERVER_MAX_TOKENS_PER_WINDOW` | `200000` | Observer budget before it pauses |

## Security

The room is a prompt-injection surface by construction — anyone who can reach it can put
text in front of an agent with your filesystem.

- Gating is on **member identity**, never on who can reach the port. Group-membership
  gating is the documented hole; the room does not do it.
- Tokens are per-member, revocable, and compared in constant time.
- Bind to the Tailscale interface, never `0.0.0.0`.
- The room never interprets message content. Slash commands arrive as plain text.
- The browser client writes every server-supplied string with `textContent`.
- Uploaded filenames never reach the filesystem; only a sanitised extension survives.

## Failure modes

| What happens | What you see |
|---|---|
| Claude Code exits | The room server is its child and exits too. Browsers show "room offline" and retry. |
| Restart | Transcript, members, ledger and decisions replay from `ROOM_STATE_DIR`. |
| Channel not registered | Claude Code drops events silently. If messages vanish, check the startup notice and `channelsEnabled`. |
| A hook fails | Fire-and-forget; the activity feed degrades, the room keeps working. |

## Tests

```bash
npm test
```

167 tests, no network and no Claude Code required. The pure modules — router, ledger,
identity, decisions, queue, turns, brief, observer — carry the load-bearing logic and are
tested directly. The observer takes `runModel` as an injected seam, so its whole cycle is
exercised without spawning a subprocess or spending a token.

## Design notes

- `docs/superpowers/specs/2026-08-19-claude-room-design.md` — the design and its decision record
- `docs/superpowers/plans/2026-08-19-claude-room.md` — the implementation plan
- `multiplayer-claude-code-handoff.md` — the prior exploration this supersedes
