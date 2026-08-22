# claude-room — Design Spec

**Date:** 2026-08-19
**Status:** Approved for implementation
**Supersedes:** the architecture in `multiplayer-claude-code-handoff.md` §6–§7

---

## 1. Goal

A multi-human collaboration layer on Claude Code. Several teammates drive **one shared
Claude Code session** from their own browsers, over Tailscale, without any of them having
credentials, a terminal, or a checkout on the host machine.

The value proposition is the **shared context window**, not a shared UI. When everyone's
input lands in one context, the agent knows what the team decided and why. Word vs Google
Docs: Docs killed the merge step, and that is what people actually love.

### Constraints (unchanged from handoff §1)

- No hosted infrastructure. Everything runs on participants' machines.
- Terminal-first for the host; browser-only for teammates.
- No forking Claude Code. Harness level only: MCP channel server, hooks, settings, plugin.
- Minimal setup for teammates: open a URL.

---

## 2. Decision record: why channels, not cross-session messaging

The handoff made cross-session messaging the spine and channels a maybe. That is backwards.

| Requirement | Cross-session messaging | Channels |
|---|---|---|
| Shared context window | no — N separate contexts | yes — one context, many senders |
| Human participants | no — each needs own session + credentials | yes — browser only |
| Chat-shaped traffic | no — docs steer away explicitly | yes — named use case |
| Batching concurrent input | no — separate turns | yes — automatic |
| Windows host | no — unsupported | yes — works (stdio MCP) |
| Credential sharing / ToS risk | shared OS user, shared box | none |

Cross-session messaging is a request/response handoff between *your own* sessions. It is
throttled by design, plain-text only, and capped at 50 unread. It is the wrong primitive
for a room.

**Rejected alternatives:** wrapping the VS Code extension (no public API); Slack/Teams
(org policy gates, nothing lands in the Claude Code window); OmniRoute (sits on the
outbound inference path, orthogonal to local IPC).

---

## 3. Verified facts this design rests on

Checked against docs and the host machine on 2026-08-19. Anything not verified is marked.

- A channel is an MCP server spawned by Claude Code over **stdio**. It declares
  `capabilities.experimental['claude/channel'] = {}` and emits
  `notifications/claude/channel` with `{ content, meta }`.
- `meta` keys become attributes on a `<channel>` tag. **Keys must be identifiers**
  (letters, digits, underscore); keys containing hyphens are *silently dropped*.
- Events arriving while Claude is busy are **delivered together on the next turn and
  handled as a group**. This is free batching.
- Claude Code **does not acknowledge** notifications. If no channel is registered, events
  are dropped silently with no error returned to the server.
- Reply text sent through the reply tool **does not appear in the host terminal** — only
  the inbound message and a tool-call confirmation. Teammates therefore see nothing of
  tool calls, edits, or reasoning unless the room sends it itself.
- Permission relay: declare `capabilities.experimental['claude/channel/permission'] = {}`;
  receive `notifications/claude/channel/permission_request` with
  `{ request_id, tool_name, description, input_preview }`; answer with
  `notifications/claude/channel/permission` carrying `{ request_id, behavior }`.
  `request_id` is five lowercase letters drawn from `a`–`z` excluding `l`.
- Custom channels are not on the approved allowlist. Daily driver is
  `claude --dangerously-load-development-channels server:room`, which shows a full-screen
  warning dialog at every start.
- **Team/Enterprise orgs must enable `channelsEnabled`** in managed settings or at
  claude.ai to Admin settings to Claude Code to Channels. Pro/Max personal accounts skip
  this check. **Blocking prerequisite if the room runs under a Team login.**
- Hooks receive `prompt_id` (v2.1.196+) on `UserPromptSubmit`, `PreToolUse`, `PostToolUse`
  and `Stop`, plus `transcript_path` on all events.
- Hooks support `type: "http"`, so the activity feed needs no scripts.
- Transcript JSONL assistant lines carry `message.usage` with `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and
  `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`.
- `apiKeyHelper` runs a shell command whose output is sent as both `X-Api-Key` and
  `Authorization: Bearer`; refresh cadence is `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`.
- **UNVERIFIED:** whether prompt cache survives a credential swap between teammates. The
  operator reports no *context* loss when rotating OAuth, but context is client-side and
  would survive either way; a cache miss is invisible from the terminal. §8 settles this.

---

## 4. Architecture

One Node process, spawned by Claude Code as an MCP stdio child. It speaks MCP on stdio and
serves HTTP + SSE on the Tailscale interface from the same process — no IPC, no state sync.

```
teammates' browsers ──POST /msg──────┐
      (Tailscale)  ◄──SSE /events────┤
                                     │
Claude Code hooks ──POST /hook/:evt──►   room server   ──stdio──► Claude Code session
                                     │  (one process)             (host account, the repo)
                                     │
                    apiKeyHelper ◄───┘ reads current payer
