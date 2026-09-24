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

/** The scripts webview.html loads, in order. `{{fooUri}}` names `foo.js`. */
function modulesLoadedByHtml() {
  const html = readFileSync(join(CHAT, 'webview.html'), 'utf8')
  return [...html.matchAll(/src="\{\{(\w+)Uri\}\}"/g)]
    .map(m => (m[1] === 'script' ? 'webview.js' : `${m[1]}.js`))
}

function fakeElement(id) {
  const listeners = new Map()
  return {
    id,
    value: '',
    selectionStart: 0,
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
    // icons.js builds real <svg> nodes, which only render when created in the
    // SVG namespace -- so the fake document has to offer the namespaced call
    // too, or webview.js throws at its first tool row.
    createElementNS: (ns, tag) => Object.assign(fakeElement(tag), { ns }),
    createDocumentFragment: () => fakeElement('#fragment'),
    createTextNode: text => ({ nodeType: 3, textContent: text }),
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

  // Load in the same order webview.html does.
  // Read out of webview.html rather than listed here, in the html's own order.
  // A hardcoded list is wrong the moment a module is added, and the failure it
  // produces -- "Cannot destructure property X of window.ClaudeY" -- looks like
  // a bug in the webview rather than a stale test. That happened twice.
  for (const f of modulesLoadedByHtml()) {
    vm.runInContext(readFileSync(join(CHAT, f), 'utf8'), sandbox, { filename: f })
  }
  return {
    elements,
    get,
    posted,
    /** Deliver a postMessage the way the extension host would. */
    handleMessage: msg => (msgHandlers.message || []).forEach(fn => fn(msg)),
    /** Fire an element's registered handlers for an event. */
    fire: (el, ev, arg = {}) => (el.listeners.get(ev) || []).forEach(fn => fn(arg)),
  }
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

// --- the command dashboard -------------------------------------------------

/** Type into the composer the way a person does: value, caret, input event. */
function typeInto(boot, text) {
  const input = boot.get('input')
  input.value = text
  input.selectionStart = text.length
  boot.fire(input, 'input')
  return input
}

test('typing a slash at the start of the composer opens the dashboard', () => {
  const boot = bootWebview()
  boot.get('dashboard').hidden = true
  typeInto(boot, '/')
  assert.equal(boot.get('dashboard').hidden, false, 'a leading slash must open the dashboard')
})

test('a slash mid-sentence does not open the dashboard', () => {
  // "and/or" is prose, not a command.
  const boot = bootWebview()
  boot.get('dashboard').hidden = true
  typeInto(boot, 'and/or')
  assert.equal(boot.get('dashboard').hidden, true)
})

test('a slash command with arguments closes the menu, which is in the way by then', () => {
  const boot = bootWebview()
  typeInto(boot, '/model')
  assert.equal(boot.get('dashboard').hidden, false)
  typeInto(boot, '/model sonnet')
  assert.equal(boot.get('dashboard').hidden, true)
})

test('Enter accepts the highlighted entry instead of sending the raw text', () => {
  const boot = bootWebview()
  const input = typeInto(boot, '/mod')
  let prevented = false
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() { prevented = true } })
  assert.ok(prevented, 'Enter must be consumed by the open dashboard')
  assert.ok(!boot.posted.some(m => m.text === '/mod'), 'the half-typed filter must never be sent')
  assert.ok(boot.posted.some(m => m.text === '/model'), 'the highlighted command must be what runs')
})

test('Escape closes the dashboard and leaves what was typed alone', () => {
  const boot = bootWebview()
  const input = typeInto(boot, '/mo')
  boot.fire(input, 'keydown', { key: 'Escape', preventDefault() {} })
  assert.equal(boot.get('dashboard').hidden, true)
  assert.equal(input.value, '/mo', 'Escape must not eat what was typed')
})

test('arrow keys move the highlight and Enter takes the moved-to entry', () => {
  const boot = bootWebview()
  const input = typeInto(boot, '/')
  boot.fire(input, 'keydown', { key: 'ArrowDown', preventDefault() {} })
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  // The registry's order is /model /context /cost /mcp, so one down is /context.
  assert.ok(boot.posted.some(m => m.text === '/context'),
    `expected /context, got ${JSON.stringify(boot.posted)}`)
})

test('skills posted from the host join the same list the commands are in', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'skills', skills: [
    { name: '/superpowers:brainstorming', summary: 'Explores intent', hint: '', sends: false },
  ] } })
  typeInto(boot, '/brain')
  assert.equal(boot.get('dashboard').hidden, false)
  assert.equal(boot.get('dash-empty').hidden, true, 'a match must not show the empty state')
})

test('a skill is inserted rather than sent, because it usually needs an argument', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'skills', skills: [
    { name: '/superpowers:brainstorming', summary: 'Explores intent', hint: '', sends: false },
  ] } })
  const input = typeInto(boot, '/brain')
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  assert.equal(input.value, '/superpowers:brainstorming ')
  assert.ok(!boot.posted.some(m => m.type === 'input' && m.text.includes('brainstorming')),
    'a bare skill name must not be sent')
})

