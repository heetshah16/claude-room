// mod/tests/room-seat.test.tsx
import { expect, mock, test } from 'claude-code/testing'

const SEAT_ENV = { ROOM_URL: 'http://room.test', ROOM_SEAT_TOKEN: 'tok', ROOM_SEAT_HANDLE: 'ana-agent' }
const CONFIG = { room_url: 'http://room.test', seat_token: 'tok', seat_handle: '@ana-agent' }

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

// The fake feed: prints `lines`, one JSON object each, then stays up until it
// is killed, as feed.mjs does while the seat is joined.
function playing(lines: object[]) {
  return async function* (signal: AbortSignal) {
    for (const l of lines) yield { stream: 'stdout' as const, text: JSON.stringify(l) + '\n' }
    await new Promise(r => signal.aborted ? r(null) : signal.addEventListener('abort', r, { once: true }))
    return { value: { code: null, signal: 'SIGTERM' } }
  }
}

// A fake feed that exits on its own at once, with exit code `code`.
function exiting(code: number) {
  return async function* () {
    return { value: { code, signal: null } }
  }
}

const statusOnce = async ($, re: RegExp) => {
  let status = ''
  for (let i = 0; i < 50 && !re.test(status); i++) status = (await $.command.run({ command: 'room-status', args: '' })).text
  return status
}

// Stubs everything the mod calls. `lines` are what the fake feed prints, or
// `spawn` replaces the fake feed whole; `fetch` answers each post (default:
// 200). Records posts and spawns. Overrides go through these options:
// a second stub on the same event would never run, the first one answering.
// `file` is the project's .claude/room-seat.local.json as text, or a function
// giving it at each read; undefined means the file is missing. `cwd` is the
// session's directory, or a function giving it at each $.session.cwd().
function stubRoom(on, { env = {}, lines = [] as object[], spawn = undefined as any, fetch = undefined as any, submit = undefined as any, file = undefined as any, cwd = '/work' as any } = {}) {
  const seen = {
    posts: [] as { url: string; body: any }[],
    spawns: [] as any[],
    tools: 0,
    prompted: deferred<any>(), // the first prompt.submit event
    submits: [] as string[], // every prompt.submit's text
    ended: 0, // fake feeds that ended, killed or not
    reads: [] as string[], // every fs.read's path
  }
  const feed = spawn ?? playing(lines)
  mock.env(on, env)
  on('fs.read', ($, e) => {
    // The engine hands the hook the path resolved against the working directory.
    const path = e.path.replace(/\\/g, '/')
    seen.reads.push(path)
    const text = typeof file === 'function' ? file() : file
    if (!path.endsWith('/.claude/room-seat.local.json') || text === undefined) return { deny: `ENOENT: ${path}` }
    return { value: text }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: typeof cwd === 'function' ? cwd() : cwd }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => { seen.tools++; return { value: { tool: 'mcp__room-seat__room_reply' } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    seen.posts.push({ url: e.url, body: JSON.parse(e.init?.body ?? 'null') })
    return fetch ? fetch(e) : { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('process.spawn', async function* ($, e, next) {
    seen.spawns.push(e)
    try {
      return yield* feed(next.signal)
    } finally {
      seen.ended++
    }
  })
  on('prompt.submit', ($, e) => {
    seen.prompted.resolve(e)
    seen.submits.push(e.text)
    return submit ? submit(e) : { text: e.text }
  })
  // The bottom of a tool call the model makes (here, Bash): `$.tool.call`
  // raises classic.PreToolUse on the way down, as a session does.
  on('tool.call', () => ({ result: 'ran' }))
  return seen
}

const start = $ => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
const hookPosts = seen => seen.posts.filter(p => p.url.includes('/seat/hook/')).map(p => p.url.replace(/\?.*/, ''))
const bash = ($, command) => $.tool.call({ tool: 'Bash', command })

// `prompted` resolves inside the stub, before the mod's $.prompt.submit call
// has resolved and marked the room turn as running. A few round trips through
// the engine let the mod catch up before the test fires the next event.
async function settle($) {
  for (let i = 0; i < 3; i++) await $.command.run({ command: 'room-status', args: '' })
}

test('outside a room seat the mod adds its commands and nothing else', async ($, on) => {
  const seen = stubRoom(on)
  await start($)
  expect(seen.spawns.length).toBe(0)
  expect(seen.tools).toBe(0)
})

test('a session launched as a seat joins at once, with its settings in the environment and never on argv', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].argv[0]).toBe('node')
  expect(seen.spawns[0].argv[1]).toMatch(/feed\.mjs$/)
  expect(seen.spawns[0].env.ROOM_SEAT_TOKEN).toBe('tok')
  expect(seen.spawns[0].argv.join(' ')).not.toContain('tok')
  expect(seen.tools).toBe(1)
})

test('a room turn from the feed is submitted as a prompt, framed as the plugin, not as the user', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ status: 'online' }, { text: 'hello room' }] })
  await start($)
  const prompt = await seen.prompted.promise
  expect(prompt.text).toBe('hello room')
  expect(prompt.origin).toEqual({ kind: 'plugin', name: 'room-seat' }) // never asUser
})

