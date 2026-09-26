// extension/src/session.js
//
// The room session: the room process, its owner token, the one SSE
// subscription, the worker fleet, and the publish/invite controls.
//
// All of this used to be closures inside extension.js's openChat(), which meant
// the room only existed while a chat window was open -- and the sidebar, which
// registers at activation, had nothing to show. The chat is optional now
// (spec §4), so this owns the lifetime and the chat attaches to it.
//
// Nothing here requires the `vscode` module. The two things that genuinely do
// -- a dialog and the clipboard -- arrive as `ui`, which is what makes every
// line below testable without an extension host.
'use strict'
const net = require('node:net')

const { roomRecipe, readOwnerToken, createRoomClient, PUBLISHED_HOST } = require('./room-client.js')
const { detectDevtunnel, tunnelRecipe, parseTunnelUrl, isLoggedIn: devtunnelLoggedIn } = require('./tunnel.js')
const { createEventRouter } = require('./events.js')
const { createWorkerPool } = require('./workers.js')

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Binds 127.0.0.1:0 and releases it, so the room gets a port nothing else is using. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}

/**
 * Reads Server-Sent Events by hand off a fetch Response's streaming body.
 *
 * Deliberately NOT `src/seat.mjs`'s `readFrames`, even though the shape is
 * identical: `src/seat.mjs` is ESM and this extension is CommonJS. This is the
 * same ~20 lines, duplicated on purpose: do not "fix" this by reaching across
 * the module-system boundary.
 *
 * Frames are separated by a blank line; only `event:`/`data:` lines matter, so
 * a bare `: comment` keep-alive is silently skipped.
 */
async function readEventStream(body, onFrame) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = null
      let data = null
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length)
        else if (line.startsWith('data: ')) data = line.slice('data: '.length)
      }
      if (data !== null) onFrame(event, data)
    }
  }
}

/**
 * One SSE subscription to the room's event feed, fanned out through `router`.
 * Reconnects on any drop with a fixed delay -- the feed matters for as long as
 * the session lives, so a dropped connection is worth retrying.
 *
 * @returns {() => void} stop -- aborts the subscription and any pending retry.
 */
function subscribeToRoomEvents(roomClient, router, { fetchImpl, sleep }) {
  let stopped = false
  let controller = null

  async function connectOnce() {
    controller = new AbortController()
    try {
      const res = await fetchImpl(
        `${roomClient.roomUrl}/events?token=${encodeURIComponent(roomClient.token)}`,
        { signal: controller.signal },
      )
      if (!res.ok || !res.body) throw new Error(`room events feed failed: HTTP ${res.status}`)
      await readEventStream(res.body, (event, raw) => {
        if (!event) return // the room always sends event:; only OpenCode's raw feed omits it
        let data
        try { data = JSON.parse(raw) } catch { return } // a malformed frame must not kill the feed
        router.handle(event, data)
      })
    } catch {
      // Aborted by stop(), a network error, or a bad response -- every case is
      // handled the same way below: try again unless told to stop.
    }
  }

  // DEVIATION FROM THE BRIEF (see task-4 report): the `await new Promise(...)`
  // line below is not in the brief's given code.
  //
  // `sleep` is a test double in session.test.js that resolves with no real
  // timer at all (`async () => {}`), so this loop's retry -- unbounded by
  // design, since the feed matters for as long as the session lives -- was a
  // pure-microtask cycle under test: nothing here ever touched a real timer,
  // which starves the whole process's event loop (no timer, no I/O, not even
  // node:test's own reporting, can run while a chain of already-resolved
  // promises keeps re-queue itself). Every one of this suite's 16 tests hung
  // forever, including the very first, simplest one. A real, unref'd tick
  // fixes that: unref'd, so it never keeps a production process alive on its
  // own, and production is unaffected either way -- `sleep(1000)` already
  // puts a real second between retries there.
  ;(async () => {
    while (!stopped) {
      await connectOnce()
      if (stopped) return
      await sleep(1000)
      await new Promise(resolve => { const t = setImmediate(resolve); t.unref() })
    }
  })()

  return () => {
    stopped = true
    controller?.abort()
  }
}

/** Polls `fn` with exponential backoff until it returns truthy or `timeoutMs` elapses. */
async function pollWithBackoff(fn, { timeoutMs = 10_000, startMs = 150, maxMs = 1000, sleep = realSleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs
  let delay = startMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (now() >= deadline) return null
    await sleep(delay)
    delay = Math.min(delay * 2, maxMs)
  }
}

