# Multiplayer Claude Code — Design Handoff

Context transfer from a claude.ai chat session. Everything below was reasoned through or
verified against docs on 2026-08-19. Version numbers and setting keys are exact; treat
anything marked **UNVERIFIED** as an open question.

---

## 1. The goal

A multi-human, multi-agent collaboration layer on Claude Code. Teammates — and optionally
their agents — participate in a shared working session, like a chat room that has a
filesystem and can run commands.

**Hard constraints:**

- No hosted infrastructure. Everything runs on participants' machines.
- Terminal-first (Claude Code CLI, not the VS Code extension).
- Minimal setup. No forking Claude Code.
- Implementation must live at the harness level: hooks, plugins, skills, settings files,
  wrapper scripts.

**The refined value proposition** (this shifted over the conversation and is the thing to
hold onto): the win is the *shared context window*, not a shared UI. When everyone's input
lands in one context, the agent knows what the team decided and why — no one re-explains,
no one merges transcripts afterward.

Analogy that clarified it: Word vs Google Docs. Word is single-writer plus a merge step.
Claude Code today is Word. Docs killed the merge step, and that — not live cursors — is
what people actually love.

---

## 2. Design decisions already made

### 2.1 Agents are event-driven workers, not persistent chat participants

A long-lived session idling in a room waiting to be addressed fights the grain of the tool.
Better: a message mentioning an agent spawns a fresh headless run with the room transcript
plus repo as context; it posts back and exits. Stateless, restartable, survives sleep,
trivially parallel. Feels persistent to humans.

### 2.2 Addressing is explicit, silent by default

`@mentions` route deterministically. Default state for every agent is silent. Inference-based
"should I respond?" invites the failure mode where N agents all independently decide yes.
If added later, needs claim-then-speak with jitter, not independent decisions.

### 2.3 The agent turn is a serialization point

Google Docs works because a document is passive — two people in different paragraphs never
conflict, so a CRDT resolves it mechanically. An agent *takes actions on a filesystem*.
"Refactor auth" and "revert auth" arriving simultaneously cannot merge.

Closer precedent is **Google Colab**: Docs-style editing over a stateful kernel. The editing
half works; the kernel half is chaos. Avoid rebuilding Colab's worst property.

Split the artifact along that seam:

| Docs-able (concurrent, mergeable) | Not Docs-able (serialized) |
|---|---|
| Prompt composition | The agent turn itself |
| Shared plan/spec files | Tool execution |
| Pending-request queue | Write operations |
| Transcript, presence | |

### 2.4 Shared queue with live local composition

Everyone types simultaneously into their own local buffer — nobody is ever blocked on the
keyboard, which is most of what "feels like Docs" actually means. Submitted messages stack
visibly in a queue. The agent drains them serially. When Claude is mid-turn you *see* that
someone else's message is next, rather than discovering it garbled into yours.

Add presence (who's connected, who's typing, whose message is queued) → ~90% of the Docs
sensation.

### 2.5 Permission tiers

Docs' view / comment / suggest / edit maps well. Some teammates queue prompts but don't
approve destructive tool calls. The Agent SDK supports routing permission decisions to a
wrapping process, so this is implementable rather than aspirational.

### 2.6 The write-conflict problem — mostly dissolved

Originally the biggest risk: N agents editing one repo concurrently. A **single shared
session** eliminates it — one session, one filesystem, one write path. If the design ever
returns to N independent agents, the ladder is:

1. Single write lease (one agent writes, others are read-only advisors) — ships fastest
2. Per-path leases (`claim(paths)` → edit → `release()`)
3. Worktree per agent with coordinated merges — correct, but a project in itself

---

## 3. The broker / context layer

A layer that holds and curates context before it reaches the inline agent.

### 3.1 Patterns borrowed from claude-mem

claude-mem (`docs.claude-mem.ai`) runs a two-process architecture:

- Thin hooks inside Claude Code, fire-and-forget HTTP with 2s timeout
- A long-lived worker (Express on a localhost port) doing the real work
- Five hooks: SessionStart (inject), UserPromptSubmit (record/init), PostToolUse (queue
  observation), Stop (summarize), SessionEnd (cleanup)
- The context agent (`SDKAgent`) runs an Agent SDK `query()` loop with an **event-driven
  message generator** as the prompt — wakes on queued work, doesn't poll
