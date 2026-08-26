// Observer must stay fed by seat activity, not just the local channel — the
// anti-drift property (a regenerated brief re-synchronising every seat's
// independently-compacted context) depends on every seat's replies and turn
// closes reaching the observer's note stream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done, openSeatFeed } from './helpers/room.mjs'

test('the observer sees agent replies, or it goes blind in a multi-seat room', async () => {
  const h = harness({}, { brief: () => ({ text: '', ageS: 0, pending: 0 }) })
  const base = await listen(h.server)
  await post(base, '/seat/join', { token: h.agentToken, handle: 'ana-agent' })
  await post(base, '/seat/reply', { token: h.agentToken, text: 'found three places' })

  // Without this the brief stops reflecting anything agents do, and the
  // anti-drift property the whole design leans on quietly stops working.
  const seen = h.noted.filter(n => n.kind === 'message').map(n => n.text)
  assert.ok(seen.some(t => /found three places/.test(t)))
  done(h)
})

test('the observer sees a seat turn closing, with its tools', async () => {
  const h = harness({}, { brief: () => ({ text: '', ageS: 0, pending: 0 }) })
  const base = await listen(h.server)
  // A seat is only "online" (Queue.submit's gate) while its own SSE feed is
  // open, and Stop only closes something TurnLog actually opened — so, like
  // the single-session equivalent in web.test.mjs ("a closed turn is fed to
  // the observer..."), the turn has to be opened for real via an addressed
  // /msg rather than skipping straight to the hooks.
  const feed = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent find the TTL' })
  await feed.next() // drain the resulting turn event so it doesn't dangle
  await post(base, '/seat/hook/PreToolUse', { token: h.agentToken, prompt_id: 'p1', tool_name: 'Grep' })
  await post(base, '/seat/hook/Stop', { token: h.agentToken, prompt_id: 'p1', transcript_path: '/nope' })
  const turn = h.noted.find(n => n.kind === 'turn')
  assert.ok(turn, 'expected a turn event')
  assert.deepEqual(turn.tools, ['Grep'])
  feed.close()
  done(h)
})

/**
 * The turn note above carries the tools a seat used; this is the other half —
 * what it actually said. The observer builds its note from `closed.replies`,
 * which only gets filled if /seat/reply attaches the reply to the seat's open
 * turn. It did not, so every seat turn reached the observer with an empty
 * reply: the component whose entire job is tracking the conversation could see
 * that a seat ran Grep but never what it concluded.
 */
test('a seat turn reaches the observer with what the seat actually said', async () => {
  const h = harness({}, { brief: () => ({ text: '', ageS: 0, pending: 0 }) })
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent find the TTL' })
  await feed.next()
  await post(base, '/seat/reply', { token: h.agentToken, text: 'the TTL is 900 seconds' })
  await post(base, '/seat/hook/Stop', { token: h.agentToken, prompt_id: 'p1', transcript_path: '/nope' })

  const turn = h.noted.find(n => n.kind === 'turn')
  assert.ok(turn, 'expected a turn event')
  assert.match(turn.reply, /900 seconds/, 'the observer must see the seat\'s answer, not an empty string')
  feed.close()
  done(h)
})

test('a seat reply is attached to its own turn, so the UI can show it', async () => {
  const h = harness({}, { brief: () => ({ text: '', ageS: 0, pending: 0 }) })
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent find the TTL' })
  await feed.next()
  await post(base, '/seat/reply', { token: h.agentToken, text: 'the TTL is 900 seconds' })

  // Scoped to this seat's own destination, exactly like its hooks - a reply
  // must never land on another seat's (or the local channel's) open turn.
  const turn = h.turns.openTurn('ana-agent')
  assert.ok(turn, 'expected an open turn for this seat')
  assert.equal(turn.replies.length, 1)
  assert.match(turn.replies[0].text, /900 seconds/)
  feed.close()
  done(h)
})

// Each seat compacts its own context independently, so two seats' recollections
// of the same conversation drift apart and neither knows. The brief is
// regenerated from the room's own record, never from any seat's context, so
// injecting it immediately before an addressed turn is what re-synchronises
// them — exactly what web.mjs's drain() already does for the local channel via
// channel.notifyBrief. Without this, seats drift permanently.
test("a seat's feed carries the current brief immediately ahead of its turn", async () => {
  const h = harness({}, { brief: () => ({ text: 'threads:\n - TTL fix (open)', ageS: 4, pending: 1 }) })
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent find the TTL' })

  const first = await feed.next()
  assert.equal(first.event, 'brief')
  assert.match(first.data.text, /TTL fix/)
  assert.equal(first.data.ageS, 4)
  assert.equal(first.data.pending, 1)

  const second = await feed.next()
  assert.equal(second.event, 'turn')
  assert.equal(second.data.messages[0].content, '@ana-agent find the TTL')

  feed.close()
  done(h)
})
