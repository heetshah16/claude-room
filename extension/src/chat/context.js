// extension/src/chat/context.js
//
// Parsing for the context panel. Pure -- no DOM, no vscode.
//
// `/context` is a synthetic turn: Claude Code answers it locally, with no model
// call and no cost, and the answer is a markdown report of what is occupying
// the context window. Parsing that output is the same approach the model picker
// takes with `/model`, and for the same reason -- the numbers then come from
// the installed binary rather than from an estimate of our own that can drift
// from it silently.
//
// Field shapes verified against version 2.1.216 on 2026-09-08.
'use strict'

const HEADER_MODEL_RE = /\*\*Model:\*\*\s*(\S+)/
const HEADER_TOKENS_RE = /\*\*Tokens:\*\*\s*([\d.]+[km]?)\s*\/\s*([\d.]+[km]?)\s*\((\d+(?:\.\d+)?)%\)/i
const ROW_RE = /^\|(.+)\|\s*$/

/** "20.2k" -> 20200, "1m" -> 1000000, "~380" -> 380, "42" -> 42. */
function toTokens(raw) {
  const s = String(raw ?? '').trim().replace(/^~/, '')
  const m = /^([\d.]+)\s*([km])?$/i.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  const suffix = m[2] ? m[2].toLowerCase() : ''
  const scale = suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1
  return Math.round(n * scale)
}

/** The cells of a markdown table row, or null if this line is not one. */
function cells(line) {
  const m = ROW_RE.exec(line.trim())
  if (!m) return null
  const parts = m[1].split('|').map(s => s.trim())
  // The separator row (|---|---|) is structure, not data.
  if (parts.every(p => /^:?-{3,}:?$/.test(p))) return null
  return parts
}

/**
 * The data rows of the table under `heading`, excluding the table's own
 * column-name row. Returns [] when the section is absent -- which it is for
 * Memory Files whenever no CLAUDE.md is in scope.
 */
function tableUnder(text, heading) {
  const lines = String(text).split('\n')
  const start = lines.findIndex(l => l.trim().toLowerCase() === heading.toLowerCase())
  if (start === -1) return []
  const rows = []
  let seenHeader = false
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i].trim())) break // the next section
    const c = cells(lines[i])
    if (!c) continue
    if (!seenHeader) { seenHeader = true; continue }
    rows.push(c)
  }
  return rows
}

// Free space is the unfilled remainder of the bar, not something occupying
// context, so it is deliberately not a category.
const NOT_A_CATEGORY = new Set(['free space'])

/**
 * Which of the six chart bands each category is drawn in.
 *
 * /context reports nine categories; a part-to-whole display stops being
 * readable somewhere around six colours, and VS Code ships exactly six chart
 * tokens. So related categories share a band.
 *
 * The grouping is the question people actually ask -- how much is the system
 * prompt, how much is tooling, how much is skills, how much is my CLAUDE.md,
 * how much is the conversation. An earlier version put the system prompt and
 * the system tools in one band, which drew the two of them in the same colour
 * and erased the very distinction the panel exists to show.
 */
const BAND_ORDER = ['prompt', 'tools', 'mcp', 'skills', 'memory', 'messages']

const BAND_LABELS = {
  prompt: 'System prompt',
  tools: 'Tools',
  mcp: 'MCP tools',
  skills: 'Skills',
  memory: 'Memory files',
  messages: 'Messages',
}

const BANDS = {
  'system prompt': 'prompt',
  // Deferred tools are still tools. They keep their own row in the category
  // table, where the exact split is what matters.
  'system tools': 'tools',
  'system tools (deferred)': 'tools',
  'mcp tools': 'mcp',
  skills: 'skills',
  'custom agents': 'skills',
  'memory files': 'memory',
  messages: 'messages',
  'autocompact buffer': 'messages',
}

/**
 * Categories summed into the six drawn bands, largest first, with each band's
 * share of everything loaded.
 *
 * @returns {{key: string, label: string, tokens: number, share: number}[]}
 */
