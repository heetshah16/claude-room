// extension/src/stream.js
'use strict'

/**
 * Turns Claude Code's `--output-format stream-json` into the small set of
 * events a chat UI actually renders.
 *
 * Normalising here rather than in the webview keeps the webview dumb and this
 * logic testable without VS Code. Every shape below was captured from the real
 * binary; anything unrecognised is dropped, so a newer Claude Code that adds
 * an event type cannot break the chat.
 */
function createStreamParser({ onEvent }) {
  let buf = ''

  function emitBlocks(blocks) {
    for (const b of blocks ?? []) {
      if (b.type === 'text' && b.text) onEvent({ kind: 'text', text: b.text })
      else if (b.type === 'thinking' && b.thinking) onEvent({ kind: 'thinking', text: b.thinking })
      else if (b.type === 'tool_use') onEvent({ kind: 'tool', id: b.id, name: b.name, input: b.input ?? {} })
      else if (b.type === 'tool_result') {
        onEvent({ kind: 'tool-result', id: b.tool_use_id, content: b.content, isError: !!b.is_error })
      }
    }
  }

  function handle(ev) {
    switch (ev?.type) {
      case 'system':
        if (ev.subtype === 'init') {
          onEvent({ kind: 'session', sessionId: ev.session_id, tools: ev.tools ?? [], cwd: ev.cwd })
        } else if (ev.subtype === 'thinking_tokens') {
          onEvent({ kind: 'thinking-tokens', tokens: ev.estimated_tokens ?? 0 })
        }
        return
      // Both assistant and user messages carry a content-block array; the
      // difference is only which block types appear in them.
      case 'assistant':
      case 'user':
        emitBlocks(ev.message?.content)
        return
      case 'rate_limit_event': {
        const i = ev.rate_limit_info ?? {}
        onEvent({ kind: 'rate-limit', status: i.status, resetsAt: i.resetsAt, limitType: i.rateLimitType })
        return
      }
      case 'result':
        onEvent({
          kind: 'turn-end',
          text: typeof ev.result === 'string' ? ev.result : '',
          sessionId: ev.session_id,
          turns: ev.num_turns ?? 0,
          costUsd: ev.total_cost_usd ?? 0,
          isError: !!ev.is_error,
        })
        return
      default:
        return
    }
  }

  return {
    push(chunk) {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue } // a malformed line must not kill the stream
        handle(ev)
      }
    },
    end() { buf = '' },
  }
}

module.exports = { createStreamParser }
