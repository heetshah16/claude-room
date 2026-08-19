import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Decisions, extractTags } from '../src/decisions.mjs'

test('tags come from meaningful words, stopwords excluded', () => {
  const tags = extractTags('keep the auth service stateless')
  assert.ok(tags.includes('auth'))
  assert.ok(tags.includes('stateless'))
  assert.ok(!tags.includes('the'))
})

test('a superseding decision closes the one it replaces', () => {
  const d = new Decisions()
  const first = d.add({ text: 'use redis for sessions', by: 'heet' })
  d.add({ text: 'use postgres for sessions', by: 'ana', supersedes: first.id })
  const openIds = d.open().map(x => x.id)
  assert.ok(!openIds.includes(first.id))
  assert.equal(d.open().length, 1)
})

test('a negation of an open decision is flagged as a conflict', () => {
  const d = new Decisions()
  d.add({ text: 'keep the auth service stateless', by: 'heet' })
  const c = d.conflicts('add a cache layer to auth so it is not stateless')
  assert.equal(c.length, 1)
  assert.equal(c[0].reason, 'negation')
})

test('strong topic overlap without negation is flagged as overlap, not negation', () => {
  const d = new Decisions()
  d.add({ text: 'auth tokens expire after thirty minutes', by: 'heet' })
  const c = d.conflicts('change auth tokens to expire after seven days')
  assert.equal(c.length, 1)
  assert.equal(c[0].reason, 'overlap')
  assert.ok(c[0].overlap.includes('auth'))
})

test('unrelated text produces no conflicts', () => {
  const d = new Decisions()
  d.add({ text: 'keep the auth service stateless', by: 'heet' })
  assert.equal(d.conflicts('update the readme typo').length, 0)
})

test('superseded decisions are never flagged', () => {
  const d = new Decisions()
  const first = d.add({ text: 'keep auth stateless', by: 'heet' })
  d.add({ text: 'auth may hold state now', by: 'ana', supersedes: first.id })
  const c = d.conflicts('auth should not be stateless')
  assert.ok(c.every(x => x.decision.id !== first.id))
})

test('round-trips through JSON', () => {
  const d = new Decisions()
  d.add({ text: 'keep auth stateless', by: 'heet' })
  const back = Decisions.fromJSON(JSON.parse(JSON.stringify(d.toJSON())))
  assert.equal(back.open().length, 1)
  assert.equal(back.conflicts('do not keep auth stateless').length, 1)
})
