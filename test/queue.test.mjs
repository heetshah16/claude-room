import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Queue } from '../src/queue.mjs'
import { Ledger } from '../src/ledger.mjs'
import { loadConfig } from '../src/config.mjs'
import { Decisions } from '../src/decisions.mjs'

const mk = (over = {}) =>
  new Queue({
    config: loadConfig({ ROOM_MESSAGES_PER_WINDOW: '3', ...over.env }),
    ledger: new Ledger(),
    decisions: new Decisions(),
    now: over.now ?? (() => 1000),
  })

const ana = { id: 'a', name: 'ana', role: 'member', canApprove: false }
const obs = { id: 'o', name: 'obs', role: 'viewer', canApprove: false }

test('chatter is accepted but never queued for a turn', () => {
  const q = mk()
  const r = q.submit(ana, 'morning all')
  assert.equal(r.ok, true)
  assert.equal(r.message.addressed, false)
  assert.equal(q.pending().length, 0)
})

test('an addressed message is queued', () => {
  const q = mk()
  q.submit(ana, '@claude run the tests')
  assert.equal(q.pending().length, 1)
})

test('a viewer is rejected with a visible reason, never silently', () => {
  const q = mk()
  const r = q.submit(obs, '@claude run the tests')
  assert.equal(r.ok, true)
  assert.equal(r.message.addressed, false)
  assert.equal(r.reason, 'not-permitted')
})

test('the message rate limit rejects rather than dropping', () => {
  const q = mk()
  for (let i = 0; i < 3; i++) assert.equal(q.submit(ana, `@claude ${i}`).ok, true)
  const r = q.submit(ana, '@claude four')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'rate-limited')
})

test('the rate limit is per member, not per room', () => {
  const q = mk()
  for (let i = 0; i < 3; i++) q.submit(ana, `@claude ${i}`)
  assert.equal(q.submit({ id: 'b', name: 'bo', role: 'member' }, '@claude hi').ok, true)
})

test('a token budget rejects a member who is over it', () => {
  const ledger = new Ledger()
  ledger.record(
    'p0',
    { input: 0, output: 900, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'a', weight: 1 }],
    'equal',
  )
  const q = new Queue({
    config: loadConfig({ ROOM_TOKENS_PER_MEMBER: '500' }),
    ledger,
    decisions: new Decisions(),
    now: () => 1000,
  })
  const r = q.submit(ana, '@claude more work')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'over-budget')
})

test('a turn drains every queued message at once - the batching contract', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  q.submit({ id: 'b', name: 'bo', role: 'member' }, '@claude two')
  const turn = q.beginTurn()
  assert.equal(turn.messages.length, 2)
  assert.equal(q.pending().length, 0)
  assert.deepEqual(turn.participants.map(p => p.memberId).sort(), ['a', 'b'])
})

test('only one turn runs at a time', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  assert.ok(q.beginTurn())
  assert.equal(q.busy(), true)
  q.submit(ana, '@claude two')
  assert.equal(q.beginTurn(), null)
  q.endTurn('p1')
  assert.equal(q.busy(), false)
  assert.equal(q.beginTurn().messages.length, 1)
})

test('beginTurn on an empty queue returns null', () => {
  assert.equal(mk().beginTurn(), null)
})

test('participants carry character weight for weighted attribution', () => {
  const q = mk()
  q.submit(ana, '@claude ' + 'x'.repeat(50))
  const turn = q.beginTurn()
  assert.ok(turn.participants[0].weight >= 50)
})

test('participants are recoverable by promptId after the turn ends', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  q.beginTurn()
  q.endTurn('p1')
  assert.deepEqual(q.participantsOf('p1').map(p => p.memberId), ['a'])
})

test('participants are recoverable mid-turn before any promptId is known', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  q.beginTurn()
  assert.deepEqual(q.participantsOf('__inflight__').map(p => p.memberId), ['a'])
})

test('payer is the host by default and rotates when configured', () => {
  const q = mk()
  q.submit(ana, '@claude one')
  assert.equal(q.beginTurn().payer, null)

  const rot = new Queue({
    config: loadConfig({ ROOM_PAYER_MODE: 'rotate' }),
    ledger: new Ledger(),
    decisions: new Decisions(),
    now: () => 1,
  })
  rot.submit({ ...ana, payerRef: 'ana-cred' }, '@claude one')
  assert.equal(rot.beginTurn().payer, 'ana-cred')
})

test('rotation skips members with no credential rather than failing the turn', () => {
  const rot = new Queue({
    config: loadConfig({ ROOM_PAYER_MODE: 'rotate' }),
    ledger: new Ledger(),
    decisions: new Decisions(),
    now: () => 1,
  })
  rot.submit(ana, '@claude one')
  assert.equal(rot.beginTurn().payer, null)
})

test('an addressed message that contradicts an open decision carries conflicts', () => {
  const decisions = new Decisions()
  decisions.add({ text: 'keep the auth service stateless', by: 'heet' })
  const q = new Queue({
    config: loadConfig({}),
    ledger: new Ledger(),
    decisions,
    now: () => 1,
  })
  const r = q.submit(ana, '@claude add a cache layer to auth, it should not be stateless')
  assert.equal(r.conflicts.length, 1)
})
