import { randomUUID } from 'node:crypto'
import { isAgent } from './identity.mjs'

/**
 * Tracks which agent seats are currently live. A seat binds an agent member to an
 * SSE connection; when the connection closes, the seat goes offline.
 *
 * Seats are indexed by both seatId (connection-local) and by handle (global within
 * the room). A handle can only be claimed by one seat at a time.
 */
export class Seats {
  #seats = new Map() // seatId -> Seat
  #byHandle = new Map() // handle -> seatId

  /**
   * Brings an agent online. Returns {ok, reason, seatId}. Fails if the member is
   * not an agent, or if the handle is already taken.
   */
  join(agent, conn) {
    if (!isAgent(agent)) {
      return { ok: false, reason: 'not-an-agent' }
    }

    if (this.#byHandle.has(agent.handle)) {
      return { ok: false, reason: 'handle-taken' }
    }

    const seatId = randomUUID()
    const seat = {
      seatId,
      handle: agent.handle,
      memberId: agent.id,
      ownerId: agent.ownerId,
      conn,
      joinedAt: Date.now(),
    }

    this.#seats.set(seatId, seat)
    this.#byHandle.set(agent.handle, seatId)

    return { ok: true, seatId }
  }

  /**
   * Brings a seat offline. Removes it from both indexes. No-op if the seat doesn't
   * exist (callers may race on cleanup).
   */
  leave(seatId) {
    const seat = this.#seats.get(seatId)
    if (!seat) return

    this.#byHandle.delete(seat.handle)
    this.#seats.delete(seatId)
  }

  /**
   * Looks up a seat by handle. Returns the seat object or null if not found or
   * offline.
   */
  byHandle(handle) {
    const seatId = this.#byHandle.get(handle)
    return seatId ? this.#seats.get(seatId) : null
  }

  /**
   * All currently online seats. Returns plain rows without the conn object so the
   * seat list can be serialised straight to browsers over JSON without leaking
   * internals or causing circular references.
   */
  online() {
    const result = []
    for (const seat of this.#seats.values()) {
      const { conn, ...row } = seat
      result.push(row)
    }
    return result
  }

  /**
   * Whether a handle is currently online.
   */
  isOnline(handle) {
    return this.#byHandle.has(handle)
  }

  /**
   * All seats except the given one. Used to broadcast events to peers.
   */
  others(seatId) {
    const result = []
    for (const seat of this.#seats.values()) {
      if (seat.seatId !== seatId) {
        result.push(seat)
      }
    }
    return result
  }

  /**
   * Updates the last-seen timestamp for a seat. No-op if the seat doesn't exist
   * (safe for racing cleanup). Tracks continuous activity to distinguish live
   * seats from stalled connections.
   */
  touch(seatId) {
    const seat = this.#seats.get(seatId)
    if (seat) {
      seat.lastSeen = Date.now()
    }
  }
}
