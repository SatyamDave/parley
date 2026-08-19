// The deterministic gate.
//
// This exists because of a real, documented failure in this exact repo, not a
// theoretical worry. An agent wrote 49 genuinely good tests, added an
// `npm test` script, and marked its task done with `verified_how: "tests
// pass"`. The script was `node --test test/` — the directory form, which
// `node --test` cannot resolve as a module path — so it threw
// `MODULE_NOT_FOUND` on every run and every one of those 49 tests silently
// never ran. Nobody noticed for days, because the only thing that had ever
// "verified" the claim was the same agent's own free-text say-so
// (src/mcp.ts, updateTask: `verified_by` is set to whichever agent is
// *calling*, based on nothing but that agent's own claim). Self-attestation
// caught nothing, because it was never designed to catch anything — it just
// records what an agent says.
//
// So this module contains no model calls at all. It finds a project's real
// checks from files that are actually on disk (package.json scripts, lockfiles,
// pyproject.toml, go.mod, Cargo.toml, a Makefile) and runs them for real,
// via argv execution, and reports the real exit code and real captured
// output. A non-zero exit is data, not an exception; the only thing this
// module refuses to do is agree that something passed without having run it.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export type CheckKind = 'test' | 'typecheck' | 'lint' | 'build' | 'vet' | 'other'

export type Check = {
  /** Human-readable label, e.g. "pnpm run test" or "go vet". */
  name: string
  /** argv, never a shell string — a check command is often untrusted-ish
   *  input (a script name lifted from someone else's package.json), and shell
   *  interpolation of that is exactly how injection and quoting bugs happen. */
  command: string[]
  kind: CheckKind
}

export type CheckResult = {
  name: string
  command: string[]
  ok: boolean
  /** Process exit code, or null if the process never produced one (killed by
   *  a signal, e.g. our own timeout, or never launched at all). */
  exitCode: number | null
  /** Captured stdout+stderr, tail-capped — see runOne for why. */
  output: string
  durationMs: number
  /** Set only for the exceptional cases: a timeout, or a command that could
   *  not be launched (e.g. binary missing). A plain nonzero exit does not
   *  get a reason; the exit code and output already say everything. */
  reason?: string
}

// --- detection -------------------------------------------------------------

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined // missing or malformed — never worth failing detection over
  }
}

/** Running `npm test` inside a pnpm repo (or vice versa) can silently behave
 *  differently — different lockfile resolution, different script-running
 *  semantics — so the check must shell out through whichever manager this
 *  repo actually uses, not npm by default. */
function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function detectNodeChecks(root: string): Check[] {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return []
  const pkg = readJson(pkgPath) as { scripts?: Record<string, unknown> } | undefined
  const scripts = pkg?.scripts ?? {}
  const pm = detectPackageManager(root)

  // Order matters: this is the priority a failing check should be *found*
  // in, not just a list — test first because a red test suite is the check
  // most worth surfacing before anything else.
  const priority: [CheckKind, string[]][] = [
    ['test', ['test']],
    ['typecheck', ['typecheck', 'tsc']],
    ['lint', ['lint']],
    ['build', ['build']],
  ]

  const checks: Check[] = []
  for (const [kind, candidates] of priority) {
    const scriptName = candidates.find((c) => typeof scripts[c] === 'string')
    if (scriptName) {
      // `run` works uniformly across npm/pnpm/yarn/bun, including for the
      // special-cased "test" script npm also lets you invoke bare.
      checks.push({ name: `${pm} run ${scriptName}`, command: [pm, 'run', scriptName], kind })
    }
  }
  return checks
}

/** True if pyproject.toml exists and contains a `[tool.<name>]` table — the
 *  standard place Python tools declare "this project actually uses me". */
function pyprojectHasTool(root: string, name: string): boolean {
  const p = join(root, 'pyproject.toml')
  if (!existsSync(p)) return false
  try {
    return readFileSync(p, 'utf8').includes(`[tool.${name}]`)
  } catch {
    return false
  }
}

