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
 * Falls back to the host credential whenever anything is missing, unreachable,
 * or not shaped like an API key.
 *
 * That last check matters more than it looks. Measured 2026-08-22: when this
 * helper returns a credential Claude Code cannot authenticate with, the session
 * does not error — it retries until it times out. A bad payer token therefore
 * stalls the whole room rather than costing one turn. So anything that is not
 * recognisably an API key is discarded here rather than handed over.
 *
 * Subscription OAuth access tokens are specifically NOT usable: the helper's
 * value is sent as X-Api-Key/Bearer without the OAuth beta header, and such a
 * token hangs the session. Rotation requires Console API keys.
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

/**
 * Console API keys start `sk-ant-api`. Subscription OAuth tokens start
 * `sk-ant-oat` and do NOT work here — see the note above.
 */
const usable = v => /^sk-ant-api[\w-]{10,}$/.test(String(v ?? '').trim())

const emit = v => process.stdout.write(usable(v) ? String(v).trim() : fallback)

const payerRef = read(join(dir, 'current-payer'))

if (!payerRef || !/^https?:\/\//.test(payerRef)) {
  process.stdout.write(fallback)
} else {
  try {
    const res = await fetch(payerRef, {
      headers: { 'x-room-auth': process.env.ROOM_PAYER_SECRET ?? '' },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      process.stderr.write(`room-payer: ${payerRef} returned ${res.status}, using host credential\n`)
      process.stdout.write(fallback)
    } else {
      const body = (await res.text()).trim()
      if (!usable(body)) {
        process.stderr.write('room-payer: payer returned an unusable credential, using host credential\n')
      }
      emit(body)
    }
  } catch {
    process.stderr.write(`room-payer: cannot reach ${payerRef}, using host credential\n`)
    process.stdout.write(fallback)
  }
}
