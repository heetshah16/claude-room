import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWeb } from '../src/web.mjs'
import { loadConfig } from '../src/config.mjs'
import { Store } from '../src/state.mjs'
import { Registry, Bans, createMember } from '../src/identity.mjs'
import { createAdmin } from '../src/admin.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'
import { Queue } from '../src/queue.mjs'
import { Bus } from '../src/bus.mjs'
import { PermissionBroker } from '../src/permissions.mjs'
import { TurnLog } from '../src/turns.mjs'

function harness(env = {}, observer = null) {
  const dir = mkdtempSync(join(tmpdir(), 'roomweb-'))
  const config = loadConfig({ ROOM_STATE_DIR: dir, ...env })
  const turns = new TurnLog()
  const order = []
  const briefs = []
  const noted = []
  const registry = new Registry()
  const owner = registry.add(createMember({ name: 'heet', role: 'owner' }))
  const viewer = registry.add(createMember({ name: 'obs', role: 'viewer' }))
  const ledger = new Ledger()
  const decisions = new Decisions()
  const queue = new Queue({ config, ledger, decisions })
  const sent = []
  const verdicts = []
  const permissions = new PermissionBroker()
  const obs = observer
    ? {
        note: e => noted.push(e),
        briefForInjection: observer.brief,
        enabled: () => true,
        paused: () => false,
      }
    : null

  const bans = new Bans()
  const store = new Store(dir)
  const bus = new Bus()
  const addrs = new Map()
  const runtime = {
    joinUrl: t => `http://test/?token=${t}`,
    noteAddr: (id, a) => addrs.set(id, a),
    lastAddrOf: id => addrs.get(id) ?? null,
  }
  const admin = createAdmin({ registry, bans, store, bus, config, queue, runtime })

  const server = createWeb({
    config, registry, ledger, decisions, queue, turns, observer: obs,
    store, bus, permissions, bans, admin, runtime,
    channel: {
      notify: m => { order.push('message'); sent.push(m) },
      notifyBrief: (text, o) => { order.push('brief'); briefs.push({ text, ...o }) },
      sendVerdict: (id, b) => verdicts.push([id, b]),
    },
  })
  return {
    dir, server, owner, viewer, sent, verdicts, queue, ledger, permissions, turns, config,
    order, briefs, noted, bans, admin, registry,
  }
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

test('admin routes are owner-only and reject bad tokens', async () => {
  const h = harness(); const base = await listen(h.server)
  assert.equal((await post(base, '/api/admin/invite', { token: 'bad', name: 'x' })).status, 401)
  assert.equal((await post(base, '/api/admin/invite', { token: h.viewer.token, name: 'x' })).status, 403)
  assert.equal((await fetch(base + '/api/admin/state?token=' + h.viewer.token)).status, 403)
  done(h)
})

test('an owner can invite and immediately use the new token, with no restart', async () => {
  const h = harness(); const base = await listen(h.server)
  const r = await (await post(base, '/api/admin/invite', { token: h.owner.token, name: 'bo' })).json()
  assert.equal(r.ok, true)

  const bo = h.registry.byName('bo')
  const state = await (await fetch(base + '/api/state?token=' + bo.token)).json()
  assert.equal(state.you.name, 'bo')
  done(h)
})

test('a removed member is refused on their next request', async () => {
  const h = harness(); const base = await listen(h.server)
  const token = h.viewer.token
  assert.equal((await fetch(base + '/api/state?token=' + token)).status, 200)

  await post(base, '/api/admin/remove', { token: h.owner.token, memberId: h.viewer.id })
  assert.equal((await fetch(base + '/api/state?token=' + token)).status, 401)
  done(h)
})

test('a ban outranks a still-valid token', async () => {
  const h = harness(); const base = await listen(h.server)
  // Ban the name only, leaving the member in place, to prove the token check
  // is not the only gate.
  h.bans.ban({ name: h.viewer.name })
  assert.equal((await fetch(base + '/api/state?token=' + h.viewer.token)).status, 401)
  done(h)
})

test('renaming the agent handle changes routing live', async () => {
  const h = harness(); const base = await listen(h.server)
  let r = await (await post(base, '/msg', { token: h.owner.token, text: '@claude go' })).json()
  assert.equal(r.addressed, true)

  await post(base, '/api/admin/handles', { token: h.owner.token, handles: ['ada'] })

  r = await (await post(base, '/msg', { token: h.owner.token, text: '@claude go' })).json()
  assert.equal(r.addressed, false)
  r = await (await post(base, '/msg', { token: h.owner.token, text: '@ada go' })).json()
  assert.equal(r.addressed, true)
  done(h)
})

test('pausing rejects work with a visible reason and leaves chatter alone', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/api/admin/pause', { token: h.owner.token, paused: true })

  const blocked = await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  assert.equal(blocked.status, 429)
  assert.equal((await blocked.json()).reason, 'paused')

  const chat = await post(base, '/msg', { token: h.owner.token, text: 'still talking' })
  assert.equal(chat.status, 200)
  done(h)
})

