// extension/test/probes.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createProbeQueue } = require('../src/chat/probes.js')

const spy = () => { const sent = []; return { sent, send: t => sent.push(t) } }

test('a requested probe is sent immediately when nothing is in flight', () => {
  const s = spy()
  createProbeQueue({ send: s.send }).request('model')
  assert.deepEqual(s.sent, ['/model'])
})

test('a second probe waits rather than racing the first', () => {
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('model')
  q.request('context')
  assert.deepEqual(s.sent, ['/model'], 'only one probe may be in flight')
})

test('the queued probe goes out when the first one is answered', () => {
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('model')
  q.request('context')
  assert.equal(q.onTurnEnd(), 'model')
  assert.deepEqual(s.sent, ['/model', '/context'])
})

test('a real turn ending reports no probe, so it renders normally', () => {
  const q = createProbeQueue({ send: () => {} })
  assert.equal(q.onTurnEnd(), null)
})

test('output is suppressed only while a probe is in flight', () => {
  // A probe's answer must never reach the transcript: it is the chat talking to
  // itself, and the user did not ask for it.
  const q = createProbeQueue({ send: () => {} })
  assert.equal(q.suppressing(), false)
  q.request('context')
  assert.equal(q.suppressing(), true)
  q.onTurnEnd()
  assert.equal(q.suppressing(), false)
})

test('requesting a probe that is already in flight does not queue a duplicate', () => {
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('context')
  q.request('context')
  q.onTurnEnd()
  assert.deepEqual(s.sent, ['/context'], 'the same probe must not be sent twice')
})

test('requesting a probe already queued does not queue it twice either', () => {
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('model')
  q.request('context')
  q.request('context')
  q.onTurnEnd() // answers model, dispatches context
  q.onTurnEnd() // answers context; nothing left
  assert.deepEqual(s.sent, ['/model', '/context'])
})

test('a probe answering does not itself start another probe', () => {
  // This is the loop guard. /context is requested AT turn-end; if a probe's own
  // turn-end counted as a real turn, the chat would run /context against itself
  // forever.
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('context')
  const answered = q.onTurnEnd()
  assert.equal(answered, 'context')
  assert.deepEqual(s.sent, ['/context'], 'nothing new may be sent by answering')
})

test('an unknown probe name throws rather than sending a bare slash', () => {
  assert.throws(() => createProbeQueue({ send: () => {} }).request('nope'), /nope/)
})
