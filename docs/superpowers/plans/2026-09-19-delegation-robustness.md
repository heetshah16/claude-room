# Delegation Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the orchestrator grow its own fleet from inside a session (`spawn_worker`, plus `POST /api/spawn-worker` and `POST /api/stop-worker` for the extension), and stop taking a worker's success claim on faith — the room re-runs the delegation's own `spec.tests` in the worker's worktree and reports `verified` alongside what the worker said, including on the silent-worker path.

**Architecture:** Two new pure-ish modules plus one port. `src/supervisor.mjs` is an ESM port of `extension/src/supervisor.js` (start/stop/stopAll, process-**tree** kill, exit events); `src/workers.mjs` owns one of those and mints a `delegatable:true` agent seat, then launches `scripts/room-opencode-seat.mjs` through `src/spawn.mjs`; `src/verify.mjs` runs a `spec.tests` command list sequentially under its own deadline. `createDelegator` gains one injected `verify` dependency, so every existing caller — and every existing test — is byte-identical until `server.mjs` wires it.

**Tech Stack:** Node 22+, ESM, zero runtime dependencies beyond `@modelcontextprotocol/sdk`. `node --test` with `node:assert/strict`. No build step. `extension/` stays CommonJS and is not touched by this plan.

**Spec:** `docs/superpowers/specs/2026-09-18-delegation-robustness-design.md`

## Global Constraints

- `src/` is ESM with zero runtime dependencies beyond `@modelcontextprotocol/sdk`; nothing here adds one.
- Pure logic must be injectable: `spawn`, `fetch`, `env`, `platform`, `killTree` and the clock arrive as parameters with real defaults, never read from a global inside a function under test.
- **No test may spawn a real binary or open a non-loopback socket.** `test/helpers/room.mjs`'s `bootRoom` spawning `src/server.mjs` is the one existing exception and stays exactly as scoped as it is.
- Kill process **trees**, not processes — `taskkill /T /F` on Windows, the process group on POSIX. A `.cmd` shim runs under `cmd.exe`, so killing the child orphans the real `opencode serve` holding the port and the worktree.
- stdout belongs to the MCP protocol in `src/server.mjs` and `src/channel.mjs`; every log line goes to stderr via the existing `log` helper (`src/server.mjs:32`).
- Never edit an existing test to make a change pass. Appending new tests to an existing file is fine; changing an existing assertion is not.
- **Baseline suite, measured at the repo root on 2026-09-19 before any of this:** `node --test` → **756 tests, 754 passing, 0 failing, 2 skipped**, ~10.6s. 40 room test files (`test/*.test.mjs`), 22 extension test files (`extension/test/*.test.js`).
- Commit after every task with a `feat:` / `fix:` / `docs:` prefix.
- Test style: `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`. Test names state the *why*, not the *what*.

### Design decisions made here, and why

1. **A `spec.tests` entry is executed without a shell, on both platforms.** `src/verify.mjs` exports `splitCommand`, a tiny quote-aware tokenizer: the first token goes to `spawnPortable` as the command *name* (so `resolveCommand`'s PATHEXT walk still finds `npm.cmd` on Windows, `src/spawn.mjs:43-55`) and the rest go through as an argv array. No `shell: true` anywhere. The ceiling, stated plainly: shell operators (`&&`, `|`, `>`, globbing, `$VAR`) are **not** interpreted — a `spec.tests` entry containing one runs literally and fails. `tests` is already an array, so "two commands" is two entries, which is the shape the orchestrator should use anyway. The alternative — a shell — would hand a room-side shell an orchestrator-authored string, which is exactly the injection surface `src/spawn.mjs:79-98` exists to avoid.
2. **The worktree path is `join(repoRoot, '.worktrees', <sanitised handle>)`**, derived by `worktreeFor` exported from `src/workers.mjs`. That is byte-identical to `scripts/room-seat.mjs:37-40`, which is what `scripts/room-opencode-seat.mjs:44-48` actually calls to create the directory. It is duplicated rather than imported because `src/` must not import from `scripts/` (the dependency runs the other way — `scripts/room-opencode-seat.mjs:22` imports `src/spawn.mjs`). Task 3 pins the duplicate against the original with a test that imports both, so drift fails the suite.
3. **The fleet learns readiness from `seats.isOnline(handle)` (`src/seats.mjs:92`), not from a new signal.** `spawn()` returns the moment the process is launched, matching `delegate`'s own fire-and-forget shape; `list()` derives `starting` / `online` / `exited` rather than tracking a state machine. It learns about death from the supervisor's own `exit` event (`extension/src/supervisor.js:58-64`, ported).
4. **Verification hooks into `onSeatReply`/`onTurnAbandoned` through one optional injected `verify` dependency.** With no `verify` supplied, both methods are line-for-line what they are today — synchronous, same return value, same published events — which is what keeps all 17 cases in `test/delegation-result.test.mjs` green without touching one of them. With `verify` supplied, an `execution` delegation's record is still `take`n synchronously (answered exactly once), but its notification and its `state:'done'` event are published when verification settles. `onSeatReply` cannot become `async`: it is called from `POST /seat/reply` (`src/web.mjs:681`), which must answer the seat immediately, and its array return value is asserted synchronously by four existing tests.
5. **A `delegatable:true` seat is created through the same internal path `POST /api/admin/invite` uses**: `registry.add(createAgentMember({...}))` + `store.saveRegistry(registry)` (`src/admin.mjs:99-101`). The fleet does not go through `admin.run('invite')` because the cross-plan contract fixes its dependency list without `admin`; it reproduces the two guards that matter (a real owner, a free handle) in `nextHandle`'s taken-set and an explicit owner check.
6. **`config.handles` is deliberately NOT touched.** The spec says the handle must be addressable the moment the tool returns; `Queue.#addressableHandles` (`src/queue.mjs:78-84`) already unions `registry.agents().map(a => a.handle)` into the classifier's handle list, so `registry.add` alone achieves that. Adding `@worker-N` to `config.handles` would also be actively harmful after `stop`: `Queue.#destinationOf` (`src/queue.mjs:62-66`) returns `LOCAL_DEST` for a handle no agent holds, so a stale entry would silently route `@worker-1` to the host's own Claude session.

---

### Task 1: `src/supervisor.mjs` — the room gets its own process supervisor

**Files:**
- Create: `src/supervisor.mjs`
- Test: `test/supervisor.test.mjs`

**Interfaces:**
- Consumes: `spawnPortable` from `src/spawn.mjs:161`.
- Produces: `createSupervisor({ spawn, killTree, log }) -> { start(name, {cmd, args, opts}), stop(name), stopAll(), status(name), on(event, cb) }`; `defaultKillTree(pid, platform)`.

**Background:** Ported from `extension/src/supervisor.js:14-93`, which is already proven against real `opencode`/`room` children. Two deliberate changes: it defaults `spawn` to the room's own `spawnPortable` rather than `node:child_process.spawn` (the room already owns portable launching, and a PATH-resolved child is one fewer Windows failure mode), and it drops the extension's `setTimer`/`clearTimer` parameters, which that file accepts and never uses.

- [ ] **Step 1: Write the failing test**

```javascript
// test/supervisor.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSupervisor } from '../src/supervisor.mjs'

/** A child that never exits until the test says so. */
function fakeChild(pid = 100) {
  const c = new EventEmitter()
  c.pid = pid
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.stdin = { write() {}, end() {} }
  return c
}

function harness({ children = [] } = {}) {
  const spawned = []
  const killed = []
  const logged = []
  let i = 0
  const sup = createSupervisor({
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return children[i++] ?? fakeChild(100 + i)
    },
    killTree: pid => killed.push(pid),
    log: s => logged.push(s),
  })
  return { sup, spawned, killed, logged }
}

test('a started child is reported running, with the recipe it was actually given', () => {
  const { sup, spawned } = harness()
  sup.start('worker:worker-1', { cmd: 'node', args: ['launcher.mjs'], opts: { env: { A: '1' } } })
  assert.equal(sup.status('worker:worker-1').state, 'running')
  assert.deepEqual(spawned[0].args, ['launcher.mjs'])
  assert.equal(spawned[0].opts.env.A, '1')
})

test('a child that dies on its own is reported, never silently forgotten', () => {
  // A worker dying while the fleet still lists it as idle is the worst
  // failure this can have: the orchestrator delegates into a corpse.
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  child.emit('exit', 3)
  assert.deepEqual(seen, [{ name: 'worker:worker-1', code: 3 }])
  assert.equal(sup.status('worker:worker-1').state, 'exited')
})

test('a launch error surfaces as an exit rather than an unhandled throw', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('worker:worker-1', { cmd: 'nope', args: [] })
  child.emit('error', new Error('command not found on PATH: nope'))
  assert.equal(seen.length, 1)
  assert.match(sup.status('worker:worker-1').error, /not found on PATH/)
})

test('stopping kills the whole tree, because killing the child orphans opencode', () => {
  // On Windows `opencode` is an npm .cmd shim, so the process we hold is
  // cmd.exe; killing it leaves the real server holding its port and worktree.
  // Observed twice for real while building the OpenCode seat.
  const child = fakeChild(4242)
  const { sup, killed } = harness({ children: [child] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.stop('worker:worker-1')
  assert.deepEqual(killed, [4242])
  assert.equal(sup.status('worker:worker-1').state, 'stopped')
})

test('a stop we asked for is not reported as a crash', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  const seen = []
  sup.on('exit', e => seen.push(e))
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.stop('worker:worker-1')
  child.emit('exit', 0)
  assert.deepEqual(seen, [], 'shutting a worker down is not an incident')
})

test('stopAll tears children down in reverse start order', () => {
  const a = fakeChild(1), b = fakeChild(2), c = fakeChild(3)
  const { sup, killed } = harness({ children: [a, b, c] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.start('worker:worker-2', { cmd: 'node', args: [] })
  sup.start('worker:worker-3', { cmd: 'node', args: [] })
  sup.stopAll()
  assert.deepEqual(killed, [3, 2, 1])
})

test('starting a name twice reaps the first child rather than leaking it', () => {
  const a = fakeChild(1), b = fakeChild(2)
  const { sup, killed } = harness({ children: [a, b] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  assert.deepEqual(killed, [1])
  assert.equal(sup.status('worker:worker-1').pid, 2)
})

test('stderr is drained and logged, so a crash has a reason and not just a code', () => {
  // Nothing else reads the pipe: unread, it fills, and the child stalls.
  const child = fakeChild()
  const { sup, logged } = harness({ children: [child] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  child.stderr.emit('data', 'opencode did not answer\n')
  assert.match(logged.join(''), /did not answer/)
})

test('stdout is kept as a bounded tail, readable through status', () => {
  const child = fakeChild()
  const { sup } = harness({ children: [child] })
  sup.start('worker:worker-1', { cmd: 'node', args: [] })
  child.stdout.emit('data', 'x'.repeat(5000))
  child.stdout.emit('data', 'LAST')
  const out = sup.status('worker:worker-1').output
  assert.ok(out.endsWith('LAST'))
  assert.ok(out.length <= 4096, 'a long-lived chatty child must not grow this without limit')
})

test('status for a name that was never started is stopped, not a crash', () => {
  const { sup } = harness()
  assert.deepEqual(sup.status('worker:nope'), { state: 'stopped', pid: null, error: null, output: '' })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/supervisor.test.mjs`
Expected: FAIL — `Cannot find module '.../src/supervisor.mjs'`

- [ ] **Step 3: Implement**

```javascript
// src/supervisor.mjs
/**
 * Supervised child processes, for the room itself.
 *
 * Ported from extension/src/supervisor.js, which has been driving real
 * `opencode` and room children since the extension shipped. The room needs its
 * own copy because it is now the thing that spawns workers (spec §1): the
 * extension's supervisor lives in a different process and a different module
 * system, so there is nothing to share.
 *
 * Nothing here is a restart policy. A worker that dies stays dead and is
 * reported — the orchestrator decides whether to spawn another, the same way
 * it decides everything else this project keeps out of the room.
 */
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { spawnPortable } from './spawn.mjs'

/** How much of a child's stdout to keep. Bounded: a worker outlives the turn. */
const MAX_OUTPUT = 4096

/**
 * Kill a process and everything it started.
 *
 * `child.kill()` is not enough on Windows: an npm `.cmd` shim runs under
 * cmd.exe, so killing the child kills the shell and leaves the real server
 * running, holding its port and its worktree. That was observed twice while
 * building the OpenCode seat, both times needing a manual hunt.
 */
export function defaultKillTree(pid, platform = process.platform) {
  if (!pid) return
  if (platform === 'win32') {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => {})
    return
  }
  // Negative pid is the process group — the POSIX half of the same idea.
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
}

/**
 * @param {{spawn?:Function, killTree?:Function, log?:Function}} deps
 */
export function createSupervisor({
  spawn = spawnPortable,
  killTree = defaultKillTree,
  log = () => {},
} = {}) {
  const bus = new EventEmitter()
  const procs = new Map() // name -> { child, state, error, pid, stopping, order, output }
  let order = 0

  function start(name, { cmd, args = [], opts = {} }) {
    if (procs.has(name)) stop(name)
    const child = spawn(cmd, args, opts)
    const rec = {
      child, state: 'running', error: null, pid: child.pid,
      stopping: false, order: order++, output: '',
    }
    procs.set(name, rec)

    // Nothing else reads stderr, so an unread pipe would sit full and a crash
    // would surface as a bare exit code with no reason attached to it.
    child.stderr?.on('data', d => log(`${name}: ${d}`))
    child.stdout?.on('data', d => {
      rec.output = (rec.output + d).slice(-MAX_OUTPUT)
    })

    child.on('error', err => {
      rec.error = String(err?.message ?? err)
      rec.state = 'exited'
      log(`${name}: ${rec.error}`)
      if (!rec.stopping) bus.emit('exit', { name, code: null })
    })
    child.on('exit', code => {
      rec.state = rec.stopping ? 'stopped' : 'exited'
      // A stop we asked for is not a crash, and reporting it as one would put
      // an error in front of the user every time they shut a worker down.
      if (!rec.stopping) bus.emit('exit', { name, code })
    })
    return rec
  }

  function stop(name) {
    const rec = procs.get(name)
    if (!rec) return
    rec.stopping = true
    rec.state = 'stopped'
    killTree(rec.pid)
    procs.delete(name)
  }

  return {
    start,
    stop,
    /** Reverse start order: later children may depend on earlier ones. */
    stopAll() {
      const names = [...procs.entries()].sort((a, b) => b[1].order - a[1].order).map(([n]) => n)
      for (const n of names) stop(n)
    },
    status(name) {
      const rec = procs.get(name)
      if (!rec) return { state: 'stopped', pid: null, error: null, output: '' }
      return { state: rec.state, pid: rec.pid, error: rec.error, output: rec.output ?? '' }
    },
    on: (ev, cb) => bus.on(ev, cb),
  }
}
```

Note: `stop` is referenced inside `start` before its own `function stop` declaration appears. Both are function declarations in the same scope, so both are hoisted — this is the same arrangement `extension/src/supervisor.js:34-74` already uses.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/supervisor.test.mjs`
Expected: PASS — 10 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 766 tests, 764 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/supervisor.mjs test/supervisor.test.mjs
git commit -m "feat(room): port the extension's process supervisor to ESM

The room is about to spawn workers itself, so it needs the tree-killing
supervisor that until now only the extension had. Straight port of
extension/src/supervisor.js, defaulting spawn to the room's own
spawnPortable and dropping the setTimer/clearTimer parameters that file
accepted and never used.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `src/verify.mjs` — running a delegation's own tests

**Files:**
- Create: `src/verify.mjs`
- Test: `test/verify.test.mjs`

**Interfaces:**
- Consumes: `spawnPortable` from `src/spawn.mjs:161`; `defaultKillTree` from `src/supervisor.mjs` (Task 1).
- Produces: `verifyDelegation({ tests, cwd, timeoutMs, spawn, killTree }) -> Promise<{ran:boolean, ok:boolean|null, exitCode:number|null, output:string, timedOut:boolean}>`; `splitCommand(line) -> string[]`; `truncateTail(s, max)`; `MAX_OUTPUT`; `DEFAULT_VERIFY_TIMEOUT_MS`.

**Background:** Spec §2. `validateDelegation` (`src/delegation.mjs:35-50`) already *requires* `spec.tests` for `class: "execution"` and nothing ever runs it. This runs it. The command was authored by the orchestrator when it built the brief, not by the worker, so this is not a new trust boundary — it is the room re-running something it already had standing authority to have run.

- [ ] **Step 1: Write the failing test**

```javascript
// test/verify.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { verifyDelegation, splitCommand, truncateTail, MAX_OUTPUT } from '../src/verify.mjs'

/** A child under our control: nothing here launches a real process. */
function fakeChild() {
  const c = new EventEmitter()
  c.pid = 777
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  return c
}

/**
 * A spawn that records its calls and hands each child a scripted outcome.
 * `script` is one entry per expected command.
 */
function fakeSpawn(script = []) {
  const calls = []
  let i = 0
  const spawn = (name, args, opts) => {
    calls.push({ name, args, opts })
    const child = fakeChild()
    const step = script[i++] ?? { code: 0 }
    if (step.hang) return child
    queueMicrotask(() => {
      if (step.stdout) child.stdout.emit('data', step.stdout)
      if (step.stderr) child.stderr.emit('data', step.stderr)
      if (step.error) child.emit('error', new Error(step.error))
      else child.emit('exit', step.code)
    })
    return child
  }
  return { spawn, calls }
}

test('a command string becomes a program plus argv, so no shell is ever involved', () => {
  // A shell would mean quoting an orchestrator-authored string, which is the
  // injection surface src/spawn.mjs exists to avoid.
  assert.deepEqual(splitCommand('node --test math.test.mjs'), ['node', '--test', 'math.test.mjs'])
})

test('a quoted path with a space stays one argument, because this repo has one', () => {
  assert.deepEqual(
    splitCommand('node --test "C:\\My Repo\\math.test.mjs"'),
    ['node', '--test', 'C:\\My Repo\\math.test.mjs'],
  )
})

test('an empty or blank command produces no tokens rather than an empty program name', () => {
  assert.deepEqual(splitCommand('   '), [])
  assert.deepEqual(splitCommand(null), [])
})

test('a class with no tests reports that nothing ran, and claims nothing', async () => {
  // reasoning/verification delegations have nothing mechanical to check.
  // ok:null is the honest answer; ok:false would libel them.
  const { spawn, calls } = fakeSpawn()
  const r = await verifyDelegation({ tests: [], cwd: '/w', spawn })
  assert.deepEqual(r, { ran: false, ok: null, exitCode: null, output: '', timedOut: false })
  assert.equal(calls.length, 0)
})

test('a passing command is verified, and runs in the worktree it was given', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 0, stdout: 'pass 12\n' }])
  const r = await verifyDelegation({ tests: ['node --test'], cwd: '/repo/.worktrees/worker-1', spawn })
  assert.equal(r.ran, true)
  assert.equal(r.ok, true)
  assert.equal(r.exitCode, 0)
  assert.match(r.output, /pass 12/)
  assert.equal(calls[0].name, 'node')
  assert.deepEqual(calls[0].args, ['--test'])
  assert.equal(calls[0].opts.cwd, '/repo/.worktrees/worker-1')
})

