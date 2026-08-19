# claude-room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a room server that lets several humans drive one shared Claude Code session from their browsers over Tailscale, with per-member cost attribution.

**Architecture:** One Node process spawned by Claude Code as an MCP stdio child. It speaks the channel protocol on stdio (inbound messages become `<channel>` events; replies come back through a reply tool) and simultaneously serves HTTP + SSE to teammates' browsers. Claude Code hooks POST activity back into the same process, which broadcasts it as a live feed. Pure modules (`router`, `ledger`, `identity`, `decisions`) carry the load-bearing logic and are unit tested with no Claude Code in the loop.

**Tech Stack:** Node 22 ESM (`.mjs`), `@modelcontextprotocol/sdk` as the sole runtime dependency, `node:test` + `node:assert/strict` for tests, `node:http` + Server-Sent Events for the browser transport.

**Spec:** `docs/superpowers/specs/2026-08-19-claude-room-design.md`

## Global Constraints

- Runtime dependency allowlist: `@modelcontextprotocol/sdk` only. Everything else must be a Node built-in. No `ws`, no `express`, no bundler, no TypeScript build step.
- All source files are ESM `.mjs`. Types are expressed as JSDoc typedefs, never `.ts`.
- Channel `meta` keys must match `/^[A-Za-z0-9_]+$/`. Keys containing hyphens are silently dropped by Claude Code — validate rather than trust.
- Message `content` sent to the channel is **verbatim**. Attribution goes in `meta`. Never rewrite a member's words. (Spec §5, handoff §3.4.)
- Sender gating is on **member identity**, never room membership. Gate before `mcp.notification()` is called. (Spec §7.)
- Exactly one agent turn in flight at a time. The queue is the serialization point. (Spec §6.)
- `permissionRelay` defaults to `false`. `payerMode` defaults to `"host"`.
- The MCP server writes **nothing** to stdout except MCP protocol traffic. All logging goes to stderr — stdout is the transport and any stray write corrupts it.
- Tests run with `node --test test/`. Every task ends green.

---

### Task 1: Scaffold, config, and shared types

**Files:**
- Create: `package.json`, `.gitignore` (exists, extend), `src/types.mjs`, `src/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env) -> Config` where `Config = { roomName:string, port:number, host:string, stateDir:string, payerMode:'host'|'rotate', permissionRelay:boolean, splitMode:'equal'|'weighted', budgets:{ windowMs:number, tokensPerMember:number, messagesPerWindow:number } }`. Typedefs `Member`, `RoomMessage`, `Usage` in `src/types.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// test/config.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.mjs'

test('defaults are safe', () => {
  const c = loadConfig({})
  assert.equal(c.port, 8787)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.payerMode, 'host')
  assert.equal(c.permissionRelay, false)
  assert.equal(c.splitMode, 'equal')
})

test('env overrides are parsed and typed', () => {
  const c = loadConfig({
    ROOM_PORT: '9000', ROOM_HOST: '100.64.0.1', ROOM_NAME: 'auth-work',
    ROOM_PAYER_MODE: 'rotate', ROOM_PERMISSION_RELAY: '1',
    ROOM_TOKENS_PER_MEMBER: '50000',
  })
  assert.equal(c.port, 9000)
  assert.equal(c.host, '100.64.0.1')
  assert.equal(c.roomName, 'auth-work')
  assert.equal(c.payerMode, 'rotate')
  assert.equal(c.permissionRelay, true)
  assert.equal(c.budgets.tokensPerMember, 50000)
})

test('an unknown payer mode falls back to host rather than throwing', () => {
  assert.equal(loadConfig({ ROOM_PAYER_MODE: 'nonsense' }).payerMode, 'host')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL, cannot find module `../src/config.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
// src/config.mjs
import { homedir } from 'node:os'
import { join } from 'node:path'

const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d)
const bool = v => v === '1' || v === 'true'
const oneOf = (v, allowed, d) => (allowed.includes(v) ? v : d)

export function loadConfig(env = process.env) {
  return {
    roomName: env.ROOM_NAME || 'room',
    port: int(env.ROOM_PORT, 8787),
    host: env.ROOM_HOST || '127.0.0.1',
    stateDir: env.ROOM_STATE_DIR || join(homedir(), '.claude', 'channels', 'room'),
    payerMode: oneOf(env.ROOM_PAYER_MODE, ['host', 'rotate'], 'host'),
    permissionRelay: bool(env.ROOM_PERMISSION_RELAY),
    splitMode: oneOf(env.ROOM_SPLIT_MODE, ['equal', 'weighted'], 'equal'),
    budgets: {
      windowMs: int(env.ROOM_BUDGET_WINDOW_MS, 5 * 60 * 60 * 1000),
      tokensPerMember: int(env.ROOM_TOKENS_PER_MEMBER, 0),
      messagesPerWindow: int(env.ROOM_MESSAGES_PER_WINDOW, 200),
    },
  }
}
```

`src/types.mjs` holds JSDoc typedefs only (no runtime code):

```js
// src/types.mjs
/** @typedef {'owner'|'member'|'viewer'} Role */
/** @typedef {{ id:string, name:string, role:Role, canApprove:boolean, token:string, payerRef?:string }} Member */
/** @typedef {{ input:number, output:number, cacheRead:number, cacheCreate:number, cache1h:number, cache5m:number }} Usage */
/** @typedef {{ id:string, memberId:string, name:string, text:string, ts:number,
 *   addressed:boolean, kind:'chat'|'reply'|'activity'|'system',
 *   attachment?:{ path:string, name:string } }} RoomMessage */
export {}
```

`package.json`:

```json
{
  "name": "claude-room",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.mjs",
    "test": "node --test test/"
  },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0" }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && node --test test/config.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/types.mjs src/config.mjs test/config.test.mjs
git commit -m "feat: project scaffold, config loader, shared typedefs"
```

---

### Task 2: Identity, join tokens, and roles

**Files:**
- Create: `src/identity.mjs`
- Test: `test/identity.test.mjs`

**Interfaces:**
- Consumes: `Member` typedef from Task 1
- Produces: `createMember({name, role, canApprove}) -> Member`; `class Registry` with `add(member)`, `byToken(token) -> Member|null`, `byId(id) -> Member|null`, `all() -> Member[]`, `revoke(id) -> boolean`, `toJSON()`, static `fromJSON(arr) -> Registry`; `canAddress(member) -> boolean`; `mayApprove(member) -> boolean`

- [ ] **Step 1: Write the failing test**

```js
// test/identity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMember, Registry, canAddress, mayApprove } from '../src/identity.mjs'

test('a member gets a long unguessable token', () => {
  const m = createMember({ name: 'heet', role: 'owner' })
  assert.ok(m.token.length >= 32)
  assert.notEqual(createMember({ name: 'a', role: 'member' }).token, m.token)
})

test('lookup by token resolves the member, unknown tokens resolve null', () => {
  const r = new Registry()
  const m = r.add(createMember({ name: 'ana', role: 'member' }))
  assert.equal(r.byToken(m.token).id, m.id)
  assert.equal(r.byToken('not-a-real-token'), null)
  assert.equal(r.byToken(''), null)
  assert.equal(r.byToken(undefined), null)
})

test('viewers cannot address Claude; owners and members can', () => {
  assert.equal(canAddress({ role: 'viewer' }), false)
  assert.equal(canAddress({ role: 'member' }), true)
  assert.equal(canAddress({ role: 'owner' }), true)
})

test('approval requires the owner role or an explicit grant', () => {
  assert.equal(mayApprove({ role: 'owner', canApprove: false }), true)
  assert.equal(mayApprove({ role: 'member', canApprove: true }), true)
  assert.equal(mayApprove({ role: 'member', canApprove: false }), false)
  assert.equal(mayApprove({ role: 'viewer', canApprove: true }), false)
})

test('a revoked token stops resolving', () => {
  const r = new Registry()
  const m = r.add(createMember({ name: 'temp', role: 'member' }))
  assert.equal(r.revoke(m.id), true)
  assert.equal(r.byToken(m.token), null)
  assert.equal(r.revoke(m.id), false)
})

