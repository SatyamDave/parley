// The scheduler's first tests. dispatch.ts decides which agent gets which
// task, and when — every historical bug in this project has clustered here,
// and every one of them failed silently (a task sitting forever, a
// double-dispatch into the same terminal, an escalation that quietly no-ops).
// These tests exist to make those regressions loud.
//
// store.ts caches one DatabaseSync handle at module scope (see
// test/store-graph.test.ts), and dispatch.ts's own `import ... from
// './store.ts'` always resolves to that same plain, no-query module — a
// `?fresh=N` query on dispatch.ts's own specifier does not propagate to its
// internal imports. So unlike store-graph.test.ts, we cannot get a fresh
// database per test by re-importing with a query: dispatch would still be
// talking to the first instance ever loaded. Instead we set PARLEY_DIR once,
// import store.ts plainly (the same instance dispatch.ts is guaranteed to
// share), and wipe every table before each test. We still re-import
// dispatch.ts with `?fresh=N` per test, because that *does* reset dispatch's
// own module-level state (`spawnedFor`, `capacityNoted`) without touching the
// shared database.
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'parley-dispatch-test-'))
process.env.PARLEY_DIR = dir
after(() => rmSync(dir, { recursive: true, force: true }))

const store = await import('../src/store.ts')
const { persona } = await import('../src/personas.ts')

let dispatchCounter = 0
async function freshDispatch() {
  return await import(`../src/dispatch.ts?fresh=${dispatchCounter++}`)
}

/** Wipe every table and reset autoincrement counters so each test starts on
 *  an empty, id-1 board — the isolation store-graph.test.ts gets from a fresh
 *  module, achieved here by resetting data instead since the module itself
 *  is necessarily shared with dispatch.ts. */
function resetDb() {
  store.db().exec(`
    DELETE FROM agents;
    DELETE FROM tasks;
    DELETE FROM feed;
    DELETE FROM claims;
    DELETE FROM links;
    DELETE FROM personas;
    DELETE FROM sqlite_sequence;
  `)
}

/** A fake Runner that just records what got typed into it. */
function fakeRunner(id: string, p: ReturnType<typeof persona>, model: string, alive = true) {
  const writes: string[] = []
  return { runner: { id, persona: p, model, alive, write: (s: string) => writes.push(s) }, writes }
}

// ---------------------------------------------------------------------------
// laneFor
// ---------------------------------------------------------------------------

test('laneFor: an explicit lane wins even when labels would point elsewhere', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  const task = { lane: 'architect', labels: 'build,fix' } as any
  assert.equal(dispatch.laneFor(task).id, 'architect')
})

test('laneFor: an unknown lane falls through to the best label overlap', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  // 'no-such-lane' does not exist -> persona() throws -> falls back to labels.
  // 'review,test' scores 2 against the reviewer and only 1 against the builder.
  const task = { lane: 'no-such-lane', labels: 'review,test' } as any
  assert.equal(dispatch.laneFor(task).id, 'reviewer')
})

test('laneFor: no lane and no matching label falls back to builder', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  const task = { lane: '', labels: 'random,none' } as any
  assert.equal(dispatch.laneFor(task).id, 'builder')
})

// ---------------------------------------------------------------------------
// tierFor
// ---------------------------------------------------------------------------

test('tierFor: a per-task tier beats the persona default', async () => {
  const dispatch = await freshDispatch()
  const task = { model: 'opus' } as any
  const p = { model: 'sonnet' } as any
  assert.equal(dispatch.tierFor(task, p), 'opus')
})

test('tierFor: empty when neither the task nor the persona set a tier', async () => {
  const dispatch = await freshDispatch()
  const task = { model: '' } as any
  const p = { model: undefined } as any
  assert.equal(dispatch.tierFor(task, p), '')
})

// ---------------------------------------------------------------------------
// The 'starting' interlock (failure mode #1's guard rail)
// ---------------------------------------------------------------------------

test('an agent still starting is never handed work, even if it is alive and in the fleet', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  store.joinAgent('builder', 'builder', 111, 'starting')

  const { runner, writes } = fakeRunner('builder', persona('builder'), 'sonnet')
  const fleet = { runners: () => [runner], spawn: () => null }

  const taskId = store.addTask('do the thing', '', 'build')
  dispatch.dispatchTick(fleet)

  assert.equal(writes.length, 0, 'a starting agent must never be written to')
  assert.equal(store.getTask(taskId)!.status, 'open', 'nothing was free to take it')
})

