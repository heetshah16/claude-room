#!/usr/bin/env node
/**
 * claude-room entrypoint.
 *
 * Claude Code spawns this as an MCP stdio child, so stdout belongs to the
 * protocol — every log line here goes to stderr. Being a child also means
 * "this process is alive" is the same fact as "the session is alive", which is
 * why the room needs no liveness protocol of its own.
 */
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config.mjs'
import { Store } from './state.mjs'
import { Queue } from './queue.mjs'
import { Bus } from './bus.mjs'
import { createChannel } from './channel.mjs'
import { createWeb } from './web.mjs'
import { PermissionBroker } from './permissions.mjs'
import { createMember } from './identity.mjs'
import { Observer } from './observer.mjs'
import { makeRunner } from './run-model.mjs'

const log = s => process.stderr.write(`room: ${s}\n`)

// Reserved ledger identity so the observer's spend sits beside the humans it
// serves rather than hiding inside the host's total.
const OBSERVER_ID = 'observer'

const config = loadConfig(process.env)
const store = new Store(config.stateDir)
const { registry, ledger, decisions, turns } = store.load()

// Bootstrap an owner on first run, otherwise the room is unreachable.
if (!registry.all().length) {
  const owner = registry.add(createMember({ name: process.env.ROOM_OWNER || 'owner', role: 'owner' }))
  store.saveRegistry(registry)
  log(`created owner "${owner.name}"`)
  log(`join: http://${config.host}:${config.port}/?token=${owner.token}`)
}

const bus = new Bus()
const permissions = new PermissionBroker()
const queue = new Queue({ config, ledger, decisions })

const channel = createChannel({
  config,
  onReply(text, to) {
    const turn = turns.reply(text, to)
    const m = {
      id: randomUUID(), memberId: 'claude', name: 'claude', text,
      ts: Date.now(), addressed: false, kind: 'reply', to,
      turnId: turn?.id ?? null,
    }
    store.appendMessage(m)
    bus.publish('message', m)
  },
  onDecision(text, by, supersedes) {
    const d = decisions.add({ text, by, supersedes })
    store.saveDecisions(decisions)
    bus.publish('decision', d)
    return d
  },
})

if (config.permissionRelay) {
  channel.onPermissionRequest(params => {
    permissions.open(params)
    bus.publish('approval-request', params)
  })
  log('permission relay is ON — approvers in the room can allow tool calls')
}

// Sweep prompts nobody answered, so the approvals panel cannot grow forever.
const sweeper = setInterval(() => {
  for (const gone of permissions.expire(5 * 60 * 1000)) {
    bus.publish('approval', { request_id: gone.request_id, behavior: 'expired', by: 'timeout' })
  }
}, 30_000)
sweeper.unref()

let observer = null
if (config.observer.on) {
  observer = new Observer({
    config,
    runModel: makeRunner(config),
    getDecisions: () => decisions.open(),
    onBrief() {
      // Publish the same shape /api/state returns, so the browser has one format.
      bus.publish('brief', { ...observer.briefForInjection(), on: true, paused: observer.paused() })
    },
    onNote(text) {
      const m = {
        id: randomUUID(), memberId: OBSERVER_ID, name: 'observer', text,
        ts: Date.now(), addressed: false, kind: 'system',
      }
      store.appendMessage(m)
      bus.publish('message', m)
    },
    onSpend(tokens) {
      ledger.record(
        `obs-${randomUUID()}`,
        { input: tokens.input, output: tokens.output, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 },
        [{ memberId: OBSERVER_ID, weight: 1 }],
        'equal',
      )
      store.saveLedger(ledger)
      bus.publish('cost', { observer: ledger.totalsFor(OBSERVER_ID) })
    },
  })
  log(`observer on (${config.observer.model}), notes ${config.observer.notes ? 'on' : 'off'}`)
}

const web = createWeb({ config, registry, ledger, decisions, queue, store, bus, channel, permissions, turns, observer })

web.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} (${registry.all().length} member(s))`)
  if (config.host === '127.0.0.1') log('bound to loopback — set ROOM_HOST to your Tailscale address to let teammates in')
})

web.on('error', err => log(`http error: ${err.message}`))

await channel.connect()
log('channel connected')
