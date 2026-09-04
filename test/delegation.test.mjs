import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDelegation, renderDelegation, TASK_CLASSES } from '../src/delegation.mjs'

const exec = {
  to: '@opencode', class: 'execution', task: 'add mul() to math.js',
  spec: { files: ['math.js'], tests: ['npm test'] },
}

test('a well-formed execution delegation is accepted', () => {
  assert.deepEqual(validateDelegation(exec), { ok: true, errors: [] })
})

test('an execution delegation without files or tests is refused, and says which', () => {
  // The whole failure mode this guards: a one-line brief handed to a weak
  // model, which then invents an interface nobody asked for.
  const r = validateDelegation({ to: '@opencode', class: 'execution', task: 'do the thing' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /files/.test(e)))
  assert.ok(r.errors.some(e => /tests/.test(e)))
})

test('reasoning and verification need only a task, because there is no code to scope', () => {
  for (const cls of ['reasoning', 'verification']) {
    const r = validateDelegation({ to: '@claude', class: cls, task: 'why does the feed drop?' })
    assert.equal(r.ok, true, `${cls} should not require files`)
  }
})

test('an unknown class is refused rather than treated as execution', () => {
  const r = validateDelegation({ to: '@opencode', class: 'vibes', task: 'x' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes(TASK_CLASSES.join(', '))))
})

test('a missing target or empty task is refused', () => {
  assert.equal(validateDelegation({ class: 'reasoning', task: 'x' }).ok, false)
  assert.equal(validateDelegation({ to: '@oc', class: 'reasoning', task: '   ' }).ok, false)
})

test('the rendered brief carries every part of the spec the worker needs', () => {
  const text = renderDelegation({
    ...exec,
    spec: { ...exec.spec, interface: 'export function mul(a,b)', do_not_touch: ['add.js'] },
  })
  assert.match(text, /add mul\(\) to math\.js/)
  assert.match(text, /math\.js/)
  assert.match(text, /npm test/)
  assert.match(text, /export function mul/)
  assert.match(text, /add\.js/)
})

test('the brief omits sections that were not supplied, rather than printing empty headings', () => {
  const text = renderDelegation({ to: '@oc', class: 'reasoning', task: 'explain the fork' })
  assert.doesNotMatch(text, /Do not touch/)
  assert.doesNotMatch(text, /Interface/)
})
