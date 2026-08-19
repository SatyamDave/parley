// The board of record. Every parley process — the TUI, each agent's MCP
// server, every hook invocation — opens this same SQLite file. WAL mode plus a
// busy timeout is what makes that safe from many processes at once.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export type Agent = {
  id: string
  persona: string
  status: string
  task_id: number | null
  pid: number | null
  cursor: number
  started_at: number
  last_seen: number
}

export type Task = {
  id: number
  title: string
  detail: string
  status: string // open | claimed | blocked | review | done
  owner: string | null // the agent INSTANCE holding it, once claimed
  lane: string // the PERSONA it routes to — set at plan time, before anyone holds it
  deps: string // comma-separated task ids that must be done first. These are the edges.
  model: string // '' | haiku | sonnet | opus — the tier this task is worth
  attempts: number
  route_to: string // a specific agent this is reserved for, set by a link. '' = open to the lane.
  labels: string
  verified_by: string | null
  verified_how: string | null
  // The agent's claim (verified_by/verified_how, above) and the machine's own
  // finding are kept as separate columns on purpose — see parley_update in
  // mcp.ts, which is the only place that ever writes these. '' means no gate
  // has run against this task yet; 'passed' means src/checks.ts actually ran
  // real commands and every one exited 0; 'unverified' means the gate ran but
  // found no checks at all to run, which must never be confused with 'passed'
  // — that confusion is the exact self-attestation bug this exists to fix.
  verified_machine: string // '' | 'passed' | 'unverified'
  // The real report from checks.ts's summarize() for whichever run last
  // touched this task — which checks ran, their exit codes, and (on a
  // failure) their captured output. Empty until the gate has run once.
  checks_report: string
  created_at: number
  updated_at: number
}

export type Claim = {
  id: number
  agent: string
  path: string
  kind: string // claim | avoid
  note: string
  created_at: number
}

export type FeedItem = {
  id: number
  agent: string
  kind: string
  body: string
  task_id: number | null
  created_at: number
}

export type Wip = { agent: string; files: string; updated_at: number }

export type Proposal = {
  id: number
  goal: string
  agents_json: string
  note: string
  /** An answer to a question the human asked instead of revising the plan.
   *  Empty when the last reply was a revision (or there hasn't been one yet). */
  answer: string
  status: string // pending | approved | cancelled
  created_at: number
  updated_at: number
}

export type CustomPersona = {
  id: string
  title: string
  color: string
  labels: string
  model: string
  prompt: string
  created_at: number
}

/** Nearest ancestor containing .git, else the cwd itself. */
export function projectRoot(from: string = process.cwd()): string {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return resolve(from)
    dir = parent
  }
}

