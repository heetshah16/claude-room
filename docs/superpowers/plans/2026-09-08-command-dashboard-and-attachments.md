# Command Dashboard and Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `/` in the composer opens a filtered dashboard of the slash
commands that actually work here plus every skill installed on the machine, and
`+` attaches a file — picked, dropped, or pasted, images included.

**Architecture:** Two pure modules do the thinking — a registry of
print-mode-verified commands, and a discovery pass that reads `SKILL.md`
frontmatter. The extension host owns the filesystem (skill scan, writing pasted
images); the webview owns the popover and keyboard handling and receives
everything else over `postMessage`.

**Tech Stack:** CommonJS, no build step, no runtime dependencies. `node --test`.
Screenshots via `node extension/harness/shoot.js`.

**Spec:** [`docs/design-system.md`](../../design-system.md) — §1 the chip row,
the command dashboard and attachments; §3 the accessibility floor.

## Global Constraints

- **CommonJS only** in `extension/`; `extension/package.json` must never gain a
  `"type"` field.
- **Zero runtime dependencies.**
- **Never `innerHTML`.** Build nodes, set `textContent`. A skill description is
  third-party text from a plugin author — untrusted, like model output.
- **No hex literal in `webview.css`**; every colour is `var(--vscode-*, fallback)`.
- **No emoji as an icon.** Use `icon(name, document)` from `chat/icons.js`.
- **Webview scripts share one global scope** — every `src/chat/*.js` file
  declares uniquely and ends with the dual `module.exports` / `window.ClaudeX`
  export. `chat-globals.test.js` and `webview-boot.test.js` read the module list
  out of `webview.html`, so a new module needs only a script tag and a
  `panel.js` uri.
- Tests never spawn `claude` or `opencode`, and never open a non-loopback socket.

## Verified before planning

Probed against `claude` 2.1.216 on 2026-09-08. This is the whole basis for
what the dashboard may offer — offering a command that answers "isn't available
in this environment" is worse than omitting it.

| Command | Result |
|---|---|
| `/model` | **works** — lists and switches |
| `/context` | **works** — the category report |
| `/cost` | **works** — subscription usage, session and weekly limits |
| `/mcp` | **works** — "5 MCP server(s): 0 connected, 3 connecting…" |
| `/help` | *"isn't available in this environment"* |
| `/status` | *"isn't available in this environment"* |
| `/permissions` | *"isn't available in this environment"* |
| `/todos` | *"Unknown command"* |
| `/agents` | answers, but only to say the wizard was removed — not an action |

Skill layout, also verified: **neither `.claude/skills` nor `~/.claude/skills`
exists on this machine.** All 28 skills live at
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`
and are invoked as `plugin:skill`. Scanning only the two documented directories
would find nothing at all here. Frontmatter is `---` fenced, every skill has
`name` and `description`, 6 use double quotes, none has a multi-line
description, and some carry `argument-hint` such as `"[platform] [style]"`.

---

### Task 1: The command registry

**Files:**
- Create: `extension/src/chat/commands.js`
- Test: `extension/test/commands.test.js`

**Interfaces:**
- Produces: `window.ClaudeCommands` / `module.exports` =
  `{ COMMANDS, filterEntries }`.
  - `COMMANDS`: `{name, summary, sends}[]` — `sends: true` means selecting it
    runs immediately; `false` means insert and let the user finish the line.
  - `filterEntries(entries, query)` → the subset matching, best first.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/commands.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { COMMANDS, filterEntries } = require('../src/chat/commands.js')

test('only print-mode-verified commands are offered', () => {
  const names = COMMANDS.map(c => c.name)
  for (const ok of ['/model', '/context', '/cost', '/mcp']) {
    assert.ok(names.includes(ok), `${ok} is verified to work and must be offered`)
  }
  // Each of these was probed and answers "isn't available in this
  // environment" or "Unknown command". Offering one is worse than omitting it.
  for (const bad of ['/help', '/status', '/permissions', '/todos', '/agents']) {
    assert.ok(!names.includes(bad), `${bad} does not work in print mode and must not be offered`)
  }
})

test('every command carries a summary, so the list is readable', () => {
  for (const c of COMMANDS) {
    assert.equal(typeof c.summary, 'string')
    assert.ok(c.summary.length > 0, `${c.name} needs a summary`)
    assert.equal(typeof c.sends, 'boolean')
  }
})

test('filtering matches on name', () => {
  const out = filterEntries(COMMANDS, 'mod')
  assert.equal(out[0].name, '/model')
})

test('filtering matches on summary too, so plain words find things', () => {
  const entries = [{ name: '/context', summary: 'what is filling the context window' }]
  assert.equal(filterEntries(entries, 'filling').length, 1)
})

test('a prefix match outranks a match in the middle of a word', () => {
  const entries = [
    { name: '/xcost', summary: 'not this one' },
    { name: '/cost', summary: 'this one' },
  ]
  assert.equal(filterEntries(entries, 'cost')[0].name, '/cost')
})

test('an empty query returns everything, so opening the menu shows the menu', () => {
  assert.equal(filterEntries(COMMANDS, '').length, COMMANDS.length)
})

test('filtering is case-insensitive', () => {
  assert.equal(filterEntries(COMMANDS, 'MODEL')[0].name, '/model')
})

test('a query matching nothing returns nothing rather than everything', () => {
  assert.deepEqual(filterEntries(COMMANDS, 'zzzznope'), [])
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/commands.test.js`
Expected: FAIL — `Cannot find module '../src/chat/commands.js'`

