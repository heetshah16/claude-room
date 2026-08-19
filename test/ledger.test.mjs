import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageLine, sumUsage, cacheRatio, attribute, Ledger } from '../src/ledger.mjs'

const line = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    usage: {
      input_tokens: 2,
      output_tokens: 319,
      cache_read_input_tokens: 21169,
      cache_creation_input_tokens: 15237,
      cache_creation: { ephemeral_1h_input_tokens: 15237, ephemeral_5m_input_tokens: 0 },
    },
  },
})

test('parses a real assistant transcript line', () => {
  const u = parseUsageLine(line)
  assert.deepEqual(u, {
    input: 2, output: 319, cacheRead: 21169, cacheCreate: 15237, cache1h: 15237, cache5m: 0,
  })
})

test('non-assistant, malformed, and blank lines yield null rather than throwing', () => {
  assert.equal(parseUsageLine(JSON.stringify({ type: 'user', message: {} })), null)
  assert.equal(parseUsageLine('{not json'), null)
  assert.equal(parseUsageLine(''), null)
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: {} })), null)
})

test('missing cache_creation detail defaults to zero, not NaN', () => {
  const u = parseUsageLine(
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
  )
  assert.equal(u.cache1h, 0)
  assert.equal(u.cacheRead, 0)
})

test('sums usages field by field', () => {
  const u = sumUsage([parseUsageLine(line), parseUsageLine(line)])
  assert.equal(u.output, 638)
  assert.equal(u.cacheRead, 42338)
})

test('cache ratio is cached reads over all input - the rotation instrument', () => {
  assert.ok(Math.abs(cacheRatio({ input: 2, cacheRead: 21169, cacheCreate: 15237 }) - 21169 / 36408) < 1e-9)
  assert.equal(cacheRatio({ input: 0, cacheRead: 0, cacheCreate: 0 }), 0)
  assert.equal(cacheRatio({ input: 100, cacheRead: 0, cacheCreate: 0 }), 0)
})

test('equal split divides a turn evenly across participants', () => {
  const got = attribute(
    { input: 10, output: 10, cacheRead: 10, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'a', weight: 1 }, { memberId: 'b', weight: 3 }],
    'equal',
  )
  assert.equal(got.a.output, 5)
  assert.equal(got.b.output, 5)
})

test('weighted split honours weights', () => {
  const got = attribute(
    { input: 0, output: 100, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'a', weight: 1 }, { memberId: 'b', weight: 3 }],
    'weighted',
  )
  assert.equal(got.a.output, 25)
  assert.equal(got.b.output, 75)
})

test('zero total weight falls back to an equal split instead of dividing by zero', () => {
  const got = attribute(
    { input: 0, output: 10, cacheRead: 0, cacheCreate: 0, cache1h: 0, cache5m: 0 },
    [{ memberId: 'a', weight: 0 }, { memberId: 'b', weight: 0 }],
    'weighted',
  )
  assert.equal(got.a.output, 5)
  assert.equal(got.b.output, 5)
})

test('a turn with no participants is recorded but attributed to nobody', () => {
  const l = new Ledger()
  l.record('p1', parseUsageLine(line), [], 'equal')
  assert.equal(l.turns().length, 1)
  assert.equal(l.totalsFor('nobody').output, 0)
})

test('ledger accumulates per member across turns and round-trips', () => {
  const l = new Ledger()
  const u = parseUsageLine(line)
  l.record('p1', u, [{ memberId: 'a', weight: 1 }], 'equal')
  l.record('p2', u, [{ memberId: 'a', weight: 1 }], 'equal')
  assert.equal(l.totalsFor('a').output, 638)
  const back = Ledger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())))
  assert.equal(back.totalsFor('a').output, 638)
  assert.equal(back.turns().length, 2)
})

test('recording the same promptId twice does not double-count', () => {
  const l = new Ledger()
  const u = parseUsageLine(line)
  l.record('p1', u, [{ memberId: 'a', weight: 1 }], 'equal')
  l.record('p1', u, [{ memberId: 'a', weight: 1 }], 'equal')
  assert.equal(l.turns().length, 1)
  assert.equal(l.totalsFor('a').output, 319)
})
