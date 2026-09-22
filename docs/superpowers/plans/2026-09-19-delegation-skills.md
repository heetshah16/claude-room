# Delegation Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two Claude Code skills, `delegating-work` and `managing-workers`, inside a Claude Code plugin manifest that also declares the room channel, so the judgment `validateDelegation` cannot enforce (brief quality, repairing failures, stalled workers, when to spawn) travels with the channel toward Path B. Then verify, against the real `claude` CLI and a real OpenCode worker, whether the skills change behaviour, and record the answer honestly.

**Architecture:** Pure-guidance `SKILL.md` files under `skills/`, discovered through a `.claude-plugin/plugin.json` manifest that also points at a plugin-scoped MCP config and declares the `room` channel. A structural test (`test/skills.test.mjs`) is written first and gates every skill: frontmatter, trigger-quality descriptions, no code or restated schemas, and drift guards that fail if a skill quotes a tool, an error message, or a notification field the room does not really have. Behavioural verification is a manual, recorded probe in `docs/evals/delegation-skills.md`.

**Tech Stack:** Markdown skills, JSON plugin manifest, Node 22+ ESM, `node:test` with `assert/strict`. No new dependencies. `claude plugin validate` (Claude Code 2.1.277 on this machine) for manifest and skill validation.

**Spec:** `docs/superpowers/specs/2026-09-18-delegation-skills-design.md`. Also read `docs/superpowers/specs/2026-09-18-delegation-robustness-design.md`: it supplies `spawn_worker`, the `verified` result field and the `likelySucceeded` abandonment case that the skills teach.

## Global Constraints

- **Sequencing gate.** This plan must run AFTER the delegation-robustness plan has landed `spawn_worker` on the channel and `verified` / `likelySucceeded` in the delegation result. On the day this plan was written (branch `orchestrator-parity`, HEAD `fb3c1ca`) none of the three exists in `src/` (`grep -rn "spawn_worker\|verified\|likelySucceeded" src` finds nothing that names them as tools or fields). Task 1 Step 1 is a hard gate on this.
- **Skills are pure guidance markdown.** No code fences in any `SKILL.md`, no restated tool `inputSchema`. A skill names tools (`delegate`, `list_workers`, `spawn_worker`) and, where the room's own error text uses a field name (`spec.files`, `spec.tests`), quotes that text. Claude Code shows the live schema; a skill that copies it drifts.
- **Descriptions are the trigger text.** They start with "Use when", state triggering conditions only (no workflow summary), are one plain YAML line with no `: ` or ` #` inside, are at most 1024 characters, and must not overlap between the two skills. Conventions copied from `superpowers:writing-skills` (`C:\Users\admin\.claude\plugins\cache\claude-plugins-official\superpowers\6.3.0\skills\writing-skills\SKILL.md`, lines 97-108, 148-171) and the installed `discord` plugin's skills.
- **Do not contradict the code.** The skills must agree with `src/channel.mjs` `INSTRUCTIONS` (delegate mechanical work; a thin brief is rejected with the reason; fix it and retry rather than doing the work yourself out of habit; only seats whose owner opted in accept delegated work; transcript output never reaches the room, `room_reply` does) and with `src/delegation.mjs` (`validateDelegation` collects all errors in one pass; `execution` needs non-empty `spec.files` and `spec.tests`; `reasoning`/`verification` need only `task`; `class` never routes; a second `delegate` to a busy seat is accepted and queued behind the first; `to` is stripped of a leading `@` and lowercased).
- **Ground the content in observed behaviour only.** Free-model failure modes come from `docs/opencode-seat.md` (stalls, `status: retry` loops, finishing real work without calling `room_reply`, default model `opencode/mimo-v2.5-free` is the only one that reliably completed a tool-using turn, 5 minute default turn deadline). The worked brief is the POC's: `math.js`, `mul(a, b)`, `node --test math.test.mjs` (the POC's output is real and still sits in `.worktrees/opencode/math.js` and `math.test.mjs`; its verbatim `delegate` call was not stored in the repo, so the plan does not claim it).
- **No cap on self-spawned workers** (explicit brainstorming decision, mirrored in the robustness spec). Guidance is judgment-based; `list_workers` is the visibility mechanism. The skill must not invent a limit.
- **Cross-plan names (exact).** Files: `.claude-plugin/plugin.json`, `skills/delegating-work/SKILL.md`, `skills/managing-workers/SKILL.md`, `docs/evals/delegation-skills.md`. Tools on the MCP server named `room`: `delegate`, `list_workers`, `spawn_worker` (input `{model?: string}`, returns `{ok:true,handle}` or `{ok:false,errors}`). Notification `kind="delegation-result"` carries `verified` = `"true"`, `"false"` or `"none"` plus a verification summary (exit code, truncated output); an abandoned delegation may carry `likelySucceeded`.
- **Tool-name prefix.** In the README's `server:room` mode the client shows `mcp__room__delegate`. Loaded through a plugin the documented convention is `mcp__plugin_<plugin>_<server>__<tool>` (`plugin-dev` `mcp-integration/SKILL.md` line 194), i.e. `mcp__plugin_claude-room_room__delegate`. Both are real, which is why the skills use bare tool names.
- **Test style:** `import { test } from 'node:test'` and `import assert from 'node:assert/strict'`. Test names state the why.
- **Baseline (measured 2026-09-19, Node v24.19.0, branch `orchestrator-parity`):** `node --test` at the repo root reports 756 tests, 754 pass, 0 fail, 2 skipped (14.5s). `node --test "test/*.test.mjs"` alone reports 491 tests, 490 pass, 1 skipped. The root count also walks `extension/` and the untracked `.worktrees/` copy of the repo, so compare like for like. Never regress: after each task the root run must show `fail 0`, `skipped 2`, and tests = baseline + the tests added so far (Task 1 +5, Task 2 +5, Task 3 +5; final 771 tests, 769 pass). `README.md` still says "549 tests"; that is stale and not this plan's job.
- **Git hygiene.** `.worktrees/` and `graphify-out/` are untracked and stay that way: `git add` named files only, never `-A` or `.`. Commit after every task with a `feat:` or `docs:` prefix and end each message with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Plugin-format facts.** Verified: manifest location and fields (`plugin-dev` `plugin-structure/SKILL.md` lines 22-96), `"skills": "./skills/"` and `"mcpServers": "./.mcp.json"` in the installed `atlassian` and `supabase` manifests, `${CLAUDE_PLUGIN_ROOT}` in the `discord` and `fakechat` `.mcp.json`, `claude --channels plugin:<name>@<marketplace>` in the `discord` README, and, by running `claude plugin validate --strict` against a scratch plugin, that `channels` is a recognised manifest field whose entries must be objects with a non-empty string `server` (optionally `userConfig`). Open items are listed in Task 1's Interfaces block and must stay listed as open until someone verifies them.

