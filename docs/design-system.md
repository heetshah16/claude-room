# Design system — the VS Code extension

A living document. It describes the visual and interaction language of
[`extension/`](../extension/), and the four surfaces built on it. Update it when
the UI changes; a change that lands in the webview and not here is a bug in this
file.

For what the system *is*, read [README.md](../README.md). For how the processes
fit together, read [ARCHITECTURE.md](../ARCHITECTURE.md). This file is only about
what a person sees and touches.

---

## 1. Principles

**Derive every colour from the editor.** No hex literal ever appears in
`webview.css`. The panel is a guest inside somebody's theme, and a fixed palette
looks correct in exactly one of them. A design pass that proposed a slate/green
palette was rejected for this reason.

**Never `innerHTML`.** Message text, thinking, tool inputs, tool results, worker
output and delegation briefs are all untrusted. Build nodes, set `textContent`.
This is the same rule [`src/ui.mjs`](../src/ui.mjs) states for the room's browser
client, and the CSP in `webview.html` enforces it.

**SVG icons, never emoji.** Emoji render differently on every platform, ignore
`currentColor`, and cannot be sized to a grid.

**Never colour alone.** Every status carries a word or a shape as well as a hue.
Roughly 1 in 12 men cannot separate the red/green pair that "busy vs idle" would
otherwise rely on.

**Dense, like the editor around it.** This is a professional tool sitting beside
a file tree, not a marketing page. 22px rows, 4px grid, no ornament.

**No build step, no runtime dependencies.** Plain CSS and DOM APIs. The room is
ESM and the extension is CommonJS, and nothing crosses that boundary by import.

---

## 2. Tokens

### Colour

All from VS Code. The panel inherits light, dark and high-contrast for free.

| Role | Token |
|---|---|
| Page background | `--vscode-editor-background` |
| Body text | `--vscode-editor-foreground` |
| Muted text, labels | `--vscode-descriptionForeground` |
| Borders, dividers | `--vscode-panel-border` |
| Raised surface (cards, popovers) | `--vscode-editorWidget-background` |
| Code, inline and block | `--vscode-textCodeBlock-background` |
| Accent, links, focus | `--vscode-focusBorder` |
| Primary action | `--vscode-button-background` / `-foreground` |
| Chip rest / hover | `--vscode-badge-background` / `--vscode-toolbar-hoverBackground` |
| Error | `--vscode-errorForeground` |
| Warning | `--vscode-editorWarning-foreground` |
| Success | `--vscode-testing-iconPassed` |
| Data series (6) | `--vscode-charts-{blue,purple,orange,yellow,green,red}` |

`--vscode-charts-*` is the one family VS Code ships specifically for
quantitative display, which is why the context bar uses it rather than inventing
one. Six is the ceiling, and it is the reason §6 groups nine `/context`
categories into six bands.

Every token gets a fallback, because a theme is allowed to omit any of them:

```css
--surface: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.08));
```

### Type

| Role | Family | Size |
|---|---|---|
| UI chrome | `--vscode-font-family` | 13px |
| Chat body | `--vscode-font-family` | 13px / 1.55 |
| Labels, chips, meta | `--vscode-font-family` | 11px |
| Code, paths, token counts | `--vscode-editor-font-family` | 12px |

Anything numeric or path-shaped is monospace, so digits align in a column and a
worktree path cannot be confused with prose. Web fonts are impossible here — the
CSP blocks `fonts.googleapis.com` — and undesirable anyway, since matching the
editor is the point.

### Space and shape

4px grid: `--sp-1: 4px` through `--sp-6: 24px`. Radius is `3px` on chips,
buttons and cards; `0` on full-width dividers. Rows are 22px, matching VS Code's
own tree.

### Motion

120ms for hover and chip state, 180ms for popover and disclosure. Nothing else
animates. Streaming text must never animate — it arrives many times a second and
a transition on it reads as jitter.

```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.01ms !important; animation: none !important; }
}
```

### Icons

Lucide paths (MIT), committed as `extension/src/chat/icons.js` exporting path
data, drawn with `createElementNS` into a 16×16 `viewBox="0 0 24 24"`,
`stroke="currentColor"`, `stroke-width="2"`, `fill="none"`. No network, no
sprite sheet, no build.

