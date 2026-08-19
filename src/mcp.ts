// The parley MCP server. One instance is spawned per agent by Claude Code over
// stdio, so PARLEY_AGENT tells us who is calling. MCP is JSON-RPC 2.0 over
// newline-delimited JSON — small enough to speak directly.
import { createInterface } from 'node:readline'
import {
  acquireCheckLock,
  addClaim,
  addTask,
  blockTask,
  claimTask,
  conflicts,
  downstreamOf,
  getTask,
  post,
  projectRoot,
  releaseCheckLock,
  releaseClaims,
  setAgentStatus,
  setRoute,
  tasks,
  updateTask,
} from './store.ts'
import { renderBoard, renderWho } from './render.ts'
import { detectChecks, runChecks, summarize } from './checks.ts'
import { laneFor, tierFor } from './dispatch.ts'

const AGENT = process.env.PARLEY_AGENT ?? 'unknown'

type Json = Record<string, unknown>

const str = (d: string) => ({ type: 'string', description: d })

const TOOLS = [
  {
    name: 'parley_who',
    description:
      'Who else is working this repo right now, what they hold, which paths are claimed, which paths are explicitly free, and which peers have uncommitted work. Call this before assuming anything is unowned — git cannot tell you this.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'parley_board',
    description: 'The shared task board: open, in progress, in review, blocked, done.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'parley_claim',
    description:
      'Claim a task and/or file paths before editing them. Reports a conflict if a peer already holds an overlapping path — if it does, pick different work.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task number from the board' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Paths or globs you are about to edit' },
        note: str('Why, in a few words'),
      },
    },
  },
  {
    name: 'parley_avoid',
    description:
      'Declare paths you are deliberately NOT touching. This frees peers to work there without fear of a collision. As valuable as claiming: it prevents work sitting undone because nobody was sure it was safe.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        note: str('Why you are staying out — e.g. "owned by the migration lane"'),
      },
      required: ['paths'],
    },
  },
  {
    name: 'parley_release',
    description: 'Release your claims when you are done, so peers can take the area.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Omit to release all of yours' } },
    },
  },
  {
    name: 'parley_post',
    description:
      'Tell your peers something. They see it at the top of their next turn. Keep it to one or two lines.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['started', 'finished', 'blocked', 'decision', 'finding', 'question', 'note'] },
        body: str('The message'),
        task_id: { type: 'number' },
      },
      required: ['kind', 'body'],
    },
  },
  {
    name: 'parley_update',
    description:
      'Move a task and record how you verified it. Carry the evidence: the command you ran and what it printed, not just a claim that it works.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        status: { type: 'string', enum: ['open', 'claimed', 'review', 'blocked', 'done'] },
        verified_how: str('The command you ran and its result, or the file:line you read'),
      },
      required: ['task_id'],
    },
  },
  {
    name: 'parley_task_add',
    description:
      'Put newly discovered work on the board rather than silently doing it or silently dropping it. If it cannot start until something else lands, say so in deps — parley will hold it back and start it automatically the moment those finish.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('One line'),
        detail: str('What done looks like and how to verify it'),
        labels: str('Comma separated, e.g. "test,api" — routes it to the right persona'),
        lane: str('Persona id whose lane this falls in, if it is clear'),
        deps: {
          type: 'array',
          items: { type: 'number' },
          description: 'Task ids that must be done first. Only genuine blockers, not preferred order.',
        },
        model: {
          type: 'string',
          enum: ['haiku', 'sonnet', 'opus'],
          description: 'How much model this is worth. Most work is sonnet.',
        },
      },
      required: ['title'],
    },
  },
]

/**
 * parley_update(status: "done") no longer just records a claim — it runs the
 * project's real checks (src/checks.ts, which makes zero model calls) and
 * only lets the task through if they actually pass. This is the exact fix
 * for the founding failure: an agent wrote 49 real tests, wired an `npm
 * test` script that could never resolve its module path, and marked the
 * task done anyway — because the only thing that had ever "verified" that
 * claim was this same function trusting whichever agent called it.
 *
 * The data model keeps "the agent claimed" and "the machine confirmed"
 * separate, never merged into one field:
 *   - checks pass       -> status becomes done. verified_by/verified_how
 *     still record the agent's own claim, untouched; verified_machine =
 *     'passed' and checks_report holds the real per-check exit codes and
 *     output, in a column the agent's claim never touches.
 *   - checks fail        -> NOT done. blockTask() (the existing mechanism
 *     for "return work to the board with a note") reopens the task with the
 *     real failure output appended to its detail, and this function returns
 *     that same report as the tool's response text, so the calling agent
 *     can fix the actual problem in this same turn instead of guessing.
 *   - no checks detected -> let the task through — many real repos
 *     genuinely have none, and refusing to ever complete such a task would
 *     just trade one bug for another — but verified_machine = 'unverified',
 *     never 'passed'. Silently treating "nothing ran" as "it passed" would
 *     recreate the exact self-attestation bug this whole function exists to
 *     remove; the two must stay visibly distinguishable later.
 */
