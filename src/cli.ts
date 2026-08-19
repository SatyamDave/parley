#!/usr/bin/env node
// parley — a workspace of Claude Code terminals that plan the work, run it, and
// then explain it back to you.
//
// The shell surface is deliberately small: opening the workspace, stating a
// goal, and the three ways of understanding what came out. Everything
// interactive lives on the ':' line inside the workspace itself.
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERSONAS, PROTOCOL, allPersonas, persona } from './personas.ts'
import { plan, commitPlan, proposeAgents } from './planner.ts'
import { renderBoard, renderGraph, renderWho, renderWiring, ago } from './render.ts'
import {
  addProposal,
  drainInbox,
  getProposal,
  joinAgent,
  linkedPeers,
  projectRoot,
  pushIntent,
  recordTouch,
  setAgentStatus,
  stateDir,
  tasks,
  updateProposal,
} from './store.ts'
import { isProjectTrusted, trustProject } from './spawn.ts'
import { explain, makeQuiz, writeBrief, writeBriefDetached, writeReview } from './tutor.ts'
import { scanWip } from './watch.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)

const flag = (name: string, fallback = ''): string => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
// Flags that take no value. Without this list a boolean flag swallows the token
// after it and a positional argument silently goes missing — which is why every
// value-less flag has to be registered here, not just `--auto`.
//
// `--agent` is deliberately absent: it is value-taking for the internal `brief`
// command (`--agent builder`) and value-less for `map --agent`. Registering it
// would break `brief`. `map` reads it with `argv.includes`, and `map` takes no
// positionals, so leaving it out is harmless there.
const BOOLEAN_FLAGS = new Set(['--auto', '--show', '--verify', '--full'])

/**
 * Which flags each command actually understands. This exists because of a real
 * footgun: `parley map --help` was not a recognised flag, fell straight through
 * the `--show`/`--agent`/`--verify` checks, and started a **full map rebuild** —
 * minutes of work and real model calls, from a typo. An unrecognised flag must
 * never silently trigger an expensive operation. Value-taking flags are listed
 * alongside their value-less siblings; the check only cares about the flag name.
 */
const KNOWN_FLAGS: Record<string, string[]> = {
  up: ['--agents', '--model', '--permission-mode', '--auto'],
  goal: ['--roster'],
  propose: ['--refine', '--reply'],
  map: ['--show', '--agent', '--verify', '--full'],
  add: ['--model'],
  brief: ['--agent', '--transcript'],
}

/** Every flag present in argv, ignoring their values. */
const flagsUsed = (): string[] => argv.filter((a) => a.startsWith('--'))

/**
 * Refuse to act on a command carrying a flag it does not understand. Returns
 * true when the caller should stop. Being loud here is the whole point: the
 * alternative — which is what shipped — is doing something slow and costly that
 * the user never asked for.
 */
function rejectUnknownFlags(cmd: string): boolean {
  const known = KNOWN_FLAGS[cmd] ?? []
  const unknown = flagsUsed().filter((f) => !known.includes(f))
  if (!unknown.length) return false
  console.log(`parley ${cmd}: unrecognised ${unknown.length > 1 ? 'flags' : 'flag'} ${unknown.join(', ')}`)
  console.log(known.length ? `Understood here: ${known.join(' ')}` : 'This command takes no flags.')
  console.log('Run `parley` with no arguments for the full command list.')
  return true
}

const positionals = (): string[] => {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(argv[i])) i++ // skip its value
      continue
    }
    out.push(argv[i])
  }
  return out
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** npm blocks node-pty's install script under allow-scripts, which leaves
 *  spawn-helper non-executable and every spawn failing with "posix_spawnp
 *  failed". Cheap to just make sure. */
function ensurePty(): void {
  const helper = join(ROOT, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755)
    } catch {
      /* not ours to chmod */
    }
  }
}

/**
 * `parley status` needs to answer one question render.ts's renderBoard()
 * cannot: was a "done" task actually machine-checked, or did an agent just
 * say so? Defined here rather than in render.ts, which is off limits while
 * another change is in flight there — this reads verified_machine directly,
 * the field parley_update(done) now sets separately from the agent's own
 * verified_how claim (see src/mcp.ts's finishTask).
 */
