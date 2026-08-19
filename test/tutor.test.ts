// tutor.ts is the whole "learning" half of the product, and almost every
// exported function ends in a real model call (`runClaude` -> `execFileSync
// claude ...`). This file never lets that happen. Instead:
//
// - Where a function returns before ever calling the model (an empty diff, an
//   agent with nothing unbriefed, nothing to quiz on), we call it for real and
//   assert the early return and its side effects (or lack of them) directly.
//   No model call is even attempted on these paths.
//
// - Where a function's PURE logic (which diff source `gatherDiff` picks,
//   whether it discloses truncation, which user turn `lastUserPrompt` finds in
//   a transcript) only shows up in the prompt it hands to the model, we point
//   PARLEY_CLAUDE at a tiny local script that is not a model, never talks to
//   the network, and just (a) records the prompt it was invoked with and (b)
//   returns a canned, well-formed response so the surrounding code can finish
//   its side effects. This is not mocking child_process — execFileSync really
//   spawns a real, separate, deterministic executable — and it never invokes
//   Claude. Nothing here relies on the `claude` binary existing.
//
// gatherDiff, lastUserPrompt, git, runClaude, unwrap and reviewRange are not
// exported by src/tutor.ts, and this file's scope forbids editing src/, so
// they are exercised only indirectly through the exported functions above.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- a fake "claude" binary, never a model, never the network -------------

