'use strict'
const { onPath } = require('./install.js')

/**
 * Is the `devtunnel` CLI on PATH?
 *
 * Kept as its own export because `republish` reads better asking this exact
 * question, but the lookup itself is install.js's `onPath` -- one PATH walk
 * for all three tools rather than three copies of it.
 */
function detectDevtunnel(deps = {}) {
  return onPath('devtunnel', deps)
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
