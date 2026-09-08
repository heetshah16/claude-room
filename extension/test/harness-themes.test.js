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
