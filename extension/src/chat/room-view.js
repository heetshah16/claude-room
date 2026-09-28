// extension/src/chat/room-view.js
//
// The Room sidebar view.
//
// Built exactly like chat/workers-view.js -- a WebviewView so it shares the
// chat's stylesheet, its icons and its row formatting, rather than a TreeView
// that could render none of them. Its own view rather than a header inside
// Workers: each view keeps one purpose.
//
// This file and workers-view.js are the only places besides chat/panel.js that
// touch the VS Code webview API; everything it renders lives in
// room-webview.js, inside the webview's own sandbox.
'use strict'
const vscode = require('vscode')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

const nonce = () => randomBytes(16).toString('base64')

/**
 * @param {{context: object, onPublish: Function, onInvite: Function, onRefresh: Function}} deps
 * @returns {{provider: object, postRoom: Function}}
 */
function createRoomView({ context, onPublish, onInvite, onRefresh }) {
  const extensionRoot = context.extensionUri?.fsPath ?? context.extensionPath
  const chatDir = join(extensionRoot, 'src', 'chat')

  let view = null
  /** The last room state posted, replayed when the view is revealed again. */
  let last = { published: false, advertised: null, members: null, busy: false }

  function html(webview) {
    const uri = f => String(webview.asWebviewUri(vscode.Uri.file(join(chatDir, f))))
    const n = nonce()
    return readFileSync(join(chatDir, 'room.html'), 'utf8')
      .split('{{cspSource}}').join(webview.cspSource)
      .split('{{nonce}}').join(n)
      .split('{{styleUri}}').join(uri('webview.css'))
      .split('{{iconsUri}}').join(uri('icons.js'))
      .split('{{scriptUri}}').join(uri('room-webview.js'))
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
        if (msg?.type === 'publish') return onPublish?.(!!msg.published)
        if (msg?.type === 'invite') return onInvite?.({ role: String(msg.role ?? 'member') })
        if (msg?.type === 'open-address') {
          // The token in this URL is never rendered by the webview (see
          // room-webview.js's hostOf) -- it only ever travels internally,
          // here, to actually open the owner's own working link.
          try { vscode.env.openExternal(vscode.Uri.parse(String(msg.url))) } catch { /* a bad URL is not fatal */ }
          return
        }
        // The view is destroyed and rebuilt whenever the sidebar is collapsed
        // and reopened, so it asks for the current room rather than waiting.
        if (msg?.type === 'room-refresh') {
          post(last)
          onRefresh?.()
        }
      })
      // A revealed view starts empty; replay immediately.
      post(last)
    },
  }

  function post(room) {
    // Merged so a partial `{busy: true}` does not blank the roster.
    last = { ...last, ...room }
    // The view may not be resolved yet (the sidebar has never been opened) or
    // may have been disposed. Neither is worth an exception.
    try { view?.webview?.postMessage({ type: 'room', room: last }) } catch { /* not visible */ }
  }

  return { provider, postRoom: post }
}

module.exports = { createRoomView }
