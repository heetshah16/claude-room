import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildNotification } from './channel.mjs'
import { readFrames } from './seat.mjs'

// The reply-only bridge registered with opencode is always src/seat.mjs
// itself, so connect() defaults to its own sibling file rather than
// requiring every caller (including every test) to name it explicitly. A
// caller that already knows its own on-disk layout (scripts/room-opencode-seat.mjs)
// may still pass an explicit bridgePath, which simply overrides this.
const DEFAULT_BRIDGE_PATH = fileURLToPath(new URL('./seat.mjs', import.meta.url))

/**
 * `provider/model`, split on the FIRST slash — a model id may itself contain
 * slashes (`openrouter/meta/llama-3`), so splitting on all of them loses the
 * back half.
 */
export function parseModel(spec) {
  const s = String(spec)
  const i = s.indexOf('/')
  if (i <= 0 || i === s.length - 1) {
    throw new Error(`model must be provider/model, got: ${s}`)
  }
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

/**
 * The text of a room turn, rendered exactly as `channel.mjs` renders it for a
 * Claude seat. Reused rather than reimplemented so the two harnesses cannot
 * end up seeing differently-shaped versions of the same room.
 */
export function promptFromTurn(messages, roomName) {
  const nt = buildNotification(messages ?? [], roomName)
  return nt ? nt.params.content : null
}

const LABEL = { mirror: 'mirror', brief: 'brief', seed: 'seed' }

/**
 * Room events that are NOT a request — mirrors, briefs, the join seed.
 *
 * OpenCode has no inbox, so these cannot be delivered on their own: sending
 * one would start a turn nobody asked for. They wait here and ride along with
 * the next real turn.
 *
 * Bounded, because they arrive whether or not this seat is ever addressed.
 * Drops are counted and reported rather than hidden, mirroring how `pending`
 * already tells a Claude seat how stale its brief is.
 */
export class PendingContext {
  #max
  #items = []
  #dropped = 0

  constructor(max = 20) {
    this.#max = Math.max(1, Number(max) || 20)
  }

  add(kind, text, from) {
    if (!text || !String(text).trim()) return
    const label = LABEL[kind] ?? 'context'
    this.#items.push(from ? `[${label} from @${from}] ${text}` : `[${label}] ${text}`)
    while (this.#items.length > this.#max) {
      this.#items.shift()
      this.#dropped++
    }
  }

  drain() {
    if (!this.#items.length && !this.#dropped) return { text: '', dropped: 0 }
    const dropped = this.#dropped
    const lines = [...this.#items]
    if (dropped) lines.unshift(`(${dropped} earlier room events dropped)`)
    this.#items = []
    this.#dropped = 0
    return {
      dropped,
      text: [
        '--- room context: background only, never a request ---',
        ...lines,
        '--- end room context ---',
      ].join('\n'),
    }
  }
}

/**
 * One opencode bus event -> what the driver should do about it.
 *
 * Pure, so every branch is testable without a socket. Events for another
 * session are ignored outright: one opencode server hosts many sessions, and
 * acting on someone else's sessionID would end the wrong turn.
 */
export function actionForOpencodeEvent(ev, sessionId) {
  const type = ev?.type
  const p = ev?.properties ?? {}
  if (!type) return { type: 'ignore' }
  if (p.sessionID && p.sessionID !== sessionId) return { type: 'ignore' }

  if (type === 'session.idle') return { type: 'end-turn' }
  if (type === 'session.error') return { type: 'error', error: p.error ?? null }
  if (type === 'session.status') {
    const st = p.status?.type
    // Retry is alive-but-not-progressing. Naming it separately is what stops
    // the deadline from being reset by a model that is failing in a loop.
    if (st === 'retry') return { type: 'retry', attempt: p.status?.attempt ?? 0 }
    return { type: 'busy' }
  }
  return { type: 'ignore' }
}

export const DEFAULT_MODEL = 'opencode/mimo-v2.5-free'
export const DEFAULT_TURN_TIMEOUT_MS = 300_000

/**
 * One OpenCode session, driven as a room seat.
 *
 * The room pushes work to a Claude seat through a channel notification. That
 * path does not exist here: OpenCode discards notifications it does not know,
 * so delivery is an outbound HTTP call this driver makes. Everything else —
 * the reply path, the queue, cost — is the room's existing seat protocol,
 * unchanged.
 */
export function createOpenCodeSeat({
  roomUrl,
  token,
  handle,
  opencodeUrl,
  model = DEFAULT_MODEL,
  roomName = 'room',
  maxPendingContext = 20,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  const modelRef = parseModel(model)
  const pending = new PendingContext(maxPendingContext)
  let sessionId = null
  let turn = null // { promptId } while one is in flight

  const post = (url, body) => fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

  async function ensureSession() {
    if (sessionId) return sessionId
    const res = await fetchImpl(`${opencodeUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `room seat ${handle}` }),
    })
    if (!res.ok) throw new Error(`could not create an opencode session: ${res.status}`)
    const body = await res.json()
    sessionId = body?.id ?? null
    if (!sessionId) throw new Error('opencode created a session with no id')
    return sessionId
  }

  /** The room's only way to hear from this seat. */
  function say(text) {
    return post(`${roomUrl}/seat/reply`, { token, text })
  }

  /**
   * Closes the room turn. Without this the destination stays busy and every
   * later message for this seat queues behind a turn that already finished —
   * the same failure the missing Stop hook caused for Claude seats.
   */
  async function endTurn(promptId) {
    await post(`${roomUrl}/seat/hook/Stop?token=${encodeURIComponent(token)}`,
      { token, prompt_id: promptId })
  }

  async function finish(promptId) {
    // Ownership guard: a concurrent path may already have finished this turn and
    // armed the next one. Without this, a late finish for turn A clears turn B's
    // timer and ends B while its prompt is still running.
    if (turn?.promptId !== promptId) return
    clearTimer(turn.timer)
    turn = null
    await endTurn(promptId)
  }

  async function onRoomEvent(ev) {
    const kind = ev?.event
    const data = ev?.data ?? {}

    // Not requests: they wait for the next real turn.
    if (kind === 'mirror') return void pending.add('mirror', data.text, data.from)
    if (kind === 'brief') return void pending.add('brief', data.text)
    if (kind === 'seed') return void pending.add('seed', data.text)
    if (kind !== 'turn') return

    const body = promptFromTurn(data.messages ?? [], data.room ?? roomName)
    if (!body) return

    const promptId = `oc-${randomUUID()}`
    try {
      const id = await ensureSession()
      const { text: context } = pending.drain()

      turn = { promptId, timer: null }
      turn.timer = setTimer(() => { void onDeadline(promptId) }, turnTimeoutMs)
      // Injected fakes in tests won't have unref; the real setTimeout does.
      // Without it, a real un-fired deadline timer keeps the process alive
      // long after the test that scheduled it has finished asserting.
      turn.timer?.unref?.()

      await post(`${opencodeUrl}/session/${id}/prompt_async`, {
        model: modelRef,
        parts: [{ type: 'text', text: context ? `${context}\n\n${body}` : body }],
      })
    } catch (err) {
      // The room marked this destination busy the moment it dispatched the
      // turn. If delivery fails we must still close it, or every later message
      // for this seat queues behind a turn that never started.
      if (turn?.promptId === promptId) {
        clearTimer(turn.timer)
        turn = null
      }
      await say(`could not start the turn: ${err?.message ?? err}`)
      await endTurn(promptId)
    }
  }

  async function onDeadline(promptId) {
    // Guard against a deadline that fires for a turn already finished.
    if (!turn || turn.promptId !== promptId) return
    log(`turn ${promptId} exceeded ${turnTimeoutMs}ms — aborting`)
    try {
      if (sessionId) await post(`${opencodeUrl}/session/${sessionId}/abort`, {})
    } catch {
      // The abort is best-effort. Draining the room queue is not.
    }
    await say(`no response after ${Math.round(turnTimeoutMs / 1000)}s — the turn was abandoned.`)
    await finish(promptId)
  }

  async function onOpencodeEvent(ev) {
    const action = actionForOpencodeEvent(ev, sessionId)
    if (action.type === 'ignore' || action.type === 'busy') return
    // Retry means the provider is failing in a loop. It is deliberately NOT
    // progress: resetting the deadline here is exactly how a wedged seat
    // would block its queue destination forever.
    if (action.type === 'retry') {
      log(`provider retry (attempt ${action.attempt})`)
      return
    }
    if (!turn) return
    const { promptId } = turn

    if (action.type === 'error') {
      const name = action.error?.name ?? 'unknown error'
      await say(`the turn failed: ${name}`)
      await finish(promptId)
      return
    }
    if (action.type === 'end-turn') await finish(promptId)
  }

  let stopped = false
  let roomCtrl = null
  let ocCtrl = null
  let backoffMs = 500
  let retryTimer = null

  /** Registers the reply-only bridge so opencode can call room_reply. */
  async function registerBridge(bridgePath) {
    await post(`${opencodeUrl}/mcp`, {
      name: 'room',
      config: {
        type: 'local',
        command: ['node', bridgePath],
        environment: {
          ROOM_URL: roomUrl,
          ROOM_SEAT_TOKEN: token,
          ROOM_SEAT_HANDLE: handle,
          // Reply-only: the driver owns the room feed. A second join would be
          // refused as handle-taken and this seat would go deaf.
          ROOM_SEAT_MODE: 'reply-only',
        },
        enabled: true,
      },
    })
  }

  function feed(url, onEvent, label) {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal })
        if (!res.ok || !res.body) throw new Error(`${label} feed failed: ${res.status}`)
        backoffMs = 500
        await readFrames(res.body, (event, raw) => {
          let data
          try { data = JSON.parse(raw) } catch { return }
          void onEvent(event, data)
        })
      } catch {
        // A dropped feed is normal: sleep/wake, a restart, a wifi blip.
      }
      if (!stopped) {
        // Deliberately NOT unref'd (unlike the deadline timer above): the
        // deadline's unref is only safe because a pending turn always holds
        // some other referenced handle - the room feed, the opencode feed, or
        // the stdio transport. During a reconnect backoff BOTH feeds can be
        // down at once, so this timer must be the thing that keeps the
        // process alive, or it could exit mid-turn with the deadline still
        // armed. src/seat.mjs's own reconnectTimer follows the same rule.
        retryTimer = setTimer(() => feed(url, onEvent, label), backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    })()
    return ctrl
  }

  return {
    onRoomEvent,
    onOpencodeEvent,
    sessionId: () => sessionId,
    busy: () => turn !== null,
    async connect({ bridgePath = DEFAULT_BRIDGE_PATH } = {}) {
      if (bridgePath) await registerBridge(bridgePath)

      const res = await fetchImpl(`${roomUrl}/seat/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, handle }),
      })
      if (res.ok) {
        const body = await res.json()
        if (body?.seed?.text) pending.add('seed', body.seed.text)
      }

      roomCtrl = feed(
        `${roomUrl}/seat/events?token=${encodeURIComponent(token)}`,
        (event, data) => onRoomEvent({ event, data }),
        'room',
      )
      // opencode's bus frames carry the event type inside `data`, not on an
      // `event:` line, so the frame's event name is ignored here.
      ocCtrl = feed(`${opencodeUrl}/event`, (_event, data) => onOpencodeEvent(data), 'opencode')
    },
    stop() {
      stopped = true
      if (retryTimer) clearTimer(retryTimer)
      clearTimer(turn?.timer)
      roomCtrl?.abort()
      ocCtrl?.abort()
    },
  }
}

/**
 * The spawn recipe for this seat's own `opencode serve`.
 *
 * Bound to loopback deliberately: the server runs with no password unless
 * OPENCODE_SERVER_PASSWORD is set, so exposing it on the tailnet the room
 * itself listens on would hand out an unauthenticated shell.
 */
export function opencodeSeatArgs({ port, cwd }) {
  return {
    cmd: 'opencode',
    args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    env: { ...process.env },
    cwd,
  }
}
