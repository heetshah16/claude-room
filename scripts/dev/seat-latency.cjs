// First- and second-reply latency of a seat, read from the room's own turns.json.
// node scripts/dev/seat-latency.cjs <extension dir, e.g. ~/.cursor/extensions/claude-room.claude-room-orchestrator-0.0.4> <scratch dir> [plugin dir]
// Starts a room through that extension's own session.js on a temp git repo, launches a headless
// claude there (the installed room-seat, or [plugin dir] via --plugin-dir: disable the installed
// one first or both join), asks twice and prints reply time, room-busy time and ToolSearch calls.
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync, spawn } = require('node:child_process')

const [, , EXT, WORK, PLUGIN_DIR] = process.argv
const { createSession } = require(path.join(EXT, 'src', 'session.js'))
const { createSupervisor } = require(path.join(EXT, 'src', 'supervisor.js'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

fs.rmSync(WORK, { recursive: true, force: true })
const proj = path.join(WORK, 'proj'), stateDir = path.join(WORK, 'state')
fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(stateDir, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: proj })
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: proj })

const supervisor = createSupervisor({ log: () => {} })
const s = createSession({ repoRoot: path.join(EXT, 'room'), workRepo: proj, stateDir, supervisor, ui: { showError() {}, showInfo() {}, copy() {} }, log: () => {} })
const turns = () => { try { const t = JSON.parse(fs.readFileSync(path.join(stateDir, 'turns.json'), 'utf8')); return Array.isArray(t) ? t : Object.values(t) } catch { return [] } }
let child

;(async () => {
  try {
    const started = await s.start()
    const handle = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'room-seat.local.json'), 'utf8')).seat_handle
    const env = { ...process.env }; for (const k of Object.keys(env)) if (/^ROOM_/.test(k)) delete env[k]
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--allowedTools', 'mcp__room-seat__room_reply', ...(PLUGIN_DIR ? ['--plugin-dir', PLUGIN_DIR] : [])]
    child = spawn('claude', args, { cwd: proj, env, shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let out = ''; child.stdout.on('data', d => { out += d })
    const state = async () => (await (await fetch(`${started.roomUrl}/api/state?token=${encodeURIComponent(started.token)}`)).json())
    for (let i = 0; i < 240 && !(await state()).seats?.some(x => x.handle === handle); i++) await sleep(250)
    for (const word of ['alpha', 'beta']) {
      const n = turns().length
      await fetch(`${started.roomUrl}/msg?token=${encodeURIComponent(started.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `@${handle} reply with exactly the word ${word}` }) })
      let t
      for (let i = 0; i < 400; i++) { t = turns()[n]; if (t?.endedAt) break; await sleep(250) }
      const reply = t?.replies?.[0]
      console.log(`${word}: reply ${reply ? ((reply.ts - t.startedAt) / 1000).toFixed(2) + 's' : 'NONE'} (${reply?.text}), room busy ${t?.endedAt ? ((t.endedAt - t.startedAt) / 1000).toFixed(2) + 's' : '?'}`)
    }
    console.log('ToolSearch calls in session:', (out.match(/"name":"ToolSearch"/g) || []).length)
  } finally {
    if (child) try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    s.stop(); await supervisor.stop('room').catch(() => {})
    process.exit(0)
  }
})()
