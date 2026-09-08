// extension/test/commands.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { COMMANDS, filterEntries } = require('../src/chat/commands.js')

test('only print-mode-verified commands are offered', () => {
  const names = COMMANDS.map(c => c.name)
  for (const ok of ['/model', '/context', '/cost', '/mcp']) {
    assert.ok(names.includes(ok), `${ok} is verified to work and must be offered`)
  }
  // Each of these was probed against the real binary and answers "isn't
  // available in this environment" or "Unknown command". Offering one produces
  // a dead menu item that fails in a way the user cannot diagnose.
  for (const bad of ['/help', '/status', '/permissions', '/todos', '/agents']) {
    assert.ok(!names.includes(bad), `${bad} does not work in print mode and must not be offered`)
  }
})

test('every command carries a summary, so the list is readable', () => {
  for (const c of COMMANDS) {
    assert.equal(typeof c.summary, 'string')
    assert.ok(c.summary.length > 0, `${c.name} needs a summary`)
    assert.equal(typeof c.sends, 'boolean')
  }
})

test('filtering matches on name', () => {
  const out = filterEntries(COMMANDS, 'mod')
  assert.equal(out[0].name, '/model')
})

test('filtering matches on summary too, so plain words find things', () => {
  const entries = [{ name: '/context', summary: 'what is filling the context window' }]
  assert.equal(filterEntries(entries, 'filling').length, 1)
})

test('a prefix match outranks a match in the middle of a word', () => {
  const entries = [
    { name: '/xcost', summary: 'not this one' },
    { name: '/cost', summary: 'this one' },
  ]
  assert.equal(filterEntries(entries, 'cost')[0].name, '/cost')
})

test('a plugin skill is found by its skill name, not just its plugin prefix', () => {
  // Typing "brain" must reach /superpowers:brainstorming -- otherwise every
  // plugin skill is only reachable by knowing which plugin it came from.
  const entries = [{ name: '/superpowers:brainstorming', summary: 'Explores intent' }]
  assert.equal(filterEntries(entries, 'brain').length, 1)
})

test('an empty query returns everything, so opening the menu shows the menu', () => {
  assert.equal(filterEntries(COMMANDS, '').length, COMMANDS.length)
})

test('filtering is case-insensitive', () => {
  assert.equal(filterEntries(COMMANDS, 'MODEL')[0].name, '/model')
})

test('a query matching nothing returns nothing rather than everything', () => {
  assert.deepEqual(filterEntries(COMMANDS, 'zzzznope'), [])
})

test('order within a score band follows the registry, so the menu is stable', () => {
  const entries = [
    { name: '/aaa', summary: 'shared word' },
    { name: '/bbb', summary: 'shared word' },
  ]
  assert.deepEqual(filterEntries(entries, 'shared').map(e => e.name), ['/aaa', '/bbb'])
})