test('the first failing command stops the run, because the rest is noise', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 1, stderr: 'not ok 3\n' }, { code: 0 }])
  const r = await verifyDelegation({ tests: ['npm test', 'npm run lint'], cwd: '/w', spawn })
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 1)
  assert.match(r.output, /not ok 3/, 'the real output is what makes a failure repairable')
  assert.equal(calls.length, 1, 'the second command must not run after the first failed')
})

test('every command must pass before the work is called verified', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 0 }, { code: 0 }])
  const r = await verifyDelegation({ tests: ['npm test', 'npm run lint'], cwd: '/w', spawn })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2)
})

test('stderr counts as output too, because a runner puts the failure on either stream', async () => {
  const { spawn } = fakeSpawn([{ code: 1, stdout: 'ran 4\n', stderr: 'AssertionError\n' }])
  const r = await verifyDelegation({ tests: ['npm test'], cwd: '/w', spawn })
  assert.match(r.output, /ran 4/)
  assert.match(r.output, /AssertionError/)
})

test('output is truncated to the last 2048 bytes, so a chatty suite cannot flood the channel', async () => {
  // The tail, not the head: a test runner prints its failure summary last.
  const { spawn } = fakeSpawn([{ code: 1, stdout: 'x'.repeat(9000) + 'TAIL' }])
  const r = await verifyDelegation({ tests: ['npm test'], cwd: '/w', spawn })
  assert.ok(Buffer.byteLength(r.output) <= MAX_OUTPUT)
  assert.ok(r.output.endsWith('TAIL'))
})

test('truncation counts bytes, not code units, so multibyte output is still bounded', () => {
  const out = truncateTail('\u3042'.repeat(2000), 2048)
  assert.ok(Buffer.byteLength(out) <= 2048)
})

test('a hanging command is killed and reported as a timeout, not left wedging the delegation', async () => {
  // Spec §2.4: verification has its own deadline, independent of the worker's
  // turn deadline. A test command that never returns must not hold a
  // delegation open forever.
  const { spawn } = fakeSpawn([{ hang: true }])
  const killed = []
  const r = await verifyDelegation({
    tests: ['npm test'], cwd: '/w', timeoutMs: 20, spawn, killTree: pid => killed.push(pid),
  })
  assert.equal(r.timedOut, true)
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, null)
  assert.deepEqual(killed, [777], 'the tree goes, not just the process we happen to hold')
})

test('a command that cannot be launched is a failure with a reason, never a crash', async () => {
  const { spawn } = fakeSpawn([{ error: 'command not found on PATH: pytest' }])
  const r = await verifyDelegation({ tests: ['pytest'], cwd: '/w', spawn })
  assert.equal(r.ok, false)
  assert.match(r.output, /not found on PATH/)
})

test('a blank entry in tests is skipped rather than spawning an empty program', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 0 }])
  const r = await verifyDelegation({ tests: ['  ', 'npm test'], cwd: '/w', spawn })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'npm')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/verify.test.mjs`
Expected: FAIL — `Cannot find module '.../src/verify.mjs'`

- [ ] **Step 3: Implement**

```javascript
// src/verify.mjs
/**
 * Running a delegation's own verification command, room-side.
 *
 * `validateDelegation` validates a brief before work starts. This applies the
 * same "validated, not trusted" rule to what comes back: when a worker says it
 * is done, the room runs the `spec.tests` the ORCHESTRATOR wrote and lets the
 * real exit code decide. The command was authored upstream, not by the worker,
 * so this is not a new trust boundary — it is the room re-running something it
 * already had standing authority to have run, instead of believing a
 * self-report.
 *
 * Nothing here reads a global: `spawn` and `killTree` are parameters, which is
 * what lets the whole module be tested without launching a process.
 */
import { spawnPortable } from './spawn.mjs'
import { defaultKillTree } from './supervisor.mjs'

/** How much of a test run's output travels back. Bytes, not code units. */
export const MAX_OUTPUT = 2048

/** Verification's own deadline (spec §2.4), independent of a worker's turn. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000

/**
 * Split one command line into a program and its arguments.
 *
 * Deliberately NOT a shell. `&&`, `|`, `>`, globs and `$VAR` are not special
 * here and are passed through as literal argv — a `spec.tests` entry using one
 * will fail rather than being quietly reinterpreted. `spec.tests` is an array,
 * so "run two things" is two entries, which is also the shape that lets the
 * run stop at the first failure.
 *
 * Quotes group, and are removed. `""` is a real empty argument, which is why
 * the tokenizer tracks "a token was started" separately from "it has
 * characters in it".
 */