function renderVerification(): string {
  const done = tasks('done')
  if (!done.length) return ''
  const lines = ['', 'VERIFICATION (done tasks — machine-checked vs. self-attested)']
  for (const t of done) {
    const tag =
      t.verified_machine === 'passed'
        ? 'MACHINE-VERIFIED'
        : t.verified_machine === 'unverified'
          ? 'UNVERIFIED — no checks existed to run'
          : 'self-attested only (no gate result recorded)'
    lines.push(`  #${t.id} ${t.title} — ${tag}`)
    if (t.verified_how) lines.push(`      claimed: ${t.verified_how}`)
  }
  return lines.join('\n')
}

const HELP = `parley — a workspace of Claude Code terminals that plan, run, and explain the work

  parley                      open the workspace
  parley goal "<intention>"   turn it into a plan and start running it
  parley map                  build the architecture map of this repo (incremental if one exists)
  parley map --full           rebuild the map from scratch, ignoring any previous one
  parley map --show           read it · --agent shows the form agents receive
  parley map --verify         re-check every claim against the code (drift detection)
  parley map corrections      list pinned human corrections to the map
  parley map corrections label|purpose <regionId> "<text>"    override what the model said
  parley map corrections suppress <regionId> "<statement>"    hide a wrong claim, even if regenerated
  parley map corrections claim <regionId> "<statement>" --files a.ts,b.ts   add a claim of your own
  parley map corrections remove label|purpose|suppress|claim <regionId|id>
  parley status               what is happening, from another shell — including whether each done task was actually machine-checked or just self-attested
  parley review [ref|PR#]     system-design review of a change, before you merge
  parley explain <topic>      ask about a file, function, or term
  parley quiz [n]             check what actually stuck
  parley add <role>           start another agent from outside the workspace
  parley kill <agent-id>      stop one from outside the workspace
  parley wires                who is linked to whom, right now
  parley prompt [role]        the system prompt a role actually runs with

Inside the workspace, use the mouse:

  click a pane          type in that agent
  drag pane onto pane   link them — work flows that way, messages both ways
  click +role           start another agent
  click x               close one
  type up top           say what you want, press enter

Keyboard: tab moves between panes, ctrl-q quits. Everything else goes to the agent.

Roles: ${PERSONAS.map((p) => `${p.id} (${p.model ?? 'default'})`).join(', ')}
Options: --agents a,b · --model <tier> · --auto (dispatch ready tasks automatically; off by default)
`

async function hook(event: string): Promise<void> {
  const agent = process.env.PARLEY_AGENT
  if (!agent) return
  const raw = await readStdin()
  const payload = (raw ? JSON.parse(raw) : {}) as {
    transcript_path?: string
    tool_input?: { file_path?: string; notebook_path?: string }
  }

  if (event === 'session-start') {
    // Claude Code is up and listening — this is what promotes the agent out of
    // 'starting' and makes the dispatcher willing to hand it work.
    joinAgent(agent, process.env.PARLEY_PERSONA ?? agent, null, 'idle')
    try {
      scanWip()
    } catch {
      /* not a git repo */
    }
    const context = `You are agent "${agent}" in a parley session.\n\n${renderWho()}\n\n${renderBoard()}`
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }),
    )
    return
  }

  if (event === 'inbox') {
    const items = drainInbox(agent)
    if (!items.length) return
    // Everyone still sees everything — that is the point of the board. A link
    // adds precedence: a wired peer is talking to you, not announcing to a room,
    // so their messages go first and are labelled as directed.
    const wired = linkedPeers(agent)
    const direct = items.filter((i) => wired.has(i.agent))
    const rest = items.filter((i) => !wired.has(i.agent))
    const fmt = (i: (typeof items)[number]) =>
      `  [${i.agent} · ${i.kind} · ${ago(i.created_at)}] ${i.body}`

    const sections: string[] = []
    if (direct.length) {
      sections.push(
        `Directly from the agent(s) you are linked to — treat this as addressed to you:\n${direct.map(fmt).join('\n')}`,
      )
    }
    if (rest.length) sections.push(`From your other peers since your last turn:\n${rest.map(fmt).join('\n')}`)

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: sections.join('\n\n') },
      }),
    )
    return
  }

  if (event === 'touch') {
    const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path
    if (file) {
      const root = projectRoot()
      recordTouch(agent, file.startsWith(root) ? file.slice(root.length + 1) : file)
    }
    return
  }

  if (event === 'stop') {
    setAgentStatus(agent, 'idle')
    try {
      scanWip()
    } catch {
      /* fine */
    }
    writeBriefDetached(agent, payload.transcript_path)
  }
}


