// extension/src/room-client.js
'use strict'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * The room, launched standalone under the extension's control.
 *
 * Deliberately NOT spawned as Claude Code's MCP child, which is how the CLI
 * runs it: that inverts control, leaving the extension unable to choose the
 * port, watch the health, or restart the room independently.
 */
/**
 * The bind address that publishes the room.
 *
 * Verified against a real standalone room on 2026-09-08: restarting with this
 * host on the SAME port and state dir keeps the owner token, keeps the roster,
 * and keeps http://127.0.0.1:<port> serving -- so the orchestrator's MCP
 * bridge never notices the restart and the chat is not torn down. Only the
 * advertised address in a join link changes.
 */
const PUBLISHED_HOST = '0.0.0.0'

function roomRecipe({ repoRoot, stateDir, port, host = '127.0.0.1', advertise, nodePath = process.execPath, env = process.env }) {
  return {
    cmd: nodePath,
    args: [join(repoRoot, 'src', 'server.mjs')],
    opts: {
      cwd: repoRoot,
      env: {
        ...env,
        ROOM_STANDALONE: '1',
        ROOM_PORT: String(port),
        ROOM_HOST: host,
        ROOM_STATE_DIR: stateDir,
        // Only set when publishing via a tunnel -- omitted entirely (not set to
        // undefined) so the room's own advertiseHost() autodetection still runs
        // for the plain-LAN/Tailscale case, unchanged from before this task.
        ...(advertise ? { ROOM_ADVERTISE: advertise } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  }
}

/**
 * The owner's token, from the room's own persisted roster.
 *
 * Verified against a real standalone room (2026-09-05): `members.json` is a
 * top-level array of `{ id, name, role, canApprove, muted, token }`, not
 * `{ members: [...] }`. Both shapes are handled below; the array branch is
 * the one that actually fires.
 */
function readOwnerToken(stateDir, { readFile = p => readFileSync(p, 'utf8') } = {}) {
  try {
    const raw = readFile(join(stateDir, 'members.json'))
    const parsed = JSON.parse(raw)
    const members = Array.isArray(parsed) ? parsed : (parsed.members ?? [])
    return members.find(m => m.role === 'owner')?.token ?? null
  } catch {
    return null // absent on first boot; the caller retries
  }
}

function createRoomClient({ roomUrl, token, fetchImpl = fetch }) {
  const q = `token=${encodeURIComponent(token)}`

  async function post(path, body) {
    try {
      const res = await fetchImpl(`${roomUrl}${path}?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!res.ok) return { ok: false, errors: [`${path} failed: HTTP ${res.status}`] }
      return await res.json()
    } catch (err) {
      return { ok: false, errors: [String(err?.message ?? err)] }
    }
  }

  /** GET returning parsed JSON, or null on any failure. */
  async function get(path) {
    try {
      const res = await fetchImpl(`${roomUrl}${path}?${q}`)
      return res.ok ? await res.json() : null
    } catch {
      return null
    }
  }

  return {
    async state() {
      try {
        const res = await fetchImpl(`${roomUrl}/api/state?${q}`)
        return res.ok ? await res.json() : null
      } catch { return null }
    },
    // The room's verdict travels verbatim: it names the missing spec field,
    // and paraphrasing it would leave the orchestrator unable to repair the brief.
    delegate: input => post('/api/delegate', input),

    /**
     * Address a seat directly, as a person in the room.
     *
     * Goes through /msg, the room's normal path, which means it QUEUES: the
     * room runs one turn per destination and Queue.submit gates a seat on
     * being online, never on being idle. So this lands after whatever the seat
     * is already doing -- which the detail view says before you send, not
     * after.
     */
    say: (handle, text) => post('/msg', { text: `@${handle} ${text}` }),

    // --- admin (owner-only) ---
    //
    // adminState returns null rather than an empty roster when the call fails:
    // a member list that renders as "nobody is here" because the room was
    // briefly restarting is worse than one that does not render at all.
    adminState: () => get('/api/admin/state'),
    invite: ({ name, role }) => post('/api/admin/invite', { name, role }),
    rotate: memberId => post('/api/admin/rotate', { memberId }),
    remove: memberId => post('/api/admin/remove', { memberId }),

    // --- worker provisioning (owner-only) ---
    //
    // The room owns worker processes now: it mints the seat, allocates the
    // handle and spawns `scripts/room-opencode-seat.mjs` under its own
    // supervisor. The extension asks. One implementation of "spawn a worker"
    // serves channel-mode sessions and this extension alike, which is what
    // keeps the extension working standalone with no channel session.
    //
    // `model` is omitted when unset so the room's own default wins; sending
    // null would silently pin whatever the extension believed the default was.
    spawnWorker: ({ model = null } = {}) => post('/api/spawn-worker', model ? { model } : {}),
    stopWorker: handle => post('/api/stop-worker', { handle }),

    roomUrl,
    token,
  }
}

module.exports = { roomRecipe, readOwnerToken, createRoomClient, PUBLISHED_HOST }