test('muting a member stops them addressing the agent without demoting them', async () => {
  const h = harness(); const base = await listen(h.server)
  const bo = h.registry.add(createMember({ name: 'bo', role: 'member' }))
  await post(base, '/api/admin/mute', { token: h.owner.token, memberId: bo.id, muted: true })

  const r = await (await post(base, '/msg', { token: bo.token, text: '@claude go' })).json()
  assert.equal(r.addressed, false)
  assert.equal(r.reason, 'muted')
  assert.equal(h.registry.byId(bo.id).role, 'member')
  done(h)
})

test('admin state lists members with join URLs, bans and current settings', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/api/admin/ban', { token: h.owner.token, name: 'mallory', reason: 'spam' })
  const s = await (await fetch(base + '/api/admin/state?token=' + h.owner.token)).json()
  assert.equal(s.ok, true)
  assert.ok(s.members.every(m => m.joinUrl.includes('token=')))
  assert.equal(s.bans[0].name, 'mallory')
  assert.deepEqual(s.handles, ['claude'])
  assert.ok(s.commands.includes('rotate'))
  done(h)
})

test('an unknown path is a 404, not a crash', async () => {
  const h = harness(); const base = await listen(h.server)
  assert.equal((await fetch(base + '/nope')).status, 404)
  done(h)
})

test('a turn records the tool calls that ran during it, tied to its message', async () => {
  const h = harness(); const base = await listen(h.server)
  const sent = await (await post(base, '/msg', { token: h.owner.token, text: '@claude find the TTL' })).json()
  assert.equal(sent.addressed, true)

  await post(base, '/hook/PreToolUse', { prompt_id: 'p1', tool_name: 'Read', tool_input: { file_path: 'src/auth.js' } })
  await post(base, '/hook/PostToolUse', { prompt_id: 'p1', tool_name: 'Read' })

  const state = await (await fetch(base + '/api/state?token=' + h.owner.token)).json()
  assert.equal(state.turns.length, 1)
  assert.equal(state.turns[0].activityCount, 2)
  assert.ok(state.openTurnId)

  const turn = await (await fetch(base + `/api/turn?id=${state.turns[0].id}&token=${h.owner.token}`)).json()
  assert.equal(turn.activity[0].tool, 'Read')
  assert.equal(turn.activity[0].input.file_path, 'src/auth.js')
  // The message that caused the turn is recoverable from it.
  assert.equal(turn.msgIds.length, 1)
  done(h)
})

test('turn detail requires a valid token', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  const state = await (await fetch(base + '/api/state?token=' + h.owner.token)).json()
  assert.equal((await fetch(base + `/api/turn?id=${state.turns[0].id}&token=bad`)).status, 401)
  assert.equal((await fetch(base + `/api/turn?id=nope&token=${h.owner.token}`)).status, 404)
  done(h)
})

