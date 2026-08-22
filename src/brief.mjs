import { createHash } from 'node:crypto'

const SECTIONS = ['threads', 'forks', 'reversals', 'tried', 'unanswered']

// Only these are worth interrupting people about. A new thread or a new
// "tried" entry is useful context but not news.
const HARD = ['reversals', 'forks']

const FIELDS = {
  threads: ['id', 'topic', 'owner', 'status', 'last'],
  forks: ['id', 'at', 'branches', 'live'],
  reversals: ['id', 'who', 'was', 'now', 'why'],
  tried: ['id', 'what', 'outcome', 'turn'],
  unanswered: ['id', 'who', 'question'],
}

const MAX_ENTRIES = 12
const MAX_STR = 300

export const EMPTY_BRIEF = () => ({
  threads: [], forks: [], reversals: [], tried: [], unanswered: [], ts: 0,
})

const str = v => (typeof v === 'string' ? v.slice(0, MAX_STR) : undefined)
const strArr = v =>
  Array.isArray(v)
    ? v.filter(x => typeof x === 'string').slice(0, MAX_ENTRIES).map(x => x.slice(0, MAX_STR))
    : undefined

/**
 * The observer's output is generated text derived from untrusted room input, so
 * it is never trusted structurally. Unknown keys are dropped, arrays capped,
 * strings truncated. This does not close the laundering risk — a summary still
 * reaches the main agent — but it bounds the shape of what can get through.
 */
export function clampBrief(raw, ts = 0) {
  const out = EMPTY_BRIEF()
  out.ts = ts
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out

  for (const section of SECTIONS) {
    const src = raw[section]
    if (!Array.isArray(src)) continue
    const entries = []
    for (const item of src.slice(0, MAX_ENTRIES)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = {}
      for (const f of FIELDS[section]) {
        const v = Array.isArray(item[f]) ? strArr(item[f]) : str(item[f])
        if (v !== undefined) entry[f] = v
      }
      if (Object.keys(entry).length) entries.push(entry)
    }
    out[section] = entries
  }
  return out
}

export function signalId(kind, subject) {
  return createHash('sha256').update(`${kind}::${subject}`).digest('hex').slice(0, 12)
}

const subjectOf = (kind, e) =>
  kind === 'reversals'
    ? `${e.who ?? ''}|${e.was ?? ''}`
    : `${e.at ?? ''}|${(e.branches ?? []).join('>')}`

/** Entries present in `next` but not in `prev`, and only from hard sections. */
export function diffBriefs(prev, next) {
  const signals = []
  for (const kind of HARD) {
    const seen = new Set((prev?.[kind] ?? []).map(e => signalId(kind, subjectOf(kind, e))))
    for (const entry of next?.[kind] ?? []) {
      const id = signalId(kind, subjectOf(kind, entry))
      if (!seen.has(id)) signals.push({ id, kind, entry })
    }
  }
  return signals
}

const line = (kind, e) => {
  if (kind === 'threads') {
    return `${e.topic ?? '?'} (${e.owner ?? 'unowned'}, ${e.status ?? 'open'})` +
      (e.last ? ` — ${e.last}` : '')
  }
  if (kind === 'forks') {
    return `${e.at ?? '?'} → ${(e.branches ?? []).join(' vs ')}` +
      (e.live?.length ? ` [live: ${e.live.join(', ')}]` : '')
  }
  if (kind === 'reversals') {
    return `${e.who ?? '?'}: ${e.was ?? '?'} → ${e.now ?? '?'}` + (e.why ? ` (${e.why})` : '')
  }
  if (kind === 'tried') return `${e.what ?? '?'} → ${e.outcome ?? 'unknown'}`
  return `${e.who ?? '?'}: ${e.question ?? '?'}`
}

export function renderBrief(brief) {
  const parts = []
  for (const kind of SECTIONS) {
    const entries = brief?.[kind] ?? []
    if (!entries.length) continue
    parts.push(`${kind}:`)
    for (const e of entries) parts.push(`  - ${line(kind, e)}`)
  }
  return parts.join('\n')
}

// Floor, not round: a brief 4.5s old has been stale for 4 whole seconds, and
// overstating staleness would make a fresh brief look worse than it is.
export const briefAge = (brief, now = Date.now()) =>
  Math.max(0, Math.floor((now - (brief?.ts ?? 0)) / 1000))

export function noteFor(signal) {
  const e = signal.entry
  if (signal.kind === 'reversals') {
    return `${e.who ?? 'someone'} moved from "${e.was ?? '?'}" to "${e.now ?? '?'}"` +
      (e.why ? ` — ${e.why}` : '') + '. Flagging, not resolving.'
  }
  return `This split at ${e.at ?? 'some point'}: ${(e.branches ?? []).join(' vs ')}` +
    (e.live?.length ? `. Still live: ${e.live.join(', ')}` : '') + '. Which one wins?'
}