---

### Task 1: Structural test harness and the plugin packaging surface (Path B)

**Files:**
- Create: `test/skills.test.mjs`
- Create: `.claude-plugin/plugin.json`
- Create: `plugin.mcp.json`
- Not touched: `.mcp.json` (the existing project-scoped config the README's `server:room` flow depends on; it uses `${CLAUDE_PROJECT_DIR}`, which would resolve to the user's project, not the plugin, if reused as-is)

**Interfaces:**
- Consumes: `createChannel` from `src/channel.mjs` (its `listTools()` must list `delegate`, `list_workers`, `spawn_worker`); `validateDelegation` from `src/delegation.mjs`.
- Produces: the `EXPECTED_SKILLS` array in `test/skills.test.mjs` (each skill task adds its own name and its `SKILL.md` in one commit); a manifest that names the plugin `claude-room`, points `skills` at `./skills/`, `mcpServers` at `./plugin.mcp.json`, and declares `channels: [{ "server": "room" }]`.
- **Open items, not verified, stay open:** (O1) what Claude Code does at runtime with a `channels` entry (the validator checks only its shape, and whether a plugin-declared channel still needs `--dangerously-load-development-channels` like `server:room` does today is unknown); (O2) whether the plugin loader also auto-loads a root `.mcp.json` in addition to the `mcpServers` path, which could register a second `room` server pointing at `${CLAUDE_PROJECT_DIR}`; (O3) Path B's actual submission requirements and whether a `.claude-plugin/marketplace.json` is needed (the `superpowers` plugin ships one; nothing in this repo says what Anthropic's review wants); (O4) the exact command to load a plugin's channel in development. The `discord` README documents `--channels plugin:discord@claude-plugins-official` for a published plugin only.

- [ ] **Step 1: Gate on the robustness plan having landed**

```bash
cd /c/Users/admin/OneDrive/Desktop/claude-room
grep -n "spawn_worker" src/channel.mjs
grep -n "verified" src/channel.mjs src/delegation.mjs
grep -rn "likelySucceeded" src
```

Expected: each command prints at least one line. If any prints nothing, STOP: the robustness plan has not landed and this plan's skills would teach tools and fields that do not exist. Do not continue and do not stub them.

- [ ] **Step 2: Write the failing structural test**

Create `test/skills.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChannel } from '../src/channel.mjs'
import { validateDelegation } from '../src/delegation.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8')
const json = rel => JSON.parse(read(rel))

// The skills this plugin must ship. A skill's task adds its name here in the
// same commit as its SKILL.md, so the suite is red exactly when a skill is
// declared but missing or malformed, and green at every commit.
const EXPECTED_SKILLS = []

// The tools the skills teach. They must be real tools on the room channel.
const TOOL_NAMES = ['delegate', 'list_workers', 'spawn_worker']

const skillText = name => read(`skills/${name}/SKILL.md`)

function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  assert.ok(m, 'SKILL.md must open with a --- frontmatter block')
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) data[kv[1]] = kv[2].trim()
  }
  return { data, body: text.slice(m[0].length) }
}

const words = s => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3))
const jaccard = (a, b) => {
  const inter = [...a].filter(w => b.has(w)).length
  return inter / (a.size + b.size - inter)
}

const allSrc = () =>
  readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.mjs')).map(f => read(`src/${f}`)).join('\n')

test('plugin.json is the manifest Claude Code loads: named, versioned, attributed, pointing at skills/', () => {
  const p = json('.claude-plugin/plugin.json')
  assert.equal(p.name, 'claude-room')
  assert.match(p.version, /^\d+\.\d+\.\d+$/)
  assert.ok(p.description && p.description.length > 20)
  assert.ok(p.author?.name, 'claude plugin validate warns when author is missing')
  assert.equal(p.skills, './skills/')
})

test('the plugin declares the room server from the plugin root, and its channel names a server that exists', () => {
  const p = json('.claude-plugin/plugin.json')
  assert.equal(p.mcpServers, './plugin.mcp.json')
  const servers = json('plugin.mcp.json').mcpServers
  assert.ok(servers.room, 'the server must be keyed "room": the skills and INSTRUCTIONS name it that')
  const args = servers.room.args.join(' ')
  assert.match(args, /\$\{CLAUDE_PLUGIN_ROOT\}\/src\/server\.mjs/)
  assert.doesNotMatch(args, /CLAUDE_PROJECT_DIR/)
  assert.ok(Array.isArray(p.channels) && p.channels.length > 0)
  for (const c of p.channels) assert.ok(servers[c.server], `channel server "${c.server}" is not declared`)
})

test('skills/ holds exactly the expected skills, one directory each', () => {
  const dir = join(ROOT, 'skills')
  const found = existsSync(dir) ? readdirSync(dir).sort() : []
  assert.deepEqual(found, [...EXPECTED_SKILLS].sort())
})

test('the channel really exposes every tool the skills name', async () => {
  const ch = createChannel({ config: { roomName: 'r', permissionRelay: false }, onReply() {}, onDecision() {} })
  const names = (await ch.listTools()).map(t => t.name)
  for (const t of TOOL_NAMES) assert.ok(names.includes(t), `${t} is not a tool on the channel`)
})

test('no two skill descriptions are near-duplicates, because the description is the trigger', () => {
  for (let i = 0; i < EXPECTED_SKILLS.length; i++) {
    for (let j = i + 1; j < EXPECTED_SKILLS.length; j++) {
      const a = parseSkill(skillText(EXPECTED_SKILLS[i])).data.description
      const b = parseSkill(skillText(EXPECTED_SKILLS[j])).data.description
      const sim = jaccard(words(a), words(b))
      assert.ok(sim < 0.5, `${EXPECTED_SKILLS[i]} and ${EXPECTED_SKILLS[j]} descriptions overlap too much (${sim.toFixed(2)})`)
    }
  }
})

for (const name of EXPECTED_SKILLS) {
  test(`${name}: frontmatter loads, name matches the directory, description is a trigger`, () => {
    const { data } = parseSkill(skillText(name))
    assert.equal(data.name, name)
    assert.match(data.name, /^[a-z0-9-]+$/)
    assert.match(data.description, /^Use when /)
    assert.ok(data.description.length >= 60 && data.description.length <= 1024)
    // A plain (unquoted) YAML scalar cannot contain ": " or " #".
    assert.doesNotMatch(data.description, /: | #/)
    assert.doesNotMatch(data.description, /^["']/)
  })

  test(`${name}: pure guidance, no code and no restated schema`, () => {
    const { body } = parseSkill(skillText(name))
    assert.ok(!body.includes('```'), 'no code fences in a SKILL.md')
    assert.doesNotMatch(body, /inputSchema|additionalProperties|"type"\s*:|"properties"|\benum\b/)
    assert.ok(body.split('\n').length < 500, 'keep SKILL.md under 500 lines')
  })

  test(`${name}: refers to each tool by name`, () => {
    const { body } = parseSkill(skillText(name))
    for (const t of TOOL_NAMES) assert.ok(body.includes(`\`${t}\``), `${name} never mentions \`${t}\``)
  })
}
```

The `read` of `allSrc`, `validateDelegation`, `existsSync` and `readdirSync` helpers are used by the per-skill tests added in Tasks 2 and 3; they are imported now so those tasks only append tests.

- [ ] **Step 3: Run it and watch it fail for the right reason**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test test/skills.test.mjs
```

