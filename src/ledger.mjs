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
    // Tokens are whole things. Multiplying by 1/3 gave totals like
    // 1266.6666666666667, which then accumulated float error across every
    // turn and rendered as noise in the UI. Rounding each slice can lose a
    // token or two against the true total; that is the right trade for a
    // fairness display, and the per-turn `usage` above stays exact.
    for (const k of Object.keys(slice)) slice[k] = Math.round(n(usage[k]) * share)
    out[p.memberId] = slice
  }
  return out
}

/**
 * How many per-turn records to keep, and how many promptIds to remember for
 * idempotency. Totals are cumulative and never dropped — only the itemised
 * history is trimmed. Unbounded, these grew for the life of the room and were
 * rewritten to disk in full on every single turn, so cost was O(turns so far)
 * per turn.
 */
const MAX_TURNS = 1000

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
    // Trim in step so the two never diverge: dropping a turn whose promptId is
    // still in #seen would keep the set growing forever anyway.
    if (this.#turns.length > MAX_TURNS) {
      const dropped = this.#turns.splice(0, this.#turns.length - MAX_TURNS)
      for (const d of dropped) if (d.promptId) this.#seen.delete(d.promptId)
    }
    return turn
  }

  /** A copy: handing out the live object lets any caller silently rewrite the ledger. */
  totalsFor(memberId) {
    return { ...ZERO(), ...(this.#totals.get(memberId) ?? {}) }
  }

  turns() {
    return this.#turns
  }

  toJSON() {
    return { turns: this.#turns, totals: Object.fromEntries(this.#totals) }
  }

  static fromJSON(o = {}) {
    const l = new Ledger()
    for (const t of (o.turns ?? []).slice(-MAX_TURNS)) {
      l.#turns.push(t)
      if (t.promptId) l.#seen.add(t.promptId)
    }
    for (const [k, v] of Object.entries(o.totals ?? {})) l.#totals.set(k, v)
    return l
  }
}