test('/room-join without configuration says how to configure, and starts nothing', async ($, on) => {
  const seen = stubRoom(on)
  await start($)
  const out = await $.command.run({ command: 'room-join', args: '' })
  expect(out.text).toMatch(/Configure options/)
  expect(seen.spawns.length).toBe(0)
})

test('plugin options alone join at session start, with a leading @ stripped from the handle', { options: CONFIG }, async ($, on) => {
  const seen = stubRoom(on, { lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(1) // no /room-join needed
  expect(seen.spawns[0].env.ROOM_SEAT_HANDLE).toBe('ana-agent')
  expect(await statusOnce($, /online/)).toMatch(/online as @ana-agent .*plugin options/)
  const out = await $.command.run({ command: 'room-join', args: '' })
  expect(out.text).toMatch(/online/) // already joined: /room-join starts nothing more
  expect(seen.spawns.length).toBe(1)
})

const seatFile = (over = {}) => JSON.stringify({ room_url: 'http://127.0.0.1:8787', seat_handle: 'ana-claude', seat_token: 'file-tok', ...over })

test("the Room extension's seat file joins at session start with its values", async ($, on) => {
  const seen = stubRoom(on, { file: seatFile(), lines: [{ status: 'online' }] })
  await start($)
  expect(seen.reads[0]).toMatch(/\/\.claude\/room-seat\.local\.json$/)
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].env).toEqual({ ROOM_URL: 'http://127.0.0.1:8787', ROOM_SEAT_TOKEN: 'file-tok', ROOM_SEAT_HANDLE: 'ana-claude' })
  expect(await statusOnce($, /online/)).toMatch(/online as @ana-claude .*project file/)
})

test('the environment beats the seat file', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, file: seatFile(), lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].env.ROOM_SEAT_TOKEN).toBe('tok')
  expect(await statusOnce($, /online/)).toMatch(/environment/)
})

test('the seat file beats the plugin options', { options: CONFIG }, async ($, on) => {
  const seen = stubRoom(on, { file: seatFile(), lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].env.ROOM_SEAT_TOKEN).toBe('file-tok')
})

for (const [what, file] of [
  ['missing', undefined],
  ['not JSON', '{ room_url: oops'],
  ['JSON null', 'null'],
  ['incomplete', JSON.stringify({ room_url: 'http://127.0.0.1:8787', seat_handle: 'ana-claude' })],
] as const) {
  test(`a seat file that is ${what} falls through to the plugin options`, { options: CONFIG }, async ($, on) => {
    const seen = stubRoom(on, { file, lines: [{ status: 'online' }] })
    await start($)
    expect(seen.spawns.length).toBe(1)
    expect(seen.spawns[0].env.ROOM_SEAT_TOKEN).toBe('tok')
  })
}