async function ask(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(question)
  rl.close()
  return answer.trim().toLowerCase()
}

/**
 * Claude Code asks whether you trust a folder the first time it opens one, and
 * every pane asks separately — so without this the first run looks like four
 * dead terminals. It is a safety prompt, so parley asks rather than assuming.
 */
async function ensureTrust(): Promise<void> {
  const root = projectRoot()
  if (isProjectTrusted(root) || !process.stdin.isTTY) return
  console.log(`\nFirst run in ${root}`)
  console.log('Claude Code will ask each agent separately whether you trust this folder.')
  const answer = await ask('Answer it once now, for this project? [Y/n] ')
  if (answer === 'n' || answer === 'no') {
    console.log('Fine — answer the prompt in each pane instead.\n')
    return
  }
  console.log(
    trustProject(root)
      ? 'Done (previous config saved to ~/.claude.json.parley-bak).\n'
      : 'Could not update ~/.claude.json — answer the prompt in each pane instead.\n',
  )
}

async function main(): Promise<void> {
  const [cmd, ...rest] = positionals()

  // Check flags before doing anything. `map` in particular kicks off minutes of
  // real model calls, so a typo'd flag has to stop here rather than be
  // discovered afterwards from the bill.
  const resolved = cmd ?? 'up'
  if (resolved in KNOWN_FLAGS && rejectUnknownFlags(resolved)) return

  switch (cmd) {
    // No argument opens the workspace. Everything interactive lives in there.
    case undefined:
    case 'up': {
      ensurePty()
      await ensureTrust()
      const ids = flag('agents') ? flag('agents').split(',').map((s) => s.trim()).filter(Boolean) : []
      const { startTui } = await import('./tui.ts')
      startTui(ids, {
        permissionMode: flag('permission-mode', 'acceptEdits'),
        model: flag('model') || undefined,
        // Off by default: a ready task otherwise starts itself the instant
        // you open the workspace, with no chance to look at the board first.
        // Pass --auto to get the old always-on behavior back.
        auto: argv.includes('--auto'),
      })
      return
    }

    case 'goal': {
      const goal = rest.join(' ')
      if (!goal) return console.log('parley goal "what you want to happen"')
      // Set by the TUI once a proposal is approved, to scope the real
      // decomposition to just the agents the human signed off on. Omitted —
      // the normal case for this command run from a plain shell — it
      // advertises the full library, same as always.
      const rosterIds = flag('roster') ? flag('roster').split(',').map((s) => s.trim()).filter(Boolean) : []
      const roster = rosterIds.length ? allPersonas().filter((p) => rosterIds.includes(p.id)) : undefined
      console.log(`planning: ${goal}\n`)
      const planned = plan(goal, roster)
      if (!planned.length) return console.log('planner returned nothing — try a more specific goal')
      const ids = commitPlan(goal, planned)
      planned.forEach((t, i) => {
        const deps = (t.deps ?? []).map((d) => `#${ids[d]}`).filter(Boolean)
        console.log(
          `  #${ids[i]} ${t.title}  → ${t.owner || 'unassigned'} (${t.model || 'default'})` +
            (deps.length ? `  after ${deps.join(' ')}` : ''),
        )
      })
      console.log(`\n${ids.length} task(s). Anything with no unmet dependency starts as soon as an agent is free.`)
      return
    }

    // Internal: the TUI spawns this detached, the same way it spawns `goal`,
    // so the cheap scoping pass never blocks rendering. Plain `propose "<goal>"`
    // writes a fresh pending proposal; `--refine <id>` revises the one at that
    // id in place instead of creating a new row, using the human's reply as
    // context for the revision.
    case 'propose': {
      const goal = rest.join(' ')
      if (!goal) return console.log('parley propose "what you want to happen"')
      const refineId = flag('refine')
      const reply = flag('reply')
      if (refineId && reply) {
        const prior = getProposal(Number(refineId))
        if (!prior) return console.log(`no such proposal: ${refineId}`)
        const revised = proposeAgents(goal, {
          prior: { agents: JSON.parse(prior.agents_json), note: prior.note, answer: prior.answer },
          reply,
        })
        updateProposal(prior.id, { agents_json: JSON.stringify(revised.agents), note: revised.note, answer: revised.answer })
      } else {
        const proposal = proposeAgents(goal)
        addProposal(goal, JSON.stringify(proposal.agents), proposal.note)
      }
      return
    }

    case 'status':
      try {
        scanWip()
      } catch {
        /* not a git repo */
      }
      console.log(renderWho())
      console.log(`\n${renderGraph()}`)
      console.log(renderVerification())
      return

    case 'review':
      console.log(writeReview(rest[0] ?? ''))
      return

    case 'explain': {
      const topic = rest.join(' ')
      if (!topic) return console.log('parley explain <file, function, or term>')
      console.log(explain(topic))
      return
    }

    case 'quiz': {
      const items = makeQuiz(Number(rest[0]) || 5)
      if (!items.length) return console.log('Nothing to quiz on yet — it fills in as changes land.')
      // Answers are withheld until you press enter: producing the answer before
      // seeing it is the entire point, and a printed answer removes it.
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      for (const [i, item] of items.entries()) {
        console.log(`\n${'─'.repeat(60)}\n${i + 1}/${items.length}  ${item.question}\n`)
        await rl.question('your answer (enter to reveal) > ')
        console.log(`\n${item.answer}\n\nWhy it matters: ${item.why}`)
      }
      rl.close()
      console.log(`\n${'─'.repeat(60)}\nparley explain <term> to go deeper on any of these.`)
      return
    }

    case 'add': {
      const role = rest[0]
      if (!role || !allPersonas().some((p) => p.id === role)) {
        console.log(`parley add <role> — roles: ${allPersonas().map((p) => p.id).join(', ')}`)
        return
      }
      pushIntent('add', role, flag('model'))
      console.log(`queued: ${role}${flag('model') ? ` (${flag('model')})` : ''} — takes effect only while a parley workspace is running`)
      return
    }

    case 'kill': {
      const id = rest[0]
      if (!id) return console.log('parley kill <agent-id>')
      pushIntent('kill', id)
      console.log(`queued: kill ${id} — takes effect only while a parley workspace is running`)
      return
    }

    case 'wires':
      console.log(renderWiring())
      return

    // The architecture map. `--show` prints the stored one; bare rebuilds it.
    // `--agent` prints the compact form an agent gets injected before working,
    // which is the form with measured value.
    case 'map': {
      const { buildMap, saveMap, loadMap, loadMapCorrected } = await import('./map/index.ts')
      const { forAgent, forHuman, estimateTokens } = await import('./map/render.ts')
      const root = projectRoot()
      const dir = stateDir(root)

      // Pinned human corrections: a separate surface from the map build/verify
      // flow above, because they live in their own file (corrections.json,
      // next to map.json — see corrections.ts for why) and never call a model.
      // `rest` here is everything after "map corrections".
      if (rest[0] === 'corrections') {
        const {
          loadCorrections,
          saveCorrections,
          staleCorrections,
          hashStatement,
          makeAnchor,
          newCorrectionId,
        } = await import('./map/corrections.ts')
        const sub = rest[1]
        const corrections = loadCorrections(dir)
        const existing = loadMap(dir)
        const region = (id: string) => existing?.regions.find((r) => r.id === id)

        const usage = () => {
          console.log('Usage:')
          console.log('  parley map corrections [list]')
          console.log('  parley map corrections label <regionId> "<new label>"')
          console.log('  parley map corrections purpose <regionId> "<new purpose>"')
          console.log('  parley map corrections suppress <regionId> "<statement text>" [--reason "..."]')
          console.log('  parley map corrections claim <regionId> "<statement>" --files a.ts,b.ts [--kind mechanism|invariant|gotcha]')
          console.log('  parley map corrections remove label|purpose <regionId>')
          console.log('  parley map corrections remove suppress <regionId> <hash>')
          console.log('  parley map corrections remove claim <id>')
          console.log('(region ids come from `parley map --show`)')
        }

        if (!sub || sub === 'list') {
          const stale = existing?.fileHashes ? staleCorrections(corrections, existing.fileHashes) : []
          const staleTag = (kind: 'region' | 'suppression' | 'humanClaim', regionId: string, key?: string) =>
            stale.some((s) => s.kind === kind && s.regionId === regionId && (!key || s.key === key)) ? ' [STALE — anchor files changed]' : ''

          const overrides = Object.values(corrections.regionOverrides)
          const suppressions = Object.values(corrections.suppressions)
          const claims = Object.values(corrections.humanClaims).flat()
          if (!overrides.length && !suppressions.length && !claims.length) {
            console.log('No corrections pinned yet.\n')
            usage()
            return
          }
          for (const ov of overrides) {
            if (ov.label) console.log(`label    ${ov.regionId}: "${ov.label}"${staleTag('region', ov.regionId)}`)
            if (ov.purpose) console.log(`purpose  ${ov.regionId}: "${ov.purpose.slice(0, 80)}"${staleTag('region', ov.regionId)}`)
          }
          for (const s of suppressions) {
            console.log(`suppress ${s.regionId} ${s.statementHash.slice(0, 10)}: "${s.statementPreview.slice(0, 80)}"${staleTag('suppression', s.regionId, s.statementHash)}`)
          }
          for (const c of claims) {
            console.log(`claim    ${c.regionId} ${c.id.slice(0, 8)} (${c.kind}): "${c.statement.slice(0, 80)}"${staleTag('humanClaim', c.regionId, c.id)}`)
          }
          return
        }

        if (sub === 'label' || sub === 'purpose') {
          const regionId = rest[2]
          const text = rest.slice(3).join(' ')
          if (!regionId || !text) return usage()
          const r = region(regionId)
          if (!r) return console.log(`No region "${regionId}" in the current map. Run \`parley map --show\` to see region ids.`)
          const prior = corrections.regionOverrides[regionId]
          corrections.regionOverrides[regionId] = {
            regionId,
            label: sub === 'label' ? text : prior?.label,
            purpose: sub === 'purpose' ? text : prior?.purpose,
            anchor: makeAnchor(root, r.files),
            createdAt: Date.now(),
          }
          saveCorrections(dir, corrections)
          console.log(`Pinned ${sub} override for "${regionId}", anchored to ${r.files.length} file(s).`)
          return
        }

        if (sub === 'suppress') {
          const regionId = rest[2]
          const statement = rest.slice(3).join(' ')
          if (!regionId || !statement) return usage()
          const r = region(regionId)
          // Anchor to the actual claim's own citations when the claim is
          // still present, for a tighter drift signal than the whole region.
          const matching = r?.narrative.claims.find((c) => hashStatement(c.statement) === hashStatement(statement))
          const anchorFiles = matching?.files ?? r?.files ?? []
          const key = `${regionId}:${hashStatement(statement)}`
          corrections.suppressions[key] = {
            regionId,
            statementHash: hashStatement(statement),
            statementPreview: statement,
            anchor: makeAnchor(root, anchorFiles),
            reason: flag('reason') || undefined,
            createdAt: Date.now(),
          }
          saveCorrections(dir, corrections)
          console.log(`Suppressed in "${regionId}". Reappears hidden automatically if the model regenerates the same statement.`)
          return
        }

        if (sub === 'claim') {
          const regionId = rest[2]
          const statement = rest.slice(3).join(' ')
          const files = flag('files').split(',').map((f) => f.trim()).filter(Boolean)
          const kind = flag('kind', 'mechanism') as 'mechanism' | 'invariant' | 'gotcha'
          if (!regionId || !statement || !files.length) return usage()
          const id = newCorrectionId()
          corrections.humanClaims[regionId] = [
            ...(corrections.humanClaims[regionId] ?? []),
            { id, regionId, statement, files, kind, anchor: makeAnchor(root, files), createdAt: Date.now() },
          ]
          saveCorrections(dir, corrections)
          console.log(`Added human claim ${id.slice(0, 8)} to "${regionId}", anchored to ${files.length} file(s).`)
          return
        }

        if (sub === 'remove') {
          const kind = rest[2]
          const a = rest[3]
          const b = rest[4]
          if (kind === 'label' || kind === 'purpose') {
            const ov = corrections.regionOverrides[a]
            if (!ov) return console.log(`No ${kind} override for "${a}".`)
            delete ov[kind]
            if (!ov.label && !ov.purpose) delete corrections.regionOverrides[a]
            saveCorrections(dir, corrections)
            return console.log(`Removed ${kind} override for "${a}".`)
          }
          if (kind === 'suppress') {
            const key = Object.keys(corrections.suppressions).find((k) => k === `${a}:${b}` || (a && k.startsWith(`${a}:`) && k.includes(b ?? '')))
            if (!key) return console.log(`No suppression matching "${a} ${b ?? ''}".`)
            delete corrections.suppressions[key]
            saveCorrections(dir, corrections)
            return console.log(`Removed suppression ${key}.`)
          }
          if (kind === 'claim') {
            for (const [regionId, list] of Object.entries(corrections.humanClaims)) {
              const idx = list.findIndex((c) => c.id === a || c.id.startsWith(a ?? ''))
              if (idx >= 0) {
                list.splice(idx, 1)
                if (!list.length) delete corrections.humanClaims[regionId]
                saveCorrections(dir, corrections)
                return console.log(`Removed claim from "${regionId}".`)
              }
            }
            return console.log(`No human claim with id "${a}".`)
          }
          return usage()
        }

        console.log(`Unknown corrections subcommand "${sub}".\n`)
        usage()
        return
      }

      // Re-judge a stored map's claims against current code, without paying to
      // re-describe anything. Worth its own entry point because it is two things
      // at once: validation when a map is new, and *drift detection* later —
      // a claim that was supported and is now contradicted is precisely the
      // signal that the map has gone stale against the code.
      if (argv.includes('--verify')) {
        const existing = loadMap(dir)
        if (!existing) return console.log('No map yet. Run `parley map` first.')
        const { verifyClaims } = await import('./map/verify.ts')
        let supported = 0
        let judged = 0
        for (const region of existing.regions) {
          const claims = region.verified?.length ? region.verified : region.narrative.claims
          if (!claims.length) continue
          const verdicts = await verifyClaims(root, claims, 6)
          region.verified = verdicts
          const kept = verdicts.filter((c) => c.verdict === 'supported')
          region.narrative = { ...region.narrative, claims: kept }
          judged += verdicts.length
          supported += kept.length
          // Persist per region, matching the build path. Verifying a whole map
          // is many minutes of model calls; losing all of it to a late failure
          // is the same mistake the build path already learned not to make.
          saveMap(dir, existing)
          console.log(`  ${region.label}: ${kept.length}/${verdicts.length} supported`)
          for (const bad of verdicts.filter((c) => c.verdict !== 'supported')) {
            console.log(`    ${bad.verdict.toUpperCase()}: ${bad.statement.slice(0, 100)}`)
          }
        }
        saveMap(dir, existing)
        console.log(`\n${supported}/${judged} claims survived falsification (${Math.round((100 * supported) / Math.max(1, judged))}%)`)
        return
      }

      if (argv.includes('--show') || argv.includes('--agent')) {
        // Corrected, not raw: this is the one render-facing path, so it is
        // where a pinned human correction actually takes effect. --verify
        // above stays on `loadMap` deliberately — re-verification is a model
        // pass over the map's own claims and must never see human-injected
        // ones (see corrections.ts on why those carry no verdict to recheck).
        const existing = loadMapCorrected(dir)
        if (!existing) return console.log('No map yet. Run `parley map` to build one.')
        const text = argv.includes('--agent') ? forAgent(existing) : forHuman(existing)
        console.log(text)
        if (argv.includes('--agent')) console.log(`\n[~${estimateTokens(text)} tokens]`)
        return
      }

      // Incremental by default: a prior map on disk is diffed against the
      // current tree so only what actually changed gets re-narrated and
      // re-verified. `--full` skips loading it, which forces buildMap down
      // its original from-scratch path.
      const map = await buildMap(
        root,
        (msg) => console.log(`  ${msg}`),
        (partial) => saveMap(dir, partial),
        argv.includes('--full') ? null : loadMap(dir),
      )
      const path = saveMap(dir, map)
      console.log(`\n${map.regions.length} components mapped. Saved to ${path}`)
      const claims = map.regions.reduce((n, r) => n + r.narrative.claims.length, 0)
      const unknowns = map.regions.reduce((n, r) => n + r.narrative.unknowns.length, 0)
      console.log(`${claims} anchored claims, ${unknowns} explicit unknowns`)
      if (map.groupingUnconfirmed) {
        console.log('Component boundaries were proposed automatically — review them with `parley map --show`.')
      }
      return
    }

    case 'prompt': {
      const role = rest[0]
      if (!role) {
        console.log(allPersonas().map((p) => `${p.id}  ${p.title}`).join('\n'))
        return
      }
      const p = persona(role)
      console.log(`You are "${p.title}" (agent id: ${role}).\n\n${p.prompt}\n\n${PROTOCOL}`)
      return
    }

    // Internal: run by the hooks and by the Stop hook's detached tutor.
    case 'brief':
      writeBrief(flag('agent'), flag('transcript') || undefined)
      return

    case 'hook':
      await hook(rest[0] ?? '')
      return

    default:
      console.log(HELP)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