test('round-trips through JSON', () => {
  const r = new Registry()
  const m = r.add(createMember({ name: 'ana', role: 'member', canApprove: true }))
  const back = Registry.fromJSON(JSON.parse(JSON.stringify(r.toJSON())))
  assert.equal(back.byToken(m.token).name, 'ana')
  assert.equal(back.byToken(m.token).canApprove, true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/identity.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/identity.mjs
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export function createMember({ name, role = 'member', canApprove = false, payerRef }) {
  return { id: randomUUID(), name, role, canApprove, token: randomBytes(24).toString('base64url'), payerRef }
}

export const canAddress = m => !!m && (m.role === 'owner' || m.role === 'member')
export const mayApprove = m => !!m && (m.role === 'owner' || (m.role === 'member' && m.canApprove === true))

/** Constant-time compare so token lookup does not leak length or prefix by timing. */
function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export class Registry {
  #members = new Map()
  add(member) { this.#members.set(member.id, member); return member }
  byId(id) { return this.#members.get(id) ?? null }
  byToken(token) {
    if (!token) return null
    for (const m of this.#members.values()) if (sameToken(m.token, token)) return m
    return null
  }
  all() { return [...this.#members.values()] }
  revoke(id) { return this.#members.delete(id) }
  toJSON() { return this.all() }
  static fromJSON(arr = []) {
    const r = new Registry()
    for (const m of arr) r.add(m)
    return r
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/identity.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/identity.mjs test/identity.test.mjs
git commit -m "feat: member registry with revocable join tokens and role gating"
```

---

### Task 3: The addressing router

This is the classifier from handoff §3.3, implemented as a pure function with no LLM and no
latency. It is the single reason the room stays affordable: unaddressed chatter never enters
the context window.

**Files:**
- Create: `src/router.mjs`
- Test: `test/router.test.mjs`

**Interfaces:**
- Consumes: `canAddress` from Task 2
- Produces: `classify(text, member, opts) -> { addressed:boolean, content:string, display:string, reason:string }` where `opts = { force?:boolean }`. `content` is always verbatim input. `display` has a leading mention stripped for rendering only.

- [ ] **Step 1: Write the failing test**

```js
// test/router.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/router.mjs'

const member = { role: 'member', name: 'ana' }
const viewer = { role: 'viewer', name: 'obs' }

test('plain chatter is not addressed', () => {
  const r = classify('anyone know why CI is red?', member)
  assert.equal(r.addressed, false)
  assert.equal(r.reason, 'chatter')
})

test('a leading @claude mention addresses the agent', () => {
  const r = classify('@claude fix the failing test', member)
  assert.equal(r.addressed, true)
  assert.equal(r.reason, 'mention')
})

test('content is preserved verbatim while display strips the mention', () => {
  const r = classify('@claude   fix   it', member)
  assert.equal(r.content, '@claude   fix   it')
  assert.equal(r.display, 'fix   it')
})

test('the mention must lead — mid-sentence mentions stay chatter', () => {
  assert.equal(classify('ask @claude about it later', member).addressed, false)
})

test('the mention is case-insensitive and tolerates punctuation', () => {
  assert.equal(classify('@Claude: go', member).addressed, true)
  assert.equal(classify('@CLAUDE, go', member).addressed, true)
})

test('a bare mention with no instruction is chatter, not an empty turn', () => {
  assert.equal(classify('@claude', member).addressed, false)
  assert.equal(classify('@claude   ', member).addressed, false)
})

test('the force flag addresses without a mention', () => {
  const r = classify('fix the test', member, { force: true })
  assert.equal(r.addressed, true)
  assert.equal(r.reason, 'explicit')
  assert.equal(r.display, 'fix the test')
})

test('a viewer can never address, even with force or a mention', () => {
  assert.equal(classify('@claude do it', viewer).addressed, false)
  assert.equal(classify('do it', viewer, { force: true }).addressed, false)
  assert.equal(classify('@claude do it', viewer).reason, 'not-permitted')
})

test('an email-like token is not a mention', () => {
  assert.equal(classify('mail@claude.example.com is the alias', member).addressed, false)
})

test('empty and whitespace input is never addressed', () => {
  assert.equal(classify('', member, { force: true }).addressed, false)
  assert.equal(classify('   ', member).addressed, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/router.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/router.mjs
import { canAddress } from './identity.mjs'

// Leading mention only: start of string, optional punctuation, then whitespace.
// Anchored at ^ so "mail@claude.example.com" and "ask @claude later" never match.
const MENTION = /^@claude\b[:,]?\s*/i

export function classify(text, member, opts = {}) {
  const raw = typeof text === 'string' ? text : ''
  const trimmed = raw.trim()
  const base = { addressed: false, content: raw, display: trimmed, reason: 'chatter' }

  if (!trimmed) return { ...base, reason: 'empty' }

  const hasMention = MENTION.test(trimmed)
  const wants = hasMention || opts.force === true
  if (!wants) return base

  if (!canAddress(member)) return { ...base, reason: 'not-permitted' }

  const display = hasMention ? trimmed.replace(MENTION, '') : trimmed
  // A mention with nothing after it is a greeting, not a turn worth paying for.
  if (!display.trim()) return { ...base, display: trimmed, reason: 'empty' }

  return { addressed: true, content: raw, display, reason: hasMention ? 'mention' : 'explicit' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/router.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/router.mjs test/router.test.mjs
git commit -m "feat: pure addressing router — chatter never reaches the context window"
```

---

### Task 4: The ledger

Reads real Claude Code transcript JSONL. Verified field shape on 2026-08-19:
`message.usage = { input_tokens, output_tokens, cache_read_input_tokens,
cache_creation_input_tokens, cache_creation: { ephemeral_1h_input_tokens,
ephemeral_5m_input_tokens } }`.

**Files:**
- Create: `src/ledger.mjs`
- Test: `test/ledger.test.mjs`

**Interfaces:**
- Consumes: `Usage` typedef from Task 1
- Produces: `parseUsageLine(jsonlLine) -> Usage|null`; `sumUsage(usages) -> Usage`; `cacheRatio(usage) -> number`; `attribute(usage, participants, mode) -> Record<memberId, Usage>` where `participants = [{ memberId, weight }]`; `class Ledger` with `record(promptId, usage, participants, mode)`, `totalsFor(memberId) -> Usage`, `turns() -> Turn[]`, `toJSON()`, static `fromJSON(o) -> Ledger`

- [ ] **Step 1: Write the failing test**

```js
// test/ledger.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageLine, sumUsage, cacheRatio, attribute, Ledger } from '../src/ledger.mjs'

const line = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    usage: {
      input_tokens: 2, output_tokens: 319,
      cache_read_input_tokens: 21169, cache_creation_input_tokens: 15237,
      cache_creation: { ephemeral_1h_input_tokens: 15237, ephemeral_5m_input_tokens: 0 },
    },
  },
})

test('parses a real assistant transcript line', () => {
  const u = parseUsageLine(line)
  assert.deepEqual(u, { input: 2, output: 319, cacheRead: 21169, cacheCreate: 15237, cache1h: 15237, cache5m: 0 })
})

test('non-assistant, malformed, and blank lines yield null rather than throwing', () => {
  assert.equal(parseUsageLine(JSON.stringify({ type: 'user', message: {} })), null)
  assert.equal(parseUsageLine('{not json'), null)
  assert.equal(parseUsageLine(''), null)
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: {} })), null)
})

test('missing cache_creation detail defaults to zero, not NaN', () => {
  const u = parseUsageLine(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 1 } } }))
  assert.equal(u.cache1h, 0)
  assert.equal(u.cacheRead, 0)
})

test('sums usages field by field', () => {
  const u = sumUsage([parseUsageLine(line), parseUsageLine(line)])
  assert.equal(u.output, 638)
  assert.equal(u.cacheRead, 42338)
})

test('cache ratio is cached reads over all input — the rotation instrument', () => {
  assert.ok(Math.abs(cacheRatio({ input: 2, cacheRead: 21169, cacheCreate: 15237 }) - 21169 / 36408) < 1e-9)
  assert.equal(cacheRatio({ input: 0, cacheRead: 0, cacheCreate: 0 }), 0)
  assert.equal(cacheRatio({ input: 100, cacheRead: 0, cacheCreate: 0 }), 0)
})

test('equal split divides a turn evenly across participants', () => {
  const got = attribute({ input: 10, output: 10, cacheRead: 10, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'a', weight: 1 }, { memberId: 'b', weight: 3 }], 'equal')
  assert.equal(got.a.output, 5)
  assert.equal(got.b.output, 5)
})

test('weighted split honours weights', () => {
  const got = attribute({ input: 0, output: 100, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'a', weight: 1 }, { memberId: 'b', weight: 3 }], 'weighted')
  assert.equal(got.a.output, 25)
  assert.equal(got.b.output, 75)
})

test('zero total weight falls back to an equal split instead of dividing by zero', () => {
  const got = attribute({ input: 0, output: 10, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'a', weight: 0 }, { memberId: 'b', weight: 0 }], 'weighted')
  assert.equal(got.a.output, 5)
  assert.equal(got.b.output, 5)
})

test('a turn with no participants is recorded but attributed to nobody', () => {
  const l = new Ledger()
  l.record('p1', parseUsageLine(line), [], 'equal')
  assert.equal(l.turns().length, 1)
  assert.equal(l.totalsFor('nobody').output, 0)
})

test('ledger accumulates per member across turns and round-trips', () => {
  const l = new Ledger()
  const u = parseUsageLine(line)
  l.record('p1', u, [{ memberId: 'a', weight: 1 }], 'equal')
  l.record('p2', u, [{ memberId: 'a', weight: 1 }], 'equal')
  assert.equal(l.totalsFor('a').output, 638)
  const back = Ledger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())))
  assert.equal(back.totalsFor('a').output, 638)
  assert.equal(back.turns().length, 2)
})

