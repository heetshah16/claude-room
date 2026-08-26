/**
 * Removing, banning, or re-tokening someone must actually cut them off.
 *
 * `bus.disconnect(memberId)` ends the browser streams tagged with that member,
 * but a seat's connection lives in Seats, not Bus, and createAdmin was never
 * given `seats` at all. deliverToSeats writes to `seat.conn` directly without
 * re-checking a token, so a revoked agent's feed kept streaming the room's
 * conversation to it.
 *
 * `rotate` is the sharpest case: it is documented "use when a link leaks", and
 * for a seat it did not close the leak — the old token stopped working for new
 * requests while whoever already held the socket kept reading everything.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done, openSeatFeed, waitUntil } from './helpers/room.mjs'

/** The agent member the shared harness registers as @ana-agent. */
const agentOf = h => h.registry.byHandle('ana-agent')

test('removing an agent cuts its live feed, not just its token', async () => {
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  assert.equal(h.seats.isOnline('ana-agent'), true)

  h.admin.run('remove', { memberId: agentOf(h).id })

  await waitUntil(() => h.seats.isOnline('ana-agent') === false)
  assert.equal(h.seats.isOnline('ana-agent'), false, 'a removed agent must not keep a live feed')
  feed.close()
  done(h)
})

test('banning an agent cuts its live feed', async () => {
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)

  h.admin.run('ban', { memberId: agentOf(h).id, reason: 'testing' })

  await waitUntil(() => h.seats.isOnline('ana-agent') === false)
  assert.equal(h.seats.isOnline('ana-agent'), false, 'a banned agent must not keep reading the room')
  feed.close()
  done(h)
})

test('rotating a seat token closes the leak it exists to close', async () => {
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)

  h.admin.run('rotate', { memberId: agentOf(h).id })

  await waitUntil(() => h.seats.isOnline('ana-agent') === false)
  assert.equal(
    h.seats.isOnline('ana-agent'), false,
    'rotate is for a leaked link; leaving the old socket streaming defeats it',
  )
  feed.close()
  done(h)
})

test("removing a seat's owner takes the seat down with them", async () => {
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)

  // Ana owns @ana-agent. With Ana gone nobody can address it (ownsSeat can
  // never match a revoked member), so leaving it online holds the handle and
  // keeps feeding the conversation to a session with no one behind it.
  h.admin.run('remove', { memberId: h.ana.id })

  await waitUntil(() => h.seats.isOnline('ana-agent') === false)
  assert.equal(h.seats.isOnline('ana-agent'), false, "an orphaned seat must not stay online")
  feed.close()
  done(h)
})

test('evicting a seat mid-turn does not wedge the queue', async () => {
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent find the TTL' })
  await feed.next()
  assert.equal(h.queue.busy('ana-agent'), true)

  h.admin.run('remove', { memberId: agentOf(h).id })

  // The feed's own close handler owns cleanup — it retires the seat AND ends
  // the abandoned turn. Evicting must go through that path rather than
  // reaching into Seats directly, or the turn is left in flight forever.
  await waitUntil(() => h.queue.busy('ana-agent') === false)
  assert.equal(h.queue.busy('ana-agent'), false, 'an evicted seat must not leave its turn in flight')
  feed.close()
  done(h)
})

test('evicting one seat leaves every other seat alone', async () => {
  const h = harness()
  const base = await listen(h.server)
  const anaFeed = await openSeatFeed(base, h.agentToken)
  const heetFeed = await openSeatFeed(base, h.heetAgentToken)
  assert.equal(h.seats.isOnline('heet-agent'), true)

  h.admin.run('remove', { memberId: agentOf(h).id })

  await waitUntil(() => h.seats.isOnline('ana-agent') === false)
  assert.equal(h.seats.isOnline('heet-agent'), true, 'evicting one seat must not disturb another')
  anaFeed.close(); heetFeed.close()
  done(h)
})
