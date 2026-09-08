// extension/src/workers.js
//
// The worker fleet: minting a seat, launching it, and tracking what it is
// doing.
//
// A worker is an OpenCode seat in the room. Minting one is a single owner-only
// call (`invite` with `kind: 'agent'`), and launching it is
// `scripts/room-opencode-seat.mjs` -- which is what creates the git worktree,
// starts `opencode serve`, registers the reply-only bridge so the seat can call
// room_reply, and runs the driver. Launching `opencode` directly from here
// would reimplement all four.
//
// The live state is driven entirely by the room's own event stream, which the
// extension already subscribes to once. `applyRoomEvent` is pure over this
// module's own state, which is what makes the whole thing testable without a
// socket or a real worker.
'use strict'
const { join } = require('node:path')

/** How long a worker's turn may run before the driver abandons it. */
const DEFAULT_TURN_TIMEOUT_MS = 300_000

/**
 * argv for `scripts/room-opencode-seat.mjs`.
 *
 * `model` and `timeout` are omitted when unset so the launcher's own defaults
 * win; passing them explicitly would silently pin whatever they happen to be.
 */
function workerRecipe({
  repoRoot, handle, token, roomUrl, model = null, timeoutMs = null,
  nodePath = process.execPath, env = process.env,
}) {
  const args = [
    join(repoRoot, 'scripts', 'room-opencode-seat.mjs'),
    handle,
    '--token', token,
    '--repo', repoRoot,
    '--room', roomUrl,
  ]
  if (model) args.push('--model', model)
  if (timeoutMs) args.push('--timeout', String(timeoutMs))

  return {
    cmd: nodePath,
    args,
    opts: {
      // The worktree is created relative to the repo, so this is where the
      // launcher has to run.
      cwd: repoRoot,
      // The token travels in argv, which the launcher reads. Putting it in the
      // environment as well would widen where a seat credential can be read
      // from, and buy nothing.
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  }
}

/** The lowest free `worker-N`, so a stopped worker's handle comes back. */
function nextHandle(existing) {
  const taken = new Set(existing)
  for (let i = 1; ; i++) {
    const h = `worker-${i}`
    if (!taken.has(h)) return h
  }
}

/**
 * @param {{roomClient: object, supervisor: object, repoRoot: string,
 *          roomUrl: string, model?: string, timeoutMs?: number,
 *          log?: Function, now?: () => number}} deps
 */
function createWorkerPool({
  roomClient, supervisor, repoRoot, roomUrl,
  model = null, timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  log = () => {}, now = Date.now,
}) {
  /** @type {Map<string, object>} handle -> worker */
  const workers = new Map()
  const listeners = new Set()

  const snapshot = () => [...workers.values()].map(w => ({ ...w }))

  function changed() {
    const list = snapshot()
    for (const fn of listeners) {
      try { fn(list) } catch { /* a listener must not take the pool down */ }
    }
  }

  /** The owner's member id, which `invite` requires and must not be guessed. */
  async function ownerId() {
    const state = await roomClient.state()
    return state?.you?.id ?? null
  }

  async function spawn() {
    const owner = await ownerId()
    if (!owner) {
      // Guessing would mint a seat owned by nobody, whose cost lands nowhere.
      log('cannot start a worker: the room did not report an owner')
      return null
    }

    const handle = nextHandle([...workers.keys()])
    const invited = await roomClient.invite({
      name: handle,
      kind: 'agent',
      handle,
      ownerId: owner,
      // The orchestrator's permission to delegate here. Room ownership does
      // not grant it -- it is a separate, per-seat opt-in.
      delegatable: true,
    })
    if (!invited?.ok || !invited.token) {
      log(`could not mint a seat for ${handle}: ${invited?.errors?.[0] ?? 'unknown error'}`)
      return null // a worker with no seat is not a worker
    }

    try {
      supervisor.start(`worker:${handle}`, workerRecipe({
        repoRoot, handle, token: invited.token, roomUrl, model, timeoutMs,
      }))
    } catch (err) {
      // `opencode` missing from PATH is the common case. Degrade to "no
      // workers" rather than to a row that will never do anything.
      log(`could not start ${handle}: ${err?.message ?? err}`)
      return null
    }

    workers.set(handle, {
      handle,
      model,
      worktree: join(repoRoot, '.worktrees', handle),
      // Not idle: there is no worktree and no opencode yet, and a delegation
      // sent now would fail. "Idle" would be a lie the sidebar repeats.
      state: 'starting',
      task: null,
      lastTool: null,
      deadlineAt: null,
      startedAt: now(),
    })
    changed()
    return handle
  }

  return {
    /** Start a worker if there are none. Idempotent. */
    async ensureOne() {
      if (workers.size > 0) return null
      return spawn()
    },

    /** Start another worker alongside the existing ones. */
    add() {
      return spawn()
    },

    stop(handle) {
      if (!workers.has(handle)) return
      supervisor.stop(`worker:${handle}`)
      workers.delete(handle)
      changed()
    },

    stopAll() {
      for (const handle of [...workers.keys()]) supervisor.stop(`worker:${handle}`)
      workers.clear()
      changed()
    },

    list: snapshot,

    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /**
     * The room's own event stream, applied to the fleet's state.
     *
     * Fed from the single SSE subscription the extension already holds --
     * ARCHITECTURE.md states that one subscription and one ordering is
     * deliberate, so this takes a callback rather than opening a second.
     */
    applyRoomEvent(event, data) {
      const handle = data?.handle ?? data?.to ?? data?.dest
      const w = handle ? workers.get(handle) : null
      // An event for a handle this pool does not own: another room member's
      // seat, or a worker already stopped. Never invent one.
      if (!w) return

      if (event === 'delegation') {
        if (data.state === 'sent') {
          w.state = 'busy'
          w.task = data.task ?? null
          // The driver's own per-turn deadline: the number that decides
          // whether a stalled free model gets killed, and therefore the only
          // one worth counting down.
          w.deadlineAt = now() + timeoutMs
        } else if (data.state === 'done' || data.state === 'abandoned') {
          w.state = 'idle'
          w.task = null
          w.deadlineAt = null
        }
        changed()
        return
      }

      if (event === 'activity') {
        // A worker producing activity is plainly past starting, whatever the
        // launcher has got round to reporting.
        if (w.state === 'starting') w.state = 'busy'
        if (data.tool) w.lastTool = data.tool
        changed()
      }
    },
  }
}

module.exports = { workerRecipe, nextHandle, createWorkerPool, DEFAULT_TURN_TIMEOUT_MS }
