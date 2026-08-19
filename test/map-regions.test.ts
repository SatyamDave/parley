// Layer 2 of the map (src/map/regions.ts) decomposes a skeleton into regions.
// The invariant that matters most: no file may ever be dropped from the map,
// through any of the three paths (directory, pinned, flat-repo cluster
// fallback) — there was a real bug where single-file directories vanished.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decompose, roles, clusterByImports } from '../src/map/regions.ts'
import type { Skeleton, SourceFile } from '../src/map/skeleton.ts'

function file(path: string, opts: Partial<SourceFile> = {}): SourceFile {
  return { path, loc: 10, exports: [], imports: [], external: [], ...opts }
}

function skeletonOf(files: SourceFile[], edges: { from: string; to: string }[] = []): Skeleton {
  return { root: '/fake', files, edges }
}

function allFiles(skeleton: Skeleton, regions: { files: string[] }[]): void {
  const covered = new Set(regions.flatMap((r) => r.files))
  const missing = skeleton.files.map((f) => f.path).filter((p) => !covered.has(p))
  assert.deepEqual(missing, [], `files dropped from the map: ${missing.join(', ')}`)
  // Also check nothing appears in more than one region.
  const seen = new Set<string>()
  const duplicated: string[] = []
  for (const r of regions) for (const f of r.files) {
    if (seen.has(f)) duplicated.push(f)
    seen.add(f)
  }
  assert.deepEqual(duplicated, [], `files appearing in more than one region: ${duplicated.join(', ')}`)
}

test('decompose (directory path): every file lands in exactly one region, including a single-file directory', () => {
  const files = [
    file('a/one.ts'),
    file('a/two.ts'),
    file('b/three.ts'),
    file('b/four.ts'),
    // a lone file in its own directory — the historical bug dropped this.
    file('lonely/only.ts'),
  ]
  const skeleton = skeletonOf(files)
  const d = decompose(skeleton)
  allFiles(skeleton, d.regions)
  const lonely = d.regions.find((r) => r.files.includes('lonely/only.ts'))
  assert.ok(lonely, 'the single-file directory must appear somewhere in the map')
})

test('decompose (pinned path): every file lands in exactly one region, unassigned files get a holding region', () => {
  const files = [file('a/one.ts'), file('a/two.ts'), file('b/three.ts')]
  const skeleton = skeletonOf(files)
  const pinned = [{ id: 'grp1', label: 'Group 1', files: ['a/one.ts', 'a/two.ts'], origin: 'pinned' as const }]
  const d = decompose(skeleton, pinned)
  allFiles(skeleton, d.regions)
  const unassigned = d.regions.find((r) => r.id === 'unassigned')
  assert.ok(unassigned, 'a file not covered by any pinned region must appear in an "unassigned" holding region')
  assert.deepEqual(unassigned!.files, ['b/three.ts'])
  assert.equal(d.needsSemanticGrouping, false)
})

test('decompose (pinned path): no unassigned region is created when pinned regions cover everything', () => {
  const files = [file('a/one.ts'), file('b/two.ts')]
  const skeleton = skeletonOf(files)
  const pinned = [{ id: 'grp1', label: 'Group 1', files: ['a/one.ts', 'b/two.ts'], origin: 'pinned' as const }]
  const d = decompose(skeleton, pinned)
  assert.equal(d.regions.some((r) => r.id === 'unassigned'), false)
  allFiles(skeleton, d.regions)
})

test('decompose (flat-repo cluster fallback): every file lands in exactly one region when there is no usable directory structure', () => {
  // All files at repo root — byDirectory returns null (only one "directory": root).
  const files = [file('one.ts'), file('two.ts'), file('three.ts')]
  const edges = [{ from: 'one.ts', to: 'two.ts' }]
  const skeleton = skeletonOf(files, edges)
  const d = decompose(skeleton)
  allFiles(skeleton, d.regions)
  assert.equal(d.needsSemanticGrouping, true, 'a flat repo cannot be a real decomposition')
  for (const r of d.regions) assert.equal(r.origin, 'cluster')
})

