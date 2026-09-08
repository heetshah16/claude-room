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

  const messagesEl = document.getElementById('messages')
  const inputEl = document.getElementById('input')
  const sendEl = document.getElementById('send')
  const fatalEl = document.getElementById('fatal')
  const rateLimitEl = document.getElementById('rate-limit')
  const statusEl = document.getElementById('status')
  const modelPickerEl = document.getElementById('model-picker')
  const modelSelectEl = document.getElementById('model-select')
  const emptyStateEl = document.getElementById('empty-state')

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
    // A model-list probe's answer must not appear as a chat message -- it
    // is parsed for the picker (in onTurnEnd) and nothing else.
    if (awaitingModelList) return
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
  let awaitingModelList = false

  function setCurrentModel(model) {
    modelPickerEl.textContent = `model: ${model}`
  }

  function showModelOptions(list) {
    modelSelectEl.textContent = ''
    for (const name of list) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      modelSelectEl.appendChild(opt)
    }
    modelSelectEl.hidden = list.length === 0
    modelPickerEl.hidden = list.length > 0
  }

  modelPickerEl.addEventListener('click', () => {
    awaitingModelList = true
    vscode.postMessage({ type: 'input', text: '/model' })
  })

  modelSelectEl.addEventListener('change', () => {
    const chosen = modelSelectEl.value
    modelSelectEl.hidden = true
    modelPickerEl.hidden = false
    if (chosen) vscode.postMessage({ type: 'input', text: `/model ${chosen}` })
  })

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
    awaitingModelList = true
    vscode.postMessage({ type: 'input', text: '/model' })
  }

  // --- turn lifecycle ----------------------------------------------------

  function onTurnEnd(ev) {
    // If the picker requested the list (by click, or the session-start
    // probe above), this turn's text is the answer to a bare `/model` —
    // parse it for the current model and the option list instead of
    // treating it as a normal reply. onText already refused to render it as
    // a bubble, and this must not fall through to the "turn ended" system
    // line either: it is not a conversational turn, so nothing belongs in
    // the transcript for it (and doing so would dismiss the empty state
    // before the user has sent anything).
    if (awaitingModelList) {
      awaitingModelList = false
      const { current, available } = parseModelList(ev.text ?? '')
      if (current) setCurrentModel(current)
      if (available.length) showModelOptions(available)
      endBubble()
      currentThinkingBody = null
      setStatus('')
      return
    }
    endBubble()
    currentThinkingBody = null
    setStatus('')
    const cost = typeof ev.costUsd === 'number' ? ev.costUsd : 0
    appendMsg('system', `turn ended · ${ev.turns} turn(s) · $${cost.toFixed(4)}`)
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

    if (msg.type === 'activity') return onActivity(msg.activity)
    if (msg.type === 'fatal') return onFatal(String(msg.message ?? 'The orchestrator process has stopped.'))
  })

  function send() {
    const text = inputEl.value.trim()
    if (!text) return
    appendMsg('user', text)
    vscode.postMessage({ type: 'input', text })
    inputEl.value = ''
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
  inputEl.addEventListener('input', autoGrow)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  inputEl.focus()
})()
