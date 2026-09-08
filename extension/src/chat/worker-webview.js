// extension/src/chat/worker-webview.js
//
// One worker's detail tab.
//
// Everything rendered here comes from outside the extension: the brief is
// written by the orchestrator, the tool names and inputs by a free model, and
// the reply by that worker. textContent throughout, never innerHTML.
'use strict'
;(function () {
  const vscode = acquireVsCodeApi()
  const { icon } = window.ClaudeIcons
  const { formatWorker, shortPath } = window.ClaudeWorkersFormat

  const dotEl = document.getElementById('w-dot')
  const titleEl = document.getElementById('w-title')
  const statusEl = document.getElementById('w-status')
  const subEl = document.getElementById('w-sub')
  const interruptEl = document.getElementById('w-interrupt')
  const briefEl = document.getElementById('w-brief')
  const classEl = document.getElementById('w-class')
  const taskEl = document.getElementById('w-task')
  const fieldsEl = document.getElementById('w-fields')
  const toolsEl = document.getElementById('w-tools')
  const toolsSummaryEl = document.getElementById('w-tools-summary')
  const toolsListEl = document.getElementById('w-tools-list')
  const messagesEl = document.getElementById('messages')
  const emptyEl = document.getElementById('empty-state')
  const inputEl = document.getElementById('input')
  const sendEl = document.getElementById('send')
  const queuedEl = document.getElementById('w-queued')
  const hintEl = document.getElementById('w-hint')

  let worker = null
  /** Messages typed here and not yet delivered, shown so none looks lost. */
  const queued = []

  function renderHeader() {
    const w = formatWorker(worker ?? {}, Date.now())
    document.body.className = `worker-${w.state}`
    dotEl.className = `worker-dot`
    titleEl.textContent = w.title
    statusEl.textContent = w.status
    subEl.textContent = [worker?.model, shortPath(worker?.worktree)].filter(Boolean).join(' · ')
    // Interrupt is offered only while there is something to interrupt, and is
    // never the default action: it discards work the orchestrator is waiting on.
    interruptEl.hidden = worker?.state !== 'busy'
  }

  function addField(label, value) {
    if (!value || (Array.isArray(value) && !value.length)) return
    const row = document.createElement('div')
    row.className = 'brief-field'
    const k = document.createElement('span')
    k.className = 'brief-key'
    k.textContent = label
    const v = document.createElement('span')
    v.className = 'brief-value'
    v.textContent = Array.isArray(value) ? value.join(', ') : String(value)
    row.appendChild(k)
    row.appendChild(v)
    fieldsEl.appendChild(row)
  }

  function renderBrief() {
    const b = worker?.brief
    briefEl.hidden = !b
    if (!b) return
    classEl.textContent = b.class ?? ''
    taskEl.textContent = b.task ?? ''
    fieldsEl.textContent = ''
    // Shown as FIELDS, not as the prose the worker received. A brief with no
    // files and no tests is supposed to look thin here -- that is what the
    // room's own validation is strict about, and what this view exists to make
    // visible.
    const spec = b.spec ?? {}
    addField('Files', spec.files)
    addField('Interface', spec.interface)
    addField('Verify', spec.tests)
    addField('Avoid', spec.do_not_touch)
  }

  function renderTools() {
    const used = worker?.toolsUsed ?? []
    toolsEl.hidden = used.length === 0
    // "Used", not "available": the launcher picks opencode's port internally,
    // so its declared tool list is not reachable from here. Claiming otherwise
    // would be inventing a capability list.
    toolsSummaryEl.textContent = `Tools used · ${used.length}`
    toolsListEl.textContent = used.join(', ')
  }

  function renderTranscript() {
    const entries = worker?.transcript ?? []
    messagesEl.textContent = ''
    if (!entries.length) {
      messagesEl.appendChild(emptyEl)
      emptyEl.hidden = false
      return
    }
    emptyEl.hidden = true

    for (const e of entries) {
      if (e.kind === 'brief') continue // already shown as the card above

      if (e.kind === 'tool') {
        const row = document.createElement('div')
        row.className = 'card'
        const title = document.createElement('div')
        title.className = 'card-title card-name'
        title.appendChild(icon('wrench', document))
        const name = document.createElement('span')
        name.textContent = e.tool
        title.appendChild(name)
        if (e.input) {
          const summary = document.createElement('span')
          summary.className = 'card-summary'
          summary.textContent = summarise(e.input)
          title.appendChild(summary)
        }
        row.appendChild(title)
        messagesEl.appendChild(row)
        continue
      }

      const msg = document.createElement('div')
      msg.className = e.kind === 'abandoned' ? 'msg system' : 'msg assistant'
      const label = document.createElement('div')
      label.className = 'msg-role'
      label.textContent = e.kind === 'abandoned' ? '' : 'Reported'
      const body = document.createElement('div')
      body.className = 'msg-body'
      body.textContent = e.text ?? ''
      msg.appendChild(label)
      msg.appendChild(body)
      messagesEl.appendChild(msg)
    }
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function summarise(input) {
    if (!input || typeof input !== 'object') return ''
    for (const k of ['command', 'file_path', 'path', 'pattern', 'query']) {
      if (typeof input[k] === 'string') return input[k]
    }
    try {
      const json = JSON.stringify(input)
      return json.length > 120 ? `${json.slice(0, 120)}…` : json
    } catch { return '' }
  }

  function renderQueued() {
    queuedEl.textContent = ''
    queuedEl.hidden = queued.length === 0
    for (const text of queued) {
      const row = document.createElement('div')
      row.className = 'queued-row'
      const note = document.createElement('span')
      note.className = 'queued-note'
      note.textContent = 'queued · delivered after this turn'
      const body = document.createElement('div')
      body.textContent = text
      row.appendChild(note)
      row.appendChild(body)
      queuedEl.appendChild(row)
    }
    // Says so BEFORE sending, not after. The room runs one turn per
    // destination and gates a seat on being online, never on being idle, so a
    // message typed now lands after the current task -- and a sender who
    // believes otherwise is the worst failure this system can have.
    hintEl.textContent = worker?.state === 'busy' ? 'delivered after the current task' : ''
  }

  function render() {
    renderHeader()
    renderBrief()
    renderTools()
    renderTranscript()
    renderQueued()
  }

  function send() {
    const text = inputEl.value.trim()
    if (!text) return
    queued.push(text)
    inputEl.value = ''
    renderQueued()
    vscode.postMessage({ type: 'worker-say', handle: worker?.handle, text })
  }

  sendEl.addEventListener('click', send)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })

  interruptEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'worker-interrupt', handle: worker?.handle })
  })

  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'worker') {
      worker = msg.worker
      // A delivered message is no longer queued. The room does not echo it
      // back, so it is cleared when the worker moves on from the turn it was
      // waiting behind.
      if (worker?.state !== 'busy') queued.length = 0
      render()
    }
  })

  // A busy worker's header carries a countdown, true only for a second.
  setInterval(() => { if (worker?.state === 'busy') renderHeader() }, 1000)

  render()
  vscode.postMessage({ type: 'worker-refresh' })
})()
