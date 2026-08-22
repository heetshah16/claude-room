import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdmin } from '../src/admin.mjs'
import { Registry, Bans, createMember, canAddress, mayApprove } from '../src/identity.mjs'
import { Store } from '../src/state.mjs'
import { Queue } from '../src/queue.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'
import { loadConfig } from '../src/config.mjs'

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'roomadmin-'))
  const config = loadConfig({ ROOM_STATE_DIR: dir })
  const registry = new Registry()
  const bans = new Bans()
  const owner = registry.add(createMember({ name: 'heet', role: 'owner' }))
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const disconnected = []
  const published = []
  const bus = {
    publish: (e, d) => published.push([e, d]),
    disconnect: id => { disconnected.push(id); return 1 },
    count: () => 0,
  }
  const queue = new Queue({ config, ledger: new Ledger(), decisions: new Decisions() })
  const store = new Store(dir)
  // Distinct addresses per member: the owner sharing an address with the person
  // being banned is its own case, covered separately below.
  const addrs = new Map([[owner.id, '100.64.0.1'], [ana.id, '100.64.0.9']])
  const admin = createAdmin({
    registry, bans, store, bus, config, queue,
    runtime: { joinUrl: t => `http://x/?token=${t}`, lastAddrOf: id => addrs.get(id) ?? null },
  })
  return { dir, admin, registry, bans, owner, ana, disconnected, published, queue, config, store }
}

const done = h => rmSync(h.dir, { recursive: true, force: true })

test('invite creates a member and hands back a join URL', () => {
  const h = harness()
  const r = h.admin.run('invite', { name: 'bo', role: 'member' })
  assert.equal(r.ok, true)
  assert.match(r.joinUrl, /token=/)
  assert.equal(h.registry.byName('bo').role, 'member')
  done(h)
})

test('invite refuses duplicate names, empty names, bad roles and banned names', () => {
  const h = harness()
  assert.equal(h.admin.run('invite', { name: 'ana' }).reason, 'name-taken')
  assert.equal(h.admin.run('invite', { name: '  ' }).reason, 'name-required')
  assert.equal(h.admin.run('invite', { name: 'x', role: 'wizard' }).reason, 'bad-role')
  h.admin.run('ban', { name: 'mallory' })
  assert.equal(h.admin.run('invite', { name: 'mallory' }).reason, 'name-banned')
  done(h)
})

test('remove revokes the token and cuts the live stream', () => {
  const h = harness()
  const token = h.ana.token
  const r = h.admin.run('remove', { memberId: h.ana.id })
  assert.equal(r.ok, true)
  assert.equal(h.registry.byToken(token), null)
  assert.deepEqual(h.disconnected, [h.ana.id])
  done(h)
})

test('the last owner cannot be removed, demoted, or banned', () => {
  const h = harness()
  assert.equal(h.admin.run('remove', { memberId: h.owner.id }).reason, 'last-owner')
  assert.equal(h.admin.run('role', { memberId: h.owner.id, role: 'viewer' }).reason, 'last-owner')
  assert.equal(h.admin.run('ban', { memberId: h.owner.id }).reason, 'last-owner')
  // With a second owner it is allowed.
  h.admin.run('invite', { name: 'co', role: 'owner' })
  assert.equal(h.admin.run('role', { memberId: h.owner.id, role: 'viewer' }).ok, true)
  done(h)
})

test('a ban survives the member being gone and blocks the name', () => {
  const h = harness()
  h.admin.run('ban', { memberId: h.ana.id, reason: 'spamming' })
  assert.equal(h.registry.byId(h.ana.id), null)
  assert.equal(h.bans.isBanned({ name: 'ana' }), true)
  assert.equal(h.bans.isBanned({ name: 'ANA' }), true)      // case-insensitive
  done(h)
})

test('a ban never guesses at an address', () => {
  const h = harness()
  h.admin.run('ban', { memberId: h.ana.id })
  // The member was last seen at 100.64.0.9, but banning them must not silently
  // ban that address: on loopback or behind NAT it belongs to other people too.
  assert.equal(h.bans.isBanned({ addr: '100.64.0.9' }), false)
  done(h)
})

test('an address ban is opt-in and does work when asked for', () => {
  const h = harness()
  const r = h.admin.run('ban', { memberId: h.ana.id, banAddress: true })
  assert.equal(r.ok, true)
  assert.equal(h.bans.isBanned({ addr: '100.64.0.9' }), true)
  done(h)
})

test('loopback can never be banned - it would lock out everyone local', () => {
  const h = harness()
  const r = h.admin.run('ban', { name: 'mallory', addr: '127.0.0.1' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'addr-unsafe-to-ban')
  assert.equal(h.bans.isBanned({ addr: '127.0.0.1' }), false)
  done(h)
})

test('an address an owner is using can never be banned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roomadmin2-'))
  const config = loadConfig({ ROOM_STATE_DIR: dir })
  const registry = new Registry()
  const bans = new Bans()
  const owner = registry.add(createMember({ name: 'heet', role: 'owner' }))
  const bad = registry.add(createMember({ name: 'mallory', role: 'member' }))
  const addrs = new Map([[owner.id, '203.0.113.5'], [bad.id, '203.0.113.5']])
  const admin = createAdmin({
    registry, bans, store: new Store(dir),
    bus: { publish() {}, disconnect() {}, count: () => 0 },
    config, queue: new Queue({ config, ledger: new Ledger(), decisions: new Decisions() }),
    runtime: { joinUrl: t => t, lastAddrOf: id => addrs.get(id) ?? null },
  })
  // Sharing an office NAT with the owner must not be a way to lock the owner out.
  const r = admin.run('ban', { memberId: bad.id, banAddress: true })
  assert.equal(r.reason, 'addr-unsafe-to-ban')
  assert.equal(bans.isBanned({ addr: '203.0.113.5' }), false)
  rmSync(dir, { recursive: true, force: true })
})