test('an idle agent still holding an unfinished task is not free either', async () => {
  resetDb()
  const dispatch = await freshDispatch()

  const heldId = store.addTask('still in flight', '', 'build')
  store.joinAgent('builder', 'builder', 111, 'idle')
  store.setAgentStatus('builder', 'idle', heldId) // idle, but the held task isn't done

  const { runner, writes } = fakeRunner('builder', persona('builder'), 'sonnet')
  const fleet = { runners: () => [runner], spawn: () => null }

  const newTaskId = store.addTask('new work', '', 'build')
  dispatch.dispatchTick(fleet)

  assert.equal(writes.length, 0, 'still holding unfinished work, so not free')
  assert.equal(store.getTask(newTaskId)!.status, 'open')
})

test('an idle agent whose held task is done is free again', async () => {
  resetDb()
  const dispatch = await freshDispatch()

  const doneId = store.addTask('already finished', '', 'build')
  store.updateTask(doneId, { status: 'done' })
  store.joinAgent('builder', 'builder', 111, 'idle')
  store.setAgentStatus('builder', 'idle', doneId)

  const { runner, writes } = fakeRunner('builder', persona('builder'), 'sonnet')
  const fleet = { runners: () => [runner], spawn: () => null }

  const newTaskId = store.addTask('new work', '', 'build')
  dispatch.dispatchTick(fleet)

  assert.ok(writes.length > 0, 'a held-but-done task should not block eligibility')
  assert.equal(store.getTask(newTaskId)!.status, 'claimed')
})

// ---------------------------------------------------------------------------
// Spawn grace period (failure mode #3)
// ---------------------------------------------------------------------------

test('spawn grace period: an immediately-following tick does not spawn again for the same task', async () => {
  resetDb()
  const dispatch = await freshDispatch()

  let spawnCalls = 0
  const fleet = {
    runners: () => [], // nobody free at all, ever, in this test
    spawn: (p: ReturnType<typeof persona>, model: string) => {
      spawnCalls++
      return { id: 'builder-2', persona: p, model, alive: true, write: () => {} }
    },
  }

  const taskId = store.addTask('needs an agent', '', 'build')

  dispatch.dispatchTick(fleet)
  assert.equal(spawnCalls, 1, 'first tick spawns')
  assert.equal(store.getTask(taskId)!.status, 'open', 'left open for the next tick, not handed off now')

  dispatch.dispatchTick(fleet)
  assert.equal(spawnCalls, 1, 'the very next tick must not spawn a second agent for the same task')
})

// ---------------------------------------------------------------------------
// The handoff itself, including the separate submit-newline write
// (failure mode #1's cousin)
// ---------------------------------------------------------------------------

test('dispatching a task claims it, sets the agent working, and submits with a separate newline write', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  store.joinAgent('builder', 'builder', 111, 'idle')

  const { runner, writes } = fakeRunner('builder', persona('builder'), 'sonnet')
  const fleet = { runners: () => [runner], spawn: () => null }

  const taskId = store.addTask('ship the feature', 'some detail', 'build')

  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    dispatch.dispatchTick(fleet)

    const task = store.getTask(taskId)!
    assert.equal(task.status, 'claimed')
    assert.equal(task.owner, 'builder')

    const agent = store.agents().find((a) => a.id === 'builder')!
    assert.equal(agent.status, 'working')
    assert.equal(agent.task_id, taskId)

    // Before the submit timer fires: the clear-line and the brief have been
    // written, but nothing has submitted it yet.
    assert.equal(writes.length, 2, 'clear-line + brief only, before the timer fires')
    assert.equal(writes[0], '\x15')
    assert.match(writes[1], new RegExp(`Task #${taskId}`))
    assert.ok(
      !writes[1].includes('\r'),
      'the brief text itself must never carry the submit newline — that reads as a paste',
    )

    mock.timers.tick(250)
    assert.equal(writes.length, 3, 'the newline arrives as its own, later write')
    assert.equal(writes[2], '\r')
  } finally {
    mock.timers.reset()
  }
})

// ---------------------------------------------------------------------------
// reclaimStale (failure mode #2)
// ---------------------------------------------------------------------------

test('reclaimStale returns a claimed task to the board when its owner is no longer live', async () => {
  resetDb()
  const dispatch = await freshDispatch()

  const taskId = store.addTask('orphaned work', '', 'build')
  store.claimTask(taskId, 'ghost-agent') // never joined -> not in agents()

  dispatch.dispatchTick({ runners: () => [], spawn: () => null })

  const task = store.getTask(taskId)!
  assert.equal(task.status, 'open')
  assert.equal(task.owner, null)
})