test('a query matching nothing shows the empty state, not a blank panel', () => {
  const boot = bootWebview()
  typeInto(boot, '/zzzznope')
  assert.equal(boot.get('dashboard').hidden, false)
  assert.equal(boot.get('dash-empty').hidden, false)
})

test('Enter still sends normally when the dashboard is closed', () => {
  // The dashboard must not capture Enter for ordinary messages.
  const boot = bootWebview()
  const input = boot.get('input')
  input.value = 'hello there'
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  assert.ok(boot.posted.some(m => m.type === 'input' && m.text === 'hello there'))
})

// --- attachments -----------------------------------------------------------

test('an attachment from the host appears in the strip', () => {
  const boot = bootWebview()
  assert.equal(boot.get('attachments').hidden, true, 'the strip starts hidden')
  boot.handleMessage({ data: { type: 'attached', path: '/repo/notes.md', dataUrl: null } })
  assert.equal(boot.get('attachments').hidden, false)
})

test('attachment paths are prefixed onto the message, on their own lines', () => {
  // The model has to be told where the file is before it is told what to do
  // with it, and a path buried mid-sentence is not that.
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'attached', path: '/repo/notes.md', dataUrl: null } })
  const input = boot.get('input')
  input.value = 'summarise this'
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  const sent = boot.posted.find(m => m.type === 'input')
  assert.equal(sent.text, '/repo/notes.md\nsummarise this')
})

test('an attachment alone is sendable, with no typed text at all', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'attached', path: '/repo/shot.png', dataUrl: null } })
  const input = boot.get('input')
  input.value = ''
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  assert.ok(boot.posted.some(m => m.type === 'input' && m.text.includes('/repo/shot.png')))
})

test('sending clears the strip, so the next message does not resend the file', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'attached', path: '/repo/notes.md', dataUrl: null } })
  const input = boot.get('input')
  input.value = 'one'
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  input.value = 'two'
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  const second = boot.posted.filter(m => m.type === 'input')[1]
  assert.equal(second.text, 'two', 'the attachment must not ride along on the next message')
  assert.equal(boot.get('attachments').hidden, true)
})

test('an empty composer with no attachments still sends nothing', () => {
  const boot = bootWebview()
  const input = boot.get('input')
  input.value = '   '
  boot.fire(input, 'keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
  assert.equal(boot.posted.filter(m => m.type === 'input').length, 0)
})

test('the attach button asks the host to open a picker', () => {
  const boot = bootWebview()
  boot.fire(boot.get('attach-btn'), 'click')
  assert.ok(boot.posted.some(m => m.type === 'attach-file'))
})

// --- the permission chip ---------------------------------------------------
//
// The room chip moved to the claudeRoom.room sidebar view when the chat went
// dormant; its cases live in test/room-view-boot.test.js now.

test('only one chip-owned popover is open at a time', () => {
  // Two open at once would stack over the composer and hide what is typed.
  const boot = bootWebview()
  boot.fire(boot.get('context-chip'), 'click')
  assert.equal(boot.get('context-panel').hidden, false)
  boot.fire(boot.get('permission-chip'), 'click')
  assert.equal(boot.get('permission-panel').hidden, false)
  assert.equal(boot.get('context-panel').hidden, true)
})

test('choosing an ordinary permission mode tells the host at once', () => {
  const boot = bootWebview()
  boot.fire(boot.get('permission-chip'), 'click')
  const rows = boot.get('permission-list').children
  boot.fire(rows[0], 'click') // auto
  assert.ok(boot.posted.some(m => m.type === 'permission-mode' && m.mode === 'auto'))
})

test('bypassing every permission check is never one click', () => {
  const boot = bootWebview()
  boot.fire(boot.get('permission-chip'), 'click')
  const rows = [...boot.get('permission-list').children]
  const bypass = rows[rows.length - 1] // bypassPermissions is last
  boot.fire(bypass, 'click')
  assert.ok(!boot.posted.some(m => m.type === 'permission-mode'), 'one click must not enable bypass')

  // The second click, on the re-rendered row, confirms.
  const armed = [...boot.get('permission-list').children].at(-1)
  boot.fire(armed, 'click')
  assert.ok(boot.posted.some(m => m.type === 'permission-mode' && m.mode === 'bypassPermissions'))
})

test('reopening the popover disarms a pending confirmation', () => {
  // Otherwise an armed destructive row waits to be satisfied by an unrelated
  // click much later.
  const boot = bootWebview()
  boot.fire(boot.get('permission-chip'), 'click')
  boot.fire([...boot.get('permission-list').children].at(-1), 'click') // arm
  boot.fire(boot.get('permission-chip'), 'click') // close
  boot.fire(boot.get('permission-chip'), 'click') // reopen
  boot.fire([...boot.get('permission-list').children].at(-1), 'click')
  assert.ok(!boot.posted.some(m => m.type === 'permission-mode'), 'the confirmation must not survive a reopen')
})

test('the permission chip shows the mode the host reports', () => {
  const boot = bootWebview()
  boot.handleMessage({ data: { type: 'permission-mode', mode: 'plan' } })
  assert.equal(boot.get('permission-chip').textContent, 'Plan')
})
