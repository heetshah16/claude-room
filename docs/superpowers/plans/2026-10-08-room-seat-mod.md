# room-seat mod: production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code agent seats join a room through a Claude Code mod instead of `--dangerously-load-development-channels`, installable from a marketplace, usable from a terminal and from Anthropic's VS Code panel.

**Architecture:** A mod (`mod/`, plugin `room-seat`) runs inside the seat's Claude Code session. It spawns `mod/feed.mjs`, a Node child that holds the room's existing `/seat/events` SSE feed and prints one JSON line per prompt or status change; the mod turns prompt lines into turns with `$.prompt.submit`, serves `room_reply` as a registered tool, and forwards the seat's own hook events to `/seat/hook/*` only while a room turn is running. The room needs no change: a seat is still online exactly while one connection holds its feed.

**Tech Stack:** Node 22+ ESM (room, feed), Claude Code mods API (hooks module, v2.1.287+), `node:test` (room suite), `claude plugin test` (mod suite).

**Spec:** No separate spec. The design was settled in conversation on 2026-10-08 and proven by the proof-of-concept now in `mod/` (verified against real `claude` 2.1.287 headless and interactive; see the "Design record" below). This plan carries the decisions and the evidence for each.

## Design record (in place of a spec)

| Decision | Evidence |
|---|---|
| Mod, not channel | Mods are on by default from v2.1.287, need no allowlist or flag; PoC ran a full turn with no flag |
| Feed in a child process, not long-poll | `$.http.fetch` reads the whole body (types: "resolves … once the body is read"); seat liveness is one open connection (`seats.join(member, res)`, `web.mjs:634`), so a child holding `/seat/events` needs zero room changes |
| Child dies with the session | Hard-killing `claude.exe` in the PoC took `feed.mjs` down too; seat offline in under 2.5 s |
| Settings via `userConfig` + explicit `/room-join` | `register(on, options)` receives `userConfig` values, sensitive ones included (types: `PluginOptions`). User-scope config applies to every session, so auto-joining from it would make every session claim one handle and all but one get `409 handle-taken` |
| Env vars still auto-join | `scripts/room-seat.mjs` launches a session whose only job is to be the seat |
| Forward hooks only during a room turn | A `/room-join` session is also the owner's own session: their own `Stop` would close the room's turn early and their tool calls would leak into the room's activity feed |
| Forwarding never blocks | `HttpInit` has no timeout or signal; awaiting a post to an unreachable room would stall every tool call |
| Shared protocol code lives in `mod/lib/` | A marketplace install copies `mod/` alone, without `node_modules`; `src/seat.mjs` etc. import the MCP SDK. The room imports `mod/lib/protocol.mjs` so there is still one copy |
| Mod tests are `*.test.tsx` | Node 24's `node --test` runs `*.test.ts` (verified) and would fail on `claude-code/testing`; it ignores `.test.tsx` (verified); `claude plugin test` runs both |
| Marketplace name `claude-room` | `claude plugin validate` passes it (verified) |

## Global Constraints

