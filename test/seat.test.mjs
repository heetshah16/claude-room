import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { seatNotification, createSeat } from '../src/seat.mjs'

test('a turn event becomes a channel notification with verbatim content', () => {
  const n = seatNotification({
    event: 'turn',
    data: { messages: [{ name: 'ana', content: '@ana-agent go', memberId: 'u1', id: 'm1' }], batch: 1 },
  })
  assert.equal(n.method, 'notifications/claude/channel')
  assert.equal(n.params.content, '@ana-agent go')
  assert.equal(n.params.meta.user, 'ana')
  assert.equal(n.params.meta.kind, undefined)   // a turn is not tagged
})

test('a mirror event is tagged so the agent knows it is context, not a request', () => {
  const n = seatNotification({ event: 'mirror', data: { text: 'heet-agent: found three', from: 'heet-agent' } })
  assert.equal(n.params.meta.kind, 'mirror')
  assert.equal(n.params.meta.user, undefined)   // never attributed to a person
})

test('a brief event keeps its age and pending attributes', () => {
  const n = seatNotification({ event: 'brief', data: { text: 'forks:\n - x', ageS: 3, pending: 2 } })
  assert.equal(n.params.meta.kind, 'brief')
  assert.equal(n.params.meta.age_s, '3')
  assert.equal(n.params.meta.pending, '2')
})

test('a seed event arrives as its own tagged block', () => {
  const n = seatNotification({ event: 'seed', data: { text: 'decisions:\n - keep auth stateless' } })
  assert.equal(n.params.meta.kind, 'seed')
  assert.match(n.params.content, /keep auth stateless/)
})

test('an unknown event yields nothing rather than a malformed notification', () => {
  assert.equal(seatNotification({ event: 'nonsense', data: {} }), null)
  assert.equal(seatNotification({ event: 'turn', data: { messages: [] } }), null)
})

test('every emitted meta key is a legal identifier', () => {
  const n = seatNotification({ event: 'mirror', data: { text: 'x', from: 'y' } })
  for (const k of Object.keys(n.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/)
})

// Regression: createSeat used to take `EventSourceImpl = EventSource` as a
// default parameter, and Node 22 does not expose EventSource as a global
// without --experimental-eventsource. That threw a synchronous
// ReferenceError before the MCP Server was even constructed, so every real
// seat - which never passes an override - failed outright, with an error
// that named nothing useful. This exercises the exact path a real seat
// takes: no fetchImpl override, a real local HTTP server standing in for
// the room, nothing but stock Node 22.
test('createSeat constructs and connects on stock Node 22, with no injected transport override', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/seat/join') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ seatId: 's1', seed: { text: 'welcome to the room' } }))
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/seat/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      return // left open; the seat's own SSE reader stays attached to it
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  // Constructing must not throw - that is the exact regression.
  const seat = createSeat({ roomUrl: `http://127.0.0.1:${port}`, token: 't', handle: 'ana-agent' })

  const notifs = []
  seat.mcp.notification = async n => { notifs.push(n) }

  await seat.connect()

  // The join response's seed reached the agent as a tagged notification -
  // proof the default fetch-based join + feed path actually ran end to end.
  assert.equal(notifs.length, 1)
  assert.equal(notifs[0].params.meta.kind, 'seed')
  assert.match(notifs[0].params.content, /welcome to the room/)

  seat.stop()
  await seat.mcp.close()
  await new Promise(resolve => server.close(resolve))
})
