// Layer 3 of the map: what each region actually is, in plain language.
//
// This is the only place a model touches the map, and it is deliberately
// fenced in. Measured hallucination rates on code summarization run to ~66%
// baseline, and the best published mitigation only reaches 59% — so the design
// assumes the model will sometimes be wrong and makes that detectable rather
// than pretending it won't be:
//
//   - The model never originates structure. Files, edges, and roles all arrive
//     from layer 1 and are passed in as given facts.
//   - Every claim carries provenance (which files support it). A claim with no
//     evidence anchor can never be invalidated later, which would make drift
//     detection impossible.
//   - UNKNOWN is a valid, expected answer. Copied from RIG's anti-hallucination
//     design, which is the one approach with measured agent-side gains.
//
// The one judgment the model is allowed to make is *grouping* — and only as a
// proposal a human confirms, after which it is pinned. Grouping is cheap for a
// human to verify (look at five buckets of files, say yes or no) in a way that
// an invariant claim is not, which is why it is a defensible exception.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Async on purpose. The synchronous version made concurrency impossible:
// execFileSync blocks Node's entire event loop, so narrating regions "in
// parallel" still ran strictly one at a time and a 24-file repo took over
// twenty minutes.
//
// `spawn` rather than execFile because the prompt has to go in on stdin, and
// execFile offers no way to write it — see runClaude for why argv is not an
// option here.

/** Run the model with the prompt on stdin, resolving its raw stdout. Rejects
 *  only on a spawn-level failure; a non-zero exit resolves with whatever was
 *  written, so the caller's own parse guard decides what to do. */
function runWithStdin(file: string, args: string[], prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: { ...process.env, PARLEY_AGENT: '', PARLEY_DIR: '' },
    })
    let out = ''
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(() => reject(new Error('timeout')))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', (e) => done(() => reject(e)))
    child.on('close', () => done(() => resolve(out)))
    // EPIPE if the child died before reading — already covered by 'error'.
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}
import type { Skeleton } from './skeleton.ts'
import type { Decomposition, Region } from './regions.ts'

// 6000 was too small and produced a specific, instructive failure: on an
// 894-line file the model correctly reported "no DatabaseSync() call is shown"
// as an unknown — because it genuinely wasn't in the slice it received. Honest
// answer, wrong input. Per-symbol chunking is the real fix; until then the
// budget is large enough for a whole file of parley's scale, and truncation is
// disclosed in the prompt so the model never infers absence from it.
const MAX_FILE_CHARS = 24_000

/**
 * Models cite evidence as prose, not as bare paths — the real observed shape is
 * `"src/store.ts:2 — import statement: import { DatabaseSync } ..."`. Requiring
 * an exact path match silently discarded every claim, so this pulls the path out
 * of the citation and validates *that*, keeping the human-readable citation
 * intact for display.
 */
export function resolveCitation(citation: string, known: Set<string>): string | null {
  const head = citation.trim().split(/[\s:,]/)[0]
  if (!head) return null
  if (known.has(head)) return head
  const bare = head.replace(/^\.\//, '')
  if (known.has(bare)) return bare
  // A basename like "store.ts" is only safe to accept when exactly one known
  // path ends with it on a component boundary — parley already learned this
  // lesson in watch.ts, where loose suffix matching misattributed files.
  const matches = [...known].filter((k) => k === bare || k.endsWith(`/${bare}`))
  return matches.length === 1 ? matches[0] : null
}

/**
 * Returns null rather than throwing when the model doesn't produce parseable
 * structured output. This is not defensive padding — it happened: a schema'd
 * call answered conversationally ("I already ..."), the unguarded parse threw,
 * and it killed a 20-minute map build that had already completed four regions.
 * One uncooperative response must degrade one region, never the whole map.
 */
async function runClaude(prompt: string, schema: string, model?: string): Promise<unknown | null> {
  const args = [
    '-p',
    '--model',
    model ?? process.env.PARLEY_MAP_MODEL ?? 'haiku',
    // No tools. Two reasons, and the correctness one matters more than the
    // speed one: everything the model is allowed to assert must come from the
    // context we handed it, or its citations can name files outside the region
    // and the provenance model quietly breaks. It also stops the call spending
    // turns re-reading files we already pasted in.
    '--disallowed-tools',
    'Read',
    'Grep',
    'Glob',
    'Bash',
    'Edit',
    'Write',
    'WebFetch',
    'WebSearch',
    '--output-format',
    'json',
    '--json-schema',
    schema,
  ]
  let raw: string
  try {
    // The prompt goes on stdin, never in argv. Linux caps a single argument at
    // 128 KB and a region's narration prompt is MAX_FILE_CHARS (24 KB) per
    // file — so any region of six or more files would die with E2BIG on Linux
    // while working fine on macOS. CI caught the same bug in tutor.ts by
    // running both platforms; this is the same fix applied before it could bite.
    raw = await runWithStdin(process.env.PARLEY_CLAUDE ?? 'claude', args, prompt, 300_000)
  } catch {
    return null
  }
  try {
    const outer = JSON.parse(raw) as { result?: unknown }
    const result = outer.result ?? outer
    return typeof result === 'string' ? JSON.parse(result) : result
  } catch {
    return null
  }
}

// --- the grouping proposal -------------------------------------------------

const GROUPING_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short name for this component, e.g. "The Board" or "Agent Runtime"' },
          files: { type: 'array', items: { type: 'string' }, description: 'Exact repo-relative paths from the list given' },
          why: { type: 'string', description: 'One sentence: what makes these one component rather than separate ones' },
        },
        required: ['label', 'files', 'why'],
      },
    },
  },
  required: ['regions'],
})

