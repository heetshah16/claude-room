import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNotification, sanitizeMeta, createChannel, PERMISSION_REQUEST } from '../src/channel.mjs'
import { loadConfig } from '../src/config.mjs'

const msg = (over = {}) => ({
  id: 'm1', memberId: 'a', name: 'ana', content: '@claude fix it', text: 'fix it', ts: 1, ...over,
})

test('meta keys with hyphens are dropped - Claude Code silently discards them', () => {
  const clean = sanitizeMeta({ chat_id: 'x', 'bad-key': 'y', ok2: 'z' })
  assert.deepEqual(Object.keys(clean).sort(), ['chat_id', 'ok2'])
})

test('meta values are coerced to strings', () => {
  assert.equal(sanitizeMeta({ n: 5 }).n, '5')
})

test('a single message keeps its content verbatim, mention and all', () => {
  const nt = buildNotification([msg()], 'room')
  assert.equal(nt.method, 'notifications/claude/channel')
  assert.equal(nt.params.content, '@claude fix it')
})

test('attribution rides in meta, never in content', () => {
  const nt = buildNotification([msg()], 'room')
  assert.equal(nt.params.meta.user, 'ana')
  assert.equal(nt.params.meta.member_id, 'a')
  assert.equal(nt.params.meta.room, 'room')
  assert.ok(!nt.params.content.includes('ana'))
})

test('a batch labels each speaker without altering anyone\'s words', () => {
  const nt = buildNotification(
    [msg(), msg({ id: 'm2', memberId: 'b', name: 'bo', content: 'and revert auth' })],
    'room',
  )
  assert.ok(nt.params.content.includes('ana'))
  assert.ok(nt.params.content.includes('bo'))
  assert.ok(nt.params.content.includes('@claude fix it'))
  assert.ok(nt.params.content.includes('and revert auth'))
  assert.equal(nt.params.meta.batch, '2')
})

test('an attachment path travels in meta so it cannot be forged in text', () => {
  const nt = buildNotification([msg({ attachment: { path: '/tmp/x.png', name: 'x.png' } })], 'room')
  assert.equal(nt.params.meta.file_path, '/tmp/x.png')
})

test('every produced meta key is a legal identifier', () => {
  const nt = buildNotification([msg({ attachment: { path: '/tmp/x', name: 'x' } })], 'room')
  for (const k of Object.keys(nt.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/)
})

test('an empty batch produces no notification', () => {
  assert.equal(buildNotification([], 'room'), null)
})

test('the permission capability is declared only when relay is enabled', () => {
  const off = createChannel({ config: loadConfig({}), onReply() {}, onDecision() {} })
  const on = createChannel({ config: loadConfig({ ROOM_PERMISSION_RELAY: '1' }), onReply() {}, onDecision() {} })
  const caps = s => s.mcp.getCapabilities?.() ?? {}
  assert.equal('claude/channel/permission' in (caps(off).experimental ?? {}), false)
  assert.equal('claude/channel/permission' in (caps(on).experimental ?? {}), true)
})

test('a relayed permission request reaches the registered callback', async () => {
  const ch = createChannel({ config: loadConfig({ ROOM_PERMISSION_RELAY: '1' }), onReply() {}, onDecision() {} })
  const seen = []
  ch.onPermissionRequest(p => seen.push(p))
  await ch.mcp.fallbackNotificationHandler({
    method: PERMISSION_REQUEST,
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: 'ls' },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].request_id, 'abcde')
})

test('an unrelated notification does not reach the permission callback', async () => {
  const ch = createChannel({ config: loadConfig({ ROOM_PERMISSION_RELAY: '1' }), onReply() {}, onDecision() {} })
  const seen = []
  ch.onPermissionRequest(p => seen.push(p))
  await ch.mcp.fallbackNotificationHandler({ method: 'notifications/something/else', params: {} })
  assert.equal(seen.length, 0)
})
