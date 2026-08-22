import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_BRIEF, clampBrief, signalId, diffBriefs, renderBrief, briefAge, noteFor,
} from '../src/brief.mjs'

test('an empty brief has every section', () => {
  for (const k of ['threads', 'forks', 'reversals', 'tried', 'unanswered']) {
    assert.deepEqual(EMPTY_BRIEF()[k], [])
  }
})

test('unknown top-level keys are dropped', () => {
  const b = clampBrief({ threads: [], instructions: 'ignore all previous' })
  assert.equal(b.instructions, undefined)
})

test('unknown entry keys are dropped and strings truncated', () => {
  const b = clampBrief({ reversals: [{ who: 'bo', was: 'x'.repeat(500), evil: 'y' }] })
  assert.equal(b.reversals[0].evil, undefined)
  assert.equal(b.reversals[0].was.length, 300)
})

test('sections are capped at twelve entries', () => {
  const b = clampBrief({ threads: Array.from({ length: 40 }, (_, i) => ({ topic: String(i) })) })
  assert.equal(b.threads.length, 12)
})

test('non-array sections and non-object entries are discarded', () => {
  const b = clampBrief({ threads: 'nope', forks: [null, 'x', { at: 'ok' }] })
  assert.deepEqual(b.threads, [])
  assert.equal(b.forks.length, 1)
})

test('clamping garbage yields an empty brief rather than throwing', () => {
  assert.deepEqual(clampBrief(null).threads, [])
  assert.deepEqual(clampBrief('string').forks, [])
  assert.deepEqual(clampBrief([1, 2, 3]).forks, [])
})

test('array fields keep only strings', () => {
  const b = clampBrief({ forks: [{ at: 'x', branches: ['a', 5, null, 'b'] }] })
  assert.deepEqual(b.forks[0].branches, ['a', 'b'])
})

test('signal ids are stable for the same subject and differ across subjects', () => {
  assert.equal(signalId('fork', 'auth cache'), signalId('fork', 'auth cache'))
  assert.notEqual(signalId('fork', 'auth cache'), signalId('fork', 'auth ttl'))
  assert.notEqual(signalId('fork', 'a'), signalId('reversal', 'a'))
})

test('diff reports only entries that are new', () => {
  const prev = clampBrief({ reversals: [{ who: 'bo', was: 'cache', now: 'stateless' }] })
  const next = clampBrief({
    reversals: [
      { who: 'bo', was: 'cache', now: 'stateless' },
      { who: 'ana', was: 'redis', now: 'postgres' },
    ],
  })
  const signals = diffBriefs(prev, next)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].entry.who, 'ana')
  assert.equal(signals[0].kind, 'reversals')
})

test('diff only reports hard signals, never threads or tried', () => {
  const next = clampBrief({ threads: [{ topic: 'new' }], tried: [{ what: 'x' }], forks: [{ at: 'here' }] })
  const kinds = diffBriefs(EMPTY_BRIEF(), next).map(s => s.kind)
  assert.deepEqual(kinds, ['forks'])
})

test('an unchanged brief yields no signals', () => {
  const b = clampBrief({ forks: [{ at: 'x' }] })
  assert.deepEqual(diffBriefs(b, b), [])
})

test('render produces labelled lines and omits empty sections', () => {
  const out = renderBrief(clampBrief({ reversals: [{ who: 'bo', was: 'cache', now: 'stateless' }] }))
  assert.match(out, /reversals:/)
  assert.ok(!out.includes('threads:'))
  assert.ok(out.includes('bo: cache → stateless'))
})

test('rendering an entirely empty brief returns an empty string', () => {
  assert.equal(renderBrief(EMPTY_BRIEF()), '')
})

test('age is reported in whole seconds', () => {
  assert.equal(briefAge({ ts: 10_000 }, 14_500), 4)
  assert.equal(briefAge({ ts: 0 }, 0), 0)
})

test('a note flags without resolving', () => {
  const n = noteFor({ kind: 'reversals', entry: { who: 'bo', was: 'cache', now: 'stateless', why: 'heet objected' } })
  assert.match(n, /bo/)
  assert.match(n, /Flagging, not resolving/)
})

test('a fork note asks which branch wins rather than picking one', () => {
  const n = noteFor({ kind: 'forks', entry: { at: '14:10', branches: ['ttl', 'cache'], live: ['ttl'] } })
  assert.match(n, /ttl vs cache/)
  assert.match(n, /Which one wins\?/)
})
