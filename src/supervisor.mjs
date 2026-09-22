/**
 * Supervised child processes, for the room itself.
 *
 * Ported from extension/src/supervisor.js, which has been driving real
 * `opencode` and room children since the extension shipped. The room needs its
 * own copy because it is now the thing that spawns workers (spec §1): the
 * extension's supervisor lives in a different process and a different module
 * system, so there is nothing to share.
 *
 * Nothing here is a restart policy. A worker that dies stays dead and is
 * reported — the orchestrator decides whether to spawn another, the same way
 * it decides everything else this project keeps out of the room.
 */
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { spawnPortable } from './spawn.mjs'

/** How much of a child's stdout to keep. Bounded: a worker outlives the turn. */
const MAX_OUTPUT = 4096

/**
 * Kill a process and everything it started.
 *
 * `child.kill()` is not enough on Windows: an npm `.cmd` shim runs under
 * cmd.exe, so killing the child kills the shell and leaves the real server
 * running, holding its port and its worktree. That was observed twice while
 * building the OpenCode seat, both times needing a manual hunt.
 */
export function defaultKillTree(pid, platform = process.platform) {
  if (!pid) return
  if (platform === 'win32') {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => {})
    return
  }
  // Negative pid is the process group — the POSIX half of the same idea.
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
}

/**
 * @param {{spawn?:Function, killTree?:Function, log?:Function}} deps
 */
export function createSupervisor({
  spawn = spawnPortable,
  killTree = defaultKillTree,
  log = () => {},
} = {}) {
  const bus = new EventEmitter()
  const procs = new Map() // name -> { child, state, error, pid, stopping, order, output }
  let order = 0

  function start(name, { cmd, args = [], opts = {} }) {
    if (procs.has(name)) stop(name)
    const child = spawn(cmd, args, opts)
    const rec = {
      child, state: 'running', error: null, pid: child.pid,
      stopping: false, order: order++, output: '',
    }
    procs.set(name, rec)

    // Nothing else reads stderr, so an unread pipe would sit full and a crash
    // would surface as a bare exit code with no reason attached to it.
    child.stderr?.on('data', d => log(`${name}: ${d}`))
    child.stdout?.on('data', d => {
      rec.output = (rec.output + d).slice(-MAX_OUTPUT)
    })

    child.on('error', err => {
      rec.error = String(err?.message ?? err)
      rec.state = 'exited'
      log(`${name}: ${rec.error}`)
      if (!rec.stopping) bus.emit('exit', { name, code: null })
    })
    child.on('exit', code => {
      rec.state = rec.stopping ? 'stopped' : 'exited'
      // A stop we asked for is not a crash, and reporting it as one would put
      // an error in front of the user every time they shut a worker down.
      if (!rec.stopping) bus.emit('exit', { name, code })
    })
    return rec
  }

  function stop(name) {
    const rec = procs.get(name)
    if (!rec) return
    rec.stopping = true
    rec.state = 'stopped'
    killTree(rec.pid)
    procs.delete(name)
  }

  return {
    start,
    stop,
    /** Reverse start order: later children may depend on earlier ones. */
    stopAll() {
      const names = [...procs.entries()].sort((a, b) => b[1].order - a[1].order).map(([n]) => n)
      for (const n of names) stop(n)
    },
    status(name) {
      const rec = procs.get(name)
      if (!rec) return { state: 'stopped', pid: null, error: null, output: '' }
      return { state: rec.state, pid: rec.pid, error: rec.error, output: rec.output ?? '' }
    },
    on: (ev, cb) => bus.on(ev, cb),
  }
}
