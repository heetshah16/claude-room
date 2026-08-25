import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseUsageLine, sumUsage, cacheRatio } from './ledger.mjs'
import { mayApprove, isAgent } from './identity.mjs'
import { fanOut } from './fanout.mjs'
import { buildSeed } from './seed.mjs'
import { LOCAL_DEST } from './queue.mjs'
import { renderUI } from './ui.mjs'

const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

const readBody = req =>
  new Promise(resolve => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })

export function createWeb(deps) {
  const {
    config, registry, ledger, decisions, queue, store, bus, channel,
    permissions, turns, observer, bans, admin, runtime, seats,
  } = deps

  // Address seen per member, so a ban can cover the device as well as the name.
  // On a tailnet these are stable per machine. Held in `runtime` rather than
  // locally because the admin layer needs to read it when issuing a ban.
  const addrOf = req =>
    String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  const uploadDir = join(config.stateDir, 'uploads')
  mkdirSync(uploadDir, { recursive: true })

  // Gate on member identity, never on who can reach the port. Anyone able to
  // put text in front of Claude is a prompt-injection path.
  const memberFrom = (req, url, body) => {
    const m = registry.byToken(body?.token ?? url.searchParams.get('token') ?? req.headers['x-room-token'])
    if (!m) return null
    // A ban outranks a valid token: the token may still be in someone's
    // bookmark bar long after they were removed.
    if (bans?.isBanned({ name: m.name, addr: addrOf(req) })) return null
    runtime.noteAddr(m.id, addrOf(req))
    return m
  }

  // `Seats.online()` strips `conn` deliberately (it goes straight to
  // browsers as JSON), so delivery goes through `seats.byId`, the one lookup
  // that still has a live socket. There is no connection map of our own here
  // — the Seat record is the single place that knows whether a seat is
  // reachable, exactly the invariant a seat's liveness depends on.
  function deliverToSeats(event) {
    for (const d of fanOut(event, seats.online())) {
      const seat = seats.byId(d.seatId)
      if (!seat?.conn) continue
      // fanOut hands back a bare messages array for 'turn'/'addressed'
      // mirrors and an already-shaped {text} object for reply/digest
      // mirrors; normalise the former so every seat event is `{...}`, never
      // a raw array.
      const data = Array.isArray(d.payload) ? { messages: d.payload } : d.payload
      try {
        seat.conn.write(`event: ${d.kind}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        // Dead socket; its own close handler retires the seat.
      }
    }
  }

  function drain() {
    const turn = queue.beginTurn()
    if (!turn) return
    if (config.payerMode === 'rotate') store.writePayer(turn.payer)

    // A turn targets exactly one destination — never merge messages meant
    // for two different seats (or a seat and the local channel) into one
    // batch, which would hand one person's message to another person's
    // account. `queue.beginTurn()` already guarantees `turn.messages` all
    // share `turn.dest`; this just resolves what that destination is.
    const agent = registry.byHandle(turn.messages[0]?.handle)

    if (agent && !seats.byHandle(agent.handle)) {
      // The seat went offline between submit and drain — Queue.submit's own
      // online gate can still lose this race. Fail visibly: end this
      // destination's turn and tell the room, rather than leave it wedged
      // busy with the message gone and nowhere to deliver it.
      queue.endTurn(turn.dest)
      for (const m of turn.messages) {
        bus.publish('rejected', { memberId: m.memberId, name: m.name, reason: 'seat-offline' })
      }
      return
    }

    const logged = turns.open({ messages: turn.messages, participants: turn.participants, dest: turn.dest })

    if (agent) {
      // A turn addressed to a live agent seat belongs to that seat's own
      // account — deliver it over the seat's own feed instead of the local
      // MCP channel, so nothing but the seat's owner can ever drive it.
      deliverToSeats({ type: 'addressed', handle: agent.handle, messages: turn.messages })
    } else {
      // The brief goes first, as its own event. Channel events queued together
      // are delivered in order as one turn, so the agent sees the room's state
      // and then the message, with the message untouched.
      const brief = observer?.briefForInjection?.()
      if (brief?.text) channel.notifyBrief(brief.text, { ageS: brief.ageS, pending: brief.pending })
      channel.notify(turn.messages)
    }

    // msgIds let the browser link each message to the turn it caused, without
    // rewriting the append-only transcript.
    bus.publish('turn', {
      started: true,
      turnId: logged.id,
      msgIds: logged.msgIds,
      participants: turn.participants,
    })
  }

  const slimTurn = t => ({
    id: t.id, promptId: t.promptId, msgIds: t.msgIds, preview: t.preview,
    startedAt: t.startedAt, endedAt: t.endedAt,
    activityCount: t.activity.length, replyCount: t.replies.length,
    usage: t.usage, ratio: t.ratio,
  })

  function broadcastMessage(m) {
    store.appendMessage(m)
    bus.publish('message', m)
    // Chatter is fed to the observer too: walk-backs and forks happen in the
    // conversation the agent never sees, which is exactly the gap it fills.
    observer?.note?.({ kind: 'message', name: m.name, text: m.text })
  }

  function usageFromTranscript(path) {
    if (!path) return null
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    const lines = text.split('\n')
    const usages = []
    // Walk backwards to the previous user line so only this turn's requests count.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.trim()) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (o.type === 'user') break
      const u = parseUsageLine(line)
      if (u) usages.push(u)
    }
    return usages.length ? sumUsage(usages) : null
  }

  function emitActivity(evt, promptId, dest = LOCAL_DEST) {
    const turn = turns.activity(evt, promptId, dest)
    bus.publish('activity', { ...evt, turnId: turn?.id ?? null })
  }

  // `ctx.dest` scopes this whole pipeline to one destination's turn, so seat
  // A's hooks can never bind, close, or end seat B's (or the local channel's)
  // in-flight turn. `ctx.participants` lets a seat's hooks attribute cost to
  // the seat's owner instead of the queue's own participants, which only
  // ever describes the local host's turn.
  function handleHook(event, p, ctx = {}) {
    const dest = ctx.dest ?? LOCAL_DEST
    if (event === 'PreToolUse') {
      emitActivity({ kind: 'tool-start', tool: p.tool_name, input: p.tool_input, ts: Date.now() }, p.prompt_id, dest)
    } else if (event === 'PostToolUse') {
      emitActivity({ kind: 'tool-end', tool: p.tool_name, ts: Date.now() }, p.prompt_id, dest)
    } else if (event === 'Notification') {
      emitActivity({ kind: 'notification', type: p.notification_type, ts: Date.now() }, p.prompt_id, dest)
    } else if (event === 'SessionStart') {
      bus.publish('activity', { kind: 'session-start', ts: Date.now(), turnId: null })
    } else if (event === 'Stop') {
      const participants = ctx.participants ?? queue.participantsOf(p.prompt_id) ?? queue.participantsOf('__inflight__') ?? []
      const usage = usageFromTranscript(p.transcript_path)
      if (usage) {
        ledger.record(p.prompt_id, usage, participants, config.splitMode)
        store.saveLedger(ledger)
        bus.publish('cost', {
          promptId: p.prompt_id,
          ratio: cacheRatio(usage),
          usage,
          totals: Object.fromEntries(registry.all().map(m => [m.id, ledger.totalsFor(m.id)])),
        })
      }
      const closed = turns.close(p.prompt_id, usage, dest)
      store.saveTurns(turns)
      if (closed) {
        observer?.note?.({
          kind: 'turn',
          ask: closed.preview,
          tools: [...new Set(closed.activity.filter(a => a.kind === 'tool-start').map(a => a.tool))],
          reply: closed.replies.map(r => r.text).join(' ').slice(0, 300),
        })
      }
      queue.endTurn(dest, p.prompt_id)
      bus.publish('turn', { started: false, turnId: closed?.id ?? null, summary: closed ? slimTurn(closed) : null })
      drain()
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    try {
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(renderUI(config))
      }

      if (req.method === 'GET' && path === '/events') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        // Tag the subscription so a removal or ban can cut this stream at once.
        bus.subscribe(res, member.id)
        bus.publish('presence', {
          members: registry.all().map(m => ({ id: m.id, name: m.name, role: m.role })),
          listeners: bus.count(),
        })
        return
      }

      if (req.method === 'GET' && path === '/api/state') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        return json(res, 200, {
          you: {
            id: member.id, name: member.name, role: member.role,
            canApprove: mayApprove(member), muted: !!member.muted,
          },
          room: config.roomName,
          payerMode: config.payerMode,
          handles: config.handles,
          paused: !!config.paused,
          members: registry.all().map(m => ({
            id: m.id, name: m.name, role: m.role, muted: !!m.muted,
          })),
          messages: store.recent(200),
          ledger: {
            ...Object.fromEntries(registry.all().map(m => [m.id, ledger.totalsFor(m.id)])),
            // The observer is not a registry member but does spend, so its row
            // has to be added explicitly or its cost is invisible.
            observer: ledger.totalsFor('observer'),
          },
          decisions: decisions.open(),
          pending: queue.pending().length,
          busy: queue.busy(),
          pendingApprovals: mayApprove(member) ? permissions.pending() : [],
          turns: turns.recent(50).map(slimTurn),
          openTurnId: turns.openTurn()?.id ?? null,
          brief: observer ? { ...observer.briefForInjection(), on: observer.enabled(), paused: observer.paused() } : null,
        })
      }

      // Detail is a separate fetch: a room with 50 turns of tool calls would
      // otherwise make every state poll enormous.
      if (req.method === 'GET' && path === '/api/turn') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        const turn = turns.get(url.searchParams.get('id'))
        return turn ? json(res, 200, turn) : json(res, 404, { error: 'no such turn' })
      }

      if (req.method === 'POST' && path === '/msg') {
        let body = {}
        try {
          body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        } catch {
          return json(res, 400, { error: 'bad json' })
        }
        const member = memberFrom(req, url, body)
        if (!member) return json(res, 401, { error: 'bad token' })

        const r = queue.submit(member, String(body.text ?? ''), {
          force: body.force === true,
          handles: config.handles,
          paused: config.paused,
        })
        if (!r.ok) {
          bus.publish('rejected', { memberId: member.id, name: member.name, reason: r.reason })
          return json(res, 429, { ok: false, reason: r.reason })
        }
        broadcastMessage(r.message)
        if (r.conflicts.length) bus.publish('conflicts', { msgId: r.message.id, conflicts: r.conflicts })
        if (r.message.addressed) drain()
        return json(res, 200, { ok: true, addressed: r.message.addressed, reason: r.reason, conflicts: r.conflicts })
      }

      if (req.method === 'POST' && path === '/upload') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        const buf = await readBody(req)
        const name = String(url.searchParams.get('name') ?? 'upload.bin')
        // Never trust the client filename for a path; keep only a short extension.
        const ext = extname(name).slice(0, 12).replace(/[^.A-Za-z0-9]/g, '')
        const dest = join(uploadDir, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`)
        writeFileSync(dest, buf)
        const r = queue.submit(member, String(url.searchParams.get('text') ?? ''), {
          force: true,
          attachment: { path: dest, name },
        })
        if (r.message) broadcastMessage(r.message)
        if (r.message?.addressed) drain()
        return json(res, 200, { ok: true, path: dest })
      }

      // Owner-only. Every command mutates the running room and persists.
      if (req.method === 'POST' && path.startsWith('/api/admin/')) {
        let body = {}
        try {
          body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        } catch {
          return json(res, 400, { ok: false, reason: 'bad-json' })
        }
        const member = memberFrom(req, url, body)
        if (!member) return json(res, 401, { ok: false, reason: 'bad-token' })
        if (member.role !== 'owner') return json(res, 403, { ok: false, reason: 'owner-only' })

        const action = path.slice('/api/admin/'.length)
        const result = admin.run(action, { ...body, by: member.name })
        return json(res, result.ok ? 200 : 400, result)
      }

      if (req.method === 'GET' && path === '/api/admin/state') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { ok: false, reason: 'bad-token' })
        if (member.role !== 'owner') return json(res, 403, { ok: false, reason: 'owner-only' })
        return json(res, 200, {
          ok: true,
          members: registry.all().map(m => ({
            ...admin.publicMember(m),
            joinUrl: runtime.joinUrl(m.token),
            lastAddr: runtime.lastAddrOf(m.id),
          })),
          bans: bans.all(),
          handles: config.handles,
          paused: !!config.paused,
          budgets: config.budgets,
          commands: admin.names,
        })
      }

      if (req.method === 'POST' && path === '/verdict') {
        let body = {}
        try {
          body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        } catch {
          return json(res, 400, { error: 'bad json' })
        }
        const member = memberFrom(req, url, body)
        if (!member) return json(res, 401, { error: 'bad token' })
        const r = permissions.resolve(String(body.request_id), member, String(body.behavior))
        if (r.ok) {
          channel.sendVerdict(body.request_id, body.behavior)
          bus.publish('approval', { request_id: body.request_id, behavior: body.behavior, by: member.name })
        }
        return json(res, r.ok ? 200 : 403, r)
      }

      if (req.method === 'POST' && path === '/seat/join') {
        let body = {}
        try {
          body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        } catch {
          return json(res, 400, { error: 'bad json' })
        }
        const member = memberFrom(req, url, body)
        if (!member) return json(res, 401, { error: 'bad token' })
        // A human token must never claim a seat: a seat is a different
        // person's Anthropic account, and this is the gate that keeps a
        // browser token from driving one.
        if (!isAgent(member)) return json(res, 403, { error: 'not-an-agent' })

        // A seat is online exactly while its event feed is open — that is
        // the only fact Seats tracks liveness by, and /seat/events is the
        // only route with a socket to back it. This handshake just checks
        // the token and hands back a seed; `seatId` here is a correlation id
        // for this call only, not a live registration.
        const seed = buildSeed({
          brief: observer?.briefForInjection?.()?.text ?? '',
          decisions: decisions.open(),
          messages: store.recent(200),
          limit: 50,
        })
        return json(res, 200, { seatId: randomUUID(), seed })
      }

      if (req.method === 'GET' && path === '/seat/events') {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        if (!isAgent(member)) return json(res, 403, { error: 'not-an-agent' })

        // The one place a seat becomes reachable: Seats.join's own
        // handle-taken guard refuses a second feed for a handle that
        // already has one open, so at most one connection ever owns a seat.
        const r = seats.join(member, res)
        if (!r.ok) return json(res, 409, { error: r.reason })
        const seatId = r.seatId

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        // Liveness is the connection: once it drops, the seat is offline and
        // its handle is free again. Fenced on identity — if this seat was
        // ever re-registered under a different connection (e.g. a refused
        // duplicate that somehow still reached here, or a rejoin after a
        // prior leave), this close must not retire a seat it no longer owns.
        res.on('close', () => {
          const current = seats.byId(seatId)
          if (current?.conn === res) seats.leave(seatId)
        })
        return
      }

      if (req.method === 'POST' && path === '/seat/reply') {
        let body = {}
        try {
          body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        } catch {
          return json(res, 400, { error: 'bad json' })
        }
        const member = memberFrom(req, url, body)
        if (!member) return json(res, 401, { error: 'bad token' })
        if (!isAgent(member)) return json(res, 403, { error: 'not-an-agent' })

        const text = String(body.text ?? '')
        const message = {
          id: randomUUID(),
          memberId: member.id,
          name: member.handle,
          text,
          content: text,
          ts: Date.now(),
          addressed: false,
          handle: null,
          kind: 'reply',
        }
        broadcastMessage(message)
        deliverToSeats({ type: 'reply', fromHandle: member.handle, text })
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && path.startsWith('/seat/hook/')) {
        // Fire and forget, same as /hook/: a hook must never stall a turn.
        const event = path.slice('/seat/hook/'.length)
        let payload = {}
        try {
          payload = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        } catch {
          payload = {}
        }
        try {
          const member = memberFrom(req, url, payload)
          if (member && isAgent(member)) {
            handleHook(event, payload, {
              // Scoped to this seat's own destination so its Stop can never
              // bind to or end a different seat's (or the local channel's)
              // in-flight turn.
              dest: member.handle,
              // Cost lands on the human who owns the seat, never on the
              // agent member — that is the entire point of per-seat auth.
              participants: [{ memberId: member.ownerId, weight: 1 }],
            })
          }
        } catch {
          // The activity feed may degrade; the room must not.
        }
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST' && path.startsWith('/hook/')) {
        // Fire and forget. A hook must never stall a turn, so this always
        // answers 200 even when the payload is unparseable.
        const event = path.slice('/hook/'.length)
        let payload = {}
        try {
          payload = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        } catch {
          payload = {}
        }
        try {
          handleHook(event, payload)
        } catch {
          // The activity feed may degrade; the room must not.
        }
        return json(res, 200, { ok: true })
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) })
    }
  })
}
