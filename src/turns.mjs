import { randomUUID } from 'node:crypto'
import { cacheRatio } from './ledger.mjs'

const MAX_ACTIVITY = 500

/**
 * How many turns to keep in memory.
 *
 * Only `recent(200)` is ever persisted, but nothing capped the in-memory
 * array: a long-lived room accumulated every turn it had ever run, each
 * holding up to MAX_ACTIVITY tool events, plus an entry in each index. The
 * room grew until it was killed. Kept comfortably above what is persisted so
 * a browser asking for a turn it can still see does not miss.
 */
const MAX_TURNS = 500

// Same idea as Queue's LOCAL_DEST: every caller that does not name a
// destination (every classic, pre-seats caller) gets this one, so a single
// implicit destination behaves exactly as the old single-`#open` design did.
const DEFAULT_DEST = '__local__'

/**
 * What the agent actually did, grouped by turn.
 *
 * Members other than the host see none of the terminal, so "claude is working"
 * is all the room can say unless something records the tool calls and ties them
 * back to the messages that caused them. This is that record.
 *
 * A turn opens before Claude Code has told anyone its prompt_id — the id only
 * arrives on the first hook — so turns are keyed by their own id and the
 * prompt_id is bound as an alias when it shows up.
 *
 * Several turns can be open at once — one per destination (the local channel,
 * or an agent seat) — so "open" is tracked per destination rather than as one
 * global field. Without that, seat A's Stop hook would bind to and close
 * whichever turn happened to be open most recently, seat B's included.
 */
export class TurnLog {
  #turns = []  // capped at MAX_TURNS by #evict
  #openByDest = new Map()
  #byId = new Map()
  #byMsg = new Map()

  open({ messages = [], participants = [], dest = DEFAULT_DEST } = {}) {
    const turn = {
      id: randomUUID(),
      promptId: null,
      dest,
      msgIds: messages.map(m => m.id),
      preview: messages.map(m => `${m.name}: ${m.text}`).join('\n').slice(0, 300),
      participants,
      startedAt: Date.now(),
      endedAt: null,
      activity: [],
      replies: [],
      usage: null,
      ratio: null,
    }
    this.#turns.push(turn)
    this.#byId.set(turn.id, turn)
    for (const id of turn.msgIds) this.#byMsg.set(id, turn.id)
    this.#openByDest.set(dest, turn)
    this.#evict()
    return turn
  }

  /**
   * Drop the oldest turns past MAX_TURNS, and every index entry pointing at
   * them — evicting from `#turns` alone would leave `#byId`/`#byMsg` holding
   * the objects forever, which is a leak with extra steps.
   *
   * An open turn is never evicted: it is still being written to, and losing it
   * would leave its destination unable to close.
   */
  #evict() {
    if (this.#turns.length <= MAX_TURNS) return
    const open = new Set(this.#openByDest.values())
    const overflow = this.#turns.length - MAX_TURNS
    const dropped = []
    let i = 0
    while (dropped.length < overflow && i < this.#turns.length) {
      if (!open.has(this.#turns[i])) dropped.push(this.#turns[i])
      i++
    }
    if (!dropped.length) return

    const gone = new Set(dropped)
    this.#turns = this.#turns.filter(t => !gone.has(t))
    for (const t of dropped) {
      this.#byId.delete(t.id)
      if (t.promptId) this.#byId.delete(t.promptId)
      for (const id of t.msgIds ?? []) this.#byMsg.delete(id)
    }
  }

  /** The first hook carrying a prompt_id names its destination's open turn. */
  bindPrompt(promptId, dest = DEFAULT_DEST) {
    const turn = this.#openByDest.get(dest) ?? null
    if (!promptId || !turn || turn.promptId) return turn
    turn.promptId = promptId
    this.#byId.set(promptId, turn)
    return turn
  }

  activity(evt, promptId, dest = DEFAULT_DEST) {
    const turn = this.bindPrompt(promptId, dest)
    if (!turn) return null
    if (turn.activity.length < MAX_ACTIVITY) turn.activity.push({ ...evt, ts: evt.ts ?? Date.now() })
    return turn
  }

  reply(text, to, dest = DEFAULT_DEST) {
    const turn = this.#openByDest.get(dest) ?? null
    if (!turn) return null
    turn.replies.push({ text, to, ts: Date.now() })
    return turn
  }

  close(promptId, usage, dest = DEFAULT_DEST) {
    const turn = this.bindPrompt(promptId, dest)
    if (!turn) return null
    turn.endedAt = Date.now()
    if (usage) {
      turn.usage = usage
      turn.ratio = cacheRatio(usage)
    }
    this.#openByDest.delete(dest)
    return turn
  }

  openTurn(dest = DEFAULT_DEST) {
    return this.#openByDest.get(dest) ?? null
  }

  /**
   * Every turn currently open, across every destination. `openTurn()` only
   * ever answers for one destination (the local channel by default); a room
   * with live seats can have several turns open at once, and a browser
   * watching the whole room needs to see all of them, not just the local one.
   */
  openTurns() {
    return [...this.#openByDest.values()]
  }

  get(id) {
    return this.#byId.get(id) ?? null
  }

  forMessage(msgId) {
    const id = this.#byMsg.get(msgId)
    return id ? this.#byId.get(id) ?? null : null
  }

  recent(n = 50) {
    return this.#turns.slice(-n)
  }

  toJSON() {
    return this.#turns
  }

  static fromJSON(arr = []) {
    const t = new TurnLog()
    for (const turn of arr) {
      t.#turns.push(turn)
      t.#byId.set(turn.id, turn)
      if (turn.promptId) t.#byId.set(turn.promptId, turn)
      for (const id of turn.msgIds ?? []) t.#byMsg.set(id, turn.id)
    }
    return t
  }
}
