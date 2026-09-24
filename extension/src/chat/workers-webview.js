// extension/src/chat/workers-webview.js
//
// The workers sidebar, inside the webview's sandboxed context.
//
// Every string here originates outside the extension: a handle and a worktree
// come from the room, a model from a launcher flag, and the task is written by
// the orchestrator -- a model. All of it goes through textContent, never
// innerHTML, exactly as the chat panel does.
'use strict'
;(function () {
  const vscode = acquireVsCodeApi()
  const { icon } = window.ClaudeIcons
  const { formatWorker } = window.ClaudeWorkersFormat

  const listEl = document.getElementById('worker-list')
  const emptyEl = document.getElementById('worker-empty')
  const summaryEl = document.getElementById('worker-summary')
  const addEl = document.getElementById('worker-add')

  let workers = []

  function summarise(list) {
    if (!list.length) return ''
    const busy = list.filter(w => w.state === 'busy').length
    const noun = list.length === 1 ? 'worker' : 'workers'
    // A meaningful sentence rather than a bare count: a live region that
    // announces "2" tells a screen reader reader nothing.
    return busy ? `${list.length} ${noun}, ${busy} busy` : `${list.length} ${noun}, idle`
  }

  function render() {
    listEl.textContent = ''
    emptyEl.hidden = workers.length > 0
    summaryEl.textContent = summarise(workers)

    const now = Date.now()
    for (const raw of workers) {
      const w = formatWorker(raw, now)

      const row = document.createElement('div')
      row.className = `worker worker-${w.state}`
      row.setAttribute('role', 'button')
      row.setAttribute('tabindex', '0')
      // Clicking a worker opens its detail tab (phase 4). Wired now so the
      // affordance and the keyboard path exist together rather than one
      // arriving later than the other.
      const open = () => vscode.postMessage({ type: 'open-worker', handle: raw.handle })
      row.addEventListener('click', open)
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
      })

      const head = document.createElement('div')
      head.className = 'worker-head'
      // The dot is decorative: the status word beside it carries the same
      // fact, because colour alone is not something everyone can read.
      const dot = document.createElement('span')
      dot.className = 'worker-dot'
      dot.setAttribute('aria-hidden', 'true')
      const title = document.createElement('span')
      title.className = 'worker-title'
      title.textContent = w.title
      const status = document.createElement('span')
      status.className = 'worker-status'
      status.textContent = w.status
      head.appendChild(dot)
      head.appendChild(title)
      head.appendChild(status)
      const stop = document.createElement('button')
      stop.className = 'icon-btn'
      stop.type = 'button'
      stop.setAttribute('aria-label', `Stop ${w.title}`)
      stop.title = `Stop ${w.title}`
      stop.appendChild(icon('x', document))
      stop.addEventListener('click', e => {
        // The row itself opens the worker; stopping it must not do both.
        e.stopPropagation()
        vscode.postMessage({ type: 'stop-worker', handle: raw.handle })
      })
      head.appendChild(stop)
      row.appendChild(head)

      if (w.subtitle) {
        const sub = document.createElement('div')
        sub.className = 'worker-sub'
        sub.textContent = w.subtitle
        row.appendChild(sub)
      }

      if (w.task) {
        const task = document.createElement('div')
        task.className = 'worker-task'
        task.appendChild(icon('chevron-right', document))
        const text = document.createElement('span')
        text.textContent = w.task
        task.appendChild(text)
        row.appendChild(task)
      }

      listEl.appendChild(row)
    }
  }

  addEl.appendChild(icon('plus', document))
  addEl.addEventListener('click', () => vscode.postMessage({ type: 'add-worker' }))

  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'workers') {
      workers = Array.isArray(msg.workers) ? msg.workers : []
      render()
    }
  })

  // A busy worker's row shows a countdown, which is only true for a second.
  // Re-rendering on a timer is what keeps it from freezing at whatever it read
  // when the last event happened to arrive.
  setInterval(() => {
    if (workers.some(w => w.state === 'busy' && w.deadlineAt)) render()
  }, 1000)

  // The script owns its own initial state rather than inheriting it from the
  // markup, so the empty state is correct before any message arrives.
  render()
  vscode.postMessage({ type: 'workers-refresh' })
})()