export type ProposedGrouping = { regions: { label: string; files: string[]; why: string }[] }

/**
 * Ask for a semantic grouping of files that directories failed to decompose.
 * The result is a *proposal* — callers must have a human confirm it before it
 * becomes pinned truth.
 *
 * Every file is validated back against the skeleton afterwards, because a
 * hallucinated path would silently corrupt the map's foundation.
 */
export async function proposeGrouping(skeleton: Skeleton, region: Region): Promise<ProposedGrouping> {
  const facts = region.files
    .map((path) => {
      const f = skeleton.files.find((x) => x.path === path)
      if (!f) return `- ${path}`
      const imports = f.imports.length ? ` imports: ${f.imports.join(', ')}` : ''
      const exports = f.exports.length ? ` exports: ${f.exports.slice(0, 8).join(', ')}` : ''
      return `- ${path} (${f.loc} lines)${exports}${imports}`
    })
    .join('\n')

  const prompt = `Group these files into the components a senior engineer would draw on a whiteboard to explain this system.

Files, with their real exports and internal imports (these are facts from static analysis — do not contradict them):
${facts}

Rules:
- Use ONLY the exact paths listed above. Never invent a path.
- Every file must appear in exactly one component.
- Group by what the code is *for*, not by naming similarity. Two files that share a prefix may belong to different components; two files with unrelated names may be one component.
- The import structure is strong evidence: a file everything depends on is usually its own foundational component, not a member of one of its consumers.
- Prefer 3-6 components. One component holding most of the files means you have not decomposed anything.
- "label" is what a human reads. Name the component for its job ("The Board", "Agent Runtime"), not its folder.`

  const parsed = ((await runClaude(prompt, GROUPING_SCHEMA)) ?? {}) as Partial<ProposedGrouping>
  const known = new Set(region.files)
  const regions = (parsed.regions ?? [])
    .map((r) => ({ ...r, files: (r.files ?? []).filter((f) => known.has(f)) }))
    .filter((r) => r.files.length)

  // Any file the model dropped or hallucinated away still has to land
  // somewhere — a silently missing file is a corrupt map.
  const placed = new Set(regions.flatMap((r) => r.files))
  const missed = region.files.filter((f) => !placed.has(f))
  if (missed.length) regions.push({ label: '(ungrouped)', files: missed, why: 'Not assigned by the grouping pass.' })

  return { regions }
}

// --- the narrative ---------------------------------------------------------

const NARRATIVE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    purpose: { type: 'string', description: 'What this component is and does. 2-3 sentences, plain language, no jargon unless decoded.' },
    claims: {
      type: 'array',
      description: 'Specific factual statements about how it works. Each must be supported by the files given.',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths supporting this. Required.' },
          kind: { type: 'string', enum: ['mechanism', 'invariant', 'gotcha'] },
        },
        required: ['statement', 'evidence', 'kind'],
      },
    },
    unknowns: {
      type: 'array',
      items: { type: 'string' },
      description: "Things you could not determine from the code. Say so here rather than guessing.",
    },
  },
  required: ['purpose', 'claims', 'unknowns'],
})

