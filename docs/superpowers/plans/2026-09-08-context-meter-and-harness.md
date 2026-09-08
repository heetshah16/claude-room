# Context Meter and Screenshot Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat a context-budget chip that expands into a by-category
breakdown of what is filling the orchestrator's context window, and give this
repo the ability to screenshot its own webview so the UI can be verified without
a human opening VS Code.

**Architecture:** `/context` is a synthetic Claude Code turn — answered locally,
no model call, no cost — whose result text carries a markdown table of token
counts per category. A pure parser turns that text into a report; a pure verdict
function turns the report into one sentence of plain language; the webview
renders both. Alongside it, a harness loads the *real* webview scripts in
headless Chrome against generated VS Code theme tokens, so every change can be
looked at.

**Tech Stack:** CommonJS, no build step, no runtime dependencies. `node --test`.
Headless Chrome (already installed; spawned from Node, so it needs no shell
permission). VS Code theme JSON read from the installed editor.

**Spec:** [`docs/design-system.md`](../../design-system.md) — §2 tokens, §3
accessibility floor, §7 the context panel, §9 checklist.

## Global Constraints

- **CommonJS only** in `extension/`. `extension/package.json` must never gain a
  `"type"` field — its absence is what lets the CommonJS extension tests and the
  ESM room tests resolve in one `node --test` run.
- **Zero runtime dependencies.** Dev-only dependencies are allowed.
- **Never `innerHTML`.** Build nodes, set `textContent`. Enforced by the CSP in
  `webview.html`.
- **No hex literal in `webview.css`.** Every colour is `var(--vscode-*, fallback)`.
- **No emoji used as an icon.** Inline SVG only.
- **Webview scripts share one global scope.** Every file in `src/chat/` that the
  HTML loads must declare its top-level names uniquely — two files declaring
  `const api` is a SyntaxError that silently kills the second script.
- Every `src/chat/*.js` module ends with the dual export used by `model.js`:
  `module.exports` when `module` exists, `window.ClaudeX` when `window` does.
- Tests never spawn `claude` or `opencode`, and never open a non-loopback socket.

---

### Task 1: Theme tokens generated from the installed editor

**Files:**
- Create: `extension/harness/themes.js`
- Test: `extension/test/harness-themes.test.js`

**Interfaces:**
- Produces: `themeToCss(themeJson, { defaults })` → CSS text;
  `tokenName(colorKey)` → `--vscode-…`; `BUILTIN_DEFAULTS` (object, dark/light).

**Why a defaults layer:** verified 2026-09-08 — `dark_modern.json` includes
`dark_plus.json` includes `dark_vs.json`, and **none of them define any
`charts.*` colour**. Those come from VS Code's own built-in defaults, so a
generator that only reads theme files produces a stylesheet with no chart
colours at all and the context bar renders invisible.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/harness-themes.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { tokenName, themeToCss, BUILTIN_DEFAULTS } = require('../harness/themes.js')

test('a theme colour key becomes the webview CSS custom property VS Code exposes', () => {
  assert.equal(tokenName('editor.background'), '--vscode-editor-background')
  assert.equal(tokenName('editorWidget.background'), '--vscode-editorWidget-background')
})

