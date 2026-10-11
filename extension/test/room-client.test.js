// extension/test/room-client.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { roomRecipe, readOwnerToken, createRoomClient, roomDir, roomStateDir } = require('../src/room-client.js')

test('the room is launched standalone, because the extension owns its lifecycle', () => {
  // Not as an MCP child of Claude Code: the extension has to choose the port,
  // watch the health and restart it independently of any orchestrator.
  const r = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 4321, nodePath: 'node' })
  assert.equal(r.cmd, 'node')
  assert.ok(r.args[0].endsWith('server.mjs'))
  assert.equal(r.opts.env.ROOM_STANDALONE, '1')
  assert.equal(r.opts.env.ROOM_PORT, '4321')
  assert.equal(r.opts.env.ROOM_HOST, '127.0.0.1')
  assert.equal(r.opts.env.ROOM_STATE_DIR, '/state')
})

test('the owner token is read from room state, not scraped from stderr', () => {
  const readFile = () => JSON.stringify({
    members: [
      { id: '1', name: 'bot', role: 'member', token: 'nope' },
      { id: '2', name: 'heet', role: 'owner', token: 'owner-token' },
    ],
  })
  assert.equal(readOwnerToken('/state', { readFile }), 'owner-token')
})

test('a missing or unreadable state file yields null rather than throwing', () => {
  assert.equal(readOwnerToken('/state', { readFile: () => { throw new Error('ENOENT') } }), null)
  assert.equal(readOwnerToken('/state', { readFile: () => 'not json' }), null)
})

test('delegate posts the brief and returns the room verdict verbatim', () => {
  // The room already validates the brief and names the missing field; the
  // client must not paraphrase that, or the orchestrator cannot repair it.
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ ok: false, errors: ['spec.files is required'] }) }
  }
  const c = createRoomClient({ roomUrl: 'http://room', token: 'tok', fetchImpl })
  return c.delegate({ to: '@opencode', class: 'execution', task: 'x' }).then(r => {
    assert.match(calls[0].url, /\/api\/delegate/)
    assert.equal(calls[0].body.to, '@opencode')
    assert.deepEqual(r, { ok: false, errors: ['spec.files is required'] })
  })
})

test('a connection failure reports the real reason, not just "fetch failed"', () => {
  // Confirmed against a real Node fetch() to a closed port: the thrown
  // error's own .message is ALWAYS the unhelpful literal string "fetch
  // failed" -- the actual reason (ECONNREFUSED, a reset, a timeout) lives on
  // .cause, which String(err.message) silently drops on the floor.
  const err = new TypeError('fetch failed')
  err.cause = new Error('connect ECONNREFUSED 127.0.0.1:62953')
  const fetchImpl = async () => { throw err }
  const c = createRoomClient({ roomUrl: 'http://room', token: 't', fetchImpl })
  return c.delegate({ to: '@x', class: 'reasoning', task: 'y' }).then(r => {
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /ECONNREFUSED/)
  })
})

test('a non-ok HTTP response becomes a readable failure, not a thrown status', () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const c = createRoomClient({ roomUrl: 'http://room', token: 't', fetchImpl })
  return c.delegate({ to: '@x', class: 'reasoning', task: 'y' }).then(r => {
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /503/)
  })
})

// --- publishing, and the admin surface -------------------------------------

const { PUBLISHED_HOST } = require('../src/room-client.js')

test('the room binds loopback unless told otherwise', () => {
  const { opts } = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, env: {} })
  assert.equal(opts.env.ROOM_HOST, '127.0.0.1')
})

test('publishing binds every interface, on the same port and state dir', () => {
  // Verified against a real standalone room on 2026-09-08: same port and same
  // state dir means the owner token and the roster both survive the restart,
  // and 127.0.0.1 keeps serving -- so the orchestrator's MCP bridge never
  // notices and the chat is not torn down.
  const loopback = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, env: {} })
  const published = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, host: PUBLISHED_HOST, env: {} })
  assert.equal(published.opts.env.ROOM_HOST, '0.0.0.0')
  assert.equal(published.opts.env.ROOM_PORT, loopback.opts.env.ROOM_PORT)
  assert.equal(published.opts.env.ROOM_STATE_DIR, loopback.opts.env.ROOM_STATE_DIR)
})