// A committed seat file must not join a stranger's room: only a room on this
// machine is trusted from it, which is all the Room extension ever writes.
const IGNORED = /ignored \.claude\/room-seat\.local\.json: its room address is not on this machine/

for (const url of ['http://evil.example.com:8787', 'http://127.0.0.1@evil.com/', 'http://127.0.0.2:8787', 'ftp://127.0.0.1:8787', 'not a url']) {
  test(`a seat file pointing at ${url} is ignored, and says why`, async ($, on) => {
    const seen = stubRoom(on, { file: seatFile({ room_url: url }), lines: [{ status: 'online' }] })
    await start($)
    expect(seen.spawns.length).toBe(0)
    expect((await $.command.run({ command: 'room-status', args: '' })).text).toMatch(IGNORED)
    expect((await $.command.run({ command: 'room-join', args: '' })).text).toMatch(IGNORED)
    expect(seen.spawns.length).toBe(0)
  })
}

test('a seat file pointing off this machine falls through to the plugin options, still saying why', { options: CONFIG }, async ($, on) => {
  const seen = stubRoom(on, { file: seatFile({ room_url: 'http://evil.example.com:8787' }), lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].env).toEqual({ ROOM_URL: 'http://room.test', ROOM_SEAT_TOKEN: 'tok', ROOM_SEAT_HANDLE: 'ana-agent' })
  const status = await statusOnce($, /online/)
  expect(status).toMatch(/online as @ana-agent .*plugin options/)
  expect(status).toMatch(IGNORED)
})

for (const url of ['http://localhost:8787', 'http://[::1]:8787', 'https://127.0.0.1:8787']) {
  test(`a seat file pointing at ${url} joins`, async ($, on) => {
    const seen = stubRoom(on, { file: seatFile({ room_url: url }), lines: [{ status: 'online' }] })
    await start($)
    expect(seen.spawns.length).toBe(1)
    expect(seen.spawns[0].env.ROOM_URL).toBe(url)
    expect(await statusOnce($, /online/)).not.toMatch(/ignored/)
  })
}

// A feed that prints `lines` and exits with code 2, as feed.mjs does on a fatal.
function failing(lines: object[]) {
  return async function* () {
    for (const l of lines) yield { stream: 'stdout' as const, text: JSON.stringify(l) + '\n' }
    return { value: { code: 2, signal: null } }
  }
}

const untilSpawns = async ($, seen, n: number) => {
  for (let i = 0; i < 50 && seen.spawns.length < n; i++) await $.command.run({ command: 'room-status', args: '' })
}

test('a fatal with a changed seat file rejoins once with the new token, and not again on the same values', async ($, on) => {
  let file = seatFile({ seat_token: 'old' })
  const refused = { status: 'fatal', reason: 'the room refused this seat token (HTTP 401)' }
  const seen = stubRoom(on, {
    file: () => file,
    spawn: (signal: AbortSignal) => {
      if (seen.spawns.length === 1) file = seatFile({ seat_token: 'new' }) // the extension rotated it
      return failing([refused])()
    },
  })
  await start($)
  await untilSpawns($, seen, 2)
  expect(seen.spawns.length).toBe(2)
  expect(seen.spawns[1].env.ROOM_SEAT_TOKEN).toBe('new')
  expect(await statusOnce($, /offline/)).toMatch(/offline: the room refused/)
  await settle($)
  expect(seen.spawns.length).toBe(2)
})

test('a fatal with the seat file now pointing off this machine does not rejoin, and says why', async ($, on) => {
  let file = seatFile({ seat_token: 'old' })
  const seen = stubRoom(on, {
    file: () => file,
    spawn: () => {
      if (seen.spawns.length === 1) file = seatFile({ room_url: 'http://evil.example.com:8787', seat_token: 'evil' })
      return failing([{ status: 'fatal', reason: 'the room refused this seat token (HTTP 401)' }])()
    },
  })
  await start($)
  for (let i = 0; i < 50 && seen.reads.length < 2; i++) await settle($)
  await settle($)
  await settle($)
  expect(seen.reads.length).toBe(2)
  expect(seen.spawns.length).toBe(1)
  const status = (await $.command.run({ command: 'room-status', args: '' })).text
  expect(status).toMatch(/offline: the room refused/)
  expect(status).toMatch(IGNORED)
})

