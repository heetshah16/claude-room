import { canAddress } from './identity.mjs'

// Leading mention only. Anchored at ^ so "mail@claude.example.com" and
// "ask @claude later" stay chatter — the whole point is that most traffic
// never reaches the shared context window.
const MENTION = /^@claude\b[:,]?\s*/i

/**
 * The classifier. Pure, synchronous, no model call — so it adds no latency to
 * the hot path, which is what makes a curation layer viable at all.
 *
 * @param {string} text
 * @param {import('./types.mjs').Member} member
 * @param {{force?:boolean}} [opts]
 * @returns {{addressed:boolean, content:string, display:string, reason:string}}
 */
export function classify(text, member, opts = {}) {
  const raw = typeof text === 'string' ? text : ''
  const trimmed = raw.trim()
  const base = { addressed: false, content: raw, display: trimmed, reason: 'chatter' }

  if (!trimmed) return { ...base, reason: 'empty' }

  const hasMention = MENTION.test(trimmed)
  const wants = hasMention || opts.force === true
  if (!wants) return base

  if (!canAddress(member)) return { ...base, reason: 'not-permitted' }

  const display = hasMention ? trimmed.replace(MENTION, '') : trimmed
  // A bare mention is a greeting, not a turn worth paying for.
  if (!display.trim()) return { ...base, display: trimmed, reason: 'empty' }

  return {
    addressed: true,
    content: raw,
    display,
    reason: hasMention ? 'mention' : 'explicit',
  }
}
