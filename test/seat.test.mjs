import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { seatNotification, createSeat } from '../src/seat.mjs'

test('a turn event becomes a channel notification with verbatim content', () => {
  const n = seatNotification({
    event: 'turn',
    data: { messages: [{ name: 'ana', content: '@ana-agent go', memberId: 'u1', id: 'm1' }], batch: 1 },
  })
  assert.equal(n.method, 'notifications/claude/channel')
  assert.equal(n.params.content, '@ana-agent go')
  assert.equal(n.params.meta.user, 'ana')
  assert.equal(n.params.meta.kind, undefined)   // a turn is not tagged
})

test('a mirror event is tagged so the agent knows it is context, not a request', () => {
  const n = seatNotification({ event: 'mirror', data: { text: 'heet-agent: found three', from: 'heet-agent' } })
  assert.equal(n.params.meta.kind, 'mirror')
  assert.equal(n.params.meta.user, undefined)   // never attributed to a person
})

test('a brief event keeps its age and pending attributes', () => {
  const n = seatNotification({ event: 'brief', data: { text: 'forks:\n - x', ageS: 3, pending: 2 } })
  assert.equal(n.params.meta.kind, 'brief')
  assert.equal(n.params.meta.age_s, '3')
  assert.equal(n.params.meta.pending, '2')
})

test('a seed event arrives as its own tagged block', () => {
  const n = seatNotification({ event: 'seed', data: { text: 'decisions:\n - keep auth stateless' } })
  assert.equal(n.params.meta.kind, 'seed')
  assert.match(n.params.content, /keep auth stateless/)
})

test('an unknown event yields nothing rather than a malformed notification', () => {
  assert.equal(seatNotification({ event: 'nonsense', data: {} }), null)
  assert.equal(seatNotification({ event: 'turn', data: { messages: [] } }), null)
})

test('every emitted meta key is a legal identifier', () => {
  const n = seatNotification({ event: 'mirror', data: { text: 'x', from: 'y' } })
  for (const k of Object.keys(n.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/)
})

// Regression: createSeat used to take `EventSourceImpl = EventSource` as a
// default parameter, and Node 22 does not expose EventSource as a global
// without --experimental-eventsource. That threw a synchronous
// ReferenceError before the MCP Server was even constructed, so every real
// seat - which never passes an override - failed outright, with an error
// that named nothing useful. This exercises the exact path a real seat
// takes: no fetchImpl override, a real local HTTP server standing in for
// the room, nothing but stock Node 22.
test('createSeat constructs and connects on stock Node 22, with no injected transport override', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/seat/join') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ seatId: 's1', seed: { text: 'welcome to the room' } }))
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/seat/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      return // left open; the seat's own SSE reader stays attached to it
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  // Constructing must not throw - that is the exact regression.
  const seat = createSeat({ roomUrl: `http://127.0.0.1:${port}`, token: 't', handle: 'ana-agent' })

  const notifs = []
  seat.mcp.notification = async n => { notifs.push(n) }

  await seat.connect()

  // The join response's seed reached the agent as a tagged notification -
  // proof the default fetch-based join + feed path actually ran end to end.
  assert.equal(notifs.length, 1)
  assert.equal(notifs[0].params.meta.kind, 'seed')
  assert.match(notifs[0].params.content, /welcome to the room/)

  seat.stop()
  await seat.mcp.close()
  await new Promise(resolve => server.close(resolve))
})

// --- Task 11, item 4: run-as-main entry point ---
//
// scripts/room-seat.mjs (Task 9) already wires `--mcp-config` to spawn
// `node src/seat.mjs` as the seat's own MCP server, but until now that file
// only ever exported createSeat/seatNotification — invoked directly it did
// nothing: no top-level code ever called createSeat(...).connect(), so a
// real seat process launched exactly this way sat there doing nothing,
// silently. These tests spawn the real file as Claude Code's launcher
// would, rather than calling a main() function in-process, because the
// point being tested is the process's own exit code and what lands on its
// stdout/stderr — a directly-called function has neither.

const SEAT_FILE = fileURLToPath(new URL('../src/seat.mjs', import.meta.url))

