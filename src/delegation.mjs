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
