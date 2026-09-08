// extension/test/icons.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { icon, ICON_NAMES } = require('../src/chat/icons.js')

// The smallest document `icon` needs. Namespaced creation is what makes an
// <svg> actually render, rather than appear as an unknown HTML element.
function fakeDoc() {
  const make = tag => ({
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v },
    appendChild(c) { this.children.push(c); return c },
  })
  return { createElementNS: (ns, tag) => ({ ...make(tag), ns }) }
}

test('every named icon builds an svg element', () => {
  for (const name of ICON_NAMES) {
    const el = icon(name, fakeDoc())
    assert.equal(el.tag, 'svg', `${name} must be an svg`)
    assert.ok(el.children.length > 0, `${name} must have at least one path`)
  }
})

test('icons are built in the SVG namespace, or they render as unknown elements', () => {
  assert.equal(icon('wrench', fakeDoc()).ns, 'http://www.w3.org/2000/svg')
})

test('icons inherit the text colour instead of carrying their own', () => {
  const el = icon('wrench', fakeDoc())
  assert.equal(el.attrs.stroke, 'currentColor')
  assert.equal(el.attrs.fill, 'none')
})

test('icons are decorative, so they are hidden from screen readers', () => {
  // The accessible name lives on the button, per design section 3. An icon
  // that also announced itself would make every tool row say "wrench" twice.
  assert.equal(icon('wrench', fakeDoc()).attrs['aria-hidden'], 'true')
})

test('an unknown icon name throws rather than rendering an empty box', () => {
  assert.throws(() => icon('no-such-icon', fakeDoc()), /no-such-icon/)
})
