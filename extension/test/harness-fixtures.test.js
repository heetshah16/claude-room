// extension/test/harness-fixtures.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { FIXTURES, INTERACTIONS, PAGES, resolveTheme } = require('../harness/fixtures.js')

/**
 * The message types the host actually posts into a webview, read from source.
 *
 * Hardcoding this list meant a fixture for a new message kind was rejected as
 * malformed the moment one was added -- the test failing rather than the thing
 * it was testing. These three files define the protocol between the extension
 * host and its three webviews; read it from them.
 */
const HOST_FILES = ['panel.js', 'worker-panel.js', 'workers-view.js', 'room-view.js']

function postedTypes() {
  const types = new Set()
  for (const file of HOST_FILES) {
    const src = readFileSync(join(__dirname, '..', 'src', 'chat', file), 'utf8')
    for (const [, t] of src.matchAll(/post(?:Message)?\(\{\s*type:\s*'([^']+)'/g)) types.add(t)
  }
  return types
}

test('every fixture is a list of messages shaped like what panel.js posts', () => {
  const allowed = postedTypes()
  assert.ok(allowed.size > 0, 'expected to find the message types panel.js posts')

  const names = Object.keys(FIXTURES)
  assert.ok(names.length > 0, 'there must be at least one fixture')
  for (const name of names) {
    for (const msg of FIXTURES[name]) {
      assert.ok(allowed.has(msg.type), `${name}: ${msg.type} is not a type panel.js posts`)
      if (msg.type === 'stream') assert.ok(typeof msg.event?.kind === 'string', `${name}: stream needs event.kind`)
    }
  }
})

/** The harness page a fixture renders on. */
const pageFor = fixture =>
  readFileSync(join(__dirname, '..', 'harness', PAGES[fixture]?.file ?? 'index.html'), 'utf8')

test('every fixture the harness can click has the ids it clicks', () => {
  // An interaction naming an element the page does not have throws inside the
  // browser, and a screenshot of the un-clicked page looks like the feature
  // simply did nothing. Checked against the fixture's OWN page: fixtures no
  // longer all render index.html.
  for (const [fixture, ids] of Object.entries(INTERACTIONS)) {
    assert.ok(FIXTURES[fixture], `INTERACTIONS names ${fixture}, which is not a fixture`)
    const html = pageFor(fixture)
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `${fixture} clicks #${id}, which its page lacks`)
    }
  }
})

test('every fixture that names a page names one that exists', () => {
  for (const [fixture, page] of Object.entries(PAGES)) {
    assert.ok(FIXTURES[fixture], `PAGES names ${fixture}, which is not a fixture`)
    assert.doesNotThrow(() => pageFor(fixture), `${fixture} names a missing page: ${page.file}`)
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
