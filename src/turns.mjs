import { randomUUID } from 'node:crypto'
import { cacheRatio } from './ledger.mjs'

const MAX_ACTIVITY = 500

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
 */
export class TurnLog {
  #turns = []
  #open = null
  #byId = new Map()
  #byMsg = new Map()

  open({ messages = [], participants = [] } = {}) {
    const turn = {
      id: randomUUID(),
      promptId: null,
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
    this.#open = turn
    return turn
  }

  /** The first hook carrying a prompt_id names the open turn. */
  bindPrompt(promptId) {
    if (!promptId || !this.#open || this.#open.promptId) return this.#open
    this.#open.promptId = promptId
    this.#byId.set(promptId, this.#open)
    return this.#open
  }

  activity(evt, promptId) {
    this.bindPrompt(promptId)
    const turn = this.#open
    if (!turn) return null
    if (turn.activity.length < MAX_ACTIVITY) turn.activity.push({ ...evt, ts: evt.ts ?? Date.now() })
    return turn
  }

  reply(text, to) {
    const turn = this.#open
    if (!turn) return null
    turn.replies.push({ text, to, ts: Date.now() })
    return turn
  }

  close(promptId, usage) {
    this.bindPrompt(promptId)
    const turn = this.#open
    if (!turn) return null
    turn.endedAt = Date.now()
    if (usage) {
      turn.usage = usage
      turn.ratio = cacheRatio(usage)
    }
    this.#open = null
    return turn
  }

  openTurn() {
    return this.#open
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
