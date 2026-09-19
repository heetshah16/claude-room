# Extension maturation: a companion to Claude Code, not a competitor

**Status:** approved design, not yet implemented
**Date:** 2026-09-19

## Problem

The extension was built as a full orchestrator chat window with a room and a
worker fleet bolted on. The strategic review on this branch reversed that:
Claude Code's own UI is the chat, and this project's durable value is the
room, the workers, and sharing. The extension's job is now to *show and
control* those, not to be a second chat client.

The code has not caught up. A dependency query over the project graph
(`graphify-out/`, 2026-09-18) plus a direct read of `extension/src/extension.js`
found that the extension's structure still assumes the chat is the front door:

- The room process (`supervisor.start('room', …)`, L266), the worker pool
  (L391), the SSE subscription, and `republish` / `invite` / `postRoom`
  (L462 / L501 / L446) are all closures inside `openChat()`. Only the Workers
  sidebar registers at activation (L63–72). With the chat dormant, nothing
  starts the room and the sidebar has nothing to show.
- Publish and invite live in the chat webview's Room popover
  (`webview.js`, `publishBtnEl`), not the sidebar. The Publish control built
  in the delegate-and-devtunnels POC therefore never landed in the side panel
  the user asked for.
- The extension keeps its own worker-spawning logic (`workers.js`:
  `spawn`, `ownerId`, `workerRecipe`, `nextHandle`) that spec #2 gives the
  room natively.

This is the third of three sibling specs (Skills / delegation robustness /
this). It depends on spec #2 for the room-side worker routes.

## What was verified before designing

| Fact | Evidence |
|---|---|
| Room start, pool, republish, invite are inside `openChat()` | `extension.js`: `supervisor.start('room'` L266, `createWorkerPool(` L391, `republish` L462, `invite` L501; graph community "Chat Actions (openChat)" |
| The Workers view registers at activation, independent of the chat | `extension.js` L63–72 (`registerWebviewViewProvider('claudeRoom.workers', …)`) |
| `createWorkerPool` is consumed by `openChat`, the Workers view, and the worker detail panel | graph query, `createWorkerPool()` neighbourhood |
| Making the chat dormant keeps its tests green; deleting it would not | `chat-globals.test.js` and `webview-boot.test.js` load the chat modules together |
| Publish and the Room chip are chat-webview features | `docs/design-system.md` §8; `webview.js` `publishBtnEl` |
| Installer/packaging was deferred from the original extension design and never built | `2026-09-05-orchestrator-extension-design.md` build order, stage 5 |
| The extension's rendered appearance has never been verified in a real host | `ARCHITECTURE.md` §6 |

## Design

### 1. Lift the session out of `openChat()`

Introduce an activation-level **session** (`extension/src/session.js`, new),
started on activation (or first sidebar reveal), owning what today hides in
`openChat()`:

- start the room via the supervisor, wait for it, read the owner token
- the room client and the single SSE subscription (still one subscription,
  one ordering, per `ARCHITECTURE.md`)
- the worker pool, as a viewer (§3)
- `republish`, `invite`, `postRoom` (moved as-is, including the Dev Tunnels
  logic from the POC)

`openChat()` shrinks to: attach to the session, start the orchestrator
process, open the webview. The orchestrator and everything chat-specific
(permission mode, model picker, attachments, probes) stay inside the chat.
The room now runs whether or not the chat is ever opened.

### 2. A `claudeRoom.room` sidebar view

A second view in the existing activity-bar container, beside Workers.
Contents, moved out of the chat's Room popover: published/local state with
the address shown before committing (design-system §8), **Publish with Dev
Tunnels** / **Stop sharing**, **Invite** (join link to the clipboard, never
rendered), and the member roster (a roster that failed to load says so,
never an empty list). Same design-system rules as every other surface: theme
tokens only, SVG icons, state by word and shape, `textContent` throughout.
The chat's Room chip is removed from the composer (dormant chat, §4).

Its own view rather than a header inside Workers: each view keeps one
purpose, and it is a small `package.json` contribution.

### 3. Worker pool becomes a viewer with a thin client

`workers.js` keeps `applyRoomEvent` and the state/transcript tracking, which
drive the Workers view and detail panel. `spawn`, `ownerId`, `workerRecipe`,
and `nextHandle` are deleted. Add/Stop in the sidebar become HTTP calls to
the room (`POST /api/spawn-worker`, `POST /api/stop-worker`, added by spec
#2), through `room-client.js` — the same shape as `delegate`. The extension's
supervisor stops tracking `worker:<handle>` children; the room owns them.
One implementation of "spawn a worker," used by channel-mode sessions and the
extension alike, so the extension still works standalone with no channel
session.

### 4. The chat becomes dormant

Not deleted. A setting (`claudeRoom.enableChat`, default false) gates the
`claudeRoom.openChat` command and hides it from the palette. The code and its
tests stay, so it can be revived if a need justifies it, and so the
cross-loading tests stay green. The extension's front door is the Room and
Workers views.

### 5. Installer and packaging

Detect `claude`, `opencode`, and `devtunnel` on PATH (the `detectDevtunnel`
pattern from the POC, generalized). Show exactly what is missing and what
will be installed and where, install only on explicit confirmation (never
silently), and surface the one-time `devtunnel user login`. Package with
`vsce` into a `.vsix`. Strangers cannot be expected to hand-install three
binaries, so this matters most for Path B.

### 6. Parked debt, closed here

- Stale tailnet/office-wifi comment prose near the publish copy
  (`webview.js`/`webview.css`) is removed with the Room chip.
- `republish()` never resets `published` when a room restart fails, so it can
  stay `true` after the room did not come back. Fix in the moved code: set
  state from what actually happened, not from intent.

### 7. Verification

- New unit tests for `session.js`, the room-client spawn/stop calls, and the
  detection generalization (injected fakes, as elsewhere).
- Run `extension/harness/shoot.js` for the new Room view in dark and light
  themes at 320px and full width, per the design-system checklist.
- The manual F5 walkthrough has never been done. Do it once against the real
  editor and record the outcome in `extension/README.md`, honestly, including
  failures.

## Rejected alternatives

**Fold Room controls into the Workers view.** Rejected by the user: separate
views, one purpose each.

**Delete the chat.** Rejected: tests couple the chat modules, and dormant
costs nothing while keeping the option open.

**Keep the extension's own worker spawning.** Rejected: duplicates spec #2's
room-side implementation and forces the extension to own processes the room
now owns.

## Dependencies

- **Spec #2** must add `POST /api/spawn-worker` and `POST /api/stop-worker`
  (owner-authenticated, mirroring `/api/delegate`). The addendum is in spec
  #2 §1.

## Risks

- **Lifting the session touches the most-coupled function in the extension**
  (`openChat()`, the graph's densest node). Tests around `extension.js` are
  thin because it needs the real `vscode` module, so this refactor leans on
  the manual F5 walkthrough more than most changes here.
- **Starting the room at activation** means a process runs for anyone with
  the extension installed, even if they never chat. Consider starting on
  first reveal of either view rather than on activation.
- **The graph predates the POC commits** (`tunnel.js`, Task 3 edits). The
  structural findings hold, but refresh it (`/graphify --update`) before
  planning.
