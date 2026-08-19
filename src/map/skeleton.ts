// Layer 1 of the map: the deterministic skeleton.
//
// This file never calls a model. Everything here is derived from the source
// text itself, because a map is only useful if its structure can be trusted —
// and the research is unambiguous that letting an LLM originate edges or
// boundaries is where architecture maps go wrong (measured hallucination rates
// on code summarization run to ~66%). The model gets to narrate this skeleton
// later; it never gets to invent it.
//
// Phase 0 shortcut, stated plainly: imports and exports are extracted with
// per-language regexes rather than tree-sitter. That was fine while parley was
// TS-only, but a structural-analysis tool that only understands one language
// is not a product — so this file now also covers Python, Go, and Rust. What
// hasn't changed is the *shape* of the shortcut: still no parser, still no new
// dependency, just four regex-based strategies instead of one. Each language's
// discovery/import/export/resolve logic lives behind the `LangStrategy`
// interface below, selected by file extension, so adding a fifth language
// later means adding a fifth strategy, not threading more branches through
// `buildSkeleton` itself.
//
// The rule that must survive any of this is the one in `resolveLocal`-style
// functions: only a specifier that is unambiguously *local* — a relative path,
// a `crate::`/`super::`/`self::` path, a dotted module actually found on disk,
// an import path under the repo's own Go module — may become an edge. Anything
// else is either `external` (a real dependency, just not one of ours to trace)
// or silently dropped when it looks local but doesn't resolve to a real file.
// Reporting a package as external is honest; inventing a file it doesn't
// resolve to is exactly what layer 1 must never do, in any language.
//
// What regex cannot do, in every language here: it cannot see through
// dynamic/conditional import construction (`importlib.import_module(x)`,
// build-tag-gated Go files, macro-generated `mod`/`use` in Rust), and it
// cannot tell code from a comment or a string literal that happens to contain
// import-shaped text. Each language's section below notes its own sharper
// edges on top of that shared ceiling.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, basename, extname } from 'node:path'

export type SourceFile = {
  /** Repo-relative, POSIX-style. The stable id for a file everywhere in the map. */
  path: string
  loc: number
  /** Exported symbol names, in declaration order. */
  exports: string[]
  /** Repo-relative paths this file imports from, resolved. Externals are dropped. */
  imports: string[]
  /** Import specifiers that did not resolve inside the repo — dependencies. */
  external: string[]
}

export type Skeleton = {
  root: string
  files: SourceFile[]
  /** Directed import edges between repo files, deduplicated. */
  edges: { from: string; to: string }[]
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'vendor',
  // Added for the non-TS languages: build/venv/cache trees that are never
  // hand-written source and would otherwise get walked like real code.
  '__pycache__',
  '.venv',
  'venv',
  'target',
])

/**
 * A language's whole contribution to the skeleton: which files it owns, how
 * to pull specifiers and exported names out of one file's text, and how to
 * turn a specifier into either a real local file (an edge), an external
 * dependency, or neither. `prepare` is for the rare case (Go) where resolving
 * a single file's imports needs repo-wide context gathered once up front.
 */
type ResolveResult =
  | { kind: 'local'; paths: string[] }
  | { kind: 'external'; spec: string }
  | { kind: 'unresolved' }

type LangStrategy = {
  extensions: Set<string>
  specifiers(text: string): string[]
  exportedNames(text: string): string[]
  prepare?(root: string, relPaths: string[]): unknown
  resolveLocal(ctx: unknown, root: string, fromFile: string, spec: string): ResolveResult
}

/**
 * The set of repo-relative paths `walk()` actually found, exactly as
 * `readdirSync` cased them. Every language's resolution checks candidates
 * against this rather than calling `statSync` directly, because the default
 * macOS filesystem is case-insensitive: `statSync` on `src/Backoff.rs` would
 * report success even when the real file on disk is `src/backoff.rs`,
 * producing an edge whose `to` doesn't match any file's real `path` — a
 * fabricated-looking edge by a different name. A set built from the same
 * case-exact listing `buildSkeleton` uses for `files[].path` can't drift
 * from it. (TS/JS resolution used to call `statSync` directly and carried
 * this exact bug — a case-mismatched `./Thing` import next to `thing.ts`
 * would silently resolve on macOS/Windows. Fixed by routing it through this
 * same index; see `tsResolveLocalPath`.)
 */
function knownPathIndex(_root: string, relPaths: string[]): Set<string> {
  return new Set(relPaths)
}

