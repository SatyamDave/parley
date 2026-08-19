# parley

[![tests](https://github.com/SatyamDave/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/SatyamDave/parley/actions/workflows/ci.yml)

A workspace of Claude Code terminals that plan the work, run it, and explain it back to you. 14 subcommands exist; 11 are things you type, the rest is panes and keys.

Three problems, one tool:

1. **Terminals can't see each other.** Git is not a read of peer progress — a peer with hours of uncommitted work in another worktree is invisible to `origin/main`, remote branch lists, `ls-tree`, and even `git worktree list`. parley keeps a board that agents write to directly, and separately watches the filesystem for uncommitted work so heads-down terminals get surfaced without cooperating.
2. **Orchestration is manual.** `parley goal "..."` decomposes an intention into a dependency graph and tiers each task by how much model it's worth. A dispatcher can then run that graph — handing a ready task to a free agent in its lane, spawning one at the right tier if nobody is free — but only if you ask for it, with `--auto`. That's off by default: it used to be on, and a ready task would start itself the instant the workspace opened, before anyone had a chance to look at the board.
3. **You ship code you don't understand.** A tutor process explains every change after it lands, `parley review` gives you the whole-PR version, and `parley map` gives you a standing architecture map of the repo itself — what each part does, what would break if a claim about it is wrong, generated and then checked rather than taken on faith. `parley quiz` checks what stuck.

## Install

```sh
npm install
npm link          # optional, puts `parley` on your PATH
```

Node 24+. No build step — Node runs the TypeScript directly. The first run in a
project offers to answer Claude Code's folder-trust prompt once, so your agents
don't each stop and ask.

## Use

`parley` has 14 subcommands. Three — `propose`, `brief`, `hook` — are internal: the TUI and Claude Code's own hooks call them, a person never types them, so they're left out below. The rest:

```sh
parley                                     # open the workspace
parley goal "add rate limiting to the API" # commit a dependency graph to the board
parley map                                 # build/refresh the architecture map of this repo
parley status                              # what's happening, from another shell
parley review                              # system-design review before you merge
parley explain src/store.ts                # ask about anything
parley quiz                                # check what actually stuck
parley add <role>                          # start another agent from outside the workspace
parley kill <agent-id>                     # stop one from outside the workspace
parley wires                               # who is linked to whom, right now
parley prompt [role]                       # the system prompt a role actually runs with
```

`parley goal` writes the plan to the board immediately — it does not, by itself, get anyone to work on it. Something has to actually dispatch the ready tasks: a workspace open with `--auto`, or you, by hand. `parley map` is its own subsystem with several flags and a `corrections` command; see [The architecture map](#the-architecture-map) below.

Everything else lives inside the workspace, because that's where you already are.

## The workspace

It is an application. Use the mouse.

```
 parley  +architect  +builder  +reviewer  +scout   3/6  1 link
+- WHAT DO YOU WANT? add rate limiting ---++- ACTIVITY -----------------+
| done #1 token bucket                    || 12s builder finished #7    |
| run  #7 wire the middleware             || 40s architect decision ... |
+-----------------------------------------++----------------------------+
+------------------------------------+ +-----------------------------+
| architect opus working  ->builder x| | builder sonnet working    x |
|  * Thinking...                     | |  * Write(cache.ts)          |
+------------------------------------+ +-----------------------------+
+---------------------------------------------------------------------+
| scout haiku idle                                                  x |
+---------------------------------------------------------------------+
 click a pane to type in it . drag one pane onto another to link them
```

| Do this | Get this |
|---|---|
| Click a pane | You are typing in that agent |
| Drag one pane onto another | They are linked |
| Click `+role` | Another agent starts |
| Click `x` | That agent closes |
| Type up top, press enter | Proposes a roster for the goal; approving it (or redirecting it in your own words) is what actually commits the plan to the board |

There are no modes. Whatever you clicked last is where your typing goes.
Keyboard-only: `tab` moves between panes, `ctrl-q` quits, everything else goes
straight to the focused agent.

Once a plan is on the board, whether it runs on its own depends on `--auto` (see below) — without it, the workspace says as much when you approve a proposal, and tasks just sit there until you type one into a pane yourself.

**How many agents?** As many as fit. The number by the buttons (`3/6`) is what
this window has room for; make the terminal bigger and it goes up. There is no
flag, because the real limit was always the screen.

**One tradeoff:** while parley is running, the terminal reports mouse clicks to
it, so click-dragging to select text goes to parley instead of your terminal.
Hold **shift** (**option** in some terminals) to select and copy as usual.

## Links

Drag one pane onto another. The wire appears in both panes — `->builder` on one,
`<-architect` on the other — and carries two things:

- **Work flows downstream.** Tasks the upstream agent puts on the board are
  reserved for the agent it points at, instead of going to whoever is free. A
  routed task *waits* for its agent rather than spilling back to the lane —
  otherwise drawing the wire would not mean anything.
- **Messages flow both ways.** A linked peer's posts arrive at the top of your
  next turn marked as addressed to you, rather than mixed into the general feed.

Broadcast still works: everyone can always see everyone, which was parley's
original point. A link is precedence and routing on top of that, not a wall
around it.

Links bind the terminals you can see, not the lanes. Kill an agent and its wires
go with it.

## The graph is the point

`parley goal` doesn't return a list, it returns edges. A task carries the ids of the tasks that must finish first, and that is the only thing gating it:

```
✔ #1 add the deps column to the board        (architect, opus)
└─ ○ #2 write the dispatcher                 (builder lane, sonnet)
   └─ · #3 cover the escalation path         (reviewer lane, haiku)
      └─ · #5 wire it into the TUI           (builder lane)

○ #4 check how node-pty handles resize       (scout lane, haiku)
└─ ↑ #5 (shown above)

2 ready to start now: #2, #4
```

Everything not waiting on something is ready to run now, in parallel — handed out immediately if the workspace is running with `--auto`, otherwise it just sits marked ready until an agent is assigned by hand. The planner is told explicitly that a false dependency idles an agent for nothing, so it writes wide graphs rather than queues.

Model tier travels with the task, not the agent. The planner rates each task `haiku` (mechanical, well-specified), `sonnet` (ordinary implementation — the default) or `opus` (load-bearing design, wide blast radius, expensive to get wrong). Personas have defaults too — Architect `opus`, Builder and Reviewer `sonnet`, Scout `haiku` — and the dispatcher spawns an agent at the right tier when none is free.

When an agent posts `parley_post(kind: "blocked")`, the task doesn't die: it returns to the board with its tier bumped one step, carrying the note about what stopped it. A task that defeats haiku was mis-tiered, not impossible. That escalation has a ceiling, though: a task that still fails after reaching `opus` parks — status stays `blocked`, and it is never dispatched again — once it has failed 4 times total. A feed post and a note left in the task's own detail are what a human reads to find out why.

## The architecture map

`parley map` builds a standing map of the repository, layered so a wrong sentence can never become a wrong edge:

1. **Skeleton (`src/map/skeleton.ts`)** — deterministic, no model involved. Files, exports, and import edges, extracted per-language with regex: TypeScript/JavaScript, Python, Go, and Rust each get their own extraction and resolution rules, selected by file extension. This is a real, stated shortcut, not a parser — its own header comment is candid about the ceiling: it cannot see dynamic or computed imports (`importlib.import_module(...)`, macro-generated `mod`/`use` in Rust, build-tag-gated Go files), and it will not fabricate an edge — a specifier that looks local but doesn't resolve to a real file is dropped rather than guessed at. Go needs a readable `go.mod` to tell "this repo's own package" from an external one at all; without it, every Go import is treated as external. Rust only unfolds one level of a `use a::{b::{c, d}}` group. All four languages resolve against the case-exact file list the walk produced, not against the disk — `statSync('src/Thing.ts')` succeeds on a case-insensitive filesystem (the macOS default) even when the real file is `src/thing.ts`, which would attach an edge to a file that does not exist under that name. CI runs on both Linux and macOS specifically so the test for this keeps its teeth; on Linux alone it would pass for the wrong reason.
2. **Regions (`src/map/regions.ts`)** — grouping files into components, also model-free. Directories win when they're informative; when a repo is flat (parley's own `src/` is the example that forced this), an import-graph clustering pass gives a starting point but is explicitly marked as not a real decomposition, and hands off to layer 3 for a proposed semantic grouping — which stays flagged unconfirmed until a human says otherwise.
3. **Narrative (`src/map/narrate.ts`)** — the only layer that calls a model, one bounded call per region (4 concurrent). It describes purpose and makes claims (`mechanism`, `invariant`, `gotcha`), each required to cite the files that support it; `UNKNOWN` is treated as a correct answer and is preferred over a guess. The model never originates structure — files, edges, and roles all arrive as given facts — so a wrong narrative sentence can be traced and dropped without corrupting anything underneath it.
4. **Falsification (`src/map/verify.ts`)** — a second, separate model call tries to *disprove* each claim against only the files it cited, batched by shared evidence so a file's content is sent once no matter how many claims cite it. Verdicts are `supported`, `contradicted`, or `unsupported`. Only `supported` claims are presented as fact to an agent; `contradicted` ones are dropped, and `unsupported` ones are kept but marked with a `?` so a reader can tell provenance from truth. This exists because provenance alone was measured to produce a confidently wrong map once — a claim correctly cited the right file and still asserted the opposite of what the code did.
5. **Corrections (`src/map/corrections.ts`)** — pinned human overrides that survive a rebuild, because rebuilds regenerate the model's prose from scratch. A label/purpose override is keyed to a region id (stable across rebuilds), a suppression is keyed to a hash of the wrong statement's own text (so it's automatically hidden again if the model regenerates the same claim, and automatically stops applying if the model ever stops producing it), and a human-authored claim carries its own id and is tagged `human` so it's never confused for generated text. Corrections live in their own file next to `map.json` specifically so a full rebuild can't discard them. If the files a correction was anchored to change afterward, it's flagged stale rather than silently trusted.

Rebuilds are incremental by default: `parley map` hashes every file's content and diffs against the previous build, skipping re-narration for any region whose files are unchanged. Re-verification is scoped even further — a claim is only re-checked if one of the files it specifically cites changed, even across region boundaries. Running `parley map --verify` on an existing map re-judges its claims against the current code without paying to re-describe anything, and doubles as drift detection: a claim that was `supported` and is now not means the code moved out from under the map.

Flags: `--full` (ignore any prior map, rebuild everything), `--show` (print the stored map for a human), `--agent` (print the compact, token-budgeted form an agent actually receives — ranked so invariants and gotchas lead, support code like `test/`, `scripts/`, `bin/` is demoted, and it's truncated to fit a budget), `--verify` (re-check every claim, drift detection). `parley map corrections list|label|purpose|suppress|claim|remove` manages the pinned overrides above; region ids come from `parley map --show`.

Building and verifying a map make real, uncached model calls — expect minutes on anything beyond a handful of files, not seconds.

## How it fits together

```
   parley up
       |
       +-- pty --> claude (architect:opus)  --+
       +-- pty --> claude (builder:sonnet)  --+--> MCP: parley_who / claim / avoid / post
       +-- pty --> claude (scout:haiku)  ‹----+    hooks: SessionStart, UserPromptSubmit,
       |            spawned on demand         |           PostToolUse, Stop
       |                                      v
       |                              ~/.parley/<project>/parley.db
       |                        board · deps · claims · feed · touches · wip
       |                                      |
       +-- dispatcher (every 3s, --auto only) +
       |     ready tasks -> free agent in lane, or spawn one at the right tier
       |
       +-- board + feed panes <---------------+
                                              |
                                   Stop hook -+--> tutor (separate claude -p)
                                                   briefs/*.md + glossary
```

**The board** is SQLite in `~/.parley/<project>/`. Every process — the TUI, each agent's MCP server, every hook — opens the same file. WAL mode makes that safe from many processes at once.

**The reflexes** are hooks written into a per-agent settings file:

| Hook | What it does |
|---|---|
| `SessionStart` | Agent joins the roster and is handed the board + who holds what |
| `UserPromptSubmit` | Anything peers posted since its last turn is injected into context |
| `PostToolUse` | Records which files this agent touched |
| `Stop` | Reports in, rescans for uncommitted work, fires the tutor detached |

`UserPromptSubmit` is what makes terminals actually *talk* — peer messages arrive at the top of the next turn instead of needing anyone to poll.

**The dispatcher** only runs when the workspace was opened with `--auto`; there's no way to switch it on mid-session short of restarting. When it is running, every three seconds it asks for tasks whose dependencies are met, finds a free agent in the right lane, claims the task (the claim is an atomic `UPDATE`, so two dispatchers racing produce one winner), and types it into that agent's terminal. It only ever touches an agent Claude Code has confirmed is up and idle — writing into a terminal mid-turn corrupts whatever was there.

**The tutor** runs out-of-process. The coding agent can't skip it to save tokens, and the explanation never competes for room in the coding context. It reads more than the diff: `parley_post(kind: "decision")` entries are fed in alongside, so "why this and not the obvious alternative" comes from the agent that made the call rather than being reverse-engineered from the result.

Three levels, deliberately different in cost:

| | When | Model | What you get |
|---|---|---|---|
| brief | every turn that touched a file | `haiku` | what changed, why it matters, where it sits, jargon decoded |
| `parley review` | before you merge | `opus` | system design, the decisions and their alternatives, a reading route, what to push back on |
| `parley quiz` | when you want to | `haiku` | questions from your own glossary and briefs, answers withheld until you commit to one |

The per-turn brief is cheap because it fires constantly. The review is expensive because you read it once and merge from it.

## The two ideas worth stealing

**Saying what you're *not* touching matters as much as claiming.** Claims stop two agents editing one file. But the more common failure is an agent avoiding work that was free the whole time, because nobody said so. `parley_avoid` publishes "this area is uncontested" and unblocks peers.

**Facts carry who verified them and how.** "Tests pass" is worth little. "`pnpm -F web test`, 41 passed, at `a3f21`" is worth acting on. `parley_update` records verification alongside status, so a reader can discount a shaky claim without re-deriving it — the alternative is several terminals confidently wrong at once about the same thing.

And the agent's word is no longer the only evidence. Closing a task as `done` runs the project's real checks — detected from what is actually on disk (npm/pnpm/yarn/bun scripts, `pytest`/`ruff`/`mypy`, `go test`/`vet`/`build`, `cargo test`/`clippy`/`build`, a Makefile's `test`/`check` target) — and captures the real exit codes and output. If they fail, the task does not become `done`: it returns to the board with the actual error appended, and the same report comes back to the agent so it can fix it in-turn. If they pass, the machine's finding is stored in its own column (`verified_machine`, `checks_report`) and is **never merged** with the agent's `verified_how` claim, so you can always tell "an agent said so" from "the checks actually ran." Runs are serialised by a cross-process lock, because concurrent test runs collide on ports and databases and produce flaky results, which is worse than slow ones. Nothing on this path calls a model: verification is free, fast, and cannot hallucinate.

This exists because of a specific failure in this repository's own history: an agent wrote 49 genuinely good tests, added an `npm test` script that never worked at all, and marked the task done. Nobody noticed for days, because nothing ever ran it.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PARLEY_CLAUDE` | `claude` | Path to the Claude Code binary |
| `PARLEY_TUTOR_MODEL` | `haiku` | Model that writes per-turn briefs |
| `PARLEY_REVIEW_MODEL` | `opus` | Model that writes `parley review` |
| `PARLEY_PLANNER_MODEL` | `opus` | Model that decomposes an approved goal into the real task graph |
| `PARLEY_PROPOSE_MODEL` | `haiku` | Model that proposes a roster for a goal, before it's decomposed |
| `PARLEY_MAP_MODEL` | `haiku` | Model that narrates each region of `parley map` |
| `PARLEY_VERIFY_MODEL` | `haiku` | Model that falsifies map claims for `parley map --verify` |
| `PARLEY_DIR` | `~/.parley/<project>` | Where the board and the map live |

## Does it work?

`parley map` makes an empirical claim, so [EVALUATION.md](EVALUATION.md) has the
numbers, the method, and the parts that did not replicate. Short version, across
two unrelated repositories and two runs each: **turns down 6.9% and 16.5%**,
concentrated in cross-file and prove-a-negative questions (up to -40%), and
**no statistically significant accuracy gain either time**. The harness is in
`scripts/` and runs against any repo.

The finding that shaped the design is in there too: one correctly-cited but
false map claim cost an agent 19 turns against 9 with no map at all. Provenance
is not a correctness check, which is why there is a falsification pass.

## Known limits

- **A `done` call blocks while the checks run.** `parley_update(status:"done")` now actually runs the project's real checks before accepting the task, which means the tool call takes as long as your test suite does — up to the 5-minute-per-check timeout in `src/checks.ts`. That is inherent to actually running them rather than taking an agent's word, but it is a real change in how long that call takes.
- **Only the `done` transition is gated.** `parley_update` to `review`, `claimed`, or `blocked` still records `verified_by`/`verified_how` straight from what the calling agent passed, unchecked — only `done` claims "confirmed," so only `done` is verified. Read those other fields as the agent's own words, which is all they have ever been.
- **A project with no detectable checks is marked `unverified`, not verified.** If `detectChecks` finds nothing to run, the task still reaches `done` but `verified_machine` is set to `unverified` rather than `passed`. That distinction is the whole point — deliberately *not* treating "nothing to check" as "checked and fine" — but it does mean `done` on such a repo carries no machine evidence at all.
- **A rejected task reopens while its agent may still be fixing it.** When checks fail, the task goes back on the board via `blockTask` so it is not lost, and the failure report is returned to the agent so it can fix the problem in the same turn. Those two facts together mean a dispatcher running with `--auto` could hand the reopened task to a *different* agent while the original is still working on it. This mirrors the pre-existing manual "blocked" flow rather than being new, but it is a real race.
- **Dispatch types into a terminal.** There is no API for handing a running Claude Code session a task, so the dispatcher writes the task into the pty as if you had. It only does this to an agent that reported idle, and it sends the newline as a separate keystroke 250ms later — a long string with a trailing `\r` arrives as one chunk, which Claude Code reads as a paste and inserts as a line break rather than submitting. If an agent is idle but parked on a prompt parley doesn't know about, the injected text will land in that prompt instead.
- **Auto-dispatch is a startup choice.** `--auto` is read once when the workspace opens; there is no in-session toggle. Without it, a task reaching "ready" just sits on the board until a human assigns it by hand.
- **First run per project asks for trust.** Claude Code's folder-trust dialog only auto-skips in non-interactive mode, so every pane would ask separately. `parley` offers to answer it once on first run (it edits `~/.claude.json` and backs the old one up). It asks rather than assuming — that dialog is a safety check.
- **Claims are advisory.** `parley_claim` reports a conflict; nothing stops an agent editing anyway. Real isolation would mean a worktree per agent.
- **The map's skeleton is regex, not a parser**, and makes real, uncached model calls for narration and falsification — see [The architecture map](#the-architecture-map) for what that specifically misses per language, and expect minutes of wall-clock time to build or verify one on anything beyond a handful of files.
- Agent panes render without color. A headless xterm keeps the screen buffer and layout intact — box drawing survives — but cell colors are dropped on the way into Ink.
- Dirty-file attribution matches an agent's recorded edits against `git status`. Changes parley didn't make show up under `(not parley)`, which is the interesting bucket.
- Everything dies with the TUI. There is no detach; closing the terminal kills the fleet.