export function splitCommand(line) {
  const out = []
  let cur = ''
  let started = false
  let quote = null
  const push = () => {
    if (started) out.push(cur)
    cur = ''
    started = false
  }
  for (const ch of String(line ?? '')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push()
      continue
    }
    cur += ch
    started = true
  }
  push()
  return out
}

/**
 * The last `max` BYTES of a string.
 *
 * `String.slice(-n)` counts UTF-16 code units, so a suite printing CJK or
 * emoji would blow a byte budget silently. A cut can land mid-character; the
 * leading replacement character it produces is dropped rather than shipped.
 */
export function truncateTail(s, max = MAX_OUTPUT) {
  const str = String(s ?? '')
  const buf = Buffer.from(str, 'utf8')
  if (buf.length <= max) return str
  return buf.subarray(buf.length - max).toString('utf8').replace(/^\uFFFD/, '')
}

/** One command. Resolves with how it went; never rejects. */
function runOne(command, { cwd, timeoutMs, spawn, killTree }) {
  return new Promise(resolve => {
    const [name, ...args] = splitCommand(command)
    if (!name) {
      resolve({ exitCode: null, output: `not a command: ${command}`, timedOut: false, failed: true })
      return
    }

    const child = spawn(name, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    // Capped as it arrives so a runaway command cannot grow this without
    // limit; a code-unit cap always keeps at least MAX_OUTPUT bytes, which
    // truncateTail then trims to exactly that.
    let output = ''
    let timedOut = false
    let settled = false
    const add = d => { output = (output + d).slice(-MAX_OUTPUT) }

    const finish = exitCode => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, output, timedOut, failed: timedOut || exitCode !== 0 })
    }

    const timer = setTimeout(() => {
      timedOut = true
      // The tree, not the process: a test command is routinely a shim that
      // starts the thing doing the actual work.
      killTree(child.pid)
      finish(null)
    }, timeoutMs)
    // A verification timer is not a reason to keep the room alive.
    timer.unref?.()

    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    child.on('error', err => {
      add(String(err?.message ?? err))
      finish(null)
    })
    child.on('exit', code => finish(code))
  })
}

/**
 * Run a delegation's `spec.tests` in the worker's worktree.
 *
 * Sequential, stopping at the first failure. `ran:false, ok:null` when there is
 * nothing to run — "unchecked" is a third answer, and collapsing it into
 * `ok:false` would report a reasoning task as broken.
 *
 * @param {{tests?:string[], cwd:string, timeoutMs?:number, spawn?:Function, killTree?:Function}} opts
 * @returns {Promise<{ran:boolean, ok:boolean|null, exitCode:number|null, output:string, timedOut:boolean}>}
 */
export async function verifyDelegation({
  tests,
  cwd,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  spawn = spawnPortable,
  killTree = defaultKillTree,
}) {
  const list = (Array.isArray(tests) ? tests : [])
    .map(t => String(t ?? '').trim())
    .filter(Boolean)
  if (!list.length) return { ran: false, ok: null, exitCode: null, output: '', timedOut: false }

  let last = null
  for (const command of list) {
    last = await runOne(command, { cwd, timeoutMs, spawn, killTree })
    if (last.failed) break
  }
  return {
    ran: true,
    ok: !last.failed,
    exitCode: last.exitCode,
    output: truncateTail(last.output),
    timedOut: last.timedOut,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/verify.test.mjs`
Expected: PASS — 13 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 779 tests, 777 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/verify.mjs test/verify.test.mjs
git commit -m "feat(room): run a delegation's own tests instead of trusting the claim

validateDelegation has always required spec.tests for class:execution and
nothing ever ran it. verifyDelegation runs the list sequentially in the
worker's worktree, stops at the first failure, and answers with the real
exit code plus the last 2048 bytes of output. No shell: the command string
is tokenised and handed to spawnPortable as program + argv, so an
orchestrator-authored string never reaches cmd.exe unquoted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `src/workers.mjs` — the fleet

**Files:**
- Create: `src/workers.mjs`
- Test: `test/workers.test.mjs`

**Interfaces:**
- Consumes: `createAgentMember` (`src/identity.mjs:73`), `createSupervisor` (Task 1), `spawnPortable` (`src/spawn.mjs:161`), `Seats.isOnline` (`src/seats.mjs:92`), `Registry.add/agents/owners/revoke` (`src/identity.mjs:135,216,207,159`).
- Produces: `createWorkerFleet({ registry, seats, config, store, bus, spawn, repoRoot, roomUrl, log, now }) -> { spawn({model}) -> Promise<{ok:true,handle}|{ok:false,errors}>, stop(handle) -> {ok:true}|{ok:false,errors}, stopAll(), list() }`; `nextHandle(existing)`; `worktreeFor(repoRoot, handle)`; `workerRecipe({...})`.

**Background:** Spec §1. `extension/src/workers.js:38-166` already does this against a running room over HTTP; this is the same logic on the inside, where `registry` and `seats` are objects rather than fetches. Its state-tracking half (`applyRoomEvent`, transcripts, `detail`) is **not** ported: that is the extension's sidebar, and `list_workers` (`src/channel.mjs:225-228`) is already the room's answer to "what is the fleet doing".

- [ ] **Step 1: Write the failing test**

```javascript
// test/workers.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { createWorkerFleet, nextHandle, worktreeFor, workerRecipe } from '../src/workers.mjs'
import { worktreeFor as launcherWorktreeFor } from '../scripts/room-seat.mjs'
import { Registry, createMember, createAgentMember, isDelegatable } from '../src/identity.mjs'
import { Seats } from '../src/seats.mjs'
import { loadConfig } from '../src/config.mjs'

function fakeChild(pid = 500) {
  const c = new EventEmitter()
  c.pid = pid
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  return c
}

function fleetHarness({ owner = true, spawnImpl = null } = {}) {
  const registry = new Registry()
  if (owner) registry.add(createMember({ name: 'heet', role: 'owner' }))
  const seats = new Seats()
  const saved = []
  const published = []
  const spawned = []
  const children = []
  const fleet = createWorkerFleet({
    registry,
    seats,
    config: loadConfig({}),
    store: { saveRegistry: r => saved.push(r.all().length) },
    bus: { publish: (e, d) => published.push([e, d]) },
    spawn: spawnImpl ?? ((cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      const c = fakeChild(500 + children.length)
      children.push(c)
      return c
    }),
    repoRoot: '/repo',
    roomUrl: 'http://127.0.0.1:8787',
    log: () => {},
    now: () => 1,
  })
  return { fleet, registry, seats, saved, published, spawned, children }
}

test('nextHandle takes the lowest free number, so a stopped worker\'s handle comes back', () => {
  assert.equal(nextHandle([]), 'worker-1')
  assert.equal(nextHandle(['worker-1', 'worker-2']), 'worker-3')
  assert.equal(nextHandle(['worker-1', 'worker-3']), 'worker-2')
})

test('the fleet derives the same worktree path the launcher actually creates', () => {
  // src/ must not import from scripts/ (the dependency runs the other way), so
  // this two-line function is duplicated. This is the guard against drift: if
  // either side changes, a worker verifies in a directory nobody wrote to.
  for (const h of ['worker-1', '@Worker-2', 'ana agent']) {
    assert.equal(worktreeFor('/repo', h), launcherWorktreeFor('/repo', h))
  }
  assert.equal(worktreeFor('/repo', 'worker-1'), join('/repo', '.worktrees', 'worker-1'))
})

test('the recipe runs the opencode launcher with the seat token, repo and room URL', () => {
  const r = workerRecipe({
    repoRoot: '/repo', handle: 'worker-1', token: 'tok', roomUrl: 'http://r:1',
    nodePath: '/usr/bin/node', launcher: '/room/scripts/room-opencode-seat.mjs', env: { PATH: '/bin' },
  })
  assert.equal(r.cmd, '/usr/bin/node')
  assert.deepEqual(r.args, [
    '/room/scripts/room-opencode-seat.mjs', 'worker-1',
    '--token', 'tok', '--repo', '/repo', '--room', 'http://r:1',
  ])
  assert.equal(r.opts.cwd, '/repo')
  assert.deepEqual(r.opts.stdio, ['ignore', 'pipe', 'pipe'])
})

test('a model is only passed when one was asked for, so the launcher\'s default still wins', () => {
  const bare = workerRecipe({ repoRoot: '/r', handle: 'w', token: 't', roomUrl: 'u' })
  assert.equal(bare.args.includes('--model'), false)
  const pinned = workerRecipe({ repoRoot: '/r', handle: 'w', token: 't', roomUrl: 'u', model: 'opencode/x' })
  assert.deepEqual(pinned.args.slice(-2), ['--model', 'opencode/x'])
})

test('a spawned worker is minted as a delegatable agent seat, addressable the moment spawn returns', async () => {
  // delegatable is unconditional here: a self-spawned worker exists to be
  // delegated to, so making that opt-in would be friction with no decision
  // behind it. And Queue.#addressableHandles unions registry agent handles, so
  // registering the member IS what makes @worker-1 route.
  const { fleet, registry, saved } = fleetHarness()
  const r = await fleet.spawn({})
  assert.deepEqual(r, { ok: true, handle: 'worker-1' })
  const member = registry.byHandle('worker-1')
  assert.ok(member, 'the seat must exist on the roster')
  assert.equal(isDelegatable(member), true)
  assert.equal(member.ownerId, registry.owners()[0].id, 'the cost lands on a real owner')
  assert.equal(saved.length, 1, 'and the roster is persisted, or a restart loses the seat')
})

test('the worker is launched with its own freshly minted token, never a guessed one', async () => {
  const { fleet, registry, spawned } = fleetHarness()
  await fleet.spawn({})
  const member = registry.byHandle('worker-1')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--token') + 1], member.token)
})

test('a second worker gets the next handle rather than colliding with the first', async () => {
  const { fleet } = fleetHarness()
  await fleet.spawn({})
  const second = await fleet.spawn({})
  assert.equal(second.handle, 'worker-2')
})

test('a handle already held by a hand-minted seat is skipped, not reused', async () => {
  // `room-admin seat add worker-1` is a perfectly legal thing to have done.
  const { fleet, registry } = fleetHarness()
  const owner = registry.owners()[0]
  registry.add(createAgentMember({ name: 'worker-1', handle: 'worker-1', ownerId: owner.id }))
  const r = await fleet.spawn({})
  assert.equal(r.handle, 'worker-2')
})

test('a room with no owner refuses to spawn, because the cost would land nowhere', async () => {
  const { fleet, spawned } = fleetHarness({ owner: false })
  const r = await fleet.spawn({})
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /owner/)
  assert.equal(spawned.length, 0, 'nothing may be launched for a seat nobody pays for')
})

test('a launch failure revokes the seat it just minted, leaving no phantom on the roster', async () => {
  // A seat with no process is worse than no seat: the orchestrator sees a
  // handle in the roster and delegates into something that will never answer.
  const { fleet, registry } = fleetHarness({
    spawnImpl: () => { throw new Error('EINVAL') },
  })
  const r = await fleet.spawn({})
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /EINVAL/)
  assert.equal(registry.byHandle('worker-1'), null)
})

test('a worker is listed as starting until its seat joins, which is how readiness is discovered', async () => {
  // Spawn returns once the process is LAUNCHED, matching delegate's own
  // fire-and-forget shape. Readiness is a fact about the seat feed, and
  // Seats already owns that fact.
  const { fleet, registry, seats } = fleetHarness()
  await fleet.spawn({})
  assert.equal(fleet.list()[0].state, 'starting')
  seats.join(registry.byHandle('worker-1'), { write() {} })
  assert.equal(fleet.list()[0].state, 'online')
})

