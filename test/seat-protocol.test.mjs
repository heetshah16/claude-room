import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done, openSeatFeed, openEventsFeed, writeFakeTranscript, waitUntil } from './helpers/room.mjs'

test('a seat joins with its member token and receives a seed', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await post(base, '/seat/join', { token: h.agentToken, handle: 'ana-agent' })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok(body.seatId)
  assert.ok(body.seed)
  done(h)
})

test('a human token cannot claim a seat', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await post(base, '/seat/join', { token: h.owner.token, handle: 'ana-agent' })
  assert.equal(res.status, 403)
  done(h)
})

test('an addressed message is delivered to its seat as a turn', async () => {
  const h = harness(); const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)      // helper: SSE reader
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent find the TTL' })
  const ev = await feed.next()
  assert.equal(ev.event, 'turn')
  assert.equal(ev.data.messages[0].content, '@ana-agent find the TTL')
  feed.close(); done(h)
})

test('a seat reply lands in the room attributed to the seat', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/seat/join', { token: h.agentToken, handle: 'ana-agent' })
  await post(base, '/seat/reply', { token: h.agentToken, text: 'found three places' })
  const s = await (await fetch(base + '/api/state?token=' + h.owner.token)).json()
  const last = s.messages[s.messages.length - 1]
  assert.equal(last.name, 'ana-agent')
  assert.equal(last.kind, 'reply')
  done(h)
})

test('seat hooks are attributed to the seat owner in the ledger', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/seat/join', { token: h.agentToken, handle: 'ana-agent' })
  const tp = writeFakeTranscript(h.dir, { output: 120 })
  await post(base, '/seat/hook/Stop', { token: h.agentToken, prompt_id: 'p1', transcript_path: tp })
  assert.equal(h.ledger.totalsFor(h.anaId).output, 120)
  done(h)
})

// A prior review flagged that seats.online() was only ever checked for the
// fields it should have, never that `conn` was absent. The room JSON-
// serialises this list straight to browsers; a live http.ServerResponse on
// a row would throw on circular refs or leak internals.
test('seats.online() rows never carry the live connection object', async () => {
  const h = harness(); const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  const rows = h.seats.online()
  assert.equal(rows.length, 1)
  assert.ok(!('conn' in rows[0]))
  assert.doesNotThrow(() => JSON.stringify(rows))
  feed.close(); done(h)
})

// --- Fix round 1: cross-account leak via mixed-handle batching (Critical 1) ---

test('a turn never cross-delivers - two seats addressed together each get only their own message', async () => {
  const h = harness(); const base = await listen(h.server)
  const anaFeed = await openSeatFeed(base, h.agentToken)
  const heetFeed = await openSeatFeed(base, h.heetAgentToken)

  // Queue both seats' messages directly, bypassing /msg's own synchronous
  // drain, so both sit in #pending at once — the exact precondition the
  // reviewer reproduced the leak with. Also occupy the local channel first,
  // as a busy destination unrelated to either seat, matching the original
  // repro ("queued behind an in-flight turn").
  await post(base, '/msg', { token: h.owner.token, text: '@claude keep going' })
  h.queue.submit(h.ana, '@ana-agent ANA-SECRET')
  h.queue.submit(h.owner, '@heet-agent HEET-SECRET')
  assert.equal(h.queue.pending().length, 2)

  // A third addressed submission's own drain() is what pulls from #pending;
  // one call only ever starts ONE destination's turn (the oldest free one).
  await post(base, '/msg', { token: h.ana.token, text: 'chatter, not addressed' })
  await post(base, '/msg', { token: h.ana.token, text: '@ana-agent trigger' }).catch(() => {})

  const anaEv = await anaFeed.next()
  assert.equal(anaEv.event, 'turn')
  // Must be exactly ana's own message(s) - never heet-agent's secret riding
  // along in the same batch.
  for (const m of anaEv.data.messages) assert.ok(!m.content.includes('HEET-SECRET'))
  assert.ok(anaEv.data.messages.some(m => m.content.includes('ANA-SECRET')))

  anaFeed.close(); heetFeed.close(); done(h)
})

