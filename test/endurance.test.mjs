/**
 * The room over time, rather than over milliseconds.
 *
 * Every other test in this suite finishes in well under a second, which is why
 * the keepalive bug shipped: idle seat feeds were killed by undici's 300s body
 * timeout and nothing in CI ran long enough to notice. Anything whose failure
 * mode is "works, then stops working a few minutes later" is invisible to the
 * rest of the suite.
 *
 * These compress that class into seconds by shrinking the intervals the room
 * actually uses, rather than waiting real minutes. The room is driven entirely
 * through HTTP, so what is exercised is the shipped wiring.
 *
 * A caveat worth keeping honest: shrinking ROOM_KEEPALIVE_MS shrinks the
 * room's heartbeat, but NOT undici's 300s timeout, which is the thing that
 * actually killed idle feeds. Nothing here can prove that timeout is survived
 * except the opt-in real-time test at the bottom. What the fast tests prove is
 * narrower and still worth having: that the heartbeat keeps firing, that seats
 * survive many cycles of it, and that repetition does not leak handles, wedge
 * destinations, or strand turns.
 *
 * Run with ROOM_ENDURANCE=1 to additionally run the real-time test, which
 * genuinely idles past undici's 300s timeout and so takes ~6 minutes:
 *
 *   ROOM_ENDURANCE=1 node --test test/endurance.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done, openSeatFeed, waitUntil } from './helpers/room.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Counts raw `: ping` frames on a live feed over a window.
 *
 * Shrinking ROOM_KEEPALIVE_MS shrinks the room's heartbeat, but the timeout it
 * defends against is undici's and cannot be shrunk from here. So a short idle
 * proves nothing about surviving it — an earlier version of this file asserted
 * `isOnline` after 1.2s and passed with the heartbeat disabled entirely. What
 * IS provable quickly is that pings keep coming: a heartbeat that fires once
 * and dies, or that is cleared by the first delivery, fails this.
 */
async function countPings(url, windowMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), windowMs)
  let pings = 0
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done: fin } = await reader.read()
      if (fin) break
      pings += (decoder.decode(value, { stream: true }).match(/: ping/g) ?? []).length
    }
  } catch {
    // aborted by the window closing
  } finally {
    clearTimeout(timer)
    ctrl.abort()
  }
  return pings
}

test('the heartbeat keeps firing - it does not stop after the first tick', async () => {
  const h = harness({ ROOM_KEEPALIVE_MS: '30' })
  const base = await listen(h.server)

  const pings = await countPings(`${base}/seat/events?token=${h.agentToken}`, 900)

  // ~30 expected at 30ms over 900ms; anything above a handful proves it
  // repeats rather than firing once, without being flaky under load.
  assert.ok(pings >= 5, `heartbeat stopped early: only ${pings} ping(s) in 900ms`)
  done(h)
})

test('a seat idled across many heartbeats can still take a turn', async () => {
  // Guards a feed that is nominally open but no longer usable: isOnline() says
  // true while delivery goes nowhere. Sending only after a long idle, and
  // after many heartbeat writes, is what exercises that.
  const h = harness({ ROOM_KEEPALIVE_MS: '30' })
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)

  await sleep(1200)

  assert.equal(h.seats.isOnline('ana-agent'), true, 'seat dropped during idle heartbeat cycles')
  const res = await post(base, '/msg', { token: h.anaToken, text: '@ana-agent still there?' })
  assert.equal(res.status, 200)
  const ev = await feed.next()
  assert.equal(ev.event, 'turn', 'an idled seat must still receive its turn')
  assert.equal(ev.data.messages[0].content, '@ana-agent still there?')
  feed.close()
  done(h)
})

test('many turns in a row leave nothing in flight and nothing queued', async () => {
  // Guards the slow leak: a queue that never fully drains, or a destination
  // left busy once every N turns, only shows up over a run of them.
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)

  for (let i = 0; i < 25; i++) {
    await post(base, '/msg', { token: h.anaToken, text: `@ana-agent question ${i}` })
    await feed.next() // the turn
    await post(base, '/seat/reply', { token: h.agentToken, text: `answer ${i}` })
    await post(base, '/seat/hook/Stop', { token: h.agentToken, prompt_id: `p${i}`, transcript_path: '/nope' })
    await waitUntil(() => h.queue.busy('ana-agent') === false)
  }

  assert.equal(h.queue.busy('ana-agent'), false, 'a destination was left in flight')
  assert.equal(h.queue.pending().length, 0, 'messages were left queued')
  assert.equal(h.seats.isOnline('ana-agent'), true, 'the seat did not survive 25 turns')
  feed.close()
  done(h)
})

test('seats reconnecting repeatedly never leak a handle', async () => {
  // A handle is claimable by exactly one seat. If a drop ever failed to free
  // it, the next join would be refused `handle-taken` and the seat would be
  // permanently unreachable — a bug that only appears after a reconnect,
  // which nothing else here does.
  const h = harness()
  const base = await listen(h.server)

  for (let i = 0; i < 15; i++) {
    const feed = await openSeatFeed(base, h.agentToken)
    assert.equal(h.seats.isOnline('ana-agent'), true, `join ${i} did not register`)
    feed.close()
    await waitUntil(() => h.seats.isOnline('ana-agent') === false)
  }

  const feed = await openSeatFeed(base, h.agentToken)
  assert.equal(h.seats.isOnline('ana-agent'), true, 'the handle leaked across reconnects')
  feed.close()
  done(h)
})

test('a seat dropping mid-turn, repeatedly, never wedges its destination', async () => {
  const h = harness()
  const base = await listen(h.server)

  for (let i = 0; i < 10; i++) {
    const feed = await openSeatFeed(base, h.agentToken)
    await post(base, '/msg', { token: h.anaToken, text: `@ana-agent round ${i}` })
    await feed.next()
    assert.equal(h.queue.busy('ana-agent'), true)

    feed.close() // drop mid-turn, before any Stop

    await waitUntil(() => h.queue.busy('ana-agent') === false)
    assert.equal(h.queue.busy('ana-agent'), false, `round ${i} left the destination wedged`)
  }
  done(h)
})

/**
 * The real thing: idle past undici's actual 300s body timeout, no shrunken
 * intervals. This is the test that would have caught the keepalive bug on its
 * own terms, and it is opt-in because it takes about six minutes.
 */
test('a seat survives a genuinely idle six minutes', { skip: process.env.ROOM_ENDURANCE !== '1' }, async t => {
  t.diagnostic('idling ~330s to cross undici\'s 300s body timeout')
  const h = harness() // stock 25s keepalive
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)

  await sleep(330_000)

  assert.equal(h.seats.isOnline('ana-agent'), true, 'the seat did not survive a real idle period')
  const res = await post(base, '/msg', { token: h.anaToken, text: '@ana-agent after the long quiet' })
  assert.equal(res.status, 200)
  const ev = await feed.next()
  assert.equal(ev.event, 'turn')
  feed.close()
  done(h)
})
