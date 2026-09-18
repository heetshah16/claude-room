# Delegate-into-real-Claude-Code, and Dev Tunnels sharing

**Status:** approved design, not yet implemented
**Date:** 2026-09-18

## Problem

Two decisions came out of a strategic review of this branch:

1. **Stop chasing Claude Code's own chat UI.** The `orchestrator-parity` work
   (markdown renderer, model picker, command dashboard, context meter) races
   a closed-source, first-party product that ships weekly — Anthropic's own
   "Agent Map" (VS Code extension 2.1.269, 2026-09-11) landed mid-branch and
   makes the gap concrete. `delegate`-to-cheap-models and the multiplayer
   room are the two things Anthropic structurally will not build (one
   undercuts their own model revenue, the other cuts against per-seat
   billing), so those are where the effort goes now.
2. **Sharing uses VS Code's own Dev Tunnels**, not Tailscale Funnel or
   Cloudflare Tunnel. A business decision, not a technical one — this spec
   implements it rather than re-litigating it.

This spec covers three pieces:

- **A**: formalize the room's *other* MCP surface — `src/channel.mjs`, loaded
  by a real `claude` session via `--dangerously-load-development-channels`
  — as the primary way to reach OpenCode workers. It already has `delegate`
  and pushes results back via a native MCP notification. Nobody has run it
  end to end from an actual interactive session; only a raw MCP test client
  has exercised it.
- **B**: a "Publish" control in the extension's side panel that stands up a
  public VS Code Dev Tunnel for the room, so a join link works for someone
  with nothing installed.
- **C**: `src/ui.mjs` — the browser page a joiner actually lands on — brought
  in line with `docs/design-system.md`'s principles, adapted for a page that
  cannot use `--vscode-*` tokens because it never runs inside VS Code.

## What was verified before designing

| Fact | Evidence |
|---|---|
| `channel.mjs` already exposes `delegate` and `notifyDelegationResult` | Read directly: `notifications/claude/channel` push, tagged `kind="delegation-result"`, keyed by `delegation_id` |
| That path has only been tested via a raw MCP client, never a live `claude` session | README's own "Status" section: the delegate tool was "run end to end, against real binaries" through an MCP client over stdio, not through an interactive CLI session |
| There is **no stable `vscode.*` API to programmatically create a public tunnel** | Searched the current VS Code API surface: `PortAttributesProvider` only supplies metadata for ports VS Code already auto-forwards; the public Dev Tunnels feature is UI-driven (Ports panel → Port Visibility → Public) or via Microsoft's separate `devtunnel` CLI |
| `devtunnel` CLI is a real, scriptable binary | `devtunnel host -p <port> --allow-anonymous [--protocol https]` prints connect URLs of the form `https://<id>.<region>.devtunnels.ms`; installable via `winget install --id Microsoft.devtunnel -e`; requires a one-time `devtunnel user login` (GitHub or Microsoft account) before it can host, independent of `--allow-anonymous` |
| `devtunnel` has no confirmed `--json`/`-o json` flag | Not documented anywhere found; output must be parsed as text, defensively |
| The room already restarts itself to publish | `extension/src/extension.js`'s `republish(next)` restarts the **room** child with `host: next ? PUBLISHED_HOST : '127.0.0.1'` (`PUBLISHED_HOST = '0.0.0.0'` in `room-client.js`), same port, same state dir. The advertised address is computed by `src/config.mjs`'s `advertiseHost()`, which prefers a Tailscale-range IP (`100.64.0.0/10`) over any other, or is overridden by `ROOM_ADVERTISE` |
| `src/ui.mjs` has its own fixed hex palette (a "Soft UI Evolution" theme, light/dark via `prefers-color-scheme`), unrelated to `docs/design-system.md`'s VS Code tokens | Read directly: `:root { --bg: #f6f6fb; ... }` |

Two consequences shape the design:

1. **"VS Code Dev Tunnels" is implemented by spawning the `devtunnel` CLI**,
   the same way the room already spawns `claude` and `opencode` — not by
   calling a `vscode.*` API that does not exist for this purpose. The
   product decision (use VS Code's own tunnel service) and the
   implementation mechanism (shell out to Microsoft's CLI for it) are
   different layers, and that is fine — `claude` and `opencode` are already
   handled the same way.
2. **`src/ui.mjs` cannot literally reuse `--vscode-*` tokens** — it is a
   plain browser document, reachable by people with no editor open at all.
   It gets its own token set that follows the same *principles*
   (derive-don't-invent, no emoji, accessibility floor, dense layout) with
   literal values instead of theme variables.

## Design

### A. Delegate via the room's channel MCP

No new room-side code — `channel.mjs` already does this. What is missing is
verification, plus one small addition:

**`list_workers` tool**, alongside `delegate` on the channel, so a real
session can answer "what's opencode doing?" without a side panel:

```
list_workers() -> { workers: [{ handle, model, task, state, deadline_s }] }
```

Backed by the same seat/worker bookkeeping `src/seats.mjs` already holds —
this is a read, not new state. This is the "drop into a conversation while
a worker is running" capability from the earlier discussion, done natively
instead of via a webview.

**Manual verification, recorded honestly** (this repo's own convention for
anything needing a real host): launch a real `claude` session against the
room's channel, delegate a real task to a real OpenCode worker, and confirm
the result notification is visible — and specifically, whether it appears
while the session sits idle at the prompt, or only surfaces once the next
message is sent (like the observer's brief). Either answer is usable; which
one it is changes what "drop into a conversation" actually means in
practice, and nothing here has confirmed it yet.

### B. Publish via Dev Tunnels

**`extension/src/tunnel.js`** (new), mirroring `room-client.js`'s shape:

- `tunnelRecipe({ port, devtunnelPath })` → `{ cmd, args, opts }` for the
  supervisor, running `devtunnel host -p <port> --allow-anonymous`.
- `parseTunnelUrl(output)` → the first `https://*.devtunnels.ms` host found
  in the CLI's stdout, or `null`. Pure, fed lines as they arrive — the CLI
  prints the URL once, then keeps running.
- `detectDevtunnel({ exists, env, platform })` → boolean, the same
  `resolveCommand`-style PATH check `src/spawn.mjs` already does for
  `claude`/`opencode`, reused rather than reinvented.

**Wired into the existing `republish()` flow**, not a parallel one:
publishing now means (a) start the tunnel child pointed at the room's port,
(b) wait for its URL, (c) restart the room with `ROOM_ADVERTISE=<tunnel
host>` instead of relying on `advertiseHost()`'s Tailscale autodetection,
(d) same teardown path un-publishes both. `PUBLISHED_HOST` (`0.0.0.0`) is
still correct — the room still needs to bind every interface for the tunnel
to reach it locally; only *what gets advertised* changes.

**Sign-in is a one-time, visible gate**, the same pattern `install.ts` in
the earlier extension design used for `claude`/`opencode`: if `devtunnel
user show` (or equivalent) reports not signed in, show exactly what will
happen and prompt `devtunnel user login` in a terminal before the first
publish — never silently.

**Side panel change**: the existing Room chip's publish button
(`extension/src/chat/webview.js`, `publishBtnEl`) already says "Publish to
this network" / shows the advertised address — the copy changes to name the
tunnel explicitly ("Publish with Dev Tunnels"), and the popover shows the
`devtunnels.ms` URL instead of a tailnet IP. The state machine
(`published`/`busy`/`advertised`) already fits; no new UI concept is needed.

### C. `src/ui.mjs` design-system pass

Not a rewrite — the page's structure and behavior are already right (the
user's own words: "the way our correct room opens was fine"). This is a
token and detail pass, applying `docs/design-system.md`'s *principles* with
values a standalone page can actually use:

| Principle (design-system.md) | Applied to `ui.mjs` |
|---|---|
| Derive every colour from *something* stable | Keep the existing light/dark hex pairs (already exist, already reasonable) but audit against the same contrast floor (§3): ≥4.5:1 body text in both themes, checked not assumed |
| Never `innerHTML` | Already true here (`esc()` used throughout) — confirm, don't change |
| SVG icons, never emoji | Audit for any emoji or Unicode pictograph; replace with the same Lucide-path approach `extension/src/chat/icons.js` uses, ported as a standalone module (no VS Code dependency in that file, so it is a straight copy) |
| Never colour alone | Audit status indicators (online/offline, busy/idle) for a word or shape alongside colour |
| Dense, like the editor | Already 22px-row-ish per the existing CSS; confirm against the 4px grid tokens (`--sp1`..`--sp6` already match this shape, just needs the grid documented) |
| Accessibility floor (§3) | Add what's missing: visible focus rings, `aria-label` on icon-only controls, live region for connection status |

This produces a page that *reads* like a sibling of the extension's chat
window — same instincts, same rigor — without pretending it runs inside
VS Code.

## Rejected alternatives

**Tailscale Funnel / Cloudflare Tunnel.** Both were the technical
recommendation before this decision; superseded by the business decision to
use VS Code's own Dev Tunnels. Recorded here so the reasoning isn't lost,
not because either was technically wrong.

**A `vscode.*` API call for tunnel creation.** Investigated and does not
exist for this purpose in the stable API. Not chased further.

**Rewriting `src/ui.mjs` from scratch.** Rejected per the user's own
assessment: the page already works and looks reasonable; this is a
token/detail alignment pass, not a rebuild.

## Risks

- **`devtunnel` requires interactive login once.** The extension cannot do
  this silently or on the user's behalf — it can only detect the gate and
  hand off to a terminal, the same as it already does for a missing
  `claude`/`opencode` binary.
- **Text-parsing the CLI's output** is inherently a little fragile across
  `devtunnel` versions. `parseTunnelUrl` is written defensively (returns
  `null` rather than throwing on a shape it doesn't recognise) and is a
  pure, independently tested function specifically so a version bump's
  fallout is visible and small.
- **The "does the channel notification interrupt an idle session" question
  is genuinely unverified** and shapes how much of a "live" experience this
  actually is without any webview. Task order puts this check early.
