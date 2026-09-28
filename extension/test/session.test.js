// extension/test/session.test.js
//
// Everything that used to be unreachable inside openChat(): starting the room,
// waiting for it, the one SSE subscription, and the room controls. All of it is
// testable here because the only two things that genuinely need VS Code -- a
// dialog and the clipboard -- arrive as `ui`.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSession } = require('../src/session.js')

/** An SSE body: one `getReader()` handing out the frames, then done. */
function sseBody(frames) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    getReader: () => ({
      read: async () => (i < frames.length
        ? { done: false, value: encoder.encode(frames[i++]) }
        : { done: true, value: undefined }),
    }),
  }
}

function harness(over = {}) {
  const started = []
  const stopped = []
  const errors = []
  const infos = []
  const copied = []
  let clock = 0
  const session = createSession({
    repoRoot: '/repo',
    stateDir: '/state',
    ui: {
      showError: m => errors.push(String(m)),
      showInfo: m => infos.push(String(m)),
      copy: async t => copied.push(String(t)),
    },
    pickPort: async () => 51820,
    readToken: () => 'owner-token',
    detectTunnel: () => true,
    isLoggedIn: async () => true,
    // No real waiting anywhere: the clock advances a second per read, so a
    // poll that is going to time out does so immediately.
    sleep: async () => {},
    now: () => (clock += 1000),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    log: () => {},
    ...over,
    // DEVIATION FROM THE BRIEF (see task-4 report): `supervisor` moved after
    // `...over`. The brief has it before, with its own `...(over.supervisor
    // ?? {})` merge inside -- but the later `...over` then replaces the whole
    // `supervisor` key wholesale, discarding that merge, so a test that
    // overrides only `status` (like "a tunnel that never prints a URL...")
    // gets a supervisor with no `start`/`stop` at all. Moving this key after
    // `...over` is what makes the inner merge the one that actually wins.
    supervisor: {
      start: (name, recipe) => { started.push({ name, recipe }); return { child: { pid: 1 } } },
      stop: name => stopped.push(name),
      status: () => ({ output: 'Connect via browser: https://abc-1234.inc1.devtunnels.ms\n' }),
      ...(over.supervisor ?? {}),
    },
  })
  return { session, started, stopped, errors, infos, copied }
}

test('start launches the room on a port nothing else holds, then waits for its token', async () => {
  const { session, started } = harness()
  const r = await session.start()
  assert.equal(r.ok, true)
  assert.equal(session.roomUrl, 'http://127.0.0.1:51820')
  assert.equal(session.token, 'owner-token')
  assert.equal(started[0].name, 'room')
  assert.equal(started[0].recipe.opts.env.ROOM_PORT, '51820')
  assert.equal(started[0].recipe.opts.env.ROOM_HOST, '127.0.0.1')
})

test('a room that never writes its token fails loudly instead of hanging', async () => {
  // Hanging here is the worst outcome: a sidebar that never says anything and
  // a room process nobody stops.
  const { session, stopped } = harness({ readToken: () => null })
  const r = await session.start()
  assert.equal(r.ok, false)
  assert.match(r.error, /owner token/)
  assert.deepEqual(stopped, ['room'], 'the half-started room must not be left running')
})

