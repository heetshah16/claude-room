# Agent Seats — Design Spec

**Date:** 2026-08-25
**Status:** Approved for implementation
**Builds on:** `2026-08-19-claude-room-design.md`, `2026-08-22-room-observer-design.md`

---

## 1. Goal

Several Claude Code sessions, **each authenticated as a different person**, joined to one
room, sharing a replicated conversation.

```
@heet-agent   host machine, heet's login,  host repo
@ana-agent    host machine, ana's login,   host repo
@devops       devops's own machine, own login, own checkout
```

Every seat draws its owner's quota. No credential is ever transported, intercepted, or
substituted: each seat is genuine Claude Code performing its own OAuth against its own
config directory.

## 2. Why this replaces payer rotation

Rotation is dead and should not be revived. Two findings closed it:

- `apiKeyHelper` rejects subscription OAuth tokens (measured 2026-08-22; the session hangs
  rather than erroring).
- A proxy substituting `Authorization` on the wire works, but is a third-party harness.
  Anthropic disabled OAuth tokens for third-party use around 2026-02-20
  (`"OAuth authentication is currently not supported."`), and the Consumer Terms forbid
  making an account available to anyone else.

Seats avoid the entire question. Nothing intercepts anything; N sanctioned clients run
side by side.

## 3. What replicates, and what does not

The room is the source of truth. Each seat is fed from it.

| Component | Replicates | Mechanism |
|---|---|---|
| System prompt, CLAUDE.md, MCP tools, skills | exactly | same config per seat |
| Human messages addressed to any seat | exactly | same channel event to every seat |
| Agent replies | exactly | every `room_reply` mirrored to every other seat |
| Observer brief | exactly | one brief, broadcast |
| Recorded decisions | exactly | one store |
| What another agent *did* | as a digest | `TurnLog` → tool names, arguments, outcome |
| Raw tool results (file contents, command output) | **no** | deliberately: this is each seat's own working memory |
| Thinking blocks | **no** | never returned by the API |
| Compaction state | **no** | each session compacts independently |

**Byte-identical windows are impossible and unwanted.** Semantic equivalence of the
conversation is the target, with each seat keeping its own working context and its own free
space.

### Compaction drift, and why the observer is the fix

Independent compaction is the one failure that matters: two seats summarise the same history
differently and neither knows. The observer brief is regenerated **from the room's record**,
never from any seat's context, so it carries no seat's compaction damage. Injecting it before
every addressed turn re-synchronises seats that have drifted.

This makes the observer the room's canonical shared memory rather than a convenience.

## 4. Architecture inversion

Today the room server is spawned by one Claude Code session as an MCP stdio child, which is
why "room alive" has meant "session alive". With N seats that no longer holds.

The room becomes a **standalone hub**. Every seat — local or remote — joins over the same
HTTP protocol.

```
browsers ──────────────┐
                       ▼
              room server (standalone)
        routes @handle · mirrors · brief · ledger
           │              │                 │
   HTTP/SSE│      HTTP/SSE│         HTTP/SSE│  (tailnet)
   ┌───────▼──┐  ┌────────▼──┐   ┌──────────▼────────┐
   │ seat.mjs │  │ seat.mjs  │   │ seat.mjs          │
   │ in heet's│  │ in ana's  │   │ on devops's box   │
   │ session  │  │ session   │   │                   │
   └──────────┘  └───────────┘   └───────────────────┘
```

`seat.mjs` is a channel MCP server each Claude Code session loads. It is the same file for
local and remote seats; only the room URL differs. Local seats point at `127.0.0.1`.

Liveness becomes explicit: a seat is online while its SSE connection is open.

## 5. Seat protocol

All authenticated by the seat's member token.

| Route | Direction | Purpose |
|---|---|---|
| `POST /seat/join` | seat → room | register handle, receive seat id and seed |
| `GET /seat/events` | room → seat (SSE) | `turn`, `mirror`, `brief`, `seed`, `shutdown` |
| `POST /seat/reply` | seat → room | the agent's reply into the room |
| `POST /seat/hook/:event` | seat's hooks → room | activity, turn close, usage |

