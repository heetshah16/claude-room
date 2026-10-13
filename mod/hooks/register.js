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
// Joins at session start from the first complete source:
//   the environment   ROOM_URL, ROOM_SEAT_TOKEN, ROOM_SEAT_HANDLE (scripts/room-seat.mjs)
//   the project file  .claude/room-seat.local.json, which the Room extension writes,
//                     trusted only when its room is on this machine
//   the plugin options
// Only one session holds a handle; the others show the room's refusal.
// A session the room itself runs (ROOM_SEAT_SKIP=1: its orchestrator, its
// observer) joins only from the environment, never as the user's seat.

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
  // In the prompt from the start: behind ToolSearch, every session's first
  // reply waited on an extra model call just to load this schema.
  isDeferred: false,
}

let seat = null // { roomUrl, token, handle } while joined
let envSeat = null // the launch environment's seat settings
let source = null // the SOURCES key the last join came from
let feed = null // the feed child's stream while joined
let status = 'not joined - run /room-join'
let inRoomTurn = false
let retries = 0 // retrying statuses in a row from the current feed
let ignored = '' // why the last read of the seat file was not trusted, shown after the status
let seatPath = null // the seat file, absolute, fixed at session start so a later cd cannot switch rooms

const SEAT_FILE = '.claude/room-seat.local.json'
const SOURCES = { env: 'the environment', file: 'the project file', options: 'the plugin options' }
const NOT_LOCAL = ` - ignored ${SEAT_FILE}: its room address is not on this machine (the Room extension only writes a local address)`
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'] // URL keeps the brackets on an IPv6 hostname

const REPLY_TIMEOUT_MS = 15_000

const UNANSWERED = {
  aborted: "the seat's owner interrupted this turn",
  refusal: 'the model refused this turn',
  error: 'this turn ended on an API error',
}

export function register(on, options = {}) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'room-join', description: 'Bring this session online as your room seat', immediate: true })
    await $.command.register({ name: 'room-leave', description: "Take this session's room seat offline", immediate: true })
    await $.command.register({ name: 'room-status', description: "Show this session's room seat", immediate: true })
    envSeat = complete(await $.env.get('ROOM_URL'), await $.env.get('ROOM_SEAT_TOKEN'), await $.env.get('ROOM_SEAT_HANDLE'))
    const skip = (await $.env.get('ROOM_SEAT_SKIP')) === '1'
    const started = await next(e)
    seatPath = `${String(await $.session.cwd()).replace(/[\\/]+$/, '')}/${SEAT_FILE}`
    const found = envSeat || !skip ? await findSeat($, options) : null
    if (found) await join($, found.cfg, found.from)
    else if (skip) setStatus($, 'this session is a room process; not joining')
    return started
  })

  on('command.run', { command: 'room-join' }, async ($) => {
    if (feed) return { text: statusText() }
    const found = await findSeat($, options)
    if (!found) {
      return { text: `No seat to join: open this folder with the Room extension running, or set the room address, seat handle and seat token: /plugin, Installed, room-seat, Configure options.${ignored}` }
    }
    await join($, found.cfg, found.from)
    return { text: `${statusText()} - /room-status shows when it is online` }
  })

  on('command.run', { command: 'room-leave' }, async ($) => {
    if (!feed) return { text: status }
    const stream = feed
    feed = null
    seat = null
    inRoomTurn = false
    setStatus($, 'left the room')
    await stream.return?.().catch(() => {})
    return { text: status }
  })

  on('command.run', { command: 'room-status' }, async () => ({ text: statusText() }))

  on('tool.call', { tool: 'mcp__room-seat__room_reply' }, async ($, e) => {
    if (!seat) return { deny: 'room_reply: this session is not joined to a room' }
    try {
      const body = { token: seat.token, text: String(e.text ?? '') }
      if (e.to) body.to = String(e.to)
      // No one may be at a launched seat to press Esc on a hung call.
      let timer
      const late = new Promise(resolve => { timer = $.clock.after(REPLY_TIMEOUT_MS, () => resolve(null)) })
      const res = await Promise.race([post($, '/seat/reply', body), late]).finally(() => timer.cancel())
      if (!res) return { deny: `room_reply failed: the room did not answer within ${REPLY_TIMEOUT_MS / 1000}s` }
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

  // A turn that ends without an answer may end without a Stop (an API error
  // raises StopFailure); the room must not stay busy. A forwarded Stop already
  // cleared inRoomTurn, so the room's turn is closed once either way.
  on('turn.complete', async ($, e, next) => {
    if (inRoomTurn && !e.agentId && UNANSWERED[e.reason]) {
      inRoomTurn = false
      void closeRoomTurn($, UNANSWERED[e.reason])
    }
    return next(e)
  })
}

const complete = (roomUrl, token, handle) => (roomUrl && token && handle ? { roomUrl, token, handle } : null)

// A repository can commit this file, so a room it names off this machine would
// let anyone who opens the repository join a stranger's room: prompts in,
// answers out. The Room extension only writes http://127.0.0.1:<port>, and a
// repository cannot put a room on the user's own loopback.
function onThisMachine(roomUrl) {
  try {
    const u = new URL(String(roomUrl))
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.includes(u.hostname)
  } catch {
    return false
  }
}

// Missing, unreadable, not JSON or incomplete all mean no seat file; one whose
// room is off this machine is no seat file either, and the status says why.
async function readSeatFile($) {
  let cfg = null
  try {
    const f = JSON.parse(await $.fs.read(seatPath ?? SEAT_FILE))
    cfg = complete(f.room_url, f.seat_token, f.seat_handle)
  } catch {}
  const trusted = !cfg || onThisMachine(cfg.roomUrl)
  ignored = trusted ? '' : NOT_LOCAL
  if (!trusted) setStatus($, status)
  return trusted ? cfg : null
}

// { cfg, from } from the first complete source, or null. The file is read only
// when the environment has no seat.
async function findSeat($, options) {
  if (envSeat) return { cfg: envSeat, from: 'env' }
  const file = await readSeatFile($)
  if (file) return { cfg: file, from: 'file' }
  const opts = complete(options.room_url, options.seat_token, options.seat_handle)
  return opts ? { cfg: opts, from: 'options' } : null
}

function statusText() {
  return (source ? `${status} (seat from ${SOURCES[source]})` : status) + ignored
}

function setStatus($, text) {
  status = text
  $.ui.status(`room: ${text}${ignored}`)
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
  const inTurn = seat && inRoomTurn
  if (event === 'Stop') inRoomTurn = false
  if (!inTurn) return
  post($, `/seat/hook/${event}?token=${encodeURIComponent(seat.token)}`, payload)
    .catch(err => $.ui.log(`room hook ${event} failed: ${err?.message ?? err}`, { to: 'debug' }))
}

const seatOf = cfg => ({ roomUrl: String(cfg.roomUrl).replace(/\/+$/, ''), token: String(cfg.token), handle: String(cfg.handle).replace(/^@/, '') })

async function join($, cfg, from) {
  seat = seatOf(cfg)
  source = from
  retries = 0
  inRoomTurn = false
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
  let ended = null
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        $.ui.log(text.trim(), { to: 'debug' })
        continue
      }
      buf += text
      let i
      // Lines already read stay unprocessed once the seat has left.
      while (feed === stream && (i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) await onLine($, line, stream)
      }
    }
    ended = await stream.result?.catch(() => null)
  } catch (err) {
    if (feed === stream) setStatus($, `offline: could not run the room feed (${err?.message ?? err}); a room seat needs Node.js 22 or later on PATH`)
  }
  if (feed === stream) {
    feed = null
    seat = null
    inRoomTurn = false
    const how = ended?.code != null ? ` (exit code ${ended.code})` : ended?.signal ? ` (${ended.signal})` : ''
    if (!status.startsWith('offline')) setStatus($, `offline: the room feed stopped${how} - /room-join to reconnect`)
  }
}

