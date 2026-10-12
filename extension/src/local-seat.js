// extension/src/local-seat.js
//
// Gives Claude Code in the open folder its own seat in the room, and writes
// <folder>/.claude/room-seat.local.json so the room-seat plugin can join with
// no copy-paste. Never throws: a seat that cannot be made must not stop the room.
'use strict'
const nodeFs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const SEAT_FILE = path.join('.claude', 'room-seat.local.json')
// `**/` so it matches when the open folder is a subfolder of the git toplevel.
const EXCLUDE_LINE = '**/.claude/room-seat.local.json'

/** `Admin` -> `admin-claude`: lowercase [a-z0-9-], dashes collapsed. */
function seatHandle(username) {
  const base = String(username ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${base || 'user'}-claude`
}

// CommonJS copy of scripts/room-seat.mjs excludeWorktrees (ESM, room side; the
// extension must not import it). Returns false for a non-git folder.
function defaultGit(repo) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return path.resolve(repo, common)
  } catch { return null }
}

function excludeSeatFile(repo, fs, git) {
  const gitDir = git(repo)
  if (!gitDir) return
  const file = path.join(gitDir, 'info', 'exclude')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (text.split(/\r?\n/).some(l => l.trim() === EXCLUDE_LINE)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`)
}

function readSeatFile(file, fs) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

// Owner-only and atomic: the file holds a seat token, and a reader must never
// see a half-written one. Windows largely ignores the mode bits; harmless there.
function writeSeatFile(file, text, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw err
  }
  try { fs.chmodSync(file, 0o600) } catch { /* best effort: tightens an older, looser file */ }
}

async function ensureLocalSeat({ client, workRepo, roomUrl, username, fs = nodeFs, git = defaultGit }) {
  if (!workRepo) return { ok: false, reason: 'no folder open' }
  try {
    const handle = seatHandle(username)
    const state = await client.adminState()
    if (!state?.members) return { ok: false, reason: 'could not read the room roster' }
    const owner = state.members.find(m => m.role === 'owner')
    if (!owner) return { ok: false, reason: 'the room has no owner' }

    const file = path.join(workRepo, SEAT_FILE)
    const existing = state.members.find(m => m.kind === 'agent' && m.handle === handle)
    const saved = readSeatFile(file, fs)
    let token

    if (existing && saved?.seat_handle === handle && saved.seat_token) {
      // The roster never exposes tokens, so a file naming a live seat is trusted.
      if (saved.room_url === roomUrl) {
        // Idempotent; retried here in case the first run's exclude failed.
        try { excludeSeatFile(workRepo, fs, git) } catch { /* a courtesy */ }
        return { ok: true, handle, file }
      }
      token = saved.seat_token
    } else {
      // No seat: mint one. A seat without a usable file: rotate for a fresh
      // token rather than a duplicate seat.
      const r = existing
        ? await client.rotate(existing.id)
        : await client.addSeat({ handle, ownerId: owner.id })
      if (!r?.ok || !r.token) return { ok: false, reason: r?.errors?.[0] ?? r?.reason ?? 'the room refused the seat' }
      token = r.token
    }

    writeSeatFile(file, JSON.stringify({ room_url: roomUrl, seat_handle: handle, seat_token: token }, null, 2) + '\n', fs)
    try { excludeSeatFile(workRepo, fs, git) } catch { /* hiding the file is a courtesy */ }
    return { ok: true, handle, file }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
}

module.exports = { seatHandle, ensureLocalSeat }
