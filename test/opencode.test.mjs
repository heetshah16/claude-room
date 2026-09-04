import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseModel, promptFromTurn, PendingContext, actionForOpencodeEvent,
} from '../src/opencode.mjs'

test('a model spec splits on the first slash, so model ids may contain slashes', () => {
  assert.deepEqual(parseModel('opencode/mimo-v2.5-free'),
    { providerID: 'opencode', modelID: 'mimo-v2.5-free' })
  assert.deepEqual(parseModel('openrouter/meta/llama-3'),
    { providerID: 'openrouter', modelID: 'meta/llama-3' })
})

test('a model spec without a provider is refused rather than guessed at', () => {
  assert.throws(() => parseModel('mimo'), /provider\/model/)
})

test('a turn is rendered exactly as the channel renders it, so both harnesses see one room', () => {
  // Reusing channel.mjs's renderer is deliberate: a second, hand-maintained
  // copy is how the brief notification drifted once already.
  const one = promptFromTurn([{ name: 'heet', memberId: 'm1', id: 'x', content: 'do the thing' }], 'room')
  assert.equal(one, 'do the thing')

  const many = promptFromTurn([
    { name: 'heet', memberId: 'm1', id: 'x', content: 'do the thing' },
    { name: 'ana', memberId: 'm2', id: 'y', content: 'and this too' },
  ], 'room')
  assert.equal(many, '[heet] do the thing\n[ana] and this too')
})

test('an empty batch produces no prompt at all', () => {
  assert.equal(promptFromTurn([], 'room'), null)
})

test('context accumulates until it is drained, then starts empty again', () => {
  const p = new PendingContext(20)
  p.add('mirror', 'ana-agent said something', 'ana-agent')
  p.add('brief', 'two open threads')
  const first = p.drain()
  assert.match(first.text, /ana-agent said something/)
  assert.match(first.text, /two open threads/)
  assert.equal(first.dropped, 0)
  assert.equal(p.drain().text, '')
})

test('context is bounded, so a seat nobody addresses cannot grow a prompt forever', () => {
  // Mirrors arrive for every turn in the room whether or not this seat is
  // ever addressed. Unbounded, the first prompt would eventually exceed the
  // context window.
  const p = new PendingContext(3)
  for (let i = 1; i <= 5; i++) p.add('mirror', `event ${i}`)
  const { text, dropped } = p.drain()
  assert.equal(dropped, 2)
  assert.doesNotMatch(text, /event 1/)
  assert.match(text, /event 5/)
  assert.match(text, /2 earlier/, 'the drop must be visible, not silent')
})

test('idle for our session ends the turn', () => {
  const a = actionForOpencodeEvent(
    { type: 'session.idle', properties: { sessionID: 'ses_a' } }, 'ses_a')
  assert.equal(a.type, 'end-turn')
})

test('idle for someone else\'s session is ignored, so two seats never end each other\'s turns', () => {
  // One opencode server can host many sessions. Acting on a sessionID we do
  // not own is the same bug class as a seat ending the local channel's turn.
  const a = actionForOpencodeEvent(
    { type: 'session.idle', properties: { sessionID: 'ses_b' } }, 'ses_a')
  assert.equal(a.type, 'ignore')
})

test('retry is reported as its own state, never as progress', () => {
  // A model retrying a 502 forever is stalled. If retry counted as progress
  // the deadline would never fire and the queue destination would wedge.
  const a = actionForOpencodeEvent(
    { type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'retry', attempt: 2 } } },
    'ses_a')
  assert.equal(a.type, 'retry')
  assert.equal(a.attempt, 2)
})

test('a session error is surfaced with its payload', () => {
  const a = actionForOpencodeEvent(
    { type: 'session.error', properties: { sessionID: 'ses_a', error: { name: 'UnknownError' } } },
    'ses_a')
  assert.equal(a.type, 'error')
  assert.equal(a.error.name, 'UnknownError')
})

test('unknown event types are ignored rather than crashing the driver', () => {
  assert.equal(actionForOpencodeEvent({ type: 'file.edited', properties: {} }, 'ses_a').type, 'ignore')
  assert.equal(actionForOpencodeEvent(null, 'ses_a').type, 'ignore')
})
