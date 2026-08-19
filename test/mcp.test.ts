// The parley MCP server (src/mcp.ts) never exports its dispatch function or
// its tool list — agents only ever reach it by writing JSON-RPC lines to its
// stdin and reading responses off its stdout. mcp.ts also has no exports at
// all, and this suite must not touch src/, so there is no way to import the
// handlers directly.
//
// Instead we drive the module through its real entry point, in-process: swap
// process.stdin for a fake Readable before importing a fresh copy of mcp.ts
// (so its own `createInterface({ input: process.stdin })` binds to our fake
// stream), push JSON-RPC request lines into it, and capture whatever it
// writes to process.stdout while doing so. This exercises the exact same
// readline -> JSON.parse -> call() -> store code path a real Claude Code
// session would, without spawning a subprocess and without any real stdio.
//
// Every "agent" in these tests is its own fresh module instance of mcp.ts
// (via a `?fresh=N` query, same trick as test/store-graph.test.ts) so that
// each one captures a distinct PARLEY_AGENT identity at import time. All of
// them still import the plain, unqualified `./store.ts`, so — like the real
// system — they all end up sharing exactly one board (one DatabaseSync
// singleton, opened against the PARLEY_DIR set below). Every agent id is
// made unique to the call that created it, so no test can see claims, feed
// posts, or agent-status rows left behind by an earlier one.
//
// IMPORTANT: `node --test` itself pipes structured test-lifecycle events
// (test:enqueue/start/pass/fail...) through this same process's real
// process.stdout as its own IPC channel back to the CLI. A naive "swallow
// everything written to stdout while we wait" patch captures that traffic
// too and corrupts it (discovered empirically — it silently dropped 15 of 16
// tests' results). So instead of swallowing all output, the patch below only
// intercepts writes that are our own JSON-RPC response lines (recognizable
// by the literal `{"jsonrpc"` prefix mcp.ts's own `send()` always produces)
// and passes every other write straight through untouched.
// parley_update(status: "done") now runs src/checks.ts's real gate against
// projectRoot(), which defaults to process.cwd() (store.ts's projectRoot()).
// Any test that reaches "done" MUST chdir into an isolated fixture first —
// otherwise it detects and actually *runs* this very repo's own `npm test` /
// `npm run check` scripts as a side effect of a unit test, recursively
// re-invoking `node --test test/*.test.ts` from inside itself. withCwd()
// below is the guard: it always restores the real cwd, even on throw.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import * as store from '../src/store.ts'

/** Run `fn` with process.cwd() pointed at `dir`, always restoring the real
 *  cwd afterward — same pattern as test/tutor.test.ts's inRepo(). */
async function withCwd<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(prev)
  }
}

/** A throwaway project with exactly one npm script, for exercising the real
 *  gate without touching this repo. No .git anywhere above tmpdir() (verified
 *  empirically), so store.ts's projectRoot() falls back to returning this
 *  directory itself rather than walking up into a real repo. */
function fixtureProject(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'parley-mcp-gate-fixture-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }))
  return root
}

let dir: string
const jsonrpcLines: string[] = []
let realWrite: typeof process.stdout.write

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'parley-mcp-test-'))
  process.env.PARLEY_DIR = dir

  realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (text.startsWith('{"jsonrpc"')) {
      jsonrpcLines.push(text)
      return true
    }
    // biome-ignore lint: forwarding the exact original arguments to the real writer.
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
})

after(() => {
  process.stdout.write = realWrite
  rmSync(dir, { recursive: true, force: true })
})

// A fixed iteration count (the original form of this helper) times out on
// wall-clock, not on iterations: a `parley_update(done)` call now really
// spawns a subprocess (npm/pytest/go/...) via checks.ts's runChecks, and
// `npm run test`'s own CLI startup overhead alone can exceed 500 back-to-back
// setImmediate ticks, which cost roughly nothing when nothing else is
// pending. Measured this empirically: the fixed-count version aborted the
// *test* (assertion failure) while the real npm child was still starting,
// so the harness moved on to the next test while that orphaned promise —
// and the check_lock it was still holding — kept running in the background,
// cascading into spurious lock-contention failures on unrelated tests.
// Bounding by elapsed time instead fixes both: every real check run gets to
// actually finish before we give up.
async function waitUntil(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise((r) => setImmediate(r))
  assert.ok(check(), 'timed out waiting for the mcp module to answer')
}