test('theme colours are emitted as custom properties on :root', () => {
  const css = themeToCss({ colors: { 'editor.background': '#1f1f1f' } }, { defaults: {} })
  assert.match(css, /:root\s*\{/)
  assert.match(css, /--vscode-editor-background:\s*#1f1f1f;/)
})

test('defaults fill in tokens no theme file defines, which is the charts family', () => {
  // Verified against the installed editor: dark_modern -> dark_plus -> dark_vs
  // define no charts.* colour at all.
  const css = themeToCss({ colors: {} }, { defaults: BUILTIN_DEFAULTS.dark })
  assert.match(css, /--vscode-charts-blue:/)
  assert.match(css, /--vscode-charts-purple:/)
})

test('a colour the theme defines wins over the built-in default', () => {
  const css = themeToCss(
    { colors: { 'charts.blue': '#abcdef' } },
    { defaults: { 'charts.blue': '#000000' } },
  )
  assert.match(css, /--vscode-charts-blue:\s*#abcdef;/)
  assert.doesNotMatch(css, /--vscode-charts-blue:\s*#000000;/)
})

test('values are rejected unless they look like colours, so a theme cannot inject CSS', () => {
  const css = themeToCss({ colors: { 'editor.background': 'red; } body { display:none } .x {' } }, { defaults: {} })
  assert.doesNotMatch(css, /display:none/)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/harness-themes.test.js`
Expected: FAIL — `Cannot find module '../harness/themes.js'`

- [ ] **Step 3: Write the implementation**

```js
// extension/harness/themes.js
//
// Turns a VS Code colour theme into the CSS custom properties a webview sees.
//
// VS Code exposes theme colours to a webview as `--vscode-<key with dots
// replaced by dashes>`. Reproducing that here is what makes a harness
// screenshot look like the real panel rather than an approximation.
//
// Themes inherit: dark_modern includes dark_plus includes dark_vs. And no
// theme in that chain defines any `charts.*` colour -- those live in VS Code's
// built-in defaults. So a generator that reads only theme files emits no chart
// colours and the context bar renders as nothing. BUILTIN_DEFAULTS is that
// missing layer.
'use strict'

/** `editorWidget.background` -> `--vscode-editorWidget-background`. Case is preserved. */
function tokenName(colorKey) {
  return `--vscode-${String(colorKey).split('.').join('-')}`
}

// A theme file is data, not code, but it is still input -- and this output is
// concatenated into a stylesheet. Anything that is not a plain colour is
// dropped rather than escaped: no legitimate theme value needs more than this.
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

/** VS Code's own defaults for tokens no theme file carries. */
const BUILTIN_DEFAULTS = {
  dark: {
    'charts.foreground': '#cccccc',
    'charts.lines': '#808080',
    'charts.red': '#f14c4c',
    'charts.blue': '#3794ff',
    'charts.yellow': '#cca700',
    'charts.orange': '#d18616',
    'charts.green': '#89d185',
    'charts.purple': '#b180d7',
  },
  light: {
    'charts.foreground': '#3b3b3b',
    'charts.lines': '#808080',
    'charts.red': '#cd3131',
    'charts.blue': '#0f4a85',
    'charts.yellow': '#b89500',
    'charts.orange': '#d18616',
    'charts.green': '#388a34',
    'charts.purple': '#652d90',
  },
}

/**
 * @param {{colors?: Record<string,string>}} themeJson  already include-resolved
 * @param {{defaults?: Record<string,string>}} opts
 * @returns {string} a stylesheet declaring the tokens on :root
 */
function themeToCss(themeJson, { defaults = {} } = {}) {
  const merged = { ...defaults, ...(themeJson?.colors ?? {}) }
  const lines = []
  for (const [key, value] of Object.entries(merged)) {
    if (!COLOR_RE.test(String(value))) continue
    lines.push(`  ${tokenName(key)}: ${value};`)
  }
  lines.sort()
  return `:root {\n${lines.join('\n')}\n}\n`
}

module.exports = { tokenName, themeToCss, BUILTIN_DEFAULTS }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/harness-themes.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/harness/themes.js extension/test/harness-themes.test.js
git commit -m "feat(harness): generate webview CSS tokens from a VS Code theme"
```

---

### Task 2: The harness page and the screenshot runner

**Files:**
- Create: `extension/harness/index.html`
- Create: `extension/harness/fixtures.js`
- Create: `extension/harness/shoot.js`
- Modify: `.gitignore` (add `extension/harness/shots/`)
- Test: `extension/test/harness-fixtures.test.js`

**Interfaces:**
- Consumes: `themeToCss`, `BUILTIN_DEFAULTS` from Task 1.
- Produces: `FIXTURES` (object keyed by scenario name → array of postMessage
  payloads); `resolveTheme(dir, file)` → include-resolved theme JSON.

**How it works:** `index.html` loads the real `webview.css` and the real
`markdown.js` / `model.js` / `webview.js` from `../src/chat/`, stubs
`acquireVsCodeApi`, then replays a fixture by dispatching the same
`window.postMessage` payloads `panel.js` sends in production. Nothing is
reimplemented, so a CSS or renderer bug shows up as itself.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/harness-fixtures.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FIXTURES, resolveTheme } = require('../harness/fixtures.js')

test('every fixture is a list of messages shaped like what panel.js posts', () => {
  const names = Object.keys(FIXTURES)
  assert.ok(names.length > 0, 'there must be at least one fixture')
  for (const name of names) {
    for (const msg of FIXTURES[name]) {
      assert.ok(['stream', 'activity', 'fatal'].includes(msg.type), `${name}: bad type ${msg.type}`)
      if (msg.type === 'stream') assert.ok(typeof msg.event?.kind === 'string', `${name}: stream needs event.kind`)
    }
  }
})

test('a conversation fixture exercises text, a tool call and its result', () => {
  const kinds = FIXTURES.conversation.filter(m => m.type === 'stream').map(m => m.event.kind)
  for (const k of ['text', 'tool', 'tool-result', 'turn-end']) {
    assert.ok(kinds.includes(k), `conversation fixture must include a ${k} event`)
  }
})

test('resolveTheme follows the include chain and lets the outer theme win', () => {
  const files = {
    'a.json': JSON.stringify({ include: './b.json', colors: { 'editor.background': '#111111' } }),
    'b.json': JSON.stringify({ colors: { 'editor.background': '#222222', 'badge.background': '#333333' } }),
  }
  const theme = resolveTheme('a.json', { readFile: p => files[p] })
  assert.equal(theme.colors['editor.background'], '#111111', 'the including theme wins')
  assert.equal(theme.colors['badge.background'], '#333333', 'the included theme fills the rest')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/harness-fixtures.test.js`
Expected: FAIL — `Cannot find module '../harness/fixtures.js'`

- [ ] **Step 3: Write the fixtures module**

```js
// extension/harness/fixtures.js
//
// Recorded conversations, replayed into the harness page. Each entry is a list
// of the exact `postMessage` payloads chat/panel.js sends in production, so the
// webview cannot tell it is being driven by a fixture.
'use strict'
const { dirname, join } = require('node:path')
const { readFileSync } = require('node:fs')

/**
 * VS Code themes inherit through `include`. Returns one flattened theme whose
 * `colors` has the including file's values layered over the included file's.
 */
function resolveTheme(file, { readFile = p => readFileSync(p, 'utf8') } = {}) {
  const theme = JSON.parse(readFile(file))
  if (!theme.include) return theme
  const parent = resolveTheme(join(dirname(file), theme.include), { readFile })
  return { ...theme, colors: { ...(parent.colors ?? {}), ...(theme.colors ?? {}) } }
}

const stream = event => ({ type: 'stream', event })

const FIXTURES = {
  conversation: [
    stream({ kind: 'session', sessionId: 'fixture', tools: [], cwd: '/repo' }),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/harness-fixtures.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the harness page**

```html
<!-- extension/harness/index.html -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>webview harness</title>
<!--
  Loads the REAL webview stylesheet and the REAL chat scripts, so what is
  screenshotted here is what ships. The only things faked are the two seams a
  webview has with VS Code: `acquireVsCodeApi`, and the theme custom properties
  (generated into theme.css by shoot.js).
-->
<link rel="stylesheet" href="./theme.css">
<link rel="stylesheet" href="../src/chat/webview.css">
</head>
<body>
  <div id="fatal" class="fatal" hidden></div>
  <div id="rate-limit" class="rate-limit-banner" hidden></div>
  <div id="messages" class="messages">
    <div id="empty-state" class="empty-state">
      <div class="empty-state-title">Orchestrator</div>
      <div class="empty-state-hint">Delegates mechanical work to workers, and reports back here.</div>
    </div>
  </div>
  <div id="status" class="status" hidden></div>
  <div class="composer">
    <textarea id="input" rows="1" placeholder="Message the orchestrator... (Enter to send, Shift+Enter for a new line)"></textarea>
    <div class="composer-toolbar">
      <div class="composer-toolbar-left">
        <button id="model-picker" class="model-chip" type="button" title="Change model">model: (unknown)</button>
        <select id="model-select" hidden></select>
      </div>
      <button id="send" class="send-btn" type="button" aria-label="Send" title="Send">&uarr;</button>
    </div>
  </div>
  <script>
    // The one seam the webview has with the extension host.
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => null, setState() {} })
  </script>
  <script src="../src/chat/markdown.js"></script>
  <script src="../src/chat/model.js"></script>
  <script src="../src/chat/webview.js"></script>
  <script src="./replay.js"></script>
</body>
</html>
```

- [ ] **Step 6: Write the screenshot runner**

```js
// extension/harness/shoot.js
//
// Renders each fixture in headless Chrome and writes a PNG per
// (fixture x theme x width).
//
// Chrome is spawned here rather than from a shell so the harness needs no
// browser permission of its own, and so the path is resolved rather than
// assumed. No Playwright, no Puppeteer: `--screenshot` is a Chrome flag, and
// this repo's zero-dependency property is worth more than a nicer API.
'use strict'
const { execFile } = require('node:child_process')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { promisify } = require('node:util')
const { FIXTURES, resolveTheme } = require('./fixtures.js')
const { themeToCss, BUILTIN_DEFAULTS } = require('./themes.js')

const run = promisify(execFile)
const HERE = __dirname

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const VSCODE_THEMES = [
  'C:/Users/' + (process.env.USERNAME ?? '') + '/AppData/Local/Programs/cursor/resources/app/extensions/theme-defaults/themes',
  '/usr/share/code/resources/app/extensions/theme-defaults/themes',
]

const THEMES = [
  { name: 'dark', file: 'dark_modern.json', defaults: BUILTIN_DEFAULTS.dark },
  { name: 'light', file: 'light_modern.json', defaults: BUILTIN_DEFAULTS.light },
]

const WIDTHS = [{ name: 'wide', px: 900 }, { name: 'narrow', px: 420 }]

function findChrome() {
  const found = CHROME_CANDIDATES.find(p => existsSync(p))
  if (!found) throw new Error(`no Chrome or Edge found. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`)
  return found
}

function findThemeDir() {
  const found = VSCODE_THEMES.find(p => existsSync(p))
  if (!found) throw new Error(`no VS Code theme directory found. Looked in:\n  ${VSCODE_THEMES.join('\n  ')}`)
  return found
}

async function main() {
  const chrome = findChrome()
  const themeDir = findThemeDir()
  const outDir = join(HERE, 'shots')
  mkdirSync(outDir, { recursive: true })

  const only = process.argv[2] ?? null
  const names = only ? [only] : Object.keys(FIXTURES)
  for (const n of names) {
    if (!FIXTURES[n]) throw new Error(`no such fixture: ${n}. Have: ${Object.keys(FIXTURES).join(', ')}`)
  }

  for (const theme of THEMES) {
    const css = themeToCss(resolveTheme(join(themeDir, theme.file)), { defaults: theme.defaults })
    writeFileSync(join(HERE, 'theme.css'), css)
    for (const fixture of names) {
      // replay.js is rewritten per shot rather than read from a query string:
      // a file:// page cannot fetch a sibling file, and inlining keeps the
      // page itself identical to what a script tag would load.
      writeFileSync(
        join(HERE, 'replay.js'),
        `for (const m of ${JSON.stringify(FIXTURES[fixture])}) window.dispatchEvent(new MessageEvent('message', { data: m }))\n`,
      )
      for (const width of WIDTHS) {
        const out = join(outDir, `${fixture}-${theme.name}-${width.name}.png`)
        await run(chrome, [
          '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
          `--screenshot=${out}`,
          `--window-size=${width.px},760`,
          '--virtual-time-budget=2000',
          `file://${join(HERE, 'index.html').split('\\').join('/')}`,
        ])
        process.stdout.write(`${out}\n`)
      }
    }
  }
}

main().catch(err => { process.stderr.write(`${err.message}\n`); process.exit(1) })
```

- [ ] **Step 7: Ignore the output, and run it**

```bash
printf 'extension/harness/shots/\nextension/harness/theme.css\nextension/harness/replay.js\n' >> .gitignore
node extension/harness/shoot.js conversation
```

Expected: PNG paths printed, files on disk. **Read one of the PNGs and look at
it.** If the page is unstyled or blank, the stylesheet path or the replay is
wrong — fix before continuing, because every later task depends on this being
truthful.

- [ ] **Step 8: Commit**

```bash
git add extension/harness/ extension/test/harness-fixtures.test.js .gitignore
git commit -m "feat(harness): screenshot the real webview in both themes"
```

---

### Task 3: SVG icons, replacing the emoji

**Files:**
- Create: `extension/src/chat/icons.js`
- Modify: `extension/src/chat/webview.js:150` and `:342` (the two `\u{1F527}` uses)
- Modify: `extension/src/chat/webview.html` (load `icons.js` before `webview.js`)
- Test: `extension/test/icons.test.js`

**Interfaces:**
- Produces: `window.ClaudeIcons` / `module.exports` = `{ icon(name, document) }`
  returning an `<svg>` element; `ICON_NAMES` (array).

**Why:** design §2 forbids emoji as icons — they render differently per
platform, ignore `currentColor`, and cannot be sized to the 4px grid. The chat
currently uses a wrench emoji on every tool row.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/icons.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { icon, ICON_NAMES } = require('../src/chat/icons.js')

// The smallest document `icon` needs. Namespaced creation is what makes an
// <svg> actually render rather than appear as an unknown HTML element.
function fakeDoc() {
  const make = tag => ({
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v },
    appendChild(c) { this.children.push(c); return c },
  })
  return { createElementNS: (_ns, tag) => make(tag), created: make }
}

test('every named icon builds an svg element', () => {
  for (const name of ICON_NAMES) {
    const el = icon(name, fakeDoc())
    assert.equal(el.tag, 'svg', `${name} must be an svg`)
    assert.ok(el.children.length > 0, `${name} must have at least one path`)
  }
})

test('icons inherit the text colour instead of carrying their own', () => {
  const el = icon('wrench', fakeDoc())
  assert.equal(el.attrs.stroke, 'currentColor')
  assert.equal(el.attrs.fill, 'none')
})

test('icons are decorative, so they are hidden from screen readers', () => {
  // The accessible name lives on the button, per design section 3. An icon
  // that also announces itself would make every tool row say "wrench" twice.
  assert.equal(icon('wrench', fakeDoc()).attrs['aria-hidden'], 'true')
})

test('an unknown icon name throws rather than rendering an empty box', () => {
  assert.throws(() => icon('no-such-icon', fakeDoc()), /no-such-icon/)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/icons.test.js`
Expected: FAIL — `Cannot find module '../src/chat/icons.js'`

- [ ] **Step 3: Write the implementation**

```js
// extension/src/chat/icons.js
//
// Inline SVG icons, built as DOM nodes. Lucide path data (MIT).
//
// Emoji were used here before. They render differently on every platform,
// cannot take `currentColor`, and cannot be aligned to the grid -- so a tool
// row's glyph was a different size and colour on every machine.
//
// Path data only; no <svg> markup string is ever parsed, which keeps this on
// the right side of the no-innerHTML rule.
'use strict'

const SVG_NS = 'http://www.w3.org/2000/svg'

const PATHS = {
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  plus: ['M5 12h14', 'M12 5v14'],
  slash: ['M22 2 2 22'],
  'arrow-up': ['M12 19V5', 'm5 12 7-7 7 7'],
  gauge: ['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M22 21v-2a4 4 0 0 0-3-3.87'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'circle-dot': ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  'alert-triangle': ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z', 'M12 9v4', 'M12 17h.01'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  'file-text': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', 'M14 2v5h5', 'M10 13h4', 'M10 17h4'],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8'],
}

const ICON_NAMES = Object.keys(PATHS)

/**
 * @param {string} name  one of ICON_NAMES
 * @param {Document} doc
 * @returns {SVGElement} a 16x16 icon drawn on a 24-unit grid
 */
function icon(name, doc) {
  const paths = PATHS[name]
  if (!paths) throw new Error(`unknown icon: ${name}`)
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  // Decorative: the accessible name belongs on the control, not the glyph.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'icon')
  for (const d of paths) {
    const p = doc.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

// Uniquely named: browser <script> tags share one global scope, and a second
// file declaring the same top-level const is a SyntaxError that silently kills
// whichever script loads later.
const iconsApi = { icon, ICON_NAMES }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = iconsApi
}
if (typeof window !== 'undefined') {
  window.ClaudeIcons = iconsApi
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/icons.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use it, replacing both emoji**

In `extension/src/chat/webview.html`, add before the `webview.js` tag:

```html
  <script nonce="{{nonce}}" src="{{iconsUri}}"></script>
```

In `extension/src/chat/panel.js`, add the URI alongside the others:

```js
  const iconsUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'icons.js')))
```

and add `.split('{{iconsUri}}').join(String(iconsUri))` to the html replacement chain.

In `extension/src/chat/webview.js`, add to the destructuring at the top:

```js
  const { icon } = window.ClaudeIcons
```

Replace the emoji in `onToolUse` (was `` name.textContent = `\u{1F527} ${ev.name}` ``):

```js
    const name = document.createElement('span')
    name.className = 'card-name'
    name.appendChild(icon('wrench', document))
    const nameText = document.createElement('span')
    nameText.textContent = ev.name
    name.appendChild(nameText)
```

Replace the emoji in `activityTitle` — it returns a string, so it becomes a
node builder instead. Change `onActivity`'s title construction to:

```js
    const title = document.createElement('div')
    title.className = 'card-title'
    if (activity?.tool) {
      title.appendChild(icon('wrench', document))
      const t = document.createElement('span')
      t.textContent = `@${activity.handle ?? 'worker'} – ${activity.tool}`
      title.appendChild(t)
    } else {
      title.textContent = activityTitle(activity)
    }
```

and delete the `\u{1F527}` branch from `activityTitle`, leaving it returning
only the two text cases.

In `extension/src/chat/webview.css`, add:

```css
.icon { flex: 0 0 auto; vertical-align: -2px; }
.card-name { display: inline-flex; align-items: center; gap: 6px; }
```

Add `icons.js` to the harness page (`extension/harness/index.html`) before
`webview.js`, matching the production load order.

- [ ] **Step 6: Verify nothing broke, and look at it**

```bash
node --test
node extension/harness/shoot.js conversation
```

Expected: all tests pass (`webview-boot.test.js` proves the new global does not
kill the script). **Read `extension/harness/shots/conversation-dark-wide.png`**
and confirm the tool row shows a drawn wrench aligned with its label, not an
emoji.

- [ ] **Step 7: Commit**

```bash
git add extension/src/chat/ extension/test/icons.test.js extension/harness/index.html
git commit -m "feat(chat): draw tool icons as SVG instead of emoji"
```

---

### Task 4: Parsing `/context`

**Files:**
- Create: `extension/src/chat/context.js`
- Test: `extension/test/context.test.js`

**Interfaces:**
- Produces: `window.ClaudeContext` / `module.exports` =
  `{ parseContextReport(text), verdictFor(report), BANDS }`.
  - `parseContextReport(text)` → `{ model, usedTokens, totalTokens, pct,
    categories: [{key, label, tokens}], skills: [{name, source, tokens}],
    memoryFiles: [{type, path, tokens}] }`, or `null` if the text is not a
    context report.
  - `verdictFor(report)` → `string|null`.

**The real output**, captured from `claude --print "/context"` on 2.1.216
(2026-09-08), is the fixture. Note `1m` for one million and `k` suffixes, and
that `Memory files` appears only when a CLAUDE.md is in scope.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/context.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseContextReport, verdictFor } = require('../src/chat/context.js')

// Captured verbatim from `claude --print "/context"`, version 2.1.216.
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

test('the header line yields model, used, total and percentage', () => {
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

test('free space is not a category — it is the empty part of the bar', () => {
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
  const noMemory = REAL.replace(/### Memory Files[\s\S]*?\n\n/, '')
  const r = parseContextReport(noMemory)
  assert.deepEqual(r.memoryFiles, [])
  assert.ok(r.categories.length > 0)
})

test('text that is not a context report returns null rather than a blank panel', () => {
  assert.equal(parseContextReport('Current model: Haiku 4.5'), null)
  assert.equal(parseContextReport(''), null)
})

test('the verdict names the largest block when it dominates', () => {
  const v = verdictFor(parseContextReport(REAL))
  assert.match(v, /System tools/)
})

test('a healthy small context gets no verdict rather than invented concern', () => {
  const lean = REAL
    .replace('| System tools | 12.4k | 1.2% |', '| System tools | 1.0k | 0.1% |')
    .replace('| System tools (deferred) | 11.3k | 1.1% |', '| System tools (deferred) | 0.5k | 0.1% |')
    .replace('| Skills | 3.7k | 0.4% |', '| Skills | 0.4k | 0.1% |')
  assert.equal(verdictFor(parseContextReport(lean)), null)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/context.test.js`
Expected: FAIL — `Cannot find module '../src/chat/context.js'`

- [ ] **Step 3: Write the implementation**

```js
// extension/src/chat/context.js
//
// Parsing for the context panel. Pure -- no DOM, no vscode.
//
// `/context` is a synthetic turn: Claude Code answers it locally, with no model
// call and no cost, and the answer is a markdown report of what is occupying
// the context window. Parsing its own output is the same approach the model
// picker takes with `/model`, and for the same reason: the numbers then come
// from the installed binary rather than from an estimate that can drift.
//
// Field shapes verified against version 2.1.216 on 2026-09-08.
'use strict'

const HEADER_MODEL_RE = /\*\*Model:\*\*\s*(\S+)/
const HEADER_TOKENS_RE = /\*\*Tokens:\*\*\s*([\d.]+[km]?)\s*\/\s*([\d.]+[km]?)\s*\((\d+(?:\.\d+)?)%\)/i
const ROW_RE = /^\|(.+)\|\s*$/

/** "20.2k" -> 20200, "1m" -> 1000000, "~380" -> 380, "1.3" -> 1. */
function toTokens(raw) {
  const s = String(raw ?? '').trim().replace(/^~/, '')
  const m = /^([\d.]+)\s*([km])?$/i.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  const scale = m[2]?.toLowerCase() === 'm' ? 1e6 : m[2]?.toLowerCase() === 'k' ? 1e3 : 1
  return Math.round(n * scale)
}

/** The cells of a markdown table row, or null if the line is not one. */
function cells(line) {
  const m = ROW_RE.exec(line.trim())
  if (!m) return null
  const parts = m[1].split('|').map(s => s.trim())
  // The separator row (|---|---|) is structure, not data.
  if (parts.every(p => /^:?-{3,}:?$/.test(p))) return null
  return parts
}

/** Rows of the table under `## heading`, excluding its header row. */
function tableUnder(text, heading) {
  const lines = String(text).split('\n')
  const start = lines.findIndex(l => l.trim().toLowerCase() === heading.toLowerCase())
  if (start === -1) return []
  const rows = []
  let seenHeader = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{2,3}\s/.test(line.trim())) break // the next section
    const c = cells(line)
    if (!c) continue
    if (!seenHeader) { seenHeader = true; continue } // the table's own column names
    rows.push(c)
  }
  return rows
}

