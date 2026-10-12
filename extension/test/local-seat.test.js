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

// The room's own persisted roster (`<stateDir>/members.json`) is the only place
// a seat's token lives; adminState() never exposes tokens.
function fakeClient({ members, state } = {}) {
  const stateDir = tmp()
  const roster = members ?? [{ id: 'o1', role: 'owner', name: 'Owner', token: 'tok-owner' }]
  const persist = () => fs.writeFileSync(path.join(stateDir, 'members.json'), JSON.stringify(roster))
  persist()
  const calls = []
  return {
    calls, stateDir, roster, persist,
    adminState: async () => (state === null ? null : { ok: true, members: roster.map(({ token, ...m }) => m) }),
    addSeat: async a => {
      calls.push(['addSeat', a])
      roster.push({ id: 'a1', role: 'member', kind: 'agent', handle: a.handle, ownerId: a.ownerId, token: 'tok-new' })
      persist()
      return { ok: true, token: 'tok-new', member: { id: 'a1' } }
    },
    rotate: async id => { calls.push(['rotate', id]); return { ok: true, token: 'tok-rot' } },
  }
}
const run = (o) => ensureLocalSeat({ username: 'Admin', roomUrl: 'http://127.0.0.1:5000', git: () => null, stateDir: o.client.stateDir, ...o })
const seat = (o = {}) => ({ id: 'a9', role: 'member', kind: 'agent', handle: 'admin-claude', ownerId: 'o1', token: 'tok-live', ...o })
const owner = { id: 'o1', role: 'owner', token: 'tok-owner' }

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

test('seat exists but the file is missing or corrupt: written from the roster, no rotate, no duplicate', async () => {
  const repo = tmp()
  const client = fakeClient({ members: [{ ...owner }, seat()] })
  assert.equal((await run({ client, workRepo: repo })).ok, true)
  assert.deepEqual(client.calls, [])
  assert.equal(read(repo).seat_token, 'tok-live')
  fs.writeFileSync(seatFile(repo), '{nope')
  await run({ client, workRepo: repo })
  fs.writeFileSync(seatFile(repo), JSON.stringify({ seat_handle: 'someone-else', seat_token: 'x' }))
  await run({ client, workRepo: repo })
  assert.deepEqual(client.calls, [])
  assert.deepEqual(read(repo), { room_url: 'http://127.0.0.1:5000', seat_handle: 'admin-claude', seat_token: 'tok-live' })
})

test('a rotated token in the roster rewrites a file that still names the seat', async () => {
  const repo = tmp(); const client = fakeClient()
  await run({ client, workRepo: repo })
  client.roster.find(m => m.id === 'a1').token = 'tok-rotated'; client.persist()
  const r = await run({ client, workRepo: repo })
  assert.equal(r.ok, true)
  assert.deepEqual(client.calls.map(c => c[0]), ['addSeat'])
  assert.equal(read(repo).seat_token, 'tok-rotated')
})

test('an up-to-date file is not rewritten', async () => {
  const repo = tmp(); const client = fakeClient()
  await run({ client, workRepo: repo })
  let writes = 0
  const spy = { ...fs, renameSync: (...a) => { writes++; return fs.renameSync(...a) } }
  assert.equal((await run({ client, workRepo: repo, fs: spy })).ok, true)
  assert.equal(writes, 0)
})

test('a seat whose token is not in the roster is not written', async () => {
  const repo = tmp()
  const client = fakeClient({ members: [{ ...owner }, seat({ token: undefined })] })
  const r = await run({ client, workRepo: repo })
  assert.equal(r.ok, false)
  assert.match(r.reason, /token/)
  assert.equal(fs.existsSync(seatFile(repo)), false)
})

test('a seat with that handle owned by someone else is left alone', async () => {
  const repo = tmp()
  const client = fakeClient({ members: [{ ...owner }, { id: 'o2', role: 'member' }, seat({ ownerId: 'o2' })] })
  fs.mkdirSync(path.dirname(seatFile(repo)), { recursive: true })
  fs.writeFileSync(seatFile(repo), 'untouched')
  const r = await run({ client, workRepo: repo })
  assert.equal(r.ok, false)
  assert.match(r.reason, /admin-claude/)
  assert.deepEqual(client.calls, [])
  assert.equal(fs.readFileSync(seatFile(repo), 'utf8'), 'untouched')
})