test('recording the same promptId twice does not double-count', () => {
  const l = new Ledger()
  const u = parseUsageLine(line)
  l.record('p1', u, [{ memberId: 'a', weight: 1 }], 'equal')
  l.record('p1', u, [{ memberId: 'a', weight: 1 }], 'equal')
  assert.equal(l.turns().length, 1)
  assert.equal(l.totalsFor('a').output, 319)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ledger.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/ledger.mjs
const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 })
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function parseUsageLine(line) {
  if (!line || !line.trim()) return null
  let o
  try { o = JSON.parse(line) } catch { return null }
  if (o?.type !== 'assistant') return null
  const u = o?.message?.usage
  if (!u) return null
  const cc = u.cache_creation ?? {}
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheCreate: n(u.cache_creation_input_tokens),
    cache1h: n(cc.ephemeral_1h_input_tokens),
    cache5m: n(cc.ephemeral_5m_input_tokens),
  }
}

export function sumUsage(usages) {
  const t = ZERO()
  for (const u of usages) { if (!u) continue; for (const k of Object.keys(t)) t[k] += n(u[k]) }
  return t
}

/** Cached reads as a share of all input tokens. Near zero after a cache miss. */
export function cacheRatio(u) {
  const total = n(u.input) + n(u.cacheRead) + n(u.cacheCreate)
  return total === 0 ? 0 : n(u.cacheRead) / total
}

export function attribute(usage, participants, mode = 'equal') {
  const out = {}
  if (!participants.length) return out
  const totalWeight = participants.reduce((s, p) => s + n(p.weight), 0)
  const useWeights = mode === 'weighted' && totalWeight > 0
  for (const p of participants) {
    const share = useWeights ? n(p.weight) / totalWeight : 1 / participants.length
    const slice = ZERO()
    for (const k of Object.keys(slice)) slice[k] = n(usage[k]) * share
    out[p.memberId] = slice
  }
  return out
}

export class Ledger {
  #turns = []
  #seen = new Set()
  #totals = new Map()

  record(promptId, usage, participants, mode = 'equal') {
    if (promptId && this.#seen.has(promptId)) return null
    if (promptId) this.#seen.add(promptId)
    const split = attribute(usage, participants, mode)
    for (const [memberId, slice] of Object.entries(split)) {
      const cur = this.#totals.get(memberId) ?? ZERO()
      for (const k of Object.keys(cur)) cur[k] += slice[k]
      this.#totals.set(memberId, cur)
    }
    const turn = { promptId, usage, participants, split, ratio: cacheRatio(usage), ts: Date.now() }
    this.#turns.push(turn)
    return turn
  }