function bandsOf(report) {
  if (!report) return []
  const totals = new Map()
  for (const c of report.categories) {
    const key = BAND_ORDER.indexOf(c.key) === -1 ? 'messages' : c.key
    totals.set(key, (totals.get(key) || 0) + c.tokens)
  }
  const used = [...totals.values()].reduce((a, b) => a + b, 0) || 1
  return BAND_ORDER
    .filter(key => totals.get(key))
    .map(key => ({
      key,
      label: BAND_LABELS[key],
      tokens: totals.get(key),
      share: totals.get(key) / used,
    }))
    .sort((a, b) => b.tokens - a.tokens)
}

/**
 * @param {string} text  a turn's full output text
 * @returns {{
 *   model: string|null, usedTokens: number, totalTokens: number, pct: number,
 *   categories: {label: string, key: string, tokens: number}[],
 *   skills: {name: string, source: string, tokens: number}[],
 *   memoryFiles: {type: string, path: string, tokens: number}[],
 * }|null} null when this text is not a context report at all.
 */
function parseContextReport(text) {
  const s = String(text ?? '')
  const tokens = HEADER_TOKENS_RE.exec(s)
  // Say "not a context report" rather than returning an empty one: the caller
  // renders what it is given, and an empty report is an empty panel that looks
  // like a bug rather than like the wrong text having arrived.
  if (!tokens) return null

  const categories = tableUnder(s, '### Estimated usage by category')
    .map(([label, tok]) => ({
      label,
      key: BANDS[String(label).toLowerCase()] ?? 'other',
      tokens: toTokens(tok),
    }))
    .filter(c => !NOT_A_CATEGORY.has(c.label.toLowerCase()))

  const skills = tableUnder(s, '### Skills')
    .map(([name, source, tok]) => ({ name, source, tokens: toTokens(tok) }))

  const memoryFiles = tableUnder(s, '### Memory Files')
    .map(([type, path, tok]) => ({ type, path, tokens: toTokens(tok) }))

  return {
    model: HEADER_MODEL_RE.exec(s) ? HEADER_MODEL_RE.exec(s)[1] : null,
    usedTokens: toTokens(tokens[1]),
    totalTokens: toTokens(tokens[2]),
    pct: Number(tokens[3]),
    categories,
    skills,
    memoryFiles,
  }
}

// A percentage does not answer "is this working well". These thresholds try to,
// and each exists because it names something a person can actually act on.
const DOMINANT_SHARE = 0.35 // one block is over a third of everything loaded
const BIG_MEMORY_FILE = 5000 // a single CLAUDE.md this large is worth trimming

/** 380 -> "380", 20200 -> "20.2k", 1000000 -> "1m". */
function fmt(n) {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}m`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * One sentence of plain language, or null when there is nothing worth saying.
 *
 * Silence is the common case and the right one: a verdict on every healthy
 * report trains people to ignore the line that matters.
 */
function verdictFor(report) {
  if (!report) return null

  // Ranked before the largest band deliberately. "Tools are big" is true and
  // useless -- you cannot shrink them. An oversized CLAUDE.md is something the
  // person reading this owns and can edit today.
  const fat = (report.memoryFiles || []).find(f => f.tokens >= BIG_MEMORY_FILE)
  if (fat) {
    return `${fat.path} is ${fmt(fat.tokens)} on its own — trimming it frees the most context per line removed.`
  }

  // Judged over bands, not raw categories, because bands are what the panel
  // draws. Reasoning over categories disagreed with the bar in front of the
  // reader: tools were plainly 64% of it while the largest single category was
  // 33%, under the threshold, so the panel said nothing about its own biggest
  // block.
  const bands = bandsOf(report)
  const biggest = bands[0] // bandsOf sorts largest first
  if (biggest && biggest.share >= DOMINANT_SHARE) {
    const share = Math.round(biggest.share * 100)
    return `${biggest.label} are ${fmt(biggest.tokens)} — ${share}% of everything loaded, and the largest single block.`
  }
  return null
}

// Uniquely named, like every other chat module: browser <script> tags share one
// global scope, so a repeated top-level const kills whichever loads later.
const contextApi = { parseContextReport, verdictFor, bandsOf, fmtTokens: fmt, BANDS, BAND_ORDER, BAND_LABELS }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = contextApi
}
if (typeof window !== 'undefined') {
  window.ClaudeContext = contextApi
}
