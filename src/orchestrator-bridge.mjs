#!/usr/bin/env node
/**
 * The orchestrator's bridge to the room.
 *
 * The mirror of src/seat.mjs, and deliberately thinner: a seat needs a feed
 * because the room drives it, whereas the orchestrator is driven by a human in
 * the extension's chat. It needs exactly one thing from the room - the ability
 * to hand work to a seat - so this holds no state and opens no stream.
 *
 * stdout belongs to the MCP protocol; every log line goes to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASK_CLASSES } from './delegation.mjs'

const INSTRUCTIONS = `You orchestrate. Design, decide, and verify yourself; hand mechanical work to a worker seat with the delegate tool.

Delegate boilerplate, tests, mechanical refactors, documentation, and lint or build fixes. Keep architecture, ambiguous requirements, hard debugging, and final integration decisions.

The spec is what makes delegated work usable. Name the files, the interface to conform to, and the command that verifies it. A thin brief is rejected, and the rejection names the field it needs.`

export function createBridge({ roomUrl, token, fetchImpl = fetch }) {
  const mcp = new Server(
    { name: 'orchestrator', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'delegate',
      description:
        'Hand a scoped task to a worker seat. Use it for work that does not need this session: boilerplate, tests, mechanical refactors, documentation, lint and build fixes. Name the files, the interface and how it will be verified - a thin brief is rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The @handle to delegate to' },
          class: { type: 'string', enum: TASK_CLASSES },
          task: { type: 'string', description: 'One line stating what to do' },
          spec: {
            type: 'object',
            description: 'files and tests are REQUIRED when class is execution.',
            properties: {
              files: { type: 'array', items: { type: 'string' } },
              interface: { type: 'string' },
              tests: { type: 'array', items: { type: 'string' } },
              do_not_touch: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['to', 'class', 'task'],
      },
    }],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name !== 'delegate') {
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
    try {
      const res = await fetchImpl(`${roomUrl}/api/delegate?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.params.arguments ?? {}),
      })
      if (!res.ok) {
        return { content: [{ type: 'text', text: `delegate failed: HTTP ${res.status}` }], isError: true }
      }
      const body = await res.json()
      if (!body.ok) {
        return {
          content: [{ type: 'text', text: `delegate rejected:\n- ${(body.errors ?? []).join('\n- ')}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: `delegated ${body.id} to ${req.params.arguments?.to}` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true }
    }
  })

  return { mcp, connect: () => mcp.connect(new StdioServerTransport()) }
}

const log = s => process.stderr.write(`orchestrator-bridge: ${s}\n`)

async function main() {
  const roomUrl = process.env.ROOM_URL
  const token = process.env.ROOM_TOKEN
  if (!roomUrl) { log('missing ROOM_URL'); process.exit(1) }
  if (!token) { log('missing ROOM_TOKEN'); process.exit(1) }
  await createBridge({ roomUrl, token }).connect()
  log(`connected to ${roomUrl}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
