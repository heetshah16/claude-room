// extension/test/skills.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const { parseFrontmatter, skillDirs, discoverSkills } = require('../src/skills.js')

/**
 * A filesystem of exactly the shape discoverSkills uses: directory listings
 * derived from the mapped paths, and readFile returning the content (null
 * meaning "exists but unreadable").
 */
function fakeFs(files) {
  const paths = Object.keys(files)
  return {
    readdirSync(dir) {
      const prefix = dir.replace(/[\\/]$/, '').split('\\').join('/') + '/'
      const names = new Set()
      for (const f of paths) {
        const norm = f.split('\\').join('/')
        if (!norm.startsWith(prefix)) continue
        const rest = norm.slice(prefix.length).split('/')
        names.add(rest[0] + (rest.length > 1 ? '/' : ''))
      }
      if (!names.size) throw new Error('ENOENT')
      return [...names].map(n => ({
        name: n.replace(/\/$/, ''),
        isDirectory: () => n.endsWith('/'),
        isFile: () => !n.endsWith('/'),
      }))
    },
    readFileSync(p) {
      const key = Object.keys(files).find(f => f.split('\\').join('/') === p.split('\\').join('/'))
      if (key === undefined || files[key] === null) throw new Error('unreadable')
      return files[key]
    },
  }
}

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
  assert.equal(parseFrontmatter(null), null)
})

test('CRLF frontmatter parses -- this repo is developed on Windows', () => {
  const fm = parseFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\n')
  assert.equal(fm.name, 'x')
  assert.equal(fm.description, 'y')
})

test('the plugin cache is scanned, not just the two documented directories', () => {
  // Verified on the development machine: neither .claude/skills nor
  // ~/.claude/skills exists, and all 28 installed skills live under the plugin
  // cache. Scanning only the documented pair finds nothing at all here.
  // Compared with separators normalised: path.join is correct to emit
  // backslashes on Windows, and this assertion is about which roots are
  // scanned, not about how the platform spells a path.
  const dirs = skillDirs({ workspace: '/repo', home: '/home/u' }).map(d => d.split('\\').join('/'))
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
  // This layout is not a published contract; degrade, never crash.
  assert.deepEqual(discoverSkills({ workspace: '/nope', home: '/nope', fs: fakeFs({}) }), [])
})

test('a SKILL.md that cannot be read is skipped, not fatal', () => {
  const fs = fakeFs({ '/repo/.claude/skills/bad/SKILL.md': null })
  assert.deepEqual(discoverSkills({ workspace: '/repo', home: '/h', fs }), [])
})

test('one unreadable skill does not cost us the readable ones beside it', () => {
  const fs = fakeFs({
    '/repo/.claude/skills/bad/SKILL.md': null,
    '/repo/.claude/skills/good/SKILL.md': '---\nname: good\ndescription: fine\n---\n',
  })
  const found = discoverSkills({ workspace: '/repo', home: '/h', fs })
  assert.deepEqual(found.map(s => s.name), ['/good'])
})

test('skills come back sorted, so the menu order is stable between runs', () => {
  const files = {
    '/repo/.claude/skills/zebra/SKILL.md': '---\nname: zebra\ndescription: z\n---\n',
    '/repo/.claude/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: a\n---\n',
  }
  const names = discoverSkills({ workspace: '/repo', home: '/h', fs: fakeFs(files) }).map(s => s.name)
  assert.deepEqual(names, ['/alpha', '/zebra'])
})

test('the real machine has skills, or the layout assumption is wrong', { skip: !process.env.SKILLS_LIVE }, () => {
  // Opt-in (SKILLS_LIVE=1): it reads the developer's own home directory, which
  // no ordinary test run should depend on. But a fake filesystem only proves
  // the algorithm -- it cannot prove the layout the whole feature rests on.
  const found = discoverSkills({ workspace: process.cwd(), home: os.homedir() })
  assert.ok(found.length > 0, 'no skills discovered on this machine')
  assert.ok(found.every(s => s.name.startsWith('/')), 'every entry is invocable as typed')

  // The layout assumption that matters: skills are reached through the plugin
  // cache and named `plugin:skill`. A run that found only bare names would
  // mean the cache walk silently stopped working.
  assert.ok(found.some(s => s.name.includes(':')), 'no plugin-scoped skill found')

  // Dedup actually happening, not just intended. On this machine 28 SKILL.md
  // files yield 22 skills, because one plugin ships six of its skills at two
  // paths inside a single version. A duplicate reaching the menu would show
  // the same entry twice.
  const names = found.map(s => s.name)
  assert.equal(new Set(names).size, names.length, `duplicate skill names: ${names.join(', ')}`)

  assert.ok(found.every(s => typeof s.summary === 'string'), 'every entry needs a summary field')
})
