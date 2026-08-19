// Rendering the map as text.
//
// Two audiences, one artifact. The agent-facing form is the one with measured
// value: RIG showed a deterministic, evidence-backed architectural map of
// ~5,000 tokens improved commercial agents' task accuracy by 12.2% and cut
// completion time by 53.9%. So `forAgent` is budget-conscious on purpose —
// beyond a few thousand tokens it stops being context and starts being noise.
import type { SystemMap, MappedRegion } from './index.ts'
import type { Claim } from './narrate.ts'

/** Rough token estimate. Good enough to keep the agent map inside its budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Not all regions are architecture. The first real map of parley put claims
 * about the A/B harness and about `bin/parley.mjs`'s shebang line in the same
 * must-know list as the dispatch interlocks — technically true, useless to an
 * agent about to change dispatch, and expensive in a fixed token budget.
 *
 * Support code is demoted rather than dropped: it is still part of the system,
 * it just does not get to crowd out the parts that carry invariants.
 */
const SUPPORT_DIRS = ['test/', 'tests/', 'scripts/', 'bin/', '__tests__/', 'spec/']

function isSupportRegion(files: string[]): boolean {
  return files.length > 0 && files.every((f) => SUPPORT_DIRS.some((d) => f.startsWith(d)))
}

/**
 * Higher sorts first. Hubs and heavily-depended-on regions lead, support trails.
 *
 * Deliberately not weighted by file count: a big region is not an important one,
 * and counting size put the three-file UI surface ahead of the single-file state
 * store that the entire system depends on.
 */
function importance(region: { files: string[]; dependedOnBy: string[] }, roles: Record<string, string>): number {
  if (isSupportRegion(region.files)) return -1
  const hubs = region.files.filter((f) => roles[f] === 'hub').length
  return hubs * 10 + region.dependedOnBy.length * 5
}

/** No single region may flood the must-know list. */
const MAX_CRITICAL_PER_REGION = 4

function staleness(narratedAt: number): string {
  const days = (Date.now() - narratedAt) / 86_400_000
  if (days < 1) return ''
  if (days < 7) return ` [checked ${Math.round(days)}d ago]`
  return ` [STALE — last checked ${Math.round(days)}d ago, verify before trusting]`
}

/** The one string that marks anything human-authored or human-overridden —
 *  shared so a claim tag and a region tag read identically. `stale` means the
 *  files this was anchored to have changed since a human made the call: the
 *  correction still wins the display, but must not pass as settled. */
function humanTag(stale: boolean): string {
  return stale ? ' [HUMAN — STALE, files changed since: re-examine]' : ' [HUMAN]'
}

/** A human override outranks the model, but must never look like the model's
 * own words — see corrections.ts for why. */
function correctionNote(region: Pick<MappedRegion, 'correction'>): string {
  if (!region.correction) return ''
  const what = [region.correction.labelOverridden && 'label', region.correction.purposeOverridden && 'purpose']
    .filter(Boolean)
    .join('+')
  return ` [HUMAN ${what} OVERRIDE${region.correction.stale ? ' — STALE, files changed since: re-examine' : ''}]`
}

/** Same idea, per claim: a human-authored claim (added via `parley map
 *  corrections claim`) is never mixed into the unmarked model claims below. */
function claimTag(c: Claim): string {
  return c.human ? humanTag(!!c.stale) : ''
}

/**
 * The compact form handed to an agent before it works. Ordered so the most
 * load-bearing thing comes first: invariants and gotchas are what a per-task
 * agent cannot infer locally and is most likely to violate.
 */
