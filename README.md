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
                                     │                    ┌─► @claude
 local hooks ──POST /hook/:evt───────►   room server   ────┤   (host's session, host's account)
                                     │  (one process)     │
 seat hooks ──POST /seat/hook/:evt───►                    ├─► @ana-agent
                                     │                    │   (Ana's account, Ana's login)
                     observer ◄──────┘                    └─► @devops
              (tracks forks, reversals)                        (their machine, their account)
```

Two ways to take part, and the difference matters:

- **`@claude`** is the host's own session. Anyone in the room can address it, and every
  token it spends comes off the **host's** plan. This is the shared context window.
- **`@ana-agent`** is an *agent seat*: a second Claude Code process running under its own
  `CLAUDE_CONFIG_DIR`, where Ana did her own `/login`. By default only Ana can address it,
  and its cost lands on Ana. **No credential is ever copied, forwarded, or stored** —
  that isolation is the entire reason this design is legitimate rather than account
  sharing.

Seats see the conversation (their turns and everyone's replies are mirrored to them) but
each runs its own context. An **observer** watches the room and writes a short brief —
open threads, forks, who walked back on what — which is injected ahead of each turn so
seats that have compacted independently get re-synchronised from the room's own record.

---

## Status

Working and tested, with one honest gap. **365 tests** (`node --test`), plus an opt-in
endurance run (`ROOM_ENDURANCE=1`) that idles a real six minutes to prove seat feeds
survive undici's 300s body timeout.

What has been exercised end to end:

- the shared `@claude` session, with several browsers driving it
- agent seats over the full HTTP/SSE protocol — addressing, mirroring, per-seat turns,
  cost attribution, eviction, reconnection
- the observer, on a real conversation containing a genuine fork and walk-back

**Not yet run for real: two seats logged into two different Anthropic accounts.** Every
demo so far has driven the seat protocol with a stand-in rather than a second real
`/login`. The room-side code is the shipped code, but `scripts/room-seat.mjs` launching a
genuine second Claude Code under its own `CLAUDE_CONFIG_DIR` has never been verified with
two accounts. Treat that path as unproven.

This is a personal project, not an Anthropic product. It uses
`--dangerously-load-development-channels`, because custom channels are not on the
Anthropic-curated allowlist — read [Security](#security) before pointing it at anything
that matters.

## Is sharing a session allowed?

Worth reading before you invite anyone. Not legal advice, and terms change — check
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and
[Commercial Terms](https://www.anthropic.com/legal/commercial-terms) yourself.

**Credentials are never shared by this project, in any mode.** The Consumer Terms are
unambiguous there: *"You may not share your Account login information, Anthropic API key,
or Account credentials with anyone else."* Nothing here copies, forwards, or stores a
credential, and `room-seat.mjs` actively strips `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` so it cannot become the thing that authenticates a session.

The harder question is the shared `@claude` session, where other people's text runs on
**your** account. The same paragraph continues: *"You also may not make your Account
available to anyone else. You are responsible for all activity occurring under your
Account."*

How much that bites depends on what you are doing:

| Situation | Read |
|---|---|
| Your own personal Pro/Max account, other people driving `@claude` | **Hard to defend.** On a plain reading this is making your Account available to someone else. Don't. |
| You at the keyboard, colleagues suggesting input, you watching | Closer to pair programming over a screen share. Defensible — but it weakens the more unattended it gets. |
| Colleagues on the **same Team/Enterprise org**, all already licensed | No clause found prohibiting it; the org is the customer and everyone is a licensed user. But Team is billed and metered **per seat**, so one person's limits absorb everyone's work. Not obviously a terms breach; do ask Anthropic if it matters commercially. |
| Agent seats (`@ana-agent`) | **Unambiguously fine.** Each person authenticates themselves and spends their own quota. This is why the feature exists. |

The honest summary: **agent seats are the mode this project is comfortable recommending.**
The shared session is genuinely useful and is the reason the project exists, but treat it
as *you, with your team feeding you input* — not as a way to give several people an
account they do not have.

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

Five steps from a clone to a teammate typing in the room.

### 1. Install

```bash
git clone https://github.com/heetshah16/claude-room
cd claude-room
npm install          # one dependency: @modelcontextprotocol/sdk
node --test          # optional: 365 tests, ~10s
```

### 2. Choose where it listens

```bash
export ROOM_HOST=$(tailscale ip -4)   # reachable by your tailnet, and nobody else
export ROOM_NAME=auth-work
```

Bind to `0.0.0.0` instead if you also want people on the local network. Either way the room
works out which address to put in join links — it prefers the tailnet address (Tailscale's
100.64.0.0/10 range) over a LAN one, because `0.0.0.0` is a bind address and not somewhere
anyone can browse to. Override with `ROOM_ADVERTISE` if you have a MagicDNS name you would
rather hand out.

### 3. Start the session

From the repo you want the team working in:

```bash
claude --dangerously-load-development-channels server:room \
       --settings ~/.claude/channels/room/settings.hooks.json
