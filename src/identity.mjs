import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

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
    token: randomBytes(24).toString('base64url'),
    payerRef,
  }
}

/** Viewers observe the room but never put anything into the context window. */
export const canAddress = m => !!m && (m.role === 'owner' || m.role === 'member')

/** Owners always approve; members only with an explicit grant. Viewers never. */
export const mayApprove = m =>
  !!m && (m.role === 'owner' || (m.role === 'member' && m.canApprove === true))

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

  all() {
    return [...this.#members.values()]
  }

  revoke(id) {
    return this.#members.delete(id)
  }

  toJSON() {
    return this.all()
  }

  static fromJSON(arr = []) {
    const r = new Registry()
    for (const m of arr) r.add(m)
    return r
  }
}
