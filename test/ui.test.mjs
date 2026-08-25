import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { renderUI } from '../src/ui.mjs'
import { loadConfig } from '../src/config.mjs'

// Pulls the client `renderSeats` function out of the emitted <script> and runs
// it against a minimal fake DOM. renderSeats is a local function inside the
// page's top-level IIFE, so it is not otherwise reachable from a test - we
// inject one hook line right after 'use strict' that captures it via the
// function-declaration hoisting) before any other top-level statement (which
// would need a real browser: fetch, EventSource, etc.) has a chance to throw.
function extractRenderSeats(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const hookLine = "'use strict';\n  globalThis.__renderSeatsForTest = renderSeats;"
  const hooked = script.replace("'use strict';", hookLine)
  assert.notEqual(hooked, script, 'expected to find the use-strict pragma to hook into')

  function fakeElement() {
    const node = { children: [], className: '', textContent: '', title: '', style: {} }
    node.appendChild = child => { node.children.push(child) }
    return node
  }
  const byId = { seats: fakeElement(), seatCount: fakeElement() }
  const context = {
    document: {
      getElementById: id => byId[id],
      createElement: () => fakeElement(),
    },
    location: { href: 'http://localhost/room' },
    localStorage: { getItem: () => null, setItem: () => {} },
    URL,
    console,
  }
  context.window = context
  vm.createContext(context)
  try {
    // The rest of the top-level script needs a real browser (fetch,
    // EventSource...) and will throw once it gets past the hook line - that's
    // fine, the hook has already run by then.
    vm.runInContext(hooked, context)
  } catch { /* expected - see above */ }

  const renderSeats = context.__renderSeatsForTest
  assert.equal(typeof renderSeats, 'function', 'failed to capture renderSeats from the client script')
  return { renderSeats, seatsBox: byId.seats }
}

test('renders a complete standalone document naming the room', () => {
  const html = renderUI(loadConfig({ ROOM_NAME: 'auth-work' }))
  assert.match(html, /<!doctype html>/i)
  assert.ok(html.includes('auth-work'))
})

test('pulls in no external resources - the room must work offline on a tailnet', () => {
  const html = renderUI(loadConfig({}))
  assert.ok(!/src=["']https?:/i.test(html))
  assert.ok(!/href=["']https?:/i.test(html))
})

test('a room name containing markup cannot break out of the document', () => {
  const html = renderUI(loadConfig({ ROOM_NAME: '</script><img onerror=alert(1)>' }))
  assert.ok(!html.includes('<img onerror'))
  assert.ok(!html.includes('</script><img'))
})

test('the room state panel is present and defaults to observer off', () => {
  const html = renderUI(loadConfig({}))
  assert.ok(html.includes('id="brief"'))
  assert.match(html, /Room state/)
  assert.match(html, /observer off/)
})

test('the client never assigns untrusted values through innerHTML', () => {
  const html = renderUI(loadConfig({}))
  const script = html.slice(html.indexOf('<script>'))
  assert.ok(!/\.innerHTML\s*=/.test(script))
})

test('the admin panel exists in the document but starts hidden', () => {
  const html = renderUI(loadConfig({}))
  assert.ok(html.includes('id="admin"'))
  // The whole card is hidden until /api/admin/state confirms the viewer is an
  // owner, so a non-owner never even sees the controls exist.
  assert.match(html, /id="cAdmin" hidden/)
})

test('icons are SVG, never emoji', () => {
  const html = renderUI(loadConfig({}))
  // Emoji render inconsistently across platforms and are announced as
  // decoration by screen readers.
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), 'found an emoji in the page')
  assert.ok(html.includes('createElementNS'), 'expected inline SVG icons')
})

test('the page respects reduced motion and declares a dark palette', () => {
  const html = renderUI(loadConfig({}))
  assert.match(html, /prefers-reduced-motion/)
  assert.match(html, /prefers-color-scheme: dark/)
})

test('focus is never removed without a visible replacement', () => {
  const html = renderUI(loadConfig({}))
  // Keyboard users must always be able to see where they are.
  assert.match(html, /:focus-visible/, 'expected a global focus-visible rule')
  // Removing an outline is allowed only where a wrapper takes over the job of
  // showing focus — the composer does this so the textarea and its buttons
  // read as one focused control.
  if (/outline:\s*(none|0)\b/.test(html)) {
    assert.match(html, /:focus-within/, 'outline removed with no :focus-within replacement')
    assert.match(html, /:focus-within\s*\{[^}]*box-shadow/, 'the focus-within replacement must be visible')
  }
})

test('the composer no longer hardcodes @claude, since the handle is renameable', () => {
  const html = renderUI(loadConfig({}))
  assert.ok(!html.includes('Prefix @claude'))
})

test('the emitted client script is syntactically valid JavaScript', () => {
  // This file is one large template literal, so a bare '\n' inside the client
  // script becomes a real newline in the output and breaks the whole page - a
  // syntax error kills every handler, so the room renders blank with no clue
  // why. Asserting on substrings never caught it; parsing does.
  const html = renderUI(loadConfig({ ROOM_NAME: 'parse-check' }))
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'expected a <script> block in the page')
  assert.doesNotThrow(() => new Function(script), 'client script must parse')
})

test('the client script parses for any room name, including hostile ones', () => {
  for (const name of ['plain', "it's quoted", '</script>', 'back\\slash', '`tick`']) {
    const html = renderUI(loadConfig({ ROOM_NAME: name }))
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    assert.doesNotThrow(() => new Function(script), `script broke for room name: ${name}`)
  }
})

test('the seats panel is present', () => {
  const html = renderUI(loadConfig({}))
  assert.ok(html.includes('id="seats"'))
  assert.match(html, /Agents/)
})

test('the client script still parses with the seats panel added', () => {
  const html = renderUI(loadConfig({ ROOM_NAME: 'seats' }))
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  assert.doesNotThrow(() => new Function(script))
})

test('the Agents card reads spend from the ledger id the server actually credits (the seat owner)', () => {
  // /seat/hook/* in src/web.mjs records participants as the seat's owner, not
  // the agent's own member id (see docs/superpowers/specs/2026-08-25-agent-seats-design.md
  // §8), so ledger entries only ever exist under the owner's id. If renderSeats
  // looked the spend up by the agent's own id instead, every seat would show 0
  // tokens forever, and a test that only checks a number is present would
  // never notice.
  const html = renderUI(loadConfig({}))
  const { renderSeats, seatsBox } = extractRenderSeats(html)

  const seats = [{ ownerId: 'owner-1', memberId: 'agent-1', handle: 'ana-agent' }]
  const members = [{ id: 'owner-1', name: 'Ana' }]
  // Ledger only has an entry under the owner's id - exactly what the real
  // ledger looks like, since nothing ever credits the agent's own id.
  const ledger = { 'owner-1': { input: 100, output: 50, cacheRead: 0, cacheCreate: 0 } }

  renderSeats(seats, members, ledger)

  const row = seatsBox.children[0]
  const metaText = row.children[2].textContent
  assert.match(metaText, /150/, `expected the owner's 150 tokens to show, got: ${metaText}`)
})
