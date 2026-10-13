// Both sidebar views ask for the room the moment they resolve, so the first
// reveal calls ensureSession twice at once. Found in a real Cursor window
// (2026-10-13): each call started its own room under the supervisor's one
// 'room' name, the second replaced the first, and the loser's 10 s timeout
// stopped the room that had won.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('two views revealing at once start one room', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-session-'))
  const resolve = Module._resolveFilename
  Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : resolve.call(this, req, ...rest) }
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {
    workspace: { workspaceFolders: [{ uri: { fsPath: dir } }] },
    window: { showErrorMessage() {}, showInformationMessage() {} },
  } }
  let starts = 0
  const sessionPath = require.resolve('../src/session.js')
  require.cache[sessionPath] = { id: sessionPath, filename: sessionPath, loaded: true, exports: {
    createSession: () => ({
      start: async () => { starts++; await new Promise(r => setTimeout(r, 20)); return { ok: true } },
      onWorkers() {}, onRoom() {}, postRoom: async () => {}, stop() {},
    }),
  } }
  try {
    const { ensureSession } = require('../src/extension.js')
    const context = { storageUri: { fsPath: dir } }
    const [a, b] = await Promise.all([ensureSession(context), ensureSession(context)])
    assert.equal(starts, 1)
    assert.ok(a)
    assert.equal(a, b)
  } finally {
    Module._resolveFilename = resolve
    delete require.cache.vscode
    delete require.cache[sessionPath]
    delete require.cache[require.resolve('../src/extension.js')]
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