export type Claim = {
  statement: string
  /** The model's own citations, as written — kept because they carry line
   *  numbers and read better than bare paths. */
  evidence: string[]
  /** Citations resolved to real repo paths. This is what drift detection
   *  anchors to; a claim with none of these is dropped. */
  files: string[]
  kind: 'mechanism' | 'invariant' | 'gotcha'
  /** Set only by corrections.ts, never by narrateRegion: true when a human
   *  wrote this claim directly rather than a model. Kept on the claim itself
   *  (not inferred from context) so it can never be silently indistinguishable
   *  from generated text once it reaches render.ts. */
  human?: boolean
  /** Only meaningful when `human` is true: the files this claim was anchored
   *  to have changed since a human wrote it, so it must be shown as needing
   *  re-examination rather than settled fact — see corrections.ts. */
  stale?: boolean
}
export type Narrative = { purpose: string; claims: Claim[]; unknowns: string[] }

/**
 * Describe one region. Bounded to that region's files so cost stays linear in
 * repo size and a wrong answer is contained rather than contaminating the map.
 */
export async function narrateRegion(
  root: string,
  skeleton: Skeleton,
  region: Region,
  decomposition: Decomposition,
): Promise<Narrative> {
  const bodies = region.files
    .map((path) => {
      let full = ''
      try {
        full = readFileSync(join(root, path), 'utf8')
      } catch {
        return null
      }
      const text = full.slice(0, MAX_FILE_CHARS)
      // Disclose truncation explicitly. Without this the model reads a partial
      // file and reports things as absent that are simply below the cut.
      const note =
        full.length > MAX_FILE_CHARS
          ? ` [TRUNCATED — showing first ${MAX_FILE_CHARS} of ${full.length} chars. Do NOT conclude anything is absent from this file.]`
          : ''
      return `--- ${path}${note} ---\n${text}`
    })
    .filter(Boolean)
    .join('\n\n')

  const rolesHere = region.files
    .map((f) => `${f}: ${decomposition.roles[f] ?? 'middle'}`)
    .join(', ')
  const inbound = decomposition.crossings.filter((c) => c.to === region.id)
  const outbound = decomposition.crossings.filter((c) => c.from === region.id)
  const edgeFacts = [
    inbound.length ? `Depended on by: ${inbound.map((c) => c.from).join(', ')}` : '',
    outbound.length ? `Depends on: ${outbound.map((c) => c.to).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const prompt = `Describe this component of a codebase for someone who has to understand it well enough to review changes to it.

COMPONENT: ${region.label}
Files: ${region.files.join(', ')}
Structural roles (from static analysis — facts): ${rolesHere}
${edgeFacts}

Source:
${bodies}

Rules that matter more than completeness:
- Every entry in "claims" must be supported by the source above, and must list the file paths that support it in "evidence". A claim you cannot anchor to a file is one you must not make.
- If you cannot tell what something is for, put it in "unknowns". UNKNOWN is a correct answer and is strongly preferred over a plausible guess.
- Do not describe what the code obviously says line by line. Describe the mechanism: what this component guarantees, what would break if it were wrong, what a newcomer would get wrong about it.
- "invariant" = something that must stay true here. "gotcha" = non-obvious knowledge that isn't visible in the code. "mechanism" = how it works.
- Explain, never sell. No "robust", "powerful", "seamless", "comprehensive".
- Never claim anything is tested or verified unless the source shows it.`

  const raw = await runClaude(prompt, NARRATIVE_SCHEMA)
  if (!raw) {
    // Degrade this region rather than the map. A region that says plainly that
    // it could not be described is honest and fixable; a crashed build is not.
    return {
      purpose: 'UNKNOWN',
      claims: [],
      unknowns: ['The description pass failed for this component — rerun `parley map` to retry it.'],
    }
  }
  const parsed = raw as Partial<Narrative>
  const known = new Set(skeleton.files.map((f) => f.path))

  // Drop claims whose evidence doesn't resolve to a real file. An unanchored
  // claim can never be invalidated by drift detection, which makes it
  // permanently unfalsifiable — worse than no claim at all.
  const claims: Claim[] = (parsed.claims ?? [])
    .map((c) => {
      const evidence = c.evidence ?? []
      const files = [...new Set(evidence.map((e) => resolveCitation(e, known)).filter((f): f is string => !!f))]
      return { statement: c.statement, kind: c.kind ?? 'mechanism', evidence, files }
    })
    .filter((c) => c.statement && c.files.length)

  return {
    purpose: parsed.purpose ?? 'UNKNOWN',
    claims,
    unknowns: parsed.unknowns ?? [],
  }
}
