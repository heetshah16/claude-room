import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Registry } from './identity.mjs'
import { Ledger } from './ledger.mjs'
import { Decisions } from './decisions.mjs'
import { TurnLog } from './turns.mjs'

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
      payer: join(dir, 'current-payer'),
    }
  }

  #readJSON(p, fallback) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return fallback
    }
  }

  load() {
    return {
      registry: Registry.fromJSON(this.#readJSON(this.paths.members, [])),
      ledger: Ledger.fromJSON(this.#readJSON(this.paths.ledger, {})),
      decisions: Decisions.fromJSON(this.#readJSON(this.paths.decisions, [])),
      turns: TurnLog.fromJSON(this.#readJSON(this.paths.turns, [])),
    }
  }

  appendMessage(m) {
    appendFileSync(this.paths.transcript, JSON.stringify(m) + '\n')
  }

  recent(n = 200) {
    if (!existsSync(this.paths.transcript)) return []
    const out = []
    for (const line of readFileSync(this.paths.transcript, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn line from a killed process must not stop the rest replaying.
      }
    }
    return out.slice(-n)
  }

  saveRegistry(r) {
    writeFileSync(this.paths.members, JSON.stringify(r.toJSON(), null, 2))
  }

  saveLedger(l) {
    writeFileSync(this.paths.ledger, JSON.stringify(l.toJSON()))
  }

  saveDecisions(d) {
    writeFileSync(this.paths.decisions, JSON.stringify(d.toJSON(), null, 2))
  }

  /**
   * Turns keep changing after they open, so unlike the transcript this is a
   * rewritten document rather than an append log. Capped: a long-lived room
   * would otherwise carry every tool call it ever made.
   */
  saveTurns(t) {
    writeFileSync(this.paths.turns, JSON.stringify(t.recent(200)))
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
