import { randomUUID } from 'node:crypto'
import { classify } from './router.mjs'

const INFLIGHT = '__inflight__'

/**
 * The serialization point. An agent takes actions on a filesystem, so two
 * concurrent turns cannot be merged the way two edits to a document can —
 * "refactor auth" and "revert auth" have no reconciliation. Exactly one turn
 * runs at a time; everything else stacks visibly in the queue.
 */
export class Queue {
  #pending = []
  #busy = false
  #inflight = null
  #byPrompt = new Map()
  #recent = new Map()
  #rotation = 0

  constructor({ config, ledger, decisions, now = Date.now }) {
    this.config = config
    this.ledger = ledger
    this.decisions = decisions
    this.now = now
  }

  #rateOk(memberId) {
    const { windowMs, messagesPerWindow } = this.config.budgets
    const t = this.now()
    const hits = (this.#recent.get(memberId) ?? []).filter(x => t - x < windowMs)
    this.#recent.set(memberId, hits)
    return hits.length < messagesPerWindow
  }

  #budgetOk(memberId) {
    const cap = this.config.budgets.tokensPerMember
    if (!cap) return true
    const u = this.ledger.totalsFor(memberId)
    return u.input + u.output + u.cacheRead + u.cacheCreate < cap
  }

  /**
   * @returns {{ok:boolean, reason:string, message:import('./types.mjs').RoomMessage|null, conflicts:object[]}}
   */
  submit(member, text, opts = {}) {
    const c = classify(text, member, { ...opts, handles: opts.handles ?? this.config.handles })
    const message = {
      id: randomUUID(),
      memberId: member.id,
      name: member.name,
      text: c.display,
      content: c.content,
      ts: this.now(),
      addressed: c.addressed,
      handle: c.handle,
      kind: 'chat',
      attachment: opts.attachment,
    }

    // Chatter is accepted into the room but never costs a token.
    if (!c.addressed) return { ok: true, reason: c.reason, message, conflicts: [] }

    // A paused room still carries conversation; it just stops taking work.
    const paused = opts.paused ?? this.config.paused
    if (paused) return { ok: false, reason: 'paused', message: null, conflicts: [] }

    // Rejections are visible, never silent — a dropped message the sender
    // believes landed is the worst failure this system can have.
    if (!this.#rateOk(member.id)) return { ok: false, reason: 'rate-limited', message: null, conflicts: [] }
    if (!this.#budgetOk(member.id)) return { ok: false, reason: 'over-budget', message: null, conflicts: [] }

    this.#recent.get(member.id).push(this.now())
    message.payerRef = member.payerRef ?? null
    this.#pending.push(message)

    const conflicts = this.decisions ? this.decisions.conflicts(c.display) : []
    return { ok: true, reason: 'queued', message, conflicts }
  }

  pending() {
    return [...this.#pending]
  }

  /** Drop everything waiting. Returns how many were discarded. */
  clear() {
    const n = this.#pending.length
    this.#pending = []
    return n
  }

  busy() {
    return this.#busy
  }

  selectPayer(messages) {
    if (this.config.payerMode !== 'rotate') return null
    const refs = [...new Set(messages.map(m => m.payerRef).filter(Boolean))]
    if (!refs.length) return null
    return refs[this.#rotation++ % refs.length]
  }

  /**
   * Drains everything queued into a single turn. Claude Code batches concurrent
   * channel events anyway; draining together keeps attribution honest.
   */
  beginTurn() {
    if (this.#busy || !this.#pending.length) return null
    const messages = this.#pending
    this.#pending = []
    this.#busy = true

    const weights = new Map()
    for (const m of messages) {
      weights.set(m.memberId, (weights.get(m.memberId) ?? 0) + (m.text?.length ?? 0))
    }
    const participants = [...weights].map(([memberId, weight]) => ({ memberId, weight }))

    // Stash under a fixed key too: the Stop hook learns the prompt_id only after
    // the turn has already started, so there is no id to key on at this point.
    this.#byPrompt.set(INFLIGHT, participants)

    this.#inflight = { messages, participants, payer: this.selectPayer(messages) }
    return this.#inflight
  }

  endTurn(promptId) {
    if (promptId && this.#inflight) this.#byPrompt.set(promptId, this.#inflight.participants)
    this.#busy = false
    this.#inflight = null
  }

  participantsOf(promptId) {
    return this.#byPrompt.get(promptId) ?? null
  }
}