let mcpCounter = 0

/** A fresh, isolated in-process instance of the mcp server speaking as a
 *  freshly minted agent id derived from `idHint`. The agent is also joined
 *  onto the board (as the real SessionStart hook would before any tool call
 *  is possible), so status assertions have a row to land on. Returns the
 *  agent's id plus an async `call(tool, args)` that sends one tools/call
 *  request and resolves with the text of the response (or throws on a
 *  JSON-RPC error). */
async function makeAgent(idHint: string): Promise<{ id: string; call: (name: string, args?: Record<string, unknown>) => Promise<string> }> {
  const n = mcpCounter++
  const id = `${idHint}-${n}`
  process.env.PARLEY_AGENT = id
  store.joinAgent(id, idHint, 10000 + n, 'idle')

  const input = new Readable({ read() {} })
  const realStdin = process.stdin
  Object.defineProperty(process, 'stdin', { value: input, configurable: true })
  try {
    await import(`../src/mcp.ts?fresh=${n}`)
  } finally {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
  }

  let nextId = 0
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const reqId = ++nextId
    const before = jsonrpcLines.length
    input.push(
      `${JSON.stringify({ jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name, arguments: args } })}\n`,
    )
    await waitUntil(() => jsonrpcLines.length > before)
    const res = JSON.parse(jsonrpcLines[jsonrpcLines.length - 1].trim()) as {
      id: number
      result?: { content: { type: string; text: string }[] }
      error?: { message: string }
    }
    assert.equal(res.id, reqId, 'response id must match the request that was sent')
    if (res.error) throw new Error(res.error.message)
    return res.result!.content[0].text
  }
  return { id, call }
}

// --- parley_claim -----------------------------------------------------

test('parley_claim: claiming a free task succeeds', async () => {
  const id = store.addTask('build the thing')
  const agentA = await makeAgent('agentA')

  const result = await agentA.call('parley_claim', { task_id: id })

  assert.match(result, new RegExp(`Claimed #${id} build the thing`))
  const task = store.getTask(id)!
  assert.equal(task.status, 'claimed')
  assert.equal(task.owner, agentA.id)
})

test('parley_claim: a task already held by another agent is refused, naming the holder', async () => {
  const id = store.addTask('only one owner')
  const agentA = await makeAgent('agentA')
  const agentB = await makeAgent('agentB')

  await agentA.call('parley_claim', { task_id: id })
  const result = await agentB.call('parley_claim', { task_id: id })

  assert.match(result, /Could not claim/)
  assert.match(result, new RegExp(`held by ${agentA.id}`))
  assert.match(result, /Pick different work/)
  // the refusal must not have silently reassigned it
  assert.equal(store.getTask(id)!.owner, agentA.id)
})

test('parley_claim: path conflicts are detected in both directions', async () => {
  const agentA = await makeAgent('agentA')
  const agentB = await makeAgent('agentB')
  const agentC = await makeAgent('agentC')

  // direction 1: a broad claim already held, a narrower path collides with it
  await agentA.call('parley_claim', { paths: ['src/api'] })
  const narrower = await agentB.call('parley_claim', { paths: ['src/api/routes.ts'] })
  assert.match(narrower, /CONFLICT on src\/api\/routes\.ts/)
  assert.match(narrower, new RegExp(agentA.id))

  // direction 2: a narrow claim already held, a broader path collides with it
  await agentB.call('parley_claim', { paths: ['src/very/specific/file.ts'] })
  const broader = await agentC.call('parley_claim', { paths: ['src/very'] })
  assert.match(broader, /CONFLICT on src\/very/)
  assert.match(broader, new RegExp(agentB.id))
})

test('parley_claim: a path is claimable again after being released', async () => {
  const agentA = await makeAgent('agentA')
  const agentB = await makeAgent('agentB')

  await agentA.call('parley_claim', { paths: ['src/scratch.ts'] })
  const blocked = await agentB.call('parley_claim', { paths: ['src/scratch.ts'] })
  assert.match(blocked, /CONFLICT/)

  await agentA.call('parley_release', { paths: ['src/scratch.ts'] })
  const nowFree = await agentB.call('parley_claim', { paths: ['src/scratch.ts'] })
  assert.match(nowFree, /Claimed path src\/scratch\.ts/)
})