test('a worker that dies on its own is listed as exited rather than silently left online', async () => {
  const { fleet, children, published } = fleetHarness()
  await fleet.spawn({})
  children[0].emit('exit', 1)
  const row = fleet.list()[0]
  assert.equal(row.state, 'exited')
  assert.equal(row.exitCode, 1)
  assert.ok(
    published.some(([e, d]) => e === 'worker' && d.handle === 'worker-1' && d.state === 'exited'),
    'the room must say so, or a browser shows a worker that no longer exists',
  )
})

test('stopping a worker kills its tree, retires its seat and frees the handle', async () => {
  const { fleet, registry, seats, children } = fleetHarness()
  await fleet.spawn({})
  const member = registry.byHandle('worker-1')
  let ended = 0
  seats.join(member, { end() { ended++ }, write() {} })

  assert.deepEqual(fleet.stop('worker-1'), { ok: true })
  assert.equal(ended, 1, 'the seat feed goes with the process')
  assert.equal(registry.byHandle('worker-1'), null, 'and the credential dies with it')
  assert.deepEqual(fleet.list(), [])
  const next = await fleet.spawn({})
  assert.equal(next.handle, 'worker-1', 'the handle is genuinely free again')
  assert.equal(children.length, 2)
})

test('stopping a worker this fleet does not own is refused, never a silent no-op', async () => {
  const { fleet } = fleetHarness()
  const r = fleet.stop('worker-9')
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /worker-9/)
})

test('stopAll stops every worker, so shutting the room down does not orphan opencode', async () => {
  const { fleet } = fleetHarness()
  await fleet.spawn({})
  await fleet.spawn({})
  fleet.stopAll()
  assert.deepEqual(fleet.list(), [])
})

test('a room-wide worker model is used when set, and the launcher default when not', async () => {
  const { fleet, spawned } = fleetHarness()
  await fleet.spawn({ model: 'opencode/other-free' })
  assert.deepEqual(spawned[0].args.slice(-2), ['--model', 'opencode/other-free'])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workers.test.mjs`
Expected: FAIL — `Cannot find module '.../src/workers.mjs'`

- [ ] **Step 3: Implement**

```javascript
// src/workers.mjs
/**
 * The worker fleet: minting a seat, launching it, and tearing it down.
 *
 * A worker is an OpenCode seat in the room. Minting one is `registry.add` of an
 * agent member — the same internal path POST /api/admin/invite takes
 * (src/admin.mjs:99) — and launching it is scripts/room-opencode-seat.mjs,
 * which is what creates the git worktree, starts `opencode serve`, registers
 * the reply-only bridge so the seat can call room_reply, and runs the driver.
 * Launching `opencode` from here would reimplement all four.
 *
 * Ported in logic from extension/src/workers.js, minus its state tracking:
 * that half exists to drive a sidebar from an HTTP event feed, and inside the
 * room `seats` and the supervisor already hold both facts first-hand.
 *
 * `delegatable` is unconditional. A self-spawned worker exists to be delegated
 * to; making that opt-in would be friction with no decision behind it.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentMember } from './identity.mjs'
import { createSupervisor } from './supervisor.mjs'
import { spawnPortable } from './spawn.mjs'

/**
 * The launcher, resolved from this module rather than from cwd: the room is
 * routinely started from the repo being worked on, which is not this checkout.
 */
const LAUNCHER = fileURLToPath(new URL('../scripts/room-opencode-seat.mjs', import.meta.url))

/** The lowest free `worker-N`, so a stopped worker's handle comes back. */
export function nextHandle(existing) {
  const taken = new Set(existing)
  for (let i = 1; ; i++) {
    const h = `worker-${i}`
    if (!taken.has(h)) return h
  }
}

/**
 * Where a handle's worktree lives.
 *
 * Byte-identical to scripts/room-seat.mjs's `worktreeFor`, which is what
 * actually creates the directory (scripts/room-opencode-seat.mjs:44-48).
 * Duplicated rather than imported because src/ must not depend on scripts/ —
 * the dependency runs the other way. test/workers.test.mjs pins the two
 * together so a change to either fails the suite rather than silently
 * verifying in a directory nobody wrote to.
 */
export function worktreeFor(repoRoot, handle) {
  const safe = String(handle).replace(/^@/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return join(repoRoot, '.worktrees', safe)
}

/**
 * argv for scripts/room-opencode-seat.mjs.
 *
 * `model` is omitted when unset so the launcher's own default wins; passing it
 * explicitly would silently pin whatever that happens to be today.
 */
export function workerRecipe({
  repoRoot, handle, token, roomUrl, model = null,
  nodePath = process.execPath, launcher = LAUNCHER, env = process.env,
}) {
  const args = [launcher, handle, '--token', token, '--repo', repoRoot, '--room', roomUrl]
  if (model) args.push('--model', model)
  return {
    cmd: nodePath,
    args,
    opts: {
      // The worktree is created relative to the repo, so this is where the
      // launcher has to run.
      cwd: repoRoot,
      // The token travels in argv, which the launcher reads. Putting it in the
      // environment as well would widen where a seat credential can be read
      // from, and buy nothing.
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  }
}

/**
 * @param {{registry:object, seats:object, config:object, store:object, bus:object,
 *          spawn?:Function, repoRoot:string, roomUrl:string,
 *          log?:Function, now?:() => number}} deps
 */
export function createWorkerFleet({
  registry, seats, config, store, bus,
  spawn = spawnPortable,
  repoRoot, roomUrl,
  log = () => {}, now = Date.now,
}) {
  /** @type {Map<string, {handle:string, model:string|null, memberId:string, worktree:string, state:string, exitCode:number|null, startedAt:number}>} */
  const workers = new Map()
  const supervisor = createSupervisor({ spawn, log })
  const procName = handle => `worker:${handle}`

  supervisor.on('exit', ({ name, code }) => {
    const w = workers.get(name.slice('worker:'.length))
    // An exit for a name this fleet does not own, or a worker already stopped.
    if (!w) return
    w.state = 'exited'
    w.exitCode = code
    log(`${w.handle} exited with code ${code}`)
    bus?.publish?.('worker', { handle: w.handle, state: 'exited', code })
  })

  /**
   * A worker's state is derived, never tracked: `exited` is the supervisor's
   * fact, and "is it ready" is the seat feed's fact, which Seats already owns.
   * A third copy would be the one that goes stale.
   */
  const stateOf = w => (w.state === 'exited' ? 'exited' : seats?.isOnline?.(w.handle) ? 'online' : 'starting')

  const row = w => ({
    handle: w.handle, model: w.model, worktree: w.worktree,
    state: stateOf(w), exitCode: w.exitCode, startedAt: w.startedAt,
  })

  function stop(handle) {
    const w = workers.get(handle)
    if (!w) return { ok: false, errors: [`no worker ${handle} in this fleet`] }
    supervisor.stop(procName(handle))
    workers.delete(handle)
    // The credential dies with the process. Leaving the member behind would
    // leave `@worker-1` on the roster, addressable and permanently offline,
    // and would keep nextHandle from ever handing the name out again.
    seats?.evict?.(w.memberId)
    registry.revoke(w.memberId)
    store?.saveRegistry?.(registry)
    bus?.publish?.('worker', { handle, state: 'stopped' })
    return { ok: true }
  }

  return {
    /**
     * Mint a seat and launch it. Returns once the process is LAUNCHED, which
     * matches `delegate`'s own fire-and-forget shape — readiness is discovered
     * through `list_workers`, the same way every other worker fact is.
     */
    async spawn({ model = null } = {}) {
      const owner = registry.owners?.()[0] ?? null
      if (!owner) {
        // Guessing would mint a seat owned by nobody, whose cost lands nowhere.
        return { ok: false, errors: ['this room has no owner to charge a worker to'] }
      }

      const handle = nextHandle([
        ...workers.keys(),
        ...registry.agents().map(a => a.handle),
        // Names as well as handles: Registry.add enforces neither, and a
        // duplicate name breaks byName for everyone.
        ...registry.all().map(m => String(m.name).toLowerCase()),
      ])
      const member = registry.add(createAgentMember({
        name: handle, handle, ownerId: owner.id, delegatable: true,
      }))
      store?.saveRegistry?.(registry)

      const chosen = model ?? config?.workerModel ?? null
      try {
        supervisor.start(procName(handle), workerRecipe({
          repoRoot, handle, token: member.token, roomUrl, model: chosen,
        }))
      } catch (err) {
        // A seat with no process is worse than no seat: the orchestrator would
        // see the handle and delegate into something that never answers.
        registry.revoke(member.id)
        store?.saveRegistry?.(registry)
        return { ok: false, errors: [`could not start ${handle}: ${err?.message ?? err}`] }
      }

      workers.set(handle, {
        handle, model: chosen, memberId: member.id,
        worktree: worktreeFor(repoRoot, handle),
        state: 'starting', exitCode: null, startedAt: now(),
      })
      bus?.publish?.('worker', { handle, state: 'starting', model: chosen })
      return { ok: true, handle }
    },

    stop,

    stopAll() {
      for (const handle of [...workers.keys()]) stop(handle)
    },

    list() {
      return [...workers.values()].map(row)
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workers.test.mjs`
Expected: PASS — 16 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 795 tests, 793 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/workers.mjs test/workers.test.mjs
git commit -m "feat(room): a worker fleet the room can grow on its own

createWorkerFleet mints a delegatable agent seat through the same
registry.add(createAgentMember(...)) path POST /api/admin/invite uses, then
launches scripts/room-opencode-seat.mjs under the supervisor. Readiness is
derived from Seats and death from the supervisor's exit event, so there is
no third copy of either fact to go stale. Stopping a worker kills the tree,
evicts the seat and revokes the credential, which is what makes the handle
genuinely free for the next one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: the `spawn_worker` channel tool

**Files:**
- Modify: `src/channel.mjs` (`TOOLS` array, ends at line 181; `createChannel` signature line 183; `callTool`, lines 204-230)
- Modify: `test/channel.test.mjs` (append only — the 16 existing tests stay exactly as they are)

**Interfaces:**
- Consumes: an optional `onSpawnWorker(args) -> Promise<{ok:true,handle}|{ok:false,errors}>` callback, the same optional-callback shape as `onDelegate` (`src/channel.mjs:214`) and `onListWorkers` (`src/channel.mjs:226`).
- Produces: MCP tool `spawn_worker` with input `{ model?: string }`, returning text JSON `{"ok":true,"handle":"worker-1"}` or an `isError` result naming the reason.

- [ ] **Step 1: Write the failing test**

```javascript
// test/channel.test.mjs — APPEND to the end of the file. Change nothing above.

test('spawn_worker hands back the new handle as JSON, so it can be addressed at once', async () => {
  const seen = []
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onSpawnWorker: async a => { seen.push(a); return { ok: true, handle: 'worker-1' } },
  })
  const result = await ch.callTool('spawn_worker', { model: 'opencode/x' })
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, handle: 'worker-1' })
  assert.equal(result.isError, undefined)
  assert.deepEqual(seen, [{ model: 'opencode/x' }])
})

test('spawn_worker with no model asks for none, so the launcher\'s own default wins', async () => {
  const seen = []
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onSpawnWorker: async a => { seen.push(a); return { ok: true, handle: 'worker-1' } },
  })
  await ch.callTool('spawn_worker', {})
  assert.equal(seen[0].model, null)
})

test('a refused spawn names the reason, because an orchestrator told only "failed" cannot react', async () => {
  const ch = createChannel({
    config: { roomName: 'r', permissionRelay: false },
    onReply() {}, onDecision() {},
    onSpawnWorker: async () => ({ ok: false, errors: ['this room has no owner to charge a worker to'] }),
  })
  const result = await ch.callTool('spawn_worker', {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /no owner/)
})

test('spawn_worker in a room with no fleet says so rather than reporting a handle it never made', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const result = await ch.callTool('spawn_worker', {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /not enabled/)
})

test('spawn_worker is listed alongside delegate, list_workers, room_reply and room_decision', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const tools = (await ch.listTools()).map(t => t.name)
  assert.deepEqual(tools.sort(), ['delegate', 'list_workers', 'room_decision', 'room_reply', 'spawn_worker'])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/channel.test.mjs`
Expected: FAIL — `spawn_worker` returns `{content:[{text:'unknown tool: spawn_worker'}], isError:true}`, so the JSON parse throws and the tool-list assertion reports four names instead of five.

- [ ] **Step 3: Implement**

In `src/channel.mjs`, add a fifth entry to `TOOLS`, immediately after the `list_workers` entry that currently ends at line 180:

```javascript
  {
    name: 'spawn_worker',
    description:
      'Start a new OpenCode worker seat in this room and get its @handle back. The worker accepts delegated work immediately; it takes a few seconds to come online, which list_workers reports. Use it when the work in front of you splits into parts that do not need this session.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Optional provider/model for this worker, e.g. opencode/mimo-v2.5-free' },
      },
    },
  },
