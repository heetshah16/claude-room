// extension/src/orchestrator.js
'use strict'
const { join } = require('node:path')
const { createStreamParser } = require('./stream.js')

const SYSTEM_PROMPT = `You are the orchestrator in a room that also has cheap worker seats.

Design, decide and verify yourself. Hand mechanical work - boilerplate, tests, mechanical refactors, documentation, lint and build fixes - to a worker with the delegate tool. Keep architecture, ambiguous requirements, hard debugging and final integration decisions.

When you delegate, say so in your reply. Your live output is visible only to the person here; anyone else in the room sees only what you actually state, so decisions must be said, not merely thought.`

/**
 * One long-lived Claude Code process, serving every turn of the chat.
 *
 * Verified against the real binary: two prompts over one process kept one
 * session_id and the second turn recalled a fact from the first.
 *
 * `--bare` is deliberately absent. It would skip the user's hooks and
 * CLAUDE.md, which is tempting - but it also never reads OAuth or the keychain
 * and requires an API key, and reusing the existing subscription login is the
 * whole reason this is pleasant to install.
 */
function orchestratorRecipe({
  repoRoot, roomUrl, token, sessionId, workspace, mcpConfigPath,
  env = process.env, claudePath = 'claude',
}) {
  return {
    cmd: claudePath,
    args: [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', sessionId,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--mcp-config', mcpConfigPath,
      '--add-dir', workspace,
    ],
    opts: {
      cwd: workspace,
      env: { ...env, ROOM_URL: roomUrl, ROOM_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  }
}

/** The MCP config naming the bridge — written to disk, never passed as argv JSON. */
function bridgeMcpConfig(repoRoot) {
  return { mcpServers: { orchestrator: { command: 'node', args: [join(repoRoot, 'src', 'orchestrator-bridge.mjs')] } } }
}

function userTurn(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
}

function createOrchestrator({ child, onEvent }) {
  let sessionId = null
  const parser = createStreamParser({
    onEvent: e => {
      if (e.kind === 'session') sessionId = e.sessionId
      onEvent(e)
    },
  })
  child.stdout.on('data', d => parser.push(String(d)))

  return {
    send(text) { child.stdin.write(userTurn(text)) },
    /**
     * A worker's report, handed to the orchestrator as a turn.
     *
     * Labelled, because it arrives on the same channel a person's message
     * does: unlabelled, the orchestrator would credit the human with work a
     * worker did.
     */
    relay({ handle, text }) {
      child.stdin.write(userTurn(`[worker @${handle} reports] ${text}`))
    },
    sessionId: () => sessionId,
  }
}

module.exports = { orchestratorRecipe, bridgeMcpConfig, createOrchestrator, SYSTEM_PROMPT }
