/**
 * The delegation return path.
 *
 * Design §4: the enqueued turn is tagged `kind="delegation"`, the seat's reply
 * comes back to `@claude` as `kind="delegation-result"` carrying the
 * delegation id, and a delegation record exists so `class` — which never
 * routes anything — is attributable afterwards. Without this the `delegate`
 * tool is fire-and-never-hear-back, which guts the orchestrator use case it
 * exists for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done } from './helpers/room.mjs'
import { PendingDelegations, createDelegator } from '../src/delegation.mjs'
import { buildDelegationResultNotification } from '../src/channel.mjs'
import { Queue } from '../src/queue.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'
import { Seats } from '../src/seats.mjs'
import { loadConfig } from '../src/config.mjs'
import { Registry, createMember, createAgentMember } from '../src/identity.mjs'

function seated() {
  const registry = new Registry()
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const agent = registry.add(createAgentMember({
    name: 'opencode', handle: 'opencode', ownerId: ana.id, delegatable: true,
  }))
  const seats = new Seats()
  seats.join(agent, { id: 'c1' })
  const queue = new Queue({
    config: loadConfig({ ROOM_HANDLES: 'claude' }), registry, seats,
    ledger: new Ledger(), decisions: new Decisions(),
  })
  return { queue, orchestrator: { id: 'orchestrator', name: 'claude', role: 'member', muted: false } }
}

function delegator(extra = {}) {
  const { queue, orchestrator } = seated()
  const published = []
  const appended = []
  const drained = []
  const notified = []
  const d = createDelegator({
    queue,
    orchestrator,
    store: { appendMessage: m => appended.push(m) },
    bus: { publish: (e, data) => published.push([e, data]) },
    channel: { notifyDelegationResult: r => { notified.push(r); return r } },
    drain: () => drained.push(1),
    now: () => 1,
    ...extra,
  })
  return { d, queue, published, appended, drained, notified }
}

const EXEC = { class: 'execution', task: 'add mul()', spec: { files: ['math.js'], tests: ['npm test'] } }

test('a delegation to a handle no seat holds is reported as a failure, not a success', () => {
  // classify finds no mention for an unknown handle, so submit returns
  // {ok:true, addressed:false} and nothing is enqueued. Checking only r.ok told
  // the orchestrator "delegated <id> to @opencode-typo" while the work vanished
  // - and a typo'd handle is the likeliest operator error there is here.
  const { d, drained, appended } = delegator()
  const r = d.delegate({ ...EXEC, to: '@opencode-typo' })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /no seat with handle @opencode-typo/)
  assert.deepEqual(appended, [], 'nothing was enqueued, so nothing may be recorded')
  assert.deepEqual(drained, [], 'and there is nothing to drain')
  assert.equal(d.pending.size, 0)
})

test('a delegation to a real seat drains, the way every other addressed submit does', () => {
  // web.mjs:430 and :450 both drain after an addressed submit. delegate is not
  // an HTTP path, so without an explicit call its turn sat in the queue until
  // some unrelated message happened to trigger a drain.
  const { d, drained } = delegator()
  const r = d.delegate({ ...EXEC, to: '@opencode' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(drained.length, 1)
})

test('a rejected brief never reaches the queue at all', () => {
  const { d, appended, drained } = delegator()
  const r = d.delegate({ to: '@opencode', class: 'execution', task: 'do the thing' })
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /spec\.files/)
  assert.deepEqual([appended.length, drained.length], [0, 0])
})

test('a seat that owes a delegation gets its reply routed back to @claude as the result', () => {
  const { d, notified, published } = delegator()
  const r = d.delegate({ ...EXEC, to: '@opencode' })
  const nt = d.onSeatReply('opencode', 'added mul(), tests pass')
  assert.ok(nt, 'the reply must come back as a delegation-result')
  assert.equal(notified[0].id, r.id, 'carrying the delegation id')
  assert.equal(notified[0].class, 'execution')
  assert.equal(notified[0].text, 'added mul(), tests pass')
  assert.deepEqual(published.filter(([e]) => e === 'delegation').map(([, x]) => x.state), ['sent', 'done'])
})

test('a reply from a seat that owes nothing produces no delegation-result', () => {
  // A seat answering its own owner is an ordinary reply; turning it into a
  // result for a delegation that never happened would invent work.
  const { d, notified } = delegator()
  assert.equal(d.onSeatReply('opencode', 'just chatting'), null)
  assert.deepEqual(notified, [])
})

test('a delegation is answered exactly once - the second reply is an ordinary one', () => {
  const { d } = delegator()
  d.delegate({ ...EXEC, to: '@opencode' })
  assert.ok(d.onSeatReply('opencode', 'done'))
  assert.equal(d.onSeatReply('opencode', 'and one more thing'), null)
})

test('a delegated turn is tagged kind=delegation, so it is distinguishable from something a person typed', () => {
  const { queue, orchestrator } = seated()
  const r = queue.submit(orchestrator, '@opencode add mul() to math.js', {
    delegation: true, kind: 'delegation',
  })
  assert.equal(r.ok, true)
  assert.equal(r.message.kind, 'delegation')
})

test('every other caller still produces kind=chat, because the default did not move', () => {
  const { queue, orchestrator } = seated()
  assert.equal(queue.submit(orchestrator, 'just talking').message.kind, 'chat')
})

test('a seat reply pops its pending delegation and comes back as a delegation-result', () => {
  // The two halves server.mjs composes: the record, and the notification built
  // from it. The id is what lets the orchestrator match this answer to the
  // call it made minutes earlier.
  const pending = new PendingDelegations()
  pending.add('opencode', { id: 'del-1', task: 'add mul()', class: 'execution', at: 1 })

  const record = pending.take('opencode')
  assert.ok(record, 'the seat that was delegated to owes an answer')
  const nt = buildDelegationResultNotification(
    { ...record, handle: 'opencode', text: 'added mul(), tests pass' },
    { roomName: 'room' },
  )
  assert.equal(nt.params.content, 'added mul(), tests pass', 'the seat\'s words travel verbatim')
  assert.equal(nt.params.meta.kind, 'delegation-result')
  assert.equal(nt.params.meta.delegation_id, 'del-1')
  assert.equal(nt.params.meta.handle, 'opencode')
  assert.equal(nt.params.meta.class, 'execution')
  assert.equal(pending.size, 0, 'a delegation is answered exactly once')
})

test('one delegation per handle can be in flight, which is what makes keying by handle sound', () => {
  // The room serialises one turn per destination and a seat is a destination,
  // so the second delegation cannot start until the first has ended. Recording
  // it replaces rather than accumulating, and nothing is left orphaned.
  const pending = new PendingDelegations()
  pending.add('opencode', { id: 'del-1', task: 'first', class: 'execution', at: 1 })
  pending.add('opencode', { id: 'del-2', task: 'second', class: 'execution', at: 2 })
  assert.equal(pending.size, 1)
  assert.equal(pending.take('opencode').id, 'del-2')
})

test('an empty reply produces no notification rather than an empty one', () => {
  assert.equal(buildDelegationResultNotification({ id: 'd', handle: 'h', text: '  ' }, { roomName: 'r' }), null)
})

test('POST /seat/reply hands the reply to the room, which is how a result ever gets back', async () => {
  // web.mjs must not reach into server.mjs's delegation bookkeeping, so the
  // reply is handed out through a callback — the same way every other
  // cross-module hook in this module is wired. If this stops firing, the
  // return path is dead however correct the rest of it is.
  const seen = []
  const h = harness({}, null, { onSeatReply: (handle, text) => seen.push([handle, text]) })
  const base = await listen(h.server)
  await post(base, '/seat/join', { token: h.agentToken, handle: 'ana-agent' })
  await post(base, '/seat/reply', { token: h.agentToken, text: 'added mul(), tests pass' })
  assert.deepEqual(seen, [['ana-agent', 'added mul(), tests pass']])
  done(h)
})

test('a throwing onSeatReply does not fail the reply the seat already delivered', async () => {
  const h = harness({}, null, { onSeatReply: () => { throw new Error('bookkeeping blew up') } })
  const base = await listen(h.server)
  await post(base, '/seat/join', { token: h.agentToken, handle: 'ana-agent' })
  const res = await post(base, '/seat/reply', { token: h.agentToken, text: 'done' })
  assert.equal(res.status, 200, 'the reply is already in the room; a 500 would make the seat retry it')
  done(h)
})

test('createWeb exposes drain, because the delegate tool is not an HTTP path', async () => {
  // Every HTTP path that accepts an addressed message drains. `delegate`
  // arrives over MCP instead, and with drain unreachable from server.mjs its
  // turn sat in the queue until some unrelated message happened to trigger one.
  const h = harness()
  assert.equal(typeof h.server.drain, 'function')
  done(h)
})