/** `candidate` (absolute) resolves only if it names a file `walk()` actually
 *  found — see `knownPathIndex`. */
function resolvesTo(root: string, known: Set<string>, candidate: string): string | null {
  const rel = relative(root, candidate)
  return known.has(rel) ? rel : null
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript — candidate generation is unchanged from the
// TS-only version of this file; only how a candidate is confirmed to exist
// changed (see `tsResolveLocalPath`), to close the case-insensitive-fs bug
// described on `knownPathIndex` above.
// ---------------------------------------------------------------------------

const TS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

// `from './x.ts'`, `from "../y"`, and the bare `import './side-effect.ts'` form.
const TS_IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
// `const x = await import('./y.ts')` — dynamic, but still a real edge.
const TS_DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const TS_EXPORT_RE =
  /(?:^|\n)export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g

function tsSpecifiers(text: string): string[] {
  const out: string[] = []
  for (const re of [TS_IMPORT_RE, TS_DYNAMIC_RE]) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const spec = m[1] ?? m[2]
      if (spec) out.push(spec)
    }
  }
  return out
}

function tsExportedNames(text: string): string[] {
  const out: string[] = []
  TS_EXPORT_RE.lastIndex = 0
  for (let m = TS_EXPORT_RE.exec(text); m; m = TS_EXPORT_RE.exec(text)) out.push(m[1])
  return out
}

/**
 * Turn an import specifier into a repo-relative path, or null if it points
 * outside the repo. Only relative specifiers can resolve locally — a bare
 * specifier is a package, and treating one as a local file would fabricate an
 * edge, which is exactly what layer 1 must never do.
 *
 * Candidates are checked against `known` (see `knownPathIndex`) rather than
 * with `statSync`, because `statSync('src/Thing.ts')` succeeds on a
 * case-insensitive filesystem even when the real file is `src/thing.ts` —
 * that would produce an edge to a path no file actually has. Same fix as
 * Python/Rust, applied here because there is no reason for one of four
 * languages to keep fabricating edges that the other three no longer do.
 */
function tsResolveLocalPath(root: string, known: Set<string>, fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  const candidates = [
    base,
    ...[...TS_EXT].map((e) => base + e),
    ...[...TS_EXT].map((e) => join(base, `index${e}`)),
    // Node ESM requires the extension in the specifier, but TS source is often
    // written as './x.ts' and compiled to './x.js' (and vice versa). Try the
    // sibling extension so both conventions resolve to the same real file.
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.ts$/, '.js'),
  ]
  for (const candidate of candidates) {
    const found = resolvesTo(root, known, candidate)
    if (found) return found
  }
  return null
}

const tsStrategy: LangStrategy = {
  extensions: TS_EXT,
  specifiers: tsSpecifiers,
  exportedNames: tsExportedNames,
  prepare: knownPathIndex,
  resolveLocal(ctx, root, fromFile, spec) {
    if (!spec.startsWith('.')) return { kind: 'external', spec }
    const local = tsResolveLocalPath(root, ctx as Set<string>, fromFile, spec)
    return local ? { kind: 'local', paths: [local] } : { kind: 'unresolved' }
  },
}

// ---------------------------------------------------------------------------
// Python
//
// "Exports" are __all__ when the module declares one — the one place Python
// lets an author state their public API explicitly, so it's trusted over a
// guess — and otherwise the module's top-level (column-0) def/class names and
// bare assignments. That is a convention, not a language rule: a module with
// no __all__ can still intend everything to be "internal", and this will
// over-report. Regex can't know intent that isn't written down.
//
// What this specifically cannot see: `importlib.import_module(...)`, imports
// built from string concatenation, and `__all__` built by anything other than
// a literal list/tuple of string literals (e.g. `__all__ = a + b`).
// ---------------------------------------------------------------------------

const PY_EXT = new Set(['.py'])

const PY_IMPORT_RE = /^\s*import\s+([^\n]+)/gm
// Captures: (1) leading dots, (2) dotted module (may be empty when the import
// is `from . import x`), (3) the raw name-list, parenthesized or not.
const PY_FROM_RE = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(\([\s\S]*?\)|[^\n]*)/gm
const PY_ALL_RE = /^__all__\s*(?::[^=\n]+)?=\s*[[(]([^\])]*)[\])]/m
// Column-0 only: this is what "top-level" means for the fallback export list.
// Indented def/class/assignment is nested and deliberately excluded.
const PY_EXPORT_RE = /^(?:async\s+)?def\s+(\w+)|^class\s+(\w+)|^([A-Za-z_]\w*)(?:\s*:\s*[^=\n]+)?\s*=(?!=)/gm

