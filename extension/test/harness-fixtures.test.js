// extension/test/harness-fixtures.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FIXTURES, resolveTheme } = require('../harness/fixtures.js')

test('every fixture is a list of messages shaped like what panel.js posts', () => {
  const names = Object.keys(FIXTURES)
  assert.ok(names.length > 0, 'there must be at least one fixture')
  for (const name of names) {
    for (const msg of FIXTURES[name]) {
      assert.ok(['stream', 'activity', 'fatal'].includes(msg.type), `${name}: bad type ${msg.type}`)
      if (msg.type === 'stream') assert.ok(typeof msg.event?.kind === 'string', `${name}: stream needs event.kind`)
    }
  }
})

test('a conversation fixture exercises text, a tool call and its result', () => {
  const kinds = FIXTURES.conversation.filter(m => m.type === 'stream').map(m => m.event.kind)
  for (const k of ['text', 'tool', 'tool-result', 'turn-end']) {
    assert.ok(kinds.includes(k), `conversation fixture must include a ${k} event`)
  }
})

test('resolveTheme follows the include chain and lets the outer theme win', () => {
  const files = {
    'a.json': JSON.stringify({ include: './b.json', colors: { 'editor.background': '#111111' } }),
    'b.json': JSON.stringify({ colors: { 'editor.background': '#222222', 'badge.background': '#333333' } }),
  }
  const theme = resolveTheme('a.json', { readFile: p => files[p] })
  assert.equal(theme.colors['editor.background'], '#111111', 'the including theme wins')
  assert.equal(theme.colors['badge.background'], '#333333', 'the included theme fills the rest')
})
