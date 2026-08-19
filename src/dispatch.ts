// The scheduler. Tasks do not get assigned — they become *eligible* when their
// dependencies finish, and this loop hands eligible work to whoever is free in
// the right lane, spawning a right-sized agent if nobody is.
//
// That is the whole difference between a multiplexer and an orchestrator: with
// this running, `parley goal "..."` produces work that starts itself, in
// parallel, without anyone typing into a pane.
//
// Ptys live in the TUI, so this file never touches one directly. It asks for a
// Runner and writes a line to it. That keeps the scheduling decision separable
// from the terminal plumbing — and testable without spawning anything.
import { allPersonas, persona } from './personas.ts'
import type { Persona } from './personas.ts'
import { agents, blockTask, claimTask, getTask, post, ready, setAgentStatus, tasks } from './store.ts'
import type { Task } from './store.ts'

/** How long to wait before sending the newline that submits an injected task. */
const SUBMIT_DELAY_MS = 250

/** How long a spawn gets to become idle before the dispatcher will try again for the same task. */
const SPAWN_RETRY_MS = 60_000

/** How long a task may sit 'claimed' with no update before the dispatcher treats it as stuck. */
const STALE_CLAIM_MS = 15 * 60_000

/** task id -> when a spawn was fired for it, so a slow-booting agent doesn't get a second one every tick. */
const spawnedFor = new Map<number, number>()

/** Whether the "no room to spawn" note has already been posted for the current capacity crunch. */
let capacityNoted = false

export type Runner = {
  id: string
  persona: Persona
  model: string
  alive: boolean
  /** Type into this agent's terminal, as if the human had. */
  write(input: string): void
}

export type Fleet = {
  runners(): Runner[]
  /** Start a new agent, or return null if that would exceed the cap. */
  spawn(p: Persona, model: string): Runner | null
}

