// extension/src/permission-modes.js
//
// The permission modes the chip offers, and the gate on what may reach the
// command line.
//
// `/permissions` is verified NOT to work in print mode, so there is no
// in-session way to change this: the chip restarts the orchestrator with
// `--permission-mode` and `--resume <sessionId>`, which keeps the conversation.
// That restart path already exists, for crash recovery.
//
// Verified on 2.1.216 (2026-09-08): `--permission-mode` is accepted alongside
// `--print`, and plan, acceptEdits and auto each answered normally. The CLI's
// full choice list is acceptEdits, auto, bypassPermissions, manual, dontAsk,
// plan.
//
// `dontAsk` is deliberately absent. The CLI accepts it, but its exact
// behaviour cannot be stated accurately here, and describing a safety setting
// with an invented summary is worse than not offering it -- the same rule the
// slash-command registry follows, applied harder. It stays reachable through
// settings.json.
'use strict'

const PERMISSION_MODES = [
  { id: 'auto', label: 'Auto', summary: 'Claude decides which actions need asking', destructive: false },
  { id: 'acceptEdits', label: 'Accept edits', summary: 'File edits apply without asking; other actions still ask', destructive: false },
  { id: 'plan', label: 'Plan', summary: 'Plan first — nothing is changed', destructive: false },
  { id: 'manual', label: 'Manual', summary: 'Ask before every action', destructive: false },
  { id: 'bypassPermissions', label: 'Bypass all', summary: 'Skip every permission check', destructive: true },
]

/** The ordinary prompting mode; `manual` is the CLI's alias for its default. */
const DEFAULT_MODE = 'manual'

/**
 * Whether a string may be passed as `--permission-mode`.
 *
 * Checked against the offered list rather than merely being non-empty: the
 * mode arrives from the webview and is spliced into a command line, so a value
 * like `--dangerously-skip-permissions` must never survive this.
 */
function isKnownMode(mode) {
  return PERMISSION_MODES.some(m => m.id === mode)
}

/** The mode's row, or null. */
function modeById(id) {
  return PERMISSION_MODES.find(m => m.id === id) ?? null
}

// Uniquely named, like every other module the webview loads: <script> tags
// share one global scope.
const permissionsApi = { PERMISSION_MODES, DEFAULT_MODE, isKnownMode, modeById }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = permissionsApi
}
if (typeof window !== 'undefined') {
  window.ClaudePermissions = permissionsApi
}
