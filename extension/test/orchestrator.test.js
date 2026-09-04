// extension/test/orchestrator.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { orchestratorRecipe, createOrchestrator } = require('../src/orchestrator.js')

function fakeChild() {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.written = []
  c.stdin = { write: s => c.written.push(s), end() {} }
  return c
}

test('the session is persistent and bidirectional, not one process per turn', () => {
  // Verified against the real binary: one process, one session id, and the
  // second turn recalled a fact from the first. A cold start per message is
  // what makes a chat feel like a terminal.
  const r = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://room', token: 'tok',
    sessionId: 'sess-1', workspace: '/ws', mcpConfigPath: '/cfg/mcp.json',
  })
  assert.equal(r.cmd, 'claude')
  assert.ok(r.args.includes('--print'))
  assert.equal(r.args[r.args.indexOf('--input-format') + 1], 'stream-json')
  assert.equal(r.args[r.args.indexOf('--output-format') + 1], 'stream-json')
  assert.equal(r.args[r.args.indexOf('--session-id') + 1], 'sess-1')
  assert.equal(r.args[r.args.indexOf('--mcp-config') + 1], '/cfg/mcp.json')
})

test('--bare is never used, because it would forfeit the user\'s login', () => {
  // --bare skips hooks and CLAUDE.md, but it also never reads OAuth or the
  // keychain and demands an API key. Reusing the existing subscription login
  // is the entire reason this is pleasant to install.
  const r = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'u', token: 't', sessionId: 's', workspace: '/ws', mcpConfigPath: '/c',
  })
  assert.ok(!r.args.includes('--bare'))
  assert.equal(r.opts.env.ANTHROPIC_API_KEY, undefined)
})

test('the bridge is told where the room is, through the environment', () => {
  const r = orchestratorRecipe({
    repoRoot: '/repo', roomUrl: 'http://room:1', token: 'tok', sessionId: 's',
    workspace: '/ws', mcpConfigPath: '/c',
  })
  assert.equal(r.opts.env.ROOM_URL, 'http://room:1')
  assert.equal(r.opts.env.ROOM_TOKEN, 'tok')
})

test('a turn is one JSON line on stdin', () => {
  const child = fakeChild()
  const o = createOrchestrator({ child, onEvent: () => {} })
  o.send('add a mul function')
  assert.equal(child.written.length, 1)
  const msg = JSON.parse(child.written[0])
  assert.equal(msg.type, 'user')
  assert.equal(msg.message.content[0].text, 'add a mul function')
  assert.ok(child.written[0].endsWith('\n'), 'the line must be terminated or it is never read')
})

test('stdout is parsed into UI events', () => {
  const child = fakeChild()
  const seen = []
  createOrchestrator({ child, onEvent: e => seen.push(e) })
  child.stdout.emit('data', JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] },
  }) + '\n')
  assert.deepEqual(seen, [{ kind: 'text', text: 'hi' }])
})

test('a worker result is relayed as a turn the orchestrator can tell apart from a person', () => {
  // It arrives as a user-role turn because that is what it is - somebody
  // reporting back - but it must be labelled, or the orchestrator will thank
  // the human for work the human did not do.
  const child = fakeChild()
  const o = createOrchestrator({ child, onEvent: () => {} })
  o.relay({ handle: 'opencode', text: 'added mul(), tests pass' })
  const msg = JSON.parse(child.written[0])
  const text = msg.message.content[0].text
  assert.match(text, /opencode/)
  assert.match(text, /added mul/)
  assert.match(text, /worker/i, 'the orchestrator must be able to tell this is not the human')
})
