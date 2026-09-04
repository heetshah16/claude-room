// Shared harness for the seat protocol and anything else that needs a room
// with a live agent seat wired in. Mirrors test/web.test.mjs's harness (kept
// untouched by this task) so the two stay drop-in compatible, plus the
// pieces seat tests need: an agent member, its owner, and an SSE reader for
// the seat's own feed.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createWeb } from '../../src/web.mjs'
import { loadConfig } from '../../src/config.mjs'
import { Store } from '../../src/state.mjs'
import { Registry, Bans, createMember, createAgentMember } from '../../src/identity.mjs'
import { createAdmin } from '../../src/admin.mjs'
import { Ledger } from '../../src/ledger.mjs'
import { Decisions } from '../../src/decisions.mjs'
import { Queue } from '../../src/queue.mjs'
import { Seats } from '../../src/seats.mjs'
import { Bus } from '../../src/bus.mjs'
import { PermissionBroker } from '../../src/permissions.mjs'
import { TurnLog } from '../../src/turns.mjs'

// `extra` is spread into createWeb's deps, for tests that need one of its
// optional callbacks (onSeatReply, say). Nothing existing passes it, so the
// default keeps every current caller identical.
export function harness(env = {}, observer = null, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roomweb-'))
  // 'ana-agent' and 'heet-agent' are configured handles alongside 'claude' so
  // a plain @mention routes to either seat the same way any other handle
  // does. Two seats, owned by two different members, is what the
  // cross-account tests need: proof that a turn addressed to one seat is
  // never mixed with, or delivered to, the other.
  // POST /hook/* is authenticated like every other route, so the harness needs
  // a known hook token. Tests reach it via `h.hookToken` / the postHook helper.
  const config = loadConfig({
    ROOM_STATE_DIR: dir,
    ROOM_HANDLES: 'claude,ana-agent,heet-agent',
    ROOM_HOOK_TOKEN: 'test-hook-token',
    ...env,
  })
  const turns = new TurnLog()
  const order = []
  const briefs = []
  const noted = []
  const registry = new Registry()
  const owner = registry.add(createMember({ name: 'heet', role: 'owner' }))
  const viewer = registry.add(createMember({ name: 'obs', role: 'viewer' }))
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const agent = registry.add(createAgentMember({ name: 'ana-agent', handle: 'ana-agent', ownerId: ana.id }))
  const heetAgent = registry.add(createAgentMember({ name: 'heet-agent', handle: 'heet-agent', ownerId: owner.id }))
  const ledger = new Ledger()
  const decisions = new Decisions()
  const seats = new Seats()
  const queue = new Queue({ config, ledger, decisions, registry, seats })
  const sent = []
  const verdicts = []
  const permissions = new PermissionBroker()
  const obs = observer
    ? {
        note: e => noted.push(e),
        briefForInjection: observer.brief,
        enabled: () => true,
        paused: () => false,
      }
    : null

  const bans = new Bans()
  const store = new Store(dir)
  const bus = new Bus()
  const addrs = new Map()
  const runtime = {
    joinUrl: t => `http://test/?token=${t}`,
    noteAddr: (id, a) => addrs.set(id, a),
    lastAddrOf: id => addrs.get(id) ?? null,
  }
  const admin = createAdmin({ registry, bans, store, bus, config, queue, runtime, seats })

  const server = createWeb({
    config, registry, ledger, decisions, queue, turns, observer: obs,
    store, bus, permissions, bans, admin, runtime, seats,
    channel: {
      notify: m => { order.push('message'); sent.push(m) },
      notifyBrief: (text, o) => { order.push('brief'); briefs.push({ text, ...o }) },
      sendVerdict: (id, b) => verdicts.push([id, b]),
    },
    ...extra,
  })

  return {
    dir, server, owner, viewer, ana, agent, heetAgent, seats, registry, ledger, queue,
    permissions, turns, config, sent, verdicts, order, briefs, noted, bans, admin, runtime,
    // Convenience accessors the seat-protocol tests read directly.
    agentToken: agent.token, anaToken: ana.token, anaId: ana.id,
    ownerToken: owner.token,
    hookToken: config.hookToken,
    heetAgentToken: heetAgent.token,
  }
}

/**
 * Spawns `src/server.mjs` as a real child process — the shape
 * test/server.smoke.test.mjs uses to prove the room boots outside a Claude
 * Code parent (embedded mode) or entirely on its own (`ROOM_STANDALONE=1`).
 * ROOM_PORT=0 lets the OS pick a free port; this polls stderr for the
 * "listening on" line to learn which one, and scrapes the bootstrap owner's
 * join URL for its token so callers can hit authenticated routes without
 * re-deriving the owner themselves. Later tasks needing a live server should
 * use this rather than each spawning their own.
 */
