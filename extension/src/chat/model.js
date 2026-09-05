// extension/src/chat/model.js
//
// Parsing for the model picker. Pure -- no DOM, no vscode.
//
// `/model` with no argument, run against the real binary, prints:
//   Current model: Haiku 4.5
//   Usage: /model <name>. Available: sonnet, opus, haiku, fable, best,
//   sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.
//
// parseModelList reads that text so the picker's option list comes from the
// installed binary rather than a hardcoded table that could drift from it.
'use strict'

const CURRENT_RE = /Current model:\s*(.+)/
const AVAILABLE_RE = /Available:\s*(.+)/
const TRAILING_FULL_ID_RE = /,?\s*or a full model ID\.?\s*$/i

/**
 * @param {string} text  the turn's full output text
 * @returns {{ current: string|null, available: string[] }}
 */
function parseModelList(text) {
  const s = String(text ?? '')

  const currentMatch = CURRENT_RE.exec(s)
  const current = currentMatch ? currentMatch[1].trim() : null

  const availableMatch = AVAILABLE_RE.exec(s)
  let available = []
  if (availableMatch) {
    const list = availableMatch[1].trim().replace(TRAILING_FULL_ID_RE, '')
    available = list
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  return { current, available }
}

// `<synthetic>` means a local slash command answered the turn, not a real
// model -- the spec is explicit that displaying it would be wrong.
function isRealModel(model) {
  return typeof model === 'string' && model.length > 0 && model !== '<synthetic>'
}

const api = { parseModelList, isRealModel }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api
}
if (typeof window !== 'undefined') {
  window.ClaudeModel = api
}