test('parley_claim: a non-existent task id is reported, not thrown', async () => {
  const agentA = await makeAgent('agentA')
  const result = await agentA.call('parley_claim', { task_id: 999999 })
  assert.equal(result, 'No task #999999 on the board.')
})

// --- parley_avoid -------------------------------------------------------

test('parley_avoid: records a declaration distinct from a claim, and does not block others', async () => {
  const agentA = await makeAgent('agentA')
  const agentB = await makeAgent('agentB')

  const result = await agentA.call('parley_avoid', { paths: ['src/legacy'], note: 'owned by the migration lane' })
  assert.match(result, /Declared not-touching: src\/legacy/)

  const avoided = store.claims('avoid').filter((c) => c.path === 'src/legacy' && c.agent === agentA.id)
  assert.equal(avoided.length, 1)
  assert.equal(avoided[0].kind, 'avoid')

  // it must not show up as a claim
  assert.equal(store.claims('claim').filter((c) => c.path === 'src/legacy' && c.agent === agentA.id).length, 0)

  // an avoid is not a conflict: a peer can still claim the same path
  const claimResult = await agentB.call('parley_claim', { paths: ['src/legacy'] })
  assert.match(claimResult, /Claimed path src\/legacy/)

  const feedHit = store.feed(50).find((f) => f.agent === agentA.id && f.body.includes('not touching: src/legacy'))
  assert.ok(feedHit, 'the avoid must also be announced on the feed')
})

// --- parley_release -----------------------------------------------------

test('parley_release: releases one specific path, leaving the rest', async () => {
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { paths: ['src/one.ts', 'src/two.ts'] })

  const result = await agentA.call('parley_release', { paths: ['src/one.ts'] })
  assert.equal(result, 'Released 1 claim(s).')

  const remaining = store.claims('claim').filter((c) => c.agent === agentA.id).map((c) => c.path)
  assert.deepEqual(remaining, ['src/two.ts'])
})

test('parley_release: with no paths releases every claim the agent holds', async () => {
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { paths: ['src/three.ts', 'src/four.ts'] })

  const result = await agentA.call('parley_release', {})
  assert.equal(result, 'Released 2 claim(s).')
  assert.equal(store.claims('claim').filter((c) => c.agent === agentA.id).length, 0)
})

// --- parley_post ---------------------------------------------------------

test('parley_post: appends to the feed with the given kind', async () => {
  const agentA = await makeAgent('agentA')
  const result = await agentA.call('parley_post', { kind: 'finding', body: 'the cache was never invalidated' })
  assert.equal(result, 'Posted. Peers will see it on their next turn.')

  const hit = store
    .feed(50)
    .find((f) => f.agent === agentA.id && f.kind === 'finding' && f.body === 'the cache was never invalidated')
  assert.ok(hit, 'the post must land on the feed with its kind intact')
})

test('parley_post: a "blocked" post returns the task to the board with its tier escalated', async () => {
  const id = store.addTask('too hard for haiku', '', '', null, [], 'haiku')
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { task_id: id })

  const result = await agentA.call('parley_post', {
    kind: 'blocked',
    body: 'cannot get the types to line up',
    task_id: id,
  })

  assert.match(result, new RegExp(`#${id} is back on the board \\(attempt 1, now tiered sonnet\\)`))

  const task = store.getTask(id)!
  assert.equal(task.status, 'open', 'a blocked task goes back to open so someone else can take it')
  assert.equal(task.owner, null)
  assert.equal(task.model, 'sonnet', 'a task that defeats haiku is mis-tiered, not impossible')

  // reporting blocked also releases the reporter's claims and idles them
  assert.equal(store.agents().find((a) => a.id === agentA.id)?.status, 'idle')
})

// --- parley_update: status other than "done" is still pure self-attestation -
//
// This is deliberate, not an oversight: parley_update(done) is the one
// transition that carries "this is confirmed correct", so that is the only
// one gated below with real checks. review/claimed/open/blocked carry no
// such claim, and still just record whatever the calling agent says, exactly
// as before this change.