// Free space is the unfilled remainder of the bar, not a thing occupying
// context, so it is deliberately not a category.
const NOT_A_CATEGORY = new Set(['free space'])

/** Which of the six chart bands each category is drawn in. Design section 7. */
const BANDS = {
  'system prompt': 'system',
  'system tools': 'system',
  'system tools (deferred)': 'deferred',
  'mcp tools': 'mcp',
  skills: 'skills',
  'custom agents': 'skills',
  'memory files': 'memory',
  messages: 'messages',
  'autocompact buffer': 'messages',
}

function parseContextReport(text) {
  const s = String(text ?? '')
  const tokens = HEADER_TOKENS_RE.exec(s)
  if (!tokens) return null // not a context report; say so rather than render a blank panel

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
    model: HEADER_MODEL_RE.exec(s)?.[1] ?? null,
    usedTokens: toTokens(tokens[1]),
    totalTokens: toTokens(tokens[2]),
    pct: Number(tokens[3]),
    categories,
    skills,
    memoryFiles,
  }
}

// A percentage does not answer "is this working well". These thresholds do,
// and each exists because it names something a person can actually act on.
const DOMINANT_SHARE = 0.35 // one block is over a third of everything used
const BIG_MEMORY_FILE = 5000 // a single CLAUDE.md this large is worth trimming

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** One sentence of plain language, or null when there is nothing worth saying. */
function verdictFor(report) {
  if (!report) return null
  const used = report.categories.reduce((sum, c) => sum + c.tokens, 0)
  if (used === 0) return null

  const fat = report.memoryFiles.find(f => f.tokens >= BIG_MEMORY_FILE)
  if (fat) return `${fat.path} is ${fmt(fat.tokens)} on its own — trimming it frees the most context per line removed.`

  const biggest = [...report.categories].sort((a, b) => b.tokens - a.tokens)[0]
  if (biggest && biggest.tokens / used >= DOMINANT_SHARE) {
    return `${biggest.label} is ${fmt(biggest.tokens)} — ${Math.round((biggest.tokens / used) * 100)}% of everything loaded, and the largest single block.`
  }
  return null
}

