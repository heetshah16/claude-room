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
function roomRecipe({ repoRoot, stateDir, port, nodePath = process.execPath, env = process.env }) {
  return {
    cmd: nodePath,
    args: [join(repoRoot, 'src', 'server.mjs')],
    opts: {
      cwd: repoRoot,
      env: {
        ...env,
        ROOM_STANDALONE: '1',
        ROOM_PORT: String(port),
        ROOM_HOST: '127.0.0.1',
        ROOM_STATE_DIR: stateDir,
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
    roomUrl,
    token,
  }
}

module.exports = { roomRecipe, readOwnerToken, createRoomClient }
