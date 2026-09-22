/**
 * The HTTP mirror of spawn_worker, and its stop.
 *
 * The extension may run a standalone room with no channel session at all, so
 * without these it has no way to reach the fleet and keeps its own duplicate
 * spawn logic. Owner-only for the same reason POST /api/delegate is: this puts
 * a process on somebody's machine and a seat on the room's roster.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done } from './helpers/room.mjs'

test('an owner can spawn a worker over HTTP, which is how a standalone room grows', async () => {
  const calls = []
  const h = harness({}, null, {
    onSpawnWorker: async body => { calls.push(body); return { ok: true, handle: 'worker-1' } },
  })
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.ownerToken}`, { model: 'opencode/x' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, handle: 'worker-1' })
  assert.deepEqual(calls, [{ model: 'opencode/x' }])
  done(h)
})

test('the spawn verdict travels verbatim, so a failure names what actually went wrong', async () => {
  const h = harness({}, null, {
    onSpawnWorker: async () => ({ ok: false, errors: ['could not start worker-1: EINVAL'] }),
  })
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.ownerToken}`, {})
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.errors[0], /EINVAL/)
  done(h)
})

test('a non-owner cannot spawn a worker, because it puts a process on the host', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.anaToken}`, {})
  assert.equal(res.status, 403)
  done(h)
})

test('an unauthenticated spawn is refused', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await post(base, '/api/spawn-worker?token=nope', {})
  assert.equal(res.status, 401)
  done(h)
})

test('a room with no fleet wired says so rather than answering as if it spawned one', async () => {
  const h = harness()
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.ownerToken}`, {})
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.errors[0], /not enabled/)
  done(h)
})

test('an owner can stop a worker by handle', async () => {
  const calls = []
  const h = harness({}, null, { onStopWorker: async body => { calls.push(body); return { ok: true } } })
  const base = await listen(h.server)
  const res = await post(base, `/api/stop-worker?token=${h.ownerToken}`, { handle: 'worker-1' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(calls, [{ handle: 'worker-1' }])
  done(h)
})

test('a non-owner cannot stop a worker, because that is somebody else\'s work in flight', async () => {
  const h = harness({}, null, { onStopWorker: async () => ({ ok: true }) })
  const base = await listen(h.server)
  const res = await post(base, `/api/stop-worker?token=${h.anaToken}`, { handle: 'worker-1' })
  assert.equal(res.status, 403)
  done(h)
})

test('a malformed body is a 400, not a 500', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await fetch(`${base}/api/spawn-worker?token=${h.ownerToken}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  })
  assert.equal(res.status, 400)
  done(h)
})

test('an oversized body is refused rather than buffered, same as every other route', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await fetch(`${base}/api/spawn-worker?token=${h.ownerToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(1024 * 1024 + 16),
  }).catch(() => ({ status: 413 })) // the socket may be destroyed mid-send
  assert.equal(res.status, 413)
  done(h)
})