- Claude Code **v2.1.287 or later** for any seat (mods are off below it).
- **Node.js 22 or later on PATH** on the seat's machine (`feed.mjs` runs under `node`).
- Plugin name `room-seat`; its tool is `mcp__room-seat__room_reply`; marketplace name `claude-room`.
- Every import in `mod/` resolves inside `mod/`. Allowed bare specifiers: `node:*` (in `feed.mjs`), `claude-code` (in the hooks module).
- Mod test files end in `.test.tsx`, never `.test.ts`.
- The seat token never appears on argv (it travels in the child's `env` or in `userConfig`).
- `feed.mjs` stdout carries only the line protocol; every log goes to stderr.
- Never submit room text with `asUser: true`: Claude must always see it as coming from the plugin.
- The room's two test suites stay green: `node --test` at the root, and `node --test` in `extension/`.

## Review Focus

1. **The owner's own turn ends while a room turn is queued behind it.** The room's turn must stay open until the room turn itself ends. Test: Task 3, "the owner's own turn never reaches the room".
2. **A second session joins with a handle that is already online.** The feed must stop with a visible reason, not retry forever. Tests: Task 2, "a handle already online elsewhere stops the feed"; Task 3, "a fatal feed status shows in /room-status and the feed is not restarted".
3. **The room is unreachable while a room turn is running.** Tool calls must not stall on the hook forward. Test: Task 3, "a hook that cannot reach the room does not hold the session".
4. **The owner presses Esc during a room turn.** The room must not stay busy forever, and the room must see why there was no answer. Test: Task 3, "a room turn the owner interrupts is closed with a visible reason".
5. **`node` is missing, or Claude Code is too old.** The seat must say so instead of silently never joining. Tests: Task 3, "a feed that cannot start says the seat needs Node.js"; Task 4, `meetsModFloor` cases.

---

### Task 0: Branch

- [ ] **Step 1: Move the uncommitted proof-of-concept onto its own branch**

`orchestrator-parity` carries open PR #2; this work must not land on it.

```bash
git switch -c room-seat-mod
git status --short
```

Expected: `M src/opencode.mjs`, `?? mod/`, `?? test/mod-feed.test.mjs` (plus the pre-existing, unrelated `?? videos/`, which is never staged by this plan).

---

### Task 1: Self-contained protocol module

**Files:**
- Create: `mod/lib/protocol.mjs`
- Modify: `src/seat.mjs:77-111` (remove `readFrames`, import and re-export it)
- Modify: `src/opencode.mjs:37-85` and `:147-158` (remove `LABEL`, `PendingContext`, `REPLY_DIRECTIVE`; import and re-export)
- Modify: `src/channel.mjs:41-62` (`buildNotification` built on `turnFields`)
- Modify: `mod/feed.mjs` (imports only `./lib/protocol.mjs`)
- Test: `test/mod-boundary.test.mjs` (new); existing `test/channel.test.mjs`, `test/opencode*.test.mjs`, `test/seat*.test.mjs`, `test/mod-feed.test.mjs` must stay green

**Interfaces:**
- Produces (from `mod/lib/protocol.mjs`):
  - `readFrames(body: ReadableStream, onFrame: (event: string|null, data: string) => void): Promise<void>`
  - `class PendingContext { constructor(max = 20); add(kind, text, from?); drain(): { text: string, dropped: number } }`
  - `REPLY_DIRECTIVE: string`
  - `turnFields(messages): null | { content: string, user: string, memberId: string, msgId: string, batch: number, attachments: string[] }`
- `src/seat.mjs` still exports `readFrames`; `src/opencode.mjs` still exports `PendingContext` and `REPLY_DIRECTIVE` (re-exports), so no other importer changes.

- [ ] **Step 1: Write the failing boundary test**

```js
// test/mod-boundary.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOD = fileURLToPath(new URL('../mod/', import.meta.url))

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.claude-plugin' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(m?js|tsx?)$/.test(entry.name)) yield path
  }
}

const SPECIFIER = /^\s*(?:import|export)\b[^'"]*?['"]([^'"]+)['"]/gm

test('every import in the room-seat plugin resolves inside mod/, so a marketplace install of mod/ alone still runs', () => {
  for (const file of sources(MOD)) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (spec.startsWith('node:') || spec === 'claude-code' || spec === 'claude-code/testing') continue
      assert.ok(spec.startsWith('.'), `${relative(MOD, file)}: bare import "${spec}" - an installed plugin has no node_modules`)
      const target = resolve(dirname(file), spec)
      assert.ok(!relative(MOD, target).startsWith('..'), `${relative(MOD, file)}: "${spec}" leaves mod/`)
    }
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mod-boundary.test.mjs`
Expected: FAIL, `feed.mjs: "../src/seat.mjs" leaves mod/`

- [ ] **Step 3: Create `mod/lib/protocol.mjs`**

Move `readFrames` (from `src/seat.mjs`, with its doc comment), `LABEL` + `PendingContext` + `REPLY_DIRECTIVE` (from `src/opencode.mjs`, with their doc comments) verbatim, and add `turnFields`:

```js
// The room's seat protocol, the parts that are plain JavaScript: reading an
// SSE stream, rendering a turn, holding context until the next real turn.
//
// It lives inside mod/ because a marketplace install of the room-seat plugin
// copies mod/ and nothing else, without node_modules. The room imports it
// from here too, so there is still exactly one copy - this repo has been
// bitten more than once by a hand-maintained second copy drifting from the
// first. Keep it dependency-free: test/mod-boundary.test.mjs enforces that.

/**
 * Reads Server-Sent Events by hand off a fetch Response's streaming body.
 * (doc comment moved verbatim from src/seat.mjs)
 */
export async function readFrames(body, onFrame) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = null
      let data = null
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length)
        else if (line.startsWith('data: ')) data = line.slice('data: '.length)
      }
      if (data !== null) onFrame(event, data)
    }
  }
}

const LABEL = { mirror: 'mirror', brief: 'brief', seed: 'seed' }

/**
 * Room events that are NOT a request — mirrors, briefs, the join seed.
 * (doc comment moved verbatim from src/opencode.mjs)
 */
export class PendingContext {
  #max
  #items = []
  #dropped = 0

  constructor(max = 20) {
    this.#max = Math.max(1, Number(max) || 20)
  }

  add(kind, text, from) {
    if (!text || !String(text).trim()) return
    const label = LABEL[kind] ?? 'context'
    this.#items.push(from ? `[${label} from @${from}] ${text}` : `[${label}] ${text}`)
    while (this.#items.length > this.#max) {
      this.#items.shift()
      this.#dropped++
    }
  }

  drain() {
    if (!this.#items.length && !this.#dropped) return { text: '', dropped: 0 }
    const dropped = this.#dropped
    const lines = [...this.#items]
    if (dropped) lines.unshift(`(${dropped} earlier room events dropped)`)
    this.#items = []
    this.#dropped = 0
    return {
      dropped,
      text: [
        '--- room context: background only, never a request ---',
        ...lines,
        '--- end room context ---',
      ].join('\n'),
    }
  }
}

/**
 * A seat that is not a Claude Code channel has no MCP `instructions` to carry
 * the one rule that matters, so it rides in the prompt body instead.
 * (doc comment moved verbatim from src/opencode.mjs)
 */
export const REPLY_DIRECTIVE = [
  '---',
  'When you have finished, you MUST call the room_reply tool to report what you did.',
  'Your normal output does NOT reach the room — room_reply is the only channel to it.',
  'A turn that ends without calling room_reply looks like silence to the people waiting.',
].join('\n')

/**
 * The parts of a drained turn every harness renders: everyone's words
 * verbatim, and who said them, kept apart so the words are never rewritten.
 * Null for an empty turn.
 */
export function turnFields(messages) {
  if (!messages?.length) return null
  return {
    content: messages.length === 1
      ? messages[0].content
      : messages.map(m => `[${m.name}] ${m.content}`).join('\n'),
    user: messages.map(m => m.name).join(','),
    memberId: messages.map(m => m.memberId).join(','),
    msgId: messages.map(m => m.id).join(','),
    batch: messages.length,
    // Every attachment in the batch, not just the first message's.
    attachments: messages.map(m => m.attachment?.path).filter(Boolean),
  }
}
```

- [ ] **Step 4: Point the room at it**

`src/seat.mjs`: delete the `readFrames` function and its doc comment (lines 77-111) and add, below the existing imports:

```js
import { readFrames } from '../mod/lib/protocol.mjs'
export { readFrames }
```

`src/opencode.mjs`: delete `const LABEL`, the `PendingContext` class and its doc comment (lines 37-85), and the `REPLY_DIRECTIVE` block and its doc comment (lines 147-158); add, below the existing imports:

```js
import { PendingContext, REPLY_DIRECTIVE } from '../mod/lib/protocol.mjs'
export { PendingContext, REPLY_DIRECTIVE }
```

`src/channel.mjs`: add `import { turnFields } from '../mod/lib/protocol.mjs'` and replace the body of `buildNotification` (keep its doc comment):

```js
export function buildNotification(messages, roomName) {
  const t = turnFields(messages)
  if (!t) return null
  return channelEvent(t.content, {
    room: roomName,
    user: t.user,
    member_id: t.memberId,
    msg_id: t.msgId,
    batch: t.batch,
    ts: new Date().toISOString(),
    // Every attachment in the batch, not just the first message's. Reading
    // only messages[0] silently dropped a file whenever someone else uploaded
    // while the agent was busy — the batch is exactly when that happens.
    ...(t.attachments.length ? { file_path: t.attachments.join(',') } : {}),
  })
}
```

`mod/feed.mjs`: replace its three `../src` imports and the ponytail comment above them with

```js
import { readFrames, PendingContext, REPLY_DIRECTIVE, turnFields } from './lib/protocol.mjs'
```

and in `createPrompter` replace the `buildNotification` lines with

```js
    const t = turnFields(data.messages)
    if (!t) return null
    const where = data.room ? ` in room "${data.room}"` : ''
    const header = `${t.user} addressed you (${seat})${where}:`
    const attached = t.attachments.length ? `(attached: ${t.attachments.join(', ')})` : ''
    const body = [header, t.content, attached].filter(Boolean).join('\n')
```

- [ ] **Step 5: Run everything that touches the moved code**

Run: `node --test test/mod-boundary.test.mjs test/mod-feed.test.mjs test/channel.test.mjs test/seat.test.mjs test/opencode.test.mjs test/opencode-driver.test.mjs test/hardening.test.mjs`
Expected: all pass. Then the full root suite: `node --test` → `fail 0`, test count = 914 + 1.

- [ ] **Step 6: Commit**

```bash
git add mod/lib/protocol.mjs mod/feed.mjs src/seat.mjs src/opencode.mjs src/channel.mjs test/mod-boundary.test.mjs
git commit -m "refactor: move the seat protocol's plain-JS pieces into mod/lib so the room-seat plugin is self-contained"
```

---

### Task 2: Feed process: line protocol, fatal vs retry

**Files:**
- Modify: `mod/feed.mjs` (`main`, new exported `refusal`)
- Test: `test/mod-feed-process.test.mjs` (new; spawns the real `feed.mjs` against an in-process fake room)

**Interfaces:**
- Consumes: Task 1's `readFrames`, `PendingContext` (inside `createPrompter`), `turnFields`.
- Produces: the **stdout line protocol** Task 3 reads, one JSON object per `\n`-terminated line:
  - `{ "text": string }`: a prompt the seat should run
  - `{ "status": "online" }`: the feed is connected
  - `{ "status": "retrying", "reason": string }`: a recoverable drop; the feed reconnects with backoff (0.5 s doubling to 30 s)
  - `{ "status": "fatal", "reason": string }`: unrecoverable; the process then exits with code **2**
- `export function refusal(status: number): string | null`: the human reason for a status retrying cannot fix (401, 403, 409), else null.

- [ ] **Step 1: Write the failing tests**

```js
// test/mod-feed-process.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { refusal } from '../mod/feed.mjs'

const FEED = fileURLToPath(new URL('../mod/feed.mjs', import.meta.url))

// A room that answers /seat/join and /seat/events the way each test says.
async function fakeRoom({ join = 200, events = 200, frames = [] } = {}) {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/seat/join')) {
      res.writeHead(join, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(join === 200 ? { seatId: 's1', seed: { text: 'recent history' } } : { error: 'no' }))
    }
    if (req.url.startsWith('/seat/events')) {
      if (events !== 200) {
        res.writeHead(events)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      for (const [event, data] of frames) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      return // held open, as the real room holds a seat's feed
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); server.close() },
  }
}

// Runs the real feed.mjs until it has printed `until` lines or exited.
function runFeed(url, { until = Infinity, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FEED], {
      env: { ...process.env, ROOM_URL: url, ROOM_SEAT_TOKEN: 'tok', ROOM_SEAT_HANDLE: 'ana-agent', ...env },
    })
    const lines = []
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`feed timed out; lines so far: ${JSON.stringify(lines)}`))
    }, 10_000)
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
      if (lines.length >= until) {
        clearTimeout(timer)
        child.kill()
        resolve({ lines, code: null })
      }
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ lines, code })
    })
  })
}

test('a turn arrives as one prompt line after an online status, with the seed and a mirror riding along', async () => {
  const room = await fakeRoom({
    frames: [
      ['mirror', { text: 'bob found the bug', from: 'bob-agent' }],
      ['turn', { messages: [{ id: 'm1', name: 'heet', memberId: 'u1', content: '@ana-agent fix it' }] }],
    ],
  })
  try {
    const { lines } = await runFeed(room.url, { until: 2 })
    assert.deepEqual(lines[0], { status: 'online' })
    assert.match(lines[1].text, /recent history/)
    assert.match(lines[1].text, /bob found the bug/)
    assert.match(lines[1].text, /@ana-agent fix it/)
  } finally {
    room.close()
  }
})

test('a handle already online elsewhere stops the feed instead of retrying forever', async () => {
  const room = await fakeRoom({ events: 409 })
  try {
    const { lines, code } = await runFeed(room.url)
    assert.equal(code, 2)
    assert.equal(lines.at(-1).status, 'fatal')
    assert.match(lines.at(-1).reason, /already online/)
  } finally {
    room.close()
  }
})

test('a refused token stops the feed at join', async () => {
  const room = await fakeRoom({ join: 401 })
  try {
    const { lines, code } = await runFeed(room.url)
    assert.equal(code, 2)
    assert.match(lines.at(-1).reason, /refused this seat token/)
  } finally {
    room.close()
  }
})

test('missing configuration is a fatal status, not a crash', async () => {
  const { lines, code } = await runFeed('http://127.0.0.1:1', { env: { ROOM_URL: '' } })
  assert.equal(code, 2)
  assert.equal(lines.at(-1).status, 'fatal')
})

test('a room that answers 503 is retried, not fatal', async () => {
  const room = await fakeRoom({ events: 503 })
  try {
    const { lines } = await runFeed(room.url, { until: 1 })
    assert.equal(lines[0].status, 'retrying')
    assert.match(lines[0].reason, /503/)
  } finally {
    room.close()
  }
})

test('only refusals that retrying cannot fix are fatal', () => {
  assert.match(refusal(401), /token/)
  assert.match(refusal(403), /not an agent/)
  assert.match(refusal(409), /already online/)
  assert.equal(refusal(500), null)
  assert.equal(refusal(503), null)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/mod-feed-process.test.mjs`
Expected: FAIL. `refusal` is not exported, and the PoC `main` prints no status lines.

- [ ] **Step 3: Replace `main` in `mod/feed.mjs`**

Replace everything from `const log = …` to the end of the file with:

```js
// Refusals that retrying cannot fix. Anything else (a 5xx, a refused
// connection, a dropped stream) is a blip, and the feed reconnects.
const FATAL = {
  401: 'the room refused this seat token',
  403: 'this token is not an agent seat',
  409: 'this handle is already online in another session',
}

export function refusal(status) {
  return FATAL[status] ?? null
}

const say = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Exit only once the line is flushed: a pipe write can still be pending.
function fatal(reason) {
  process.stdout.write(JSON.stringify({ status: 'fatal', reason }) + '\n', () => process.exit(2))
}

async function main() {
  // The session that read this pipe is gone; a seat nobody reads must not
  // keep its handle online.
  process.stdout.on('error', () => process.exit(0))

  const { ROOM_URL: roomUrl, ROOM_SEAT_TOKEN: token, ROOM_SEAT_HANDLE: handle } = process.env
  if (!roomUrl || !token || !handle) return fatal('ROOM_URL, ROOM_SEAT_TOKEN and ROOM_SEAT_HANDLE must all be set')

  const prompt = createPrompter(handle)
  const emit = (event, data) => {
    const text = prompt(event, data)
    if (text) say({ text })
  }

  let joined = false
  let backoffMs = 500
  for (;;) {
    try {
      if (!joined) {
        const res = await fetch(`${roomUrl}/seat/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, handle }),
        })
        if (!res.ok) {
          const why = refusal(res.status)
          if (why) return fatal(why)
          throw new Error(`join failed: HTTP ${res.status}`)
        }
        const body = await res.json()
        if (body?.seed?.text) emit('seed', { text: body.seed.text })
        joined = true
      }
      const feed = await fetch(`${roomUrl}/seat/events?token=${encodeURIComponent(token)}`)
      if (!feed.ok || !feed.body) {
        const why = refusal(feed.status)
        if (why) return fatal(why)
        throw new Error(`feed refused: HTTP ${feed.status}`)
      }
      say({ status: 'online' })
      backoffMs = 500
      await readFrames(feed.body, (event, raw) => {
        try {
          emit(event, JSON.parse(raw))
        } catch {
          // A malformed frame is dropped, never fatal.
        }
      })
      throw new Error('the room closed the feed')
    } catch (err) {
      say({ status: 'retrying', reason: String(err?.message ?? err) })
    }
    // Sleep/wake, a room restart, a wifi blip: reconnect, as seat.mjs does.
    await sleep(backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
```

Also update the file's header comment: "prints one JSON line per prompt" becomes "prints one JSON line per prompt or status change (see Task 2's line protocol)".

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test test/mod-feed-process.test.mjs test/mod-feed.test.mjs`
Expected: PASS (6 + 5).

- [ ] **Step 5: Commit**

```bash
git add mod/feed.mjs test/mod-feed-process.test.mjs
git commit -m "feat(mod): feed reports status lines and stops on refusals that retrying cannot fix"
```

---

### Task 3: The mod: config, explicit join, scoped forwarding

**Files:**
- Modify: `mod/hooks/register.js` (rewrite)
- Modify: `mod/.claude-plugin/plugin.json` (add `userConfig`, `repository`, `license`)
- Test: `mod/tests/room-seat.test.tsx` (new; run with `claude plugin test` from `mod/`)

**Interfaces:**
- Consumes: Task 2's stdout line protocol; `${$.plugin.root}/feed.mjs`.
- Produces for users: commands `/room-join`, `/room-leave`, `/room-status`; tool `mcp__room-seat__room_reply` (`{ text: string, to?: string }`, registered only once joined); `userConfig` keys `room_url`, `seat_handle`, `seat_token` (sensitive).
- Produces for Task 4: auto-join when `ROOM_URL`, `ROOM_SEAT_TOKEN`, `ROOM_SEAT_HANDLE` are all set.

Before writing the stubs, confirm the test kit's field names in the generated declarations (`mod/.claude-plugin/types/claude-code/index.d.ts`): search `'http.fetch':` for the stub event's fields (the code below assumes `e.url` and `e.init`), and `'process.spawn'` for how a streaming stub is written (the code below assumes an async generator that yields `{ stream, text }` and returns `{ code, signal }`). If either differs, adjust the stub, not the mod.

- [ ] **Step 1: Write the failing tests**

```tsx
// mod/tests/room-seat.test.tsx
import { expect, mock, test } from 'claude-code/testing'

const SEAT_ENV = { ROOM_URL: 'http://room.test', ROOM_SEAT_TOKEN: 'tok', ROOM_SEAT_HANDLE: 'ana-agent' }
const CONFIG = { room_url: 'http://room.test', seat_token: 'tok', seat_handle: '@ana-agent' }

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

// Stubs everything the mod calls. `lines` are what the fake feed prints;
// `fetch` answers each post (default: 200). Records posts, spawns, prompts.
function stubRoom(on, { env = {}, lines = [] as object[], fetch = undefined as any, submit = undefined as any } = {}) {
  const seen = {
    posts: [] as { url: string; body: any }[],
    spawns: [] as any[],
    prompts: [] as string[],
    tools: 0,
    prompted: deferred<string>(),
    posted: deferred<string>(),
  }
  mock.env(on, env)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => { seen.tools++; return { value: { tool: 'mcp__room-seat__room_reply' } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    seen.posts.push({ url: e.url, body: JSON.parse(e.init?.body ?? 'null') })
    seen.posted.resolve(e.url)
    return fetch ? fetch(e) : { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('process.spawn', async function* ($, e) {
    seen.spawns.push(e)
    for (const l of lines) yield { stream: 'stdout', text: JSON.stringify(l) + '\n' }
    return { code: 0, signal: null }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    seen.prompted.resolve(e.text)
    return submit ? submit(e) : { text: e.text }
  })
  return seen
}

const start = $ => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const hookPosts = seen => seen.posts.filter(p => p.url.includes('/seat/hook/')).map(p => p.url.replace(/\?.*/, ''))

// `prompted` resolves inside the stub, before the mod's own prompt.submit hook
// has marked the room turn as running. A few round trips through the engine
// let that hook finish before the test fires the next event.
async function settle($) {
  for (let i = 0; i < 3; i++) await $.command.run({ command: 'room-status', args: '' })
}

test('outside a room seat the mod adds its commands and nothing else', async ($, on) => {
  const seen = stubRoom(on)
  await start($)
  expect(seen.spawns.length).toBe(0)
  expect(seen.tools).toBe(0)
})

test('a session launched as a seat joins at once, with its settings in the environment and never on argv', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].argv[0]).toBe('node')
  expect(seen.spawns[0].argv[1]).toMatch(/feed\.mjs$/)
  expect(seen.spawns[0].env.ROOM_SEAT_TOKEN).toBe('tok')
  expect(seen.spawns[0].argv.join(' ')).not.toContain('tok')
  expect(seen.tools).toBe(1)
})

test('a room turn from the feed is submitted as a prompt, framed as the plugin, not as the user', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ status: 'online' }, { text: 'hello room' }] })
  await start($)
  expect(await seen.prompted.promise).toBe('hello room')
})

test('/room-join without configuration says how to configure, and starts nothing', async ($, on) => {
  const seen = stubRoom(on)
  await start($)
  const out = await $.command.run({ command: 'room-join', args: '' })
  expect(out.text).toMatch(/Configure options/)
  expect(seen.spawns.length).toBe(0)
})

test('/room-join uses the plugin options and strips a leading @ from the handle', { options: CONFIG }, async ($, on) => {
  const seen = stubRoom(on, { lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(0) // options alone never auto-join
  await $.command.run({ command: 'room-join', args: '' })
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].env.ROOM_SEAT_HANDLE).toBe('ana-agent')
})

test('a fatal feed status shows in /room-status and the feed is not restarted', async ($, on) => {
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    lines: [{ status: 'fatal', reason: 'this handle is already online in another session' }],
  })
  await start($)
  let status = ''
  for (let i = 0; i < 50 && !/already online/.test(status); i++) {
    status = (await $.command.run({ command: 'room-status', args: '' })).text
  }
  expect(status).toMatch(/already online/)
  expect(seen.spawns.length).toBe(1)
})

test('a feed that cannot start says the seat needs Node.js', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV })
  on('process.spawn', async function* () {
    throw new Error('ENOENT: node')
  })
  await start($)
  let status = ''
  for (let i = 0; i < 50 && !/Node\.js/.test(status); i++) {
    status = (await $.command.run({ command: 'room-status', args: '' })).text
  }
  expect(status).toMatch(/Node\.js 22/)
})

test('room_reply posts the text to the room with the seat token', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'done' })
  expect(out.result).toBe('sent')
  const reply = seen.posts.find(p => p.url.endsWith('/seat/reply'))
  expect(reply.body).toEqual({ token: 'tok', text: 'done' })
})

test('a refused room_reply reaches the model as an error', async ($, on) => {
  stubRoom(on, { env: SEAT_ENV, fetch: () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }) })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'done' })
  expect(out.deny).toMatch(/500/)
})

test("the owner's own turn never reaches the room", async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV })
  on('classic.PreToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  await start($)
  await $.classic.PreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await $.classic.Stop({})
  expect(hookPosts(seen)).toEqual([])
})

test("a room turn's tool calls and its Stop are forwarded, and nothing after the Stop", async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }] })
  on('classic.PreToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  await start($)
  await seen.prompted.promise
  await settle($)
  await $.classic.PreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await $.classic.Stop({ prompt_id: 'p1' })
  await $.classic.PreToolUse({ tool_name: 'Bash', tool_input: { command: 'pwd' } })
  for (let i = 0; i < 50 && hookPosts(seen).length < 2; i++) await $.command.run({ command: 'room-status', args: '' })
  expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/PreToolUse', 'http://room.test/seat/hook/Stop'])
})

test('a room turn the owner interrupts is closed with a visible reason', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }] })
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await seen.prompted.promise
  await settle($)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: true, usage: null })
  for (let i = 0; i < 50 && hookPosts(seen).length < 1; i++) await $.command.run({ command: 'room-status', args: '' })
  expect(seen.posts.find(p => p.url.endsWith('/seat/reply')).body.text).toMatch(/interrupted/)
  expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/Stop'])
})

test('a room turn that cannot start is closed with the reason', async ($, on) => {
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    lines: [{ text: 'room work' }],
    submit: () => ({ drop: 'paused by policy' }),
  })
  await start($)
  for (let i = 0; i < 50 && hookPosts(seen).length < 1; i++) await $.command.run({ command: 'room-status', args: '' })
  expect(seen.posts.find(p => p.url.endsWith('/seat/reply')).body.text).toMatch(/paused by policy/)
  expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/Stop'])
})

test('a hook that cannot reach the room does not hold the session', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }], fetch: () => new Promise(() => {}) })
  on('classic.PreToolUse', () => ({}))
  await start($)
  await seen.prompted.promise
  await settle($)
  // Resolves only if the mod does not await the post; the test's 5 s limit fails it otherwise.
  await $.classic.PreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } })
})

test('/room-leave takes the seat offline and room_reply stops working', async ($, on) => {
  stubRoom(on, { env: SEAT_ENV, lines: [{ status: 'online' }] })
  await start($)
  await $.command.run({ command: 'room-leave', args: '' })
  expect((await $.command.run({ command: 'room-status', args: '' })).text).toMatch(/left/)
  const out = await $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'x' })
  expect(out.deny).toMatch(/not .*joined/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `mod/`): `claude plugin test`
Expected: most tests FAIL against the PoC `register.js` (no commands registered, no status, no scoping).

- [ ] **Step 3: Add `userConfig` to `mod/.claude-plugin/plugin.json`**

```json
{
  "name": "room-seat",
  "displayName": "Claude Room seat",
  "version": "0.2.0",
  "description": "Joins a claude-room as your agent seat: room turns run in this session, replies go back with room_reply. No development-channels flag.",
  "author": { "name": "Heet Shah" },
  "repository": "https://github.com/heetshah16/claude-room",
  "license": "MIT",
  "userConfig": {
    "room_url": {
      "type": "string",
      "title": "Room address",
      "description": "The room's address, such as http://127.0.0.1:8787 or its published tunnel URL"
    },
    "seat_handle": {
      "type": "string",
      "title": "Seat handle",
      "description": "Your seat's handle from `room-admin seat add`, such as ana-agent"
    },
    "seat_token": {
      "type": "string",
      "title": "Seat token",
      "description": "Your seat's token from `room-admin seat add`",
      "sensitive": true
    }
  }
}
```

- [ ] **Step 4: Rewrite `mod/hooks/register.js`**

```js
// Makes a Claude Code session a claude-room agent seat, with no
// --dangerously-load-development-channels: a channel pushes into a session
// from outside, which is what Anthropic's allowlist gates. A mod runs inside
// the session and starts the turn itself with $.prompt.submit.
//
//   seat.mjs holding /seat/events  -> feed.mjs, a child this mod spawns
//   claude/channel notification    -> $.prompt.submit
//   room_reply MCP tool            -> $.tool.register + a tool.call hook
//   generated hooks settings file  -> classic.* hooks, forwarded during room turns
//
// Joins at once when ROOM_URL, ROOM_SEAT_TOKEN and ROOM_SEAT_HANDLE are set
// (scripts/room-seat.mjs launches a session to be a seat). Plugin options are
// per user, not per session, so they wait for /room-join: auto-joining from
// them would make every session claim the same handle.

const REPLY_TOOL = {
  name: 'room_reply',
  description:
    'Send a message to the room. This is the ONLY way the room sees your words - your transcript, prose, and reasoning never reach it on their own.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The message to send to the room' },
      to: { type: 'string', description: 'Optional member name this reply answers' },
    },
    required: ['text'],
  },
}

