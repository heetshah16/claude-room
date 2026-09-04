// A stand-in for `opencode serve`, implementing only the routes the driver
// uses. Tests must never need the real binary: it is a network dependency, a
// model dependency, and — as the probe showed — unreliable on the free tier.
import { createServer } from 'node:http'

export async function startFakeOpencode() {
  const prompts = []
  const aborts = []
  const mcp = []
  const feeds = new Set()

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const json = () => { try { return JSON.parse(body || '{}') } catch { return {} } }

      if (req.method === 'GET' && path === '/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        feeds.add(res)
        // `res`, not `req`: a bodyless GET's IncomingMessage fires its own
        // 'close' as soon as its (empty) body finishes reading — immediately,
        // long before the connection actually ends — which emptied `feeds`
        // before a single event could ever be delivered. The response only
        // closes when the client actually disconnects.
        res.on('close', () => feeds.delete(res))
        return
      }
      if (req.method === 'POST' && path === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'ses_fake' }))
      }
      if (req.method === 'POST' && path.endsWith('/prompt_async')) {
        prompts.push(json())
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'POST' && path.endsWith('/abort')) {
        aborts.push(path)
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'POST' && path === '/mcp') {
        mcp.push(json())
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ room: { status: 'connected' } }))
      }
      res.writeHead(404)
      res.end()
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    prompts, aborts, mcp,
    emit(type, properties = {}) {
      const frame = `data: ${JSON.stringify({ id: 'evt_1', type, properties })}\n\n`
      for (const f of feeds) f.write(frame)
    },
    async close() {
      for (const f of feeds) f.end()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
