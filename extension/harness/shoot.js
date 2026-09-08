// extension/harness/shoot.js
//
// Renders each fixture in headless Chrome and writes a PNG per
// (fixture x theme x width), into extension/harness/shots/.
//
//   node extension/harness/shoot.js              every fixture
//   node extension/harness/shoot.js conversation just that one
//
// Chrome is spawned from here rather than from a shell, so this needs no
// browser permission of its own and the binary is located rather than assumed.
// No Playwright, no Puppeteer: `--screenshot` is a Chrome flag, and this
// repo's zero-dependency property is worth more than a nicer API.
//
// This closes the gap ARCHITECTURE.md names as the one thing nothing verifies:
// the webview's appearance.
'use strict'
const { execFile } = require('node:child_process')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { promisify } = require('node:util')
const { FIXTURES, resolveTheme } = require('./fixtures.js')
const { themeToCss, BUILTIN_DEFAULTS } = require('./themes.js')

const run = promisify(execFile)
const HERE = __dirname
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

// Cursor is a VS Code fork and ships the same theme-defaults extension, so
// either editor supplies the same files.
const THEME_DIRS = [
  join(HOME, 'AppData/Local/Programs/cursor/resources/app/extensions/theme-defaults/themes'),
  join(HOME, 'AppData/Local/Programs/Microsoft VS Code/resources/app/extensions/theme-defaults/themes'),
  '/usr/share/code/resources/app/extensions/theme-defaults/themes',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-defaults/themes',
]

const THEMES = [
  { name: 'dark', file: 'dark_modern.json', defaults: BUILTIN_DEFAULTS.dark },
  { name: 'light', file: 'light_modern.json', defaults: BUILTIN_DEFAULTS.light },
]

// Wide is a full editor tab; narrow is roughly a sidebar, which is where a
// chip row or a legend wraps badly if it is going to.
const WIDTHS = [{ name: 'wide', px: 900 }, { name: 'narrow', px: 420 }]

function findFirst(candidates, what) {
  const found = candidates.find(p => existsSync(p))
  if (!found) throw new Error(`no ${what} found. Looked in:\n  ${candidates.join('\n  ')}`)
  return found
}

/** Chrome wants a URL; on Windows the path arrives with backslashes. */
const fileUrl = p => `file://${p.split('\\').join('/')}`

async function main() {
  const chrome = findFirst(CHROME_CANDIDATES, 'Chrome or Edge')
  const themeDir = findFirst(THEME_DIRS, 'VS Code theme directory')
  const outDir = join(HERE, 'shots')
  mkdirSync(outDir, { recursive: true })

  const only = process.argv[2] ?? null
  const names = only ? [only] : Object.keys(FIXTURES)
  for (const n of names) {
    if (!FIXTURES[n]) throw new Error(`no such fixture: ${n}. Have: ${Object.keys(FIXTURES).join(', ')}`)
  }

  for (const theme of THEMES) {
    writeFileSync(
      join(HERE, 'theme.css'),
      themeToCss(resolveTheme(join(themeDir, theme.file)), { defaults: theme.defaults }),
    )
    for (const fixture of names) {
      // replay.js is rewritten per shot rather than read from a query string:
      // a file:// page cannot fetch a sibling file, and writing it keeps the
      // page identical to what a plain script tag would load.
      writeFileSync(
        join(HERE, 'replay.js'),
        'for (const m of ' + JSON.stringify(FIXTURES[fixture]) +
          ") window.dispatchEvent(new MessageEvent('message', { data: m }))\n",
      )
      for (const width of WIDTHS) {
        const out = join(outDir, `${fixture}-${theme.name}-${width.name}.png`)
        await run(chrome, [
          '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
          `--screenshot=${out}`,
          `--window-size=${width.px},760`,
          '--virtual-time-budget=2000',
          fileUrl(join(HERE, 'index.html')),
        ])
        process.stdout.write(`${out}\n`)
      }
    }
  }
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