- Critically: `disallowedTools: ['Bash', 'Read', 'Write', ...]` — **observer-only**. Pure
  text in, structured text out, no filesystem access. Cheap and safe to run constantly.
- Injection via `hookSpecificOutput.additionalContext` (silent since Claude Code 2.1.0)
- Recursion prevention: injected context wrapped in tags, stripped before storage, so the
  system never re-ingests its own output
- Structured summary schema: `request / investigated / learned / completed / next_steps`

### 3.2 The one principle that does NOT transfer

claude-mem is built around never being on the critical path — it observes retrospectively
and nothing waits on it. **A curation layer is inherently blocking.** A broker that adds 3s
per message destroys the responsiveness that is the whole point.

**Invert it: do expensive work at enqueue time, not at submit time.**

```
human types → queue → [async, per-message, Haiku, observer-only]
                        ├─ classify: for the agent, or human-to-human?
                        ├─ conflict-check against decision store
                        └─ tag: files/subsystems in scope
                              ↓ annotations land in SQLite

prompt submitted → UserPromptSubmit hook
                   → SELECT precomputed annotations + assemble template
                   → hookSpecificOutput.additionalContext   [budget: <200ms]
                   → main session
```

By submit time the annotation already exists. The synchronous step is a DB read and a
string template — no LLM call on the hot path.

### 3.3 What the broker does that claude-mem doesn't

- **Drop human-to-human traffic entirely.** Straight upgrade over having the model reply
  `NOOP` — chatter never enters the agent's context at all. Teammates still see it.
- **Batch the queue into one turn.** Three messages during a long tool call compose into one
  coherent prompt with attribution, not three re-orienting turns.
- **Flag contradictions, don't resolve them.** "Add a cache layer" vs. an earlier "keep this
  stateless." Left alone the agent picks one silently and nobody notices until review.
  This is the highest-value function of the layer and has no claude-mem analogue.
- **Carry a decision store.** Team-shaped schema: `decided / by_whom / when / supersedes /
  still_open`.

### 3.4 Non-negotiable rule

**Annotate, never rewrite.** Keep everyone's words verbatim; append a delimited annotation
block. If the broker paraphrases and gets it subtly wrong, the person who typed it will
debug the agent when the bug is in the broker.

**First thing to build:** the classifier alone. Drop chatter, pass everything else through
untouched. ~80% of the value, and testable against existing transcripts.

---

## 4. Cross-session messaging (verified facts)

Docs: `code.claude.com/docs/en/cross-session-messaging`

