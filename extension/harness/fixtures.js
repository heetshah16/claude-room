// extension/harness/fixtures.js
//
// Recorded conversations, replayed into the harness page. Each entry is a list
// of the exact `postMessage` payloads chat/panel.js sends in production, so the
// webview cannot tell it is being driven by a fixture rather than by a real
// orchestrator.
//
// The shapes come from chat/panel.js (`postStream`, `postActivity`,
// `postFatal`) and from stream.js's event kinds. If those change, these change.
'use strict'
const { dirname, join } = require('node:path')
const { readFileSync } = require('node:fs')

/**
 * VS Code themes inherit through `include`. Returns one flattened theme whose
 * `colors` has the including file's values layered over the included file's --
 * which is the precedence VS Code itself applies.
 */
function resolveTheme(file, { readFile = p => readFileSync(p, 'utf8') } = {}) {
  const theme = JSON.parse(readFile(file))
  if (!theme.include) return theme
  const parent = resolveTheme(join(dirname(file), theme.include), { readFile })
  return { ...theme, colors: { ...(parent.colors ?? {}), ...(theme.colors ?? {}) } }
}

const stream = event => ({ type: 'stream', event })

// What a bare `/model` prints, verified against the real binary (see
// test/model.test.js). The webview fires this probe the moment a session is
// established, so any fixture that starts from a session must answer it --
// otherwise the chip stays "(unknown)" and, until the probe queue landed, the
// pending-probe guard swallowed every message after it.
const MODEL_PROBE_RESULT =
  'Current model: Opus 5\n' +
  'Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, opusplan, default, or a full model ID.'

// The real `/context` report, captured verbatim from `claude --print
// "/context"` version 2.1.216 on 2026-09-08. The same text drives
// test/context.test.js, so the screenshot and the parser tests agree on what
// the binary actually emits.
const CONTEXT_REPORT = [
  '## Context Usage',
  '',
  '**Model:** claude-opus-4-8',
  '**Tokens:** 20.2k / 1m (2%)',
  '',
  '### Estimated usage by category',
  '',
  '| Category | Tokens | Percentage |',
  '|----------|--------|------------|',
  '| System prompt | 2.8k | 0.3% |',
  '| System tools | 12.4k | 1.2% |',
  '| System tools (deferred) | 11.3k | 1.1% |',
  '| MCP tools | 4.1k | 0.4% |',
  '| Memory files | 1.6k | 0.2% |',
  '| Skills | 3.7k | 0.4% |',
  '| Messages | 1.3k | 0.1% |',
  '| Free space | 975.7k | 97.6% |',
  '',
  '### Memory Files',
  '',
  '| Type | Path | Tokens |',
  '|------|------|--------|',
  '| Project | CLAUDE.md | 1.6k |',
  '',
  '### Skills',
  '',
  '| Skill | Source | Tokens |',
  '|-------|--------|--------|',
  '| superpowers:brainstorming | Plugin (superpowers) | ~80 |',
  '| ui-ux-pro-max:design | Plugin (ui-ux-pro-max) | ~210 |',
  '| dataviz | Built-in | ~380 |',
  '| claude-api | Built-in | ~360 |',
].join('\n')

