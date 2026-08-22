import { createMember, ROLES, mayApprove } from './identity.mjs'
import { DEFAULT_HANDLES } from './router.mjs'

/**
 * Room administration.
 *
 * Every command mutates live state and then persists, so nothing here needs a
 * restart — which is the whole point. The previous CLI edited the members file
 * on disk while a running room held its own copy in memory, so changes only
 * took effect on the next launch and revoking someone did not actually remove
 * them. These are the same operations done against the running room.
 *
 * Each command returns `{ ok, reason, ... }` and never throws: an admin action
 * that fails silently is worse than one that fails loudly.
 */

const ok = (extra = {}) => ({ ok: true, reason: 'ok', ...extra })
const no = reason => ({ ok: false, reason })

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', ''])

/**
 * An address is unsafe to ban when it is loopback (everything local shares it)
 * or when an owner is currently reachable at it (the ban would lock the room's
 * administrator out of the room).
 */
function isUnbannableAddr(addr, registry, runtime) {
  if (LOOPBACK.has(String(addr))) return true
  return registry.owners().some(o => runtime.lastAddrOf?.(o.id) === addr)
}

const publicMember = m => ({
  id: m.id, name: m.name, role: m.role, canApprove: mayApprove(m), muted: !!m.muted,
  hasPayer: !!m.payerRef,
})

export function createAdmin({ registry, bans, store, bus, config, queue, runtime }) {
  const persistMembers = () => store.saveRegistry(registry)
  const persistBans = () => store.saveBans(bans)

  const announce = (event, data) => bus.publish(event, data)

  /** Roster changed: everyone's member list and any admin panel must refresh. */
  const rosterChanged = () => {
    announce('presence', {
      members: registry.all().map(publicMember),
      listeners: bus.count(),
    })
  }

  const commands = {
    invite({ name, role = 'member', canApprove = false, payerRef }) {
      const clean = String(name ?? '').trim()
      if (!clean) return no('name-required')
      if (!ROLES.includes(role)) return no('bad-role')
      if (registry.byName(clean)) return no('name-taken')
      if (bans.isBanned({ name: clean })) return no('name-banned')

      const m = registry.add(createMember({ name: clean, role, canApprove, payerRef }))
      persistMembers()
      rosterChanged()
      return ok({ member: publicMember(m), token: m.token, joinUrl: runtime.joinUrl(m.token) })
    },

    remove({ memberId }) {
      const m = registry.byId(memberId)
      if (!m) return no('no-such-member')
      // Refuse to strand the room: something must be able to administer it.
      if (m.role === 'owner' && registry.owners().length <= 1) return no('last-owner')

      registry.revoke(m.id)
      persistMembers()
      bus.disconnect(m.id)          // drop their live stream immediately
      rosterChanged()
      announce('admin', { action: 'remove', name: m.name })
      return ok({ removed: publicMember(m) })
    },

    ban({ memberId, name, addr, banAddress = false, reason = '', by = '' }) {
      const m = memberId ? registry.byId(memberId) : name ? registry.byName(name) : null
      if (m?.role === 'owner' && registry.owners().length <= 1) return no('last-owner')

      // Address bans are opt-in and never inferred.
      //
      // Banning whatever address someone last used looks helpful and is a
      // footgun: on loopback, or behind NAT, or on shared office wifi, that
      // address belongs to other people too — including the owner issuing the
      // ban, who then locks themselves out of their own room. Ask for it
      // explicitly, and still refuse the addresses that cannot be safely banned.
      let banAddr = null
      if (addr || banAddress) {
        const candidate = addr ?? runtime.lastAddrOf?.(m?.id) ?? null
        if (candidate && !isUnbannableAddr(candidate, registry, runtime)) banAddr = candidate
        else if (candidate) return no('addr-unsafe-to-ban')
      }

      const entry = bans.ban({ name: m?.name ?? name ?? null, addr: banAddr, reason, by })
      persistBans()

      if (m) {
        registry.revoke(m.id)
        persistMembers()
        bus.disconnect(m.id)
      }
      rosterChanged()
      announce('admin', { action: 'ban', name: entry.name })
      return ok({ ban: entry })
    },

    unban({ key }) {
      if (!bans.unban(key)) return no('not-banned')
      persistBans()
      announce('admin', { action: 'unban', name: key })
      return ok()
    },

    role({ memberId, role }) {
      const m = registry.byId(memberId)
      if (!m) return no('no-such-member')
      if (!ROLES.includes(role)) return no('bad-role')
      if (m.role === 'owner' && role !== 'owner' && registry.owners().length <= 1) {
        return no('last-owner')
      }
      registry.setRole(m.id, role)
      persistMembers()
      rosterChanged()
      return ok({ member: publicMember(m) })
    },

    approve({ memberId, canApprove }) {
      const m = registry.setApprove(memberId, canApprove)
      if (!m) return no('no-such-member')
      persistMembers()
      rosterChanged()
      return ok({ member: publicMember(m) })
    },

    mute({ memberId, muted }) {
      const m = registry.setMuted(memberId, muted)
      if (!m) return no('no-such-member')
      persistMembers()
      rosterChanged()
      return ok({ member: publicMember(m) })
    },

    rename({ memberId, name }) {
      const m = registry.rename(memberId, name)
      if (!m) return no(registry.byId(memberId) ? 'name-taken-or-empty' : 'no-such-member')
      persistMembers()
      rosterChanged()
      return ok({ member: publicMember(m) })
    },

    /** New token, old one dead on the next request. Use when a link leaks. */
    rotate({ memberId }) {
      const m = registry.rotate(memberId)
      if (!m) return no('no-such-member')
      persistMembers()
      bus.disconnect(m.id)
      return ok({ member: publicMember(m), token: m.token, joinUrl: runtime.joinUrl(m.token) })
    },

    payer({ memberId, payerRef }) {
      const m = registry.setPayer(memberId, payerRef)
      if (!m) return no('no-such-member')
      persistMembers()
      rosterChanged()
      return ok({ member: publicMember(m) })
    },

    /** Rename the agent. `@claude` becomes `@ada` for everyone, immediately. */
    handles({ handles }) {
      const list = (Array.isArray(handles) ? handles : String(handles ?? '').split(','))
        .map(h => String(h).trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean)
      if (!list.length) return no('handles-required')
      if (list.some(h => /\s/.test(h))) return no('handle-has-space')
      config.handles = list
      store.saveRuntime({ handles: list, paused: !!config.paused })
      announce('admin', { action: 'handles', handles: list })
      return ok({ handles: list })
    },

    /** Stop accepting work without evicting anyone. Chat keeps flowing. */
    pause({ paused }) {
      config.paused = !!paused
      store.saveRuntime({ handles: config.handles ?? DEFAULT_HANDLES, paused: config.paused })
      announce('admin', { action: 'pause', paused: config.paused })
      return ok({ paused: config.paused })
    },

    clearQueue() {
      const dropped = queue.clear()
      announce('admin', { action: 'clear-queue', dropped })
      return ok({ dropped })
    },

    budget({ tokensPerMember, messagesPerWindow }) {
      if (tokensPerMember != null) config.budgets.tokensPerMember = Number(tokensPerMember) || 0
      if (messagesPerWindow != null) config.budgets.messagesPerWindow = Number(messagesPerWindow) || 0
      announce('admin', { action: 'budget', budgets: config.budgets })
      return ok({ budgets: config.budgets })
    },
  }

  return {
    commands,
    names: Object.keys(commands),
    run(action, args = {}) {
      const fn = commands[action]
      if (!fn) return no('unknown-command')
      return fn(args)
    },
    publicMember,
  }
}
