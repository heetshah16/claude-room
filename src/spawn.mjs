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
 * The characters `cmd.exe` parses rather than passes on, when it meets them
 * outside a quoted region. `%` is here because a bare `%NAME%` is expanded.
 */
const CMD_META = /[&|<>^()%]/

/**
 * Quote one argument for a command line handed to `cmd.exe /d /s /c "…"`.
 *
 * Two escaping systems apply at once, in this order:
 *
 *  1. `cmd.exe` reads the line first. Outside a quoted region it acts on
 *     `& | < > ^ ( ) %`, so those are escaped with `^`. INSIDE a quoted
 *     region a caret is not an escape — it is passed through as a literal
 *     character — so the quote state is tracked as the output is built and
 *     the escape is only emitted where it actually escapes.
 *  2. Whatever cmd hands on is parsed again by the target's own argv
 *     splitter, under the Windows rules: a run of backslashes is literal
 *     unless it precedes a double quote, where n backslashes become 2n, and
 *     an embedded quote is escaped as `\"`.
 *
 * An argument is wrapped in double quotes when it contains a space, a tab or
 * a quote — and when it is empty, which would otherwise vanish entirely.
 */
export function quoteForCmd(arg) {
  const s = String(arg)
  const wrap = s === '' || /[ \t"]/.test(s)

  let inQuotes = false
  let out = ''
  const emitQuote = () => {
    out += '"'
    inQuotes = !inQuotes
  }

  if (wrap) emitQuote()
  let slashes = 0
  for (const ch of s) {
    if (ch === '\\') {
      slashes++
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1)
      slashes = 0
      emitQuote()
      continue
    }
    out += '\\'.repeat(slashes)
    slashes = 0
    out += !inQuotes && CMD_META.test(ch) ? `^${ch}` : ch
  }
  // A trailing run of backslashes would otherwise escape our own closing
  // quote and swallow it, gluing this argument to the next one.
  out += '\\'.repeat(wrap ? slashes * 2 : slashes)
  if (wrap) emitQuote()
  return out
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
    // A real executable is spawned directly, with no shell anywhere near it.
    if (!found.needsShell) return spawnImpl(found.path, args, { ...opts, shell: false })

    // Node's shell:true joins argv with plain spaces and quotes nothing, so
    // any argument containing a space is silently split — and both seat
    // launchers pass paths derived from homedir() and cwd(), which routinely
    // contain spaces. Drive cmd.exe ourselves with windowsVerbatimArguments
    // so our own quoting survives intact instead of being re-quoted away.
    const env = opts.env ?? resolveOpts.env ?? process.env
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe'
    const quoted = [found.path, ...args].map(quoteForCmd).join(' ')
    return spawnImpl(comspec, ['/d', '/s', '/c', `"${quoted}"`], {
      ...opts, windowsVerbatimArguments: true, shell: false,
    })
  } catch (err) {
    return failedChild(err)
  }
}
