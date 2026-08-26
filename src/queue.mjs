import { randomUUID } from 'node:crypto'
import { classify } from './router.mjs'
import { ownsSeat } from './identity.mjs'

const INFLIGHT = '__inflight__'

// The destination every non-agent handle shares: the local MCP session this
// room was spawned from. Agent seats get their own destination (their
// handle); everything else — including a renamed classic handle — funnels
// here, because there is only ever one local channel to notify.
export const LOCAL_DEST = '__local__'

/**
 * The serialization point. An agent takes actions on a filesystem, so two
 * concurrent turns to the SAME destination cannot be merged the way two edits
 * to a document can — "refactor auth" and "revert auth" have no
 * reconciliation. Exactly one turn per destination runs at a time; everything
 * else for that destination stacks visibly in the queue.
 *
 * Concurrency is per-destination, not global: N agent seats each draw on a
 * different person's account and must be able to run their own turn without
 * waiting on — or being wedged by — anyone else's. A turn also always targets
 * exactly one destination; draining never merges messages addressed to
 * different seats (or a seat and the local channel) into one batch, which
 * would hand one person's message to another person's account.
 */
export class Queue {
  #pending = []
  #busy = new Set() // destinations with a turn currently in flight
  #inflight = new Map() // destination -> the turn currently in flight for it
  #byPrompt = new Map()
  #recent = new Map()
  #rotation = 0

  constructor({ config, ledger, decisions, registry, seats, now = Date.now }) {
    this.config = config
    this.ledger = ledger
    this.decisions = decisions
    this.registry = registry
    this.seats = seats
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

  /** Where a handle's turn belongs: the agent seat it names, or the one local channel. */
  #destinationOf(handle) {
    const agent = this.registry?.byHandle(handle)
    return agent ? agent.handle : LOCAL_DEST
  }

  /**
   * Every handle that can be addressed right now: the local channel's
   * configured aliases, plus one for each agent seat on the roster.
   *
   * Agent handles are minted at runtime by `seat add`, never configured up
   * front, so a caller's `handles` option only ever describes the local
   * channel. Unioning them here rather than at each call site is what stops
   * the two lists from drifting — web.mjs passes `config.handles`, and on its
   * own that made every seat unaddressable from the browser: the classifier
   * did not recognise `@ana-agent` as a mention at all, so the message was
   * filed as ordinary chatter and the owner-only and offline guards below
   * were never reached.
   */
  #addressableHandles(opts) {
    const configured = opts.handles ?? this.config.handles ?? []
    const agents = this.registry ? this.registry.agents().map(a => a.handle) : []
    return [...new Set([...configured, ...agents])]
  }

  /**
   * @returns {{ok:boolean, reason:string, message:import('./types.mjs').RoomMessage|null, conflicts:object[]}}
   */
  submit(member, text, opts = {}) {
    const c = classify(text, member, { ...opts, handles: this.#addressableHandles(opts) })
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

    // A handle that resolves to an agent seat is a different person's Anthropic
    // account — only its owner may address it, and only while it is listening.
    // No agent match (single-session rooms, or `registry`/`seats` not wired up)
    // leaves behaviour exactly as it was before seats existed.
    const agent = this.registry?.byHandle(c.handle)
    if (agent) {
      if (!ownsSeat(member, agent)) return { ok: false, reason: 'not-your-seat', message: null, conflicts: [] }
      if (!this.seats?.isOnline(c.handle)) return { ok: false, reason: 'seat-offline', message: null, conflicts: [] }
    }

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

  /** With no destination, whether ANYTHING is in flight anywhere in the room. */
  busy(dest) {
    return dest === undefined ? this.#busy.size > 0 : this.#busy.has(dest)
  }

  selectPayer(messages) {
    if (this.config.payerMode !== 'rotate') return null
    const refs = [...new Set(messages.map(m => m.payerRef).filter(Boolean))]
    if (!refs.length) return null
    return refs[this.#rotation++ % refs.length]
  }

  /**
   * Starts a turn for exactly one destination: the oldest pending message
   * whose destination is not already busy. Every other pending message for
   * that SAME destination rides along in the same batch (Claude Code batches
   * concurrent channel events anyway, so draining a destination's own
   * messages together keeps attribution honest); messages for every other
   * destination are left queued untouched.
   *
   * Scanning past a busy destination to find the next free one — rather than
   * only ever looking at the oldest message — is what stops one wedged seat
   * from freezing every other seat's ability to start its own turn.
   */
  beginTurn() {
    let dest = null
    for (const m of this.#pending) {
      const d = this.#destinationOf(m.handle)
      if (!this.#busy.has(d)) {
        dest = d
        break
      }
    }
    if (dest === null) return null

    const group = []
    const rest = []
    for (const m of this.#pending) {
      if (this.#destinationOf(m.handle) === dest) group.push(m)
      else rest.push(m)
    }
    this.#pending = rest

    const weights = new Map()
    for (const m of group) {
      weights.set(m.memberId, (weights.get(m.memberId) ?? 0) + (m.text?.length ?? 0))
    }
    const participants = [...weights].map(([memberId, weight]) => ({ memberId, weight }))

    this.#busy.add(dest)
    const turn = { dest, messages: group, participants, payer: this.selectPayer(group) }
    this.#inflight.set(dest, turn)

    // Stash under a fixed key too, but only for the local channel: the Stop
    // hook learns the prompt_id only after the turn has already started, so
    // there is no id to key on yet. Seat hooks never rely on this fallback —
    // they always carry their own participants — so it needs no per-seat form.
    if (dest === LOCAL_DEST) this.#byPrompt.set(INFLIGHT, participants)

    return turn
  }

  endTurn(dest, promptId) {
    const turn = this.#inflight.get(dest)
    if (promptId && turn) this.#byPrompt.set(promptId, turn.participants)
    this.#busy.delete(dest)
    this.#inflight.delete(dest)
  }

  /**
   * The turn currently in flight for a destination, or null. Lets a caller
   * that needs to abandon a destination (a seat dropping mid-turn, say) read
   * its messages/participants for a visible rejection before endTurn wipes
   * the record.
   */
  inflightFor(dest) {
    return this.#inflight.get(dest) ?? null
  }

  participantsOf(promptId) {
    return this.#byPrompt.get(promptId) ?? null
  }
}
