// extension/src/chat/commands.js
//
// The slash commands the dashboard may offer, and the filter behind it. Pure --
// no DOM, no vscode.
//
// EVERY entry here was run against the real binary in `--print` mode and seen
// to work. That is the entry criterion, not a style preference: a headless
// Claude Code answers an unsupported command with "isn't available in this
// environment", so offering one produces a dead menu item that fails in a way
// the user cannot diagnose.
//
// Verified working on 2.1.216, 2026-09-08: /model /context /cost /mcp.
// Verified NOT working, and deliberately absent: /help, /status, /permissions,
// /todos, and /agents -- which answers only to say its wizard was removed.
'use strict'

const COMMANDS = [
  { name: '/model', summary: 'Show or switch the model for this session', sends: true },
  { name: '/context', summary: 'What is filling the context window', sends: true },
  { name: '/cost', summary: 'Subscription usage and limits', sends: true },
  { name: '/mcp', summary: 'MCP server connection status', sends: true },
]

/**
 * Where a query hits an entry, lower being better. Null when it does not.
 *
 * Ranked rather than merely filtered: with a name and a summary both able to
 * match, a menu that ignores where the hit landed puts "/xcost" above "/cost"
 * for the query "cost", which reads as broken.
 */
function scoreOf(entry, q) {
  const name = String(entry.name ?? '').toLowerCase()
  const summary = String(entry.summary ?? '').toLowerCase()

  // A leading slash is punctuation, and a plugin skill is named
  // `/plugin:skill` -- people type the skill, not the plugin it shipped in. So
  // both the bare name and the part after the colon count as prefixes.
  const bare = name.replace(/^\/+/, '')
  const afterColon = bare.slice(bare.indexOf(':') + 1)

  if (bare.startsWith(q) || afterColon.startsWith(q)) return 0
  if (name.includes(q)) return 1
  if (summary.includes(q)) return 2
  return null
}

/** Entries matching `query`, best first; everything when the query is empty. */
function filterEntries(entries, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return entries.slice()

  const scored = []
  entries.forEach((entry, i) => {
    const score = scoreOf(entry, q)
    // Stable within a band: the registry's own order is meaningful, and a
    // menu that reshuffles between keystrokes is unusable.
    if (score !== null) scored.push({ entry, score, i })
  })
  return scored
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map(s => s.entry)
}

// Uniquely named, like every other chat module: browser <script> tags share one
// global scope, so a repeated top-level const kills whichever loads later.
const commandsApi = { COMMANDS, filterEntries }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = commandsApi
}
if (typeof window !== 'undefined') {
  window.ClaudeCommands = commandsApi
}
