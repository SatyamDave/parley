// planner.ts turns a goal into tasks (plan()/proposeAgents(), both model calls
// we never invoke here) and then two pure, load-bearing pieces of bookkeeping:
//
// - commitPlan() maps the planning model's POSITIONAL dependency indices
//   (0-based, into the array it returned) onto the real autoincrement ids the
//   board assigns as tasks are inserted one at a time. Get the index math
//   wrong and you get a silently corrupt dependency graph.
// - rosterFor() maps an approved proposal's agent entries (existing persona id
//   or an invented custom persona id) onto real Persona objects.
//
// Same isolation problem as dispatch.test.ts: store.ts caches its DatabaseSync
// handle at module scope, and planner.ts's own `import ... from './store.ts'`
// always resolves to that one plain, no-query module instance — a `?fresh=N`
// on planner.ts's specifier would not propagate to its internal import. So we
// set PARLEY_DIR once, import store.ts plainly (the same instance planner.ts
// is guaranteed to share), and wipe every table before each test rather than
// re-importing for a fresh module.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'parley-planner-test-'))
process.env.PARLEY_DIR = dir
after(() => rmSync(dir, { recursive: true, force: true }))

const store = await import('../src/store.ts')
const { commitPlan, rosterFor } = await import('../src/planner.ts')
import type { Planned, ProposedAgent, Proposal } from '../src/planner.ts'

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

/** A minimally-filled Planned entry — tests override only what they care about. */
function planned(overrides: Partial<Planned> = {}): Planned {
  return {
    title: 'do a thing',
    detail: 'do the thing and verify it',
    labels: 'build',
    owner: 'builder',
    deps: [],
    model: 'sonnet',
    ...overrides,
  }
}

/** A minimally-filled ProposedAgent entry. */
function agent(overrides: Partial<ProposedAgent> = {}): ProposedAgent {
  return {
    kind: 'existing',
    personaId: '',
    customId: '',
    customTitle: '',
    customDescription: '',
    customPrompt: '',
    customLabels: '',
    customModel: '',
    count: 1,
    why: '',
    ...overrides,
  }
}

function proposal(agents: ProposedAgent[]): Proposal {
  return { agents, note: '', answer: '' }
}

const bodies = () => store.feed(200).map((f) => f.body).join('\n')

// ---------------------------------------------------------------------------
// commitPlan: positional index -> real id mapping
// ---------------------------------------------------------------------------

test('commitPlan maps a positional dep index to the real id assigned at that position', () => {
  resetDb()
  const plan: Planned[] = [
    planned({ title: 'task 0', deps: [] }),
    planned({ title: 'task 1', deps: [0] }),
    planned({ title: 'task 2', deps: [0, 1] }),
  ]
  const ids = commitPlan('build the thing', plan)
  assert.equal(ids.length, 3)

  const t0 = store.getTask(ids[0])!
  const t1 = store.getTask(ids[1])!
  const t2 = store.getTask(ids[2])!

  assert.equal(t0.deps, '', 'task 0 declared no deps')
  assert.equal(t1.deps, String(ids[0]), 'task 1 deps:[0] must resolve to the real id of task 0')
  assert.equal(
    t2.deps,
    `${ids[0]},${ids[1]}`,
    'task 2 deps:[0,1] must resolve, in order, to the real ids of tasks 0 and 1',
  )
})

test('commitPlan: ids are assigned in array order, so later entries can depend on any earlier one', () => {
  resetDb()
  const plan: Planned[] = [
    planned({ title: 'a', deps: [] }),
    planned({ title: 'b', deps: [] }),
    planned({ title: 'c', deps: [1] }), // depends on b, not a
    planned({ title: 'd', deps: [0, 2] }), // depends on a and c
  ]
  const ids = commitPlan('goal', plan)
  assert.equal(store.getTask(ids[2])!.deps, String(ids[1]), 'c depends on the real id of b')
  assert.equal(
    store.getTask(ids[3])!.deps,
    `${ids[0]},${ids[2]}`,
    'd depends on the real ids of a and c, in the order given',
  )
})

test('commitPlan: a dep index pointing at a LATER task (forbidden by the contract) is dropped, and the drop is announced', () => {
  // At the point task 0 is inserted, `ids` only contains ids pushed so far —
  // none yet, since task 0 is first — so `ids[1]` is undefined and gets
  // filtered out by the `typeof id === 'number'` guard in commitPlan. The
  // edge is lost entirely rather than turned into a wrong-but-present edge
  // (it does NOT become a dependency on task 1's real id, nor on task 0
  // itself, nor does it throw). That data loss on the graph must be visible,
  // though — a planner that (against the contract) emitted a forward
  // reference gets no edge, but the feed must say so, the same way store.ts
  // announces a dangling dep or a cycle in `ready()`.
  resetDb()
  const plan: Planned[] = [
    planned({ title: 'points forward', deps: [1] }), // task 1 doesn't exist yet
    planned({ title: 'the target', deps: [] }),
  ]
  const ids = commitPlan('goal', plan)
  assert.equal(store.getTask(ids[0])!.deps, '', 'the forward reference is dropped — no edge at all')
  assert.deepEqual(store.dependencyProblems().dangling, [], 'not reported as dangling, since it was dropped before insertion')
  assert.match(
    bodies(),
    new RegExp(`#${ids[0]}.*dependency index 1.*not a valid earlier entry`),
    'the dropped forward reference must be visible in the feed, not silent',
  )
})

