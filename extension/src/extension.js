// extension/src/extension.js
//
// The thin layer that wires the already-tested modules (supervisor,
// room-client, orchestrator, stream) to VS Code and renders them. All logic
// lives in those modules; this file is deliberately just glue, which is what
// keeps the rest testable without VS Code.
'use strict'
const vscode = require('vscode')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const { createSupervisor } = require('./supervisor.js')
const { roomRecipe, readOwnerToken } = require('./room-client.js')
const { orchestratorRecipe, bridgeMcpConfig, createOrchestrator } = require('./orchestrator.js')
const { createChatPanel } = require('./chat/panel.js')

// extension.js lives at <repoRoot>/extension/src/extension.js. "The
// extension's own directory" is <repoRoot>/extension; its parent is the repo
// root, which is what roomRecipe/orchestratorRecipe/bridgeMcpConfig need to
// find src/server.mjs and src/orchestrator-bridge.mjs.
const REPO_ROOT = path.join(__dirname, '..', '..')

let supervisor = null
let output = null
let session = null // { panel } — the live chat session, if one is open

function log(msg) {
  output?.appendLine(String(msg))
}

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Room')
  supervisor = createSupervisor({ log })

  supervisor.on('exit', ({ name, code }) => {
    log(`${name} exited unexpectedly (code ${code ?? 'unknown'})`)
    // A dead process must never be invisible: without this the chat keeps
    // accepting input against an orchestrator or room that is no longer
    // there, which is the worst outcome this design can have.
    session?.panel.postFatal(
      `${name} exited unexpectedly (code ${code ?? 'unknown'}). Run "Claude Room: Restart Services" to continue.`,
    )
  })

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeRoom.openChat', () => openChat(context)),
    vscode.commands.registerCommand('claudeRoom.restart', () => restart(context)),
    output,
    { dispose: () => supervisor?.stopAll() },
  )
}

function deactivate() {
  session = null
  supervisor?.stopAll()
}

async function restart(context) {
  session = null
  supervisor.stopAll()
  await openChat(context)
}

/** Binds 127.0.0.1:0 and releases it, so the room gets a port nothing else is using. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}

/** Polls `fn` with exponential backoff until it returns truthy or `timeoutMs` elapses. */
async function pollWithBackoff(fn, { timeoutMs = 10_000, startMs = 150, maxMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let delay = startMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() >= deadline) return null
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, maxMs)
  }
}

/**
 * Waits for the room's HTTP server to be listening at all. Any response —
 * even the 401 an unauthenticated /api/state gets, since the extension has
 * no token yet at this point — proves the process is up; readOwnerToken
 * below is what actually waits for the room to finish booting.
 */
async function waitForRoomUp(roomUrl) {
  const ok = await pollWithBackoff(async () => {
    try {
      await fetch(`${roomUrl}/api/state`)
      return true
    } catch {
      return false
    }
  })
  if (!ok) throw new Error('the room did not start listening within 10s')
}

/**
 * readOwnerToken returns null until the room has written its roster —
 * absent on the very first boot. Poll with backoff and fail loudly after
 * ~10s rather than hanging forever with a chat window that never opens.
 */
async function waitForOwnerToken(stateDir) {
  const token = await pollWithBackoff(() => readOwnerToken(stateDir))
  if (!token) throw new Error('the room did not write its owner token within 10s')
  return token
}

async function openChat(context) {
  if (session) {
    session.panel.reveal()
    return
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]
  if (!workspace) {
    vscode.window.showErrorMessage('Claude Room: open a folder before starting a chat.')
    return
  }

  const storageDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath
  const stateDir = path.join(storageDir, 'room-state')
  fs.mkdirSync(stateDir, { recursive: true })

  let port
  try {
    port = await pickFreePort()
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Room: could not find a free port: ${err.message}`)
    return
  }
  const roomUrl = `http://127.0.0.1:${port}`

  supervisor.start('room', roomRecipe({ repoRoot: REPO_ROOT, stateDir, port }))

  let token
  try {
    await waitForRoomUp(roomUrl)
    token = await waitForOwnerToken(stateDir)
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Room: ${err.message}`)
    supervisor.stop('room')
    return
  }

  const mcpConfigPath = path.join(stateDir, 'mcp-config.json')
  fs.writeFileSync(mcpConfigPath, JSON.stringify(bridgeMcpConfig(REPO_ROOT), null, 2))

  const sessionId = crypto.randomUUID()
  const orchProc = supervisor.start('orchestrator', orchestratorRecipe({
    repoRoot: REPO_ROOT,
    roomUrl,
    token,
    sessionId,
    workspace: workspace.uri.fsPath,
    mcpConfigPath,
  }))

  // `orchestrator` is assigned below, after `panel` — the two need each
  // other, so `panel`'s onInput closes over this `let` binding rather than
  // a value that exists yet. Both are assigned synchronously before either
  // callback can actually fire, so by the time a message arrives on either
  // side the other half is always ready.
  let orchestrator
  const panel = createChatPanel({
    context,
    onInput: text => orchestrator?.send(text),
  })
  orchestrator = createOrchestrator({
    child: orchProc.child,
    onEvent: e => panel.postStream(e),
  })

  panel.onDidDispose(() => {
    if (session?.panel === panel) session = null
  })

  session = { panel, orchestrator, roomUrl, token, stateDir }
}

module.exports = { activate, deactivate }
