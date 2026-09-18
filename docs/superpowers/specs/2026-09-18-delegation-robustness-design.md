# Delegation robustness: spawning workers on demand, and verifying what they claim

**Status:** approved design, not yet implemented
**Date:** 2026-09-18

## Problem

`delegate` and `list_workers` already work end to end (verified this session:
a real `claude` session, real channel, real OpenCode worker, real files
produced and independently confirmed passing). But the system as it stands
has three gaps that matter more as free/weaker models do more of the work:

1. **No way to grow the fleet from inside a session.** Provisioning a worker
   is an out-of-band, owner-only CLI dance (`room-admin.mjs seat add` +
   `room-opencode-seat.mjs`) — nothing the orchestrator can call itself.
2. **A worker's success claim is taken on faith.** `onSeatReply` closes a
   delegation the moment any reply arrives; nothing confirms the claimed
   work is real.
3. **A worker that never replies is reported as a mystery**, even in cases
   this project has already observed for real: the free model doing the
   work and simply failing to call `room_reply` (`docs/opencode-seat.md`'s
   `REPLY_DIRECTIVE` fix addressed the *cause*, not what happens when it
   still occurs).

This is the second of three sibling specs from the same brainstorming
session (Skills / **this** / extension maturation). Spec #1
(`2026-09-18-delegation-skills-design.md`) depends on this one for the
`spawn_worker` tool's real name and shape; this spec supplies both.

## What was verified before designing

| Fact | Evidence |
|---|---|
| The extension already solved on-demand worker provisioning | `extension/src/workers.js`: `createWorkerPool` mints a seat via `invite({kind:'agent', delegatable:true})`, spawns `scripts/room-opencode-seat.mjs` as a child via a supervisor, tracks state from the room's own event stream |
| Delegation replies are already matched structurally, not by content | `src/delegation.mjs`'s `onSeatReply`: matched via `queue.inflightFor(handle)` against the turn the seat is actually running, not by anything the worker's text says |
| A worker doing real work but failing to reply has already happened | `docs/opencode-seat.md`: the model completed a real edit but never called `room_reply` on the first recorded smoke test, before the `REPLY_DIRECTIVE` prompt fix |
| `class: "execution"` already mandates a verification command | `src/delegation.mjs`'s `validateDelegation`: non-empty `spec.tests` required, but nothing currently *runs* it |
| Portable, tree-killing process spawning already exists on the room side | `src/spawn.mjs`'s `spawnPortable`/`resolveCommand` — used by `room-seat.mjs`/`room-opencode-seat.mjs` already; this spec reuses it rather than adding a third implementation |

## Design

### 1. `spawn_worker` — provisioning from inside a session

```
spawn_worker({ model?: string }) -> { ok: true, handle: string } | { ok: false, errors: string[] }
```

- Mints an agent member via the same internal path `POST /api/admin/invite`
  already uses (`registry.add(createAgentMember(...))`), with
  `delegatable: true` set unconditionally — a self-spawned worker exists to
  be delegated to, so making that opt-in would be pointless friction.
- Handle assignment (`worker-1`, `worker-2`, ...) ports `nextHandle` from
  `extension/src/workers.js` verbatim in logic, translated to ESM.
- Spawns `scripts/room-opencode-seat.mjs` as a child process via
  `src/spawn.mjs`'s `spawnPortable` — reusing the exact launcher the manual
  CLI path already uses, not reimplementing worktree/`opencode serve` setup
  a third time.
- Registers the handle immediately (`config.handles` gains `@worker-N`) so
  it's addressable the moment the tool returns.
- Returns once the process is *launched*, matching `delegate`'s own
  fire-and-forget shape — readiness is discovered via `list_workers`, the
  same way every other worker fact is discovered, not through a second
  signal invented just for this.
- Needs the room server to hold a small `Supervisor` (today only the
  extension has one) so a self-spawned worker can be tracked and torn down
  cleanly. Ports the ~40-line pattern from `extension/src/supervisor.js` to
  ESM rather than inventing a different shape.
- **No cap on concurrent self-spawned workers**, by explicit decision made
  during brainstorming: OpenCode's free tier makes token cost a non-issue,
  so this is a judgment call for the orchestrator (taught in spec #1's
  `managing-workers` skill), not a limit enforced here. The real ceiling is
  local process/worktree resources, and `list_workers` staying the
  visibility mechanism is what keeps an unusually large fleet visible
  rather than silent.

**Considered and deferred**: an explicit handshake token a worker must echo
back to close its own delegation. Rejected for now — this project's own
history shows a free model already forgets to call `room_reply` at all
without a prompt fix; requiring it to *also* remember a token adds a new way
for genuinely-completed work to look unclosed. The existing turn-based
structural correlation (below) plus verification (§2) achieves the same
rigor without depending on the worker's own reliability. Worth revisiting
if verification alone proves insufficient once this is running for real —
recorded here so the idea isn't lost, not because it was wrong.