test('a busy seat destination does not block a different, free seat from starting its own turn', async () => {
  const h = harness(); const base = await listen(h.server)
  const anaFeed = await openSeatFeed(base, h.agentToken)
  const heetFeed = await openSeatFeed(base, h.heetAgentToken)

  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent one' })
  await anaFeed.next()
  // heet-agent is a different, online seat, so it also gets ana's turn
  // mirrored to it (by design — that's how seats stay in sync). Drain that
  // mirror before checking for heet's own turn, or it shadows the real one.
  const mirrored = await heetFeed.next()
  assert.equal(mirrored.event, 'mirror')
  assert.equal(h.queue.busy('ana-agent'), true)

  // heet-agent is a completely different destination and must not wait on
  // ana-agent's in-flight turn.
  await post(base, '/msg', { token: h.owner.token, text: '@heet-agent two' })
  const heetEv = await heetFeed.next()
  assert.equal(heetEv.event, 'turn')
  assert.equal(heetEv.data.messages[0].content, '@heet-agent two')

  anaFeed.close(); heetFeed.close(); done(h)
})

// --- Fix round 1: a seat can be "online" but unreachable (Critical 3) ---

test('addressing a seat that has joined but not opened its feed is a visible rejection, not a wedge', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/seat/join', { token: h.agentToken, handle: 'ana-agent' }) // join only, no feed
  const res = await post(base, '/msg', { token: h.anaToken, text: '@ana-agent hello' })
  assert.equal(res.status, 429)
  assert.equal((await res.json()).reason, 'seat-offline')
  assert.equal(h.queue.busy('ana-agent'), false)
  assert.equal(h.queue.pending().length, 0)
  done(h)
})

test('a seat feed that closes between submit and drain fails visibly rather than wedging the queue', async () => {
  const h = harness(); const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)

  // Occupy ana-agent's own destination so the next message queues instead
  // of draining immediately.
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent first' })
  await feed.next()
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent second' })
  assert.equal(h.queue.pending().length, 1)

  feed.close()
  await waitUntil(() => !h.seats.isOnline('ana-agent'))

  // Ending the first turn drains the queue again; the seat is gone by now.
  await post(base, '/seat/hook/Stop', { token: h.agentToken, prompt_id: 'p1', transcript_path: '/no/such/file' })

  assert.equal(h.queue.busy('ana-agent'), false)
  assert.equal(h.queue.pending().length, 0)
  done(h)
})

// --- Fix round 1: a second feed for one handle (Important 4) ---

test('a second feed for an already-online handle is refused, and closing it leaves the first seat online', async () => {
  const h = harness(); const base = await listen(h.server)
  const feed1 = await openSeatFeed(base, h.agentToken)
  assert.equal(h.seats.isOnline('ana-agent'), true)

  const res2 = await fetch(`${base}/seat/events?token=${h.agentToken}`)
  assert.equal(res2.status, 409)
  await res2.arrayBuffer()

  assert.equal(h.seats.isOnline('ana-agent'), true) // untouched by the refused duplicate

  feed1.close(); done(h)
})

// --- Fix round 1: one seat's Stop must not end another's turn (Important 5) ---

test("seat A's Stop hook does not end seat B's in-flight turn", async () => {
  const h = harness(); const base = await listen(h.server)
  const anaFeed = await openSeatFeed(base, h.agentToken)
  const heetFeed = await openSeatFeed(base, h.heetAgentToken)

  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent go' })
  await anaFeed.next()
  await post(base, '/msg', { token: h.owner.token, text: '@heet-agent go' })
  await heetFeed.next()

  assert.equal(h.queue.busy('ana-agent'), true)
  assert.equal(h.queue.busy('heet-agent'), true)
  assert.ok(h.turns.openTurn('heet-agent'))

  await post(base, '/seat/hook/Stop', { token: h.agentToken, prompt_id: 'pa', transcript_path: '/no/such/file' })

  assert.equal(h.queue.busy('ana-agent'), false)
  assert.equal(h.queue.busy('heet-agent'), true) // untouched
  assert.ok(h.turns.openTurn('heet-agent'), "heet-agent's turn must still be open")

  anaFeed.close(); heetFeed.close(); done(h)
})

