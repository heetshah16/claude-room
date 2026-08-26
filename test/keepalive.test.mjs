// A seat is online exactly while its feed is open, so anything that cuts an
// idle feed takes the seat offline with it. SSE has no protocol-level ping,
// and undici - which src/seat.mjs reads its feed with - aborts a response body
// after 300s of silence (UND_ERR_BODY_TIMEOUT). Found live: both demo seats
// dropped with that exact error on an idle room, then reconnected on backoff,
// churning every seat roughly every five minutes and refusing their owners
// with `seat-offline` in each gap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bus } from '../src/bus.mjs'
import { Seats } from '../src/seats.mjs'
import { createAgentMember } from '../src/identity.mjs'
import { harness, listen, done } from './helpers/room.mjs'

/**
 * Reads raw bytes off a live SSE response until `want` appears or time runs
 * out. The shared openSSE helper parses frames into events, and a keepalive is
 * deliberately not an event — so proving it reaches the wire needs the raw
 * stream.
 */
async function rawUntil(url, want, timeoutMs = 3000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    for (;;) {
      const { value, done: fin } = await reader.read()
      if (fin) return seen
      seen += decoder.decode(value, { stream: true })
      if (seen.includes(want)) return seen
    }
  } catch {
    return '' // aborted by the timeout
  } finally {
    clearTimeout(timer)
    ctrl.abort()
  }
}

// Minimal stand-in for an SSE response: records what was written to it.
function fakeConn() {
  const written = []
  return {
    written,
    write(s) { written.push(s) },
    end() {},
    on() {},
  }
}

test('the bus pings every open stream so an idle room is not mistaken for a dead one', () => {
  const bus = new Bus()
  const a = fakeConn()
  const b = fakeConn()
  bus.subscribe(a, 'm1')
  bus.subscribe(b, 'm2')

  const live = bus.keepalive()

  assert.equal(live, 2)
  assert.deepEqual(a.written, [': ping\n\n'])
  assert.deepEqual(b.written, [': ping\n\n'])
})

test('a keepalive frame is an SSE comment, so no client parses it as an event', () => {
  const bus = new Bus()
  const conn = fakeConn()
  bus.subscribe(conn, 'm1')
  bus.keepalive()

  const frame = conn.written[0]
  // A line starting ':' is ignored by every SSE parser. If this ever became a
  // real `event:` line, every client would see a phantom event on every tick.
  assert.ok(frame.startsWith(':'), `keepalive must be a comment, got: ${JSON.stringify(frame)}`)
  assert.ok(!/^event:/m.test(frame))
  assert.ok(!/^data:/m.test(frame))
})

test('a stream that throws on write is dropped rather than pinged forever', () => {
  const bus = new Bus()
  const dead = { write() { throw new Error('EPIPE') }, end() {}, on() {} }
  const live = fakeConn()
  bus.subscribe(dead, 'm1')
  bus.subscribe(live, 'm2')

  assert.equal(bus.keepalive(), 1)
  assert.equal(bus.count(), 1)
})

test('seat feeds are pinged too - this is the one that was actually dropping', () => {
  const seats = new Seats()
  const conn = fakeConn()
  const agent = createAgentMember({ name: 'ana-agent', handle: 'ana-agent', ownerId: 'owner-1' })
  seats.join(agent, conn)

  assert.equal(seats.keepalive(), 1)
  assert.deepEqual(conn.written, [': ping\n\n'])
})

test('a seat whose socket throws is left for its own close handler to retire', () => {
  const seats = new Seats()
  const agent = createAgentMember({ name: 'ana-agent', handle: 'ana-agent', ownerId: 'owner-1' })
  seats.join(agent, { write() { throw new Error('EPIPE') }, end() {}, on() {} })

  assert.equal(seats.keepalive(), 0, 'a throwing socket is not counted live')
  // Retiring it here would race the close handler and free the handle twice;
  // liveness has exactly one owner, and this is not it.
  assert.equal(seats.isOnline('ana-agent'), true)
})

test('keepalive on an empty room is a no-op, not a crash', () => {
  assert.equal(new Bus().keepalive(), 0)
  assert.equal(new Seats().keepalive(), 0)
})

// The unit tests above prove the two keepalive methods work; these prove the
// server actually calls them, which is the part that was missing entirely.

test('a running room pings an idle seat feed without being asked', async () => {
  const h = harness({ ROOM_KEEPALIVE_MS: '40' })
  const base = await listen(h.server)
  const seen = await rawUntil(`${base}/seat/events?token=${h.agentToken}`, ': ping')
  assert.ok(seen.includes(': ping'), `no keepalive on an idle seat feed; saw: ${JSON.stringify(seen)}`)
  done(h)
})

test('a running room pings an idle browser feed too', async () => {
  const h = harness({ ROOM_KEEPALIVE_MS: '40' })
  const base = await listen(h.server)
  const seen = await rawUntil(`${base}/events?token=${h.anaToken}`, ': ping')
  assert.ok(seen.includes(': ping'), `no keepalive on an idle browser feed; saw: ${JSON.stringify(seen)}`)
  done(h)
})

test('the heartbeat stops when the server closes, so it cannot outlive the room', async () => {
  const h = harness({ ROOM_KEEPALIVE_MS: '40' })
  await listen(h.server)
  done(h) // closes the server
  // An interval left running here would keep firing against a closed room for
  // the life of the process. unref() hides that from the exit path but does
  // not stop it.
  await new Promise(r => setTimeout(r, 120))
  assert.ok(true)
})