test('three retrying statuses with the seat file now pointing off this machine do not rejoin', async ($, on) => {
  let file = seatFile()
  const seen = stubRoom(on, {
    file: () => file,
    spawn: (signal: AbortSignal) => {
      if (seen.spawns.length === 1) file = seatFile({ room_url: 'http://127.0.0.1@evil.com/' })
      return playing([retrying, retrying, retrying])(signal)
    },
  })
  await start($)
  for (let i = 0; i < 50 && seen.reads.length < 2; i++) await settle($)
  await settle($)
  expect(seen.spawns.length).toBe(1)
  expect(seen.ended).toBe(0) // the loopback feed keeps retrying
  expect((await $.command.run({ command: 'room-status', args: '' })).text).toMatch(IGNORED)
})

test('a fatal with an unchanged seat file stays offline with the reason', async ($, on) => {
  const seen = stubRoom(on, {
    file: seatFile(),
    spawn: failing([{ status: 'fatal', reason: 'this handle is already online in another session' }]),
  })
  await start($)
  expect(await statusOnce($, /already online/)).toMatch(/offline: this handle is already online/)
  for (let i = 0; i < 50 && seen.reads.length < 2; i++) await settle($)
  await settle($)
  await settle($)
  expect(seen.reads.length).toBe(2) // read at start, and once more on the fatal
  expect(seen.spawns.length).toBe(1)
  expect((await $.command.run({ command: 'room-status', args: '' })).text).toMatch(/offline: this handle is already online/)
})

const retrying = { status: 'retrying', reason: 'ECONNREFUSED' }

// The room's own claude children (the orchestrator, the observer) run in the
// user's folder: they must never take the user's seat.
test('a room process never joins from the seat file or the plugin options, and says why', { options: CONFIG }, async ($, on) => {
  const seen = stubRoom(on, { env: { ROOM_SEAT_SKIP: '1' }, file: seatFile(), lines: [{ status: 'online' }] })
  await start($)
  await settle($)
  expect(seen.spawns.length).toBe(0)
  expect((await $.command.run({ command: 'room-status', args: '' })).text).toMatch(/this session is a room process; not joining/)
})

test('a seat launched through the environment joins even when marked a room process', async ($, on) => {
  const seen = stubRoom(on, { env: { ...SEAT_ENV, ROOM_SEAT_SKIP: '1' }, lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].env.ROOM_SEAT_TOKEN).toBe('tok')
})

test('the seat file is re-read from the folder the session started in, after a directory change', async ($, on) => {
  let cwd = '/proj-a'
  let file = seatFile({ seat_token: 'old' })
  const seen = stubRoom(on, {
    cwd: () => cwd,
    file: () => file,
    spawn: () => {
      if (seen.spawns.length === 1) { cwd = '/proj-b'; file = seatFile({ seat_token: 'new' }) }
      return failing([{ status: 'fatal', reason: 'the room refused this seat token (HTTP 401)' }])()
    },
  })
  await start($)
  await untilSpawns($, seen, 2)
  expect(seen.spawns.length).toBe(2)
  expect(seen.reads.length).toBeGreaterThanOrEqual(2)
  for (const r of seen.reads) expect(r).toMatch(/\/proj-a\/\.claude\/room-seat\.local\.json$/)
})