/** ~/.parley/<name>-<hash> — one board per project, stable across sessions. */
export function stateDir(root: string = projectRoot()): string {
  const dir =
    process.env.PARLEY_DIR ||
    join(
      homedir(),
      '.parley',
      `${basename(root).replace(/[^a-zA-Z0-9._-]/g, '-')}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`,
    )
  mkdirSync(join(dir, 'briefs'), { recursive: true })
  return dir
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  task_id INTEGER,
  pid INTEGER,
  cursor INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  owner TEXT,
  lane TEXT NOT NULL DEFAULT '',
  deps TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  route_to TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '',
  verified_by TEXT,
  verified_how TEXT,
  verified_machine TEXT NOT NULL DEFAULT '',
  checks_report TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS check_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  acquired_at INTEGER
);
CREATE TABLE IF NOT EXISTS links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst)
);
CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  arg TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claim','avoid')),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  briefed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wip (
  agent TEXT PRIMARY KEY,
  files TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS glossary (
  term TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  agents_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'white',
  labels TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`

/**
 * CREATE TABLE IF NOT EXISTS silently does nothing to a table that already
 * exists, so a board created before the DAG landed would keep its old columns
 * and every query touching them would throw. Add what is missing, in place.
 */
const ADDED_COLUMNS: [string, string, string][] = [
  ['tasks', 'lane', "TEXT NOT NULL DEFAULT ''"],
  ['tasks', 'deps', "TEXT NOT NULL DEFAULT ''"],
  ['tasks', 'model', "TEXT NOT NULL DEFAULT ''"],
  ['tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['tasks', 'route_to', "TEXT NOT NULL DEFAULT ''"],
  ['tasks', 'verified_machine', "TEXT NOT NULL DEFAULT ''"],
  ['tasks', 'checks_report', "TEXT NOT NULL DEFAULT ''"],
  ['proposals', 'answer', "TEXT NOT NULL DEFAULT ''"],
]

function migrate(handle: DatabaseSync): void {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const cols = handle.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
    if (cols.some((c) => c.name === column)) continue
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  }
}

let cached: DatabaseSync | null = null

export function db(): DatabaseSync {
  if (cached) return cached
  const handle = new DatabaseSync(join(stateDir(), 'parley.db'))
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA busy_timeout = 5000')
  handle.exec(SCHEMA)
  migrate(handle)
  cached = handle
  return handle
}

const now = () => Date.now()

// --- agents ---------------------------------------------------------------

/**
 * `status` matters more than it looks: the dispatcher only injects work into an
 * agent that is idle. A freshly spawned agent joins as 'starting' and its own
 * SessionStart hook flips it to 'idle' once Claude Code is actually up, which is
 * what stops us typing into a terminal that is not listening yet.
 */
/**
 * Whatever task `agentId` was holding goes back to the board, unclaimed —
 * used both when an agent leaves cleanly (`dropAgent`) and when one rejoins
 * after an unclean exit that skipped cleanup, still holding a task from
 * before (`joinAgent`). A task an agent was holding is not "assigned" once
 * that agent is gone in any sense of the word; leaving it `claimed` would
 * mean nobody dispatches it (it is not open) and nobody is working it.
 */
function releaseHeldTask(agentId: string, taskId: number, reason: string): void {
  const held = getTask(taskId)
  if (!held || held.status === 'done') return
  db()
    .prepare("UPDATE tasks SET status = 'open', owner = NULL, updated_at = ? WHERE id = ? AND owner = ?")
    .run(now(), taskId, agentId)
  post('parley', 'note', `#${taskId} returned to the board — ${agentId} ${reason}`, taskId)
}

export function joinAgent(id: string, persona: string, pid: number | null, status = 'idle'): void {
  // A joining agent is a fresh Claude Code session: it holds nothing and
  // remembers nothing. If the previous incarnation died mid-task, that task is
  // still marked claimed by this id and would sit there forever. Hand it back.
  const prior = db().prepare('SELECT task_id FROM agents WHERE id = ?').get(id) as
    | { task_id: number | null }
    | undefined
  if (prior?.task_id) {
    releaseHeldTask(id, prior.task_id, 'restarted while holding it')
    releaseClaims(id)
  }

  // COALESCE, not excluded.pid: the SessionStart hook rejoins with pid null
  // (a hook subprocess does not know the pty's pid), and overwriting would wipe
  // the pid the spawner recorded. reapDeadAgents reads a null pid as "process
  // gone" and drops the agent, so a plain assignment kills every agent the
  // moment its own Claude Code finishes booting.
  db()
    .prepare(
      `INSERT INTO agents (id, persona, status, task_id, pid, started_at, last_seen)
       VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET persona = excluded.persona, status = excluded.status,
                                     task_id = NULL, pid = COALESCE(excluded.pid, agents.pid),
                                     last_seen = excluded.last_seen`,
    )
    .run(id, persona, status, pid, now(), now())
}

/**
 * Drop agents whose process is gone. A session killed rather than quit leaves
 * its rows behind, and those ghosts make every future id drift upward
 * (builder-2, builder-3...) while showing up as online to peers and to `status`.
 */
export function reapDeadAgents(): number {
  let dropped = 0
  for (const a of agents()) {
    let alive = false
    if (a.pid) {
      try {
        process.kill(a.pid, 0) // signal 0 tests for existence without sending
        alive = true
      } catch {
        alive = false
      }
    }
    if (!alive) {
      dropAgent(a.id)
      dropped++
    }
  }
  if (dropped) pruneLinks()
  return dropped
}

