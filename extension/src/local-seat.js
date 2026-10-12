// extension/src/local-seat.js
//
// Gives Claude Code in the open folder its own seat in the room, and writes
// <folder>/.claude/room-seat.local.json so the room-seat plugin can join with
// no copy-paste. Never throws: a seat that cannot be made must not stop the room.
'use strict'
const nodeFs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const SEAT_FILE = path.join('.claude', 'room-seat.local.json')
// `**/` so it matches when the open folder is a subfolder of the git toplevel.
const EXCLUDE_LINE = '**/.claude/room-seat.local.json'
// Every git call here: a repository's own config must not run commands (git
// ls-files runs core.fsmonitor; command-line -c outranks repo config), and a
// hung git must not hold the room start. A timeout is an error: fails closed.
const GIT_SAFE = ['-c', 'core.fsmonitor=false']
const GIT_TIMEOUT_MS = 10_000

/** `Admin` -> `admin-claude`: lowercase [a-z0-9-], dashes collapsed. */
function seatHandle(username) {
  const base = String(username ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${base || 'user'}-claude`
}

// CommonJS copy of scripts/room-seat.mjs excludeWorktrees (ESM, room side; the
// extension must not import it). Returns false for a non-git folder.
function defaultGit(repo) {
  try {
    const common = execFileSync('git', [...GIT_SAFE, 'rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).trim()
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
}

const defaultRunGit = (repo, args) => spawnSync('git', args, { cwd: repo, stdio: 'ignore', timeout: GIT_TIMEOUT_MS })

// A `.git` dir or file (a worktree's) in repo or any folder above it.
function insideRepo(repo, fs) {
  for (let dir = path.resolve(repo); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true
    if (path.dirname(dir) === dir) return false
  }
}

// 'tracked', 'untracked', or 'unknown'. Fails closed: git missing or failing
// (exit 128 covers "not a repository" but also e.g. safe.directory refusals)
// counts as untracked only when no `.git` is anywhere up the tree.
function trackedState(repo, rel, runGit, fs) {
  const r = runGit(repo, [...GIT_SAFE, 'ls-files', '--error-unmatch', rel])
  if (!r?.error && r?.status === 0) return 'tracked'
  if (!r?.error && r?.status === 1) return 'untracked'
  return insideRepo(repo, fs) ? 'unknown' : 'untracked'
}

// The seat's real token, from the room's own persisted roster (same file and
// shapes as room-client.js readOwnerToken), rather than parsing it out of the
// joinUrl that adminState() carries for each member.
function rosterToken(stateDir, id, fs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'members.json'), 'utf8'))
    const members = Array.isArray(parsed) ? parsed : (parsed.members ?? [])
    return members.find(m => m.id === id)?.token ?? null
  } catch { return null }
}

async function ensureLocalSeat({ client, workRepo, roomUrl, username, stateDir, fs = nodeFs, git = defaultGit, runGit = defaultRunGit }) {
  if (!workRepo) return { ok: false, reason: 'no folder open' }
  try {
    const tracked = trackedState(workRepo, SEAT_FILE.split(path.sep).join('/'), runGit, fs)
    if (tracked === 'tracked') {
      return { ok: false, reason: '.claude/room-seat.local.json is tracked by git; not writing a seat token into it' }
    }
    if (tracked === 'unknown') {
      return { ok: false, reason: 'could not check whether .claude/room-seat.local.json is tracked by git (is git on PATH?); not writing a seat token' }
    }
    const handle = seatHandle(username)
    const state = await client.adminState()
    if (!state?.members) return { ok: false, reason: 'could not read the room roster' }
    const owner = state.members.find(m => m.role === 'owner')
    if (!owner) return { ok: false, reason: 'the room has no owner' }

    const file = path.join(workRepo, SEAT_FILE)
    const existing = state.members.find(m => m.kind === 'agent' && m.handle === handle)
    let token

    if (existing) {
      if (existing.ownerId !== owner.id) return { ok: false, reason: `the seat ${handle} belongs to someone else` }
      // Always from the roster, so a rotated token or a lost file is repaired.
      token = rosterToken(stateDir, existing.id, fs)
      if (!token) return { ok: false, reason: `could not read the token for ${handle} from the room's roster` }
    } else {
      const r = await client.addSeat({ handle, ownerId: owner.id })
      if (!r?.ok || !r.token) return { ok: false, reason: r?.errors?.[0] ?? r?.reason ?? 'the room refused the seat' }
      token = r.token
    }

    const saved = readSeatFile(file, fs)
    if (saved?.room_url !== roomUrl || saved?.seat_handle !== handle || saved?.seat_token !== token) {
      writeSeatFile(file, JSON.stringify({ room_url: roomUrl, seat_handle: handle, seat_token: token }, null, 2) + '\n', fs)
    }
    // Every run, written or not: tightens an older, looser file. Best effort.
    try { fs.chmodSync(file, 0o600) } catch { /* Windows largely ignores mode bits */ }
    // Idempotent; retried every run in case an earlier exclude failed.
    try { excludeSeatFile(workRepo, fs, git) } catch { /* hiding the file is a courtesy */ }
    return { ok: true, handle, file }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
}

module.exports = { seatHandle, ensureLocalSeat }
