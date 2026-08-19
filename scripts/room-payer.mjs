#!/usr/bin/env node
/**
 * apiKeyHelper target. Prints the credential for the member paying for the
 * current turn.
 *
 * The queue writes `current-payer` between turns and never during one, so a
 * single turn is never split across two accounts. The value it writes is a URL
 * on the paying teammate's OWN machine, reached over the tailnet — their
 * credential is fetched per turn and never stored at rest on the host. That is
 * the difference between per-person billing and holding everyone's tokens.
 *
 * Falls back to the host credential whenever anything is missing or unreachable,
 * because failing closed here would stall the session rather than the payment.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.ROOM_STATE_DIR || join(homedir(), '.claude', 'channels', 'room')
const fallback = process.env.ROOM_HOST_CREDENTIAL || ''

const read = p => {
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return ''
  }
}

const payerRef = read(join(dir, 'current-payer'))

if (!payerRef || !/^https?:\/\//.test(payerRef)) {
  process.stdout.write(fallback)
} else {
  try {
    const res = await fetch(payerRef, {
      headers: { 'x-room-auth': process.env.ROOM_PAYER_SECRET ?? '' },
      signal: AbortSignal.timeout(3000),
    })
    process.stdout.write(res.ok ? (await res.text()).trim() : fallback)
  } catch {
    process.stdout.write(fallback)
  }
}
