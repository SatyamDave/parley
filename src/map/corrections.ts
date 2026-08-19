// Layer 3.75: pinned human corrections.
//
// Every layer above this one can be wrong, and the map already has machinery
// for saying so out loud (unknowns, unsupported verdicts, staleness). What it
// has no machinery for is a human *fixing* something and having the fix
// survive the next rebuild. Rebuilds regenerate narrate.ts's prose from
// scratch, so a correction anchored to the regenerated text itself would be
// destroyed the moment it was needed again. Everything here is keyed to
// something that does NOT get regenerated:
//
//   - a region label/purpose override is keyed by region id. Region ids come
//     from directory paths (regions.ts), so they are stable across rebuilds
//     even though the prose describing them is not.
//   - a claim suppression is keyed by a hash of the claim's own statement
//     text. If the model regenerates the identical wrong claim, the hash
//     matches and it is hidden again with zero human effort. If the model
//     stops producing it — because the code changed, or because narrate.ts
//     phrased it differently this time — the hash simply never matches again.
//     That is a feature, not a gap: a suppression that no longer applies
//     should fall away on its own rather than require manual cleanup.
//   - a human-authored claim is keyed by its own id (there is no model
//     original to key against) and carries `human: true` so it is never
//     silently confused for something the model said.
//
// The second, harder-won property: a correction is not a way to freeze a lie.
// Every correction records the files it was anchored to and their content
// hash at the moment a human made the call. If those files change afterward,
// `staleCorrections` reports it and `applyCorrections` surfaces the flag in
// the map — the correction keeps winning the display (a human still knows
// more than a fresh model call did), but it stops being presented as settled.
// The human wins on precedence, never on being unfalsifiable.
//
// This file never calls a model and never touches map.json — see index.ts and
// cli.ts for where it is wired in. Corrections live in their own file
// (corrections.json, alongside map.json in the same state dir) specifically
// so a map rebuild — which recreates map.json from nothing — cannot discard
// them by construction, not because some merge step remembered to preserve
// them.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SystemMap, MappedRegion } from './index.ts'
import type { Claim } from './narrate.ts'

const CORRECTIONS_FILE = 'corrections.json'

/** What a correction is pinned to: the files it was made against, and their
 *  content hash at that moment. Same hash algorithm as computeFileHashes in
 *  index.ts (sha1 of raw file bytes) so an anchor hash compares directly
 *  against `SystemMap.fileHashes` without any conversion. */
export type Anchor = {
  files: string[]
  hashes: Record<string, string>
}

export type RegionOverride = {
  regionId: string
  /** Replaces the region's displayed label when set. */
  label?: string
  /** Replaces the region's narrative purpose paragraph when set. */
  purpose?: string
  anchor: Anchor
  note?: string
  createdAt: number
}

export type ClaimSuppression = {
  regionId: string
  /** The addressable key — see the header note on why this, not the
   *  statement text itself, is what a suppression matches against. */
  statementHash: string
  /** For a human re-reading corrections.json. Never matched against. */
  statementPreview: string
  anchor: Anchor
  reason?: string
  createdAt: number
}

export type HumanClaim = {
  /** Own identity, since (unlike a suppression) there is no model original to
   *  key against — a human claim is new content, not a correction of old. */
  id: string
  regionId: string
  statement: string
  /** Same discipline the model is held to in narrate.ts: a claim with no file
   *  anchor can never be checked for drift, so it is not accepted. */
  files: string[]
  kind: 'mechanism' | 'invariant' | 'gotcha'
  anchor: Anchor
  note?: string
  createdAt: number
}

export type Corrections = {
  /** Keyed by region id — one override per region. */
  regionOverrides: Record<string, RegionOverride>
  /** Keyed by `${regionId}:${statementHash}`, scoped to a region so the same
   *  wrong sentence appearing in two different components can be suppressed
   *  independently. */
  suppressions: Record<string, ClaimSuppression>
  /** Keyed by region id; a region may have several human claims. */
  humanClaims: Record<string, HumanClaim[]>
}

