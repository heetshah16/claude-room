// extension/test/context.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseContextReport, verdictFor, bandsOf, fmtTokens } = require('../src/chat/context.js')

// Captured verbatim from `claude --print "/context"`, version 2.1.216, on
// 2026-09-08. Not invented: every field shape here is one the real binary
// emitted, which is the whole reason this parser can be trusted.
const REAL = `## Context Usage

**Model:** claude-opus-4-8
**Tokens:** 20.2k / 1m (2%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.8k | 0.3% |
| System tools | 12.4k | 1.2% |
| System tools (deferred) | 11.3k | 1.1% |
| Memory files | 1.6k | 0.2% |
| Skills | 3.7k | 0.4% |
| Messages | 1.3k | 0.1% |
| Free space | 979.8k | 98.0% |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | C:\\repo\\CLAUDE.md | 1.6k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| superpowers:brainstorming | Plugin (superpowers) | ~80 |
| dataviz | Built-in | ~380 |
`

test('the header lines yield model, used, total and percentage', () => {
  const r = parseContextReport(REAL)
  assert.equal(r.model, 'claude-opus-4-8')
  assert.equal(r.usedTokens, 20200)
  assert.equal(r.totalTokens, 1000000)
  assert.equal(r.pct, 2)
})

test('categories are parsed with their token counts', () => {
  const { categories } = parseContextReport(REAL)
  const byLabel = Object.fromEntries(categories.map(c => [c.label, c.tokens]))
  assert.equal(byLabel['System tools'], 12400)
  assert.equal(byLabel['System tools (deferred)'], 11300)
  assert.equal(byLabel['Skills'], 3700)
  assert.equal(byLabel['Memory files'], 1600)
})

test('categories carry the band they are drawn in, so nine become six bars', () => {
  const { categories } = parseContextReport(REAL)
  const byLabel = Object.fromEntries(categories.map(c => [c.label, c.key]))
  // The system prompt gets its own band. Grouping it with the tools drew both
  // in one colour and erased the distinction the panel exists to show.
  assert.equal(byLabel['System prompt'], 'prompt')
  assert.equal(byLabel['System tools'], 'tools')
  assert.equal(byLabel['System tools (deferred)'], 'tools')
  assert.equal(byLabel['Memory files'], 'memory')
})

test('bandsOf sums categories into bands and shares them against what is loaded', () => {
  const bands = bandsOf(parseContextReport(REAL))
  const tools = bands.find(b => b.key === 'tools')
  // 12.4k + 11.3k, the two tool rows, in one band.
  assert.equal(tools.tokens, 23700)
  assert.equal(tools.label, 'Tools')

  // Shares are of the total loaded, not of the window -- the bar is
  // normalised so proportions stay legible in a 1m context.
  const used = bands.reduce((sum, b) => sum + b.tokens, 0)
  assert.ok(Math.abs(tools.share - tools.tokens / used) < 1e-9)
  assert.ok(Math.abs(bands.reduce((sum, b) => sum + b.share, 0) - 1) < 1e-9,
    'the shares must add up to the whole bar')
})

test('bands come back largest first, so the bar reads big-to-small', () => {
  const bands = bandsOf(parseContextReport(REAL))
  const sizes = bands.map(b => b.tokens)
  assert.deepEqual(sizes, sizes.slice().sort((a, b) => b - a))
})

test('an empty band is not drawn at all', () => {
  // The real report has no Custom agents row, so no such band may appear.
  const keys = bandsOf(parseContextReport(REAL)).map(b => b.key)
  assert.ok(!keys.includes('mcp'), 'this fixture has no MCP tools row')
})

test('bandsOf on a null report is an empty list, not a crash', () => {
  assert.deepEqual(bandsOf(null), [])
})

test('token counts read in the same units the binary prints', () => {
  assert.equal(fmtTokens(380), '380')
  assert.equal(fmtTokens(20200), '20.2k')
  // 1000000 rendered as "1000.0k" was what the first screenshot showed.
  assert.equal(fmtTokens(1000000), '1m')
})

test('free space is not a category -- it is the empty part of the bar', () => {
  const { categories } = parseContextReport(REAL)
  assert.ok(!categories.some(c => c.label === 'Free space'))
})

test('the skills table is parsed, including the ~ prefix on estimates', () => {
  const { skills } = parseContextReport(REAL)
  assert.deepEqual(skills[1], { name: 'dataviz', source: 'Built-in', tokens: 380 })
})

test('memory files are parsed with their paths', () => {
  const { memoryFiles } = parseContextReport(REAL)
  assert.equal(memoryFiles.length, 1)
  assert.equal(memoryFiles[0].tokens, 1600)
  assert.match(memoryFiles[0].path, /CLAUDE\.md$/)
})

test('a report with no memory files parses with an empty list, not a crash', () => {
  // Verified: the Memory Files section is absent entirely when no CLAUDE.md is
  // in scope, rather than present and empty.
  const noMemory = REAL.replace(/### Memory Files[\s\S]*?(?=### Skills)/, '')
  const r = parseContextReport(noMemory)
  assert.deepEqual(r.memoryFiles, [])
  assert.ok(r.categories.length > 0, 'the rest of the report must still parse')
  assert.equal(r.skills.length, 2)
})

test('text that is not a context report returns null rather than a blank panel', () => {
  assert.equal(parseContextReport('Current model: Haiku 4.5'), null)
  assert.equal(parseContextReport(''), null)
  assert.equal(parseContextReport(null), null)
})

test('the verdict names the largest band, which is what the bar draws', () => {
  // Judged over bands, not raw categories. The two tool rows are 23.7k of the
  // 33.1k loaded -- plainly the biggest thing on the bar -- while the largest
  // single category is 12.4k, or 37%. Reasoning over categories left the panel
  // nearly silent about its own dominant block, and silent outright once an
  // MCP row pushed the category share below the threshold.
  const v = verdictFor(parseContextReport(REAL))
  assert.match(v, /^Tools are 23\.7k/)
  assert.match(v, /72%/)
})

test('a balanced context gets no verdict rather than invented concern', () => {
  // Every band under a third of the total: nothing here is worth a sentence,
  // and a line on every report trains people to ignore the one that matters.
  const lean = REAL
    .replace('| System prompt | 2.8k | 0.3% |', '| System prompt | 2.0k | 0.2% |')
    .replace('| System tools | 12.4k | 1.2% |', '| System tools | 1.5k | 0.1% |')
    .replace('| System tools (deferred) | 11.3k | 1.1% |', '| System tools (deferred) | 0.5k | 0.1% |')
    .replace('| Skills | 3.7k | 0.4% |', '| Skills | 2.0k | 0.2% |')
    .replace('| Memory files | 1.6k | 0.2% |', '| Memory files | 1.8k | 0.2% |')
    .replace('| Messages | 1.3k | 0.1% |', '| Messages | 1.9k | 0.2% |')
  assert.equal(verdictFor(parseContextReport(lean)), null)
})

test('an oversized memory file is called out ahead of the largest category', () => {
  // A CLAUDE.md is something a person can actually act on, so it outranks
  // "system tools are big", which they cannot.
  const fat = REAL.replace('| Project | C:\\repo\\CLAUDE.md | 1.6k |', '| Project | C:\\repo\\CLAUDE.md | 9.4k |')
  assert.match(verdictFor(parseContextReport(fat)), /CLAUDE\.md/)
})

test('verdictFor tolerates a null report', () => {
  assert.equal(verdictFor(null), null)
})
