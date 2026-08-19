// `parley goal "..."` — decompose an intention into claimable tasks and route
// them to the persona whose lane they fall in. You can always overrule the
// result; it lands on the board as ordinary tasks, not as a locked plan.
import { execFileSync } from 'node:child_process'
import { addCustomPersona, addTask, post, projectRoot, tasks } from './store.ts'
import { PERSONAS, allPersonas } from './personas.ts'
import type { Persona } from './personas.ts'

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          labels: { type: 'string' },
          owner: { type: 'string' },
          deps: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Indices of earlier tasks in THIS array that must finish first. Empty if none.',
          },
          model: {
            type: 'string',
            enum: ['haiku', 'sonnet', 'opus'],
            description: 'How much model this task is worth',
          },
        },
        required: ['title', 'detail', 'labels', 'owner', 'deps', 'model'],
      },
    },
  },
  required: ['tasks'],
})

export type Planned = {
  title: string
  detail: string
  labels: string
  owner: string
  deps: number[]
  model: string
}

/** `roster`, when given, limits which agents this decomposition is allowed to
 *  assign work to — the ones the human actually approved in the proposal
 *  step. Omitted, it advertises the full library, which is what the
 *  standalone `parley goal` CLI command (nothing to approve from there) keeps
 *  using. */
export function plan(goal: string, approvedRoster?: Persona[]): Planned[] {
  const advertised = approvedRoster && approvedRoster.length ? approvedRoster : PERSONAS
  const roster = advertised.map((p) => `- ${p.id} (${p.title}): ${p.labels.join(', ')}`).join('\n')
  const existing = tasks()
    .filter((t) => t.status !== 'done')
    .map((t) => `#${t.id} [${t.status}] ${t.title}`)
    .join('\n')

  const prompt = `Decompose this goal into tasks for a team of parallel Claude Code agents working the same repository.

GOAL: ${goal}

Available agents and their lanes:
${roster}

${existing ? `Already on the board (do not duplicate these):\n${existing}` : 'The board is empty.'}

Read enough of the repository to make the tasks concrete. Then produce tasks where:

- Each is independently claimable. Two agents should be able to take two different tasks and not collide on the same files. If two pieces of work must touch the same file, that is ONE task, not two.
- The title is one line, imperative, specific to this repo. Not "add tests" but "cover the retry path in fetchWithBackoff".
- The detail says what done looks like and how to verify it — the command to run, the behavior to observe. Write it so an agent with no memory of this conversation could execute it.
- labels is comma-separated and drawn from the lanes above, so it routes correctly.
- owner is the agent id whose lane it falls in.

deps is the real ordering constraint, and it is load-bearing: parley will not start a task until every task listed in its deps is finished, and it starts everything else immediately and in parallel. So:

- List a dependency only when the work genuinely cannot begin without the other finishing — usually because it needs a function, table, or file the other creates. Do not encode a preferred order, a review step, or "it would be tidier if". A false edge idles an agent for no reason.
- Use 0-based indices into the array you are returning. A task can only depend on tasks EARLIER in the array, so order the array so that is always possible.
- Aim for a wide graph. If everything depends on the thing before it, you have written a queue, not a plan, and only one agent will ever be working.

model is how much intelligence the task is worth. Be honest — most tasks are not opus tasks:

- haiku: mechanical and well-specified. Reading and reporting, renaming, moving code, following an established pattern, writing a test for behavior that is already described.
- sonnet: ordinary implementation. Most feature work and most fixes belong here. This is the default when you are unsure.
- opus: genuinely hard. Load-bearing design decisions, tricky concurrency, a change whose blast radius is wide, or anything where being wrong is expensive and hard to detect.

Prefer four to eight tasks. Fewer if the goal is small — do not pad. If the goal is too vague to decompose concretely, return a single task asking the specific question that would unblock it.`

  const raw = execFileSync(process.env.PARLEY_CLAUDE ?? 'claude', [
    '-p',
    '--model',
    process.env.PARLEY_PLANNER_MODEL ?? 'opus',
    '--output-format',
    'json',
    '--json-schema',
    SCHEMA,
    prompt,
  ], {
    cwd: projectRoot(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
    env: { ...process.env, PARLEY_AGENT: '', PARLEY_DIR: '' },
  })

  const outer = JSON.parse(raw) as { result?: unknown }
  const result = outer.result ?? outer
  const parsed = (typeof result === 'string' ? JSON.parse(result) : result) as { tasks?: Planned[] }
  return parsed.tasks ?? []
}

/**
 * The planner names dependencies by position, because it cannot know the ids the
 * board will assign. Tasks go in in order and a task may only depend on earlier
 * ones, so by the time we insert task i every id it references already exists —
 * which is what turns "deps: [0, 2]" into real edges without a second pass.
 *
 * `deps` may only reference EARLIER entries (see the `plan()` prompt above).
 * A forward reference, a self-reference, or an out-of-range index all leave
 * `ids[i]` undefined at this point in the loop, since `ids` only holds ids
 * for entries already inserted. The old code just filtered those out with
 * `typeof id === 'number'` — a bad index vanished with no error, no log, no
 * feed note, and the task landed on the board looking correctly wired while
 * actually missing a real prerequisite, free to run before the work it
 * depended on. That is a silent corruption of the dependency graph, which is
 * exactly the failure mode this codebase exists to surface, not hide.
 *
 * Follow the pattern store.ts already uses for dangling deps and cycles (see
 * `ready()`): keep the task, drop only the bad edge, but post a feed note so
 * a planner mistake is visible instead of invisible. Throwing would be worse
 * here — one garbage index shouldn't destroy an otherwise-good plan.
 */
export function commitPlan(goal: string, planned: Planned[]): number[] {
  const ids: number[] = []
  for (const t of planned) {
    const deps: number[] = []
    const badIndices: number[] = []
    for (const depIndex of t.deps ?? []) {
      const id = ids[depIndex]
      if (typeof id === 'number') deps.push(id)
      else badIndices.push(depIndex)
    }
    const taskId = addTask(t.title, t.detail, t.labels, t.owner || null, deps, t.model || '')
    ids.push(taskId)
    for (const depIndex of badIndices) {
      post(
        'planner',
        'note',
        `#${taskId} ("${t.title}") named dependency index ${depIndex}, which is not a valid earlier ` +
          `entry in the plan (forward reference, self-reference, or out of range) — dropping that dependency.`,
        taskId,
      )
    }
  }
  post('planner', 'note', `goal: ${goal} → ${ids.length} task(s) on the board`)
  return ids
}

// --- proposing a team, before any of it runs ------------------------------
// The expensive part above — a full task decomposition — only happens once
// the human has approved which agents get to work at all. This is the cheap
// pass that decides that: which agents, how many, and why, in one sentence
// each a non-engineer can read. Kept flat (unused fields empty string) rather
// than nested, matching the schema style `plan`'s SCHEMA already uses.

export type ProposedAgent = {
  kind: 'existing' | 'custom'
  personaId: string
  customId: string
  customTitle: string
  customDescription: string
  customPrompt: string
  customLabels: string
  customModel: string
  count: number
  why: string
}

export type Proposal = {
  agents: ProposedAgent[]
  note: string
  /** Set only when the human's reply was a question rather than an
   *  instruction to change the team — the direct answer, plain language.
   *  Empty on a fresh proposal or after an actual revision. */
  answer: string
}

const PROPOSE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    agents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['existing', 'custom'] },
          personaId: { type: 'string', description: "id from the library, when kind is 'existing'. Empty otherwise." },
          customId: { type: 'string', description: "short slug for a new persona, when kind is 'custom'. Empty otherwise." },
          customTitle: { type: 'string' },
          customDescription: { type: 'string', description: 'one line, plain language, for a human to read' },
          customPrompt: { type: 'string', description: "the new persona's system prompt. Empty when kind is 'existing'." },
          customLabels: { type: 'string', description: 'comma-separated lane labels, for routing tasks to it' },
          customModel: { type: 'string', enum: ['haiku', 'sonnet', 'opus', ''] },
          count: { type: 'integer' },
          why: { type: 'string', description: 'one plain-language sentence: what this agent is for, no jargon' },
        },
        required: [
          'kind', 'personaId', 'customId', 'customTitle', 'customDescription',
          'customPrompt', 'customLabels', 'customModel', 'count', 'why',
        ],
      },
    },
    note: { type: 'string', description: 'one short sentence introducing the plan as a whole, PM-readable' },
    answer: {
      type: 'string',
      description:
        "If the human's reply (see below, when present) was a genuine question rather than an instruction to change the team, answer it here directly, in plain language. Leave empty on a fresh proposal, or when you revised the team instead.",
    },
  },
  required: ['agents', 'note', 'answer'],
})