function emptyCorrections(): Corrections {
  return { regionOverrides: {}, suppressions: {}, humanClaims: {} }
}

/** Missing file (nothing pinned yet) and a corrupt file are the same case
 *  from every caller's point of view: there is nothing safe to apply. This
 *  must never throw — a hand-edited or half-written corrections.json cannot
 *  be allowed to take down a map build or a render, matching how loadMap
 *  treats a bad map.json. */
export function loadCorrections(dir: string): Corrections {
  try {
    const raw = JSON.parse(readFileSync(join(dir, CORRECTIONS_FILE), 'utf8')) as Partial<Corrections>
    return {
      regionOverrides: raw.regionOverrides ?? {},
      suppressions: raw.suppressions ?? {},
      humanClaims: raw.humanClaims ?? {},
    }
  } catch {
    return emptyCorrections()
  }
}

export function saveCorrections(dir: string, corrections: Corrections): string {
  const path = join(dir, CORRECTIONS_FILE)
  writeFileSync(path, JSON.stringify(corrections, null, 2))
  return path
}

/** Normalized before hashing so incidental whitespace/case differences don't
 *  defeat a match against an otherwise-identical regenerated claim. Anything
 *  beyond that (a genuinely reworded sentence) is out of scope by design —
 *  see the header note on why fuzzy re-matching was rejected as the
 *  addressing mechanism. */
export function hashStatement(statement: string): string {
  return createHash('sha1').update(statement.trim().toLowerCase()).digest('hex')
}

function hashFile(root: string, path: string): string | null {
  try {
    return createHash('sha1').update(readFileSync(join(root, path))).digest('hex')
  } catch {
    return null // unreadable at anchor time — left out, matching computeFileHashes
  }
}

/** Build an anchor from the files a correction is being pinned to, at the
 *  moment it is made. This is the only function here that touches disk —
 *  it runs once, at correction-creation time in the CLI, not on every
 *  render. */
export function makeAnchor(root: string, files: string[]): Anchor {
  const hashes: Record<string, string> = {}
  for (const f of files) {
    const h = hashFile(root, f)
    if (h) hashes[f] = h
  }
  return { files, hashes }
}

export type StaleCorrection = {
  kind: 'region' | 'suppression' | 'humanClaim'
  regionId: string
  /** Which of the anchor's files are gone or modified since the correction
   *  was made — the concrete evidence a human is shown to decide whether the
   *  correction still holds. */
  changedFiles: string[]
  /** statementHash for a suppression, id for a human claim; absent for a
   *  region override, which has only one per region. */
  key?: string
}

/** A file counts as drifted if it is gone from the current hash set, or its
 *  hash no longer matches what was recorded at anchor time. Absence and
 *  modification are both "the ground moved under this correction" — neither
 *  is proof the correction is now wrong, only that it has not been checked
 *  against the current code and must not be presented as if it had been. */
function anchorDrift(anchor: Anchor, fileHashes: Record<string, string>): string[] {
  return anchor.files.filter((f) => fileHashes[f] === undefined || fileHashes[f] !== anchor.hashes[f])
}

/**
 * Which corrections were anchored to files that have since changed. Pure and
 * cheap — this is the mechanism that stops a pinned correction from freezing
 * a lie: it does not un-pin anything by itself, it only reports the drift so
 * `applyCorrections` (and the CLI) can flag it rather than silently trusting
 * a correction whose basis no longer exists.
 */