function detectPythonChecks(root: string): Check[] {
  const checks: Check[] = []
  const hasPytestConfig = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini'].some((f) => existsSync(join(root, f)))
  if (hasPytestConfig) checks.push({ name: 'pytest', command: ['pytest'], kind: 'test' })

  const hasRuff = pyprojectHasTool(root, 'ruff') || existsSync(join(root, 'ruff.toml')) || existsSync(join(root, '.ruff.toml'))
  if (hasRuff) checks.push({ name: 'ruff check', command: ['ruff', 'check', '.'], kind: 'lint' })

  const setupCfg = existsSync(join(root, 'setup.cfg')) ? readFileSync(join(root, 'setup.cfg'), 'utf8') : ''
  const hasMypy = pyprojectHasTool(root, 'mypy') || existsSync(join(root, 'mypy.ini')) || setupCfg.includes('[mypy]')
  if (hasMypy) checks.push({ name: 'mypy', command: ['mypy', '.'], kind: 'typecheck' })

  return checks
}

function detectGoChecks(root: string): Check[] {
  if (!existsSync(join(root, 'go.mod'))) return []
  return [
    { name: 'go test', command: ['go', 'test', './...'], kind: 'test' },
    { name: 'go vet', command: ['go', 'vet', './...'], kind: 'vet' },
    { name: 'go build', command: ['go', 'build', './...'], kind: 'build' },
  ]
}

function detectRustChecks(root: string): Check[] {
  if (!existsSync(join(root, 'Cargo.toml'))) return []
  return [
    { name: 'cargo test', command: ['cargo', 'test'], kind: 'test' },
    { name: 'cargo clippy', command: ['cargo', 'clippy'], kind: 'lint' },
    { name: 'cargo build', command: ['cargo', 'build'], kind: 'build' },
  ]
}

/** A Makefile with a `test:` or `check:` target is very often the project's
 *  real, curated entry point (it may wrap several other tools) — worth
 *  detecting on top of whatever the ecosystem-specific checks above found. */
function detectMakeChecks(root: string): Check[] {
  const p = join(root, 'Makefile')
  if (!existsSync(p)) return []
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return []
  }
  const checks: Check[] = []
  if (/^test:/m.test(text)) checks.push({ name: 'make test', command: ['make', 'test'], kind: 'test' })
  if (/^check:/m.test(text)) checks.push({ name: 'make check', command: ['make', 'check'], kind: 'other' })
  return checks
}

/** Everything this project's own files say should be run to verify it.
 *  Returns [] when nothing is detected — that is a real, meaningful answer
 *  ("no checks exist for this project"), not an error, and callers must not
 *  confuse it with `runChecks` on a nonempty list all passing. Check
 *  `detectChecks(root).length === 0` explicitly if that distinction matters
 *  to you; `summarize([])` also says so in its report text. */
export function detectChecks(root: string): Check[] {
  return [
    ...detectNodeChecks(root),
    ...detectPythonChecks(root),
    ...detectGoChecks(root),
    ...detectRustChecks(root),
    ...detectMakeChecks(root),
  ]
}

// --- running -----------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 5 * 60_000

// The useful part of a failing run is almost always at the *end* — the
// assertion failure, the stack trace, the compiler error — while the front
// is often just setup noise. Keeping the tail (not the head) and bounding it
// per stream also caps memory for a check that goes rogue and free-runs
// stdout, which an unbounded buffer would not.
const MAX_OUTPUT_CHARS = 20_000

function tailAppend(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length > MAX_OUTPUT_CHARS ? combined.slice(combined.length - MAX_OUTPUT_CHARS) : combined
}

function formatOutput(stdout: string, stderr: string): string {
  // Test failures very often land on stderr, not stdout — losing it would
  // make the result useless for handing back to an agent. Keep both, labeled.
  return [stdout, stderr ? `--- stderr ---\n${stderr}` : ''].filter(Boolean).join('\n')
}

