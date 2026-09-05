// Does webview.js actually finish executing and wire its handlers?
//
// The chat once stopped accepting input entirely because webview.js threw on
// its first line (a missing global) and never reached
// `inputEl.addEventListener('keydown', ...)` at the bottom. Nothing caught it:
// the module tests import the pure helpers, and no test ran the script itself.
//
// This boots webview.js against a fake DOM just complete enough to satisfy it,
// then asserts the handlers that make the chat usable are registered. It is a
// smoke test for "the script survives to the end", not a UI test.
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
    value: '',
    textContent: '',
    hidden: false,
    className: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    options: [],
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    listeners,
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
    },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c },
    append(...c) { this.children.push(...c) },
    remove() {},
    replaceChildren() { this.children = [] },
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}

function bootWebview() {
  const elements = new Map()
  const get = id => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  const document = {
    getElementById: get,
    createElement: tag => fakeElement(tag),
    createDocumentFragment: () => fakeElement('#fragment'),
    createTextNode: text => ({ nodeType: 3, textContent: text }),
    body: fakeElement('body'),
    addEventListener() {},
  }
  const window = { addEventListener() {}, document }
  const posted = []
  const sandbox = {
    window,
    document,
    console,
    acquireVsCodeApi: () => ({ postMessage: m => posted.push(m), getState: () => null, setState() {} }),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  // Load in the same order webview.html does.
  for (const f of ['markdown.js', 'model.js', 'webview.js']) {
    vm.runInContext(readFileSync(join(CHAT, f), 'utf8'), sandbox, { filename: f })
  }
  return { elements, get, posted }
}

test('webview.js runs to completion instead of dying on a missing global', () => {
  // The whole point: if it throws anywhere, this call throws and the chat is
  // dead in the real webview too.
  assert.doesNotThrow(() => bootWebview())
})

test('Enter in the composer is wired, which is what sends a message', () => {
  const { get } = bootWebview()
  const input = get('input')
  const keydown = input.listeners.get('keydown')
  assert.ok(keydown && keydown.length > 0, 'the input must have a keydown handler')
})

test('the Send button is wired', () => {
  const { get } = bootWebview()
  const send = get('send')
  assert.ok((send.listeners.get('click') ?? []).length > 0, 'send must have a click handler')
})

test('pressing Enter actually posts the message to the extension', () => {
  // Wiring that exists but does nothing is the same failure with extra steps,
  // so drive the handler and check something left the webview.
  const { get, posted } = bootWebview()
  const input = get('input')
  input.value = 'hello orchestrator'
  const handler = input.listeners.get('keydown')[0]
  handler({ key: 'Enter', shiftKey: false, preventDefault() {} })

  const sent = posted.find(m => m.type === 'input' && m.text === 'hello orchestrator')
  assert.ok(sent, `expected the message to be posted, got ${JSON.stringify(posted)}`)
})

test('Shift+Enter does not send, so a newline stays a newline', () => {
  const { get, posted } = bootWebview()
  const input = get('input')
  input.value = 'line one'
  const handler = input.listeners.get('keydown')[0]
  handler({ key: 'Enter', shiftKey: true, preventDefault() { assert.fail('must not preventDefault') } })
  assert.equal(posted.filter(m => m.type === 'input').length, 0)
})