/** A free instance id for this persona: builder, then builder-2, builder-3. */
export function nextInstanceId(persona: string): string {
  const taken = new Set(agents().map((a) => a.id))
  if (!taken.has(persona)) return persona
  for (let n = 2; ; n++) {
    const id = `${persona}-${n}`
    if (!taken.has(id)) return id
  }
}

export function agents(): Agent[] {
  return db().prepare('SELECT * FROM agents ORDER BY started_at').all() as unknown as Agent[]
}

export function setAgentStatus(id: string, status: string, taskId?: number | null): void {
  if (taskId === undefined) {
    db().prepare('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?').run(status, now(), id)
  } else {
    db()
      .prepare('UPDATE agents SET status = ?, task_id = ?, last_seen = ? WHERE id = ?')
      .run(status, taskId, now(), id)
  }
}

/**
 * The general case `joinAgent`'s restart-recovery only half-covers: an agent
 * instance can leave for good — closed with `x`, its pty crashed, or it was
 * reaped as dead at startup — and that exact id may never come back to
 * trigger `joinAgent`'s own cleanup. Whatever it was holding needs to be let
 * go here instead, on every path that removes an agent, or it is stuck until
 * someone notices and fixes the board by hand.
 */
export function dropAgent(id: string): void {
  const row = db().prepare('SELECT task_id FROM agents WHERE id = ?').get(id) as
    | { task_id: number | null }
    | undefined
  if (row?.task_id) releaseHeldTask(id, row.task_id, 'left while holding it')
  releaseClaims(id)
  // A task routed to this agent by a link is meaningless once the agent is
  // gone — leaving route_to set would strand it waiting for an id that may
  // never exist again, instead of falling back to whoever is free in the lane.
  db().prepare("UPDATE tasks SET route_to = '', updated_at = ? WHERE route_to = ? AND status != 'done'").run(now(), id)
  db().prepare('DELETE FROM agents WHERE id = ?').run(id)
}

// --- tasks ----------------------------------------------------------------

