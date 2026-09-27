// extension/src/workers.js
//
// The worker fleet, as the extension sees it: what exists, what each one is
// doing, and what it has done.
//
// Nothing is spawned here. The room mints the seat, allocates the handle and
// runs `scripts/room-opencode-seat.mjs` under its own supervisor; this asks it
// to, over HTTP, through room-client.js. One implementation of "spawn a
// worker" serves channel-mode sessions and this extension alike, and the
// extension no longer supervises processes the room owns.
//
// The live state is driven entirely by the room's own event stream, which the
// session already subscribes to once. `applyRoomEvent` is pure over this
// module's own state, which is what makes the whole thing testable without a
// socket or a real worker.
'use strict'

/** How long a worker's turn may run before the driver abandons it. */
const DEFAULT_TURN_TIMEOUT_MS = 300_000

/**
 * How many transcript entries a worker keeps.
 *
 * Bounded because a worker lives as long as the chat does and a busy one
 * produces a row per tool call. The most recent entries are the ones worth
 * having, so the oldest are dropped.
 */
const MAX_TRANSCRIPT = 500

/**
 * @param {{roomClient: object, model?: string, timeoutMs?: number,
 *          log?: Function, now?: () => number}} deps
 */
function createWorkerPool({
  roomClient,
  model = null, timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  log = () => {}, now = Date.now,
}) {
  /** @type {Map<string, object>} handle -> worker */
  const workers = new Map()
  const listeners = new Set()

  const snapshot = () => [...workers.values()].map(w => ({ ...w }))

  /** Append to a worker's transcript, dropping the oldest past the bound. */
  function record(w, entry) {
    w.transcript.push(entry)
    if (w.transcript.length > MAX_TRANSCRIPT) w.transcript.splice(0, w.transcript.length - MAX_TRANSCRIPT)
  }

  function changed() {
    const list = snapshot()
    for (const fn of listeners) {
      try { fn(list) } catch { /* a listener must not take the pool down */ }
    }
  }

  /**
   * Ask the room for a worker and record what it gave back.
   *
   * The handle comes from the response, never from a local counter: the room
   * allocates it, and a guessed one would address a seat that does not exist.
   */
  async function spawn({ model: wanted = model } = {}) {
    const r = await roomClient.spawnWorker(wanted ? { model: wanted } : {})
    if (!r?.ok || !r.handle) {
      log(`could not start a worker: ${r?.errors?.[0] ?? 'the room did not return a handle'}`)
      // Nothing changed, but a caller waiting for the attempt to settle (the
      // sidebar's Add button, disabled since the click) needs to hear that it
      // has, or a refused spawn leaves it disabled forever.
      changed()
      return null // a worker the room refused is not a worker
    }

    workers.set(r.handle, {
      handle: r.handle,
      model: wanted,
      // The room always makes it here; the path is shown, the directory is
      // not this process's to know.
      worktree: `.worktrees/${r.handle}`,
      // Not idle: there is no worktree and no opencode yet, and a delegation
      // sent now would fail. "Idle" would be a lie the sidebar repeats.
      state: 'starting',
      task: null,
      lastTool: null,
      deadlineAt: null,
      startedAt: now(),
      // What the orchestrator actually asked for, kept as fields rather than
      // as the prose the model received. Outlives the delegation: "what was it
      // asked to do" is still the question after the answer arrives.
      brief: null,
      transcript: [],
      toolsUsed: [],
    })
    changed()
    return r.handle
  }

  return {
    /** Start a worker if there are none. Idempotent. */
    async ensureOne() {
      if (workers.size > 0) return null
      return spawn()
    },

    /** Start another worker alongside the existing ones. */
    add(opts = {}) {
      return spawn(opts)
    },

    /**
     * Ask the room to stop a worker, and forget it only if it agreed.
     *
     * Dropping the row on a refusal would hide a live process holding a
     * worktree; the room is the authority on whether it actually died.
     */
    async stop(handle) {
      if (!workers.has(handle)) return
      const r = await roomClient.stopWorker(handle)
      if (!r?.ok) {
        log(`could not stop ${handle}: ${r?.errors?.[0] ?? 'unknown error'}`)
        return
      }
      workers.delete(handle)
      changed()
    },

    list: snapshot,

    /**
     * Everything the detail view shows for one worker, or null.
     *
     * `toolsUsed` is what this worker HAS used, not what it could: the
     * launcher picks opencode's port internally, so its declared /config is
     * not reachable from here. What it has actually reached for is both
     * obtainable and the more honest answer.
     */
    detail(handle) {
      const w = workers.get(handle)
      if (!w) return null
      return { ...w, transcript: [...w.transcript], toolsUsed: [...w.toolsUsed] }
    },

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
          w.brief = { id: data.id, task: data.task ?? null, class: data.class ?? null, spec: data.spec ?? {} }
          record(w, { kind: 'brief', text: data.task ?? '', at: now() })
        } else if (data.state === 'done') {
          w.state = 'idle'
          w.task = null
          w.deadlineAt = null
          record(w, { kind: 'reply', text: data.text ?? '', at: now() })
        } else if (data.state === 'abandoned') {
          w.state = 'idle'
          w.task = null
          w.deadlineAt = null
          // Recorded rather than left as a silent stop: a worker that simply
          // goes quiet is indistinguishable from one still thinking.
          record(w, { kind: 'abandoned', text: `abandoned: ${data.reason ?? 'unknown reason'}`, at: now() })
        }
        changed()
        return
      }

      if (event === 'seat-online') {
        // The only signal that a worker with no task yet is actually ready:
        // delegation and activity both require it to already be doing
        // something, so without this a worker nobody has delegated to yet
        // stayed on "starting" forever, looking stuck though it was fine.
        if (w.state === 'starting') { w.state = 'idle'; changed() }
        return
      }

      if (event === 'activity') {
        // A worker producing activity is plainly past starting, whatever the
        // launcher has got round to reporting.
        if (w.state === 'starting') w.state = 'busy'
        if (data.tool) {
          w.lastTool = data.tool
          if (data.kind !== 'tool-end') {
            record(w, { kind: 'tool', tool: data.tool, input: data.input ?? null, at: now() })
            if (!w.toolsUsed.includes(data.tool)) w.toolsUsed.push(data.tool)
          }
        }
        changed()
      }
    },
  }
}

module.exports = { createWorkerPool, DEFAULT_TURN_TIMEOUT_MS, MAX_TRANSCRIPT }
