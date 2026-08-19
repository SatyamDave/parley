// The education layer. After an agent finishes a turn, a separate headless
// claude reads the diff it produced and explains it to you — at the level of a
// product manager who wants to actually understand the machine, not be
// reassured about it.
//
// It runs out-of-process on purpose: the coding agent cannot skip it to save
// tokens, and the explanation never competes for room in the coding context.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addBrief,
  briefs,
  decisions,
  glossary,
  learnTerm,
  markBriefed,
  post,
  projectRoot,
  stateDir,
  unbriefedTouches,
} from './store.ts'
import { ago } from './render.ts'
import { SRC } from './spawn.ts'

const MAX_DIFF = 40_000
const MAX_REVIEW_DIFF = 180_000

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Six words or fewer, plain language' },
    markdown: { type: 'string', description: 'The brief itself' },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: { term: { type: 'string' }, definition: { type: 'string' } },
        required: ['term', 'definition'],
      },
    },
  },
  required: ['title', 'markdown', 'terms'],
})

const TUTOR_PROMPT = `You are the tutor in a tool called parley. Your reader is a strong product thinker who ships software daily with AI agents and wants to genuinely understand the systems being built for them — not to be flattered, and not to be handed a summary they cannot act on.

Write a brief about the change below. Assume the reader is smart and has no context on this specific code. Use these sections:

## What changed
Plain language. No jargon at all in this section — if a term is unavoidable, use the everyday word and save the real term for the decoder. Say what the software can now do that it could not before, or what stopped being broken.

## Why it matters
The consequence a product person would care about: what a user notices, what risk went away, what became possible next. If the honest answer is "nothing user-visible, this is groundwork," say that plainly and explain what it unblocks.

## Where this sits
Locate it in the system. What calls this code, what it calls, what would break if it vanished. One small ASCII diagram if — and only if — the shape is genuinely easier to see than to read.

## Jargon decoder
Every term in this diff a non-engineer would trip on. Format: **term** — what it means here, in one or two sentences, using this codebase as the example rather than a generic definition. Skip terms the reader has clearly met many times before; prefer the three that actually matter to this change.

## How it actually works
One level deeper than the summary. The mechanism: the order things happen in, the data structure chosen, the reason this approach and not the obvious alternative. This is the section that teaches — spend the most words here. Explain the *why* behind the design, not a line-by-line narration of the diff.

## Worth watching
Tradeoffs taken, failure modes now possible, what will hurt at scale. Be specific and honest — if the change has a real weakness, name it. Do not invent concerns to fill the section; if there is genuinely nothing notable, say so in one line.

Rules:
- Explain, never sell. No "robust", "powerful", "seamless", "comprehensive".
- Be concrete. Name real files, real functions, real values from the diff.
- If the diff is trivial, write a short brief. Length should track substance.
- Never claim something was verified or tested unless the material below shows it.
- You may be given what the agents posted while working — decisions, findings, blockers. Where a post explains a choice, use it: that is first-hand reasoning you cannot reconstruct from a diff. Where the diff contradicts a post, trust the diff and say so.
- No emojis.

Return JSON: title (six words or fewer), markdown (the brief, starting at "## What changed"), and terms (the jargon decoder entries as structured data, for the running glossary).`

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** What the agent actually did: uncommitted first, else the last commit. */
function gatherDiff(root: string, files: string[]): string {
  let diff = git(['diff', 'HEAD', '--', ...files], root)
  if (!diff.trim()) diff = git(['log', '-1', '-p', '--', ...files], root)
  if (!diff.trim()) {
    // Not a git repo, or brand new files git has never seen.
    diff = files
      .filter((f) => existsSync(join(root, f)))
      .map((f) => `--- ${f} ---\n${readFileSync(join(root, f), 'utf8').slice(0, 8000)}`)
      .join('\n\n')
  }
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n\n[diff truncated]` : diff
}

/** The last thing the human asked for — the intent behind the diff. */
function lastUserPrompt(transcript?: string): string {
  if (!transcript || !existsSync(transcript)) return ''
  try {
    const lines = readFileSync(transcript, 'utf8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as { type?: string; message?: { content?: unknown } }
      if (entry.type !== 'user') continue
      const content = entry.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((c): c is { type: string; text: string } => (c as { type?: string })?.type === 'text')
                .map((c) => c.text)
                .join('\n')
            : ''
      if (text.trim() && !text.startsWith('<')) return text.slice(0, 2000)
    }
  } catch {
    /* transcript format drift is not worth crashing a hook over */
  }
  return ''
}

function runClaude(prompt: string, schema?: string, modelOverride?: string): string {
  // Per-turn briefs fire on every turn that touched a file, which makes this the
  // heaviest recurring cost in the tool — so the default is the cheap model.
  // Whole-PR reviews (writeReview) reason across a much larger diff and override
  // upward, because that is the one the reader actually studies.
  const model = modelOverride ?? process.env.PARLEY_TUTOR_MODEL ?? 'haiku'
  const args = ['-p', '--model', model, '--output-format', 'json']
  if (schema) args.push('--json-schema', schema)
  // The prompt goes on stdin, NOT in argv. Linux caps a single argument at
  // MAX_ARG_STRLEN (32 pages = 128 KB); macOS is far more generous. A review
  // prompt carries up to MAX_REVIEW_DIFF (180 KB) of diff, so passing it as an
  // argument works on a Mac and dies with E2BIG on every Linux box — which is
  // exactly how CI caught this: green on macos-latest, `spawnSync ... E2BIG` on
  // ubuntu-latest. `claude -p` reads the prompt from stdin when none is given
  // in argv, so this removes the ceiling entirely rather than just raising it.
  return execFileSync(process.env.PARLEY_CLAUDE ?? 'claude', args, {
    cwd: projectRoot(),
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300_000,
    // A tutor that can edit the repo is a tutor that can break your build.
    env: { ...process.env, PARLEY_AGENT: '', PARLEY_DIR: '' },
  })
}

/** claude -p --output-format json wraps the answer in {result: ...}. */
function unwrap(raw: string): unknown {
  const outer = JSON.parse(raw) as { result?: unknown }
  const result = outer.result ?? outer
  return typeof result === 'string' ? JSON.parse(result) : result
}

export function writeBrief(agent: string, transcript?: string): void {
  const root = projectRoot()
  const files = unbriefedTouches(agent)
  if (!files.length) return

  const diff = gatherDiff(root, files)
  if (!diff.trim()) {
    markBriefed(agent)
    return
  }

  const intent = lastUserPrompt(transcript)
  const why = decisions(10)
  const prompt = `${TUTOR_PROMPT}

--- what the human asked for ---
${intent || '(not captured)'}

--- what the agents said while doing it ---
${
  why.length
    ? why
        .reverse()
        .map((d) => `[${d.agent} · ${d.kind} · ${ago(d.created_at)}] ${d.body}`)
        .join('\n')
    : '(nothing posted)'
}

--- files touched ---
${files.join('\n')}

--- the change ---
${diff}`

  let parsed: { title: string; markdown: string; terms: { term: string; definition: string }[] }
  try {
    parsed = unwrap(runClaude(prompt, SCHEMA)) as typeof parsed
  } catch {
    markBriefed(agent) // do not retry forever on a bad turn
    return
  }
  if (!parsed?.markdown) {
    markBriefed(agent)
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  const path = join(stateDir(root), 'briefs', `${stamp}-${slug}.md`)

  writeFileSync(
    path,
    `# ${parsed.title}

*${agent} · ${new Date().toLocaleString()} · ${files.length} file(s)*

${files.map((f) => `- \`${f}\``).join('\n')}

${parsed.markdown}
`,
  )

  for (const { term, definition } of parsed.terms ?? []) learnTerm(term, definition)
  addBrief(parsed.title, path, agent)
  markBriefed(agent)
  post(agent, 'note', `brief: ${parsed.title}`)

  appendFileSync(
    join(stateDir(root), 'briefs', 'index.md'),
    `- [${parsed.title}](${path}) — ${agent}, ${new Date().toLocaleString()}\n`,
  )
}

/** Fire and forget, so the agent's Stop hook returns immediately. */
export function writeBriefDetached(agent: string, transcript?: string): void {
  const child = spawn('node', [join(SRC, 'cli.ts'), 'brief', '--agent', agent, ...(transcript ? ['--transcript', transcript] : [])], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

// --- whole-change review --------------------------------------------------
// A per-turn brief explains one edit. This explains a *shipment*: the shape of
// the change across every commit in it, and why it was built this way. It is the
// one you read before merging something an agent wrote for you.

const REVIEW_PROMPT = `You are the tutor in a tool called parley. Your reader ships software daily with AI agents. They are about to merge the change below — much of which an agent wrote — and they want to genuinely understand it first: the system design, what moved, and whether the decisions were the right ones. They are smart, they are not bluffable, and they would rather hear "this is a weak spot" than be reassured.

Write a review of the whole change. Sections:

## The shape of it
What this change is, in plain language, in a short paragraph. What the system could not do before and can now — or what stopped being broken. Someone who has never seen this repo should finish this section knowing what shipped.

## System design
The architecture of the change specifically. What new pieces exist, what each is responsible for, and how they fit the pieces that were already there. Name the real modules and the real seams. One ASCII diagram if — and only if — the shape is genuinely easier to see than to read; a diagram that just restates the file list is noise.

## The decisions
The load-bearing choices, one subsection each. For every one: what was chosen, what the realistic alternative was, and why this won. Where the material below records an agent's stated reasoning, use it and say it came from there. Where it does not, infer from the code and label it as your inference — never present a guess as the author's reasoning. If a decision looks wrong or under-justified to you, say that plainly; that judgment is the most valuable thing in this document.

## Reading it yourself
The order to read the files in to understand this change, and what to look for in each. Start with the one that makes the rest make sense. This is a route, not a list.

## Jargon decoder
Terms in this change a strong generalist would trip on. **term** — what it means *here*, using this codebase as the example. Three to six that actually matter, not every term present.

## What I would push back on
Real weaknesses: tradeoffs taken, failure modes now possible, things that will hurt at scale, tests that should exist and do not. Be specific — name the file and the scenario. If the change is genuinely clean, say so in a line rather than inventing concerns.

## If you learn one thing
One transferable idea this change teaches — a pattern, a tradeoff, a piece of judgment — that the reader can carry to code that has nothing to do with this repo. This is the section that compounds. Make it earn its place.

Rules:
- Explain, never sell. No "robust", "powerful", "seamless", "comprehensive".
- Be concrete. Real files, real functions, real values.
- Never claim something was tested or verified unless the material below shows it.
- Length tracks substance. A small change gets a short review.
- No emojis.

Return JSON: title (six words or fewer), markdown (the review, starting at "## The shape of it"), and terms (the jargon decoder entries as structured data, for the running glossary).`

/** Resolve what "the change" means: a PR number, a ref, or this branch's work. */
function reviewRange(root: string, ref: string): { diff: string; log: string; label: string } {
  if (/^\d+$/.test(ref)) {
    const diff = (() => {
      try {
        return execFileSync('gh', ['pr', 'diff', ref], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
      } catch {
        return ''
      }
    })()
    return { diff, log: git(['log', '--oneline', '-20'], root), label: `PR #${ref}` }
  }

  // Compare against where this branch left the trunk, not against the trunk tip,
  // so commits that landed on main while you worked do not show up as yours.
  const base =
    ref ||
    ['main', 'master', 'develop']
      .map((b) => git(['merge-base', 'HEAD', b], root).trim())
      .find(Boolean) ||
    'HEAD~1'
  const point = git(['merge-base', 'HEAD', base], root).trim() || base
  return {
    diff: git(['diff', `${point}...HEAD`], root),
    log: git(['log', '--oneline', `${point}..HEAD`], root),
    label: `${point.slice(0, 8)}..HEAD`,
  }
}

