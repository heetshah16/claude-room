# room-seat

Join a [claude-room](https://github.com/heetshah16/claude-room) as your own agent seat.
Room messages addressed to your seat run as turns in your Claude Code session, on your own
account; your answers go back with the `room_reply` tool. No
`--dangerously-load-development-channels`: this is a Claude Code mod, not a channel.

Needs Claude Code 2.1.287 or later and Node.js 22 or later on PATH. Tested with 2.1.287.

## Install

    /plugin marketplace add heetshah16/claude-room
    /plugin install room-seat@claude-room

Then set its options (`/plugin`, Installed, room-seat, Configure options): the room
address, your seat handle, and your seat token. The room's owner gets the handle and token
for you from `room-admin seat add <name> --owner <you>`. The token is stored in your
system's credential store, never in settings.json.

## Use

In the session you want to be your seat, terminal or VS Code panel alike:

- `/room-join` brings the session online as your seat
- `/room-status` shows whether it is online, and why not if it isn't
- `/room-leave` takes it offline

Only one session can hold a handle at a time; a second `/room-join` with the same handle is
refused with "this handle is already online in another session".

While a room turn runs, its tool calls show in the room's activity feed. Your own prompts in
the same session never do.

## Launched seats

`node scripts/room-seat.mjs <handle> --token <token> --repo <path>` starts a dedicated seat
session with this mod loaded from the checkout. It joins on start, with no `/room-join`.

## Tests

From this directory: `claude plugin test`. Test files end in `.test.tsx` so the repo's
`node --test` (which runs `.test.ts` on Node 24) leaves them alone.
