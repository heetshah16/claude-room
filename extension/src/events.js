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
/**
 * src/web.mjs's `activity` bus event carries the seat's handle under `dest`
 * — that is the field name the room's own turn-tracking uses everywhere, and
 * `emitActivity` just forwards it verbatim. The panel, and the
 * `delegation-sent` activity this router builds itself, both key off
 * `handle` instead. Normalising here means the webview only ever has to
 * read one field name, rather than guessing between two per event source.
 */
function normalizeActivity(data) {
  if (!data || data.handle !== undefined || data.dest === undefined) return data
  return { ...data, handle: data.dest }
}

/**
 * @param {{onWorkerActivity: Function, onDelegationResult: Function,
 *          onRoomEvent?: Function}} deps
 *
 * `onRoomEvent` sees EVERY frame, including the ones the panel has no use for
 * and the ones this router does not recognise at all. The worker pool needs
 * `delegation` in all its states; the panel needs two of them. Giving the pool
 * its own SSE subscription would give the two consumers different orderings,
 * and one ordering is the property this file exists to preserve.
 */
function createEventRouter({ onWorkerActivity, onDelegationResult, onRoomEvent = null }) {
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
      // Normalised once, here, so neither consumer has to guess whether a
      // seat's handle arrived as `dest` or as `handle`.
      const normalized = event === 'activity' ? normalizeActivity(data) : data
      // The observer is told first and unconditionally: it must not depend on
      // whether this router happens to recognise the event.
      onRoomEvent?.(event, normalized)

      if (event === 'delegation') return handleDelegation(normalized)
      if (event === 'activity') return onWorkerActivity(normalized)
      // Any other room event — an unknown or future SSE event type — is
      // dropped rather than crashing the extension host. The room's stream
      // is allowed to grow event types this router does not yet know.
    },
  }
}

module.exports = { createEventRouter }
