// extension/test/room-view-boot.test.js
//
// Does room-webview.js survive to the end and wire its controls?
//
// The same smoke test webview-boot.test.js runs for the chat, for the same
// reason: a script that throws on its first line leaves a view that looks
// present and does nothing. The fake DOM is duplicated rather than shared,
// because webview-boot.test.js guards a real historical bug and is not worth
// refactoring to make this file shorter.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const CHAT = join(__dirname, '..', 'src', 'chat')

function fakeElement(id) {
  const listeners = new Map()
  return {
    id,
    textContent: '',
    hidden: false,
    disabled: false,
    className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    listeners,
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
    },
    appendChild(c) { this.children.push(c); return c },
    setAttribute() {},
    removeAttribute() {},
  }
}

function bootRoomView() {
  const elements = new Map()
  const get = id => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  const document = {
    getElementById: get,
    createElement: tag => fakeElement(tag),
    // icons.js builds real <svg> nodes in the SVG namespace.
    createElementNS: (ns, tag) => Object.assign(fakeElement(tag), { ns }),
    body: fakeElement('body'),
    addEventListener() {},
  }
  const msgHandlers = {}
  const window = {
    addEventListener: (ev, fn) => { (msgHandlers[ev] = msgHandlers[ev] || []).push(fn) },
    document,
  }
  const posted = []
  const sandbox = {
    window,
    document,
    console,
    acquireVsCodeApi: () => ({ postMessage: m => posted.push(m), getState: () => null, setState() {} }),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  for (const f of ['icons.js', 'room-webview.js']) {
    vm.runInContext(readFileSync(join(CHAT, f), 'utf8'), sandbox, { filename: f })
  }
  return {
    get,
    posted,
    handleMessage: msg => (msgHandlers.message || []).forEach(fn => fn(msg)),
    fire: (el, ev, arg = {}) => (el.listeners.get(ev) || []).forEach(fn => fn(arg)),
  }
}

const roomMsg = room => ({ data: { type: 'room', room } })

test('room-webview.js runs to completion instead of dying on a missing global', () => {
  assert.doesNotThrow(() => bootRoomView())
})

test('a revealed view asks the host for the current room rather than waiting', () => {
  // A WebviewView is destroyed and rebuilt whenever the sidebar is collapsed
  // and reopened. Waiting for the next change means waiting forever.
  const boot = bootRoomView()
  assert.ok(boot.posted.some(m => m.type === 'room-refresh'))
})

test('publishing asks the host, naming the state being moved to', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  boot.fire(boot.get('publish-btn'), 'click')
  assert.ok(boot.posted.some(m => m.type === 'publish' && m.published === true))
})

test('the button says what it will do, so Stop sharing is never a guess', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: true, advertised: 'https://x-1.devtunnels.ms/?token=T', members: [] }))
  assert.match(boot.get('publish-btn').textContent, /Stop sharing/)
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  assert.match(boot.get('publish-btn').textContent, /Publish with Dev Tunnels/)
})

test('a restart in progress disables the button rather than queueing a second one', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ busy: true, published: false }))
  assert.equal(boot.get('publish-btn').disabled, true)
})

test('the room reports its state in words, not only by colour', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: true, advertised: 'https://x-1.devtunnels.ms/?token=T', members: [] }))
  assert.match(JSON.stringify(boot.get('room-state')), /published/)
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  assert.match(JSON.stringify(boot.get('room-state')), /local only/)
})

test('a join token never reaches the view, only the host part does', () => {
  // The token IS the identity. It goes to the clipboard, never on screen.
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({
    published: true, advertised: 'https://abc-1234.inc1.devtunnels.ms/?token=SECRETTOKEN', members: [],
  }))
  const rendered = JSON.stringify([boot.get('room-address'), boot.get('room-state'), boot.get('room-summary')])
  assert.ok(!rendered.includes('SECRETTOKEN'), 'the token must not be rendered anywhere')
  assert.ok(rendered.includes('abc-1234.inc1.devtunnels.ms'), 'the address itself should be shown')
})

test('the local address is shown before publishing, because it is the whole decision', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  assert.match(boot.get('room-address').textContent, /127\.0\.0\.1/)
})

