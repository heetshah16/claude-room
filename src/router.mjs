import { canAddress } from './identity.mjs'

// A mention is a standalone @claude token anywhere in the message, because
// "while that runs — @claude also check the refresh path" is how people
// actually write. Two guards keep it from over-matching:
//   (^|\s)      the @ must start the message or follow whitespace, so the
//               "@claude" inside mail@claude.example.com is not a mention
//   (?!\.[a-z]) it must not be followed by a dot and a letter, so a bare
//               "@claude.example.com" is not one either
const MENTION_ANYWHERE = /(?:^|\s)@claude\b(?!\.[a-z])/i

// Only a leading mention is stripped for display; a mid-sentence one reads
// naturally where it is and removing it would mangle the sentence.
const MENTION_LEADING = /^@claude\b[:,]?\s*/i

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

  const hasMention = MENTION_ANYWHERE.test(trimmed)
  const wants = hasMention || opts.force === true
  if (!wants) return base

  if (!canAddress(member)) return { ...base, reason: 'not-permitted' }

  const display = MENTION_LEADING.test(trimmed) ? trimmed.replace(MENTION_LEADING, '') : trimmed
  // A bare mention is a greeting, not a turn worth paying for.
  if (!display.trim()) return { ...base, display: trimmed, reason: 'empty' }

  return {
    addressed: true,
    content: raw,
    display,
    reason: hasMention ? 'mention' : 'explicit',
  }
}