test('unban clears it and reports when there was nothing to clear', () => {
  const h = harness()
  h.admin.run('ban', { name: 'mallory' })
  assert.equal(h.admin.run('unban', { key: 'mallory' }).ok, true)
  assert.equal(h.bans.isBanned({ name: 'mallory' }), false)
  assert.equal(h.admin.run('unban', { key: 'nobody' }).reason, 'not-banned')
  done(h)
})

test('role change takes effect on the live member object', () => {
  const h = harness()
  h.admin.run('role', { memberId: h.ana.id, role: 'viewer' })
  assert.equal(canAddress(h.registry.byId(h.ana.id)), false)
  h.admin.run('role', { memberId: h.ana.id, role: 'member' })
  assert.equal(canAddress(h.registry.byId(h.ana.id)), true)
  done(h)
})

test('muting blocks addressing without changing the role', () => {
  const h = harness()
  h.admin.run('mute', { memberId: h.ana.id, muted: true })
  const m = h.registry.byId(h.ana.id)
  assert.equal(m.role, 'member')
  assert.equal(canAddress(m), false)
  h.admin.run('mute', { memberId: h.ana.id, muted: false })
  assert.equal(canAddress(h.registry.byId(h.ana.id)), true)
  done(h)
})

test('approve toggles tool-approval authority', () => {
  const h = harness()
  assert.equal(mayApprove(h.registry.byId(h.ana.id)), false)
  h.admin.run('approve', { memberId: h.ana.id, canApprove: true })
  assert.equal(mayApprove(h.registry.byId(h.ana.id)), true)
  done(h)
})

test('rename works and refuses a name already in use', () => {
  const h = harness()
  assert.equal(h.admin.run('rename', { memberId: h.ana.id, name: 'anna' }).ok, true)
  assert.equal(h.registry.byName('anna').id, h.ana.id)
  assert.equal(h.admin.run('rename', { memberId: h.ana.id, name: 'heet' }).ok, false)
  done(h)
})

test('rotate issues a new token and kills the old one', () => {
  const h = harness()
  const old = h.ana.token
  const r = h.admin.run('rotate', { memberId: h.ana.id })
  assert.equal(r.ok, true)
  assert.notEqual(r.token, old)
  assert.equal(h.registry.byToken(old), null)
  assert.equal(h.registry.byToken(r.token).id, h.ana.id)
  done(h)
})

test('the agent handle can be renamed and takes effect immediately', () => {
  const h = harness()
  assert.deepEqual(h.config.handles, ['claude'])
  const r = h.admin.run('handles', { handles: '@Ada, devops' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.handles, ['ada', 'devops'])
  // The queue reads config.handles, so routing changes with no restart.
  const m = h.registry.byId(h.ana.id)
  assert.equal(h.queue.submit(m, '@ada ship it').message.addressed, true)
  assert.equal(h.queue.submit(m, '@claude ship it').message.addressed, false)
  done(h)
})

test('bad handles are refused', () => {
  const h = harness()
  assert.equal(h.admin.run('handles', { handles: '' }).reason, 'handles-required')
  assert.equal(h.admin.run('handles', { handles: ['two words'] }).reason, 'handle-has-space')
  done(h)
})

test('pausing stops work but not conversation', () => {
  const h = harness()
  h.admin.run('pause', { paused: true })
  const m = h.registry.byId(h.ana.id)
  const addressed = h.queue.submit(m, '@claude do it')
  assert.equal(addressed.ok, false)
  assert.equal(addressed.reason, 'paused')
  // Chatter still flows.
  assert.equal(h.queue.submit(m, 'just talking').ok, true)
  h.admin.run('pause', { paused: false })
  assert.equal(h.queue.submit(m, '@claude do it').ok, true)
  done(h)
})

test('clearQueue drops pending work and reports the count', () => {
  const h = harness()
  const m = h.registry.byId(h.ana.id)
  h.queue.submit(m, '@claude one')
  h.queue.submit(m, '@claude two')
  assert.equal(h.admin.run('clearQueue').dropped, 2)
  assert.equal(h.queue.pending().length, 0)
  done(h)
})

test('budgets can be changed at runtime', () => {
  const h = harness()
  h.admin.run('budget', { tokensPerMember: 500, messagesPerWindow: 3 })
  assert.equal(h.config.budgets.tokensPerMember, 500)
  assert.equal(h.config.budgets.messagesPerWindow, 3)
  done(h)
})

test('an unknown command is refused rather than throwing', () => {
  const h = harness()
  assert.deepEqual(h.admin.run('selfDestruct'), { ok: false, reason: 'unknown-command' })
  assert.equal(h.admin.run('remove', { memberId: 'nope' }).reason, 'no-such-member')
  done(h)
})

test('changes persist so a restart keeps them', () => {
  const h = harness()
  h.admin.run('invite', { name: 'bo', role: 'viewer' })
  h.admin.run('ban', { name: 'mallory' })
  h.admin.run('handles', { handles: ['ada'] })

  const back = new Store(h.dir).load()
  assert.equal(back.registry.byName('bo').role, 'viewer')
  assert.equal(back.bans.isBanned({ name: 'mallory' }), true)
  assert.deepEqual(back.runtime.handles, ['ada'])
  done(h)
})
