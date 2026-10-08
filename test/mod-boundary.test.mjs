import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOD = fileURLToPath(new URL('../mod/', import.meta.url))

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.claude-plugin' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(m?js|tsx?)$/.test(entry.name)) yield path
  }
}

const SPECIFIER = /^\s*(?:import\s[^'"]*?from\s*|import\s*|export\s[^'"(=]*?from\s*)['"]([^'"]+)['"]/gm

test('every import in the room-seat plugin resolves inside mod/, so a marketplace install of mod/ alone still runs', () => {
  for (const file of sources(MOD)) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (spec.startsWith('node:') || spec === 'claude-code' || spec === 'claude-code/testing') continue
      assert.ok(spec.startsWith('.'), `${relative(MOD, file)}: bare import "${spec}" - an installed plugin has no node_modules`)
      const target = resolve(dirname(file), spec)
      assert.ok(!relative(MOD, target).startsWith('..'), `${relative(MOD, file)}: "${spec}" leaves mod/`)
    }
  }
})
