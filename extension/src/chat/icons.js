// extension/src/chat/icons.js
//
// Inline SVG icons, built as DOM nodes. Lucide path data (MIT).
//
// Emoji were used here before -- a wrench on every tool row. They render
// differently on every platform, cannot take `currentColor` (so they stay
// full-colour against a themed foreground), and cannot be aligned to the grid.
//
// Path data only. No SVG markup string is ever parsed, which keeps this on the
// right side of the no-innerHTML rule that message text, tool inputs and
// worker output all depend on.
'use strict'

const SVG_NS = 'http://www.w3.org/2000/svg'

// Drawn on Lucide's 24-unit grid, rendered at 16px.
const PATHS = {
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  plus: ['M5 12h14', 'M12 5v14'],
  slash: ['M22 2 2 22'],
  'arrow-up': ['M12 19V5', 'm5 12 7-7 7 7'],
  gauge: ['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M22 21v-2a4 4 0 0 0-3-3.87'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'circle-dot': ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  'alert-triangle': ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z', 'M12 9v4', 'M12 17h.01'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  'file-text': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', 'M14 2v5h5', 'M10 13h4', 'M10 17h4'],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8'],
  radio: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M7.76 16.24a6 6 0 0 1 0-8.48', 'M16.24 7.76a6 6 0 0 1 0 8.48', 'M4.93 19.07a10 10 0 0 1 0-14.14', 'M19.07 4.93a10 10 0 0 1 0 14.14'],
}

const ICON_NAMES = Object.keys(PATHS)

/**
 * @param {string} name  one of ICON_NAMES
 * @param {Document} doc
 * @returns {SVGElement} a 16x16 icon that inherits the current text colour
 */
function icon(name, doc) {
  const paths = PATHS[name]
  // A silent empty box would be worse than a crash: it looks like a layout
  // bug rather than a typo, and the typo is what it always is.
  if (!paths) throw new Error(`unknown icon: ${name}`)

  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  // Decorative: the accessible name belongs on the control that contains it.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'icon')

  for (const d of paths) {
    const p = doc.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

// Uniquely named: browser <script> tags share one global scope, and a second
// file declaring the same top-level const is a SyntaxError that silently kills
// whichever script loads later. That cost this chat its send button once.
const iconsApi = { icon, ICON_NAMES }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = iconsApi
}
if (typeof window !== 'undefined') {
  window.ClaudeIcons = iconsApi
}
