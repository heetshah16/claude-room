'use strict'
const { existsSync } = require('node:fs')

/**
 * Is the `devtunnel` CLI on PATH? Same question `resolveCommand` (src/spawn.mjs,
 * the room side) answers for `claude`/`opencode` -- reimplemented here rather
 * than imported, because extension/ is CommonJS and src/ is ESM and nothing
 * crosses that boundary by import (ARCHITECTURE.md).
 *
 * Deliberately simpler than resolveCommand: this only needs a yes/no to decide
 * whether to show the "install devtunnel" prompt, never a path to spawn --
 * `cmd: 'devtunnel'` below resolves through the OS the normal way.
 */
function detectDevtunnel({ exists = existsSync, env = process.env, platform = process.platform } = {}) {
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const names = platform === 'win32' ? ['devtunnel.exe', 'devtunnel.cmd'] : ['devtunnel']
  for (const dir of dirs) {
    for (const name of names) {
      if (exists(`${dir}/${name}`)) return true
    }
  }
  return false
}

/**
 * `devtunnel host -p <port> --allow-anonymous`: hosts the room's port on a
 * public *.devtunnels.ms URL. --allow-anonymous is required for a joiner with
 * no devtunnels account of their own -- the whole point of this path is that
 * they have nothing installed.
 */
function tunnelRecipe({ port, devtunnelPath = 'devtunnel' }) {
  return {
    cmd: devtunnelPath,
    args: ['host', '-p', String(port), '--allow-anonymous'],
    opts: { stdio: ['ignore', 'pipe', 'pipe'] },
  }
}

/**
 * Pull the public URL out of `devtunnel host`'s stdout.
 *
 * Prefers the port-free host (`https://<id>-<port>.<region>.devtunnels.ms`)
 * over the port-suffixed one on the same line, because that is the form a
 * plain browser link should use. Returns null on anything unrecognised rather
 * than throwing -- a `devtunnel` version bump changing this text must not
 * crash the extension host, only leave publishing not-yet-working.
 */
function parseTunnelUrl(output) {
  const urls = String(output).match(/https:\/\/[a-z0-9.-]+\.devtunnels\.ms(?::\d+)?/gi) ?? []
  if (!urls.length) return null
  const portFree = urls.find(u => !/:\d+$/.test(u))
  return portFree ?? urls[0]
}

module.exports = { detectDevtunnel, tunnelRecipe, parseTunnelUrl }
