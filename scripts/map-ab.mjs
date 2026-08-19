#!/usr/bin/env node
// The map A/B, rebuilt for enough statistical power to mean something.
//
// The first version used 6 questions run once and could not resolve its own
// result: the baseline scored 5/6 then 6/6 on identical questions, so variance
// (±1 answer = ±17%) matched the effect being measured. This version fixes the
// three things that made it useless:
//
//   1. 20 questions instead of 6, so one answer is ±5% rather than ±17%.
//   2. Repeated runs per condition, so baseline variance is measured rather
//      than assumed away.
//   3. Questions selected to discriminate, tagged by kind, and reported per
//      kind — a question the baseline answers in one turn from general
//      knowledge tells us nothing and should be visible as such.
//
// Turns is the primary efficiency metric, not wall-clock. Calls run
// concurrently here to make ~160 model calls feasible, which makes elapsed time
// dependent on API contention; turn count and correctness are unaffected by
// concurrency. Time is still reported, but it is the weakest number here.
//
// Usage: node scripts/map-ab.mjs <map-file> [--runs N] [--only kind]
//   AB_REPO=<path>      repo the baseline/with-map agent actually works in
//                        (defaults to parley itself — this harness was
//                        originally hardcoded to parley only, which made it
//                        unusable for testing generalization to another repo)
//   AB_QUESTIONS=<path> question module to import (must export QUESTIONS),
//                        defaults to ./ab-questions.mjs (parley's own set)
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)
// Defaults to wherever this is run from, so the harness works in a clone.
const REPO = process.env.AB_REPO ?? process.cwd()
const AGENT_MODEL = process.env.AB_AGENT_MODEL ?? 'sonnet'
const GRADER_MODEL = process.env.AB_GRADER_MODEL ?? 'sonnet'
const CONCURRENCY = Number(process.env.AB_CONCURRENCY ?? 5)

const questionsPath = process.env.AB_QUESTIONS
  ? pathToFileURL(process.env.AB_QUESTIONS).href
  : new URL('./ab-questions.mjs', import.meta.url).href
const { QUESTIONS } = await import(questionsPath)

const args = process.argv.slice(2)
const mapPath = args[0]
const runs = Number(args.includes('--runs') ? args[args.indexOf('--runs') + 1] : 2)
const onlyKind = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

const mapText = readFileSync(mapPath, 'utf8')
const questions = onlyKind ? QUESTIONS.filter((q) => q.kind === onlyKind) : QUESTIONS

async function askAgent(question, withMap) {
  const prompt = withMap
    ? `${mapText}\n\n---\n\nUsing the map above plus the repository itself, answer precisely.\n\nQUESTION: ${question}`
    : `Answer precisely, based on this repository.\n\nQUESTION: ${question}`
  try {
    const { stdout } = await run('claude', ['-p', '--model', AGENT_MODEL, '--output-format', 'json', prompt], {
      cwd: REPO,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    })
    const d = JSON.parse(stdout)
    return { answer: String(d.result ?? ''), turns: d.num_turns ?? 0, ms: d.duration_ms ?? 0, cost: d.total_cost_usd ?? 0, ok: true }
  } catch (e) {
    return { answer: '', turns: 0, ms: 0, cost: 0, ok: false }
  }
}