// --- Fix round 2, item 1: a rejected destination must not stall the next one ---

test('a rejected destination drains the next one automatically, with no further external trigger', async () => {
  const h = harness(); const base = await listen(h.server)
  const anaFeed = await openSeatFeed(base, h.agentToken)
  const heetFeed = await openSeatFeed(base, h.heetAgentToken)

  // Start ana-agent's first turn so its destination is busy; a second
  // message for it then queues instead of draining.
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent first' })
  await anaFeed.next()
  await heetFeed.next() // mirror of ana's first turn

  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent second' })
  // Queue heet-agent's message directly, bypassing /msg's own drain, so it
  // sits behind ana-agent's second message without anything touching it yet.
  h.queue.submit(h.owner, '@heet-agent go')
  assert.equal(h.queue.pending().length, 2)

  anaFeed.close()
  await waitUntil(() => !h.seats.isOnline('ana-agent'))

  // One external trigger, addressed to neither seat. Everything after this
  // must happen as a direct, automatic consequence of the single drain() it
  // causes: ana-agent's now-unreachable second message is discovered and
  // rejected, and heet-agent's message — queued the whole time — starts its
  // own turn with no further external prompt.
  await post(base, '/msg', { token: h.owner.token, text: '@claude trigger' })

  const heetEv = await heetFeed.next()
  assert.equal(heetEv.event, 'turn')
  assert.equal(heetEv.data.messages[0].content, '@heet-agent go')
  assert.equal(h.queue.busy('heet-agent'), true)

  heetFeed.close(); done(h)
})

// --- Fix round 2, item 2: /api/state must expose an open SEAT turn too ---

test('/api/state exposes the open seat turn, not just the local one', async () => {
  const h = harness(); const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent go' })
  await feed.next()

  const s = await (await fetch(base + '/api/state?token=' + h.owner.token)).json()
  assert.equal(s.busy, true)
  // openTurnId stays scoped to the local channel, unchanged, for anything
  // that already reads it — no local turn is open here.
  assert.equal(s.openTurnId, null)
  // openTurnIds is every turn open right now, across every destination —
  // the shape chosen so a browser can link "the room is busy" to what is
  // actually running even when it is a seat, not the local session.
  assert.ok(Array.isArray(s.openTurnIds))
  assert.equal(s.openTurnIds.length, 1)
  assert.ok(s.openTurnIds[0])

  feed.close(); done(h)
})

// --- Fix round 2, item 3: a seat dropping mid-turn must not wedge its handle ---

test("a seat's feed dropping mid-turn ends that turn visibly and frees its handle to reconnect", async () => {
  const h = harness(); const base = await listen(h.server)
  const events = await openEventsFeed(base, h.owner.token)

  const feed1 = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent go' })
  await feed1.next()
  assert.equal(h.queue.busy('ana-agent'), true)

  feed1.close()
  await waitUntil(() => !h.seats.isOnline('ana-agent'))

  // Visible: a 'rejected' event reaches the room's own feed, not just a
  // silent internal state change.
  const rejected = await events.until(e => e.event === 'rejected')
  assert.equal(rejected.data.reason, 'seat-disconnected')

  // Not wedged: the destination is free again...
  assert.equal(h.queue.busy('ana-agent'), false)

  // ...and the same handle can reconnect and start a fresh turn.
  const feed2 = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent again' })
  const ev = await feed2.next()
  assert.equal(ev.event, 'turn')
  assert.equal(ev.data.messages[0].content, '@ana-agent again')

  events.close(); feed2.close(); done(h)
})
