import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMember, Registry, canAddress, mayApprove, createAgentMember, isAgent, ownsSeat, isDelegatable } from '../src/identity.mjs'

test('a member gets a long unguessable token', () => {
  const m = createMember({ name: 'heet', role: 'owner' })
  assert.ok(m.token.length >= 32)
  assert.notEqual(createMember({ name: 'a', role: 'member' }).token, m.token)
})

test('lookup by token resolves the member, unknown tokens resolve null', () => {
  const r = new Registry()
  const m = r.add(createMember({ name: 'ana', role: 'member' }))
  assert.equal(r.byToken(m.token).id, m.id)
  assert.equal(r.byToken('not-a-real-token'), null)
  assert.equal(r.byToken(''), null)
  assert.equal(r.byToken(undefined), null)
})

test('viewers cannot address Claude; owners and members can', () => {
  assert.equal(canAddress({ role: 'viewer' }), false)
  assert.equal(canAddress({ role: 'member' }), true)
  assert.equal(canAddress({ role: 'owner' }), true)
})

test('approval requires the owner role or an explicit grant', () => {
  assert.equal(mayApprove({ role: 'owner', canApprove: false }), true)
  assert.equal(mayApprove({ role: 'member', canApprove: true }), true)
  assert.equal(mayApprove({ role: 'member', canApprove: false }), false)
  assert.equal(mayApprove({ role: 'viewer', canApprove: true }), false)
})

test('a revoked token stops resolving', () => {
  const r = new Registry()
  const m = r.add(createMember({ name: 'temp', role: 'member' }))
  assert.equal(r.revoke(m.id), true)
  assert.equal(r.byToken(m.token), null)
  assert.equal(r.revoke(m.id), false)
})

test('round-trips through JSON', () => {
  const r = new Registry()
  const m = r.add(createMember({ name: 'ana', role: 'member', canApprove: true }))
  const back = Registry.fromJSON(JSON.parse(JSON.stringify(r.toJSON())))
  assert.equal(back.byToken(m.token).name, 'ana')
  assert.equal(back.byToken(m.token).canApprove, true)
})

test('an agent member carries a handle and an owner', () => {
  const a = createAgentMember({ name: 'ana-agent', handle: 'ana-agent', ownerId: 'u-ana' })
  assert.equal(isAgent(a), true)
  assert.equal(a.handle, 'ana-agent')
  assert.equal(a.ownerId, 'u-ana')
  assert.ok(a.token.length >= 32)
})

test('a human member is not an agent', () => {
  assert.equal(isAgent(createMember({ name: 'ana', role: 'member' })), false)
})

test('only the owner may address a seat', () => {
  const agent = createAgentMember({ name: 'ana-agent', handle: 'ana-agent', ownerId: 'u-ana' })
  assert.equal(ownsSeat({ id: 'u-ana' }, agent), true)
  assert.equal(ownsSeat({ id: 'u-heet' }, agent), false)
  assert.equal(ownsSeat(null, agent), false)
  assert.equal(ownsSeat({ id: 'u-ana' }, null), false)
})

test('an owner of the room does not thereby own every seat', () => {
  // Being room owner must not grant use of someone else's account.
  const agent = createAgentMember({ name: 'ana-agent', handle: 'ana-agent', ownerId: 'u-ana' })
  assert.equal(ownsSeat({ id: 'u-heet', role: 'owner' }, agent), false)
})

test('handles are unique and case-insensitive in lookup', () => {
  const r = new Registry()
  const a = r.add(createAgentMember({ name: 'ana-agent', handle: 'Ana-Agent', ownerId: 'u1' }))
  assert.equal(r.byHandle('ana-agent').id, a.id)
  assert.equal(r.byHandle('ANA-AGENT').id, a.id)
  assert.equal(r.byHandle('nobody'), null)
  assert.equal(r.agents().length, 1)
})

test('a seat is not delegatable unless its owner said so', () => {
  // Fail closed. Delegation lets the orchestrator put work on someone else's
  // seat; that must be opt-in, never a default or an accident.
  const a = createAgentMember({ name: 'oc', handle: 'opencode', ownerId: 'm1' })
  assert.equal(isDelegatable(a), false)
})

test('an owner can opt a seat into delegation', () => {
  const a = createAgentMember({ name: 'oc', handle: 'opencode', ownerId: 'm1', delegatable: true })
  assert.equal(isDelegatable(a), true)
})

test('a delegatable value that is not a boolean true is refused', () => {
  // A value from an older state file, or a string "false", must not open the
  // gate. Anything unrecognised means no.
  for (const bad of ['true', 1, {}, null, undefined]) {
    const a = { ...createAgentMember({ name: 'oc', handle: 'opencode', ownerId: 'm1' }), delegatable: bad }
    assert.equal(isDelegatable(a), false, `delegatable=${JSON.stringify(bad)} must not pass`)
  }
})

test('a non-agent is never delegatable, whatever its fields say', () => {
  assert.equal(isDelegatable({ kind: 'human', delegatable: true }), false)
})
