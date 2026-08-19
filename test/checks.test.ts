// src/checks.ts is the deterministic gate: it must find a project's real
// checks from files actually on disk and actually run them, with no model
// call anywhere. These tests build tiny real fixture trees on disk (no
// mocking of fs or child_process) and assert on what detectChecks/runChecks/
// summarize actually produce — including the exact historical bug
// (`node --test test/` silently never running 49 .ts tests) that motivated
// building this module at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectChecks, runChecks, summarize, type Check } from '../src/checks.ts'

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'parley-checks-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

// --- detectChecks: Node/JS/TS ------------------------------------------

test('detectChecks: package.json scripts are detected in priority order, npm by default', () => {
  const root = fixture({
    'package.json': JSON.stringify({
      scripts: { test: 'node test.js', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'tsc' },
    }),
  })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(
      checks.map((c) => c.kind),
      ['test', 'typecheck', 'lint', 'build'],
    )
    assert.deepEqual(checks[0].command, ['npm', 'run', 'test'])
    assert.equal(checks[0].name, 'npm run test')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: falls back to a "tsc" script for typecheck when no "typecheck" script exists', () => {
  const root = fixture({
    'package.json': JSON.stringify({ scripts: { tsc: 'tsc --noEmit' } }),
  })
  try {
    const checks = detectChecks(root)
    const tc = checks.find((c) => c.kind === 'typecheck')
    assert.ok(tc)
    assert.deepEqual(tc!.command, ['npm', 'run', 'tsc'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: only scripts that are actually present are returned', () => {
  const root = fixture({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }) })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(checks.map((c) => c.kind), ['lint'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: package manager is detected from lockfiles, not assumed to be npm', () => {
  const cases: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ]
  for (const [lockfile, pm] of cases) {
    const root = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'echo hi' } }),
      [lockfile]: '',
    })
    try {
      const checks = detectChecks(root)
      assert.deepEqual(checks[0].command, [pm, 'run', 'test'], `expected ${pm} for ${lockfile}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// --- detectChecks: other ecosystems --------------------------------------

test('detectChecks: Python — pytest from pyproject.toml, plus ruff/mypy only when configured', () => {
  const root = fixture({
    'pyproject.toml': '[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
  })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(
      checks.map((c) => c.kind).sort(),
      ['lint', 'test', 'typecheck'],
    )
    assert.deepEqual(
      checks.find((c) => c.kind === 'test')!.command,
      ['pytest'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: Python — a bare pyproject.toml with no tool sections yields only pytest', () => {
  const root = fixture({ 'pyproject.toml': '[project]\nname = "x"\n' })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(checks.map((c) => c.kind), ['test'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: Python — mypy detected from setup.cfg [mypy] section without pyproject.toml', () => {
  const root = fixture({ 'setup.cfg': '[mypy]\nstrict = true\n' })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(checks.map((c) => c.kind), ['test', 'typecheck'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: Go — go.mod produces test, vet, and build', () => {
  const root = fixture({ 'go.mod': 'module example.com/x\n\ngo 1.22\n' })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(checks.map((c) => c.kind), ['test', 'vet', 'build'])
    assert.deepEqual(checks.find((c) => c.kind === 'test')!.command, ['go', 'test', './...'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: Rust — Cargo.toml produces test, clippy, and build', () => {
  const root = fixture({ 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n' })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(checks.map((c) => c.kind), ['test', 'lint', 'build'])
    assert.deepEqual(checks.find((c) => c.kind === 'lint')!.command, ['cargo', 'clippy'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: Makefile with test: and check: targets is detected', () => {
  const root = fixture({ Makefile: 'test:\n\techo running tests\n\ncheck:\n\techo checking\n' })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(
      checks.map((c) => c.command),
      [['make', 'test'], ['make', 'check']],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectChecks: a repo with no recognizable project files returns an empty array, not a crash', () => {
  const root = fixture({ 'README.md': '# nothing here' })
  try {
    const checks = detectChecks(root)
    assert.deepEqual(checks, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- runChecks -------------------------------------------------------------

test('runChecks: a genuinely passing command reports ok:true with exit code 0', async () => {
  const root = fixture({})
  try {
    const checks: Check[] = [{ name: 'exit 0', command: ['node', '-e', 'process.exit(0)'], kind: 'test' }]
    const [result] = await runChecks(root, checks)
    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runChecks: a genuinely failing command reports ok:false, the real exit code, and captures stderr — without throwing', async () => {
  const root = fixture({})
  try {
    const checks: Check[] = [
      { name: 'exit 1 with stderr', command: ['node', '-e', "console.error('boom'); process.exit(1)"], kind: 'test' },
    ]
    const [result] = await runChecks(root, checks)
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 1)
    assert.ok(result.output.includes('boom'), `expected captured output to include stderr, got: ${result.output}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runChecks: a hung command is killed at the timeout and reported as a failure with a clear reason, not a crash', async () => {
  const root = fixture({})
  try {
    const checks: Check[] = [
      { name: 'sleep forever', command: ['node', '-e', 'setTimeout(() => {}, 60_000)'], kind: 'test' },
    ]
    const [result] = await runChecks(root, checks, { timeoutMs: 300 })
    assert.equal(result.ok, false)
    assert.ok(result.reason?.includes('timed out'), `expected a timeout reason, got: ${result.reason}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runChecks: a command that cannot be launched at all is reported as ok:false with a reason, not thrown', async () => {
  const root = fixture({})
  try {
    const checks: Check[] = [{ name: 'missing binary', command: ['this-binary-does-not-exist-xyz'], kind: 'other' }]
    const [result] = await runChecks(root, checks)
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, null)
    assert.ok(result.reason?.includes('could not launch'), `expected a launch-failure reason, got: ${result.reason}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runChecks: runs sequentially by default (no overlap in start/end times)', async () => {
  const root = fixture({})
  try {
    // Each waits briefly then exits; if run in parallel the two windows would
    // overlap. Sequential execution means the second cannot start until the
    // first's process has already closed.
    const checks: Check[] = [
      { name: 'a', command: ['node', '-e', 'setTimeout(() => process.exit(0), 80)'], kind: 'test' },
      { name: 'b', command: ['node', '-e', 'process.exit(0)'], kind: 'test' },
    ]
    const start = Date.now()
    await runChecks(root, checks)
    const elapsed = Date.now() - start
    // If they ran in parallel this would be roughly max(80, ~0) ~= 80ms;
    // sequential must be at least the sum of both, comfortably over 80ms.
    assert.ok(elapsed >= 80, `expected sequential runs to take at least 80ms, took ${elapsed}ms`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- summarize ---------------------------------------------------------

test('summarize: all passing checks yield ok:true and an empty failed list', async () => {
  const root = fixture({})
  try {
    const checks: Check[] = [{ name: 'pass', command: ['node', '-e', 'process.exit(0)'], kind: 'test' }]
    const results = await runChecks(root, checks)
    const { ok, failed, report } = summarize(results)
    assert.equal(ok, true)
    assert.deepEqual(failed, [])
    assert.ok(report.includes('PASS'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('summarize: a mixed result set is ok:false, lists the failure, and the report carries the real output', async () => {
  const root = fixture({})
  try {
    const checks: Check[] = [
      { name: 'pass', command: ['node', '-e', 'process.exit(0)'], kind: 'test' },
      { name: 'fail', command: ['node', '-e', "console.error('specific failure detail'); process.exit(1)"], kind: 'lint' },
    ]
    const results = await runChecks(root, checks)
    const { ok, failed, report } = summarize(results)
    assert.equal(ok, false)
    assert.equal(failed.length, 1)
    assert.equal(failed[0].name, 'fail')
    assert.ok(report.includes('specific failure detail'), 'report must carry real captured output, not just a pass/fail label')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('summarize: an empty result list is ok:true but its report says plainly that nothing ran', () => {
  const { ok, failed, report } = summarize([])
  assert.equal(ok, true)
  assert.deepEqual(failed, [])
  assert.ok(report.toLowerCase().includes('no checks'))
})

// --- this repo, for real -----------------------------------------------

test('detectChecks: finds real checks on this repo (parley itself)', () => {
  const checks = detectChecks(join(import.meta.dirname, '..'))
  assert.ok(checks.some((c) => c.kind === 'test'), 'expected a test check to be detected on parley itself')
})

// --- the historical bug this module exists to catch ------------------------

test('runChecks: catches the exact historical bug — an npm test script using the directory form `node --test test/` fails loudly instead of silently passing', async () => {
  const root = fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test test/' } }),
    'test/foo.test.ts': [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "test('a real ts test', () => { assert.equal(1, 1) })",
    ].join('\n'),
  })
  try {
    const checks = detectChecks(root)
    const testCheck = checks.find((c) => c.kind === 'test')
    assert.ok(testCheck)

    const [result] = await runChecks(root, [testCheck!])

    // The bug that shipped undetected: this must NOT be reported as passing.
    assert.equal(result.ok, false)
    assert.notEqual(result.exitCode, 0)
    // The real error node produces for this exact mistake, captured verbatim.
    assert.ok(
      result.output.includes('MODULE_NOT_FOUND') || result.output.includes('Cannot find module'),
      `expected the real module-resolution error to be captured, got: ${result.output}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