async function finishTask(taskId: number, verifiedHow: string | undefined): Promise<string> {
  const task = getTask(taskId)
  if (!task) return `No task #${taskId}.`

  // Serialize real check runs across every agent process sharing this board
  // (store.ts's check_lock — see its own comment). A second agent arriving
  // while a run is in flight is told to retry rather than made to wait: that
  // keeps this tool call bounded and synchronous, and the agent's own retry
  // is a perfectly good backoff without inventing a poll loop here.
  if (!acquireCheckLock(AGENT)) {
    return (
      `Another agent's verification run is in flight right now — running two at once would ` +
      `produce flaky results, not just slow ones. #${taskId} was not moved; call parley_update again shortly.`
    )
  }

  try {
    const root = projectRoot()
    const checks = detectChecks(root)

    if (checks.length === 0) {
      updateTask(taskId, {
        status: 'done',
        verified_by: verifiedHow ? AGENT : undefined,
        verified_how: verifiedHow,
        verified_machine: 'unverified',
        checks_report:
          'No checks were detected for this project (no package.json test/typecheck/lint/build ' +
          'script, no pytest/ruff/mypy config, no go.mod, Cargo.toml, or Makefile test/check target).',
      })
      releaseClaims(AGENT)
      setAgentStatus(AGENT, 'idle', null)
      post(
        AGENT,
        'finished',
        `#${taskId} done — UNVERIFIED, no checks detected${verifiedHow ? ` (claim: ${verifiedHow})` : ''}`,
        taskId,
      )
      return (
        `#${taskId} is done, but UNVERIFIED: no checks exist for this project, so nothing actually ran to ` +
        `confirm "${verifiedHow ?? 'your claim'}". Recorded as your claim only, not machine-verified.`
      )
    }

    const results = await runChecks(root, checks)
    const { ok, report } = summarize(results)

    if (!ok) {
      const bumped = blockTask(
        taskId,
        `parley_update(done) rejected — the real checks failed:\n${report}`,
        tierFor(task, laneFor(task)),
      )
      const tierNote = bumped
        ? bumped.parked
          ? ' It has been parked after too many failed attempts.'
          : ` It is back on the board (attempt ${bumped.attempts}, now tiered ${bumped.model || 'default'}).`
        : ''
      return `#${taskId} did NOT reach done — the real checks failed.${tierNote} Fix this now, in this session:\n\n${report}`
    }

    updateTask(taskId, {
      status: 'done',
      verified_by: verifiedHow ? AGENT : undefined,
      verified_how: verifiedHow,
      verified_machine: 'passed',
      checks_report: report,
    })
    releaseClaims(AGENT)
    setAgentStatus(AGENT, 'idle', null)
    post(AGENT, 'finished', `#${taskId} done — machine-verified${verifiedHow ? ` (claim: ${verifiedHow})` : ''}`, taskId)
    return `#${taskId} is done. Machine-verified — every real check passed:\n\n${report}`
  } finally {
    releaseCheckLock(AGENT)
  }
}

