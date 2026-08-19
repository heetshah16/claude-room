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

test('the client never assigns untrusted values through innerHTML', () => {
  const html = renderUI(loadConfig({}))
  const script = html.slice(html.indexOf('<script>'))
  assert.ok(!/\.innerHTML\s*=/.test(script))
})