/** Which persona should own this task: explicit lane, else best label overlap. */
export function laneFor(task: Task): Persona {
  if (task.lane) {
    try {
      return persona(task.lane)
    } catch {
      /* planner named a lane that no longer exists — fall through to labels */
    }
  }
  const labels = task.labels.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  let best: Persona | null = null
  let bestScore = 0
  for (const p of allPersonas()) {
    const score = p.labels.filter((l) => labels.includes(l)).length
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  return best ?? persona('builder')
}

export function tierFor(task: Task, p: Persona): string {
  return task.model || p.model || ''
}

/**
 * An agent is takeable only if Claude Code has actually booted (status leaves
 * 'starting' in the SessionStart hook) and it is not still sitting on a task.
 * Writing into a terminal that is mid-turn is how you corrupt someone's prompt,
 * so this check is the safety interlock for the whole mechanism.
 */
function freeRunnerIds(): Set<string> {
  const free = new Set<string>()
  for (const a of agents()) {
    if (a.status !== 'idle') continue
    if (a.task_id) {
      const held = getTask(a.task_id)
      if (held && held.status !== 'done') continue
    }
    free.add(a.id)
  }
  return free
}

/** One line, because Claude Code submits its input at the first newline. */
function brief(task: Task): string {
  const detail = task.detail.replace(/\s+/g, ' ').trim()
  const retry =
    task.attempts > 0
      ? ` This is attempt ${task.attempts + 1} — a previous agent reported it blocked, so read that note in the detail before starting.`
      : ''
  return (
    `[parley] Task #${task.id} is yours: ${task.title}.` +
    (detail ? ` Detail: ${detail}` : '') +
    retry +
    ` Claim the paths you are about to edit with parley_claim before editing them.` +
    ` When it works, close it with parley_update(task_id: ${task.id}, status: "done", verified_how: the command you ran and what it printed).` +
    ` If you get genuinely stuck, parley_post(kind: "blocked", task_id: ${task.id}) saying what stopped you, and it goes back on the board for a stronger model.`
  )
}

/**
 * A task left 'claimed' whose owner is gone, or whose owner has been sitting on
 * it far longer than any real turn takes, blocks every task downstream of it
 * forever — nothing else ever moves it. Hand it back to the board so the next
 * tick's ready() can see it again.
 */
function reclaimStale(): void {
  const liveIds = new Set(agents().map((a) => a.id))
  const now = Date.now()
  for (const task of tasks('claimed')) {
    if (!task.owner) continue
    const vanished = !liveIds.has(task.owner)
    const stuck = now - task.updated_at > STALE_CLAIM_MS
    if (!vanished && !stuck) continue
    const reason = vanished
      ? `${task.owner} is no longer online`
      : `${task.owner} has not updated it in over ${Math.round(STALE_CLAIM_MS / 60_000)} minutes`
    // Pass the effective tier (task.model, falling back to the lane
    // persona's default) so a reclaimed task with no explicit tier actually
    // escalates instead of stalling at '' — see blockTask's own comment.
    blockTask(task.id, `${reason} — reclaimed by dispatcher`, tierFor(task, laneFor(task)))
    post('parley', 'note', `#${task.id} returned to the board — ${reason}`, task.id)
  }
}

/**
 * Run one scheduling pass. Notes anything worth a human's attention — a spawn,
 * a reclaim, a capacity crunch — to the feed directly, since nothing else
 * reads this function's return value.
 */
export function dispatchTick(fleet: Fleet): void {
  reclaimStale()

  const eligible = ready()
  if (!eligible.length) return

  const free = freeRunnerIds()
  const live = fleet.runners().filter((r) => r.alive)
  const takenThisTick = new Set<string>()
  let hitCapacity = false

  for (const task of eligible) {
    const p = laneFor(task)
    const tier = tierFor(task, p)

    const available = live.filter((r) => free.has(r.id) && !takenThisTick.has(r.id))

    // A task routed by a link belongs to one agent. It waits for that agent
    // rather than spilling to the lane — otherwise drawing a wire would change
    // nothing the moment anyone else happened to be free.
    if (task.route_to) {
      const target = available.find((r) => r.id === task.route_to)
      if (!target) continue
      if (!claimTask(task.id, target.id)) continue
      handOff(target, task)
      takenThisTick.add(target.id)
      spawnedFor.delete(task.id)
      continue
    }

    // Prefer an agent already running at the right tier; fall back to any free
    // agent in the lane rather than leaving ready work sitting still.
    const runner =
      available.find((r) => r.persona.id === p.id && (!tier || r.model === tier)) ??
      available.find((r) => r.persona.id === p.id) ??
      null

    if (runner) {
      if (!claimTask(task.id, runner.id)) continue // someone else got there first
      handOff(runner, task)
      takenThisTick.add(runner.id)
      spawnedFor.delete(task.id)
      continue
    }

    // No free agent in the lane. A spawn already in flight for this exact task
    // gets a grace period to come up rather than a second (and third...) agent
    // every tick until paneCapacity is hit — SPAWN_RETRY_MS is how long we'll
    // wait before assuming that spawn is never coming and trying again.
    const spawnedAt = spawnedFor.get(task.id)
    if (spawnedAt !== undefined && Date.now() - spawnedAt < SPAWN_RETRY_MS) continue

    // Leave the task open rather than handing off now. A just-spawned agent's
    // DB status is still 'starting' until its own SessionStart hook fires;
    // writing the task into it before that races against joinAgent's restart
    // check, which would see the task_id this handoff just set, wrongly read
    // it as a previous incarnation that crashed mid-task, and bounce it
    // straight back to the board. Leaving it open lets the next tick's
    // freeRunnerIds() pick it up once the agent is genuinely idle, through the
    // same safe path as any other free agent.
    const spawned = fleet.spawn(p, tier)
    if (spawned) {
      spawnedFor.set(task.id, Date.now())
      post('parley', 'note', `spawned ${spawned.id} (${tier || 'default'}) — will pick up #${task.id} once it's up`, task.id)
    } else {
      hitCapacity = true
      if (!capacityNoted) {
        post('parley', 'note', `nothing free and no room to spawn — #${task.id} and possibly other ready work is waiting`)
        capacityNoted = true
      }
    }
  }

  if (!hitCapacity) capacityNoted = false
}

/** Put a claimed task into an agent's terminal. */
function handOff(runner: Runner, task: Task): void {
  setAgentStatus(runner.id, 'working', task.id)

  // Clear whatever is on the input line before typing, so a half-typed
  // character from an earlier session does not corrupt the instruction.
  runner.write('\x15')
  runner.write(brief(task))
  // The submit has to arrive as its own keystroke. A long string followed
  // immediately by \r lands as one chunk, which Claude Code reads as a paste
  // — and a newline inside a paste inserts a line break instead of sending.
  // The task text then sits in the input box forever, looking dispatched.
  setTimeout(() => runner.write('\r'), SUBMIT_DELAY_MS)

  post('parley', 'note', `dispatched #${task.id} ${task.title} → ${runner.id}`, task.id)
}
