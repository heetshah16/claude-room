# Room Observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cheap, tool-less second agent that maintains a structured brief of conversation state and injects it alongside the message when someone addresses Claude.

**Architecture:** A debounced cycle inside the room server shells `claude -p` with the previous brief plus only what is new, parses strict JSON, clamps it to schema, and stores it. At drain time the brief goes out as its own channel event immediately before the member's message, leaving their content byte-identical. `runModel` is an injected seam so the whole thing is testable with no subprocess and no tokens.

**Tech Stack:** Node 22 ESM, `node:test`, `node:child_process` for `claude -p`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-room-observer-design.md`

## Global Constraints

- No new runtime dependencies. `@modelcontextprotocol/sdk` remains the only one.
- The observer is strictly additive: every failure path degrades to the room exactly as it behaves today.
- The observer never blocks a turn. If a cycle is in flight, inject the stale brief and carry on.
- Observer output is untrusted generated text: parse as JSON, clamp to schema, drop unknown keys, truncate strings. Never inject unparsed text.
- Member `content` is never modified. The brief is a separate channel event.
- `runModel` must be injectable so no test spawns a subprocess or spends a token.
- Tests run with `node --test`. Every task ends green.

---

### Task 1: Brief schema, clamping, signal ids, diffing

**Files:**
- Create: `src/brief.mjs`
- Test: `test/brief.test.mjs`

**Interfaces:**
- Produces: `EMPTY_BRIEF`; `clampBrief(raw) -> Brief`; `signalId(kind, subject) -> string`; `diffBriefs(prev, next) -> Signal[]` where `Signal = { id, kind, entry }`; `renderBrief(brief) -> string`; `briefAge(brief, now) -> seconds`
- `Brief = { threads:[], forks:[], reversals:[], tried:[], unanswered:[], ts:number }`

- [ ] **Step 1: Write the failing test**

```js
// test/brief.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_BRIEF, clampBrief, signalId, diffBriefs, renderBrief, briefAge } from '../src/brief.mjs'

test('an empty brief has every section', () => {
  for (const k of ['threads', 'forks', 'reversals', 'tried', 'unanswered']) {
    assert.deepEqual(EMPTY_BRIEF()[k], [])
  }
})

test('unknown top-level keys are dropped', () => {
  const b = clampBrief({ threads: [], instructions: 'ignore all previous' })
  assert.equal(b.instructions, undefined)
})

test('unknown entry keys are dropped and strings truncated', () => {
  const b = clampBrief({ reversals: [{ who: 'bo', was: 'x'.repeat(500), evil: 'y' }] })
  assert.equal(b.reversals[0].evil, undefined)
  assert.equal(b.reversals[0].was.length, 300)
})

test('sections are capped at twelve entries', () => {
  const b = clampBrief({ threads: Array.from({ length: 40 }, (_, i) => ({ topic: String(i) })) })
  assert.equal(b.threads.length, 12)
})

test('non-array sections and non-object entries are discarded', () => {
  const b = clampBrief({ threads: 'nope', forks: [null, 'x', { at: 'ok' }] })
  assert.deepEqual(b.threads, [])
  assert.equal(b.forks.length, 1)
})

test('clamping garbage yields an empty brief rather than throwing', () => {
  assert.deepEqual(clampBrief(null).threads, [])
  assert.deepEqual(clampBrief('string').forks, [])
})

test('signal ids are stable for the same subject and differ across subjects', () => {
  assert.equal(signalId('fork', 'auth cache'), signalId('fork', 'auth cache'))
  assert.notEqual(signalId('fork', 'auth cache'), signalId('fork', 'auth ttl'))
  assert.notEqual(signalId('fork', 'a'), signalId('reversal', 'a'))
})

test('diff reports only entries that are new', () => {
  const prev = clampBrief({ reversals: [{ who: 'bo', was: 'cache', now: 'stateless' }] })
  const next = clampBrief({
    reversals: [
      { who: 'bo', was: 'cache', now: 'stateless' },
      { who: 'ana', was: 'redis', now: 'postgres' },
    ],
  })
  const signals = diffBriefs(prev, next)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].entry.who, 'ana')
  assert.equal(signals[0].kind, 'reversals')
})

test('diff only reports hard signals, never threads or tried', () => {
  const next = clampBrief({ threads: [{ topic: 'new' }], tried: [{ what: 'x' }], forks: [{ at: 'here' }] })
  const kinds = diffBriefs(EMPTY_BRIEF(), next).map(s => s.kind)
  assert.deepEqual(kinds, ['forks'])
})

