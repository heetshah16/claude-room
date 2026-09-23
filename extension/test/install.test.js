// extension/test/install.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { onPath, detectTools, installPlan } = require('../src/install.js')

test('a tool is found on PATH the same way the room resolves a command', () => {
  const exists = p => p === '/usr/local/bin/claude'
  assert.equal(onPath('claude', { exists, env: { PATH: '/usr/local/bin' }, platform: 'linux' }), true)
  assert.equal(onPath('opencode', { exists, env: { PATH: '/usr/local/bin' }, platform: 'linux' }), false)
})

test('on Windows the shim extensions are what actually exist on disk', () => {
  // `claude` on Windows is a .cmd shim; looking only for the bare name finds
  // nothing and the extension would offer to install something already there.
  const exists = p => p === 'C:/bin/claude.cmd'
  assert.equal(onPath('claude', { exists, env: { Path: 'C:/bin' }, platform: 'win32' }), true)
})

test('detectTools answers for all three, so one dialog can list everything missing', () => {
  const exists = p => p === '/usr/local/bin/claude'
  const found = detectTools({ exists, env: { PATH: '/usr/local/bin' }, platform: 'linux' })
  assert.deepEqual(found, { claude: true, opencode: false, devtunnel: false })
})

test('an empty PATH reports everything missing rather than throwing', () => {
  assert.deepEqual(
    detectTools({ exists: () => false, env: {}, platform: 'linux' }),
    { claude: false, opencode: false, devtunnel: false },
  )
})

test('the plan names the exact command a human would type, per platform', () => {
  const win = installPlan(['devtunnel'], { platform: 'win32' })
  assert.equal(win[0].tool, 'devtunnel')
  assert.equal(win[0].command, 'winget install --id Microsoft.devtunnel -e')
  const mac = installPlan(['devtunnel'], { platform: 'darwin' })
  assert.match(mac[0].command, /brew install/)
})

test('devtunnel carries its one-time login, because installing it is not enough', () => {
  // `devtunnel host` fails until `devtunnel user login` has been done once,
  // and that failure reads like a broken extension rather than a missing step.
  const [plan] = installPlan(['devtunnel'], { platform: 'win32' })
  assert.match(plan.note, /devtunnel user login/)
})

test('an unknown tool is dropped rather than offered as a guessed command', () => {
  // Offering a made-up install command is worse than offering none: it runs.
  assert.deepEqual(installPlan(['kubectl'], { platform: 'linux' }), [])
})

test('nothing missing means nothing to offer', () => {
  assert.deepEqual(installPlan([], { platform: 'win32' }), [])
})
