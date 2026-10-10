// Copies what the room imports at runtime into <out>, for the extension package.
// bundleRoom({ repo, out }): string[] -- src/**/*.mjs, mod/lib/**, the two seat launchers
// (room-opencode-seat.mjs imports room-seat.mjs), and package.json ("type": "module").
import { cpSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const isTest = f => /\.test\.[^.]+$/.test(f)

export function bundleRoom({ repo, out }) {
  rmSync(out, { recursive: true, force: true })
  const copied = []
  const copy = rel => { cpSync(join(repo, rel), join(out, rel)); copied.push(rel) }
  for (const f of readdirSync(join(repo, 'src'))) if (f.endsWith('.mjs') && !isTest(f)) copy(`src/${f}`)
  for (const f of readdirSync(join(repo, 'mod', 'lib'))) if (!isTest(f)) copy(`mod/lib/${f}`)
  for (const f of ['scripts/room-opencode-seat.mjs', 'scripts/room-seat.mjs', 'package.json']) copy(f)
  return copied
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const files = bundleRoom({ repo, out: join(repo, 'extension', 'room') })
  console.error(`bundled ${files.length} files into extension/room`)
}