let seat = null // { roomUrl, token, handle } while joined
let feed = null // the feed child's stream while joined
let status = 'not joined - run /room-join'
let inRoomTurn = false

export function register(on, options = {}) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'room-join', description: 'Bring this session online as your room seat', immediate: true })
    await $.command.register({ name: 'room-leave', description: "Take this session's room seat offline", immediate: true })
    await $.command.register({ name: 'room-status', description: "Show this session's room seat", immediate: true })
    const roomUrl = await $.env.get('ROOM_URL')
    const token = await $.env.get('ROOM_SEAT_TOKEN')
    const handle = await $.env.get('ROOM_SEAT_HANDLE')
    const started = await next(e)
    if (roomUrl && token && handle) await join($, { roomUrl, token, handle })
    return started
  })

  on('command.run', { command: 'room-join' }, async ($) => {
    if (feed) return { text: status }
    const cfg = { roomUrl: options.room_url, token: options.seat_token, handle: options.seat_handle }
    if (!cfg.roomUrl || !cfg.token || !cfg.handle) {
      return { text: 'Set the room address, seat handle and seat token first: /plugin, Installed, room-seat, Configure options.' }
    }
    await join($, cfg)
    return { text: `${status} - /room-status shows when it is online` }
  })

  on('command.run', { command: 'room-leave' }, async ($) => {
    if (!feed) return { text: status }
    const stream = feed
    feed = null
    seat = null
    inRoomTurn = false
    setStatus($, 'left the room')
    await stream.return?.()
    return { text: status }
  })

  on('command.run', { command: 'room-status' }, async () => ({ text: status }))

  on('tool.call', { tool: 'mcp__room-seat__room_reply' }, async ($, e) => {
    if (!seat) return { deny: 'room_reply: this session is not joined to a room' }
    try {
      const body = { token: seat.token, text: String(e.text ?? '') }
      if (e.to) body.to = String(e.to)
      const res = await post($, '/seat/reply', body)
      return res.ok ? { result: 'sent' } : { deny: `room_reply failed: HTTP ${res.status}` }
    } catch (err) {
      return { deny: `room_reply failed: ${err?.message ?? err}` }
    }
  })

  // A turn this mod submitted has entered: from here until it ends, the
  // session's hook events belong to the room's turn.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (seat && e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name && !entered?.drop) inRoomTurn = true
    return entered
  })

  // Only during a room turn: outside one, the owner's own Stop would close the
  // room's turn early and their tool calls would leak into the room's feed.
  // Never awaited: $.http.fetch has no timeout, and a hook waiting on an
  // unreachable room would hold every tool call.
  on('classic.*', { hook_event_name: ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'] }, async ($, e, next) => {
    if (seat && inRoomTurn) {
      if (e.hook_event_name === 'Stop') inRoomTurn = false
      forward($, e.hook_event_name, e)
    }
    return next(e)
  })

  // An interrupted turn may end without a Stop; the room must not stay busy.
  on('turn.complete', async ($, e, next) => {
    if (seat && inRoomTurn && e.isAborted && !e.agentId) {
      inRoomTurn = false
      void closeRoomTurn($, "the seat's owner interrupted this turn")
    }
    return next(e)
  })
}