**Requirements:** Claude Code v2.1.224+. macOS and Linux only, including Linux under WSL 2.
No native Windows. Not on Bedrock, Claude Platform on AWS, Google Cloud Agent Platform, or
Microsoft Foundry. Disabled if `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
`DO_NOT_TRACK`, or `DISABLE_GROWTHBOOK` turns off feature-flag evaluation.

**Tools:** `ListAgents` (discover reachable agents), `SendMessage` (deliver text by name).
Claude calls them; you never do. `@`-mention targeting requires v2.1.232+.

**Routing:**

| Target | Path |
|---|---|
| Same machine | Per-session Unix socket, never through Anthropic servers |
| Another of your machines | Through Anthropic servers, over that machine's Remote Control |
| Claude Code on the web | Through Anthropic servers, straight to the cloud session |

**Same-machine gates (important):** sessions register in files on disk and bind an inbox
socket there; they reach each other only when they **see the same files** and share the
**same OS user** ("on a shared machine another user's sessions can't reach it"). Containers
have their own filesystem, so a session inside one and a session on the host cannot reach
each other.

> The docs do **not** name Anthropic account as a same-machine gate. See §6.

### 4.1 The injection primitive (this is the important part)

Documented, not reverse-engineered. Docs section is explicitly headed "read this when… you
want a script or hook to post into a session."

- `CLAUDE_CODE_MESSAGING_SOCKET` — inbox socket path, exported to hooks and Bash commands
  before any hook runs, including SessionStart
- `CLAUDE_CODE_MESSAGING_TOKEN` — per-session token
- A script posting to its own session's socket sends `{"type":"auth","token":"<token>"}` as
  the **first line** of the connection
- Also visible as the `Peer address` row in `/status` (prefixed `uds:`)

**Own-child delivery:** when no `crossSessionInbound` value applies, Claude Code delivers a
message it verifies came from the session's own child processes (hook or Bash command posting
back). Verification differs by platform:

- **Linux (incl. WSL 2):** process evidence works even after the child exits
- **macOS:** process evidence only while the posting process is still running
- **Containers where Claude Code is PID 1:** no process evidence at all

→ **Always send the token auth frame.** It's the only path that works everywhere.

### 4.2 Inbound controls

`crossSessionInbound`: `accept` | `hold` | `refuse`. Settable in `/config` row
"Messages from your other sessions" (v2.1.232+). When unset, Claude Code derives behavior
from both sessions' permission modes (bypassing vs. prompting classes).

- `isolatePeerMachines: true` — require approval before any message leaves the machine
- `dialogExpiry` — approval dialog deadline, default 5 minutes, `"never"` to disable
- Held-message cap: 100, oldest dropped past that
- To disable: deny rules on `SendMessage` and `ListAgents` (bare tool names), plus
  `crossSessionInbound: "refuse"`

### 4.3 Limits — read before designing anything conversational

- **Plain text only.** Structured agent-team protocol messages stay within a team.
- **Loops are throttled by design:** rate-limited per sender, identical repeats within a
  short window are dropped, and accepted-but-unread messages cap at 50 per session. "A
  message loop between two sessions therefore stops on its own."
- Same-machine size cap: ~1,000,000 serialized characters
- A message **cannot** approve a permission prompt or change configuration. Slash commands
  in message text arrive as plain text and never execute.
- Docs steer explicitly: if you're designing a message protocol on top of plain text, you
  want **agent teams** instead.

→ **Use cross-session messaging for request/response handoffs, not chat.**

### 4.4 Headless sessions

`claude -p` binds an inbox socket and appears in `/list-agents`, but cannot show the approval
dialog. Start unattended workers with `crossSessionInbound: "accept"` in their `--settings`.
**Bare mode binds no socket** and is invisible to the listing.

### 4.5 Addressing

`--name` flag or `/rename`. Unset → derived from working directory (e.g. `my-app-3f`).
Duplicate names on one machine get renamed to a variant; Claude Code shows working
directories in `/list-agents` to disambiguate. `/list-agents` is also aliased `/peers`.

---

## 5. Channels (the likely path for the human side)

Docs: `code.claude.com/docs/en/channels`. Shipped v2.1.80, **research preview**.

An MCP server that pushes external events into a *running* session. Events land in context
wrapped in `<channel>` tags. Can be two-way — Claude reads the event and replies back through
the same pipe. Docs explicitly name "chat messages" as a use case.

Nearly the target architecture: `teammate → broker → channel MCP server → live session`,
replies flowing back out.

**Caveats:**

- Requires Anthropic auth via claude.ai or a Console API key. Not on Bedrock, Google Cloud
  Agent Platform, or Microsoft Foundry. Team/Enterprise orgs must explicitly enable.
- `--channels` accepts only Anthropic-managed allowlisted plugins. A custom channel needs
  `--dangerously-load-development-channels` — which would be the daily driver for a homegrown
  room. Weigh this.
- Session must be open; if Claude Code isn't running the event is dropped silently.
- **Prompt-injection surface.** Any endpoint injecting text into a session is one. Gate on
  *sender identity*, not room membership. Matters more here than for a solo user, since
  teammate messages are semi-trusted input.

---

## 6. THE OPEN EXPERIMENT — run this first

Everything downstream branches on the result.

**Hypothesis:** since the documented same-machine gates are OS user + shared filesystem (not
Anthropic account), two sessions running as the same OS user with *different* credentials
should still discover each other.

```bash
# terminal 1 — your credentials
claude --name heet

# terminal 2 — same OS user, teammate's credentials
CLAUDE_CONFIG_DIR=~/.claude-teammate ANTHROPIC_API_KEY=sk-ant-... \
  claude --name teammate

