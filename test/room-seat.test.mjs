import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seatArgs, worktreeFor, meetsModFloor, ensureWorktree, MOD_DIR } from '../scripts/room-seat.mjs'

/** A real repo with one commit: `git worktree add` needs a HEAD to branch from. */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'roomseat-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return { dir, git }
}

test("a worker's worktree never shows up as untracked in the user's repo", t => {
  const { dir, git } = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // No info/ at all: a repo made by a tool that skipped the templates.
  rmSync(join(dir, '.git', 'info'), { recursive: true, force: true })
  ensureWorktree(dir, 'worker-1')
  ensureWorktree(dir, 'worker-2')
  assert.ok(existsSync(join(dir, '.worktrees', 'worker-1')))
  assert.equal(git('status', '--porcelain'), '')
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split(/\r?\n/).filter(l => l === '.worktrees/').length, 1, 'appended once, not per worker')
  assert.ok(!existsSync(join(dir, '.gitignore')), "the user's tracked .gitignore is never touched")
})

test('the exclude line is appended after existing entries, never over them', t => {
  const { dir } = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, '.git', 'info', 'exclude')
  writeFileSync(file, '*.log') // no trailing newline: the append must add one
  ensureWorktree(dir, 'worker-1')
  assert.deepEqual(readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean), ['*.log', '.worktrees/'])
})

const base = { configDir: '/cfg/ana', roomUrl: 'http://127.0.0.1:8787', token: 'tok', handle: 'ana-agent', repo: '/repo' }

test('a seat launches real Claude Code against its own config dir, with the room in its environment', () => {
  const { cmd, env } = seatArgs(base)
  assert.equal(cmd, 'claude')
  // The isolation that makes this work at all: a separate credential store per
  // seat, so each session performs its own login.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg/ana')
  assert.equal(env.ROOM_URL, 'http://127.0.0.1:8787')
  assert.equal(env.ROOM_SEAT_TOKEN, 'tok')
  assert.equal(env.ROOM_SEAT_HANDLE, 'ana-agent')
})

test('the seat loads the room-seat mod, and no development channel', () => {
  const { args } = seatArgs(base)
  assert.ok(!args.some(a => /dangerously/.test(a)), 'a mod needs no development-channels flag')
  assert.equal(args[args.indexOf('--plugin-dir') + 1], MOD_DIR)
  assert.ok(!args.includes('--mcp-config'))
  assert.ok(!args.includes('--settings'), 'the mod forwards the hooks; no settings file')
})

test("the plugin dir is the repo's own mod/", () => {
  assert.ok(existsSync(join(MOD_DIR, '.claude-plugin', 'plugin.json')))
})

test("room_reply is pre-approved: it is the seat's only way to answer, and posts only to the room", () => {
  const { args } = seatArgs(base)
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__room-seat__room_reply')
})

test('no credential is ever passed on the command line', () => {
  const { args, env } = seatArgs(base)
  assert.ok(!args.join(' ').includes('tok'), 'the seat token travels in the env, never argv')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
})

test('each local seat gets its own worktree so two agents cannot clobber one checkout', () => {
  const a = worktreeFor('/repo', 'ana-agent')
  const b = worktreeFor('/repo', 'heet-agent')
  assert.notEqual(a, b)
  assert.match(a, /ana-agent/)
  const { args, cwd } = seatArgs(base)
  assert.equal(cwd, a)
  assert.ok(args.includes(a), 'seat must run in its own worktree')
})

test('a seat needs Claude Code 2.1.287 or later, where mods load', () => {
  assert.equal(meetsModFloor('2.1.287 (Claude Code)'), true)
  assert.equal(meetsModFloor('2.1.290 (Claude Code)'), true)
  assert.equal(meetsModFloor('2.2.0'), true)
  assert.equal(meetsModFloor('10.0.0'), true)
  assert.equal(meetsModFloor('2.1.286 (Claude Code)'), false)
  assert.equal(meetsModFloor('2.0.999'), false)
  assert.equal(meetsModFloor(''), false)
  assert.equal(meetsModFloor('not a version'), false)
})