function setStatus($, text) {
  status = text
  $.ui.status(`room: ${text}`)
}

function post($, path, body) {
  return $.http.fetch(seat.roomUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function forward($, event, payload) {
  post($, `/seat/hook/${event}?token=${encodeURIComponent(seat.token)}`, payload)
    .catch(err => $.ui.log(`room hook ${event} failed: ${err?.message ?? err}`, { to: 'debug' }))
}

async function join($, cfg) {
  seat = { roomUrl: String(cfg.roomUrl).replace(/\/+$/, ''), token: String(cfg.token), handle: String(cfg.handle).replace(/^@/, '') }
  setStatus($, `connecting to ${seat.roomUrl} as @${seat.handle}`)
  await $.tool.register(REPLY_TOOL)
  const stream = $.process.spawn({
    argv: ['node', `${$.plugin.root}/feed.mjs`],
    env: { ROOM_URL: seat.roomUrl, ROOM_SEAT_TOKEN: seat.token, ROOM_SEAT_HANDLE: seat.handle },
  })
  feed = stream
  void pump($, stream)
}

// Runs while joined. Claude Code kills feed.mjs when the loop is left or the
// module unloads, which drops /seat/events and takes the seat offline.
async function pump($, stream) {
  let buf = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        $.ui.log(text.trim(), { to: 'debug' })
        continue
      }
      buf += text
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) await onLine($, line)
      }
    }
  } catch (err) {
    if (feed === stream) setStatus($, `offline: could not run the room feed (${err?.message ?? err}); a room seat needs Node.js 22 or later on PATH`)
  }
  if (feed === stream) {
    feed = null
    seat = null
    inRoomTurn = false
    if (!status.startsWith('offline')) setStatus($, 'offline: the room feed stopped - /room-join to reconnect')
  }
}

