// The room feed for a mod-driven Claude Code seat, run as a child process by
// mod/hooks/register.js. A mod can only make outbound calls and cannot hold an
// SSE stream itself ($.http.fetch reads the whole body), so this process holds
// /seat/events for it and prints one JSON line per prompt or status change (see Task 2's line protocol).
//
// Seat liveness is unchanged: the seat is online exactly while this process
// holds the feed, and Claude Code kills it when the mod unloads.

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFrames, PendingContext, REPLY_DIRECTIVE, turnFields } from './lib/protocol.mjs'

/**
 * Room events -> prompt text, or null when the event is not a request.
 *
 * The same "pulled" shape as the OpenCode driver, reusing its pieces: mirrors,
 * briefs and the seed wait in a PendingContext and ride along with the next
 * real turn, and the reply rule rides in the prompt because a mod's tool has
 * no MCP `instructions` to carry it.
 */
export function createPrompter(handle) {
  const seat = `@${String(handle).replace(/^@/, '')}`
  const pending = new PendingContext()
  return (event, data = {}) => {
    if (event === 'mirror' || event === 'brief' || event === 'seed') {
      pending.add(event, data.text, data.from)
      return null
    }
    if (event !== 'turn') return null
    const t = turnFields(data.messages)
    if (!t) return null
    const where = data.room ? ` in room "${data.room}"` : ''
    const header = `${t.user} addressed you (${seat})${where}:`
    const attached = t.attachments.length ? `(attached: ${t.attachments.join(', ')})` : ''
    const body = [header, t.content, attached].filter(Boolean).join('\n')
    return [pending.drain().text, body, REPLY_DIRECTIVE].filter(Boolean).join('\n\n')
  }
}

// Refusals that retrying cannot fix. Anything else (a 5xx, a refused
// connection, a dropped stream) is a blip, and the feed reconnects.
const FATAL = {
  401: 'the room refused this seat token',
  403: 'this token is not an agent seat',
  409: 'this handle is already online in another session',
}

export function refusal(status) {
  return FATAL[status] ?? null
}

const say = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Exit only once the line is flushed: a pipe write can still be pending.
function fatal(reason) {
  process.stdout.write(JSON.stringify({ status: 'fatal', reason }) + '\n', () => process.exit(2))
}

async function main() {
  // The session that read this pipe is gone; a seat nobody reads must not
  // keep its handle online.
  process.stdout.on('error', () => process.exit(0))

  const { ROOM_URL: roomUrl, ROOM_SEAT_TOKEN: token, ROOM_SEAT_HANDLE: handle } = process.env
  if (!roomUrl || !token || !handle) return fatal('ROOM_URL, ROOM_SEAT_TOKEN and ROOM_SEAT_HANDLE must all be set')

  const prompt = createPrompter(handle)
  const emit = (event, data) => {
    const text = prompt(event, data)
    if (text) say({ text })
  }

  let joined = false
  let wasOnline = false
  let backoffMs = 500
  for (;;) {
    try {
      if (!joined) {
        const res = await fetch(`${roomUrl}/seat/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, handle }),
        })
        if (!res.ok) {
          const why = refusal(res.status)
          if (why) return fatal(why)
          throw new Error(`join failed: HTTP ${res.status}`)
        }
        const body = await res.json()
        if (body?.seed?.text) emit('seed', { text: body.seed.text })
        joined = true
      }
      const feed = await fetch(`${roomUrl}/seat/events?token=${encodeURIComponent(token)}`)
      if (!feed.ok || !feed.body) {
        // A 409 on reconnect is the room still holding our previous socket
        // (blip, sleep/wake) until its keepalive fails; only a 409 before we
        // were ever online means another session really owns the handle.
        if (feed.status === 409 && wasOnline) throw new Error('handle still held by the previous connection (HTTP 409)')
        const why = refusal(feed.status)
        if (why) return fatal(why)
        throw new Error(`feed refused: HTTP ${feed.status}`)
      }
      wasOnline = true
      say({ status: 'online' })
      backoffMs = 500
      await readFrames(feed.body, (event, raw) => {
        try {
          emit(event, JSON.parse(raw))
        } catch {
          // A malformed frame is dropped, never fatal.
        }
      })
      throw new Error('the room closed the feed')
    } catch (err) {
      say({ status: 'retrying', reason: String(err?.message ?? err) })
    }
    // Sleep/wake, a room restart, a wifi blip: reconnect, as seat.mjs does.
    await sleep(backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
