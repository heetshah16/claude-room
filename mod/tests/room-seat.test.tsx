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

// Stubs everything the mod calls. `lines` are what the fake feed prints, or
// `spawn` replaces the fake feed whole; `fetch` answers each post (default:
// 200). Records posts and spawns. Overrides go through these options:
// a second stub on the same event would never run, the first one answering.
function stubRoom(on, { env = {}, lines = [] as object[], spawn = undefined as any, fetch = undefined as any, submit = undefined as any } = {}) {
  const seen = {
    posts: [] as { url: string; body: any }[],
    spawns: [] as any[],
    tools: 0,
    prompted: deferred<any>(), // the first prompt.submit event
  }
  const feed = spawn ?? playing(lines)
  mock.env(on, env)
  on('session.start', () => ({ cwd: '/work' }))
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
    return yield* feed(next.signal)
  })
  on('prompt.submit', ($, e) => {
    seen.prompted.resolve(e)
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

test('/room-join uses the plugin options and strips a leading @ from the handle', { options: CONFIG }, async ($, on) => {
  const seen = stubRoom(on, { lines: [{ status: 'online' }] })
  await start($)
  expect(seen.spawns.length).toBe(0) // options alone never auto-join
  await $.command.run({ command: 'room-join', args: '' })
  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0].env.ROOM_SEAT_HANDLE).toBe('ana-agent')
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
  stubRoom(on, { env: SEAT_ENV, lines: [{ status: 'online' }] })
  await start($)
  await $.command.run({ command: 'room-leave', args: '' })
  expect((await $.command.run({ command: 'room-status', args: '' })).text).toMatch(/left/)
  const out = await $.tool.call({ tool: 'mcp__room-seat__room_reply', text: 'x' })
  expect(out.deny).toMatch(/not .*joined/)
})