```

Change the `createChannel` signature (line 183) to accept the new callback:

```javascript
export function createChannel({ config, onReply, onDecision, onDelegate, onListWorkers, onSpawnWorker }) {
```

And add the handler inside `callTool`, immediately after the `list_workers` branch (lines 225-228):

```javascript
    if (name === 'spawn_worker') {
      // Awaited: spawning mints a seat and launches a process, so unlike
      // delegate there is no synchronous answer to hand back.
      const result = (await onSpawnWorker?.({ model: a.model ? String(a.model) : null }))
        ?? { ok: false, errors: ['spawning workers is not enabled in this room'] }
      if (!result.ok) {
        // Specific, like a rejected brief: an orchestrator told only "failed"
        // cannot tell a missing binary from a room with no owner.
        return {
          content: [{ type: 'text', text: `spawn_worker failed:\n- ${(result.errors ?? []).join('\n- ')}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, handle: result.handle }) }] }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/channel.test.mjs`
Expected: PASS — 24 tests (19 existing, 5 new).

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 800 tests, 798 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/channel.mjs test/channel.test.mjs
git commit -m "feat(channel): spawn_worker, so the orchestrator can grow its own fleet

Provisioning a worker was an out-of-band, owner-only CLI dance that nothing
inside a session could reach. spawn_worker returns the new @handle as JSON
and fails loudly with a reason, matching delegate's own rejection shape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/spawn-worker` and `POST /api/stop-worker`

**Files:**
- Modify: `src/web.mjs` (deps destructure, lines 73-92; new route beside `POST /api/delegate`, lines 427-444)
- Test: `test/worker-routes.test.mjs`

**Interfaces:**
- Consumes: optional `onSpawnWorker(body)` and `onStopWorker(body)` callbacks on `createWeb`'s deps, wired the same way `onDelegate` is (`src/web.mjs:91`).
- Produces: `POST /api/spawn-worker` (body `{model?}` → `{ok:true,handle}|{ok:false,errors}`) and `POST /api/stop-worker` (body `{handle}` → `{ok:true}|{ok:false,errors}`), owner-only, with the identical 401/403/400/413 handling as `POST /api/delegate`.

**Background:** Spec §1's "HTTP mirror and stop". The extension may run a standalone room with no channel session at all, so the room has to be reachable for this over HTTP or the extension keeps its own duplicate spawn logic — which spec #3 exists to delete.

- [ ] **Step 1: Write the failing test**

```javascript
// test/worker-routes.test.mjs
/**
 * The HTTP mirror of spawn_worker, and its stop.
 *
 * The extension may run a standalone room with no channel session at all, so
 * without these it has no way to reach the fleet and keeps its own duplicate
 * spawn logic. Owner-only for the same reason POST /api/delegate is: this puts
 * a process on somebody's machine and a seat on the room's roster.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, listen, post, done } from './helpers/room.mjs'

test('an owner can spawn a worker over HTTP, which is how a standalone room grows', async () => {
  const calls = []
  const h = harness({}, null, {
    onSpawnWorker: async body => { calls.push(body); return { ok: true, handle: 'worker-1' } },
  })
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.ownerToken}`, { model: 'opencode/x' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, handle: 'worker-1' })
  assert.deepEqual(calls, [{ model: 'opencode/x' }])
  done(h)
})

test('the spawn verdict travels verbatim, so a failure names what actually went wrong', async () => {
  const h = harness({}, null, {
    onSpawnWorker: async () => ({ ok: false, errors: ['could not start worker-1: EINVAL'] }),
  })
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.ownerToken}`, {})
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.errors[0], /EINVAL/)
  done(h)
})

test('a non-owner cannot spawn a worker, because it puts a process on the host', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.anaToken}`, {})
  assert.equal(res.status, 403)
  done(h)
})

test('an unauthenticated spawn is refused', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await post(base, '/api/spawn-worker?token=nope', {})
  assert.equal(res.status, 401)
  done(h)
})

test('a room with no fleet wired says so rather than answering as if it spawned one', async () => {
  const h = harness()
  const base = await listen(h.server)
  const res = await post(base, `/api/spawn-worker?token=${h.ownerToken}`, {})
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.errors[0], /not enabled/)
  done(h)
})

