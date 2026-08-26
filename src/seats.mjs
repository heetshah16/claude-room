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
   * Looks up a seat by its connection-local id. Returns the live record
   * (conn included) or null. `online()` strips `conn` for anything handed to
   * a browser; this is the one lookup the room itself uses to still have a
   * socket to deliver a turn or mirror to.
   */
  byId(seatId) {
    return this.#seats.get(seatId) ?? null
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
   * Ends the feeds of every seat belonging to a member: the agent member
   * itself, and any seat that member owns. Returns how many were ended.
   *
   * This is the seat half of `Bus.disconnect`. A seat's connection lives here
   * rather than on the bus, so revoking, banning, or re-tokening someone left
   * their seat streaming the room — deliverToSeats writes to `conn` directly
   * and never re-checks a token, so a removed agent kept reading everything.
   *
   * Deliberately only ends the connection. The feed's own close handler is
   * what retires the seat and ends any turn left in flight; removing the
   * record here instead would free the handle while leaving the queue busy
   * forever — the same wedge the mid-turn-disconnect fix exists to prevent.
   * Liveness keeps exactly one owner.
   */
  evict(memberId) {
    if (!memberId) return 0
    let ended = 0
    for (const seat of [...this.#seats.values()]) {
      if (seat.memberId !== memberId && seat.ownerId !== memberId) continue
      try {
        seat.conn?.end()
        ended++
      } catch {
        // Already gone; its close handler has run or is about to.
      }
    }
    return ended
  }

  /**
   * The same comment frame as Bus.keepalive, for seat feeds.
   *
   * A seat is online exactly while its feed is open, so an idle feed being cut
   * is not a cosmetic problem: undici aborts one after 300s of silence, the
   * close handler retires the seat, and its owner is refused with
   * `seat-offline` until the bridge's backoff reconnects it. A quiet room
   * churned every seat roughly every five minutes.
   *
   * A write that throws is left to that connection's own close handler to
   * retire, exactly as deliverToSeats does — a seat is never retired here.
   */
  keepalive() {
    let live = 0
    for (const seat of this.#seats.values()) {
      try {
        seat.conn?.write(': ping\n\n')
        live++
      } catch {
        // Dead socket; its close handler retires the seat.
      }
    }
    return live
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
