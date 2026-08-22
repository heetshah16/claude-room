# Room Observer — Design Spec

**Date:** 2026-08-22
**Status:** Approved for implementation
**Builds on:** `2026-08-19-claude-room-design.md`

---

## 1. Goal

A second, cheap agent that watches the room continuously and maintains a structured brief of
**conversation state** — what is open, where the discussion forked, who walked something
back, what Claude already tried. When someone addresses Claude, that brief is injected
alongside their message so the agent understands the situation rather than only the
sentence.

The room already prevents contradictions from being *silently resolved* (`decisions.mjs`
flags them lexically). This is the part that makes the agent actually *understand* the
conversation it has been dropped into.

## 2. Decisions taken during design

| Decision | Rationale |
|---|---|
| Runs as `claude -p`, shelled from the room server | Keeps the one-runtime-dependency rule. A debounced observer needs no streaming control. |
| Haiku, **no tools at all** | Pure text in, structured text out. Cheap enough to run constantly, and cannot act on anything it reads. |
| Reads chat **and** agent activity | `TurnLog` already records what Claude did. "Claude tried this in turn 2 and the tests failed" is the context that prevents a repeat. |
| **Never on the critical path** | A curation layer that adds seconds to every message destroys the responsiveness that is the point. Handoff §3.2. |
| Incremental: previous brief + new events only | Input is O(new), not O(conversation). A room open all day costs the same per cycle as a fresh one. The brief *is* the memory. |
| Brief injected as its **own channel event**, before the message | The member's `content` stays byte-identical — not even a wrapper. Strictly more faithful to §3.4 than prepending a block, and the brief is visibly machine-generated rather than blending into someone's words. |
| Speaks only on hard signals, throttled per signal id | A fork is most useful announced when it happens. An agent that comments constantly gets muted, and the useful signals get muted with it. Handoff §2.2. |
| Metered as its own ledger row | Its cost should be visible next to the humans it serves, and capped. |

## 3. The brief

Strict JSON, schema-constrained on parse. Unknown keys dropped, arrays capped, strings
truncated — the observer's output is generated text and is never trusted structurally.

```json
{
  "threads":    [{ "id": "…", "topic": "…", "owner": "ana", "status": "open|resolved", "last": "…" }],
  "forks":      [{ "id": "…", "at": "…", "branches": ["…", "…"], "live": ["…"] }],
  "reversals":  [{ "id": "…", "who": "bo", "was": "…", "now": "…", "why": "…" }],
  "tried":      [{ "id": "…", "what": "…", "outcome": "…", "turn": "…" }],
  "unanswered": [{ "id": "…", "who": "heet", "question": "…" }]
}
```

`reversals` and `tried` are the two entries obtainable no other way. Every entry carries a
stable `id` derived from its type and subject, so the same fork is never re-announced.

Caps: 12 entries per section, 300 characters per string.

## 4. The cycle

```
room events ──► buffer ──► debounce (4s idle, or 8 events) ──► runModel
                                                                  │
                    previous brief + only what is new ────────────┘
                                                                  ▼
                                              parse + clamp ──► store brief
                                                                  │
                                        ┌─────────────────────────┼──────────────┐
                                        ▼                         ▼              ▼
                                  broadcast to panel        diff → speak?     meter
```

Events fed to the observer: room messages (chatter included — chatter is where walk-backs
happen), and closed turns with their tool calls and outcomes.

## 5. Injection

At drain time, when a brief exists, the room emits two channel notifications in order:

```
<channel source="room" kind="brief" stale="false" age_s="3">…</channel>
<channel source="room" user="bo" member_id="…">and add a cache layer to auth</channel>
```

Channel events queued together are delivered in order and handled as one turn, so these
arrive as a unit. The member's message is untouched.

## 6. Speaking

Silent by default. After each cycle, the new brief is diffed against the previous one. A
**new** entry in `reversals` or `forks`, or a new `threads` entry whose topic collides with
an open decision, is a hard signal. The observer posts one short room note per signal id,
capped at `ROOM_OBSERVER_NOTES_PER_WINDOW` per window. A signal already announced is never
announced again, even if it persists across cycles.

## 7. Cost and budget

Per cycle: input ≈ previous brief plus the delta; output ≈ one brief. On Haiku this is a
fraction of a cent.

- The observer appears in the ledger as a reserved member id `observer`, so its spend sits
  beside the humans'.
- `ROOM_OBSERVER_MAX_TOKENS_PER_WINDOW` caps it. Over budget, the observer **pauses**: the
  brief goes stale and is still injected with `stale="true"`, and the room is otherwise
  unaffected.

## 8. Failure modes

| Situation | Behaviour |
|---|---|
| Cycle in flight when someone addresses Claude | Inject the current brief with `stale="true"` and `age_s`. Never wait. |
| Model call fails or times out | Keep the previous brief, log to stderr, retry next debounce. |
| Output is not valid JSON | Discard, keep the previous brief. Never inject unparsed text. |
| Over budget | Pause cycles. Room unaffected. |
| Observer disabled | No brief events. Room behaves exactly as it does today. |

The observer is strictly additive: every failure degrades to the room as it exists now.

## 9. Security

The observer has no tools, so nothing it reads can cause an action.

**The residual risk is laundering.** A member writes something manipulative, the observer
summarises it, and the summary enters the main agent's context wearing system-ish framing.
Mitigations, none of which fully close it:

- Output is parsed as JSON and clamped to the schema; unknown keys dropped, strings truncated.
- The brief is tagged `kind="brief"` so it is visibly machine-generated, distinct from a
  human turn.
- The observer's own prompt states that room text is data to summarise, never instructions.
- Brief text is rendered with `textContent` in the browser like all other untrusted strings.

This is a real, accepted risk of any summarisation layer feeding an agent. It is recorded
here so it is a decision rather than an oversight.

## 10. Testing

`runModel` is an injected function, so the entire observer is tested deterministically with
no subprocess and no tokens spent.

- **`brief.mjs`** (pure): schema clamping, unknown-key rejection, string truncation, stable
  signal ids, diffing old against new, staleness computation.
- **`observer.mjs`** (pure, fake `runModel`): debounce timing with an injected clock, budget
  pausing, previous-brief-plus-delta prompt construction, speak-once-per-signal throttling,
  malformed output discarded.
- **Integration**: brief event emitted before the message event; member content byte-identical;
  no brief event when none exists.

## 11. Scope

**Built:** brief schema and clamping, incremental cycle, debounce, `claude -p` runner,
injection as a separate channel event, staleness, room notes with per-signal throttling,
ledger metering and budget pause, sidebar panel, demo wiring.

**Not built:** repo/git awareness (rejected — needs filesystem access, which breaks the
observer-only property), multi-room briefs, learned signal tuning.

## 12. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ROOM_OBSERVER` | off | `1` to enable |
| `ROOM_OBSERVER_MODEL` | `haiku` | Model passed to `claude -p` |
| `ROOM_OBSERVER_DEBOUNCE_MS` | `4000` | Idle time before a cycle |
| `ROOM_OBSERVER_MAX_EVENTS` | `8` | Buffered events that force a cycle early |
| `ROOM_OBSERVER_NOTES` | on when observer on | `0` to keep it silent, panel only |
| `ROOM_OBSERVER_NOTES_PER_WINDOW` | `6` | Room-note cap per budget window |
| `ROOM_OBSERVER_MAX_TOKENS_PER_WINDOW` | `200000` | Budget before pausing |
