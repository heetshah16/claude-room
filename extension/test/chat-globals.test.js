// The webview loads chat modules with plain <script> tags. There is no module
// system in there, so the only way webview.js can reach them is a global.
//
// This exists because markdown.js once shipped with only `module.exports` and
// no `window` assignment. Every Node test passed - they import through
// module.exports - while the real webview threw
// "Cannot destructure property 'renderMarkdown' of undefined" at the top of
// webview.js and killed the whole script, send button included.
//
// So these tests evaluate the files the way a BROWSER does: a fake window, and
// no `module` at all.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const CHAT = join(__dirname, '..', 'src', 'chat')

/** Run a chat module with no module system, exactly as a <script> tag would. */
function runInFakeBrowser(file) {
  const code = readFileSync(join(CHAT, file), 'utf8')
  const window = {}
  const sandbox = { window, document: undefined, console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: file })
  return window
}

test('markdown.js exposes itself on window, or the webview script dies on load', () => {
  const window = runInFakeBrowser('markdown.js')
  assert.ok(window.ClaudeMarkdown, 'window.ClaudeMarkdown must exist')
  assert.equal(typeof window.ClaudeMarkdown.renderMarkdown, 'function')
  assert.equal(typeof window.ClaudeMarkdown.parseMarkdown, 'function')
})

test('model.js exposes itself on window too', () => {
  const window = runInFakeBrowser('model.js')
  assert.ok(window.ClaudeModel, 'window.ClaudeModel must exist')
  assert.equal(typeof window.ClaudeModel.parseModelList, 'function')
})

test('icons.js exposes itself on window too', () => {
  const window = runInFakeBrowser('icons.js')
  assert.ok(window.ClaudeIcons, 'window.ClaudeIcons must exist')
  assert.equal(typeof window.ClaudeIcons.icon, 'function')
})

/**
 * Which files the webview actually loads, read from its html rather than
 * listed here.
 *
 * A hardcoded list goes stale the moment a module is added -- which is exactly
 * what happened when icons.js arrived: the provider check below kept passing
 * against two files while the html loaded three. The html is the production
 * contract, so derive from it.
 *
 * `{{fooUri}}` names `foo.js`, except `scriptUri`, which is webview.js itself.
 */
function modulesLoadedByHtml() {
  const html = readFileSync(join(CHAT, 'webview.html'), 'utf8')
  return [...html.matchAll(/src="\{\{(\w+)Uri\}\}"/g)]
    .map(m => (m[1] === 'script' ? 'webview.js' : `${m[1]}.js`))
}

test('every global webview.js destructures is actually provided by some module', () => {
  // The real check: whatever webview.js reads off `window` at load time must
  // be something a loaded module assigns. A mismatch here is precisely the
  // bug that broke sending, and it is invisible to any per-module test.
  const src = readFileSync(join(CHAT, 'webview.js'), 'utf8')
  const needed = [...src.matchAll(/window\.(Claude[A-Za-z]+)/g)].map(m => m[1])
  assert.ok(needed.length > 0, 'expected webview.js to consume at least one global')

  const provided = new Set()
  for (const file of modulesLoadedByHtml()) {
    if (file === 'webview.js') continue // the consumer, and it needs a real DOM
    for (const key of Object.keys(runInFakeBrowser(file))) provided.add(key)
  }

  for (const name of new Set(needed)) {
    assert.ok(provided.has(name), `webview.js reads window.${name}, but no chat module assigns it`)
  }
})

test('every module the webview html loads is one we can actually evaluate', () => {
  // A script tag pointing at a file that throws on load is the same failure
  // with a different cause, so the html's list is checked rather than assumed.
  const loaded = modulesLoadedByHtml()
  assert.ok(loaded.includes('markdown.js'), 'markdown.js must be loaded by the webview')
  assert.ok(loaded.includes('webview.js'), 'webview.js itself must be loaded')
  // Every module except webview.js must evaluate standalone; webview.js needs
  // a real DOM, so it is covered by webview-boot.test.js instead.
  for (const file of loaded) {
    if (file === 'webview.js') continue
    assert.doesNotThrow(() => runInFakeBrowser(file), `${file} must evaluate as a plain script`)
  }
})

test('panel.js passes a uri for every script tag the html declares', () => {
  // A `{{fooUri}}` the panel never substitutes reaches the browser verbatim as
  // a src, which loads nothing and takes the webview's globals down with it.
  const html = readFileSync(join(CHAT, 'webview.html'), 'utf8')
  const panel = readFileSync(join(CHAT, 'panel.js'), 'utf8')
  for (const [, name] of html.matchAll(/src="\{\{(\w+)Uri\}\}"/g)) {
    assert.ok(
      panel.includes(`{{${name}Uri}}`),
      `webview.html loads {{${name}Uri}}, but panel.js never substitutes it`,
    )
  }
})
