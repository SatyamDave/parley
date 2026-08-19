// The question set for the map A/B, and the part that decides whether the whole
// experiment means anything.
//
// The first attempt used six questions and could not resolve its own result: the
// baseline scored 5/6 in one run and 6/6 in the next on identical questions, so
// run-to-run variance (±1 answer = ±17%) was the same size as the effect being
// measured. Two of the six were also duds — `paste-newline` was answerable from
// general knowledge about terminal pastes in a single turn, with no repository
// access at all.
//
// So these are chosen against explicit criteria. A question earns its place only
// if answering it requires something an agent cannot get cheaply:
//
//   trap        the locally-sensible answer is wrong. This is the category that
//               matters most, because "makes a reasonable local decision that
//               breaks a system guarantee" is the exact failure the map exists
//               to prevent.
//   spanning    the mechanism lives across three or more files, so no single
//               read produces it.
//   blast       "what else breaks if I change this" — invisible from the file
//               being changed.
//   absence     the correct answer is that a thing does NOT exist. Very hard to
//               establish by exploration, since not finding something is weak
//               evidence, and easy to state in a map.
//
// Every ground truth below was written by reading current source and verified
// with grep at authoring time — never from the map, and never from memory.
// Grading against the map would make the experiment circular.

export const QUESTIONS = [
  {
    id: 'add-column',
    kind: 'trap',
    q: 'You are adding a new column to the `tasks` table. You edit the SCHEMA string to include it. Why is that not sufficient, and what else must you do?',
    truth:
      "`CREATE TABLE IF NOT EXISTS` does nothing at all to a table that already exists, so any board created before the column was added keeps its old shape and every query referencing the new column throws. The column must also be added to the ADDED_COLUMNS list in store.ts, which migrate() uses to ALTER TABLE ADD COLUMN on existing databases. Credit for identifying that IF NOT EXISTS silently skips existing tables AND that a separate migration list/ALTER path must be updated.",
  },
  {
    id: 'update-done-gate',
    kind: 'absence',
    q: 'An agent calls parley_update(task_id: 5, status: "done", verified_how: "tests pass"). What verification does parley perform before accepting that the task is done?',
    truth:
      "None. There is no gate whatsoever. `verified_by` is set to whichever agent is making the call, and `verified_how` is a free-text string with no validation — nothing runs a test, checks an exit code, or requires a second agent. The task's status flips straight to 'done', claims are released and a 'finished' note is posted. It is pure self-attestation. The 'review' status exists in the schema but no code path ever routes a task through it. Credit only for stating clearly that no verification happens and it is self-reported.",
  },
  {
    id: 'starting-to-idle',
    kind: 'spanning',
    q: 'Trace every step between pty.spawn() creating an agent process and the dispatcher becoming willing to hand that agent a task. Name the components involved.',
    truth:
      "planAgent (spawn.ts) builds the argv plus a per-agent settings file containing the hooks; the TUI spawns the pty and calls joinAgent with status 'starting'; Claude Code boots and fires its SessionStart hook, which runs `parley hook session-start` in cli.ts; that handler calls joinAgent again, this time with status 'idle'; the dispatcher's freeRunnerIds() only returns agents whose status is 'idle' and which hold no unfinished task. Credit for the 'starting' → SessionStart hook → 'idle' → freeRunnerIds chain across spawn.ts, tui.ts, cli.ts and dispatch.ts.",
  },
  {
    id: 'claim-enforcement',
    kind: 'trap',
    q: 'Agent A calls parley_claim on src/store.ts. Agent B then tries to edit src/store.ts without claiming it. What stops agent B?',
    truth:
      'Nothing stops it. Claims are advisory only — a coordination signal recorded on the board, not a lock. parley_claim reports a conflict to an agent that asks, and the protocol text instructs agents to claim before editing and to back off on conflict, but no mechanism prevents a write. Real isolation would require a worktree or container per agent. Credit for stating that claims are advisory and nothing actually blocks the edit.',
  },
  {
    id: 'peer-message-path',
    kind: 'spanning',
    q: 'One agent posts a message. By what mechanism does it end up in a different agent\'s context, and how does being "linked" change what that agent sees?',
    truth:
      "The post is written to the feed table on the shared SQLite board. Each agent's UserPromptSubmit hook runs `parley hook inbox` in cli.ts, which calls drainInbox(agent) — returning feed rows newer than that agent's stored cursor and advancing it — then partitions them using linkedPeers(agent). Messages from linked peers are placed first and labelled as addressed to the agent; everything else follows as general peer traffic. It is returned as additionalContext so it arrives at the top of the agent's next turn with no polling. Credit for feed + UserPromptSubmit hook + drainInbox/cursor + linkedPeers partitioning.",
  },
  {
    id: 'tier-precedence',
    kind: 'spanning',
    q: 'A task is dispatched. What decides which model tier the handling agent runs at, and in what order of precedence?',
    truth:
      "Two places compose. tierFor(task, persona) in dispatch.ts resolves `task.model || persona.model || ''` — the per-task tier set by the planner wins over the persona's default. That result is passed as the model override into planAgent (spawn.ts), which resolves `opts.model || p.model || ''` and appends --model only if non-empty. So: explicit per-task tier, then persona default, then nothing (the CLI's own default). Credit for task tier over persona default, and for naming tierFor and/or planAgent.",
  },
  {
    id: 'duplicate-spawn',
    kind: 'blast',
    q: 'The dispatcher runs every few seconds. A task is ready but no agent in its lane is free, so it spawns one. The new agent takes 30 seconds to boot. What stops the next tick spawning another agent for the same task?',
    truth:
      'A module-level map (spawnedFor) records the timestamp of the spawn keyed by task id. Subsequent ticks skip that task while it is inside a grace period of SPAWN_RETRY_MS (60 seconds), so a slow-booting agent does not accumulate duplicates until the pane capacity is hit. The entry is deleted once the task is actually handed off. Credit for the per-task spawn timestamp plus a ~60s grace window.',
  },
  {
    id: 'orphan-claimed',
    kind: 'blast',
    q: "A task is 'claimed' by agent builder-3, but builder-3 no longer exists and never rejoined. Nothing is working the task. What returns it to the board, and what would happen without that?",
    truth:
      "Two independent paths. dropAgent (store.ts) releases the held task when an agent is removed by any route — pane closed, pty exited, reaped as dead at startup — via releaseHeldTask, which sets status back to 'open' and owner to NULL, and also clears route_to on tasks routed to that agent. Additionally reclaimStale() in dispatch.ts scans 'claimed' tasks each tick and hands back any whose owner is not in the live agent list (or which has not been updated in ~15 minutes), using blockTask. Without this the task is permanently stuck: it is not 'open' so nothing dispatches it, and nobody is working it, so everything downstream of it in the dependency graph blocks forever. Credit for naming dropAgent/releaseHeldTask or reclaimStale AND for explaining that it would otherwise be stuck because 'claimed' is not dispatchable.",
  },
  {
    id: 'submit-newline',
    kind: 'trap',
    q: 'When handing a task to a running agent, why does parley not simply write the task text with a trailing newline in one pty write?',
    truth:
      'A long string arriving as a single chunk is interpreted by Claude Code as a paste, and a newline inside a paste inserts a line break instead of submitting. The task text would sit in the input box looking dispatched but never run — a silent failure. parley writes the text, waits about 250ms, then writes the carriage return as a separate keystroke. It also sends ctrl-U first to clear anything already on the input line. Credit for the paste-detection explanation and the separate delayed newline.',
  },
  {
    id: 'claim-race',
    kind: 'spanning',
    q: 'Two dispatcher passes try to claim the same task at the same instant. What guarantees only one wins, and how does the loser find out?',
    truth:
      "claimTask issues a single conditional UPDATE whose WHERE clause requires the task to still be available — owner IS NULL or owner equal to the claiming agent, and status in ('open','blocked'). The database applies these serially, so the loser's UPDATE matches zero rows; claimTask returns changes > 0, so the loser gets false and moves on. The atomicity is the SQL WHERE clause, not any application-level lock. Credit for the conditional UPDATE and the zero-rows-means-lost mechanism.",
  },
  {
    id: 'escalation-cap',
    kind: 'trap',
    q: 'An agent reports a task blocked. It gets retried. Does this repeat forever? Describe exactly what happens across attempts.',
    truth:
      "No. blockTask reopens the task, increments attempts, and escalates the model tier one step along haiku → sonnet → opus, appending the blocking note to the detail so the next attempt starts from it. Escalation stops at the top tier, and once the tier can no longer escalate and attempts have reached MAX_ATTEMPTS (4) the task is parked with status 'blocked', which excludes it from ready() so the dispatcher stops offering it. Credit for tier escalation AND for the existence of a cap that parks the task rather than looping forever.",
  },
  {
    id: 'tutor-trigger',
    kind: 'trap',
    q: 'Does the tutor write a brief after every agent turn? What actually determines whether one gets written?',
    truth:
      "No. The Stop hook fires on every turn, but writeBrief immediately returns unless unbriefedTouches(agent) is non-empty — that is, unless the PostToolUse hook recorded file edits (Edit/Write/NotebookEdit) for that agent which have not yet been briefed. Turns that only read, run commands, or post to the board produce no brief. Credit for 'only turns that touched/edited a file' and ideally the touches table being populated by PostToolUse.",
  },
  {
    id: 'tutor-detached',
    kind: 'spanning',
    q: 'Why is the tutor run as a separate detached process rather than inline in the agent, and where does its output go?',
    truth:
      'Two reasons: run out-of-process it cannot be skipped by the coding agent to save tokens, and the explanation never competes for room in the coding context. It is spawned detached with stdio ignored and unref()ed so the Stop hook returns immediately instead of blocking Claude Code on a fresh `claude -p` call. Output goes to markdown files in the state directory (briefs/), a row in the briefs table, an appended index, extracted terms into the glossary table, and a note posted to the feed. Credit for both reasons (cannot be skipped, does not consume coding context) and the briefs directory/table.',
  },
  {
    id: 'wal-multiprocess',
    kind: 'spanning',
    q: 'Name every kind of process that opens the board database concurrently, and what makes that safe.',
    truth:
      'The TUI, one MCP server per agent, every hook invocation (SessionStart, UserPromptSubmit, PostToolUse, Stop), the detached tutor, and the standalone CLI commands all open the same SQLite file. Safety comes from PRAGMA journal_mode = WAL plus PRAGMA busy_timeout, set when the handle is opened in db(): WAL permits concurrent readers alongside a writer, and the busy timeout makes a blocked writer wait rather than fail immediately. Credit for WAL plus busy_timeout and for recognising it is many separate OS processes rather than threads.',
  },
  {
    id: 'custom-persona-reach',
    kind: 'blast',
    q: 'A persona is created at runtime and stored in the database rather than defined in code. Which code paths must resolve it for it to behave like a built-in one, and what breaks if any of them only look at the built-in list?',
    truth:
      'persona(id) must fall back to the stored personas table, and allPersonas() must return built-ins plus stored ones. The paths that need it: spawning (planAgent needs the prompt/model), the TUI roster and add-agent picker, and crucially laneFor() in dispatch.ts, whose label-overlap fallback iterates the persona list — if that only saw the built-in array, a task labelled for a custom persona would silently route to the default builder lane instead. Credit for laneFor/dispatch routing being the non-obvious one, plus persona()/allPersonas() resolution.',
  },
  {
    id: 'dep-edge-cases',
    kind: 'trap',
    q: 'A task lists a dependency on a task id that does not exist on the board. And separately, two tasks depend on each other. What does the scheduler do in each case?',
    truth:
      'They are handled deliberately differently. A dangling dependency — an id with no matching task — is treated as satisfied so the task can still run, and the situation is announced on the feed rather than silently ignored. A genuine cycle is not satisfiable and those tasks stay unready and blocked, also announced. The rendered graph additionally lists unreachable tasks (circular or dangling) in a separate section so they do not simply vanish from view. Credit for the asymmetry: dangling counts as satisfied and runs, cycles stay blocked.',
  },
  {
    id: 'coalesce-pid',
    kind: 'trap',
    q: 'joinAgent takes a pid argument that is sometimes null. Why is the pid column updated with COALESCE rather than plain assignment, and what breaks without it?',
    truth:
      "The TUI records the real pty pid when it spawns an agent, but the SessionStart hook also calls joinAgent and has no idea what the pid is, so it passes null. A plain assignment would overwrite the spawner's recorded pid with null moments later. Liveness detection uses process.kill(pid, 0) to test whether an agent is still alive, so an agent with a null pid looks dead and gets reaped almost immediately after starting. COALESCE keeps the previously recorded pid when the incoming one is null. Credit for the hook-passes-null detail and for reaping/liveness breaking.",
  },
  {
    id: 'wip-attribution',
    kind: 'trap',
    q: 'parley reports which uncommitted files each agent is working on. Given the agent only records repo-relative paths and git may report paths differently, how are dirty files attributed, and what is the known hazard in that matching?',
    truth:
      "Files an agent touched (recorded by the PostToolUse hook) are matched against the dirty paths from git status. Matching is suffix-based, and the hazard is false positives if the match is not anchored to a path-component boundary: a recorded 'foo/bar' must match '/repo/foo/bar' but must not match '/repo/xfoo/bar'. Matching on bare basenames would misattribute same-named files in different directories. Anything dirty that no agent claims is bucketed separately as not-parley's work, which is the interesting bucket. Credit for suffix matching plus the component-boundary/basename false-positive hazard.",
  },
  // Replaced 'auto-dispatch-default', which the harness correctly flagged as a
  // dud: the baseline answered it in a single turn with no tool calls at all,
  // guessing correctly from the flag's name. A question a model can guess is
  // measuring the model's priors, not the map.
  {
    id: 'stop-all-agents',
    kind: 'absence',
    q: 'From a shell outside the workspace, you want to stop every running agent at once without closing the workspace. Which command does that?',
    truth:
      "There isn't one. `parley kill <agent-id>` stops a single named agent, and it works by pushing an intent row onto the board that the running TUI drains on its next tick — so it only has any effect while a workspace is live, and there is no all-agents variant. The only way to stop everything is ctrl-q inside the workspace (which kills the panes and releases their held work) or killing the processes directly. Credit for stating no such command exists and that kill targets one agent at a time via the queued-intent mechanism.",
  },
  {
    id: 'test-coverage-gaps',
    kind: 'absence',
    q: 'Which parts of this codebase have automated test coverage, and which significant subsystems have none?',
    truth:
      'Only four modules have test files: layout, mouse, store (graph/scheduler behaviour) and watch. Everything else is untested — notably the dispatcher, the MCP server, spawn, the planner, the tutor, personas, render and the TUI itself. So the orchestration and agent-lifecycle code that carries the trickiest invariants has no coverage, while the pure functions do. Credit for naming roughly the tested set (layout/mouse/store/watch) and identifying that dispatch/mcp/spawn/planner/tutor are untested.',
  },
  {
    id: 'pane-capacity',
    kind: 'blast',
    q: 'What limits how many agents can run at once, and where does that number come from?',
    truth:
      'The limit is screen space rather than an arbitrary configured cap. paneCapacity(width, height) searches downward from a maximum, laying out the grid for n panes and returning the largest n where every pane still meets minimum readable interior dimensions. The TUI refuses to start another agent beyond that and says how many the window fits, so making the terminal larger raises the ceiling. The dispatcher also treats a failed spawn as "at capacity" and leaves the task for a later tick. Credit for the limit being derived from terminal size via a layout capacity computation, not a fixed constant.',
  },
]
