// extension/src/install.js
//
// Which of the three external binaries this extension needs are actually on
// PATH, and the exact command that installs a missing one.
//
// Generalises tunnel.js's detectDevtunnel: the question "is X on PATH" is the
// same one src/spawn.mjs's resolveCommand answers on the room side,
// reimplemented here because extension/ is CommonJS and src/ is ESM and
// nothing crosses that boundary by import (ARCHITECTURE.md).
//
// Nothing here installs anything. It returns commands; a caller shows them and
// installs only after an explicit confirmation. A silent install of a binary a
// user did not ask for is not a convenience, it is a surprise.
'use strict'
const { existsSync } = require('node:fs')

/** The names each tool actually has on disk, per platform. */
const NAMES = {
  claude: { win32: ['claude.exe', 'claude.cmd'], other: ['claude'] },
  opencode: { win32: ['opencode.exe', 'opencode.cmd'], other: ['opencode'] },
  devtunnel: { win32: ['devtunnel.exe', 'devtunnel.cmd'], other: ['devtunnel'] },
}

/**
 * How to install each tool, per platform, and anything that is still needed
 * afterwards. Verified commands only -- a tool with no known command for a
 * platform is omitted, because a guessed install command gets run.
 */
const INSTALL = {
  claude: {
    all: 'npm install -g @anthropic-ai/claude-code',
    note: 'Then run `claude` once to sign in with your existing subscription.',
  },
  opencode: {
    all: 'npm install -g opencode-ai',
    note: 'Workers run through this; the room needs it only when you add a worker.',
  },
  devtunnel: {
    win32: 'winget install --id Microsoft.devtunnel -e',
    darwin: 'brew install --cask devtunnel',
    other: 'curl -sL https://aka.ms/DevTunnelCliInstall | bash',
    note: 'Then run `devtunnel user login` once — publishing fails until you have.',
  },
}

/** Is `name` on PATH? A yes/no, never a path: spawning resolves through the OS. */
function onPath(name, { exists = existsSync, env = process.env, platform = process.platform } = {}) {
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const candidates = NAMES[name]
  if (!candidates) return false
  const names = platform === 'win32' ? candidates.win32 : candidates.other
  for (const dir of dirs) {
    for (const n of names) {
      if (exists(`${dir}/${n}`)) return true
    }
  }
  return false
}

/** All three answers at once, so one dialog can list everything that is missing. */
function detectTools(deps = {}) {
  return {
    claude: onPath('claude', deps),
    opencode: onPath('opencode', deps),
    devtunnel: onPath('devtunnel', deps),
  }
}

/**
 * The exact commands to offer for `missing`, in the order given.
 *
 * @param {string[]} missing tool names
 * @returns {Array<{tool: string, command: string, note: string}>}
 */
function installPlan(missing, { platform = process.platform } = {}) {
  const plan = []
  for (const tool of missing ?? []) {
    const spec = INSTALL[tool]
    if (!spec) continue // no verified command: offer nothing rather than a guess
    const command = spec.all ?? spec[platform] ?? spec.other
    if (!command) continue
    plan.push({ tool, command, note: spec.note })
  }
  return plan
}

module.exports = { onPath, detectTools, installPlan, NAMES }
