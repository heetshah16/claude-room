import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseUsageLine, sumUsage, cacheRatio } from './ledger.mjs'
import { mayApprove } from './identity.mjs'
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
  const { config, registry, ledger, decisions, queue, store, bus, channel, permissions, turns, observer } = deps
  const uploadDir = join(config.stateDir, 'uploads')
  mkdirSync(uploadDir, { recursive: true })

  // Gate on member identity, never on who can reach the port. Anyone able to
  // put text in front of Claude is a prompt-injection path.
  const memberFrom = (req, url, body) =>
    registry.byToken(body?.token ?? url.searchParams.get('token') ?? req.headers['x-room-token'])

  function drain() {
    const turn = queue.beginTurn()
    if (!turn) return
    if (config.payerMode === 'rotate') store.writePayer(turn.payer)
    const logged = turns.open({ messages: turn.messages, participants: turn.participants })

    // The brief goes first, as its own event. Channel events queued together
    // are delivered in order as one turn, so the agent sees the room's state
    // and then the message, with the message untouched.
    const brief = observer?.briefForInjection?.()
    if (brief?.text) channel.notifyBrief(brief.text, { stale: brief.stale, ageS: brief.ageS })

    channel.notify(turn.messages)
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

  function emitActivity(evt, promptId) {
    const turn = turns.activity(evt, promptId)
    bus.publish('activity', { ...evt, turnId: turn?.id ?? null })
  }

  function handleHook(event, p) {
    if (event === 'PreToolUse') {
      emitActivity({ kind: 'tool-start', tool: p.tool_name, input: p.tool_input, ts: Date.now() }, p.prompt_id)
    } else if (event === 'PostToolUse') {
      emitActivity({ kind: 'tool-end', tool: p.tool_name, ts: Date.now() }, p.prompt_id)
    } else if (event === 'Notification') {
      emitActivity({ kind: 'notification', type: p.notification_type, ts: Date.now() }, p.prompt_id)
    } else if (event === 'SessionStart') {
      bus.publish('activity', { kind: 'session-start', ts: Date.now(), turnId: null })
    } else if (event === 'Stop') {
      const participants = queue.participantsOf(p.prompt_id) ?? queue.participantsOf('__inflight__') ?? []
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
      const closed = turns.close(p.prompt_id, usage)
      store.saveTurns(turns)
      if (closed) {
        observer?.note?.({
          kind: 'turn',
          ask: closed.preview,
          tools: [...new Set(closed.activity.filter(a => a.kind === 'tool-start').map(a => a.tool))],
          reply: closed.replies.map(r => r.text).join(' ').slice(0, 300),
        })
      }
      queue.endTurn(p.prompt_id)
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
        bus.subscribe(res)
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
          you: { id: member.id, name: member.name, role: member.role, canApprove: mayApprove(member) },
          room: config.roomName,
          payerMode: config.payerMode,
          members: registry.all().map(m => ({ id: m.id, name: m.name, role: m.role })),
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

        const r = queue.submit(member, String(body.text ?? ''), { force: body.force === true })
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