test('an explicit advertise host overrides autodetection', () => {
  const r = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234, host: '0.0.0.0', advertise: 'https://abc-1234.devtunnels.ms' })
  assert.equal(r.opts.env.ROOM_ADVERTISE, 'https://abc-1234.devtunnels.ms')
})

test('no advertise option leaves ROOM_ADVERTISE unset, so the room autodetects as before', () => {
  const r = roomRecipe({ repoRoot: '/repo', stateDir: '/state', port: 1234 })
  assert.equal('ROOM_ADVERTISE' in r.opts.env, false)
})

test('adminState reads the roster', async () => {
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1',
    token: 'tok',
    fetchImpl: async url => {
      assert.match(String(url), /\/api\/admin\/state\?token=tok/)
      return { ok: true, json: async () => ({ ok: true, members: [{ name: 'ana', role: 'member' }] }) }
    },
  })
  const state = await client.adminState()
  assert.equal(state.members[0].name, 'ana')
})

test('adminState returns null on failure rather than a half-empty roster', async () => {
  // A roster that renders as "nobody is here" when the call merely failed is
  // worse than one that does not render.
  const offline = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(await offline.adminState(), null)

  const forbidden = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  })
  assert.equal(await forbidden.adminState(), null)
})

test('invite posts a name and a role and returns the join link', async () => {
  let body = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/api\/admin\/invite/)
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ ok: true, joinUrl: 'http://100.1.2.3:1/?token=x' }) }
    },
  })
  const r = await client.invite({ name: 'ana', role: 'member' })
  assert.deepEqual(body, { name: 'ana', role: 'member' })
  assert.equal(r.joinUrl, 'http://100.1.2.3:1/?token=x')
})

test('a failed admin call reports the failure instead of pretending it worked', async () => {
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  })
  const r = await client.invite({ name: 'ana', role: 'member' })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /403/)
})

test('rotate and remove name the member they act on', async () => {
  const calls = []
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      calls.push([String(url), JSON.parse(init.body)])
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  await client.rotate('m1')
  await client.remove('m2')
  assert.match(calls[0][0], /\/api\/admin\/rotate/)
  assert.deepEqual(calls[0][1], { memberId: 'm1' })
  assert.match(calls[1][0], /\/api\/admin\/remove/)
  assert.deepEqual(calls[1][1], { memberId: 'm2' })
})

test('joinLink asks for an existing member\'s link by id, not a fresh invite', async () => {
  const calls = []
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      calls.push([String(url), JSON.parse(init.body)])
      return { ok: true, json: async () => ({ ok: true, joinUrl: 'https://x/?token=T' }) }
    },
  })
  const r = await client.joinLink('m1')
  assert.match(calls[0][0], /\/api\/admin\/joinLink/)
  assert.deepEqual(calls[0][1], { memberId: 'm1' })
  assert.equal(r.joinUrl, 'https://x/?token=T')
})

test('addressing a seat goes through the room, mentioning it by handle', async () => {
  // /msg is the room's normal path, which is what makes this QUEUE behind
  // whatever the seat is already doing rather than interrupting it.
  let sent = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) }
      return { ok: true, json: async () => ({ ok: true, addressed: true }) }
    },
  })
  await client.say('worker-1', 'also cover the empty case')
  assert.match(sent.url, /\/msg\?/)
  assert.equal(sent.body.text, '@worker-1 also cover the empty case')
})

// --- worker provisioning, which the room owns ------------------------------