test('reclaimStale leaves a claimed task alone when its owner is live and recently updated', async () => {
  resetDb()
  const dispatch = await freshDispatch()

  store.joinAgent('builder', 'builder', 111, 'working')
  const taskId = store.addTask('still being worked', '', 'build')
  store.claimTask(taskId, 'builder')

  dispatch.dispatchTick({ runners: () => [], spawn: () => null })

  const task = store.getTask(taskId)!
  assert.equal(task.status, 'claimed')
  assert.equal(task.owner, 'builder')
})

test('reclaimStale reclaims a claimed task whose live owner has gone silent past the stale window', async () => {
  resetDb()
  const dispatch = await freshDispatch()

  store.joinAgent('builder', 'builder', 111, 'working')
  const taskId = store.addTask('stuck', '', 'build')
  store.claimTask(taskId, 'builder')

  // Backdate updated_at instead of sleeping 15+ minutes — STALE_CLAIM_MS is
  // internal to dispatch.ts, so we manipulate the recorded timestamp instead.
  const ancient = Date.now() - 16 * 60_000
  store.db().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ancient, taskId)

  dispatch.dispatchTick({ runners: () => [], spawn: () => null })

  const task = store.getTask(taskId)!
  assert.equal(task.status, 'open')
  assert.equal(task.owner, null)
})

// ---------------------------------------------------------------------------
// Claim race (failure mode #6)
// ---------------------------------------------------------------------------

test('claimTask: exactly one of two racing claims wins', async () => {
  resetDb()
  const taskId = store.addTask('contested', '', '')

  const first = store.claimTask(taskId, 'agent-a')
  const second = store.claimTask(taskId, 'agent-b')

  assert.equal(first, true)
  assert.equal(second, false)
  assert.equal(store.getTask(taskId)!.owner, 'agent-a')
})

// ---------------------------------------------------------------------------
// Escalation and its cap, including the unrecognised-tier case (failure mode #4)
// ---------------------------------------------------------------------------

test('blockTask escalates haiku -> sonnet -> opus and parks past the top tier, excluded from ready()', async () => {
  resetDb()
  const taskId = store.addTask('too hard for haiku', '', 'build', null, [], 'haiku')

  assert.equal(store.blockTask(taskId, 'nope')?.model, 'sonnet')
  assert.equal(store.blockTask(taskId, 'nope again')?.model, 'opus')

  let result: { attempts: number; model: string; parked: boolean } | null = null
  for (let i = 0; i < 10 && !result?.parked; i++) result = store.blockTask(taskId, `n${i}`)

  assert.equal(result?.parked, true)
  assert.equal(store.getTask(taskId)!.status, 'blocked')
  assert.deepEqual(store.ready().map((t) => t.id), [], 'a parked task is never dispatchable')
})

test('blockTask on an unrecognised model tier: escalation is a silent no-op, but the cap still fires', async () => {
  resetDb()
  // 'super-model' is not one of TIERS, so TIERS.indexOf returns -1 and the
  // escalation branch in blockTask never runs. This documents the real,
  // current behaviour of failure mode #4: no error, no escalation, and the
  // task burns all MAX_ATTEMPTS at the exact same (unrecognised) tier before
  // parking, looking exactly like an escalating task from the outside.
  const taskId = store.addTask('weird tier', '', 'build', null, [], 'super-model')

  let result: { attempts: number; model: string; parked: boolean } | null = null
  for (let i = 0; i < 10 && !result?.parked; i++) result = store.blockTask(taskId, `n${i}`)

  assert.equal(result?.model, 'super-model', 'the tier never changed across any attempt')
  assert.equal(result?.parked, true)
  assert.equal(result?.attempts, store.MAX_ATTEMPTS)
  assert.equal(store.getTask(taskId)!.model, 'super-model')
})

// ---------------------------------------------------------------------------
// The no-explicit-tier escalation fix (the real, separate bug: TIERS.indexOf('')
// is -1, so an untiered task — addTask's default, and what parley_task_add
// produces whenever the caller omits `model` — used to stay stuck at '' and
// never escalate, unlike the explicit-'haiku' case above which always worked).
// ---------------------------------------------------------------------------