async function onLine($, line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.status === 'online') return setStatus($, `online as @${seat.handle} in ${seat.roomUrl}`)
  if (msg.status === 'retrying') return setStatus($, `reconnecting: ${msg.reason}`)
  if (msg.status === 'fatal') return setStatus($, `offline: ${msg.reason}`)
  if (typeof msg.text === 'string') await submit($, msg.text)
}

async function submit($, text) {
  try {
    const entered = await $.prompt.submit({ text })
    if (entered?.drop) throw new Error(entered.drop)
  } catch (err) {
    inRoomTurn = false
    // The room marked this seat busy when it sent the turn. If the turn cannot
    // start, say so and close it, or every later message queues behind a turn
    // that never ran - the rule opencode.mjs follows too.
    await closeRoomTurn($, `could not start the turn: ${err?.message ?? err}`)
  }
}

async function closeRoomTurn($, reason) {
  if (!seat) return
  try {
    await post($, '/seat/reply', { token: seat.token, text: reason })
    await post($, `/seat/hook/Stop?token=${encodeURIComponent(seat.token)}`, { token: seat.token })
  } catch (err) {
    $.ui.log(`could not close the room turn: ${err?.message ?? err}`, { to: 'debug' })
  }
}
```

- [ ] **Step 5: Validate and run the mod tests**

Run: `claude plugin validate ./mod` (expect `Validation passed`; the `hooks:` line must list `session.start, command.run{command=room-join}, command.run{command=room-leave}, command.run{command=room-status}, tool.call{…}, prompt.submit, classic.*{…}, turn.complete`)
Run (from `mod/`): `claude plugin test`
Expected: every test passes. If a stub-shape assumption from the note above was wrong, fix the stub and re-run; the mod code is the contract.

- [ ] **Step 6: Confirm the root suite still ignores the mod's tests**

Run: `node --test` (repo root)
Expected: `fail 0`, and the test count does not change because of `mod/tests/room-seat.test.tsx`.

- [ ] **Step 7: Commit**

```bash
git add mod/hooks/register.js mod/.claude-plugin/plugin.json mod/tests/room-seat.test.tsx mod/tsconfig.json
git commit -m "feat(mod): /room-join with plugin options, status, and hook forwarding scoped to room turns"
```

---

### Task 4: Launcher uses the mod

**Files:**
- Modify: `scripts/room-seat.mjs` (`seatArgs`, `main`; delete `seatHookSettings`, `mcpConfigFor`, `SEAT_BRIDGE`, the `HOOK_EVENTS` import and the two `writeFileSync` calls)
- Test: `test/room-seat.test.mjs`

**Interfaces:**
- Consumes: Task 3's env auto-join contract.
- Produces: `seatArgs({ configDir, roomUrl, token, handle, repo }) -> { cmd, args, env, cwd }`; `meetsModFloor(versionText: string): boolean`; `MOD_DIR: string`.

- [ ] **Step 1: Confirm nothing else uses the helpers being deleted**

Run: `git grep -n "seatHookSettings\|mcpConfigFor" -- ':!docs'`
Expected: only `scripts/room-seat.mjs` and `test/room-seat.test.mjs`.

- [ ] **Step 2: Rewrite the tests**

Replace `test/room-seat.test.mjs` with:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { seatArgs, worktreeFor, meetsModFloor, MOD_DIR } from '../scripts/room-seat.mjs'

const base = { configDir: '/cfg/ana', roomUrl: 'http://127.0.0.1:8787', token: 'tok', handle: 'ana-agent', repo: '/repo' }

test('a seat launches real Claude Code against its own config dir, with the room in its environment', () => {
  const { cmd, env } = seatArgs(base)
  assert.equal(cmd, 'claude')
  // The isolation that makes this work at all: a separate credential store per
  // seat, so each session performs its own login.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg/ana')
  assert.equal(env.ROOM_URL, 'http://127.0.0.1:8787')
  assert.equal(env.ROOM_SEAT_TOKEN, 'tok')
  assert.equal(env.ROOM_SEAT_HANDLE, 'ana-agent')
})

test('the seat loads the room-seat mod, and no development channel', () => {
  const { args } = seatArgs(base)
  assert.ok(!args.some(a => /dangerously/.test(a)), 'a mod needs no development-channels flag')
  assert.equal(args[args.indexOf('--plugin-dir') + 1], MOD_DIR)
  assert.ok(!args.includes('--mcp-config'))
  assert.ok(!args.includes('--settings'), 'the mod forwards the hooks; no settings file')
})

test("the plugin dir is the repo's own mod/", () => {
  assert.ok(existsSync(join(MOD_DIR, '.claude-plugin', 'plugin.json')))
})

test("room_reply is pre-approved: it is the seat's only way to answer, and posts only to the room", () => {
  const { args } = seatArgs(base)
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__room-seat__room_reply')
})

test('no credential is ever passed on the command line', () => {
  const { args, env } = seatArgs(base)
  assert.ok(!args.join(' ').includes('tok'), 'the seat token travels in the env, never argv')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
})

test('each local seat gets its own worktree so two agents cannot clobber one checkout', () => {
  const a = worktreeFor('/repo', 'ana-agent')
  const b = worktreeFor('/repo', 'heet-agent')
  assert.notEqual(a, b)
  assert.match(a, /ana-agent/)
  const { args, cwd } = seatArgs(base)
  assert.equal(cwd, a)
  assert.ok(args.includes(a), 'seat must run in its own worktree')
})

test('a seat needs Claude Code 2.1.287 or later, where mods load', () => {
  assert.equal(meetsModFloor('2.1.287 (Claude Code)'), true)
  assert.equal(meetsModFloor('2.1.290 (Claude Code)'), true)
  assert.equal(meetsModFloor('2.2.0'), true)
  assert.equal(meetsModFloor('10.0.0'), true)
  assert.equal(meetsModFloor('2.1.286 (Claude Code)'), false)
  assert.equal(meetsModFloor('2.0.999'), false)
  assert.equal(meetsModFloor(''), false)
  assert.equal(meetsModFloor('not a version'), false)
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/room-seat.test.mjs`
Expected: FAIL. `meetsModFloor` and `MOD_DIR` are not exported, and the flag is still present.