- [ ] **Step 3: Write the implementation**

```js
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
// Verified NOT working, and deliberately absent: /help /status /permissions
// /todos, and /agents (which answers only to say its wizard was removed).
'use strict'

const COMMANDS = [
  { name: '/model', summary: 'Show or switch the model for this session', sends: true },
  { name: '/context', summary: 'What is filling the context window', sends: true },
  { name: '/cost', summary: 'Subscription usage and limits', sends: true },
  { name: '/mcp', summary: 'MCP server connection status', sends: true },
]

/**
 * Entries matching `query`, best first.
 *
 * Ranked rather than merely filtered: with a name and a summary both matching,
 * a menu that ignores where the hit landed puts "/xcost" above "/cost" for the
 * query "cost", which reads as broken.
 */
function filterEntries(entries, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return entries.slice()

  const scored = []
  for (const e of entries) {
    const name = String(e.name ?? '').toLowerCase()
    const summary = String(e.summary ?? '').toLowerCase()
    // A leading slash or colon is punctuation, not something the user types to
    // find "model", so a match just past it still counts as a prefix.
    const bare = name.replace(/^[/:]+/, '')

    let score
    if (bare.startsWith(q) || name.startsWith(q)) score = 0
    else if (name.includes(q)) score = 1
    else if (summary.includes(q)) score = 2
    else continue

    scored.push({ e, score })
  }
  // Stable within a score band: the registry's own order is meaningful.
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map(s => s.e)
}

const commandsApi = { COMMANDS, filterEntries }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = commandsApi
}
if (typeof window !== 'undefined') {
  window.ClaudeCommands = commandsApi
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/commands.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src/chat/commands.js extension/test/commands.test.js
git commit -m "feat(chat): registry of the slash commands that work headless"
```

---

### Task 2: Skill discovery

**Files:**
- Create: `extension/src/skills.js`
- Test: `extension/test/skills.test.js`

**Interfaces:**
- Produces: `module.exports = { parseFrontmatter, skillDirs, discoverSkills }`.
  - `parseFrontmatter(text)` → `{name, description, 'argument-hint'?}` or `null`
  - `skillDirs({ workspace, home })` → absolute directories to scan
  - `discoverSkills({ workspace, home, fs })` → `{name, summary, hint, sends}[]`

Extension-host side (it touches the filesystem), so `module.exports` only — no
`window` half. The webview receives the finished list over `postMessage`.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/skills.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseFrontmatter, skillDirs, discoverSkills } = require('../src/skills.js')

test('frontmatter yields the name and description', () => {
  const fm = parseFrontmatter('---\nname: brainstorming\ndescription: Explores intent\n---\n\n# Body\n')
  assert.equal(fm.name, 'brainstorming')
  assert.equal(fm.description, 'Explores intent')
})

test('double-quoted values are unwrapped -- 6 of 28 installed skills use them', () => {
  const fm = parseFrontmatter('---\nname: design\ndescription: "Brand identity, tokens"\nargument-hint: "[type] [context]"\n---\n')
  assert.equal(fm.description, 'Brand identity, tokens')
  assert.equal(fm['argument-hint'], '[type] [context]')
})

test('a colon inside the value is kept, since descriptions contain them', () => {
  const fm = parseFrontmatter('---\nname: x\ndescription: Use when: you need it\n---\n')
  assert.equal(fm.description, 'Use when: you need it')
})

test('a file with no frontmatter is null, not a half-built entry', () => {
  assert.equal(parseFrontmatter('# Just a heading\n'), null)
  assert.equal(parseFrontmatter(''), null)
})

test('CRLF frontmatter parses -- this repo is developed on Windows', () => {
  const fm = parseFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\n')
  assert.equal(fm.name, 'x')
  assert.equal(fm.description, 'y')
})

test('the plugin cache is scanned, not just the two documented directories', () => {
  // Verified on the development machine: neither .claude/skills nor
  // ~/.claude/skills exists, and all 28 installed skills live under the plugin
  // cache. Scanning only the documented pair finds nothing at all.
  const dirs = skillDirs({ workspace: '/repo', home: '/home/u' })
  assert.ok(dirs.some(d => d.includes('plugins') && d.includes('cache')),
    'the plugin cache must be scanned')
  assert.ok(dirs.some(d => d.startsWith('/repo')), 'the workspace must be scanned')
  assert.ok(dirs.some(d => d.startsWith('/home/u')), 'the user directory must be scanned')
})

