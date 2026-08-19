import { mayApprove } from './identity.mjs'

// Five lowercase letters drawn from a-z without 'l', per the channels reference —
// the omission keeps the id from reading as a 1 or I when typed on a phone.
export const REQUEST_ID = /^[a-km-z]{5}$/

const BEHAVIORS = new Set(['allow', 'deny'])

/**
 * Tracks permission prompts relayed out of the session and matches verdicts
 * coming back. Two gates apply: the request id must be one Claude Code issued,
 * and the answering member must actually hold approval authority. Anyone who can
 * answer a prompt can approve tool use in the host's session, so this is the
 * sharpest edge in the system.
 */
export class PermissionBroker {
  #open = new Map()

  constructor({ now = Date.now } = {}) {
    this.now = now
  }

  open(req) {
    const entry = { ...req, openedAt: this.now() }
    this.#open.set(req.request_id, entry)
    return entry
  }

  resolve(requestId, member, behavior) {
    if (!this.#open.has(requestId)) return { ok: false, reason: 'unknown-request' }
    if (!mayApprove(member)) return { ok: false, reason: 'not-permitted' }
    if (!BEHAVIORS.has(behavior)) return { ok: false, reason: 'bad-behavior' }
    const entry = this.#open.get(requestId)
    this.#open.delete(requestId)
    return { ok: true, reason: 'resolved', entry, behavior }
  }

  pending() {
    return [...this.#open.values()]
  }

  expire(maxAgeMs) {
    const t = this.now()
    const gone = []
    for (const [id, e] of this.#open) {
      if (t - e.openedAt > maxAgeMs) {
        gone.push(e)
        this.#open.delete(id)
      }
    }
    return gone
  }
}
