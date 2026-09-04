import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { win32, posix } from 'node:path'

/** `.cmd` and `.bat` are batch scripts: Node refuses to spawn them without a shell. */
const isBatch = ext => /^\.(cmd|bat)$/i.test(ext)

/**
 * Find the real file a command name refers to, the way the OS would.
 *
 * `env` and `platform` are parameters rather than globals so Windows
 * resolution can be tested from POSIX and vice versa — the whole class of
 * bug this module fixes is one that only appears on the other platform.
 *
 * @returns {{path:string, needsShell:boolean}|null}
 */
export function resolveCommand(name, opts = {}) {
  const {
    env = process.env,
    platform = process.platform,
    exists = existsSync,
  } = opts

  const isWin = platform === 'win32'
  const P = isWin ? win32 : posix
  const raw = String(name)

  // An explicit path is an instruction, not a search term.
  const bases = raw.includes('/') || raw.includes('\\')
    ? [raw]
    : (env.PATH || env.Path || '').split(P.delimiter).filter(Boolean).map(d => P.join(d, raw))

  if (!isWin) {
    for (const p of bases) if (exists(p)) return { path: p, needsShell: false }
    return null
  }

  // Try real executables before batch shims: a shim forces a shell, and a
  // shell forces quoting, which is an injection surface we would rather not
  // have. Array.sort is stable, so PATHEXT's own order survives within each
  // group.
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .sort((a, b) => Number(isBatch(a)) - Number(isBatch(b)))

  for (const base of bases) {
    const given = P.extname(base)
    if (given && exists(base)) return { path: base, needsShell: isBatch(given) }
    for (const ext of exts) {
      const p = base + ext.toLowerCase()
      if (exists(p)) return { path: p, needsShell: isBatch(ext) }
    }
  }
  return null
}

/**
 * A stand-in child that reports a launch failure the same way a real one
 * does. Callers already handle `error`; without this they would have to
 * handle a synchronous throw as well, and the EINVAL case proves they forget.
 */
function failedChild(err) {
  const child = new EventEmitter()
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} })
  child.stdout = stream()
  child.stderr = stream()
  child.stdin = { end() {}, write() {} }
  child.kill = () => false
  queueMicrotask(() => child.emit('error', err))
  return child
}

/**
 * spawn() that works on Windows.
 *
 * Two failures are folded into the `error` event: nothing on PATH, and the
 * synchronous EINVAL Node throws for a `.cmd` spawned without a shell.
 */
export function spawnPortable(name, args = [], opts = {}, deps = {}) {
  const { spawnImpl = nodeSpawn, ...resolveOpts } = deps
  const found = resolveCommand(name, resolveOpts)
  if (!found) return failedChild(new Error(`command not found on PATH: ${name}`))
  try {
    return spawnImpl(found.path, args, { ...opts, shell: found.needsShell })
  } catch (err) {
    return failedChild(err)
  }
}
