// Makes a Claude Code session a claude-room agent seat, with no
// --dangerously-load-development-channels: a channel pushes into a session
// from outside, which is what Anthropic's allowlist gates. A mod runs inside
// the session and starts the turn itself with $.prompt.submit.
//
//   seat.mjs holding /seat/events  -> feed.mjs, a child this mod spawns
//   claude/channel notification    -> $.prompt.submit
//   room_reply MCP tool            -> $.tool.register + a tool.call hook
//   generated hooks settings file  -> classic.* hooks, forwarded during room turns
//
// Joins at once when ROOM_URL, ROOM_SEAT_TOKEN and ROOM_SEAT_HANDLE are set
// (scripts/room-seat.mjs launches a session to be a seat). Plugin options are
// per user, not per session, so they wait for /room-join: auto-joining from
// them would make every session claim the same handle.

const REPLY_TOOL = {
  name: 'room_reply',
  description:
    'Send a message to the room. This is the ONLY way the room sees your words - your transcript, prose, and reasoning never reach it on their own.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The message to send to the room' },
      to: { type: 'string', description: 'Optional member name this reply answers' },
    },
    required: ['text'],
  },
}

let seat = null // { roomUrl, token, handle } while joined
let feed = null // the feed child's stream while joined
let status = 'not joined - run /room-join'
let inRoomTurn = false

export function register(on, options = {}) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'room-join', description: 'Bring this session online as your room seat', immediate: true })
    await $.command.register({ name: 'room-leave', description: "Take this session's room seat offline", immediate: true })
    await $.command.register({ name: 'room-status', description: "Show this session's room seat", immediate: true })
    const roomUrl = await $.env.get('ROOM_URL')
    const token = await $.env.get('ROOM_SEAT_TOKEN')
    const handle = await $.env.get('ROOM_SEAT_HANDLE')
    const started = await next(e)
    if (roomUrl && token && handle) await join($, { roomUrl, token, handle })
    return started
  })

  on('command.run', { command: 'room-join' }, async ($) => {
    if (feed) return { text: status }
    const cfg = { roomUrl: options.room_url, token: options.seat_token, handle: options.seat_handle }
    if (!cfg.roomUrl || !cfg.token || !cfg.handle) {
      return { text: 'Set the room address, seat handle and seat token first: /plugin, Installed, room-seat, Configure options.' }
    }
    await join($, cfg)
    return { text: `${status} - /room-status shows when it is online` }
  })

  on('command.run', { command: 'room-leave' }, async ($) => {
    if (!feed) return { text: status }
    const stream = feed
    feed = null
    seat = null
    inRoomTurn = false
    setStatus($, 'left the room')
    await stream.return?.()
    return { text: status }
  })

  on('command.run', { command: 'room-status' }, async () => ({ text: status }))

  on('tool.call', { tool: 'mcp__room-seat__room_reply' }, async ($, e) => {
    if (!seat) return { deny: 'room_reply: this session is not joined to a room' }
    try {
      const body = { token: seat.token, text: String(e.text ?? '') }
      if (e.to) body.to = String(e.to)
      const res = await post($, '/seat/reply', body)
      return res.ok ? { result: 'sent' } : { deny: `room_reply failed: HTTP ${res.status}` }
    } catch (err) {
      return { deny: `room_reply failed: ${err?.message ?? err}` }
    }
  })

  // classic.PreToolUse carries the tool call itself ({ tool, tool_use_id,
  // ...arguments }), not a settings hook's stdin, so it has no hook_event_name
  // for the matcher below. The room reads tool_name and tool_input.
  on('classic.PreToolUse', async ($, e, next) => {
    const { tool, tool_use_id, ...tool_input } = e
    forward($, 'PreToolUse', { tool_name: tool, tool_input, tool_use_id })
    return next(e)
  })

  on('classic.*', { hook_event_name: ['PostToolUse', 'Notification', 'Stop'] }, async ($, e, next) => {
    forward($, e.hook_event_name, e)
    return next(e)
  })

  // An interrupted turn may end without a Stop; the room must not stay busy.
  on('turn.complete', async ($, e, next) => {
    if (seat && inRoomTurn && e.isAborted && !e.agentId) {
      inRoomTurn = false
      void closeRoomTurn($, "the seat's owner interrupted this turn")
    }
    return next(e)
  })
}