const fixturesDir = mkdtempSync(join(tmpdir(), 'parley-tutor-fixtures-'))
const fakeClaude = join(fixturesDir, 'fake-claude.mjs')
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const prompt = process.argv[process.argv.length - 1]
if (process.env.FAKE_CLAUDE_CAPTURE) writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, prompt)
if (process.env.FAKE_CLAUDE_EXIT) process.exit(Number(process.env.FAKE_CLAUDE_EXIT))
process.stdout.write(process.env.FAKE_CLAUDE_RESPONSE ?? JSON.stringify({ result: '' }))
`,
)
chmodSync(fakeClaude, 0o755)
process.env.PARLEY_CLAUDE = fakeClaude

const captureFile = join(fixturesDir, 'capture.txt')

/** Configure the fake claude for one call, run it, and clean the env after —
 *  so a forgotten var never bleeds into the next test. */
async function withFakeClaude<T>(opts: { response?: unknown; exit?: number }, fn: () => Promise<T> | T): Promise<T> {
  process.env.FAKE_CLAUDE_CAPTURE = captureFile
  if (opts.response !== undefined) process.env.FAKE_CLAUDE_RESPONSE = JSON.stringify(opts.response)
  if (opts.exit !== undefined) process.env.FAKE_CLAUDE_EXIT = String(opts.exit)
  try {
    return await fn()
  } finally {
    delete process.env.FAKE_CLAUDE_CAPTURE
    delete process.env.FAKE_CLAUDE_RESPONSE
    delete process.env.FAKE_CLAUDE_EXIT
  }
}

function capturedPrompt(): string {
  return readFileSync(captureFile, 'utf8')
}

const briefResponse = (over: Partial<{ title: string; markdown: string; terms: unknown[] }> = {}) => ({
  result: JSON.stringify({ title: 'A change', markdown: '## What changed\nsomething', terms: [], ...over }),
})

// --- store isolation, same pattern as test/dispatch.test.ts ----------------
// tutor.ts imports store.ts plainly, so we cannot get a fresh module per
// test; instead we set PARLEY_DIR once and wipe every table tutor.ts reads or
// writes before each test.

const dir = mkdtempSync(join(tmpdir(), 'parley-tutor-test-'))
process.env.PARLEY_DIR = dir
after(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(fixturesDir, { recursive: true, force: true })
})

const store = await import('../src/store.ts')
const tutor = await import('../src/tutor.ts')

function resetDb() {
  store.db().exec(`
    DELETE FROM agents;
    DELETE FROM tasks;
    DELETE FROM feed;
    DELETE FROM claims;
    DELETE FROM links;
    DELETE FROM personas;
    DELETE FROM touches;
    DELETE FROM wip;
    DELETE FROM briefs;
    DELETE FROM glossary;
    DELETE FROM proposals;
    DELETE FROM sqlite_sequence;
  `)
}

// --- temp git repos ---------------------------------------------------------

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'parley-tutor-git-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  return repo
}

/** Run `fn` with process.cwd() pointed at `repo` (tutor.ts's helpers all call
 *  store's projectRoot(), which defaults to process.cwd()), always restoring
 *  the real cwd afterward even if `fn` throws. */
async function inRepo<T>(repo: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.cwd()
  process.chdir(repo)
  try {
    return await fn()
  } finally {
    process.chdir(prev)
    rmSync(repo, { recursive: true, force: true })
  }
}

const bodies = () => store.feed(200).map((f) => f.body).join('\n')

// ---------------------------------------------------------------------------
// writeBrief: the paths that never touch the model
// ---------------------------------------------------------------------------

test('writeBrief: an agent with nothing unbriefed returns immediately, no model call, no side effects', async () => {
  resetDb()
  await inRepo(gitRepo(), () => {
    tutor.writeBrief('nobody-touched-anything')
    assert.deepEqual(store.briefs(), [])
    assert.deepEqual(store.feed(200), [])
  })
})

test('writeBrief: a touched file that resolves to an empty diff marks briefed and returns, without calling the model', async () => {
  resetDb()
  const repo = gitRepo() // git repo exists, but the file was never created in it
  await inRepo(repo, () => {
    store.recordTouch('agent1', 'never-existed.txt')
    assert.deepEqual(store.unbriefedTouches('agent1'), ['never-existed.txt'])
    tutor.writeBrief('agent1')
    assert.deepEqual(store.unbriefedTouches('agent1'), [], 'markBriefed still runs on the empty-diff path')
    assert.deepEqual(store.briefs(), [], 'but no brief is produced')
    assert.deepEqual(store.feed(200), [], 'and nothing is posted')
  })
})

// ---------------------------------------------------------------------------
// writeBrief: gatherDiff's decision tree, observed via the prompt it builds
// ---------------------------------------------------------------------------

test('writeBrief: an uncommitted change is diffed with `git diff HEAD` (checked-in file, then edited)', async () => {
  resetDb()
  const repo = gitRepo()
  writeFileSync(join(repo, 'foo.txt'), 'line1\n')
  git(['add', 'foo.txt'], repo)
  git(['commit', '-q', '-m', 'initial'], repo)
  writeFileSync(join(repo, 'foo.txt'), 'line1\nline2\n') // uncommitted edit

  await inRepo(repo, async () => {
    store.recordTouch('agent1', 'foo.txt')
    await withFakeClaude({ response: briefResponse() }, () => tutor.writeBrief('agent1'))
    const prompt = capturedPrompt()
    assert.match(prompt, /\+line2/, 'the uncommitted addition shows up in the diff sent to the tutor')
    assert.doesNotMatch(prompt, /\[diff truncated\]/)
    assert.equal(store.briefs().length, 1)
    assert.match(bodies(), /brief: A change/)
    assert.deepEqual(store.unbriefedTouches('agent1'), [])
    const path = store.briefs()[0].path
    assert.ok(existsSync(path), 'the brief markdown file was actually written')
    assert.match(readFileSync(path, 'utf8'), /A change/)
  })
})

test('writeBrief: no uncommitted changes falls back to `git log -1 -p` (the last commit)', async () => {
  resetDb()
  const repo = gitRepo()
  writeFileSync(join(repo, 'bar.txt'), 'hello\n')
  git(['add', 'bar.txt'], repo)
  git(['commit', '-q', '-m', 'add bar'], repo)
  // no further edits: `git diff HEAD` is empty, so gatherDiff must fall back

  await inRepo(repo, async () => {
    store.recordTouch('agent1', 'bar.txt')
    await withFakeClaude({ response: briefResponse() }, () => tutor.writeBrief('agent1'))
    assert.match(capturedPrompt(), /\+hello/, 'the committed content shows up via `git log -1 -p`, not an empty diff')
  })
})

test('writeBrief: a file git has never seen, in a repo with no commits at all, falls back to raw file contents', async () => {
  resetDb()
  const plain = mkdtempSync(join(tmpdir(), 'parley-tutor-plain-'))
  writeFileSync(join(plain, 'new.txt'), 'brand new content\n')

  await inRepo(plain, async () => {
    store.recordTouch('agent1', 'new.txt')
    await withFakeClaude({ response: briefResponse() }, () => tutor.writeBrief('agent1'))
    assert.match(capturedPrompt(), /--- new\.txt ---/)
    assert.match(capturedPrompt(), /brand new content/)
  })
})

test('writeBrief: a diff over the cap is truncated and the truncation is disclosed, not silent', async () => {
  resetDb()
  const repo = gitRepo()
  writeFileSync(join(repo, 'big.txt'), 'x\n')
  git(['add', 'big.txt'], repo)
  git(['commit', '-q', '-m', 'initial'], repo)
  // 50,000 lines of "y" is comfortably over MAX_DIFF (40,000 chars) once diffed.
  writeFileSync(join(repo, 'big.txt'), 'x\n' + 'y\n'.repeat(50_000))

  await inRepo(repo, async () => {
    store.recordTouch('agent1', 'big.txt')
    await withFakeClaude({ response: briefResponse() }, () => tutor.writeBrief('agent1'))
    const prompt = capturedPrompt()
    assert.match(prompt, /\[diff truncated\]/, 'truncation must be disclosed in what the tutor is shown')
    const change = prompt.slice(prompt.indexOf('--- the change ---'))
    assert.ok(change.length < 40_100, `truncated section should be capped near MAX_DIFF, got ${change.length}`)
  })
})

// ---------------------------------------------------------------------------
// writeBrief: lastUserPrompt, observed the same way
// ---------------------------------------------------------------------------

test('writeBrief: lastUserPrompt walks the transcript backwards, skipping synthetic and empty entries, to find the last real ask', async () => {
  resetDb()
  const repo = gitRepo()
  writeFileSync(join(repo, 'f.txt'), 'a\n')
  git(['add', 'f.txt'], repo)
  git(['commit', '-q', '-m', 'c'], repo)
  writeFileSync(join(repo, 'f.txt'), 'a\nb\n')

  const transcript = join(repo, 'transcript.jsonl')
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'first real ask' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'an answer' } }),
    JSON.stringify({ type: 'user', message: { content: '<synthetic-tool-result>should be skipped</synthetic-tool-result>' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '   ' }] } }), // blank after trim
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'the real last ask' }] } }),
  ]
  writeFileSync(transcript, lines.join('\n') + '\n')

  await inRepo(repo, async () => {
    store.recordTouch('agent1', 'f.txt')
    await withFakeClaude({ response: briefResponse() }, () => tutor.writeBrief('agent1', transcript))
    const prompt = capturedPrompt()
    const intent = prompt.slice(prompt.indexOf('--- what the human asked for ---'), prompt.indexOf('--- what the agents said'))
    assert.match(intent, /the real last ask/)
    assert.doesNotMatch(intent, /first real ask/)
    assert.doesNotMatch(intent, /synthetic-tool-result/)
  })
})

test('writeBrief: a missing transcript path is treated as "not captured", not an error', async () => {
  resetDb()
  const repo = gitRepo()
  writeFileSync(join(repo, 'f.txt'), 'a\n')
  git(['add', 'f.txt'], repo)
  git(['commit', '-q', '-m', 'c'], repo)
  writeFileSync(join(repo, 'f.txt'), 'a\nb\n')

  await inRepo(repo, async () => {
    store.recordTouch('agent1', 'f.txt')
    await withFakeClaude({ response: briefResponse() }, () =>
      tutor.writeBrief('agent1', join(repo, 'does-not-exist.jsonl')),
    )
    assert.match(capturedPrompt(), /\(not captured\)/)
  })
})

// ---------------------------------------------------------------------------
// writeReview: the paths that never touch the model
// ---------------------------------------------------------------------------

test('writeReview: nothing to review (no commits, no ref) returns a message and never calls the model', async () => {
  resetDb()
  const plain = mkdtempSync(join(tmpdir(), 'parley-tutor-noreview-'))
  await inRepo(plain, () => {
    const result = tutor.writeReview()
    assert.match(result, /Nothing to review for/)
    assert.deepEqual(store.briefs(), [])
  })
})

test('writeReview: a numeric ref with no such PR (and no git repo) also reports nothing to review', async () => {
  resetDb()
  const plain = mkdtempSync(join(tmpdir(), 'parley-tutor-noreview-pr-'))
  await inRepo(plain, () => {
    const result = tutor.writeReview('424242')
    assert.match(result, /Nothing to review for PR #424242/)
  })
})

test('writeReview: a diff over the review cap is truncated and disclosed', async () => {
  resetDb()
  const repo = gitRepo()
  writeFileSync(join(repo, 'a.txt'), 'first\n')
  git(['add', 'a.txt'], repo)
  git(['commit', '-q', '-m', 'first commit'], repo)
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

  writeFileSync(join(repo, 'huge.txt'), 'z\n'.repeat(150_000)) // ~300,000 chars, over the 180,000 cap
  git(['add', 'huge.txt'], repo)
  git(['commit', '-q', '-m', 'add a huge file'], repo)

  await inRepo(repo, async () => {
    const result = await withFakeClaude({ response: briefResponse({ markdown: '## The shape of it\nreview' }) }, () =>
      tutor.writeReview(base),
    )
    assert.match(result, /Saved to/)
    const prompt = capturedPrompt()
    assert.match(prompt, /\[diff truncated\]/)
    const change = prompt.slice(prompt.indexOf('--- the change ---'))
    assert.ok(change.length < 180_100, `truncated review diff should be capped near MAX_REVIEW_DIFF, got ${change.length}`)
  })
})

test('writeReview: a failed model call is reported back as text, not thrown', async () => {
  resetDb()
  const repo = gitRepo()
  writeFileSync(join(repo, 'a.txt'), 'first\n')
  git(['add', 'a.txt'], repo)
  git(['commit', '-q', '-m', 'first'], repo)
  writeFileSync(join(repo, 'a.txt'), 'first\nsecond\n')
  git(['add', 'a.txt'], repo)
  git(['commit', '-q', '-m', 'second'], repo)

  await inRepo(repo, async () => {
    const result = await withFakeClaude({ exit: 1 }, () => tutor.writeReview('HEAD~1'))
    assert.match(result, /Review failed/)
  })
})

// ---------------------------------------------------------------------------
// makeQuiz: deterministic before the model call
// ---------------------------------------------------------------------------

test('makeQuiz: returns [] without calling the model when there is nothing to quiz on', () => {
  resetDb()
  assert.deepEqual(store.glossary(), [])
  assert.deepEqual(store.briefs(), [])
  assert.deepEqual(tutor.makeQuiz(), [])
})

test('makeQuiz: a failed model call returns [] rather than throwing, once there IS something to quiz on', async () => {
  resetDb()
  store.learnTerm('WAL', 'write-ahead logging')
  await withFakeClaude({ exit: 1 }, () => {
    assert.deepEqual(tutor.makeQuiz(), [])
  })
})

test('makeQuiz: once there is material, it calls the model and returns what it parses back', async () => {
  resetDb()
  store.learnTerm('WAL', 'write-ahead logging')
  const items = [{ question: 'q', answer: 'a', why: 'w' }]
  await withFakeClaude({ response: { result: JSON.stringify({ questions: items }) } }, () => {
    assert.deepEqual(tutor.makeQuiz(3), items)
  })
})

// ---------------------------------------------------------------------------
// explain: a different unwrap path (no --json-schema, result is plain text)
// ---------------------------------------------------------------------------

test('explain: returns the model\'s plain-text result directly', async () => {
  await withFakeClaude({ response: { result: 'here is the explanation' } }, () => {
    assert.equal(tutor.explain('what is the board'), 'here is the explanation')
  })
})

test('explain: a failed model call is reported back as text, not thrown', async () => {
  await withFakeClaude({ exit: 1 }, () => {
    assert.match(tutor.explain('anything'), /Tutor failed/)
  })
})