/**
 * `refinement`, when given, is the human's reply to a proposal they didn't
 * just approve outright — "make it five" or "add one focused on tests" — and
 * the prior proposal it's replying to, so the model revises rather than
 * starting over.
 */
export function proposeAgents(goal: string, refinement?: { prior: Proposal; reply: string }): Proposal {
  const roster = allPersonas().map((p) => `- ${p.id} (${p.title}): ${p.labels.join(', ')}`).join('\n')

  const prompt = `A person wants a team of parallel Claude Code agents to work on something in this repository. Decide which agents should spin up — not what they will do task-by-task, that comes later once this is approved.

GOAL: ${goal}

Existing agent library (id, title, lanes):
${roster}

For each agent you want: pick an existing persona by id ("kind": "existing", "personaId" set, the custom* fields left empty) when one in the library genuinely fits. Only invent a new one ("kind": "custom") when the goal needs a shape of agent nothing in the library covers — give it a short id, a title, a one-line description a non-engineer would understand, a real system prompt (written the way the existing personas' prompts are: what this agent does, what it does NOT do, how it hands off), and comma-separated lane labels so tasks route to it.

"why" is the one sentence the human sees next to this agent — plain language, no jargon, what it's for and why it's part of this team. "note" is one sentence introducing the whole proposal.

Prefer the smallest team that can actually do the work in parallel without idling — do not add an agent "for completeness". Most goals need two or three.${
    refinement
      ? `\n\nYou already proposed:\n${JSON.stringify(refinement.prior, null, 2)}\n\nThe human replied: "${refinement.reply}"\n\nIf that reply is phrased as a question ("why...", "what...", "how...", ends in "?", or is otherwise asking rather than telling) — ALWAYS fill "answer" with a direct, honest response, even if answering it also leads you to change the team. A rhetorical-sounding question ("why does this need an architect at all?") still gets answered — say why, or say you agree and are dropping it, but never make that change silently. Only leave "answer" empty when the reply has no question in it at all — a plain instruction ("make it five", "drop the reviewer") or a plain approval.`
      : ''
  }`

  const raw = execFileSync(process.env.PARLEY_CLAUDE ?? 'claude', [
    '-p',
    '--model',
    process.env.PARLEY_PROPOSE_MODEL ?? 'haiku',
    '--output-format',
    'json',
    '--json-schema',
    PROPOSE_SCHEMA,
    prompt,
  ], {
    cwd: projectRoot(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, PARLEY_AGENT: '', PARLEY_DIR: '' },
  })

  const outer = JSON.parse(raw) as { result?: unknown }
  const result = outer.result ?? outer
  const parsed = (typeof result === 'string' ? JSON.parse(result) : result) as Partial<Proposal>
  const proposal: Proposal = { agents: parsed.agents ?? [], note: parsed.note ?? '', answer: parsed.answer ?? '' }

  // Persist any invented personas immediately — the library only grows, and
  // doesn't depend on this particular proposal being the one that gets
  // approved.
  for (const a of proposal.agents) {
    if (a.kind !== 'custom' || !a.customId) continue
    addCustomPersona({
      id: a.customId,
      title: a.customTitle || a.customId,
      color: 'white',
      labels: a.customLabels,
      model: a.customModel,
      prompt: a.customPrompt,
    })
  }

  return proposal
}

/** Turn an approved proposal into the roster `plan()` should be scoped to. */
export function rosterFor(proposal: Proposal): Persona[] {
  const ids = proposal.agents.map((a) => (a.kind === 'existing' ? a.personaId : a.customId)).filter(Boolean)
  return allPersonas().filter((p) => ids.includes(p.id))
}
