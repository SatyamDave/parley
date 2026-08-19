// Assembling the map from its layers, and persisting it.
//
// The layering is the whole point and is worth restating where it is composed:
// layer 1 (skeleton) and layer 2 (regions) are deterministic and cheap; layer 3
// (narrative) is the only model call and is bounded per region. That ordering is
// what keeps a wrong sentence from becoming a wrong edge.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildSkeleton } from './skeleton.ts'
import type { Skeleton, SourceFile } from './skeleton.ts'
import { decompose } from './regions.ts'
import type { Decomposition, Region } from './regions.ts'
import { narrateRegion, proposeGrouping } from './narrate.ts'
import type { Narrative } from './narrate.ts'
import { verifyClaims } from './verify.ts'
import type { VerifiedClaim } from './verify.ts'
import { applyCorrections, loadCorrections } from './corrections.ts'

export type MappedRegion = Region & {
  narrative: Narrative
  /** Every claim with its falsification verdict. Contradicted and unsupported
   *  claims are kept here rather than deleted so a human can audit the judge —
   *  but only supported ones are rendered as fact. */
  verified?: VerifiedClaim[]
  /** Region ids this one depends on, and which depend on it. */
  dependsOn: string[]
  dependedOnBy: string[]
  /** When this region's narrative was last reconciled against real code. Drives
   *  the visible-staleness rule: a region nobody has checked recently must look
   *  uncertain rather than authoritative. */
  narratedAt: number
  /** Set only by applyCorrections (corrections.ts), never by buildMap itself —
   *  buildMap's own output only ever reflects the model. Present when a human
   *  has overridden this region's label and/or purpose; `stale` is true when
   *  the files that override was anchored to have since changed, so it must
   *  be shown as needing re-examination rather than presented as settled. */
  correction?: {
    labelOverridden: boolean
    purposeOverridden: boolean
    stale: boolean
  }
}

export type SystemMap = {
  root: string
  builtAt: number
  regions: MappedRegion[]
  roles: Record<string, import('./regions.ts').Role>
  /** Kept so a later run can tell whether the skeleton moved under the
   *  narrative — the cheap half of drift detection. */
  fileCount: number
  edgeCount: number
  /** True when the grouping came from a model and no human has confirmed it. */
  groupingUnconfirmed: boolean
  /** SHA-1 of every file's content at build time, keyed by repo-relative path.
   *  The next build diffs against this to classify files as unchanged,
   *  modified, added, or deleted — the only thing that makes a rebuild
   *  incremental instead of starting over. Optional because a map saved
   *  before this existed has no such record; that case is treated as "cannot
   *  diff", not as a crash. */
  fileHashes?: Record<string, string>
}

const MAP_FILE = 'map.json'

/**
 * Regions large enough that a directory name isn't describing a component get a
 * model-proposed semantic grouping. Flagged unconfirmed until a human says
 * otherwise — grouping is a judgment, and the design only permits the model to
 * make it as a proposal.
 */
async function regroup(
  skeleton: Skeleton,
  decomposition: Decomposition,
): Promise<{ regions: Region[]; unconfirmed: boolean }> {
  if (!decomposition.needsSemanticGrouping) return { regions: decomposition.regions, unconfirmed: false }

  const out: Region[] = []
  let unconfirmed = false
  for (const region of decomposition.regions) {
    if (region.files.length <= 8) {
      out.push(region)
      continue
    }
    const proposal = await proposeGrouping(skeleton, region)
    unconfirmed = true
    for (const [i, group] of proposal.regions.entries()) {
      out.push({
        id: `${region.id}-${i + 1}`,
        label: group.label,
        files: group.files,
        origin: 'cluster',
      })
    }
  }
  return { regions: out, unconfirmed }
}

/** Regions are independent, so they narrate concurrently. Sequential narration
 *  took over twenty minutes on a 24-file repo — almost all of it waiting — which
 *  would be hopeless at real repository scale. Concurrency is bounded because
 *  each unit here is a separate model process, not a cheap promise. */
const NARRATE_CONCURRENCY = 4

async function mapConcurrently<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// The three functions below are exported for one reason: they decide what gets
// re-narrated and re-verified, so a bug in them silently serves stale claims as
// current fact — the exact failure this map layer exists to prevent. Private
// functions cannot be unit tested, and "verified by one happy-path run" is not
// coverage for logic this consequential. Exported so the edge cases (deletions,
// added files reshaping a region, a prior map with no hashes at all) are pinned
// down by tests rather than argued about.

/** SHA-1 of each file's current content, keyed by repo-relative path. Pure and
 *  cheap — this is the only new fact incremental rebuild needs from disk, and
 *  it never touches a model. A file that vanishes between the skeleton walk
 *  and hashing is simply left out; the next diff will see it as gone. */
export function computeFileHashes(root: string, files: SourceFile[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) {
    try {
      out[f.path] = createHash('sha1').update(readFileSync(join(root, f.path))).digest('hex')
    } catch {
      /* vanished since the walk — not this build's problem */
    }
  }
  return out
}