const contextApi = { parseContextReport, verdictFor, BANDS }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = contextApi
}
if (typeof window !== 'undefined') {
  window.ClaudeContext = contextApi
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/context.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src/chat/context.js extension/test/context.test.js
git commit -m "feat(chat): parse /context into a per-category token report"
```

---

### Task 5: One probe queue for `/model` and `/context`

**Files:**
- Create: `extension/src/chat/probes.js`
- Test: `extension/test/probes.test.js`

**Interfaces:**
- Produces: `window.ClaudeProbes` / `module.exports` = `{ createProbeQueue }`.
  - `createProbeQueue({ send })` → `{ request(name), suppressing(), onTurnEnd(),
    pending() }` where `onTurnEnd()` returns the probe name this turn answered,
    or `null` for a real turn.

**Why this exists:** the webview currently tracks `awaitingModelList` as a lone
boolean. Adding a second probe with a second boolean would let both be true at
once, and neither could tell whose turn just ended. Worse, `/context` must fire
*at* turn-end, so without a guard its own turn-end fires another probe, forever.
One queue, one in-flight probe, and a probe's turn-end never starts another.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/probes.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createProbeQueue } = require('../src/chat/probes.js')

const spy = () => { const sent = []; return { sent, send: t => sent.push(t) } }

test('a requested probe is sent immediately when nothing is in flight', () => {
  const s = spy()
  createProbeQueue({ send: s.send }).request('model')
  assert.deepEqual(s.sent, ['/model'])
})

test('a second probe waits rather than racing the first', () => {
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('model')
  q.request('context')
  assert.deepEqual(s.sent, ['/model'], 'only one probe may be in flight')
})

test('the queued probe goes out when the first one is answered', () => {
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('model')
  q.request('context')
  assert.equal(q.onTurnEnd(), 'model')
  assert.deepEqual(s.sent, ['/model', '/context'])
})

test('a real turn ending reports no probe, so it renders normally', () => {
  const q = createProbeQueue({ send: () => {} })
  assert.equal(q.onTurnEnd(), null)
})

test('output is suppressed only while a probe is in flight', () => {
  const q = createProbeQueue({ send: () => {} })
  assert.equal(q.suppressing(), false)
  q.request('context')
  assert.equal(q.suppressing(), true)
  q.onTurnEnd()
  assert.equal(q.suppressing(), false)
})

test('requesting a probe that is already in flight does not queue a duplicate', () => {
  const s = spy()
  const q = createProbeQueue({ send: s.send })
  q.request('context')
  q.request('context')
  q.onTurnEnd()
  assert.deepEqual(s.sent, ['/context'], 'the same probe must not be sent twice')
})

test('an unknown probe name throws rather than sending a bare slash', () => {
  assert.throws(() => createProbeQueue({ send: () => {} }).request('nope'), /nope/)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/probes.test.js`
Expected: FAIL — `Cannot find module '../src/chat/probes.js'`

- [ ] **Step 3: Write the implementation**

```js
// extension/src/chat/probes.js
//
// Slash commands the chat runs for its own information rather than because the
// user asked: `/model` for the picker, `/context` for the budget panel. Both
// are synthetic turns -- answered locally, no model call, no cost -- but they
// are still turns, and the orchestrator serves one at a time.
//
// This exists because two independent "am I waiting for X" booleans cannot
// answer "whose turn just ended", and because /context is fired AT turn-end:
// without a guard, the probe's own turn-end fires another probe forever.
'use strict'

const COMMANDS = { model: '/model', context: '/context' }

function createProbeQueue({ send }) {
  let inFlight = null
  const queued = []

  function dispatch() {
    if (inFlight || queued.length === 0) return
    inFlight = queued.shift()
    send(COMMANDS[inFlight])
  }

  return {
    /** Ask for a probe. Sent now if the line is clear, queued if not. */
    request(name) {
      if (!COMMANDS[name]) throw new Error(`unknown probe: ${name}`)
      // Already in flight or already waiting: asking twice must not send twice.
      if (inFlight === name || queued.includes(name)) return
      queued.push(name)
      dispatch()
    },

    /** True while a probe's output is arriving, which must not reach the transcript. */
    suppressing() {
      return inFlight !== null
    },

    /**
     * @returns {string|null} the probe this turn answered, or null if this was
     *   a real conversational turn that should render normally.
     */
    onTurnEnd() {
      const answered = inFlight
      inFlight = null
      dispatch()
      return answered
    },

    pending() {
      return inFlight
    },
  }
}

const probesApi = { createProbeQueue }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = probesApi
}
if (typeof window !== 'undefined') {
  window.ClaudeProbes = probesApi
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/probes.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src/chat/probes.js extension/test/probes.test.js
git commit -m "feat(chat): one queue for the /model and /context self-probes"
```

---

### Task 6: The context chip and panel

**Files:**
- Modify: `extension/src/chat/webview.html` (chip, panel markup, script tags)
- Modify: `extension/src/chat/panel.js` (two new webview URIs)
- Modify: `extension/src/chat/webview.js` (probe queue, panel rendering)
- Modify: `extension/src/chat/webview.css` (chip row, bar, table)
- Modify: `extension/harness/index.html`, `extension/harness/fixtures.js`
- Test: `extension/test/webview-boot.test.js` (extend), screenshots

**Interfaces:**
- Consumes: `parseContextReport`, `verdictFor` (Task 4); `createProbeQueue`
  (Task 5); `icon` (Task 3).

**Also fixes, found by the first harness screenshot:** `showModelOptions` sets
`modelPickerEl.hidden = list.length > 0`, so once the session-start probe
answers, the styled chip is replaced *permanently* by a bare native `<select>`.
That is what the composer looks like on every launch today. The select must
become a popover the chip owns, not a replacement for it: keep the chip
visible showing the current model, and reveal the list on click.

- [ ] **Step 1: Add the markup**

In `webview.html`, replace the `composer-toolbar-left` block with:

```html
      <div class="composer-toolbar-left">
        <button id="model-picker" class="chip" type="button" title="Change model">model: (unknown)</button>
        <select id="model-select" hidden></select>
        <button id="context-chip" class="chip" type="button" aria-expanded="false"
                aria-controls="context-panel" title="Context usage">context: —</button>
      </div>
```

and add the panel immediately above `<div class="composer">`:

```html
  <div id="context-panel" class="panel" hidden role="region" aria-label="Context usage">
    <div class="panel-head">
      <span id="context-title" class="panel-title">Context</span>
      <span id="context-total" class="panel-total"></span>
    </div>
    <div id="context-bar" class="bar" role="img" aria-labelledby="context-total"></div>
    <div id="context-legend" class="legend"></div>
    <div id="context-verdict" class="verdict" hidden></div>
    <div id="context-tables"></div>
  </div>
```

Add script tags for `{{contextUri}}` and `{{probesUri}}` before `{{scriptUri}}`,
and wire both in `panel.js` exactly as `modelUri` is wired.

- [ ] **Step 2: Write the failing test**

Add to `extension/test/webview-boot.test.js`:

```js
test('the context chip is wired and toggles its panel', () => {
  const { get } = bootWebview()
  const chip = get('context-chip')
  const click = chip.listeners.get('click')
  assert.ok(click && click.length > 0, 'the context chip must have a click handler')
  const panel = get('context-panel')
  panel.hidden = true
  click[0]()
  assert.equal(panel.hidden, false, 'clicking must reveal the panel')
})

test('a real turn ending probes for context exactly once, not in a loop', () => {
  const { posted } = bootWebview()
  const handler = lastMessageHandler()
  handler({ data: { type: 'stream', event: { kind: 'turn-end', text: '', turns: 1, costUsd: 0 } } })
  const first = posted.filter(m => m.text === '/context').length
  assert.equal(first, 1, 'a finished turn should ask for context once')

  // The probe's own turn-end must not start another probe, or the chat spins
  // forever running /context against itself.
  handler({ data: { type: 'stream', event: { kind: 'turn-end', text: '## Context Usage\n\n**Tokens:** 1k / 1m (0%)\n' } } })
  assert.equal(posted.filter(m => m.text === '/context').length, first)
})
```

This needs the fake DOM to record `window.addEventListener('message')`. Add to
`bootWebview`'s `window`: `addEventListener: (ev, fn) => { (msgHandlers[ev] ??= []).push(fn) }`
with `const msgHandlers = {}` above it, return `msgHandlers` from `bootWebview`,
and add a `lastMessageHandler()` helper that reads `msgHandlers.message.at(-1)`.

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test extension/test/webview-boot.test.js`
Expected: FAIL — no click handler on `context-chip`.

- [ ] **Step 4: Implement in `webview.js`**

Replace the `awaitingModelList` machinery with the queue, and add rendering:

```js
  const { parseContextReport, verdictFor } = window.ClaudeContext
  const { createProbeQueue } = window.ClaudeProbes

  const probes = createProbeQueue({ send: text => vscode.postMessage({ type: 'input', text }) })

  const contextChipEl = document.getElementById('context-chip')
  const contextPanelEl = document.getElementById('context-panel')
  const contextTotalEl = document.getElementById('context-total')
  const contextBarEl = document.getElementById('context-bar')
  const contextLegendEl = document.getElementById('context-legend')
  const contextVerdictEl = document.getElementById('context-verdict')
  const contextTablesEl = document.getElementById('context-tables')

  // Six bands, six chart tokens -- the ceiling the design sets, because a
  // part-to-whole display stops being readable past about six colours.
  const BAND_ORDER = ['system', 'deferred', 'mcp', 'skills', 'memory', 'messages']

  function fmtTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  }

  function renderContext(report) {
    if (!report) return
    contextChipEl.textContent = `context: ${fmtTokens(report.usedTokens)} · ${report.pct}%`
    contextTotalEl.textContent =
      `${fmtTokens(report.usedTokens)} of ${fmtTokens(report.totalTokens)} used · ${report.pct}%`

    // Sum categories into bands, so nine /context categories become six bars.
    const banded = new Map()
    for (const c of report.categories) {
      const key = BAND_ORDER.includes(c.key) ? c.key : 'messages'
      banded.set(key, (banded.get(key) ?? 0) + c.tokens)
    }
    const used = [...banded.values()].reduce((a, b) => a + b, 0) || 1

    contextBarEl.replaceChildren()
    for (const band of BAND_ORDER) {
      const tokens = banded.get(band) ?? 0
      if (!tokens) continue
      const seg = document.createElement('div')
      seg.className = `seg seg-${band}`
      seg.style.width = `${(tokens / report.totalTokens) * 100}%`
      contextBarEl.appendChild(seg)
    }

    // The legend is also the accessible reading of the bar: a colour and a
    // length alone convey nothing to a screen reader, or to anyone who cannot
    // separate two of the six hues.
    contextLegendEl.replaceChildren()
    for (const c of [...report.categories].sort((a, b) => b.tokens - a.tokens)) {
      if (!c.tokens) continue
      const item = document.createElement('span')
      item.className = 'legend-item'
      const sw = document.createElement('i')
      sw.className = `swatch seg-${BAND_ORDER.includes(c.key) ? c.key : 'messages'}`
      const label = document.createElement('span')
      label.textContent = `${c.label} ${fmtTokens(c.tokens)}`
      item.appendChild(sw)
      item.appendChild(label)
      contextLegendEl.appendChild(item)
    }

    const verdict = verdictFor(report)
    contextVerdictEl.hidden = !verdict
    contextVerdictEl.textContent = verdict ?? ''

    contextTablesEl.replaceChildren()
    appendDetail('Skills', report.skills.map(s => [s.name, s.source, fmtTokens(s.tokens)]))
    appendDetail('Memory files', report.memoryFiles.map(f => [f.path, f.type, fmtTokens(f.tokens)]))
  }

  function appendDetail(title, rows) {
    if (!rows.length) return
    const d = document.createElement('details')
    d.className = 'detail'
    const s = document.createElement('summary')
    s.textContent = `${title} · ${rows.length}`
    d.appendChild(s)
    for (const cols of rows) {
      const row = document.createElement('div')
      row.className = 'detail-row'
      for (const text of cols) {
        const cell = document.createElement('span')
        cell.textContent = text
        row.appendChild(cell)
      }
      d.appendChild(row)
    }
    contextTablesEl.appendChild(d)
  }

  contextChipEl.addEventListener('click', () => {
    const open = contextPanelEl.hidden
    contextPanelEl.hidden = !open
    contextChipEl.setAttribute('aria-expanded', String(open))
    if (open) probes.request('context')
  })