Set in use: `plus`, `slash`, `arrow-up`, `wrench`, `file-text`, `terminal`,
`users`, `circle-dot`, `chevron-right`, `alert-triangle`, `check`, `x`,
`loader`, `gauge`, `radio`.

---

## 3. Accessibility floor

Non-negotiable, and checked before any surface is called done.

- **Contrast ≥ 4.5:1** for body text in light *and* dark. VS Code tokens satisfy
  this within a theme; anything composited (a chip on a card on a background)
  gets verified rather than assumed.
- **Visible focus** on every interactive element: `outline: 1px solid
  var(--vscode-focusBorder); outline-offset: 2px`. Never removed.
- **Keyboard reachable.** The chip row is a toolbar with roving tabindex. A
  popover traps Tab while open, closes on Esc, and returns focus to its chip.
- **Live regions are atomic and meaningful.** One `role="status"
  aria-atomic="true"` per surface, announcing `"2 workers busy"` — never a bare
  number, and never one live region per chip competing to speak.
- **Icon-only buttons carry `aria-label`.** `+` is "Attach a file", `/` is
  "Commands and skills".
- **Disclosure state is announced** via `aria-expanded` on the summary, which
  `<details>`/`<summary>` gives for free — which is why tool cards use it.

---

## 4. Surface: the chat window

An editor tab (`ViewColumn.One`), deliberately not a sidebar view. That
placement raises the bar on everything else: if it will not sit where Claude
Code sits, it has to read like it.

### Layout

```
┌────────────────────────────────────────────────────────────────┐
│  [ rate limit banner — hidden unless limited ]                 │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  You                                                           │
│  Add tests for the parser                                      │
│                                                                │
│  Claude                                                        │
│  I'll delegate the mechanical part and review the result.      │
│  ▸ delegate  @worker-1 · execution                             │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  [ status line — "Thinking… (1.2k tokens)" ]                   │
├────────────────────────────────────────────────────────────────┤
│  Message the orchestrator…                                     │
│                                                                │
│  ⊕  ⁄     ◉ Room · Local   ⚡ Auto   Opus 5   ▪ 20.2k · 2%  ↑  │
└────────────────────────────────────────────────────────────────┘
```

Messages are flat and full-width — a small muted role label above the body, no
bubble, no per-role background. Assistant text renders through
`markdown.js`, which returns a `DocumentFragment`.

### The chip row

Five controls, left-grouped, send on the right. Each chip is a
`<button aria-expanded>` owning one popover; exactly one popover is open at a
time; Esc closes it and restores focus.

| Control | Opens | Notes |
|---|---|---|
| `⊕` | file picker | also the drop target and paste target |
| `⁄` | command dashboard | also triggered by typing `/` at position 0 |
| Room | publish / invite / roster | §7 |
| Permission | mode list | §8 |
| Model | model list | built; restyled to match |
| Context | breakdown panel | §6 |

Chips are 22px tall, 11px label, `--vscode-badge-background` at rest. State is
carried by a leading icon *and* the label text, never by colour alone —
`◉ Room · Published` differs from `○ Room · Local` in glyph, word and hue.

### Attachments

`⊕` opens VS Code's native file picker and inserts a workspace-relative path
into the composer. Drag-and-drop onto the message area does the same.

The orchestrator is not a room member and already holds Read and Glob, so a path
is the honest mechanism — the room's `/upload` route serves room members and is
deliberately not on this path.

**Clipboard paste, including images.** A `paste` event carrying
`clipboardData.items` of type `image/*` is intercepted:

1. Read the blob as an `ArrayBuffer` in the webview.
2. `postMessage` it to the extension host.
3. Host writes it under `globalStorageUri/attachments/<uuid>.png`.
4. Host posts the path back; the composer inserts it and shows a thumbnail chip.

The thumbnail previews from a `data:` URI, which the CSP already permits
(`img-src {{cspSource}} https: data:`). Pasted *text* is left entirely alone.
Attachment chips sit in a strip above the textarea, each removable with an `×`,
and clear when the message sends.

### Command dashboard

Opens on `⁄` or on `/` typed at position 0. A popover anchored above the
composer: a filter field, then results grouped under **Commands** and
**Skills**.

- Arrow keys move a highlight, Enter accepts, Esc closes, and the input keeps
  DOM focus throughout with `aria-activedescendant` pointing at the highlighted
  row. The list is `role="listbox"`, rows are `role="option"`.