export function forAgent(map: SystemMap, budgetTokens = 5000, includeUnknowns = false): string {
  const lines: string[] = [
    'SYSTEM MAP — the architecture of this repository.',
    'This is established, evidence-backed knowledge about this codebase. Trust it as a starting point rather than re-deriving it: it exists so you do not make a locally-sensible change that breaks a system-level guarantee.',
    '',
  ]

  if (map.groupingUnconfirmed) {
    lines.push('NOTE: this grouping was proposed automatically and not yet confirmed by a human. Treat component boundaries as provisional; treat file lists and edges as reliable.', '')
  }

  // A human claim/override outranks a model one, but must never be silently
  // indistinguishable from it — this legend is only spent when there is
  // something to explain, so a map with no corrections costs nothing here.
  if (map.regions.some((r) => r.correction || r.narrative.claims.some((c) => c.human))) {
    lines.push(
      'NOTE: entries marked [HUMAN] were written directly by a person who owns this codebase, not generated — trust them above unmarked claims unless flagged STALE, which means the files they were anchored to have since changed and they need re-examination.',
      '',
    )
  }

  // Ranked so the parts that carry invariants lead and support code trails.
  const ranked = [...map.regions].sort((a, b) => importance(b, map.roles) - importance(a, map.roles))

  // Invariants and gotchas first, across the whole system — these are the
  // highest-value-per-token content for an agent about to change something.
  const critical: string[] = []
  for (const r of ranked) {
    if (isSupportRegion(r.files)) continue // support code has no architectural invariants worth this space
    // Only claims that survived falsification are stated as fact here. Anything
    // merely unrefuted appears in its component body marked unproven — a wrong
    // claim in this section is the single most expensive thing the map can do.
    // Human claims bypass this check: they never went through verifyClaims in
    // the first place (corrections.ts makes zero model calls), so there is no
    // verdict to look up — that is not the same as being unverified-and-shown-
    // anyway, it is why they carry their own [HUMAN] tag instead.
    const verdictOf = new Map((r.verified ?? []).map((v) => [v.statement, v.verdict]))
    const here = r.narrative.claims
      .filter((c) => c.kind === 'invariant' || c.kind === 'gotcha')
      .filter((c) => c.human || (r.verified?.length ? verdictOf.get(c.statement) === 'supported' : true))
      .slice(0, MAX_CRITICAL_PER_REGION)
    for (const c of here) critical.push(`- [${r.label}]${claimTag(c)} ${c.statement}`)
  }
  if (critical.length) {
    lines.push('MUST-KNOW (invariants and non-obvious behaviour):', ...critical, '')
  }

  lines.push('COMPONENTS:')
  for (const r of ranked) {
    lines.push('')
    lines.push(`## ${r.label}${staleness(r.narratedAt)}${correctionNote(r)}`)
    lines.push(`files: ${r.files.join(', ')}`)
    if (r.dependsOn.length) lines.push(`depends on: ${r.dependsOn.join(', ')}`)
    if (r.dependedOnBy.length) lines.push(`depended on by: ${r.dependedOnBy.join(', ')}`)
    lines.push(`${r.narrative.purpose}${r.correction?.purposeOverridden ? humanTag(r.correction.stale) : ''}`)
    const verdicts = new Map((r.verified ?? []).map((v) => [v.statement, v.verdict]))
    const mechanisms = r.narrative.claims.filter((c) => c.kind === 'mechanism')
    for (const c of mechanisms) {
      // '?' marks a claim nothing refuted but nothing confirmed either. Saying
      // so is the difference between a map that is trusted and one that is
      // trusted where it deserves to be. A human claim never went through that
      // check at all — it gets its own tag (claimTag) instead of either mark.
      const mark = c.human ? 'H ' : verdicts.get(c.statement) === 'unsupported' ? '? ' : '· '
      lines.push(`  ${mark}${c.statement}${claimTag(c)}`)
    }
    // Unknowns are deliberately off by default for the agent view. They took 14%
    // of the token budget, and handing an agent a list of open questions about
    // the codebase reads as a research assignment — the first A/B pair showed the
    // map doubling an agent's tool-call turns rather than reducing them. The
    // human view still shows them, because being honest about gaps is the point
    // there; an agent just needs what we actually know.
    if (includeUnknowns && r.narrative.unknowns.length) {
      lines.push(`  UNKNOWN here: ${r.narrative.unknowns.join(' | ')}`)
    }
  }

  let text = lines.join('\n')
  // Trim from the tail if over budget: the must-know section and component
  // headers matter more than the last region's mechanism detail.
  if (estimateTokens(text) > budgetTokens) {
    const keep = budgetTokens * 4
    text = `${text.slice(0, keep)}\n\n[truncated to fit context budget — full map via \`parley map --show\`]`
  }
  return text
}

/** The human-facing form: same content, laid out to be read rather than parsed. */
export function forHuman(map: SystemMap): string {
  const lines: string[] = [
    `SYSTEM MAP — ${map.root}`,
    `${map.regions.length} components · ${map.fileCount} files · ${map.edgeCount} internal imports`,
    `built ${new Date(map.builtAt).toISOString().slice(0, 16).replace('T', ' ')}`,
  ]
  if (map.groupingUnconfirmed) {
    lines.push('', '⚠ component boundaries were proposed automatically and are not yet confirmed')
  }

  for (const r of map.regions) {
    lines.push('', '─'.repeat(70), `${r.label}${staleness(r.narratedAt)}${correctionNote(r)}`, '')
    lines.push(`${r.narrative.purpose}${r.correction?.purposeOverridden ? humanTag(r.correction.stale) : ''}`, '')
    lines.push(`  files        ${r.files.join(', ')}`)
    if (r.dependsOn.length) lines.push(`  depends on   ${r.dependsOn.join(', ')}`)
    if (r.dependedOnBy.length) lines.push(`  used by      ${r.dependedOnBy.join(', ')}`)

    const by = (kind: string) => r.narrative.claims.filter((c) => c.kind === kind)
    for (const [kind, label] of [
      ['invariant', 'MUST STAY TRUE'],
      ['gotcha', 'NON-OBVIOUS'],
      ['mechanism', 'HOW IT WORKS'],
    ] as const) {
      const items = by(kind)
      if (!items.length) continue
      lines.push('', `  ${label}`)
      for (const c of items) lines.push(`    · ${c.statement}${claimTag(c)}`, `      ↳ ${c.files.join(', ')}`)
    }
    if (r.narrative.unknowns.length) {
      lines.push('', '  NOT DETERMINED FROM CODE')
      for (const u of r.narrative.unknowns) lines.push(`    ? ${u}`)
    }
  }
  return lines.join('\n')
}
