import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeSeat } from '../src/opencode.mjs'

/** A controllable clock: nothing fires until the test says so. */
function clock() {
  let next = 1
  const timers = new Map()
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimer: id => timers.delete(id),
    pending: () => timers.size,
    fireAll() {
      const due = [...timers.values()]
      timers.clear()
      for (const t of due) t.fn()
    },
  }
}

function recorder() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null })
    if (u.endsWith('/session')) return { ok: true, status: 200, json: async () => ({ id: 'ses_a' }) }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  return { calls, fetchImpl, find: re => calls.filter(c => re.test(c.url)) }
}

const turn = { event: 'turn', data: { room: 'room', messages: [{ name: 'heet', memberId: 'm', id: 'i', content: 'go' }] } }

test('a session that never idles is aborted and its room turn is closed anyway', async () => {
  // The exact probe failure: the model stalled mid tool-loop, stayed "busy"
  // forever, and emitted nothing. Without this the destination never drains.
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl, setTimer: c.setTimer, clearTimer: c.clearTimer, turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  assert.equal(seat.busy(), true)

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))

  assert.equal(r.find(/\/abort$/).length, 1, 'the stalled session must be aborted')
  assert.equal(r.find(/\/seat\/hook\/Stop/).length, 1, 'the room queue must drain')
  assert.equal(r.find(/\/seat\/reply/).length, 1, 'the room must be told, not left guessing')
  assert.equal(seat.busy(), false)
})

test('a provider retrying in a loop does NOT get its deadline reset', async () => {
  // A model retrying a 502 forever is stalled, not working. Treating retry as
  // progress would mean the deadline never fires.
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl, setTimer: c.setTimer, clearTimer: c.clearTimer, turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  const armed = c.pending()

  for (let i = 1; i <= 3; i++) {
    await seat.onOpencodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'retry', attempt: i } },
    })
  }
  assert.equal(c.pending(), armed, 'retry must not arm a fresh deadline')

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))
  assert.equal(r.find(/Stop/).length, 1, 'the retrying turn still times out')
})

test('a turn that finishes normally disarms its deadline', async () => {
  // Otherwise a later deadline would fire against a turn that already ended
  // and abort a session that had moved on to the next one.
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl, setTimer: c.setTimer, clearTimer: c.clearTimer, turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
  assert.equal(c.pending(), 0, 'a finished turn must leave no timer behind')

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))
  assert.equal(r.find(/\/abort$/).length, 0, 'nothing should be aborted after a clean finish')
})

test('a deadline that fires for an already-finished turn does nothing', async () => {
  const c = clock()
  const r = recorder()
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: r.fetchImpl,
    // A timer that ignores clearing, to simulate the race where a deadline is
    // already on the callback queue when the turn ends.
    setTimer: fn => { c.setTimer(fn, 0); return 'stuck' },
    clearTimer: () => {},
    turnTimeoutMs: 1000,
  })
  await seat.onRoomEvent(turn)
  await seat.onOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })

  c.fireAll()
  await new Promise(r2 => setImmediate(r2))
  assert.equal(r.find(/Stop/).length, 1, 'the turn must be ended exactly once')
})
