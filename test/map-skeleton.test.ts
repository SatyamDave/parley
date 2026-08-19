// Layer 1 of the map (src/map/skeleton.ts) is the deterministic foundation:
// everything downstream trusts that its files, imports, and edges are real.
// These tests build tiny real fixture trees on disk (no mocking of fs) and
// assert on what buildSkeleton/walk/importersOf actually extract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSkeleton, walk, importersOf } from '../src/map/skeleton.ts'

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'parley-map-skeleton-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

test('buildSkeleton: resolves a relative import with an explicit matching extension', () => {
  const root = fixture({
    'src/a.ts': `import { b } from './b.ts'\nexport const a = b`,
    'src/b.ts': `export const b = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.ok(a)
    assert.deepEqual(a!.imports, ['src/b.ts'])
    assert.deepEqual(skeleton.edges, [{ from: 'src/a.ts', to: 'src/b.ts' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: sibling-extension fallback resolves ./x.ts written for a compiled ./x.js and vice versa', () => {
  const root = fixture({
    // a.ts imports from a specifier ending in .js, but only b.ts exists on disk.
    'src/a.ts': `import { b } from './b.js'\nexport const a = b`,
    'src/b.ts': `export const b = 1`,
    // c.js imports from a specifier ending in .ts, but only d.js exists on disk.
    'src/c.js': `import { d } from './d.ts'\nexport const c = d`,
    'src/d.js': `export const d = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    const c = skeleton.files.find((f) => f.path === 'src/c.js')
    assert.deepEqual(a!.imports, ['src/b.ts'])
    assert.deepEqual(c!.imports, ['src/d.js'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: a directory import resolves to its index.ts', () => {
  const root = fixture({
    'src/a.ts': `import { widget } from './lib'\nexport const a = widget`,
    'src/lib/index.ts': `export const widget = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.deepEqual(a!.imports, ['src/lib/index.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: bare and package specifiers are classified as external, never fabricated as edges', () => {
  const root = fixture({
    'src/a.ts': `import { readFileSync } from 'node:fs'\nimport React from 'react'\nexport const a = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.deepEqual(a!.imports, [])
    assert.deepEqual(a!.external.sort(), ['node:fs', 'react'])
    assert.deepEqual(skeleton.edges, [], 'no edge may be fabricated for a package specifier')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: an unresolvable relative specifier produces neither an edge nor an external entry', () => {
  const root = fixture({
    'src/a.ts': `import { ghost } from './does-not-exist.ts'\nexport const a = ghost`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.deepEqual(a!.imports, [])
    assert.deepEqual(a!.external, [])
    assert.deepEqual(skeleton.edges, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: a case-mismatched relative specifier never fabricates an edge, even on a case-insensitive filesystem', () => {
  // The real file is lowercase; the importer spells it capitalised. On a
  // case-insensitive filesystem (the macOS/Windows default) `statSync` on
  // the capitalised candidate path succeeds anyway, which is exactly the bug
  // this guards: resolution must check the case-exact set of paths `walk()`
  // actually found (see `knownPathIndex`/`resolvesTo` in skeleton.ts), not
  // `statSync` directly, or it fabricates an edge to a path no file has.
  //
  // Honest caveat: on a case-*sensitive* filesystem (most Linux CI), './Thing'
  // simply never resolves at all, before or after the fix — so this test only
  // actively exercises the bug on case-insensitive filesystems. It's still
  // worth keeping because it locks in the correct (unresolved) behaviour
  // everywhere, and is the only thing that would have caught the regression
  // on the platform where it actually manifested.
  const root = fixture({
    'src/a.ts': `import { thing } from './Thing'\nexport const a = thing`,
    'src/thing.ts': `export const thing = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.ok(a)
    assert.deepEqual(a!.imports, [], 'a case mismatch must never resolve to the real file under a fabricated name')
    assert.deepEqual(a!.external, [], 'a relative specifier that fails to resolve is unresolved, not external')
    assert.deepEqual(skeleton.edges, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: a dynamic await import() is captured as a real edge', () => {
  const root = fixture({
    'src/a.ts': `export async function load() {\n  const mod = await import('./b.ts')\n  return mod\n}`,
    'src/b.ts': `export const b = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.deepEqual(a!.imports, ['src/b.ts'])
    assert.deepEqual(skeleton.edges, [{ from: 'src/a.ts', to: 'src/b.ts' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: export statements are extracted as exported names', () => {
  const root = fixture({
    'src/a.ts': `export function foo() {}\nexport const bar = 1\nexport class Baz {}\nexport type Qux = string`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.deepEqual(a!.exports, ['foo', 'bar', 'Baz', 'Qux'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walk: skips node_modules, dist, and .git directories', () => {
  const root = fixture({
    'src/a.ts': `export const a = 1`,
    'node_modules/pkg/index.ts': `export const ignored = 1`,
    'dist/built.ts': `export const ignored = 1`,
    '.git/hooks/pre-commit.ts': `export const ignored = 1`,
  })
  try {
    const found = walk(root).map((f) => f.slice(root.length + 1))
    assert.deepEqual(found, ['src/a.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: repeated imports of the same file are deduplicated in both imports[] and edges', () => {
  const root = fixture({
    'src/a.ts': `import { b } from './b.ts'\nimport { b as b2 } from './b.ts'\nexport const a = b + b2`,
    'src/b.ts': `export const b = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'src/a.ts')
    assert.deepEqual(a!.imports, ['src/b.ts'], 'imports list should not contain duplicates')
    assert.deepEqual(skeleton.edges, [{ from: 'src/a.ts', to: 'src/b.ts' }], 'edges should be deduplicated')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('importersOf: returns every file that imports the given path', () => {
  const root = fixture({
    'src/a.ts': `import './target.ts'`,
    'src/b.ts': `import './target.ts'`,
    'src/c.ts': `export const c = 1`,
    'src/target.ts': `export const target = 1`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const importers = importersOf(skeleton, 'src/target.ts').sort()
    assert.deepEqual(importers, ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(importersOf(skeleton, 'src/c.ts'), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Python, Go, and Rust — added when the TS-only shortcut in skeleton.ts's
// header was retired. Same contract as above: real fixture trees on disk,
// asserting on what buildSkeleton actually extracted, with the
// never-fabricate-an-edge rule getting its own test per language since it's
// the one property this whole layer exists to guarantee.
// ---------------------------------------------------------------------------

test('buildSkeleton (Python): "from . import x" resolves to a sibling module in the same package', () => {
  const root = fixture({
    'pkg/__init__.py': `from . import helpers\n`,
    'pkg/helpers.py': `def helper():\n    pass\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const init = skeleton.files.find((f) => f.path === 'pkg/__init__.py')
    assert.deepEqual(init!.imports, ['pkg/helpers.py'])
    assert.deepEqual(skeleton.edges, [{ from: 'pkg/__init__.py', to: 'pkg/helpers.py' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Python): ".." climbs one package level, and "from .pkg import x" can resolve to a package\'s __init__.py', () => {
  const root = fixture({
    'app/__init__.py': ``,
    'app/pkg/__init__.py': `Y = 2\n`,
    'app/pkg/helpers.py': `def helper():\n    pass\n`,
    'app/main.py': `from .pkg import helper\n`,
    'app/pkg/sibling.py': `from .. import pkg\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const main = skeleton.files.find((f) => f.path === 'app/main.py')
    // The module named after `from` (the package "pkg", not the name "helper"
    // imported from it) resolves — to the package's own __init__.py, since
    // "pkg" names a directory with no further module component.
    assert.deepEqual(main!.imports, ['app/pkg/__init__.py'])
    const sibling = skeleton.files.find((f) => f.path === 'app/pkg/sibling.py')
    // ".." from app/pkg/sibling.py climbs to app/, then resolves "pkg" the
    // same way: back to app/pkg/__init__.py.
    assert.deepEqual(sibling!.imports, ['app/pkg/__init__.py'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Python): a relative "from . import *" resolves to the current package\'s __init__.py', () => {
  const root = fixture({
    'pkg/__init__.py': `X = 1\n`,
    'pkg/sub/__init__.py': ``,
    'pkg/sub/other.py': `from . import *\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const other = skeleton.files.find((f) => f.path === 'pkg/sub/other.py')
    assert.deepEqual(other!.imports, ['pkg/sub/__init__.py'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Python): stdlib and site-packages imports are classified as external, never fabricated as edges', () => {
  const root = fixture({
    'pkg/a.py': `import os\nfrom typing import List\nimport numpy.linalg\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'pkg/a.py')
    assert.deepEqual(a!.imports, [])
    assert.deepEqual(a!.external.sort(), ['numpy.linalg', 'os', 'typing'])
    assert.deepEqual(skeleton.edges, [], 'no edge may be fabricated for a stdlib or third-party import')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Python): __all__ wins over the top-level def/class/assignment fallback when present', () => {
  const root = fixture({
    'pkg/a.py': `__all__ = ["foo", "Bar"]\n\ndef foo():\n    pass\n\nclass Bar:\n    pass\n\ndef _hidden():\n    pass\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'pkg/a.py')
    assert.deepEqual(a!.exports, ['foo', 'Bar'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Python): without __all__, top-level def/class/assignment names are the exports; indented ones are not', () => {
  const root = fixture({
    'pkg/a.py': `def foo():\n    y = 2\n    return y\n\nclass Bar:\n    pass\n\nX = 1\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const a = skeleton.files.find((f) => f.path === 'pkg/a.py')
    assert.deepEqual(a!.exports, ['foo', 'Bar', 'X'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Go): an import under the module\'s own path (from go.mod) resolves to every file in that package directory', () => {
  const root = fixture({
    'go.mod': `module github.com/example/goproj\n\ngo 1.21\n`,
    'pkg/util/util.go': `package util\n\nfunc Slugify(s string) string {\n\treturn s\n}\n`,
    'pkg/util/extra.go': `package util\n\nfunc Reverse(s string) string {\n\treturn s\n}\n`,
    'cmd/app/main.go': `package main\n\nimport (\n\t"fmt"\n\n\t"github.com/example/goproj/pkg/util"\n)\n\nfunc main() {\n\tfmt.Println(util.Slugify("hi"))\n}\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const main = skeleton.files.find((f) => f.path === 'cmd/app/main.go')
    assert.deepEqual(main!.imports.sort(), ['pkg/util/extra.go', 'pkg/util/util.go'])
    assert.deepEqual(main!.external, ['fmt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Go): a third-party module path is external, never fabricated as a local edge', () => {
  const root = fixture({
    'go.mod': `module github.com/example/goproj\n\ngo 1.21\n`,
    'main.go': `package main\n\nimport (\n\t"github.com/pkg/errors"\n)\n\nfunc main() {}\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const main = skeleton.files.find((f) => f.path === 'main.go')
    assert.deepEqual(main!.imports, [])
    assert.deepEqual(main!.external, ['github.com/pkg/errors'])
    assert.deepEqual(skeleton.edges, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Go): without a go.mod, every import is treated as external rather than guessed at', () => {
  const root = fixture({
    'main.go': `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const main = skeleton.files.find((f) => f.path === 'main.go')
    assert.deepEqual(main!.imports, [])
    assert.deepEqual(main!.external, ['fmt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Go): capitalised top-level identifiers are exports; lowercase ones are not', () => {
  const root = fixture({
    'go.mod': `module github.com/example/goproj\n\ngo 1.21\n`,
    'main.go': `package main\n\nfunc Public() {}\n\nfunc private() {}\n\nvar (\n\tExported = 1\n\tinternal = 2\n)\n\nconst Pi = 3.14\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const main = skeleton.files.find((f) => f.path === 'main.go')
    assert.deepEqual(main!.exports.sort(), ['Exported', 'Pi', 'Public'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Rust): crate::, super::, and a bare "mod foo;" declaration all resolve to real files', () => {
  const root = fixture({
    'Cargo.toml': `[package]\nname = "demo"\n`,
    'src/lib.rs': `mod a;\n\npub struct Backoff;\n`,
    'src/a.rs': `mod b;\n\nuse crate::Backoff;\n\npub fn use_backoff() -> Backoff {\n    Backoff\n}\n`,
    'src/a/b.rs': `use super::use_backoff;\n\npub fn call() {\n    use_backoff();\n}\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const lib = skeleton.files.find((f) => f.path === 'src/lib.rs')
    assert.ok(lib!.imports.includes('src/a.rs'), '"mod a;" should resolve to src/a.rs')
    const a = skeleton.files.find((f) => f.path === 'src/a.rs')
    assert.ok(a!.imports.includes('src/a/b.rs'), '"mod b;" should resolve to src/a/b.rs')
    assert.ok(a!.imports.includes('src/lib.rs'), '"use crate::Backoff" should resolve to the crate root defining it')
    const b = skeleton.files.find((f) => f.path === 'src/a/b.rs')
    assert.deepEqual(b!.imports, ['src/a.rs'], '"use super::use_backoff" should resolve to the parent module\'s file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Rust): a crates.io "use" is external, never fabricated as a local edge', () => {
  const root = fixture({
    'Cargo.toml': `[package]\nname = "demo"\n`,
    'src/lib.rs': `use serde::Deserialize;\n\n#[derive(Deserialize)]\npub struct Config;\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const lib = skeleton.files.find((f) => f.path === 'src/lib.rs')
    assert.deepEqual(lib!.imports, [])
    assert.deepEqual(lib!.external, ['serde'])
    assert.deepEqual(skeleton.edges, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton (Rust): pub items are exports; non-pub and pub(crate) items are not', () => {
  const root = fixture({
    'Cargo.toml': `[package]\nname = "demo"\n`,
    'src/lib.rs': `pub fn public_fn() {}\n\nfn private_fn() {}\n\npub(crate) fn crate_fn() {}\n\npub struct Public;\n\nstruct Private;\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const lib = skeleton.files.find((f) => f.path === 'src/lib.rs')
    assert.deepEqual(lib!.exports, ['public_fn', 'Public'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSkeleton: a mixed-language repo produces one coherent skeleton across TS, Python, Go, and Rust', () => {
  const root = fixture({
    'web/index.ts': `import { helper } from './helper.ts'\nexport const main = helper\n`,
    'web/helper.ts': `export const helper = 1`,
    'scripts/build.py': `from . import util\n`,
    'scripts/util.py': `def run():\n    pass\n`,
    'go.mod': `module github.com/example/mixed\n\ngo 1.21\n`,
    'server/main.go': `package main\n\nimport "github.com/example/mixed/server/util"\n\nfunc main() {\n\t_ = util.Ping\n}\n`,
    'server/util/util.go': `package util\n\nfunc Ping() string {\n\treturn "pong"\n}\n`,
    'Cargo.toml': `[package]\nname = "mixed"\n`,
    'src/lib.rs': `mod core;\n`,
    'src/core.rs': `pub fn run() {}\n`,
  })
  try {
    const skeleton = buildSkeleton(root)
    const paths = skeleton.files.map((f) => f.path).sort()
    assert.deepEqual(paths, [
      'scripts/build.py',
      'scripts/util.py',
      'server/main.go',
      'server/util/util.go',
      'src/core.rs',
      'src/lib.rs',
      'web/helper.ts',
      'web/index.ts',
    ])
    const byPath = new Map(skeleton.files.map((f) => [f.path, f]))
    assert.deepEqual(byPath.get('web/index.ts')!.imports, ['web/helper.ts'])
    assert.deepEqual(byPath.get('scripts/build.py')!.imports, ['scripts/util.py'])
    assert.deepEqual(byPath.get('server/main.go')!.imports, ['server/util/util.go'])
    assert.deepEqual(byPath.get('src/lib.rs')!.imports, ['src/core.rs'])
    // Every edge found belongs to exactly one language's own resolution —
    // nothing crosses languages, which is correct: nothing in this fixture
    // imports across a language boundary, and nothing should be invented to
    // make it look like it does.
    assert.equal(skeleton.edges.length, 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