function pyNameList(raw: string): string[] {
  const trimmed = raw.trim().replace(/^\(/, '').replace(/\)$/, '')
  return trimmed
    .split(',')
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
}

function pySpecifiers(text: string): string[] {
  const out: string[] = []

  PY_IMPORT_RE.lastIndex = 0
  for (let m = PY_IMPORT_RE.exec(text); m; m = PY_IMPORT_RE.exec(text)) {
    for (const mod of pyNameList(m[1])) out.push(mod) // absolute, no leading dot
  }

  PY_FROM_RE.lastIndex = 0
  for (let m = PY_FROM_RE.exec(text); m; m = PY_FROM_RE.exec(text)) {
    const dots = m[1]
    const moduleTail = m[2]
    if (moduleTail !== '') {
      // The module named after `from` is what resolves; the imported names
      // may be symbols, not submodules, and guessing at each one risks
      // fabricating an edge. One edge per `from` clause, not per name.
      out.push(dots + moduleTail)
      continue
    }
    if (dots === '') continue // `from x import y` with no dots already handled above
    // `from . import a, b` (and `from .. import a, b`, etc): with no module
    // named, each imported name IS the candidate submodule — this is the
    // common re-export-from-__init__ pattern — so expand one specifier per
    // name rather than one for the bare package.
    for (const name of pyNameList(m[3])) {
      out.push(name === '*' ? dots : dots + name)
    }
  }

  return out
}

function pyExportedNames(text: string): string[] {
  const allMatch = PY_ALL_RE.exec(text)
  if (allMatch) {
    const names = [...allMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    if (names.length) return names
  }
  const out: string[] = []
  PY_EXPORT_RE.lastIndex = 0
  for (let m = PY_EXPORT_RE.exec(text); m; m = PY_EXPORT_RE.exec(text)) {
    const name = m[1] ?? m[2] ?? m[3]
    if (name && name !== '__all__') out.push(name)
  }
  return out
}

function pyResolveLocal(ctx: unknown, root: string, fromFile: string, spec: string): ResolveResult {
  const known = ctx as Set<string>
  const parsed = /^(\.*)(.*)$/.exec(spec)
  const level = parsed![1].length
  const tail = parsed![2]

  let baseDir: string
  if (level === 0) {
    baseDir = root
  } else {
    // Level 1 is the importing file's own package (its containing
    // directory); each further dot climbs one more directory, mirroring
    // Python's own relative-import semantics.
    baseDir = dirname(fromFile)
    for (let i = 1; i < level; i++) baseDir = dirname(baseDir)
  }

  if (tail === '') {
    // A bare package reference (`from . import *`, or `..` alone): only the
    // package's own __init__.py can be the target.
    const init = resolvesTo(root, known, join(baseDir, '__init__.py'))
    return init ? { kind: 'local', paths: [init] } : { kind: 'unresolved' }
  }

  const modulePath = join(baseDir, ...tail.split('.'))
  for (const candidate of [`${modulePath}.py`, join(modulePath, '__init__.py')]) {
    const found = resolvesTo(root, known, candidate)
    if (found) return { kind: 'local', paths: [found] }
  }
  // Absolute imports (no leading dot) that don't resolve inside the repo are
  // stdlib or a site-packages dependency — a real external. A leading dot can
  // only ever mean "inside this package", so one that fails to resolve is a
  // ghost import, not a dependency name worth reporting.
  return level === 0 ? { kind: 'external', spec: tail } : { kind: 'unresolved' }
}

const pyStrategy: LangStrategy = {
  extensions: PY_EXT,
  specifiers: pySpecifiers,
  exportedNames: pyExportedNames,
  prepare: knownPathIndex,
  resolveLocal: pyResolveLocal,
}

// ---------------------------------------------------------------------------
// Go
//
// Go's import unit is a package (a directory of files), not a file, so one
// import can only be turned into file-level edges by pointing at every file
// discovered in that directory — there is no single file a package import
// "is". That is a deliberate widening, not a fabrication: every target is a
// real file that genuinely belongs to the imported package.
//
// Resolution needs the module's own import path, which only exists in
// go.mod — without it there is no way to tell "this repo's own package" from
// "an external module with a similar-looking path", so every import is
// conservatively external. This also can't account for build-tag-excluded
// files (`_test.go`, `//go:build windows`) — a directory's package is treated
// as "every .go file found in it".
// ---------------------------------------------------------------------------

const GO_EXT = new Set(['.go'])

// Anchored to line-start (like the TS/JS regexes above): an unanchored
// `import` could match the word appearing mid-sentence in a doc comment
// followed by any quoted path, which is a real thing people write.
const GO_IMPORT_BLOCK_RE = /(?:^|\n)\s*import\s*\(([\s\S]*?)\)/g
const GO_IMPORT_SINGLE_RE = /(?:^|\n)\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/g
const GO_QUOTED_RE = /"([^"]+)"/g
const GO_EXPORT_SINGLE_RE = /^(?:func\s+(?:\([^)]*\)\s+)?|type\s+|var\s+|const\s+)([A-Z]\w*)/gm
const GO_EXPORT_BLOCK_RE = /(?:var|const)\s*\(([\s\S]*?)\)/g
const GO_EXPORT_BLOCK_LINE_RE = /^\s*([A-Z]\w*)/gm

