# Skills for delegating well and managing the worker fleet

**Status:** approved design, not yet implemented
**Date:** 2026-09-18

## Problem

The channel (`src/channel.mjs`) already exposes `delegate` and `list_workers`
to any real Claude Code session that loads it, and `validateDelegation`
already enforces a schema (`to`, `class`, `task`, and `files`/`tests` for
`class: "execution"`). What it cannot enforce is *judgment*: whether a brief
is specific enough for a **free, weaker model** to actually succeed, when to
delegate at all, what to do when a worker goes quiet, and — once spec #2
lands a tool for it — when to spin up a new worker rather than wait.

That judgment lives nowhere durable today. `channel.mjs`'s `INSTRUCTIONS`
string carries one paragraph of it, always present but necessarily terse
since it rides in every session's system prompt. This spec adds two Claude
Code Skills — richer, on-demand-loaded playbooks — that teach the deeper
version of the same judgment, and packages them so they travel with the
channel toward the Path B (Anthropic security review) submission.

This is one of three sibling specs from the same brainstorming session
(Skills / delegation-robustness logic / extension maturation), split because
each is independently shippable and the user asked for all three fully
designed even though only some may be implemented first given limited
resources right now.

## What was verified before designing

| Fact | Evidence |
|---|---|
| `delegate` and `list_workers` already work end to end from a real Claude Code session | This session's own delegate-and-devtunnels POC: a real `claude` session, real channel, real OpenCode worker (`mimo-v2.5-free`), real files (`math.js`, `math.test.mjs`) produced and verified passing |
| `validateDelegation` enforces only shape, not quality | `src/delegation.mjs`: `class: "execution"` requires non-empty `files`/`tests`, nothing about specificity |
| A weak/free model needs a more explicit brief than a capable one | Our own successful POC brief named the exact function signature and the exact verify command; nothing in the schema requires that level of specificity, it happened because the human writing it already knew to |
| Free models genuinely stall | `docs/opencode-seat.md`: 2 of 6 probe turns wedged in earlier work on this project |
| There is no tool today for the orchestrator to create a new worker itself | Provisioning a seat is currently `room-admin.mjs seat add` (owner-only CLI) + `room-opencode-seat.mjs` (a separate process launch) — neither is reachable from inside a Claude Code session |
| Claude Code discovers Skills by matching their `description` against the task at hand | Observed directly, repeatedly, in this very session (`superpowers:*` skills firing on description match) |

## Design

### 1. Packaging

Both skills ship inside the **same plugin** as the channel — one artifact
for Path B's review, since Anthropic is reviewing "this channel" and the
skills exist specifically to teach its own tools well:

```
.claude-plugin/
  plugin.json                 # the manifest Path B submits
skills/
  delegating-work/
    SKILL.md
  managing-workers/
    SKILL.md
```

No code in either `SKILL.md` — pure guidance, referencing tool names
(`delegate`, `list_workers`, and `spawn_worker` once spec #2 lands it)
rather than restating their schemas, since Claude Code already surfaces the
live schema and a skill that duplicates it will drift out of sync the first
time the schema changes.

### 2. `delegating-work`

Covers three things `validateDelegation` cannot check:

- **When to delegate vs. keep it.** Deeper than `channel.mjs`'s one
  paragraph: concrete markers of genuinely mechanical work (boilerplate, one
  well-specified function, tests for existing code, formatting/lint fixes)
  versus work that needs the orchestrator's own judgment (anything requiring
  exploring the codebase first, ambiguous requirements, multi-file
  coordination a weak model would flub).
- **Writing briefs for a *weak* model, not merely a valid one.** The core
  "dumber models" content: name exact file paths, give the exact function
  signature rather than "add a helper," keep scope to one file/one concern,
  and give a concrete verification command rather than "make sure it
  works." Grounded in this session's own POC brief, which succeeded first
  try against `mimo-v2.5-free` for exactly this reason.
