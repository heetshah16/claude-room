import { buildNotification } from './channel.mjs'

/**
 * `provider/model`, split on the FIRST slash — a model id may itself contain
 * slashes (`openrouter/meta/llama-3`), so splitting on all of them loses the
 * back half.
 */
export function parseModel(spec) {
  const s = String(spec)
  const i = s.indexOf('/')
  if (i <= 0 || i === s.length - 1) {
    throw new Error(`model must be provider/model, got: ${s}`)
  }
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

/**
 * The text of a room turn, rendered exactly as `channel.mjs` renders it for a
 * Claude seat. Reused rather than reimplemented so the two harnesses cannot
 * end up seeing differently-shaped versions of the same room.
 */
export function promptFromTurn(messages, roomName) {
  const nt = buildNotification(messages ?? [], roomName)
  return nt ? nt.params.content : null
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
 * One opencode bus event -> what the driver should do about it.
 *
 * Pure, so every branch is testable without a socket. Events for another
 * session are ignored outright: one opencode server hosts many sessions, and
 * acting on someone else's sessionID would end the wrong turn.
 */
export function actionForOpencodeEvent(ev, sessionId) {
  const type = ev?.type
  const p = ev?.properties ?? {}
  if (!type) return { type: 'ignore' }
  if (p.sessionID && p.sessionID !== sessionId) return { type: 'ignore' }

  if (type === 'session.idle') return { type: 'end-turn' }
  if (type === 'session.error') return { type: 'error', error: p.error ?? null }
  if (type === 'session.status') {
    const st = p.status?.type
    // Retry is alive-but-not-progressing. Naming it separately is what stops
    // the deadline from being reset by a model that is failing in a loop.
    if (st === 'retry') return { type: 'retry', attempt: p.status?.attempt ?? 0 }
    return { type: 'busy' }
  }
  return { type: 'ignore' }
}
