// extension/src/chat/worker-panel.js
//
// One editor tab per worker, beside the chat.
//
// Deliberately the same shape as chat/panel.js: this file is the only place
// that touches the VS Code webview API for a worker, and everything it renders
// lives in worker-webview.js, inside the webview's own sandbox.
'use strict'
const vscode = require('vscode')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

const nonce = () => randomBytes(16).toString('base64')

/**
 * @param {{context: object, handle: string, onSay: Function, onInterrupt: Function,
 *          onRefresh: Function}} deps
 */
function createWorkerPanel({ context, handle, onSay, onInterrupt, onRefresh }) {
  const extensionRoot = context.extensionUri?.fsPath ?? context.extensionPath
  const chatDir = join(extensionRoot, 'src', 'chat')

  const panel = vscode.window.createWebviewPanel(
    'claudeRoomWorker',
    `@${handle}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(chatDir)],
    },
  )

  const uri = f => String(panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, f))))
  const n = nonce()
  panel.webview.html = readFileSync(join(chatDir, 'worker.html'), 'utf8')
    .split('{{cspSource}}').join(panel.webview.cspSource)
    .split('{{nonce}}').join(n)
    .split('{{styleUri}}').join(uri('webview.css'))
    .split('{{iconsUri}}').join(uri('icons.js'))
    .split('{{formatUri}}').join(uri('workers-format.js'))
    .split('{{scriptUri}}').join(uri('worker-webview.js'))

  panel.webview.onDidReceiveMessage(msg => {
    if (msg?.type === 'worker-say' && typeof msg.text === 'string' && msg.text.trim()) {
      return onSay?.(handle, msg.text)
    }
    if (msg?.type === 'worker-interrupt') return onInterrupt?.(handle)
    if (msg?.type === 'worker-refresh') return onRefresh?.(handle)
  })

  // The webview can already be gone by the time an update arrives; posting to
  // a disposed one throws, and a worker update is not worth crashing the host.
  const post = message => { try { panel.webview.postMessage(message) } catch { /* disposed */ } }

  return {
    handle,
    panel,
    postWorker: worker => post({ type: 'worker', worker }),
    reveal: () => panel.reveal(vscode.ViewColumn.Beside),
    onDidDispose: cb => panel.onDidDispose(cb),
  }
}

module.exports = { createWorkerPanel }
