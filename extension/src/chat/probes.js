// extension/src/chat/probes.js
//
// Slash commands the chat runs for its own information rather than because
// someone asked: `/model` for the picker, `/context` for the budget panel.
//
// Both are synthetic turns -- Claude Code answers them locally, no model call,
// no cost -- but they are still turns, and one process serves one turn at a
// time. So they have to queue rather than race.
//
// This exists because a boolean per probe cannot answer the question that
// actually matters at turn-end: whose answer is this? With two flags both set,
// the model parser and the context parser each get handed the other's text.
// And /context is requested AT turn-end, so without a guard the probe's own
// turn-end requests another one, forever.
'use strict'

const COMMANDS = { model: '/model', context: '/context' }

/**
 * @param {{send: (text: string) => void}} deps
 */
function createProbeQueue({ send }) {
  let inFlight = null
  const queued = []

  function dispatch() {
    if (inFlight || queued.length === 0) return
    inFlight = queued.shift()
    send(COMMANDS[inFlight])
  }

  return {
    /** Ask for a probe. Sent now if the line is clear, queued if it is not. */
    request(name) {
      // A bare `/` would be sent to the model as a message. Fail loudly.
      if (!COMMANDS[name]) throw new Error(`unknown probe: ${name}`)
      // Asking twice must not send twice -- the context probe is requested on
      // every real turn-end, and the chip's click asks for it too.
      if (inFlight === name || queued.includes(name)) return
      queued.push(name)
      dispatch()
    },

    /** True while a probe's output is arriving, which must not reach the transcript. */
    suppressing() {
      return inFlight !== null
    },

    /**
     * Call once per `turn-end`.
     *
     * @returns {string|null} the probe this turn answered, or null if this was
     *   a real conversational turn that should render normally.
     */
    onTurnEnd() {
      const answered = inFlight
      inFlight = null
      // Anything queued behind it goes now. A probe answering only ever
      // releases work already asked for; it never asks for more, which is what
      // keeps /context from retriggering itself.
      dispatch()
      return answered
    },

    /** Which probe is in flight, or null. */
    pending() {
      return inFlight
    },
  }
}

const probesApi = { createProbeQueue }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = probesApi
}
if (typeof window !== 'undefined') {
  window.ClaudeProbes = probesApi
}