```

Because the room server is a **child of Claude Code**, "room server alive" is equivalent to
"session alive". No liveness protocol is needed.

### Module boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `types.mjs` | shared shapes and JSDoc typedefs | — |
| `config.mjs` | env, paths, defaults | — |
| `identity.mjs` | join tokens to member; roles; sender gating | config |
| `router.mjs` | addressed-to-Claude vs room chatter (pure) | types |
| `ledger.mjs` | transcript usage to per-member attribution (pure core) | types |
| `decisions.mjs` | decision store and contradiction flagging | types |
| `queue.mjs` | pending queue, rate limits, budgets, payer selection | identity, ledger |
| `state.mjs` | persistence and replay | config |
| `channel.mjs` | MCP capabilities, notification, reply tool, permission relay | queue, state |
| `web.mjs` | HTTP/SSE, browser UI, hook ingest | everything |
| `server.mjs` | wiring and entrypoint | everything |

`router`, `ledger`, `decisions` and `identity` are pure or near-pure and carry the
load-bearing logic. They are unit tested with `node:test` and no Claude Code in the loop.

---

## 5. Message lifecycle

1. Teammate types, `POST /msg` with a join token, `identity` resolves a member.
   **Gating is on sender identity, never room membership** — group-membership gating is
   the documented prompt-injection hole.
2. `router` classifies:
   - **Chatter** — broadcast to the room only. Never enters context. Costs nothing.
     This is the handoff's §3.3 classifier with no LLM and no hot path, so §3.2's
     "a curation layer is inherently blocking" problem never arises.
   - **Addressed** (`@claude` prefix or explicit UI toggle) — enqueued, broadcast with a
     queued badge so everyone sees whose message is next.
3. Drain: `mcp.notification()` with `content` **verbatim** and
   `meta: { user, member_id, msg_id, room, ts }`. Attribution travels in `meta`, never in
   `content`. This makes the handoff's §3.4 *annotate, never rewrite* rule structural
   rather than aspirational: the layer physically cannot corrupt anyone's words.
4. Claude Code batches everything queued during a busy turn into one turn.
5. Hooks stream activity back via `POST /hook/:event`; the room broadcasts an activity feed
   over SSE so teammates see tool calls and edits, not just replies.
6. `Stop` hook: `ledger` reads `transcript_path`, sums usage for that `prompt_id`, and
   attributes it to the members whose messages composed the turn.

### Addressing rules (`router`)

- Default silent. Only explicit addressing reaches Claude (handoff §2.2).
- `@claude ...` is addressed. The leading mention is stripped from the *display* copy only;
  the `content` sent to the channel stays verbatim.
- A UI "send to Claude" toggle marks a message addressed regardless of prefix.
- Everything else is chatter.
- A `viewer` can never produce an addressed message.

---

## 6. Cost model

A single session has a single credential, so **all inference bills to whoever launched the
room**. That is the honest starting point; the design makes it visible and then fixable.

### Ledger

On `Stop`, read the transcript, select assistant lines belonging to that turn, and sum
usage. Split across the members whose messages composed the turn — equal split by default,
`weighted` by character count is configurable. Per-member running totals are broadcast to
every browser, so the bill is visible to the people creating it.

The ledger also tracks `cache_read_input_tokens` against `input_tokens` per turn. This is
the instrument that settles §8.

### Budgets

`queue` enforces, **before a turn is spent**:

- per-member token budget per rolling window
- per-member message rate limit
- a room-wide concurrency ceiling of 1 — the agent turn is a serialization point
  (handoff §2.3); "refactor auth" and "revert auth" cannot merge

An exceeded budget rejects the message at the queue with a visible reason, never silently.

### Payer rotation

`queue` selects a payer per turn and writes it to `${STATE}/current-payer`. `apiKeyHelper`
points at `scripts/room-payer.mjs`, which reads that file and prints the credential.

- The payer changes **only between turns**, never mid-turn, so a single turn is never split
  across two accounts.
- Credentials are **fetched on demand over Tailscale from the owning teammate's machine**,
  not stored at rest on the host.
- Default mode is `host` (no rotation) until §8 settles.
- On Team plans the binding constraint is the per-seat 5-hour and weekly allowance, so
  rotation raises the team's ceiling roughly N times as well as attributing cost correctly.

---

## 7. Permissions, roles, security

| Role | Chatter | Address Claude | Approve tool calls |
|---|---|---|---|
| `owner` | yes | yes | yes |
| `member` | yes | yes | only if `canApprove` |
| `viewer` | yes | no | no |

This is Docs' view / comment / edit, which handoff §2.5 identified as the right mapping.

Permission relay is **opt-in per room and off by default**. Rationale: relay makes the
system less safe, not more. The safe default is that a teammate can *ask* Claude to do
something destructive but only the host approves it. When enabled, only members with
`canApprove` see the prompt, and a verdict from anyone else is dropped.

### Threat model

The room is a prompt-injection surface by construction. Mitigations:

- Join tokens are per-member, revocable, and never shared. The room binds to the Tailscale
  interface, not `0.0.0.0`.
- Sender gating happens before `mcp.notification()` is ever called.
- Content is never interpreted by the room — no slash commands, no markup expansion.
- Permission verdicts are matched against issued `request_id` values and an approver
  allowlist.
- `input_preview` and `description` from permission requests are treated as untrusted
  display text. Claude Code sanitizes them, but the room re-escapes for HTML.

---

## 8. The rotation spike

Before enabling rotation by default, settle the unverified question:

1. Run the room with `payerMode: host` and capture per-turn `cache_read_input_tokens`.
2. Switch to `payerMode: rotate` with two teammates' credentials.
3. Compare the cache-read ratio across a credential swap.

If cache read collapses to near zero on the turn after a swap, rotation costs more than it
saves — keep `host` plus ledger plus budgets. If cache read holds, rotation is the right
default and the fairness problem dissolves.

---

## 9. Persistence and failure modes

State lives in `~/.claude/channels/room/`: `members.json`, `transcript.jsonl`,
`ledger.json`, `decisions.json`, `current-payer`.

| Failure | Behavior |
|---|---|
| Claude Code exits | room server dies with it; browsers show "room offline" and retry SSE |
| Server restart | transcript replayed from disk on reconnect |
| Channel not registered | Claude Code drops events silently; the room warns if no `SessionStart` hook has fired |
| Runaway member | per-member rate limit at the queue |
| Context pressure | chatter never enters context — the primary defense |
| Hook POST fails | fire-and-forget; the activity feed degrades, the room keeps working |

Context pressure deserves emphasis: 5–10 people share **one** context window, and every
compaction is itself a large request. Strict addressing is not a nicety here; it is the
only thing keeping the room affordable and coherent.

---

## 10. Testing

- **Unit** (`node:test`, no Claude Code in the loop): `router` classification including
  adversarial inputs; `ledger` attribution math and cache-ratio computation; `identity`
  token gating and role enforcement; `queue` budgets, rate limits, payer selection and
  serialization; `decisions` contradiction detection.
- **Integration**: a fake stdio transport asserting notification shape, `meta` key validity
  (identifier characters only), verbatim content, the reply-tool contract, and permission
  verdict matching.
- **Manual**: `--dangerously-load-development-channels server:room` with two browsers.

TDD throughout: write the test, watch it fail, then implement.

---

## 11. Scope

**Built:** identity, join tokens and roles; addressing router; queue with budgets, rate
limits and serialization; verbatim-plus-meta attribution; reply tool; permission relay
(opt-in); activity feed via HTTP hooks; transcript persistence and replay; ledger with
live per-member cost and cache ratio; payer rotation (`host` default, `rotate` opt-in);
decision store with contradiction flagging; file attachments; browser UI with presence and
typing indicators.

**Not built:** the §9 git-bus transport. Tailscale was chosen, so the transport interface
exists but only the HTTP implementation is written.

---

## 12. Open questions

1. Does prompt cache survive a credential swap? See §8.
2. Can the Team org enable `channelsEnabled`? Blocking prerequisite; operator to confirm.
3. Does `apiKeyHelper` accept an OAuth access token as a `Bearer` value across refresh
   boundaries? This surfaces during §8.

---

## 13. Addendum — the §8 rotation experiment, run 2026-08-22

**Result: per-turn payer rotation is unavailable on claude.ai subscription and Team auth.**

Two-arm test, plus a baseline, using `claude -p --model haiku --settings <apiKeyHelper>`:

| Arm | Helper returns | Outcome |
|---|---|---|
| baseline | nothing (stored login) | succeeds |
| control | a deliberately invalid token | hangs until timeout |
| real | a valid subscription OAuth access token | hangs until timeout |

The control arm establishes that `apiKeyHelper` is consulted and authoritative: Claude Code
does not silently fall back to the stored login when the helper returns something bad. The
real arm therefore shows that a subscription OAuth access token supplied through the helper
does not authenticate. The likely cause is that the helper's value is sent as `X-Api-Key` and
`Authorization: Bearer` without the `anthropic-beta: oauth-2025-04-20` header OAuth requires.

This settles §12 open question 3 in the negative, and makes question 1 (whether prompt cache
survives a swap) moot for this operator, since no swap is possible.

**Two operational findings:**

1. A credential the session cannot authenticate with produces a **hang, not an error**. In a
   rotation setup a single bad payer token would stall the entire room indefinitely.
   `room-payer.mjs` now validates that anything it emits looks like a Console API key and
   falls back to the host credential otherwise.
2. The server now detects `payerMode: rotate` without a Console API key at startup, warns,
   and falls back to `host` rather than hanging on the first rotated turn.

**What remains true:** rotation is still correct for a team that holds Console API keys in one
org and workspace, where cache isolation would not bite. The mechanism is built and behind the
same interface; only the credential type is the blocker.

**Correction to an earlier claim:** "no credentials leave anyone's machine" describes `host`
mode only. Under rotation the host process holds a bearer credential for the paying member for
its lifetime — scoped to inference, never the refresh token, never written to disk, but real.
