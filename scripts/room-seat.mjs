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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HOOK_EVENTS } from '../src/state.mjs'
import { fileURLToPath } from 'node:url'
import { spawnPortable } from '../src/spawn.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The MCP stdio server every seat loads to bridge the room's SSE feed into
// this session's channel notifications (see src/seat.mjs). Custom channels
// are not on Anthropic's approved allowlist, hence --dangerously-load-development-channels below.
const SEAT_BRIDGE = join(__dirname, '..', 'src', 'seat.mjs')

/** Every local seat lives in its own worktree so two agents can never clobber one checkout. */
export function worktreeFor(repo, handle) {
  const safe = String(handle).replace(/^@/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return join(repo, '.worktrees', safe)
}

/**
 * The hooks settings a seat runs with, pointed at its own /seat/hook/* routes
 * and carrying its own seat token.
 *
 * Without this a seat has NO hooks at all: its CLAUDE_CONFIG_DIR is fresh, so
 * there is no settings.json in it, and nothing else supplies one. That meant
 * Stop never fired, so `queue.endTurn` was never called for the seat's
 * destination — the seat answered exactly one message and then stayed busy
 * forever, with every later message queued behind it and never drained. Tests
 * missed it because they post /seat/hook/Stop by hand, which is precisely the
 * thing production never did.
 */
export function seatHookSettings({ roomUrl, token }) {
  const hooks = {}
  for (const [event, timeout] of Object.entries(HOOK_EVENTS)) {
    const url = `${roomUrl}/seat/hook/${event}?token=${encodeURIComponent(token)}`
    hooks[event] = [{ hooks: [{ type: 'http', url, timeout }] }]
  }
  return { hooks }
}

/**
 * The MCP config body a seat loads. Extracted so the launcher can write it to
 * a file: passing it as JSON on argv cannot survive a Windows shell, and a
 * shell is exactly what an npm-installed `claude` needs.
 */
export function mcpConfigFor() {
  return { mcpServers: { seat: { command: 'node', args: [SEAT_BRIDGE] } } }
}

/**
 * Builds the spawn recipe for one seat: real `claude`, pointed at its own
 * config dir and its own worktree, with the seat bridge loaded as an MCP
 * server and its own hooks settings. Pure and injection-testable — nothing
 * here touches the filesystem or a child process.
 *
 * Deliberately never sets ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: doing so
 * would let this script authenticate the session instead of the person, which
 * is exactly the shortcut this whole design exists to avoid.
 */
export function seatArgs({ configDir, roomUrl, token, handle, repo, settingsPath, mcpConfigPath }) {
  const worktree = worktreeFor(repo, handle)
  const configPath = mcpConfigPath || join(configDir, 'mcp.seat.json')

  // Start from the operator's own environment (PATH, HOME, etc. — claude
  // needs those to run at all), then strip any credential that might be set
  // ambiently so this script can never be the thing that supplies one.
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  return {
    cmd: 'claude',
    args: [
      '--dangerously-load-development-channels',
      '--mcp-config', configPath,
      // Without --settings the seat fires no hooks, so its turns never close
      // and its destination wedges after the first message.
      '--settings', settingsPath,
      '--add-dir', worktree,
    ],
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

  const worktree = ensureWorktree(repo, handle)

  // The seat's hooks live beside its credentials, in its own config dir, so
  // two seats on one machine never share a settings file — and so the seat
  // token in it is no more exposed than the login already in that directory.
  mkdirSync(configDir, { recursive: true })
  const settingsPath = join(configDir, 'settings.hooks.json')
  writeFileSync(settingsPath, JSON.stringify(seatHookSettings({ roomUrl, token }), null, 2))

  const mcpConfigPath = join(configDir, 'mcp.seat.json')
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigFor(), null, 2))

  const { cmd, args, env } = seatArgs({
    configDir, roomUrl, token, handle, repo, settingsPath, mcpConfigPath,
  })

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
