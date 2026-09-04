/**
 * The `delegate` tool and the queue gate it depends on.
 *
 * Delegation is a second, separate authorisation path alongside human
 * addressing (see address-policy.test.mjs, which this must not touch): the
 * orchestrator never owns a seat, so what it needs is the seat owner's
 * explicit per-seat opt-in (`delegatable`), not the owner-only check that
 * governs humans.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Queue } from '../src/queue.mjs'
import { Seats } from '../src/seats.mjs'
import { Registry, createMember, createAgentMember } from '../src/identity.mjs'
import { loadConfig } from '../src/config.mjs'
import { createChannel } from '../src/channel.mjs'

function setup({ delegatable }) {
  const registry = new Registry()
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const agent = registry.add(createAgentMember({
    name: 'opencode', handle: 'opencode', ownerId: ana.id, delegatable,
  }))
  const seats = new Seats()
  seats.join(agent, { id: 'c1' })
  const orchestrator = { id: 'orchestrator', name: 'claude', role: 'member', muted: false }
  const queue = new Queue({
    config: loadConfig({ ROOM_HANDLES: 'claude' }), registry, seats,
    ledger: null, decisions: null,
  })
  return { queue, orchestrator, ana, agent }
}

test('the orchestrator may put work on a seat whose owner opted in', () => {
  const { queue, orchestrator } = setup({ delegatable: true })
  const r = queue.submit(orchestrator, '@opencode add mul() to math.js', { delegation: true })
  assert.equal(r.ok, true, `expected queued, got ${r.reason}`)
})

test('the orchestrator is refused a seat that never opted in', () => {
  // Room ownership must not by itself reach someone else's seat, and neither
  // may the orchestrator. Delegation is consent, not authority.
  const { queue, orchestrator } = setup({ delegatable: false })
  const r = queue.submit(orchestrator, '@opencode add mul() to math.js', { delegation: true })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-delegatable')
})

test('delegatable does NOT loosen who may address the seat by hand', () => {
  // The two paths are separate on purpose: opting into delegation must not
  // quietly turn an owner-only seat into a shared one.
  const { queue, agent } = setup({ delegatable: true })
  const stranger = { id: 'other', name: 'sam', role: 'member', muted: false }
  const r = queue.submit(stranger, '@opencode do a thing')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-your-seat')
})

test('an owner addressing their own delegatable seat still works', () => {
  const { queue, ana } = setup({ delegatable: true })
  assert.equal(queue.submit(ana, '@opencode do a thing').ok, true)
})

test('a delegate call with a thin brief is rejected with the reason, not silently dropped', async () => {
  let seen = null
  const channel = createChannel({
    config: loadConfig({}),
    onReply() {}, onDecision() {},
    onDelegate(input) { seen = input; return { ok: false, errors: ['spec.files is required for execution'] } },
  })
  const res = await channel.callTool('delegate', {
    to: '@opencode', class: 'execution', task: 'do the thing',
  })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /spec\.files/)
  assert.equal(seen.to, '@opencode')
})

test('the delegate tool is advertised alongside room_reply', async () => {
  const channel = createChannel({
    config: loadConfig({}), onReply() {}, onDecision() {}, onDelegate: () => ({ ok: true, id: 'd1' }),
  })
  const names = (await channel.listTools()).map(t => t.name)
  assert.ok(names.includes('delegate'))
  assert.ok(names.includes('room_reply'))
})
