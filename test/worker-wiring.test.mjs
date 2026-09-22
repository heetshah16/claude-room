/**
 * The fleet and verification, wired into a real booted room.
 *
 * Deliberately never asks a real room to actually spawn a worker: that would
 * launch `opencode` and create a git worktree, which no test in this suite is
 * allowed to do. What is proved here is that the routes exist and are gated —
 * the behaviour behind them is covered by test/workers.test.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootRoom } from './helpers/room.mjs'

test('a booted room answers the worker routes rather than 404ing them', async () => {
  const room = await bootRoom({ ROOM_STANDALONE: '1' })
  try {
    const res = await fetch(`http://127.0.0.1:${room.port}/api/spawn-worker?token=nope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    // 401, not 404: the route is wired, and it refuses an unknown token before
    // it does anything that would put a process on the host.
    assert.equal(res.status, 401)

    const stop = await fetch(`http://127.0.0.1:${room.port}/api/stop-worker?token=nope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(stop.status, 401)
  } finally {
    room.child.kill()
  }
})

test('stopping a worker the room never started is refused by name, not by crashing', async () => {
  const room = await bootRoom({ ROOM_STANDALONE: '1' })
  try {
    const res = await fetch(`http://127.0.0.1:${room.port}/api/stop-worker?token=${room.ownerToken}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'worker-9' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.match(body.errors[0], /worker-9/)
  } finally {
    room.child.kill()
  }
})