- **Only print-mode-verified commands appear.** `/model` and `/context` are
  verified to work; `/status` is verified not to. A command whose headless
  behaviour has not been checked is omitted, because offering one that answers
  "isn't available in this environment" is worse than not offering it.
- Skills come from scanning `SKILL.md` frontmatter in the workspace and
  user-level skill directories, listing `name` and `description`. If nothing is
  found the group is empty rather than an error — the directory layout is not a
  published contract.
- Selecting a skill *inserts* it and leaves the caret at the end. Skills
  usually need an argument, so sending immediately would be wrong.

---

## 5. Surface: the workers sidebar

A new activity-bar container holding one view, **Workers**.

```
WORKERS                                        ⊕   ⟳
─────────────────────────────────────────────────────
● @worker-1                            busy · 2:14
  mimo-v2.5-free · .worktrees/worker-1
  ▸ Add tests for parser.mjs

○ @worker-2                                    idle
  mimo-v2.5-free · .worktrees/worker-2
```

Three lines per worker: handle and status; model and worktree; current task.
Status is a filled/hollow dot **and** a word. The countdown is the driver's own
per-turn deadline — the number that actually decides whether a stalled free model
gets killed, and therefore the only one worth showing.

**Empty state** reads *"No workers yet. One starts automatically the first time
the orchestrator delegates."* An empty list must never look like breakage.

**Lifecycle is on-demand.** Nothing spawns at startup, so a chat-only session
costs no worktree, no process, and does not require `opencode` on `PATH`. The
first `delegate` call starts a worker; `⊕` adds another by hand.

---

## 6. Surface: the worker detail tab

Clicking a row opens an editor tab beside the chat, using the same renderer and
the same stylesheet.

```
@worker-1   ● busy · 2:14 left                    [ Interrupt ]
mimo-v2.5-free · .worktrees/worker-1
──────────────────────────────────────────────────────────────
▾ BRIEF FROM ORCHESTRATOR                            execution
    Add tests for parser.mjs
    Files    src/parser.mjs, test/parser.test.mjs
    Verify   node --test test/parser.test.mjs
    Avoid    src/server.mjs
──────────────────────────────────────────────────────────────
▸ CAPABILITIES                          6 tools · 1 MCP server
──────────────────────────────────────────────────────────────
▸ read   src/parser.mjs
▸ write  test/parser.test.mjs
    Added 4 cases covering the empty-input path…
──────────────────────────────────────────────────────────────
  ⏳ queued · delivered after this turn
     "also cover the empty case"
──────────────────────────────────────────────────────────────
  Message @worker-1…                                        ↑
```

**The brief card renders the validated delegation record** — `class`, `task`,
`files`, `tests`, `do_not_touch` — as labelled fields, not the flat prose
`renderDelegation` produces for the model. Seeing the brief as structure is what
makes a bad brief visible as a bad brief.

**Capabilities** come from OpenCode's own `GET /config` and the tool parts in
`GET /session/:id/message`, so the card reports what the worker actually has
rather than what we assume it has.

**Input queues; it does not interrupt.** The room runs one turn per destination,
and `Queue.submit` gates a seat on being *online*, never on being *busy*. A
message typed here goes through `POST /msg` as `@handle …` and lands as the
worker's next turn. The composer says so before you send, and a pending row
stays visible until it is delivered — a message the sender believes landed is the
worst failure this system can have.

`Interrupt` is a separate, explicitly-labelled control that aborts the running
turn. It is never the default, because it discards work the orchestrator is
waiting on.

---

## 7. Surface: the context panel

Expands from the context chip, in-window.

```
CONTEXT · claude-opus-5                          20.2k / 1m · 2%
████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
▪ System tools 12.4k   ▪ Deferred 11.3k   ▪ Skills 3.7k
▪ System prompt 2.8k   ▪ Memory 1.6k      ▪ Messages 1.3k
────────────────────────────────────────────────────────────────
Deferred tools are 11.3k — the largest single block, and none of
it has been used this session.
────────────────────────────────────────────────────────────────
▸ Skills            38 loaded · 3.7k
▸ Memory files       1 file   · 1.6k
```

### Where the numbers come from

`/context`, run as an ordinary turn and parsed from the result text — the same
mechanism the model chip already uses for `/model`. It is a **synthetic** turn:
answered locally, no model call, no cost. Verified working in
`claude --print` on 2.1.216.

