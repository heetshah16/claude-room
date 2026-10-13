// The room's seat protocol, the parts that are plain JavaScript: reading an
// SSE stream, rendering a turn, holding context until the next real turn.
//
// It lives inside mod/ because a marketplace install of the room-seat plugin
// copies mod/ and nothing else, without node_modules. The room imports it
// from here too, so there is still exactly one copy - this repo has been
// bitten more than once by a hand-maintained second copy drifting from the
// first. Keep it dependency-free: test/mod-boundary.test.mjs enforces that.

/**
 * Reads Server-Sent Events by hand off a fetch Response's streaming body.
 * Frames are separated by a blank line; only the `event:`/`data:` lines
 * matter here, so a bare `: comment` keep-alive (the room writes one on
 * connect) has neither and is silently skipped. `onFrame` fires once per
 * complete frame; this returns when the stream ends.
 *
 * `event` is passed through as `null` when a frame carries no `event:`
 * line — OpenCode's SSE frames never have one, only `data:`. The room feed
 * always sends `event:`, and its caller here additionally filters with
 * FEED_EVENTS.has(event), which rejects null, so this relaxation is safe
 * for the room path and required for OpenCode's.
 */
export async function readFrames(body, onFrame) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = null
      let data = null
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length)
        else if (line.startsWith('data: ')) data = line.slice('data: '.length)
      }
      if (data !== null) onFrame(event, data)
    }
  }
}

const LABEL = { mirror: 'mirror', brief: 'brief', seed: 'seed' }

/**
 * Room events that are NOT a request — mirrors, briefs, the join seed.
 *
 * OpenCode has no inbox, so these cannot be delivered on their own: sending
 * one would start a turn nobody asked for. They wait here and ride along with
 * the next real turn.
 *
 * Bounded, because they arrive whether or not this seat is ever addressed.
 * Drops are counted and reported rather than hidden, mirroring how `pending`
 * already tells a Claude seat how stale its brief is.
 */
export class PendingContext {
  #max
  #items = []
  #dropped = 0

  constructor(max = 20) {
    this.#max = Math.max(1, Number(max) || 20)
  }

  add(kind, text, from) {
    if (!text || !String(text).trim()) return
    const label = LABEL[kind] ?? 'context'
    this.#items.push(from ? `[${label} from @${from}] ${text}` : `[${label}] ${text}`)
    while (this.#items.length > this.#max) {
      this.#items.shift()
      this.#dropped++
    }
  }

  drain() {
    if (!this.#items.length && !this.#dropped) return { text: '', dropped: 0 }
    const dropped = this.#dropped
    const lines = [...this.#items]
    if (dropped) lines.unshift(`(${dropped} earlier room events dropped)`)
    this.#items = []
    this.#dropped = 0
    return {
      dropped,
      text: [
        '--- room context: background only, never a request ---',
        ...lines,
        '--- end room context ---',
      ].join('\n'),
    }
  }
}

/**
 * OpenCode does not surface an MCP server's `instructions` to its model the way
 * Claude Code does, so the seat never learns the one rule that matters. It has
 * to ride in the prompt body instead. Without it the seat does the work and
 * reports nothing, which reads as silence to everyone waiting in the room.
 */
export const REPLY_DIRECTIVE = [
  '---',
  'When you have finished, you MUST call the room_reply tool to report what you did.',
  'Your normal output does NOT reach the room — room_reply is the only channel to it.',
  'A turn that ends without calling room_reply looks like silence to the people waiting.',
  'After room_reply, end your turn: anything you write after it reaches no one and keeps the room waiting.',
].join('\n')

/**
 * The parts of a drained turn every harness renders: everyone's words
 * verbatim, and who said them, kept apart so the words are never rewritten.
 * Null for an empty turn.
 */
export function turnFields(messages) {
  if (!messages?.length) return null
  return {
    content: messages.length === 1
      ? messages[0].content
      : messages.map(m => `[${m.name}] ${m.content}`).join('\n'),
    user: messages.map(m => m.name).join(','),
    memberId: messages.map(m => m.memberId).join(','),
    msgId: messages.map(m => m.id).join(','),
    batch: messages.length,
    // Every attachment in the batch, not just the first message's.
    attachments: messages.map(m => m.attachment?.path).filter(Boolean),
  }
}