export type FileDiff = {
  /** Every path that is new, different, or gone — the set that can invalidate
   *  something that cited it. */
  changed: Set<string>
  added: string[]
  modified: string[]
  deleted: string[]
}

/** Classify the tree against the previous build's recorded hashes. */
export function diffFiles(current: Record<string, string>, prior: Record<string, string>): FileDiff {
  const added: string[] = []
  const modified: string[] = []
  for (const [path, hash] of Object.entries(current)) {
    if (!(path in prior)) added.push(path)
    else if (prior[path] !== hash) modified.push(path)
  }
  const deleted = Object.keys(prior).filter((p) => !(p in current))
  return { changed: new Set([...added, ...modified, ...deleted]), added, modified, deleted }
}

/**
 * True when a region is safe to skip re-narrating: the prior build had a
 * region of the same id, holding exactly the same files, none of which
 * changed. Regions are derived from the file tree, so an add/remove anywhere
 * in the region counts as membership changing even if every remaining file's
 * content is identical.
 */
export function regionUnchanged(region: Region, prior: MappedRegion | undefined, changedFiles: Set<string>): boolean {
  if (!prior) return false
  if (region.files.length !== prior.files.length) return false
  const priorSet = new Set(prior.files)
  if (region.files.some((f) => !priorSet.has(f))) return false
  return region.files.every((f) => !changedFiles.has(f))
}

/** Shared tail of both the full-verify and drift-recheck paths: decide what
 *  survives, log it, and fold the (possibly filtered) claims back into the
 *  narrative. Mirrors the original single-path loop body exactly. */
function finalizeVerification(region: MappedRegion, verified: VerifiedClaim[], say: (msg: string) => void): void {
  region.verified = verified
  // Only 'contradicted' means false. 'unsupported' often means true but
  // anchored to the wrong file — the link-priority claim was rejected against
  // store.ts because that behaviour actually lives in cli.ts's inbox hook.
  // Deleting those loses real knowledge, so they are kept and marked instead;
  // only supported claims are ever presented as established fact.
  const kept = verified.filter((c) => c.verdict !== 'contradicted')
  const refuted = verified.length - kept.length
  const unproven = kept.filter((c) => c.verdict === 'unsupported').length
  say(`  ${region.label}: ${verified.length - refuted - unproven} confirmed, ${unproven} unproven, ${refuted} refuted`)
  region.narrative = { ...region.narrative, claims: kept }
}

