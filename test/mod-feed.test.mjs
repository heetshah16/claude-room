import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrompter } from '../mod/feed.mjs'
import { REPLY_DIRECTIVE } from '../src/opencode.mjs'

const msg = (name, content) => ({ id: `${name}-1`, name, memberId: `m-${name}`, content })

test('a turn becomes one prompt naming the seat, the room and the sender, ending with the reply rule', () => {
  const prompt = createPrompter('ana-agent')
  const text = prompt('turn', { messages: [msg('heet', 'add a test for the login timeout')], room: 'auth' })
  assert.match(text, /@ana-agent/)
  assert.match(text, /"auth"/)
  assert.match(text, /heet/)
  assert.match(text, /add a test for the login timeout/)
  // The seat has no MCP `instructions` any more, so the one rule that matters
  // has to ride in the prompt itself, exactly as it does for OpenCode.
  assert.ok(text.endsWith(REPLY_DIRECTIVE))
})

test('a turn without a room name does not invent one', () => {
  // The room's `addressed` delivery carries messages only (web.mjs drain).
  const text = createPrompter('ana-agent')('turn', { messages: [msg('heet', 'hi')] })
  assert.doesNotMatch(text, /in room/)
  assert.match(text, /heet addressed you \(@ana-agent\)/)
})

test('a handle given with its @ is not doubled', () => {
  const text = createPrompter('@ana-agent')('turn', { messages: [msg('heet', 'hi')], room: 'r' })
  assert.doesNotMatch(text, /@@/)
})

test('mirrors, briefs and the seed never start a turn; they ride along with the next one, once', () => {
  const prompt = createPrompter('ana-agent')
  assert.equal(prompt('seed', { text: 'recent history' }), null)
  assert.equal(prompt('mirror', { text: 'found three call sites', from: 'bob-agent' }), null)
  assert.equal(prompt('brief', { text: 'room summary' }), null)

  const first = prompt('turn', { messages: [msg('heet', 'go')], room: 'r' })
  assert.match(first, /background only, never a request/)
  assert.match(first, /\[seed\] recent history/)
  assert.match(first, /\[mirror from @bob-agent\] found three call sites/)
  assert.match(first, /\[brief\] room summary/)

  const second = prompt('turn', { messages: [msg('heet', 'again')], room: 'r' })
  assert.doesNotMatch(second, /recent history/)
})

test('an empty turn and an unknown event produce nothing', () => {
  const prompt = createPrompter('ana-agent')
  assert.equal(prompt('turn', { messages: [], room: 'r' }), null)
  assert.equal(prompt('decision', { text: 'x' }), null)
})

test('the reply rule ends the turn at room_reply, so the room is not kept busy by text no one sees', () => {
  assert.match(REPLY_DIRECTIVE, /after room_reply.*end your turn/i)
})
