// extension/test/workers-view-boot.test.js
//
// Does workers-webview.js survive to the end and wire its controls?
//
// The fake DOM is duplicated rather than shared with room-view-boot.test.js,
// for the same reason that file gives for not sharing with webview-boot.test.js:
// each guards its own script and is not worth refactoring together.
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

function bootWorkersView() {
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
    setInterval: () => 0,
    Date,
    acquireVsCodeApi: () => ({ postMessage: m => posted.push(m), getState: () => null, setState() {} }),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  for (const f of ['icons.js', 'workers-format.js', 'workers-webview.js']) {
    vm.runInContext(readFileSync(join(CHAT, f), 'utf8'), sandbox, { filename: f })
  }
  return {
    get,
    posted,
    handleMessage: msg => (msgHandlers.message || []).forEach(fn => fn(msg)),
    fire: (el, ev, arg = {}) => (el.listeners.get(ev) || []).forEach(fn => fn(arg)),
  }
}

const workersMsg = workers => ({ data: { type: 'workers', workers } })

test('workers-webview.js runs to completion instead of dying on a missing global', () => {
  const boot = bootWorkersView()
  assert.ok(boot.posted.some(m => m.type === 'workers-refresh'))
})

test('adding a worker disables the button, so a slow spawn cannot be clicked twice', () => {
  // A real spawn takes several seconds (worktree, then a real opencode boot),
  // with nothing else in the UI showing that. Without this guard, an
  // impatient second click starts a second real worker, not a retry.
  const boot = bootWorkersView()
  boot.fire(boot.get('worker-add'), 'click')
  assert.equal(boot.posted.filter(m => m.type === 'add-worker').length, 1)
  assert.equal(boot.get('worker-add').disabled, true)
  boot.fire(boot.get('worker-add'), 'click')
  assert.equal(boot.posted.filter(m => m.type === 'add-worker').length, 1, 'a second click while disabled must not post again')
})

test('a workers update re-enables the button, whether the add succeeded or failed', () => {
  // The pool always posts a fresh list once an add attempt settles -- on
  // success the list changed, on failure it did not, but either way this is
  // the only signal the webview gets that the attempt is over.
  const boot = bootWorkersView()
  boot.fire(boot.get('worker-add'), 'click')
  assert.equal(boot.get('worker-add').disabled, true)
  boot.handleMessage(workersMsg([]))
  assert.equal(boot.get('worker-add').disabled, false)
})