test('a room that never listens fails rather than handing back a dead client', async () => {
  const { session } = harness({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  const r = await session.start()
  assert.equal(r.ok, false)
  assert.match(r.error, /start listening/)
})

test('starting twice reuses the one room, because two would fight over the state dir', async () => {
  const { session, started } = harness()
  await session.start()
  await session.start()
  assert.equal(started.filter(s => s.name === 'room').length, 1)
})

test('one subscription feeds the pool, the activity listeners and the relay', async () => {
  // ARCHITECTURE.md: one subscription, one ordering. A second would let a
  // worker's reply reach the orchestrator before the panel showed the work.
  const frames = [
    'event: delegation\ndata: {"id":"d1","to":"worker-1","state":"sent","task":"Add tests"}\n\n',
    'event: delegation\ndata: {"id":"d1","to":"worker-1","state":"done","text":"added 4"}\n\n',
  ]
  let feeds = 0
  let workerAdded = false
  const { session } = harness({
    fetchImpl: async url => {
      if (String(url).includes('/events')) {
        feeds++
        // Gated on `workerAdded`: this subscription and pool.add()'s own round
        // trip are both microtask chains kicked off from session.start(), and
        // without this the SSE frames can be fully delivered -- and dropped,
        // for a handle nothing has registered yet -- before pool.add() ever
        // resolves. Waiting for the real signal rather than guessing a tick
        // count is what makes this deterministic.
        const real = sseBody(frames).getReader()
        return {
          ok: true, status: 200,
          body: { getReader: () => ({
            read: async () => {
              while (!workerAdded) await new Promise(resolve => setImmediate(resolve))
              return real.read()
            },
          }) },
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, handle: 'worker-1' }) }
    },
  })
  const activity = []
  const results = []
  session.onActivity(a => activity.push(a))
  session.onDelegationResult(d => results.push(d))
  await session.start()
  await session.pool.add()
  workerAdded = true
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(feeds, 1, 'exactly one subscription')
  assert.equal(activity[0].kind, 'delegation-sent')
  assert.equal(results[0].text, 'added 4')
  assert.equal(session.pool.list()[0].state, 'idle', 'the pool saw the same stream')
})

test('a malformed frame does not kill the feed', async () => {
  const frames = [
    'event: delegation\ndata: {not json}\n\n',
    'event: delegation\ndata: {"id":"d1","to":"w","state":"done","text":"ok"}\n\n',
  ]
  const { session } = harness({
    fetchImpl: async url => (String(url).includes('/events')
      ? { ok: true, status: 200, body: sseBody(frames) }
      : { ok: true, status: 200, json: async () => ({}) }),
  })
  const results = []
  session.onDelegationResult(d => results.push(d))
  await session.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(results.length, 1)
})

test('stop ends the feed rather than reconnecting against a room nobody started', async () => {
  let feeds = 0
  const { session } = harness({
    fetchImpl: async url => {
      if (String(url).includes('/events')) { feeds++; return { ok: true, status: 200, body: sseBody([]) } }
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  await session.start()
  session.stop()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(feeds, 1)
})

test('the roster is reported as unknown when the call failed, never as empty', async () => {
  // "Nobody is here" because the room was briefly restarting is a confident
  // lie about who can read the room.
  const { session } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/state')
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  const rooms = []
  session.onRoom(r => rooms.push(r))
  await session.start()
  await session.postRoom()
  assert.equal(rooms.at(-1).members, null)
})

test('the advertised address comes from a join link, not from a local guess', async () => {
  const { session } = harness({
    fetchImpl: async url => {
      if (String(url).includes('/api/admin/state')) {
        return { ok: true, status: 200, json: async () => ({
          members: [{ id: 'm0', name: 'you', role: 'owner', joinUrl: 'https://abc-1234.inc1.devtunnels.ms/?token=SECRET' }],
        }) }
      }
      return { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }
    },
  })
  const rooms = []
  session.onRoom(r => rooms.push(r))
  await session.start()
  await session.postRoom()
  assert.equal(rooms.at(-1).advertised, 'https://abc-1234.inc1.devtunnels.ms/?token=SECRET')
  assert.deepEqual(rooms.at(-1).members, [{ id: 'm0', name: 'you', role: 'owner' }])
})

test('an agent member\'s kind is passed through, so the UI can tell a worker from a person', async () => {
  const { session } = harness({
    fetchImpl: async url => {
      if (String(url).includes('/api/admin/state')) {
        return { ok: true, status: 200, json: async () => ({
          members: [
            { id: 'm0', name: 'you', role: 'owner' },
            { id: 'm1', name: 'worker-1', role: 'member', kind: 'agent', handle: 'worker-1' },
          ],
        }) }
      }
      return { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }
    },
  })
  const rooms = []
  session.onRoom(r => rooms.push(r))
  await session.start()
  await session.postRoom()
  assert.deepEqual(rooms.at(-1).members, [
    { id: 'm0', name: 'you', role: 'owner' },
    { id: 'm1', name: 'worker-1', role: 'member', kind: 'agent' },
  ])
})

test('an invite goes to the clipboard, never through a listener', async () => {
  // The token IS the identity: it must not reach anything that renders.
  const { session, copied, infos } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/invite')
      ? { ok: true, status: 200, json: async () => ({ ok: true, joinUrl: 'https://x/?token=SECRETTOKEN' }) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  const rooms = []
  session.onRoom(r => rooms.push(r))
  await session.start()
  await session.invite({ name: 'ana', role: 'member' })
  assert.deepEqual(copied, ['https://x/?token=SECRETTOKEN'])
  assert.match(infos.join(' '), /clipboard/)
  assert.ok(!JSON.stringify(rooms).includes('SECRETTOKEN'))
})

test('a refused invite says so instead of copying nothing and claiming success', async () => {
  const { session, copied, errors } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/invite')
      ? { ok: false, status: 403, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  await session.start()
  await session.invite({ name: 'ana', role: 'member' })
  assert.deepEqual(copied, [])
  assert.match(errors.join(' '), /could not invite ana/)
})

test('re-copying a member\'s link uses their EXISTING token, no fresh invite', async () => {
  const { session, copied, infos } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/joinLink')
      ? { ok: true, status: 200, json: async () => ({ ok: true, joinUrl: 'https://x/?token=EXISTING' }) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  await session.start()
  await session.copyJoinLink('m1')
  assert.deepEqual(copied, ['https://x/?token=EXISTING'])
  assert.match(infos.join(' '), /clipboard/)
})

test('a failed re-copy says so instead of copying nothing and claiming success', async () => {
  const { session, copied, errors } = harness({
    fetchImpl: async url => (String(url).includes('/api/admin/joinLink')
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({}), body: sseBody([]) }),
  })
  await session.start()
  await session.copyJoinLink('m1')
  assert.deepEqual(copied, [])
  assert.match(errors.join(' '), /could not (get|copy)/i)
})

test('publishing without devtunnel installed says how to get it and changes nothing', async () => {
  const { session, started, errors } = harness({ detectTunnel: () => false })
  await session.start()
  await session.republish(true)
  assert.equal(session.isPublished(), false)
  assert.equal(started.filter(s => s.name === 'tunnel').length, 0)
  assert.match(errors.join(' '), /winget install --id Microsoft\.devtunnel/)
})

test('publishing starts the tunnel and restarts the room on the same port and state dir', async () => {
  // Same port and same state dir is what keeps the owner token, the roster and
  // http://127.0.0.1:<port> alive across the restart.
  const { session, started } = harness()
  await session.start()
  await session.republish(true)
  const tunnel = started.find(s => s.name === 'tunnel')
  const rooms = started.filter(s => s.name === 'room')
  assert.deepEqual(tunnel.recipe.args, ['host', '-p', '51820', '--allow-anonymous'])
  assert.equal(rooms.length, 2)
  assert.equal(rooms[1].recipe.opts.env.ROOM_HOST, '0.0.0.0')
  assert.equal(rooms[1].recipe.opts.env.ROOM_PORT, '51820')
  assert.equal(rooms[1].recipe.opts.env.ROOM_STATE_DIR, '/state')
  assert.equal(rooms[1].recipe.opts.env.ROOM_ADVERTISE, 'https://abc-1234.inc1.devtunnels.ms')
  assert.equal(session.isPublished(), true)
})

test('publishing without being logged in to devtunnel says so, before waiting on anything', async () => {
  // isLoggedIn is checked up front now, so a not-logged-in account is an
  // immediate, correct answer -- not a 10s wait for a guess.
  const { session, started, errors } = harness({ isLoggedIn: async () => false })
  await session.start()
  await session.republish(true)
  assert.equal(session.isPublished(), false)
  assert.equal(started.filter(s => s.name === 'tunnel').length, 0)
  assert.match(errors.join(' '), /devtunnel user login/)
})

test('a tunnel that never prints a URL is stopped rather than left hosting blind', async () => {
  const { session, stopped, errors } = harness({
    supervisor: { status: () => ({ output: 'Connecting...\n', errOutput: '' }) },
  })
  await session.start()
  await session.republish(true)
  assert.ok(stopped.includes('tunnel'))
  assert.equal(session.isPublished(), false)
  // Login is already confirmed by this point (harness default), so the
  // message must not repeat a guess that has already been ruled out.
  assert.match(errors.join(' '), /devtunnel did not report a URL within 10s/)
  assert.doesNotMatch(errors.join(' '), /devtunnel user login/)
})

test('a tunnel failure surfaces devtunnel\'s own error text, not a guess', async () => {
  const { session, errors } = harness({
    supervisor: { status: () => ({ output: 'Connecting...\n', errOutput: 'ERROR: network is unreachable\n' }) },
  })
  await session.start()
  await session.republish(true)
  assert.match(errors.join(' '), /network is unreachable/)
})

test('stop sharing stops the tunnel and rebinds the room to loopback', async () => {
  const { session, started, stopped } = harness()
  await session.start()
  await session.republish(true)
  await session.republish(false)
  assert.ok(stopped.includes('tunnel'))
  assert.equal(started.filter(s => s.name === 'room').at(-1).recipe.opts.env.ROOM_HOST, '127.0.0.1')
  assert.equal(session.isPublished(), false)
})

test('the busy state is announced before the restart, so no click lands twice', async () => {
  const { session } = harness()
  const rooms = []
  await session.start()
  session.onRoom(r => rooms.push(r))
  await session.republish(true)
  assert.equal(rooms[0].busy, true)
  assert.equal(rooms.at(-1).busy, false)
})

// --- published state comes from the outcome, never from the intent ---------

/** A harness whose room never comes back after the publish restart. */
function deadRoomHarness() {
  let up = true
  return {
    ...harness({
      fetchImpl: async url => {
        if (String(url).includes('/api/state') && !up) throw new Error('ECONNREFUSED')
        if (String(url).includes('/events')) return { ok: true, status: 200, body: sseBody([]) }
        return { ok: true, status: 200, json: async () => ({}) }
      },
    }),
    kill: () => { up = false },
  }
}

test('a publish whose room never comes back is not reported as published', async () => {
  // Reporting "published" for a room that is not serving tells the owner their
  // work is shared when nothing is reachable at all.
  const h = deadRoomHarness()
  await h.session.start()
  h.kill()
  await h.session.republish(true)
  assert.equal(h.session.isPublished(), false)
  assert.match(h.errors.join(' '), /did not restart/)
})

test('a failed publish stops the tunnel it started, so nothing points at a dead port', async () => {
  const h = deadRoomHarness()
  await h.session.start()
  h.kill()
  await h.session.republish(true)
  assert.ok(h.stopped.includes('tunnel'))
})

test('a failed stop-sharing reports local, because the tunnel really did stop', async () => {
  // The tunnel is down whatever the room did next. Staying "published" here is
  // the exact lie this fix exists to remove.
  const h = deadRoomHarness()
  await h.session.start()
  await h.session.republish(true)
  assert.equal(h.session.isPublished(), true)
  h.kill()
  await h.session.republish(false)
  assert.equal(h.session.isPublished(), false)
})

test('the failure is reported to listeners too, not only to the dialog', async () => {
  const h = deadRoomHarness()
  await h.session.start()
  const rooms = []
  h.session.onRoom(r => rooms.push(r))
  h.kill()
  await h.session.republish(true)
  assert.equal(rooms.at(-1).published, false)
  assert.equal(rooms.at(-1).busy, false)
})