test('parley_update: for a status other than "done", verified_by is set purely because verified_how was non-empty — nothing is actually checked', async () => {
  // This test used to pin parley_update's *entire* behaviour as
  // self-attested and unverified, including for status "done" — that half
  // was the founding complaint this project exists to fix (see src/mcp.ts's
  // finishTask, and src/checks.ts's header for the real bug that motivated
  // it), and it is intentionally no longer true; see the "gate" tests below.
  // What remains true, and is still asserted here, is that any status other
  // than "done" carries no verification claim at all and is never gated.
  const id = store.addTask('claim it works')
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { task_id: id })

  const result = await agentA.call('parley_update', {
    task_id: id,
    status: 'review',
    verified_how: 'i am pretty sure it works',
  })

  assert.equal(result, `Updated #${id}.`)
  const task = store.getTask(id)!
  assert.equal(task.status, 'review')
  assert.equal(task.verified_by, agentA.id, 'verified_by is the calling agent, self-attested')
  assert.equal(task.verified_how, 'i am pretty sure it works', 'no validation is performed on this text')
})

test('parley_update: without a verified_how, verified_by is left unset', async () => {
  const id = store.addTask('move without evidence')
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { task_id: id })

  await agentA.call('parley_update', { task_id: id, status: 'review' })

  const task = store.getTask(id)!
  assert.equal(task.status, 'review')
  assert.equal(task.verified_by, null)
})

test('parley_update: a non-existent task id is reported, not thrown', async () => {
  const agentA = await makeAgent('agentA')
  const result = await agentA.call('parley_update', { task_id: 999998, status: 'done' })
  assert.equal(result, 'No task #999998.')
})

// --- parley_update(done): the real gate ------------------------------------
//
// This is the replacement for the old self-attestation pin above. A "done"
// update now runs src/checks.ts's real detectChecks/runChecks against
// whatever fixture project withCwd() points at, and each test below asserts
// on the actual result of that real run — no mocking of checks.ts itself.

