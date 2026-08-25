import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSeed } from '../src/seed.mjs'

const msgs = [
  { name: 'ana', text: 'morning', addressed: false, kind: 'chat' },
  { name: 'heet', text: 'find the TTL', addressed: true, kind: 'chat' },
  { name: 'ana-agent', text: 'found three', addressed: false, kind: 'reply' },
]

test('a seed carries the brief, open decisions and recent conversation', () => {
  const s = buildSeed({
    brief: 'forks:\n  - a vs b',
    decisions: [{ text: 'keep auth stateless' }],
    messages: msgs, limit: 50,
  })
  assert.match(s.text, /a vs b/)
  assert.match(s.text, /keep auth stateless/)
  assert.match(s.text, /find the TTL/)
})

test('chatter is left out of the seed as it is out of everything else', () => {
  const s = buildSeed({ brief: '', decisions: [], messages: msgs, limit: 50 })
  assert.ok(!s.text.includes('morning'))
  assert.equal(s.counts.messages, 2)
})

test('the seed is capped so a long-running room does not blow a new seat window', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ name: 'x', text: 'm' + i, addressed: true, kind: 'chat' }))
  const s = buildSeed({ brief: '', decisions: [], messages: many, limit: 20 })
  assert.equal(s.counts.messages, 20)
  assert.ok(s.text.includes('m499'))       // the most recent survive
  assert.ok(!s.text.includes('m0 '))
})

test('an empty room seeds to a short, valid string', () => {
  const s = buildSeed({ brief: '', decisions: [], messages: [], limit: 50 })
  assert.equal(typeof s.text, 'string')
  assert.equal(s.counts.messages, 0)
})