- [ ] **Step 4: Change `scripts/room-seat.mjs`**

Delete `SEAT_BRIDGE`, `seatHookSettings`, `mcpConfigFor`, the `HOOK_EVENTS` import, and `writeFileSync` from the `node:fs` import. Add and replace:

```js
// The room-seat mod (mod/), loaded straight from this checkout. It joins the
// room, runs room turns and serves room_reply from inside the session, which
// is what lets a seat run without --dangerously-load-development-channels.
export const MOD_DIR = join(__dirname, '..', 'mod')

const MOD_FLOOR = [2, 1, 287] // mods load from Claude Code 2.1.287

/** Whether `claude --version` output is a version that loads mods. */
export function meetsModFloor(versionText) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionText))
  if (!m) return false
  const v = m.slice(1).map(Number)
  for (let i = 0; i < 3; i++) if (v[i] !== MOD_FLOOR[i]) return v[i] > MOD_FLOOR[i]
  return true
}

export function seatArgs({ configDir, roomUrl, token, handle, repo }) {
  const worktree = worktreeFor(repo, handle)

  // Start from the operator's own environment (PATH, HOME, etc. — claude
  // needs those to run at all), then strip any credential that might be set
  // ambiently so this script can never be the thing that supplies one.
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  return {
    cmd: 'claude',
    args: [
      '--plugin-dir', MOD_DIR,
      // The seat's only way to answer the room; it posts nowhere else.
      '--allowedTools', 'mcp__room-seat__room_reply',
      '--add-dir', worktree,
    ],
    // The mod joins at once when it finds these three.
    env: {
      ...env,
      CLAUDE_CONFIG_DIR: configDir,
      ROOM_URL: roomUrl,
      ROOM_SEAT_TOKEN: token,
      ROOM_SEAT_HANDLE: handle,
    },
    cwd: worktree,
  }
}

/** `claude --version`'s output, or '' when claude is not on PATH. */
function claudeVersion() {
  return new Promise(done => {
    let out = ''
    const child = spawnPortable('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout.on('data', d => { out += d })
    child.on('exit', () => done(out))
    child.on('error', () => done(''))
  })
}
```