test('three retrying statuses re-read the seat file and rejoin at a changed room address', async ($, on) => {
  let file = seatFile()
  const seen = stubRoom(on, {
    file: () => file,
    spawn: (signal: AbortSignal) => {
      if (seen.spawns.length === 1) file = seatFile({ room_url: 'http://127.0.0.1:9999' }) // the room moved
      return playing(seen.spawns.length === 1 ? [retrying, retrying, retrying] : [{ status: 'online' }])(signal)
    },
  })
  await start($)
  await untilSpawns($, seen, 2)
  expect(seen.spawns.length).toBe(2)
  expect(seen.spawns[1].env.ROOM_URL).toBe('http://127.0.0.1:9999')
  expect(await statusOnce($, /online/)).toMatch(/online as @ana-claude in http:\/\/127\.0\.0\.1:9999/)
  expect(seen.ended).toBe(1) // the first feed was ended, not left running
})

test('an online status resets the retry count, so two retries either side of it do not re-read', async ($, on) => {
  const seen = stubRoom(on, {
    file: () => seatFile(),
    lines: [retrying, retrying, { status: 'online' }, retrying, { ...retrying, reason: 'last one' }],
  })
  await start($)
  expect(await statusOnce($, /last one/)).toMatch(/reconnecting: last one/)
  await settle($)
  expect(seen.reads.length).toBe(1)
  expect(seen.spawns.length).toBe(1)
})

test('a seat from the environment never reads the seat file on a fatal', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, file: seatFile(), spawn: failing([{ status: 'fatal', reason: 'nope' }]) })
  await start($)
  expect(await statusOnce($, /nope/)).toMatch(/offline: nope/)
  await settle($)
  expect(seen.reads.length).toBe(0)
  expect(seen.spawns.length).toBe(1)
})

test('a fatal feed status shows in /room-status and the feed is not restarted', async ($, on) => {
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    lines: [{ status: 'fatal', reason: 'this handle is already online in another session' }],
  })
  await start($)
  let status = ''
  for (let i = 0; i < 50 && !/already online/.test(status); i++) {
    status = (await $.command.run({ command: 'room-status', args: '' })).text
  }
  expect(status).toMatch(/already online/)
  expect(seen.spawns.length).toBe(1)
})

test('a feed that cannot start says the seat needs Node.js', async ($, on) => {
  stubRoom(on, {
    env: SEAT_ENV,
    spawn: async function* () {
      throw new Error('ENOENT: node')
    },
  })
  await start($)
  let status = ''
  for (let i = 0; i < 50 && !/Node\.js/.test(status); i++) {
    status = (await $.command.run({ command: 'room-status', args: '' })).text
  }
  expect(status).toMatch(/Node\.js 22/)
})

test('room_reply posts the text to the room with the seat token', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'done' })
  expect(out.result).toBe('sent')
  const reply = seen.posts.find(p => p.url.endsWith('/seat/reply'))
  expect(reply.body).toEqual({ token: 'tok', text: 'done' })
})

test('a refused room_reply reaches the model as an error', async ($, on) => {
  stubRoom(on, { env: SEAT_ENV, fetch: () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }) })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'done' })
  expect(out.deny).toMatch(/500/)
})

test("the owner's own turn never reaches the room", async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV })
  on('classic.Stop', () => ({}))
  await start($)
  await bash($, 'ls')
  await $.classic.Stop({ stop_hook_active: false })
  expect(hookPosts(seen)).toEqual([])
})

test("a room turn's tool calls and its Stop are forwarded, and nothing after the Stop", async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }] })
  on('classic.Stop', () => ({}))
  await start($)
  await seen.prompted.promise
  await settle($)
  await bash($, 'ls')
  await $.classic.Stop({ stop_hook_active: false, prompt_id: 'p1' })
  await bash($, 'pwd')
  for (let i = 0; i < 50 && hookPosts(seen).length < 2; i++) await $.command.run({ command: 'room-status', args: '' })
  expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/PreToolUse', 'http://room.test/seat/hook/Stop'])
  // The room's activity feed reads the settings-hook field names.
  expect(seen.posts.find(p => p.url.includes('/seat/hook/PreToolUse')).body).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' } })
})

