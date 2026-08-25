import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Seats } from '../src/seats.mjs'

const agent = (handle, ownerId) => ({ id: 'm-' + handle, kind: 'agent', handle, ownerId })
const conn = () => ({ write() {}, end() {} })

test('a seat is online once joined and offline once released', () => {
  const s = new Seats()
  const r = s.join(agent('ana-agent', 'u-ana'), conn())
  assert.equal(r.ok, true)
  assert.equal(s.isOnline('ana-agent'), true)
  s.leave(r.seatId)
  assert.equal(s.isOnline('ana-agent'), false)
})

test('an unknown handle is not online', () => {
  assert.equal(new Seats().isOnline('nobody'), false)
})

test('a second claim on a live handle is refused', () => {
  const s = new Seats()
  s.join(agent('ana-agent', 'u-ana'), conn())
  const again = s.join(agent('ana-agent', 'u-ana'), conn())
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'handle-taken')
})

test('a handle can be reclaimed after the first seat leaves', () => {
  const s = new Seats()
  const first = s.join(agent('ana-agent', 'u-ana'), conn())
  s.leave(first.seatId)
  assert.equal(s.join(agent('ana-agent', 'u-ana'), conn()).ok, true)
})

test('others() excludes the seat itself', () => {
  const s = new Seats()
  const a = s.join(agent('ana-agent', 'u-ana'), conn())
  const b = s.join(agent('heet-agent', 'u-heet'), conn())
  assert.deepEqual(s.others(a.seatId).map(x => x.handle), ['heet-agent'])
  assert.deepEqual(s.others(b.seatId).map(x => x.handle), ['ana-agent'])
})

test('a non-agent member cannot take a seat', () => {
  const s = new Seats()
  const r = s.join({ id: 'u1', role: 'member', name: 'ana' }, conn())
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-an-agent')
})

test('online() reports handle, owner and uptime without leaking the connection', () => {
  const s = new Seats()
  s.join(agent('ana-agent', 'u-ana'), conn())
  const [row] = s.online()
  assert.equal(row.handle, 'ana-agent')
  assert.equal(row.ownerId, 'u-ana')
  assert.ok(row.joinedAt)
  // That array is JSON-serialised straight to browsers: a raw HTTP
  // connection object on a row would throw on circular references or leak
  // internals to every viewer.
  assert.ok(!('conn' in row), 'expected conn to be stripped from the online() row')
})
