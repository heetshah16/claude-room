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
// shipped a menu that is empty for everyone whose skills come from plugins,
// which is the common case.
//
// None of this layout is a published contract, so every step degrades to "no
// skills found" rather than throwing. Extension-host side, because it touches
// the filesystem: the webview is handed the finished list over postMessage.
'use strict'
const nodeFs = require('node:fs')
const { join } = require('node:path')

/**
 * The `---` fenced block at the top of a SKILL.md.
 *
 * Deliberately not a YAML parser. The frontmatter here is flat `key: value`
 * lines and all 28 installed skills fit that shape; a real parser would be a
 * dependency, and this file has none. Only the FIRST colon splits, so a
 * description containing one survives intact.
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
    // Anything that is not a plain key is a continuation line or list item
    // from a shape we do not handle; skipping it is better than storing junk.
    if (!/^[A-Za-z][\w-]*$/.test(key)) continue
    let value = line.slice(at + 1).trim()
    // 6 of the 28 wrap the value in double quotes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return Object.keys(out).length ? out : null
}

/** Every root worth scanning for a SKILL.md. */
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
  // levels below the cache root. The bound stops a symlink loop, or an
  // unexpectedly deep tree, from walking the whole disk.
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
 * invoked: `.../plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`
 * yields `<plugin>`. Null for anything not in that shape, which is how a
 * workspace or user skill ends up with a bare name.
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
  const found = new Map() // name -> entry; a duplicate name resolves once
  for (const dir of skillDirs({ workspace, home })) {
    for (const file of findSkillFiles(dir, fs)) {
      let fm
      try {
        fm = parseFrontmatter(fs.readFileSync(file, 'utf8'))
      } catch {
        continue // unreadable: skip this one, keep every other
      }
      if (!fm || !fm.name) continue
      const plugin = pluginOf(file)
      const name = `/${plugin ? `${plugin}:${fm.name}` : fm.name}`
      // First win: skillDirs lists the workspace before the user directory
      // before the cache, which is the order of specificity.
      if (found.has(name)) continue
      found.set(name, {
        name,
        summary: fm.description ?? '',
        hint: fm['argument-hint'] ?? '',
        // A skill usually needs an argument, so selecting one puts it in the
        // composer and leaves the caret there rather than spending a turn on
        // a bare skill name.
        sends: false,
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

module.exports = { parseFrontmatter, skillDirs, findSkillFiles, pluginOf, discoverSkills }
