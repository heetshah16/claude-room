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
}

module.exports = { FIXTURES, resolveTheme }
