import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeSeat, opencodeSeatArgs } from '../src/opencode.mjs'
import { startFakeOpencode } from './helpers/fake-opencode.mjs'

const settle = () => new Promise(r => setTimeout(r, 50))

/**
 * Tear the fake server and the seat down however the test ends.
 *
 * An assertion failure used to leave the server and its SSE feeds open, so a
 * FAILING test hung `node --test` instead of going red — confirmed during
 * review. Registering the teardown before the first assertion is what makes
 * the failure visible.
 */
async function fakeOpencode(t) {
  const oc = await startFakeOpencode()
  let seat = null
  t.after(async () => {
    seat?.stop()
    await oc.close()
  })
  return { oc, hold: s => { seat = s; return s } }
}

test('the driver registers the reply-only bridge with opencode when it connects', async t => {
  // The bridge is what lets opencode call room_reply. Registering it in
  // reply-only mode is what stops it claiming the handle the driver holds.
  const { oc, hold } = await fakeOpencode(t)
  const roomCalls = []
  const seat = hold(createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: oc.url,
    fetchImpl: async (url, init) => {
      if (String(url).startsWith(oc.url)) return fetch(url, init)
      roomCalls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ seed: null }) }
    },
  }))
  await seat.connect()
  await settle()

  assert.equal(oc.mcp.length, 1)
  const cfg = oc.mcp[0]
  assert.equal(cfg.name, 'room')
  assert.equal(cfg.config.environment.ROOM_SEAT_MODE, 'reply-only')
  assert.equal(cfg.config.environment.ROOM_SEAT_TOKEN, 'tok')
  assert.ok(roomCalls.some(u => u.includes('/seat/join')), 'the driver joins the room itself')
})

test('an idle arriving over the real event stream ends the room turn', async t => {
  // End to end over an actual socket: the pure mapper tests prove the
  // decision, this proves the wiring that delivers it.
  const { oc, hold } = await fakeOpencode(t)
  const stops = []
  const seat = hold(createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: oc.url,
    fetchImpl: async (url, init) => {
      const u = String(url)
      if (u.startsWith(oc.url)) return fetch(url, init)
      if (u.includes('/seat/hook/Stop')) stops.push(u)
      return { ok: true, status: 200, json: async () => ({ seed: null }) }
    },
  }))
  await seat.connect()
  await settle()

  await seat.onRoomEvent({
    event: 'turn',
    data: { room: 'room', messages: [{ name: 'heet', memberId: 'm', id: 'i', content: 'go' }] },
  })
  assert.equal(oc.prompts.length, 1)

  oc.emit('session.idle', { sessionID: 'ses_fake' })
  await settle()
  assert.equal(stops.length, 1)
})

test('a refused bridge registration fails the connect instead of producing a silent seat', async () => {
  // Ignoring this response left a seat that joins the room, accepts turns and
  // can never reply: the same silent-seat failure c3b17e6 fixed, through
  // another door and without even a log line to find it by.
  const calls = []
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: async url => {
      calls.push(String(url))
      if (String(url).endsWith('/mcp')) return { ok: false, status: 503, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ seed: null }) }
    },
  })
  await assert.rejects(() => seat.connect({ bridgePath: '/seat.mjs' }), /bridge.*503/)
  assert.ok(!calls.some(u => u.includes('/seat/join')), 'a seat that cannot reply must not join the room')
  seat.stop()
})

test('a refused prompt closes the turn immediately rather than burning the whole deadline', async () => {
  // A rejected prompt_async left `turn` armed, so the room waited out the full
  // 300s and was then told "no response after 300s" — the stall message — for
  // a request that was refused in milliseconds.
  const said = []
  const stops = []
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl: async (url, init) => {
      const u = String(url)
      if (u.includes('prompt_async')) return { ok: false, status: 400, json: async () => ({}) }
      if (u.includes('/seat/reply')) said.push(JSON.parse(init.body).text)
      if (u.includes('/seat/hook/Stop')) stops.push(u)
      return { ok: true, status: 200, json: async () => ({ id: 'ses_fake', seed: null }) }
    },
  })
  await seat.onRoomEvent({
    event: 'turn',
    data: { room: 'room', messages: [{ name: 'heet', memberId: 'm', id: 'i', content: 'go' }] },
  })
  assert.equal(seat.busy(), false, 'the turn must not stay armed')
  assert.equal(stops.length, 1, 'the room destination must be freed')
  assert.match(said.join('\n'), /400/, 'and the room must be told the real reason, not the stall message')
  seat.stop()
})

/** A controllable clock: nothing fires until the test says so. Same shape as test/opencode-stall.test.mjs's. */
function clock() {
  let next = 1
  const timers = new Map()
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimer: id => timers.delete(id),
    fireAll() {
      const due = [...timers.values()]
      timers.clear()
      for (const t of due) t.fn()
    },
  }
}

test('a stopped seat stays stopped, even when both feeds are mid-backoff at once', async () => {
  // Each feed schedules its own reconnect on failure. If that reconnect state
  // were shared between the room feed and the opencode feed, whichever fails
  // SECOND overwrites the first's timer handle - stop() can then only cancel
  // the survivor, and the other fires anyway. For the room feed that is not a
  // leak: it re-opens GET /seat/events, bringing a stopped seat back online
  // and re-claiming its handle against a legitimate restart. Both feeds are
  // made to fail here specifically so both are mid-backoff at once - a
  // single failing feed can never exercise the overwrite.
  const c = clock()
  let roomJoins = 0
  let ocJoins = 0
  const fetchImpl = async url => {
    const u = String(url)
    if (u.includes('/seat/events')) { roomJoins++; throw new Error('room down') }
    if (u.endsWith('/event')) { ocJoins++; throw new Error('opencode down') }
    return { ok: true, status: 200, json: async () => ({ seed: null }) }
  }
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: 'http://oc',
    fetchImpl, setTimer: c.setTimer, clearTimer: c.clearTimer,
  })
  await seat.connect()
  await new Promise(r => setImmediate(r)) // let both feeds' first attempt reject and reschedule
  assert.equal(roomJoins, 1)
  assert.equal(ocJoins, 1)

  seat.stop()
  c.fireAll() // fire whatever reconnect timer(s) survived stop()
  await new Promise(r => setImmediate(r))

  assert.equal(roomJoins, 1, 'no room feed attempt may follow stop()')
  assert.equal(ocJoins, 1, 'no opencode feed attempt may follow stop()')
})

test('the launcher binds opencode to loopback, because it runs without a password', () => {
  // `opencode serve` has no auth unless OPENCODE_SERVER_PASSWORD is set. On a
  // tailnet-bound room, a tailnet-bound opencode would be an open shell.
  const { args } = opencodeSeatArgs({ port: 4096, cwd: '/repo/.worktrees/opencode' })
  assert.ok(args.includes('serve'))
  const i = args.indexOf('--hostname')
  assert.equal(args[i + 1], '127.0.0.1')
  assert.ok(args.includes('4096'))
})
