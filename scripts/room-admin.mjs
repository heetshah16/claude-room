#!/usr/bin/env node
/**
 * Room membership CLI. Operates on the on-disk registry, so it works whether or
 * not the room is currently running — but a running room reads members at
 * startup, so restart the session after adding someone.
 *
 *   node scripts/room-admin.mjs list
 *   node scripts/room-admin.mjs add <name> [owner|member|viewer] [--approve] [--payer <url>]
 *   node scripts/room-admin.mjs revoke <name|id>
 */
import { loadConfig } from '../src/config.mjs'
import { Store } from '../src/state.mjs'
import { createMember } from '../src/identity.mjs'

const config = loadConfig(process.env)
const store = new Store(config.stateDir)
const { registry } = store.load()

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = name => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}

const base = `http://${config.host}:${config.port}`

function list() {
  const all = registry.all()
  if (!all.length) return console.log('no members yet — start the room once to bootstrap an owner')
  for (const m of all) {
    console.log(`${m.name.padEnd(14)} ${m.role.padEnd(7)} ${m.canApprove ? 'approver' : '        '} ${base}/?token=${m.token}`)
  }
}

if (cmd === 'list' || !cmd) {
  list()
} else if (cmd === 'add') {
  const name = argv[1]
  if (!name) {
    console.error('usage: room-admin add <name> [owner|member|viewer] [--approve] [--payer <url>]')
    process.exit(1)
  }
  const role = ['owner', 'member', 'viewer'].includes(argv[2]) ? argv[2] : 'member'
  const m = registry.add(
    createMember({
      name,
      role,
      canApprove: argv.includes('--approve'),
      payerRef: flag('--payer') ?? undefined,
    }),
  )
  store.saveRegistry(registry)
  console.log(`added ${m.name} (${m.role})`)
  console.log(`${base}/?token=${m.token}`)
  console.log('restart the Claude Code session for the room to pick this up')
} else if (cmd === 'revoke') {
  const key = argv[1]
  const target = registry.all().find(m => m.id === key || m.name === key)
  if (!target) {
    console.error(`no member named ${key}`)
    process.exit(1)
  }
  registry.revoke(target.id)
  store.saveRegistry(registry)
  console.log(`revoked ${target.name}`)
  console.log('restart the Claude Code session to drop their live access')
} else {
  console.error(`unknown command: ${cmd}`)
  process.exit(1)
}
