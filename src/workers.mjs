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
import { execFileSync } from 'node:child_process'
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
 * actually creates the directory (its `ensureWorktree`, which
 * scripts/room-opencode-seat.mjs calls).
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
 * The channel's list_workers view: every currently online seat — any kind, a
 * hand-added Claude or OpenCode seat is online too, not just a fleet-spawned
 * one — plus any fleet worker the fleet itself still tracks that is NOT
 * currently online (`starting` or `exited`), which `seats.online()` alone
 * can never report: a starting worker has not joined yet, and an exited
 * one's seat entry is simply gone. A fleet worker already online is never
 * duplicated here — `fleet.list()`'s own `'online'` state is itself derived
 * from `seats.isOnline()` (see `stateOf` above), so the two can never
 * disagree about who is online, only about who currently is not.
 */
export function listWorkersView({ onlineSeats, isBusy, fleetWorkers }) {
  const rows = onlineSeats.map(seat => ({ handle: seat.handle, busy: isBusy(seat.handle), state: 'online' }))
  const onlineHandles = new Set(rows.map(r => r.handle))
  for (const w of fleetWorkers) {
    if (w.state === 'online' || onlineHandles.has(w.handle)) continue
    rows.push({ handle: w.handle, busy: false, state: w.state })
  }
  return rows
}

/** The refusal for a folder that has no git work tree. */
const notARepo = dir => `workers need a git repository: ${dir} is not one — open a git project folder (or set ROOM_REPO) and try again`

/**
 * Worktrees need a repo: without this a worker launches, then dies on `git
 * worktree add`. Returns `true` when the folder will do, else the reason it
 * will not (a string), so the refusal can name the actual problem.
 *
 * - stdout must say `true`: a bare repo prints `false` and exits 0, and has
 *   no work tree to put worktrees beside.
 * - ENOENT means git itself is missing, which is not the folder's fault —
 *   saying "<path> is not a git repository" there sends the user to the wrong fix.
 * - The timeout bounds a git that hangs (a network drive, a credential
 *   prompt), so a spawn request cannot wait forever.
 */
export function defaultIsGitRepo(dir, exec = execFileSync) {
  try {
    const out = exec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000,
    })
    return String(out).trim() === 'true' || notARepo(dir)
  } catch (err) {
    if (err?.code === 'ENOENT') return 'workers need git, and git is not on PATH — install git, restart the editor so it sees the new PATH, and try again'
    return notARepo(dir)
  }
}

/**
 * @param {{registry:object, seats:object, config:object, store:object, bus:object,
 *          spawn?:Function, isGitRepo?:(dir:string) => true|false|string, repoRoot:string, roomUrl:string,
 *          log?:Function, now?:() => number}} deps
 */
export function createWorkerFleet({
  registry, seats, config, store, bus,
  spawn = spawnPortable,
  isGitRepo = defaultIsGitRepo,
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

      // `true` is fine; anything else is a refusal — the check's own reason
      // when it gave one, the generic one for a plain `false`.
      const repoOk = isGitRepo(repoRoot)
      if (repoOk !== true) {
        return { ok: false, errors: [typeof repoOk === 'string' ? repoOk : notARepo(repoRoot)] }
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
        // The token rides on argv, so a spawn error can quote it; it is masked
        // below because this message reaches the orchestrator and the HTTP caller.
        // A seat with no process is worse than no seat: the orchestrator would
        // see the handle and delegate into something that never answers.
        registry.revoke(member.id)
        store?.saveRegistry?.(registry)
        return { ok: false, errors: [`could not start ${handle}: ${String(err?.message ?? err).replaceAll(member.token, '***')}`] }
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