test('an unchanged brief yields no signals', () => {
  const b = clampBrief({ forks: [{ at: 'x' }] })
  assert.deepEqual(diffBriefs(b, b), [])
})

test('render produces labelled lines and omits empty sections', () => {
  const out = renderBrief(clampBrief({ reversals: [{ who: 'bo', was: 'cache', now: 'stateless' }] }))
  assert.match(out, /reversals:/)
  assert.ok(!out.includes('threads:'))
})

test('rendering an entirely empty brief returns an empty string', () => {
  assert.equal(renderBrief(EMPTY_BRIEF()), '')
})

test('age is reported in whole seconds', () => {
  assert.equal(briefAge({ ts: 10_000 }, 14_500), 4)
  assert.equal(briefAge({ ts: 0 }, 0), 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/brief.test.mjs` → FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/brief.mjs
import { createHash } from 'node:crypto'

const SECTIONS = ['threads', 'forks', 'reversals', 'tried', 'unanswered']
// Only these sections are worth interrupting people about.
const HARD = ['reversals', 'forks']
const FIELDS = {
  threads: ['id', 'topic', 'owner', 'status', 'last'],
  forks: ['id', 'at', 'branches', 'live'],
  reversals: ['id', 'who', 'was', 'now', 'why'],
  tried: ['id', 'what', 'outcome', 'turn'],
  unanswered: ['id', 'who', 'question'],
}
const MAX_ENTRIES = 12
const MAX_STR = 300

export const EMPTY_BRIEF = () => ({
  threads: [], forks: [], reversals: [], tried: [], unanswered: [], ts: 0,
})

const str = v => (typeof v === 'string' ? v.slice(0, MAX_STR) : undefined)
const strArr = v =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, MAX_ENTRIES).map(x => x.slice(0, MAX_STR)) : undefined

/**
 * The observer's output is generated text, so it is never trusted structurally.
 * Unknown keys are dropped, arrays capped, strings truncated.
 */
export function clampBrief(raw, ts = 0) {
  const out = EMPTY_BRIEF()
  out.ts = ts
  if (!raw || typeof raw !== 'object') return out
  for (const section of SECTIONS) {
    const src = raw[section]
    if (!Array.isArray(src)) continue
    const entries = []
    for (const item of src.slice(0, MAX_ENTRIES)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = {}
      for (const f of FIELDS[section]) {
        const v = Array.isArray(item[f]) ? strArr(item[f]) : str(item[f])
        if (v !== undefined) entry[f] = v
      }
      if (Object.keys(entry).length) entries.push(entry)
    }
    out[section] = entries
  }
  return out
}

export function signalId(kind, subject) {
  return createHash('sha256').update(`${kind}::${subject}`).digest('hex').slice(0, 12)
}

const subjectOf = (kind, e) =>
  kind === 'reversals' ? `${e.who ?? ''}|${e.was ?? ''}` : `${e.at ?? ''}|${(e.branches ?? []).join('>')}`

/** Only entries absent from the previous brief, and only hard sections. */
export function diffBriefs(prev, next) {
  const signals = []
  for (const kind of HARD) {
    const seen = new Set((prev?.[kind] ?? []).map(e => signalId(kind, subjectOf(kind, e))))
    for (const entry of next?.[kind] ?? []) {
      const id = signalId(kind, subjectOf(kind, entry))
      if (!seen.has(id)) signals.push({ id, kind, entry })
    }
  }
  return signals
}

const line = (kind, e) =>
  kind === 'threads' ? `${e.topic ?? '?'} (${e.owner ?? 'unowned'}, ${e.status ?? 'open'})${e.last ? ' — ' + e.last : ''}`
  : kind === 'forks' ? `${e.at ?? '?'} → ${(e.branches ?? []).join(' vs ')}${e.live?.length ? ` [live: ${e.live.join(', ')}]` : ''}`
  : kind === 'reversals' ? `${e.who ?? '?'}: ${e.was ?? '?'} → ${e.now ?? '?'}${e.why ? ' (' + e.why + ')' : ''}`
  : kind === 'tried' ? `${e.what ?? '?'} → ${e.outcome ?? 'unknown'}`
  : `${e.who ?? '?'}: ${e.question ?? '?'}`

export function renderBrief(brief) {
  const parts = []
  for (const kind of SECTIONS) {
    const entries = brief?.[kind] ?? []
    if (!entries.length) continue
    parts.push(`${kind}:`)
    for (const e of entries) parts.push(`  - ${line(kind, e)}`)
  }
  return parts.join('\n')
}

export const briefAge = (brief, now = Date.now()) =>
  Math.max(0, Math.round((now - (brief?.ts ?? 0)) / 1000))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/brief.test.mjs` → PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/brief.mjs test/brief.test.mjs
git commit -m "feat: brief schema with clamping, stable signal ids and hard-signal diffing"
```

---

### Task 2: The observer cycle

**Files:**
- Create: `src/observer.mjs`
- Test: `test/observer.test.mjs`

**Interfaces:**
- Consumes: `clampBrief`, `diffBriefs`, `EMPTY_BRIEF` (Task 1)
- Produces: `class Observer` with `constructor({ config, runModel, now, onBrief, onNote, onSpend })`, `note(event)`, `flush() -> Promise<Brief|null>`, `brief() -> Brief`, `paused() -> boolean`, `buildPrompt() -> string`, `spend(tokens)`

- [ ] **Step 1: Write the failing test**

```js
// test/observer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Observer } from '../src/observer.mjs'
import { loadConfig } from '../src/config.mjs'

const cfg = over => loadConfig({ ROOM_OBSERVER: '1', ...over })
const ok = brief => async () => ({ text: JSON.stringify(brief), tokens: { input: 100, output: 50 } })

test('a cycle stores the clamped brief and reports it', async () => {
  const seen = []
  const o = new Observer({
    config: cfg(), runModel: ok({ reversals: [{ who: 'bo', was: 'cache', now: 'stateless' }] }),
    onBrief: b => seen.push(b),
  })
  o.note({ kind: 'message', name: 'bo', text: 'actually forget the cache' })
  await o.flush()
  assert.equal(o.brief().reversals[0].who, 'bo')
  assert.equal(seen.length, 1)
})

test('the prompt carries the previous brief and only new events', async () => {
  const o = new Observer({ config: cfg(), runModel: ok({ forks: [{ at: 'first' }] }) })
  o.note({ kind: 'message', name: 'ana', text: 'one' })
  await o.flush()
  o.note({ kind: 'message', name: 'bo', text: 'two' })
  const prompt = o.buildPrompt()
  assert.ok(prompt.includes('first'))   // previous brief is present
  assert.ok(prompt.includes('two'))     // the new event is present
  assert.ok(!prompt.includes('one'))    // the consumed event is not resent
})

test('flushing with nothing buffered does no work', async () => {
  let calls = 0
  const o = new Observer({ config: cfg(), runModel: async () => { calls++; return { text: '{}' } } })
  assert.equal(await o.flush(), null)
  assert.equal(calls, 0)
})

test('malformed model output is discarded and the previous brief survives', async () => {
  let out = JSON.stringify({ forks: [{ at: 'good' }] })
  const o = new Observer({ config: cfg(), runModel: async () => ({ text: out }) })
  o.note({ kind: 'message', text: 'a' })
  await o.flush()
  out = 'this is not json at all'
  o.note({ kind: 'message', text: 'b' })
  await o.flush()
  assert.equal(o.brief().forks[0].at, 'good')
})

test('a model error is swallowed and the previous brief survives', async () => {
  const o = new Observer({ config: cfg(), runModel: async () => { throw new Error('spawn failed') } })
  o.note({ kind: 'message', text: 'a' })
  assert.equal(await o.flush(), null)
  assert.deepEqual(o.brief().forks, [])
})

test('JSON wrapped in prose or fences is still recovered', async () => {
  const o = new Observer({
    config: cfg(),
    runModel: async () => ({ text: 'Sure!\n```json\n{"forks":[{"at":"x"}]}\n```\n' }),
  })
  o.note({ kind: 'message', text: 'a' })
  await o.flush()
  assert.equal(o.brief().forks[0].at, 'x')
})

test('a new hard signal produces one note, and never a second time', async () => {
  const notes = []
  const o = new Observer({
    config: cfg(), onNote: n => notes.push(n),
    runModel: ok({ reversals: [{ who: 'bo', was: 'cache', now: 'stateless' }] }),
  })
  o.note({ kind: 'message', text: 'a' })
  await o.flush()
  o.note({ kind: 'message', text: 'b' })
  await o.flush()
  assert.equal(notes.length, 1)
  assert.match(notes[0], /bo/)
})

test('notes are capped per window', async () => {
  const notes = []
  let n = 0
  const o = new Observer({
    config: cfg({ ROOM_OBSERVER_NOTES_PER_WINDOW: '2' }),
    onNote: x => notes.push(x),
    runModel: async () => ({ text: JSON.stringify({ forks: [{ at: 'f' + n++ }] }) }),
  })
  for (let i = 0; i < 5; i++) { o.note({ kind: 'message', text: String(i) }); await o.flush() }
  assert.equal(notes.length, 2)
})

test('notes can be turned off entirely', async () => {
  const notes = []
  const o = new Observer({
    config: cfg({ ROOM_OBSERVER_NOTES: '0' }), onNote: x => notes.push(x),
    runModel: ok({ reversals: [{ who: 'bo', was: 'x', now: 'y' }] }),
  })
  o.note({ kind: 'message', text: 'a' })
  await o.flush()
  assert.equal(notes.length, 0)
})

test('spend is reported and the budget pauses further cycles', async () => {
  const spends = []
  const o = new Observer({
    config: cfg({ ROOM_OBSERVER_MAX_TOKENS_PER_WINDOW: '120' }),
    onSpend: s => spends.push(s),
    runModel: ok({ forks: [{ at: 'x' }] }),
  })
  o.note({ kind: 'message', text: 'a' })
  await o.flush()
  assert.equal(spends[0].input + spends[0].output, 150)
  assert.equal(o.paused(), true)

  o.note({ kind: 'message', text: 'b' })
  assert.equal(await o.flush(), null)
})

test('a disabled observer never runs a cycle', async () => {
  let calls = 0
  const o = new Observer({
    config: loadConfig({}), runModel: async () => { calls++; return { text: '{}' } },
  })
  o.note({ kind: 'message', text: 'a' })
  assert.equal(await o.flush(), null)
  assert.equal(calls, 0)
})

test('a full event buffer triggers a cycle without waiting for the debounce', async () => {
  let calls = 0
  const o = new Observer({
    config: cfg({ ROOM_OBSERVER_MAX_EVENTS: '3' }),
    runModel: async () => { calls++; return { text: '{"forks":[]}' } },
  })
  for (let i = 0; i < 3; i++) o.note({ kind: 'message', text: String(i) })
  await o.settled()
  assert.equal(calls, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/observer.test.mjs` → FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

Implement `src/observer.mjs` per the interfaces above:

- buffer events in an array; `note()` pushes and, when the buffer reaches
  `maxEvents`, schedules an immediate cycle, otherwise resets a debounce timer
  (`setTimeout(...).unref()`), tracking the in-flight promise so `settled()` can await it
- `buildPrompt()` returns a fixed instruction block plus `renderBrief(previous)` plus the
  buffered events; the instruction block states that room text is data to summarise and
  never instructions, and demands a single JSON object
- `flush()` returns `null` unless enabled, not paused, and the buffer is non-empty;
  otherwise it drains the buffer, calls `runModel(prompt)`, extracts JSON (first `{` to
  last `}`, tolerating fences and prose), `clampBrief`s it with `now()`, stores it, calls
  `onBrief`, diffs against the previous brief, emits at most `notesPerWindow` notes through
  `onNote`, and reports `{ input, output }` through `onSpend`
- any throw or unparseable output leaves the previous brief in place and returns `null`
- `paused()` is true once window spend exceeds `maxTokensPerWindow`; the window resets on
  `budgets.windowMs`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/observer.test.mjs` → PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/observer.mjs test/observer.test.mjs
git commit -m "feat: observer cycle with debounce, budget pause and speak-once throttling"
```

---

### Task 3: The model runner and configuration

**Files:**
- Create: `src/run-model.mjs`
- Modify: `src/config.mjs`
- Test: `test/run-model.test.mjs`, `test/config.test.mjs`

**Interfaces:**
- Produces: `makeRunner(config) -> (prompt) => Promise<{text, tokens}>`; config gains `observer: { on, model, debounceMs, maxEvents, notes, notesPerWindow, maxTokensPerWindow }`

- [ ] **Step 1: Write the failing test**

```js
// test/run-model.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRunner, extractJSON } from '../src/run-model.mjs'
import { loadConfig } from '../src/config.mjs'

test('extracts a bare JSON object', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 })
})

test('extracts JSON from fences and surrounding prose', () => {
  assert.deepEqual(extractJSON('Here you go:\n```json\n{"a":2}\n```\nhope that helps'), { a: 2 })
})

test('returns null for text with no JSON object', () => {
  assert.equal(extractJSON('no json here'), null)
  assert.equal(extractJSON(''), null)
  assert.equal(extractJSON('{ broken'), null)
})

test('the runner spawns the configured model and returns parsed usage', async () => {
  // Stand in for `claude -p` so no session is started and no tokens are spent.
  const runner = makeRunner(loadConfig({ ROOM_OBSERVER_MODEL: 'haiku' }), {
    spawn: (cmd, args) => {
      assert.equal(cmd, 'claude')
      assert.ok(args.includes('-p'))
      assert.ok(args.includes('--model'))
      assert.ok(args.includes('haiku'))
      assert.ok(args.includes('--output-format'))
      return {
        stdout: JSON.stringify({
          result: '{"forks":[]}',
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 },
        }),
        code: 0,
      }
    },
  })
  const out = await runner('some prompt')
  assert.equal(out.text, '{"forks":[]}')
  assert.equal(out.tokens.input, 16)
  assert.equal(out.tokens.output, 4)
})

test('a non-zero exit throws so the observer keeps its previous brief', async () => {
  const runner = makeRunner(loadConfig({}), { spawn: () => ({ stdout: '', stderr: 'boom', code: 1 }) })
  await assert.rejects(() => runner('x'), /boom|exit/)
})
```

Add to `test/config.test.mjs`:

```js
test('observer settings default to off and safe', () => {
  const c = loadConfig({})
  assert.equal(c.observer.on, false)
  assert.equal(c.observer.model, 'haiku')
  assert.equal(c.observer.debounceMs, 4000)
  assert.equal(c.observer.notes, true)
  assert.equal(c.observer.notesPerWindow, 6)
})

test('observer settings read from env', () => {
  const c = loadConfig({ ROOM_OBSERVER: '1', ROOM_OBSERVER_DEBOUNCE_MS: '900', ROOM_OBSERVER_NOTES: '0' })
  assert.equal(c.observer.on, true)
  assert.equal(c.observer.debounceMs, 900)
  assert.equal(c.observer.notes, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/run-model.test.mjs test/config.test.mjs` → FAIL

- [ ] **Step 3: Write minimal implementation**

Add the `observer` block to `loadConfig` using the existing `int`/`bool`/`oneOf` helpers,
defaulting `notes` to `true`. Write `src/run-model.mjs` exporting `extractJSON(text)` (first
`{` to last `}`, `JSON.parse` in a try, `null` on failure) and `makeRunner(config, { spawn })`
where the default `spawn` uses `child_process.spawn` with
`['-p', '--model', <model>, '--output-format', 'json', '--disallowed-tools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch']`,
writes the prompt to stdin, collects stdout, and rejects on a non-zero exit. Sum
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` into `tokens.input`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/run-model.test.mjs test/config.test.mjs` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/run-model.mjs src/config.mjs test/run-model.test.mjs test/config.test.mjs
git commit -m "feat: tool-less claude -p runner and observer configuration"
```

---

### Task 4: Wire the brief into the room

**Files:**
- Modify: `src/channel.mjs`, `src/web.mjs`, `src/server.mjs`
- Test: `test/channel.test.mjs`, `test/web.test.mjs`

**Interfaces:**
- Produces: `buildBriefNotification(briefText, { stale, ageS, roomName }) -> notification|null`; `channel.notifyBrief(text, opts)`; `/api/state` gains `brief` and `observerSpend`

- [ ] **Step 1: Write the failing test**

```js
// add to test/channel.test.mjs
import { buildBriefNotification } from '../src/channel.mjs'

test('a brief notification is tagged as machine-generated', () => {
  const nt = buildBriefNotification('forks:\n  - a vs b', { stale: false, ageS: 3, roomName: 'r' })
  assert.equal(nt.params.meta.kind, 'brief')
  assert.equal(nt.params.meta.stale, 'false')
  assert.equal(nt.params.meta.age_s, '3')
  assert.equal(nt.params.meta.user, undefined)   // never attributed to a person
  assert.ok(nt.params.content.includes('a vs b'))
})

test('an empty brief produces no notification', () => {
  assert.equal(buildBriefNotification('', { stale: false, ageS: 0, roomName: 'r' }), null)
})
```

```js
// add to test/web.test.mjs — harness gains an `observer` stub
test('the brief is sent as its own event immediately before the message', async () => {
  const h = harness({}, { brief: () => ({ text: 'forks:\n  - a vs b', stale: false, ageS: 2 }) })
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })

  assert.equal(h.briefs.length, 1)
  assert.equal(h.sent.length, 1)
  // The member's words are untouched — not even a wrapper.
  assert.equal(h.sent[0][0].content, '@claude go')
  assert.ok(h.briefs[0].text.includes('a vs b'))
  assert.equal(h.order.join(','), 'brief,message')
  done(h)
})

test('no brief event is emitted when the observer has nothing', async () => {
  const h = harness({}, { brief: () => ({ text: '', stale: false, ageS: 0 }) })
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  assert.equal(h.briefs.length, 0)
  assert.equal(h.sent.length, 1)
  done(h)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/channel.test.mjs test/web.test.mjs` → FAIL

- [ ] **Step 3: Write minimal implementation**

In `channel.mjs` add `buildBriefNotification(text, { stale, ageS, roomName })` returning
`null` for empty text and otherwise a `notifications/claude/channel` notification whose
`meta` is `{ room, kind: 'brief', stale, age_s }` and never carries `user` or `member_id`.
Add `notifyBrief` to the returned channel object.

In `web.mjs`, `drain()` calls `observer?.briefForInjection()` before `channel.notify(...)`
and, when it yields text, calls `channel.notifyBrief(...)` first. Feed room messages and
closed turns to `observer.note(...)`. Add `brief` and `observerSpend` to `/api/state`.

In `server.mjs`, construct the `Observer` with `makeRunner(config)` when
`config.observer.on`, wire `onBrief` to a `bus.publish('brief', …)`, `onNote` to a room
message from a reserved `observer` member, and `onSpend` to a ledger record against the
reserved member id `observer`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test` → PASS, all suites

- [ ] **Step 5: Commit**

```bash
git add src/channel.mjs src/web.mjs src/server.mjs test/channel.test.mjs test/web.test.mjs
git commit -m "feat: inject the brief as its own channel event before the member message"
```

---

### Task 5: Brief panel, docs, and demo

**Files:**
- Modify: `src/ui.mjs`, `README.md`, scratchpad `demo.mjs`
- Test: `test/ui.test.mjs`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test**

```js
// add to test/ui.test.mjs
test('the brief panel is present in the document', () => {
  const html = renderUI(loadConfig({}))
  assert.ok(html.includes('id="brief"'))
  assert.match(html, /Room state/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.mjs` → FAIL

- [ ] **Step 3: Write minimal implementation**

Add a **Room state** section to the sidebar rendering the brief with `textContent`, a
staleness indicator, and an observer spend row in the cost table. Subscribe to the `brief`
SSE event. Document the observer in `README.md`: what it does, the config table from the
spec, the cost profile, and the laundering risk stated plainly. Extend the demo harness to
run with `ROOM_OBSERVER=1` against a scripted `runModel` so a fork and a walk-back appear
without spending tokens.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test` → PASS, all suites

- [ ] **Step 5: Commit**

```bash
git add src/ui.mjs README.md test/ui.test.mjs
git commit -m "feat: room-state panel, observer docs and demo wiring"
```

---

## Self-Review

**Spec coverage.** §3 brief → Task 1. §4 cycle → Task 2. §5 injection → Task 4. §6 speaking
→ Task 2 (throttle) and Task 4 (delivery). §7 cost and budget → Tasks 2, 3, 4. §8 failure
modes → Task 2 tests for malformed output, model error, budget pause, disabled. §9 security
→ Task 1 clamping, Task 3 `--disallowed-tools`, Task 4 `kind="brief"` tagging, Task 5
`textContent`. §10 testing → every task. §12 config → Task 3.

**Placeholder scan.** Tasks 2, 3 and 5 give implementations as precise prose contracts
rather than full listings, because their bodies are mechanical given the interfaces and the
tests pin every branch. No TBDs.

**Type consistency.** `Brief` sections are the same five names throughout. `runModel`
returns `{ text, tokens: { input, output } }` in Tasks 2 and 3. `Signal` is
`{ id, kind, entry }` in Tasks 1 and 2. `briefForInjection()` returns
`{ text, stale, ageS }` in Tasks 4 and 5.