test('commitPlan: a self-referencing dep index is dropped, and the drop is announced', () => {
  resetDb()
  const plan: Planned[] = [planned({ title: 'points at itself', deps: [0] })]
  const ids = commitPlan('goal', plan)
  assert.equal(store.getTask(ids[0])!.deps, '', 'index 0 is not yet in `ids` when task 0 itself is being inserted')
  assert.match(
    bodies(),
    new RegExp(`#${ids[0]}.*dependency index 0.*not a valid earlier entry`),
    'the dropped self-reference must be visible in the feed',
  )
})

test('commitPlan: an out-of-range dep index is dropped, and the drop is announced', () => {
  resetDb()
  const plan: Planned[] = [planned({ title: 'solo', deps: [5] })]
  const ids = commitPlan('goal', plan)
  assert.equal(store.getTask(ids[0])!.deps, '')
  assert.match(
    bodies(),
    new RegExp(`#${ids[0]}.*dependency index 5.*not a valid earlier entry`),
    'the dropped out-of-range index must be visible in the feed',
  )
})

test('commitPlan: a task with one valid dep and one bad index keeps the valid dep and only announces the bad one', () => {
  // The contract violation must not take the good half of the plan down with
  // it: a task that legitimately depends on an earlier one, but also carries
  // one garbage index, still gets created with the real dependency intact.
  resetDb()
  const plan: Planned[] = [
    planned({ title: 'a' }),
    planned({ title: 'b', deps: [0, 4] }), // 0 is real, 4 is out of range
  ]
  const ids = commitPlan('goal', plan)
  assert.equal(store.getTask(ids[1])!.deps, String(ids[0]), 'the valid dependency on task a survives')
  assert.match(
    bodies(),
    new RegExp(`#${ids[1]}.*dependency index 4.*not a valid earlier entry`),
    'the bad index is still announced even though the task itself is otherwise fine',
  )
})

test('commitPlan: empty deps produces no edges', () => {
  resetDb()
  const ids = commitPlan('goal', [planned({ deps: [] })])
  assert.equal(store.getTask(ids[0])!.deps, '')
})

test('commitPlan: a plan with no tasks commits nothing and returns an empty array', () => {
  resetDb()
  const ids = commitPlan('an empty goal', [])
  assert.deepEqual(ids, [])
  assert.deepEqual(store.tasks(), [])
})

test('commitPlan posts a summary of the goal and task count to the feed, even for an empty plan', () => {
  resetDb()
  commitPlan('ship the widget', [planned({ title: 'a' }), planned({ title: 'b' })])
  assert.match(bodies(), /goal: ship the widget → 2 task\(s\) on the board/)

  resetDb()
  commitPlan('a goal nothing came of', [])
  assert.match(bodies(), /goal: a goal nothing came of → 0 task\(s\) on the board/)
})

test('commitPlan: owner and model default sensibly when the planning model left them empty', () => {
  resetDb()
  const ids = commitPlan('goal', [planned({ owner: '', model: '' })])
  const t = store.getTask(ids[0])!
  assert.equal(t.lane, '', '"" owner becomes null lane, stored back out as ""')
  assert.equal(t.model, '')
})

// ---------------------------------------------------------------------------
// rosterFor
// ---------------------------------------------------------------------------

test('rosterFor resolves an existing persona by its library id', () => {
  resetDb()
  const roster = rosterFor(proposal([agent({ kind: 'existing', personaId: 'builder' })]))
  assert.deepEqual(roster.map((p) => p.id), ['builder'])
})

test('rosterFor resolves a custom persona once it has been added to the store', () => {
  resetDb()
  store.addCustomPersona({
    id: 'custom-tester',
    title: 'Custom Tester',
    color: 'white',
    labels: 'test',
    model: 'sonnet',
    prompt: 'you test things',
  })
  const roster = rosterFor(proposal([agent({ kind: 'custom', customId: 'custom-tester' })]))
  assert.deepEqual(roster.map((p) => p.id), ['custom-tester'])
})

test('rosterFor drops entries referencing a persona id that does not exist anywhere', () => {
  resetDb()
  const roster = rosterFor(
    proposal([
      agent({ kind: 'existing', personaId: 'builder' }),
      agent({ kind: 'existing', personaId: 'no-such-persona' }),
      agent({ kind: 'custom', customId: 'never-added' }),
    ]),
  )
  assert.deepEqual(roster.map((p) => p.id), ['builder'], 'only the resolvable entry survives')
})

test('rosterFor returns an empty roster for an empty proposal', () => {
  resetDb()
  assert.deepEqual(rosterFor(proposal([])), [])
})

test('rosterFor does not duplicate a persona referenced by two agent entries', () => {
  resetDb()
  const roster = rosterFor(
    proposal([agent({ kind: 'existing', personaId: 'builder' }), agent({ kind: 'existing', personaId: 'builder', count: 2 })]),
  )
  // .filter(ids.includes(p.id)) checks the PERSONA list, not the agent entries,
  // so a persona referenced twice still appears once in the roster.
  assert.deepEqual(roster.map((p) => p.id), ['builder'])
})
