// Layer 3.5: falsifying the map's own claims before anyone trusts them.
//
// This layer exists because of a measured failure, not a theoretical worry. The
// first real map of parley asserted, in its must-know section and with correct
// provenance, that on release "the task's status remains 'claimed' (not
// 'open')". src/store.ts:266 reads
// `UPDATE tasks SET status = 'open', owner = NULL` — exactly backwards. An agent
// given that map spent 19 tool-call turns on a question the same agent answered
// in 9 turns with no map at all: +111% turns, +250% time. A confidently wrong
// map is worse than no map.
//
// The lesson that reshaped the design: **provenance is not a correctness check.**
// Anchoring a claim to a file proves the model looked in the right place and
// makes the claim invalidatable later. It does nothing to establish that the
// claim is true. Those are separate properties and the original design conflated
// them.
//
// So each claim is re-examined by a fresh call asked to *disprove* it, seeing
// only the files it cites. Framing matters: a model asked to "check" a
// plausible statement tends to agree, while one asked to find the contradiction
// will actually go looking.
//
// Claims are batched by which file(s) they cite rather than verified one at a
// time. The first version sent one claim per call, and on parley's own map that
// meant src/store.ts's ~30k-char source was retransmitted 11 separate times —
// once per claim about it — paying full input cost each time for identical
// content. Grouping by cited file means each file's content is sent once,
// carrying every claim it needs to answer for. Same verdicts, a fraction of the
// tokens.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Claim } from './narrate.ts'

const exec = promisify(execFile)
const MAX_EVIDENCE_CHARS = 30_000
// Cap per call so the response schema stays small enough for the model to fill
// in reliably, and one call verifies a manageable claim set even if a single
// file turns out to anchor many.
const MAX_CLAIMS_PER_CALL = 12

export type Verdict = 'supported' | 'contradicted' | 'unsupported'

export type VerifiedClaim = Claim & {
  verdict: Verdict
  /** Why, when the claim did not survive. Kept so a human can audit the judge. */
  note: string
}

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      description: 'One entry per claim, in the same order the claims were given.',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'integer', description: 'The CLAIM number this verdict answers, matching the numbering given.' },
          verdict: {
            type: 'string',
            enum: ['supported', 'contradicted', 'unsupported'],
            description:
              "'contradicted' = the source shows the opposite or something materially different. 'unsupported' = the source neither shows nor refutes it. 'supported' = the source demonstrably shows it.",
          },
          note: { type: 'string', description: 'If not supported, quote or cite the specific line that settles it.' },
        },
        required: ['claim', 'verdict', 'note'],
      },
    },
  },
  required: ['verdicts'],
})

/** Verify every claim in one group against the shared evidence text they all
 *  cite. Returns one verdict per input claim, defaulting to 'unsupported' for
 *  any the model's response drops rather than silently promoting it. */
async function judgeBatch(claims: Claim[], evidence: string): Promise<{ verdict: Verdict; note: string }[]> {
  const numbered = claims.map((c, i) => `CLAIM ${i + 1}: ${c.statement}`).join('\n\n')

  const prompt = `Try to DISPROVE each of the following claims about this source code. Assume each is wrong until the source shows otherwise. Judge every claim independently — one being true says nothing about another.

${numbered}

This is the complete source the claims cite. Nothing outside it is available, and you may not assume anything not shown here:
${evidence}

For EACH claim, decide:
- "contradicted" — the source shows the opposite, or something materially different from what the claim says. Quote the line that proves it.
- "unsupported" — the source does not settle the question either way. A claim you cannot confirm from this source is unsupported, not supported.
- "supported" — the source demonstrably shows the claim to be true.

Be pedantic about SUBSTANCE, not about wording. If a claim names a value, a status, a flag, an order of operations, or a condition, check that exact detail — a claim that is directionally right but names the wrong value is "contradicted".

But do not reject a claim for how it is phrased:
- Different vocabulary for the same thing is NOT a contradiction. Judge the mechanism, not the terminology.
- Paraphrase, summary, and informal description are fine.
- If a claim has several parts and most hold but one is not shown here, that is "unsupported", not "contradicted". Reserve "contradicted" for the source actively showing otherwise.

Most important: **absence of evidence is never a contradiction.** If you cannot find the code a claim describes, the correct verdict is "unsupported". Any file marked TRUNCATED above is incomplete, so the described behaviour may well exist below the cut. Only answer "contradicted" when you can point at something in this source that is actively inconsistent with the claim.

Return one verdict per claim, numbered to match.`

  try {
    const { stdout } = await exec(
      process.env.PARLEY_CLAUDE ?? 'claude',
      [
        '-p',
        '--model',
        process.env.PARLEY_VERIFY_MODEL ?? 'haiku',
        // Same reasoning as the narrator: the judge must rule on the evidence it
        // was handed, not go wandering for extra context.
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
        SCHEMA,
        prompt,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000, env: { ...process.env, PARLEY_AGENT: '', PARLEY_DIR: '' } },
    )
    const outer = JSON.parse(stdout) as { result?: unknown }
    const r = outer.result ?? outer
    const parsed = (typeof r === 'string' ? JSON.parse(r) : r) as {
      verdicts?: { claim?: number; verdict?: Verdict; note?: string }[]
    }
    const byNumber = new Map((parsed.verdicts ?? []).map((v) => [v.claim, v]))
    return claims.map((_, i) => {
      const v = byNumber.get(i + 1)
      // A claim number the model dropped from its response must not be
      // silently promoted — that would be the same failure mode as a claim
      // that was never checked at all.
      return v ? { verdict: v.verdict ?? 'unsupported', note: v.note ?? '' } : { verdict: 'unsupported', note: 'no verdict returned for this claim in its batch' }
    })
  } catch {
    // A judge that could not run must not silently promote any claim in the batch.
    return claims.map(() => ({ verdict: 'unsupported' as Verdict, note: 'verification did not complete' }))
  }
}

