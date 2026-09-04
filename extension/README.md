# Claude Room Orchestrator

A VS Code extension that packages [claude-room](../README.md) as one chat
window backed by a long-lived Claude Code session. The orchestrating Claude
delegates mechanical work to cheap OpenCode workers instead of doing it all
itself.

## Status

This extension is under active development. This tree is CommonJS
(`extension/package.json` has no `"type"` field), independent of the ESM
room server rooted at the repo's top level in `src/`.

## Development

```bash
cd extension
node --test test/
```

No runtime dependencies are required. Node 22+ and VS Code 1.90+ are assumed.
