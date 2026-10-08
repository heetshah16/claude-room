// test/mod-feed-process.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { refusal } from '../mod/feed.mjs'

const FEED = fileURLToPath(new URL('../mod/feed.mjs', import.meta.url))

// A room that answers /seat/join and /seat/events the way each test says.
// `join` and `events` may be a status or a sequence of answers (the last one
// repeats); 'close' on events opens the stream and ends it at once.
async function fakeRoom({ join = 200, events = 200, frames = [] } = {}) {
  const joinAnswers = [].concat(join)
  const eventAnswers = [].concat(events)
  const next = a => (a.length > 1 ? a.shift() : a[0])
  const server = createServer((req, res) => {
    if (req.url.startsWith('/seat/join')) {
      const join = next(joinAnswers)
      res.writeHead(join, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(join === 200 ? { seatId: 's1', seed: { text: 'recent history' } } : { error: 'no' }))
    }
    if (req.url.startsWith('/seat/events')) {
      const events = next(eventAnswers)
      if (typeof events === 'number' && events !== 200) {
        res.writeHead(events)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      for (const [event, data] of frames) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      if (events === 'close') return res.end()
      return // held open, as the real room holds a seat's feed
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); server.close() },
  }
}

// Runs the real feed.mjs until it has printed `until` lines or exited.
function runFeed(url, { until = Infinity, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FEED], {
      env: { ...process.env, ROOM_URL: url, ROOM_SEAT_TOKEN: 'tok', ROOM_SEAT_HANDLE: 'ana-agent', ...env },
    })
    const lines = []
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`feed timed out; lines so far: ${JSON.stringify(lines)}`))
    }, 10_000)
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
      if (lines.length >= until) {
        clearTimeout(timer)
        child.kill()
        resolve({ lines, code: null })
      }
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ lines, code })
    })
  })
}

test('a turn arrives as one prompt line after an online status, with the seed and a mirror riding along', async () => {
  const room = await fakeRoom({
    frames: [
      ['mirror', { text: 'bob found the bug', from: 'bob-agent' }],
      ['turn', { messages: [{ id: 'm1', name: 'heet', memberId: 'u1', content: '@ana-agent fix it' }] }],
    ],
  })
  try {
    const { lines } = await runFeed(room.url, { until: 2 })
    assert.deepEqual(lines[0], { status: 'online' })
    assert.match(lines[1].text, /recent history/)
    assert.match(lines[1].text, /bob found the bug/)
    assert.match(lines[1].text, /@ana-agent fix it/)
  } finally {
    room.close()
  }
})

test('a handle already online elsewhere stops the feed instead of retrying forever', async () => {
  const room = await fakeRoom({ events: 409 })
  try {
    const { lines, code } = await runFeed(room.url)
    assert.equal(code, 2)
    assert.equal(lines.at(-1).status, 'fatal')
    assert.match(lines.at(-1).reason, /already online/)
  } finally {
    room.close()
  }
})

test('a refused token stops the feed at join', async () => {
  const room = await fakeRoom({ join: 401 })
  try {
    const { lines, code } = await runFeed(room.url)
    assert.equal(code, 2)
    assert.match(lines.at(-1).reason, /refused this seat token/)
  } finally {
    room.close()
  }
})

test('missing configuration is a fatal status, not a crash', async () => {
  const { lines, code } = await runFeed('http://127.0.0.1:1', { env: { ROOM_URL: '' } })
  assert.equal(code, 2)
  assert.equal(lines.at(-1).status, 'fatal')
})

test('a room that answers 503 is retried, not fatal', async () => {
  const room = await fakeRoom({ events: 503 })
  try {
    const { lines } = await runFeed(room.url, { until: 1 })
    assert.equal(lines[0].status, 'retrying')
    assert.match(lines[0].reason, /503/)
  } finally {
    room.close()
  }
})

test('only refusals that retrying cannot fix are fatal', () => {
  assert.match(refusal(401), /token/)
  assert.match(refusal(403), /not an agent/)
  assert.match(refusal(409), /already online/)
  assert.equal(refusal(500), null)
  assert.equal(refusal(503), null)
})

test('a 409 on reconnect after being online is retried, not fatal', async () => {
  const room = await fakeRoom({ events: ['close', 409, 200] })
  try {
    const { lines, code } = await runFeed(room.url, { until: 4 })
    assert.equal(code, null) // still running when the harness stopped it
    assert.deepEqual(lines.map(l => l.status), ['online', 'retrying', 'retrying', 'online'])
    assert.match(lines[2].reason, /previous connection/)
  } finally {
    room.close()
  }
})

test('a 403 at the feed is fatal', async () => {
  const room = await fakeRoom({ events: 403 })
  try {
    const { lines, code } = await runFeed(room.url)
    assert.equal(code, 2)
    assert.match(lines.at(-1).reason, /not an agent/)
  } finally {
    room.close()
  }
})

test('a join that fails with 500 once is retried, not fatal', async () => {
  const room = await fakeRoom({ join: [500, 200] })
  try {
    const { lines } = await runFeed(room.url, { until: 2 })
    assert.equal(lines[0].status, 'retrying')
    assert.match(lines[0].reason, /500/)
    assert.deepEqual(lines[1], { status: 'online' })
  } finally {
    room.close()
  }
})
