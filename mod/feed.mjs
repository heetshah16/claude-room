// The room feed for a mod-driven Claude Code seat, run as a child process by
// mod/hooks/register.js. A mod can only make outbound calls and cannot hold an
// SSE stream itself ($.http.fetch reads the whole body), so this process holds
// /seat/events for it and prints one JSON line per prompt the seat should run.
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

const log = s => process.stderr.write(`room-seat feed: ${s}\n`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { ROOM_URL: roomUrl, ROOM_SEAT_TOKEN: token, ROOM_SEAT_HANDLE: handle } = process.env
  if (!roomUrl || !token || !handle) {
    log('missing ROOM_URL, ROOM_SEAT_TOKEN or ROOM_SEAT_HANDLE')
    process.exit(1)
  }
  const prompt = createPrompter(handle)
  const emit = (event, data) => {
    const text = prompt(event, data)
    if (text) process.stdout.write(JSON.stringify({ text }) + '\n')
  }

  const res = await fetch(`${roomUrl}/seat/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, handle }),
  })
  // A bad token must stop the seat loudly, not leave it retrying forever.
  if (!res.ok) {
    log(`join refused: HTTP ${res.status}`)
    process.exit(1)
  }
  const joined = await res.json()
  if (joined?.seed?.text) emit('seed', { text: joined.seed.text })

  let backoffMs = 500
  for (;;) {
    try {
      const feed = await fetch(`${roomUrl}/seat/events?token=${encodeURIComponent(token)}`)
      if (!feed.ok || !feed.body) throw new Error(`feed refused: HTTP ${feed.status}`)
      log(`online as ${handle}`)
      backoffMs = 500
      await readFrames(feed.body, (event, raw) => {
        try {
          emit(event, JSON.parse(raw))
        } catch {
          // A malformed frame is dropped, never fatal.
        }
      })
      log('feed ended')
    } catch (err) {
      log(String(err?.message ?? err))
    }
    // Sleep/wake, a room restart, a wifi blip: reconnect, as seat.mjs does.
    await sleep(backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
