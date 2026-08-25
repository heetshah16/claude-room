import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionBroker, REQUEST_ID } from '../src/permissions.mjs'

const owner = { id: 'o', name: 'heet', role: 'owner', canApprove: false }
const member = { id: 'm', name: 'ana', role: 'member', canApprove: false }
const approver = { id: 'p', name: 'bo', role: 'member', canApprove: true }
const req = { request_id: 'abcde', tool_name: 'Bash', description: 'Run shell command', input_preview: 'rm -rf /' }

test('the documented request id alphabet excludes the letter l', () => {
  assert.ok(REQUEST_ID.test('abcde'))
  assert.ok(!REQUEST_ID.test('ablde'))
  assert.ok(!REQUEST_ID.test('abcd'))
})

test('an approver resolves an open request', () => {
  const b = new PermissionBroker()
  b.open(req)
  const r = b.resolve('abcde', approver, 'allow')
  assert.equal(r.ok, true)
  assert.equal(b.pending().length, 0)
})

test('a non-approver is refused and the request stays open', () => {
  const b = new PermissionBroker()
  b.open(req)
  const r = b.resolve('abcde', member, 'allow')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-permitted')
  assert.equal(b.pending().length, 1)
})

test('an owner may always approve', () => {
  const b = new PermissionBroker()
  b.open(req)
  assert.equal(b.resolve('abcde', owner, 'deny').ok, true)
})

test('an unknown request id is dropped, matching Claude Code behaviour', () => {
  const b = new PermissionBroker()
  assert.deepEqual(b.resolve('zzzzz', owner, 'allow'), { ok: false, reason: 'unknown-request' })
})

test('a request cannot be resolved twice', () => {
  const b = new PermissionBroker()
  b.open(req)
  b.resolve('abcde', owner, 'allow')
  assert.equal(b.resolve('abcde', owner, 'deny').reason, 'unknown-request')
})

test('an invalid behaviour is rejected', () => {
  const b = new PermissionBroker()
  b.open(req)
  assert.equal(b.resolve('abcde', owner, 'maybe').reason, 'bad-behavior')
})

test('expired requests are swept', () => {
  let t = 0
  const b = new PermissionBroker({ now: () => t })
  b.open(req)
  t = 6 * 60 * 1000
  assert.equal(b.expire(5 * 60 * 1000).length, 1)
  assert.equal(b.pending().length, 0)
})

test('a pending request records which seat asked', () => {
  const b = new PermissionBroker()
  b.open({ request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: 'ls' }, 'ana-agent')
  assert.equal(b.pending()[0].seat, 'ana-agent')
})

test('two seats can have requests outstanding at once without colliding', () => {
  const b = new PermissionBroker()
  b.open({ request_id: 'abcde', tool_name: 'Bash' }, 'ana-agent')
  b.open({ request_id: 'fghij', tool_name: 'Edit' }, 'heet-agent')
  assert.equal(b.pending().length, 2)
  const r = b.resolve('fghij', { role: 'owner' }, 'allow')
  assert.equal(r.ok, true)
  assert.equal(r.entry.seat, 'heet-agent')
  assert.equal(b.pending()[0].seat, 'ana-agent')
})