  totalsFor(memberId) { return this.#totals.get(memberId) ?? ZERO() }
  turns() { return this.#turns }
  toJSON() { return { turns: this.#turns, totals: Object.fromEntries(this.#totals) } }

  static fromJSON(o = {}) {
    const l = new Ledger()
    for (const t of o.turns ?? []) { l.#turns.push(t); if (t.promptId) l.#seen.add(t.promptId) }
    for (const [k, v] of Object.entries(o.totals ?? {})) l.#totals.set(k, v)
    return l
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ledger.test.mjs`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/ledger.mjs test/ledger.test.mjs
git commit -m "feat: ledger parsing real transcript usage with per-member attribution and cache ratio"
```

---

### Task 5: Decision store and contradiction flagging

Handoff §3.3 calls this the highest-value function of the layer. It **flags, never resolves** —
the agent silently picking a side is the failure mode being prevented.

**Files:**
- Create: `src/decisions.mjs`
- Test: `test/decisions.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `class Decisions` with `add({ text, by, tags, supersedes }) -> Decision`, `open() -> Decision[]`, `conflicts(text, tags) -> Conflict[]`, `toJSON()`, static `fromJSON(arr)`. `Decision = { id, text, by, tags:string[], ts, supersededBy:string|null }`. `Conflict = { decision, reason:'negation'|'overlap', overlap:string[] }`. Also `extractTags(text) -> string[]`.

- [ ] **Step 1: Write the failing test**

```js
// test/decisions.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Decisions, extractTags } from '../src/decisions.mjs'

test('tags come from meaningful words, stopwords excluded', () => {
  const tags = extractTags('keep the auth service stateless')
  assert.ok(tags.includes('auth'))
  assert.ok(tags.includes('stateless'))
  assert.ok(!tags.includes('the'))
})

test('a superseding decision closes the one it replaces', () => {
  const d = new Decisions()
  const first = d.add({ text: 'use redis for sessions', by: 'heet' })
  d.add({ text: 'use postgres for sessions', by: 'ana', supersedes: first.id })
  const openIds = d.open().map(x => x.id)
  assert.ok(!openIds.includes(first.id))
  assert.equal(d.open().length, 1)
})

test('a negation of an open decision is flagged as a conflict', () => {
  const d = new Decisions()
  d.add({ text: 'keep the auth service stateless', by: 'heet' })
  const c = d.conflicts('add a cache layer to auth so it is not stateless')
  assert.equal(c.length, 1)
  assert.equal(c[0].reason, 'negation')
})

test('strong topic overlap without negation is flagged as overlap, not negation', () => {
  const d = new Decisions()
  d.add({ text: 'auth tokens expire after thirty minutes', by: 'heet' })
  const c = d.conflicts('change auth tokens to expire after seven days')
  assert.equal(c.length, 1)
  assert.equal(c[0].reason, 'overlap')
  assert.ok(c[0].overlap.includes('auth'))
})

test('unrelated text produces no conflicts', () => {
  const d = new Decisions()
  d.add({ text: 'keep the auth service stateless', by: 'heet' })
  assert.equal(d.conflicts('update the readme typo').length, 0)
})

test('superseded decisions are never flagged', () => {
  const d = new Decisions()
  const first = d.add({ text: 'keep auth stateless', by: 'heet' })
  d.add({ text: 'auth may hold state now', by: 'ana', supersedes: first.id })
  const c = d.conflicts('auth should not be stateless')
  assert.ok(c.every(x => x.decision.id !== first.id))
})

test('round-trips through JSON', () => {
  const d = new Decisions()
  d.add({ text: 'keep auth stateless', by: 'heet' })
  const back = Decisions.fromJSON(JSON.parse(JSON.stringify(d.toJSON())))
  assert.equal(back.open().length, 1)
  assert.equal(back.conflicts('do not keep auth stateless').length, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/decisions.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/decisions.mjs
import { randomUUID } from 'node:crypto'

const STOP = new Set(['the','a','an','to','for','of','and','or','is','are','be','it','we','so','on','in','with','use','using','should','must','can','after','now','has','have','that','this','then','than','as','at','by','from','do','does'])
const NEGATORS = ['not', 'no longer', "don't", 'dont', 'never', 'stop', 'remove', 'drop', 'instead', 'revert', 'undo']

export function extractTags(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])].filter(w => !STOP.has(w))
}

const hasNegator = t => NEGATORS.some(neg => new RegExp(`\\b${neg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t))

export class Decisions {
  #items = []

  add({ text, by, tags, supersedes = null }) {
    const d = { id: randomUUID(), text, by, tags: tags?.length ? tags : extractTags(text), ts: Date.now(), supersededBy: null }
    if (supersedes) {
      const prev = this.#items.find(x => x.id === supersedes)
      if (prev) prev.supersededBy = d.id
    }
    this.#items.push(d)
    return d
  }

  open() { return this.#items.filter(d => d.supersededBy === null) }

  /** Flags candidates for a human to judge. Deliberately never resolves. */
  conflicts(text, tags) {
    const incoming = new Set(tags?.length ? tags : extractTags(text))
    const negated = hasNegator(text)
    const out = []
    for (const d of this.open()) {
      const overlap = d.tags.filter(t => incoming.has(t))
      if (!overlap.length) continue
      // A negation cue plus any shared topic is the "add a cache" vs "keep it
      // stateless" case. Without a cue, require real topical overlap.
      if (negated) out.push({ decision: d, reason: 'negation', overlap })
      else if (overlap.length >= 2) out.push({ decision: d, reason: 'overlap', overlap })
    }
    return out
  }

  toJSON() { return this.#items }
  static fromJSON(arr = []) {
    const d = new Decisions()
    for (const item of arr) d.#items.push(item)
    return d
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/decisions.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/decisions.mjs test/decisions.test.mjs
git commit -m "feat: decision store that flags contradictions without resolving them"
```

---

### Task 6: The queue — serialization, rate limits, budgets, payer selection

**Files:**
- Create: `src/queue.mjs`
- Test: `test/queue.test.mjs`

**Interfaces:**
- Consumes: `Registry`/`canAddress` (Task 2), `classify` (Task 3), `Ledger` (Task 4), `Config` (Task 1)
- Produces: `class Queue` with `submit(member, text, opts) -> { ok:boolean, reason:string, message:RoomMessage|null, conflicts:Conflict[] }`, `pending() -> RoomMessage[]`, `busy() -> boolean`, `beginTurn() -> { messages:RoomMessage[], participants:[{memberId,weight}], payer:string|null }|null`, `endTurn(promptId)`, `participantsOf(promptId) -> [{memberId,weight}]|null`, `selectPayer(messages) -> string|null`

- [ ] **Step 1: Write the failing test**

```js
// test/queue.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Queue } from '../src/queue.mjs'
import { Ledger } from '../src/ledger.mjs'
import { loadConfig } from '../src/config.mjs'
import { Decisions } from '../src/decisions.mjs'

const mk = (over = {}) => new Queue({
  config: loadConfig({ ROOM_MESSAGES_PER_WINDOW: '3', ...over.env }),
  ledger: new Ledger(), decisions: new Decisions(), now: over.now ?? (() => 1000),
})
const ana = { id: 'a', name: 'ana', role: 'member', canApprove: false }
const obs = { id: 'o', name: 'obs', role: 'viewer', canApprove: false }

test('chatter is accepted but never queued for a turn', () => {
  const q = mk()
  const r = q.submit(ana, 'morning all')
  assert.equal(r.ok, true)
  assert.equal(r.message.addressed, false)
  assert.equal(q.pending().length, 0)
})

test('an addressed message is queued', () => {
  const q = mk()
  q.submit(ana, '@claude run the tests')
  assert.equal(q.pending().length, 1)
})

test('a viewer is rejected with a visible reason, never silently', () => {
  const q = mk()
  const r = q.submit(obs, '@claude run the tests')
  assert.equal(r.ok, true)
  assert.equal(r.message.addressed, false)
  assert.equal(r.reason, 'not-permitted')
})

test('the message rate limit rejects rather than dropping', () => {
  const q = mk()
  for (let i = 0; i < 3; i++) assert.equal(q.submit(ana, `@claude ${i}`).ok, true)
  const r = q.submit(ana, '@claude four')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'rate-limited')
})

test('the rate limit is per member, not per room', () => {
  const q = mk()
  for (let i = 0; i < 3; i++) q.submit(ana, `@claude ${i}`)
  assert.equal(q.submit({ id: 'b', name: 'bo', role: 'member' }, '@claude hi').ok, true)
})

test('a token budget rejects a member who is over it', () => {
  const ledger = new Ledger()
  ledger.record('p0', { input: 0, output: 900, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 }, [{ memberId: 'a', weight: 1 }], 'equal')
  const q = new Queue({ config: loadConfig({ ROOM_TOKENS_PER_MEMBER: '500' }), ledger, decisions: new Decisions(), now: () => 1000 })
  const r = q.submit(ana, '@claude more work')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'over-budget')
})

test('a turn drains every queued message at once — the batching contract', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  q.submit({ id: 'b', name: 'bo', role: 'member' }, '@claude two')
  const turn = q.beginTurn()
  assert.equal(turn.messages.length, 2)
  assert.equal(q.pending().length, 0)
  assert.deepEqual(turn.participants.map(p => p.memberId).sort(), ['a', 'b'])
})

test('only one turn runs at a time', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  assert.ok(q.beginTurn())
  assert.equal(q.busy(), true)
  q.submit(ana, '@claude two')
  assert.equal(q.beginTurn(), null)
  q.endTurn('p1')
  assert.equal(q.busy(), false)
  assert.equal(q.beginTurn().messages.length, 1)
})

test('beginTurn on an empty queue returns null', () => {
  assert.equal(mk().beginTurn(), null)
})

test('participants carry character weight for weighted attribution', () => {
  const q = mk()
  q.submit(ana, '@claude ' + 'x'.repeat(50))
  const turn = q.beginTurn()
  assert.ok(turn.participants[0].weight >= 50)
})

test('participants are recoverable by promptId after the turn ends', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  q.beginTurn()
  q.endTurn('p1')
  assert.deepEqual(q.participantsOf('p1').map(p => p.memberId), ['a'])
})

test('payer is the host by default and rotates when configured', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  assert.equal(q.beginTurn().payer, null)

  const rot = new Queue({ config: loadConfig({ ROOM_PAYER_MODE: 'rotate' }), ledger: new Ledger(), decisions: new Decisions(), now: () => 1 })
  rot.submit({ ...ana, payerRef: 'ana-cred' }, '@claude one')
  assert.equal(rot.beginTurn().payer, 'ana-cred')
})

test('rotation skips members with no credential rather than failing the turn', () => {
  const rot = new Queue({ config: loadConfig({ ROOM_PAYER_MODE: 'rotate' }), ledger: new Ledger(), decisions: new Decisions(), now: () => 1 })
  rot.submit(ana, '@claude one')
  assert.equal(rot.beginTurn().payer, null)
})

test('an addressed message that contradicts an open decision carries conflicts', () => {
  const decisions = new Decisions()
  decisions.add({ text: 'keep the auth service stateless', by: 'heet' })
  const q = new Queue({ config: loadConfig({}), ledger: new Ledger(), decisions, now: () => 1 })
  const r = q.submit(ana, '@claude add a cache layer to auth, it should not be stateless')
  assert.equal(r.conflicts.length, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/queue.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/queue.mjs
import { randomUUID } from 'node:crypto'
import { classify } from './router.mjs'

export class Queue {
  #pending = []
  #busy = false
  #inflight = null
  #byPrompt = new Map()
  #recent = new Map()   // memberId -> timestamps
  #rotation = 0

  constructor({ config, ledger, decisions, now = Date.now }) {
    this.config = config; this.ledger = ledger; this.decisions = decisions; this.now = now
  }

  #rateOk(memberId) {
    const { windowMs, messagesPerWindow } = this.config.budgets
    const t = this.now()
    const hits = (this.#recent.get(memberId) ?? []).filter(x => t - x < windowMs)
    this.#recent.set(memberId, hits)
    return hits.length < messagesPerWindow
  }

  #budgetOk(memberId) {
    const cap = this.config.budgets.tokensPerMember
    if (!cap) return true
    const u = this.ledger.totalsFor(memberId)
    return u.input + u.output + u.cacheRead + u.cacheCreate < cap
  }

  submit(member, text, opts = {}) {
    const c = classify(text, member, opts)
    const message = {
      id: randomUUID(), memberId: member.id, name: member.name, text: c.display,
      content: c.content, ts: this.now(), addressed: c.addressed, kind: 'chat',
      attachment: opts.attachment,
    }
    if (!c.addressed) return { ok: true, reason: c.reason, message, conflicts: [] }

    if (!this.#rateOk(member.id)) return { ok: false, reason: 'rate-limited', message: null, conflicts: [] }
    if (!this.#budgetOk(member.id)) return { ok: false, reason: 'over-budget', message: null, conflicts: [] }

    this.#recent.get(member.id).push(this.now())
    message.payerRef = member.payerRef ?? null
    this.#pending.push(message)
    const conflicts = this.decisions ? this.decisions.conflicts(c.display) : []
    return { ok: true, reason: 'queued', message, conflicts }
  }

  pending() { return [...this.#pending] }
  busy() { return this.#busy }

  selectPayer(messages) {
    if (this.config.payerMode !== 'rotate') return null
    const refs = [...new Set(messages.map(m => m.payerRef).filter(Boolean))]
    if (!refs.length) return null
    return refs[this.#rotation++ % refs.length]
  }

  beginTurn() {
    if (this.#busy || !this.#pending.length) return null
    const messages = this.#pending
    this.#pending = []
    this.#busy = true
    const weights = new Map()
    for (const m of messages) weights.set(m.memberId, (weights.get(m.memberId) ?? 0) + (m.text?.length ?? 0))
    const participants = [...weights].map(([memberId, weight]) => ({ memberId, weight }))
    this.#inflight = { messages, participants, payer: this.selectPayer(messages) }
    return this.#inflight
  }

  endTurn(promptId) {
    if (promptId && this.#inflight) this.#byPrompt.set(promptId, this.#inflight.participants)
    this.#busy = false
    this.#inflight = null
  }

  participantsOf(promptId) { return this.#byPrompt.get(promptId) ?? null }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/queue.test.mjs`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/queue.mjs test/queue.test.mjs
git commit -m "feat: queue with serialization, per-member limits, budgets and payer selection"
```

---

### Task 7: Persistence and replay

**Files:**
- Create: `src/state.mjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Consumes: `Config` (Task 1), `Registry` (Task 2), `Ledger` (Task 4), `Decisions` (Task 5)
- Produces: `class Store` with `constructor(dir)`, `load() -> { registry, ledger, decisions }`, `appendMessage(m)`, `recent(n) -> RoomMessage[]`, `saveRegistry(r)`, `saveLedger(l)`, `saveDecisions(d)`, `writePayer(ref)`, `readPayer() -> string|null`

- [ ] **Step 1: Write the failing test**

```js
// test/state.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/state.mjs'
import { Registry, createMember } from '../src/identity.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'

const fresh = () => mkdtempSync(join(tmpdir(), 'room-'))

test('loading an empty directory yields empty collections, not an error', () => {
  const dir = fresh()
  const { registry, ledger, decisions } = new Store(dir).load()
  assert.equal(registry.all().length, 0)
  assert.equal(ledger.turns().length, 0)
  assert.equal(decisions.open().length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('messages append and replay in order, newest last', () => {
  const dir = fresh(); const s = new Store(dir)
  s.appendMessage({ id: '1', text: 'one' })
  s.appendMessage({ id: '2', text: 'two' })
  assert.deepEqual(new Store(dir).recent(10).map(m => m.id), ['1', '2'])
  rmSync(dir, { recursive: true, force: true })
})

test('recent(n) returns only the tail', () => {
  const dir = fresh(); const s = new Store(dir)
  for (let i = 0; i < 10; i++) s.appendMessage({ id: String(i) })
  assert.deepEqual(s.recent(3).map(m => m.id), ['7', '8', '9'])
  rmSync(dir, { recursive: true, force: true })
})

test('a corrupt transcript line is skipped rather than crashing replay', () => {
  const dir = fresh(); const s = new Store(dir)
  s.appendMessage({ id: '1' })
  require('node:fs').appendFileSync(join(dir, 'transcript.jsonl'), '{broken\n')
  s.appendMessage({ id: '2' })
  assert.deepEqual(new Store(dir).recent(10).map(m => m.id), ['1', '2'])
  rmSync(dir, { recursive: true, force: true })
})

test('registry, ledger and decisions survive a restart', () => {
  const dir = fresh(); const s = new Store(dir)
  const r = new Registry(); const m = r.add(createMember({ name: 'ana', role: 'member' }))
  const l = new Ledger(); l.record('p1', { input: 1, output: 2, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 }, [{ memberId: m.id, weight: 1 }], 'equal')
  const d = new Decisions(); d.add({ text: 'keep auth stateless', by: 'ana' })
  s.saveRegistry(r); s.saveLedger(l); s.saveDecisions(d)

  const back = new Store(dir).load()
  assert.equal(back.registry.byToken(m.token).name, 'ana')
  assert.equal(back.ledger.totalsFor(m.id).output, 2)
  assert.equal(back.decisions.open().length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('the payer file round-trips and reads null when absent', () => {
  const dir = fresh(); const s = new Store(dir)
  assert.equal(s.readPayer(), null)
  s.writePayer('ana-cred')
  assert.equal(s.readPayer(), 'ana-cred')
  rmSync(dir, { recursive: true, force: true })
})
```

Replace the `require` in the corrupt-line test with an ESM import at the top:
`import { appendFileSync } from 'node:fs'` and call `appendFileSync(...)` directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/state.mjs
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Registry } from './identity.mjs'
import { Ledger } from './ledger.mjs'
import { Decisions } from './decisions.mjs'

export class Store {
  constructor(dir) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    this.paths = {
      members: join(dir, 'members.json'),
      transcript: join(dir, 'transcript.jsonl'),
      ledger: join(dir, 'ledger.json'),
      decisions: join(dir, 'decisions.json'),
      payer: join(dir, 'current-payer'),
    }
  }

  #readJSON(p, fallback) {
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
  }

  load() {
    return {
      registry: Registry.fromJSON(this.#readJSON(this.paths.members, [])),
      ledger: Ledger.fromJSON(this.#readJSON(this.paths.ledger, {})),
      decisions: Decisions.fromJSON(this.#readJSON(this.paths.decisions, [])),
    }
  }

  appendMessage(m) { appendFileSync(this.paths.transcript, JSON.stringify(m) + '\n') }

  recent(n = 200) {
    if (!existsSync(this.paths.transcript)) return []
    const out = []
    for (const line of readFileSync(this.paths.transcript, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* skip a torn line, keep replaying */ }
    }
    return out.slice(-n)
  }

  saveRegistry(r) { writeFileSync(this.paths.members, JSON.stringify(r.toJSON(), null, 2)) }
  saveLedger(l) { writeFileSync(this.paths.ledger, JSON.stringify(l.toJSON())) }
  saveDecisions(d) { writeFileSync(this.paths.decisions, JSON.stringify(d.toJSON(), null, 2)) }
  writePayer(ref) { writeFileSync(this.paths.payer, ref ?? '') }
  readPayer() {
    try { return readFileSync(this.paths.payer, 'utf8').trim() || null } catch { return null }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/state.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/state.mjs test/state.test.mjs
git commit -m "feat: durable room state with tolerant transcript replay"
```

---

### Task 8: The channel — MCP contract

**Files:**
- Create: `src/channel.mjs`
- Test: `test/channel.test.mjs`

**Interfaces:**
- Consumes: `Config` (Task 1), `Queue` (Task 6)
- Produces: `buildNotification(messages, roomName) -> { method, params:{ content, meta } }`; `META_KEY = /^[A-Za-z0-9_]+$/`; `sanitizeMeta(obj) -> obj`; `createChannel({ config, onReply, onEditRequest }) -> { mcp, notify(messages), sendVerdict(requestId, behavior), onPermissionRequest(cb) }`

- [ ] **Step 1: Write the failing test**

```js
// test/channel.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNotification, sanitizeMeta } from '../src/channel.mjs'

const msg = (over = {}) => ({ id: 'm1', memberId: 'a', name: 'ana', content: '@claude fix it', text: 'fix it', ts: 1, ...over })

test('meta keys with hyphens are dropped — Claude Code silently discards them', () => {
  const clean = sanitizeMeta({ chat_id: 'x', 'bad-key': 'y', ok2: 'z' })
  assert.deepEqual(Object.keys(clean).sort(), ['chat_id', 'ok2'])
})

test('meta values are coerced to strings', () => {
  assert.equal(sanitizeMeta({ n: 5 }).n, '5')
})

test('a single message keeps its content verbatim, mention and all', () => {
  const nt = buildNotification([msg()], 'room')
  assert.equal(nt.method, 'notifications/claude/channel')
  assert.equal(nt.params.content, '@claude fix it')
})

test('attribution rides in meta, never in content', () => {
  const nt = buildNotification([msg()], 'room')
  assert.equal(nt.params.meta.user, 'ana')
  assert.equal(nt.params.meta.member_id, 'a')
  assert.equal(nt.params.meta.room, 'room')
  assert.ok(!nt.params.content.includes('ana'))
})

test('a batch labels each speaker without altering anyone words', () => {
  const nt = buildNotification([msg(), msg({ id: 'm2', memberId: 'b', name: 'bo', content: 'and revert auth' })], 'room')
  assert.ok(nt.params.content.includes('ana'))
  assert.ok(nt.params.content.includes('bo'))
  assert.ok(nt.params.content.includes('@claude fix it'))
  assert.ok(nt.params.content.includes('and revert auth'))
  assert.equal(nt.params.meta.batch, '2')
})

test('an attachment path travels in meta so it cannot be forged in text', () => {
  const nt = buildNotification([msg({ attachment: { path: '/tmp/x.png', name: 'x.png' } })], 'room')
  assert.equal(nt.params.meta.file_path, '/tmp/x.png')
})

test('every produced meta key is a legal identifier', () => {
  const nt = buildNotification([msg({ attachment: { path: '/tmp/x', name: 'x' } })], 'room')
  for (const k of Object.keys(nt.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/)
})

test('an empty batch produces no notification', () => {
  assert.equal(buildNotification([], 'room'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/channel.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/channel.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const META_KEY = /^[A-Za-z0-9_]+$/

export function sanitizeMeta(meta) {
  const out = {}
  for (const [k, v] of Object.entries(meta)) {
    if (!META_KEY.test(k) || v == null) continue
    out[k] = String(v)
  }
  return out
}

export function buildNotification(messages, roomName) {
  if (!messages.length) return null
  const single = messages.length === 1
  // Batched turns need speaker labels, but each person's words stay byte-identical.
  const content = single
    ? messages[0].content
    : messages.map(m => `[${m.name}] ${m.content}`).join('\n')
  const first = messages[0]
  const meta = sanitizeMeta({
    room: roomName,
    user: single ? first.name : messages.map(m => m.name).join(','),
    member_id: single ? first.memberId : messages.map(m => m.memberId).join(','),
    msg_id: messages.map(m => m.id).join(','),
    batch: messages.length,
    ts: new Date().toISOString(),
    ...(first.attachment ? { file_path: first.attachment.path } : {}),
  })
  return { method: 'notifications/claude/channel', params: { content, meta } }
}

const INSTRUCTIONS = roomName => `You are the shared agent for the "${roomName}" room. Several people are talking to you at once.

Messages arrive as <channel source="room" user="NAME" member_id="..." msg_id="..." batch="N">. The user attribute names who wrote it; when batch is greater than 1, each line is prefixed with [name]. Treat every sender as a distinct human with their own intent.

Your transcript output does NOT reach the room. Anything you want the team to see must go through the room_reply tool. Room members see your tool calls as an activity feed, but not your reasoning or your prose.

When members give you contradictory instructions, say so and ask which one wins rather than silently picking. Use room_decision to record a decision the team has settled.`

export function createChannel({ config, onReply, onDecision }) {
  const mcp = new Server(
    { name: 'room', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          ...(config.permissionRelay ? { 'claude/channel/permission': {} } : {}),
        },
      },
      instructions: INSTRUCTIONS(config.roomName),
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'room_reply',
        description: 'Send a message to everyone in the room. This is the only way the team sees your words.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message to send to the room' },
            to: { type: 'string', description: 'Optional member name this reply answers' },
          },
          required: ['text'],
        },
      },
      {
        name: 'room_decision',
        description: 'Record a decision the team has settled, so later contradictory requests get flagged.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            by: { type: 'string' },
            supersedes: { type: 'string' },
          },
          required: ['text'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const a = req.params.arguments ?? {}
    try {
      if (req.params.name === 'room_reply') { onReply(String(a.text), a.to ? String(a.to) : null); return { content: [{ type: 'text', text: 'sent' }] } }
      if (req.params.name === 'room_decision') { const d = onDecision(String(a.text), a.by ? String(a.by) : 'claude', a.supersedes); return { content: [{ type: 'text', text: `recorded ${d.id}` }] } }
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true }
    }
  })

  let permissionCb = null
  if (config.permissionRelay) {
    // Registered lazily in Task 9 wiring via onPermissionRequest.
  }

  return {
    mcp,
    async connect() { await mcp.connect(new StdioServerTransport()) },
    notify(messages) {
      const nt = buildNotification(messages, config.roomName)
      if (nt) void mcp.notification(nt)
      return nt
    },
    sendVerdict(requestId, behavior) {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: requestId, behavior },
      })
    },
    onPermissionRequest(cb) { permissionCb = cb; return permissionCb },
    _permissionCb: () => permissionCb,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/channel.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/channel.mjs test/channel.test.mjs
git commit -m "feat: channel MCP server with verbatim content and identifier-safe meta"
```

---

### Task 9: Permission relay

**Files:**
- Modify: `src/channel.mjs` (register the notification handler)
- Create: `src/permissions.mjs`
- Test: `test/permissions.test.mjs`

**Interfaces:**
- Consumes: `mayApprove` (Task 2), `createChannel` (Task 8)
- Produces: `REQUEST_ID = /^[a-km-z]{5}$/`; `class PermissionBroker` with `open(req)`, `resolve(requestId, member, behavior) -> { ok, reason }`, `pending() -> Request[]`, `expire(ms)`

- [ ] **Step 1: Write the failing test**

```js
// test/permissions.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionBroker, REQUEST_ID } from '../src/permissions.mjs'

const owner = { id: 'o', name: 'heet', role: 'owner', canApprove: false }
const member = { id: 'm', name: 'ana', role: 'member', canApprove: false }
const approver = { id: 'p', name: 'bo', role: 'member', canApprove: true }
const req = { request_id: 'abcde', tool_name: 'Bash', description: 'Run shell command', input_preview: 'rm -rf /' }

test('the documented request id alphabet excludes the letter l', () => {
  assert.ok(REQUEST_ID.test('abcde'))
  assert.ok(!REQUEST_ID.test('ablde'))
  assert.ok(!REQUEST_ID.test('abcd'))
})

test('an approver resolves an open request', () => {
  const b = new PermissionBroker()
  b.open(req)
  const r = b.resolve('abcde', approver, 'allow')
  assert.equal(r.ok, true)
  assert.equal(b.pending().length, 0)
})

test('a non-approver is refused and the request stays open', () => {
  const b = new PermissionBroker()
  b.open(req)
  const r = b.resolve('abcde', member, 'allow')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-permitted')
  assert.equal(b.pending().length, 1)
})

test('an owner may always approve', () => {
  const b = new PermissionBroker()
  b.open(req)
  assert.equal(b.resolve('abcde', owner, 'deny').ok, true)
})

test('an unknown request id is dropped, matching Claude Code behaviour', () => {
  const b = new PermissionBroker()
  assert.deepEqual(b.resolve('zzzzz', owner, 'allow'), { ok: false, reason: 'unknown-request' })
})

test('a request cannot be resolved twice', () => {
  const b = new PermissionBroker()
  b.open(req)
  b.resolve('abcde', owner, 'allow')
  assert.equal(b.resolve('abcde', owner, 'deny').reason, 'unknown-request')
})

test('an invalid behaviour is rejected', () => {
  const b = new PermissionBroker()
  b.open(req)
  assert.equal(b.resolve('abcde', owner, 'maybe').reason, 'bad-behavior')
})

test('expired requests are swept', () => {
  let t = 0
  const b = new PermissionBroker({ now: () => t })
  b.open(req)
  t = 6 * 60 * 1000
  assert.equal(b.expire(5 * 60 * 1000).length, 1)
  assert.equal(b.pending().length, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/permissions.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

```js
// src/permissions.mjs
import { mayApprove } from './identity.mjs'

// Five lowercase letters, a-z without l, per the channels reference.
export const REQUEST_ID = /^[a-km-z]{5}$/
const BEHAVIORS = new Set(['allow', 'deny'])

export class PermissionBroker {
  #open = new Map()
  constructor({ now = Date.now } = {}) { this.now = now }

  open(req) {
    const entry = { ...req, openedAt: this.now() }
    this.#open.set(req.request_id, entry)
    return entry
  }

  resolve(requestId, member, behavior) {
    if (!this.#open.has(requestId)) return { ok: false, reason: 'unknown-request' }
    if (!mayApprove(member)) return { ok: false, reason: 'not-permitted' }
    if (!BEHAVIORS.has(behavior)) return { ok: false, reason: 'bad-behavior' }
    const entry = this.#open.get(requestId)
    this.#open.delete(requestId)
    return { ok: true, reason: 'resolved', entry, behavior }
  }

  pending() { return [...this.#open.values()] }

  expire(maxAgeMs) {
    const t = this.now(); const gone = []
    for (const [id, e] of this.#open) if (t - e.openedAt > maxAgeMs) { gone.push(e); this.#open.delete(id) }
    return gone
  }
}
```

In `src/channel.mjs`, register the inbound handler when relay is on. Add at the top:

```js
import { z } from 'zod'
```

The dependency allowlist forbids `zod`, so instead build the schema shape the SDK expects
with a hand-rolled object exposing `parse` and a `method` literal. Replace the placeholder
comment inside `createChannel` with:

```js
  if (config.permissionRelay) {
    const schema = {
      parse: v => v,
      _def: { typeName: 'ZodObject' },
      shape: { method: { value: 'notifications/claude/channel/permission_request' } },
      method: 'notifications/claude/channel/permission_request',
    }
    mcp.setNotificationHandler(schema, async note => { permissionCb?.(note.params) })
  }
```

If `setNotificationHandler` rejects the hand-rolled schema at runtime, fall back to
`mcp.fallbackNotificationHandler = async note => { if (note.method === 'notifications/claude/channel/permission_request') permissionCb?.(note.params) }`,
which is part of the MCP SDK Protocol class and needs no schema object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/permissions.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/permissions.mjs src/channel.mjs test/permissions.test.mjs
git commit -m "feat: permission relay broker with approver gating and request-id matching"
```

---

### Task 10: HTTP server, SSE bus, hook ingest, attachments

**Files:**
- Create: `src/bus.mjs`, `src/web.mjs`
- Test: `test/web.test.mjs`

**Interfaces:**
- Consumes: every previous module
- Produces: `class Bus` with `subscribe(res)`, `publish(event, data)`, `count()`; `createWeb(deps) -> http.Server` serving `GET /` (UI), `GET /events` (SSE), `POST /msg`, `POST /upload`, `POST /verdict`, `POST /hook/:event`, `GET /api/state`

- [ ] **Step 1: Write the failing test**

```js
// test/web.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWeb } from '../src/web.mjs'
import { loadConfig } from '../src/config.mjs'
import { Store } from '../src/state.mjs'
import { Registry, createMember } from '../src/identity.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'
import { Queue } from '../src/queue.mjs'
import { Bus } from '../src/bus.mjs'
import { PermissionBroker } from '../src/permissions.mjs'

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'roomweb-'))
  const config = loadConfig({ ROOM_STATE_DIR: dir, ROOM_PORT: '0' })
  const registry = new Registry()
  const owner = registry.add(createMember({ name: 'heet', role: 'owner' }))
  const ledger = new Ledger(); const decisions = new Decisions()
  const queue = new Queue({ config, ledger, decisions })
  const sent = []
  const server = createWeb({
    config, registry, ledger, decisions, queue, store: new Store(dir), bus: new Bus(),
    permissions: new PermissionBroker(),
    channel: { notify: m => sent.push(m), sendVerdict: () => {} },
  })
  return { dir, server, owner, sent, queue, ledger, config }
}

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))

test('POST /msg without a valid token is refused', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(`${base}/msg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope', text: 'hi' }) })
  assert.equal(res.status, 401)
  h.server.close(); rmSync(h.dir, { recursive: true, force: true })
})

test('chatter is accepted and never notified to the channel', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(`${base}/msg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.owner.token, text: 'morning' }) })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).addressed, false)
  assert.equal(h.sent.length, 0)
  h.server.close(); rmSync(h.dir, { recursive: true, force: true })
})

test('an addressed message reaches the channel exactly once', async () => {
  const h = harness(); const base = await listen(h.server)
  await fetch(`${base}/msg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.owner.token, text: '@claude go' }) })
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0][0].content, '@claude go')
  h.server.close(); rmSync(h.dir, { recursive: true, force: true })
})

test('a Stop hook records usage against the turn participants', async () => {
  const h = harness(); const base = await listen(h.server)
  await fetch(`${base}/msg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.owner.token, text: '@claude go' }) })

