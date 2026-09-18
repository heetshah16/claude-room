const { test } = require('node:test')
const assert = require('node:assert/strict')
const { detectDevtunnel, tunnelRecipe, parseTunnelUrl } = require('../src/tunnel.js')

test('devtunnel is detected on PATH the same way claude and opencode are', () => {
  const exists = p => p === '/usr/local/bin/devtunnel'
  const found = detectDevtunnel({
    exists, env: { PATH: '/usr/local/bin' }, platform: 'linux',
  })
  assert.equal(found, true)
})

test('a missing devtunnel is reported, not thrown', () => {
  const found = detectDevtunnel({ exists: () => false, env: { PATH: '/usr/local/bin' }, platform: 'linux' })
  assert.equal(found, false)
})

test('the recipe hosts the room\'s port and allows anonymous joiners', () => {
  // --allow-anonymous is not a relaxation here -- without it a joiner needs
  // their own Microsoft/GitHub account signed into the same tunnel, which
  // defeats "opens as a normal browser window for someone with nothing installed".
  const r = tunnelRecipe({ port: 51820, devtunnelPath: 'devtunnel' })
  assert.equal(r.cmd, 'devtunnel')
  assert.deepEqual(r.args, ['host', '-p', '51820', '--allow-anonymous'])
  assert.deepEqual(r.opts.stdio, ['ignore', 'pipe', 'pipe'])
})

test('the port-free devtunnels.ms host is extracted from real CLI output', () => {
  // A real `devtunnel host` line, captured against the actual binary.
  const line = 'Connect via browser: https://bskw8blx.inc1.devtunnels.ms:5001, https://bskw8blx-5001.inc1.devtunnels.ms\n'
  assert.equal(parseTunnelUrl(line), 'https://bskw8blx-5001.inc1.devtunnels.ms')
})

test('output with no URL yet returns null, not a throw', () => {
  assert.equal(parseTunnelUrl('Connecting...\n'), null)
})

test('a line carrying only the port-suffixed form still yields a usable host', () => {
  // Defensive: if a future CLI version ever prints only the :port form, take
  // it rather than surfacing nothing -- a URL with an explicit port still works.
  assert.equal(parseTunnelUrl('https://bskw8blx.inc1.devtunnels.ms:5001\n'), 'https://bskw8blx.inc1.devtunnels.ms:5001')
})
