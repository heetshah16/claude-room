import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderUI } from '../src/ui.mjs'
import { loadConfig } from '../src/config.mjs'

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