test('clicking the published address asks the host to open it, token included', () => {
  // The DOM never renders the token (see the test above); the click handler
  // may still hand the full link to the extension host over postMessage,
  // which is an internal channel, not the screen -- that is what lets the
  // owner actually open their own working link instead of landing on a bare
  // "paste your join token" page with nothing to paste.
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({
    published: true, advertised: 'https://abc-1234.inc1.devtunnels.ms/?token=SECRETTOKEN', members: [],
  }))
  boot.fire(boot.get('room-address'), 'click')
  const opened = boot.posted.find(m => m.type === 'open-address')
  assert.ok(opened, 'a click must ask the host to open the address')
  assert.equal(opened.url, 'https://abc-1234.inc1.devtunnels.ms/?token=SECRETTOKEN')
})

test('clicking the local-only address does nothing, since there is nothing to open', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [] }))
  boot.fire(boot.get('room-address'), 'click')
  assert.ok(!boot.posted.some(m => m.type === 'open-address'))
})

test('a failed roster says so rather than claiming the room is empty', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: null }))
  assert.match(JSON.stringify(boot.get('room-members')), /could not read the roster/)
})

test('a member name is rendered as text, never as markup', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [
    { id: '1', name: '<img src=x onerror=alert(1)>', role: 'member' },
  ] }))
  assert.ok(JSON.stringify(boot.get('room-members')).includes('<img src=x onerror=alert(1)>'),
    'the name must survive as literal text')
})

// --- re-copying an invited member's link ------------------------------------

test('clicking an invited member re-copies their link, by id', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: true, advertised: 'https://x/?token=T', members: [
    { id: 'owner-1', name: 'owner', role: 'owner' },
    { id: 'm-ana', name: 'ana', role: 'member' },
  ] }))
  const row = boot.get('room-members').children.find(c => JSON.stringify(c).includes('ana'))
  boot.fire(row, 'click')
  assert.ok(boot.posted.some(m => m.type === 'copy-link' && m.memberId === 'm-ana'))
})

test('the owner\'s own row is not clickable -- they already have another way in', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: true, advertised: 'https://x/?token=T', members: [
    { id: 'owner-1', name: 'owner', role: 'owner' },
  ] }))
  const row = boot.get('room-members').children[0]
  boot.fire(row, 'click')
  assert.ok(!boot.posted.some(m => m.type === 'copy-link'))
})

test('a worker\'s row is not clickable -- its token is not a link anyone pastes', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: true, advertised: 'https://x/?token=T', members: [
    { id: 'owner-1', name: 'owner', role: 'owner' },
    { id: 'w1', name: 'worker-1', role: 'member', kind: 'agent' },
  ] }))
  const row = boot.get('room-members').children.find(c => JSON.stringify(c).includes('worker-1'))
  boot.fire(row, 'click')
  assert.ok(!boot.posted.some(m => m.type === 'copy-link'))
})

test('the live region says something, not a number', () => {
  const boot = bootRoomView()
  boot.handleMessage(roomMsg({ published: false, advertised: null, members: [
    { id: '1', name: 'you', role: 'owner' },
    { id: '2', name: 'ana', role: 'member' },
  ] }))
  assert.match(boot.get('room-summary').textContent, /local only · 2 members/)
})

test('inviting asks the host, because a webview cannot show a native prompt', () => {
  const boot = bootRoomView()
  boot.fire(boot.get('invite-btn'), 'click')
  assert.ok(boot.posted.some(m => m.type === 'invite'))
})

test('room-view.js substitutes a uri for every script tag room.html declares', () => {
  // A `{{fooUri}}` the provider never substitutes reaches the browser verbatim
  // as a src, which loads nothing and takes the view's globals down with it.
  const html = readFileSync(join(CHAT, 'room.html'), 'utf8')
  const provider = readFileSync(join(CHAT, 'room-view.js'), 'utf8')
  for (const [, name] of html.matchAll(/src="\{\{(\w+)Uri\}\}"/g)) {
    assert.ok(provider.includes(`{{${name}Uri}}`), `room.html loads {{${name}Uri}}, but room-view.js never substitutes it`)
  }
})

test('room.html carries the same strict CSP every other webview does', () => {
  const html = readFileSync(join(CHAT, 'room.html'), 'utf8')
  assert.match(html, /default-src 'none'/)
  assert.match(html, /script-src 'nonce-\{\{nonce\}\}'/)
  for (const [, tag] of html.matchAll(/<script([^>]*)>/g)) {
    assert.match(tag, /nonce="\{\{nonce\}\}"/, 'every script tag needs the nonce')
  }
})
