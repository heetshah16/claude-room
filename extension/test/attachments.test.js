// extension/test/attachments.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { extensionForMime, attachmentPath, saveAttachment } = require('../src/attachments.js')

test('known image types map to their real extension', () => {
  assert.equal(extensionForMime('image/png'), '.png')
  assert.equal(extensionForMime('image/jpeg'), '.jpg')
  assert.equal(extensionForMime('image/gif'), '.gif')
  assert.equal(extensionForMime('image/webp'), '.webp')
})

test('the type is matched case-insensitively, since clipboards vary', () => {
  assert.equal(extensionForMime('IMAGE/PNG'), '.png')
})

test('an unknown type falls back to .bin rather than inventing one', () => {
  assert.equal(extensionForMime('application/x-weird'), '.bin')
  assert.equal(extensionForMime(''), '.bin')
  assert.equal(extensionForMime(null), '.bin')
})

test('a crafted mime type cannot escape the attachments directory', () => {
  // The mime string arrives from the webview's clipboard data. Deriving a
  // filename from it directly would be a path traversal; the extension comes
  // from the lookup table and never from the string itself.
  const p = attachmentPath('/store', 'image/../../etc/passwd', 'abc')
  assert.ok(!p.includes('..'), `path must not contain traversal: ${p}`)
  assert.match(p, /abc\.bin$/)
})

test('the filename is the uuid, so nothing user-controlled reaches the path', () => {
  assert.match(attachmentPath('/store', 'image/png', 'fixed-id'), /fixed-id\.png$/)
})

test('the written path lands under the given directory and is returned', () => {
  const writes = []
  const mkdirs = []
  const p = saveAttachment({
    dir: '/store',
    mime: 'image/png',
    base64: Buffer.from('hello').toString('base64'),
    uuid: 'fixed',
    fs: { mkdirSync: d => mkdirs.push(d), writeFileSync: (path, buf) => writes.push([path, buf]) },
  })
  assert.deepEqual(mkdirs, ['/store'])
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], p)
  assert.match(p, /fixed\.png$/)
  assert.equal(writes[0][1].toString(), 'hello', 'the decoded bytes are written, not the base64')
})

test('malformed base64 throws rather than writing a corrupt file', () => {
  // Buffer.from silently drops what it cannot decode, so a bad clipboard
  // payload would otherwise be written as a truncated image and read back
  // later as a mystery. Refuse it where the cause is still known.
  assert.throws(() => saveAttachment({
    dir: '/store', mime: 'image/png', base64: '!!!not base64!!!', uuid: 'x',
    fs: { mkdirSync() {}, writeFileSync() {} },
  }), /base64/)
})

test('empty content throws rather than writing a zero-byte image', () => {
  assert.throws(() => saveAttachment({
    dir: '/store', mime: 'image/png', base64: '', uuid: 'x',
    fs: { mkdirSync() {}, writeFileSync() {} },
  }), /base64/)
})

test('nothing is written when the payload is refused', () => {
  const writes = []
  try {
    saveAttachment({
      dir: '/store', mime: 'image/png', base64: '!!!', uuid: 'x',
      fs: { mkdirSync() {}, writeFileSync: (...a) => writes.push(a) },
    })
  } catch { /* expected */ }
  assert.deepEqual(writes, [], 'a refused attachment must leave no file behind')
})
