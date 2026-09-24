// extension/src/extension.js
//
// The thin layer that wires the already-tested modules (supervisor,
// room-client, orchestrator, stream) to VS Code and renders them. All logic
// lives in those modules; this file is deliberately just glue, which is what
// keeps the rest testable without VS Code.
'use strict'
const vscode = require('vscode')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')

const { createSupervisor } = require('./supervisor.js')
const { orchestratorRecipe, bridgeMcpConfig, createOrchestrator } = require('./orchestrator.js')
const { createChatPanel } = require('./chat/panel.js')
const { discoverSkills } = require('./skills.js')
const { saveAttachment } = require('./attachments.js')
const { isKnownMode, DEFAULT_MODE } = require('./chat/permissions.js')
const { createWorkersView } = require('./chat/workers-view.js')
const { createRoomView } = require('./chat/room-view.js')
const { createWorkerPanel } = require('./chat/worker-panel.js')
const { createSession } = require('./session.js')

// extension.js lives at <repoRoot>/extension/src/extension.js. "The
// extension's own directory" is <repoRoot>/extension; its parent is the repo
// root, which is what roomRecipe/orchestratorRecipe/bridgeMcpConfig need to
// find src/server.mjs and src/orchestrator-bridge.mjs.
const REPO_ROOT = path.join(__dirname, '..', '..')

let supervisor = null
let output = null
let roomSession = null // the room, its feed and its fleet — outlives any chat
let chat = null // { panel } — the live chat session, if one is open
let activeWorkersView = null // the sidebar, which outlives any session
let activeRoomView = null // the room sidebar, which outlives any session
let activeOpenWorker = null // opens a worker's tab, once a chat exists

function log(msg) {
  output?.appendLine(String(msg))
}

/**
 * The two things session.js genuinely needs VS Code for. Passing them in is
 * what keeps every other line of that file testable outside an extension host.
 */
const vscodeUi = {
  showError: m => vscode.window.showErrorMessage(m),
  showInfo: m => vscode.window.showInformationMessage(m),
  copy: t => vscode.env.clipboard.writeText(t),
}

/**
 * The room, started once and shared. Returns null (having already said why)
 * when it could not start, so every caller can simply check.
 */
async function ensureSession(context) {
  if (roomSession) return roomSession
  const storageDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath
  const stateDir = path.join(storageDir, 'room-state')
  fs.mkdirSync(stateDir, { recursive: true })

  const s = createSession({ repoRoot: REPO_ROOT, stateDir, supervisor, ui: vscodeUi, log })
  const started = await s.start()
  if (!started.ok) {
    vscode.window.showErrorMessage(`Claude Room: ${started.error}`)
    return null
  }
  roomSession = s
  s.onWorkers(list => activeWorkersView?.postWorkers(list))
  s.onRoom(room => activeRoomView?.postRoom(room))
  // The first paint: the views are already asking, and the answer needs the
  // roster the session has only just become able to read.
  s.postRoom().catch(err => log(`room state failed: ${err?.message ?? err}`))
  return s
}

/**
 * Run `fn` against the room session, starting it if this is the first ask.
 *
 * Every sidebar action goes through here, which is what makes "first reveal of
 * either view" the thing that starts the room -- rather than activation, which
 * would run a process for someone who never opens the panel.
 */
async function withSession(context, fn) {
  try {
    const s = await ensureSession(context)
    if (!s) return
    await fn(s)
  } catch (err) {
    log(`sidebar action failed: ${err?.stack ?? err}`)
    vscode.window.showErrorMessage(`Claude Room: ${err?.message ?? err}`)
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Room')
  supervisor = createSupervisor({ log })

  supervisor.on('exit', ({ name, code }) => {
    log(`${name} exited unexpectedly (code ${code ?? 'unknown'})`)
    chat?.panel.postFatal(
      `${name} exited unexpectedly (code ${code ?? 'unknown'}). Run "Claude Room: Restart Services" to continue.`,
    )
    // The room dying takes the SSE feed with it; stop reconnecting against a
    // process that is not coming back on its own.
    if (name === 'room') roomSession?.stop()
  })

  // Registered at activation, not per chat: the sidebar exists whether or not a
  // chat is open, and a view registered later would never appear.
  //
  // The room itself starts on the FIRST REVEAL of either view, not at
  // activation: a process for someone who never opens the panel is a cost with
  // no benefit, and both views ask for their state the moment they resolve.
  const workersView = createWorkersView({
    context,
    onAdd: () => withSession(context, s => s.pool.add()),
    onStop: handle => withSession(context, s => s.pool.stop(handle)),
    onOpen: handle => vscode.commands.executeCommand('claudeRoom.openWorker', handle),
    onRefresh: () => withSession(context, s => {
      workersView.postWorkers(s.pool.list())
    }),
  })
  activeWorkersView = workersView

  const roomView = createRoomView({
    context,
    onPublish: next => withSession(context, s => s.republish(next)),
    onInvite: async ({ role }) => {
      // The host owns the prompt: only it can show a native input box.
      const name = await vscode.window.showInputBox({
        prompt: 'Name for the join link',
        placeHolder: 'ana',
      })
      if (!name) return // cancelled: minting a seat nobody asked for helps nobody
      await withSession(context, s => s.invite({ name, role }))
    },
    onRefresh: () => withSession(context, s => s.postRoom()),
  })
  activeRoomView = roomView

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeRoom.room', roomView.provider),
    vscode.window.registerWebviewViewProvider('claudeRoom.workers', workersView.provider),
    vscode.commands.registerCommand('claudeRoom.openChat', () => openChat(context)),
    vscode.commands.registerCommand('claudeRoom.restart', () => restart(context)),
    vscode.commands.registerCommand('claudeRoom.openWorker', handle => {
      // The sidebar exists before any chat does. Without a chat there is no
      // worker tab to open, so say so rather than doing nothing at all.
      if (!activeOpenWorker) {
        vscode.window.showInformationMessage('Claude Room: worker tabs open from the orchestrator chat.')
        return
      }
      activeOpenWorker(String(handle ?? ''))
    }),
    output,
    { dispose: () => supervisor?.stopAll() },
  )
}

