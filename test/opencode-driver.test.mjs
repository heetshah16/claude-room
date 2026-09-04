import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeSeat } from '../src/opencode.mjs'

/** A fetch stand-in that records calls and answers the routes the driver uses. */
function recorder({ sessionId = 'ses_a' } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: u, method: init.method ?? 'GET', body })
    if (u.endsWith('/session')) {
      return { ok: true, status: 200, json: async () => ({ id: sessionId }) }
    }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  return { calls, fetchImpl, find: re => calls.filter(c => re.test(c.url)) }
}

const seatOf = (r, over = {}) => createOpenCodeSeat({
  roomUrl: 'http://room', token: 'tok', handle: 'opencode',
  opencodeUrl: 'http://oc', fetchImpl: r.fetchImpl, ...over,
})

const turn = content => ({
  event: 'turn',
  data: { room: 'room', messages: [{ name: 'heet', memberId: 'm1', id: 'x', content }] },
})

test('a room turn becomes one prompt on a session the driver creates once', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('add a mul function'))
  await seat.onRoomEvent(turn('and a div function'))

  assert.equal(r.find(/\/session$/).length, 1, 'the session is created once and reused')
  const prompts = r.find(/prompt_async/)
  assert.equal(prompts.length, 2)
  assert.equal(prompts[0].body.parts[0].text, 'add a mul function')
  assert.deepEqual(prompts[0].body.model, { providerID: 'opencode', modelID: 'mimo-v2.5-free' })
})

test('mirrors ride along with the next turn rather than starting one of their own', async () => {
  // OpenCode has no inbox. Sending a mirror on its own would start a turn
  // nobody asked for, and bill a model for reading gossip.
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent({ event: 'mirror', data: { text: 'ana-agent finished the parser', from: 'ana-agent' } })
  assert.equal(r.find(/prompt_async/).length, 0, 'a mirror alone must not prompt')

  await seat.onRoomEvent(turn('now do the tests'))
  const sent = r.find(/prompt_async/)[0].body.parts[0].text
  assert.match(sent, /ana-agent finished the parser/)
  assert.match(sent, /now do the tests/)
  assert.ok(sent.indexOf('ana-agent finished') < sent.indexOf('now do the tests'),
    'context comes first, the request last')
})

test('idle closes the room turn by posting Stop, which is what drains the queue', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('do it'))
  assert.equal(seat.busy(), true)

  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  const stops = r.find(/\/seat\/hook\/Stop/)
  assert.equal(stops.length, 1)
  assert.equal(seat.busy(), false)
})

test('every Stop for one turn quotes one id, so a redelivered idle cannot double-charge', async () => {
  // ledger.record is idempotent per promptId. A reconnect that replays
  // session.idle must not be billed twice.
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('do it'))
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })

  const stops = r.find(/\/seat\/hook\/Stop/)
  assert.equal(stops.length, 1, 'a second idle for a turn already ended is ignored')
  assert.ok(stops[0].body.prompt_id, 'the Stop must carry an id for ledger idempotency')
})

test('an idle with no turn in flight is ignored, so a stray event cannot end nothing', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  assert.equal(r.find(/Stop/).length, 0)
})

test('a session error ends the turn and says so in the room', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('do it'))
  await seat.onOpencodeEvent({
    type: 'session.error',
    properties: { sessionID: 'ses_a', error: { name: 'ProviderAuthError' } },
  })
  assert.equal(r.find(/Stop/).length, 1, 'the queue must drain even on failure')
  const said = r.find(/\/seat\/reply/)
  assert.equal(said.length, 1, 'a failure the room cannot see is a seat that just went quiet')
  assert.match(said[0].body.text, /ProviderAuthError/)
})

test('a session that cannot be created still closes the room turn, or the seat wedges forever', async () => {
  // The room marks the destination busy on dispatch. Nothing else will clear
  // it: abandonTurn only fires on a dropped feed, and the feed is fine here.
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null })
    if (u.endsWith('/session')) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode',
    opencodeUrl: 'http://oc', fetchImpl,
  })
  await seat.onRoomEvent(turn('do it'))

  assert.equal(calls.filter(c => /\/seat\/hook\/Stop/.test(c.url)).length, 1, 'the queue must drain')
  assert.equal(calls.filter(c => /\/seat\/reply/.test(c.url)).length, 1, 'the room must be told')
  assert.equal(seat.busy(), false)
})

test('a prompt that cannot be delivered closes the turn too, without waiting for the deadline', async () => {
  let n = 0
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u })
    if (u.endsWith('/session')) return { ok: true, status: 200, json: async () => ({ id: 'ses_a' }) }
    if (u.includes('prompt_async') && n++ === 0) throw new Error('socket hang up')
    return { ok: true, status: 204, json: async () => ({}) }
  }
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode',
    opencodeUrl: 'http://oc', fetchImpl,
  })
  await seat.onRoomEvent(turn('do it'))

  assert.equal(calls.filter(c => /\/seat\/hook\/Stop/.test(c.url)).length, 1)
  assert.equal(seat.busy(), false)
})

test('two turns in succession each close exactly once', async () => {
  const r = recorder()
  const seat = seatOf(r)
  await seat.onRoomEvent(turn('first'))
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  await seat.onRoomEvent(turn('second'))
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })

  assert.equal(r.find(/\/seat\/hook\/Stop/).length, 2, 'one Stop per turn, no more')
  assert.equal(seat.busy(), false)
})

test('a finish that resumes after its turn was replaced must not end the replacement', async () => {
  // The real interleaving: the error branch suspends inside say() while a
  // concurrent idle finishes turn A and the room dispatches turn B. Without
  // the ownership guard in finish(), the resuming branch clears B's timer and
  // ends B while B's prompt is still live in OpenCode.
  let releaseReply
  const held = new Promise(resolve => { releaseReply = resolve })
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('/session')) return { ok: true, status: 200, json: async () => ({ id: 'ses_a' }) }
    if (u.includes('/seat/reply')) {
      await held
      return { ok: true, status: 200, json: async () => ({}) }
    }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode',
    opencodeUrl: 'http://oc', fetchImpl,
  })

  await seat.onRoomEvent(turn('first'))

  // Deliberately NOT awaited: this suspends inside say() and resumes at the end.
  const errorBranch = seat.onOpencodeEvent({
    type: 'session.error',
    properties: { sessionID: 'ses_a', error: { name: 'UnknownError' } },
  })

  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  await seat.onRoomEvent(turn('second'))
  assert.equal(seat.busy(), true, 'the replacement turn is live')

  releaseReply()
  await errorBranch

  assert.equal(seat.busy(), true, 'the stale finish must not have ended the replacement turn')
  assert.equal(
    calls.filter(u => /\/seat\/hook\/Stop/.test(u)).length, 1,
    'only the first turn was ever closed',
  )
})
