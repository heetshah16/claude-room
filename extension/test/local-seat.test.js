'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { seatHandle, ensureLocalSeat } = require('../src/local-seat.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'local-seat-'))
const seatFile = repo => path.join(repo, '.claude', 'room-seat.local.json')
const read = repo => JSON.parse(fs.readFileSync(seatFile(repo), 'utf8'))

function fakeClient({ members, state } = {}) {
  const roster = members ?? [{ id: 'o1', role: 'owner', name: 'Owner' }]
  const calls = []
  return {
    calls,
    adminState: async () => (state === null ? null : { ok: true, members: roster }),
    addSeat: async a => {
      calls.push(['addSeat', a])
      roster.push({ id: 'a1', role: 'member', kind: 'agent', handle: a.handle })
      return { ok: true, token: 'tok-new', member: { id: 'a1' } }
    },
    rotate: async id => { calls.push(['rotate', id]); return { ok: true, token: 'tok-rot' } },
  }
}
const run = (o) => ensureLocalSeat({ username: 'Admin', roomUrl: 'http://127.0.0.1:5000', git: () => null, ...o })

test('seatHandle lowercases, strips and suffixes', () => {
  assert.equal(seatHandle('Admin'), 'admin-claude')
  assert.equal(seatHandle('Heet  Shah!!'), 'heet-shah-claude')
  assert.equal(seatHandle(''), 'user-claude')
})

test('first run creates the seat and writes the file', async () => {
  const repo = tmp(); const client = fakeClient()
  const r = await run({ client, workRepo: repo })
  assert.deepEqual([r.ok, r.handle], [true, 'admin-claude'])
  assert.deepEqual(client.calls, [['addSeat', { handle: 'admin-claude', ownerId: 'o1' }]])
  assert.deepEqual(read(repo), { room_url: 'http://127.0.0.1:5000', seat_handle: 'admin-claude', seat_token: 'tok-new' })
})

test('second run reuses the seat and only updates room_url', async () => {
  const repo = tmp(); const client = fakeClient()
  await run({ client, workRepo: repo })
  await run({ client, workRepo: repo, roomUrl: 'http://127.0.0.1:6000' })
  assert.equal(client.calls.length, 1)
  assert.deepEqual(read(repo), { room_url: 'http://127.0.0.1:6000', seat_handle: 'admin-claude', seat_token: 'tok-new' })
})

test('seat exists but the file is missing or corrupt: rotates, never duplicates', async () => {
  const repo = tmp()
  const members = [{ id: 'o1', role: 'owner' }, { id: 'a9', kind: 'agent', handle: 'admin-claude' }]
  const client = fakeClient({ members })
  await run({ client, workRepo: repo })
  assert.deepEqual(client.calls, [['rotate', 'a9']])
  assert.equal(read(repo).seat_token, 'tok-rot')
  fs.writeFileSync(seatFile(repo), '{nope')
  await run({ client, workRepo: repo })
  assert.equal(client.calls.length, 2)
  fs.writeFileSync(seatFile(repo), JSON.stringify({ seat_handle: 'someone-else', seat_token: 'x' }))
  await run({ client, workRepo: repo })
  assert.equal(client.calls.length, 3)
  assert.equal(read(repo).seat_handle, 'admin-claude')
})

test('no workRepo: no file, no call', async () => {
  const client = fakeClient(); let called = false
  client.adminState = async () => { called = true }
  const r = await run({ client, workRepo: undefined })
  assert.equal(r.ok, false); assert.equal(called, false)
})

test('a non-git folder gets the file and no exclude, without throwing', async () => {
  const repo = tmp()
  const r = await ensureLocalSeat({ client: fakeClient(), workRepo: repo, roomUrl: 'u', username: 'a' })
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(seatFile(repo)))
})

test('a git repo gets the file excluded, once', async () => {
  const repo = tmp()
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const client = fakeClient()
  await ensureLocalSeat({ client, workRepo: repo, roomUrl: 'u', username: 'a' })
  await ensureLocalSeat({ client, workRepo: repo, roomUrl: 'v', username: 'a' })
  const ex = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(ex.split('\n').filter(l => l === '.claude/room-seat.local.json').length, 1)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '')
})

test('client failures return ok:false and never throw', async () => {
  const repo = tmp()
  assert.equal((await run({ client: fakeClient({ state: null }), workRepo: repo })).ok, false)
  const refuse = fakeClient(); refuse.addSeat = async () => ({ ok: false, errors: ['nope'] })
  assert.deepEqual(await run({ client: refuse, workRepo: repo }), { ok: false, reason: 'nope' })
  const boom = fakeClient(); boom.adminState = async () => { throw new Error('boom') }
  assert.deepEqual(await run({ client: boom, workRepo: repo }), { ok: false, reason: 'boom' })
  assert.equal(fs.existsSync(seatFile(repo)), false)
})