function setStatus($, text) {
  status = text
  $.ui.status(`room: ${text}`)
}

function post($, path, body) {
  return $.http.fetch(seat.roomUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Only during a room turn: outside one, the owner's own Stop would close the
// room's turn early and their tool calls would leak into the room's feed.
// Never awaited: $.http.fetch has no timeout, and a hook waiting on an
// unreachable room would hold every tool call.
function forward($, event, payload) {
  if (!seat || !inRoomTurn) return
  if (event === 'Stop') inRoomTurn = false
  post($, `/seat/hook/${event}?token=${encodeURIComponent(seat.token)}`, payload)
    .catch(err => $.ui.log(`room hook ${event} failed: ${err?.message ?? err}`, { to: 'debug' }))
}

async function join($, cfg) {
  seat = { roomUrl: String(cfg.roomUrl).replace(/\/+$/, ''), token: String(cfg.token), handle: String(cfg.handle).replace(/^@/, '') }
  setStatus($, `connecting to ${seat.roomUrl} as @${seat.handle}`)
  await $.tool.register(REPLY_TOOL)
  const stream = $.process.spawn({
    argv: ['node', `${$.plugin.root}/feed.mjs`],
    env: { ROOM_URL: seat.roomUrl, ROOM_SEAT_TOKEN: seat.token, ROOM_SEAT_HANDLE: seat.handle },
  })
  feed = stream
  void pump($, stream)
}

// Runs while joined. Claude Code kills feed.mjs when the loop is left or the
// module unloads, which drops /seat/events and takes the seat offline.
async function pump($, stream) {
  let buf = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        $.ui.log(text.trim(), { to: 'debug' })
        continue
      }
      buf += text
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) await onLine($, line)
      }
    }
  } catch (err) {
    if (feed === stream) setStatus($, `offline: could not run the room feed (${err?.message ?? err}); a room seat needs Node.js 22 or later on PATH`)
  }
  if (feed === stream) {
    feed = null
    seat = null
    inRoomTurn = false
    if (!status.startsWith('offline')) setStatus($, 'offline: the room feed stopped - /room-join to reconnect')
  }
}

async function onLine($, line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.status === 'online') return setStatus($, `online as @${seat.handle} in ${seat.roomUrl}`)
  if (msg.status === 'retrying') return setStatus($, `reconnecting: ${msg.reason}`)
  if (msg.status === 'fatal') return setStatus($, `offline: ${msg.reason}`)
  if (typeof msg.text === 'string') await submit($, msg.text)
}

async function submit($, text) {
  try {
    const entered = await $.prompt.submit({ text })
    if (entered?.drop) throw new Error(entered.drop)
    // It resolves once the session was idle and the turn started: from here
    // until it ends, the session's hook events belong to the room's turn.
    // Marked here, not in a prompt.submit hook of this mod's: called from this
    // loop, the submit skips every hook of this mod's.
    inRoomTurn = true
  } catch (err) {
    inRoomTurn = false
    // The room marked this seat busy when it sent the turn. If the turn cannot
    // start, say so and close it, or every later message queues behind a turn
    // that never ran - the rule opencode.mjs follows too.
    await closeRoomTurn($, `could not start the turn: ${err?.message ?? err}`)
  }
}

async function closeRoomTurn($, reason) {
  if (!seat) return
  try {
    await post($, '/seat/reply', { token: seat.token, text: reason })
    await post($, `/seat/hook/Stop?token=${encodeURIComponent(seat.token)}`, { token: seat.token })
  } catch (err) {
    $.ui.log(`could not close the room turn: ${err?.message ?? err}`, { to: 'debug' })
  }
}
