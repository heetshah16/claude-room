import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done, openSeatFeed, writeFakeTranscript } from './helpers/room.mjs'

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
