// extension/src/events.js
'use strict'

/**
 * Fans one SSE subscription's frames out to the two things the chat panel
 * needs: activity to show (a delegation went out, a worker used a tool) and
 * results to hand back to the orchestrator (a delegation finished, one way
 * or another).
 *
 * The ordering this enforces is the whole point: a `delegation` event whose
 * `state` is `sent` must never reach `onDelegationResult` — relaying it back
 * to the orchestrator as if it were an answer would tell the orchestrator
 * its own request was a reply, and it would answer itself. Only `done` and
 * `abandoned` are results; `sent` (and anything not recognised at all) is
 * activity, so the panel can show the work without the orchestrator ever
 * seeing it as a turn.
 *
 * Pure: no I/O, no timers, nothing but the callbacks it is given. That is
 * what keeps this testable without a socket or a real room.
 */
function createEventRouter({ onWorkerActivity, onDelegationResult }) {
  function handleDelegation(data) {
    const { id, to: handle, state, task, text, reason } = data ?? {}
    if (state === 'sent') {
      onWorkerActivity({ kind: 'delegation-sent', id, handle, task })
      return
    }
    if (state === 'done') {
      onDelegationResult({ id, handle, text })
      return
    }
    if (state === 'abandoned') {
      // Reported as a failed result, not dropped — without this the chat
      // would wait forever for a reply that is never coming, e.g. because
      // the seat it was sent to disconnected mid-turn.
      onDelegationResult({ id, handle, failed: true, text: `delegation to @${handle} was abandoned: ${reason}` })
      return
    }
    // A delegation state neither this router nor the panel recognises yet —
    // surfaced as activity rather than silently dropped or, worse, treated
    // as a result the orchestrator did not actually receive.
    onWorkerActivity({ kind: 'delegation', ...data })
  }

  return {
    handle(event, data) {
      if (event === 'delegation') return handleDelegation(data)
      if (event === 'activity') return onWorkerActivity(data)
      // Any other room event — an unknown or future SSE event type — is
      // dropped rather than crashing the extension host. The room's stream
      // is allowed to grow event types this router does not yet know.
    },
  }
}

module.exports = { createEventRouter }
