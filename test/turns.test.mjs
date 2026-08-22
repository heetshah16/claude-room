import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TurnLog } from '../src/turns.mjs'

const msgs = [
  { id: 'm1', name: 'heet', text: 'find the TTL' },
  { id: 'm2', name: 'ana', text: 'and the refresh path' },
]
const usage = { input: 2, output: 300, cacheRead: 18000, cacheCreate: 0, cache1h: 0, cache5m: 0 }

test('opening a turn indexes it by every message that composed it', () => {
  const t = new TurnLog()
  const turn = t.open({ messages: msgs, participants: [{ memberId: 'a', weight: 1 }] })
  assert.equal(t.forMessage('m1').id, turn.id)
  assert.equal(t.forMessage('m2').id, turn.id)
  assert.equal(t.forMessage('nope'), null)
})

test('the preview names each speaker so a collapsed turn is still readable', () => {
  const t = new TurnLog()
  const turn = t.open({ messages: msgs })
  assert.ok(turn.preview.includes('heet: find the TTL'))
  assert.ok(turn.preview.includes('ana: and the refresh path'))
})

test('the first hook carrying a prompt_id names the open turn', () => {
  const t = new TurnLog()
  const turn = t.open({ messages: msgs })
  t.activity({ kind: 'tool-start', tool: 'Read' }, 'p1')
  assert.equal(turn.promptId, 'p1')
  assert.equal(t.get('p1').id, turn.id)
})

test('a later differing prompt_id does not steal the turn', () => {
  const t = new TurnLog()
  t.open({ messages: msgs })
  t.activity({ kind: 'tool-start', tool: 'Read' }, 'p1')
  t.activity({ kind: 'tool-start', tool: 'Grep' }, 'p2')
  assert.equal(t.get('p1').promptId, 'p1')
  assert.equal(t.get('p2'), null)
})

test('activity and replies accumulate on the open turn', () => {
  const t = new TurnLog()
  const turn = t.open({ messages: msgs })
  t.activity({ kind: 'tool-start', tool: 'Read', input: { file_path: 'a.js' } })
  t.activity({ kind: 'tool-end', tool: 'Read' })
  t.reply('done', 'heet')
  assert.equal(turn.activity.length, 2)
  assert.equal(turn.activity[0].input.file_path, 'a.js')
  assert.equal(turn.replies[0].text, 'done')
})

test('activity with no open turn is dropped rather than throwing', () => {
  const t = new TurnLog()
  assert.equal(t.activity({ kind: 'tool-start', tool: 'Read' }), null)
  assert.equal(t.reply('orphan'), null)
})

test('closing records usage and the cache ratio, then clears the open turn', () => {
  const t = new TurnLog()
  t.open({ messages: msgs })
  const turn = t.close('p1', usage)
  assert.equal(turn.usage.output, 300)
  assert.ok(Math.abs(turn.ratio - 18000 / 18002) < 1e-9)
  assert.ok(turn.endedAt >= turn.startedAt)
  assert.equal(t.openTurn(), null)
})

test('closing with no usage still ends the turn', () => {
  const t = new TurnLog()
  t.open({ messages: msgs })
  const turn = t.close('p1', null)
  assert.ok(turn.endedAt)
  assert.equal(turn.usage, null)
})

test('activity is capped so one runaway turn cannot grow without bound', () => {
  const t = new TurnLog()
  const turn = t.open({ messages: msgs })
  for (let i = 0; i < 600; i++) t.activity({ kind: 'tool-start', tool: 'X' })
  assert.equal(turn.activity.length, 500)
})

test('round-trips through JSON with both indexes intact', () => {
  const t = new TurnLog()
  t.open({ messages: msgs })
  t.activity({ kind: 'tool-start', tool: 'Read' }, 'p1')
  t.close('p1', usage)
  const back = TurnLog.fromJSON(JSON.parse(JSON.stringify(t.toJSON())))
  assert.equal(back.forMessage('m1').promptId, 'p1')
  assert.equal(back.get('p1').activity.length, 1)
  assert.equal(back.recent(10).length, 1)
})
