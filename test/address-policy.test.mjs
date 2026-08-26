/**
 * Who may address what, made explicit.
 *
 * The room has always had an asymmetry: anyone may address the local `@claude`
 * session and spend the host's account, while only a seat's owner may address
 * that seat. That fell out of the implementation rather than being chosen, and
 * was recorded as an open question in the design.
 *
 * It is now a named policy per seat, with the defaults deliberately matching
 * what the room already did. The local channel stays shared because several
 * humans driving one session is the entire premise; a seat defaults to
 * owner-only because it draws on one person's personal subscription.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Queue } from '../src/queue.mjs'
import { Ledger } from '../src/ledger.mjs'
import { loadConfig } from '../src/config.mjs'
import { Decisions } from '../src/decisions.mjs'
import { Registry, createMember, createAgentMember, addressPolicyOf } from '../src/identity.mjs'
import { Seats } from '../src/seats.mjs'

function seated() {
  const registry = new Registry()
  const heet = registry.add(createMember({ name: 'heet', role: 'owner' }))
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const agent = registry.add(createAgentMember({ name: 'ana-agent', handle: 'ana-agent', ownerId: ana.id }))
  const seats = new Seats()
  seats.join(agent, { write() {}, end() {}, on() {} })
  const q = new Queue({
    config: loadConfig({}), ledger: new Ledger(), decisions: new Decisions(), registry, seats,
  })
  return { q, heet, ana, agent, seats, registry }
}

test('a seat defaults to owner-only, which is what the room already enforced', () => {
  const { q, heet, agent } = seated()
  assert.equal(addressPolicyOf(agent), 'owner-only')
  assert.equal(q.submit(heet, '@ana-agent do a thing').reason, 'not-your-seat')
})

test('a seat set to shared can be addressed by anyone who may address at all', () => {
  const { q, heet, agent } = seated()
  agent.addressPolicy = 'shared'
  const r = q.submit(heet, '@ana-agent do a thing')
  assert.equal(r.ok, true, 'a shared seat must accept a non-owner')
  assert.equal(r.message.handle, 'ana-agent')
})

test('a shared seat still refuses a viewer - policy widens who, never what', () => {
  const { q, agent, registry } = seated()
  agent.addressPolicy = 'shared'
  const viewer = registry.add(createMember({ name: 'sam', role: 'viewer' }))
  const r = q.submit(viewer, '@ana-agent do a thing')
  // Viewers never put anything into a context window, whatever the seat says.
  assert.equal(r.message.addressed, false)
  assert.equal(r.reason, 'not-permitted')
})

test('an offline seat is refused even when shared - liveness is not a policy question', () => {
  const { q, heet, agent, seats } = seated()
  agent.addressPolicy = 'shared'
  seats.leave(seats.online()[0].seatId)
  assert.equal(q.submit(heet, '@ana-agent do a thing').reason, 'seat-offline')
})

test('the owner can always address their own seat under either policy', () => {
  for (const policy of ['owner-only', 'shared']) {
    const { q, ana, agent } = seated()
    agent.addressPolicy = policy
    assert.equal(q.submit(ana, '@ana-agent do a thing').ok, true, `owner refused under ${policy}`)
  }
})

test('the local channel stays shared - that is the whole premise of the room', () => {
  const { q, ana, heet } = seated()
  // Neither of these is the "owner" of the local session in any seat sense;
  // both must reach it, or multiplayer stops being multiplayer.
  assert.equal(q.submit(ana, '@claude run the tests').ok, true)
  assert.equal(q.submit(heet, '@claude run the tests').ok, true)
})

test('an unrecognised policy falls back to owner-only, never open', () => {
  // Includes a seat restored from a state file written before this field
  // existed. A policy that fails open would be the wrong way round.
  assert.equal(addressPolicyOf({ kind: 'agent' }), 'owner-only')
  assert.equal(addressPolicyOf({ kind: 'agent', addressPolicy: 'everyone' }), 'owner-only')
  assert.equal(addressPolicyOf({ kind: 'agent', addressPolicy: null }), 'owner-only')
  assert.equal(addressPolicyOf(undefined), 'owner-only')
})

test('a seat from an older state file is enforced as owner-only', () => {
  const { q, heet, agent } = seated()
  delete agent.addressPolicy // exactly what Registry.fromJSON produces
  assert.equal(q.submit(heet, '@ana-agent do a thing').reason, 'not-your-seat')
})
