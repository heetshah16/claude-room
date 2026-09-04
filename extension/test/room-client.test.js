// extension/test/room-client.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { roomRecipe, readOwnerToken, createRoomClient } = require('../src/room-client.js')

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

test('a non-ok HTTP response becomes a readable failure, not a thrown status', () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const c = createRoomClient({ roomUrl: 'http://room', token: 't', fetchImpl })
  return c.delegate({ to: '@x', class: 'reasoning', task: 'y' }).then(r => {
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /503/)
  })
})