/** Spawns `node src/seat.mjs` with a caller-controlled environment (never inherited: a missing var must stay missing). */
function spawnSeat(env) {
  const child = spawn(process.execPath, [SEAT_FILE], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  return { child, out: () => stdout, err: () => stderr }
}

function waitExit(child) {
  return new Promise(resolve => child.on('exit', code => resolve(code)))
}

test('run as main with no ROOM_URL: exits with a clear message naming it, nothing on stdout', async () => {
  const { child, out, err } = spawnSeat({ PATH: process.env.PATH })
  const code = await waitExit(child)
  assert.notEqual(code, 0)
  assert.match(err(), /ROOM_URL/)
  assert.equal(out(), '') // stdout belongs to the MCP protocol; a stray byte there corrupts it
})

test('run as main with no ROOM_SEAT_TOKEN: exits naming it', async () => {
  const { child, err } = spawnSeat({ PATH: process.env.PATH, ROOM_URL: 'http://127.0.0.1:1' })
  const code = await waitExit(child)
  assert.notEqual(code, 0)
  assert.match(err(), /ROOM_SEAT_TOKEN/)
})

test('run as main with no ROOM_SEAT_HANDLE: exits naming it', async () => {
  const { child, err } = spawnSeat({
    PATH: process.env.PATH, ROOM_URL: 'http://127.0.0.1:1', ROOM_SEAT_TOKEN: 't',
  })
  const code = await waitExit(child)
  assert.notEqual(code, 0)
  assert.match(err(), /ROOM_SEAT_HANDLE/)
})

test('run as main with every variable set: connects for real, logging only to stderr', async () => {
  // A minimal stand-in room, same shape as the earlier connect test's.
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/seat/join') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ seatId: 's1', seed: { text: '' } }))
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/seat/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const { child, out, err } = spawnSeat({
    PATH: process.env.PATH,
    ROOM_URL: `http://127.0.0.1:${port}`,
    ROOM_SEAT_TOKEN: 't',
    ROOM_SEAT_HANDLE: 'ana-agent',
  })

  // Poll stderr rather than sleep a fixed amount, so a slow machine does not flake.
  for (let i = 0; i < 60 && !/ana-agent/.test(err()); i++) await new Promise(r => setTimeout(r, 100))
  assert.match(err(), /ana-agent/, `seat never logged its own handle. stderr:\n${err()}`)
  // Nothing on stdout at any point - it belongs to the MCP protocol, and the
  // process is deliberately never fed a request, so a silent, listening MCP
  // server is exactly the expected end state here, not a hang.
  assert.equal(out(), '')

  child.kill()
  await new Promise(resolve => server.close(resolve))
})

// --- Task 3: reply-only mode ---

test('a reply-only seat never joins or opens a feed, so it cannot collide with its driver', async () => {
  // The OpenCode driver owns the room feed. A second connection claiming the
  // same handle would be rejected as handle-taken, leaving the seat deaf.
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const seat = createSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode',
    fetchImpl, mode: 'reply-only',
  })
  await seat.connect()
  seat.stop()
  assert.equal(calls.length, 0, `reply-only must make no calls of its own, got ${calls.join()}`)
})

test('a reply-only seat still delivers room_reply, which is its entire job', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const seat = createSeat({
    roomUrl: 'http://room', token: 't', handle: 'opencode',
    fetchImpl, mode: 'reply-only',
  })
  const res = await seat.callTool('room_reply', { text: 'hello from opencode' })
  assert.equal(res.isError, undefined)
  assert.equal(calls[0].url, 'http://room/seat/reply')
  assert.equal(calls[0].body.text, 'hello from opencode')
})

test('mode defaults to full when omitted, so every pre-existing caller of createSeat is unaffected', async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ seed: {} }) }
  }
  const seat = createSeat({ roomUrl: 'http://room', token: 't', handle: 'ana-agent', fetchImpl })
  await seat.connect()
  seat.stop()
  assert.ok(calls.some(u => u === 'http://room/seat/join'), 'default mode must still join')
})

test('an unrecognized mode string falls through to full behaviour rather than silently degrading', async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ seed: {} }) }
  }
  const seat = createSeat({
    roomUrl: 'http://room', token: 't', handle: 'ana-agent', fetchImpl, mode: 'bogus',
  })
  await seat.connect()
  seat.stop()
  assert.ok(calls.some(u => u === 'http://room/seat/join'), 'an unknown mode must not be treated as reply-only')
})

test('callTool on the full-mode MCP handler and the direct callTool path agree, because they share one implementation', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const seat = createSeat({ roomUrl: 'http://room', token: 't', handle: 'ana-agent', fetchImpl })
  const res = await seat.callTool('room_reply', { text: 'hi', to: 'ana' })
  assert.equal(res.content[0].text, 'sent')
  assert.equal(calls[0].body.to, 'ana')
})

test('callTool reports an unknown tool as an error instead of throwing', async () => {
  const seat = createSeat({ roomUrl: 'http://room', token: 't', handle: 'ana-agent', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
  const res = await seat.callTool('not_a_real_tool', {})
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /unknown tool/)
})

test('importing the module does not fire the main guard', async () => {
  // Real seats launch via scripts/room-seat.mjs, which spawns `node
  // src/seat.mjs` as a fresh process - process.argv[1] is the file itself.
  // Every OTHER test in this file imports the same module as a library, not
  // as that fresh process, and none of them observe a stray exit or a die()
  // message - which is only possible if the guard stays silent on import.
  // This spawns a clean process that imports (never runs) the file, with
  // none of the three env vars set, to prove that explicitly: if the guard
  // fired on import, this would exit non-zero with a "missing ROOM_URL"
  // message exactly like the tests above.
  const child = spawn(process.execPath, [
    '--input-type=module', '-e',
    `import(${JSON.stringify(new URL('../src/seat.mjs', import.meta.url).href)}).then(() => process.stderr.write('imported-ok\\n'))`,
  ], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const code = await waitExit(child)
  assert.equal(code, 0)
  assert.match(stderr, /imported-ok/)
})
