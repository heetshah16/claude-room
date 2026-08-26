import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync,
  renameSync, openSync, fstatSync, readSync, closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { Registry, Bans } from './identity.mjs'
import { Ledger } from './ledger.mjs'
import { Decisions } from './decisions.mjs'
import { TurnLog } from './turns.mjs'

/**
 * The hooks the room needs, and how long each may take.
 *
 * Stop gets longer because it reads a transcript off disk. Shared by the local
 * session's generated settings file and by the seat launcher, so a seat can
 * never end up with a different set than the room expects — a seat with no
 * Stop hook never closes its turn, and its destination stays busy forever.
 */
export const HOOK_EVENTS = {
  SessionStart: 5,
  PreToolUse: 5,
  PostToolUse: 5,
  Notification: 5,
  Stop: 10,
}

/**
 * Durable room state. Everything here is recoverable: the room server dies with
 * the Claude Code session, so a restart must not lose the transcript, the member
 * list, or anybody's running cost.
 */
export class Store {
  constructor(dir) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    this.paths = {
      members: join(dir, 'members.json'),
      transcript: join(dir, 'transcript.jsonl'),
      ledger: join(dir, 'ledger.json'),
      decisions: join(dir, 'decisions.json'),
      turns: join(dir, 'turns.json'),
      bans: join(dir, 'bans.json'),
      runtime: join(dir, 'runtime.json'),
      payer: join(dir, 'current-payer'),
    }
  }

  /**
   * A file that exists but does not parse is corruption, not absence.
   *
   * Treating them the same is how a torn write became silent catastrophe: a
   * half-written members.json parsed as "no members", server.mjs saw an empty
   * registry, bootstrapped a fresh owner, and every existing member's token
   * stopped working with nothing said. Absence is normal on first run;
   * corruption must stop the room so the operator can restore the file rather
   * than have it quietly replaced.
   */
  #readJSON(p, fallback) {
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      return fallback // genuinely absent — first run
    }
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error(
        `${p} exists but is not valid JSON (${err.message}). Refusing to start: ` +
        'continuing would treat it as empty and silently discard whatever it held. ' +
        `Restore it from ${p}.bak or delete it deliberately to start fresh.`,
      )
    }
  }

  /**
   * Write-then-rename, with one generation of backup.
   *
   * writeFileSync truncates before it writes, so a crash mid-write leaves a
   * valid-looking file with half the content. rename is atomic on both POSIX
   * and Windows (same volume), so a reader sees either the whole old file or
   * the whole new one and never a torn one.
   */
  #writeAtomic(p, text) {
    const tmp = `${p}.tmp`
    writeFileSync(tmp, text)
    // Keep the previous good copy: atomicity stops torn writes, it does not
    // stop a bug writing well-formed nonsense over something irreplaceable.
    try {
      if (existsSync(p)) renameSync(p, `${p}.bak`)
    } catch {
      // A missing backup is not worth failing the write for.
    }
    renameSync(tmp, p)
  }

  load() {
    return {
      registry: Registry.fromJSON(this.#readJSON(this.paths.members, [])),
      ledger: Ledger.fromJSON(this.#readJSON(this.paths.ledger, {})),
      decisions: Decisions.fromJSON(this.#readJSON(this.paths.decisions, [])),
      turns: TurnLog.fromJSON(this.#readJSON(this.paths.turns, [])),
      bans: Bans.fromJSON(this.#readJSON(this.paths.bans, [])),
      // Admin changes that must outlive a restart: the agent's handle and
      // whether the room is paused.
      runtime: this.#readJSON(this.paths.runtime, null),
    }
  }

  appendMessage(m) {
    appendFileSync(this.paths.transcript, JSON.stringify(m) + '\n')
  }

  /**
   * The last `n` messages, read from the tail rather than the whole file.
   *
   * This runs on every /api/state and every /seat/join. Reading and parsing
   * the entire transcript to return its last 200 lines made every page load
   * cost O(everything ever said), on an append-only file that never rotates —
   * a room degraded continuously for as long as it stayed up.
   *
   * Reads a fixed window off the end instead, growing it only if that window
   * did not contain enough lines. The first line in a window is almost always
   * partial, so it is dropped unless the window covers the whole file.
   */
  recent(n = 200) {
    let fd
    try {
      fd = openSync(this.paths.transcript, 'r')
    } catch {
      return []
    }
    try {
      const size = fstatSync(fd).size
      if (!size) return []

      // ~2KB/message is generous; grow and retry rather than guess high.
      let window = Math.min(size, Math.max(64 * 1024, n * 2048))
      for (;;) {
        const start = size - window
        const buf = Buffer.alloc(window)
        readSync(fd, buf, 0, window, start)
        let lines = buf.toString('utf8').split('\n')
        // Unless we read from byte 0, the first line is a fragment.
        if (start > 0) lines = lines.slice(1)

        const out = []
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch {
            // A torn line from a killed process must not stop the rest.
          }
        }
        // Enough, or we already hold the whole file and cannot do better.
        if (out.length >= n || window >= size) return out.slice(-n)
        window = Math.min(size, window * 4)
      }
    } finally {
      closeSync(fd)
    }
  }

  saveRegistry(r) {
    this.#writeAtomic(this.paths.members, JSON.stringify(r.toJSON(), null, 2))
  }

  saveLedger(l) {
    this.#writeAtomic(this.paths.ledger, JSON.stringify(l.toJSON()))
  }

  saveDecisions(d) {
    this.#writeAtomic(this.paths.decisions, JSON.stringify(d.toJSON(), null, 2))
  }

  /**
   * Turns keep changing after they open, so unlike the transcript this is a
   * rewritten document rather than an append log. Capped: a long-lived room
   * would otherwise carry every tool call it ever made.
   */
  saveTurns(t) {
    this.#writeAtomic(this.paths.turns, JSON.stringify(t.recent(200)))
  }

  saveBans(b) {
    this.#writeAtomic(this.paths.bans, JSON.stringify(b.toJSON(), null, 2))
  }

  /**
   * Merged, not replaced. Callers each know about one or two runtime fields
   * and pass only those — admin's handle command sends {handles, paused}, and
   * nothing there knows the hook token exists. A whole-file write would drop
   * every field the caller had not heard of, which for the hook token means
   * silently invalidating the hooks on the next restart.
   */
  saveRuntime(r) {
    const current = this.#readJSON(this.paths.runtime, {}) ?? {}
    this.#writeAtomic(this.paths.runtime, JSON.stringify({ ...current, ...r }, null, 2))
  }

  /**
   * Writes the hooks settings file for the LOCAL session, with the room's own
   * hook token baked into each URL, and returns its path.
   *
   * Generated rather than shipped because it has to carry a secret. The
   * checked-in settings.room.json quoted a bare URL, which is why POST /hook/*
   * accepted anything: there was nowhere for a token to live. Regenerated on
   * every boot so a rotated token or a changed port cannot leave a stale file
   * pointing somewhere that no longer authenticates.
   */
  writeHookSettings({ port, token, events = HOOK_EVENTS }) {
    const url = e => `http://127.0.0.1:${port}/hook/${e}?token=${encodeURIComponent(token)}`
    const hooks = {}
    for (const [event, timeout] of Object.entries(events)) {
      hooks[event] = [{ hooks: [{ type: 'http', url: url(event), timeout }] }]
    }
    const p = join(this.dir, 'settings.hooks.json')
    this.#writeAtomic(p, JSON.stringify({ hooks }, null, 2))
    return p
  }

  writePayer(ref) {
    writeFileSync(this.paths.payer, ref ?? '')
  }

  readPayer() {
    try {
      return readFileSync(this.paths.payer, 'utf8').trim() || null
    } catch {
      return null
    }
  }
}