function goSpecifiers(text: string): string[] {
  const out: string[] = []
  GO_IMPORT_BLOCK_RE.lastIndex = 0
  for (let m = GO_IMPORT_BLOCK_RE.exec(text); m; m = GO_IMPORT_BLOCK_RE.exec(text)) {
    GO_QUOTED_RE.lastIndex = 0
    for (let q = GO_QUOTED_RE.exec(m[1]); q; q = GO_QUOTED_RE.exec(m[1])) out.push(q[1])
  }
  GO_IMPORT_SINGLE_RE.lastIndex = 0
  for (let m = GO_IMPORT_SINGLE_RE.exec(text); m; m = GO_IMPORT_SINGLE_RE.exec(text)) out.push(m[1])
  return out
}

function goExportedNames(text: string): string[] {
  const out: string[] = []
  GO_EXPORT_SINGLE_RE.lastIndex = 0
  for (let m = GO_EXPORT_SINGLE_RE.exec(text); m; m = GO_EXPORT_SINGLE_RE.exec(text)) out.push(m[1])
  GO_EXPORT_BLOCK_RE.lastIndex = 0
  for (let m = GO_EXPORT_BLOCK_RE.exec(text); m; m = GO_EXPORT_BLOCK_RE.exec(text)) {
    GO_EXPORT_BLOCK_LINE_RE.lastIndex = 0
    for (let n = GO_EXPORT_BLOCK_LINE_RE.exec(m[1]); n; n = GO_EXPORT_BLOCK_LINE_RE.exec(m[1])) out.push(n[1])
  }
  return out
}

type GoContext = { moduleName: string | null; dirIndex: Map<string, string[]> }

function goPrepare(root: string, relPaths: string[]): GoContext {
  let moduleName: string | null = null
  try {
    const gomod = readFileSync(join(root, 'go.mod'), 'utf8')
    const m = /^module\s+(\S+)/m.exec(gomod)
    moduleName = m ? m[1] : null
  } catch {
    /* no go.mod at the root — every import is treated as external, see resolveLocal */
  }
  const dirIndex = new Map<string, string[]>()
  for (const p of relPaths) {
    if (extname(p) !== '.go') continue
    const dir = dirname(p)
    const bucket = dirIndex.get(dir)
    if (bucket) bucket.push(p)
    else dirIndex.set(dir, [p])
  }
  return { moduleName, dirIndex }
}

function goResolveLocal(ctx: GoContext, _root: string, _fromFile: string, spec: string): ResolveResult {
  if (!ctx.moduleName) return { kind: 'external', spec }
  let dir: string | null = null
  if (spec === ctx.moduleName) dir = '.'
  else if (spec.startsWith(`${ctx.moduleName}/`)) dir = spec.slice(ctx.moduleName.length + 1)
  if (dir === null) return { kind: 'external', spec }
  const files = ctx.dirIndex.get(dir)
  // Matches the module's own path but no .go files were found there — a
  // subpackage that genuinely has no files parley discovered. Not a fabricated
  // edge either way: no file means no target, full stop.
  return files && files.length ? { kind: 'local', paths: files } : { kind: 'unresolved' }
}

const goStrategy: LangStrategy = {
  extensions: GO_EXT,
  specifiers: goSpecifiers,
  exportedNames: goExportedNames,
  prepare: goPrepare,
  resolveLocal: goResolveLocal as LangStrategy['resolveLocal'],
}

