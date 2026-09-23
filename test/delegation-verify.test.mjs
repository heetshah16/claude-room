// test/delegation-verify.test.mjs
/**
 * Verified results: what the worker SAID, and what actually HAPPENED.
 *
 * onSeatReply closes a delegation the moment any reply arrives, and nothing
 * confirmed the claim. Now the room runs the delegation's own spec.tests —
 * written by the orchestrator, not by the worker — and reports the real exit
 * code alongside the worker's words.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegator } from '../src/delegation.mjs'
import { buildDelegationResultNotification } from '../src/channel.mjs'
import { Queue } from '../src/queue.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'
import { Seats } from '../src/seats.mjs'
import { loadConfig } from '../src/config.mjs'
import { Registry, createMember, createAgentMember } from '../src/identity.mjs'
import { waitUntil } from './helpers/room.mjs'

const ORCHESTRATOR = { id: 'orchestrator', name: 'claude', role: 'member', muted: false }
const EXEC = { class: 'execution', task: 'add mul()', spec: { files: ['math.js'], tests: ['node --test'] } }
const REASONING = { class: 'reasoning', task: 'which cache strategy?' }

function delegator(verify) {
  const registry = new Registry()
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const agent = registry.add(createAgentMember({
    name: 'worker-1', handle: 'worker-1', ownerId: ana.id, delegatable: true,
  }))
  const seats = new Seats()
  seats.join(agent, { id: 'c1' })
  const queue = new Queue({
    config: loadConfig({ ROOM_HANDLES: 'claude' }), registry, seats,
    ledger: new Ledger(), decisions: new Decisions(),
  })
  const published = []
  const notified = []
  const d = createDelegator({
    queue,
    orchestrator: ORCHESTRATOR,
    store: { appendMessage() {} },
    bus: { publish: (e, data) => published.push([e, data]) },
    channel: { notifyDelegationResult: r => { notified.push(r); return r } },
    drain() {},
    now: () => 1,
    verify,
  })
  const doneEvents = () => published.filter(([e, x]) => e === 'delegation' && x.state === 'done').map(([, x]) => x)
  return { d, queue, published, notified, doneEvents }
}

const PASSED = { ran: true, ok: true, exitCode: 0, output: 'pass 12\n', timedOut: false }
const FAILED = { ran: true, ok: false, exitCode: 1, output: 'not ok 3 - mul\n', timedOut: false }

test('an execution result waits for the real test run rather than closing on the claim', async () => {
  // The whole point: "added mul(), tests pass" is a sentence, not evidence.
  let release
  const gate = new Promise(r => { release = r })
  const { d, queue, notified, doneEvents } = delegator(() => gate)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()

  d.onSeatReply('worker-1', 'added mul(), tests pass')
  assert.deepEqual(notified, [], 'nothing may be reported before the tests have actually run')
  assert.deepEqual(doneEvents(), [])

  release(PASSED)
  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'true')
})

test('a verified result carries both what the worker said and what the room measured', async () => {
  const { d, queue, notified, doneEvents } = delegator(async () => PASSED)
  const r = d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'added mul(), tests pass')
  await waitUntil(() => notified.length === 1)

  assert.equal(notified[0].id, r.id)
  assert.equal(notified[0].text, 'added mul(), tests pass', 'the worker\'s words are untouched')
  assert.equal(notified[0].verified, 'true')
  assert.match(notified[0].verification, /exit 0/)
  const [event] = doneEvents()
  assert.equal(event.verified, 'true', 'the SSE feed sees it too, or the extension relays a claim')
})

test('a failing verification comes back as a result with the real output, not a dead end', async () => {
  // Structurally identical to a rejected brief from the orchestrator's side:
  // evidence plus a decision to make. The room does not retry — it cannot
  // rewrite a brief based on WHY something failed, and that is judgment.
  const { d, queue, notified } = delegator(async () => FAILED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'all done, everything passes')
  await waitUntil(() => notified.length === 1)

  assert.equal(notified[0].verified, 'false')
  assert.match(notified[0].verification, /exit 1/)
  assert.match(notified[0].verification, /not ok 3/, 'the real output is what makes it repairable')
})

test('a timed-out verification is reported as a timeout, not as a passing exit code', async () => {
  const { d, queue, notified } = delegator(async () => ({
    ran: true, ok: false, exitCode: null, output: '', timedOut: true,
  }))
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'false')
  assert.match(notified[0].verification, /timed out/)
})

test('verification is handed the delegation\'s own tests and the seat that ran them', async () => {
  // The worktree is per-seat, so the handle is what decides where this runs.
  const seen = []
  const { d, queue, notified } = delegator(async (record, handle) => {
    seen.push({ tests: record.spec.tests, handle, class: record.class })
    return PASSED
  })
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  await waitUntil(() => notified.length === 1)
  assert.deepEqual(seen, [{ tests: ['node --test'], handle: 'worker-1', class: 'execution' }])
})

test('a reasoning delegation reports verified=none, because there is nothing mechanical to check', async () => {
  // Collapsing "unchecked" into "unverified" would libel every reasoning task.
  const calls = []
  const { d, queue, notified } = delegator(async () => { calls.push(1); return PASSED })
  d.delegate({ ...REASONING, to: '@worker-1' })
  queue.beginTurn()
  const results = d.onSeatReply('worker-1', 'use a write-through cache')
  assert.equal(results.length, 1, 'with nothing to run, the answer is immediate as before')
  assert.equal(notified[0].verified, 'none')
  assert.deepEqual(calls, [], 'and no command is run at all')
})

test('a verification that throws is reported, never swallowed into a silent success', async () => {
  const { d, queue, notified } = delegator(async () => { throw new Error('worktree is gone') })
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'false')
  assert.match(notified[0].verification, /worktree is gone/)
})

test('a delegation is still answered exactly once, even while verification is in flight', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const { d, queue, notified } = delegator(() => gate)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  assert.deepEqual(d.onSeatReply('worker-1', 'and one more thing'), [], 'the record is taken synchronously')
  release(PASSED)
  await waitUntil(() => notified.length === 1)
  assert.equal(notified.length, 1)
})

test('a delegator with no verify wired behaves exactly as it always has', async () => {
  // Every existing caller and every existing test depends on this.
  const { d, queue, notified, doneEvents } = delegator(undefined)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  const results = d.onSeatReply('worker-1', 'added mul()')
  assert.equal(results.length, 1)
  assert.equal(notified[0].verified, undefined)
  assert.equal(doneEvents()[0].verified, undefined)
})

test('the notification carries verified and verification as meta, never in the worker\'s words', async () => {
  const nt = buildDelegationResultNotification(
    {
      id: 'del-1', handle: 'worker-1', class: 'execution', task: 'add mul()',
      text: 'added mul()', verified: 'false', verification: 'exit 1\nnot ok 3', likelySucceeded: true,
    },
    { roomName: 'room' },
  )
  assert.equal(nt.params.content, 'added mul()', 'the seat\'s words stay byte-identical')
  assert.equal(nt.params.meta.verified, 'false')
  assert.match(nt.params.meta.verification, /not ok 3/)
  assert.equal(nt.params.meta.likelySucceeded, 'true')
  for (const k of Object.keys(nt.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/)
})

test('an unverified result omits the fields entirely, so existing consumers are unaffected', () => {
  const nt = buildDelegationResultNotification(
    { id: 'del-1', handle: 'worker-1', class: 'reasoning', task: 't', text: 'answer' },
    { roomName: 'room' },
  )
  assert.equal('verified' in nt.params.meta, false)
  assert.equal('verification' in nt.params.meta, false)
  assert.equal('likelySucceeded' in nt.params.meta, false)
})

const abandonedEvents = published =>
  published.filter(([e, x]) => e === 'delegation' && x.state === 'abandoned').map(([, x]) => x)

test('a worker that did the work but never replied is reported as likely succeeded', async () => {
  // Observed for real in docs/opencode-seat.md: the model completed a genuine
  // edit and simply never called room_reply. Reported as a bare abandonment,
  // the orchestrator re-delegates work that is already done.
  const { d, queue, published, notified } = delegator(async () => PASSED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'seat-disconnected')
  await waitUntil(() => abandonedEvents(published).length === 1)

  const [event] = abandonedEvents(published)
  assert.equal(event.likelySucceeded, true)
  assert.equal(event.verified, 'true')
  assert.equal(event.reason, 'seat-disconnected')

  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'true')
  assert.equal(notified[0].likelySucceeded, true)
  assert.match(notified[0].text, /never reported back/, 'the orchestrator only ever reads the channel')
  assert.equal(notified[0].reason, 'seat-disconnected')
})

test('a real abandonment is still a real abandonment when the tests do not pass', async () => {
  const { d, queue, published, notified } = delegator(async () => FAILED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'no-response')
  await waitUntil(() => abandonedEvents(published).length === 1)

  const [event] = abandonedEvents(published)
  assert.equal(event.likelySucceeded, undefined, 'nothing may claim success here')
  assert.equal(event.verified, 'false')
  assert.deepEqual(notified, [], 'and there is no result to hand back — there is no result')
})

test('an abandoned reasoning delegation is reported exactly as it is today', async () => {
  // No spec.tests means unavoidably unknown. Inventing an answer would be
  // worse than the silence.
  const calls = []
  const { d, queue, published } = delegator(async () => { calls.push(1); return PASSED })
  d.delegate({ ...REASONING, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'no-response')

  const [event] = abandonedEvents(published)
  assert.equal(event.reason, 'no-response')
  assert.equal(event.likelySucceeded, undefined)
  assert.deepEqual(calls, [])
})

test('an abandoned delegation is released from pending whether or not it is verified', async () => {
  // Left behind, a stale record is worse than a leak: the seat's next
  // unrelated reply would come back as this dead delegation's result.
  const { d, queue } = delegator(async () => PASSED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'seat-disconnected')
  assert.equal(d.pending.size, 0, 'released synchronously, before any test has run')
})

test('a verification that throws on the abandoned path still reports the abandonment', async () => {
  const { d, queue, published } = delegator(async () => { throw new Error('worktree is gone') })
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'no-response')
  await waitUntil(() => abandonedEvents(published).length === 1)
  assert.equal(abandonedEvents(published)[0].likelySucceeded, undefined)
})
