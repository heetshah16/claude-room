// extension/test/stream.test.js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createStreamParser } = require('../src/stream.js')

/** Feed whole lines; return every normalised event. */
function run(lines) {
  const seen = []
  const p = createStreamParser({ onEvent: e => seen.push(e) })
  for (const l of lines) p.push(JSON.stringify(l) + '\n')
  return seen
}

test('the session id is surfaced on init, because a restart has to resume it', () => {
  const out = run([{ type: 'system', subtype: 'init', session_id: 'abc', tools: ['Bash'], cwd: '/x' }])
  assert.deepEqual(out, [{ kind: 'session', sessionId: 'abc', tools: ['Bash'], cwd: '/x' }])
})

test('assistant text arrives as text, and thinking as its own kind', () => {
  // The UI renders them differently: prose is the answer, thinking is a
  // disclosure the reader opens only when they want it.
  const out = run([{
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'The answer is 42.' }] },
  }])
  assert.deepEqual(out.map(e => e.kind), ['thinking', 'text'])
  assert.equal(out[1].text, 'The answer is 42.')
})

test('a tool call and its result are correlated by tool_use_id', () => {
  // The webview renders one card per call and fills in its result later;
  // without the correlation the result has no card to land in.
  const out = run([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node -e "1"' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '42', is_error: false }] } },
  ])
  assert.deepEqual(out[0], { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'node -e "1"' } })
  assert.deepEqual(out[1], { kind: 'tool-result', id: 't1', content: '42', isError: false })
})

test('a failing tool result is marked, so the UI can show it as a failure', () => {
  const out = run([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'boom', is_error: true }] } },
  ])
  assert.equal(out[0].isError, true)
})

test('thinking-token deltas become a single running total, not a hundred events', () => {
  // The real binary emits one of these per few tokens. Forwarding each to the
  // webview would be a message storm; the UI only ever shows the latest.
  const out = run([
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 22 },
  ])
  assert.deepEqual(out, [{ kind: 'thinking-tokens', tokens: 5 }, { kind: 'thinking-tokens', tokens: 22 }])
})

test('a rate limit event is surfaced, because a GUI must not just go quiet', () => {
  const out = run([{
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', resetsAt: 1788562200, rateLimitType: 'five_hour' },
  }])
  assert.deepEqual(out, [{ kind: 'rate-limit', status: 'allowed', resetsAt: 1788562200, limitType: 'five_hour' }])
})

test('result ends the turn and carries what the turn cost', () => {
  const out = run([{
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    session_id: 'abc', num_turns: 2, total_cost_usd: 0.01,
  }])
  assert.deepEqual(out, [{ kind: 'turn-end', text: 'done', sessionId: 'abc', turns: 2, costUsd: 0.01, isError: false }])
})

test('a JSON line split across chunks is still parsed', () => {
  // stdout arrives in arbitrary chunks; a parser that assumed whole lines
  // would drop the event that happened to straddle a boundary.
  const seen = []
  const p = createStreamParser({ onEvent: e => seen.push(e) })
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'z', tools: [], cwd: '/' }) + '\n'
  p.push(line.slice(0, 12))
  p.push(line.slice(12))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, 'z')
})

test('a malformed line is skipped rather than killing the stream', () => {
  const seen = []
  const p = createStreamParser({ onEvent: e => seen.push(e) })
  p.push('{not json}\n')
  p.push(JSON.stringify({ type: 'result', result: 'ok', session_id: 's' }) + '\n')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'turn-end')
})

test('an unknown event type is ignored, so a new binary version cannot break the chat', () => {
  assert.deepEqual(run([{ type: 'something_new', payload: 1 }]), [])
})
