// extension/src/chat/workers-format.js
//
// How a worker reads in the sidebar. Pure -- no DOM, no vscode -- so every
// rule here is testable without a worker, a room, or a browser.
'use strict'

/**
 * Time remaining, as `m:ss`.
 *
 * The driver's per-turn deadline is what decides whether a stalled free model
 * gets killed, so remaining time is the number worth showing; elapsed time
 * decides nothing. An overdue worker reads as `0:00` rather than as a negative
 * duration -- it is out of time, not owed some.
 */
function countdown(msLeft) {
  const total = Math.max(0, Math.floor(Number(msLeft) || 0) / 1000)
  const mins = Math.floor(total / 60)
  const secs = Math.floor(total % 60)
  // Two digits always, so the column does not jitter as the seconds tick.
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * The identifying tail of a worktree path.
 *
 * The sidebar is about 300px wide; an absolute path pushes the handle and the
 * status out of view. `.worktrees/<handle>` is the part that says which
 * checkout this is.
 */
function shortPath(path) {
  if (!path) return ''
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  const at = parts.lastIndexOf('.worktrees')
  const tail = at === -1 ? parts.slice(-2) : parts.slice(at)
  return tail.join('/')
}

/**
 * One worker as three lines: title, subtitle, task.
 *
 * @param {object} w a row from the worker pool
 * @param {number} now
 * @returns {{title: string, status: string, subtitle: string, task: string|null, state: string}}
 */
function formatWorker(w, now = Date.now()) {
  const state = w?.state ?? 'idle'

  // A word, always. The dot beside it carries the same fact in colour, and
  // colour alone is not something everyone can read.
  let status = state
  if (state === 'busy' && w?.deadlineAt) {
    status = `busy · ${countdown(w.deadlineAt - now)}`
  }

  // The model only. The worktree is always `.worktrees/<handle>`, so at a
  // ~300px sidebar it truncated to ".worktrees/worke…" -- cutting off the one
  // part that identified it, to repeat what the title already said. It is kept
  // on the worker itself for the detail view, which has room for it.
  //
  // A model that is still null is a worker that has not finished starting;
  // rendering that gap as "null" would be worse than rendering nothing.
  const bits = [w?.model].filter(Boolean)

  return {
    state,
    title: `@${w?.handle ?? 'worker'}`,
    status,
    subtitle: bits.join(' · '),
    task: w?.task ?? null,
  }
}

// Uniquely named: the webview loads this with a <script> tag, sharing one
// global scope with every other chat module.
const workersFormatApi = { countdown, shortPath, formatWorker }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = workersFormatApi
}
if (typeof window !== 'undefined') {
  window.ClaudeWorkersFormat = workersFormatApi
}