// ---------------------------------------------------------------------------
// Rust
//
// `use` paths and `mod` declarations are the only sources of edges — a crate
// dependency declared in Cargo.toml but never `use`d produces no edge, which
// is correct (there is nothing to point an edge at). "Exports" are anything
// declared with a bare `pub` (not `pub(crate)`/`pub(super)`, which are public
// only within the crate — a real distinction Rust makes that regex can
// afford to keep).
//
// The one place this deliberately reads past the literal text: `use
// crate::module::Item` is far more common than `use crate::module` where
// `module` is itself a file — so a `use` path that doesn't resolve as a
// module is retried with its last segment dropped, and only kept if *that*
// resolves to a real file. This still never invents a path; it just tries a
// second, still-real, candidate. What it can't do: unfold more than one level
// of `{ }` grouping, so `use a::{b::{c, d}, e}` only reliably recovers `a::b`
// and `a::e`, not the nested `c`/`d`; and it can't see macro-generated `mod`
// or `use` items at all.
// ---------------------------------------------------------------------------

const RS_EXT = new Set(['.rs'])

const RUST_USE_RE = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\s\S]*?);/g
const RUST_MOD_RE = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g
const RUST_EXPORT_RE = /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|const|static|type|mod)\s+([A-Za-z_]\w*)/gm

/**
 * `crate::a::{b, c}` -> ["crate::a::b", "crate::a::c"]. Only unfolds one
 * level of `{ }` grouping — see header note on what nested groups lose.
 */
function expandRustUsePath(raw: string): string[] {
  const trimmed = raw.trim()
  const braceIdx = trimmed.indexOf('{')
  if (braceIdx === -1) {
    const prefix = trimmed.split(/\s+as\s+/)[0].trim().replace(/::$/, '')
    return prefix ? [prefix] : []
  }
  const prefix = trimmed.slice(0, braceIdx).replace(/::$/, '').trim()
  const closeIdx = trimmed.lastIndexOf('}')
  const inner = trimmed.slice(braceIdx + 1, closeIdx === -1 ? undefined : closeIdx)
  const out: string[] = []
  for (const rawItem of inner.split(',')) {
    const item = rawItem.trim()
    if (!item) continue
    if (item === 'self') {
      if (prefix) out.push(prefix)
      continue
    }
    const seg = item.split(/\s+as\s+/)[0].split('::')[0].trim()
    if (!seg) continue
    out.push(prefix ? `${prefix}::${seg}` : seg)
  }
  return out
}

function rustSpecifiers(text: string): string[] {
  const out: string[] = []
  RUST_USE_RE.lastIndex = 0
  for (let m = RUST_USE_RE.exec(text); m; m = RUST_USE_RE.exec(text)) out.push(...expandRustUsePath(m[1]))
  RUST_MOD_RE.lastIndex = 0
  for (let m = RUST_MOD_RE.exec(text); m; m = RUST_MOD_RE.exec(text)) out.push(`mod:${m[1]}`)
  return out
}

function rustExportedNames(text: string): string[] {
  const out: string[] = []
  RUST_EXPORT_RE.lastIndex = 0
  for (let m = RUST_EXPORT_RE.exec(text); m; m = RUST_EXPORT_RE.exec(text)) out.push(m[1])
  return out
}

/** The directory a file's *own* submodules would live in: for `mod.rs`,
 *  `lib.rs`, and `main.rs` that's the file's own directory (they represent
 *  the directory itself); for any other `x.rs` it's the `x/` sibling
 *  directory, whether or not it exists yet. */
function rustOwnModuleDir(fromFileAbs: string): string {
  const stem = basename(fromFileAbs, '.rs')
  const dir = dirname(fromFileAbs)
  return stem === 'mod' || stem === 'lib' || stem === 'main' ? dir : join(dir, stem)
}

/** A module named by `segments` under `baseDirAbs`, or — when segments is
 *  empty — the module file representing `baseDirAbs` itself. */
function resolveRustModule(root: string, known: Set<string>, baseDirAbs: string, segments: string[]): string | null {
  const candidates = segments.length
    ? [`${join(baseDirAbs, ...segments)}.rs`, join(baseDirAbs, ...segments, 'mod.rs')]
    : // Zero segments means "baseDir's own module file". `baseDirAbs` is a
      // *children* directory computed from the current file's stem (see
      // `rustOwnModuleDir`), so the module might be the 2018-edition leaf
      // file sitting next to it (`a.rs`, for `mod b` inside it living at
      // `a/b.rs`) rather than an `a/mod.rs` — try both conventions.
      [`${baseDirAbs}.rs`, join(baseDirAbs, 'mod.rs'), join(baseDirAbs, 'lib.rs'), join(baseDirAbs, 'main.rs')]
  for (const c of candidates) {
    const found = resolvesTo(root, known, c)
    if (found) return found
  }
  return null
}

