const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 })
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * Parse one line of a Claude Code transcript JSONL. Field shape verified against
 * a live transcript on 2026-08-19.
 *
 * @returns {import('./types.mjs').Usage|null}
 */
export function parseUsageLine(line) {
  if (!line || !line.trim()) return null
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (o?.type !== 'assistant') return null
  const u = o?.message?.usage
  if (!u) return null
  const cc = u.cache_creation ?? {}
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheCreate: n(u.cache_creation_input_tokens),
    cache1h: n(cc.ephemeral_1h_input_tokens),
    cache5m: n(cc.ephemeral_5m_input_tokens),
  }
}

export function sumUsage(usages) {
  const t = ZERO()
  for (const u of usages) {
    if (!u) continue
    for (const k of Object.keys(t)) t[k] += n(u[k])
  }
  return t
}

/**
 * Cached reads as a share of all input tokens. This is the instrument for the
 * payer-rotation question: if the ratio collapses on the turn after a credential
 * swap, rotation is paying full rate to reprocess the whole shared context.
 */
export function cacheRatio(u) {
  const total = n(u.input) + n(u.cacheRead) + n(u.cacheCreate)
  return total === 0 ? 0 : n(u.cacheRead) / total
}

/**
 * @param {import('./types.mjs').Usage} usage
 * @param {import('./types.mjs').Participant[]} participants
 * @param {'equal'|'weighted'} mode
 */
export function attribute(usage, participants, mode = 'equal') {
  const out = {}
  if (!participants.length) return out
  const totalWeight = participants.reduce((s, p) => s + n(p.weight), 0)
  // Weighted mode with no weight at all would divide by zero; fall back to equal.
  const useWeights = mode === 'weighted' && totalWeight > 0
  for (const p of participants) {
    const share = useWeights ? n(p.weight) / totalWeight : 1 / participants.length
    const slice = ZERO()
    for (const k of Object.keys(slice)) slice[k] = n(usage[k]) * share
    out[p.memberId] = slice
  }
  return out
}

export class Ledger {
  #turns = []
  #seen = new Set()
  #totals = new Map()

  /** Idempotent per promptId, so a re-fired Stop hook cannot double-charge anyone. */
  record(promptId, usage, participants, mode = 'equal') {
    if (promptId && this.#seen.has(promptId)) return null
    if (promptId) this.#seen.add(promptId)
    const split = attribute(usage, participants, mode)
    for (const [memberId, slice] of Object.entries(split)) {
      const cur = this.#totals.get(memberId) ?? ZERO()
      for (const k of Object.keys(cur)) cur[k] += slice[k]
      this.#totals.set(memberId, cur)
    }
    const turn = { promptId, usage, participants, split, ratio: cacheRatio(usage), ts: Date.now() }
    this.#turns.push(turn)
    return turn
  }

  totalsFor(memberId) {
    return this.#totals.get(memberId) ?? ZERO()
  }

  turns() {
    return this.#turns
  }

  toJSON() {
    return { turns: this.#turns, totals: Object.fromEntries(this.#totals) }
  }

  static fromJSON(o = {}) {
    const l = new Ledger()
    for (const t of o.turns ?? []) {
      l.#turns.push(t)
      if (t.promptId) l.#seen.add(t.promptId)
    }
    for (const [k, v] of Object.entries(o.totals ?? {})) l.#totals.set(k, v)
    return l
  }
}
