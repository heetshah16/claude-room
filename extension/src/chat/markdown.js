// extension/src/chat/markdown.js
//
// A small markdown renderer for what Claude actually emits: fenced code
// blocks, inline code, bold, italic, links, bullet/numbered lists, headings,
// and blockquotes. Anything else falls through as plain text.
//
// Split in two on purpose:
//   parseMarkdown(text)        -- pure, returns a plain tree of {type, ...}
//                                  nodes. No DOM, so `node --test` can assert
//                                  on it directly.
//   renderMarkdown(text, doc)  -- walks that tree building real DOM nodes
//                                  with document.createElement/textContent.
//
// The input is model output, so renderMarkdown must never build an HTML
// string and hand it to innerHTML/outerHTML/insertAdjacentHTML -- that would
// reintroduce exactly the injection src/ui.mjs's header warns about for the
// room's own browser client. Every recognised inline/block construct becomes
// a real element via createElement, and every piece of literal text -- most
// importantly anything that merely *looks* like a tag, e.g. `<img onerror=..>`
// typed by the model -- goes through textContent, which the DOM renders as
// text, never as markup.
'use strict'

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const FENCE_RE = /^```(\S*)\s*$/
const FENCE_CLOSE_RE = /^```\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const BLOCKQUOTE_RE = /^>\s?(.*)$/
const BULLET_RE = /^[-*+]\s+(.*)$/
const NUMBERED_RE = /^\d+[.)]\s+(.*)$/

function isBlockStart(line) {
  return (
    FENCE_RE.test(line.trim()) ||
    HEADING_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    NUMBERED_RE.test(line)
  )
}

/**
 * Parse markdown text into a plain tree of block nodes. Pure -- no DOM.
 * @param {string} text
 * @returns {Array<object>}
 */
