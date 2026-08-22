import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.mjs'

test('defaults are safe', () => {
  const c = loadConfig({})
  assert.equal(c.port, 8787)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.payerMode, 'host')
  assert.equal(c.permissionRelay, false)
  assert.equal(c.splitMode, 'equal')
})

test('env overrides are parsed and typed', () => {
  const c = loadConfig({
    ROOM_PORT: '9000',
    ROOM_HOST: '100.64.0.1',
    ROOM_NAME: 'auth-work',
    ROOM_PAYER_MODE: 'rotate',
    ROOM_PERMISSION_RELAY: '1',
    ROOM_TOKENS_PER_MEMBER: '50000',
  })
  assert.equal(c.port, 9000)
  assert.equal(c.host, '100.64.0.1')
  assert.equal(c.roomName, 'auth-work')
  assert.equal(c.payerMode, 'rotate')
  assert.equal(c.permissionRelay, true)
  assert.equal(c.budgets.tokensPerMember, 50000)
})

test('an unknown payer mode falls back to host rather than throwing', () => {
  assert.equal(loadConfig({ ROOM_PAYER_MODE: 'nonsense' }).payerMode, 'host')
})

test('observer settings default to off and safe', () => {
  const c = loadConfig({})
  assert.equal(c.observer.on, false)
  assert.equal(c.observer.model, 'haiku')
  assert.equal(c.observer.debounceMs, 15000)
  assert.equal(c.observer.maxEvents, 8)
  assert.equal(c.observer.notes, true)
  assert.equal(c.observer.notesPerWindow, 6)
})

test('observer settings read from env, and notes need an explicit zero to silence', () => {
  const c = loadConfig({ ROOM_OBSERVER: '1', ROOM_OBSERVER_DEBOUNCE_MS: '900', ROOM_OBSERVER_NOTES: '0' })
  assert.equal(c.observer.on, true)
  assert.equal(c.observer.debounceMs, 900)
  assert.equal(c.observer.notes, false)
  assert.equal(loadConfig({ ROOM_OBSERVER: '1' }).observer.notes, true)
})
