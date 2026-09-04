import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeSeat, opencodeSeatArgs } from '../src/opencode.mjs'
import { startFakeOpencode } from './helpers/fake-opencode.mjs'

const settle = () => new Promise(r => setTimeout(r, 50))

test('the driver registers the reply-only bridge with opencode when it connects', async () => {
  // The bridge is what lets opencode call room_reply. Registering it in
  // reply-only mode is what stops it claiming the handle the driver holds.
  const oc = await startFakeOpencode()
  const roomCalls = []
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: oc.url,
    fetchImpl: async (url, init) => {
      if (String(url).startsWith(oc.url)) return fetch(url, init)
      roomCalls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ seed: null }) }
    },
  })
  await seat.connect()
  await settle()

  assert.equal(oc.mcp.length, 1)
  const cfg = oc.mcp[0]
  assert.equal(cfg.name, 'room')
  assert.equal(cfg.config.environment.ROOM_SEAT_MODE, 'reply-only')
  assert.equal(cfg.config.environment.ROOM_SEAT_TOKEN, 'tok')
  assert.ok(roomCalls.some(u => u.includes('/seat/join')), 'the driver joins the room itself')

  seat.stop()
  await oc.close()
})

test('an idle arriving over the real event stream ends the room turn', async () => {
  // End to end over an actual socket: the pure mapper tests prove the
  // decision, this proves the wiring that delivers it.
  const oc = await startFakeOpencode()
  const stops = []
  const seat = createOpenCodeSeat({
    roomUrl: 'http://room', token: 'tok', handle: 'opencode', opencodeUrl: oc.url,
    fetchImpl: async (url, init) => {
      const u = String(url)
      if (u.startsWith(oc.url)) return fetch(url, init)
      if (u.includes('/seat/hook/Stop')) stops.push(u)
      return { ok: true, status: 200, json: async () => ({ seed: null }) }
    },
  })
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

  seat.stop()
  await oc.close()
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