async function onLine($, line, stream) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.status === 'online') {
    retries = 0
    return setStatus($, `online as @${seat.handle} in ${seat.roomUrl}`)
  }
  if (msg.status === 'retrying') {
    setStatus($, `reconnecting: ${msg.reason}`)
    if (++retries >= 3) await followSeatFile($, stream)
    return
  }
  if (msg.status === 'fatal') {
    setStatus($, `offline: ${msg.reason}`)
    return followSeatFile($, stream)
  }
  if (typeof msg.text === 'string') await submit($, msg.text)
}

// The Room extension rewrites the seat file when the room moves to a new port
// or the seat gets a new token. A seat from it that is refused, or keeps
// failing, rejoins with what the file says now - only when that differs from
// the address and token in use, so an unchanged file never loops.
async function followSeatFile($, stream) {
  if (source !== 'file') return
  retries = 0
  const cfg = await readSeatFile($)
  if (!cfg || feed !== stream) return // the seat left or joined again meanwhile
  const next = seatOf(cfg)
  if (next.roomUrl === seat.roomUrl && next.token === seat.token) return
  feed = null
  seat = null
  await stream.return?.().catch(() => {})
  await join($, cfg, 'file')
}

async function submit($, text) {
  const by = seat
  try {
    const entered = await $.prompt.submit({ text })
    if (entered?.drop) throw new Error(entered.drop)
    // It resolves once the session was idle and the turn started: from here
    // until it ends, the session's hook events belong to the room's turn.
    // Marked here, not in a prompt.submit hook of this mod's: called from this
    // loop, the submit skips every hook of this mod's. Not if the seat that
    // sent it left (or left and joined again) while the submit waited.
    if (seat === by) inRoomTurn = true
  } catch (err) {
    if (seat !== by) return
    inRoomTurn = false
    // The room marked this seat busy when it sent the turn. If the turn cannot
    // start, say so and close it, or every later message queues behind a turn
    // that never ran - the rule opencode.mjs follows too.
    // Not awaited: a post to a room that never answers would hold every later line.
    void closeRoomTurn($, `could not start the turn: ${err?.message ?? err}`)
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
