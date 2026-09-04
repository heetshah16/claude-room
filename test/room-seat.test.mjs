import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seatArgs, worktreeFor, mcpConfigFor } from '../scripts/room-seat.mjs'

test('a seat launches real Claude Code against its own config dir', () => {
  const { cmd, args, env } = seatArgs({
    configDir: '/cfg/ana', roomUrl: 'http://127.0.0.1:8787',
    token: 'tok', handle: 'ana-agent', repo: '/repo',
  })
  assert.equal(cmd, 'claude')
  // The isolation that makes this work at all: a separate credential store per
  // seat, so each session performs its own login.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg/ana')
  assert.equal(env.ROOM_URL, 'http://127.0.0.1:8787')
  assert.equal(env.ROOM_SEAT_TOKEN, 'tok')
  assert.equal(env.ROOM_SEAT_HANDLE, 'ana-agent')
})

test('the seat loads the bridge as a development channel', () => {
  const { args } = seatArgs({ configDir: '/c', roomUrl: 'u', token: 't', handle: 'h', repo: '/r' })
  assert.ok(args.includes('--dangerously-load-development-channels'))
  assert.ok(args.some(a => a.includes('seat')))
})

test('no credential is ever passed on the command line or in the env', () => {
  const { args, env } = seatArgs({
    configDir: '/c', roomUrl: 'u', token: 't', handle: 'h', repo: '/r',
  })
  const blob = JSON.stringify({ args, env })
  assert.ok(!/sk-ant/.test(blob), 'a credential must never appear here')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
})

test('each local seat gets its own worktree so two agents cannot clobber one checkout', () => {
  const a = worktreeFor('/repo', 'ana-agent')
  const b = worktreeFor('/repo', 'heet-agent')
  assert.notEqual(a, b)
  assert.match(a, /ana-agent/)
  // The room serialises turns inside one session; it cannot serialise writes
  // from two independent sessions. Isolation has to come from git.
  const { args } = seatArgs({ configDir: '/c', roomUrl: 'u', token: 't', handle: 'ana-agent', repo: '/repo' })
  assert.ok(args.some(x => String(x).includes('ana-agent')), 'seat must run in its own worktree')
})

test('the MCP config travels as a file path, never as JSON on the command line', () => {
  // argv-borne JSON cannot survive cmd.exe, and escaping it would be an
  // injection surface. A path has neither problem.
  const { args } = seatArgs({
    configDir: '/cfg/ana', roomUrl: 'u', token: 't', handle: 'ana-agent', repo: '/repo',
  })
  const i = args.indexOf('--mcp-config')
  assert.notEqual(i, -1)
  const value = args[i + 1]
  assert.doesNotMatch(value, /[{}]/, 'the config must be a path, not inline JSON')
  assert.match(value, /mcp\.seat\.json$/)
})

test('the mcp config path can be overridden, so the launcher controls where it writes', () => {
  const { args } = seatArgs({
    configDir: '/cfg/ana', roomUrl: 'u', token: 't', handle: 'h', repo: '/r',
    mcpConfigPath: '/tmp/custom.json',
  })
  assert.ok(args.includes('/tmp/custom.json'))
})

test('the seat bridge is still what gets loaded, now via the config file body', () => {
  const cfg = mcpConfigFor()
  assert.ok(cfg.mcpServers.seat.command)
  assert.ok(cfg.mcpServers.seat.args.some(a => String(a).includes('seat')))
})
