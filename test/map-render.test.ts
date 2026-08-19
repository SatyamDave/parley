// Rendering (src/map/render.ts) turns a SystemMap into text for two audiences.
// These tests build SystemMap/MappedRegion objects by hand rather than a real
// map, since render.ts's contract is purely a function of that shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, forAgent, forHuman } from '../src/map/render.ts'
import type { SystemMap, MappedRegion } from '../src/map/index.ts'

function region(overrides: Partial<MappedRegion> = {}): MappedRegion {
  return {
    id: 'r1',
    label: 'Region One',
    files: ['src/one.ts'],
    origin: 'directory',
    narrative: { purpose: 'Does a thing.', claims: [], unknowns: [] },
    dependsOn: [],
    dependedOnBy: [],
    narratedAt: Date.now(),
    ...overrides,
  }
}

function map(overrides: Partial<SystemMap> = {}): SystemMap {
  return {
    root: '/fake/repo',
    builtAt: Date.now(),
    regions: [region()],
    roles: {},
    fileCount: 1,
    edgeCount: 0,
    groupingUnconfirmed: false,
    ...overrides,
  }
}

test('estimateTokens: roughly one token per four characters', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('abcdefghi'), 3, 'rounds up on a partial token')
})

test('forAgent: truncates output when it exceeds the token budget', () => {
  const bigClaims = Array.from({ length: 50 }, (_, i) => ({
    statement: `claim number ${i} repeated with enough text to add up to real size`,
    evidence: ['src/one.ts'],
    files: ['src/one.ts'],
    kind: 'mechanism' as const,
  }))
  const m = map({ regions: [region({ narrative: { purpose: 'p', claims: bigClaims, unknowns: [] } })] })
  const full = forAgent(m, 100_000)
  const truncated = forAgent(m, 50)
  assert.ok(estimateTokens(full) > 50, 'sanity: the full render exceeds the small budget')
  assert.ok(truncated.includes('truncated to fit context budget'), 'truncated output must say so')
  assert.ok(truncated.length < full.length, 'truncated output must actually be shorter')
})

test('forAgent: respects a generous budget by not truncating', () => {
  const m = map()
  const text = forAgent(m, 5000)
  assert.equal(text.includes('truncated to fit context budget'), false)
})

test('forAgent excludes unknowns by default; forHuman always includes them', () => {
  const withUnknown = region({
    narrative: { purpose: 'p', claims: [], unknowns: ['what does this actually validate?'] },
  })
  const m = map({ regions: [withUnknown] })

  const agentDefault = forAgent(m)
  assert.equal(agentDefault.includes('what does this actually validate?'), false)

  const agentIncluding = forAgent(m, 5000, true)
  assert.ok(agentIncluding.includes('what does this actually validate?'))

  const human = forHuman(m)
  assert.ok(human.includes('what does this actually validate?'), 'the human view must always show unknowns')
})

test('forAgent: only claims verified as supported appear in the MUST-KNOW section', () => {
  const claims = [
    { statement: 'unsupported invariant', evidence: ['src/one.ts'], files: ['src/one.ts'], kind: 'invariant' as const },
    { statement: 'supported invariant', evidence: ['src/one.ts'], files: ['src/one.ts'], kind: 'invariant' as const },
  ]
  const verified = [
    { ...claims[0], verdict: 'unsupported' as const, note: '' },
    { ...claims[1], verdict: 'supported' as const, note: '' },
  ]
  const r = region({
    narrative: { purpose: 'p', claims, unknowns: [] },
    verified,
  })
  const text = forAgent(map({ regions: [r] }))
  assert.ok(text.includes('supported invariant'), 'a supported claim must appear in MUST-KNOW')
  assert.equal(text.includes('unsupported invariant'), false, 'an unsupported claim must never be stated as fact in MUST-KNOW')
})

test('forAgent: a region under test/, scripts/, or bin/ is excluded from MUST-KNOW and ranked last', () => {
  const supportRegion = region({
    id: 'support',
    label: 'Test Support',
    files: ['test/helpers.ts'],
    narrative: {
      purpose: 'test helpers',
      claims: [{ statement: 'support invariant', evidence: ['test/helpers.ts'], files: ['test/helpers.ts'], kind: 'invariant' }],
      unknowns: [],
    },
  })
  const hubRegion = region({
    id: 'hub',
    label: 'Core',
    files: ['src/core.ts'],
    dependedOnBy: ['support'],
    narrative: {
      purpose: 'core',
      claims: [{ statement: 'core invariant', evidence: ['src/core.ts'], files: ['src/core.ts'], kind: 'invariant' }],
      unknowns: [],
    },
  })
  const m = map({ regions: [supportRegion, hubRegion], roles: { 'src/core.ts': 'hub' } })
  const text = forAgent(m)

  assert.equal(text.includes('- [Test Support] support invariant'), false, 'support region invariants must not appear in MUST-KNOW')
  assert.ok(text.includes('- [Core] core invariant'), 'the non-support region invariant should appear in MUST-KNOW')

  const componentsIdx = text.indexOf('COMPONENTS:')
  const coreIdx = text.indexOf('## Core', componentsIdx)
  const supportIdx = text.indexOf('## Test Support', componentsIdx)
  assert.ok(coreIdx > -1 && supportIdx > -1)
  assert.ok(coreIdx < supportIdx, 'the support region must be ranked after the hub-bearing region')
})

test('forAgent: region ranking is by hub-ness and fan-in, not file count', () => {
  // A big region with no hub files and no dependents vs. a single-file hub
  // region that many others depend on. The single-file region must rank first.
  const bigNonHub = region({
    id: 'big',
    label: 'Big Non-Hub',
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
  })
  const smallHub = region({
    id: 'hub',
    label: 'Small Hub',
    files: ['src/hub.ts'],
    dependedOnBy: ['big'],
  })
  const m = map({
    regions: [bigNonHub, smallHub],
    roles: { 'src/hub.ts': 'hub' },
  })
  const text = forAgent(m)
  const componentsIdx = text.indexOf('COMPONENTS:')
  const hubIdx = text.indexOf('## Small Hub', componentsIdx)
  const bigIdx = text.indexOf('## Big Non-Hub', componentsIdx)
  assert.ok(hubIdx > -1 && bigIdx > -1)
  assert.ok(hubIdx < bigIdx, 'the single-file hub region should rank before the larger non-hub region')
})
