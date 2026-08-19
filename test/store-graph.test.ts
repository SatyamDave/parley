// Scheduler integrity: the three ways the board used to strand work silently —
// a dependency edge that can never be satisfied, a retry loop with no floor,
// and a pid wiped on rejoin.
//
// Every test gets its own PARLEY_DIR and its own copy of the module. store.ts
// caches one DatabaseSync handle at module scope, so a shared import would keep
// talking to the first test's database; the ?fresh= query gives each test an
// unrelated module instance pointed at an unrelated temp directory, and no real
// board is ever opened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let counter = 0
async function freshStore() {
  process.env.PARLEY_DIR = mkdtempSync(join(tmpdir(), 'parley-test-'))
  return await import(`../src/store.ts?fresh=${counter++}`)
}

const bodies = (store: { feed: (n?: number) => { body: string }[] }) =>
  store.feed(200).map((f) => f.body).join('\n')

test('a dep on an id that is not on the board does not strand the task', async () => {
  const store = await freshStore()

  const plain = store.addTask('no deps at all')
  const orphan = store.addTask('deps on a ghost', '', '', null, [9999])

  const readyIds = store.ready().map((t) => t.id)
  assert.deepEqual(readyIds.sort(), [plain, orphan].sort(), 'both tasks should be dispatchable')
  assert.deepEqual(store.waiting(), [], 'nothing is genuinely waiting')

  const problems = store.dependencyProblems()
  assert.deepEqual(problems.dangling, [{ id: orphan, missing: [9999] }])

  assert.match(bodies(store), /#9999/, 'the rewritten edge is announced, not silent')
})

test('the dangling-dep announcement is posted once, not every tick', async () => {
  const store = await freshStore()
  store.addTask('deps on a ghost', '', '', null, [9999])

  for (let i = 0; i < 5; i++) store.ready()

  const hits = store.feed(200).filter((f) => f.body.includes('#9999'))
  assert.equal(hits.length, 1, `expected one notice, got ${hits.length}`)
})

test('a two-task cycle stays put and is surfaced rather than vanishing', async () => {
  const store = await freshStore()

  // #1 waits on #2 and #2 waits on #1. #1 names an id that does not exist yet
  // at insert time; once #2 lands the edge is real and the loop is closed.
  const first = store.addTask('first half of the loop', '', '', null, [2])
  const second = store.addTask('second half of the loop', '', '', null, [1])
  assert.deepEqual([first, second], [1, 2], 'test assumes a fresh autoincrement')

  assert.deepEqual(store.ready(), [], 'a real cycle must not be auto-satisfied')
  assert.deepEqual(
    store.waiting().map((t) => t.id),
    [first, second],
    'the tasks are still on the board, visibly waiting',
  )

  const { cycles, dangling } = store.dependencyProblems()
  assert.deepEqual(dangling, [], 'both ids exist, so neither edge is dangling')
  assert.equal(cycles.length, 1, 'one loop, reported once however it is entered')
  assert.deepEqual([...cycles[0]].sort(), [first, second])

  assert.match(bodies(store), /dependency cycle/, 'a human can see why nothing is running')
})

test('a cycle whose members are all done is history, not a stall', async () => {
  const store = await freshStore()
  store.addTask('a', '', '', null, [2])
  store.addTask('b', '', '', null, [1])
  store.updateTask(1, { status: 'done' })
  store.updateTask(2, { status: 'done' })

  assert.deepEqual(store.dependencyProblems().cycles, [])
})

test('blockTask escalates haiku -> sonnet -> opus, then parks instead of looping', async () => {
  const store = await freshStore()
  const id = store.addTask('the impossible one', 'original detail', '', null, [], 'haiku')

  assert.deepEqual(store.blockTask(id, 'note one'), { attempts: 1, model: 'sonnet', parked: false })
  assert.deepEqual(store.blockTask(id, 'note two'), { attempts: 2, model: 'opus', parked: false })

  let result: { attempts: number; model: string; parked: boolean } | null = null
  for (let i = 0; i < 20 && !result?.parked; i++) {
    result = store.blockTask(id, `note at the top tier ${i}`)
    assert.equal(result?.model, 'opus', 'nothing escalates past the top tier')
  }
  assert.equal(result?.parked, true, 'a task at the top tier must eventually stop being re-dispatched')
  assert.ok(result!.attempts <= store.MAX_ATTEMPTS, 'parking happens at the cap, not long after it')

  const parked = store.getTask(id)!
  assert.equal(parked.status, 'blocked', 'parked tasks render under BLOCKED, not OPEN')
  assert.deepEqual(store.ready(), [], 'the dispatcher never sees a parked task')
  assert.equal(parked.owner, null)

  // Every attempt's reason travels with the task — that is what a human reads.
  assert.match(parked.detail, /original detail/)
  assert.match(parked.detail, /note one/)
  assert.match(parked.detail, /note two/)
  assert.match(parked.detail, /note at the top tier 0/)

  assert.match(bodies(store), /parked after/, 'parking is announced')
})

test('an untiered task also parks rather than retrying forever', async () => {
  const store = await freshStore()
  const id = store.addTask('no tier set')

  let result: { parked: boolean } | null = null
  for (let i = 0; i < 20 && !result?.parked; i++) result = store.blockTask(id, `n${i}`)

  assert.equal(result?.parked, true)
  assert.equal(store.getTask(id)!.status, 'blocked')
})

test('rejoining with a null pid keeps the pid that was recorded', async () => {
  const store = await freshStore()

  store.joinAgent('builder', 'builder', 4242, 'starting')
  // This is the SessionStart hook: it knows the agent id but not the pty's pid.
  store.joinAgent('builder', 'builder', null, 'idle')

  const agent = store.agents().find((a) => a.id === 'builder')!
  assert.equal(agent.pid, 4242, 'liveness detection needs the pid to survive the boot hook')
  assert.equal(agent.status, 'idle', 'the status the hook set still applies')
})

test('rejoining with a real pid still replaces the old one', async () => {
  const store = await freshStore()

  store.joinAgent('builder', 'builder', 4242, 'starting')
  store.joinAgent('builder', 'builder', 5555, 'starting')

  assert.equal(store.agents().find((a) => a.id === 'builder')!.pid, 5555)
})
