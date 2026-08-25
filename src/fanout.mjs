/**
 * Fan-out policy: who receives what. Pure switch over event type to avoid
 * chatter leaking into context windows and prevent agent loops via mirrors.
 *
 * @param {object} event - Event with type and payload
 * @param {object[]} seats - Array of {seatId, handle}
 * @returns {object[]} Array of {seatId, kind, payload} deliveries
 */
export function fanOut(event, seats) {
  switch (event.type) {
    case 'addressed':
      return addressedDeliveries(event, seats)
    case 'chatter':
      // Cost control: unaddressed traffic never enters a context window.
      // Reaches seats only later, compressed, via observer brief.
      return []
    case 'reply':
      return mirrorDeliveries(event, seats)
    case 'turn-digest':
      return turnDigestDeliveries(event, seats)
    case 'brief':
      return briefDelivery(event, seats)
    default:
      return []
  }
}

/**
 * The observer's brief, injected immediately before the turn it precedes —
 * the seat mirror of what the local channel already does in web.mjs's
 * drain(). Goes only to the one seat about to be addressed, never mirrored
 * to the rest: it re-synchronises that seat's own drifted context, and every
 * other live seat gets its own copy of the same brief the next time it is
 * the one being addressed.
 */
function briefDelivery(event, seats) {
  const seat = seats.find(s => s.handle === event.handle)
  if (!seat) return []
  return [{
    seatId: seat.seatId,
    kind: 'brief',
    payload: { text: event.text, ageS: event.ageS, pending: event.pending, room: event.room },
  }]
}

/**
 * Addressed message: turn to matching handle, mirror to all others.
 * If no seat has that handle, nothing to deliver.
 */
function addressedDeliveries(event, seats) {
  const addressedSeat = seats.find(s => s.handle === event.handle)
  if (!addressedSeat) return []

  const out = []
  for (const seat of seats) {
    out.push({
      seatId: seat.seatId,
      kind: seat.seatId === addressedSeat.seatId ? 'turn' : 'mirror',
      payload: event.messages,
    })
  }
  return out
}

/**
 * Reply: mirror to all seats except originator. Never a turn — agents cannot
 * be made to act by other agents, even if the reply contains @mentions.
 */
function mirrorDeliveries(event, seats) {
  const seatFromHandle = seats.find(s => s.handle === event.fromHandle)
  if (!seatFromHandle) return []

  return seats
    .filter(s => s.seatId !== seatFromHandle.seatId)
    .map(seat => ({
      seatId: seat.seatId,
      kind: 'mirror',
      payload: { text: event.text },
    }))
}

/**
 * Turn digest: mirrors what another agent did. Never a turn. Includes tool
 * names and outcome, but never tool output.
 */
function turnDigestDeliveries(event, seats) {
  const seatFromHandle = seats.find(s => s.handle === event.fromHandle)
  if (!seatFromHandle) return []

  const text = `${event.tools.join(', ')} → ${event.outcome}`

  return seats
    .filter(s => s.seatId !== seatFromHandle.seatId)
    .map(seat => ({
      seatId: seat.seatId,
      kind: 'mirror',
      payload: { text },
    }))
}

/**
 * Digest a turn into a one-line summary: what the agent did and said.
 * Extracts tool names and primary arguments from activity, but never outputs.
 * Primary argument is first of: file_path, command, pattern, path.
 *
 * @param {object} turn - Turn object with preview, activity, replies
 * @returns {string} Summary of tools used and outcome
 */
export function digestOf(turn) {
  // Collect distinct tool names and primary arguments, without output.
  // Preserve first-seen order; repeated tools appear once only.
  const seenTools = new Set()
  const tools = []
  for (const act of turn.activity || []) {
    if (act.kind === 'tool-start' && !seenTools.has(act.tool)) {
      seenTools.add(act.tool)
      const arg = act.input?.file_path || act.input?.command ||
                  act.input?.pattern || act.input?.path || ''
      const suffix = arg ? ` ${arg}` : ''
      tools.push(`${act.tool}${suffix}`)
    }
  }

  const toolSummary = tools.length ? tools.join(', ') : ''
  const replySummary = turn.replies?.[0]?.text || ''

  // Build one-line summary: tools, then what the agent said.
  const parts = [toolSummary, turn.preview, replySummary].filter(Boolean)
  return parts.join(' • ')
}
