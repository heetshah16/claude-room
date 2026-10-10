import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bundleRoom } from '../scripts/bundle-room.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
// Inside the repo so the SDK resolves by walking up to the repo's node_modules (ESM ignores NODE_PATH).
const tmp = () => mkdtempSync(join(REPO, '.bundle-test-'))

test('the bundle has everything the room imports at runtime, and no tests', () => {
  const out = tmp()
  try {
    bundleRoom({ repo: REPO, out })
    for (const f of ['src/server.mjs', 'src/orchestrator-bridge.mjs', 'mod/lib/protocol.mjs',
      'scripts/room-opencode-seat.mjs', 'scripts/room-seat.mjs', 'package.json']) {
      assert.ok(existsSync(join(out, f)), `missing ${f}`)
    }
    assert.equal(existsSync(join(out, 'mod', 'hooks')), false)
    assert.equal(existsSync(join(out, 'mod', 'tests')), false)
    assert.equal(existsSync(join(out, 'mod', '.claude-plugin')), false)
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('the bundled room boots on its own, with no repo src around it', async () => {
  const out = tmp()
  try {
    bundleRoom({ repo: REPO, out })
    const child = spawn(process.execPath, [join(out, 'src', 'server.mjs')], {
      env: { ...process.env, ROOM_STANDALONE: '1', ROOM_PORT: '0', ROOM_STATE_DIR: join(out, 'state') },
    })
    const err = []
    child.stderr.on('data', d => err.push(String(d)))
    const listening = await new Promise(resolve => {
      const t = setTimeout(() => resolve(false), 10_000)
      child.stderr.on('data', () => { if (/listening on/.test(err.join(''))) { clearTimeout(t); resolve(true) } })
      child.on('exit', () => { clearTimeout(t); resolve(false) })
      child.on('error', () => { clearTimeout(t); resolve(false) })
    })
    await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill() })
    assert.ok(listening, `bundled room did not start:\n${err.join('')}`)
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