  const tp = join(h.dir, 'fake-transcript.jsonl')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } }) + '\n')

  await fetch(`${base}/hook/Stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Stop', prompt_id: 'p1', transcript_path: tp }) })
  assert.equal(h.ledger.totalsFor(h.owner.id).output, 40)
  assert.equal(h.queue.busy(), false)
  h.server.close(); rmSync(h.dir, { recursive: true, force: true })
})

test('hook ingest always answers 200 so a hook never blocks a turn', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(`${base}/hook/PostToolUse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all' })
  assert.equal(res.status, 200)
  h.server.close(); rmSync(h.dir, { recursive: true, force: true })
})

test('GET /api/state returns members, ledger totals and recent messages', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(`${base}/api/state?token=${h.owner.token}`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.you.name, 'heet')
  assert.ok(Array.isArray(body.members))
  assert.ok(Array.isArray(body.messages))
  h.server.close(); rmSync(h.dir, { recursive: true, force: true })
})

test('the SSE endpoint sets the event-stream content type', async () => {
  const h = harness(); const base = await listen(h.server)
  const ctrl = new AbortController()
  const res = await fetch(`${base}/events?token=${h.owner.token}`, { signal: ctrl.signal })
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  ctrl.abort()
  h.server.close(); rmSync(h.dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web.test.mjs`
Expected: FAIL, cannot find module `../src/bus.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
// src/bus.mjs
export class Bus {
  #subs = new Set()
  subscribe(res) {
    this.#subs.add(res)
    res.on('close', () => this.#subs.delete(res))
    return () => this.#subs.delete(res)
  }
  publish(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.#subs) { try { res.write(frame) } catch { this.#subs.delete(res) } }
  }
  count() { return this.#subs.size }
}
```

```js
// src/web.mjs
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseUsageLine, sumUsage, cacheRatio } from './ledger.mjs'
import { mayApprove } from './identity.mjs'
import { renderUI } from './ui.mjs'

const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

const readBody = req => new Promise(resolve => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', () => resolve(Buffer.alloc(0)))
})

export function createWeb(deps) {
  const { config, registry, ledger, decisions, queue, store, bus, channel, permissions } = deps
  const uploadDir = join(config.stateDir, 'uploads')
  mkdirSync(uploadDir, { recursive: true })

  const memberFrom = (req, url, body) =>
    registry.byToken(body?.token ?? url.searchParams.get('token') ?? req.headers['x-room-token'])

  function drain() {
    const turn = queue.beginTurn()
    if (!turn) return
    if (config.payerMode === 'rotate') store.writePayer(turn.payer)
    channel.notify(turn.messages)
    bus.publish('turn', { started: true, participants: turn.participants })
  }

  function broadcastMessage(m) {
    store.appendMessage(m)
    bus.publish('message', m)
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    try {
      if (req.method === 'GET' && path === '/') {
        const html = renderUI(config)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(html)
      }

      if (req.method === 'GET' && path === '/events') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': connected\n\n')
        bus.subscribe(res)
        bus.publish('presence', { members: registry.all().map(m => ({ id: m.id, name: m.name, role: m.role })), listeners: bus.count() })
        return
      }

      if (req.method === 'GET' && path === '/api/state') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        return json(res, 200, {
          you: { id: member.id, name: member.name, role: member.role, canApprove: mayApprove(member) },
          room: config.roomName,
          members: registry.all().map(m => ({ id: m.id, name: m.name, role: m.role })),
          messages: store.recent(200),
          ledger: Object.fromEntries(registry.all().map(m => [m.id, ledger.totalsFor(m.id)])),
          decisions: decisions.open(),
          pending: queue.pending().length,
          busy: queue.busy(),
          pendingApprovals: mayApprove(member) ? permissions.pending() : [],
        })
      }

      if (req.method === 'POST' && path === '/msg') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const member = memberFrom(req, url, body)
        if (!member) return json(res, 401, { error: 'bad token' })
        const r = queue.submit(member, String(body.text ?? ''), { force: body.force === true })
        if (!r.ok) { bus.publish('rejected', { memberId: member.id, reason: r.reason }); return json(res, 429, { ok: false, reason: r.reason }) }
        broadcastMessage(r.message)
        if (r.conflicts.length) bus.publish('conflicts', { msgId: r.message.id, conflicts: r.conflicts })
        if (r.message.addressed) drain()
        return json(res, 200, { ok: true, addressed: r.message.addressed, reason: r.reason, conflicts: r.conflicts })
      }

      if (req.method === 'POST' && path === '/upload') {
        const buf = await readBody(req)
        const name = String(url.searchParams.get('name') ?? 'upload.bin')
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        const safe = `${Date.now()}-${randomUUID().slice(0, 8)}${extname(name).slice(0, 12)}`
        const dest = join(uploadDir, safe)
        writeFileSync(dest, buf)
        const r = queue.submit(member, String(url.searchParams.get('text') ?? ''), { force: true, attachment: { path: dest, name } })
        if (r.message) broadcastMessage(r.message)
        if (r.message?.addressed) drain()
        return json(res, 200, { ok: true, path: dest })
      }

      if (req.method === 'POST' && path === '/verdict') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const member = memberFrom(req, url, body)
        if (!member) return json(res, 401, { error: 'bad token' })
        const r = permissions.resolve(String(body.request_id), member, String(body.behavior))
        if (r.ok) { channel.sendVerdict(body.request_id, body.behavior); bus.publish('approval', { request_id: body.request_id, behavior: body.behavior, by: member.name }) }
        return json(res, r.ok ? 200 : 403, r)
      }

      if (req.method === 'POST' && path.startsWith('/hook/')) {
        // Fire and forget: always 200 so a hook can never stall a turn.
        const event = path.slice('/hook/'.length)
        let payload = {}
        try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}') } catch { payload = {} }
        try { handleHook(event, payload) } catch { /* the feed may degrade; the room must not */ }
        return json(res, 200, { ok: true })
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) })
    }
  })

  function handleHook(event, p) {
    if (event === 'PreToolUse') {
      bus.publish('activity', { kind: 'tool-start', tool: p.tool_name, input: p.tool_input, ts: Date.now() })
    } else if (event === 'PostToolUse') {
      bus.publish('activity', { kind: 'tool-end', tool: p.tool_name, ts: Date.now() })
    } else if (event === 'Notification') {
      bus.publish('activity', { kind: 'notification', type: p.notification_type, ts: Date.now() })
    } else if (event === 'SessionStart') {
      bus.publish('activity', { kind: 'session-start', ts: Date.now() })
    } else if (event === 'Stop') {
      const participants = queue.participantsOf(p.prompt_id) ?? currentParticipants()
      const usage = usageFromTranscript(p.transcript_path)
      if (usage) {
        ledger.record(p.prompt_id, usage, participants, config.splitMode)
        store.saveLedger(ledger)
        bus.publish('cost', {
          promptId: p.prompt_id, ratio: cacheRatio(usage),
          totals: Object.fromEntries(registry.all().map(m => [m.id, ledger.totalsFor(m.id)])),
        })
      }
      queue.endTurn(p.prompt_id)
      bus.publish('turn', { started: false })
      drain()
    }
  }

  function currentParticipants() {
    const t = queue.participantsOf('__inflight__')
    return t ?? []
  }

  function usageFromTranscript(path) {
    if (!path) return null
    let text
    try { text = readFileSync(path, 'utf8') } catch { return null }
    const lines = text.split('\n')
    const usages = []
    // Walk backwards to the previous user turn so only this turn's requests count.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.type === 'user') break
      const u = parseUsageLine(line)
      if (u) usages.push(u)
    }
    return usages.length ? sumUsage(usages) : null
  }
}
```

Note: `queue.beginTurn()` must record its participants under the in-flight key so `Stop`
can find them when `prompt_id` was not seen at submit time. Add to `Queue.beginTurn` before
returning: `this.#byPrompt.set('__inflight__', participants)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/bus.mjs src/web.mjs src/queue.mjs test/web.test.mjs
git commit -m "feat: HTTP/SSE room server with hook ingest, uploads and cost recording"
```

---

### Task 11: Browser UI

**Files:**
- Create: `src/ui.mjs`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `Config` (Task 1)
- Produces: `renderUI(config) -> string` (a complete self-contained HTML document)

- [ ] **Step 1: Write the failing test**

```js
// test/ui.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderUI } from '../src/ui.mjs'
import { loadConfig } from '../src/config.mjs'

