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

test('the mention must lead - mid-sentence mentions stay chatter', () => {
  assert.equal(classify('ask @claude about it later', member).addressed, false)
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
})

test('empty and whitespace input is never addressed', () => {
  assert.equal(classify('', member, { force: true }).addressed, false)
  assert.equal(classify('   ', member).addressed, false)
})