Events delivered to a seat become channel notifications in its session:

- `kind="turn"` — you are addressed; batched messages, verbatim, with attribution in meta
- `kind="brief"` — the observer's state summary (existing behaviour)
- `kind="mirror"` — context only: another human's addressed message, another agent's reply,
  or a digest of another agent's turn. **Never a request to act.**
- `kind="seed"` — on join: brief, open decisions, recent addressed messages and replies

## 6. Fan-out policy

What each seat receives, and what it does not:

| Room event | To the addressed seat | To other seats |
|---|---|---|
| Human message addressed to a seat | `turn` | `mirror` |
| Human chatter (no mention) | — | — |
| Agent reply | — | `mirror` |
| Agent turn closed | — | `mirror` (digest: tools, args, outcome) |
| Observer brief | `brief` before each turn | on change |

**Chatter reaches seats only through the brief.** This preserves the original cost control —
unaddressed traffic never enters any context window — while the observer distils what
mattered. It is the reason the observer is load-bearing here rather than optional.

## 7. Addressing and loop damping

- `@<handle>` routes to exactly one seat.
- **Only a seat's owner may address it.** Enforced at the router. If anyone could address
  `@ana-agent`, Ana's account would be serving another person's request, which is the line
  this design exists to stay on the right side of.
- **Agents cannot address agents.** Mirror events are never routed as requests; a handle
  mentioned inside an agent reply is text, not a route. This makes agent↔agent loops
  structurally impossible rather than rate-limited.
- Agent-to-agent addressing stays unbuilt. If it is ever added it needs hop counts, per-pair
  rate limits and duplicate suppression, which is a project in itself.

## 8. Cost

Each seat's hooks post to the room tagged with the seat id. The ledger attributes to the
seat's **owner**, so spend is genuinely per-account for the first time — not an estimate,
and not a rotation trick.

Mirroring multiplies ingestion: N seats each read every addressed message and reply. That
cost lands on each seat's own account, which is the point. The room reports per-seat totals
so the multiplier is visible rather than surprising.

## 9. Failure modes

| Situation | Behaviour |
|---|---|
| Seat offline when addressed | Reject at the queue with a visible reason. Never queue silently forever. |
| Seat's session exits | SSE drops, seat marked offline, roster updates |
| Room restarts | Seats reconnect and re-seed from the stored transcript |
| Seat joins late | Seeded with brief, decisions, and recent conversation |
| Two seats claim one handle | Second join refused |

## 10. Security and trust

- Seat tokens are member tokens with `kind: "agent"`; the same identity gating applies.
- Owner-only addressing is the load-bearing rule (§7).
- A seat replies as itself, never as a human.
- Mirror content is untrusted text and is rendered with `textContent` in the browser like
  everything else.

**Stated plainly:** a seat running on someone else's machine means that person's credentials
live on hardware they do not control. The handoff already accepted this posture — *"trusted
team shared dev box… not isolation; don't pretend otherwise."* It is a trust decision the
credential's owner should make knowingly, and the README must say so.

## 11. Scope

**Built:** agent members and seat registry, seat HTTP protocol, `seat.mjs` bridge, room
standalone mode with explicit liveness, fan-out policy, seeding on join, owner-only
addressing, structural loop damping, per-seat cost attribution, local seat launcher using
`CLAUDE_CONFIG_DIR`, UI seat roster, docs.

**Not built:** agent-to-agent addressing, raw tool-result sharing, cross-room federation,
automatic seat spawning from the browser.

## 12. Open questions

1. Should mirrored replies be truncated? A long agent reply mirrored to N seats is N× its
   length. Start with a configurable cap and measure.
2. Does a seat need its own worktree when several run on one host repo? Two agents editing
   the same checkout will collide. Likely yes — `git worktree` per local seat — but that is a
   follow-on once the protocol works.