test('discovery names a plugin skill the way it is invoked', () => {
  const files = {
    '/home/u/.claude/plugins/cache/official/superpowers/6.3.0/skills/brainstorming/SKILL.md':
      '---\nname: brainstorming\ndescription: Explores intent\n---\n',
  }
  const found = discoverSkills({ workspace: '/repo', home: '/home/u', fs: fakeFs(files) })
  assert.equal(found.length, 1)
  assert.equal(found[0].name, '/superpowers:brainstorming')
  assert.equal(found[0].summary, 'Explores intent')
  // Skills usually need an argument, so selecting one inserts rather than sends.
  assert.equal(found[0].sends, false)
})

test('a workspace skill is named without a plugin prefix', () => {
  const files = { '/repo/.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship it\n---\n' }
  const found = discoverSkills({ workspace: '/repo', home: '/home/u', fs: fakeFs(files) })
  assert.equal(found[0].name, '/deploy')
})

test('an argument hint is carried through for the composer to show', () => {
  const files = {
    '/repo/.claude/skills/banner/SKILL.md':
      '---\nname: banner\ndescription: Make one\nargument-hint: "[platform] [style]"\n---\n',
  }
  assert.equal(discoverSkills({ workspace: '/repo', home: '/home/u', fs: fakeFs(files) })[0].hint,
    '[platform] [style]')
})

test('a missing directory yields no skills rather than throwing', () => {
  // The directory layout is not a published contract; degrade, never crash.
  const found = discoverSkills({ workspace: '/nope', home: '/nope', fs: fakeFs({}) })
  assert.deepEqual(found, [])
})

test('a SKILL.md that cannot be read is skipped, not fatal', () => {
  const fs = fakeFs({ '/repo/.claude/skills/bad/SKILL.md': null })
  assert.deepEqual(discoverSkills({ workspace: '/repo', home: '/h', fs }), [])
})

test('skills come back sorted, so the menu order is stable between runs', () => {
  const files = {
    '/repo/.claude/skills/zebra/SKILL.md': '---\nname: zebra\ndescription: z\n---\n',
    '/repo/.claude/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: a\n---\n',
  }
  const names = discoverSkills({ workspace: '/repo', home: '/h', fs: fakeFs(files) }).map(s => s.name)
  assert.deepEqual(names, ['/alpha', '/zebra'])
})

/**
 * A filesystem of exactly the shape discoverSkills uses: directory listings
 * derived from the paths, and readFile returning the mapped content (null
 * meaning "exists but unreadable").
 */
function fakeFs(files) {
  const paths = Object.keys(files)
  return {
    existsSync: p => paths.some(f => f === p || f.startsWith(p.replace(/\/$/, '') + '/')),
    readdirSync(dir, opts) {
      const prefix = dir.replace(/\/$/, '') + '/'
      const names = new Set()
      for (const f of paths) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length).split('/')
        names.add(rest[0] + (rest.length > 1 ? '/' : ''))
      }
      return [...names].map(n => ({
        name: n.replace(/\/$/, ''),
        isDirectory: () => n.endsWith('/'),
        isFile: () => !n.endsWith('/'),
      }))
    },
    readFileSync(p) {
      if (!(p in files) || files[p] === null) throw new Error('unreadable')
      return files[p]
    },
  }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/skills.test.js`
Expected: FAIL — `Cannot find module '../src/skills.js'`

- [ ] **Step 3: Write the implementation**

```js
// extension/src/skills.js
//
// Finding the skills installed on this machine, so the composer's `/` menu can
// offer them.
//
// The documented locations are `<workspace>/.claude/skills` and
// `~/.claude/skills`. On the machine this was built on NEITHER EXISTS, and all
// 28 installed skills live under the plugin cache:
//
//   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
//
// invoked as `plugin:skill`. Scanning only the documented pair would have
// shipped a menu that is empty for everyone who gets their skills from
// plugins, which is the common case.
//
// None of this layout is a published contract, so every step degrades to "no
// skills found" rather than throwing.
'use strict'
const nodeFs = require('node:fs')
const { join, sep } = require('node:path')

/**
 * The `---` fenced block at the top of a SKILL.md.
 *
 * Deliberately not a YAML parser: the frontmatter here is flat `key: value`
 * lines, and all 28 installed skills fit that. Only the first colon splits, so
 * a description containing one survives.
 *
 * @returns {Record<string,string>|null} null when there is no frontmatter.
 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))
  if (!m) return null
  const out = {}
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at === -1) continue
    const key = line.slice(0, at).trim()
    if (!/^[A-Za-z][\w-]*$/.test(key)) continue
    let value = line.slice(at + 1).trim()
    // 6 of 28 wrap the value in double quotes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return Object.keys(out).length ? out : null
}

/** Every root worth scanning for a SKILL.md, deepest-specific first. */
function skillDirs({ workspace, home }) {
  const dirs = []
  if (workspace) dirs.push(join(workspace, '.claude', 'skills'))
  if (home) {
    dirs.push(join(home, '.claude', 'skills'))
    dirs.push(join(home, '.claude', 'plugins', 'cache'))
  }
  return dirs
}

