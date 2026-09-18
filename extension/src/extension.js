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
const os = require('node:os')

const { createSupervisor } = require('./supervisor.js')
const { roomRecipe, readOwnerToken, createRoomClient, PUBLISHED_HOST } = require('./room-client.js')
const { detectDevtunnel, tunnelRecipe, parseTunnelUrl } = require('./tunnel.js')
const { orchestratorRecipe, bridgeMcpConfig, createOrchestrator } = require('./orchestrator.js')
const { createEventRouter } = require('./events.js')
const { createChatPanel } = require('./chat/panel.js')
const { discoverSkills } = require('./skills.js')
const { saveAttachment } = require('./attachments.js')
const { isKnownMode, DEFAULT_MODE } = require('./chat/permissions.js')
const { createWorkerPool } = require('./workers.js')
const { createWorkersView } = require('./chat/workers-view.js')
const { createWorkerPanel } = require('./chat/worker-panel.js')

// extension.js lives at <repoRoot>/extension/src/extension.js. "The
// extension's own directory" is <repoRoot>/extension; its parent is the repo
// root, which is what roomRecipe/orchestratorRecipe/bridgeMcpConfig need to
// find src/server.mjs and src/orchestrator-bridge.mjs.
const REPO_ROOT = path.join(__dirname, '..', '..')

let supervisor = null
let output = null
let session = null // { panel } — the live chat session, if one is open
let activeWorkersView = null // the sidebar, which outlives any one session
let activeOpenWorker = null // opens a worker's tab, once a chat exists

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
    // The room dying takes the SSE feed with it; stop reconnecting against a
    // process that is not coming back on its own.
    if (name === 'room') session?.stopFeed?.()
  })

  // Registered at activation, not per chat: the sidebar exists whether or not
  // a chat is open, and a view registered later would never appear.
  const workersView = createWorkersView({
    context,
    onAdd: () => session?.pool?.add().catch(err => log(`add worker failed: ${err?.message ?? err}`)),
    onOpen: handle => vscode.commands.executeCommand('claudeRoom.openWorker', handle),
    onRefresh: () => workersView.postWorkers(session?.pool?.list() ?? []),
  })
  activeWorkersView = workersView

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeRoom.workers', workersView.provider),
    vscode.commands.registerCommand('claudeRoom.openChat', () => openChat(context)),
    vscode.commands.registerCommand('claudeRoom.restart', () => restart(context)),
    vscode.commands.registerCommand('claudeRoom.openWorker', handle => {
      // The sidebar exists before any chat does, so clicking a worker with no
      // session must say so rather than doing nothing at all.
      if (!activeOpenWorker) {
        vscode.window.showInformationMessage('Claude Room: open the orchestrator chat first.')
        return
      }
      activeOpenWorker(String(handle ?? ''))
    }),
    output,
    { dispose: () => supervisor?.stopAll() },
  )
}

function deactivate() {
  session?.stopFeed?.()
  session = null
  supervisor?.stopAll()
}

async function restart(context) {
  session?.stopFeed?.()
  session = null
  supervisor.stopAll()
  await openChat(context)
}

/**
 * Reads Server-Sent Events by hand off a fetch Response's streaming body.
 *
 * Deliberately NOT `src/seat.mjs`'s `readFrames`, even though the shape is
 * identical: `src/seat.mjs` is ESM and this extension is CommonJS.
 * `require(esm)` happens to interop on this machine's Node 22.19, but a VS
 * Code extension runs inside Electron's Node — a different runtime — and
 * betting portability on that interop working there too has no upside. This
 * is the same ~20 lines, duplicated on purpose: do not "fix" this by
 * reaching across the module-system boundary.
 *
 * Frames are separated by a blank line; only `event:`/`data:` lines matter,
 * so a bare `: comment` keep-alive (the room writes one on connect) is
 * silently skipped. `onFrame` fires once per complete frame; this resolves
 * when the stream ends.
 */
async function readEventStream(body, onFrame) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = null
      let data = null
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length)
        else if (line.startsWith('data: ')) data = line.slice('data: '.length)
      }
      if (data !== null) onFrame(event, data)
    }
  }
}

/**
 * One SSE subscription to the room's event feed, fanned out through
 * `router`. Reconnects on any drop (network blip, room restart) with a fixed
 * delay — the room feed matters for as long as the chat is open, so a
 * dropped connection is worth retrying rather than giving up on.
 *
 * @returns {() => void} stop — aborts the subscription and any pending retry.
 */
