import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bootRoom } from './helpers/room.mjs'

test('the server boots, serves the UI, and writes nothing to stdout but MCP traffic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roomsmoke-'))
  // Port 0 lets the OS pick, so a stray server left over from an earlier run
  // can never make this test answer against the wrong process.
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, ROOM_STATE_DIR: dir, ROOM_PORT: '0', ROOM_HOST: '127.0.0.1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })

  // Poll rather than sleep a fixed amount, so a slow machine does not flake.
  let body = null
  let port = null
  for (let i = 0; i < 60 && body === null; i++) {
    await new Promise(r => setTimeout(r, 100))
    port ??= stderr.match(/listening on http:\/\/[^:]+:(\d+)/)?.[1]
    if (!port) continue
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) body = await res.text()
    } catch {
      // not listening yet
    }
  }

  assert.ok(body, `server never came up. stderr:\n${stderr}`)
  assert.match(body, /<!doctype html>/i)
  assert.match(stderr, /listening on/)
  assert.match(stderr, /join: http/)

  // Any non-JSON-RPC byte on stdout corrupts the MCP stdio transport.
  const stray = stdout.split('\n').filter(l => l.trim() && !l.trimStart().startsWith('{'))
  assert.deepEqual(stray, [], `stray stdout would corrupt the MCP transport: ${JSON.stringify(stray)}`)

  child.kill()
  rmSync(dir, { recursive: true, force: true })
})

test('the room runs standalone, with no Claude Code parent', async () => {
  // It used to be an MCP stdio child, which is how it knew a session was alive.
  // With several seats that no longer holds, so it must stand on its own.
  const { port, child, stderr } = await bootRoom({ ROOM_STANDALONE: '1' })
  const res = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(res.status, 200)
  assert.match(stderr(), /listening on/)
  child.kill()
})

test('seat liveness is reported in room state', async () => {
  const { port, ownerToken, child } = await bootRoom({ ROOM_STANDALONE: '1' })
  const s = await (await fetch(`http://127.0.0.1:${port}/api/state?token=${ownerToken}`)).json()
  assert.ok(Array.isArray(s.seats))
  child.kill()
})

test('an agent member left over from before this boot is pruned, freeing its handle', async () => {
  // A worker's process is a child of the room's own PID and dies with it --
  // killTree kills the whole tree -- so any agent member already on disk when
  // a room boots cannot have a live process behind it. It is either this
  // room's own prior incarnation's worker or an even older orphan; either way
  // it must not sit there forever as a permanently stale "member" occupying a
  // handle nothing can ever restart under.
  const dir = mkdtempSync(join(tmpdir(), 'roomreap-'))
  const ownerId = randomUUID()
  writeFileSync(join(dir, 'members.json'), JSON.stringify([
    { id: ownerId, name: 'owner', role: 'owner', canApprove: false, muted: false, token: 'owner-tok' },
    {
      id: randomUUID(), name: 'worker-1', role: 'member', canApprove: false, muted: false,
      token: 'w1-tok', kind: 'agent', handle: 'worker-1', ownerId, delegatable: true,
    },
  ]))

  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, ROOM_STATE_DIR: dir, ROOM_PORT: '0', ROOM_HOST: '127.0.0.1', ROOM_STANDALONE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', d => { err += d })

  let port = null
  for (let i = 0; i < 60 && !port; i++) {
    port = err.match(/listening on http:\/\/[^:]+:(\d+)/)?.[1]
    if (port) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (!port) throw new Error(`server never came up. stderr:\n${err}`)

  const s = await (await fetch(`http://127.0.0.1:${port}/api/state?token=owner-tok`)).json()
  assert.equal(s.members.some(m => m.name === 'worker-1'), false, 'the stale worker must be gone')
  assert.equal(s.members.some(m => m.name === 'owner'), true, 'the owner is untouched')

  child.kill()
  rmSync(dir, { recursive: true, force: true })
})
