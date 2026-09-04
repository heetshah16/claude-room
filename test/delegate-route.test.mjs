import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done } from './helpers/room.mjs'

test('an owner can delegate over HTTP, which is how the orchestrator reaches the room', async () => {
  const calls = []
  const h = harness({}, null, { onDelegate: input => { calls.push(input); return { ok: true, id: 'del-1' } } })
  const base = await listen(h.server)
  const res = await post(base, `/api/delegate?token=${h.ownerToken}`, {
    to: '@opencode', class: 'execution', task: 'add mul()',
    spec: { files: ['math.js'], tests: ['npm test'] },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, id: 'del-1' })
  assert.equal(calls[0].to, '@opencode')
  done(h)
})

test('the room verdict travels verbatim, so a thin brief names its missing field', async () => {
  const h = harness({}, null, {
    onDelegate: () => ({ ok: false, errors: ['spec.files is required for execution'] }),
  })
  const base = await listen(h.server)
  const res = await post(base, `/api/delegate?token=${h.ownerToken}`, { to: '@x', class: 'execution', task: 'y' })
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.errors[0], /spec\.files/)
  done(h)
})

test('a non-owner cannot delegate, because delegation spends someone else\'s seat', async () => {
  const h = harness({}, null, { onDelegate: () => ({ ok: true, id: 'x' }) })
  const base = await listen(h.server)
  const res = await post(base, `/api/delegate?token=${h.anaToken}`, { to: '@x', class: 'reasoning', task: 'y' })
  assert.equal(res.status, 403)
  done(h)
})

test('an unauthenticated delegate is refused', async () => {
  const h = harness({}, null, { onDelegate: () => ({ ok: true, id: 'x' }) })
  const base = await listen(h.server)
  const res = await post(base, '/api/delegate?token=nope', { to: '@x', class: 'reasoning', task: 'y' })
  assert.equal(res.status, 401)
  done(h)
})