/**
 * @param {{repoRoot: string, stateDir: string, supervisor: object,
 *          ui: {showError: Function, showInfo: Function, copy: Function},
 *          log?: Function, fetchImpl?: Function, pickPort?: Function,
 *          readToken?: Function, detectTunnel?: Function, isLoggedIn?: Function,
 *          sleep?: Function, now?: () => number}} deps
 */
function createSession({
  repoRoot,
  stateDir,
  supervisor,
  ui,
  log = () => {},
  fetchImpl = (...args) => fetch(...args),
  pickPort = pickFreePort,
  readToken = readOwnerToken,
  detectTunnel = detectDevtunnel,
  isLoggedIn = devtunnelLoggedIn,
  sleep = realSleep,
  now = Date.now,
}) {
  const roomListeners = new Set()
  const workerListeners = new Set()
  const activityListeners = new Set()
  const resultListeners = new Set()

  const emit = (set, ...args) => {
    for (const fn of set) {
      try { fn(...args) } catch { /* a listener must not take the session down */ }
    }
  }
  const listen = (set, fn) => { set.add(fn); return () => set.delete(fn) }

  let port = null
  let stopFeed = null
  let published = false

  /**
   * Waits for the room's HTTP server to be listening at all. Any response --
   * even the 401 an unauthenticated /api/state gets -- proves the process is
   * up; the token wait below is what waits for it to finish booting.
   */
  async function waitForRoomUp(roomUrl) {
    const ok = await pollWithBackoff(async () => {
      try {
        await fetchImpl(`${roomUrl}/api/state`)
        return true
      } catch {
        return false
      }
    }, { sleep, now })
    if (!ok) throw new Error('the room did not start listening within 10s')
  }

  /**
   * readOwnerToken returns null until the room has written its roster -- absent
   * on the very first boot. Fail loudly rather than hanging forever.
   */
  async function waitForOwnerToken() {
    const token = await pollWithBackoff(() => readToken(stateDir), { sleep, now })
    if (!token) throw new Error('the room did not write its owner token within 10s')
    return token
  }

  async function start() {
    if (api.roomClient) return { ok: true, roomUrl: api.roomUrl, token: api.token }

    try {
      port = await pickPort()
    } catch (err) {
      return { ok: false, error: `could not find a free port: ${err?.message ?? err}` }
    }
    const roomUrl = `http://127.0.0.1:${port}`
    supervisor.start('room', roomRecipe({ repoRoot, stateDir, port }))

    let token
    try {
      await waitForRoomUp(roomUrl)
      token = await waitForOwnerToken()
    } catch (err) {
      supervisor.stop('room')
      return { ok: false, error: err?.message ?? String(err) }
    }

    const roomClient = createRoomClient({ roomUrl, token, fetchImpl })
    const pool = createWorkerPool({ roomClient, log, now })
    pool.onChange(list => emit(workerListeners, list))

    // One SSE subscription, fanned out by the router: worker activity to
    // whoever is showing it, a finished delegation to whoever relays it, and
    // every frame to the pool. One subscription is one ordering, which is what
    // keeps a worker's reply from arriving before the work that produced it.
    const router = createEventRouter({
      onWorkerActivity: a => emit(activityListeners, a),
      onDelegationResult: d => emit(resultListeners, d),
      onRoomEvent: (event, data) => pool.applyRoomEvent(event, data),
    })
    stopFeed = subscribeToRoomEvents(roomClient, router, { fetchImpl, sleep })

    api.roomUrl = roomUrl
    api.token = token
    api.roomClient = roomClient
    api.pool = pool
    return { ok: true, roomUrl, token }
  }

  /** Everything a room surface renders, in one message. */
  async function postRoom(extra = {}) {
    const state = await api.roomClient?.adminState()
    emit(roomListeners, {
      published,
      // Taken from a join link rather than recomputed here: the room is the
      // only thing that knows which address it decided to advertise.
      advertised: state?.members?.[0]?.joinUrl ?? null,
      // null adminState means the call failed, not that the room is empty --
      // so send null and let the surface say it does not know.
      //
      // DEVIATION FROM THE BRIEF (see task-4 report): guards `state.members`
      // itself, not just `state`. The brief's `state ? state.members.map(...)
      // : null` throws whenever adminState() resolves ok with a body that
      // has no `members` array -- which is exactly session.test.js's own
      // generic `json: async () => ({})` stub, used by 6 of this suite's 16
      // tests for calls they are not asserting on. None of those tests check
      // `members`, so this changes nothing they assert.
      members: state?.members
        ? state.members.map(m => ({ id: m.id, name: m.name, role: m.role }))
        : null,
      ...extra,
    })
  }

  /**
   * Publishing rebinds; it does not tear down. The room restarts with a
   * different bind address on the SAME port and state dir, so the owner token,
   * the roster and http://127.0.0.1:<port> all survive and the SSE feed
   * reconnects on its own existing retry loop.
   */
  async function republish(next) {
    emit(roomListeners, { busy: true, published })
    try {
      if (next) {
        if (!detectTunnel()) {
          ui.showError(
            'Claude Room: the devtunnel CLI is not installed. Run: winget install --id Microsoft.devtunnel -e, then devtunnel user login, then try Publish again.',
          )
          await postRoom({ busy: false })
          return
        }
        // Being on PATH is not being usable: `devtunnel host` still needs an
        // account. Checking this now (well under a second) turns what used to
        // be a blind 10s timeout-then-guess into an immediate, correct answer.
        if (!(await isLoggedIn())) {
          ui.showError('Claude Room: devtunnel is installed but not logged in. Run: devtunnel user login, then try Publish again.')
          await postRoom({ busy: false })
          return
        }
        supervisor.start('tunnel', tunnelRecipe({ port }))
        // The CLI prints its URL once, on stdout, then keeps running -- poll the
        // supervisor's own stdout buffer rather than re-parenting a second reader.
        const tunnelUrl = await pollWithBackoff(
          () => parseTunnelUrl(supervisor.status('tunnel').output ?? ''),
          { sleep, now },
        )
        if (!tunnelUrl) {
          // Login is already confirmed by this point, so this is some other
          // failure (network, proxy, a devtunnel-side outage) -- show its own
          // stderr rather than repeating a guess that has already been ruled out.
          const errOutput = (supervisor.status('tunnel').errOutput ?? '').trim()
          const detail = errOutput ? ` — ${errOutput}` : ''
          ui.showError(`Claude Room: devtunnel did not report a URL within 10s${detail}`)
          supervisor.stop('tunnel')
          await postRoom({ busy: false })
          return
        }
        supervisor.start('room', roomRecipe({ repoRoot, stateDir, port, host: PUBLISHED_HOST, advertise: tunnelUrl }))
      } else {
        supervisor.stop('tunnel')
        supervisor.start('room', roomRecipe({ repoRoot, stateDir, port, host: '127.0.0.1' }))
      }
      await waitForRoomUp(api.roomUrl)
      published = next
    } catch (err) {
      // State from what actually happened, not from what was asked for. A
      // failed publish leaves a tunnel pointing at a room that is not serving,
      // so it is stopped; a failed stop-sharing has still stopped the tunnel.
      // Either way sharing is not working, and saying "published" would be a
      // confident lie about who can reach this room.
      if (next) supervisor.stop('tunnel')
      published = false
      ui.showError(`Claude Room: the room did not restart — ${err?.message ?? err}`)
      log(`republish failed: ${err?.stack ?? err}`)
    }
    await postRoom({ busy: false })
  }

  async function invite({ name, role = 'member' }) {
    const r = await api.roomClient.invite({ name, role })
    if (!r?.ok) {
      ui.showError(`Claude Room: could not invite ${name} — ${r?.errors?.[0] ?? 'unknown error'}`)
      return
    }
    // The token IS the identity, so it goes to the clipboard rather than to any
    // surface, where it would be visible to anyone reading over a shoulder.
    await ui.copy(r.joinUrl)
    ui.showInfo(`Claude Room: join link for ${name} copied to the clipboard.`)
    await postRoom()
  }

  /** Ends the SSE subscription. The room child is the supervisor's to stop. */
  function stop() {
    stopFeed?.()
    stopFeed = null
  }

  const api = {
    roomUrl: null,
    token: null,
    roomClient: null,
    pool: null,
    start,
    stop,
    postRoom,
    republish,
    invite,
    isPublished: () => published,
    onRoom: fn => listen(roomListeners, fn),
    onWorkers: fn => listen(workerListeners, fn),
    onActivity: fn => listen(activityListeners, fn),
    onDelegationResult: fn => listen(resultListeners, fn),
  }
  return api
}

module.exports = { createSession, pickFreePort }
