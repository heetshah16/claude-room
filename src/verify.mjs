/**
 * Running a delegation's own verification command, room-side.
 *
 * `validateDelegation` validates a brief before work starts. This applies the
 * same "validated, not trusted" rule to what comes back: when a worker says it
 * is done, the room runs the `spec.tests` the ORCHESTRATOR wrote and lets the
 * real exit code decide. The command was authored upstream, not by the worker,
 * so this is not a new trust boundary — it is the room re-running something it
 * already had standing authority to have run, instead of believing a
 * self-report.
 *
 * Nothing here reads a global: `spawn` and `killTree` are parameters, which is
 * what lets the whole module be tested without launching a process.
 */
import { spawnPortable } from './spawn.mjs'
import { defaultKillTree } from './supervisor.mjs'

/** How much of a test run's output travels back. Bytes, not code units. */
export const MAX_OUTPUT = 2048

/** Verification's own deadline (spec §2.4), independent of a worker's turn. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000

/**
 * Split one command line into a program and its arguments.
 *
 * Deliberately NOT a shell. `&&`, `|`, `>`, globs and `$VAR` are not special
 * here and are passed through as literal argv — a `spec.tests` entry using one
 * will fail rather than being quietly reinterpreted. `spec.tests` is an array,
 * so "run two things" is two entries, which is also the shape that lets the
 * run stop at the first failure.
 *
 * Quotes group, and are removed. `""` is a real empty argument, which is why
 * the tokenizer tracks "a token was started" separately from "it has
 * characters in it".
 */
export function splitCommand(line) {
  const out = []
  let cur = ''
  let started = false
  let quote = null
  const push = () => {
    if (started) out.push(cur)
    cur = ''
    started = false
  }
  for (const ch of String(line ?? '')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push()
      continue
    }
    cur += ch
    started = true
  }
  push()
  return out
}

/**
 * The last `max` BYTES of a string.
 *
 * `String.slice(-n)` counts UTF-16 code units, so a suite printing CJK or
 * emoji would blow a byte budget silently. A cut can land mid-character; all
 * leading replacement characters produced by the boundary cut are stripped
 * rather than shipped, preserving genuine tail content.
 */
export function truncateTail(s, max = MAX_OUTPUT) {
  const str = String(s ?? '')
  const buf = Buffer.from(str, 'utf8')
  if (buf.length <= max) return str
  return buf.subarray(buf.length - max).toString('utf8').replace(/^�+/, '')
}

/** One command. Resolves with how it went; never rejects. */
function runOne(command, { cwd, timeoutMs, spawn, killTree }) {
  return new Promise(resolve => {
    const [name, ...args] = splitCommand(command)
    if (!name) {
      resolve({ exitCode: null, output: `not a command: ${command}`, timedOut: false, failed: true })
      return
    }

    const child = spawn(name, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    // Capped as it arrives so a runaway command cannot grow this without
    // limit; a code-unit cap always keeps at least MAX_OUTPUT bytes, which
    // truncateTail then trims to exactly that.
    let output = ''
    let timedOut = false
    let settled = false
    const add = d => { output = (output + d).slice(-MAX_OUTPUT) }

    const finish = exitCode => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, output, timedOut, failed: timedOut || exitCode !== 0 })
    }

    const timer = setTimeout(() => {
      timedOut = true
      // The tree, not the process: a test command is routinely a shim that
      // starts the thing doing the actual work.
      killTree(child.pid)
      finish(null)
    }, timeoutMs)
    // A verification timer is not a reason to keep the room alive.
    timer.unref?.()

    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    child.on('error', err => {
      add(String(err?.message ?? err))
      finish(null)
    })
    child.on('exit', code => finish(code))
  })
}

/**
 * Run a delegation's `spec.tests` in the worker's worktree.
 *
 * Sequential, stopping at the first failure. `ran:false, ok:null` when there is
 * nothing to run — "unchecked" is a third answer, and collapsing it into
 * `ok:false` would report a reasoning task as broken.
 *
 * @param {{tests?:string[], cwd:string, timeoutMs?:number, spawn?:Function, killTree?:Function}} opts
 * @returns {Promise<{ran:boolean, ok:boolean|null, exitCode:number|null, output:string, timedOut:boolean}>}
 */
export async function verifyDelegation({
  tests,
  cwd,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  spawn = spawnPortable,
  killTree = defaultKillTree,
}) {
  const list = (Array.isArray(tests) ? tests : [])
    .map(t => String(t ?? '').trim())
    .filter(Boolean)
  if (!list.length) return { ran: false, ok: null, exitCode: null, output: '', timedOut: false }

  let last = null
  for (const command of list) {
    last = await runOne(command, { cwd, timeoutMs, spawn, killTree })
    if (last.failed) break
  }
  return {
    ran: true,
    ok: !last.failed,
    exitCode: last.exitCode,
    output: truncateTail(last.output),
    timedOut: last.timedOut,
  }
}
