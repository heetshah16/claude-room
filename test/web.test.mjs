import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWeb } from '../src/web.mjs'
import { loadConfig } from '../src/config.mjs'
import { Store } from '../src/state.mjs'
import { Registry, createMember } from '../src/identity.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'
import { Queue } from '../src/queue.mjs'
import { Bus } from '../src/bus.mjs'
import { PermissionBroker } from '../src/permissions.mjs'

function harness(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roomweb-'))
  const config = loadConfig({ ROOM_STATE_DIR: dir, ...env })
  const registry = new Registry()
  const owner = registry.add(createMember({ name: 'heet', role: 'owner' }))
  const viewer = registry.add(createMember({ name: 'obs', role: 'viewer' }))
  const ledger = new Ledger()
  const decisions = new Decisions()
  const queue = new Queue({ config, ledger, decisions })
  const sent = []
  const verdicts = []
  const permissions = new PermissionBroker()
  const server = createWeb({
    config, registry, ledger, decisions, queue,
    store: new Store(dir), bus: new Bus(), permissions,
    channel: { notify: m => sent.push(m), sendVerdict: (id, b) => verdicts.push([id, b]) },
  })
  return { dir, server, owner, viewer, sent, verdicts, queue, ledger, permissions, config }
}

const listen = server =>
  new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))

const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const done = h => { h.server.close(); rmSync(h.dir, { recursive: true, force: true }) }

test('POST /msg without a valid token is refused', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await post(base, '/msg', { token: 'nope', text: 'hi' })
  assert.equal(res.status, 401)
  done(h)
})

test('chatter is accepted and never notified to the channel', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await post(base, '/msg', { token: h.owner.token, text: 'morning' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).addressed, false)
  assert.equal(h.sent.length, 0)
  done(h)
})

test('an addressed message reaches the channel exactly once, verbatim', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0][0].content, '@claude go')
  done(h)
})

test('a viewer addressing Claude is downgraded to chatter, not forwarded', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await post(base, '/msg', { token: h.viewer.token, text: '@claude delete everything' })
  assert.equal((await res.json()).addressed, false)
  assert.equal(h.sent.length, 0)
  done(h)
})

test('a second message while Claude is busy queues instead of starting a turn', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude one' })
  await post(base, '/msg', { token: h.owner.token, text: '@claude two' })
  assert.equal(h.sent.length, 1)
  assert.equal(h.queue.pending().length, 1)
  done(h)
})

test('a Stop hook records usage against the turn participants and drains the queue', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  await post(base, '/msg', { token: h.owner.token, text: '@claude also this' })

  const tp = join(h.dir, 'fake-transcript.jsonl')
  writeFileSync(tp, JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 1, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } },
  }) + '\n')

  await post(base, '/hook/Stop', { hook_event_name: 'Stop', prompt_id: 'p1', transcript_path: tp })
  assert.equal(h.ledger.totalsFor(h.owner.id).output, 40)
  // The queued second message became the next turn.
  assert.equal(h.sent.length, 2)
  done(h)
})

test('hook ingest always answers 200 so a hook never blocks a turn', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(base + '/hook/PostToolUse', { method: 'POST', body: 'not json at all' })
  assert.equal(res.status, 200)
  done(h)
})

test('a Stop hook with an unreadable transcript still ends the turn', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  await post(base, '/hook/Stop', { prompt_id: 'p9', transcript_path: '/no/such/file' })
  assert.equal(h.queue.busy(), false)
  done(h)
})

test('GET /api/state returns members, ledger totals and recent messages', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(base + '/api/state?token=' + h.owner.token)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.you.name, 'heet')
  assert.equal(body.you.canApprove, true)
  assert.ok(Array.isArray(body.members))
  assert.ok(Array.isArray(body.messages))
  done(h)
})

test('a viewer never sees pending approvals', async () => {
  const h = harness(); const base = await listen(h.server)
  h.permissions.open({ request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: 'ls' })
  const asViewer = await (await fetch(base + '/api/state?token=' + h.viewer.token)).json()
  const asOwner = await (await fetch(base + '/api/state?token=' + h.owner.token)).json()
  assert.equal(asViewer.pendingApprovals.length, 0)
  assert.equal(asOwner.pendingApprovals.length, 1)
  done(h)
})

test('an owner verdict is relayed to the channel; a viewer verdict is refused', async () => {
  const h = harness(); const base = await listen(h.server)
  h.permissions.open({ request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: 'ls' })

  const bad = await post(base, '/verdict', { token: h.viewer.token, request_id: 'abcde', behavior: 'allow' })
  assert.equal(bad.status, 403)
  assert.equal(h.verdicts.length, 0)

  const good = await post(base, '/verdict', { token: h.owner.token, request_id: 'abcde', behavior: 'allow' })
  assert.equal(good.status, 200)
  assert.deepEqual(h.verdicts, [['abcde', 'allow']])
  done(h)
})

test('an upload is stored and forwarded with its path in the message', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(
    base + '/upload?token=' + h.owner.token + '&name=notes.txt&text=' + encodeURIComponent('@claude read this'),
    { method: 'POST', body: 'hello file' },
  )
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok(body.path.endsWith('.txt'))
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0][0].attachment.name, 'notes.txt')
  done(h)
})

test('an upload filename cannot escape the upload directory', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(
    base + '/upload?token=' + h.owner.token + '&name=' + encodeURIComponent('../../evil.sh'),
    { method: 'POST', body: 'x' },
  )
  const body = await res.json()
  assert.ok(!body.path.includes('..'))
  assert.ok(body.path.includes('uploads'))
  done(h)
})

test('the SSE endpoint sets the event-stream content type and refuses bad tokens', async () => {
  const h = harness(); const base = await listen(h.server)
  assert.equal((await fetch(base + '/events?token=bad')).status, 401)

  const ctrl = new AbortController()
  const res = await fetch(base + '/events?token=' + h.owner.token, { signal: ctrl.signal })
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  ctrl.abort()
  done(h)
})

test('the root path serves the UI without a token', async () => {
  const h = harness(); const base = await listen(h.server)
  const res = await fetch(base + '/')
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<!doctype html>/i)
  done(h)
})

test('an unknown path is a 404, not a crash', async () => {
  const h = harness(); const base = await listen(h.server)
  assert.equal((await fetch(base + '/nope')).status, 404)
  done(h)
})