test('closing a turn stamps usage and cache ratio onto it', async () => {
  const h = harness(); const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  const tp = join(h.dir, 'ft.jsonl')
  writeFileSync(tp, JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 998, cache_creation_input_tokens: 0 } },
  }) + '\n')
  await post(base, '/hook/Stop', { prompt_id: 'p1', transcript_path: tp })

  const state = await (await fetch(base + '/api/state?token=' + h.owner.token)).json()
  assert.equal(state.turns[0].usage.output, 50)
  assert.ok(Math.abs(state.turns[0].ratio - 998 / 1000) < 1e-9)
  assert.equal(state.openTurnId, null)
  done(h)
})

test('the brief is sent as its own event immediately before the message', async () => {
  const h = harness({}, { brief: () => ({ text: 'forks:\n  - a vs b', stale: false, ageS: 2 }) })
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })

  assert.equal(h.briefs.length, 1)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.order, ['brief', 'message'])
  // The member's words are untouched — not even a wrapper.
  assert.equal(h.sent[0][0].content, '@claude go')
  assert.ok(h.briefs[0].text.includes('a vs b'))
  assert.equal(h.briefs[0].stale, false)
  done(h)
})

test('no brief event is emitted when the observer has nothing yet', async () => {
  const h = harness({}, { brief: () => ({ text: '', stale: false, ageS: 0 }) })
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  assert.equal(h.briefs.length, 0)
  assert.equal(h.sent.length, 1)
  done(h)
})

test('a stale brief is injected rather than waited for', async () => {
  const h = harness({}, { brief: () => ({ text: 'threads:\n  - x', stale: true, ageS: 37 }) })
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  assert.equal(h.briefs[0].stale, true)
  assert.equal(h.briefs[0].ageS, 37)
  done(h)
})

test('the observer is fed chatter as well as addressed messages', async () => {
  const h = harness({}, { brief: () => ({ text: '', stale: false, ageS: 0 }) })
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: 'just chatting' })
  await post(base, '/msg', { token: h.owner.token, text: '@claude go' })
  const kinds = h.noted.filter(n => n.kind === 'message').map(n => n.text)
  assert.ok(kinds.includes('just chatting'))
  done(h)
})

test('a closed turn is fed to the observer with its tools and reply', async () => {
  const h = harness({}, { brief: () => ({ text: '', stale: false, ageS: 0 }) })
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.owner.token, text: '@claude find the TTL' })
  await post(base, '/hook/PreToolUse', { prompt_id: 'p1', tool_name: 'Grep', tool_input: { pattern: 'TTL' } })
  await post(base, '/hook/Stop', { prompt_id: 'p1', transcript_path: '/nope' })

  const turnEvt = h.noted.find(n => n.kind === 'turn')
  assert.ok(turnEvt, 'expected a turn event')
  assert.deepEqual(turnEvt.tools, ['Grep'])
  assert.match(turnEvt.ask, /find the TTL/)
  done(h)
})

test('observer spend appears in the ledger payload even though it is not a member', async () => {
  const h = harness()
  const base = await listen(h.server)
  h.ledger.record(
    'obs-1',
    { input: 900, output: 100, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'observer', weight: 1 }],
    'equal',
  )
  const s = await (await fetch(base + '/api/state?token=' + h.owner.token)).json()
  assert.equal(s.ledger.observer.input, 900)
  assert.equal(s.ledger.observer.output, 100)
  done(h)
})

test('state exposes the brief when an observer is attached, and null when not', async () => {
  const withObs = harness({}, { brief: () => ({ text: 'threads:\n  - x', stale: false, ageS: 1 }) })
  let base = await listen(withObs.server)
  let s = await (await fetch(base + '/api/state?token=' + withObs.owner.token)).json()
  assert.equal(s.brief.on, true)
  assert.ok(s.brief.text.includes('x'))
  done(withObs)

  const without = harness()
  base = await listen(without.server)
  s = await (await fetch(base + '/api/state?token=' + without.owner.token)).json()
  assert.equal(s.brief, null)
  done(without)
})

test('a mid-sentence mention now reaches the channel', async () => {
  const h = harness(); const base = await listen(h.server)
  const r = await (await post(base, '/msg', { token: h.owner.token, text: 'while that runs — @claude check the refresh path' })).json()
  assert.equal(r.addressed, true)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0][0].content, 'while that runs — @claude check the refresh path')
  done(h)
})