export function addTask(
  title: string,
  detail = '',
  labels = '',
  lane: string | null = null,
  deps: number[] = [],
  model = '',
): number {
  const info = db()
    .prepare(
      `INSERT INTO tasks (title, detail, labels, lane, deps, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(title, detail, labels, lane ?? '', deps.join(','), model, now(), now())
  return Number(info.lastInsertRowid)
}

export function tasks(status?: string): Task[] {
  const sql = status
    ? 'SELECT * FROM tasks WHERE status = ? ORDER BY id'
    : 'SELECT * FROM tasks ORDER BY id'
  const stmt = db().prepare(sql)
  return (status ? stmt.all(status) : stmt.all()) as unknown as Task[]
}

export function getTask(id: number): Task | undefined {
  return db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Task | undefined
}

/**
 * Claim a task, but only if nobody else already holds it. The WHERE clause is
 * the lock: two agents racing for the same task means one UPDATE matches zero
 * rows and that agent is told to pick something else.
 */
export function claimTask(id: number, agent: string): boolean {
  const info = db()
    .prepare(
      `UPDATE tasks SET status = 'claimed', owner = ?, updated_at = ?
       WHERE id = ? AND (owner IS NULL OR owner = ?) AND status IN ('open','blocked')`,
    )
    .run(agent, now(), id, agent)
  return info.changes > 0
}

export function updateTask(
  id: number,
  patch: {
    status?: string
    verified_by?: string
    verified_how?: string
    detail?: string
    verified_machine?: string
    checks_report?: string
  },
): void {
  const sets: string[] = []
  const values: (string | number)[] = []
  for (const key of ['status', 'verified_by', 'verified_how', 'detail', 'verified_machine', 'checks_report'] as const) {
    const value = patch[key]
    if (value !== undefined) {
      sets.push(`${key} = ?`)
      values.push(value)
    }
  }
  if (!sets.length) return
  sets.push('updated_at = ?')
  values.push(now(), id)
  db().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

// --- check lock -------------------------------------------------------
// Real check runs (src/checks.ts) actually spawn processes that bind ports,
// touch databases, and write lockfiles. Several agents finishing at once and
// running their suites at the same time is a well documented failure mode —
// it produces *flaky* results, not just slow ones, which is worse: a flaky
// "pass" is exactly the kind of unearned trust the whole gate exists to
// remove. This is a one-row mutex, same atomic-UPDATE pattern as claimTask:
// the WHERE clause is the lock, and SQLite's single-writer semantics make the
// UPDATE itself the race resolution — whichever process's UPDATE actually
// matches the row wins, and every other process's matches zero rows.

/** Comfortably above checks.ts's own DEFAULT_TIMEOUT_MS (5 minutes) per
 *  check, so a run that is genuinely still going is never pre-empted — but a
 *  holder that crashed mid-run (and so never reached releaseCheckLock) does
 *  not wedge the gate for every task on the board forever. */
const CHECK_LOCK_STALE_MS = 10 * 60_000

/** Take the lock, or steal it if the current holder has clearly gone (past
 *  CHECK_LOCK_STALE_MS with no release). False means someone else's run is
 *  genuinely in flight right now. */
export function acquireCheckLock(agent: string): boolean {
  db().exec('INSERT OR IGNORE INTO check_lock (id, holder, acquired_at) VALUES (1, NULL, NULL)')
  const at = now()
  const info = db()
    .prepare(
      `UPDATE check_lock SET holder = ?, acquired_at = ?
       WHERE id = 1 AND (holder IS NULL OR ? - acquired_at > ?)`,
    )
    .run(agent, at, at, CHECK_LOCK_STALE_MS)
  return info.changes > 0
}

/** Release only if `agent` is still the recorded holder, so a process whose
 *  lock was already stolen for being stale cannot clear the new holder's. */
export function releaseCheckLock(agent: string): void {
  db().prepare('UPDATE check_lock SET holder = NULL, acquired_at = NULL WHERE id = 1 AND holder = ?').run(agent)
}

// --- the graph ------------------------------------------------------------

export const TIERS = ['haiku', 'sonnet', 'opus'] as const

export function depsOf(task: Task): number[] {
  return task.deps.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
}

/**
 * The two ways a dependency edge can strand a task forever, rather than merely
 * make it wait: an edge pointing at an id that is not on the board (a planner
 * typo, a deleted task) and an edge that comes back around to where it started.
 * Neither can ever be satisfied, so a scheduler that only asks "are all deps
 * done?" leaves the task open and silent for the rest of the session.
 */
export function dependencyProblems(all: Task[] = tasks()): {
  dangling: { id: number; missing: number[] }[]
  cycles: number[][]
} {
  const byId = new Map(all.map((t) => [t.id, t]))

  const dangling: { id: number; missing: number[] }[] = []
  for (const t of all) {
    if (t.status === 'done') continue
    const missing = depsOf(t).filter((d) => !byId.has(d))
    if (missing.length) dangling.push({ id: t.id, missing })
  }

  // Depth-first with a colour per node: grey (1) means "on the current stack",
  // so meeting a grey node again is exactly a cycle, and the stack above it is
  // the loop. Same component reached from several entry points reports once.
  const colour = new Map<number, 1 | 2>()
  const stack: number[] = []
  const seen = new Set<string>()
  const cycles: number[][] = []
  const visit = (id: number): void => {
    const t = byId.get(id)
    if (!t || colour.get(id) === 2) return
    if (colour.get(id) === 1) {
      const loop = stack.slice(stack.indexOf(id))
      const key = [...loop].sort((a, b) => a - b).join(',')
      // A loop where everything is already done is history, not a stall.
      if (!seen.has(key) && loop.some((n) => byId.get(n)?.status !== 'done')) {
        seen.add(key)
        cycles.push(loop)
      }
      return
    }
    colour.set(id, 1)
    stack.push(id)
    for (const d of depsOf(t)) visit(d)
    stack.pop()
    colour.set(id, 2)
  }
  for (const t of all) visit(t.id)

  return { dangling, cycles }
}

/** Post only if this exact line is not already in the feed. Lets a function on
 *  the hot path say something once without keeping state to remember it did. */
function postOnce(agent: string, kind: string, body: string, taskId: number | null = null): void {
  const hit = db().prepare('SELECT 1 FROM feed WHERE body = ? LIMIT 1').get(body)
  if (hit) return
  post(agent, kind, body, taskId)
}

/**
 * Open tasks whose every dependency is done. This is the whole scheduler: a
 * task is not "assigned", it simply becomes eligible, and the dispatcher picks
 * eligible work up. Nothing has to remember to kick anything off.
 *
 * The two unsatisfiable edges are handled differently on purpose. A dep on an
 * id that is not on the board counts as satisfied — there is no work behind it,
 * so refusing to run is just losing the task — but it is announced in the feed
 * so the graph is not quietly rewritten under the human. A cycle is real work
 * that really is gated, so it stays put and is announced instead of guessed at.
 * Announcing happens here, on the call everything already makes, because the
 * alternative is a starving task nobody is told about.
 */
export function ready(): Task[] {
  const all = tasks()
  const byId = new Map(all.map((t) => [t.id, t]))
  const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id))
  const { dangling, cycles } = dependencyProblems(all)

  for (const d of dangling) {
    const ids = d.missing.map((m) => `#${m}`).join(', ')
    postOnce(
      'parley',
      'note',
      `#${d.id} depends on ${ids}, which ${d.missing.length > 1 ? 'are' : 'is'} not on the board — ` +
        `treating as satisfied so the task can run.`,
      d.id,
    )
  }
  for (const loop of cycles) {
    postOnce(
      'parley',
      'note',
      `dependency cycle ${loop.map((n) => `#${n}`).join(' → ')} → #${loop[0]} — ` +
        `these tasks can never become ready. Break the loop by editing their deps.`,
      loop[0],
    )
  }

  return all.filter(
    (t) => t.status === 'open' && depsOf(t).every((d) => !byId.has(d) || done.has(d)),
  )
}

