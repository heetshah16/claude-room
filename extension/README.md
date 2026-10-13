# Claude Room

**A group chat where your team and your Claude Code sessions work together, run from your editor's sidebar.**

Claude Code is normally one person talking to one AI. Claude Room turns it into a room:

- **Teammates** join from a link in their browser.
- **Your Claude Code session** joins as a member. Anyone in the room can @mention it and ask
  for work. It runs in your project, on your Claude account.
- **Workers** are extra AI agents running on free models. They pick up routine tasks in
  their own copy of your repository.

Everyone sees the same conversation, so nobody has to re-explain what was decided or
paste transcripts around.

> **Early preview.** The basics work end to end: messages reach Claude, and Claude
> hands tasks to workers. Expect rough edges, and please
> [report them](https://github.com/heetshah16/claude-room/issues).

## What you can do

- **Talk to Claude Code from a shared chat.** Your Claude Code session shows up in the room as
  `@<your-username>-claude`. Messages to it run as turns in your session, and its answer
  comes back to the room.
- **Invite people with a link.** Click **Invite…**, type a name, and a personal join link is
  copied to your clipboard. They open it in any browser. They don't install anything, and
  they don't need an account or a copy of your code.
- **Share beyond your machine when you choose.** The room starts out reachable only from your
  own computer. **Publish with Dev Tunnels** gives it an internet address through Microsoft
  Dev Tunnels, and **Stop sharing** takes it back.
- **Hand routine work to workers.** In the **Workers** view, click **+**. Each worker is an
  [OpenCode](https://opencode.ai) agent on a free model, working on its own branch in its own
  folder (`.worktrees/worker-1`), so it never touches your working copy. You or Claude can
  @mention a worker in the room to give it a task.
- **See who's in the room and what the workers are doing**, from the Claude Room sidebar.

## Getting started

1. **Install this extension.**
2. **Install the Claude Code plugin.** You do this once per machine, and Claude Room can't
   do it for you. Run these two commands inside Claude Code:

   ```
   /plugin marketplace add heetshah16/claude-room
   /plugin install room-seat@claude-room
   ```

3. **Open your project folder and click the Claude Room icon** in the activity bar. This
   starts the room. If you want workers, the folder has to be a git repository.
4. **Start a new Claude Code session in that folder.** It joins the room automatically.
   Type `/room-status` in it to check. It should say *online as @&lt;you&gt;-claude*.
5. **Invite someone, or publish the room**, and start talking.

If something is missing, run **Claude Room: Check Required Tools** from the Command Palette.
It lists what's missing and copies the install commands for you. It never installs anything
by itself.

## What you need

| You need | For | Install |
|---|---|---|
| [Claude Code](https://claude.com/claude-code) 2.1.287 or newer, signed in | Your Claude in the room | `npm install -g @anthropic-ai/claude-code`, then run `claude` once |
| Node.js 22 or newer | The plugin and the workers | [nodejs.org](https://nodejs.org) |
| git and OpenCode | Workers only | `npm install -g opencode-ai` |
| Dev Tunnels CLI, signed in | Publishing only | `winget install Microsoft.devtunnel` (Windows) or `brew install --cask devtunnel` (macOS), then `devtunnel user login` once |

The room itself runs inside your editor, so there's no separate server to set up. Works in
**Cursor** and **VS Code**.

## Privacy and cost

- **Every Claude session runs on its owner's own account.** Your seat uses your Claude plan.
  Claude Room never copies or shares anyone's sign-in.
- **The room stays on your computer until you publish it.**
- **A join link works like a password** for the person it was made for. Send it only to them.
- **Workers use free models through OpenCode**, so they don't count against your Claude plan.
- The extension writes a small file, `.claude/room-seat.local.json`, in your project so your
  Claude session can find the room. It is kept out of git automatically. Don't share it.

## Commands

- **Claude Room: Restart Services**: use this if the room stops responding.
- **Claude Room: Check Required Tools**: shows what's missing and how to install it.

## Known limitations

- Teammates join from the browser. Bringing a teammate's *own* Claude Code session into your
  room isn't one-click yet.
- Stopping a worker doesn't delete its branch or folder. To clean up, run
  `git worktree remove .worktrees/worker-1` and then `git branch -D worker-1`.
- Publishing or restarting the room stops any running workers.
- The VS Code Marketplace listing is behind. Install from Open VSX for the current version.

## Learn more

- [Source code and full documentation](https://github.com/heetshah16/claude-room)
- [Report a problem](https://github.com/heetshah16/claude-room/issues)