test('blockTask: an untiered task escalates once the caller resolves the effective tier (dispatch.ts tierFor/laneFor)', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  // No explicit model, but the 'research' label routes it to the scout lane
  // (see personas.ts), whose persona default is 'haiku' — the same starting
  // tier as the explicit-'haiku' test above, just resolved from the lane
  // instead of stamped onto the task.
  const taskId = store.addTask('too hard, and nobody set a tier', '', 'research')
  const task = store.getTask(taskId)!
  const p = dispatch.laneFor(task)
  assert.equal(p.id, 'scout', 'sanity check: this task should route to scout by its label')
  assert.equal(task.model, '', 'sanity check: no explicit tier was set')

  const first = store.blockTask(taskId, 'nope', dispatch.tierFor(task, p))
  assert.equal(first?.model, 'sonnet', 'escalates off the effective (lane-default) tier instead of staying stuck at empty')

  const second = store.blockTask(taskId, 'nope again', dispatch.tierFor(store.getTask(taskId)!, p))
  assert.equal(second?.model, 'opus')
})

test('blockTask: with no effectiveTier argument at all, the old (pre-fix) empty-tier behaviour is unchanged — backward compatible', async () => {
  resetDb()
  const taskId = store.addTask('no tier, and no caller resolves one')
  const result = store.blockTask(taskId, 'nope') // exactly how every caller invoked this before the fix
  assert.equal(result?.model, '', 'a caller that passes no tier sees no behaviour change')
})

test('reclaimStale (dispatch.ts) escalates an untiered stale task too, via the effective tier it now passes to blockTask', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  store.joinAgent('scout', 'scout', 111, 'working')
  const taskId = store.addTask('stuck, no explicit tier', '', 'research') // routes to scout, default 'haiku'
  store.claimTask(taskId, 'scout')
  const ancient = Date.now() - 16 * 60_000
  store.db().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ancient, taskId)

  dispatch.dispatchTick({ runners: () => [], spawn: () => null })

  const task = store.getTask(taskId)!
  assert.equal(task.status, 'open')
  assert.equal(task.model, 'sonnet', 'reclaimed with no explicit tier still escalates off the scout lane default')
})

// ---------------------------------------------------------------------------
// Dependency edge cases, exercised through dispatchTick itself
// ---------------------------------------------------------------------------

test('dispatchTick dispatches a task whose dependency id is dangling (not on the board)', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  store.joinAgent('builder', 'builder', 111, 'idle')

  const { runner } = fakeRunner('builder', persona('builder'), 'sonnet')
  const fleet = { runners: () => [runner], spawn: () => null }

  const taskId = store.addTask('depends on a ghost', '', 'build', null, [99999])
  dispatch.dispatchTick(fleet)

  assert.equal(store.getTask(taskId)!.status, 'claimed', 'a dangling dep counts as satisfied, so it runs')
})

test('dispatchTick never dispatches either half of a real dependency cycle', async () => {
  resetDb()
  const dispatch = await freshDispatch()
  store.joinAgent('builder', 'builder', 111, 'idle')

  const { runner, writes } = fakeRunner('builder', persona('builder'), 'sonnet')
  const fleet = { runners: () => [runner], spawn: () => null }

  const a = store.addTask('first half of the loop', '', 'build', null, [2])
  const b = store.addTask('second half of the loop', '', 'build', null, [1])

  dispatch.dispatchTick(fleet)

  assert.equal(store.getTask(a)!.status, 'open')
  assert.equal(store.getTask(b)!.status, 'open')
  assert.equal(writes.length, 0, 'a cycle must never produce a handoff')
})

// ---------------------------------------------------------------------------
// dropAgent releases held work (failure mode #2's other half)
// ---------------------------------------------------------------------------

test('dropAgent releases held work, drops file claims, and clears route_to pointing at it', async () => {
  resetDb()
  store.joinAgent('builder', 'builder', 111, 'idle')

  const heldId = store.addTask('being worked', '', 'build')
  store.claimTask(heldId, 'builder')
  store.setAgentStatus('builder', 'working', heldId)

  store.addClaim('builder', 'src/foo.ts', 'claim')

  const routedId = store.addTask('routed to builder', '', 'build')
  store.setRoute(routedId, 'builder')

  store.dropAgent('builder')

  const held = store.getTask(heldId)!
  assert.equal(held.status, 'open')
  assert.equal(held.owner, null)

  assert.deepEqual(store.claims().filter((c) => c.agent === 'builder'), [])

  const routed = store.getTask(routedId)!
  assert.equal(routed.route_to, '')

  assert.equal(store.agents().find((a) => a.id === 'builder'), undefined, 'the agent row itself is gone')
})
