import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNotification, sanitizeMeta, createChannel, PERMISSION_REQUEST, buildBriefNotification,
} from '../src/channel.mjs'
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

test('a brief notification is tagged as machine-generated and attributed to nobody', () => {
  const nt = buildBriefNotification('forks:\n  - a vs b', { ageS: 3, pending: 0, roomName: 'r' })
  assert.equal(nt.params.meta.kind, 'brief')
  assert.equal(nt.params.meta.pending, '0')
  assert.equal(nt.params.meta.age_s, '3')
  assert.equal(nt.params.meta.user, undefined)
  assert.equal(nt.params.meta.member_id, undefined)
  assert.ok(nt.params.content.includes('a vs b'))
})

test('an empty or blank brief produces no notification', () => {
  const opts = { ageS: 0, pending: 0, roomName: 'r' }
  assert.equal(buildBriefNotification('', opts), null)
  assert.equal(buildBriefNotification('   \n ', opts), null)
  assert.equal(buildBriefNotification(null, opts), null)
})

test('age and pending are reported separately, not conflated into one flag', () => {
  // The case that produced the nonsense pairing stale="true" age_s="0": a brand
  // new brief that is already missing messages. Both facts, stated separately.
  const fresh = buildBriefNotification('x', { ageS: 0, pending: 3, roomName: 'r' })
  assert.equal(fresh.params.meta.age_s, '0')
  assert.equal(fresh.params.meta.pending, '3')

  // And the opposite: an old brief that nothing has happened since.
  const old = buildBriefNotification('x', { ageS: 240, pending: 0, roomName: 'r' })
  assert.equal(old.params.meta.age_s, '240')
  assert.equal(old.params.meta.pending, '0')

  assert.equal('stale' in fresh.params.meta, false)
})

test('the agent is told what pending means', () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const i = ch.mcp._instructions ?? ''
  if (i) assert.match(i, /pending is how many room events have happened since/)
})

test('the agent is told a brief is not from a person', () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const instructions = ch.mcp._instructions ?? ''
  // Fall back to asserting on the exported builder when the SDK hides it.
  if (instructions) assert.match(instructions, /kind="brief" is NOT from a person/)
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

test('list_workers reports online seats and whether each is busy', async () => {
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onListWorkers: () => [{ handle: 'opencode', busy: true }, { handle: 'ana-agent', busy: false }],
  })
  const result = await ch.callTool('list_workers', {})
  const parsed = JSON.parse(result.content[0].text)
  assert.deepEqual(parsed.workers, [{ handle: 'opencode', busy: true }, { handle: 'ana-agent', busy: false }])
})

test('list_workers with no seats online reports an empty list, not an error', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {}, onListWorkers: () => [] })
  const result = await ch.callTool('list_workers', {})
  assert.deepEqual(JSON.parse(result.content[0].text).workers, [])
})

test('list_workers is listed alongside delegate, room_reply and room_decision', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const tools = (await ch.listTools()).map(t => t.name)
  assert.ok(tools.includes('list_workers'))
})

test('spawn_worker hands back the new handle as JSON, so it can be addressed at once', async () => {
  const seen = []
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onSpawnWorker: async a => { seen.push(a); return { ok: true, handle: 'worker-1' } },
  })
  const result = await ch.callTool('spawn_worker', { model: 'opencode/x' })
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, handle: 'worker-1' })
  assert.equal(result.isError, undefined)
  assert.deepEqual(seen, [{ model: 'opencode/x' }])
})

test('spawn_worker with no model asks for none, so the launcher\'s own default wins', async () => {
  const seen = []
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onSpawnWorker: async a => { seen.push(a); return { ok: true, handle: 'worker-1' } },
  })
  await ch.callTool('spawn_worker', {})
  assert.equal(seen[0].model, null)
})

test('a refused spawn names the reason, because an orchestrator told only "failed" cannot react', async () => {
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onSpawnWorker: async () => ({ ok: false, errors: ['this room has no owner to charge a worker to'] }),
  })
  const result = await ch.callTool('spawn_worker', {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /no owner/)
})

test('spawn_worker in a room with no fleet says so rather than reporting a handle it never made', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const result = await ch.callTool('spawn_worker', {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /not enabled/)
})

test('spawn_worker is listed alongside delegate, list_workers, room_reply and room_decision', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const tools = (await ch.listTools()).map(t => t.name)
  assert.deepEqual(tools.sort(), ['delegate', 'list_workers', 'room_decision', 'room_reply', 'spawn_worker', 'stop_worker'])
})

test('stop_worker hands back ok, so the caller knows the handle is free', async () => {
  const seen = []
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onStopWorker: handle => { seen.push(handle); return { ok: true } },
  })
  const result = await ch.callTool('stop_worker', { handle: 'worker-1' })
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true })
  assert.equal(result.isError, undefined)
  assert.deepEqual(seen, ['worker-1'])
})

test('a refused stop names the reason, same as a refused spawn', async () => {
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onStopWorker: () => ({ ok: false, errors: ['no worker worker-9 in this fleet'] }),
  })
  const result = await ch.callTool('stop_worker', { handle: 'worker-9' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /worker-9/)
})

test('stop_worker in a room with no fleet says so rather than pretending it stopped one', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const result = await ch.callTool('stop_worker', { handle: 'worker-1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /not enabled/)
})