test('renders a complete standalone document naming the room', () => {
  const html = renderUI(loadConfig({ ROOM_NAME: 'auth-work' }))
  assert.match(html, /<!doctype html>/i)
  assert.ok(html.includes('auth-work'))
})

test('pulls in no external resources — the room must work offline on a tailnet', () => {
  const html = renderUI(loadConfig({}))
  assert.ok(!/src=["']https?:/i.test(html))
  assert.ok(!/href=["']https?:/i.test(html))
})

test('a room name containing markup cannot break out of the document', () => {
  const html = renderUI(loadConfig({ ROOM_NAME: '</script><img onerror=alert(1)>' }))
  assert.ok(!html.includes('<img onerror'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Write minimal implementation**

Create `src/ui.mjs` exporting `renderUI(config)`. It returns one HTML string containing:

- an escape helper applied to every interpolated config value (`&`, `<`, `>`, `"`, `'`)
- a token gate: read `?token=` from the URL or `localStorage`, store it, call `/api/state`
- three panes: room transcript, activity feed, cost table
- a composer with a "send to Claude" toggle that posts `{ token, text, force }` to `/msg`
- an `EventSource('/events?token=...')` subscribing to `message`, `activity`, `cost`,
  `presence`, `turn`, `conflicts`, `rejected`, and `approval`
- an approvals panel, rendered only when `state.you.canApprove`, posting to `/verdict`
- `textContent` for all server-supplied strings — never `innerHTML` — because message text,
  member names, and `input_preview` are untrusted
- an offline banner shown when the `EventSource` errors, with automatic retry

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui.mjs test/ui.test.mjs
git commit -m "feat: self-contained browser UI with transcript, activity feed and cost panel"
```

---

### Task 12: Entrypoint, payer helper, plugin packaging, docs

**Files:**
- Create: `src/server.mjs`, `scripts/room-payer.mjs`, `scripts/room-admin.mjs`, `.mcp.json`, `.claude-plugin/plugin.json`, `settings.room.json`, `README.md`
- Test: `test/server.smoke.test.mjs`

**Interfaces:**
- Consumes: everything
- Produces: a runnable `node src/server.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/server.smoke.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the server boots, serves the UI, and writes nothing to stdout but MCP traffic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roomsmoke-'))
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, ROOM_STATE_DIR: dir, ROOM_PORT: '8799', ROOM_HOST: '127.0.0.1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', d => { stdout += d })
  await new Promise(r => setTimeout(r, 1200))

  const res = await fetch('http://127.0.0.1:8799/')
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<!doctype html>/i)

  // Any non-JSON-RPC byte on stdout corrupts the MCP transport.
  const stray = stdout.split('\n').filter(l => l.trim() && !l.trimStart().startsWith('{'))
  assert.deepEqual(stray, [])

  child.kill()
  rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.smoke.test.mjs`
Expected: FAIL, cannot find `src/server.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
// src/server.mjs
import { loadConfig } from './config.mjs'
import { Store } from './state.mjs'
import { Queue } from './queue.mjs'
import { Bus } from './bus.mjs'
import { createChannel } from './channel.mjs'
import { createWeb } from './web.mjs'
import { PermissionBroker } from './permissions.mjs'
import { createMember } from './identity.mjs'
import { randomUUID } from 'node:crypto'

const config = loadConfig(process.env)
const store = new Store(config.stateDir)
const { registry, ledger, decisions } = store.load()

// Bootstrap an owner on first run so the room is reachable at all.
if (!registry.all().length) {
  const owner = registry.add(createMember({ name: process.env.ROOM_OWNER || 'owner', role: 'owner' }))
  store.saveRegistry(registry)
  process.stderr.write(`room: owner join URL http://${config.host}:${config.port}/?token=${owner.token}\n`)
}

const bus = new Bus()
const permissions = new PermissionBroker()
const queue = new Queue({ config, ledger, decisions })

const channel = createChannel({
  config,
  onReply(text, to) {
    const m = { id: randomUUID(), memberId: 'claude', name: 'claude', text, ts: Date.now(), addressed: false, kind: 'reply', to }
    store.appendMessage(m)
    bus.publish('message', m)
  },
  onDecision(text, by, supersedes) {
    const d = decisions.add({ text, by, supersedes })
    store.saveDecisions(decisions)
    bus.publish('decision', d)
    return d
  },
})

if (config.permissionRelay) {
  channel.onPermissionRequest(params => {
    permissions.open(params)
    bus.publish('approval-request', params)
  })
}

const web = createWeb({ config, registry, ledger, decisions, queue, store, bus, channel, permissions })
web.listen(config.port, config.host, () => {
  process.stderr.write(`room: http://${config.host}:${config.port}\n`)
})

await channel.connect()
```

```js
// scripts/room-payer.mjs
// apiKeyHelper target. Prints the credential for the member paying for this turn.
// Fetches on demand over Tailscale so teammates' tokens are never stored on the host.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.ROOM_STATE_DIR || join(homedir(), '.claude', 'channels', 'room')
const read = p => { try { return readFileSync(p, 'utf8').trim() } catch { return '' } }

const payerRef = read(join(dir, 'current-payer'))
const fallback = process.env.ROOM_HOST_CREDENTIAL || ''

if (!payerRef) { process.stdout.write(fallback); process.exit(0) }

// payerRef is a URL on the teammate's own machine, e.g. http://ana-laptop:8790/credential
try {
  const res = await fetch(payerRef, { headers: { 'x-room-auth': process.env.ROOM_PAYER_SECRET ?? '' } })
  process.stdout.write(res.ok ? (await res.text()).trim() : fallback)
} catch {
  process.stdout.write(fallback)
}
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "room": { "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/src/server.mjs"] }
  }
}
```

`settings.room.json` (pass with `--settings`, or merge into `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/SessionStart", "timeout": 5 }] }],
    "PreToolUse": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/PreToolUse", "timeout": 5 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/PostToolUse", "timeout": 5 }] }],
    "Notification": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/Notification", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8787/hook/Stop", "timeout": 10 }] }]
  }
}
```

`.claude-plugin/plugin.json`:

```json
{
  "name": "claude-room",
  "description": "Multiplayer Claude Code — several humans drive one shared session from their browsers over Tailscale, with per-member cost attribution.",
  "version": "0.1.0",
  "keywords": ["channel", "mcp", "multiplayer", "room", "collaboration"]
}
```

`scripts/room-admin.mjs` adds and revokes members against the on-disk registry and prints
join URLs. `README.md` documents: prerequisites (Node 22, Tailscale, `channelsEnabled` for
Team orgs), the launch command
`claude --dangerously-load-development-channels server:room --settings ./settings.room.json`,
how to add members, the roles table, and the §8 rotation spike procedure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, all suites

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs scripts/ .mcp.json .claude-plugin/ settings.room.json README.md test/server.smoke.test.mjs
git commit -m "feat: entrypoint, payer helper, plugin packaging and operator docs"
```