async function call(name: string, args: Json): Promise<string> {
  switch (name) {
    case 'parley_who':
      return renderWho()

    case 'parley_board':
      return renderBoard()

    case 'parley_claim': {
      const out: string[] = []
      const taskId = args.task_id as number | undefined
      if (taskId !== undefined) {
        const task = getTask(taskId)
        if (!task) return `No task #${taskId} on the board.`
        if (claimTask(taskId, AGENT)) {
          setAgentStatus(AGENT, 'working', taskId)
          post(AGENT, 'started', `claimed #${taskId} ${task.title}`, taskId)
          out.push(`Claimed #${taskId} ${task.title}`)
        } else {
          const fresh = getTask(taskId)
          return `Could not claim #${taskId} — it is ${fresh?.status} and held by ${fresh?.owner ?? 'someone'}. Pick different work.`
        }
      }
      for (const path of (args.paths as string[] | undefined) ?? []) {
        const clash = conflicts(AGENT, path)
        if (clash.length) {
          out.push(`CONFLICT on ${path}: already claimed by ${clash.map((c) => c.agent).join(', ')}. Do not edit it.`)
          continue
        }
        addClaim(AGENT, path, 'claim', (args.note as string) ?? '')
        out.push(`Claimed path ${path}`)
      }
      return out.join('\n') || 'Nothing to claim — pass task_id or paths.'
    }

    case 'parley_avoid': {
      const paths = (args.paths as string[]) ?? []
      for (const path of paths) addClaim(AGENT, path, 'avoid', (args.note as string) ?? '')
      post(AGENT, 'note', `not touching: ${paths.join(', ')}${args.note ? ` (${args.note})` : ''}`)
      return `Declared not-touching: ${paths.join(', ')}. Peers can now work there.`
    }

    case 'parley_release': {
      const paths = args.paths as string[] | undefined
      const n = paths?.length
        ? paths.reduce((sum, p) => sum + releaseClaims(AGENT, p), 0)
        : releaseClaims(AGENT)
      return `Released ${n} claim(s).`
    }

    case 'parley_post': {
      const kind = args.kind as string
      const body = args.body as string
      const taskId = (args.task_id as number) ?? null
      post(AGENT, kind, body, taskId)

      // "blocked" is a state transition, not just an announcement: hand the task
      // back so someone else can take it, and buy the next attempt a better model.
      if (kind === 'blocked' && taskId) {
        releaseClaims(AGENT)
        setAgentStatus(AGENT, 'idle', null)
        // Resolve the effective tier (task.model, or else the lane persona's
        // default) so an untiered task actually escalates instead of
        // stalling at '' — see blockTask's own comment in store.ts.
        const blockedTask = getTask(taskId)
        const bumped = blockedTask ? blockTask(taskId, body, tierFor(blockedTask, laneFor(blockedTask))) : null
        if (bumped) {
          return `Posted, and #${taskId} is back on the board (attempt ${bumped.attempts}, now tiered ${bumped.model}). Take different work.`
        }
      }
      return 'Posted. Peers will see it on their next turn.'
    }

    case 'parley_update': {
      const taskId = args.task_id as number
      if (!getTask(taskId)) return `No task #${taskId}.`
      const verifiedHow = args.verified_how as string | undefined

      // "done" is the one transition that must not be pure self-attestation
      // (see the header comment on finishTask). Every other status is still
      // just recorded as told — parley_update(review) etc. carries no claim
      // of "this is confirmed correct" the way "done" does.
      if (args.status === 'done') return finishTask(taskId, verifiedHow)

      updateTask(taskId, {
        status: args.status as string | undefined,
        verified_by: verifiedHow ? AGENT : undefined,
        verified_how: verifiedHow,
      })
      return `Updated #${taskId}.`
    }

    case 'parley_task_add': {
      const deps = ((args.deps as number[]) ?? []).filter((d) => getTask(d))
      const id = addTask(
        args.title as string,
        (args.detail as string) ?? '',
        (args.labels as string) ?? '',
        (args.lane as string) ?? null,
        deps,
        (args.model as string) ?? '',
      )
      post(AGENT, 'note', `added #${id} ${args.title}`, id)

      // If this agent is wired to a downstream one, work it discovers belongs to
      // that agent rather than to whoever happens to be free.
      const [downstream] = downstreamOf(AGENT)
      if (downstream) setRoute(id, downstream)

      const held = deps.length ? ` Waiting on ${deps.map((d) => `#${d}`).join(', ')}.` : ' Ready now.'
      const routed = downstream ? ` Routed to ${downstream} (you are linked to them).` : ''
      return `Added #${id}.${held}${routed} Board now has ${tasks().length} task(s).`
    }

    default:
      return `Unknown tool: ${name}`
  }
}

function send(msg: Json): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

// `call` now runs real checks for a "done" update (finishTask awaits
// runChecks), so this handler has to be async too — parley_update is the
// only tool whose response now genuinely takes time to produce.
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req: Json
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req as { id?: unknown; method?: string; params?: Json }
  if (id === undefined || id === null) return // notification — nothing to answer

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'parley', version: '0.1.0' },
        },
      })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const name = params?.name as string
      const text = await call(name, (params?.arguments as Json) ?? {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    })
  }
})