function rustResolveLocal(ctx: unknown, root: string, fromFileAbs: string, spec: string): ResolveResult {
  const known = ctx as Set<string>
  if (spec.startsWith('mod:')) {
    const resolved = resolveRustModule(root, known, rustOwnModuleDir(fromFileAbs), [spec.slice(4)])
    return resolved ? { kind: 'local', paths: [resolved] } : { kind: 'unresolved' }
  }

  const segments = spec.split('::').filter(Boolean)
  const marker = segments[0]
  let baseDir: string
  if (marker === 'crate') baseDir = join(root, 'src')
  else if (marker === 'self') baseDir = rustOwnModuleDir(fromFileAbs)
  else if (marker === 'super') baseDir = dirname(rustOwnModuleDir(fromFileAbs))
  else return { kind: 'external', spec: marker } // a crate name — Cargo.toml's problem, not a repo file

  const rest = segments.slice(1)
  const full = resolveRustModule(root, known, baseDir, rest)
  if (full) return { kind: 'local', paths: [full] }
  if (rest.length) {
    // See header: `crate::module::Item` is the common case where the tail
    // names an item, not a submodule — retry one segment shallower.
    const shallower = resolveRustModule(root, known, baseDir, rest.slice(0, -1))
    if (shallower) return { kind: 'local', paths: [shallower] }
  }
  return { kind: 'unresolved' }
}

const rustStrategy: LangStrategy = {
  extensions: RS_EXT,
  specifiers: rustSpecifiers,
  exportedNames: rustExportedNames,
  prepare: knownPathIndex,
  resolveLocal: rustResolveLocal,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const STRATEGIES: LangStrategy[] = [tsStrategy, pyStrategy, goStrategy, rustStrategy]
const SOURCE_EXT = new Set(STRATEGIES.flatMap((s) => [...s.extensions]))

function strategyFor(absPath: string): LangStrategy | undefined {
  const ext = extname(absPath)
  return STRATEGIES.find((s) => s.extensions.has(ext))
}

/** Every source file under `root`, skipping the usual generated/vendored trees. */
export function walk(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // unreadable directory — not worth failing a whole map over
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.') continue
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue // vanished between readdir and stat
      }
      if (isDir) visit(full)
      else if (SOURCE_EXT.has(extname(entry))) found.push(full)
    }
  }
  visit(root)
  return found.sort()
}

export function buildSkeleton(root: string): Skeleton {
  const absolute = walk(root)
  const relPaths = absolute.map((abs) => relative(root, abs))

  // One-time, repo-wide context each strategy needs before it can resolve any
  // single file's specifiers (only Go actually uses this, for go.mod).
  const contexts = new Map<LangStrategy, unknown>()
  for (const strategy of STRATEGIES) {
    if (strategy.prepare) contexts.set(strategy, strategy.prepare(root, relPaths))
  }

  const files: SourceFile[] = []
  const edges: { from: string; to: string }[] = []
  const seenEdge = new Set<string>()

  for (const abs of absolute) {
    const strategy = strategyFor(abs)
    if (!strategy) continue // walk() only returns extensions a strategy claims
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const path = relative(root, abs)
    const imports: string[] = []
    const external: string[] = []
    const ctx = contexts.get(strategy)

    for (const spec of strategy.specifiers(text)) {
      const result = strategy.resolveLocal(ctx, root, abs, spec)
      if (result.kind === 'local') {
        for (const local of result.paths) {
          if (!imports.includes(local)) imports.push(local)
          const key = `${path} ${local}`
          if (!seenEdge.has(key)) {
            seenEdge.add(key)
            edges.push({ from: path, to: local })
          }
        }
      } else if (result.kind === 'external' && !external.includes(result.spec)) {
        external.push(result.spec)
      }
      // 'unresolved': looked local but no real file was found — neither an
      // edge nor a dependency, exactly the "don't fabricate" case.
    }

    files.push({
      path,
      loc: text.split('\n').length,
      exports: strategy.exportedNames(text),
      imports,
      external,
    })
  }

  return { root, files, edges }
}

/** Who imports this file. The reverse index the blast-radius view needs. */
export function importersOf(skeleton: Skeleton, path: string): string[] {
  return skeleton.edges.filter((e) => e.to === path).map((e) => e.from)
}