export function writeReview(ref = ''): string {
  const root = projectRoot()
  const { diff, log, label } = reviewRange(root, ref)
  if (!diff.trim()) {
    return `Nothing to review for ${label}. Is there uncommitted or unmerged work? Try \`parley review <base-ref>\` or \`parley review <pr-number>\`.`
  }

  const clipped =
    diff.length > MAX_REVIEW_DIFF ? `${diff.slice(0, MAX_REVIEW_DIFF)}\n\n[diff truncated]` : diff
  const why = decisions(30)

  const prompt = `${REVIEW_PROMPT}

--- what is being reviewed ---
${label}

--- commits in this change ---
${log.trim() || '(no commit history — this is uncommitted work)'}

--- what the agents said while building it ---
${
  why.length
    ? why
        .reverse()
        .map((d) => `[${d.agent} · ${d.kind}] ${d.body}`)
        .join('\n')
    : '(nothing posted — infer the reasoning from the code and label it as your inference)'
}

--- the change ---
${clipped}`

  let parsed: { title: string; markdown: string; terms: { term: string; definition: string }[] }
  try {
    // Reviews are read carefully and merged from. This is the one place worth
    // the expensive model, and it runs once per shipment rather than per turn.
    parsed = unwrap(runClaude(prompt, SCHEMA, process.env.PARLEY_REVIEW_MODEL ?? 'opus')) as typeof parsed
  } catch (err) {
    return `Review failed: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!parsed?.markdown) return 'Review failed: the tutor returned nothing usable.'

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  const path = join(stateDir(root), 'briefs', `${stamp}-review-${slug}.md`)

  const body = `# ${parsed.title}

*review of ${label} · ${new Date().toLocaleString()}*

${parsed.markdown}
`
  writeFileSync(path, body)
  for (const { term, definition } of parsed.terms ?? []) learnTerm(term, definition)
  addBrief(`review: ${parsed.title}`, path, 'tutor')
  appendFileSync(
    join(stateDir(root), 'briefs', 'index.md'),
    `- [review: ${parsed.title}](${path}) — ${label}, ${new Date().toLocaleString()}\n`,
  )

  return `${body}\nSaved to ${path}`
}

// --- retention ------------------------------------------------------------

const QUIZ_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          why: { type: 'string', description: 'Why this matters, one sentence' },
        },
        required: ['question', 'answer', 'why'],
      },
    },
  },
  required: ['questions'],
})

export type QuizItem = { question: string; answer: string; why: string }

/**
 * Reading a brief is passive and fades. This asks you to produce the answer
 * before you see it, which is the part that actually sticks — over the terms and
 * changes you have really encountered, not a generic curriculum.
 */
export function makeQuiz(count = 5): QuizItem[] {
  const terms = glossary().slice(0, 40)
  const recent = briefs(12)
  if (!terms.length && !recent.length) return []

  const prompt = `You are the tutor in a tool called parley. Your reader has been shipping code with AI agents and you have been explaining each change to them. Now check what actually stuck.

Write ${count} questions drawn from the material below. Rules:

- Ask about understanding, never recall of trivia. Not "what does WAL stand for" but "two parley processes write to the board at the same moment — what stops one of them losing the other's write, and what would break if it were missing?"
- Favor the terms and changes that carry the most weight in this codebase. Skip anything peripheral.
- Ground each question in THIS repository — real files, real functions, the actual design — not in the general concept.
- The answer should be two to four sentences: the answer itself, and the reason it is that way.
- "why" is one sentence on why knowing this makes them a better engineer, beyond this codebase.
- Vary difficulty. At least one should be genuinely hard.
- No emojis.

--- terms they have met ---
${terms.map((t) => `${t.term} (seen ${t.seen}x): ${t.definition}`).join('\n') || '(none yet)'}

--- changes recently explained to them ---
${recent.map((b) => `- ${b.title}`).join('\n') || '(none yet)'}

Return JSON: questions, an array of {question, answer, why}.`

  try {
    const parsed = unwrap(runClaude(prompt, QUIZ_SCHEMA)) as { questions?: QuizItem[] }
    return parsed.questions ?? []
  } catch (err) {
    // Silently returning [] here once cost an afternoon: the caller cannot tell
    // "nothing to ask about" from "the call failed", so say which.
    console.error(`(quiz generation failed: ${err instanceof Error ? err.message : String(err)})`)
    return []
  }
}

export function explain(topic: string): string {
  const root = projectRoot()
  const prompt = `You are the tutor in a tool called parley. Your reader ships software daily with AI agents and wants to understand the machine, not be reassured about it.

Explain: ${topic}

If that names a file, function, or directory in this repository, read it first and explain the real thing rather than the general concept. If it is a general term, define it and then show where it shows up in THIS codebase, with file paths.

Structure: what it is in plain language, why it exists (what breaks without it), how it actually works one level deeper than the summary, and where to look in this repo to see it. Be concrete, name real files. Explain, never sell. No emojis.`
  try {
    const outer = JSON.parse(runClaude(prompt)) as { result?: string }
    return outer.result ?? '(no answer)'
  } catch (err) {
    return `Tutor failed: ${err instanceof Error ? err.message : String(err)}`
  }
}
