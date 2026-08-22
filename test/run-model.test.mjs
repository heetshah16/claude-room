import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRunner, extractJSON } from '../src/run-model.mjs'
import { loadConfig } from '../src/config.mjs'

test('extracts a bare JSON object', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 })
})

test('extracts JSON from fences and surrounding prose', () => {
  assert.deepEqual(extractJSON('Here you go:\n```json\n{"a":2}\n```\nhope that helps'), { a: 2 })
})

test('returns null for text with no JSON object', () => {
  assert.equal(extractJSON('no json here'), null)
  assert.equal(extractJSON(''), null)
  assert.equal(extractJSON('{ broken'), null)
  assert.equal(extractJSON(null), null)
})

test('the runner spawns a tool-less claude -p and sums cached input into usage', async () => {
  let seenPrompt = null
  const runner = makeRunner(loadConfig({ ROOM_OBSERVER_MODEL: 'haiku' }), {
    spawn: (cmd, args, prompt) => {
      seenPrompt = prompt
      assert.equal(cmd, 'claude')
      assert.ok(args.includes('-p'))
      assert.ok(args.includes('--model'))
      assert.ok(args.includes('haiku'))
      assert.ok(args.includes('--output-format'))
      // The observer must have no tool surface at all.
      const banned = args[args.indexOf('--disallowed-tools') + 1]
      for (const t of ['Bash', 'Read', 'Write', 'Edit']) assert.ok(banned.includes(t))
      return {
        stdout: JSON.stringify({
          result: '{"forks":[]}',
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 },
        }),
        code: 0,
      }
    },
  })
  const out = await runner('some prompt')
  assert.equal(seenPrompt, 'some prompt')
  assert.equal(out.text, '{"forks":[]}')
  assert.equal(out.tokens.input, 16)
  assert.equal(out.tokens.output, 4)
})

test('a non-zero exit throws so the observer keeps its previous brief', async () => {
  const runner = makeRunner(loadConfig({}), { spawn: () => ({ stdout: '', stderr: 'boom', code: 1 }) })
  await assert.rejects(() => runner('x'), /boom/)
})

test('an unexpected envelope falls back to raw stdout rather than losing the result', async () => {
  const runner = makeRunner(loadConfig({}), { spawn: () => ({ stdout: '{"forks":[]}', code: 0 }) })
  const out = await runner('x')
  assert.equal(out.tokens.input, 0)
  assert.ok(out.text.includes('forks'))
})