Keep `seatArgs`'s existing doc comment, updated: "with the seat bridge loaded as an MCP server and its own hooks settings" becomes "with the room-seat mod loaded from this checkout".

In `main`, delete the `settingsPath`/`mcpConfigPath` block (the two `writeFileSync` calls and their comment) but keep `mkdirSync(configDir, { recursive: true })`; add the floor check before `ensureWorktree`:

```js
  const version = await claudeVersion()
  if (!meetsModFloor(version)) {
    die(`a room seat needs Claude Code 2.1.287 or later, where mods load (found: ${version.trim() || 'no claude on PATH'}). Run: claude update`)
  }
```

and call `seatArgs({ configDir, roomUrl, token, handle, repo })`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/room-seat.test.mjs` → PASS. Then `node --test` (root) → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/room-seat.mjs test/room-seat.test.mjs
git commit -m "feat: room-seat launches seats with the mod instead of --dangerously-load-development-channels"
```

---

### Task 5: Marketplace and docs

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `mod/README.md`
- Modify: `README.md` (lines 114-118, 284-289, 405-433), `ARCHITECTURE.md` (§2 "Claude Code seats — pushed", lines 77-87), `CLAUDE.md` (gotchas list)

- [ ] **Step 1: Write the marketplace**

```json
{
  "name": "claude-room",
  "description": "Plugins for claude-room, the multiplayer room for Claude Code",
  "owner": { "name": "Heet Shah" },
  "plugins": [
    {
      "name": "room-seat",
      "source": "./mod",
      "description": "Join a claude-room as your agent seat, from a terminal or the VS Code extension"
    }
  ]
}
```

Run: `claude plugin validate .` → `Validation passed`. Then `claude plugin validate ./mod` → `Validation passed`.

- [ ] **Step 2: Write `mod/README.md`**

