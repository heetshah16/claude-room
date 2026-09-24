// extension/src/chat/workers-view.js
//
// The Workers sidebar view.
//
// A WebviewView rather than a TreeView: it shares the chat's stylesheet, its
// icons and its row formatting, so the two surfaces cannot drift apart into
// two different-looking halves of one product. A TreeView would have given
// none of that and could not have shown three lines per worker.
//
// This is the only file besides chat/panel.js that touches the VS Code webview
// API; everything it renders lives in workers-webview.js, which runs inside
// the webview's own sandbox.
'use strict'
const vscode = require('vscode')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

const nonce = () => randomBytes(16).toString('base64')

/**
 * @param {{context: object, onAdd: Function, onOpen: Function, onRefresh: Function}} deps
 * @returns {{provider: object, postWorkers: Function}}
 */
function createWorkersView({ context, onAdd, onOpen, onRefresh, onStop }) {
  const extensionRoot = context.extensionUri?.fsPath ?? context.extensionPath
  const chatDir = join(extensionRoot, 'src', 'chat')

  let view = null
  /** The last list posted, replayed when the view is revealed again. */
  let last = []

  function html(webview) {
    const uri = f => String(webview.asWebviewUri(vscode.Uri.file(join(chatDir, f))))
    const n = nonce()
    return readFileSync(join(chatDir, 'workers.html'), 'utf8')
      .split('{{cspSource}}').join(webview.cspSource)
      .split('{{nonce}}').join(n)
      .split('{{styleUri}}').join(uri('webview.css'))
      .split('{{iconsUri}}').join(uri('icons.js'))
      .split('{{formatUri}}').join(uri('workers-format.js'))
      .split('{{scriptUri}}').join(uri('workers-webview.js'))
  }

  const provider = {
    resolveWebviewView(webviewView) {
      view = webviewView
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(chatDir)],
      }
      webviewView.webview.html = html(webviewView.webview)
      webviewView.webview.onDidReceiveMessage(msg => {
        if (msg?.type === 'add-worker') return onAdd?.()
        if (msg?.type === 'open-worker') return onOpen?.(String(msg.handle ?? ''))
        if (msg?.type === 'stop-worker') return onStop?.(String(msg.handle ?? ''))
        // The view is destroyed and rebuilt whenever the sidebar is collapsed
        // and reopened, so it asks for the current fleet rather than waiting
        // for the next change -- which might never come.
        if (msg?.type === 'workers-refresh') {
          post(last)
          onRefresh?.()
        }
      })
      // A revealed view starts empty; replay immediately.
      post(last)
    },
  }

  function post(workers) {
    last = workers
    // The view may not be resolved yet (the sidebar has never been opened) or
    // may have been disposed. Neither is worth an exception.
    try { view?.webview?.postMessage({ type: 'workers', workers }) } catch { /* not visible */ }
  }

  return { provider, postWorkers: post }
}

module.exports = { createWorkersView }