function parseMarkdown(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') { i++; continue }

    const fenceMatch = FENCE_RE.exec(line.trim())
    if (fenceMatch) {
      const lang = fenceMatch[1] || null
      i++
      const codeLines = []
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // consume the closing fence, if any
      blocks.push({ type: 'code-block', lang, text: codeLines.join('\n') })
      continue
    }

    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, children: parseInline(headingMatch[2]) })
      i++
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines = []
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
        quoteLines.push(BLOCKQUOTE_RE.exec(lines[i])[1])
        i++
      }
      blocks.push({ type: 'blockquote', children: parseInline(quoteLines.join('\n')) })
      continue
    }

    if (BULLET_RE.test(line) || NUMBERED_RE.test(line)) {
      const ordered = NUMBERED_RE.test(line)
      const itemRe = ordered ? NUMBERED_RE : BULLET_RE
      const items = []
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push({ children: parseInline(itemRe.exec(lines[i])[1]) })
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // A run of plain lines becomes one paragraph, joined with '\n' (rendered
    // as soft line breaks) until a blank line or the start of another block.
    const paraLines = []
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push({ type: 'paragraph', children: parseInline(paraLines.join('\n')) })
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Tried left-to-right at each position; since '**'/'__' are listed before the
// single-character '*'/'_' alternatives, a run like "**bold**" is claimed by
// the bold alternative before the italic one ever gets a chance to match the
// leading character.
function inlinePattern() {
  return /(`[^`\n]+?`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(\[[^\]\n]*\]\([^)\n]*\))/g
}

const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/

/**
 * Parse one block's inline text into a plain tree of inline nodes.
 * @param {string} text
 * @returns {Array<object>}
 */
function parseInline(text) {
  const nodes = []
  const re = inlinePattern()
  let lastIndex = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) nodes.push({ type: 'text', text: text.slice(lastIndex, m.index) })

    if (m[1]) {
      nodes.push({ type: 'code', text: m[1].slice(1, -1) })
    } else if (m[2]) {
      nodes.push({ type: 'bold', children: [{ type: 'text', text: m[2].slice(2, -2) }] })
    } else if (m[3]) {
      nodes.push({ type: 'bold', children: [{ type: 'text', text: m[3].slice(2, -2) }] })
    } else if (m[4]) {
      nodes.push({ type: 'italic', children: [{ type: 'text', text: m[4].slice(1, -1) }] })
    } else if (m[5]) {
      nodes.push({ type: 'italic', children: [{ type: 'text', text: m[5].slice(1, -1) }] })
    } else if (m[6]) {
      const linkMatch = LINK_RE.exec(m[6])
      nodes.push({ type: 'link', text: linkMatch ? linkMatch[1] : '', href: linkMatch ? linkMatch[2] : '' })
    }

    lastIndex = re.lastIndex
  }
  if (lastIndex < text.length) nodes.push({ type: 'text', text: text.slice(lastIndex) })
  return nodes
}

// Only these schemes are ever turned into a real, followable link. Anything
// else (javascript:, data:, vbscript:, ...) is model output that merely looks
// like a link and is rendered as inert text instead.
const SAFE_HREF_RE = /^(https?:|mailto:)/i

function isSafeHref(href) {
  if (typeof href !== 'string' || href.length === 0) return false
  if (SAFE_HREF_RE.test(href)) return true
  // A scheme-less relative/anchor reference (no ":" before the first slash
  // or the end of the string) is also fine; anything with an unknown scheme
  // is not.
  const colon = href.indexOf(':')
  const slash = href.indexOf('/')
  if (colon === -1) return true
  return slash !== -1 && slash < colon
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

/** Split on '\n' and turn each break into a real <br>, never raw HTML. */
function renderTextWithBreaks(text, doc) {
  const frag = doc.createDocumentFragment()
  const parts = String(text).split('\n')
  parts.forEach((part, idx) => {
    if (part) frag.appendChild(doc.createTextNode(part))
    if (idx < parts.length - 1) frag.appendChild(doc.createElement('br'))
  })
  return frag
}

function renderInlineNodes(nodes, doc) {
  const frag = doc.createDocumentFragment()
  for (const node of nodes) frag.appendChild(renderInlineNode(node, doc))
  return frag
}

function renderInlineNode(node, doc) {
  switch (node.type) {
    case 'text':
      return renderTextWithBreaks(node.text, doc)
    case 'code': {
      const el = doc.createElement('code')
      el.className = 'md-inline-code'
      el.textContent = node.text
      return el
    }
    case 'bold': {
      const el = doc.createElement('strong')
      el.appendChild(renderInlineNodes(node.children, doc))
      return el
    }
    case 'italic': {
      const el = doc.createElement('em')
      el.appendChild(renderInlineNodes(node.children, doc))
      return el
    }
    case 'link': {
      if (isSafeHref(node.href)) {
        const el = doc.createElement('a')
        el.setAttribute('href', node.href)
        el.setAttribute('rel', 'noopener noreferrer')
        el.textContent = node.text
        return el
      }
      // Unsafe scheme: render as inert text, not a followable link.
      return doc.createTextNode(`[${node.text}](${node.href})`)
    }
    default:
      return doc.createTextNode('')
  }
}

function renderBlock(block, doc) {
  switch (block.type) {
    case 'code-block': {
      const pre = doc.createElement('pre')
      pre.className = 'md-code-block'
      const code = doc.createElement('code')
      if (block.lang) code.className = `language-${block.lang}`
      code.textContent = block.text
      pre.appendChild(code)
      return pre
    }
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6)
      const el = doc.createElement(`h${level}`)
      el.className = 'md-heading'
      el.appendChild(renderInlineNodes(block.children, doc))
      return el
    }
    case 'blockquote': {
      const el = doc.createElement('blockquote')
      el.className = 'md-blockquote'
      el.appendChild(renderInlineNodes(block.children, doc))
      return el
    }
    case 'list': {
      const el = doc.createElement(block.ordered ? 'ol' : 'ul')
      el.className = 'md-list'
      for (const item of block.items) {
        const li = doc.createElement('li')
        li.appendChild(renderInlineNodes(item.children, doc))
        el.appendChild(li)
      }
      return el
    }
    case 'paragraph':
    default: {
      const el = doc.createElement('p')
      el.className = 'md-paragraph'
      el.appendChild(renderInlineNodes(block.children, doc))
      return el
    }
  }
}

/**
 * Render markdown text into a DocumentFragment of real DOM nodes. The only
 * thing the caller should ever append is this fragment.
 * @param {string} text
 * @param {Document} doc
 * @returns {DocumentFragment}
 */
function renderMarkdown(text, doc) {
  const tree = parseMarkdown(text)
  const frag = doc.createDocumentFragment()
  for (const block of tree) frag.appendChild(renderBlock(block, doc))
  return frag
}

const api = { parseMarkdown, parseInline, renderMarkdown, isSafeHref }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api
}
if (typeof window !== 'undefined') {
  window.ClaudeMarkdown = api
}
