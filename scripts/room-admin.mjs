#!/usr/bin/env node
/**
 * Room administration CLI.
 *
 * Talks to the running room over HTTP so changes take effect immediately. The
 * older version edited the members file on disk while the live room held its
 * own copy in memory, which meant "revoke" did not actually remove anyone until
 * the next restart. If the room is not running, this says so rather than
 * pretending to have done something.
 *
 * Auth: an owner token, from ROOM_ADMIN_TOKEN or --token.
 *
 *   room-admin list
 *   room-admin invite <name> [owner|member|viewer] [--approve] [--payer <url>]
 *   room-admin remove <name|id>
 *   room-admin ban <name> [--reason "..."] [--address]   room-admin unban <name>
 *   room-admin role <name> <owner|member|viewer>
 *   room-admin mute <name> [on|off]             room-admin approve <name> [on|off]
 *   room-admin rename <name> <newName>          room-admin rotate <name>
 *   room-admin payer <name> <url>
 *   room-admin handle <@name>[,<@name>...]      room-admin pause [on|off]
 *   room-admin clear-queue
 *   room-admin budget [--tokens N] [--messages N]
 *   room-admin seat add <name> --owner <member> [--handle <handle>] [--delegatable]
 *   room-admin seat policy <name> <owner-only|shared>
 */
import { loadConfig } from '../src/config.mjs'

const config = loadConfig(process.env)
const argv = process.argv.slice(2)
const cmd = (argv[0] ?? 'list').toLowerCase()

const flag = name => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}
const has = name => argv.includes(name)
const onOff = (v, dflt = true) => (v == null ? dflt : !['off', 'false', '0', 'no'].includes(String(v).toLowerCase()))

const base = flag('--url') || process.env.ROOM_URL || `http://${config.host}:${config.port}`
const token = flag('--token') || process.env.ROOM_ADMIN_TOKEN

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

if (!token) {
  die(
    'No owner token. Set ROOM_ADMIN_TOKEN or pass --token <token>.\n' +
    'The owner join URL is printed to stderr when the room starts.',
  )
}

async function call(path, body, method = 'POST') {
  let res
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ ...body, token }) : undefined,
    })
  } catch {
    die(`Cannot reach the room at ${base}. Is the Claude Code session running?`)
  }
  const out = await res.json().catch(() => ({ ok: false, reason: `http-${res.status}` }))
  if (!out.ok) die(`${out.reason ?? 'failed'}${res.status === 403 ? ' (needs an owner token)' : ''}`)
  return out
}

const state = () => call(`/api/admin/state?token=${encodeURIComponent(token)}`, null, 'GET')

/** Accept a name or an id everywhere a member is named. */
async function resolve(key) {
  if (!key) die('which member?')
  const s = await state()
  const m = s.members.find(x => x.id === key || x.name.toLowerCase() === String(key).toLowerCase())
  if (!m) die(`no member called "${key}"`)
  return m
}

function printMembers(s) {
  if (!s.members.length) return console.log('(no members)')
  for (const m of s.members) {
    const tags = [
      m.role,
      m.canApprove ? 'approver' : null,
      m.muted ? 'MUTED' : null,
      m.hasPayer ? 'payer' : null,
      // A seat's handle is how anyone addresses it, and its policy decides
      // whose account gets spent — both belong in the roster, not just in the
      // output of the command that happened to create it.
      m.kind === 'agent' ? `@${m.handle}` : null,
      m.kind === 'agent' && m.addressPolicy === 'shared' ? 'SHARED' : null,
      m.kind === 'agent' && m.delegatable ? 'DELEGATABLE' : null,
    ].filter(Boolean).join(' ')
    console.log(`${m.name.padEnd(14)} ${tags.padEnd(28)} ${m.joinUrl}`)
  }
  if (s.bans.length) {
    console.log('\nbanned:')
    for (const b of s.bans) console.log(`  ${b.name ?? b.addr}${b.reason ? ` — ${b.reason}` : ''}`)
  }
  console.log(`\nagent handle(s): ${s.handles.map(h => '@' + h).join(', ')}${s.paused ? '   [ROOM PAUSED]' : ''}`)
}