export function staleCorrections(corrections: Corrections, fileHashes: Record<string, string>): StaleCorrection[] {
  const out: StaleCorrection[] = []
  for (const [regionId, ov] of Object.entries(corrections.regionOverrides)) {
    const changed = anchorDrift(ov.anchor, fileHashes)
    if (changed.length) out.push({ kind: 'region', regionId, changedFiles: changed })
  }
  for (const s of Object.values(corrections.suppressions)) {
    const changed = anchorDrift(s.anchor, fileHashes)
    // `key` is the statement hash alone (not the `${regionId}:${hash}` map
    // key it lives under in `corrections.suppressions`) so callers can match
    // it against `ClaimSuppression.statementHash` directly, the same way a
    // human claim's `key` is its bare id rather than a compound one.
    if (changed.length) out.push({ kind: 'suppression', regionId: s.regionId, changedFiles: changed, key: s.statementHash })
  }
  for (const [regionId, list] of Object.entries(corrections.humanClaims)) {
    for (const hc of list) {
      const changed = anchorDrift(hc.anchor, fileHashes)
      if (changed.length) out.push({ kind: 'humanClaim', regionId, changedFiles: changed, key: hc.id })
    }
  }
  return out
}

/**
 * Apply corrections to an already-built, already-verified map. Pure: no model
 * calls, no disk writes, and (deliberately) no disk reads either — staleness
 * is judged from `map.fileHashes`, which the map already carries, not by
 * re-hashing anything here. Region overrides win on label/purpose, claims
 * whose statement hash is suppressed are dropped, and human claims are
 * appended and marked `human: true` so they can never be mistaken for model
 * output downstream (see render.ts).
 *
 * `region.verified` is never touched — the model's own falsification record
 * stays exactly as buildMap produced it, for audit, even where a human has
 * overridden what gets shown.
 */
export function applyCorrections(map: SystemMap, corrections: Corrections): SystemMap {
  // Staleness can only be judged against a map that actually recorded file
  // hashes at build time. A map saved before that field existed gets no
  // staleness verdicts rather than a false "everything is stale" from
  // comparing every anchor against an empty object — the same precedent
  // diffFiles in index.ts sets for "no prior hashes": treated as "cannot
  // tell", never as "assume drift".
  const stale = map.fileHashes ? staleCorrections(corrections, map.fileHashes) : []
  const staleRegions = new Set(stale.filter((s) => s.kind === 'region').map((s) => s.regionId))
  const staleHumanClaims = new Set(stale.filter((s) => s.kind === 'humanClaim').map((s) => s.key))

  const regions: MappedRegion[] = map.regions.map((region) => {
    const override = corrections.regionOverrides[region.id]
    const humanClaims = corrections.humanClaims[region.id] ?? []

    // Suppress by statement hash. A model claim regenerated with the exact
    // same wrong text hashes the same and is hidden again automatically;
    // anything else was never a match to begin with. Suppression is not
    // conditioned on its own staleness — a claim once judged false stays
    // hidden even if its anchor moved, on the theory that "hidden but
    // flagged for review" is safer than "unhidden by default". The CLI's
    // `corrections list` surfaces the flag for that review.
    const survivors = region.narrative.claims.filter(
      (c) => !(`${region.id}:${hashStatement(c.statement)}` in corrections.suppressions),
    )

    // Human claims are placed first, not appended, so a component's most
    // trusted content leads — including surviving any later truncation to a
    // fixed number of "must-know" bullets in render.ts. This is the display
    // precedence the design calls for: a human claim outranks a model claim,
    // it does not merely tie with one.
    const humanAsClaims: Claim[] = humanClaims.map((hc) => ({
      statement: hc.statement,
      evidence: hc.files,
      files: hc.files,
      kind: hc.kind,
      human: true,
      stale: staleHumanClaims.has(hc.id),
    }))

    const narrative = {
      ...region.narrative,
      purpose: override?.purpose ?? region.narrative.purpose,
      claims: [...humanAsClaims, ...survivors],
    }

    const correction = override
      ? {
          labelOverridden: !!override.label,
          purposeOverridden: !!override.purpose,
          stale: staleRegions.has(region.id),
        }
      : undefined

    return {
      ...region,
      label: override?.label ?? region.label,
      narrative,
      correction,
    }
  })

  return { ...map, regions }
}

/** Convenience for anything that wants a fresh id for a new human claim. */
export function newCorrectionId(): string {
  return randomUUID()
}