test('a seat file tracked by git is never given a token', async () => {
  const repo = tmp()
  execFileSync('git', ['init', '-q'], { cwd: repo })
  fs.mkdirSync(path.dirname(seatFile(repo)), { recursive: true })
  fs.writeFileSync(seatFile(repo), '{}')
  execFileSync('git', ['add', '.claude/room-seat.local.json'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seat'], { cwd: repo })
  const client = fakeClient()
  const r = await ensureLocalSeat({ client, workRepo: repo, roomUrl: 'u', username: 'a', stateDir: client.stateDir })
  assert.deepEqual(r, { ok: false, reason: '.claude/room-seat.local.json is tracked by git; not writing a seat token into it' })
  assert.equal(fs.readFileSync(seatFile(repo), 'utf8'), '{}')
  assert.deepEqual(client.calls, [])
})

test('no workRepo: no file, no call', async () => {
  const client = fakeClient(); let called = false
  client.adminState = async () => { called = true }
  const r = await run({ client, workRepo: undefined })
  assert.equal(r.ok, false); assert.equal(called, false)
})

test('a non-git folder gets the file and no exclude, without throwing', async () => {
  const repo = tmp()
  const r = await run({ client: fakeClient(), workRepo: repo, roomUrl: 'u', username: 'a', git: undefined })
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(seatFile(repo)))
})

test('a git repo gets the file excluded, once', async () => {
  const repo = tmp()
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const client = fakeClient()
  await run({ client, workRepo: repo, roomUrl: 'u', username: 'a', git: undefined })
  await run({ client, workRepo: repo, roomUrl: 'v', username: 'a', git: undefined })
  const ex = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(ex.split('\n').filter(l => l === '**/.claude/room-seat.local.json').length, 1)
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

test('a folder inside a larger repo stays clean in git status', async () => {
  const top = tmp()
  execFileSync('git', ['init', '-q'], { cwd: top })
  const repo = path.join(top, 'packages', 'app'); fs.mkdirSync(repo, { recursive: true })
  await run({ client: fakeClient(), workRepo: repo, roomUrl: 'u', username: 'a', git: undefined })
  assert.ok(fs.existsSync(seatFile(repo)))
  assert.equal(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: top, encoding: 'utf8' }).trim(), '')
})

test('a reuse run adds an exclude entry the first run could not', async () => {
  const repo = tmp(); const client = fakeClient()
  await run({ client, workRepo: repo, roomUrl: 'u', username: 'a' })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const r = await run({ client, workRepo: repo, roomUrl: 'u', username: 'a', git: undefined })
  assert.equal(r.ok, true); assert.equal(client.calls.length, 1)
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /room-seat.local.json/)
})

test('the seat file has exactly the three keys, owner-only, and no temp file is left', async () => {
  const repo = tmp()
  fs.mkdirSync(path.dirname(seatFile(repo)), { recursive: true })
  fs.writeFileSync(seatFile(repo), 'stale', { mode: 0o644 })
  await run({ client: fakeClient(), workRepo: repo })
  assert.deepEqual(Object.keys(read(repo)).sort(), ['room_url', 'seat_handle', 'seat_token'])
  assert.deepEqual(fs.readdirSync(path.dirname(seatFile(repo))), ['room-seat.local.json'])
  if (process.platform !== 'win32') assert.equal(fs.statSync(seatFile(repo)).mode & 0o777, 0o600)
})

test('a failed write leaves no temp file and reports ok:false', async () => {
  const repo = tmp()
  const bad = { ...fs, renameSync: () => { throw new Error('rename failed') } }
  const r = await run({ client: fakeClient(), workRepo: repo, fs: bad })
  assert.deepEqual(r, { ok: false, reason: 'rename failed' })
  assert.deepEqual(fs.readdirSync(path.dirname(seatFile(repo))), [])
})