/** Run one check to completion. Never throws for a failing or timed-out
 *  check — a nonzero exit is data. Only a command that could not be launched
 *  at all (e.g. not on PATH) is treated as exceptional, and even that
 *  resolves as `ok: false` with a `reason` rather than rejecting. */
function runOne(root: string, check: Check, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const [cmd, ...args] = check.command
    // NODE_TEST_CONTEXT leaking into a spawned check is a real, measured
    // false-pass: if this very module is itself being exercised under
    // `node --test` (as its own test suite is), that env var inherits into
    // any child check that happens to also be `node --test ...`, and the
    // child treats itself as a *nested* run of the same test file — it logs
    // "run() is being called recursively" and exits 0 having run nothing.
    // Silently-skipped-but-reported-green is exactly the failure class this
    // whole module exists to catch, so it must not reintroduce it via env
    // leakage. Delete the key rather than set it to '' — an empty string is
    // still present and still triggers the recursive-skip check.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(cmd, args, { cwd: root, env })

    // A hung suite (a stuck watch mode, a wedged database connection) must
    // not hang the whole gate forever. SIGKILL rather than SIGTERM because
    // this is a one-shot verification run, not a process we need to let
    // clean up after itself — and a process ignoring SIGTERM is exactly the
    // "hung" case this timeout exists to end.
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const finish = (result: CheckResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout = tailAppend(stdout, d.toString('utf8'))
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = tailAppend(stderr, d.toString('utf8'))
    })

    child.on('error', (err) => {
      // e.g. ENOENT — the binary itself doesn't exist. This is the one case
      // that is genuinely exceptional rather than a normal failing run.
      finish({
        name: check.name,
        command: check.command,
        ok: false,
        exitCode: null,
        output: formatOutput(stdout, stderr),
        durationMs: Date.now() - start,
        reason: `could not launch: ${err.message}`,
      })
    })

    child.on('close', (code) => {
      finish({
        name: check.name,
        command: check.command,
        ok: !timedOut && code === 0,
        exitCode: code,
        output: formatOutput(stdout, stderr),
        durationMs: Date.now() - start,
        reason: timedOut ? `timed out after ${timeoutMs}ms` : undefined,
      })
    })
  })
}

/** Execute every check and report what actually happened. Sequential by
 *  default: concurrent agents' test suites sharing a database or a port will
 *  corrupt each other if run in parallel, and that is not theoretical in
 *  this project — several agents work one repo at once. Pass
 *  `parallel: true` only when the checks are known independent. */
export async function runChecks(
  root: string,
  checks: Check[],
  opts?: { timeoutMs?: number; parallel?: boolean },
): Promise<CheckResult[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (opts?.parallel) {
    return Promise.all(checks.map((c) => runOne(root, c, timeoutMs)))
  }
  const results: CheckResult[] = []
  for (const c of checks) {
    results.push(await runOne(root, c, timeoutMs))
  }
  return results
}

// --- reporting ---------------------------------------------------------

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

/** A compact report meant to be handed straight back to an agent whose task
 *  just failed the gate — so failures carry their real captured output, not
 *  just "tests failed". `ok` is vacuously true for an empty result list;
 *  callers that care about "no checks were detected" should check that
 *  upstream via `detectChecks(root).length === 0`, since that is a different
 *  fact from "the checks that ran all passed" and this report says which
 *  count is zero. */
export function summarize(results: CheckResult[]): { ok: boolean; failed: CheckResult[]; report: string } {
  if (results.length === 0) {
    return { ok: true, failed: [], report: 'No checks ran (0 checks).' }
  }

  const failed = results.filter((r) => !r.ok)
  const lines = results.map((r) => {
    const header = `${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.durationMs}ms) — ${r.command.join(' ')}`
    if (r.ok) return header
    const parts = [
      header,
      r.reason ? `  reason: ${r.reason}` : '',
      `  exit code: ${r.exitCode}`,
      r.output ? `  output:\n${indent(r.output)}` : '  (no output captured)',
    ]
    return parts.filter(Boolean).join('\n')
  })

  return { ok: failed.length === 0, failed, report: lines.join('\n\n') }
}