# in either session
/list-agents
```

- **`teammate` appears** → premise confirmed. Proceed to §7 architecture.
- **It doesn't** → there is an undocumented account check. Cheap to learn. **UNVERIFIED**
  either way; the docs only commit to OS-user and filesystem gates.

---

## 7. Architecture if the experiment passes

Your machine holds the repo. Teammate SSHes in over Tailscale as the same OS user, starts
their own named session with their own credentials. Two independent sessions, two context
windows, two humans each steering their own — able to `SendMessage` findings and decisions.
Broker sits in front using the socket + token from §4.1.

Better than plain tmux: **kills the single-keyboard problem.** Trades shared context for
separate contexts plus a message channel — which, given §4.3 throttling, is the shape the
runtime wants anyway.

**Cost:** same OS user = shared files, processes, shell history. Trusted-team shared dev box.
Fine for 3–4 people. Not isolation; don't pretend otherwise.

### Harness-level pieces (all config, no forking)

| Piece | Mechanism |
|---|---|
| Addressing | `--name` / `/rename` |
| Unattended inbox | `crossSessionInbound: "accept"` in per-session `--settings` |
| Credential separation | `CLAUDE_CONFIG_DIR` + `ANTHROPIC_API_KEY` per session |
| Broker write path | `CLAUDE_CODE_MESSAGING_SOCKET` + `CLAUDE_CODE_MESSAGING_TOKEN` from a hook |
| Asymmetric roles | Permission deny rules on `SendMessage` / `ListAgents` |
| Egress control | `isolatePeerMachines: true` |

Bundle as a plugin: `hooks.json` + settings template + launch wrapper.

---

## 8. Ruled out, with reasons

**Wrapping the official VS Code extension** — no public API to read its chat stream or inject
into it. You'd build alongside it, not around it. The **Claude Agent SDK** (Python/TS) is the
supported way to own the message stream: same agent loop, same tools, plus in-process MCP
servers, hooks, and `canUseTool` / deferred permission callbacks.

**Slack** — Claude Tag already exists (Slack-based, `@Claude` in a thread). Doesn't meet
no-hosting or in-IDE requirements, but worth 20 minutes of evaluation if the goal ever
softens to "team collaborates with Claude."

**Microsoft Teams** — investigated in depth. Transport is free; the blocker is org policy.
Three toggles gate custom apps (user setup policy, per-team setting, org-wide setting) and
are commonly off. Two viable paths were: (A) Graph delegated polling via
`/teams/{id}/channels/{id}/messages/delta` — zero ingress, but the agent has no distinct
identity and posts as a human; (B) Azure Bot + Cloudflare/Tailscale Funnel — real bot
identity, but needs sideloading and a public ingress into a dev machine. **RSC**
(resource-specific consent) lets a team *owner* grant permissions at install time instead of
a tenant admin — the shortest approval path if this is ever revisited. Teams Graph APIs
stopped being metered on 2025-08-25. Deprioritized because it doesn't put anything in the
Claude Code window.

**OmniRoute** — a local OpenAI/Anthropic-compatible gateway (`ANTHROPIC_BASE_URL=
http://localhost:20128/v1`) that fans requests across providers with quota-aware fallback.
It sits on the **outbound inference path** and changes *who generates tokens*. Cross-session
messaging is local IPC over Unix sockets and never consults `ANTHROPIC_BASE_URL`. **The two
systems are orthogonal — routing through OmniRoute cannot grant socket visibility.** Its only
adjacent-relevant feature is Quota-Share (splitting one subscription's rate-limit quota across
a team of API keys), which is capacity pooling, not enablement.

> **ToS caution:** putting a teammate's credentials on your machine, or pooling subscription
> quota across people via a third-party gateway, is squarely in account-sharing territory.
> Read Anthropic's usage policy before building on it. The clean version is each person using
> their own key in a session they start themselves.

---

## 9. Still unsolved

**The cross-machine hop for a different human.** Reaching a session on another box goes
through Remote Control — *your own machines, your own account*. A teammate's laptop running
as that teammate will never appear in your `/list-agents`, regardless of configuration.

If sessions must live on separate people's hardware, that transport is yours to build. Options
sketched earlier:

- **Tailscale mesh + elected room host** — tiny WebSocket server on whoever starts the session;
  real-time, dies when that laptop closes
- **Git as message bus** — orphan branch, one JSON file per message
  (`room/{ts}-{author}-{uuid}.json`) so merges *never* conflict; poll-pull every ~3s. Latency
  3–10s. Zero setup for teammates, uses existing auth and access lists.

Build transport behind an interface either way; §7 and this section then become a swap rather
than a rewrite.

---

## 10. Suggested order of work

1. Run the §6 experiment. Everything branches on it.
2. Build the §3.3 classifier alone — drop chatter, pass the rest through untouched.
3. Prove the §4.1 write path: ten-line script reading socket + token from env, posting one
   line into its own session.
4. Queue + presence (§2.4). Do not make the agent turn concurrent.
5. Only then: cross-machine transport (§9).