It reports these categories, and nine is more than any part-to-whole chart can
carry:

`System prompt` · `System tools` · `System tools (deferred)` · `MCP tools` ·
`Memory files` · `Skills` · `Custom agents` · `Messages` · `Free space`

### Why a bar and not a donut

A donut is legible to about five slices. Past that the guidance is explicit:
switch to a 100% stacked bar. So the bar carries **six bands** — System,
Deferred, MCP, Skills, Memory, Messages — mapped onto the six
`--vscode-charts-*` tokens, with free space left unfilled and outlined rather
than coloured.

The table underneath is not decoration. It is the accessible equivalent of the
bar and carries the exact values, because a bar alone conveys information by
colour and length only.

### The verdict line

One sentence of plain language derived from thresholds, because the request was
"so the user can know if things are not working optimally" — and a percentage
does not answer that. Examples: a skills block over 15% of used context, a
deferred-tools block larger than everything else combined, a memory file over
5k.

### Refresh

At turn-end only. The probe is free, but the orchestrator process serves one
turn at a time, so a timer could collide with a message being sent.

### Workers get a cruder meter, and say so

OpenCode has no `/context`. Per worker we show input/output totals from its
session message log, labelled *"estimated, from session log"*. It is coarser on
purpose and worth having anyway: it is how you tell a worker drowning in a
bloated brief from a model that is simply weak, and that distinction is a
judgement about the orchestrator, not the worker.

---

## 8. Surface: the room chip

```
◉ Room · Local                      ⚡ Auto
┌──────────────────────────────┐    ┌────────────────────────┐
│ Room  auth-work              │    │ ⚡ Auto                 │
│ ● Local only (127.0.0.1)     │    │   Edits applied,        │
│                              │    │   commands asked        │
│ [ Publish to tailnet ]       │    │ ✎ Accept edits          │
│   100.x.y.z:51820            │    │ ✋ Manual               │
│   restarts the room (~1s);   │    │ ▣ Plan                  │
│   the chat keeps going       │    │ ⚠ Bypass all            │
│ ──────────────────────────── │    └────────────────────────┘
│ MEMBERS                      │
│ ● you              owner     │
│ ○ ana              member    │
│ + Invite…                    │
└──────────────────────────────┘
```

**Publishing rebinds; it does not tear down.** `config.advertise` is fixed at
boot from `ROOM_HOST`, so publishing means restarting the room process with
`ROOM_HOST=0.0.0.0` — on the **same port and the same state dir**. So
`http://127.0.0.1:<port>` stays valid: the orchestrator's MCP bridge never
notices, the owner token persists, and the extension's SSE feed reconnects on
its own existing retry loop. Only the advertised address changes, which is what
join links use.

The advertised host prefers a Tailscale address (100.64.0.0/10) over a LAN one,
which `advertiseHost` already implements. The popover shows the exact address
before you commit, because "publish" on shared office wifi means something
different from "publish" on a tailnet.

**Invite** mints a named join link with a role through `POST /api/admin/invite`.
The token *is* the identity, so the UI says so plainly next to the copy button
and offers `rotate` on any member.

### Permission chip

Maps directly onto `claude --permission-mode`, which accepts `auto`,
`manual`, `acceptEdits`, `plan`, `dontAsk` and `bypassPermissions`. Nothing
needs porting from Claude Code — the flag exists and we simply were not passing
it.

Changing the mode **restarts the orchestrator with `--resume <sessionId>`**, so
the conversation survives. That path is already built and already used for crash
recovery. The chip shows a brief "reconnecting…" state rather than pretending
the switch is instantaneous.

`Bypass all` is styled as destructive, requires a confirm, and never persists
across sessions.

---

## 9. Checklist

Before any surface is called done:

- [ ] No hex literal in `webview.css`; every colour is a `var(--vscode-*)` with a fallback
- [ ] No emoji used as an icon
- [ ] No `innerHTML`, anywhere, on any path
- [ ] Every interactive element has a visible focus ring
- [ ] Every icon-only button has an `aria-label`
- [ ] Every status is legible without colour
- [ ] Screenshot verified in a dark theme *and* a light theme
- [ ] Verified at 320px sidebar width and at a full-width editor tab
- [ ] `prefers-reduced-motion` honoured
- [ ] Live regions are atomic and say something, not just a number
```
