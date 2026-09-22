/**
 * The worker fleet: minting a seat, launching it, and tearing it down.
 *
 * A worker is an OpenCode seat in the room. Minting one is `registry.add` of an
 * agent member — the same internal path POST /api/admin/invite takes
 * (src/admin.mjs:99) — and launching it is scripts/room-opencode-seat.mjs,
 * which is what creates the git worktree, starts `opencode serve`, registers
 * the reply-only bridge so the seat can call room_reply, and runs the driver.
 * Launching `opencode` from here would reimplement all four.
 *
 * Ported in logic from extension/src/workers.js, minus its state tracking:
 * that half exists to drive a sidebar from an HTTP event feed, and inside the
 * room `seats` and the supervisor already hold both facts first-hand.
 *
 * `delegatable` is unconditional. A self-spawned worker exists to be delegated
 * to; making that opt-in would be friction with no decision behind it.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentMember } from './identity.mjs'
import { createSupervisor } from './supervisor.mjs'
import { spawnPortable } from './spawn.mjs'

/**
 * The launcher, resolved from this module rather than from cwd: the room is
 * routinely started from the repo being worked on, which is not this checkout.
 */
const LAUNCHER = fileURLToPath(new URL('../scripts/room-opencode-seat.mjs', import.meta.url))

/** The lowest free `worker-N`, so a stopped worker's handle comes back. */
export function nextHandle(existing) {
  const taken = new Set(existing)
  for (let i = 1; ; i++) {
    const h = `worker-${i}`
    if (!taken.has(h)) return h
  }
}

/**
 * Where a handle's worktree lives.
 *
 * Byte-identical to scripts/room-seat.mjs's `worktreeFor`, which is what
 * actually creates the directory (scripts/room-opencode-seat.mjs:44-48).
 * Duplicated rather than imported because src/ must not depend on scripts/ —
 * the dependency runs the other way. test/workers.test.mjs pins the two
 * together so a change to either fails the suite rather than silently
 * verifying in a directory nobody wrote to.
 */
export function worktreeFor(repoRoot, handle) {
  const safe = String(handle).replace(/^@/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return join(repoRoot, '.worktrees', safe)
}

/**
 * argv for scripts/room-opencode-seat.mjs.
 *
 * `model` is omitted when unset so the launcher's own default wins; passing it
 * explicitly would silently pin whatever that happens to be today.
 */
export function workerRecipe({
  repoRoot, handle, token, roomUrl, model = null,
  nodePath = process.execPath, launcher = LAUNCHER, env = process.env,
}) {
  const args = [launcher, handle, '--token', token, '--repo', repoRoot, '--room', roomUrl]
  if (model) args.push('--model', model)
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

/**
 * @param {{registry:object, seats:object, config:object, store:object, bus:object,
 *          spawn?:Function, repoRoot:string, roomUrl:string,
 *          log?:Function, now?:() => number}} deps
 */
export function createWorkerFleet({
  registry, seats, config, store, bus,
  spawn = spawnPortable,
  repoRoot, roomUrl,
  log = () => {}, now = Date.now,
}) {
  /** @type {Map<string, {handle:string, model:string|null, memberId:string, worktree:string, state:string, exitCode:number|null, startedAt:number}>} */
  const workers = new Map()
  const supervisor = createSupervisor({ spawn, log })
  const procName = handle => `worker:${handle}`

  supervisor.on('exit', ({ name, code }) => {
    const w = workers.get(name.slice('worker:'.length))
    // An exit for a name this fleet does not own, or a worker already stopped.
    if (!w) return
    w.state = 'exited'
    w.exitCode = code
    log(`${w.handle} exited with code ${code}`)
    bus?.publish?.('worker', { handle: w.handle, state: 'exited', code })
  })

  /**
   * A worker's state is derived, never tracked: `exited` is the supervisor's
   * fact, and "is it ready" is the seat feed's fact, which Seats already owns.
   * A third copy would be the one that goes stale.
   */
  const stateOf = w => (w.state === 'exited' ? 'exited' : seats?.isOnline?.(w.handle) ? 'online' : 'starting')

  const row = w => ({
    handle: w.handle, model: w.model, worktree: w.worktree,
    state: stateOf(w), exitCode: w.exitCode, startedAt: w.startedAt,
  })

  function stop(handle) {
    const w = workers.get(handle)
    if (!w) return { ok: false, errors: [`no worker ${handle} in this fleet`] }
    supervisor.stop(procName(handle))
    workers.delete(handle)
    // The credential dies with the process. Leaving the member behind would
    // leave `@worker-1` on the roster, addressable and permanently offline,
    // and would keep nextHandle from ever handing the name out again.
    seats?.evict?.(w.memberId)
    registry.revoke(w.memberId)
    store?.saveRegistry?.(registry)
    bus?.publish?.('worker', { handle, state: 'stopped' })
    return { ok: true }
  }

  return {
    /**
     * Mint a seat and launch it. Returns once the process is LAUNCHED, which
     * matches `delegate`'s own fire-and-forget shape — readiness is discovered
     * through `list_workers`, the same way every other worker fact is.
     */
    async spawn({ model = null } = {}) {
      const owner = registry.owners?.()[0] ?? null
      if (!owner) {
        // Guessing would mint a seat owned by nobody, whose cost lands nowhere.
        return { ok: false, errors: ['this room has no owner to charge a worker to'] }
      }

      const handle = nextHandle([
        ...workers.keys(),
        ...registry.agents().map(a => a.handle),
        // Names as well as handles: Registry.add enforces neither, and a
        // duplicate name breaks byName for everyone.
        ...registry.all().map(m => String(m.name).toLowerCase()),
      ])
      const member = registry.add(createAgentMember({
        name: handle, handle, ownerId: owner.id, delegatable: true,
      }))
      store?.saveRegistry?.(registry)

      const chosen = model ?? config?.workerModel ?? null
      try {
        supervisor.start(procName(handle), workerRecipe({
          repoRoot, handle, token: member.token, roomUrl, model: chosen,
        }))
      } catch (err) {
        // A seat with no process is worse than no seat: the orchestrator would
        // see the handle and delegate into something that never answers.
        registry.revoke(member.id)
        store?.saveRegistry?.(registry)
        return { ok: false, errors: [`could not start ${handle}: ${err?.message ?? err}`] }
      }

      workers.set(handle, {
        handle, model: chosen, memberId: member.id,
        worktree: worktreeFor(repoRoot, handle),
        state: 'starting', exitCode: null, startedAt: now(),
      })
      bus?.publish?.('worker', { handle, state: 'starting', model: chosen })
      return { ok: true, handle }
    },

    stop,

    stopAll() {
      for (const handle of [...workers.keys()]) stop(handle)
    },

    list() {
      return [...workers.values()].map(row)
    },
  }
}