```

The hooks settings file is **generated by the room**, not checked in: it carries the
room's hook token, and `POST /hook/*` refuses anything without it. Start the room once
and it prints the exact path:

```
room: hooks: launch the local session with --settings /path/to/settings.hooks.json
```

It is rewritten on every boot, so a changed port or a rotated token never leaves you
pointing at a file that no longer authenticates. Agent seats get their own equivalent
automatically — `room-seat.mjs` writes one into each seat's config dir, pointed at that
seat's own `/seat/hook/*` routes. Without it a seat never fires `Stop`, never closes its
turn, and wedges after a single message.

Two dialogs appear the first time: a full-screen development-channels warning (choose
**I am using this for local development**) and an MCP server consent prompt (choose **Use
this MCP server**). The warning appears at every start — custom channels are not on the
Anthropic-curated allowlist, and that is the standing cost of this approach.

### 4. Invite people

On first run the room bootstraps an owner and prints a join URL to stderr:

```
room: join: http://100.x.y.z:8787/?token=…
```

Open that yourself, then hand out links for everyone else:

```bash
export ROOM_ADMIN_TOKEN=<the owner token from that URL>
node scripts/room-admin.mjs invite ana member
node scripts/room-admin.mjs invite sam viewer      # can read, cannot spend tokens
```

Each prints a join link. **The token is the identity** — send them privately, and use
`rotate` if one leaks. They open the link in a browser and start typing; `@claude`
addresses the shared session, anything else is chatter that costs nothing.

### 5. (Optional) Give someone their own agent

Everything above spends **your** plan. If you would rather a teammate's work came off
theirs, give them a seat:

```bash
node scripts/room-admin.mjs seat add "ana's claude" --owner ana --handle ana-agent
# → run: node scripts/room-seat.mjs ana-agent --token <token> --repo <path-to-repo>
```

Ana runs that command **on a machine she controls**, in a real terminal. The first run
lands in a fresh `CLAUDE_CONFIG_DIR` and prompts her own `/login`. From then on
`@ana-agent` is hers: only she can address it, and its tokens come off her account. See
[Multiple agents](#multiple-agents) for what seats can and cannot see.

> **Not yet verified with two real accounts.** See [Status](#status).

## Running the room

Administration happens against the **running** room, so nothing needs a restart. Point the
CLI at an owner token:

```bash
export ROOM_ADMIN_TOKEN=<the owner token from the join URL>
node scripts/room-admin.mjs list
```

Owners get the same controls as a panel in the browser sidebar.

| Command | What it does |
|---|---|
| `list` | Members, roles, join links, bans, current agent handle |
| `invite <name> [role] [--approve] [--payer <url>]` | Create a member, print their join link |
| `remove <name>` | Revoke the token **and cut their live stream immediately** |
| `ban <name> [--reason "…"] [--address]` | Remove them and stop the name being reused |
| `unban <name>` | Lift it |
| `role <name> <owner\|member\|viewer>` | Change what they can do |
| `mute <name> [on\|off]` | Stop them addressing the agent, without demoting them |
| `approve <name> [on\|off]` | Grant or revoke tool-approval authority |
| `rename <name> <newName>` | Rename a member |
| `rotate <name>` | Issue a new link and kill the old one — use when a link leaks |
| `payer <name> <url>` | Set their credential endpoint for payer rotation |
| `handle <@name>[,<@name>…]` | **Rename the agent.** `@claude` becomes `@ada` for everyone, at once |
| `seat add <name> --owner <member> [--handle <h>]` | Create an agent seat and print its launch command |
| `seat policy <name> <owner-only\|shared>` | Who may address a seat. `owner-only` is the default |
| `pause [on\|off]` | Stop taking work; conversation carries on |
| `clear-queue` | Drop everything waiting |
| `budget [--tokens N] [--messages N]` | Change per-member limits at runtime |

Notes on the sharp edges:

- **The token is the identity.** Send join links privately; `rotate` is the fix if one leaks.
- **The last owner cannot be removed, demoted, or banned.** A room with no administrator is
  unrecoverable except by editing state on disk.
- **Address bans are opt-in (`--address`) and never inferred.** Banning whatever address
  someone last used looks helpful and is a footgun: on loopback, behind NAT, or on shared
  office wifi that address belongs to other people too — including the owner issuing the
  ban. Loopback and any address an owner is currently using are refused outright.
- **`mute` and `viewer` are different tools.** Muting is "stop talking over this turn" and
  survives a role change; `viewer` is structural.

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

## Multiple agents

Everything above is one shared Claude Code session, on the host's account. A room can also
hold several independent agent sessions at once — a **seat** — each one a separate Claude
Code process, run by a different person, under that person's own account, addressable by its
own `@handle`:

```bash
export ROOM_ADMIN_TOKEN=<owner token>
node scripts/room-admin.mjs seat add ana-agent --owner ana
# → seat added: ana-agent (@ana-agent), owned by ana
#   run: node scripts/room-seat.mjs ana-agent --token <token> --repo <path-to-repo>

node scripts/room-admin.mjs handle @claude,@ana-agent
```

`seat add` only registers the seat; a handle has to also be added with `handle` (or
`ROOM_HANDLES`) before `@ana-agent` is recognised as a mention.

### `CLAUDE_CONFIG_DIR` is the whole reason this is legitimate

`scripts/room-seat.mjs` launches `claude` with `CLAUDE_CONFIG_DIR` pointed at a directory of
the seat owner's own choosing. First run prompts `/login`, right there in their own terminal,
for their own Anthropic account. Nothing in this codebase reads, copies, or forwards a
credential from one config directory to another, or from a person's machine to the room's
host — the room server only ever hands out an opaque, revocable per-seat join token, the same
kind every other member gets. **No credential is ever copied, forwarded, or stored** by the
room itself. That isolation is not an implementation detail; it is the property that makes
letting other people's agents into your room defensible at all.

### Owner-only addressing

Only the member who owns a seat may address it. Anyone else's `@ana-agent` is refused with
`not-your-seat`; addressing a seat whose connection isn't open is refused with `seat-offline`.
Both show up as a visible note in the room, exactly the way a rate-limit or budget rejection
already does — a message someone believes was sent and wasn't is the one failure this design
cannot allow.

This isn't a permission nicety. `ana-agent` runs under ana's Anthropic account: every message
it acts on becomes a real turn billed to ana, using ana's own model access. If anyone in the
room could address it, anyone could get ana's account to serve their request without ana ever
choosing to. Room ownership doesn't override this either — the room owner has no more claim
on someone else's seat than any other member does.

### Mirroring multiplies ingestion

Every live seat is echoed a quiet copy of what happens elsewhere in the room — the message
that addressed one seat, the reply it gave — tagged as a mirror and never carrying a `user`,
so the receiving agent can tell at a glance it is context, not a request, and is instructed
not to act on it even if it looks like one. In the browser this renders muted and italic with
a small "mirror" tag, deliberately quieter than the bold, bordered treatment of a message
actually addressed to an agent.

The cost consequence: with N seats online, one addressed exchange is ingested by all N of
them — once as the real turn, N−1 times as mirrored context on every other seat. Each seat's
share of that lands on its own owner's account, never on the addressee's, so mirroring does
not concentrate cost onto one person — but the total ingestion, and the total bill across the
room, both grow with every seat you add.

### A seat on someone else's machine

Running a seat means that person's Claude credentials live on hardware you do not control,
for as long as their session runs there. Say this plainly, because it is easy to lose in the
mechanics above: that is their decision to make knowingly, not something to assume on their
behalf because the isolation is technically sound. The same trust question you'd ask before
handing someone your laptop while you're logged in applies here.

### Watching it

The **Agents** card in the sidebar lists every seat currently online — handle, owner, a live
dot, and tokens spent — refreshed as seats come and go. `.superpowers/sdd/2026-08-25-agent-seats/two-seats.mjs`
boots a standalone room, registers two seats owned by two different people, and prints the
exact commands to bring each one up in its own terminal, so owner-only addressing, both
refusal reasons, and mirroring can all be watched end to end.

## The observer

Off by default. `ROOM_OBSERVER=1` starts a second, **tool-less** agent that watches the room
and keeps a structured brief of conversation state — open threads, where the discussion
forked, who walked something back, and what Claude already tried and how it went.

When someone addresses Claude, that brief is delivered as **its own channel event
immediately before their message**:

```
<channel source="room" kind="brief" age_s="3" pending="0">
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
someone addresses Claude, whatever brief exists is injected with its `age_s` and a `pending`
count of messages it does not yet reflect.
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

### Payer rotation — tested, and unavailable on subscription plans

The design was: `ROOM_PAYER_MODE=rotate` makes the queue pick a payer per turn, `apiKeyHelper`
points at `scripts/room-payer.mjs`, and each turn draws the credential of whoever asked. On
Team plans that would raise the ceiling roughly N times, because the binding constraint is
the per-seat 5-hour and weekly allowance rather than dollars.

**It does not work with claude.ai subscription or Team auth.** Measured 2026-08-22 with a
two-arm test:

| Arm | `apiKeyHelper` returns | Result |
|---|---|---|
| baseline | nothing (stored login) | works |
| control | a deliberately invalid token | hangs, times out |
| real | a valid subscription OAuth access token | hangs, times out |

The control arm proves the helper is consulted and authoritative — Claude Code does not fall
back to the stored login. The real arm then shows a subscription OAuth access token supplied
that way does not authenticate. The helper's value is sent as `X-Api-Key`/`Bearer` without
the `anthropic-beta: oauth-2025-04-20` header that OAuth tokens require.

Two consequences:

- **Rotation requires Console API keys** (`sk-ant-api…`), one per member, and is unavailable
  to teams on Pro/Max/Team subscriptions. The server detects this at startup and falls back
  to `host` mode with a warning rather than hanging.
- **A bad payer credential stalls the room, it does not error.** The session retries until it
  times out. `room-payer.mjs` therefore validates the shape of anything it is handed and
  falls back to the host credential rather than passing along something unusable.

Swapping `CLAUDE_CONFIG_DIR` or the credentials file *does* work, but it is per-process: it
needs a session restart, which destroys the shared context window the room exists to provide.

If you do have Console API keys, a `--payer` value is a URL on that member's **own** machine
returning their key; the helper fetches it per turn over the tailnet, so nothing is stored at
rest on the host. Note that for the life of that credential the host process can spend on
that account — the "no credentials leave your machine" property holds for `host` mode, not
for rotation.

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
| `ROOM_PORT` | `8787` | HTTP port. The hooks settings file is regenerated to match. `0` picks a free one |
| `ROOM_ADVERTISE` | auto | Host used in join links; auto-detects the tailnet address |
| `ROOM_HANDLES` | `claude` | Agent @handle(s), comma separated. Changeable at runtime |
| `ROOM_TRUST_PROXY` | off | Believe `X-Forwarded-For`. Leave off unless a reverse proxy really is in front: the header is client-written, and trusting it makes an address ban trivial to evade |
| `ROOM_PAUSED` | off | Start paused |
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
- **Hook routes are authenticated too.** `POST /hook/*` requires the room's own hook
  token, which is why the settings file is generated rather than checked in. Without
  this, anyone who could reach the port could end the host's in-flight turn, forge ledger
  entries, and broadcast fake tool activity to every browser.
- Bind to the Tailscale interface, never `0.0.0.0`.
- Request bodies are capped (1MB JSON, 25MB uploads) and the socket is destroyed on
  overflow, so no single request can exhaust the room's memory.
- `X-Forwarded-For` is **ignored** unless `ROOM_TRUST_PROXY` is set. It is a
  client-written header, and believing it makes an address ban trivial to evade.
- Member names and agent handles are validated. A batched turn renders to the model as
  `[name] text` per line, so a name containing a bracket or a newline could otherwise
  forge a line from someone else.
- State files are written atomically with a `.bak`, and a corrupt file **refuses to
  start** rather than being mistaken for an empty one — a torn `members.json` read as "no
  members" would silently invalidate everyone's token.
- Seats never share credentials. `room-seat.mjs` deliberately strips `ANTHROPIC_API_KEY`
  and `ANTHROPIC_AUTH_TOKEN` so it can never be the thing that authenticates a session.
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

294 tests, no network and no Claude Code required. The pure modules — router, ledger,
identity, decisions, queue, turns, brief, observer, admin, seats, fanout — carry the
load-bearing logic and are tested directly. The observer takes `runModel` as an injected seam,
so its whole cycle is exercised without spawning a subprocess or spending a token.

## Design notes

- `docs/superpowers/specs/2026-08-19-claude-room-design.md` — the design and its decision record
- `docs/superpowers/plans/2026-08-19-claude-room.md` — the implementation plan
- `multiplayer-claude-code-handoff.md` — the prior exploration this supersedes
