// extension/test/workers-format.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { countdown, formatWorker, shortPath } = require('../src/chat/workers-format.js')

test('a busy worker shows the time it has LEFT, not the time it has spent', () => {
  // The deadline is what decides whether a stalled free model gets killed.
  // Elapsed time decides nothing, so showing it would be decoration.
  assert.equal(countdown(134_000), '2:14')
  assert.equal(countdown(59_000), '0:59')
  assert.equal(countdown(600_000), '10:00')
  assert.equal(countdown(0), '0:00')
})

test('an overdue worker reads as out of time, never as negative', () => {
  assert.equal(countdown(-5000), '0:00')
})

test('seconds are always two digits, so the column does not jitter', () => {
  assert.equal(countdown(65_000), '1:05')
})

test('status is a word, so it does not depend on the dot beside it', () => {
  const now = 1_000_000
  const busy = formatWorker({
    handle: 'worker-1', state: 'busy', model: 'opencode/mimo-v2.5-free',
    worktree: '/repo/.worktrees/worker-1', task: 'Add tests', deadlineAt: now + 134_000,
  }, now)
  assert.match(busy.status, /busy/)
  assert.match(busy.status, /2:14/, 'a busy worker shows its deadline')
})

test('an idle worker has no countdown to show', () => {
  const w = formatWorker({ handle: 'w', state: 'idle', model: 'm', worktree: '/w', deadlineAt: null }, 0)
  assert.equal(w.status, 'idle')
})

test('a starting worker says so rather than looking idle', () => {
  // It has no worktree and no opencode yet; a delegation sent now would fail.
  const w = formatWorker({ handle: 'w', state: 'starting', model: null, worktree: null }, 0)
  assert.match(w.status, /starting/)
})

test('a busy worker with no deadline still reads as busy rather than blank', () => {
  const w = formatWorker({ handle: 'w', state: 'busy', model: 'm', worktree: '/w', deadlineAt: null }, 0)
  assert.equal(w.status, 'busy')
})

test('the handle is shown the way it is addressed', () => {
  assert.equal(formatWorker({ handle: 'worker-1', state: 'idle' }, 0).title, '@worker-1')
})

test('a worker with no model yet says so instead of showing "null"', () => {
  const w = formatWorker({ handle: 'w', state: 'starting', model: null, worktree: null }, 0)
  assert.ok(!w.subtitle.includes('null'), `subtitle leaked a null: ${w.subtitle}`)
})

test('the row shows the model but not the worktree, which only repeats the title', () => {
  // Every worktree is .worktrees/<handle>, so at a ~300px sidebar it truncated
  // to ".worktrees/worke…" -- losing the identifying part to repeat the title.
  const w = formatWorker({
    handle: 'worker-1', state: 'idle', model: 'opencode/mimo-v2.5-free',
    worktree: 'C:/repo/.worktrees/worker-1',
  }, 0)
  assert.equal(w.subtitle, 'opencode/mimo-v2.5-free')
})

test('shortPath is still available for the detail view, which has the room', () => {
  assert.equal(shortPath('C:\\repo\\.worktrees\\worker-1'), '.worktrees/worker-1')
  assert.equal(shortPath('/home/u/repo/.worktrees/worker-2'), '.worktrees/worker-2')
  assert.equal(shortPath(null), '')
})

test('a path with no worktrees segment keeps its last two parts', () => {
  assert.equal(shortPath('/a/b/c/d'), 'c/d')
})

test('the task is carried through so the row can show what it is doing', () => {
  const w = formatWorker({ handle: 'w', state: 'busy', model: 'm', worktree: '/w', task: 'Add tests for parser.mjs' }, 0)
  assert.equal(w.task, 'Add tests for parser.mjs')
})

test('a worker with no task has none, rather than an empty-looking row', () => {
  assert.equal(formatWorker({ handle: 'w', state: 'idle' }, 0).task, null)
})