// The grader never learns which condition produced an answer.
async function grade(question, truth, answer) {
  if (!answer.trim()) return { correct: false, missing: 'no answer produced' }
  const schema = JSON.stringify({
    type: 'object',
    properties: {
      correct: { type: 'boolean' },
      missing: { type: 'string', description: 'What the answer got wrong or omitted. Empty if fully correct.' },
    },
    required: ['correct', 'missing'],
  })
  const prompt = `Grade this answer against the ground truth. Be strict but fair: wording may differ, but the answer must contain the substance the ground truth says to credit, and must not assert anything contradicting it.

QUESTION: ${question}

GROUND TRUTH (includes what to credit): ${truth}

ANSWER TO GRADE:
${answer}

Mark correct only if the answer conveys the key mechanism. Vague, hedged, or differently-mechanised answers are incorrect.`
  try {
    const { stdout } = await run(
      'claude',
      ['-p', '--model', GRADER_MODEL, '--disallowed-tools', 'Read', 'Grep', 'Glob', 'Bash', '--output-format', 'json', '--json-schema', schema, prompt],
      { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
    )
    const d = JSON.parse(stdout)
    const r = d.result ?? d
    const p = typeof r === 'string' ? JSON.parse(r) : r
    return { correct: !!p.correct, missing: p.missing ?? '' }
  } catch {
    return { correct: false, missing: 'grading failed' }
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Build the full job list up front so both conditions and all runs interleave —
// this stops a systematic drift in API latency from landing on one condition.
const jobs = []
for (let r = 0; r < runs; r++) {
  for (const q of questions) {
    for (const withMap of [false, true]) jobs.push({ q, withMap, run: r })
  }
}

console.log(`map: ${mapText.length} chars (~${Math.ceil(mapText.length / 4)} tokens)`)
console.log(`${questions.length} questions × ${runs} runs × 2 conditions = ${jobs.length} agent calls`)
console.log(`agent: ${AGENT_MODEL} · grader: ${GRADER_MODEL} · concurrency: ${CONCURRENCY}\n`)

let done = 0
const results = await pool(jobs, CONCURRENCY, async (job) => {
  const res = await askAgent(job.q.q, job.withMap)
  const g = await grade(job.q.q, job.q.truth, res.answer)
  done++
  if (done % 10 === 0) console.log(`  ${done}/${jobs.length} complete`)
  return { ...job, ...res, ...g }
})

const side = (withMap) => results.filter((r) => r.withMap === withMap && r.ok)
const stats = (rs) => ({
  n: rs.length,
  correct: rs.filter((r) => r.correct).length,
  acc: rs.length ? rs.filter((r) => r.correct).length / rs.length : 0,
  turns: rs.length ? rs.reduce((a, r) => a + r.turns, 0) / rs.length : 0,
  secs: rs.length ? rs.reduce((a, r) => a + r.ms, 0) / rs.length / 1000 : 0,
  cost: rs.reduce((a, r) => a + r.cost, 0),
})

// Per-run accuracy on each side is the honest measure of how noisy this is.
console.log('\nPER-RUN ACCURACY (this is the variance the first experiment missed)')
for (let r = 0; r < runs; r++) {
  const b = stats(results.filter((x) => x.run === r && !x.withMap && x.ok))
  const m = stats(results.filter((x) => x.run === r && x.withMap && x.ok))
  console.log(`  run ${r + 1}:  baseline ${b.correct}/${b.n}   with map ${m.correct}/${m.n}`)
}

const b = stats(side(false))
const m = stats(side(true))
const pct = (a, base) => (base === 0 ? '—' : `${(((a - base) / base) * 100).toFixed(1)}%`)

console.log(`\n${'='.repeat(72)}`)
console.log(`                accuracy         turns/q   time/q    total cost`)
console.log(`baseline        ${b.correct}/${b.n} (${(b.acc * 100).toFixed(0)}%)      ${b.turns.toFixed(1)}      ${b.secs.toFixed(1)}s     $${b.cost.toFixed(2)}`)
console.log(`with map        ${m.correct}/${m.n} (${(m.acc * 100).toFixed(0)}%)      ${m.turns.toFixed(1)}      ${m.secs.toFixed(1)}s     $${m.cost.toFixed(2)}`)
console.log(`\ndelta: accuracy ${((m.acc - b.acc) * 100).toFixed(1)}pp · turns ${pct(m.turns, b.turns)} · cost ${pct(m.cost, b.cost)}`)

console.log('\nBY QUESTION KIND')
for (const kind of [...new Set(questions.map((q) => q.kind))]) {
  const bb = stats(results.filter((x) => x.q.kind === kind && !x.withMap && x.ok))
  const mm = stats(results.filter((x) => x.q.kind === kind && x.withMap && x.ok))
  console.log(
    `  ${kind.padEnd(9)} baseline ${(bb.acc * 100).toFixed(0)}% @ ${bb.turns.toFixed(1)} turns   →   map ${(mm.acc * 100).toFixed(0)}% @ ${mm.turns.toFixed(1)} turns`,
  )
}

// A question the baseline always gets right in very few turns is not measuring
// anything — it should be replaced, and saying so keeps the set honest.
console.log('\nNON-DISCRIMINATING QUESTIONS (baseline always right, few turns — candidates to replace)')
let duds = 0
for (const q of questions) {
  const bb = results.filter((x) => x.q.id === q.id && !x.withMap && x.ok)
  if (bb.length && bb.every((x) => x.correct) && bb.reduce((a, x) => a + x.turns, 0) / bb.length <= 2) {
    console.log(`  ${q.id} (${q.kind}) — baseline ${bb.length}/${bb.length} in ${(bb.reduce((a, x) => a + x.turns, 0) / bb.length).toFixed(1)} turns`)
    duds++
  }
}
if (!duds) console.log('  none — every question required real work from the baseline')

console.log('\nPER-QUESTION (turns baseline → map, accuracy baseline → map)')
for (const q of questions) {
  const bb = stats(results.filter((x) => x.q.id === q.id && !x.withMap && x.ok))
  const mm = stats(results.filter((x) => x.q.id === q.id && x.withMap && x.ok))
  const flag = mm.acc > bb.acc ? ' MAP WINS' : mm.acc < bb.acc ? ' MAP LOSES' : ''
  console.log(`  ${q.id.padEnd(22)} ${bb.turns.toFixed(1)}→${mm.turns.toFixed(1)} turns   ${(bb.acc * 100).toFixed(0)}%→${(mm.acc * 100).toFixed(0)}%${flag}`)
}

const failed = results.filter((r) => !r.ok).length
if (failed) console.log(`\n${failed} calls failed and were excluded`)
