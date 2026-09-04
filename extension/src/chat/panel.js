// extension/src/chat/panel.js
'use strict'
const vscode = require('vscode')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

const nonce = () => randomBytes(16).toString('base64')

/**
 * The chat webview: one panel, driven entirely through postMessage.
 *
 * This module is the only place that touches the VS Code webview API; all
 * rendering lives in webview.js, which runs inside the webview's own
 * sandboxed context. Keeping that split means webview.js can be read (and
 * eventually tested) without pulling in `vscode`, and this file stays thin
 * enough to trust by inspection.
 */
function createChatPanel({ context, onInput }) {
  const extensionRoot = context.extensionUri?.fsPath ?? context.extensionPath
  const chatDir = join(extensionRoot, 'src', 'chat')

  const panel = vscode.window.createWebviewPanel(
    'claudeRoomChat',
    'Claude Room',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(chatDir)],
    },
  )

  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'webview.js')))
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'webview.css')))
  const n = nonce()

  // The nonce lets exactly this one inline <script src> run; the CSP meta
  // tag in webview.html blocks everything else, including any innerHTML a
  // future edit might be tempted to add.
  const html = readFileSync(join(chatDir, 'webview.html'), 'utf8')
    .split('{{cspSource}}').join(panel.webview.cspSource)
    .split('{{nonce}}').join(n)
    .split('{{scriptUri}}').join(String(scriptUri))
    .split('{{styleUri}}').join(String(styleUri))

  panel.webview.html = html

  panel.webview.onDidReceiveMessage(msg => {
    if (msg?.type === 'input' && typeof msg.text === 'string' && msg.text.trim()) {
      onInput(msg.text)
    }
  })

  // The webview can already be gone (panel closed mid-turn) by the time an
  // orchestrator event arrives; postMessage on a disposed webview throws,
  // and a stream event is not worth crashing the extension host over.
  const post = message => { try { panel.webview.postMessage(message) } catch { /* panel disposed */ } }

  return {
    panel,
    postStream: event => post({ type: 'stream', event }),
    postActivity: activity => post({ type: 'activity', activity }),
    postFatal: message => post({ type: 'fatal', message }),
    reveal: () => panel.reveal(vscode.ViewColumn.One),
    onDidDispose: cb => panel.onDidDispose(cb),
  }
}

module.exports = { createChatPanel }