function subscribeToRoomEvents(roomClient, router) {
  let stopped = false
  let controller = null

  async function connectOnce() {
    controller = new AbortController()
    try {
      const res = await fetch(
        `${roomClient.roomUrl}/events?token=${encodeURIComponent(roomClient.token)}`,
        { signal: controller.signal },
      )
      if (!res.ok || !res.body) throw new Error(`room events feed failed: HTTP ${res.status}`)
      await readEventStream(res.body, (event, raw) => {
        if (!event) return // the room always sends event:; only OpenCode's raw feed omits it
        let data
        try { data = JSON.parse(raw) } catch { return } // a malformed frame must not kill the feed
        router.handle(event, data)
      })
    } catch {
      // Aborted by stop(), a network error, or a bad response — every case
      // is handled the same way below: try again unless told to stop.
    }
  }

  ;(async () => {
    while (!stopped) {
      await connectOnce()
      if (stopped) return
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  })()

  return () => {
    stopped = true
    controller?.abort()
  }
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

  const roomClient = createRoomClient({ roomUrl, token })

  // The worker fleet. Nothing is spawned here: a chat-only session should pay
  // no worktree, no process, and should not need `opencode` on PATH at all.
  const pool = createWorkerPool({ roomClient, supervisor, repoRoot: REPO_ROOT, roomUrl, log })
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

  pool.onChange(list => {
    panel.postWorkers(list)
    activeWorkersView?.postWorkers(list)
    // A worker whose tab is open sees every change, not only the ones that
    // happen to arrive while it is focused.
    for (const handle of workerPanels.keys()) pushWorker(handle)
  })

  session = session ?? null
  activeOpenWorker = openWorker

  const router = createEventRouter({
    onWorkerActivity: a => panel.postActivity(a),
    onDelegationResult: d => orchestrator.relay(d),
    // One subscription, one ordering: the pool observes the same stream the
    // panel does rather than opening a second.
    onRoomEvent: (event, data) => pool.applyRoomEvent(event, data),
  })
  const stopFeed = subscribeToRoomEvents(roomClient, router)

  // --- the room chip and the permission chip ---------------------------
  //
  // Both work by restarting a child. Publishing restarts the ROOM with a
  // different bind address on the same port and state dir; changing the
  // permission mode restarts the ORCHESTRATOR with --permission-mode and
  // --resume. Neither tears down the chat.

  let published = false

  /** Send the webview everything its room popover renders. */
  async function postRoom(extra = {}) {
    const state = await roomClient.adminState()
    panel.postRoom({
      published,
      // Taken from a join link rather than recomputed here: the room is the
      // only thing that knows which address it decided to advertise.
      advertised: state?.members?.[0]?.joinUrl ?? null,
      // null adminState means the call failed, not that the room is empty --
      // so send null and let the popover say it does not know.
      members: state
        ? state.members.map(m => ({ id: m.id, name: m.name, role: m.role }))
        : null,
      ...extra,
    })
  }

  async function republish(next) {
    panel.postRoom({ busy: true, published })
    try {
      if (next) {
        if (!detectDevtunnel()) {
          vscode.window.showErrorMessage(
            'Claude Room: the devtunnel CLI is not installed. Run: winget install --id Microsoft.devtunnel -e, then devtunnel user login, then try Publish again.',
          )
          await postRoom({ busy: false })
          return
        }
        supervisor.start('tunnel', tunnelRecipe({ port }))
        // The CLI prints its URL once, on stdout, then keeps running -- poll the
        // supervisor's own stdout buffer rather than re-parenting a second reader.
        const tunnelUrl = await pollWithBackoff(() => parseTunnelUrl(supervisor.status('tunnel').output ?? ''))
        if (!tunnelUrl) {
          vscode.window.showErrorMessage('Claude Room: devtunnel did not report a URL within 10s. Is `devtunnel user login` done?')
          supervisor.stop('tunnel')
          await postRoom({ busy: false })
          return
        }
        supervisor.start('room', roomRecipe({ repoRoot: REPO_ROOT, stateDir, port, host: PUBLISHED_HOST, advertise: tunnelUrl }))
      } else {
        supervisor.stop('tunnel')
        supervisor.start('room', roomRecipe({ repoRoot: REPO_ROOT, stateDir, port, host: '127.0.0.1' }))
      }
      await waitForRoomUp(roomUrl)
      published = next
    } catch (err) {
      // The room not coming back is the one failure here that matters, and it
      // must not be silent: the chat would keep accepting input against it.
      vscode.window.showErrorMessage(`Claude Room: the room did not restart — ${err?.message ?? err}`)
      log(`republish failed: ${err?.stack ?? err}`)
    }
    // The SSE feed reconnects on its own existing retry loop, so nothing else
    // needs doing here.
    await postRoom({ busy: false })
  }

  async function invite({ name, role }) {
    const r = await roomClient.invite({ name, role })
    if (!r?.ok) {
      vscode.window.showErrorMessage(`Claude Room: could not invite ${name} — ${r?.errors?.[0] ?? 'unknown error'}`)
      return
    }
    // The token IS the identity, so it goes to the clipboard rather than into
    // the transcript, where it would be visible to anyone reading over a
    // shoulder or scrolling back.
    await vscode.env.clipboard.writeText(r.joinUrl)
    vscode.window.showInformationMessage(`Claude Room: join link for ${name} copied to the clipboard.`)
    await postRoom()
  }

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
      if (session) session.orchestrator = orchestrator
    } catch (err) {
      vscode.window.showErrorMessage(`Claude Room: could not switch permission mode — ${err?.message ?? err}`)
      log(`permission mode change failed: ${err?.stack ?? err}`)
    }
    panel.postPermissionMode(permissionMode)
  }

  panel.onControl(async msg => {
    if (msg.type === 'publish') return republish(!!msg.published)
    if (msg.type === 'invite') return invite({ name: String(msg.name ?? ''), role: String(msg.role ?? 'member') })
    if (msg.type === 'permission-mode') return setPermissionMode(String(msg.mode ?? ''))
    if (msg.type === 'room-refresh') return postRoom()
  })

  panel.postPermissionMode(permissionMode)
  postRoom().catch(err => log(`room state failed: ${err?.message ?? err}`))

  panel.onDidDispose(() => {
    stopFeed()
    // Every worker holds a worktree and an `opencode serve`; leaving them
    // behind orphans both.
    pool.stopAll()
    if (session?.panel === panel) session = null
  })

  session = { panel, orchestrator, roomClient, stopFeed, roomUrl, token, stateDir, pool }
}

module.exports = { activate, deactivate }
