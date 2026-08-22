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
import { createAdmin } from './admin.mjs'

const log = s => process.stderr.write(`room: ${s}\n`)

// Reserved ledger identity so the observer's spend sits beside the humans it
// serves rather than hiding inside the host's total.
const OBSERVER_ID = 'observer'

const config = loadConfig(process.env)
const store = new Store(config.stateDir)
const { registry, ledger, decisions, turns, bans, runtime: savedRuntime } = store.load()

// Admin changes to the agent handle or the pause flag outlive a restart.
if (savedRuntime?.handles?.length) config.handles = savedRuntime.handles
if (typeof savedRuntime?.paused === 'boolean') config.paused = savedRuntime.paused

// Bootstrap an owner on first run, otherwise the room is unreachable.
if (!registry.all().length) {
  const owner = registry.add(createMember({ name: process.env.ROOM_OWNER || 'owner', role: 'owner' }))
  store.saveRegistry(registry)
  log(`created owner "${owner.name}"`)
  log(`join: http://${config.advertise}:${config.port}/?token=${owner.token}`)
}

const bus = new Bus()
const permissions = new PermissionBroker()
const queue = new Queue({ config, ledger, decisions })

const addrs = new Map()
const runtime = {
  joinUrl: token => `http://${config.advertise}:${config.port}/?token=${token}`,
  noteAddr: (id, addr) => addrs.set(id, addr),
  lastAddrOf: id => addrs.get(id) ?? null,
}

const admin = createAdmin({ registry, bans, store, bus, config, queue, runtime })

// Rotation needs Console API keys. Verified 2026-08-22: a subscription OAuth
// access token supplied through apiKeyHelper does not authenticate, and the
// session hangs retrying rather than failing, which would stall the room.
if (config.payerMode === 'rotate') {
  const hostCred = process.env.ROOM_HOST_CREDENTIAL ?? process.env.ANTHROPIC_API_KEY ?? ''
  if (!/^sk-ant-api/.test(hostCred)) {
    log('WARNING: payerMode=rotate but no Console API key is configured as the host credential.')
    log('         Rotation does not work with claude.ai subscription auth. Falling back to host mode.')
    config.payerMode = 'host'
  }
}

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

const web = createWeb({
  config, registry, ledger, decisions, queue, store, bus, channel,
  permissions, turns, observer, bans, admin, runtime,
})

web.listen(config.port, config.host, () => {
  // Report the port actually bound, not the one requested — with ROOM_PORT=0
  // the OS chooses, and callers need to know which.
  config.port = web.address().port
  log(`listening on http://${config.host}:${config.port} (${registry.all().length} member(s))`)
  if (config.host === '127.0.0.1') log('bound to loopback — set ROOM_HOST to your Tailscale address to let teammates in')
})

web.on('error', err => log(`http error: ${err.message}`))

await channel.connect()
log('channel connected')