test('decompose (directory path): needsSemanticGrouping is true when a directory region exceeds MAX_MEANINGFUL_REGION', () => {
  // MAX_MEANINGFUL_REGION is 8 — build one directory with 9 files, another with 2
  // so byDirectory actually returns a directory decomposition (needs >= MIN_DIRS).
  const big = Array.from({ length: 9 }, (_, i) => file(`big/f${i}.ts`))
  const small = [file('small/a.ts'), file('small/b.ts')]
  const skeleton = skeletonOf([...big, ...small])
  const d = decompose(skeleton)
  allFiles(skeleton, d.regions)
  assert.equal(d.needsSemanticGrouping, true)
})

test('decompose (directory path): needsSemanticGrouping is false when every directory region is small enough', () => {
  const files = [file('a/one.ts'), file('a/two.ts'), file('b/three.ts'), file('b/four.ts')]
  const skeleton = skeletonOf(files)
  const d = decompose(skeleton)
  assert.equal(d.needsSemanticGrouping, false)
})

test('clusterByImports: deterministic — identical input produces identical labels every time', () => {
  const files = [file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts'), file('e.ts')]
  const edges = [
    { from: 'a.ts', to: 'b.ts' },
    { from: 'b.ts', to: 'c.ts' },
    { from: 'd.ts', to: 'e.ts' },
  ]
  const skeleton = skeletonOf(files, edges)
  const runs = Array.from({ length: 5 }, () => [...clusterByImports(skeleton).entries()].sort())
  for (let i = 1; i < runs.length; i++) {
    assert.deepEqual(runs[i], runs[0], `run ${i} produced different labels than run 0`)
  }
})

test('roles: classifies entry, hub, leaf, and middle from fan-in/fan-out on a hand-built graph', () => {
  // entry.ts -> hub.ts, other.ts -> hub.ts (hub has fan-in 2, fan-out 0 -> leaf by definition since o===0)
  // Build a case where hub genuinely has i>=hubFloor and o<=1.
  const files = [
    file('entry.ts'),      // imports hub, nothing imports it -> entry
    file('other1.ts'),     // imports hub
    file('other2.ts'),     // imports hub
    file('hub.ts'),        // imported by entry/other1/other2, imports nothing -> also matches leaf pattern (o===0)
    file('leaf.ts'),       // imported by middle, imports nothing
    file('middle.ts'),     // imports leaf, imported by nothing... need imported too
  ]
  const edges = [
    { from: 'entry.ts', to: 'hub.ts' },
    { from: 'other1.ts', to: 'hub.ts' },
    { from: 'other2.ts', to: 'hub.ts' },
    { from: 'middle.ts', to: 'leaf.ts' },
    { from: 'entry.ts', to: 'middle.ts' },
  ]
  const skeleton = skeletonOf(files, edges)
  const r = roles(skeleton)

  // entry.ts: fan-in 0, fan-out 2 -> entry
  assert.equal(r['entry.ts'], 'entry')
  // leaf.ts: fan-in 1, fan-out 0 -> leaf
  assert.equal(r['leaf.ts'], 'leaf')
  // middle.ts: fan-in 1 (from entry), fan-out 1 (to leaf) -> middle (unless hub floor is 1, but floor is max(2, ...))
  assert.equal(r['middle.ts'], 'middle')
  // hub.ts: fan-in 3, fan-out 0. Since i>=hubFloor is checked before the leaf branch, hub wins.
  assert.equal(r['hub.ts'], 'hub')
})

test('roles: a file with no imports and no importers is middle, not entry or leaf', () => {
  const files = [file('isolated.ts')]
  const skeleton = skeletonOf(files)
  const r = roles(skeleton)
  assert.equal(r['isolated.ts'], 'middle')
})
