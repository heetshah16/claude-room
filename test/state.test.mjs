import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/state.mjs'
import { Registry, createMember } from '../src/identity.mjs'
import { Ledger } from '../src/ledger.mjs'
import { Decisions } from '../src/decisions.mjs'

const fresh = () => mkdtempSync(join(tmpdir(), 'room-'))
const clean = dir => rmSync(dir, { recursive: true, force: true })

test('loading an empty directory yields empty collections, not an error', () => {
  const dir = fresh()
  const { registry, ledger, decisions } = new Store(dir).load()
  assert.equal(registry.all().length, 0)
  assert.equal(ledger.turns().length, 0)
  assert.equal(decisions.open().length, 0)
  clean(dir)
})

test('messages append and replay in order, newest last', () => {
  const dir = fresh()
  const s = new Store(dir)
  s.appendMessage({ id: '1', text: 'one' })
  s.appendMessage({ id: '2', text: 'two' })
  assert.deepEqual(new Store(dir).recent(10).map(m => m.id), ['1', '2'])
  clean(dir)
})

test('recent(n) returns only the tail', () => {
  const dir = fresh()
  const s = new Store(dir)
  for (let i = 0; i < 10; i++) s.appendMessage({ id: String(i) })
  assert.deepEqual(s.recent(3).map(m => m.id), ['7', '8', '9'])
  clean(dir)
})

test('a corrupt transcript line is skipped rather than crashing replay', () => {
  const dir = fresh()
  const s = new Store(dir)
  s.appendMessage({ id: '1' })
  appendFileSync(join(dir, 'transcript.jsonl'), '{broken\n')
  s.appendMessage({ id: '2' })
  assert.deepEqual(new Store(dir).recent(10).map(m => m.id), ['1', '2'])
  clean(dir)
})

test('registry, ledger and decisions survive a restart', () => {
  const dir = fresh()
  const s = new Store(dir)
  const r = new Registry()
  const m = r.add(createMember({ name: 'ana', role: 'member' }))
  const l = new Ledger()
  l.record('p1', { input: 1, output: 2, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 }, [{ memberId: m.id, weight: 1 }], 'equal')
  const d = new Decisions()
  d.add({ text: 'keep auth stateless', by: 'ana' })
  s.saveRegistry(r)
  s.saveLedger(l)
  s.saveDecisions(d)

  const back = new Store(dir).load()
  assert.equal(back.registry.byToken(m.token).name, 'ana')
  assert.equal(back.ledger.totalsFor(m.id).output, 2)
  assert.equal(back.decisions.open().length, 1)
  clean(dir)
})

test('the payer file round-trips and reads null when absent', () => {
  const dir = fresh()
  const s = new Store(dir)
  assert.equal(s.readPayer(), null)
  s.writePayer('ana-cred')
  assert.equal(s.readPayer(), 'ana-cred')
  clean(dir)
})