/** Tasks that are open but waiting on something — the ones ready() excluded. */
export function waiting(): Task[] {
  const readyIds = new Set(ready().map((t) => t.id))
  return tasks().filter((t) => t.status === 'open' && !readyIds.has(t.id))
}

/** How many attempts a task gets once its tier has nowhere left to escalate.
 *  Reached, it parks instead of going round again. */
export const MAX_ATTEMPTS = 4

/**
 * Hand a task back to the board after an agent reported it blocked, and give the
 * next attempt a stronger model. A task that defeats haiku is not a task that
 * should sit dead on the board — it is a task that was mis-tiered.
 *
 * Escalation runs out, though. At the top tier the model stops changing while
 * `attempts` keeps climbing, so without a cap the identical attempt is
 * re-dispatched every cycle forever, burning the strongest model each time on
 * the thing it already failed. Past MAX_ATTEMPTS the task parks as 'blocked':
 * still on the board, rendered under BLOCKED with every accumulated note, but
 * not 'open', so `ready()` — and therefore the dispatcher — walks past it. A
 * human (or an agent told to) can put it back with `claimTask`, which still
 * accepts 'blocked'.
 */
/**
 * `effectiveTier` fixes a real, measured bug: TIERS.indexOf('') is -1, so a
 * task with no explicit model (addTask's default, and what parley_task_add
 * produces whenever the caller omits `model`) could never escalate — an
 * explicit-haiku task climbs haiku -> sonnet -> opus correctly, but an
 * untiered task stayed at '' through all MAX_ATTEMPTS and simply parked,
 * silently breaking the documented promise that a task which defeats a model
 * gets a stronger one next time.
 *
 * store.ts cannot resolve "what tier does this task's lane actually run at
 * by default" itself: that lives in personas.ts, and personas.ts already
 * imports store.ts (for custom personas), so importing back would be
 * circular. So the caller resolves the *effective* tier — dispatch.ts's
 * tierFor(task, laneFor(task)) does exactly this — and passes it in here.
 * task.model still wins whenever it is set explicitly; effectiveTier only
 * fills the gap when it is not. Callers that pass nothing keep the exact old
 * (unresolved-empty-tier) behaviour, so this is backward compatible.
 */
