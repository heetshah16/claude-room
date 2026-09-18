// extension/src/chat/webview.js
//
// Runs inside the webview's sandboxed context — no Node, no filesystem, only
// what the extension host posts in and what the CSP in webview.html allows
// to run. Driven entirely by postMessage in both directions.
//
// Every server- or model-supplied string is rendered with textContent (or,
// for assistant text, through markdown.js's renderMarkdown, which itself
// only ever builds DOM nodes and sets textContent — see that file's header).
// Never innerHTML. Message text, thinking, tool inputs, tool results and
// worker activity are all untrusted — same rule src/ui.mjs states for the
// room's own browser client, same reason.
'use strict'
;(function () {
  const vscode = acquireVsCodeApi()
  const { renderMarkdown } = window.ClaudeMarkdown
  const { parseModelList, isRealModel } = window.ClaudeModel
  const { icon } = window.ClaudeIcons
  const { parseContextReport, verdictFor, bandsOf, fmtTokens } = window.ClaudeContext
  const { createProbeQueue } = window.ClaudeProbes
  const { COMMANDS, filterEntries } = window.ClaudeCommands
  const { PERMISSION_MODES, DEFAULT_MODE, modeById } = window.ClaudePermissions

  const messagesEl = document.getElementById('messages')
  const inputEl = document.getElementById('input')
  const sendEl = document.getElementById('send')
  const fatalEl = document.getElementById('fatal')
  const rateLimitEl = document.getElementById('rate-limit')
  const statusEl = document.getElementById('status')
  const modelPickerEl = document.getElementById('model-picker')
  const modelSelectEl = document.getElementById('model-select')
  const emptyStateEl = document.getElementById('empty-state')
  const contextChipEl = document.getElementById('context-chip')
  const contextPanelEl = document.getElementById('context-panel')
  const contextTotalEl = document.getElementById('context-total')
  const contextBarEl = document.getElementById('context-bar')
  const contextLegendEl = document.getElementById('context-legend')
  const contextVerdictEl = document.getElementById('context-verdict')
  const contextTablesEl = document.getElementById('context-tables')
  const dashEl = document.getElementById('dashboard')
  const dashListEl = document.getElementById('dash-list')
  const dashEmptyEl = document.getElementById('dash-empty')
  const dashBtnEl = document.getElementById('dash-btn')
  const attachBtnEl = document.getElementById('attach-btn')
  const roomChipEl = document.getElementById('room-chip')
  const roomPanelEl = document.getElementById('room-panel')
  const roomStateEl = document.getElementById('room-state')
  const roomAddressEl = document.getElementById('room-address')
  const roomNoteEl = document.getElementById('room-note')
  const roomMembersEl = document.getElementById('room-members')
  const publishBtnEl = document.getElementById('publish-btn')
  const inviteBtnEl = document.getElementById('invite-btn')
  const permissionChipEl = document.getElementById('permission-chip')
  const permissionPanelEl = document.getElementById('permission-panel')
  const permissionListEl = document.getElementById('permission-list')

  // Every probe the chat runs on its own behalf goes through one queue, so a
  // turn-end can say which probe it answered instead of two booleans guessing.
  const probes = createProbeQueue({
    send: text => vscode.postMessage({ type: 'input', text }),
  })

  // Shown only until the first thing is appended to the conversation --
  // hidden here rather than left to a CSS :empty rule because #messages
  // always has the empty-state div itself as a child, so it is never
  // actually empty in the DOM sense. Would be un-hidden again by a future
  // "new conversation" action, if one is ever wired.
  function hideEmptyState() {
    if (emptyStateEl) emptyStateEl.hidden = true
  }

  // The bubble currently receiving `text` chunks, plus its raw markdown so
  // each new chunk can be re-rendered whole rather than appended as plain
  // text (streaming markdown has to re-parse as more of a construct like a
  // fenced code block arrives). Any other event kind ends it, so the next
  // `text` event opens a fresh bubble rather than appending after an
  // unrelated tool row or thinking block.
  let currentBubble = null
  let currentBubbleText = ''
  const toolCards = new Map() // tool_use id -> card DOM element

  // Auto-scroll unless the user has deliberately scrolled up to read
  // something earlier — a streaming reply must not yank them back down.
  let userScrolledUp = false
  const NEAR_BOTTOM_PX = 24
  messagesEl.addEventListener('scroll', () => {
    const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
    userScrolledUp = gap > NEAR_BOTTOM_PX
  })
  function maybeScrollToBottom() {
    if (!userScrolledUp) messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function roleLabel(role) {
    if (role === 'user') return 'You'
    if (role === 'assistant') return 'Claude'
    return ''
  }

  // Flat, full-width message block: a small muted role label above the
  // body, no bubble, no per-role background — matching Claude Code's layout
  // rather than a messaging app's.
  function appendMsg(role, text) {
    hideEmptyState()
    const el = document.createElement('div')
    el.className = `msg ${role}`
    const label = document.createElement('div')
    label.className = 'msg-role'
    label.textContent = roleLabel(role)
    const body = document.createElement('div')
    body.className = 'msg-body'
    body.textContent = text
    el.appendChild(label)
    el.appendChild(body)
    messagesEl.appendChild(el)
    maybeScrollToBottom()
    return { el, body }
  }

  function endBubble() {
    currentBubble = null
    currentBubbleText = ''
  }

  function onText(text) {
    // A probe's answer must not appear as a chat message -- it is parsed in
    // onTurnEnd and nothing else. The chat asked for it, not the user.
    if (probes.suppressing()) return
    if (!currentBubble) {
      currentBubble = appendMsg('assistant', '')
      currentBubbleText = ''
    }
    currentBubbleText += text
    // Re-render the whole accumulated text as markdown on every chunk. The
    // body only ever holds what renderMarkdown just built, via
    // appendChild — never innerHTML.
    currentBubble.body.textContent = ''
    currentBubble.body.appendChild(renderMarkdown(currentBubbleText, document))
    maybeScrollToBottom()
  }

  // Chunks of the same thinking block arrive back-to-back; this tracks the
  // open block's body so they append to one disclosure instead of opening a
  // new collapsed section per chunk.
  let currentThinkingBody = null

  function onThinking(text) {
    hideEmptyState()
    endBubble()
    const details = document.createElement('details')
    details.className = 'thinking'
    const summary = document.createElement('summary')
    summary.textContent = 'Thinking'
    const body = document.createElement('div')
    body.className = 'thinking-body'
    body.textContent = text
    details.appendChild(summary)
    details.appendChild(body)
    messagesEl.appendChild(details)
    maybeScrollToBottom()
    currentThinkingBody = body
  }

  // A one-line summary of a tool's input, for the collapsed disclosure row.
  // Falls back to the raw JSON, truncated, if there is nothing more specific.
  function summariseInput(input) {
    if (!input || typeof input !== 'object') return ''
    if (typeof input.command === 'string') return input.command
    if (typeof input.file_path === 'string') return input.file_path
    if (typeof input.path === 'string') return input.path
    if (typeof input.pattern === 'string') return input.pattern
    if (typeof input.query === 'string') return input.query
    const json = safeJson(input)
    return json.length > 140 ? json.slice(0, 140) + '…' : json
  }

  function onToolUse(ev) {
    hideEmptyState()
    endBubble()
    currentThinkingBody = null
    // A compact disclosure row: <details> gives the platform's own
    // triangle marker for free; the summary line is the tool name plus a
    // one-line input summary, and the body (appended lazily as content
    // arrives) holds the full input/result.
    const card = document.createElement('details')
    card.className = 'card pending'
    const title = document.createElement('summary')
    title.className = 'card-title'
    const name = document.createElement('span')
    name.className = 'card-name'
    name.appendChild(icon('wrench', document))
    const nameText = document.createElement('span')
    nameText.textContent = ev.name
    name.appendChild(nameText)
    const summary = document.createElement('span')
    summary.className = 'card-summary'
    summary.textContent = summariseInput(ev.input)
    title.appendChild(name)
    title.appendChild(summary)
    const body = document.createElement('div')
    body.className = 'card-body'
    body.textContent = safeJson(ev.input)
    card.appendChild(title)
    card.appendChild(body)
    messagesEl.appendChild(card)
    toolCards.set(ev.id, { card, title, body })
    maybeScrollToBottom()
  }

  function onToolResult(ev) {
    const entry = toolCards.get(ev.id)
    const text = resultText(ev.content)
    if (!entry) {
      // A result with no matching card (e.g. the webview reopened mid-turn)
      // is still worth showing — just as its own row, unmatched.
      hideEmptyState()
      const card = document.createElement('details')
      card.className = `card${ev.isError ? ' tool-error' : ''}`
      const title = document.createElement('summary')
      title.className = 'card-title'
      title.textContent = ev.isError ? 'Tool result (error)' : 'Tool result'
      const body = document.createElement('div')
      body.className = 'card-body'
      body.textContent = text
      card.appendChild(title)
      card.appendChild(body)
      messagesEl.appendChild(card)
      maybeScrollToBottom()
      return
    }
    entry.card.classList.remove('pending')
    if (ev.isError) entry.card.classList.add('tool-error')
    const resultBody = document.createElement('div')
    resultBody.className = 'card-body'
    resultBody.textContent = text
    entry.card.appendChild(resultBody)
    maybeScrollToBottom()
  }

  function resultText(content) {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map(b => (typeof b?.text === 'string' ? b.text : safeJson(b))).join('\n')
    }
    return safeJson(content)
  }

  function safeJson(v) {
    try { return JSON.stringify(v, null, 2) } catch { return String(v) }
  }

  function setStatus(text) {
    if (!text) { statusEl.hidden = true; statusEl.textContent = ''; return }
    statusEl.hidden = false
    statusEl.textContent = text
  }

  function onThinkingTokens(tokens) {
    setStatus(`Thinking… (${tokens} tokens)`)
  }

  // --- model picker ----------------------------------------------------
  //
  // The composer shows the live model, tracked from `model` stream events
  // (stream.js already filters out `<synthetic>` — a local slash command
  // answering, not a model change). Clicking the button asks the
  // orchestrator to run a bare `/model`, whose result text is parsed for
  // the available list rather than a hardcoded table, so it can't drift
  // from what the installed binary actually supports.
  // The known option list, populated by the probe. Held rather than rendered
  // immediately: the select is a popover the chip owns, not a replacement for
  // it. An earlier version set `modelPickerEl.hidden = list.length > 0`, so
  // once the session-start probe answered, the composer showed a bare native
  // dropdown instead of the chip -- on every launch, permanently. The first
  // harness screenshot is what made that obvious.
  let modelOptions = []

  function setCurrentModel(model) {
    modelPickerEl.textContent = model
  }

  function showModelOptions(list) {
    modelOptions = list
    modelSelectEl.textContent = ''
    for (const name of list) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      modelSelectEl.appendChild(opt)
    }
  }

  function closeModelOptions() {
    modelSelectEl.hidden = true
    modelPickerEl.hidden = false
    modelPickerEl.setAttribute('aria-expanded', 'false')
  }

  modelPickerEl.addEventListener('click', () => {
    // Nothing to choose from yet: ask, and the answer populates the list for
    // the next click rather than opening an empty menu now.
    if (modelOptions.length === 0) {
      probes.request('model')
      return
    }
    modelSelectEl.hidden = false
    modelPickerEl.hidden = true
    modelPickerEl.setAttribute('aria-expanded', 'true')
    modelSelectEl.focus()
  })

  modelSelectEl.addEventListener('change', () => {
    const chosen = modelSelectEl.value
    closeModelOptions()
    if (chosen) vscode.postMessage({ type: 'input', text: `/model ${chosen}` })
  })

  // Dismissing without choosing must restore the chip, or the composer is
  // stuck showing a dropdown the user already declined.
  modelSelectEl.addEventListener('blur', closeModelOptions)

  function onModel(model) {
    if (isRealModel(model)) setCurrentModel(model)
  }

  // A bare `/model` is answered locally (a synthetic turn — no model call,
  // no cost), which is why `onModel` above never fires for it: stream.js
  // filters `<synthetic>` model values before emitting a `model` event. So
  // the picker is populated here instead, once the probe's turn-end arrives.
  // Sent once per session so the chip reflects reality before the user's
  // first real turn, instead of showing "(unknown)" until they've sent one.
  let modelProbeSent = false
  function onSessionEstablished() {
    if (modelProbeSent) return
    modelProbeSent = true
    probes.request('model')
  }

  // --- context panel ---------------------------------------------------

  function renderContext(report) {
    // Not a context report: leave the last good one on screen rather than
    // blanking the panel, which would read as the feature being broken.
    if (!report) return

    contextChipEl.textContent = `context: ${fmtTokens(report.usedTokens)} · ${report.pct}%`
    contextTotalEl.textContent =
      `${fmtTokens(report.usedTokens)} of ${fmtTokens(report.totalTokens)} · ${report.pct}% used`

    // The bar is normalised to what is LOADED, not to the window. Scaled
    // against a 1m window a 20k context is a two-pixel sliver in which no
    // proportion is legible -- and "what is filling my context" is the whole
    // question. How full the window is is already on the chip and in the line
    // above; this bar answers the other question.
    const bands = bandsOf(report)
    contextBarEl.textContent = ''
    for (const band of bands) {
      const seg = document.createElement('div')
      seg.className = `seg seg-${band.key}`
      seg.style.width = `${band.share * 100}%`
      contextBarEl.appendChild(seg)
    }

    // Also the accessible reading of the bar, which is why it carries the
    // numbers and the shares rather than just the names.
    contextLegendEl.textContent = ''
    for (const band of bands) {
      const item = document.createElement('span')
      item.className = 'legend-item'
      const sw = document.createElement('i')
      sw.className = `swatch seg-${band.key}`
      const label = document.createElement('span')
      label.textContent = `${band.label} ${fmtTokens(band.tokens)} · ${Math.round(band.share * 100)}%`
      item.appendChild(sw)
      item.appendChild(label)
      contextLegendEl.appendChild(item)
    }

    const verdict = verdictFor(report)
    contextVerdictEl.hidden = !verdict
    contextVerdictEl.textContent = verdict || ''

    contextTablesEl.textContent = ''
    // Six bands is what the bar can carry; the exact nine categories live one
    // disclosure away, which is where the system-tools-versus-deferred split
    // actually matters.
    appendDetail('All categories', report.categories
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .map(c => [c.label, '', fmtTokens(c.tokens)]))
    appendDetail('Skills', report.skills.map(s => [s.name, s.source, fmtTokens(s.tokens)]))
    appendDetail('Memory files', report.memoryFiles.map(f => [f.path, f.type, fmtTokens(f.tokens)]))
  }

  function appendDetail(title, rows) {
    if (!rows.length) return
    const d = document.createElement('details')
    d.className = 'detail'
    const s = document.createElement('summary')
    s.textContent = `${title} · ${rows.length}`
    d.appendChild(s)
    for (const cols of rows) {
      const row = document.createElement('div')
      row.className = 'detail-row'
      for (const text of cols) {
        const cell = document.createElement('span')
        cell.textContent = text
        row.appendChild(cell)
      }
      d.appendChild(row)
    }
    contextTablesEl.appendChild(d)
  }

  // --- popovers ---------------------------------------------------------
  //
  // Exactly one chip-owned popover is open at a time. Two open at once would
  // stack over the composer and hide what is being typed.
  const POPOVERS = [
    [contextChipEl, contextPanelEl],
    [roomChipEl, roomPanelEl],
    [permissionChipEl, permissionPanelEl],
  ]

  function closePopovers(except) {
    for (const [chip, panelEl] of POPOVERS) {
      if (panelEl === except) continue
      panelEl.hidden = true
      chip.setAttribute('aria-expanded', 'false')
    }
  }

  /** @returns {boolean} whether the popover ended up open. */
  function togglePopover(chip, panelEl) {
    const opening = panelEl.hidden
    closePopovers(opening ? panelEl : null)
    panelEl.hidden = !opening
    chip.setAttribute('aria-expanded', String(opening))
    return opening
  }

  contextChipEl.addEventListener('click', () => {
    // Opening is a request to see current numbers, not stale ones.
    if (togglePopover(contextChipEl, contextPanelEl)) probes.request('context')
  })

  // --- turn lifecycle ----------------------------------------------------

  function onTurnEnd(ev) {
    // Which probe, if any, this turn answered. A probe's turn is not a
    // conversational turn: onText already refused to render its output, and
    // nothing belongs in the transcript for it either -- a "turn ended" line
    // would dismiss the empty state before the user has sent anything.
    const answered = probes.onTurnEnd()
    endBubble()
    currentThinkingBody = null
    setStatus('')

    if (answered === 'model') {
      const { current, available } = parseModelList(ev.text ?? '')
      if (current) setCurrentModel(current)
      if (available.length) showModelOptions(available)
      return
    }
    if (answered === 'context') {
      renderContext(parseContextReport(ev.text ?? ''))
      return
    }

    const cost = typeof ev.costUsd === 'number' ? ev.costUsd : 0
    appendMsg('system', `turn ended · ${ev.turns} turn(s) · $${cost.toFixed(4)}`)

    // Refresh the budget after real work, while the process is idle anyway.
    // A probe's own turn-end took one of the branches above, so this cannot
    // recur -- that guard is the whole reason probes.js exists.
    probes.request('context')
  }

  function onRateLimit(ev) {
    if (ev.status === 'allowed') {
      rateLimitEl.hidden = true
      rateLimitEl.textContent = ''
      return
    }
    rateLimitEl.hidden = false
    const resetInfo = ev.resetsAt ? ` — resets ${ev.resetsAt}` : ''
    rateLimitEl.textContent = `Rate limited (${ev.status}${ev.limitType ? `, ${ev.limitType}` : ''})${resetInfo}`
  }

  function onActivity(activity) {
    hideEmptyState()
    endBubble()
    currentThinkingBody = null
    const card = document.createElement('div')
    card.className = 'card activity'
    const title = document.createElement('div')
    title.className = 'card-title'
    // A worker's tool call gets the same drawn wrench a local tool call does,
    // so the two read as the same kind of event happening in two places.
    if (activity?.tool) {
      title.classList.add('card-name')
      title.appendChild(icon('wrench', document))
      const t = document.createElement('span')
      t.textContent = `@${activity.handle ?? 'worker'} – ${activity.tool}`
      title.appendChild(t)
    } else {
      title.textContent = activityTitle(activity)
    }
    card.appendChild(title)
    if (activity && (activity.input || activity.task)) {
      const body = document.createElement('div')
      body.className = 'card-body'
      body.textContent = activity.input ? safeJson(activity.input) : String(activity.task)
      card.appendChild(body)
    }
    messagesEl.appendChild(card)
    maybeScrollToBottom()
  }

  // Only the text-only cases. A tool activity is built with an icon by the
  // caller, because a title that is a node cannot be returned as a string.
  function activityTitle(a) {
    if (!a) return 'Worker activity'
    if (a.kind === 'delegation-sent') return `→ delegated to @${a.handle}`
    return `Worker activity: @${a.handle ?? 'unknown'}`
  }

  function onFatal(message) {
    fatalEl.hidden = false
    fatalEl.textContent = message
    setStatus('')
    inputEl.disabled = true
    sendEl.disabled = true
  }

  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'stream') {
      const ev = msg.event ?? {}
      switch (ev.kind) {
        case 'text': return onText(ev.text ?? '')
        case 'thinking':
          if (currentThinkingBody) { currentThinkingBody.textContent += ev.text ?? ''; maybeScrollToBottom(); return }
          return onThinking(ev.text ?? '')
        case 'tool': return onToolUse(ev)
        case 'tool-result': return onToolResult(ev)
        case 'thinking-tokens': return onThinkingTokens(ev.tokens ?? 0)
        case 'turn-end': return onTurnEnd(ev)
        case 'rate-limit': return onRateLimit(ev)
        case 'model': return onModel(ev.model)
        case 'session': return onSessionEstablished()
        default: return // anything unrecognised: nothing to render
      }
    }

    if (msg.type === 'room') {
      room = { ...room, ...msg.room }
      renderRoom()
      return
    }
    if (msg.type === 'permission-mode') {
      permissionMode = msg.mode || DEFAULT_MODE
      renderPermissionMode()
      return
    }
    if (msg.type === 'attached') {
      attached.push({ path: String(msg.path), dataUrl: msg.dataUrl ?? null })
      renderAttachments()
      inputEl.focus()
      return
    }
    if (msg.type === 'skills') {
      skillEntries = Array.isArray(msg.skills) ? msg.skills : []
      // Re-filter in place if the menu is already open: skills arrive after a
      // disk walk, which can easily land while someone is mid-query.
      if (dashOpen()) openDash(currentQuery() ?? '')
      return
    }
    if (msg.type === 'activity') return onActivity(msg.activity)
    if (msg.type === 'fatal') return onFatal(String(msg.message ?? 'The orchestrator process has stopped.'))
  })

  // --- the room chip ----------------------------------------------------

  let room = { published: false, advertised: null, members: null, busy: false }

  /** The host part of a join link, which is what "published to" actually means. */
  function hostOf(joinUrl) {
    if (!joinUrl) return null
    // Deliberately not `new URL(...).host`: the link carries a token in its
    // query string, and nothing here should be one slip away from rendering it.
    const m = /^https?:\/\/([^/?#]+)/.exec(String(joinUrl))
    return m ? m[1] : null
  }

  function renderRoom() {
    const where = hostOf(room.advertised)
    roomChipEl.textContent = room.busy
      ? 'Room · …'
      : `Room · ${room.published ? 'Published' : 'Local'}`

    // The header carries the STATE, the line under the button carries the
    // ADDRESS. Putting the address in both read as two different facts.
    roomStateEl.textContent = room.busy ? 'restarting…' : room.published ? 'published' : 'local only'

    publishBtnEl.textContent = room.published ? 'Stop sharing' : 'Publish with Dev Tunnels'
    publishBtnEl.disabled = room.busy

    // The address is the whole decision: "publish" on shared office wifi means
    // something very different from "publish" on a tailnet, and this is what
    // tells them apart. Shown for both states so it is legible before the
    // button is pressed, not only after.
    roomAddressEl.textContent = room.published
      ? (where ?? 'address unknown')
      : '127.0.0.1 — reachable only from this machine'
    roomAddressEl.hidden = false
    roomNoteEl.textContent = room.busy
      ? 'The chat keeps going.'
      : 'Restarts the room (about a second). The chat keeps going.'

    roomMembersEl.textContent = ''
    if (room.members === null) {
      // null means the roster call FAILED. Saying "nobody is here" would be a
      // confident lie about who can read the room.
      const unknown = document.createElement('div')
      unknown.className = 'room-member muted'
      unknown.textContent = room.busy ? 'checking…' : 'could not read the roster'
      roomMembersEl.appendChild(unknown)
      return
    }
    for (const m of room.members) {
      const row = document.createElement('div')
      row.className = 'room-member'
      const name = document.createElement('span')
      // A member name is typed by a person and arrives over HTTP. textContent.
      name.textContent = m.name
      const role = document.createElement('span')
      role.className = 'room-role'
      role.textContent = m.role
      row.appendChild(name)
      row.appendChild(role)
      roomMembersEl.appendChild(row)
    }
  }

  roomChipEl.addEventListener('click', () => {
    if (togglePopover(roomChipEl, roomPanelEl)) vscode.postMessage({ type: 'room-refresh' })
  })

  publishBtnEl.addEventListener('click', () => {
    if (room.busy) return
    vscode.postMessage({ type: 'publish', published: !room.published })
  })

  inviteBtnEl.addEventListener('click', () => {
    // The host owns the prompt: a webview cannot show a native input box, and
    // a bespoke one here would be a worse version of one VS Code already has.
    vscode.postMessage({ type: 'invite', role: 'member' })
  })

  // --- the permission chip ----------------------------------------------

  let permissionMode = DEFAULT_MODE
  // Cleared whenever the popover closes, so a confirmation never survives to
  // be satisfied by an unrelated click later.
  let armedDestructive = null

  function renderPermissionMode() {
    const mode = modeById(permissionMode)
    permissionChipEl.textContent = mode ? mode.label : permissionMode
    permissionChipEl.classList.toggle('destructive', !!mode?.destructive)

    permissionListEl.textContent = ''
    for (const m of PERMISSION_MODES) {
      const row = document.createElement('div')
      const armed = armedDestructive === m.id
      row.className = `dash-row${m.id === permissionMode ? ' active' : ''}${m.destructive ? ' destructive' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(m.id === permissionMode))
      const name = document.createElement('span')
      name.className = 'dash-name'
      // Marked by a word as well as by colour, per the accessibility floor.
      name.textContent = m.destructive ? `${m.label} (unsafe)` : m.label
      const summary = document.createElement('span')
      summary.className = 'dash-summary'
      summary.textContent = armed ? 'Click again to confirm' : m.summary
      row.appendChild(name)
      row.appendChild(summary)
      row.addEventListener('click', () => choosePermissionMode(m))
      permissionListEl.appendChild(row)
    }
  }

  function choosePermissionMode(mode) {
    // Bypassing every permission check must never be one click away.
    if (mode.destructive && armedDestructive !== mode.id) {
      armedDestructive = mode.id
      renderPermissionMode()
      return
    }
    armedDestructive = null
    closePopovers(null)
    vscode.postMessage({ type: 'permission-mode', mode: mode.id })
  }

  permissionChipEl.addEventListener('click', () => {
    armedDestructive = null
    togglePopover(permissionChipEl, permissionPanelEl)
    renderPermissionMode()
  })

  // --- the command dashboard -------------------------------------------
  //
  // The composer IS the filter -- there is no second input to focus, tab into
  // or lose. Typing `/` at the start opens the list, every keystroke after it
  // narrows, and the textarea keeps DOM focus throughout. That is what makes
  // aria-activedescendant the right mechanism: the listbox is pointed at, not
  // moved into.

  // Commands are known at load; skills arrive from the host once it has walked
  // the disk, and may never arrive at all.
  let skillEntries = []
  let dashEntries = []
  let dashIndex = 0

  const dashOpen = () => !dashEl.hidden

  /**
   * The command being typed, or null when the composer is not a command.
   *
   * Only while it is still a single token: once there is a space the user is
   * writing arguments, and a menu over the top of that is in the way rather
   * than helping. A slash mid-sentence ("and/or") is prose, never a command.
   */
  function currentQuery() {
    const v = inputEl.value
    if (!v.startsWith('/')) return null
    return v.includes(' ') ? null : v.slice(1)
  }

  function renderDash(entries) {
    dashEntries = entries
    if (dashIndex >= entries.length) dashIndex = 0
    dashListEl.textContent = ''
    entries.forEach((e, i) => {
      const row = document.createElement('div')
      row.className = `dash-row${i === dashIndex ? ' active' : ''}`
      row.id = `dash-row-${i}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === dashIndex))
      const name = document.createElement('span')
      name.className = 'dash-name'
      name.textContent = e.name
      const summary = document.createElement('span')
      summary.className = 'dash-summary'
      // A skill description is written by a plugin author -- third-party text,
      // as untrusted as model output. textContent, never innerHTML.
      summary.textContent = e.hint ? `${e.hint} — ${e.summary}` : e.summary
      row.appendChild(name)
      row.appendChild(summary)
      // mousedown, not click: click fires after blur, by which time the
      // composer has lost focus and the caret position with it.
      row.addEventListener('mousedown', ev => { ev.preventDefault(); accept(i) })
      dashListEl.appendChild(row)
    })
    dashEmptyEl.hidden = entries.length > 0
    inputEl.setAttribute('aria-activedescendant', entries.length ? `dash-row-${dashIndex}` : '')
  }

  function openDash(query) {
    dashEl.hidden = false
    renderDash(filterEntries(COMMANDS.concat(skillEntries), query))
  }

  function closeDash() {
    dashEl.hidden = true
    dashIndex = 0
    inputEl.setAttribute('aria-activedescendant', '')
  }

  function moveDash(delta) {
    if (!dashEntries.length) return
    // Wraps, so Up from the top reaches the bottom instead of doing nothing.
    dashIndex = (dashIndex + delta + dashEntries.length) % dashEntries.length
    renderDash(dashEntries)
  }

  function accept(i) {
    const entry = dashEntries[i]
    if (!entry) return
    closeDash()
    if (entry.sends) {
      inputEl.value = ''
      autoGrow()
      appendMsg('user', entry.name)
      vscode.postMessage({ type: 'input', text: entry.name })
      return
    }
    // Insert and let the user finish the line: a skill usually needs an
    // argument, and sending a bare skill name spends a turn to be asked for it.
    inputEl.value = `${entry.name} `
    inputEl.focus()
    autoGrow()
  }

  dashBtnEl.appendChild(icon('slash', document))
  dashBtnEl.addEventListener('click', () => {
    if (dashOpen()) return closeDash()
    if (!inputEl.value.startsWith('/')) inputEl.value = '/'
    inputEl.focus()
    autoGrow()
    openDash(currentQuery() ?? '')
  })

  // --- attachments ------------------------------------------------------
  //
  // A picked or dropped file already has a path, and a path is all the
  // orchestrator needs. A pasted image does not, so the host writes one and
  // hands the path back.

  const attachmentsEl = document.getElementById('attachments')
  const attached = [] // { path, dataUrl }

  function renderAttachments() {
    attachmentsEl.textContent = ''
    attachmentsEl.hidden = attached.length === 0
    attached.forEach((a, i) => {
      const chip = document.createElement('span')
      chip.className = 'attachment'
      if (a.dataUrl) {
        const img = document.createElement('img')
        img.className = 'attachment-thumb'
        // The CSP permits data: for img-src. This is the only place the
        // webview renders bytes rather than text.
        img.src = a.dataUrl
        img.alt = ''
        chip.appendChild(img)
      }
      const label = document.createElement('span')
      label.className = 'attachment-name'
      label.textContent = a.path.split(/[\\/]/).pop()
      chip.appendChild(label)

      const remove = document.createElement('button')
      remove.className = 'attachment-remove'
      remove.type = 'button'
      remove.setAttribute('aria-label', `Remove ${label.textContent}`)
      remove.appendChild(icon('x', document))
      remove.addEventListener('click', () => {
        attached.splice(i, 1)
        renderAttachments()
        inputEl.focus()
      })
      chip.appendChild(remove)
      attachmentsEl.appendChild(chip)
    })
  }

  attachBtnEl.appendChild(icon('plus', document))
  attachBtnEl.addEventListener('click', () => vscode.postMessage({ type: 'attach-file' }))

  // Pasted IMAGES become files. Pasted text is left entirely alone ---
  // intercepting it would break the most common paste there is.
  inputEl.addEventListener('paste', e => {
    const items = [...(e.clipboardData?.items ?? [])].filter(i => i.type?.startsWith('image/'))
    if (!items.length) return
    e.preventDefault()
    for (const item of items) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        // A data URL is "data:<mime>;base64,<payload>"; the host wants the payload.
        const url = String(reader.result)
        vscode.postMessage({
          type: 'attach-paste',
          mime: file.type,
          base64: url.slice(url.indexOf(',') + 1),
        })
      }
      reader.readAsDataURL(file)
    }
  })

  // Dropping a file onto the window is the same gesture as picking one.
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => {
    e.preventDefault()
    const paths = [...(e.dataTransfer?.files ?? [])].map(f => f.path).filter(Boolean)
    if (paths.length) vscode.postMessage({ type: 'attach-paths', paths })
  })

  function send() {
    const typed = inputEl.value.trim()
    // Paths go first, on their own lines: the model is told where the files
    // are before it is told what to do with them.
    const prefix = attached.map(a => a.path).join('\n')
    const text = prefix ? `${prefix}\n${typed}` : typed
    if (!text.trim()) return
    appendMsg('user', text)
    vscode.postMessage({ type: 'input', text })
    inputEl.value = ''
    attached.length = 0
    renderAttachments()
    autoGrow()
  }

  // The textarea is borderless and blends into the composer card, so it
  // must grow with its content itself (there is no resize handle any more)
  // up to the CSS max-height, past which it scrolls instead of growing.
  function autoGrow() {
    inputEl.style.height = 'auto'
    inputEl.style.height = `${inputEl.scrollHeight}px`
  }

  sendEl.addEventListener('click', send)

  inputEl.addEventListener('input', () => {
    autoGrow()
    const q = currentQuery()
    if (q === null) closeDash()
    else openDash(q)
  })

  inputEl.addEventListener('keydown', e => {
    // The open dashboard owns these keys. Enter in particular: without this
    // the half-typed filter ("/mod") would be sent as a message.
    if (dashOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveDash(1) }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveDash(-1) }
      if (e.key === 'Escape') { e.preventDefault(); return closeDash() }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        return accept(dashIndex)
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  // Establish the collapsible surfaces' state here rather than trusting the
  // `hidden` attributes in webview.html. The script owns this state everywhere
  // else, so letting the markup own it at boot means two sources of truth that
  // can drift -- and a dashboard that believes it is open swallows Enter.
  closeDash()
  closePopovers(null)
  renderAttachments()
  renderRoom()
  renderPermissionMode()

  inputEl.focus()
})()