/** Every SKILL.md under `dir`, to a bounded depth. */
function findSkillFiles(dir, fs, depth = 0, out = []) {
  // The plugin cache is marketplace/plugin/version/skills/name/SKILL.md -- six
  // levels. The bound stops a symlink loop or an unexpectedly deep tree from
  // walking the whole disk on every keystroke.
  if (depth > 7 || out.length > 500) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out // absent or unreadable: not an error, just no skills here
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) findSkillFiles(p, fs, depth + 1, out)
    else if (e.name === 'SKILL.md') out.push(p)
  }
  return out
}

/**
 * The plugin a cached skill belongs to, so it can be named the way it is
 * invoked. `.../plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`
 * -> `<plugin>`. Null for anything not in that shape.
 */
function pluginOf(path) {
  const parts = String(path).split(/[\\/]/)
  const cache = parts.lastIndexOf('cache')
  if (cache === -1) return null
  const plugin = parts[cache + 2]
  return plugin && parts.includes('skills') ? plugin : null
}

/**
 * @returns {{name: string, summary: string, hint: string, sends: boolean}[]}
 *   sorted by name, so the menu does not reshuffle between runs.
 */
function discoverSkills({ workspace, home, fs = nodeFs }) {
  const found = new Map() // name -> entry, so a duplicate name resolves once
  for (const dir of skillDirs({ workspace, home })) {
    for (const file of findSkillFiles(dir, fs)) {
      let fm
      try {
        fm = parseFrontmatter(fs.readFileSync(file, 'utf8'))
      } catch {
        continue // unreadable: skip this one, keep the rest
      }
      if (!fm?.name) continue
      const plugin = pluginOf(file)
      const name = `/${plugin ? `${plugin}:${fm.name}` : fm.name}`
      if (found.has(name)) continue
      found.set(name, {
        name,
        summary: fm.description ?? '',
        hint: fm['argument-hint'] ?? '',
        // A skill usually needs an argument, so selecting one puts it in the
        // composer and leaves the caret there rather than sending immediately.
        sends: false,
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

module.exports = { parseFrontmatter, skillDirs, discoverSkills, pluginOf }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/skills.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove it against the real machine, not just fakes**

A fake filesystem proves the algorithm; it does not prove the layout assumption
that the whole feature rests on. Add to `extension/test/skills.test.js`:

```js
const os = require('node:os')

test('the real machine has skills, or the layout assumption is wrong', { skip: !process.env.SKILLS_LIVE }, () => {
  // Opt-in (SKILLS_LIVE=1) because it reads the developer's own home
  // directory, which no ordinary test run should depend on.
  const found = discoverSkills({ workspace: process.cwd(), home: os.homedir() })
  assert.ok(found.length > 0, 'no skills discovered on this machine')
  assert.ok(found.every(s => s.name.startsWith('/')), 'every entry is invocable as typed')
})
```

Run it once by hand: `SKILLS_LIVE=1 node --test extension/test/skills.test.js`
Expected: PASS, and the count should be around 28 on the development machine.

- [ ] **Step 6: Commit**

```bash
git add extension/src/skills.js extension/test/skills.test.js
git commit -m "feat(extension): discover installed skills, including plugin ones"
```

---

### Task 3: The dashboard popover

**Files:**
- Modify: `extension/src/chat/webview.html` (dashboard markup, script tags)
- Modify: `extension/src/chat/panel.js` (uris; post the skill list in)
- Modify: `extension/src/chat/webview.js` (open/filter/keyboard/accept)
- Modify: `extension/src/chat/webview.css`
- Modify: `extension/src/extension.js` (discover skills, post them to the panel)
- Modify: `extension/harness/index.html`, `extension/harness/fixtures.js`
- Test: `extension/test/webview-boot.test.js`

**Interfaces:**
- Consumes: `COMMANDS`, `filterEntries` (Task 1); `discoverSkills` (Task 2);
  `icon` (from `chat/icons.js`).
- New inbound message: `{ type: 'skills', skills: [...] }`.

**Behaviour.** The composer *is* the filter — there is no second input. Typing
`/` at position 0 opens the dashboard; every keystroke after it filters;
Backspace past the `/` closes it. Up/Down move a highlight, Enter accepts, Esc
closes. The textarea keeps DOM focus throughout, so the list is a
`role="listbox"` of `role="option"` rows pointed at by `aria-activedescendant`.

- [ ] **Step 1: Add the markup**

In `webview.html`, immediately before `<div class="composer">`:

```html
  <div id="dashboard" class="dash" hidden>
    <div id="dash-list" class="dash-list" role="listbox" aria-label="Commands and skills"></div>
    <div id="dash-empty" class="dash-empty" hidden>No command or skill matches</div>
  </div>
```

In the composer toolbar, before the model chip:

```html
        <button id="attach-btn" class="icon-btn" type="button" aria-label="Attach a file" title="Attach a file"></button>
        <button id="dash-btn" class="icon-btn" type="button" aria-label="Commands and skills" title="Commands and skills"></button>
```

Add `{{commandsUri}}` as a script tag and wire it in `panel.js` beside the
others. Give the textarea `aria-autocomplete="list"` and
`aria-controls="dash-list"`.

- [ ] **Step 2: Write the failing test**

Add to `extension/test/webview-boot.test.js`:

```js
test('typing a slash at the start of the composer opens the dashboard', () => {
  const { get } = bootWebview()
  const input = get('input')
  const dash = get('dashboard')
  dash.hidden = true
  input.value = '/'
  input.selectionStart = 1
  for (const fn of input.listeners.get('input') ?? []) fn({})
  assert.equal(dash.hidden, false, 'a leading slash must open the dashboard')
})

test('a slash mid-sentence does not open the dashboard', () => {
  // "and/or" is prose, not a command.
  const { get } = bootWebview()
  const input = get('input')
  const dash = get('dashboard')
  dash.hidden = true
  input.value = 'and/or'
  input.selectionStart = 6
  for (const fn of input.listeners.get('input') ?? []) fn({})
  assert.equal(dash.hidden, true)
})

test('Enter accepts the highlighted entry instead of sending the raw text', () => {
  const { get, posted } = bootWebview()
  const input = get('input')
  input.value = '/mod'
  input.selectionStart = 4
  for (const fn of input.listeners.get('input') ?? []) fn({})
  let defaultPrevented = false
  input.listeners.get('keydown')[0]({ key: 'Enter', shiftKey: false, preventDefault() { defaultPrevented = true } })
  assert.ok(defaultPrevented, 'Enter must be consumed by the open dashboard')
  assert.ok(!posted.some(m => m.text === '/mod'), 'the half-typed filter must never be sent')
})

test('Escape closes the dashboard and leaves the text alone', () => {
  const { get } = bootWebview()
  const input = get('input')
  input.value = '/mo'
  input.selectionStart = 3
  for (const fn of input.listeners.get('input') ?? []) fn({})
  input.listeners.get('keydown')[0]({ key: 'Escape', preventDefault() {} })
  assert.equal(get('dashboard').hidden, true)
  assert.equal(input.value, '/mo', 'Escape must not eat what was typed')
})

test('skills posted from the host join the list', () => {
  const { get, handleMessage } = bootWebview()
  handleMessage({ data: { type: 'skills', skills: [{ name: '/superpowers:brainstorming', summary: 'Explores intent', hint: '', sends: false }] } })
  const input = get('input')
  input.value = '/brain'
  input.selectionStart = 6
  for (const fn of input.listeners.get('input') ?? []) fn({})
  assert.equal(get('dashboard').hidden, false)
})
```

`bootWebview` needs `selectionStart` on the fake element (add
`selectionStart: 0` to `fakeElement`) and a `handleMessage` helper that calls
the registered `message` listener — return `handleMessage: msg => msgHandlers.message.forEach(fn => fn(msg))` alongside the existing values.

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test extension/test/webview-boot.test.js`
Expected: FAIL — no `input` listener opens the dashboard.

- [ ] **Step 4: Implement in `webview.js`**

```js
  const { COMMANDS, filterEntries } = window.ClaudeCommands

  const dashEl = document.getElementById('dashboard')
  const dashListEl = document.getElementById('dash-list')
  const dashEmptyEl = document.getElementById('dash-empty')
  const dashBtnEl = document.getElementById('dash-btn')
  const attachBtnEl = document.getElementById('attach-btn')

  // Commands are known at load; skills arrive from the host once it has
  // scanned the disk, and may never arrive at all.
  let skillEntries = []
  let dashEntries = []
  let dashIndex = 0

  const dashOpen = () => !dashEl.hidden

  /** The command being typed: the whole value when it starts with `/`, else null. */
  function currentQuery() {
    const v = inputEl.value
    if (!v.startsWith('/')) return null
    // Only while it is still one token. Once there is a space the user is
    // writing arguments, and the menu is in the way rather than helping.
    return v.includes(' ') ? null : v.slice(1)
  }

  function renderDash(entries) {
    dashEntries = entries
    if (dashIndex >= entries.length) dashIndex = 0
    dashListEl.textContent = ''
    entries.forEach((e, i) => {
      const row = document.createElement('div')
      row.className = `dash-row${i === dashIndex ? ' active' : ''}`
      row.id = `dash-row-${i}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === dashIndex))
      const name = document.createElement('span')
      name.className = 'dash-name'
      name.textContent = e.name
      const summary = document.createElement('span')
      summary.className = 'dash-summary'
      // A skill description is written by a plugin author: untrusted text,
      // same as model output. textContent, never innerHTML.
      summary.textContent = e.hint ? `${e.hint} — ${e.summary}` : e.summary
      row.appendChild(name)
      row.appendChild(summary)
      row.addEventListener('mousedown', ev => { ev.preventDefault(); accept(i) })
      dashListEl.appendChild(row)
    })
    dashEmptyEl.hidden = entries.length > 0
    inputEl.setAttribute('aria-activedescendant', entries.length ? `dash-row-${dashIndex}` : '')
  }

  function openDash(query) {
    dashEl.hidden = false
    renderDash(filterEntries(COMMANDS.concat(skillEntries), query))
  }

  function closeDash() {
    dashEl.hidden = true
    dashIndex = 0
    inputEl.setAttribute('aria-activedescendant', '')
  }

  function moveDash(delta) {
    if (!dashEntries.length) return
    // Wraps, so Up from the top reaches the bottom rather than doing nothing.
    dashIndex = (dashIndex + delta + dashEntries.length) % dashEntries.length
    renderDash(dashEntries)
  }

  function accept(i) {
    const entry = dashEntries[i]
    if (!entry) return
    closeDash()
    if (entry.sends) {
      inputEl.value = ''
      autoGrow()
      appendMsg('user', entry.name)
      vscode.postMessage({ type: 'input', text: entry.name })
      return
    }
    // Insert and let the user finish the line -- a skill usually needs an
    // argument, and sending a bare skill name wastes a turn.
    inputEl.value = `${entry.name} `
    inputEl.focus()
    autoGrow()
  }

  dashBtnEl.appendChild(icon('slash', document))
  dashBtnEl.addEventListener('click', () => {
    if (dashOpen()) return closeDash()
    if (!inputEl.value.startsWith('/')) inputEl.value = '/'
    inputEl.focus()
    openDash(currentQuery() ?? '')
  })
```

Wire the composer. In the existing `input` listener add, after `autoGrow()`:

```js
    const q = currentQuery()
    if (q === null) closeDash()
    else openDash(q)
```

And at the very top of the existing `keydown` handler, before the Enter check:

```js
    if (dashOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveDash(1) }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveDash(-1) }
      if (e.key === 'Escape') { e.preventDefault(); return closeDash() }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return accept(dashIndex) }
      if (e.key === 'Tab') { e.preventDefault(); return accept(dashIndex) }
    }
```

Handle the new message kind alongside `activity` and `fatal`:

```js
    if (msg.type === 'skills') {
      skillEntries = Array.isArray(msg.skills) ? msg.skills : []
      if (dashOpen()) openDash(currentQuery() ?? '')
      return
    }
```

- [ ] **Step 5: Feed it from the host**

In `extension/src/chat/panel.js`, add to the returned object:

```js
    postSkills: skills => post({ type: 'skills', skills }),
```

In `extension/src/extension.js`, after the panel is created:

```js
  // Scanned once per chat, off the startup path: the menu works without it
  // (commands are built in), and a slow disk must not delay the first message.
  setTimeout(() => {
    try {
      panel.postSkills(discoverSkills({ workspace: workspace.uri.fsPath, home: os.homedir() }))
    } catch (err) {
      log(`skill discovery failed: ${err.message}`) // a menu without skills is still a menu
    }
  }, 0)
```

with `const os = require('node:os')` and
`const { discoverSkills } = require('./skills.js')` at the top.

- [ ] **Step 6: Style it**

```css
/* The dashboard sits directly above the composer and is anchored to it, so
 * the list grows upward from the text being typed. */
.dash {
  margin: 0 12px 4px 12px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  border-radius: 9px;
  background: var(--vscode-editorWidget-background, var(--vscode-input-background));
  max-height: 260px;
  overflow-y: auto;
}

.dash-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 12px;
  cursor: pointer;
}

.dash-row.active {
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-toolbar-hoverBackground));
  color: var(--vscode-list-activeSelectionForeground, inherit);
}

.dash-name {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.92em;
  flex: 0 0 auto;
}

.dash-summary {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* The active row keeps its summary readable: descriptionForeground against the
 * selection background is not guaranteed to clear 4.5:1. */
.dash-row.active .dash-summary { color: inherit; opacity: 0.85; }

.dash-empty {
  padding: 8px 12px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground, var(--vscode-foreground));
}

/* Ghost buttons: an action, visually lighter than a chip, which carries state. */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  cursor: pointer;
}

.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
.icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
```

- [ ] **Step 7: Add a fixture and look at it**

Add to `extension/harness/fixtures.js` a `dashboard` fixture (a session, the
model probe answer, then a `skills` message with three plausible entries), and
to `INTERACTIONS` an entry clicking `dash-btn`. Mirror the new markup into
`extension/harness/index.html`.

```bash
node --test
node extension/harness/shoot.js dashboard
```

Expected: all tests pass. **Read all four PNGs.** Check the highlighted row's
summary is legible against the selection background, that a long summary
ellipsises rather than widening the panel, and that the narrow shot does not
scroll horizontally.

- [ ] **Step 8: Commit**

```bash
git add extension/src extension/test extension/harness
git commit -m "feat(chat): slash opens a dashboard of commands and skills"
```

---

### Task 4: Attachments

**Files:**
- Modify: `extension/src/chat/webview.js`, `webview.html`, `webview.css`
- Modify: `extension/src/chat/panel.js`
- Modify: `extension/src/extension.js`
- Create: `extension/src/attachments.js`
- Test: `extension/test/attachments.test.js`

**Interfaces:**
- Produces: `module.exports = { extensionForMime, attachmentPath, saveAttachment }`
  - `extensionForMime('image/png')` → `'.png'`
  - `attachmentPath(dir, mime, uuid)` → an absolute path
  - `saveAttachment({ dir, mime, base64, fs, uuid })` → the written path
- New messages: webview→host `{type:'attach-file'}` and
  `{type:'attach-paste', mime, base64}`; host→webview
  `{type:'attached', path, mime, dataUrl}`.

**Why a path and not an upload.** The orchestrator is not a room member and
already holds Read and Glob, so a workspace-relative path is all it needs. The
room's `/upload` route serves room members and is deliberately not on this path.
A pasted image has no path yet, so the host writes one under
`globalStorageUri/attachments/` and hands the path back.

- [ ] **Step 1: Write the failing test**

```js
// extension/test/attachments.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { extensionForMime, attachmentPath, saveAttachment } = require('../src/attachments.js')

test('known image types map to their real extension', () => {
  assert.equal(extensionForMime('image/png'), '.png')
  assert.equal(extensionForMime('image/jpeg'), '.jpg')
  assert.equal(extensionForMime('image/gif'), '.gif')
  assert.equal(extensionForMime('image/webp'), '.webp')
})

test('an unknown type falls back to .bin rather than inventing one', () => {
  assert.equal(extensionForMime('application/x-weird'), '.bin')
  assert.equal(extensionForMime(''), '.bin')
})

test('a mime type cannot escape the attachments directory', () => {
  // The mime string arrives from the webview's clipboard data. Deriving a
  // filename from it without constraint is a path traversal.
  const p = attachmentPath('/store', 'image/../../etc/passwd', 'abc')
  assert.ok(!p.includes('..'), `path must not contain traversal: ${p}`)
  assert.ok(p.startsWith('/store') || p.startsWith('\\store') || /^[A-Za-z]:/.test(p))
})

test('the written path lands under the given directory and is returned', () => {
  const writes = []
  const p = saveAttachment({
    dir: '/store',
    mime: 'image/png',
    base64: Buffer.from('hello').toString('base64'),
    uuid: 'fixed',
    fs: { mkdirSync() {}, writeFileSync: (path, buf) => writes.push([path, buf]) },
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], p)
  assert.match(p, /fixed\.png$/)
  assert.equal(writes[0][1].toString(), 'hello', 'the decoded bytes are written, not the base64')
})

test('malformed base64 throws rather than writing a corrupt file', () => {
  assert.throws(() => saveAttachment({
    dir: '/store', mime: 'image/png', base64: '!!!not base64!!!', uuid: 'x',
    fs: { mkdirSync() {}, writeFileSync() {} },
  }), /base64/)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test extension/test/attachments.test.js`
Expected: FAIL — `Cannot find module '../src/attachments.js'`

- [ ] **Step 3: Write the implementation**

```js
// extension/src/attachments.js
//
// Where a pasted image goes.
//
// A file the user picks or drops already has a path, and a path is all the
// orchestrator needs -- it holds Read and Glob. A pasted image has no path, so
// one is made here, under the extension's own storage.
'use strict'
const nodeFs = require('node:fs')
const nodeCrypto = require('node:crypto')
const { join } = require('node:path')

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
}

/** A real extension for a known type, `.bin` for anything else. */
function extensionForMime(mime) {
  return MIME_EXT[String(mime ?? '').toLowerCase()] ?? '.bin'
}

/**
 * The path an attachment is written to.
 *
 * The extension comes from the lookup above and never from the mime string
 * itself, so a crafted type cannot walk out of the directory. The filename is
 * a uuid for the same reason: nothing user-controlled reaches the path.
 */
function attachmentPath(dir, mime, uuid) {
  return join(dir, `${uuid}${extensionForMime(mime)}`)
}

const BASE64_RE = /^[A-Za-z0-9+/\r\n]*={0,2}$/

/** @returns {string} the path written. */
function saveAttachment({ dir, mime, base64, fs = nodeFs, uuid = nodeCrypto.randomUUID() }) {
  const raw = String(base64 ?? '')
  // Buffer.from silently drops anything it cannot decode, so a corrupt
  // clipboard payload would otherwise be written as a truncated image and
  // read later as a mystery. Refuse it here, where the cause is still known.
  if (!raw || !BASE64_RE.test(raw)) throw new Error('attachment is not valid base64')
  const buf = Buffer.from(raw, 'base64')
  if (!buf.length) throw new Error('attachment is not valid base64')
  fs.mkdirSync(dir, { recursive: true })
  const path = attachmentPath(dir, mime, uuid)
  fs.writeFileSync(path, buf)
  return path
}

module.exports = { extensionForMime, attachmentPath, saveAttachment, MIME_EXT }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/test/attachments.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the webview**

Markup — an attachment strip above the textarea, inside `.composer`:

```html
    <div id="attachments" class="attachments" hidden></div>
```

In `webview.js`:

```js
  const attachmentsEl = document.getElementById('attachments')
  const attached = [] // { path, dataUrl }

  function renderAttachments() {
    attachmentsEl.textContent = ''
    attachmentsEl.hidden = attached.length === 0
    attached.forEach((a, i) => {
      const chip = document.createElement('span')
      chip.className = 'attachment'
      if (a.dataUrl) {
        const img = document.createElement('img')
        img.className = 'attachment-thumb'
        // data: is permitted by the CSP's img-src, and this is the only place
        // the webview renders bytes rather than text.
        img.src = a.dataUrl
        img.alt = ''
        chip.appendChild(img)
      }
      const label = document.createElement('span')
      label.textContent = a.path.split(/[\\/]/).pop()
      chip.appendChild(label)
      const remove = document.createElement('button')
      remove.className = 'attachment-remove'
      remove.type = 'button'
      remove.setAttribute('aria-label', `Remove ${label.textContent}`)
      remove.appendChild(icon('x', document))
      remove.addEventListener('click', () => { attached.splice(i, 1); renderAttachments() })
      chip.appendChild(remove)
      attachmentsEl.appendChild(chip)
    })
  }

  attachBtnEl.appendChild(icon('plus', document))
  attachBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'attach-file' }))

  // Pasted images become files; pasted text is left entirely alone.
  inputEl.addEventListener('paste', e => {
    const items = [...(e.clipboardData?.items ?? [])].filter(i => i.type.startsWith('image/'))
    if (!items.length) return
    e.preventDefault()
    for (const item of items) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        // A data URL is "data:<mime>;base64,<payload>"; the host wants the payload.
        const url = String(reader.result)
        vscode.postMessage({ type: 'attach-paste', mime: file.type, base64: url.slice(url.indexOf(',') + 1) })
      }
      reader.readAsDataURL(file)
    }
  })

  // Dropping a file onto the conversation is the same gesture as picking one.
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => {
    e.preventDefault()
    const paths = [...(e.dataTransfer?.files ?? [])].map(f => f.path).filter(Boolean)
    if (paths.length) vscode.postMessage({ type: 'attach-paths', paths })
  })
```

`send()` prefixes any attachment paths, so the model is told where they are:

```js
  function send() {
    const typed = inputEl.value.trim()
    const prefix = attached.map(a => a.path).join('\n')
    const text = prefix ? `${prefix}\n${typed}` : typed
    if (!text.trim()) return
    appendMsg('user', text)
    vscode.postMessage({ type: 'input', text })
    inputEl.value = ''
    attached.length = 0
    renderAttachments()
    autoGrow()
  }
```

And handle the host's reply:

```js
    if (msg.type === 'attached') {
      attached.push({ path: String(msg.path), dataUrl: msg.dataUrl ?? null })
      renderAttachments()
      inputEl.focus()
      return
    }
```

- [ ] **Step 6: Wire the host**

In `panel.js`, forward the new message types through a second callback:

```js
  panel.webview.onDidReceiveMessage(msg => {
    if (msg?.type === 'input' && typeof msg.text === 'string' && msg.text.trim()) {
      onInput(msg.text)
      return
    }
    if (msg?.type && msg.type.startsWith('attach')) onAttach?.(msg)
  })
```

taking `onAttach` alongside `onInput`, and add `postAttached: a => post({ type: 'attached', ...a })`.

In `extension.js`, pass an `onAttach` that handles the three cases: a picker
(`vscode.window.showOpenDialog({ canSelectMany: true })`), dropped paths
(posted straight back), and a paste (written with `saveAttachment` into
`path.join(storageDir, 'attachments')`, posted back with a `data:` URL built
from the same base64 so the thumbnail needs no second read).

- [ ] **Step 7: Style, shoot, and look**

```css
.attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 4px; }

.attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 2px 6px;
  border-radius: 4px;
  font-size: 0.85em;
  background: var(--vscode-badge-background, rgba(127, 127, 127, 0.2));
  color: var(--vscode-badge-foreground, inherit);
}

.attachment-thumb { width: 20px; height: 20px; object-fit: cover; border-radius: 2px; }

.attachment-remove {
  display: inline-flex;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}

.attachment-remove:hover { opacity: 1; }
.attachment-remove:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
```

Add an `attachments` fixture (a `session`, the model probe answer, then two
`attached` messages — one with a tiny inline `data:` PNG, one without) and shoot
it.

```bash
node --test
node extension/harness/shoot.js attachments
```

**Read the PNGs.** Check the thumbnail is square and aligned, the remove button
is reachable and visible, and the strip wraps rather than widening the composer
at 380px.

- [ ] **Step 8: Commit**

```bash
git add extension/src extension/test extension/harness
git commit -m "feat(chat): attach files by picking, dropping or pasting"
```

---

## Verification

```bash
node --test                              # 0 failures
SKILLS_LIVE=1 node --test extension/test/skills.test.js   # ~28 skills found
node extension/harness/shoot.js          # every fixture, both themes, both widths
```

Then read every PNG against design §9.

**Left for the user's own pass:** that `/` feels right against a real
orchestrator, that the picker and drag-drop work in a real editor window (the
harness fakes neither), and that a real clipboard image round-trips — the
fixture supplies bytes the webview never actually read from a clipboard.