export function blockTask(
  id: number,
  note = '',
  effectiveTier?: string,
): { attempts: number; model: string; parked: boolean } | null {
  const task = getTask(id)
  if (!task) return null
  const attempts = task.attempts + 1
  const currentTier = task.model || effectiveTier || ''
  const at = TIERS.indexOf(currentTier as (typeof TIERS)[number])
  const canEscalate = at >= 0 && at < TIERS.length - 1
  const model = canEscalate ? TIERS[at + 1] : currentTier
  const parked = !canEscalate && attempts >= MAX_ATTEMPTS
  db()
    .prepare(
      `UPDATE tasks SET status = ?, owner = NULL, attempts = ?, model = ?, detail = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      parked ? 'blocked' : 'open',
      attempts,
      model,
      note ? `${task.detail}\n\nPreviously blocked: ${note}` : task.detail,
      now(),
      id,
    )
  if (parked) {
    post(
      'parley',
      'note',
      `#${id} parked after ${attempts} attempts at ${model || 'the top tier'} — ` +
        `it will not be dispatched again. Read the blocked notes in its detail.`,
      id,
    )
  }
  return { attempts, model, parked }
}

// --- links ----------------------------------------------------------------
// A link is a wire between two terminals, and it carries two things: work flows
// downstream (what src creates lands in dst's queue instead of the open board),
// and posts flow both ways with priority (a linked peer is addressing you, not
// broadcasting). Everyone still sees the broadcast feed — a link is emphasis and
// routing on top of that, never a replacement for it.
//
// Links bind agent instances, not lanes, because you draw them between the
// terminals in front of you. Kill an agent and its wires go with it.

export function link(src: string, dst: string): void {
  if (src === dst) return
  db()
    .prepare('INSERT OR IGNORE INTO links (src, dst, created_at) VALUES (?, ?, ?)')
    .run(src, dst, now())
}

export function unlink(src: string, dst?: string): number {
  const info = dst
    ? db().prepare('DELETE FROM links WHERE src = ? AND dst = ?').run(src, dst)
    : db().prepare('DELETE FROM links WHERE src = ? OR dst = ?').run(src, src)
  return info.changes
}

export function links(): { src: string; dst: string }[] {
  return db().prepare('SELECT src, dst FROM links ORDER BY src, dst').all() as unknown as {
    src: string
    dst: string
  }[]
}

/** Who this agent feeds work to. */
export function downstreamOf(agent: string): string[] {
  return db()
    .prepare('SELECT dst FROM links WHERE src = ?')
    .all(agent)
    .map((r) => (r as { dst: string }).dst)
}

/** Everyone wired to this agent in either direction — its conversation. */
export function linkedPeers(agent: string): Set<string> {
  const rows = db()
    .prepare('SELECT src, dst FROM links WHERE src = ? OR dst = ?')
    .all(agent, agent) as unknown as { src: string; dst: string }[]
  const peers = new Set<string>()
  for (const r of rows) peers.add(r.src === agent ? r.dst : r.src)
  return peers
}

/** Drop every wire touching an agent that no longer exists. */
export function pruneLinks(): void {
  const live = agents().map((a) => a.id)
  if (!live.length) {
    db().exec('DELETE FROM links')
    return
  }
  const placeholders = live.map(() => '?').join(',')
  db()
    .prepare(`DELETE FROM links WHERE src NOT IN (${placeholders}) OR dst NOT IN (${placeholders})`)
    .run(...live, ...live)
}

export function setRoute(taskId: number, agent: string): void {
  db().prepare('UPDATE tasks SET route_to = ?, updated_at = ? WHERE id = ?').run(agent, now(), taskId)
}

