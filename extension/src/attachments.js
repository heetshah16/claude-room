// extension/src/attachments.js
//
// Where a pasted image goes.
//
// A file the user picks or drops already has a path, and a path is all the
// orchestrator needs -- it holds Read and Glob, and a workspace-relative path
// is the honest mechanism. The room's /upload route serves room members and is
// deliberately not on this path: it would put untrusted bytes through a second
// door for no gain.
//
// A pasted image has no path, so one is made here under the extension's own
// storage.
'use strict'
const nodeFs = require('node:fs')
const nodeCrypto = require('node:crypto')
const { join } = require('node:path')

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
}

/** A real extension for a known type, `.bin` for anything else. */
function extensionForMime(mime) {
  return MIME_EXT[String(mime ?? '').toLowerCase()] ?? '.bin'
}

/**
 * The path an attachment is written to.
 *
 * The extension comes from the lookup above and NEVER from the mime string
 * itself, and the filename is a uuid -- so nothing the webview supplies
 * reaches the path. The mime type arrives from clipboard data, and deriving a
 * filename from it directly is a path traversal waiting to be found.
 */
function attachmentPath(dir, mime, uuid) {
  return join(dir, `${uuid}${extensionForMime(mime)}`)
}

const BASE64_RE = /^[A-Za-z0-9+/\s]*={0,2}$/

/**
 * Decode and write one pasted attachment.
 *
 * @returns {string} the path written.
 */
function saveAttachment({ dir, mime, base64, fs = nodeFs, uuid = nodeCrypto.randomUUID() }) {
  const raw = String(base64 ?? '')
  // Buffer.from silently drops anything it cannot decode, so a corrupt
  // clipboard payload would otherwise be written as a truncated image and read
  // back later as a mystery. Refuse it here, where the cause is still known,
  // and before anything touches the disk.
  if (!raw.trim() || !BASE64_RE.test(raw)) throw new Error('attachment is not valid base64')
  const buf = Buffer.from(raw, 'base64')
  if (!buf.length) throw new Error('attachment is not valid base64')

  fs.mkdirSync(dir, { recursive: true })
  const path = attachmentPath(dir, mime, uuid)
  fs.writeFileSync(path, buf)
  return path
}

module.exports = { extensionForMime, attachmentPath, saveAttachment, MIME_EXT }
