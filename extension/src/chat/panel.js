// extension/src/chat/panel.js
'use strict'
const vscode = require('vscode')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

const nonce = () => randomBytes(16).toString('base64')

// Messages from the chips that only the extension host can act on. An
// allowlist rather than a prefix test: these reach process spawns, so an
// unrecognised type must fall on the floor rather than be forwarded.
const CONTROL_TYPES = new Set(['publish', 'invite', 'permission-mode', 'room-refresh'])

/**
 * The chat webview: one panel, driven entirely through postMessage.
 *
 * This module is the only place that touches the VS Code webview API; all
 * rendering lives in webview.js, which runs inside the webview's own
 * sandboxed context. Keeping that split means webview.js can be read (and
 * eventually tested) without pulling in `vscode`, and this file stays thin
 * enough to trust by inspection.
 */
function createChatPanel({ context, onInput, onAttach }) {
  // Assigned by onControl below; the room and permission chips are wired after
  // the panel exists, because their handlers need the room client and the
  // supervisor, which are built later in openChat.
  let onControlMsg = null
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
  const markdownUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'markdown.js')))
  const modelUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'model.js')))
  const iconsUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'icons.js')))
  const contextUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'context.js')))
  const probesUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'probes.js')))
  const commandsUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'commands.js')))
  const permissionsUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'permissions.js')))
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(join(chatDir, 'webview.css')))
  const n = nonce()

  // The same nonce is stamped on every <script> tag webview.html has
  // (markdown.js, model.js, webview.js) so all three -- and nothing else --
  // are allowed to run. The CSP meta tag blocks everything else, including
  // any innerHTML a future edit might be tempted to add.
  const html = readFileSync(join(chatDir, 'webview.html'), 'utf8')
    .split('{{cspSource}}').join(panel.webview.cspSource)
    .split('{{nonce}}').join(n)
    .split('{{scriptUri}}').join(String(scriptUri))
    .split('{{markdownUri}}').join(String(markdownUri))
    .split('{{modelUri}}').join(String(modelUri))
    .split('{{iconsUri}}').join(String(iconsUri))
    .split('{{contextUri}}').join(String(contextUri))
    .split('{{probesUri}}').join(String(probesUri))
    .split('{{commandsUri}}').join(String(commandsUri))
    .split('{{permissionsUri}}').join(String(permissionsUri))
    .split('{{styleUri}}').join(String(styleUri))

  panel.webview.html = html

  panel.webview.onDidReceiveMessage(msg => {
    if (msg?.type === 'input' && typeof msg.text === 'string' && msg.text.trim()) {
      onInput(msg.text)
      return
    }
    // attach-file (open a picker), attach-paths (dropped), attach-paste
    // (clipboard bytes). All three are the host's job: only it has a
    // filesystem and a file dialog.
    if (typeof msg?.type === 'string' && msg.type.startsWith('attach')) {
      onAttach?.(msg)
      return
    }
    // publish / invite / permission-mode / room-refresh: each restarts or
    // queries a child process, which only the extension host can do.
    if (CONTROL_TYPES.has(msg?.type)) onControlMsg?.(msg)
  })

  // The webview can already be gone (panel closed mid-turn) by the time an
  // orchestrator event arrives; postMessage on a disposed webview throws,
  // and a stream event is not worth crashing the extension host over.
  const post = message => { try { panel.webview.postMessage(message) } catch { /* panel disposed */ } }

  return {
    panel,
    postStream: event => post({ type: 'stream', event }),
    postActivity: activity => post({ type: 'activity', activity }),
    postSkills: skills => post({ type: 'skills', skills }),
    postRoom: room => post({ type: 'room', room }),
    postPermissionMode: mode => post({ type: 'permission-mode', mode }),
    /** Register the handler for the chips' control messages. */
    onControl: fn => { onControlMsg = fn },
    postAttached: a => post({ type: 'attached', path: a.path, dataUrl: a.dataUrl ?? null }),
    postFatal: message => post({ type: 'fatal', message }),
    reveal: () => panel.reveal(vscode.ViewColumn.One),
    onDidDispose: cb => panel.onDidDispose(cb),
  }
}

module.exports = { createChatPanel }
