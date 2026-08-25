export function buildSeed({ brief, decisions, messages, limit }) {
  // Filter: keep only addressed messages and replies (exclude chatter)
  const filtered = messages.filter(msg => msg.addressed === true || msg.kind === 'reply')

  // Cap: keep only the most recent `limit` messages
  const capped = filtered.slice(-limit)

  // Build text with brief, decisions, and conversation
  const parts = []

  if (brief) {
    parts.push('=== Brief ===')
    parts.push(brief)
  }

  if (decisions.length > 0) {
    parts.push('=== Decisions ===')
    decisions.forEach(d => {
      parts.push('- ' + d.text)
    })
  }

  if (capped.length > 0) {
    parts.push('=== Conversation ===')
    capped.forEach(msg => {
      parts.push(`[${msg.name}] ${msg.text}`)
    })
  }

  return {
    text: parts.join('\n'),
    counts: { messages: capped.length },
  }
}
