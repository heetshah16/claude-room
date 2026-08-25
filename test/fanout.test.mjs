import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fanOut, digestOf } from '../src/fanout.mjs'

const seats = [
  { seatId: 's1', handle: 'ana-agent' },
  { seatId: 's2', handle: 'heet-agent' },
  { seatId: 's3', handle: 'devops' },
]
const msgs = [{ id: 'm1', name: 'ana', content: '@ana-agent find the TTL', text: 'find the TTL' }]

test('an addressed message is a turn for one seat and a mirror for the rest', () => {
  const out = fanOut({ type: 'addressed', handle: 'ana-agent', messages: msgs }, seats)
  const turn = out.filter(d => d.kind === 'turn')
  const mirror = out.filter(d => d.kind === 'mirror')
  assert.deepEqual(turn.map(d => d.seatId), ['s1'])
  assert.deepEqual(mirror.map(d => d.seatId).sort(), ['s2', 's3'])
})

test('chatter reaches no seat at all', () => {
  // The original cost control: unaddressed traffic never enters a context
  // window. It reaches seats only later, compressed, via the observer brief.
  assert.deepEqual(fanOut({ type: 'chatter' }, seats), [])
})

test('an agent reply mirrors to every other seat and never back to itself', () => {
  const out = fanOut({ type: 'reply', fromHandle: 'ana-agent', text: 'found three' }, seats)
  assert.deepEqual(out.map(d => d.seatId).sort(), ['s2', 's3'])
  assert.ok(out.every(d => d.kind === 'mirror'))
})

test('a mirror is never a turn - agents cannot be made to act by other agents', () => {
  const out = fanOut({ type: 'reply', fromHandle: 'ana-agent', text: '@heet-agent go do this' }, seats)
  assert.equal(out.some(d => d.kind === 'turn'), false)
})

test('a turn digest mirrors what another agent did, not what it read', () => {
  const out = fanOut({
    type: 'turn-digest', fromHandle: 'ana-agent',
    tools: ['Grep', 'Read', 'Edit'], outcome: 'tests failed',
  }, seats)
  assert.deepEqual(out.map(d => d.seatId).sort(), ['s2', 's3'])
  assert.match(out[0].payload.text, /Grep/)
  assert.match(out[0].payload.text, /tests failed/)
})

test('addressing a handle with no live seat yields nothing to deliver', () => {
  assert.deepEqual(fanOut({ type: 'addressed', handle: 'ghost', messages: msgs }, seats), [])
})

test('with a single seat there is nothing to mirror', () => {
  const one = [{ seatId: 's1', handle: 'ana-agent' }]
  const out = fanOut({ type: 'addressed', handle: 'ana-agent', messages: msgs }, one)
  assert.deepEqual(out.map(d => d.kind), ['turn'])
})

test('a digest names tools and outcome but never carries tool output', () => {
  const d = digestOf({
    preview: 'find the TTL',
    activity: [
      { kind: 'tool-start', tool: 'Read', input: { file_path: 'a.js' } },
      { kind: 'tool-end', tool: 'Read', output: 'THE ENTIRE FILE CONTENTS' },
    ],
    replies: [{ text: 'done' }],
  })
  assert.match(d, /Read/)
  assert.ok(!d.includes('THE ENTIRE FILE CONTENTS'))
})

test('a digest deduplicates tool names, preserving first-seen order', () => {
  const d = digestOf({
    preview: 'scan and fix',
    activity: [
      { kind: 'tool-start', tool: 'Read', input: { file_path: 'a.js' } },
      { kind: 'tool-start', tool: 'Grep', input: { pattern: 'TODO' } },
      { kind: 'tool-start', tool: 'Read', input: { file_path: 'b.js' } },
      { kind: 'tool-start', tool: 'Edit', input: { file_path: 'a.js' } },
      { kind: 'tool-start', tool: 'Read', input: { file_path: 'c.js' } },
    ],
    replies: [{ text: 'fixed' }],
  })
  // Should see distinct tools: Read, Grep, Edit (in that order)
  assert.match(d, /Read.*Grep.*Edit/)
  // Should not have 'Read' three times
  const readCount = (d.match(/Read/g) || []).length
  assert.equal(readCount, 1)
})