### 2. Automatic verification — validated output, not just validated input

`validateDelegation` already validates a brief before work starts. This
applies the same "validated, not trusted" principle to what comes back:

1. When a reply closes a `class: "execution"` delegation (matched
   structurally, as already happens), the room runs the delegation's own
   `spec.tests` command **itself**, directly, in the worker's worktree
   (`.worktrees/<handle>`) via `spawnPortable`. This is not a new trust
   boundary: the command was authored by the orchestrator when it built the
   brief, not by the worker — the room is re-running something it already
   had standing authority to have run, instead of trusting a self-report of
   the outcome.
2. Real exit code decides the result. `delegation-result` gains a
   `verified: true | false` field alongside the worker's own reply text —
   the orchestrator gets both what the worker *said* and what actually
   *happened*.
3. `class: "reasoning"`/`"verification"` delegations have no `spec.tests`
   and close on reply alone, unchanged from today — there is nothing
   mechanical to check.
4. Verification runs with its own bounded timeout (independent of the
   worker's own turn deadline) — a hanging test command must not wedge the
   delegation forever.

### 3. Failure handling — kept deliberately dumb here, smart at the orchestrator

No automatic retry in the room. The room can confirm *whether* a test
passed; it cannot meaningfully rewrite a brief based on *why* it failed —
that is judgment, and this project's design already keeps judgment at the
orchestrator (`class` never routes; the room validates but never chooses
delegation targets). A `verified: false` result surfaces through the same
`delegation-result` notification as a success, carrying the real test
output. From the orchestrator's side this is structurally identical to a
rejected brief: evidence plus a decision to make, not a dead end.

**This requires one small addition to spec #1's `delegating-work` skill**:
"reading and repairing a rejection" should explicitly cover both moments —
a pre-execution rejection (thin brief, caught by `validateDelegation`) and
a post-execution verification failure (real attempt, real test output,
still wrong) — same judgment, applied at two different points. This is a
small edit to spec #1, not new scope; flagging it here since this spec is
what makes the second moment exist at all.

### 4. Stall handling — verification applies to silence too

`onTurnAbandoned` already exists and already distinguishes "abandoned" from
"done." The gap: a worker that did real work and simply never called
`room_reply` (observed for real in this project's own history) currently
reports as an undifferentiated abandonment, and whatever it actually
produced goes unexamined.

**Fix**: on abandonment, run the same §2 verification against the worktree
before finalizing the outcome, even with no reply at all:

- No reply, verification passes → report *"likely succeeded, but the worker
  never reported back"* — a genuinely new, useful signal; the orchestrator
  can retrieve the result without re-delegating.
- No reply, verification fails or nothing changed → real abandonment,
  reported as today.
- No reply, no `spec.tests` to check (reasoning/verification class) →
  unavoidably unknown, reported as today.

Reuses §2's verification outright — no separate mechanism for the timeout
path.

## Rejected alternatives

**Worker-echoed handshake token.** Deferred (not rejected outright) — see
§1's callout. The structural, turn-based correlation `onSeatReply` already
has, combined with verification, achieves the same rigor without adding a
failure mode a weak model is prone to.

**Automatic retry with an auto-rewritten brief.** Rejected: the room has no
basis to improve a brief intelligently. Only the orchestrator (with actual
reasoning about *why* something failed) can do that — matches this
project's existing philosophy of keeping the room mechanical and the
judgment upstream.

**A cap on self-spawned workers.** Rejected during brainstorming (mirrors
spec #1's identical decision) — token cost is a non-issue on the free tier;
local resources are the real ceiling and stay visible via `list_workers`
rather than being pre-limited.

## Dependencies

- **Spec #1** (`delegating-work`/`managing-workers` skills) needs this
  spec's `spawn_worker` name/shape (§1) to write its spawn-worker guidance
  to its final form, and needs the small addition noted in §3 (repairing a
  verification failure, not only a rejected brief).

## Risks

- **Verification adds real execution time to every `class: "execution"`
  delegation** — the room now runs a test suite it previously only
  required to exist. Bounded by its own timeout (§2.4), but this is a real
  latency cost, not a free correctness win.
- **A malformed or slow `spec.tests` command now costs room-side compute**,
  not just the worker's. This is authored by the orchestrator, which is
  trusted, but it's worth being honest that "trusted" is doing real work in
  this sentence — a badly-chosen verify command (e.g., one that installs
  dependencies over the network) is now something the room itself executes.
- **The room server gaining its own `Supervisor`** (§1) is new
  responsibility for a component whose original design was deliberately a
  thin HTTP+MCP server with no process-management concerns of its own —
  worth watching that this doesn't creep into the room taking on the
  extension's job, rather than the extension's job shrinking as intended.
