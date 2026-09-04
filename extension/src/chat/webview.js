// extension/src/chat/webview.js
//
// Runs inside the webview's sandboxed context — no Node, no filesystem, only
// what the extension host posts in and what the CSP in webview.html allows
// to run. Driven entirely by postMessage in both directions.
//
// Every server- or model-supplied string is rendered with textContent, never
// innerHTML. Message text, thinking, tool inputs, tool results and worker
// activity are all untrusted — same rule src/ui.mjs states for the room's
// own browser client, same reason.
'use strict'
;(function () {
  const vscode = acquireVsCodeApi()

  const messagesEl = document.getElementById('messages')
  const inputEl = document.getElementById('input')
  const sendEl = document.getElementById('send')
  const fatalEl = document.getElementById('fatal')
  const rateLimitEl = document.getElementById('rate-limit')
  const statusEl = document.getElementById('status')

  // The bubble currently receiving `text` chunks. Any other event kind ends
  // it, so the next `text` event opens a fresh bubble rather than appending
  // after an unrelated tool card or thinking block.
  let currentBubble = null
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

  function appendMsg(role, text) {
    const el = document.createElement('div')
    el.className = `msg ${role}`
    el.textContent = text
    messagesEl.appendChild(el)
    maybeScrollToBottom()
    return el
  }

  function endBubble() {
    currentBubble = null
  }

  function onText(text) {
    if (!currentBubble) currentBubble = appendMsg('assistant', '')
    currentBubble.textContent += text
    maybeScrollToBottom()
  }

  // Chunks of the same thinking block arrive back-to-back; this tracks the
  // open block's body so they append to one disclosure instead of opening a
  // new collapsed section per chunk.
  let currentThinkingBody = null

  function onThinking(text) {
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

  function onToolUse(ev) {
    endBubble()
    currentThinkingBody = null
    const card = document.createElement('div')
    card.className = 'card pending'
    const title = document.createElement('div')
    title.className = 'card-title'
    title.textContent = `\u{1F527} ${ev.name}` // wrench
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
      // is still worth showing — just as its own card, unmatched.
      const card = document.createElement('div')
      card.className = `card${ev.isError ? ' tool-error' : ''}`
      const title = document.createElement('div')
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

  function onTurnEnd(ev) {
    endBubble()
    currentThinkingBody = null
    setStatus('')
    const cost = typeof ev.costUsd === 'number' ? ev.costUsd : 0
    const el = document.createElement('div')
    el.className = 'msg system'
    el.textContent = `turn ended · ${ev.turns} turn(s) · $${cost.toFixed(4)}`
    messagesEl.appendChild(el)
    maybeScrollToBottom()
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
    endBubble()
    currentThinkingBody = null
    const card = document.createElement('div')
    card.className = 'card activity'
    const title = document.createElement('div')
    title.className = 'card-title'
    title.textContent = activityTitle(activity)
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

  function activityTitle(a) {
    if (!a) return 'Worker activity'
    if (a.kind === 'delegation-sent') return `→ delegated to @${a.handle}`
    if (a.tool) return `\u{1F527} @${a.handle ?? 'worker'} – ${a.tool}`
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
        default: return // session and anything unrecognised: nothing to render
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
    inputEl.style.height = 'auto'
  }

  sendEl.addEventListener('click', send)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  inputEl.focus()
})()
