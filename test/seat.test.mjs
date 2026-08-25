import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seatNotification } from '../src/seat.mjs'

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