export async function bootRoom(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roomboot-'))
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, ROOM_STATE_DIR: dir, ROOM_PORT: '0', ROOM_HOST: '127.0.0.1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  // The dir is this call's own tmpdir, not the caller's — clean it up
  // ourselves once the child is actually gone rather than leaving it to
  // whoever called kill().
  child.on('exit', () => rmSync(dir, { recursive: true, force: true }))

  let port = null
  // `.match()?.[1]` is `undefined`, not `null`, on a miss — loop on falsiness,
  // not on `=== null`, or the poll silently gives up after one try.
  for (let i = 0; i < 60 && !port; i++) {
    port = err.match(/listening on http:\/\/[^:]+:(\d+)/)?.[1]
    if (port) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (!port) throw new Error(`server never came up. stderr:\n${err}`)

  const ownerToken = err.match(/join:.*[?&]token=([^\s&]+)/)?.[1] ?? null

  return {
    dir,
    port: Number(port),
    child,
    ownerToken,
    stdout: () => out,
    stderr: () => err,
  }
}

export const listen = server =>
  new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))

export const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/**
 * POST to the LOCAL session's hook route, carrying the room's hook token.
 *
 * /hook/* is authenticated: it can end the in-flight turn and write to the
 * ledger, so it is gated like everything else. Real hooks get the token from
 * the settings file the room generates; tests get it from the harness.
 */
export const postHook = (base, h, event, body) =>
  post(base, `/hook/${event}?token=${encodeURIComponent(h.hookToken)}`, body)

export const done = h => { h.server.close(); rmSync(h.dir, { recursive: true, force: true }) }

/**
 * Polls until `fn()` is truthy. `res.on('close')` on an aborted fetch fires
 * asynchronously server-side, not the instant the client aborts — tests that
 * need to observe the seat actually going offline poll for it rather than
 * assuming a fixed delay is enough.
 */
export async function waitUntil(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true')
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

/**
 * Opens an SSE endpoint and hands back a tiny async reader: `.next()`
 * resolves to the next `{event, data}` frame, `.until(pred)` resolves to the
 * next frame matching `pred` (skipping — not losing — anything before it,
 * for a shared bus feed that also carries unrelated events), `.close()`
 * tears the connection down. A comment-only frame (the room's own
 * `: connected` line, or an SSE keep-alive) has no `event:`/`data:` lines
 * and is swallowed rather than handed to the caller.
 */
async function openSSE(url) {
  const ctrl = new AbortController()
  // Awaited before returning, same as the original openSeatFeed: a caller
  // that awaits this is guaranteed the server has already processed the
  // request (e.g. Seats.join has already run) before doing anything else.
  const res = await fetch(url, { signal: ctrl.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const pending = []
  let waiting = null // {resolve, match}

  function parseFrame(frame) {
    let event = null
    let data = null
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) data = line.slice('data: '.length)
    }
    if (event === null || data === null) return null
    try {
      return { event, data: JSON.parse(data) }
    } catch {
      return { event, data }
    }
  }

  function deliver(evt) {
    if (waiting && (!waiting.match || waiting.match(evt))) {
      const w = waiting
      waiting = null
      w.resolve(evt)
    } else {
      pending.push(evt)
    }
  }

  ;(async () => {
    try {
      for (;;) {
        const { done: over, value } = await reader.read()
        if (over) return
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const evt = parseFrame(frame)
          if (evt) deliver(evt)
        }
      }
    } catch {
      // Aborted on close(), or the connection dropped — either way nothing
      // left to deliver.
    }
  })()

  return {
    next() {
      if (pending.length) return Promise.resolve(pending.shift())
      return new Promise(resolve => { waiting = { resolve, match: null } })
    },
    until(match) {
      const i = pending.findIndex(match)
      if (i !== -1) return Promise.resolve(pending.splice(i, 1)[0])
      return new Promise(resolve => { waiting = { resolve, match } })
    },
    close() {
      ctrl.abort()
    },
  }
}

/** Opens a seat's own SSE feed — see `openSSE`. */
export const openSeatFeed = (base, token) => openSSE(`${base}/seat/events?token=${token}`)

/** Opens the room-wide browser SSE feed (every published bus event) — see `openSSE`. */
export const openEventsFeed = (base, token) => openSSE(`${base}/events?token=${token}`)

/**
 * Writes a one-line fake assistant transcript, the same shape a Stop hook
 * reads usage from. Unique filename per call so tests sharing one dir don't
 * clobber each other.
 */
export function writeFakeTranscript(dir, { output = 40, input = 1, cacheRead = 900, cacheCreate = 0 } = {}) {
  const path = join(dir, `fake-transcript-${randomUUID().slice(0, 8)}.jsonl`)
  writeFileSync(path, JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  }) + '\n')
  return path
}
