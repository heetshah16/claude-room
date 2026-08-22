import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/router.mjs'

const member = { role: 'member', name: 'ana' }
const viewer = { role: 'viewer', name: 'obs' }

test('plain chatter is not addressed', () => {
  const r = classify('anyone know why CI is red?', member)
  assert.equal(r.addressed, false)
  assert.equal(r.reason, 'chatter')
})

test('a leading @claude mention addresses the agent', () => {
  const r = classify('@claude fix the failing test', member)
  assert.equal(r.addressed, true)
  assert.equal(r.reason, 'mention')
})

test('content is preserved verbatim while display strips the mention', () => {
  const r = classify('@claude   fix   it', member)
  assert.equal(r.content, '@claude   fix   it')
  assert.equal(r.display, 'fix   it')
})

test('a mid-sentence mention addresses the agent - this is how people write', () => {
  const r = classify('while that runs — @claude also check the refresh path', member)
  assert.equal(r.addressed, true)
  assert.equal(r.reason, 'mention')
})

test('a mid-sentence mention is left in place in the display copy', () => {
  const r = classify('ask @claude about it later', member)
  assert.equal(r.addressed, true)
  assert.equal(r.display, 'ask @claude about it later')
  assert.equal(r.content, 'ask @claude about it later')
})

test('the mention is case-insensitive and tolerates punctuation', () => {
  assert.equal(classify('@Claude: go', member).addressed, true)
  assert.equal(classify('@CLAUDE, go', member).addressed, true)
})

test('a bare mention with no instruction is chatter, not an empty turn', () => {
  assert.equal(classify('@claude', member).addressed, false)
  assert.equal(classify('@claude   ', member).addressed, false)
})

test('the force flag addresses without a mention', () => {
  const r = classify('fix the test', member, { force: true })
  assert.equal(r.addressed, true)
  assert.equal(r.reason, 'explicit')
  assert.equal(r.display, 'fix the test')
})

test('a viewer can never address, even with force or a mention', () => {
  assert.equal(classify('@claude do it', viewer).addressed, false)
  assert.equal(classify('do it', viewer, { force: true }).addressed, false)
  assert.equal(classify('@claude do it', viewer).reason, 'not-permitted')
})

test('an email-like token is not a mention', () => {
  assert.equal(classify('mail@claude.example.com is the alias', member).addressed, false)
  assert.equal(classify('write to ops@claude.io about it', member).addressed, false)
})

test('a bare domain after the mention is not a mention either', () => {
  assert.equal(classify('the docs live at @claude.example.com', member).addressed, false)
})

test('a mention glued to a preceding word does not count', () => {
  assert.equal(classify('cc:heet@claude help', member).addressed, false)
})

test('empty and whitespace input is never addressed', () => {
  assert.equal(classify('', member, { force: true }).addressed, false)
  assert.equal(classify('   ', member).addressed, false)
})

test('a muted member cannot address, and the reason says so', () => {
  const m = { role: 'member', name: 'ana', muted: true }
  const r = classify('@claude do it', m)
  assert.equal(r.addressed, false)
  assert.equal(r.reason, 'muted')
})

test('the agent handle is configurable', () => {
  const opts = { handles: ['ada'] }
  assert.equal(classify('@ada ship it', member, opts).addressed, true)
  assert.equal(classify('@ada ship it', member, opts).handle, 'ada')
  // The old handle stops working once renamed.
  assert.equal(classify('@claude ship it', member, opts).addressed, false)
})

test('several handles route to the one that was named', () => {
  const opts = { handles: ['claude', 'devops', 'backend'] }
  assert.equal(classify('@devops what is the rollout plan', member, opts).handle, 'devops')
  assert.equal(classify('@backend design the schema', member, opts).handle, 'backend')
  assert.equal(classify('@claude summarise', member, opts).handle, 'claude')
})

test('a handle is reported for a forced message too', () => {
  const r = classify('ship it', member, { force: true, handles: ['ada', 'bob'] })
  assert.equal(r.addressed, true)
  assert.equal(r.handle, 'ada')
})

test('a handle containing regex characters is matched literally', () => {
  const opts = { handles: ['c++'] }
  assert.equal(classify('@c++ help', member, opts).addressed, true)
  assert.equal(classify('@cxx help', member, opts).addressed, false)
})

test('handle matching is case-insensitive but reported lowercase', () => {
  assert.equal(classify('@DevOps go', member, { handles: ['devops'] }).handle, 'devops')
})