function readEvidence(root: string, files: string[]): string {
  return files
    .map((p) => {
      try {
        const full = readFileSync(join(root, p), 'utf8')
        // Truncation must be disclosed. The same bug was found and fixed in the
        // narrator and then not carried here originally, and it produced exactly
        // the failure you would predict: large files got cut, the judge found no
        // supporting line, and ruled "contradicted" from absence rather than
        // "unsupported". Several demonstrably true claims were wrongly rejected
        // that way before this note was added.
        const note =
          full.length > MAX_EVIDENCE_CHARS
            ? ` [TRUNCATED — first ${MAX_EVIDENCE_CHARS} of ${full.length} chars only]`
            : ''
        return `--- ${p}${note} ---\n${full.slice(0, MAX_EVIDENCE_CHARS)}`
      } catch {
        return null
      }
    })
    .filter((x): x is string => !!x)
    .join('\n\n')
}

/**
 * Verify every claim, grouped by the set of files it cites so each file's
 * content is transmitted once no matter how many claims depend on it, then
 * chunked to a manageable batch size per call. Groups run concurrently; the
 * return value is in the same order as the input claims regardless of how
 * they were batched internally.
 */
export async function verifyClaims(
  root: string,
  claims: Claim[],
  concurrency = 6,
  onVerdict?: (c: VerifiedClaim) => void,
): Promise<VerifiedClaim[]> {
  const out: VerifiedClaim[] = new Array(claims.length)

  const groups = new Map<string, number[]>()
  for (let i = 0; i < claims.length; i++) {
    const key = [...claims[i].files].sort().join('|')
    groups.set(key, [...(groups.get(key) ?? []), i])
  }

  // Chunk any oversized group so one call never has to juggle too many claims
  // at once — this is about response reliability, not cost, since the file
  // content (the expensive part) is still shared across the chunk's calls via
  // the same evidence string, only rebuilt from the same source read.
  const batches: number[][] = []
  for (const indices of groups.values()) {
    for (let i = 0; i < indices.length; i += MAX_CLAIMS_PER_CALL) {
      batches.push(indices.slice(i, i + MAX_CLAIMS_PER_CALL))
    }
  }

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const b = next++
      if (b >= batches.length) return
      const indices = batches[b]
      const batchClaims = indices.map((i) => claims[i])
      const files = [...new Set(batchClaims.flatMap((c) => c.files))]
      const evidence = readEvidence(root, files)

      const verdicts = evidence
        ? await judgeBatch(batchClaims, evidence)
        : batchClaims.map(() => ({ verdict: 'unsupported' as Verdict, note: 'cited files could not be read' }))

      indices.forEach((claimIndex, j) => {
        out[claimIndex] = { ...claims[claimIndex], ...verdicts[j] }
        onVerdict?.(out[claimIndex])
      })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker))
  return out
}

/** Only supported claims belong in a map anyone is asked to trust. */
export function keepSupported(claims: VerifiedClaim[]): VerifiedClaim[] {
  return claims.filter((c) => c.verdict === 'supported')
}
