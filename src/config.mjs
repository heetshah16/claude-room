import { homedir } from 'node:os'
import { join } from 'node:path'

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
    stateDir: env.ROOM_STATE_DIR || join(homedir(), '.claude', 'channels', 'room'),
    payerMode: oneOf(env.ROOM_PAYER_MODE, ['host', 'rotate'], 'host'),
    permissionRelay: bool(env.ROOM_PERMISSION_RELAY),
    splitMode: oneOf(env.ROOM_SPLIT_MODE, ['equal', 'weighted'], 'equal'),
    budgets: {
      windowMs: int(env.ROOM_BUDGET_WINDOW_MS, 5 * 60 * 60 * 1000),
      tokensPerMember: int(env.ROOM_TOKENS_PER_MEMBER, 0),
      messagesPerWindow: int(env.ROOM_MESSAGES_PER_WINDOW, 200),
    },
  }
}
