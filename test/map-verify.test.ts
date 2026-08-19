// Coverage for the parts of the map pipeline that are pure and deterministic
// but don't have a dedicated test file of their own in this pass:
//   - src/map/verify.ts:    keepSupported, and verifyClaims's grouping/ordering
//                           (exercised WITHOUT ever invoking the `claude` binary
//                           — see the note on the verifyClaims tests below)
//   - src/map/narrate.ts:   resolveCitation, which is pure and exported
//   - src/map/index.ts:     saveMap/loadMap round-trip and failure handling
//
// Nothing in this file calls a model. verifyClaims normally shells out to the
// `claude` binary via judgeBatch, but only after readEvidence() successfully
// reads at least one cited file. By citing files that do not exist on disk,
// readEvidence returns '' and verifyClaims short-circuits to an 'unsupported'
// verdict without ever calling judgeBatch/exec — which is exactly the
// grouping/ordering logic worth locking down here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keepSupported, verifyClaims } from '../src/map/verify.ts'
import type { VerifiedClaim } from '../src/map/verify.ts'
import { resolveCitation } from '../src/map/narrate.ts'
import type { Claim } from '../src/map/narrate.ts'
import { saveMap, loadMap } from '../src/map/index.ts'
import type { SystemMap, MappedRegion } from '../src/map/index.ts'

// --- verify.ts: keepSupported ----------------------------------------------

function verifiedClaim(overrides: Partial<VerifiedClaim>): VerifiedClaim {
  return {
    statement: 'a claim',
    evidence: ['src/a.ts'],
    files: ['src/a.ts'],
    kind: 'mechanism',
    verdict: 'supported',
    note: '',
    ...overrides,
  }
}

test('keepSupported: keeps only claims with verdict "supported"', () => {
  const claims = [
    verifiedClaim({ statement: 'ok', verdict: 'supported' }),
    verifiedClaim({ statement: 'bad', verdict: 'contradicted' }),
    verifiedClaim({ statement: 'unknown', verdict: 'unsupported' }),
  ]
  const kept = keepSupported(claims)
  assert.deepEqual(kept.map((c) => c.statement), ['ok'])
})

test('keepSupported: empty input yields empty output', () => {
  assert.deepEqual(keepSupported([]), [])
})

// --- verify.ts: verifyClaims grouping/ordering, without a model call -------

function claim(statement: string, files: string[]): Claim {
  return { statement, evidence: files, files, kind: 'mechanism' }
}

test('verifyClaims: return order matches input order regardless of grouping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parley-map-verify-'))
  try {
    // Cite files that do not exist, so readEvidence() returns '' and no
    // `claude` process is ever spawned — see file header note.
    const claims = [
      claim('first', ['missing-a.ts']),
      claim('second', ['missing-b.ts']),
      claim('third', ['missing-a.ts']), // same file-set as "first" — same group
      claim('fourth', ['missing-c.ts']),
    ]
    const results = await verifyClaims(root, claims, 4)
    assert.deepEqual(
      results.map((r) => r.statement),
      ['first', 'second', 'third', 'fourth'],
      'output order must match input order even though claims are internally grouped by cited file-set',
    )
    for (const r of results) {
      assert.equal(r.verdict, 'unsupported', 'a claim whose cited files cannot be read must default to unsupported')
      assert.equal(r.note, 'cited files could not be read')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyClaims: claims citing the same file-set are grouped but still each get their own verdict entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parley-map-verify-'))
  try {
    const claims = [claim('a', ['x.ts', 'y.ts']), claim('b', ['y.ts', 'x.ts'])] // same set, different order
    const results = await verifyClaims(root, claims, 2)
    assert.equal(results.length, 2)
    assert.deepEqual(results.map((r) => r.statement), ['a', 'b'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyClaims: empty claims array resolves to an empty array', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parley-map-verify-'))
  try {
    const results = await verifyClaims(root, [], 4)
    assert.deepEqual(results, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- narrate.ts: resolveCitation --------------------------------------------
// Models cite evidence as prose ("src/store.ts:2 — import statement: ..."),
// not bare paths. An exact-match-only implementation silently discarded every
// claim once; these tests lock down the tolerant parsing that fixed it.

test('resolveCitation: a bare known path resolves to itself', () => {
  const known = new Set(['src/store.ts', 'src/cli.ts'])
  assert.equal(resolveCitation('src/store.ts', known), 'src/store.ts')
})

test('resolveCitation: a path with a trailing :line resolves to the path', () => {
  const known = new Set(['src/store.ts'])
  assert.equal(resolveCitation('src/store.ts:2', known), 'src/store.ts')
})

test('resolveCitation: the real observed shape — path, line, and trailing prose', () => {
  const known = new Set(['src/store.ts'])
  const citation = 'src/store.ts:2 — import statement: import { DatabaseSync } from "node:sqlite"'
  assert.equal(resolveCitation(citation, known), 'src/store.ts')
})

test('resolveCitation: a path with only trailing prose (no line number) resolves to the path', () => {
  const known = new Set(['src/store.ts'])
  assert.equal(resolveCitation('src/store.ts is where tasks are persisted', known), 'src/store.ts')
})

test('resolveCitation: a ./-prefixed path resolves after stripping the prefix', () => {
  const known = new Set(['src/store.ts'])
  assert.equal(resolveCitation('./src/store.ts', known), 'src/store.ts')
})

test('resolveCitation: a basename matching exactly one known file resolves to it', () => {
  const known = new Set(['src/store.ts', 'src/cli.ts'])
  assert.equal(resolveCitation('store.ts', known), 'src/store.ts')
})

test('resolveCitation: a basename matching multiple known files returns null rather than guessing', () => {
  const known = new Set(['src/a/index.ts', 'src/b/index.ts'])
  assert.equal(resolveCitation('index.ts', known), null)
})

test('resolveCitation: a citation matching nothing known returns null', () => {
  const known = new Set(['src/store.ts'])
  assert.equal(resolveCitation('totally/unknown/file.ts', known), null)
})

test('resolveCitation: an empty or whitespace-only citation returns null', () => {
  const known = new Set(['src/store.ts'])
  assert.equal(resolveCitation('   ', known), null)
})

// --- index.ts: saveMap / loadMap --------------------------------------------

function fakeMap(): SystemMap {
  const region: MappedRegion = {
    id: 'r1',
    label: 'Region One',
    files: ['src/one.ts'],
    origin: 'directory',
    narrative: { purpose: 'does a thing', claims: [], unknowns: [] },
    dependsOn: [],
    dependedOnBy: [],
    narratedAt: 1700000000000,
  }
  return {
    root: '/fake/repo',
    builtAt: 1700000000000,
    regions: [region],
    roles: { 'src/one.ts': 'entry' },
    fileCount: 1,
    edgeCount: 0,
    groupingUnconfirmed: false,
  }
}

test('saveMap/loadMap: round-trips a map through disk unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-map-index-'))
  try {
    const original = fakeMap()
    saveMap(dir, original)
    const loaded = loadMap(dir)
    assert.deepEqual(loaded, original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadMap: returns null for a missing map file rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-map-index-'))
  try {
    assert.equal(loadMap(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadMap: returns null for a corrupt map file rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-map-index-'))
  try {
    writeFileSync(join(dir, 'map.json'), '{ not valid json')
    assert.equal(loadMap(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