function deactivate() {
  roomSession?.stop()
  roomSession = null
  chat = null
  supervisor?.stopAll()
}

async function restart(context) {
  roomSession?.stop()
  roomSession = null
  chat = null
  supervisor.stopAll()
  if (await ensureSession(context)) await openChat(context)
}

async function openChat(context) {
  // Dormant by default (spec §4). The `when` clause hides this from the
  // palette, but a keybinding or another extension can still invoke a command
  // directly -- so refuse here too, and say where the switch is rather than
  // failing silently.
  if (!vscode.workspace.getConfiguration('claudeRoom').get('enableChat')) {
    vscode.window.showInformationMessage(
      'Claude Room: the orchestrator chat is off. Turn on "claudeRoom.enableChat" in Settings to use it — the Room and Workers views work without it.',
    )
    return
  }

  if (chat) {
    chat.panel.reveal()
    return
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]
  if (!workspace) {
    vscode.window.showErrorMessage('Claude Room: open a folder before starting a chat.')
    return
  }

  const session = await ensureSession(context)
  if (!session) return
  const { roomUrl, token, roomClient, pool } = session
  const storageDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath
  const stateDir = path.join(storageDir, 'room-state')

  const mcpConfigPath = path.join(stateDir, 'mcp-config.json')
  fs.writeFileSync(mcpConfigPath, JSON.stringify(bridgeMcpConfig(REPO_ROOT), null, 2))

  // Spec §3: a died-and-restarted orchestrator resumes the same conversation
  // with --resume <id> rather than losing the thread. workspaceState is the
  // natural place for this — it persists across both a crash and a full VS
  // Code restart, which is exactly when this matters most. The id is
  // committed before the process is even confirmed up: --resume and
  // --session-id both mint/continue the conversation at spawn time, so the
  // id to persist is already decided the moment the args are built.
  // Persisted per workspace, like the session id: a permission mode chosen
  // once should still be in force after a restart, and silently reverting to
  // the default would be the kind of quiet safety change nobody notices.
  const PERMISSION_KEY = 'claudeRoom.permissionMode'
  let permissionMode = context.workspaceState.get(PERMISSION_KEY) ?? DEFAULT_MODE

  const SESSION_KEY = 'claudeRoom.sessionId'
  const priorSessionId = context.workspaceState.get(SESSION_KEY) ?? null
  const sessionId = crypto.randomUUID()
  await context.workspaceState.update(SESSION_KEY, priorSessionId ?? sessionId)

  const orchProc = supervisor.start('orchestrator', orchestratorRecipe({
    repoRoot: REPO_ROOT,
    roomUrl,
    token,
    sessionId,
    priorSessionId,
    workspace: workspace.uri.fsPath,
    mcpConfigPath,
    permissionMode,
  }))

  // `orchestrator` is assigned below, after `panel` — the two need each
  // other, so `panel`'s onInput closes over this `let` binding rather than
  // a value that exists yet. Both are assigned synchronously before either
  // callback can actually fire, so by the time a message arrives on either
  // side the other half is always ready.
  const attachmentsDir = path.join(storageDir, 'attachments')

  /**
   * The three ways a file reaches the composer.
   *
   * A picked or dropped file keeps its own path — the orchestrator holds Read
   * and Glob, so a path is all it needs, and copying the bytes would only
   * create a second stale copy. A pasted image has no path, so one is made.
   */
  async function handleAttach(msg) {
    try {
      if (msg.type === 'attach-file') {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' })
        for (const uri of picked ?? []) panel.postAttached({ path: uri.fsPath })
        return
      }
      if (msg.type === 'attach-paths') {
        for (const p of msg.paths ?? []) panel.postAttached({ path: String(p) })
        return
      }
      if (msg.type === 'attach-paste') {
        const file = saveAttachment({ dir: attachmentsDir, mime: msg.mime, base64: msg.base64 })
        // The thumbnail reuses the bytes the webview already sent rather than
        // reading the file back off disk to show what it just handed over.
        panel.postAttached({ path: file, dataUrl: `data:${msg.mime};base64,${msg.base64}` })
      }
    } catch (err) {
      // An attachment that silently fails to attach is the worst outcome: the
      // user believes the file is on the message and it is not.
      vscode.window.showErrorMessage(`Claude Room: could not attach that file — ${err?.message ?? err}`)
      log(`attach failed: ${err?.stack ?? err}`)
    }
  }

  let orchestrator
  const panel = createChatPanel({
    context,
    onInput: text => {
      orchestrator?.send(text)
      // The last moment before a delegation is possible. `delegate` fails for
      // a handle that is not ONLINE, so a worker cannot be started in response
      // to one -- by then the orchestrator has already been told the handle
      // does not exist. A turn takes seconds, so a worker started here is
      // normally online before it is needed.
      pool.ensureOne().catch(err => log(`worker start failed: ${err?.message ?? err}`))
    },
    onAttach: handleAttach,
  })
  orchestrator = createOrchestrator({
    child: orchProc.child,
    onEvent: e => panel.postStream(e),
  })

  // One SSE subscription to the room, fanned out by the router: worker
  // activity (a delegation going out, a tool call) goes to the panel; a
  // finished or abandoned delegation is relayed to the orchestrator as a
  // turn. The router's ordering is what keeps a worker's reply from
  // reaching the orchestrator before the panel has shown the work, and
  // keeps a "sent" delegation from being relayed back as if it were the
  // orchestrator's own answer.
  // The `/` menu's skills, scanned off the startup path. The menu works
  // without them -- the commands are built in -- and a slow disk or a large
  // plugin cache must not delay the first message by even one frame.
  setTimeout(() => {
    try {
      panel.postSkills(discoverSkills({ workspace: workspace.uri.fsPath, home: os.homedir() }))
    } catch (err) {
      // A menu without skills is still a menu. This is never fatal.
      log(`skill discovery failed: ${err?.message ?? err}`)
    }
  }, 0)

  // One tab per worker, opened on demand from the sidebar and kept fed by the
  // same onChange every other surface uses.
  const workerPanels = new Map()

  function pushWorker(handle) {
    const p = workerPanels.get(handle)
    if (p) p.postWorker(pool.detail(handle))
  }

  function openWorker(handle) {
    const existing = workerPanels.get(handle)
    if (existing) return existing.reveal()
    const wp = createWorkerPanel({
      context,
      handle,
      onSay: (h, text) => roomClient.say(h, text),
      onInterrupt: h => log(`interrupt requested for ${h}`),
      onRefresh: h => pushWorker(h),
    })
    wp.onDidDispose(() => workerPanels.delete(handle))
    workerPanels.set(handle, wp)
    pushWorker(handle)
  }

  const offWorkers = session.onWorkers(list => {
    panel.postWorkers(list)
    // A worker whose tab is open sees every change, not only the ones that
    // happen to arrive while it is focused.
    for (const handle of workerPanels.keys()) pushWorker(handle)
  })

  activeOpenWorker = openWorker

  // The session holds the one subscription; the chat just asks to hear from it.
  const offActivity = session.onActivity(a => panel.postActivity(a))
  const offResults = session.onDelegationResult(d => orchestrator.relay(d))

  // --- the permission chip ----------------------------------------------
  //
  // Changing the permission mode restarts the ORCHESTRATOR with
  // --permission-mode and --resume. It does not tear down the chat.

  async function setPermissionMode(mode) {
    // Already gated in orchestratorRecipe, but refusing here too means a bad
    // value never reaches a process spawn at all.
    if (!isKnownMode(mode)) return
    permissionMode = mode
    await context.workspaceState.update(PERMISSION_KEY, mode)
    const prior = context.workspaceState.get(SESSION_KEY) ?? sessionId
    try {
      const proc = supervisor.start('orchestrator', orchestratorRecipe({
        repoRoot: REPO_ROOT, roomUrl, token,
        sessionId: crypto.randomUUID(),
        priorSessionId: prior,
        workspace: workspace.uri.fsPath,
        mcpConfigPath,
        permissionMode,
      }))
      // Reassign the SAME binding the panel's onInput closes over. Building a
      // second panel here would leave the first one wired to a dead process.
      orchestrator = createOrchestrator({ child: proc.child, onEvent: e => panel.postStream(e) })
      if (chat) chat.orchestrator = orchestrator
    } catch (err) {
      vscode.window.showErrorMessage(`Claude Room: could not switch permission mode — ${err?.message ?? err}`)
      log(`permission mode change failed: ${err?.stack ?? err}`)
    }
    panel.postPermissionMode(permissionMode)
  }

  panel.onControl(async msg => {
    if (msg.type === 'permission-mode') return setPermissionMode(String(msg.mode ?? ''))
  })

  panel.postPermissionMode(permissionMode)

  panel.onDidDispose(() => {
    offActivity()
    offResults()
    offWorkers()
    // The room, the feed and the fleet all belong to the session and keep
    // running: the sidebar is the front door, not this window.
    if (chat?.panel === panel) chat = null
  })

  chat = { panel, orchestrator, roomUrl, token, stateDir, pool }
}

module.exports = { activate, deactivate }
