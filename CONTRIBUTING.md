# Contributing

```
npm install
npm test        # 236 tests, ~10s
npm run check   # syntax-check the entry point
```

Node 24+. That's the whole setup.

## Five constraints that are load-bearing

These aren't style preferences. Each one exists because breaking it already cost
something here.

**1. There is no build step, and adding one is a change to the product.**
Node runs the TypeScript directly via `--experimental-strip-types`. That means
no bundler, no `tsc` output, no `dist/`, and no type-level features that require
a real compile — no `enum`, no parameter properties, no namespaces, and
`import type` where you mean it. `git clone && npm install && parley` working
with nothing else installed is a feature; a build step deletes it.

**2. New dependencies need a real argument.** There are four
(`node-pty`, `@xterm/headless`, `ink`, `react`), each irreplaceable: a real pty,
a terminal emulator, a TUI renderer. Everything else is `node:` builtins,
including the database (`node:sqlite`) and the test runner (`node:test`). If you
want to add something, say what builtin you tried first.

**3. Prompts go to a model on stdin, never in argv.** Linux caps a single argv
entry at 131,072 bytes (`MAX_ARG_STRLEN`). macOS is far more generous, so this
fails on exactly one platform, only on large inputs, and CI is where you find
out. Pass the prompt as `input:` to `execFileSync`, or use `runWithStdin`.

**4. In `src/map/*`, a model may never originate a fact.** Files, exports, and
import edges come from `skeleton.ts`, which never calls a model. The model
narrates what it is given, cites its evidence, and a second pass tries to
disprove it. Adding a model call that produces *structure* rather than *prose
about structure* breaks the property the whole map rests on — that a wrong
sentence can be dropped without corrupting anything underneath it.
`UNKNOWN` is a correct answer and is preferred to a guess.

**5. Tests use `node:test` and `node:assert`, and `npm test` must actually
run.** This repo's worst moment was 49 genuinely good tests, an `npm test`
script that never worked at all, and a task marked done. If you touch the test
script, run it and read the output — a passing exit code is not evidence that
anything executed. (`node --test test/` with a trailing slash resolves nothing
and exits 0. That was the bug.)

## CI

Matrix over `ubuntu-latest` and `macos-latest`, on purpose. macOS defaults to a
case-insensitive filesystem, so the test for case-mismatched import resolution
only has teeth there; Linux is where argv limits and path assumptions surface.
A change that passes on one and not the other is a real portability bug, not
flakiness — it has been, twice.

## What is genuinely open

`README.md`'s **Known limits** section is maintained as an honest list, not
marketing. The most useful contribution is turning one of those entries into a
fixed bug — and then deleting it from the list. Anything that makes the tool
claim more than it can demonstrate is the one change that will be turned down.
