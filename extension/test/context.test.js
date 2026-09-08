// extension/test/context.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseContextReport, verdictFor } = require('../src/chat/context.js')

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
  assert.equal(byLabel['System prompt'], 'system')
  assert.equal(byLabel['System tools'], 'system')
  assert.equal(byLabel['System tools (deferred)'], 'deferred')
  assert.equal(byLabel['Memory files'], 'memory')
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

test('the verdict names the largest block when it dominates', () => {
  const v = verdictFor(parseContextReport(REAL))
  assert.match(v, /System tools/)
})

test('a healthy small context gets no verdict rather than invented concern', () => {
  const lean = REAL
    .replace('| System tools | 12.4k | 1.2% |', '| System tools | 1.0k | 0.1% |')
    .replace('| System tools (deferred) | 11.3k | 1.1% |', '| System tools (deferred) | 1.1k | 0.1% |')
    .replace('| Skills | 3.7k | 0.4% |', '| Skills | 1.2k | 0.1% |')
    .replace('| Memory files | 1.6k | 0.2% |', '| Memory files | 1.3k | 0.1% |')
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