const FIXTURES = {
  conversation: [
    stream({ kind: 'session', sessionId: 'fixture', tools: [], cwd: '/repo' }),
    stream({ kind: 'turn-end', text: MODEL_PROBE_RESULT, turns: 1, costUsd: 0, isError: false }),
    stream({ kind: 'text', text: "I'll delegate the mechanical part, then review it.\n\n" }),
    stream({ kind: 'text', text: '- `parser.mjs` needs cases for the **empty input** path\n- I will verify with `node --test`\n' }),
    stream({ kind: 'tool', id: 't1', name: 'Read', input: { file_path: 'src/parser.mjs' } }),
    stream({ kind: 'tool-result', id: 't1', content: 'export function parse(s) { … }', isError: false }),
    { type: 'activity', activity: { kind: 'delegation-sent', id: 'd1', handle: 'worker-1', task: 'Add tests for parser.mjs' } },
    stream({ kind: 'turn-end', text: '', turns: 2, costUsd: 0.0143, isError: false }),
  ],
  'tool-error': [
    stream({ kind: 'text', text: 'Checking the build.\n' }),
    stream({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'npm run build' } }),
    stream({ kind: 'tool-result', id: 't1', content: 'error TS2345: argument of type…', isError: true }),
    stream({ kind: 'turn-end', text: '', turns: 1, costUsd: 0.002, isError: false }),
  ],
  'rate-limited': [
    stream({ kind: 'text', text: 'Working on it.\n' }),
    stream({ kind: 'rate-limit', status: 'rejected', resetsAt: '14:05', limitType: 'five_hour' }),
  ],
  fatal: [
    stream({ kind: 'text', text: 'Starting…\n' }),
    { type: 'fatal', message: 'orchestrator exited unexpectedly (code 1). Run "Claude Room: Restart Services" to continue.' },
  ],
  attachments: [
    stream({ kind: 'session', sessionId: 'fixture', tools: [], cwd: '/repo' }),
    stream({ kind: 'turn-end', text: MODEL_PROBE_RESULT, turns: 1, costUsd: 0, isError: false }),
    // A pasted image: carries a thumbnail, because the host hands back the
    // same bytes the webview sent rather than re-reading the file.
    { type: 'attached', path: 'C:/store/attachments/8f2a-41bc.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    // A picked file: a path and no preview.
    { type: 'attached', path: '/repo/docs/superpowers/specs/2026-09-05-orchestrator-parity-design.md', dataUrl: null },
  ],
  // Real skill names and descriptions, taken from what discoverSkills finds on
  // the development machine -- so the shot shows how actual descriptions
  // behave in a row, not how a conveniently short one does.
  workers: [
    { type: 'workers', workers: [
      { handle: 'worker-1', state: 'busy', model: 'opencode/mimo-v2.5-free',
        worktree: 'C:/repo/.worktrees/worker-1', task: 'Add tests for parser.mjs, verify with node --test',
        lastTool: 'glob', deadlineAt: Date.now() + 134_000 },
      { handle: 'worker-2', state: 'idle', model: 'opencode/mimo-v2.5-free',
        worktree: 'C:/repo/.worktrees/worker-2', task: null, lastTool: null, deadlineAt: null },
      { handle: 'worker-3', state: 'starting', model: null, worktree: null,
        task: null, lastTool: null, deadlineAt: null },
    ] },
  ],
  'workers-empty': [
    { type: 'workers', workers: [] },
  ],
  room: [
    stream({ kind: 'session', sessionId: 'fixture', tools: [], cwd: '/repo' }),
    stream({ kind: 'turn-end', text: MODEL_PROBE_RESULT, turns: 1, costUsd: 0, isError: false }),
    { type: 'permission-mode', mode: 'acceptEdits' },
    // Published, with a tailnet address -- advertiseHost prefers 100.64/10.
    { type: 'room', room: { published: true, advertised: 'http://100.84.12.7:51820/?token=REDACTED', members: [
      { id: 'm0', name: 'you', role: 'owner' },
      { id: 'm1', name: 'ana', role: 'member' },
      { id: 'm2', name: 'sam', role: 'viewer' },
    ] } },
  ],
  'permission-modes': [
    stream({ kind: 'session', sessionId: 'fixture', tools: [], cwd: '/repo' }),
    stream({ kind: 'turn-end', text: MODEL_PROBE_RESULT, turns: 1, costUsd: 0, isError: false }),
    { type: 'permission-mode', mode: 'acceptEdits' },
    { type: 'room', room: { published: false, advertised: null, members: [{ id: 'm0', name: 'you', role: 'owner' }] } },
  ],
  dashboard: [
    stream({ kind: 'session', sessionId: 'fixture', tools: [], cwd: '/repo' }),
    stream({ kind: 'turn-end', text: MODEL_PROBE_RESULT, turns: 1, costUsd: 0, isError: false }),
    { type: 'skills', skills: [
      { name: '/superpowers:brainstorming', summary: 'You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior.', hint: '', sends: false },
      { name: '/superpowers:test-driven-development', summary: 'Use when implementing any feature or bugfix, before writing implementation code', hint: '', sends: false },
      { name: '/ui-ux-pro-max:design', summary: 'Brand identity, design tokens, UI styling, logo generation', hint: '[design-type] [context]', sends: false },
      { name: '/claude-md-management:claude-md-improver', summary: 'Audit and improve CLAUDE.md files in repositories.', hint: '', sends: false },
    ] },
  ],
  'context-panel': [
    stream({ kind: 'session', sessionId: 'fixture', tools: [], cwd: '/repo' }),
    stream({ kind: 'turn-end', text: MODEL_PROBE_RESULT, turns: 1, costUsd: 0, isError: false }),
    stream({ kind: 'text', text: 'Added the empty-input cases and verified them.' }),
    // A real turn ending, which is what asks for a context refresh...
    stream({ kind: 'turn-end', text: '', turns: 3, costUsd: 0.0212, isError: false }),
    // ...and then the answer to that request.
    stream({ kind: 'turn-end', text: CONTEXT_REPORT, turns: 1, costUsd: 0, isError: false }),
  ],
}

/**
 * Fixtures that render a page other than index.html, and the widths that page
 * is worth looking at. The sidebar is about 300px in practice -- the tightest
 * surface in the product, and the one where a long worktree path does damage.
 */
const PAGES = {
  workers: { file: 'workers.html', widths: [{ name: 'sidebar', px: 300 }, { name: 'wide', px: 420 }] },
  'workers-empty': { file: 'workers.html', widths: [{ name: 'sidebar', px: 300 }] },
}

/**
 * Element ids to click after a fixture is replayed, so a panel that only opens
 * on demand can be screenshotted at all. A fixture not listed here is shot
 * exactly as it lands.
 */
const INTERACTIONS = {
  'context-panel': ['context-chip'],
  dashboard: ['dash-btn'],
  room: ['room-chip'],
  'permission-modes': ['permission-chip'],
}

module.exports = { FIXTURES, INTERACTIONS, PAGES, resolveTheme }
