// extension/harness/themes.js
//
// Turns a VS Code colour theme into the CSS custom properties a webview sees.
//
// VS Code exposes theme colours to a webview as `--vscode-<key with dots
// replaced by dashes>`. Reproducing that here is what makes a harness
// screenshot look like the real panel rather than an approximation of one.
//
// Themes inherit: dark_modern includes dark_plus includes dark_vs. And no theme
// in that chain defines any `charts.*` colour -- those live in VS Code's own
// built-in defaults, not in any theme file. So a generator that reads only
// theme files emits no chart colours at all and the context bar renders as
// nothing. BUILTIN_DEFAULTS is that missing layer.
'use strict'

/** `editorWidget.background` -> `--vscode-editorWidget-background`. Case is preserved. */
function tokenName(colorKey) {
  return `--vscode-${String(colorKey).split('.').join('-')}`
}

// A theme file is data, not code, but it is still input -- and this output is
// concatenated straight into a stylesheet. Anything that is not a plain colour
// is dropped rather than escaped: no legitimate theme value needs more than
// this, so there is nothing to lose by being strict.
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

/**
 * VS Code's own defaults for tokens no theme file carries.
 *
 * Only the families this harness actually needs. The webview declares a
 * fallback on every `var()` anyway, so a token missing here degrades to the
 * same thing a user with a sparse theme would see, rather than to nothing.
 */
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
  // Sorted so a regenerated stylesheet diffs cleanly against the last one.
  lines.sort()
  return `:root {\n${lines.join('\n')}\n}\n`
}

module.exports = { tokenName, themeToCss, BUILTIN_DEFAULTS }