test("the owner's own turn ending while a room turn waits for the session stays out of the room", async ($, on) => {
  const idle = deferred()
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    lines: [{ text: 'room work' }],
    submit: e => idle.promise.then(() => ({ text: e.text })),
  })
  on('classic.Stop', () => ({}))
  await start($)
  await seen.prompted.promise
  await settle($)
  await $.classic.Stop({ stop_hook_active: false, prompt_id: 'owner' }) // the room's turn has not started yet
  idle.resolve()
  await settle($)
  await $.classic.Stop({ stop_hook_active: false, prompt_id: 'room' })
  for (let i = 0; i < 50 && hookPosts(seen).length < 1; i++) await $.command.run({ command: 'room-status', args: '' })
  const stops = seen.posts.filter(p => p.url.includes('/seat/hook/Stop'))
  expect(stops.map(p => p.body.prompt_id)).toEqual(['room'])
})

test('a room turn the owner interrupts is closed with a visible reason', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }] })
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await seen.prompted.promise
  await settle($)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: true, reason: 'aborted' })
  for (let i = 0; i < 50 && hookPosts(seen).length < 1; i++) await $.command.run({ command: 'room-status', args: '' })
  expect(seen.posts.find(p => p.url.endsWith('/seat/reply')).body.text).toMatch(/interrupted/)
  expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/Stop'])
})

for (const [reason, said] of [['error', /API error/], ['refusal', /refused/]] as const) {
  test(`a room turn that ends with reason ${reason} is closed once, saying so`, async ($, on) => {
    const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }] })
    on('turn.complete', () => ({ text: '' }))
    await start($)
    await seen.prompted.promise
    await settle($)
    const ending = reason === 'refusal' ? { reason, refusal: { category: null, explanation: null } } : { reason }
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, ...ending })
    for (let i = 0; i < 50 && hookPosts(seen).length < 1; i++) await $.command.run({ command: 'room-status', args: '' })
    const replies = seen.posts.filter(p => p.url.endsWith('/seat/reply'))
    expect(replies.length).toBe(1)
    expect(replies[0].body.text).toMatch(said)
    expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/Stop'])
  })
}

test('a room turn that answered and sent its Stop is not closed a second time', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }] })
  on('classic.Stop', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await seen.prompted.promise
  await settle($)
  await $.classic.Stop({ stop_hook_active: false })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
  await settle($)
  expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/Stop'])
  expect(seen.posts.filter(p => p.url.endsWith('/seat/reply'))).toEqual([])
})

// A room turn queued behind the owner's, its submit still waiting when the
// owner leaves; the submit then resolves before or after a /room-join.
for (const resolves of ['before', 'after'] as const) {
  test(`a room turn submitted before /room-leave never scopes the owner's turns after a rejoin (resolves ${resolves} it)`, { options: CONFIG }, async ($, on) => {
    const idle = deferred()
    let spawned = 0
    const seen = stubRoom(on, {
      env: SEAT_ENV,
      spawn: (signal: AbortSignal) => playing(spawned++ ? [] : [{ text: 'room work' }])(signal),
      submit: e => idle.promise.then(() => ({ text: e.text })),
    })
    on('classic.Stop', () => ({}))
    await start($)
    await seen.prompted.promise
    await $.command.run({ command: 'room-leave', args: '' })
    if (resolves === 'before') idle.resolve()
    await settle($)
    await $.command.run({ command: 'room-join', args: '' })
    if (resolves === 'after') idle.resolve()
    await settle($)
    await bash($, 'ls')
    await $.classic.Stop({ stop_hook_active: false })
    await settle($)
    expect(seen.spawns.length).toBe(2)
    expect(hookPosts(seen)).toEqual([])
  })
}

test('a room turn that cannot start is closed with the reason', async ($, on) => {
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    lines: [{ text: 'room work' }],
    submit: () => ({ drop: 'paused by policy' }),
  })
  await start($)
  for (let i = 0; i < 50 && hookPosts(seen).length < 1; i++) await $.command.run({ command: 'room-status', args: '' })
  expect(seen.posts.find(p => p.url.endsWith('/seat/reply')).body.text).toMatch(/paused by policy/)
  expect(hookPosts(seen)).toEqual(['http://room.test/seat/hook/Stop'])
})

