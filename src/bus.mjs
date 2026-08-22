/**
 * Server-Sent Events fan-out. SSE rather than WebSocket so the room needs no
 * dependency beyond node:http, and so a dropped tailnet link reconnects on its
 * own without any reconnect logic of ours.
 *
 * Subscriptions are tagged with the member they belong to, so removing or
 * banning someone can actually cut their live stream instead of leaving them
 * watching the room until they happen to reload.
 */
export class Bus {
  #subs = new Set()
  #byMember = new Map()

  subscribe(res, memberId = null) {
    const entry = { res, memberId }
    this.#subs.add(entry)
    if (memberId) {
      if (!this.#byMember.has(memberId)) this.#byMember.set(memberId, new Set())
      this.#byMember.get(memberId).add(entry)
    }
    const drop = () => this.#drop(entry)
    res.on('close', drop)
    return drop
  }

  #drop(entry) {
    this.#subs.delete(entry)
    const set = entry.memberId && this.#byMember.get(entry.memberId)
    if (set) {
      set.delete(entry)
      if (!set.size) this.#byMember.delete(entry.memberId)
    }
  }

  publish(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const entry of [...this.#subs]) {
      try {
        entry.res.write(frame)
      } catch {
        this.#drop(entry)
      }
    }
  }

  /** Close every live stream belonging to a member. Returns how many. */
  disconnect(memberId) {
    const set = this.#byMember.get(memberId)
    if (!set) return 0
    let n = 0
    for (const entry of [...set]) {
      try {
        entry.res.end()
      } catch {
        // already gone
      }
      this.#drop(entry)
      n++
    }
    return n
  }

  count() {
    return this.#subs.size
  }
}
