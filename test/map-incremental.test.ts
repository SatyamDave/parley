// Coverage for the incremental-rebuild logic added to src/map/index.ts:
//   computeFileHashes, diffFiles, regionUnchanged
// plus saveMap/loadMap's handling of the new (optional) fileHashes field.
//
// Why this file exists: regionUnchanged is the gate that decides whether a
// region's narrative and verification get reused instead of redone. A false
// "true" here means a stale narrative is presented as current fact — the
// exact failure the map layer exists to prevent. It was previously exercised
// by exactly one manual happy-path run. These tests pin down the edge cases
// instead of leaving them argued-about.
//
// Nothing in this file calls a model.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeFileHashes, diffFiles, regionUnchanged, saveMap, loadMap } from '../src/map/index.ts'
import type { SystemMap, MappedRegion } from '../src/map/index.ts'
import type { SourceFile } from '../src/map/skeleton.ts'
import type { Region } from '../src/map/regions.ts'

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'parley-map-incremental-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

function sourceFile(path: string): SourceFile {
  return { path, loc: 1, exports: [], imports: [], external: [] }
}

// --- computeFileHashes -------------------------------------------------

describe('computeFileHashes', () => {
  test('produces a stable hash for a file whose content did not change', () => {
    const root = fixture({ 'src/a.ts': 'export const a = 1' })
    try {
      const files = [sourceFile('src/a.ts')]
      const first = computeFileHashes(root, files)
      const second = computeFileHashes(root, files)
      assert.equal(first['src/a.ts'], second['src/a.ts'])
      assert.equal(typeof first['src/a.ts'], 'string')
      assert.ok(first['src/a.ts'].length > 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('hash changes after the file content changes', () => {
    const root = fixture({ 'src/a.ts': 'export const a = 1' })
    try {
      const files = [sourceFile('src/a.ts')]
      const before = computeFileHashes(root, files)
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 2')
      const after = computeFileHashes(root, files)
      assert.notEqual(before['src/a.ts'], after['src/a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a file listed but missing from disk is silently omitted, not a crash or empty-string entry', () => {
    const root = fixture({ 'src/a.ts': 'export const a = 1' })
    try {
      const files = [sourceFile('src/a.ts'), sourceFile('src/gone.ts')]
      const hashes = computeFileHashes(root, files)
      assert.deepEqual(Object.keys(hashes), ['src/a.ts'])
      assert.equal('src/gone.ts' in hashes, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('identical content at two different paths hashes the same', () => {
    const root = fixture({
      'src/a.ts': 'export const same = 1',
      'src/b.ts': 'export const same = 1',
    })
    try {
      const files = [sourceFile('src/a.ts'), sourceFile('src/b.ts')]
      const hashes = computeFileHashes(root, files)
      assert.equal(hashes['src/a.ts'], hashes['src/b.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// --- diffFiles -----------------------------------------------------------

describe('diffFiles', () => {
  test('nothing changed: all arrays empty, changed set empty', () => {
    const prior = { 'a.ts': 'h1', 'b.ts': 'h2' }
    const current = { 'a.ts': 'h1', 'b.ts': 'h2' }
    const diff = diffFiles(current, prior)
    assert.deepEqual(diff.added, [])
    assert.deepEqual(diff.modified, [])
    assert.deepEqual(diff.deleted, [])
    assert.equal(diff.changed.size, 0)
  })

  test('a modified file is classified as modified only', () => {
    const prior = { 'a.ts': 'h1' }
    const current = { 'a.ts': 'h2' }
    const diff = diffFiles(current, prior)
    assert.deepEqual(diff.modified, ['a.ts'])
    assert.deepEqual(diff.added, [])
    assert.deepEqual(diff.deleted, [])
    assert.deepEqual([...diff.changed], ['a.ts'])
  })

  test('an added file is classified as added only', () => {
    const prior = { 'a.ts': 'h1' }
    const current = { 'a.ts': 'h1', 'b.ts': 'h2' }
    const diff = diffFiles(current, prior)
    assert.deepEqual(diff.added, ['b.ts'])
    assert.deepEqual(diff.modified, [])
    assert.deepEqual(diff.deleted, [])
    assert.deepEqual([...diff.changed], ['b.ts'])
  })

  test('a deleted file is classified as deleted only', () => {
    const prior = { 'a.ts': 'h1', 'b.ts': 'h2' }
    const current = { 'a.ts': 'h1' }
    const diff = diffFiles(current, prior)
    assert.deepEqual(diff.deleted, ['b.ts'])
    assert.deepEqual(diff.added, [])
    assert.deepEqual(diff.modified, [])
    assert.deepEqual([...diff.changed], ['b.ts'])
  })

  test('several changes at once are each classified correctly', () => {
    const prior = { 'kept.ts': 'h1', 'changed.ts': 'h2', 'gone.ts': 'h3' }
    const current = { 'kept.ts': 'h1', 'changed.ts': 'h2-new', 'new.ts': 'h4' }
    const diff = diffFiles(current, prior)
    assert.deepEqual(diff.added, ['new.ts'])
    assert.deepEqual(diff.modified, ['changed.ts'])
    assert.deepEqual(diff.deleted, ['gone.ts'])
  })

  test('prior being an empty object means every current file is "added"', () => {
    const prior = {}
    const current = { 'a.ts': 'h1', 'b.ts': 'h2' }
    const diff = diffFiles(current, prior)
    assert.deepEqual(diff.added.sort(), ['a.ts', 'b.ts'])
    assert.deepEqual(diff.modified, [])
    assert.deepEqual(diff.deleted, [])
    assert.equal(diff.changed.size, 2)
  })

  test('changed is exactly the union of added, modified, and deleted', () => {
    const prior = { 'kept.ts': 'h1', 'changed.ts': 'h2', 'gone.ts': 'h3' }
    const current = { 'kept.ts': 'h1', 'changed.ts': 'h2-new', 'new.ts': 'h4' }
    const diff = diffFiles(current, prior)
    const union = new Set([...diff.added, ...diff.modified, ...diff.deleted])
    assert.deepEqual(diff.changed, union)
  })
})

// --- regionUnchanged -------------------------------------------------------

function region(overrides: Partial<Region>): Region {
  return { id: 'r1', label: 'Region', files: [], origin: 'directory', ...overrides }
}

function priorRegion(overrides: Partial<MappedRegion>): MappedRegion {
  return {
    id: 'r1',
    label: 'Region',
    files: [],
    origin: 'directory',
    narrative: { purpose: 'x', claims: [], unknowns: [] },
    dependsOn: [],
    dependedOnBy: [],
    narratedAt: 1700000000000,
    ...overrides,
  }
}

describe('regionUnchanged', () => {
  test('no prior region at all -> false', () => {
    const r = region({ files: ['a.ts'] })
    assert.equal(regionUnchanged(r, undefined, new Set()), false)
  })

  test('identical file set, nothing changed -> true', () => {
    const r = region({ files: ['a.ts', 'b.ts'] })
    const p = priorRegion({ files: ['a.ts', 'b.ts'] })
    assert.equal(regionUnchanged(r, p, new Set()), true)
  })

  test('identical file set, but one of its files is in changedFiles -> false', () => {
    const r = region({ files: ['a.ts', 'b.ts'] })
    const p = priorRegion({ files: ['a.ts', 'b.ts'] })
    assert.equal(regionUnchanged(r, p, new Set(['b.ts'])), false)
  })

  test('prior had a file this region no longer has -> false', () => {
    const r = region({ files: ['a.ts'] })
    const p = priorRegion({ files: ['a.ts', 'b.ts'] })
    // note: same length is not guaranteed here, so also cover equal-length below;
    // this case has different lengths (1 vs 2) and must still be false.
    assert.equal(regionUnchanged(r, p, new Set()), false)
  })

  test('region has a file prior did not -> false', () => {
    const r = region({ files: ['a.ts', 'b.ts'] })
    const p = priorRegion({ files: ['a.ts'] })
    assert.equal(regionUnchanged(r, p, new Set()), false)
  })

  test('same file count, different members -> false (not a length-only check)', () => {
    const r = region({ files: ['a.ts', 'c.ts'] })
    const p = priorRegion({ files: ['a.ts', 'b.ts'] })
    assert.equal(regionUnchanged(r, p, new Set()), false)
  })

  test('same files in a different array order, nothing changed -> still true', () => {
    const r = region({ files: ['b.ts', 'a.ts', 'c.ts'] })
    const p = priorRegion({ files: ['a.ts', 'b.ts', 'c.ts'] })
    assert.equal(regionUnchanged(r, p, new Set()), true)
  })
})

// --- saveMap / loadMap: fileHashes ------------------------------------------

function fakeMapWithHashes(): SystemMap {
  const mappedRegion: MappedRegion = {
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
    regions: [mappedRegion],
    roles: { 'src/one.ts': 'entry' },
    fileCount: 1,
    edgeCount: 0,
    groupingUnconfirmed: false,
    fileHashes: { 'src/one.ts': 'deadbeef' },
  }
}

describe('saveMap/loadMap: fileHashes', () => {
  test('round-trips fileHashes through disk unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-map-incremental-'))
    try {
      const original = fakeMapWithHashes()
      saveMap(dir, original)
      const loaded = loadMap(dir)
      assert.deepEqual(loaded?.fileHashes, original.fileHashes)
      assert.deepEqual(loaded, original)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('loadMap on a map JSON with no fileHashes field returns it without crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-map-incremental-'))
    try {
      const legacy = {
        root: '/fake/repo',
        builtAt: 1700000000000,
        regions: [],
        roles: {},
        fileCount: 0,
        edgeCount: 0,
        groupingUnconfirmed: false,
        // no fileHashes field at all — a map saved before this feature existed
      }
      writeFileSync(join(dir, 'map.json'), JSON.stringify(legacy))
      const loaded = loadMap(dir)
      assert.ok(loaded)
      assert.equal(loaded!.fileHashes, undefined)
      assert.equal(loaded!.root, '/fake/repo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