export async function buildMap(
  root: string,
  onProgress?: (msg: string) => void,
  checkpoint?: (partial: SystemMap) => void,
  /** The previous build's map, when one exists and the caller has not asked
   *  for a full rebuild. Diffed against the current tree to skip re-narrating
   *  and re-verifying anything untouched. Omit (or pass null) to get exactly
   *  the old full-rebuild-every-time behavior — the default for any caller
   *  that hasn't been updated to pass one. */
  priorMap?: SystemMap | null,
): Promise<SystemMap> {
  const say = onProgress ?? (() => {})

  say('reading structure')
  const skeleton = buildSkeleton(root)

  say(`${skeleton.files.length} files, ${skeleton.edges.length} edges — decomposing`)
  const first = decompose(skeleton)
  const { regions, unconfirmed } = await regroup(skeleton, first)
  // Re-derive crossings against the final regions so edges match what is shown.
  const settled = decompose(skeleton, regions)

  const fileHashes = computeFileHashes(root, skeleton.files)

  const base = {
    root,
    builtAt: Date.now(),
    roles: settled.roles,
    fileCount: skeleton.files.length,
    edgeCount: skeleton.edges.length,
    groupingUnconfirmed: unconfirmed,
    fileHashes,
  }

  // No prior hashes means there is nothing to diff against — the map predates
  // this feature, or the caller forced a full rebuild. Either way `diff` stays
  // null and every region below takes the original, always-narrate path.
  const diff = priorMap?.fileHashes ? diffFiles(fileHashes, priorMap.fileHashes) : null
  const priorByRegion = new Map((priorMap?.regions ?? []).map((r) => [r.id, r]))
  if (diff) {
    say(`comparing against previous map: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted`)
  }

  say(`describing ${settled.regions.length} components (${NARRATE_CONCURRENCY} at a time)`)
  const done: MappedRegion[] = []
  const reusedRegionIds = new Set<string>()
  const mapped = await mapConcurrently(settled.regions, NARRATE_CONCURRENCY, async (region) => {
    const prior = priorByRegion.get(region.id)
    const canReuse = diff !== null && regionUnchanged(region, prior, diff.changed)

    const result: MappedRegion =
      canReuse && prior
        ? {
            ...region,
            narrative: prior.narrative,
            verified: prior.verified,
            dependsOn: settled.crossings.filter((c) => c.from === region.id).map((c) => c.to),
            dependedOnBy: settled.crossings.filter((c) => c.to === region.id).map((c) => c.from),
            // Kept, not restamped — nothing was actually re-checked, and
            // claiming otherwise would be exactly the false confidence this
            // whole layer exists to avoid.
            narratedAt: prior.narratedAt,
          }
        : {
            ...region,
            narrative: await narrateRegion(root, skeleton, region, settled),
            dependsOn: settled.crossings.filter((c) => c.from === region.id).map((c) => c.to),
            dependedOnBy: settled.crossings.filter((c) => c.to === region.id).map((c) => c.from),
            narratedAt: Date.now(),
          }

    if (canReuse) {
      reusedRegionIds.add(region.id)
      say(`  ${region.label}: unchanged, narrative kept (${result.narrative.claims.length} claims)`)
    } else {
      say(`  ${region.label} (${result.narrative.claims.length} claims)`)
    }
    done.push(result)
    // Persist as we go. Losing a whole build to a late failure is what made the
    // first attempt at this so expensive.
    checkpoint?.({ ...base, regions: [...done] })
    return result
  })
  if (diff) say(`${reusedRegionIds.size}/${settled.regions.length} components unchanged, narration skipped`)

  // Falsify every claim before anyone is asked to trust it. This is the layer
  // that exists because a confidently wrong map measurably cost an agent more
  // than having no map at all.
  const claimsTotal = mapped.reduce((n, r) => n + r.narrative.claims.length, 0)
  say(`verifying ${claimsTotal} claims`)
  let checked = 0
  let driftCount = 0
  for (const region of mapped) {
    // A reused region's claims already carry a verdict from the prior build.
    // Most of the time nothing they cite has moved and they can stand as-is —
    // zero model calls. But a claim's evidence can cite a file outside its own
    // region (a cross-region citation), so "region unchanged" does not imply
    // "every claim in it is still safe": check per claim, against the whole
    // diff, not just this region's files.
    if (diff && reusedRegionIds.has(region.id) && region.verified) {
      const priorVerified = region.verified
      const toRecheck = priorVerified.filter((c) => c.files.some((f) => diff.changed.has(f)))
      if (!toRecheck.length) {
        say(`  ${region.label}: unchanged, ${priorVerified.length} claims kept from previous verification`)
        continue
      }
      const rechecked = await verifyClaims(root, toRecheck, 6, () => {
        checked++
      })
      const byIdentity = new Map(toRecheck.map((c, i) => [c, rechecked[i]]))
      // This is drift detection: a claim the map once verified as true, now
      // failing the same check against the current code, means the code moved
      // out from under the map rather than the map having been wrong all along.
      for (const before of toRecheck) {
        const after = byIdentity.get(before)
        if (after && before.verdict === 'supported' && after.verdict !== 'supported') {
          driftCount++
          say(`  DRIFT — ${region.label}: was supported, now ${after.verdict}: "${before.statement.slice(0, 80)}"`)
        }
      }
      const merged = priorVerified.map((c) => byIdentity.get(c) ?? c)
      finalizeVerification(region, merged, say)
      checkpoint?.({ ...base, regions: mapped })
      continue
    }

    // Fresh narration, or a reused region whose prior verification data is
    // missing (e.g. a checkpoint saved before the verify pass reached it) —
    // either way there is no verdict to trust, so check every claim.
    const verified = await verifyClaims(root, region.narrative.claims, 6, () => {
      checked++
      if (checked % 20 === 0) say(`  verified ${checked}/${claimsTotal}`)
    })
    finalizeVerification(region, verified, say)
    checkpoint?.({ ...base, regions: mapped })
  }
  if (diff) say(`drift check: ${driftCount} claim(s) that were previously supported no longer are`)

  return { ...base, regions: mapped }
}

export function saveMap(dir: string, map: SystemMap): string {
  const path = join(dir, MAP_FILE)
  writeFileSync(path, JSON.stringify(map, null, 2))
  return path
}

export function loadMap(dir: string): SystemMap | null {
  try {
    return JSON.parse(readFileSync(join(dir, MAP_FILE), 'utf8')) as SystemMap
  } catch {
    return null
  }
}

/**
 * `loadMap` plus pinned human corrections (corrections.ts), for every caller
 * that renders or hands the map to an agent. This is the wiring that keeps a
 * correction from being an opt-in step someone forgets: any code that wants
 * what a human actually approved, rather than the raw model output, should
 * call this instead of `loadMap` directly.
 *
 * Deliberately not folded into `buildMap`/`saveMap`: corrections must never
 * be baked into map.json (map.json is what a rebuild regenerates from
 * scratch — see corrections.ts's header), so the merge happens here, at read
 * time, and is recomputed fresh on every call rather than persisted.
 */
export function loadMapCorrected(dir: string): SystemMap | null {
  const map = loadMap(dir)
  return map ? applyCorrections(map, loadCorrections(dir)) : null
}
