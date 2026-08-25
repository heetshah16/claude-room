import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const ROLES = ['owner', 'member', 'viewer']

/**
 * @param {{name:string, role?:import('./types.mjs').Role, canApprove?:boolean, payerRef?:string}} spec
 * @returns {import('./types.mjs').Member}
 */
export function createMember({ name, role = 'member', canApprove = false, payerRef }) {
  return {
    id: randomUUID(),
    name,
    role,
    canApprove,
    muted: false,
    token: randomBytes(24).toString('base64url'),
    payerRef,
  }
}

/**
 * Viewers observe the room but never put anything into the context window.
 * Muting is the temporary version of the same thing — it survives a role change
 * and is meant for "stop, you are talking over the turn", not for demotion.
 */
export const canAddress = m =>
  !!m && m.muted !== true && (m.role === 'owner' || m.role === 'member')

/** Owners always approve; members only with an explicit grant. Viewers never. */
export const mayApprove = m =>
  !!m && (m.role === 'owner' || (m.role === 'member' && m.canApprove === true))

/**
 * @param {{name:string, handle:string, ownerId:string}} spec
 * @returns {import('./types.mjs').Member & {kind:'agent', handle:string, ownerId:string}}
 */
export function createAgentMember({ name, handle, ownerId }) {
  return {
    ...createMember({ name, role: 'member' }),
    kind: 'agent',
    handle: String(handle).replace(/^@/, '').toLowerCase(),
    ownerId,
  }
}

export const isAgent = m => m?.kind === 'agent'

/**
 * Whether `sender` may address `agent`.
 *
 * Deliberately NOT satisfied by room ownership. If the room owner could address
 * every seat, one person's account would serve another person's request, which
 * is exactly the line this design exists to stay on the right side of.
 */
export const ownsSeat = (sender, agent) =>
  !!sender && !!agent && isAgent(agent) && agent.ownerId === sender.id

/** Constant-time compare so lookup leaks neither length nor prefix by timing. */
function sameToken(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export class Registry {
  #members = new Map()

  add(member) {
    this.#members.set(member.id, member)
    return member
  }

  byId(id) {
    return this.#members.get(id) ?? null
  }

  byToken(token) {
    if (!token) return null
    for (const m of this.#members.values()) if (sameToken(m.token, token)) return m
    return null
  }

  byName(name) {
    const want = String(name).toLowerCase()
    return this.all().find(m => m.name.toLowerCase() === want) ?? null
  }

  all() {
    return [...this.#members.values()]
  }

  revoke(id) {
    return this.#members.delete(id)
  }

  /**
   * Mutations are applied in place so a running room sees them immediately.
   * Every one returns the member or null, so callers can report honestly
   * instead of silently no-opping on a bad id.
   */
  #patch(id, fields) {
    const m = this.#members.get(id)
    if (!m) return null
    Object.assign(m, fields)
    return m
  }

  setRole(id, role) {
    if (!ROLES.includes(role)) return null
    return this.#patch(id, { role })
  }

  setApprove(id, canApprove) {
    return this.#patch(id, { canApprove: !!canApprove })
  }

  setMuted(id, muted) {
    return this.#patch(id, { muted: !!muted })
  }

  setPayer(id, payerRef) {
    return this.#patch(id, { payerRef: payerRef || undefined })
  }

  rename(id, name) {
    const clean = String(name ?? '').trim()
    if (!clean) return null
    const clash = this.byName(clean)
    if (clash && clash.id !== id) return null
    return this.#patch(id, { name: clean })
  }

  /** Issue a fresh token, invalidating the old one immediately. */
  rotate(id) {
    return this.#patch(id, { token: randomBytes(24).toString('base64url') })
  }

  /** The room must never be left without someone who can administer it. */
  owners() {
    return this.all().filter(m => m.role === 'owner')
  }

  byHandle(handle) {
    const want = String(handle ?? '').replace(/^@/, '').toLowerCase()
    return this.all().find(m => isAgent(m) && m.handle === want) ?? null
  }

  agents() {
    return this.all().filter(isAgent)
  }

  toJSON() {
    return this.all()
  }

  static fromJSON(arr = []) {
    const r = new Registry()
    // Older state files predate `muted`; default it rather than leaving it
    // undefined, so canAddress never depends on a missing field.
    for (const m of arr) r.add({ muted: false, ...m })
    return r
  }
}

/**
 * Blacklist. Removing someone frees their name and their tailnet address to be
 * handed out again by mistake; a ban is what makes "and don't let them back"
 * mean something. Names are matched case-insensitively; addresses are exact.
 *
 * On a tailnet an address is stable per device, which makes address bans
 * meaningful here in a way they would not be on open wifi behind NAT.
 */
export class Bans {
  #names = new Map()
  #addrs = new Map()

  ban({ name, addr, reason = '', by = '' }) {
    const entry = { name: name ?? null, addr: addr ?? null, reason, by, ts: Date.now() }
    if (name) this.#names.set(String(name).toLowerCase(), entry)
    if (addr) this.#addrs.set(String(addr), entry)
    return entry
  }

  unban(key) {
    const k = String(key ?? '')
    return this.#names.delete(k.toLowerCase()) || this.#addrs.delete(k)
  }

  isBanned({ name, addr } = {}) {
    if (name && this.#names.has(String(name).toLowerCase())) return true
    if (addr && this.#addrs.has(String(addr))) return true
    return false
  }

  all() {
    const seen = new Set()
    const out = []
    for (const e of [...this.#names.values(), ...this.#addrs.values()]) {
      const key = `${e.name}|${e.addr}|${e.ts}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
    }
    return out
  }

  toJSON() {
    return this.all()
  }

  static fromJSON(arr = []) {
    const b = new Bans()
    for (const e of arr) b.ban(e)
    return b
  }
}