test('parley_update(done): a genuinely passing check lets the task through, and the machine result is recorded separately from the agent claim', async () => {
  const root = fixtureProject({ test: 'node -e "process.exit(0)"' })
  const id = store.addTask('ship the passing thing')
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { task_id: id, paths: ['src/shipped.ts'] })

  try {
    const result = await withCwd(root, () =>
      agentA.call('parley_update', { task_id: id, status: 'done', verified_how: 'ran it locally, looked fine' }),
    )

    assert.match(result, /is done\. Machine-verified/)
    assert.match(result, /PASS npm run test/)

    const task = store.getTask(id)!
    assert.equal(task.status, 'done')
    assert.equal(task.verified_how, 'ran it locally, looked fine', "the agent's own claim is preserved, unmodified")
    assert.equal(task.verified_by, agentA.id)
    assert.equal(task.verified_machine, 'passed', 'the machine result lives in its own field, separate from the claim')
    assert.match(task.checks_report, /PASS npm run test/, 'the real per-check result is recorded, not just a boolean')

    // the rest of the old "done" side effects still hold: claims released,
    // agent idled, a finished post on the feed carrying the agent's claim.
    assert.equal(store.claims('claim').filter((c) => c.agent === agentA.id && c.path === 'src/shipped.ts').length, 0)
    assert.equal(store.agents().find((a) => a.id === agentA.id)?.status, 'idle')
    const finished = store.feed(50).find((f) => f.agent === agentA.id && f.kind === 'finished' && f.task_id === id)
    assert.ok(finished, 'a finished post must be on the feed')
    assert.match(finished!.body, /machine-verified/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parley_update(done): a genuinely failing check rejects the task — it stays off "done" and the real error comes back', async () => {
  const root = fixtureProject({ test: 'node -e "console.error(\'boom: assertion failed on line 42\'); process.exit(1)"' })
  const id = store.addTask('ship the broken thing')
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { task_id: id })

  try {
    const result = await withCwd(root, () =>
      agentA.call('parley_update', { task_id: id, status: 'done', verified_how: 'tests pass' }),
    )

    assert.match(result, /did NOT reach done/)
    assert.match(result, /boom: assertion failed on line 42/, 'the real failure output must come back to the caller')

    const task = store.getTask(id)!
    assert.notEqual(task.status, 'done', 'a real failure must never let the task become done')
    assert.equal(task.status, 'open', 'a rejected task goes back to the board, not left claimed')
    assert.match(
      task.detail,
      /boom: assertion failed on line 42/,
      'the real failure output is attached to the task itself, via blockTask, not just returned to the caller',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parley_update(done): with no checks detected at all, the task is let through but marked unverified — never the same as a real pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parley-mcp-gate-fixture-')) // deliberately empty: no package.json, nothing
  const id = store.addTask('ship into a repo with no checks')
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { task_id: id })

  try {
    const result = await withCwd(root, () =>
      agentA.call('parley_update', { task_id: id, status: 'done', verified_how: 'read the code, looks right' }),
    )

    assert.match(result, /UNVERIFIED/)

    const task = store.getTask(id)!
    assert.equal(task.status, 'done', 'many real repos genuinely have no checks — still let it through')
    assert.equal(task.verified_machine, 'unverified')
    assert.notEqual(task.verified_machine, 'passed', 'must never look the same as an actual machine-confirmed pass')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parley_update(done): a second agent arriving mid-check-run is told to retry, and never runs concurrently', async () => {
  const root = fixtureProject({ test: 'node -e "process.exit(0)"' })
  const id = store.addTask('contended')
  const agentA = await makeAgent('agentA')
  const agentB = await makeAgent('agentB')
  await agentB.call('parley_claim', { task_id: id })

  // Simulate agentA's check run already being in flight by holding the lock
  // directly — this is the exact mechanism finishTask itself uses, so it
  // reproduces the real race without needing two processes.
  assert.equal(store.acquireCheckLock(agentA.id), true)
  try {
    const result = await withCwd(root, () =>
      agentB.call('parley_update', { task_id: id, status: 'done', verified_how: 'looks fine' }),
    )
    assert.match(result, /verification run is in flight/)
    assert.notEqual(store.getTask(id)!.status, 'done', 'must not have run checks concurrently with the other holder')
  } finally {
    store.releaseCheckLock(agentA.id)
    rmSync(root, { recursive: true, force: true })
  }
})

test('parley_post: a "blocked" post escalates even when the task itself has no explicit tier', async () => {
  // Regression test for the fix in store.ts's blockTask: 'research' routes
  // this task (via laneFor's label match) to the scout lane, whose persona
  // default model is 'haiku' — but the task itself never got an explicit
  // tier, which used to mean TIERS.indexOf('') === -1 and escalation silently
  // never happened. Compare with the pinned "too hard for haiku" test above,
  // which passes an *explicit* tier and always worked.
  const id = store.addTask('too hard, and nobody set a tier', '', 'research')
  const agentA = await makeAgent('agentA')
  await agentA.call('parley_claim', { task_id: id })

  const result = await agentA.call('parley_post', {
    kind: 'blocked',
    body: 'cannot get the types to line up',
    task_id: id,
  })

  assert.match(result, new RegExp(`#${id} is back on the board \\(attempt 1, now tiered sonnet\\)`))
  assert.equal(
    store.getTask(id)!.model,
    'sonnet',
    'an untiered task now escalates off its lane persona default, instead of staying stuck at empty',
  )
})

// --- parley_task_add ------------------------------------------------------

test('parley_task_add: adds a task and reports the board size', async () => {
  const before = store.tasks().length
  const agentA = await makeAgent('agentA')

  const result = await agentA.call('parley_task_add', { title: 'discovered work' })

  assert.match(result, /^Added #\d+\.\s+Ready now\./)
  assert.equal(store.tasks().length, before + 1)
})

test('parley_task_add: dependencies on ids that do not exist are filtered out, not stored dangling', async () => {
  const real = store.addTask('a real dependency')
  const agentA = await makeAgent('agentA')

  const result = await agentA.call('parley_task_add', {
    title: 'depends on one real thing and one ghost',
    deps: [real, 424242],
  })

  const idMatch = result.match(/^Added #(\d+)\./)
  assert.ok(idMatch, 'expected an id in the response')
  const newId = Number(idMatch![1])

  const task = store.getTask(newId)!
  const deps = task.deps.split(',').filter(Boolean).map(Number)
  assert.deepEqual(deps, [real], 'the ghost dependency must not be stored')
  assert.match(result, new RegExp(`Waiting on #${real}\\.`))
})