switch (cmd) {
  case 'list': {
    printMembers(await state())
    break
  }
  case 'invite': {
    const name = argv[1]
    if (!name) die('usage: room-admin invite <name> [role] [--approve] [--payer <url>]')
    const role = ['owner', 'member', 'viewer'].includes(argv[2]) ? argv[2] : 'member'
    const r = await call('/api/admin/invite', {
      name, role, canApprove: has('--approve'), payerRef: flag('--payer') ?? undefined,
    })
    console.log(`invited ${name} (${role})`)
    console.log(r.joinUrl)
    break
  }
  case 'remove': {
    const m = await resolve(argv[1])
    await call('/api/admin/remove', { memberId: m.id })
    console.log(`removed ${m.name} — their link is dead and their stream is cut`)
    break
  }
  case 'ban': {
    const name = argv[1]
    if (!name) die('usage: room-admin ban <name> [--reason "..."]')
    const r = await call('/api/admin/ban', {
      name, reason: flag('--reason') ?? '', banAddress: has('--address'),
    })
    console.log(`banned ${r.ban.name}${r.ban.addr ? ` and ${r.ban.addr}` : ''}`)
    break
  }
  case 'unban': {
    await call('/api/admin/unban', { key: argv[1] })
    console.log(`unbanned ${argv[1]}`)
    break
  }
  case 'role': {
    const m = await resolve(argv[1])
    await call('/api/admin/role', { memberId: m.id, role: argv[2] })
    console.log(`${m.name} is now ${argv[2]}`)
    break
  }
  case 'mute': {
    const m = await resolve(argv[1])
    const muted = onOff(argv[2])
    await call('/api/admin/mute', { memberId: m.id, muted })
    console.log(`${m.name} ${muted ? 'muted' : 'unmuted'}`)
    break
  }
  case 'approve': {
    const m = await resolve(argv[1])
    const can = onOff(argv[2])
    await call('/api/admin/approve', { memberId: m.id, canApprove: can })
    console.log(`${m.name} ${can ? 'can' : 'cannot'} approve tool calls`)
    break
  }
  case 'rename': {
    const m = await resolve(argv[1])
    await call('/api/admin/rename', { memberId: m.id, name: argv[2] })
    console.log(`${m.name} is now ${argv[2]}`)
    break
  }
  case 'rotate': {
    const m = await resolve(argv[1])
    const r = await call('/api/admin/rotate', { memberId: m.id })
    console.log(`new link for ${m.name} — the old one is dead:`)
    console.log(r.joinUrl)
    break
  }
  case 'payer': {
    const m = await resolve(argv[1])
    await call('/api/admin/payer', { memberId: m.id, payerRef: argv[2] })
    console.log(`${m.name} pays via ${argv[2] || '(cleared)'}`)
    break
  }
  case 'handle':
  case 'handles': {
    const r = await call('/api/admin/handles', { handles: argv[1] })
    console.log(`agent now answers to ${r.handles.map(h => '@' + h).join(', ')}`)
    break
  }
  case 'pause': {
    const paused = onOff(argv[1])
    await call('/api/admin/pause', { paused })
    console.log(paused ? 'room paused — chat continues, no new work' : 'room resumed')
    break
  }
  case 'clear-queue': {
    const r = await call('/api/admin/clearQueue', {})
    console.log(`dropped ${r.dropped} queued message(s)`)
    break
  }
  case 'budget': {
    const r = await call('/api/admin/budget', {
      tokensPerMember: flag('--tokens') ?? undefined,
      messagesPerWindow: flag('--messages') ?? undefined,
    })
    console.log(`budgets: ${JSON.stringify(r.budgets)}`)
    break
  }
  case 'seat': {
    const SEAT_USAGE =
      'usage: room-admin seat add <name> --owner <member> [--handle <handle>] [--delegatable]\n' +
      '       room-admin seat policy <name> <owner-only|shared>'

    if (argv[1] === 'policy') {
      const m = await resolve(argv[2])
      const policy = argv[3]
      if (!policy) die(SEAT_USAGE)
      await call('/api/admin/addressPolicy', { memberId: m.id, policy })
      console.log(
        policy === 'shared'
          ? `@${m.handle ?? m.name} is now SHARED — anyone in the room can address it, spending its owner's account`
          : `@${m.handle ?? m.name} is now owner-only`,
      )
      break
    }

    if (argv[1] !== 'add') die(SEAT_USAGE)
    const name = argv[2]
    const ownerName = flag('--owner')
    if (!name || !ownerName) die(SEAT_USAGE)
    const owner = await resolve(ownerName)
    const handle = (flag('--handle') || name).replace(/^@/, '')
    const delegatable = has('--delegatable')
    const r = await call('/api/admin/invite', { name, kind: 'agent', handle, ownerId: owner.id, delegatable })
    console.log(`seat added: ${name} (@${handle}), owned by ${owner.name}`)
    console.log(`only ${owner.name} can address it (seat policy owner-only)`)
    console.log(delegatable
      ? `the orchestrator may delegate work to this seat`
      : `not delegatable — pass --delegatable to let the orchestrator hand it work`)
    console.log(`run: node scripts/room-seat.mjs ${handle} --token ${r.token} --repo <path-to-repo>`)
    break
  }
  default:
    die(`unknown command: ${cmd}\nRun with no arguments to list the room.`)
}
