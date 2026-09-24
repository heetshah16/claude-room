// extension/src/chat/room-webview.js
//
// The Room sidebar, inside the webview's sandboxed context.
//
// Moved out of the chat's Room popover (webview.js) when the chat went dormant:
// publishing and inviting are the product's front door, not a chat feature.
//
// The advertised address and every member name arrive from the room over HTTP,
// and a member name is typed by a person -- all of it goes through textContent,
// never innerHTML. One IIFE, nothing top-level: <script> tags share one global
// scope with icons.js.
'use strict'
;(function () {
  const vscode = acquireVsCodeApi()
  const { icon } = window.ClaudeIcons

  const stateEl = document.getElementById('room-state')
  const summaryEl = document.getElementById('room-summary')
  const publishEl = document.getElementById('publish-btn')
  const addressEl = document.getElementById('room-address')
  const noteEl = document.getElementById('room-note')
  const membersEl = document.getElementById('room-members')
  const inviteEl = document.getElementById('invite-btn')

  let room = { published: false, advertised: null, members: null, busy: false }

  /** The host part of a join link, which is what "published to" actually means. */
  function hostOf(joinUrl) {
    if (!joinUrl) return null
    // Deliberately not `new URL(...).host`: the link carries a token in its
    // query string, and nothing here should be one slip away from rendering it.
    const m = /^https?:\/\/([^/?#]+)/.exec(String(joinUrl))
    return m ? m[1] : null
  }

  function summarise(where) {
    const state = room.busy
      ? 'Room restarting'
      : room.published
        ? `Room published to ${where ?? 'an unknown address'}`
        : 'Room local only'
    if (room.members === null) return `${state} · roster unavailable`
    const n = room.members.length
    return `${state} · ${n} member${n === 1 ? '' : 's'}`
  }

  function render() {
    const where = hostOf(room.advertised)

    // The state word, with a shape beside it. `radio` broadcasts; `circle-dot`
    // sits still. Both are decorative -- the word carries the fact.
    stateEl.textContent = ''
    stateEl.appendChild(icon(room.published ? 'radio' : 'circle-dot', document))
    const word = document.createElement('span')
    word.textContent = room.busy ? 'restarting…' : room.published ? 'published' : 'local only'
    stateEl.appendChild(word)

    publishEl.textContent = room.published ? 'Stop sharing' : 'Publish with Dev Tunnels'
    publishEl.disabled = !!room.busy

    // The address is the whole decision: publishing to a devtunnels.ms URL
    // means something very different from staying on loopback, and this is what
    // tells them apart. Shown for both states so it is legible BEFORE the
    // button is pressed, not only after.
    addressEl.textContent = room.published
      ? (where ?? 'address unknown')
      : '127.0.0.1 — reachable only from this machine'
    noteEl.textContent = room.busy
      ? 'Restarting the room…'
      : 'Restarts the room (about a second). Anything already connected reconnects.'

    summaryEl.textContent = summarise(where)

    membersEl.textContent = ''
    if (room.members === null) {
      // null means the roster call FAILED. Saying "nobody is here" would be a
      // confident lie about who can read the room.
      const unknown = document.createElement('div')
      unknown.className = 'room-member muted'
      unknown.textContent = room.busy ? 'checking…' : 'could not read the roster'
      membersEl.appendChild(unknown)
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
      membersEl.appendChild(row)
    }
  }

  publishEl.addEventListener('click', () => {
    if (room.busy) return
    vscode.postMessage({ type: 'publish', published: !room.published })
  })

  inviteEl.addEventListener('click', () => {
    // The host owns the prompt: a webview cannot show a native input box, and a
    // bespoke one here would be a worse version of one VS Code already has.
    vscode.postMessage({ type: 'invite', role: 'member' })
  })

  window.addEventListener('message', event => {
    const msg = event.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'room') {
      // Merged, not replaced: republish posts a partial `{busy}` and the roster
      // it was already showing must not blink out for the duration.
      room = { ...room, ...msg.room }
      render()
    }
  })

  // The script owns its own initial state rather than inheriting it from the
  // markup, and a revealed view asks for the current room rather than waiting
  // for a change that might never come.
  render()
  vscode.postMessage({ type: 'room-refresh' })
})()
