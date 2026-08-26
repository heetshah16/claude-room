import { randomUUID } from 'node:crypto'

const STOP = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'is', 'are', 'be', 'it', 'we', 'so',
  'on', 'in', 'with', 'use', 'using', 'should', 'must', 'can', 'after', 'now', 'has',
  'have', 'that', 'this', 'then', 'than', 'as', 'at', 'by', 'from', 'do', 'does',
])

const NEGATORS = ['not', 'no longer', "don't", 'dont', 'never', 'stop', 'remove', 'drop', 'instead', 'revert', 'undo']

export function extractTags(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
  return [...new Set(words)].filter(w => !STOP.has(w))
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasNegator = t => NEGATORS.some(neg => new RegExp(`\\b${escape(neg)}\\b`, 'i').test(t))

// Open decisions are never dropped; this only bounds the superseded history.
const MAX_DECISIONS = 500

export class Decisions {
  #items = []

  add({ text, by, tags, supersedes = null }) {
    const d = {
      id: randomUUID(),
      text,
      by,
      tags: tags?.length ? tags : extractTags(text),
      ts: Date.now(),
      supersededBy: null,
    }
    if (supersedes) {
      const prev = this.#items.find(x => x.id === supersedes)
      if (prev) prev.supersededBy = d.id
    }
    this.#items.push(d)
    // Superseded decisions are history, not state: `open()` filters them out
    // and `conflicts()` never consults them, but they were kept forever and
    // rewritten to disk on every decision. Trim the oldest closed ones only —
    // an open decision is live and must never be dropped.
    if (this.#items.length > MAX_DECISIONS) {
      const closed = this.#items.filter(x => x.supersededBy !== null)
      const drop = new Set(closed.slice(0, this.#items.length - MAX_DECISIONS))
      if (drop.size) this.#items = this.#items.filter(x => !drop.has(x))
    }
    return d
  }

  open() {
    return this.#items.filter(d => d.supersededBy === null)
  }

  /**
   * Surfaces candidate contradictions for a human to judge. Deliberately never
   * resolves one: the failure mode being prevented is the agent quietly picking
   * a side and nobody noticing until review.
   */
  conflicts(text, tags) {
    const incoming = new Set(tags?.length ? tags : extractTags(text))
    const negated = hasNegator(text)
    const out = []
    for (const d of this.open()) {
      const overlap = d.tags.filter(t => incoming.has(t))
      if (!overlap.length) continue
      // A negation cue plus any shared topic is the "add a cache layer" versus
      // "keep this stateless" case. Without a cue, demand real topical overlap.
      if (negated) out.push({ decision: d, reason: 'negation', overlap })
      else if (overlap.length >= 2) out.push({ decision: d, reason: 'overlap', overlap })
    }
    return out
  }

  toJSON() {
    return this.#items
  }

  static fromJSON(arr = []) {
    const d = new Decisions()
    for (const item of arr) d.#items.push(item)
    return d
  }
}
