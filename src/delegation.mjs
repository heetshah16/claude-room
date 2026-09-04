/**
 * Delegation brief validation and rendering.
 *
 * Delegated work fails because the brief was thin far more often than because
 * the model was weak. So a brief is validated here, not trusted, and a
 * rejection is returned to the orchestrator while it still has the context to
 * fix it — the errors name the missing field, not just "rejected".
 *
 * `validateDelegation` and `renderDelegation` are pure: no I/O, no timers, no
 * process.env, nothing but the object they are given. `PendingDelegations` and
 * `createDelegator` are not — they hold the in-flight delegation records and
 * read a clock — but they still touch no I/O of their own: the queue, store,
 * bus, channel and clock all arrive as injected dependencies, which is what
 * keeps this module importable from a test without booting a room.
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
 * Delegations handed out and not yet answered, keyed by the id of the message
 * that carries each one.
 *
 * An earlier version keyed this by target handle, on the belief that the room
 * runs one turn per destination so only one delegation per handle can ever be
 * in flight. That belief was wrong, and wrong in the direction that loses
 * work: `Queue.submit` gates a seat on being ONLINE, never on being BUSY, so a
 * second `delegate` to a busy seat is accepted and queued behind the first.
 * Keyed by handle, the second record simply overwrote the first, both calls
 * returned success, and the first delegation's answer never came back —
 * exactly the silent-success-then-vanish failure that the unknown-handle fix
 * exists to prevent, arriving through a different door.
 *
 * The message id is the delegation's identity, and it is already carried by
 * the enqueued message (tagged `kind: 'delegation'`), so the seat's reply can
 * be matched to the right record by reading the turn the seat is actually
 * running. Nothing in the seat protocol carries a correlation id, and nothing
 * has to.
 *
 * `take` is deliberately destructive: a delegation is answered exactly once.
 */
export class PendingDelegations {
  #byId = new Map()

  /** @param {{id:string, task:string, class:string, at:number}} record */
  add(record) {
    this.#byId.set(record.id, record)
    return record
  }

  /** The record for this delegation id, removed. Null if there is none. */
  take(id) {
    const record = this.#byId.get(id) ?? null
    if (record) this.#byId.delete(id)
    return record
  }

  get size() {
    return this.#byId.size
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
      pending.add(record)
      bus.publish('delegation', { ...record, to: handle, state: 'sent' })

      // Every other successful addressed submit drains. Without this the turn
      // sat in the queue until some unrelated message happened to trigger one.
      drain()
      return { ok: true, id: record.id }
    },

    /**
     * A seat answered. Which delegation — if any — that answers is decided by
     * the turn the seat is actually running, never by "the last thing we sent
     * this handle": position is not identity. A human can address a seat
     * directly (a supported flow) with a delegation queued behind that turn,
     * and matching on handle alone shipped the human's answer back to the
     * orchestrator as the delegation's result while the real delegation, run
     * later, found nothing left to return.
     *
     * Every delegation delivered in this turn is answered by this reply.
     * Usually that is exactly one. It is two when both were queued behind
     * something else and drained into a single batch — and answering only the
     * first would orphan the second in precisely the way keying by handle did.
     *
     * @returns {object[]} one notification per delegation answered; empty when
     *   this reply answers no delegation at all.
     */
    onSeatReply(handle, text) {
      const turn = queue?.inflightFor?.(handle)
      const results = []
      for (const m of turn?.messages ?? []) {
        if (m.kind !== 'delegation') continue
        const record = pending.take(m.id)
        if (!record) continue
        results.push(channel.notifyDelegationResult({ ...record, handle, text }))
        // `text` travels here too, not just to the local channel above: this
        // is the only event the extension's SSE feed ever sees for a
        // finished delegation, and without the seat's actual words on it the
        // relay to the orchestrator reads literally as "undefined".
        bus.publish('delegation', { ...record, to: handle, state: 'done', text })
      }
      return results
    },

    /**
     * A destination's turn ended without ever being answered — a seat's feed
     * dropping mid-turn, or an eviction, which retires the seat through that
     * same path.
     *
     * Whatever that turn was carrying is never coming back, so its records go
     * now. Left behind, a stale record is not a leak (it is bounded by the
     * delegations actually made) but it is worse than one: the next reply from
     * that seat, for entirely unrelated work, would be delivered to the
     * orchestrator as the dead delegation's result.
     */
    onTurnAbandoned(dest, turn, reason = 'abandoned') {
      for (const m of turn?.messages ?? []) {
        if (m.kind !== 'delegation') continue
        const record = pending.take(m.id)
        if (record) bus.publish('delegation', { ...record, to: dest, state: 'abandoned', reason })
      }
    },
  }
}
