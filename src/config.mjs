import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

/**
 * The address to put in a join URL.
 *
 * `0.0.0.0` is a bind address, not somewhere anyone can browse to, so handing
 * it out in an invite link produces a link that works for nobody. Prefer the
 * tailnet address (Tailscale hands out 100.64.0.0/10), then a LAN address,
 * then loopback.
 */
export function advertiseHost(bind, ifaces = networkInterfaces()) {
  if (bind && bind !== '0.0.0.0' && bind !== '::') return bind

  const v4 = Object.values(ifaces)
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address)

  // 100.64.0.0/10 — the CGNAT range Tailscale uses.
  const tailnet = v4.find(a => {
    const [x, y] = a.split('.').map(Number)
    return x === 100 && y >= 64 && y <= 127
  })
  return tailnet ?? v4[0] ?? '127.0.0.1'
}

const int = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
const bool = v => v === '1' || v === 'true'
const oneOf = (v, allowed, d) => (allowed.includes(v) ? v : d)

/**
 * Every knob is an env var so the room can be launched from `.mcp.json` without
 * a config file. Unknown enum values fall back to the safe default rather than
 * throwing — a bad env var must never stop the session from starting.
 *
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  return {
    roomName: env.ROOM_NAME || 'room',
    port: int(env.ROOM_PORT, 8787),
    host: env.ROOM_HOST || '127.0.0.1',
    // What goes in an invite link. Override when the room sits behind a proxy
    // or a Tailscale MagicDNS name you would rather hand out.
    advertise: env.ROOM_ADVERTISE || advertiseHost(env.ROOM_HOST || '127.0.0.1'),
    stateDir: env.ROOM_STATE_DIR || join(homedir(), '.claude', 'channels', 'room'),
    // The agent's @handle(s). Mutable at runtime via the admin API, and
    // persisted, so renaming the agent does not need a restart.
    handles: (env.ROOM_HANDLES || 'claude')
      .split(',')
      .map(h => h.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
    paused: bool(env.ROOM_PAUSED),
    // How often to write a comment frame to every open SSE stream. Comfortably
    // under undici's 300s response-body timeout, which is what actually cut
    // idle seat feeds, and under the 60s idle cut common in reverse proxies.
    // Tunable because anything sitting in front of the room may be stricter.
    keepaliveMs: int(env.ROOM_KEEPALIVE_MS, 25_000),
    payerMode: oneOf(env.ROOM_PAYER_MODE, ['host', 'rotate'], 'host'),
    permissionRelay: bool(env.ROOM_PERMISSION_RELAY),
    splitMode: oneOf(env.ROOM_SPLIT_MODE, ['equal', 'weighted'], 'equal'),
    budgets: {
      windowMs: int(env.ROOM_BUDGET_WINDOW_MS, 5 * 60 * 60 * 1000),
      tokensPerMember: int(env.ROOM_TOKENS_PER_MEMBER, 0),
      messagesPerWindow: int(env.ROOM_MESSAGES_PER_WINDOW, 200),
    },
    observer: {
      on: bool(env.ROOM_OBSERVER),
      model: env.ROOM_OBSERVER_MODEL || 'haiku',
      debounceMs: int(env.ROOM_OBSERVER_DEBOUNCE_MS, 15_000),
      // Each `claude -p` carries ~18k tokens of Claude Code's own scaffolding
      // before our prompt contributes anything, so cost is per-cycle and almost
      // independent of prompt size. The floor is what actually bounds spend.
      minIntervalMs: int(env.ROOM_OBSERVER_MIN_INTERVAL_MS, 60_000),
      maxEvents: int(env.ROOM_OBSERVER_MAX_EVENTS, 8),
      // Notes default on, so an explicit "0" is the only way to silence them.
      notes: env.ROOM_OBSERVER_NOTES == null ? true : bool(env.ROOM_OBSERVER_NOTES),
      notesPerWindow: int(env.ROOM_OBSERVER_NOTES_PER_WINDOW, 6),
      maxTokensPerWindow: int(env.ROOM_OBSERVER_MAX_TOKENS_PER_WINDOW, 200_000),
    },
  }
}