test('spawning a worker asks the room, because the room owns worker processes', async () => {
  // The extension used to mint a seat and spawn the launcher itself. The room
  // does both now (robustness spec §1), so this is one POST and the room's
  // verdict comes back verbatim -- exactly like delegate.
  let sent = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) }
      return { ok: true, json: async () => ({ ok: true, handle: 'worker-1' }) }
    },
  })
  const r = await client.spawnWorker({ model: 'opencode/mimo-v2.5-free' })
  assert.match(sent.url, /\/api\/spawn-worker\?token=tok/)
  assert.deepEqual(sent.body, { model: 'opencode/mimo-v2.5-free' })
  assert.equal(r.handle, 'worker-1')
})

test('no model means the room picks its own default, not a pinned one', async () => {
  // Sending `model: null` would pin whatever the extension happened to think
  // the default was. An absent field lets the room's own default win.
  let body = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ ok: true, handle: 'worker-1' }) }
    },
  })
  await client.spawnWorker()
  assert.deepEqual(body, {})
})

test('a refused spawn reports the room errors rather than pretending it worked', async () => {
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  const r = await client.spawnWorker({ model: null })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /503/)
})

test('stopping a worker names the handle the room should reap', async () => {
  let sent = null
  const client = createRoomClient({
    roomUrl: 'http://127.0.0.1:1', token: 'tok',
    fetchImpl: async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) }
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  const r = await client.stopWorker('worker-2')
  assert.match(sent.url, /\/api\/stop-worker/)
  assert.deepEqual(sent.body, { handle: 'worker-2' })
  assert.equal(r.ok, true)
})

test('from a checkout the room is the repo next to the extension, even if a bundle exists', () => {
  const ext = path.join('/repo', 'extension')
  const exists = p => p === path.join('/repo', 'src', 'server.mjs') || p === path.join(ext, 'room', 'src', 'server.mjs')
  assert.equal(roomDir(ext, exists), path.join('/repo'))
})

test('installed, the room is the copy bundled inside the extension', () => {
  const ext = path.join('/home/u/.cursor/extensions', 'claude-room.claude-room-orchestrator-0.0.2')
  assert.equal(roomDir(ext, () => false), path.join(ext, 'room'))
})

test('the room is told which repo workers work in, and only when there is one', () => {
  const withRepo = roomRecipe({ repoRoot: '/room', stateDir: '/s', port: 1, env: {}, workRepo: '/proj' })
  assert.equal(withRepo.opts.env.ROOM_REPO, '/proj')
  assert.equal(withRepo.opts.cwd, '/room')
  const without = roomRecipe({ repoRoot: '/room', stateDir: '/s', port: 1, env: {} })
  assert.equal('ROOM_REPO' in without.opts.env, false)
})

test('each workspace gets its own room state, so two windows never share one roster', () => {
  // Two windows on two folders run two rooms; on one members.json the last
  // writer wins and each room's owner token goes stale under the other.
  const ctx = folder => ({
    storageUri: { fsPath: path.join('/ws', folder) },
    globalStorageUri: { fsPath: '/global' },
  })
  assert.equal(roomStateDir(ctx('a')), path.join('/ws', 'a', 'room-state'))
  assert.notEqual(roomStateDir(ctx('a')), roomStateDir(ctx('b')))
})

test('with no folder open there is no workspace storage, so the room falls back to global', () => {
  assert.equal(roomStateDir({ storageUri: undefined, globalStorageUri: { fsPath: '/global' } }), path.join('/global', 'room-state'))
})

test('with no folder open the room is told to refuse workers, and with one it is not', () => {
  const without = roomRecipe({ repoRoot: '/room', stateDir: '/s', port: 1, env: {} })
  assert.equal(without.opts.env.ROOM_WORKERS, 'off')
  assert.equal(roomRecipe({ repoRoot: '/room', stateDir: '/s', port: 1, env: {}, workRepo: '' }).opts.env.ROOM_WORKERS, 'off')
  const withRepo = roomRecipe({ repoRoot: '/room', stateDir: '/s', port: 1, env: {}, workRepo: '/proj' })
  assert.equal('ROOM_WORKERS' in withRepo.opts.env, false)
})
