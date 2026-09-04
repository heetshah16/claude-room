#!/usr/bin/env node
/**
 * OpenCode seat launcher — the peer of scripts/room-seat.mjs.
 *
 * Starts `opencode serve` bound to loopback in this seat's own worktree,
 * registers src/seat.mjs with it in reply-only mode so OpenCode can reach
 * room_reply, and runs the driver that translates between the two.
 *
 *   room-opencode-seat <handle> --token <token> [--repo <path>]
 *                      [--room <url>] [--model provider/model]
 *                      [--attach <url>] [--timeout <ms>]
 *
 * Unlike a Claude seat there is no credential to isolate — OpenCode's free
 * models need none — so the isolation that matters here is the worktree:
 * two agents writing one checkout silently clobber each other.
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnPortable } from '../src/spawn.mjs'
import { createOpenCodeSeat, opencodeSeatArgs, DEFAULT_MODEL, DEFAULT_TURN_TIMEOUT_MS } from '../src/opencode.mjs'
import { worktreeFor } from './room-seat.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEAT_BRIDGE = join(__dirname, '..', 'src', 'seat.mjs')

const log = s => process.stderr.write(`opencode-seat: ${s}\n`)
const die = msg => { log(msg); process.exit(1) }

/** Ask the OS for a free port, then release it. Two seats must never collide. */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

function ensureWorktree(repo, handle) {
  const dir = worktreeFor(repo, handle)
  if (!existsSync(dir)) execFileSync('git', ['worktree', 'add', dir], { cwd: repo, stdio: 'inherit' })
  return dir
}

/** Wait for `opencode serve` to answer, rather than racing it. */
async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/config`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

async function main() {
  const argv = process.argv.slice(2)
  const handle = argv[0]
  if (!handle || handle.startsWith('-')) {
    die('usage: room-opencode-seat <handle> --token <token> [--repo <path>] [--room <url>] [--model provider/model] [--attach <url>] [--timeout <ms>]')
  }
  const flag = name => {
    const i = argv.indexOf(name)
    return i === -1 ? null : argv[i + 1]
  }

  const token = flag('--token') || process.env.ROOM_SEAT_TOKEN
  if (!token) die('no seat token. Pass --token <token> (from `room-admin seat add`).')

  const repo = resolve(flag('--repo') || process.cwd())
  const roomUrl = flag('--room') || process.env.ROOM_URL || 'http://127.0.0.1:8787'
  const model = flag('--model') || process.env.ROOM_OPENCODE_MODEL || DEFAULT_MODEL
  const turnTimeoutMs = Number(flag('--timeout') || process.env.ROOM_OPENCODE_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS)
  const attach = flag('--attach')

  const worktree = ensureWorktree(repo, handle)

  let child = null
  let opencodeUrl = attach
  if (!attach) {
    const port = await freePort()
    opencodeUrl = `http://127.0.0.1:${port}`
    const { cmd, args, env, cwd } = opencodeSeatArgs({ port, cwd: worktree })
    log(`starting opencode serve on ${opencodeUrl} in ${cwd}`)
    child = spawnPortable(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', err => die(`failed to launch opencode: ${err.message}`))
    if (!(await waitForServer(opencodeUrl))) die(`opencode did not answer on ${opencodeUrl}`)
  }

  const seat = createOpenCodeSeat({
    roomUrl, token, handle, opencodeUrl, model, turnTimeoutMs, log,
  })
  await seat.connect({ bridgePath: SEAT_BRIDGE })
  log(`"${handle}" connected to ${roomUrl} using ${model}`)

  const shutdown = () => {
    seat.stop()
    child?.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
