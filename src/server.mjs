#!/usr/bin/env node
/**
 * claude-room entrypoint.
 *
 * Claude Code spawns this as an MCP stdio child, so stdout belongs to the
 * protocol — every log line here goes to stderr. Being a child also means
 * "this process is alive" is the same fact as "the session is alive", which
 * used to be all the liveness protocol the room needed.
 *
 * With several seats, a session coming and going no longer says anything
 * about whether the room itself should live — seats join and leave the HTTP
 * server independently of any one of them. ROOM_STANDALONE=1 opts into that:
 * the room skips the stdio MCP handshake and stays up on the HTTP server
 * alone. Without it, behaviour is unchanged — a single-session room still
 * connects over stdio exactly as before.
 */
import { randomUUID, randomBytes } from 'node:crypto'
import { loadConfig } from './config.mjs'
import { Store } from './state.mjs'
import { Queue } from './queue.mjs'
import { Seats } from './seats.mjs'
import { Bus } from './bus.mjs'
import { createChannel } from './channel.mjs'
import { createWeb } from './web.mjs'
import { PermissionBroker } from './permissions.mjs'
import { createMember } from './identity.mjs'
import { Observer } from './observer.mjs'
import { makeRunner } from './run-model.mjs'
import { createAdmin } from './admin.mjs'
import { createDelegator } from './delegation.mjs'

const log = s => process.stderr.write(`room: ${s}\n`)
const standalone = process.env.ROOM_STANDALONE === '1'

// Reserved ledger identity so the observer's spend sits beside the humans it
// serves rather than hiding inside the host's total.
const OBSERVER_ID = 'observer'

// Reserved identity for work the orchestrator hands out, so a delegation is
// attributable in the ledger and the feed rather than appearing to come from
// a human who never typed it.
const ORCHESTRATOR = { id: 'orchestrator', name: 'claude', role: 'member', muted: false }


const config = loadConfig(process.env)
const store = new Store(config.stateDir)
const { registry, ledger, decisions, turns, bans, runtime: savedRuntime } = store.load()

// Admin changes to the agent handle or the pause flag outlive a restart.
if (savedRuntime?.handles?.length) config.handles = savedRuntime.handles
if (typeof savedRuntime?.paused === 'boolean') config.paused = savedRuntime.paused

// The room's own hook token. POST /hook/* used to accept anything, because
// Claude Code's hooks are configured statically and had nowhere to carry a
// member token — which left Stop (ends the in-flight turn, records ledger
// usage from a caller-supplied path) and PreToolUse (broadcasts arbitrary
// activity to every browser) open to anyone who could reach the port.
// Persisted so it survives a restart and the settings file stays valid.
config.hookToken = config.hookToken || savedRuntime?.hookToken || randomBytes(24).toString('base64url')
if (config.hookToken !== savedRuntime?.hookToken) store.saveRuntime({ hookToken: config.hookToken })

// Bootstrap an owner on first run, otherwise the room is unreachable.
if (!registry.all().length) {
  const owner = registry.add(createMember({ name: process.env.ROOM_OWNER || 'owner', role: 'owner' }))
  store.saveRegistry(registry)
  log(`created owner "${owner.name}"`)
  log(`join: http://${config.advertise}:${config.port}/?token=${owner.token}`)
}

const bus = new Bus()
const permissions = new PermissionBroker()
const seats = new Seats()
const queue = new Queue({ config, ledger, decisions, registry, seats })

const addrs = new Map()
const runtime = {
  joinUrl: token => `http://${config.advertise}:${config.port}/?token=${token}`,
  noteAddr: (id, addr) => addrs.set(id, addr),
  lastAddrOf: id => addrs.get(id) ?? null,
}

const admin = createAdmin({ registry, bans, store, bus, config, queue, runtime, seats })

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

// The delegate tool needs the queue AND a way to drain it, and drain lives on
// the web server, which is built further down. Declared here and assigned once
// both exist; the channel only ever reaches it at runtime, long after that.
let delegator = null

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
  onDelegate: input => delegator.delegate(input),
})

if (config.permissionRelay) {
  channel.onPermissionRequest(params => {
    // open() refuses an id that is not the shape Claude Code issues. Announcing
    // it anyway would put a prompt in front of approvers that resolve() can
    // never match, so they would click allow and nothing would happen.
    if (!permissions.open(params)) {
      log(`ignored a permission request with an unexpected id: ${params?.request_id}`)
      return
    }
    bus.publish('approval-request', params)
  })
  // Scoped deliberately: only the local session's prompts reach the room.
  // A seat's Claude Code still approves its own tool calls in its own
  // terminal, because seat.mjs does not intercept permission prompts. Saying
  // "approvers in the room can allow tool calls" unqualified would promise
  // cover over every seat, which is not true.
  log('permission relay is ON for the local session — approvers in the room can allow its tool calls')
  log('           seats approve their own tool calls in their own terminal')
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
  permissions, turns, observer, bans, admin, runtime, seats,
  // Only a seat that was actually delegated to has a result to return; an
  // ordinary reply passes straight through.
  onSeatReply: (handle, text) => delegator.onSeatReply(handle, text),
  onTurnAbandoned: (dest, turn, reason) => delegator.onTurnAbandoned(dest, turn, reason),
})

delegator = createDelegator({
  queue, store, bus, channel, orchestrator: ORCHESTRATOR, drain: () => web.drain(),
})

web.listen(config.port, config.host, () => {
  // Report the port actually bound, not the one requested — with ROOM_PORT=0
  // the OS chooses, and callers need to know which.
  config.port = web.address().port
  log(`listening on http://${config.host}:${config.port} (${registry.all().length} member(s))`)
  if (config.host === '127.0.0.1') log('bound to loopback — set ROOM_HOST to your Tailscale address to let teammates in')

  // Written here rather than at load: with ROOM_PORT=0 the port is not known
  // until the socket is bound, and a settings file naming the wrong port
  // produces hooks that silently never arrive.
  const settingsPath = store.writeHookSettings({ port: config.port, token: config.hookToken })
  log(`hooks: launch the local session with --settings ${settingsPath}`)
})

web.on('error', err => log(`http error: ${err.message}`))

// Embedded mode: connect the MCP stdio transport, same as always. Standalone
// mode has no stdio peer to connect to — the HTTP server above is already
// listening and keeps the process alive on its own, so there is nothing
// further to do here.
if (!standalone) {
  await channel.connect()
  log('channel connected')
} else {
  log('standalone mode — no MCP stdio peer')
}
