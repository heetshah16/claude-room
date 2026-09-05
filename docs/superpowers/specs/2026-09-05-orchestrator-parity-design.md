# Orchestrator parity: make it feel like Claude Code

**Status:** approved design, not yet implemented
**Date:** 2026-09-05

## Problem

The extension works — a real room, a real orchestrator, a real worker, a real
delegation. But the chat "looks more like the webpage was made into this
space" rather than like Claude Code, and none of the things you actually do in
Claude Code are reachable: signing in, changing model, running a skill,
starting a new conversation, or seeing what the workers are configured with.

The placement is staying as an editor tab. That is a deliberate choice and it
raises the bar on everything else: if the chat is not going to sit where Claude
Code sits, it has to *read* like Claude Code.

## What was verified before designing

Probed against the real `claude` binary and the installed Claude Code extension
(`anthropic.claude-code-2.1.261`), not assumed:

| Fact | Evidence |
|---|---|
| **`/model` works in headless print mode** | `/model` lists available models; `/model sonnet` returned "Set model to Sonnet 5 for this session only" and the next turn's stream reported `model: claude-sonnet-5` and answered "Sonnet 5" |
| Slash-command turns are distinguishable | they report `model: <synthetic>` in the assistant event, so the UI can style them as local commands rather than model output |
| **`/status` is NOT available** | "/status isn't available in this environment" |
| Claude Code lives in the sidebar | its manifest contributes `viewsContainers.activitybar` + `secondarySidebar` and a `claudeVSCodeSidebar` webview view |
| Its command surface | open in tab/sidebar/window, new conversation, reopen closed session, logout, show logs, install plugin, create worktree, walkthrough |
| **Our chat renders no markdown** | `webview.js` writes assistant text straight to `textContent`; every `**bold**`, backtick and code fence shows literally |
| Our chat uses message bubbles | `.msg { max-width: 88%; border-radius: 8px }` — a messaging-app look Claude Code does not have |

The last two are the actual answer to "it looks like a webpage". Markdown is
the bigger of the two: Claude's output is markdown, and rendering it as plain
text is most of the difference.

## Design

### 1. Rendering — the visual fix

**Markdown, built as DOM nodes, never `innerHTML`.** A small renderer in
`extension/src/chat/markdown.js` handling what Claude actually emits: fenced
code blocks (with language), inline code, bold, italic, links, bullet and
numbered lists, headings, and blockquotes. Everything else falls through as
text.

It must build elements with `document.createElement` and set `textContent`,
because the input is model output and the no-`innerHTML` rule in `src/ui.mjs`
exists for exactly this. A markdown renderer that concatenates HTML strings
would reintroduce the injection this project has been careful to avoid — so
the renderer returns a `DocumentFragment`, and that is the only thing the
caller appends.

**Flat messages, not bubbles.** Remove `max-width`/`border-radius`/bubble
backgrounds. Claude Code's layout is full-width, left-aligned, with the role
carried by a small label and generous line-height. Code blocks get the editor's
monospace font and a subtle surface, matching `--vscode-textCodeBlock-background`.

**Tool calls stay collapsible** but restyled as compact rows — a disclosure
triangle, the tool name, and a one-line summary of the input — rather than
cards.

### 2. Login

`/login` cannot run in print mode, and we will not handle a credential
ourselves — that restraint is the reason the seat design was defensible and it
applies here.

On a spawn or turn failure that looks like an auth problem, the chat shows a
clear message with a **"Sign in to Claude Code"** action that opens a VS Code
terminal running `claude`, so the real OAuth flow happens in Claude Code's own
process. After it completes, "Retry" restarts the orchestrator.

Detection is by pattern on the failure, and must fail *open*: an unrecognised
error is reported as itself, never silently relabelled as a login problem.

### 3. Model switching

A picker in the composer showing the current model. Selecting one sends
`/model <name>` as an ordinary turn — the mechanism is already proven, so this
is UI only.

The current model is tracked from the stream: `assistant` events carry
`message.model`, and `<synthetic>` is ignored rather than displayed, since it
means "a local command answered this", not a model change.

The list comes from `/model`'s own output rather than a hardcoded table, so it
cannot drift from what the installed binary supports.

### 4. Skills and slash commands

The composer accepts `/` and offers completions. Two sources:

- **Built-in commands** that are known to work in print mode. `/model` is
  verified; `/status` is verified NOT to work and must not be offered. Any
  command whose print-mode behaviour has not been checked is not listed —
  offering a command that answers "isn't available in this environment" is
  worse than not offering it.
- **Skills**, discovered by scanning the skill directories Claude Code itself
  uses (`.claude/skills` in the workspace, and the user-level equivalent) for
  `SKILL.md` frontmatter, listing `name` and `description`.

Selecting one inserts it into the composer for the user to complete, rather
than sending immediately — a skill usually needs an argument.

### 5. New conversation and session history

The extension already persists a session id for `--resume`. Generalise it to a
list, per workspace, in `workspaceState`:

- **New Conversation** — mint a new id, restart the orchestrator, clear the view
- **History** — pick a previous session and `--resume` it

Each entry stores id, first user message (as a title), and last-used time. The
transcript itself is not stored by us: Claude Code owns it, and `--resume`
restores it.

### 6. Settings and MCP

A settings view contributed through `configuration` so it appears in VS Code's
own settings UI — the native surface, rather than a bespoke one:

- orchestrator model default
- worker model (`opencode/...`) and turn timeout
- room port strategy and whether to share on the tailnet
- additional MCP servers to load into the orchestrator, merged with the
  built-in bridge rather than replacing it

### 7. OpenCode surface

Config and visibility only — the orchestrator remains how work reaches a
worker, which is the whole premise.

A **Workers** view showing, per worker: handle, model, current task, live
activity, the turn deadline counting down, and its worktree path. Plus a
provider/auth status line read from `opencode`'s own config, and a model
picker writing the same setting the launcher reads.

## Build order

1. **Markdown + flat layout** — the complaint that prompted this, and the
   largest visual gain per unit of work.
2. **Model picker** — mechanism already proven.
3. **Login detection and guidance** — turns a wall into an instruction.
4. **New conversation + history.**
5. **Slash/skill completions.**
6. **Settings + MCP config.**
7. **Workers view + OpenCode config.**

## Testing

The renderer and every discovery/parsing function are pure and get `node --test`
coverage with no VS Code: markdown → expected node structure, `/model` output →
model list, `SKILL.md` frontmatter → skill entries, an auth-shaped failure →
login guidance, an unrecognised failure → passed through untouched.

The webview's own behaviour stays manual, and the README records honestly what
has and has not been exercised — as it now does for the harnesses.

## Risks

- **A markdown renderer is a classic injection vector.** Building DOM nodes
  rather than HTML strings is the mitigation, and it is a hard rule here, not a
  preference.
- **Slash-command coverage is not knowable in advance.** Only `/model` is
  verified to work and `/status` verified not to. The design's answer is to
  offer only what has been checked.
- **Skill discovery depends on Claude Code's directory layout**, which is not a
  published contract. If nothing is found, the feature degrades to "no skills
  listed" rather than erroring.