```

Rewrite `onTurnEnd` to route through the queue:

```js
  function onTurnEnd(ev) {
    const answered = probes.onTurnEnd()
    endBubble()
    currentThinkingBody = null
    setStatus('')

    if (answered === 'model') {
      const { current, available } = parseModelList(ev.text ?? '')
      if (current) setCurrentModel(current)
      if (available.length) showModelOptions(available)
      return
    }
    if (answered === 'context') {
      renderContext(parseContextReport(ev.text ?? ''))
      return
    }

    const cost = typeof ev.costUsd === 'number' ? ev.costUsd : 0
    appendMsg('system', `turn ended · ${ev.turns} turn(s) · $${cost.toFixed(4)}`)
    // Refresh the budget after real work, when the process is idle anyway.
    // A probe's own turn-end took the branch above, so this cannot recur.
    probes.request('context')
  }
```

Replace `if (awaitingModelList) return` in `onText` with
`if (probes.suppressing()) return`, and in `modelPickerEl`'s click handler and
`onSessionEstablished` replace the `awaitingModelList = true; postMessage(...)`
pairs with `probes.request('model')`. Delete the `awaitingModelList` and
`modelProbeSent` variables; guard the session probe with a local
`sessionProbed` boolean so it still fires only once.

- [ ] **Step 5: Style it**

Add to `webview.css` — every colour a `var()` with a fallback, per design §2:

```css
.chip {
  display: inline-flex; align-items: center; gap: 4px; height: 22px;
  padding: 0 8px; border: none; border-radius: 3px; font-size: 11px;
  font-family: var(--vscode-font-family);
  background: var(--vscode-badge-background, rgba(127,127,127,.25));
  color: var(--vscode-badge-foreground, inherit);
  cursor: pointer; transition: background 120ms ease;
}
.chip:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.35)); }
.chip:focus-visible { outline: 1px solid var(--vscode-focusBorder, #0078d4); outline-offset: 2px; }

.panel {
  border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35));
  border-radius: 3px; padding: 12px; margin: 0 0 8px;
  background: var(--vscode-editorWidget-background, rgba(127,127,127,.06));
}
.panel-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.panel-title { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
               color: var(--vscode-descriptionForeground, #999); }
.panel-total { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }

.bar { display: flex; height: 10px; border-radius: 2px; overflow: hidden;
       border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); }
.seg-system   { background: var(--vscode-charts-blue,   #3794ff); }
.seg-deferred { background: var(--vscode-charts-purple, #b180d7); }
.seg-mcp      { background: var(--vscode-charts-orange, #d18616); }
.seg-skills   { background: var(--vscode-charts-yellow, #cca700); }
.seg-memory   { background: var(--vscode-charts-green,  #89d185); }
.seg-messages { background: var(--vscode-charts-red,    #f14c4c); }

.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: 11px;
          color: var(--vscode-descriptionForeground, #999); }
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }

.verdict { margin-top: 10px; padding-top: 10px; font-size: 12px;
           border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.35)); }
.detail { margin-top: 8px; font-size: 11px; }
.detail-row { display: flex; gap: 12px; padding: 2px 0 2px 16px;
              font-family: var(--vscode-editor-font-family, monospace); }
.detail-row span:first-child { flex: 1; overflow-wrap: anywhere; }
.detail-row span:not(:first-child) { color: var(--vscode-descriptionForeground, #999); flex: 0 0 auto; }

@media (prefers-reduced-motion: reduce) { * { transition-duration: .01ms !important; } }
```

Delete the now-unused `.model-chip` rule.

- [ ] **Step 6: Add a fixture and look at it**

Add to `extension/harness/fixtures.js`, using the same captured `/context` text
as `extension/test/context.test.js`:

```js
  'context-panel': [
    stream({ kind: 'text', text: 'Here is where your context is going.\n' }),
    stream({ kind: 'turn-end', text: '', turns: 1, costUsd: 0.01 }),
    // The probe's answer, as the orchestrator would return it.
    stream({ kind: 'turn-end', text: REAL_CONTEXT_OUTPUT }),
  ],
```

with `REAL_CONTEXT_OUTPUT` defined at the top of the file as that captured text,
and add `context.js`, `probes.js` and `icons.js` script tags to
`extension/harness/index.html` plus the panel markup from Step 1.

```bash
node --test
node extension/harness/shoot.js context-panel
```

Expected: all tests pass. **Read all four PNGs** —
`context-panel-{dark,light}-{wide,narrow}.png` — and check against design §9:
the bar segments are distinguishable in both themes, the legend labels are
legible, the narrow shot does not scroll horizontally, and the light theme's
text clears 4.5:1.

- [ ] **Step 7: Commit**

```bash
git add extension/src/chat/ extension/harness/ extension/test/webview-boot.test.js
git commit -m "feat(chat): context budget chip and by-category breakdown panel"
```

---

## Verification

Before calling this phase done:

```bash
node --test                        # expect 549 + new tests, 0 fail, 1 skip
node extension/harness/shoot.js    # every fixture, both themes, both widths
```

Then read every PNG in `extension/harness/shots/` and check each against the
design §9 checklist. The screenshots are the deliverable's proof; a passing test
suite says the parsing is right, not that the panel is legible.

**Left for the user's own pass, because a harness cannot show it:** that the
chip appears in a real Cursor window, that `/context` returns what is expected
over the long-lived orchestrator process (rather than the one-shot `--print`
this was captured from), and that the panel refreshes at the right moments
during a real conversation.