// --- intents (cross-process control) --------------------------------------
// `parley add builder` runs in a different process from the TUI that owns the
// ptys. Rather than invent a socket, the requesting process leaves a row and the
// TUI picks it up on its next tick — the same SQLite-as-message-bus the board
// already is.

export function pushIntent(kind: string, arg = '', extra = ''): void {
  db()
    .prepare('INSERT INTO intents (kind, arg, extra, created_at) VALUES (?, ?, ?, ?)')
    .run(kind, arg, extra, now())
}

export function drainIntents(): { kind: string; arg: string; extra: string }[] {
  const rows = db().prepare('SELECT id, kind, arg, extra FROM intents ORDER BY id').all() as unknown as {
    id: number
    kind: string
    arg: string
    extra: string
  }[]
  if (rows.length) db().prepare('DELETE FROM intents WHERE id <= ?').run(rows[rows.length - 1].id)
  return rows
}

// --- claims ---------------------------------------------------------------

export function addClaim(agent: string, path: string, kind: 'claim' | 'avoid', note = ''): void {
  db()
    .prepare('INSERT INTO claims (agent, path, kind, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(agent, path, kind, note, now())
}

export function claims(kind?: 'claim' | 'avoid'): Claim[] {
  const sql = kind
    ? 'SELECT * FROM claims WHERE kind = ? ORDER BY id DESC'
    : 'SELECT * FROM claims ORDER BY id DESC'
  const stmt = db().prepare(sql)
  return (kind ? stmt.all(kind) : stmt.all()) as unknown as Claim[]
}

export function releaseClaims(agent: string, path?: string): number {
  const info = path
    ? db().prepare('DELETE FROM claims WHERE agent = ? AND path = ?').run(agent, path)
    : db().prepare('DELETE FROM claims WHERE agent = ?').run(agent)
  return info.changes
}

/** Who else has staked out this path? Substring match both ways, so a claim on
 *  `src/api` answers for `src/api/routes.ts` and vice versa. */
export function conflicts(agent: string, path: string): Claim[] {
  return claims('claim').filter(
    (c) => c.agent !== agent && (path.includes(c.path) || c.path.includes(path)),
  )
}

// --- feed -----------------------------------------------------------------

export function post(agent: string, kind: string, body: string, taskId: number | null = null): number {
  const info = db()
    .prepare('INSERT INTO feed (agent, kind, body, task_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(agent, kind, body, taskId, now())
  return Number(info.lastInsertRowid)
}

export function feed(limit = 50): FeedItem[] {
  return db()
    .prepare('SELECT * FROM feed ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as FeedItem[]
}

/**
 * The reasoning agents left behind: choices made, alternatives rejected, things
 * found, things that blocked them. A diff shows what was decided but never why —
 * this is the only record of the why, and it is what the tutor explains from.
 */
export function decisions(limit = 25): FeedItem[] {
  return db()
    .prepare(
      `SELECT * FROM feed WHERE kind IN ('decision','finding','blocked','question')
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as unknown as FeedItem[]
}

/** Everything posted since this agent last looked, and advance its cursor.
 *  This is what makes terminals notice each other without polling. */
export function drainInbox(agent: string): FeedItem[] {
  const row = db().prepare('SELECT cursor FROM agents WHERE id = ?').get(agent) as
    | { cursor: number }
    | undefined
  const cursor = row?.cursor ?? 0
  const items = db()
    .prepare('SELECT * FROM feed WHERE id > ? AND agent != ? ORDER BY id')
    .all(cursor, agent) as unknown as FeedItem[]
  if (items.length) {
    db()
      .prepare('UPDATE agents SET cursor = ?, last_seen = ? WHERE id = ?')
      .run(items[items.length - 1].id, now(), agent)
  }
  return items
}

// --- touches / wip / briefs ----------------------------------------------

export function recordTouch(agent: string, path: string): void {
  db()
    .prepare('INSERT INTO touches (agent, path, created_at) VALUES (?, ?, ?)')
    .run(agent, path, now())
}

export function unbriefedTouches(agent: string): string[] {
  const rows = db()
    .prepare('SELECT DISTINCT path FROM touches WHERE agent = ? AND briefed = 0')
    .all(agent) as unknown as { path: string }[]
  return rows.map((r) => r.path)
}

export function markBriefed(agent: string): void {
  db().prepare('UPDATE touches SET briefed = 1 WHERE agent = ?').run(agent)
}

export function setWip(agent: string, files: string[]): void {
  db()
    .prepare(
      `INSERT INTO wip (agent, files, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET files = excluded.files, updated_at = excluded.updated_at`,
    )
    .run(agent, files.join('\n'), now())
}

export function wip(): Wip[] {
  return db().prepare('SELECT * FROM wip ORDER BY agent').all() as unknown as Wip[]
}

export function addBrief(title: string, path: string, agent: string): void {
  db()
    .prepare('INSERT INTO briefs (title, path, agent, created_at) VALUES (?, ?, ?, ?)')
    .run(title, path, agent, now())
}

export function briefs(limit = 20): { title: string; path: string; agent: string; created_at: number }[] {
  return db()
    .prepare('SELECT title, path, agent, created_at FROM briefs ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as { title: string; path: string; agent: string; created_at: number }[]
}

export function learnTerm(term: string, definition: string): void {
  db()
    .prepare(
      `INSERT INTO glossary (term, definition, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET seen = glossary.seen + 1, updated_at = excluded.updated_at`,
    )
    .run(term, definition, now())
}

export function glossary(): { term: string; definition: string; seen: number }[] {
  return db()
    .prepare('SELECT term, definition, seen FROM glossary ORDER BY seen DESC, term')
    .all() as unknown as { term: string; definition: string; seen: number }[]
}

// --- proposals --------------------------------------------------------
// A goal doesn't commit tasks on its own anymore — it first proposes which
// agents it would spin up and why, and sits here as 'pending' until the human
// approves it (or replies with a refinement, which replaces the row in place)
// or cancels it.

export function addProposal(goal: string, agentsJson: string, note = ''): number {
  const info = db()
    .prepare(
      `INSERT INTO proposals (goal, agents_json, note, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
    .run(goal, agentsJson, note, now(), now())
  return Number(info.lastInsertRowid)
}

export function getProposal(id: number): Proposal | undefined {
  return db().prepare('SELECT * FROM proposals WHERE id = ?').get(id) as unknown as Proposal | undefined
}

export function updateProposal(id: number, patch: { agents_json?: string; note?: string; answer?: string; status?: string }): void {
  const sets: string[] = []
  const values: (string | number)[] = []
  for (const key of ['agents_json', 'note', 'answer', 'status'] as const) {
    const value = patch[key]
    if (value !== undefined) {
      sets.push(`${key} = ?`)
      values.push(value)
    }
  }
  if (!sets.length) return
  sets.push('updated_at = ?')
  values.push(now(), id)
  db().prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function latestPendingProposal(): Proposal | undefined {
  return db().prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id DESC LIMIT 1").get() as
    | Proposal
    | undefined
}

// --- custom personas ---------------------------------------------------
// The built-in four live in code. A persona the planner or the user invents
// on the spot lives here instead, so it works everywhere a built-in one does
// (spawning, dispatch, parley_who) and accumulates into a real library
// across goals rather than disappearing when the session that created it ends.

export function addCustomPersona(p: Omit<CustomPersona, 'created_at'>): void {
  db()
    .prepare(
      `INSERT INTO personas (id, title, color, labels, model, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, color = excluded.color,
                                     labels = excluded.labels, model = excluded.model, prompt = excluded.prompt`,
    )
    .run(p.id, p.title, p.color, p.labels, p.model, p.prompt, now())
}

export function customPersonas(): CustomPersona[] {
  return db().prepare('SELECT * FROM personas ORDER BY created_at').all() as unknown as CustomPersona[]
}