test('an owner can stop a worker by handle', async () => {
  const calls = []
  const h = harness({}, null, { onStopWorker: async body => { calls.push(body); return { ok: true } } })
  const base = await listen(h.server)
  const res = await post(base, `/api/stop-worker?token=${h.ownerToken}`, { handle: 'worker-1' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(calls, [{ handle: 'worker-1' }])
  done(h)
})

test('a non-owner cannot stop a worker, because that is somebody else\'s work in flight', async () => {
  const h = harness({}, null, { onStopWorker: async () => ({ ok: true }) })
  const base = await listen(h.server)
  const res = await post(base, `/api/stop-worker?token=${h.anaToken}`, { handle: 'worker-1' })
  assert.equal(res.status, 403)
  done(h)
})

test('a malformed body is a 400, not a 500', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await fetch(`${base}/api/spawn-worker?token=${h.ownerToken}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  })
  assert.equal(res.status, 400)
  done(h)
})

test('an oversized body is refused rather than buffered, same as every other route', async () => {
  const h = harness({}, null, { onSpawnWorker: async () => ({ ok: true, handle: 'worker-1' }) })
  const base = await listen(h.server)
  const res = await fetch(`${base}/api/spawn-worker?token=${h.ownerToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(1024 * 1024 + 16),
  })
  assert.equal(res.status, 413)
  done(h)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/worker-routes.test.mjs`
Expected: FAIL — every case gets `404 {"error":"not found"}` from the fall-through at `src/web.mjs:757`.

- [ ] **Step 3: Implement**

In `src/web.mjs`, add the two callbacks to the deps destructure, immediately after `onDelegate` (line 91):

```javascript
    // The fleet's two entry points, mirrored from the channel's spawn_worker
    // the same way onDelegate mirrors the delegate tool. The fleet itself
    // lives in src/workers.mjs and is wired in server.mjs — this module must
    // not know who owns a worker process, exactly as it must not know who
    // tracks a delegation.
    onSpawnWorker,
    onStopWorker,
```

Then add one route block immediately after the `POST /api/delegate` block (which ends at line 444):

```javascript
      if (req.method === 'POST' && (path === '/api/spawn-worker' || path === '/api/stop-worker')) {
        const member = memberFrom(req, url, null)
        if (!member) return json(res, 401, { error: 'bad token' })
        // Starting a worker puts a process and a git worktree on the host, and
        // stopping one kills work that may be in flight. Both are owner
        // actions, exactly like delegating onto somebody's seat.
        if (member.role !== 'owner') return json(res, 403, { error: 'owner-only' })
        let body = {}
        try {
          const read = await readBody(req)
          if (read.tooLarge) return json(res, 413, { error: 'body too large' })
          body = JSON.parse(read.buf.toString('utf8') || '{}')
        } catch {
          return json(res, 400, { error: 'bad json' })
        }
        const fn = path === '/api/spawn-worker' ? onSpawnWorker : onStopWorker
        // The verdict travels verbatim, same as a delegate rejection: "failed"
        // alone leaves the caller with nothing to act on.
        return json(res, 200, (await fn?.(body)) ?? { ok: false, errors: ['worker spawning is not enabled in this room'] })
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/worker-routes.test.mjs`
Expected: PASS — 9 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 809 tests, 807 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/web.mjs test/worker-routes.test.mjs
git commit -m "feat(web): POST /api/spawn-worker and /api/stop-worker

The extension may drive a standalone room with no channel session, so the
fleet has to be reachable over HTTP or the extension keeps spawning workers
itself. Owner-only, with the same 401/403/400/413 handling as
POST /api/delegate, and the verdict travels verbatim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `verified` on the reply path

**Files:**
- Modify: `src/channel.mjs` (`buildDelegationResultNotification`, lines 94-107)
- Modify: `src/delegation.mjs` (`createDelegator` signature line 126-130; `onSeatReply`, lines 197-212)
- Test: `test/delegation-verify.test.mjs`

**Interfaces:**
- Consumes: an optional injected `verify(record, handle) -> Promise<{ran, ok, exitCode, output, timedOut}>` on `createDelegator`. Shape supplied by `verifyDelegation` (Task 2); the handle is a parameter because the worktree is per-seat and only known at reply time.
- Produces: `delegation-result` notification meta gains `verified` (`"true"` | `"false"` | `"none"`) and `verification` (exit code plus truncated output); the `delegation` bus event with `state:'done'` gains the same two fields.

**Background:** Spec §2 and §3. With no `verify` injected, `createDelegator` is byte-identical to today — which is what keeps all 17 cases in `test/delegation-result.test.mjs` passing untouched. `sanitizeMeta` (`src/channel.mjs:14-21`) already drops null values, so an absent field simply does not appear and every existing consumer keeps working.

- [ ] **Step 1: Write the failing test**

```javascript
// test/delegation-verify.test.mjs
/**
 * Verified results: what the worker SAID, and what actually HAPPENED.
 *
 * onSeatReply closes a delegation the moment any reply arrives, and nothing
 * confirmed the claim. Now the room runs the delegation's own spec.tests —
 * written by the orchestrator, not by the worker — and reports the real exit
 * code alongside the worker's words.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegator } from '../src/delegation.mjs'
import { buildDelegationResultNotification } from '../src/channel.mjs'
import { Queue } from '../src/queue.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'
import { Seats } from '../src/seats.mjs'
import { loadConfig } from '../src/config.mjs'
import { Registry, createMember, createAgentMember } from '../src/identity.mjs'
import { waitUntil } from './helpers/room.mjs'

const ORCHESTRATOR = { id: 'orchestrator', name: 'claude', role: 'member', muted: false }
const EXEC = { class: 'execution', task: 'add mul()', spec: { files: ['math.js'], tests: ['node --test'] } }
const REASONING = { class: 'reasoning', task: 'which cache strategy?' }

function delegator(verify) {
  const registry = new Registry()
  const ana = registry.add(createMember({ name: 'ana', role: 'member' }))
  const agent = registry.add(createAgentMember({
    name: 'worker-1', handle: 'worker-1', ownerId: ana.id, delegatable: true,
  }))
  const seats = new Seats()
  seats.join(agent, { id: 'c1' })
  const queue = new Queue({
    config: loadConfig({ ROOM_HANDLES: 'claude' }), registry, seats,
    ledger: new Ledger(), decisions: new Decisions(),
  })
  const published = []
  const notified = []
  const d = createDelegator({
    queue,
    orchestrator: ORCHESTRATOR,
    store: { appendMessage() {} },
    bus: { publish: (e, data) => published.push([e, data]) },
    channel: { notifyDelegationResult: r => { notified.push(r); return r } },
    drain() {},
    now: () => 1,
    verify,
  })
  const doneEvents = () => published.filter(([e, x]) => e === 'delegation' && x.state === 'done').map(([, x]) => x)
  return { d, queue, published, notified, doneEvents }
}

const PASSED = { ran: true, ok: true, exitCode: 0, output: 'pass 12\n', timedOut: false }
const FAILED = { ran: true, ok: false, exitCode: 1, output: 'not ok 3 - mul\n', timedOut: false }

test('an execution result waits for the real test run rather than closing on the claim', async () => {
  // The whole point: "added mul(), tests pass" is a sentence, not evidence.
  let release
  const gate = new Promise(r => { release = r })
  const { d, queue, notified, doneEvents } = delegator(() => gate)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()

  d.onSeatReply('worker-1', 'added mul(), tests pass')
  assert.deepEqual(notified, [], 'nothing may be reported before the tests have actually run')
  assert.deepEqual(doneEvents(), [])

  release(PASSED)
  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'true')
})

test('a verified result carries both what the worker said and what the room measured', async () => {
  const { d, queue, notified, doneEvents } = delegator(async () => PASSED)
  const r = d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'added mul(), tests pass')
  await waitUntil(() => notified.length === 1)

  assert.equal(notified[0].id, r.id)
  assert.equal(notified[0].text, 'added mul(), tests pass', 'the worker\'s words are untouched')
  assert.equal(notified[0].verified, 'true')
  assert.match(notified[0].verification, /exit 0/)
  const [event] = doneEvents()
  assert.equal(event.verified, 'true', 'the SSE feed sees it too, or the extension relays a claim')
})

test('a failing verification comes back as a result with the real output, not a dead end', async () => {
  // Structurally identical to a rejected brief from the orchestrator's side:
  // evidence plus a decision to make. The room does not retry — it cannot
  // rewrite a brief based on WHY something failed, and that is judgment.
  const { d, queue, notified } = delegator(async () => FAILED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'all done, everything passes')
  await waitUntil(() => notified.length === 1)

  assert.equal(notified[0].verified, 'false')
  assert.match(notified[0].verification, /exit 1/)
  assert.match(notified[0].verification, /not ok 3/, 'the real output is what makes it repairable')
})

test('a timed-out verification is reported as a timeout, not as a passing exit code', async () => {
  const { d, queue, notified } = delegator(async () => ({
    ran: true, ok: false, exitCode: null, output: '', timedOut: true,
  }))
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'false')
  assert.match(notified[0].verification, /timed out/)
})

test('verification is handed the delegation\'s own tests and the seat that ran them', async () => {
  // The worktree is per-seat, so the handle is what decides where this runs.
  const seen = []
  const { d, queue, notified } = delegator(async (record, handle) => {
    seen.push({ tests: record.spec.tests, handle, class: record.class })
    return PASSED
  })
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  await waitUntil(() => notified.length === 1)
  assert.deepEqual(seen, [{ tests: ['node --test'], handle: 'worker-1', class: 'execution' }])
})

test('a reasoning delegation reports verified=none, because there is nothing mechanical to check', async () => {
  // Collapsing "unchecked" into "unverified" would libel every reasoning task.
  const calls = []
  const { d, queue, notified } = delegator(async () => { calls.push(1); return PASSED })
  d.delegate({ ...REASONING, to: '@worker-1' })
  queue.beginTurn()
  const results = d.onSeatReply('worker-1', 'use a write-through cache')
  assert.equal(results.length, 1, 'with nothing to run, the answer is immediate as before')
  assert.equal(notified[0].verified, 'none')
  assert.deepEqual(calls, [], 'and no command is run at all')
})

test('a verification that throws is reported, never swallowed into a silent success', async () => {
  const { d, queue, notified } = delegator(async () => { throw new Error('worktree is gone') })
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'false')
  assert.match(notified[0].verification, /worktree is gone/)
})

test('a delegation is still answered exactly once, even while verification is in flight', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const { d, queue, notified } = delegator(() => gate)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  d.onSeatReply('worker-1', 'done')
  assert.deepEqual(d.onSeatReply('worker-1', 'and one more thing'), [], 'the record is taken synchronously')
  release(PASSED)
  await waitUntil(() => notified.length === 1)
  assert.equal(notified.length, 1)
})

test('a delegator with no verify wired behaves exactly as it always has', async () => {
  // Every existing caller and every existing test depends on this.
  const { d, queue, notified, doneEvents } = delegator(undefined)
  d.delegate({ ...EXEC, to: '@worker-1' })
  queue.beginTurn()
  const results = d.onSeatReply('worker-1', 'added mul()')
  assert.equal(results.length, 1)
  assert.equal(notified[0].verified, undefined)
  assert.equal(doneEvents()[0].verified, undefined)
})

test('the notification carries verified and verification as meta, never in the worker\'s words', async () => {
  const nt = buildDelegationResultNotification(
    {
      id: 'del-1', handle: 'worker-1', class: 'execution', task: 'add mul()',
      text: 'added mul()', verified: 'false', verification: 'exit 1\nnot ok 3',
    },
    { roomName: 'room' },
  )
  assert.equal(nt.params.content, 'added mul()', 'the seat\'s words stay byte-identical')
  assert.equal(nt.params.meta.verified, 'false')
  assert.match(nt.params.meta.verification, /not ok 3/)
  for (const k of Object.keys(nt.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/)
})

test('an unverified result omits the fields entirely, so existing consumers are unaffected', () => {
  const nt = buildDelegationResultNotification(
    { id: 'del-1', handle: 'worker-1', class: 'reasoning', task: 't', text: 'answer' },
    { roomName: 'room' },
  )
  assert.equal('verified' in nt.params.meta, false)
  assert.equal('verification' in nt.params.meta, false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/delegation-verify.test.mjs`
Expected: FAIL — `createDelegator` ignores `verify`, so `notified[0].verified` is `undefined` everywhere and the first test's "nothing may be reported yet" assertion fails with one notification already present.

- [ ] **Step 3: Implement**

In `src/channel.mjs`, extend `buildDelegationResultNotification`'s meta (currently lines 100-106) to:

```javascript
  return channelEvent(text, {
    room: roomName,
    kind: 'delegation-result',
    delegation_id: result.id,
    handle: result.handle,
    // The task class labels the work; it never routed anything, and it does
    // not start doing so here.
    class: result.class,
    task: result.task,
    // What the room MEASURED, beside what the worker SAID. "true"/"false" when
    // the delegation's own tests were run, "none" when the class had none to
    // run. Absent when the room did not check at all, which sanitizeMeta drops
    // for us — so every consumer written before this keeps working unchanged.
    verified: result.verified ?? null,
    verification: result.verification ?? null,
    // Why a turn ended without a reply, on the abandoned path only.
    reason: result.reason ?? null,
  })
```

In `src/delegation.mjs`, add the summariser above `createDelegator` (before line 126):

```javascript
/**
 * One line of evidence for a verification run, for the meta field.
 *
 * The output is already bounded to 2048 bytes by src/verify.mjs; a timeout has
 * no exit code to quote, so it says so rather than printing `exit null`.
 */
export const summarizeVerification = v =>
  !v?.ran
    ? 'no tests to run'
    : `${v.timedOut ? 'timed out' : `exit ${v.exitCode}`}${v.output ? `\n${v.output}` : ''}`
```

Change the `createDelegator` signature (lines 126-130) to take `verify`:

```javascript
export function createDelegator({
  queue, store, bus, channel, drain, orchestrator,
  // Runs a finished delegation's own spec.tests in the worker's worktree and
  // resolves with src/verify.mjs's verifyDelegation shape. Injected and
  // optional: with nothing supplied this module behaves exactly as it did
  // before verification existed, which is what a room (or a test) that has no
  // worktrees to check needs.
  verify = null,
  pending = new PendingDelegations(),
  now = Date.now,
}) {
```

Add the reporting helper as the first thing inside the returned object's scope — put it directly above the `return {` (i.e. after the signature, before `return {` on line 131):

```javascript
  /**
   * The one place a finished delegation is reported. With `extra` empty this is
   * byte-identical to what this module has always published.
   */
  const report = (record, handle, text, extra = {}) => {
    const nt = channel.notifyDelegationResult({ ...record, handle, text, ...extra })
    bus.publish('delegation', { ...record, to: handle, state: 'done', text, ...extra })
    return nt
  }
```

Replace `onSeatReply`'s body (lines 197-212) with:

```javascript
    onSeatReply(handle, text) {
      const turn = queue?.inflightFor?.(handle)
      const results = []
      for (const m of turn?.messages ?? []) {
        if (m.kind !== 'delegation') continue
        // Taken synchronously whatever happens next: a delegation is answered
        // exactly once, and a verification that takes two minutes must not
        // leave a window where the seat's next reply answers it again.
        const record = pending.take(m.id)
        if (!record) continue

        if (!verify) {
          results.push(report(record, handle, text))
          continue
        }
        if (record.class !== 'execution') {
          // reasoning/verification briefs carry no spec.tests — there is
          // nothing mechanical to check, and saying so is not the same as
          // saying the work failed.
          results.push(report(record, handle, text, { verified: 'none' }))
          continue
        }

        // Verification spawns a real test command, so it cannot be awaited
        // here: this runs inside POST /seat/reply (src/web.mjs:681), which has
        // to answer the seat at once. The result is delivered on the channel
        // when it settles, which is the same shape the orchestrator already
        // handles — a delegation-result arriving minutes after the call.
        void Promise.resolve(verify(record, handle))
          .then(v => report(record, handle, text, {
            verified: v.ran ? (v.ok ? 'true' : 'false') : 'none',
            verification: summarizeVerification(v),
          }))
          .catch(err => report(record, handle, text, {
            // A verification that could not run is not a pass. Reporting it as
            // one would be the exact failure this feature exists to prevent,
            // arriving through the room's own door instead of the worker's.
            verified: 'false',
            verification: `verification could not run: ${String(err?.message ?? err)}`,
          }))
      }
      return results
    },
```

Note the deliberate contract change in the doc comment above `onSeatReply` (line 196): the returned array is now *the results available synchronously*. Update that line to say so:

```javascript
     * @returns {object[]} one notification per delegation answered synchronously;
     *   empty when this reply answers no delegation, and also empty for an
     *   execution delegation whose verification is still running — that one
     *   arrives on the channel when the tests finish.
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/delegation-verify.test.mjs test/delegation-result.test.mjs test/channel.test.mjs`
Expected: PASS — 11 + 18 + 24 tests, with every pre-existing case untouched.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 820 tests, 818 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/delegation.mjs src/channel.mjs test/delegation-verify.test.mjs
git commit -m "feat(delegation): report what happened, not just what the worker claimed

A reply closed an execution delegation the moment it arrived and nothing
confirmed the claim. With a verify dependency injected, the room runs the
delegation's own spec.tests and the result carries verified=true/false/none
plus the real exit code and output. The worker's words travel unchanged in
content; the measurement travels in meta. With no verify wired the module is
byte-identical to before, so every existing caller and test is unaffected.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: verification on the silent-worker path

**Files:**
- Modify: `src/delegation.mjs` (`onTurnAbandoned`, lines 225-231)
- Modify: `test/delegation-verify.test.mjs` (append only)

**Interfaces:**
- Consumes: the same injected `verify(record, handle)` from Task 6.
- Produces: the `delegation` bus event with `state:'abandoned'` gains `verified`, `verification`, and `likelySucceeded:true` when verification passes despite no reply; a `delegation-result` notification is sent on that one branch so the orchestrator — which only reads the channel — actually learns.

**Background:** Spec §4. This project has already observed the case for real: `docs/opencode-seat.md` records the free model completing an edit and never calling `room_reply`, before the `REPLY_DIRECTIVE` prompt fix. Today that reports as an undifferentiated abandonment and whatever it produced goes unexamined.

- [ ] **Step 1: Write the failing test**

```javascript
// test/delegation-verify.test.mjs — APPEND. Change nothing above.

const abandonedEvents = published =>
  published.filter(([e, x]) => e === 'delegation' && x.state === 'abandoned').map(([, x]) => x)

test('a worker that did the work but never replied is reported as likely succeeded', async () => {
  // Observed for real in docs/opencode-seat.md: the model completed a genuine
  // edit and simply never called room_reply. Reported as a bare abandonment,
  // the orchestrator re-delegates work that is already done.
  const { d, queue, published, notified } = delegator(async () => PASSED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'seat-disconnected')
  await waitUntil(() => abandonedEvents(published).length === 1)

  const [event] = abandonedEvents(published)
  assert.equal(event.likelySucceeded, true)
  assert.equal(event.verified, 'true')
  assert.equal(event.reason, 'seat-disconnected')

  await waitUntil(() => notified.length === 1)
  assert.equal(notified[0].verified, 'true')
  assert.match(notified[0].text, /never reported back/, 'the orchestrator only ever reads the channel')
  assert.equal(notified[0].reason, 'seat-disconnected')
})

test('a real abandonment is still a real abandonment when the tests do not pass', async () => {
  const { d, queue, published, notified } = delegator(async () => FAILED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'no-response')
  await waitUntil(() => abandonedEvents(published).length === 1)

  const [event] = abandonedEvents(published)
  assert.equal(event.likelySucceeded, undefined, 'nothing may claim success here')
  assert.equal(event.verified, 'false')
  assert.deepEqual(notified, [], 'and there is no result to hand back — there is no result')
})

test('an abandoned reasoning delegation is reported exactly as it is today', async () => {
  // No spec.tests means unavoidably unknown. Inventing an answer would be
  // worse than the silence.
  const calls = []
  const { d, queue, published } = delegator(async () => { calls.push(1); return PASSED })
  d.delegate({ ...REASONING, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'no-response')

  const [event] = abandonedEvents(published)
  assert.equal(event.reason, 'no-response')
  assert.equal(event.likelySucceeded, undefined)
  assert.deepEqual(calls, [])
})

test('an abandoned delegation is released from pending whether or not it is verified', async () => {
  // Left behind, a stale record is worse than a leak: the seat's next
  // unrelated reply would come back as this dead delegation's result.
  const { d, queue } = delegator(async () => PASSED)
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'seat-disconnected')
  assert.equal(d.pending.size, 0, 'released synchronously, before any test has run')
})

test('a verification that throws on the abandoned path still reports the abandonment', async () => {
  const { d, queue, published } = delegator(async () => { throw new Error('worktree is gone') })
  d.delegate({ ...EXEC, to: '@worker-1' })
  const turn = queue.beginTurn()
  d.onTurnAbandoned('worker-1', turn, 'no-response')
  await waitUntil(() => abandonedEvents(published).length === 1)
  assert.equal(abandonedEvents(published)[0].likelySucceeded, undefined)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/delegation-verify.test.mjs`
Expected: FAIL — `onTurnAbandoned` never calls `verify`, so `event.likelySucceeded` is `undefined` and `notified` stays empty in the first case.

- [ ] **Step 3: Implement**

Replace `onTurnAbandoned`'s body in `src/delegation.mjs` (lines 225-231) with:

```javascript
    onTurnAbandoned(dest, turn, reason = 'abandoned') {
      for (const m of turn?.messages ?? []) {
        if (m.kind !== 'delegation') continue
        const record = pending.take(m.id)
        if (!record) continue

        const abandon = extra => bus.publish('delegation', { ...record, to: dest, state: 'abandoned', reason, ...extra })

        if (!verify || record.class !== 'execution') {
          // Nothing mechanical to check: unavoidably unknown, reported as it
          // always has been. Inventing an outcome would be worse than silence.
          abandon({})
          continue
        }

        // Silence is not the same as failure. A worker that did the work and
        // simply never called room_reply has happened for real in this project
        // (docs/opencode-seat.md), and the thing it produced is sitting in the
        // worktree either way — so look before concluding.
        void Promise.resolve(verify(record, dest))
          .then(v => {
            const likelySucceeded = v.ran && v.ok === true
            abandon({
              verified: v.ran ? (v.ok ? 'true' : 'false') : 'none',
              verification: summarizeVerification(v),
              ...(likelySucceeded ? { likelySucceeded: true } : {}),
            })
            if (!likelySucceeded) return
            // The orchestrator only ever reads the channel — the bus event
            // above reaches browsers and the extension, and nothing else. A
            // genuinely-completed piece of work would otherwise be
            // re-delegated because the only party who could use it never hears.
            //
            // The content here is the ROOM's sentence, not a worker's: there
            // are no words to carry verbatim, because none were ever sent.
            channel.notifyDelegationResult({
              ...record,
              handle: dest,
              reason,
              text: `@${dest} never reported back, but the room ran this delegation's own tests in its worktree and they pass. The work is likely done — check ${record.spec?.files?.join(', ') || 'the worktree'} rather than delegating it again.`,
              verified: 'true',
              verification: summarizeVerification(v),
            })
          })
          .catch(() => abandon({}))
      }
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/delegation-verify.test.mjs test/delegation-result.test.mjs`
Expected: PASS — 16 + 18 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 825 tests, 823 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/delegation.mjs test/delegation-verify.test.mjs
git commit -m "feat(delegation): tell a silent worker apart from a failed one

A worker that did real work and never called room_reply reported as an
undifferentiated abandonment, and whatever it produced went unexamined -
observed for real in docs/opencode-seat.md before the REPLY_DIRECTIVE fix.
On abandonment the room now runs the same verification against the worktree:
passing means likelySucceeded, and the orchestrator is told on the channel,
which is the only place it reads. Failing or unverifiable is reported exactly
as it is today.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: wire it into the running room

**Files:**
- Modify: `src/config.mjs` (`loadConfig` return, lines 40-93)
- Modify: `src/server.mjs` (imports line 17-30; `let delegator = null` line 99; `createChannel` lines 101-121; `createWeb` lines 183-193; `createDelegator` lines 195-197; `web.listen` callback lines 199-211)
- Modify: `test/config.test.mjs` (append only)
- Test: `test/worker-wiring.test.mjs`

**Interfaces:**
- Consumes: `createWorkerFleet`, `worktreeFor` (Task 3), `verifyDelegation` (Task 2).
- Produces: a live fleet reachable from the `spawn_worker` tool and both HTTP routes; `createDelegator` gets its `verify`; `config.repoRoot`, `config.verifyTimeoutMs`, `config.workerModel`.

**Background:** The fleet's `roomUrl` needs the port, and with `ROOM_PORT=0` the port is not known until the socket is bound (`src/server.mjs:199-203`). So the fleet is declared before the channel and assigned inside the listen callback — exactly the pattern `delegator` already uses for the same class of reason (`src/server.mjs:96-99`).

- [ ] **Step 1: Write the failing test**

```javascript
// test/worker-wiring.test.mjs
/**
 * The fleet and verification, wired into a real booted room.
 *
 * Deliberately never asks a real room to actually spawn a worker: that would
 * launch `opencode` and create a git worktree, which no test in this suite is
 * allowed to do. What is proved here is that the routes exist and are gated —
 * the behaviour behind them is covered by test/workers.test.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootRoom } from './helpers/room.mjs'

test('a booted room answers the worker routes rather than 404ing them', async () => {
  const room = await bootRoom({ ROOM_STANDALONE: '1' })
  try {
    const res = await fetch(`http://127.0.0.1:${room.port}/api/spawn-worker?token=nope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    // 401, not 404: the route is wired, and it refuses an unknown token before
    // it does anything that would put a process on the host.
    assert.equal(res.status, 401)

    const stop = await fetch(`http://127.0.0.1:${room.port}/api/stop-worker?token=nope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(stop.status, 401)
  } finally {
    room.child.kill()
  }
})

test('stopping a worker the room never started is refused by name, not by crashing', async () => {
  const room = await bootRoom({ ROOM_STANDALONE: '1' })
  try {
    const res = await fetch(`http://127.0.0.1:${room.port}/api/stop-worker?token=${room.ownerToken}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'worker-9' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.match(body.errors[0], /worker-9/)
  } finally {
    room.child.kill()
  }
})
```

```javascript
// test/config.test.mjs — APPEND. Change nothing above.

test('the repo a worker gets its worktree in defaults to where the room was started', () => {
  assert.equal(loadConfig({}).repoRoot, process.cwd())
  assert.equal(loadConfig({ ROOM_REPO: '/other/repo' }).repoRoot, '/other/repo')
})

test('verification carries its own deadline, independent of a worker\'s turn timeout', () => {
  // Spec §2.4: a hanging test command must not wedge a delegation forever, and
  // the number that bounds it is not the one that bounds the worker.
  assert.equal(loadConfig({}).verifyTimeoutMs, 120_000)
  assert.equal(loadConfig({ ROOM_VERIFY_TIMEOUT_MS: '5000' }).verifyTimeoutMs, 5000)
})

test('an unset worker model stays null, so the launcher\'s own default wins', () => {
  assert.equal(loadConfig({}).workerModel, null)
  assert.equal(loadConfig({ ROOM_WORKER_MODEL: 'opencode/x' }).workerModel, 'opencode/x')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/worker-wiring.test.mjs test/config.test.mjs`
Expected: FAIL — the booted room 404s both routes (no `onSpawnWorker` is wired in `server.mjs`), and `loadConfig({}).repoRoot` is `undefined`.

- [ ] **Step 3: Implement**

In `src/config.mjs`, add three fields to the object `loadConfig` returns — put them directly after `keepaliveMs` (line 70):

```javascript
    // The repo a self-spawned worker gets its git worktree in, and the
    // directory the launcher runs from. The room is normally started from the
    // repo being worked on; ROOM_REPO is for when it is not — the room's own
    // checkout and the work's checkout are not always the same tree.
    repoRoot: env.ROOM_REPO || process.cwd(),
    // Verification's own deadline (spec §2.4), deliberately independent of a
    // worker's turn deadline: a hanging test command must not wedge a
    // delegation forever, and the worker's number does not bound the room's.
    verifyTimeoutMs: int(env.ROOM_VERIFY_TIMEOUT_MS, 120_000),
    // Model for self-spawned workers. Null lets the launcher's own default
    // win rather than silently pinning whatever it happens to be today.
    workerModel: env.ROOM_WORKER_MODEL || null,
```

In `src/server.mjs`, add two imports after line 30:

```javascript
import { createWorkerFleet, worktreeFor } from './workers.mjs'
import { verifyDelegation } from './verify.mjs'
```

Replace the `let delegator = null` block (lines 96-99) with:

```javascript
// The delegate tool needs the queue AND a way to drain it, and drain lives on
// the web server, which is built further down. Declared here and assigned once
// both exist; the channel only ever reaches it at runtime, long after that.
let delegator = null

// The fleet needs the room's own URL, and with ROOM_PORT=0 the port is not
// known until the socket is bound — so, for the same reason and in the same
// shape as `delegator` above, it is declared here and assigned in listen().
let fleet = null
const noFleet = { ok: false, errors: ['the room is not listening yet'] }
```

Add the callback to `createChannel`, after `onListWorkers` (line 120):

```javascript
  onSpawnWorker: a => (fleet ? fleet.spawn({ model: a?.model ?? null }) : noFleet),
```

Add both callbacks to `createWeb`, after `onDelegate` (line 192):

```javascript
  // The same fleet the spawn_worker tool reaches, over HTTP — for the
  // extension, which may drive a standalone room with no channel session.
  onSpawnWorker: body => (fleet ? fleet.spawn({ model: body?.model ?? null }) : noFleet),
  onStopWorker: body => (fleet ? fleet.stop(String(body?.handle ?? '')) : noFleet),
```

Give `createDelegator` its `verify` (lines 195-197):

```javascript
delegator = createDelegator({
  queue, store, bus, channel, orchestrator: ORCHESTRATOR, drain: () => web.drain(),
  // Spec §2: a finished execution delegation is checked by re-running the
  // orchestrator's own spec.tests in the seat's worktree. Every OpenCode and
  // Claude seat launcher puts its worktree in the same place, so this is the
  // right directory for a hand-minted seat as much as a self-spawned one.
  verify: (record, handle) => verifyDelegation({
    tests: record.spec?.tests,
    cwd: worktreeFor(config.repoRoot, handle),
    timeoutMs: config.verifyTimeoutMs,
  }),
})
```

Create the fleet inside the `web.listen` callback, immediately after the `config.port = web.address().port` line (line 201):

```javascript
  // Built here, not above: the fleet hands each worker the room's URL, and
  // with ROOM_PORT=0 that URL does not exist until this moment.
  //
  // Loopback, not config.advertise: a worker is always a local child process
  // on this same machine, never a remote one, so it should reach the room the
  // way every other local-only reference already does — extension.js's own
  // roomUrl for its worker pool is hardcoded to 127.0.0.1 for exactly this
  // reason. config.advertise exists for join links a browser opens from
  // somewhere else, which is a different question with a different answer;
  // using it here would make a self-spawned worker's own connection depend on
  // whatever the room happens to be published as, for no benefit.
  fleet = createWorkerFleet({
    registry, seats, config, store, bus,
    repoRoot: config.repoRoot,
    roomUrl: `http://127.0.0.1:${config.port}`,
    log,
  })
```

And add shutdown, after the `web.on('error', ...)` line (line 213):

```javascript
// The room owns its workers' processes now, so it owns reaping them. Without
// this, Ctrl-C leaves an `opencode serve` per worker holding a port and a
// worktree — the exact stray-process hunt the tree kill exists to prevent.
const shutdown = () => {
  try { fleet?.stopAll() } catch { /* shutdown must never hang or throw */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/worker-wiring.test.mjs test/config.test.mjs`
Expected: PASS — 2 + 11 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS — 830 tests, 828 passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/config.mjs src/server.mjs test/worker-wiring.test.mjs test/config.test.mjs
git commit -m "feat(room): wire the fleet and verification into the running room

The fleet is created inside listen() because a worker is handed the room's
own URL and, with ROOM_PORT=0, that URL does not exist until the socket is
bound - the same reason and the same shape as the existing late-assigned
delegator. SIGINT/SIGTERM now reap the fleet: the room owns these processes,
so it owns not orphaning them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: documentation

**Files:**
- Modify: `README.md` (Status, line 54; Install, line 181; the `delegate` tool section, around lines 430-470; Testing, around line 768)
- Modify: `ARCHITECTURE.md` (module table, lines 30-47; §3 Delegation, lines 128-158; §6 Testing, lines 247-254)

**Interfaces:** none — prose only.

**Background:** Both files quote **549 tests, 548 passing, 1 skipped** and "10 extension test files". The real numbers before this plan are 756 / 754 / 2 skipped, 40 room files and 22 extension files; after this plan, whatever Task 8's `node --test` printed. A stale count in the one document a reader uses to sanity-check their own run is worse than no count.

- [ ] **Step 1: Re-measure, so the number written down is one that was observed**

Run: `node --test 2>&1 | tail -8`
Record the `tests` / `pass` / `skipped` lines. Run `ls test/*.test.mjs | wc -l` and `ls extension/test/*.test.js | wc -l` for the file counts. Use those exact numbers below — do not copy the numbers this plan predicts.

- [ ] **Step 2: Update `README.md`**

Replace the count in the Status section (line 54) and the Install block (line 181) with the measured figures, and note that both skips are opt-in endurance runs rather than "1 skipped".

Add this after the `delegate` tool section's closing paragraph (the one ending "a seat that never…"), as a new `### Spawning and verifying workers` subsection:

```markdown
### Spawning and verifying workers

The shared session can grow its own fleet. `spawn_worker` mints a delegatable
OpenCode seat and launches it, and returns its handle at once:

```
spawn_worker({})                      -> {"ok":true,"handle":"worker-1"}
spawn_worker({ model: "opencode/x" }) -> {"ok":true,"handle":"worker-2"}
```

The handle is addressable the moment the tool returns; the seat itself takes a
few seconds to come online, which `list_workers` reports. There is no cap on how
many workers you may start — OpenCode's free tier makes token cost a non-issue,
so the real ceiling is local processes and worktrees, and `list_workers` is what
keeps an oversized fleet visible rather than silent. Both are mirrored over HTTP
for the extension, owner-only like every other room-mutating route:

```
POST /api/spawn-worker  {"model":"opencode/x"}  -> {"ok":true,"handle":"worker-1"}
POST /api/stop-worker   {"handle":"worker-1"}   -> {"ok":true}
```

Stopping a worker kills its **process tree**, ends its seat feed, and revokes
its credential, which is what makes the handle genuinely free for the next one.

**A worker's success claim is not taken on faith.** When a `class: "execution"`
delegation is answered, the room runs that delegation's own `spec.tests` itself,
in the worker's worktree (`.worktrees/<handle>`), under its own timeout
(`ROOM_VERIFY_TIMEOUT_MS`, 120s by default — independent of the worker's turn
deadline). The result comes back with both halves:

```
verified="true"   the tests the brief named actually pass
verified="false"  they do not; verification carries the real exit code and output
verified="none"   a reasoning/verification class, which has no tests to run
```

A `verified="false"` result is not a dead end — it is structurally the same
thing as a rejected brief: evidence, and a decision for the orchestrator to
make. The room never retries and never rewrites a brief, because it cannot
reason about *why* something failed.

The same check runs when a worker never answers at all. If its tests pass
despite the silence, the abandonment is reported as **likely succeeded** rather
than as a mystery — the free model completing a real edit and forgetting to call
`room_reply` is a case this project has actually observed. Nothing about the
command is a shell: it is tokenised into a program plus argv, so `&&`, pipes and
globs are not interpreted. Two commands means two entries in `tests`.
```

- [ ] **Step 3: Update `ARCHITECTURE.md`**

Add three rows to the module table (after the `spawn.mjs` row, line 47):

```markdown
| `supervisor.mjs` | supervised children; kills process **trees**, not processes |
| `workers.mjs` | the fleet: mint a seat, launch it, stop it, list it |
| `verify.mjs` | re-runs a delegation's own `spec.tests`, bounded |
```

Update the line count and module count in the paragraph above it (line 26-27) to what `grep -c "" src/*.mjs` and `ls src/*.mjs | wc -l` now report.

Add to §3 Delegation's bullet list (after line 136):

```markdown
- `src/workers.mjs` + `src/supervisor.mjs` — `spawn_worker` on the channel and
  `POST /api/spawn-worker` / `POST /api/stop-worker` over HTTP, both owner-only
- `src/verify.mjs` — the room runs the brief's own `spec.tests` itself
```

And add this paragraph after "**The brief is validated, not trusted.**":

```markdown
**And so is the result.** A `class: "execution"` delegation is closed only after
the room has run the orchestrator's own `spec.tests` in the worker's worktree,
under its own timeout. `verified` (`true`/`false`/`none`) travels on the
`delegation-result` notification and the `delegation` event beside what the
worker actually said. The command was authored upstream, not by the worker, so
this is not a new trust boundary — it is the room re-running something it
already had standing authority to have run. The same check runs on the
abandoned path, which is what lets "did the work and forgot to reply" be told
apart from "never did anything".
```

Update §6 Testing (lines 247-254) with the measured counts and file counts, and add `killTree` to the list of injected fakes.

- [ ] **Step 4: Verify the docs match reality**

Run: `node --test 2>&1 | tail -8` and `grep -n "tests" README.md ARCHITECTURE.md | grep -E "[0-9]{3} tests"`
Expected: every number quoted in either file matches what the run just printed.

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: spawn_worker, the worker routes, verified results, real test counts

Both files claimed 549 tests and 10 extension test files, neither of which
had been true for some time. Counts re-measured, and the new tool, routes and
verification path documented alongside delegate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: manual verification against a real room and a real worker

**Files:**
- Modify: `README.md` (append a `### Manual verification: spawning and verifying` block under the Status section)

**Interfaces:** none.

**Background:** Nothing in the automated suite spawns `opencode`, creates a git worktree, or runs a real test command in one — by rule. So every claim in Tasks 1-8 about what happens against real binaries is, until this task, an inference. `extension/README.md:102-132` is the model for how this project records that kind of check: what was actually run, what it established, and which bugs it found — including the ones that only a real run could have found.

**This task needs the user's own Claude session and a real OpenCode install.** Do not run it on the user's behalf without asking; do not write its results down before running it. **Record what happened, not what should have happened** — a step that fails is the most valuable line in this section.

- [ ] **Step 1: Boot a real standalone room**

```bash
export ROOM_STANDALONE=1
export ROOM_HOST=127.0.0.1
export ROOM_PORT=8787
export ROOM_REPO="$PWD"
node src/server.mjs
```

Record: the owner join URL it printed, and the `hooks: launch the local session with --settings` line. Leave it running.

- [ ] **Step 2: Attach a real `claude` session to the room's channel**

In a second terminal, start `claude` with the room's MCP channel configured (`.mcp.json` pointing at `src/server.mjs`) and the `--settings` file from Step 1. Confirm the session lists five tools: `room_reply`, `room_decision`, `delegate`, `list_workers`, `spawn_worker`.

Record: whether `spawn_worker` appears, and its description as the session shows it.

- [ ] **Step 3: Spawn a worker from inside the session**

Ask the session to call `spawn_worker({})`.

Record: the handle it returned, how long until `list_workers` showed that handle, and whether `.worktrees/worker-1` actually appeared on disk. If `opencode` is not on PATH, record the exact error text the tool returned — that path matters as much as the happy one.

- [ ] **Step 4: Delegate work that genuinely passes, and confirm `verified="true"`**

Ask the session to delegate an execution task to the new worker with a `spec.tests` you can run yourself — e.g. adding a function to a scratch file with `tests: ["node --test <that file's test>"]`.

Record: the `delegation-result` the session received, specifically whether `verified` is `"true"`, how long the result took to arrive after the worker replied, and whether running the same command by hand in `.worktrees/worker-1` agrees.

- [ ] **Step 5: Delegate work that genuinely fails, and confirm `verified="false"` with real output**

Repeat Step 4 with a `spec.tests` that cannot pass (name a test file that asserts something the brief does not ask for).

Record: whether `verified="false"`, and whether the `verification` field carried enough of the real failure output to be actionable. **If it did not, that is a finding — write it down rather than adjusting the step.**

- [ ] **Step 6: Exercise the silent-worker path**

Delegate an execution task, wait for the worker to do the work, and then kill the worker's process (or drop its feed) before it calls `room_reply` — so the turn is abandoned with the work already done.

Record: whether the session received the "never reported back… tests pass" notification, whether the bus event carried `likelySucceeded: true`, and whether re-running the tests by hand agreed. If the timing is hard to hit, say so and say how many attempts it took.

- [ ] **Step 7: Stop the worker, and confirm nothing is orphaned**

```bash
curl -s -X POST "http://127.0.0.1:8787/api/stop-worker?token=<owner token>" \
  -H 'content-type: application/json' -d '{"handle":"worker-1"}'
```

Then check for strays: `tasklist | findstr opencode` on Windows, `pgrep -fa opencode` on POSIX.

Record: whether any `opencode` process survived, whether `@worker-1` disappeared from `/api/admin/state`, and whether a subsequent `spawn_worker` reused the handle `worker-1`.

- [ ] **Step 8: Ctrl-C the room and check again**

Record: whether SIGINT left any `opencode` process or `.worktrees/*` lock behind.

- [ ] **Step 9: Write down what actually happened**

Append a `### Manual verification: spawning and verifying` block to `README.md`'s Status section, in the shape `extension/README.md:102-132` uses: what was run, what it established, and what it found. Include the failures and the surprises. If a step could not be run at all (no OpenCode install, no spare Claude session), say that instead of omitting it.

- [ ] **Step 10: Commit**

```bash
git add README.md
git commit -m "docs: record the real spawn/delegate/verify walkthrough

What was actually run against real binaries, what it established, and what it
found. Nothing in the automated suite spawns opencode or runs a real test
command in a worktree, by rule, so this is the only evidence for any of it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