```markdown
# room-seat

Join a [claude-room](https://github.com/heetshah16/claude-room) as your own agent seat.
Room messages addressed to your seat run as turns in your Claude Code session, on your own
account; your answers go back with the `room_reply` tool. No
`--dangerously-load-development-channels`: this is a Claude Code mod, not a channel.

Needs Claude Code 2.1.287 or later and Node.js 22 or later on PATH. Tested with 2.1.287.

## Install

    /plugin marketplace add heetshah16/claude-room
    /plugin install room-seat@claude-room

Then set its options (`/plugin`, Installed, room-seat, Configure options): the room
address, your seat handle, and your seat token. The room's owner gets the handle and token
for you from `room-admin seat add <name> --owner <you>`. The token is stored in your
system's credential store, never in settings.json.

## Use

In the session you want to be your seat, terminal or VS Code panel alike:

- `/room-join` brings the session online as your seat
- `/room-status` shows whether it is online, and why not if it isn't
- `/room-leave` takes it offline

Only one session can hold a handle at a time; a second `/room-join` with the same handle is
refused with "this handle is already online in another session".

While a room turn runs, its tool calls show in the room's activity feed. Your own prompts in
the same session never do.

## Launched seats

`node scripts/room-seat.mjs <handle> --token <token> --repo <path>` starts a dedicated seat
session with this mod loaded from the checkout. It joins on start, with no `/room-join`.

## Tests

From this directory: `claude plugin test`. Test files end in `.test.tsx` so the repo's
`node --test` (which runs `.test.ts` on Node 24) leaves them alone.
```

- [ ] **Step 3: Update `README.md`**

Lines 114-118: replace the paragraph that begins "This is a personal project" with:

```markdown
This is a personal project, not an Anthropic product. The shared host session (below) uses
`--dangerously-load-development-channels`, because custom channels are not on the
Anthropic-curated allowlist — read [Security](#security) before pointing it at anything
that matters. Agent seats do not: they join through the [`room-seat` mod](mod/README.md).
```

Lines 284-289: replace "Agent seats get their own equivalent automatically … wedges after a single message." with:

```markdown
pointing at a file that no longer authenticates. Agent seats need no such file: the
`room-seat` mod forwards a seat's hook events to that seat's own `/seat/hook/*` routes from
inside its session, and only while a room turn is running.
```

After line 419 (the closing fence of the `seat add` example), add:

```markdown
`room-seat.mjs` launches the seat with the [`room-seat` mod](mod/README.md) and no
development-channels flag; it needs Claude Code 2.1.287 or later and refuses to start
otherwise. A seat owner who would rather use their own everyday session (terminal or the
VS Code panel) installs the mod from this repo's marketplace and runs `/room-join` there
instead.
```

- [ ] **Step 4: Update `ARCHITECTURE.md` §2**

Replace the "Claude Code seats — pushed" subsection (lines 77-87) with:

```markdown
### Claude Code seats — a mod that pulls

`mod/` is a Claude Code mod (plugin `room-seat`) loaded into the seat's own session. It
spawns `mod/feed.mjs`, a Node child that holds `/seat/events` and prints one JSON line per
prompt or status change; the mod starts each room turn with `$.prompt.submit` and serves
`room_reply` as a registered tool. The seat is online exactly while that child holds the
feed, the same liveness rule as every other seat, and the child dies with the session.

This replaced a `claude/channel` push, which needed `--dangerously-load-development-channels`
because custom channels are not on Anthropic's allowlist. A mod runs inside the session, so
no allowlist applies. Two consequences worth knowing before changing it:

- **Hook events are forwarded only during a room turn.** A seat joined with `/room-join` is
  also its owner's everyday session; forwarding everything would let the owner's own `Stop`
  close the room's turn early and leak their tool calls into the room's activity feed.
- **Forwarding is never awaited.** `$.http.fetch` has no timeout; a hook waiting on an
  unreachable room would hold every tool call in the session.

`mod/lib/protocol.mjs` holds the protocol pieces both sides use (`readFrames`,
`PendingContext`, `REPLY_DIRECTIVE`, `turnFields`). It lives in `mod/` because a
marketplace install copies `mod/` alone; the room imports it from there.

Launched by `scripts/room-seat.mjs`, which still gives each seat its own `CLAUDE_CONFIG_DIR`
and its own `git worktree`.
```

- [ ] **Step 5: Add to `CLAUDE.md`'s gotchas list**

```markdown
- **Mods (`mod/`) need Claude Code 2.1.287+, and their tests are `*.test.tsx`.** Node 24's
  `node --test` runs `*.test.ts` and would fail on `claude-code/testing`; it ignores `.tsx`.
  Run the mod suite with `claude plugin test` from `mod/`. `claude --plugin-dir ./mod`
  hot-reloads on save; an installed copy does not (bump `version` and reinstall).
- **Nothing in `mod/` may import from outside `mod/`** (`test/mod-boundary.test.mjs`): a
  marketplace install copies that directory alone, without `node_modules`.
```

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/marketplace.json mod/README.md README.md ARCHITECTURE.md CLAUDE.md
git commit -m "docs: room-seat mod, its marketplace, and seats without the development-channels flag"
```

---

### Task 6: Verify against the real binary

No new code. Each step records real output, not a description. Use the scratchpad for room state and a scratch clone for the seat's worktree, so the repo itself gains no worktree or branch.

- [ ] **Step 1: Headless seat, launched with the launcher's own arguments**

Boot a throwaway room (`ROOM_STANDALONE=1 ROOM_STATE_DIR=<scratch>/state ROOM_PORT=8799 node src/server.mjs`), `room-admin seat add ana-agent --owner owner`, then run `claude -p --input-format stream-json --output-format stream-json --verbose` plus the exact `args` and `env` from `seatArgs(...)`, with stdin held open. Post `@ana-agent reply with exactly the word one`, then `… two`.
Expected: both replies in `transcript.jsonl`; `turns.json` shows both turns ended with a `promptId`.

- [ ] **Step 2: Owner's own turn stays private**

In the same headless session, send one user line on stdin (`{"type":"user","message":{"role":"user","content":"run: echo private"}}`).
Expected: no `activity` for `ana-agent` in the room's state while it runs, and the room's turn log unchanged.

- [ ] **Step 3: Second session on the same handle**

Start a second headless session with the same env.
Expected: its feed reports `fatal` ("already online in another session") within seconds; the first seat stays online.

- [ ] **Step 4: Interactive terminal via `scripts/room-seat.mjs`**

In a visible terminal (it needs the trust prompt answered once): `node scripts/room-seat.mjs ana-agent --token <token> --repo <scratch clone> --config-dir %USERPROFILE%\.claude --room http://127.0.0.1:8799`.
Expected: no development-channels warning; status line `room: online as @ana-agent …`; an addressed message gets a reply.

- [ ] **Step 5: Marketplace install and `/room-join` (user-run, VS Code panel)**

From the repo: `/plugin marketplace add C:\Users\admin\OneDrive\Desktop\claude-room`, `/plugin install room-seat@claude-room`, Configure options (room address, handle, token), reload the panel, `/room-join`, then address the seat from the room.
Expected: `/room-status` reads `online as @ana-agent …`; the turn runs in the panel; the reply appears in the room. This is the one check only the user can run.

- [ ] **Step 6: Record and commit**

Add a dated "Manual verification" entry to `mod/README.md` listing which of steps 1-5 ran, their exact results, and the Claude Code version.

```bash
git add mod/README.md
git commit -m "docs(mod): record verification against Claude Code 2.1.287"
```