test('a hook that cannot reach the room does not hold the session', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ text: 'room work' }], fetch: () => new Promise(() => {}) })
  await start($)
  await seen.prompted.promise
  await settle($)
  // Resolves only if the mod does not await the post; the test's 5 s limit fails it otherwise.
  await bash($, 'ls')
})

test('/room-leave takes the seat offline and room_reply stops working', async ($, on) => {
  const seen = stubRoom(on, { env: SEAT_ENV, lines: [{ status: 'online' }] })
  await start($)
  expect(seen.ended).toBe(0)
  await $.command.run({ command: 'room-leave', args: '' })
  await settle($)
  expect(seen.ended).toBe(1) // the feed itself was ended, not just the status changed
  expect((await $.command.run({ command: 'room-status', args: '' })).text).toMatch(/left/)
  const out = await $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'x' })
  expect(out.deny).toMatch(/not .*joined/)
})

test('/room-join reconnects a launched seat with its environment settings after its feed stops', async ($, on) => {
  let spawned = 0
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    spawn: (signal: AbortSignal) => (spawned++ ? playing([{ status: 'online' }])(signal) : exiting(1)()),
  })
  await start($)
  expect(await statusOnce($, /stopped/)).toMatch(/stopped/)
  const out = await $.command.run({ command: 'room-join', args: '' })
  expect(out.text).not.toMatch(/Configure options/)
  expect(seen.spawns.length).toBe(2)
  expect(seen.spawns[1].env).toEqual({ ROOM_URL: 'http://room.test', ROOM_SEAT_TOKEN: 'tok', ROOM_SEAT_HANDLE: 'ana-agent' })
})

test('a feed that exits on its own shows its exit code', async ($, on) => {
  stubRoom(on, { env: SEAT_ENV, spawn: exiting(3) })
  await start($)
  expect(await statusOnce($, /stopped/)).toMatch(/stopped \(exit code 3\)/)
})

test('a room turn that cannot start, closed against a room that does not answer, does not hold the next one', async ($, on) => {
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    lines: [{ text: 'one' }, { text: 'two' }],
    fetch: () => new Promise(() => {}),
    submit: () => ({ drop: 'paused by policy' }),
  })
  await start($)
  for (let i = 0; i < 50 && seen.submits.length < 2; i++) await $.command.run({ command: 'room-status', args: '' })
  expect(seen.submits).toEqual(['one', 'two'])
})

test('lines the feed already printed are dropped once the seat leaves', async ($, on) => {
  const idle = deferred()
  const seen = stubRoom(on, {
    env: SEAT_ENV,
    // Both prompts in one piece of output, as a pipe may deliver them.
    spawn: async function* (signal: AbortSignal) {
      yield { stream: 'stdout' as const, text: '{"text":"one"}\n{"text":"two"}\n' }
      await new Promise(r => signal.aborted ? r(null) : signal.addEventListener('abort', r, { once: true }))
      return { value: { code: null, signal: 'SIGTERM' } }
    },
    submit: e => (e.text === 'one' ? idle.promise.then(() => ({ text: e.text })) : { text: e.text }),
  })
  await start($)
  await seen.prompted.promise
  await $.command.run({ command: 'room-leave', args: '' })
  idle.resolve()
  await settle($)
  await settle($)
  expect(seen.submits).toEqual(['one'])
})

test('room_reply gives up when the room does not answer within 15s', async ($, on) => {
  const clock = mock.clock(on)
  stubRoom(on, { env: SEAT_ENV, fetch: () => new Promise(() => {}) })
  await start($)
  let done = false
  const reply = $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'done' })
  reply.then(() => { done = true })
  await clock.advance(14_999)
  expect(done).toBe(false)
  await clock.advance(1)
  expect((await reply).deny).toBe('room_reply failed: the room did not answer within 15s')
})
