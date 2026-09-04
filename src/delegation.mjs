/**
 * Delegation brief validation and rendering.
 *
 * Delegated work fails because the brief was thin far more often than because
 * the model was weak. So a brief is validated here, not trusted, and a
 * rejection is returned to the orchestrator while it still has the context to
 * fix it — the errors name the missing field, not just "rejected".
 *
 * Pure: no I/O, no timers, no process.env. This module only looks at the
 * object it is given.
 */

/**
 * What kind of work this is. The class never routes — `to` does that, chosen
 * by the orchestrator, which holds more context than any classifier would.
 * The class labels the ledger entry and decides which spec fields are
 * mandatory, and nothing else.
 */
export const TASK_CLASSES = ['reasoning', 'execution', 'verification']

const nonEmptyList = v => Array.isArray(v) && v.filter(x => String(x ?? '').trim()).length > 0

/**
 * Validate a delegation request before it is handed to a seat.
 *
 * `class: 'execution'` requires non-empty `spec.files` and `spec.tests` — a
 * worker told only "do the thing" invents an interface nobody asked for.
 * `reasoning` and `verification` require only `task`: there is no code to
 * scope, so demanding files/tests would just be friction.
 */
export function validateDelegation(input = {}) {
  const errors = []
  const { to, task, spec = {} } = input
  const cls = input.class

  if (!to || !String(to).trim()) errors.push('to is required: the @handle to delegate to')
  if (!TASK_CLASSES.includes(cls)) errors.push(`class must be one of ${TASK_CLASSES.join(', ')}`)
  if (!task || !String(task).trim()) errors.push('task is required: one line saying what to do')

  if (cls === 'execution') {
    if (!nonEmptyList(spec.files)) errors.push('spec.files is required for execution: which files may be touched')
    if (!nonEmptyList(spec.tests)) errors.push('spec.tests is required for execution: how the work is verified')
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Delegations handed out and not yet answered, keyed by the target seat's
 * handle.
 *
 * Keying by handle is only correct because the room serialises one turn per
 * destination, and an agent seat IS a destination: a second delegation to the
 * same handle cannot begin until the first one's turn has ended, so at most
 * one delegation per handle is ever in flight. That invariant is what lets a
 * seat's reply be matched to the delegation that caused it without a
 * correlation id — nothing in the seat protocol carries one, and the seat
 * itself is a plain Claude Code or OpenCode session that would have no reason
 * to echo one back.
 *
 * `take` is deliberately destructive: a delegation is answered exactly once,
 * and every reply after that is the seat talking to the room normally.
 */
export class PendingDelegations {
  #byHandle = new Map()

  /** @param {{id:string, task:string, class:string, at:number}} record */
  add(handle, record) {
    this.#byHandle.set(handle, record)
    return record
  }

  /** The delegation this seat owes an answer for, removed. Null if it owes none. */
  take(handle) {
    const record = this.#byHandle.get(handle) ?? null
    if (record) this.#byHandle.delete(handle)
    return record
  }

  get size() {
    return this.#byHandle.size
  }
}

const section = (heading, lines) =>
  lines?.length ? `\n${heading}:\n${lines.map(l => `- ${l}`).join('\n')}` : ''

/**
 * The text the worker seat actually receives.
 *
 * Sections that were not supplied are omitted rather than printed empty, so
 * a reasoning task's brief does not carry a bare "Interface:" heading with
 * nothing under it.
 */
export function renderDelegation({ task, class: cls, spec = {} }) {
  const parts = [`Delegated task (${cls}): ${String(task).trim()}`]
  parts.push(section('Files you may change', spec.files))
  if (spec.interface && String(spec.interface).trim()) {
    parts.push(`\nInterface to conform to:\n${spec.interface}`)
  }
  parts.push(section('Verify with', spec.tests))
  parts.push(section('Do not touch', spec.do_not_touch))
  parts.push('\nWhen you are done, report what you changed with room_reply.')
  return parts.filter(Boolean).join('\n')
}

/**
 * The server-side half of the `delegate` tool: validate, enqueue, drain, and
 * later match the seat's answer back to the call that caused it.
 *
 * It lives here rather than inline in src/server.mjs because src/server.mjs is
 * an entrypoint — importing it boots a room — so anything defined inside it is
 * unreachable from a test. The wiring it needs (`queue`, `store`, `bus`,
 * `channel`, `drain`) is injected for the same reason.
 */
export function createDelegator({
  queue, store, bus, channel, drain, orchestrator,
  pending = new PendingDelegations(),
  now = Date.now,
}) {
  return {
    pending,

    /** @returns {{ok:true, id:string}|{ok:false, errors:string[]}} */
    delegate(input = {}) {
      const check = validateDelegation(input)
      if (!check.ok) return { ok: false, errors: check.errors }

      const handle = String(input.to).replace(/^@/, '').toLowerCase()
      const text = `@${handle} ${renderDelegation(input)}`
      const r = queue.submit(orchestrator, text, { delegation: true, kind: 'delegation' })
      if (!r.ok) return { ok: false, errors: [`could not delegate to @${handle}: ${r.reason}`] }

      // An unknown handle is not a mention at all, so the classifier files it
      // as chatter: submit returns ok with addressed:false and nothing is ever
      // enqueued. A typo'd handle is the likeliest operator error here, and
      // reporting it as a success told the orchestrator its work had been
      // delegated while the work simply vanished.
      if (!r.message?.addressed) {
        return { ok: false, errors: [`no seat with handle @${handle} in this room`] }
      }

      store.appendMessage(r.message)
      bus.publish('message', r.message)

      // The delegation record: what makes the seat's eventual answer
      // attributable, and what carries `class` out to the room's event stream.
      const record = { id: r.message.id, task: String(input.task), class: input.class, at: now() }
      pending.add(handle, record)
      bus.publish('delegation', { ...record, to: handle, state: 'sent' })

      // Every other successful addressed submit drains. Without this the turn
      // sat in the queue until some unrelated message happened to trigger one.
      drain()
      return { ok: true, id: record.id }
    },

    /**
     * A seat answered. If it owed a delegation, that answer is the result;
     * otherwise it is an ordinary reply and nothing here happens.
     */
    onSeatReply(handle, text) {
      const record = pending.take(handle)
      if (!record) return null
      const nt = channel.notifyDelegationResult({ ...record, handle, text })
      bus.publish('delegation', { ...record, to: handle, state: 'done' })
      return nt
    },
  }
}
