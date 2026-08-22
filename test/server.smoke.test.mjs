import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the server boots, serves the UI, and writes nothing to stdout but MCP traffic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roomsmoke-'))
  // Port 0 lets the OS pick, so a stray server left over from an earlier run
  // can never make this test answer against the wrong process.
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, ROOM_STATE_DIR: dir, ROOM_PORT: '0', ROOM_HOST: '127.0.0.1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })

  // Poll rather than sleep a fixed amount, so a slow machine does not flake.
  let body = null
  let port = null
  for (let i = 0; i < 60 && body === null; i++) {
    await new Promise(r => setTimeout(r, 100))
    port ??= stderr.match(/listening on http:\/\/[^:]+:(\d+)/)?.[1]
    if (!port) continue
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) body = await res.text()
    } catch {
      // not listening yet
    }
  }

  assert.ok(body, `server never came up. stderr:\n${stderr}`)
  assert.match(body, /<!doctype html>/i)
  assert.match(stderr, /listening on/)
  assert.match(stderr, /join: http/)

  // Any non-JSON-RPC byte on stdout corrupts the MCP stdio transport.
  const stray = stdout.split('\n').filter(l => l.trim() && !l.trimStart().startsWith('{'))
  assert.deepEqual(stray, [], `stray stdout would corrupt the MCP transport: ${JSON.stringify(stray)}`)

  child.kill()
  rmSync(dir, { recursive: true, force: true })
})