Expected: the two manifest tests fail with `ENOENT ... .claude-plugin/plugin.json` and `plugin.mcp.json`; the listing, tools and distinct-description tests pass (the tools test passing confirms Step 1's gate). If the tools test fails, Step 1's gate was wrong: go back to it.

- [ ] **Step 4: Create the manifest**

Create `.claude-plugin/plugin.json`. Fields copied from the real conventions: `name`, `version`, `description`, `author`, `repository`, `keywords` (superpowers' and supabase's manifests), `skills` (atlassian, supabase), `mcpServers` (atlassian), `channels` (shape verified with `claude plugin validate`). `license` is omitted on purpose: the repo has no LICENSE file and the choice is the owner's to make.

```json
{
  "name": "claude-room",
  "version": "0.1.0",
  "description": "A shared Claude Code room: a channel MCP server with delegate, list_workers and spawn_worker tools, plus skills for delegating well and managing workers.",
  "author": { "name": "Heet Shah" },
  "repository": "https://github.com/heetshah16/claude-room",
  "keywords": ["channel", "mcp", "delegation", "multiplayer"],
  "skills": "./skills/",
  "mcpServers": "./plugin.mcp.json",
  "channels": [{ "server": "room" }]
}
```

- [ ] **Step 5: Create the plugin-scoped MCP config**

Create `plugin.mcp.json`. Same server as the root `.mcp.json`, but rooted at `${CLAUDE_PLUGIN_ROOT}` (the variable the `discord` and `fakechat` plugins use) instead of `${CLAUDE_PROJECT_DIR}`:

```json
{
  "mcpServers": {
    "room": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/server.mjs"]
    }
  }
}
```

- [ ] **Step 6: Run the structural test, then the manifest validator**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test test/skills.test.mjs
claude plugin validate . --strict
```

Expected: 5 tests, 5 pass. `claude plugin validate` prints `Validation passed`. If `--strict` prints a warning, read it: it names the field. Fix a field this plan set; do not silence a warning about O2 by deleting the root `.mcp.json`.

- [ ] **Step 7: Run the whole suite and commit**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test 2>&1 | tail -9
```

Expected: `tests 761`, `pass 759`, `fail 0`, `skipped 2`.

```bash
git add test/skills.test.mjs .claude-plugin/plugin.json plugin.mcp.json
git commit -m "feat: plugin manifest and structural test for the delegation skills" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: The `delegating-work` skill

**Files:**
- Modify: `test/skills.test.mjs` (add the name to `EXPECTED_SKILLS`, append two content tests)
- Create: `skills/delegating-work/SKILL.md`

**Interfaces:**
- Consumes: the real error strings from `validateDelegation` (`to is required`, `class must be one of reasoning, execution, verification`, `task is required`, `spec.files is required for execution`, `spec.tests is required for execution`), the `delegate rejected:` prefix from `src/channel.mjs`, the queue refusal reasons in `src/queue.mjs` (`not-a-seat`, `not-delegatable`, `seat-offline`, `paused`, `rate-limited`, `over-budget`) as they reach the caller through `could not delegate to @<handle>: <reason>`, and the `verified` field from the robustness plan.
- Produces: a skill that teaches (a) when to delegate, (b) briefs for a weak model, (c) repairing a pre-execution rejection AND a post-execution `verified: false` result.

- [ ] **Step 1: Declare the skill and write its content tests (red)**

In `test/skills.test.mjs` change `const EXPECTED_SKILLS = []` to:

```js
const EXPECTED_SKILLS = ['delegating-work']
```

Append at the end of the file:

```js
test('delegating-work quotes the room\'s real rejection messages, word for word', () => {
  const errors = [
    ...validateDelegation({}).errors,
    ...validateDelegation({ to: '@w', class: 'execution', task: 't' }).errors,
  ]
  const { body } = parseSkill(skillText('delegating-work'))
  for (const e of new Set(errors)) {
    const stem = e.split(':')[0]
    assert.ok(body.includes(stem), `the skill never quotes the room's "${stem}"`)
  }
  assert.ok(body.includes('delegate rejected:'))
  assert.ok(read('src/channel.mjs').includes('delegate rejected:'), 'the channel no longer says "delegate rejected:"')
})

test('delegating-work teaches the post-execution failure, and shows the POC brief that worked', () => {
  const { body } = parseSkill(skillText('delegating-work'))
  assert.ok(body.includes('verified: false'))
  assert.ok(allSrc().includes('verified'), 'no source file emits a verified field, so the skill would teach a ghost')
  assert.ok(body.includes('export function mul(a, b)'))
  assert.ok(body.includes('node --test math.test.mjs'))
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test test/skills.test.mjs
```

Expected: the listing test fails (the directory is missing), and the three per-skill tests and both content tests fail with `ENOENT ... skills/delegating-work/SKILL.md`.

- [ ] **Step 3: Reconcile with the landed robustness code**

Read `buildDelegationResultNotification` in `src/channel.mjs` and confirm two facts the skill states: `verified` travels as a notification attribute with the values `true`, `false`, `none`, and a verification summary (exit code, truncated output) is delivered with the result. If the implementation put the summary in the content rather than an attribute, or spells anything differently, edit the affected sentences in Step 4's text (the "Reading a result" section) to match before saving. The test in Step 1 already guards that `verified` exists in `src/`.

- [ ] **Step 4: Write the skill**

Create `skills/delegating-work/SKILL.md` with exactly this content:

```markdown
---
name: delegating-work
description: Use when about to hand a task to another seat with the delegate tool, when deciding whether a piece of work is mechanical enough to delegate at all, when a delegate call comes back rejected, or when a delegation-result reports verified false
---

# Delegating Work

The room's `delegate` tool hands a scoped task to a worker seat, usually a free model driven through OpenCode. Free models are weaker than you and they stall. Most failed delegations are failed briefs, not failed models, so delegating well means doing the thinking before the call and again if the result comes back wrong. Which worker to use and what to do when one goes quiet is the managing-workers skill.

Your client shows the live schema for `delegate`. Do not rely on memory of it, and this skill does not repeat it. Field names appear below only where the room's own messages use them.

## Delegate it or keep it

Delegate work that is mechanical and that a command can check:

- boilerplate or scaffolding of a shape you can fully describe
- one well-specified function with a known signature
- tests for code that already exists
- formatting, lint and build fixes
- a mechanical rename or refactor whose rule fits in one sentence

Keep work that needs your judgment:

- anything you would have to explore the codebase to specify
- requirements that are still ambiguous, or where you are not sure what done looks like
- changes that must stay consistent across several files, because a weak worker loses the thread
- anything security-sensitive or hard to undo

The readiness test: before calling, can you write down the exact files, the exact signature, and a command whose exit code says whether it worked? If you cannot, the task is not ready. The fix is to think it through, not to send a vaguer brief. Delegation also has a price, the brief you write and the result you read, so a two-line edit is faster to make yourself.

Once a task passes the test, delegate it. The room's own instructions say the same: do not do the work yourself out of habit.

## Pick the class

The class labels the work and decides what the room requires. It never routes: `to` chooses the worker.

- `execution` means code will change. The room requires files and a verification command.
- `reasoning` and `verification` need only a task line, because there is no code to scope. Nothing is checked mechanically afterwards, so read the answer critically.

Do not choose `reasoning` to get past a rejection. It removes the verification, which is the part protecting you.

## Write the brief for a weak model

The worker receives your brief rendered as plain text: a "Delegated task" line, then "Files you may change", "Interface to conform to", "Verify with" and "Do not touch" sections, ending with an instruction to report with `room_reply`. Read your own brief as that text. Assume the worker has seen nothing else: not your conversation, not your plan, not the neighbouring files.

- Name every file it may touch, by exact path from the root of its checkout. Nothing outside the list is fair game.
- Give the exact signature, in the language's own syntax, plus one sentence on behaviour that covers the edge cases you care about. "Add a helper" invites an invented interface.
- One concern per delegation, one or two files. If you are tempted to write "and also", make it two delegations.
- Give one verification command that runs non-interactively, needs no network and no installs, finishes quickly, and exits non-zero when the work is wrong. The room may run this command itself in the worker's checkout after the worker replies, so it must be a real command, not a sentence.
- List files that must not change whenever neighbours exist that a confused worker might edit.
- Keep it short enough that the worker reads all of it.

A bad brief:

> - to: opencode
> - class: execution
> - task: Add a multiply helper to the math file, with tests.

The room rejects this before anything runs, because it names no files and no verification. A worse trap is the quick repair that satisfies the check without helping the worker:

> - files: math.js
> - tests: make sure it works

That passes validation, which only checks that the lists are non-empty, and then fails in practice: there is no signature to conform to, no command to run, and a second file the worker must invent.

The brief that worked, the shape of the POC that produced `math.js` and `math.test.mjs` with a free model on the first try:

> - to: opencode
> - class: execution
> - task: Add a function mul(a, b) to math.js and cover it in math.test.mjs
> - files: math.js, math.test.mjs
> - interface: export function mul(a, b), returns a * b, both arguments are numbers, no coercion
> - tests: node --test math.test.mjs
> - do_not_touch: package.json

Why it works: every file is named, the signature is exact and copyable, there is one concern, and the verification is a single command whose exit code cannot be argued with.

## When the room rejects the call

A rejection arrives as `delegate rejected:` followed by one line per problem. The room reports every problem in one pass, so the list is your complete to-do list. Fix all of it and resubmit once. Do not do the work yourself instead: the room's instructions say to fix the brief and try again.

- `to is required` means give a worker's handle. `list_workers` shows who is online. A leading @ is fine.
- `class must be one of reasoning, execution, verification` means pick one.
- `task is required` means one line saying what to do.
- `spec.files is required for execution` means list the files the worker may touch. If you cannot name them, the task is not ready: go back to the readiness test.
- `spec.tests is required for execution` means give the verification command.

A second shape of refusal is not about the brief. `no seat with handle @name in this room` means the handle is wrong or has no seat, and `could not delegate to @name: <reason>` means the room refused for a reason of its own:

- `not-a-seat`: the target is not a worker seat. Delegation never reaches `@claude`.
- `not-delegatable`: that seat's owner has not opted it in to delegated work. You cannot change that from here.
- `seat-offline`: the seat is not connected right now.
- `paused`, `rate-limited`, `over-budget`: the room is refusing new work at the moment.

Rewriting the brief cannot fix these, and resending the same call unchanged will get the same answer. Check `list_workers` for the right handle and an online worker. If none is usable, `spawn_worker` creates one that accepts delegation (see managing-workers). For `paused`, `rate-limited` and `over-budget`, say so to the room with `room_reply` and stop, rather than hammering. Note that `list_workers` lists online seats only and does not say whether a seat accepts delegation, so a listed seat can still answer `not-delegatable`.

## Reading a result

A finished delegation returns to you as a `delegation-result` event. Its content is the worker's own words. Its attributes carry the delegation id, the handle, the class, the task, and `verified`, which says what the room found when it ran your verification command itself. The event also carries a verification summary, the exit code and the truncated output.

- `verified: true` means your command exited zero. That is exactly as strong as your command: a command that only loads the file proves little.
- `verified: none` means nothing was run, which is what happens for `reasoning` and `verification` classes. Judge the answer yourself.
- `verified: false` means the worker made a real attempt, the command really ran, and the work is still wrong.

The worker's words never outrank the exit code. A worker can say "done, all tests pass" while `verified: false` sits next to it. Believe the exit code, and do not tell the room the work is done.

## When a real attempt comes back wrong

A rejection is caught before any work happens. `verified: false` is the same judgment applied after a real attempt, with real output as evidence. There is no automatic retry: the room can tell you that the command failed but not why, so the repair is yours.

1. Read the exit code and the output. Sort the failure into one of four causes. The command itself was wrong: a bad path, the wrong runner, something that needs a network or an install. The interface was ambiguous and the worker guessed differently from you. The worker's logic is wrong. Or the task was too big.
2. Fix the cause in the brief, not just the wording. A wrong command means fixing `tests`. An ambiguous interface means adding the exact expected values. A logic bug means quoting the failing case. Too big means splitting it.
3. Send a new delegation that carries the failing output, briefly. The worker's earlier edits are probably still in its checkout unless someone reset it, so the follow-up can say what is wrong with the file as it stands rather than restarting blind.

An example. The brief above comes back with the worker saying it added `mul` and every test passes, but `verified: false` and the output shows the test named "multiplies by zero" failing, `mul(-5, 0)` returned -0 where 0 was expected, because the strict equality in the test tells the two apart. The follow-up names that exact case: "mul(-5, 0) returned -0 and the test expects 0. Make any zero product return 0. Change only math.js." Same files, same command, one sharper sentence.

If the sharpened brief fails again on the same task, stop delegating it. That is a judgment call, not a room rule: two failures suggest the task is not a weak-model task. Do it yourself and tell the room why.

## Habits to avoid

- Doing the work yourself after a rejection instead of repairing the brief.
- A verification command that is a sentence, or a command that always passes.
- Several concerns in one delegation.
- Resending an identical brief after a failure.
- Piling a second delegation onto a busy seat without looking. The room accepts it and queues it behind the first, so it waits as long as the first does. Check `list_workers` first.
- Reporting work as finished to the room on the worker's say-so when the result says `verified: false`.
```

- [ ] **Step 5: Run the structural test and the skill validator**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test test/skills.test.mjs
claude plugin validate skills --strict
claude plugin validate . --strict
```

Expected: 10 tests, 10 pass; both validator runs print `Validation passed`. If the `pure guidance` test fails on a word such as `enum`, reword the sentence; do not weaken the test.

- [ ] **Step 6: Self-check the text against the code once more**

Re-open `src/channel.mjs` (`INSTRUCTIONS`, the `delegate` tool description and the `delegate rejected:` branch) and `src/delegation.mjs`, and tick each: the skill says fix-and-retry (matches INSTRUCTIONS); it lists the five real errors (test-enforced); the queue reasons in the skill match `reason:` strings in `src/queue.mjs` (`grep -n "reason: '" src/queue.mjs`); nothing claims the room retries or that `list_workers` reports delegatability.

- [ ] **Step 7: Run the whole suite and commit**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test 2>&1 | tail -9
```

Expected: `tests 766`, `pass 764`, `fail 0`, `skipped 2`.

```bash
git add test/skills.test.mjs skills/delegating-work/SKILL.md
git commit -m "feat: delegating-work skill, covering briefs, rejections and verification failures" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: The `managing-workers` skill

**Files:**
- Modify: `test/skills.test.mjs` (add the name to `EXPECTED_SKILLS`, append two content tests)
- Create: `skills/managing-workers/SKILL.md`

**Interfaces:**
- Consumes: `list_workers` output (the channel returns `{"workers":[{handle,busy}]}` for online seats only, from `onListWorkers` in `src/server.mjs`; it carries no elapsed time and no delegatability), `spawn_worker` (input `{model?: string}`, returns `{ok:true,handle}` when launched, or `{ok:false,errors}`), the abandonment outcome with `likelySucceeded` from the robustness plan, the worker checkout path `.worktrees/<handle>` (`scripts/room-opencode-seat.mjs`), the driver's per-turn deadline (`docs/opencode-seat.md`, default 300000 ms).
- Produces: a skill that teaches checking before assuming, stall triage, `likelySucceeded` handling, and when to spawn.

- [ ] **Step 1: Declare the skill and write its content tests (red)**

In `test/skills.test.mjs` change the array to:

```js
const EXPECTED_SKILLS = ['delegating-work', 'managing-workers']
```

Append at the end of the file:

```js
test('managing-workers teaches likelySucceeded, and the room really emits that name', () => {
  const { body } = parseSkill(skillText('managing-workers'))
  assert.ok(body.includes('`likelySucceeded`'))
  assert.ok(allSrc().includes('likelySucceeded'), 'no source file emits likelySucceeded, so the skill would teach a ghost')
  assert.ok(body.includes('.worktrees/'), 'the skill must say where a worker\'s output lives')
})

test('managing-workers is honest about what list_workers cannot tell you', () => {
  const { body } = parseSkill(skillText('managing-workers'))
  // list_workers returns handle and busy for online seats, nothing about duration.
  assert.match(body, /does not tell you how long/)
  assert.ok(body.includes('busy'))
  assert.ok(body.includes('deadline'))
  assert.ok(body.includes('no cap') || body.includes('no limit'), 'the no-cap decision must be stated, not silently replaced by an invented limit')
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test test/skills.test.mjs
```

Expected: the listing test fails (the new directory is missing) and the three per-skill tests plus both new content tests fail with `ENOENT ... skills/managing-workers/SKILL.md`. The distinct-descriptions test now compares two skills only once the file exists, so it fails on the same `ENOENT`.

- [ ] **Step 3: Reconcile with the landed robustness code**

Read the abandonment path in `src/delegation.mjs` (`onTurnAbandoned`) and how `likelySucceeded` reaches the orchestrator. The skill below says the abandoned result "carries `likelySucceeded`". If the implementation delivers it as a notification attribute, a text sentence, or only on the room's event stream and not to the channel, adjust the sentence in the "When it never reported back" section to say precisely that, and note the difference in your commit message. Also confirm `spawn_worker` returns as soon as the process is launched (robustness spec section 1); the skill's "check `list_workers` before delegating to a fresh handle" step depends on it.

- [ ] **Step 4: Write the skill**

Create `skills/managing-workers/SKILL.md` with exactly this content:

```markdown
---
name: managing-workers
description: Use when a delegated task has gone quiet or a worker looks stalled, when checking which workers are online or busy, when no worker is free for new work, when deciding whether to spawn another worker, or when a delegation result reports likelySucceeded
---

# Managing Workers

Workers are OpenCode seats running free models. Treat them the way you treat your own subagents: disposable capacity sized to the task, not a rationed resource. The other side of that is that free models stall, spin in retry loops, and sometimes finish real work without ever reporting it. This skill is about noticing those things and having somewhere to go next. Writing the brief itself is the delegating-work skill.

## Look before you assume

Call `list_workers` early: before delegating, before deciding nothing is available, and while waiting on something you handed off. It costs nothing and it does not disturb the workers. It returns each online worker's handle and whether it is `busy`, meaning a turn is in progress.

What it does not do matters as much:

- It lists online seats only. A worker that is missing from the list is not connected, whether it never started or has died.
- It does not tell you how long a seat has been busy. Keep your own clock: note the time you delegated, and judge a busy seat against what you asked of it.
- It does not say whether a seat accepts delegation. A listed seat can still refuse with `not-delegatable`.

Check `busy` before sending a second delegation to the same seat. The room accepts it and queues it behind the first, so it waits exactly as long as the first does, including forever if the first is stuck.

## Recognising a stalled worker

A stall looks like this: no result has come back, and `list_workers` still shows the seat `busy`, for much longer than a task of that size deserves. A one-function edit that has been busy for several minutes is not thinking, it is stuck.

The driver already enforces a per-turn deadline, five minutes by default, though the operator can change it. When it fires the driver aborts the turn, tells the room, and frees the seat, so a stall does not last forever. A model failing in a retry loop does not reset that deadline. Your job is not to wait for the deadline out of politeness. It is to avoid idling on a worker that is not going to answer.

1. Confirm with `list_workers`. Missing from the list means the seat is gone and its turn will be abandoned. Present and `busy` means it is still holding the turn.
2. Do not poll in a tight loop and do not sit silent. Keep doing work that is yours to do, and check again at sensible intervals.
3. After a reasonable wait for the size of the task, treat the delegation as failed. Get the work moving another way: give it to a different idle worker, or `spawn_worker` for a fresh one, with a sharper brief, or do it yourself if it is small. Do not resend to the stuck seat.
4. If the original worker does report later, and you have already reissued the work, take one result you trust and discard the other. Do not apply both.
5. If the same seat keeps stalling, that is the model rather than the task. Prefer a different worker. Do not swap models by guesswork: the default model is the only one that reliably completed a tool-using turn when this was tested, and others sat busy forever or parked in retry.

## When it never reported back

A delegation can end abandoned: the worker's turn closed without a reply. Usually that means nothing came back. But the room also runs your verification command in the worker's checkout when there was no reply, and when that command passes, the abandoned result carries `likelySucceeded`. It means the worker probably did the job and never called `room_reply`, which free models are known to do.

Do not re-delegate blindly. That doubles the work and can produce a second attempt that collides with the first. Go and look:

1. Open the worker's checkout at `.worktrees/` plus the handle, inside the repo. `git status` and `git diff` there show what it changed.
2. Run the verification command yourself and read the diff against your brief: only the listed files, nothing on the do-not-touch list, the interface as specified.
3. If it holds up, take the work. Bring the changes into your own checkout on purpose, by copying the files or applying the diff, and treat the delegation as done. Tell the room.
4. If your own check fails or the diff strays outside the brief, it is an ordinary failed attempt. Repair it as delegating-work describes.

Without `likelySucceeded`, an abandonment is a real one: the check failed, nothing changed, or there was no command to run because the class was `reasoning` or `verification`. Retry with a sharper brief, or do it yourself. `likelySucceeded` says likely: it is only as strong as the command you supplied.

## When to spawn a worker

`spawn_worker` creates a new worker on demand. It takes an optional model and returns as soon as the process is launched, not when the seat is ready. A worker you spawn accepts delegation automatically.

Spawn when a task is ready to delegate and no seat can take it in time:

- `list_workers` shows no online worker at all
- every worker is busy and the task is independent enough to run alongside them
- several independent tasks are ready together, each of which can run in its own checkout without touching the others
- a worker has stalled on something you still need

Do not spawn to fix a problem a worker cannot fix:

- the task needs your judgment, so more capacity will not help
- a rejected brief. Spawning does nothing for a missing file list.
- an idle worker already exists for a task that is small
- retrying an unchanged failed brief on a fresh seat

How much: there is no cap, deliberately. The free tier makes token cost a non-issue, so the limit is your judgment. The real ceilings are processes and checkouts on the host, and `list_workers` is how a large fleet stays visible instead of silent. Spawn what the work needs and no more. Nothing in this session stops a worker, so it stays until its owner removes it, and each extra one is something the owner has to clean up. When you have grown the fleet beyond a worker or two, say so in a `room_reply`, since the people in the room otherwise only see your tool calls.

After spawning:

- Call `list_workers` and wait until the new handle appears before delegating. If you delegate too early the room answers `seat-offline`. That means it is not up yet, not that spawning failed, so check `list_workers` and try again.
- If `spawn_worker` returns an error, read it, do not loop on it, and fall back to the workers you have or to doing the work yourself. Tell the room.
- Leave the model argument alone unless the operator asked for one.
```

- [ ] **Step 5: Run the structural test and both validators**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test test/skills.test.mjs
claude plugin validate skills --strict
claude plugin validate . --strict
```

Expected: 15 tests, 15 pass; both validators pass. The distinct-description test now compares the two real descriptions (Jaccard about 0.24 by hand; the threshold is 0.5).

- [ ] **Step 6: Self-check the text against the code once more**

Re-open `src/channel.mjs`, `src/queue.mjs`, `src/server.mjs` (`onListWorkers`) and `docs/opencode-seat.md`. Tick: `list_workers` is described as handle plus busy, online only (matches `seats.online().map(...)`); the queued-behind-a-busy-seat warning matches the note above `PendingDelegations` in `src/delegation.mjs`; the deadline and the retry-does-not-reset claim match `docs/opencode-seat.md`; the default-model claim matches the same file; the skill states no numeric spawn limit anywhere.

- [ ] **Step 7: Run the whole suite and commit**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test 2>&1 | tail -9
```

Expected: `tests 771`, `pass 769`, `fail 0`, `skipped 2`.

```bash
git add test/skills.test.mjs skills/managing-workers/SKILL.md
git commit -m "feat: managing-workers skill, covering stalls, likelySucceeded and when to spawn" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Document the plugin surface and its open items in the README

**Files:**
- Modify: `README.md` (insert one subsection immediately before `## The VS Code extension`)

**Interfaces:**
- Consumes: the facts verified in Task 1 and the open items O1 to O4.
- Produces: the only human-readable statement in the repo of what the plugin declares and what has not been verified.

- [ ] **Step 1: Insert the subsection**

Use the Edit tool with this exact `old_string` (it is unique: the heading appears once):

```
## The VS Code extension

Everything above assumes you assemble it yourself
```

and this `new_string` (four backtick fence used here only so the plan can show the inner code block):

````markdown
### Skills and plugin packaging

Two skills teach the judgment the `delegate` tool cannot enforce: `delegating-work` (when to
delegate, briefs for a weak model, repairing a rejected brief and a `verified: false` result)
and `managing-workers` (checking `list_workers`, telling a stalled worker from a slow one,
what `likelySucceeded` means, when to `spawn_worker`). They live in `skills/` and ship in the
same plugin as the channel, declared by `.claude-plugin/plugin.json`, which points at
`plugin.mcp.json` (the same `room` server, rooted at `${CLAUDE_PLUGIN_ROOT}`) and names it as
a channel.

Check the manifest and the skills with the validator that ships in Claude Code:

```bash
claude plugin validate . --strict
claude plugin validate skills --strict
```

The existing `server:room` launch in [Setup](#setup) keeps working unchanged: it reads the
root `.mcp.json`, which this packaging does not touch. What is **not** verified yet, so do not
rely on it: how Claude Code treats the `channels` entry at runtime (the validator checks only
its shape); whether the plugin loader also picks up the root `.mcp.json` and registers a
second `room` server; how to load a plugin's channel during development; and what Path B's
review requires, including whether a marketplace manifest is needed. The behavioural question,
whether the skills change what the orchestrator does, is answered (or not) in
[`docs/evals/delegation-skills.md`](docs/evals/delegation-skills.md).

````

The trailing text after the inserted block must be the original `## The VS Code extension` heading and its first sentence, so `new_string` ends with:

```
## The VS Code extension

Everything above assumes you assemble it yourself
```

- [ ] **Step 2: Confirm the link target will exist and the docs did not break a test**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node --test 2>&1 | tail -9
```

Expected: unchanged from Task 3 (`tests 771`, `fail 0`). `docs/evals/delegation-skills.md` is created in Task 5; commit this task only after Task 5 Step 1 if you prefer no dangling link at any commit, otherwise accept one commit with a forward link.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the skills and the plugin surface, with what is unverified" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Verification probe (spec section 4). Needs the user's real Claude session and a real OpenCode worker

**Files:**
- Create: `docs/evals/delegation-skills.md`
- Scratch, never committed: a stall-server script in the scratchpad directory

**Interfaces:**
- Consumes: the robustness plan's `spawn_worker` and `verified` (so this task runs after Tasks 1 to 4 AND after that plan); `test/helpers/fake-opencode.mjs` (`startFakeOpencode()` returns `{url, ...}`, implements every route the seat driver uses and never reports a turn idle, which is a deterministic stand-in for a silent worker); `scripts/room-admin.mjs seat add`; `scripts/room-opencode-seat.mjs` flags `--repo`, `--attach`, `--timeout`.
- Produces: a recorded result per scenario per arm, and a verdict. **A negative result is a valid finding.** If the baseline arm already behaves well, or the skills arm behaves no better, write that down as it is. Do not edit the skills to make the numbers come out, and do not drop a run because it embarrassed the skill.

**Why two arms.** Without a baseline there is no way to tell that the skills changed anything: the channel's `INSTRUCTIONS` already tell the model to delegate mechanical work and repair a rejected brief. Arm A loads the channel exactly as the README does, with no skills. Arm B is identical plus the two skills installed as personal skills (`~/.claude/skills/<name>/SKILL.md`, the same location `claude plugin init` scaffolds into). This isolates the skills from the unverified plugin-channel loading (O1, O2, O4). Run each scenario at least twice per arm; one run is an anecdote, and say which N you ran.

- [ ] **Step 1: Create the record with the procedure in it, and commit it**

Create `docs/evals/delegation-skills.md` with this content (four backtick outer fence because the file contains code blocks):

````markdown
# Delegation skills: behavioural probe

**Status:** procedure written, not yet run. Replace this line with the run date, the verdict
and N per scenario when the runs are done.

**Question.** Do `delegating-work` and `managing-workers` change what a real Claude Code
orchestrator does, compared with the same session without them? Design:
`docs/superpowers/specs/2026-09-18-delegation-skills-design.md` section 4.

**What a negative result means.** If arm B is no better than arm A, the skills do not earn
their keep as written. That is a finding, and it is worth having before Path B. Record it
plainly. Do not tune the skills and re-run until they win without saying so.

**Honest limits.** The stalled worker in scenario 2 is a fake that never finishes a turn, not
a real free-model stall. The model is non-deterministic, so N per arm matters. This probe
needs real API calls and a real OpenCode worker.

## Environment (record at run time)

- Date, `claude --version`, `opencode --version`, `node --version`, git commit of this repo
- Worker model (the default `opencode/mimo-v2.5-free` unless stated)
- N runs per scenario per arm

## Setup common to every run

```bash
cd /c/Users/admin/OneDrive/Desktop/claude-room
claude plugin list                       # confirm neither skill is already installed
ls ~/.claude/skills                      # arm A must not contain delegating-work or managing-workers
claude --dangerously-load-development-channels server:room \
       --settings ~/.claude/channels/room/settings.hooks.json
```

Accept the two first-run dialogs as the README describes. From a second terminal:

```bash
export ROOM_ADMIN_TOKEN=<owner token from the join URL in the first terminal's stderr>
node scripts/room-admin.mjs seat add <handle> --owner owner --delegatable
node scripts/room-opencode-seat.mjs <handle> --token <token it printed> --repo .
node scripts/room-admin.mjs handle @claude,@<handle>
```

Use a fresh `<handle>` per run (`probe-a1`, `probe-b1`, ...) so a worker's checkout
(`.worktrees/<handle>`) never carries files from an earlier run. Type the scenario prompt into
the session that launched the room.

**Arm A (baseline):** as above, with no skills installed.
**Arm B (skills):** before launching, run
`mkdir -p ~/.claude/skills && cp -r skills/delegating-work skills/managing-workers ~/.claude/skills/`,
launch a NEW session (skills load at start), and remove those two directories afterwards.

**Reading what happened.** The transcript is a JSONL file under `~/.claude/projects/`. List
the room tool calls in a run with
`grep -o '"name":"mcp__room__[a-z_]*"' <transcript>.jsonl | sort | uniq -c` and read the
`delegate` inputs in full. If that grep finds nothing, open the file and look at how tool
calls are actually written before recording anything.

## Scenario 1: thin brief, repaired

Prompt (both arms): `Delegate a small slugify helper to @<handle>: it turns "Hello World" into "hello-world". Choose whatever files make sense.`

Record per run:
- The first `delegate` call's inputs, verbatim
- Did it name files, an interface and one runnable verification command? (yes/no each)
- How many `delegate rejected:` results appeared, and what it did next: resubmitted a repaired brief, or did the work itself
- The `verified` value on the result and the verification summary
- Independently: `ls .worktrees/<handle>` and run the verification command yourself. Does the file exist and does the command pass?

Positive for the skills: arm B's first call has concrete files, interface and command more
often than arm A's, or repairs a rejection without doing the work itself where arm A does not.

## Scenario 2: stalled worker, checked and not silently waited on

Setup difference: the worker is a fake that accepts a turn and never finishes it. Create a
scratch file OUTSIDE the repo (the scratchpad directory), for example `stall-server.mjs`:

```js
import { startFakeOpencode } from '<absolute path to this repo>/test/helpers/fake-opencode.mjs'
const fake = await startFakeOpencode()
console.log(fake.url)
setInterval(() => {}, 1 << 30)
```

Run `node stall-server.mjs`, note the URL, then start the seat against it with a 240 second
deadline: `node scripts/room-opencode-seat.mjs <handle> --token <token> --repo . --attach <url> --timeout 240000`.

Prompt (both arms): `Delegate adding a slugify helper to @<handle>, giving it files and a test command, then keep me posted.`

Record per run:
- Time of the `delegate` call, and the time of every `list_workers` call after it
- Whether `list_workers` was called at least once before the 240 second deadline
- What it did while waiting: other work, silent idling, asking you what to do
- What it did at and after the deadline (abandonment): re-delegated, spawned, did the work itself, or waited
- Whether it ever noticed that the seat was `busy` for implausibly long

Positive for the skills: arm B calls `list_workers` during the wait and acts on the stall
sooner or more sensibly than arm A.

## Scenario 3: fleet full, spawns rather than stalls

Setup: keep the stalled seat from scenario 2 as the only worker and occupy it. As the owner,
type `@<handle> do a small task` into the room, so the seat is `busy`.

Prompt (both arms): `Delegate two independent small tasks now: a slugify helper and a titleCase helper. Give each files and a test command.`

Record per run:
- Whether it called `list_workers` before delegating, and what it concluded
- Whether it called `spawn_worker`, how many times, and with what input
- Whether it delegated to the new handle only after it appeared in `list_workers`, or delegated to the busy seat and queued behind it, or did the work itself
- Total workers in `list_workers` at the end (there is no cap, so record the count rather than judging it)

Positive for the skills: arm B uses `spawn_worker` in proportion to the work (up to one per
independent task) and delegates to a live worker, where arm A queues behind the busy seat or
waits.

Cleanup: stop spawned workers through the room's owner-authenticated `POST /api/stop-worker`
(body shape is in the robustness plan's tests), then
`git worktree remove --force .worktrees/<handle>` for each probe handle only.

## Scenario 4 (optional, added beyond spec section 4): a verified: false result

The robustness plan created a moment the skill now teaches, so it earns one cheap probe.

Prompt (both arms): `Delegate a slugify helper to @<handle>. Use exactly this verification command: node --test nosuchfile.test.mjs`

That command cannot pass, so the room reports `verified: false` however good the worker's code.

Record per run: whether the orchestrator noticed `verified: false` despite the worker saying
it was done, whether it diagnosed the command as the cause, whether it repaired and resent,
or reported the work as finished.

## Results

Not yet run. For every run add a block in this exact shape, under its scenario heading, and
keep failed and embarrassing runs:

- Run id, arm (A or B), handle, date
- Observations, using each scenario's record list above
- Verdict for this run: positive, negative or inconclusive for the skills, with one sentence why

After the runs: a table of scenario by arm with the counts, a one-paragraph verdict, and a
list of skill or channel changes the evidence supports. If the evidence is negative or too
thin to say, say that.
````

```bash
git add docs/evals/delegation-skills.md
git commit -m "docs: write the behavioural probe procedure for the delegation skills" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Confirm the sequencing before spending anything (needs the user)**

```bash
cd /c/Users/admin/OneDrive/Desktop/claude-room
git log --oneline -8
grep -c "spawn_worker" src/channel.mjs
```

Expected: the count is at least 1 (the robustness plan is on this branch). If it is 0, stop: scenario 3 cannot run. Ask the user before making any real API call or launching a real OpenCode worker; the first run needs their Claude login and the first-run dialogs.

- [ ] **Step 3: Run Arm A (baseline), scenarios 1, 2, 3 and 4 (needs the user's real session)**

Follow the record's "Setup common to every run" and each scenario, with no skills installed. At least 2 runs per scenario. Write each run's block under `## Results` in `docs/evals/delegation-skills.md` as you go, not at the end.

- [ ] **Step 4: Run Arm B (skills), scenarios 1, 2, 3 and 4 (needs the user's real session)**

Install the two skills as personal skills, launch a NEW session, and repeat every scenario the same number of times as Arm A. Afterwards remove `~/.claude/skills/delegating-work` and `~/.claude/skills/managing-workers` so nothing lingers.

- [ ] **Step 5: Write the verdict, including if it is negative**

Replace the `**Status:**` line with the run date, N per scenario per arm, and a one-line verdict. Fill the scenario-by-arm table and the verdict paragraph. If arm A already did what the skills teach, say the skill added nothing for that scenario. If a run showed a skill instruction being followed wrongly or a claim in a skill being false, record it and open a follow-up; do not silently edit the skill inside this task.

- [ ] **Step 6: Commit the recorded result**

```bash
git add docs/evals/delegation-skills.md
git commit -m "docs: record what the delegation skills did in a real session" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

If the verdict is negative, use the message `docs: record that the delegation skills did not change behaviour in scenario N` naming the scenarios, so the history says what was found.
