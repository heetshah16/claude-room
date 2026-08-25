// Shared harness for the seat protocol and anything else that needs a room
// with a live agent seat wired in. Mirrors test/web.test.mjs's harness (kept
// untouched by this task) so the two stay drop-in compatible, plus the
// pieces seat tests need: an agent member, its owner, and an SSE reader for
// the seat's own feed.
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

export function harness(env = {}, observer = null) {
  const dir = mkdtempSync(join(tmpdir(), 'roomweb-'))
  // 'ana-agent' and 'heet-agent' are configured handles alongside 'claude' so
  // a plain @mention routes to either seat the same way any other handle
  // does. Two seats, owned by two different members, is what the
  // cross-account tests need: proof that a turn addressed to one seat is
  // never mixed with, or delivered to, the other.
  const config = loadConfig({ ROOM_STATE_DIR: dir, ROOM_HANDLES: 'claude,ana-agent,heet-agent', ...env })
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
  const admin = createAdmin({ registry, bans, store, bus, config, queue, runtime })

  const server = createWeb({
    config, registry, ledger, decisions, queue, turns, observer: obs,
    store, bus, permissions, bans, admin, runtime, seats,
    channel: {
      notify: m => { order.push('message'); sent.push(m) },
      notifyBrief: (text, o) => { order.push('brief'); briefs.push({ text, ...o }) },
      sendVerdict: (id, b) => verdicts.push([id, b]),
    },
  })

  return {
    dir, server, owner, viewer, ana, agent, heetAgent, seats, registry, ledger, queue,
    permissions, turns, config, sent, verdicts, order, briefs, noted, bans, admin,
    // Convenience accessors the seat-protocol tests read directly.
    agentToken: agent.token, anaToken: ana.token, anaId: ana.id,
    heetAgentToken: heetAgent.token,
  }
}

export const listen = server =>
  new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))

export const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

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
 * Opens a seat's SSE feed and hands back a tiny async reader: `.next()`
 * resolves to the next `{event, data}` frame, `.close()` tears the
 * connection down. The room's own connect comment (`: connected`) is a
 * frame with no `event:`/`data:` lines and is swallowed rather than handed
 * to the caller.
 */
export async function openSeatFeed(base, token) {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/seat/events?token=${token}`, { signal: ctrl.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const pending = []
  let waiting = null

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
          if (!evt) continue
          if (waiting) {
            const w = waiting
            waiting = null
            w.resolve(evt)
          } else {
            pending.push(evt)
          }
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
      return new Promise(resolve => { waiting = { resolve } })
    },
    close() {
      ctrl.abort()
    },
  }
}

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
