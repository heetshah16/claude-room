// Makes this Claude Code session a claude-room agent seat, with no
// --dangerously-load-development-channels: a channel pushes into the session
// from outside, which is what Anthropic's allowlist gates. A mod runs inside it
// and starts the turn itself with $.prompt.submit.
//
// The pieces of the old seat, and what replaces each:
//   seat.mjs holding /seat/events  -> mod/feed.mjs, a child this mod spawns
//   claude/channel notification    -> $.prompt.submit
//   room_reply MCP tool            -> $.tool.register + a tool.call hook
//   generated hooks settings file  -> classic.* hooks forwarded to /seat/hook/*
//
// Inert unless ROOM_URL, ROOM_SEAT_TOKEN and ROOM_SEAT_HANDLE are set, so a
// user-scope install changes nothing in sessions that are not room seats.

let seat = null // { roomUrl, token, handle } once session.start finds them

export function register(on) {
  on('session.start', async ($, e, next) => {
    const roomUrl = await $.env.get('ROOM_URL')
    const token = await $.env.get('ROOM_SEAT_TOKEN')
    const handle = await $.env.get('ROOM_SEAT_HANDLE')
    if (!roomUrl || !token || !handle) return next(e)
    seat = { roomUrl, token, handle }

    await $.tool.register({
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
    })
    const started = await next(e)
    void pump($)
    return started
  })

  on('tool.call', { tool: 'mcp__room-seat__room_reply' }, async ($, e) => {
    if (!seat) return { deny: 'room_reply: this session is not a room seat' }
    try {
      const res = await post($, '/seat/reply', { token: seat.token, text: String(e.text ?? ''), to: e.to ? String(e.to) : undefined })
      return res.ok ? { result: 'sent' } : { deny: `room_reply failed: HTTP ${res.status}` }
    } catch (err) {
      return { deny: `room_reply failed: ${err?.message ?? err}` }
    }
  })

  // The same five events room-seat.mjs used to configure as HTTP hooks
  // (HOOK_EVENTS in src/state.mjs). Stop is the load-bearing one: without it
  // the seat's turn never closes and its queue destination stays busy forever.
  on('classic.*', { hook_event_name: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'] }, async ($, e, next) => {
    if (seat) {
      try {
        await post($, `/seat/hook/${e.hook_event_name}?token=${encodeURIComponent(seat.token)}`, e)
      } catch (err) {
        $.ui.log(`room hook ${e.hook_event_name} failed: ${err?.message ?? err}`, { to: 'debug' })
      }
    }
    return next(e)
  })
}

function post($, path, body) {
  return $.http.fetch(seat.roomUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Runs for the session's life. Claude Code kills feed.mjs when this module
// unloads, which drops its /seat/events connection and takes the seat offline:
// the same liveness rule as before, owned by the same kind of connection.
async function pump($) {
  const feed = $.process.spawn({ argv: ['node', `${$.plugin.root}/feed.mjs`] })
  let buf = ''
  try {
    for await (const { stream, text } of feed) {
      if (stream === 'stderr') {
        $.ui.log(text.trim())
        continue
      }
      buf += text
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) await submit($, JSON.parse(line).text)
      }
    }
  } catch (err) {
    $.ui.log(`room feed failed: ${err?.message ?? err}`)
  }
  $.ui.log('room feed stopped - this seat is offline')
}

async function submit($, text) {
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    // The room marked this seat busy when it sent the turn. If the turn cannot
    // start, say so and close it, or every later message queues behind a turn
    // that never ran - the same rule opencode.mjs follows.
    const reason = `could not start the turn: ${err?.message ?? err}`
    $.ui.log(reason)
    try {
      await post($, '/seat/reply', { token: seat.token, text: reason })
      await post($, `/seat/hook/Stop?token=${encodeURIComponent(seat.token)}`, { token: seat.token })
    } catch {
      // The room is unreachable; the feed's own reconnect will surface it.
    }
  }
}
