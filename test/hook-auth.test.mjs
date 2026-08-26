/**
 * POST /hook/* is authenticated, and a seat is launched with hooks at all.
 *
 * Both were review findings, and both are the same shape: a path nothing drove
 * end to end. /hook/* never called memberFrom — every test posted to it
 * happily, because none of them was asking whether it *should* have been
 * allowed to. And room-seat.mjs passed no --settings, so a real seat fired no
 * hooks, while every test posted /seat/hook/Stop by hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harness, listen, post, postHook, done, openSeatFeed, waitUntil } from './helpers/room.mjs'
import { seatArgs, seatHookSettings } from '../scripts/room-seat.mjs'
import { Store, HOOK_EVENTS } from '../src/state.mjs'

// --- /hook/* authentication -------------------------------------------------

test('an unauthenticated Stop cannot end the room\'s in-flight turn', async () => {
  const h = harness()
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.anaToken, text: '@claude run the tests' })
  assert.equal(h.queue.busy(), true, 'guard: a turn should be in flight')

  const res = await post(base, '/hook/Stop', { prompt_id: 'p1', transcript_path: '/nope' })

  assert.equal(res.status, 401)
  assert.equal(h.queue.busy(), true, 'an unauthenticated hook must not end the turn')
  done(h)
})

test('a wrong hook token is refused', async () => {
  const h = harness()
  const base = await listen(h.server)
  const res = await post(base, '/hook/Stop?token=not-the-token', { prompt_id: 'p1' })
  assert.equal(res.status, 401)
  done(h)
})

test('the correct hook token is accepted', async () => {
  const h = harness()
  const base = await listen(h.server)
  await post(base, '/msg', { token: h.anaToken, text: '@claude run the tests' })

  const res = await postHook(base, h, 'Stop', { prompt_id: 'p1', transcript_path: '/nope' })

  assert.equal(res.status, 200)
  await waitUntil(() => h.queue.busy() === false)
  assert.equal(h.queue.busy(), false)
  done(h)
})

test('the hook token is accepted from a header as well as the query string', async () => {
  const h = harness()
  const base = await listen(h.server)
  const res = await fetch(`${base}/hook/Notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-hook-token': h.hookToken },
    body: JSON.stringify({ prompt_id: 'p1', notification_type: 'x' }),
  })
  assert.equal(res.status, 200)
  done(h)
})

test('an unauthenticated PreToolUse cannot fake agent activity for the whole room', async () => {
  const h = harness()
  const base = await listen(h.server)
  const res = await post(base, '/hook/PreToolUse', { prompt_id: 'p1', tool_name: 'rm -rf /' })
  assert.equal(res.status, 401)
  done(h)
})

test('a room with no hook token configured accepts no hooks at all', async () => {
  // Fail closed. An empty token must never mean "anything matches".
  const h = harness({ ROOM_HOOK_TOKEN: '' })
  const base = await listen(h.server)
  assert.equal((await post(base, '/hook/Stop?token=', { prompt_id: 'p' })).status, 401)
  assert.equal((await post(base, '/hook/Stop', { prompt_id: 'p' })).status, 401)
  done(h)
})

test('a member token is not a hook token', async () => {
  // They authenticate different things: a member speaks, a hook reports what
  // the session did. An owner token must not be usable to forge either.
  const h = harness()
  const base = await listen(h.server)
  const res = await post(base, `/hook/Stop?token=${encodeURIComponent(h.owner.token)}`, { prompt_id: 'p1' })
  assert.equal(res.status, 401)
  done(h)
})

// --- the generated local settings file ---------------------------------------

test('the room writes a settings file whose hooks carry the token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roomhooks-'))
  try {
    const store = new Store(dir)
    const path = store.writeHookSettings({ port: 9999, token: 'sekret' })
    const settings = JSON.parse(readFileSync(path, 'utf8'))

    for (const event of Object.keys(HOOK_EVENTS)) {
      const url = settings.hooks[event][0].hooks[0].url
      assert.match(url, /token=sekret/, `${event} hook carries no token`)
      assert.match(url, new RegExp(`/hook/${event}\\?`), `${event} hook points at the wrong route`)
      assert.match(url, /127\.0\.0\.1:9999/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a token needing escaping survives into the settings URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roomhooks-'))
  try {
    const store = new Store(dir)
    const path = store.writeHookSettings({ port: 1, token: 'a+b/c=d&e' })
    const url = JSON.parse(readFileSync(path, 'utf8')).hooks.Stop[0].hooks[0].url
    // Parsed back out, it must be the token we put in — not a truncated one.
    assert.equal(new URL(url).searchParams.get('token'), 'a+b/c=d&e')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- seats get hooks ---------------------------------------------------------

test('a seat is launched with a settings file, or its turns never close', () => {
  const { args } = seatArgs({
    configDir: '/cfg', roomUrl: 'http://room', token: 't',
    handle: 'ana-agent', repo: '/repo', settingsPath: '/cfg/settings.hooks.json',
  })
  const i = args.indexOf('--settings')
  assert.notEqual(i, -1, 'no --settings: the seat fires no hooks and wedges after one turn')
  assert.equal(args[i + 1], '/cfg/settings.hooks.json')
})

test("a seat's hooks point at its own seat routes and carry its own token", () => {
  const settings = seatHookSettings({ roomUrl: 'http://room:8811', token: 'seat-tok' })

  for (const event of Object.keys(HOOK_EVENTS)) {
    const url = settings.hooks[event][0].hooks[0].url
    assert.match(url, new RegExp(`/seat/hook/${event}\\?`), `${event} must use the seat route`)
    assert.match(url, /token=seat-tok/, `${event} carries no seat token`)
    // The local route would attribute the seat's cost to the host and bind to
    // the host's turn — the exact cross-account mistake seats exist to avoid.
    assert.ok(!/\/hook\//.test(url.replace('/seat/hook/', '')), `${event} must not hit the local hook route`)
  }
})

test('a seat closes its turn through the hooks it is actually launched with', async () => {
  // End to end over the wire: build the settings the launcher writes, then
  // drive the room using only the URLs inside them. If those URLs are wrong,
  // the destination stays busy — which is exactly what shipped.
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  const settings = seatHookSettings({ roomUrl: base, token: h.agentToken })

  await post(base, '/msg', { token: h.anaToken, text: '@ana-agent find the TTL' })
  await feed.next()
  assert.equal(h.queue.busy('ana-agent'), true)

  const stopUrl = settings.hooks.Stop[0].hooks[0].url
  await fetch(stopUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_id: 'p1', transcript_path: '/nope' }),
  })

  await waitUntil(() => h.queue.busy('ana-agent') === false)
  assert.equal(h.queue.busy('ana-agent'), false, 'the seat\'s own Stop hook must close its turn')
  feed.close()
  done(h)
})

test('a seat can take a second turn - the wedge is gone', async () => {
  const h = harness()
  const base = await listen(h.server)
  const feed = await openSeatFeed(base, h.agentToken)
  const stopUrl = seatHookSettings({ roomUrl: base, token: h.agentToken }).hooks.Stop[0].hooks[0].url
  const stop = id => fetch(stopUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt_id: id, transcript_path: '/nope' }),
  })

  for (const i of [1, 2, 3]) {
    const res = await post(base, '/msg', { token: h.anaToken, text: `@ana-agent question ${i}` })
    assert.equal(res.status, 200, `message ${i} was refused - the destination is wedged`)
    const ev = await feed.next()
    assert.equal(ev.event, 'turn', `message ${i} never reached the seat`)
    await stop(`p${i}`)
    await waitUntil(() => h.queue.busy('ana-agent') === false)
  }
  feed.close()
  done(h)
})
