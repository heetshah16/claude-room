/**
 * Server-Sent Events fan-out. SSE rather than WebSocket so the room needs no
 * dependency beyond node:http, and so a dropped tailnet link reconnects on its
 * own without any reconnect logic of ours.
 */
export class Bus {
  #subs = new Set()

  subscribe(res) {
    this.#subs.add(res)
    res.on('close', () => this.#subs.delete(res))
    return () => this.#subs.delete(res)
  }

  publish(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.#subs) {
      try {
        res.write(frame)
      } catch {
        this.#subs.delete(res)
      }
    }
  }

  count() {
    return this.#subs.size
  }
}
