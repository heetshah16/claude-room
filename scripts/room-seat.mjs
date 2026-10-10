#!/usr/bin/env node
/**
 * Local seat launcher.
 *
 * Starts real Claude Code as one seat in the room, isolated by its own
 * `CLAUDE_CONFIG_DIR`. That isolation is the entire reason this design is
 * legitimate: nothing here reads, copies, forwards, or stores anyone's
 * credentials. The person whose seat this is logs in themselves, on first
 * run, in their own config directory — this script only ever sets the
 * directory Claude Code will use, never a token inside it.
 *
 * Each local seat also gets its own `git worktree`. The room serialises
 * turns *within one session*; it cannot serialise two independent Claude
 * Code sessions writing to the same checkout. Without separate worktrees,
 * two seats editing the same files would silently clobber each other.
 *
 *   room-seat <handle> --token <token> [--config-dir <dir>] [--repo <path>] [--room <url>]
 *
 * <token> comes from `room-admin seat add <name> --owner <member>`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnPortable } from '../src/spawn.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The room-seat mod (mod/), loaded straight from this checkout. It joins the
// room, runs room turns and serves room_reply from inside the session, which
// is what lets a seat run without --dangerously-load-development-channels.
export const MOD_DIR = join(__dirname, '..', 'mod')

const MOD_FLOOR = [2, 1, 287] // mods load from Claude Code 2.1.287

/** Whether `claude --version` output is a version that loads mods. */
export function meetsModFloor(versionText) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionText))
  if (!m) return false
  const v = m.slice(1).map(Number)
  for (let i = 0; i < 3; i++) if (v[i] !== MOD_FLOOR[i]) return v[i] > MOD_FLOOR[i]
  return true
}

/** Every local seat lives in its own worktree so two agents can never clobber one checkout. */
export function worktreeFor(repo, handle) {
  const safe = String(handle).replace(/^@/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return join(repo, '.worktrees', safe)
}

/**
 * Builds the spawn recipe for one seat: real `claude`, pointed at its own
 * config dir and its own worktree, with the room-seat mod loaded from this
 * checkout. Pure and injection-testable — nothing
 * here touches the filesystem or a child process.
 *
 * Deliberately never sets ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: doing so
 * would let this script authenticate the session instead of the person, which
 * is exactly the shortcut this whole design exists to avoid.
 */
export function seatArgs({ configDir, roomUrl, token, handle, repo }) {
  const worktree = worktreeFor(repo, handle)

  // Start from the operator's own environment (PATH, HOME, etc. — claude
  // needs those to run at all), then strip any credential that might be set
  // ambiently so this script can never be the thing that supplies one.
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  return {
    cmd: 'claude',
    args: [
      '--plugin-dir', MOD_DIR,
      // The seat's only way to answer the room; it posts nowhere else.
      '--allowedTools', 'mcp__room-seat__room_reply',
      '--add-dir', worktree,
    ],
    // The mod joins at once when it finds these three.
    env: {
      ...env,
      CLAUDE_CONFIG_DIR: configDir,
      ROOM_URL: roomUrl,
      ROOM_SEAT_TOKEN: token,
      ROOM_SEAT_HANDLE: handle,
    },
    cwd: worktree,
  }
}

/**
 * `claude --version`'s output, or '' when claude is not on PATH — and also ''
 * when it has not finished after 10s, so a wedged probe kills its child and
 * lets main() die with its usual version message instead of hanging forever.
 */
function claudeVersion() {
  return new Promise(done => {
    let out = ''
    const child = spawnPortable('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const settle = text => {
      clearTimeout(timer)
      done(text) // a settled promise ignores every later call
    }
    const timer = setTimeout(() => {
      child.kill()
      settle('')
    }, 10_000)
    child.stdout.on('data', d => { out += d })
    child.on('close', () => settle(out)) // not 'exit': stdout may still be draining
    child.on('error', () => settle(''))
  })
}

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

/** Creates the worktree on first run; reuses it on every run after. */
function ensureWorktree(repo, handle) {
  const dir = worktreeFor(repo, handle)
  if (!existsSync(dir)) {
    execFileSync('git', ['worktree', 'add', dir], { cwd: repo, stdio: 'inherit' })
  }
  return dir
}

async function main() {
  const argv = process.argv.slice(2)
  const handle = argv[0]
  if (!handle || handle.startsWith('-')) {
    die('usage: room-seat <handle> --token <token> [--config-dir <dir>] [--repo <path>] [--room <url>]')
  }
  const flag = name => {
    const i = argv.indexOf(name)
    return i === -1 ? null : argv[i + 1]
  }

  const token = flag('--token') || process.env.ROOM_SEAT_TOKEN
  if (!token) die('no seat token. Pass --token <token> (from `room-admin seat add`).')

  const repo = resolve(flag('--repo') || process.cwd())
  const configDir = resolve(flag('--config-dir') || join(homedir(), '.claude-rooms', handle))
  const roomUrl = flag('--room') || process.env.ROOM_URL || 'http://127.0.0.1:8787'

  const version = await claudeVersion()
  if (!meetsModFloor(version)) {
    die(`a room seat needs Claude Code 2.1.287 or later, where mods load (found: ${version.trim() || 'no claude on PATH'}). Run: claude update`)
  }

  const worktree = ensureWorktree(repo, handle)
  mkdirSync(configDir, { recursive: true })

  const { cmd, args, env } = seatArgs({ configDir, roomUrl, token, handle, repo })

  console.error(`launching seat "${handle}" — config: ${configDir}  worktree: ${worktree}`)
  console.error('first run will prompt /login for this seat\'s own account.')

  // spawnPortable rather than a bare spawn: on a machine where `claude` is an
  // npm .cmd shim, a bare spawn fails ENOENT.
  // stdio: 'inherit' so the first run's /login prompt shows up right here,
  // in the operator's own terminal, for this seat's own account.
  const child = spawnPortable(cmd, args, { cwd: worktree, env, stdio: 'inherit' })
  child.on('exit', code => process.exit(code ?? 0))
  child.on('error', err => die(`failed to launch claude: ${err.message}`))
}

// Only run the CLI when invoked directly; importing seatArgs/worktreeFor for
// tests must never spawn anything.
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