- **Reading and repairing a rejection.** `delegate rejected:\n- <reason>`
  names the missing field. The skill teaches treating that as a to-do list
  and re-submitting, not falling back to doing the work itself out of habit
  — the exact anti-pattern `channel.mjs`'s own instructions already warn
  against, restated here with the follow-through Claude actually needs.

### 3. `managing-workers`

- **Check before assuming.** Use `list_workers` before waiting blindly on a
  delegation or concluding nothing is available — a zero-cost read, treated
  as a first move rather than a last resort.
- **Recognizing a stalled worker.** The symptom via `list_workers` (a seat
  reported `busy` for implausibly long relative to the task's size) and the
  response: the driver's own per-turn deadline already handles the hard
  timeout, so the skill's job is telling Claude not to just re-poll forever
  — treat a stalled delegation as failed after a reasonable wait, and either
  retry with a sharper brief or do the work directly.
- **Spawning a new worker when the fleet can't take more work.** Depends on
  spec #2's new tool (name TBD there, referred to here as `spawn_worker`).
  Framed the way Claude already reasons about its own subagents: a worker
  is disposable infrastructure sized to the task, not a rationed resource.
  No cap, per an explicit decision made during brainstorming — OpenCode's
  free tier makes token cost a non-issue, so the guidance is about judgment
  (does this task genuinely need more capacity) rather than a limit check.
  The real ceiling is local process/worktree resources, not money, and
  `list_workers` staying the visibility mechanism is what keeps an
  unusually large fleet visible rather than silent.

This third bullet's guidance is only actionable once spec #2 ships the
actual tool. The skill is written now regardless; its examples name a tool
spec #2 defines, and implementation of this skill should land no earlier
than spec #2's tool.

### 4. Verification

Skills are prompt content, not code — "testing" means a real probe against
the real `claude` CLI with the channel loaded, the same rigor every design
doc in this repo already holds itself to. Three scenarios, each a real run
against real binaries, recorded honestly (including a negative result if
the skill doesn't change behavior — that is itself a finding worth having
before Path B submission):

1. **Thin brief → repaired.** Ask the orchestrator to delegate something
   from a deliberately vague request. Confirm it writes a brief with real
   files/interface/tests rather than a bare `task` string, or self-corrects
   after a rejection.
2. **Stalled worker → checked, not silently waited on.** Simulate a
   slow-replying seat. Confirm `list_workers` gets called rather than the
   session idling.
3. **Fleet full → spawns rather than stalls.** With every seat busy,
   confirm the orchestrator uses the spawn tool instead of waiting
   indefinitely or doing the work itself.

## Rejected alternatives

**One combined skill instead of two.** Rejected: "deciding whether/how to
hand off a task" and "checking on or growing the fleet" are different
moments in a session, and Claude Code's auto-triggering works off
description match — one skill trying to cover both dilutes the trigger
text for each.

**More than two skills (one per topic).** Rejected: too many
overlapping "use this when delegating" descriptions compete for the same
trigger moment rather than sharpening it.

**A hard cap on self-spawned workers.** Considered and explicitly rejected
during brainstorming — token cost is a non-issue on OpenCode's free tier,
and the guidance is judgment-based rather than limit-based. Revisit if a
future paid model changes this.

## Dependencies

- **Spec #2 (delegation robustness logic)** must define the spawn-worker
  tool's actual name and schema before `managing-workers`'s third bullet
  can be written to its final, tool-accurate form. This spec's content for
  that bullet is written against the tool's *behavior*, not a committed
  interface, and should be reconciled once spec #2 is written.

## Risks

- **Skill guidance can go stale against the real tool schemas** if
  `delegate`/`list_workers`/the spawn tool change shape after this ships —
  mitigated by the skills referencing tool names rather than restating
  schemas, but not eliminated.
- **Verification (§4) requires real API calls and a real worker**, so it
  carries the same cost and first-run-consent considerations as the
  original delegate-and-devtunnels POC.
