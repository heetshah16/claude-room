// extension/src/supervisor.js
'use strict'
const { EventEmitter } = require('node:events')
const { spawn: nodeSpawn, execFile } = require('node:child_process')

/**
 * Kill a process and everything it started.
 *
 * `child.kill()` is not enough on Windows: a `.cmd` shim runs under cmd.exe,
 * so killing the child kills the shell and leaves the real server running,
 * holding its port and its worktree. That was observed twice while building
 * the OpenCode seat, both times needing a manual hunt.
 */
function defaultKillTree(pid, platform = process.platform) {
  if (!pid) return
  if (platform === 'win32') {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => {})
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
}

function createSupervisor({
  spawn = nodeSpawn,
  killTree = defaultKillTree,
  log = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  const bus = new EventEmitter()
  const procs = new Map() // name -> { child, state, error, pid, stopping, order }
  let order = 0

  function start(name, { cmd, args = [], opts = {} }) {
    if (procs.has(name)) stop(name)
    const child = spawn(cmd, args, opts)
    const rec = { child, state: 'running', error: null, pid: child.pid, stopping: false, order: order++ }
    procs.set(name, rec)

    // Logged AND buffered: the log is for the output channel, the buffer is
    // for a caller that needs to explain a failure in the child's own words
    // (devtunnel prints why it failed on stderr, not stdout).
    rec.errOutput = ''
    child.stderr?.on('data', d => {
      rec.errOutput = (rec.errOutput + d).slice(-4096)
      log(`${name}: ${d}`)
    })

    // Bounded so a chatty child (or one left running a long time) cannot grow
    // this without limit; devtunnel's URL line appears in its first few lines,
    // so keeping only the tail is enough for parseTunnelUrl to find it.
    rec.output = ''
    child.stdout?.on('data', d => {
      rec.output = (rec.output + d).slice(-4096)
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
      // an error in front of the user every time they close the window.
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
    /** Reverse start order: workers depend on the room, so the room goes last. */
    stopAll() {
      const names = [...procs.entries()].sort((a, b) => b[1].order - a[1].order).map(([n]) => n)
      for (const n of names) stop(n)
    },
    status(name) {
      const rec = procs.get(name)
      if (!rec) return { state: 'stopped', pid: null, error: null, output: '', errOutput: '' }
      return {
        state: rec.state, pid: rec.pid, error: rec.error,
        output: rec.output ?? '', errOutput: rec.errOutput ?? '',
      }
    },
    on: (ev, cb) => bus.on(ev, cb),
  }
}

module.exports = { createSupervisor, defaultKillTree }