---

## Self-Review

**Spec coverage.** §4 architecture → Tasks 10, 12. §4 module table → Tasks 1–11 one-to-one.
§5 lifecycle → Tasks 3, 6, 8, 10. §5 addressing → Task 3. §6 ledger → Task 4. §6 budgets →
Task 6. §6 payer rotation → Tasks 6, 12. §7 roles → Task 2. §7 relay → Task 9. §7 threat
model → Tasks 2 (constant-time tokens), 8 (meta sanitising), 10 (auth on every route),
11 (`textContent` only). §8 spike → the cache ratio recorded in Task 4 and surfaced in
Task 10. §9 persistence → Task 7. §9 failure modes → Tasks 7, 10, 11. §10 testing → every
task. §11 attachments → Task 10.

**Placeholder scan.** No TBDs. Task 11 describes the UI as a bulleted contract rather than
a full HTML listing; that is a deliberate exception for a large presentational artifact
whose behaviour is pinned by three tests and an explicit element list.

**Type consistency.** `Usage` uses `{input, output, cacheRead, cacheCreate, cache1h,
cache5m}` in Tasks 1, 4, 6, 10. `participants` is `[{memberId, weight}]` in Tasks 4, 6, 10.
`classify` returns `{addressed, content, display, reason}` in Tasks 3 and 6. `submit`
returns `{ok, reason, message, conflicts}` in Tasks 6 and 10.

**Known adjustment.** Task 10 requires a one-line addition to `Queue.beginTurn` from Task 6
(recording in-flight participants). It is called out in Task 10 and the commit includes
`src/queue.mjs`.
