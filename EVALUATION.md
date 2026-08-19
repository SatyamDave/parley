# Does the map actually help?

This repository makes an empirical claim, so this file is the evidence, the
method, and the parts that did not work. The harness is
`scripts/map-ab.mjs`; it is parameterised (`AB_REPO`, `AB_QUESTIONS`) so the
same test can be run against any repository, including yours.

## Method

Same agent, same questions, twice: once with `parley map --agent` output in
context, once with nothing. Answers graded against hand-written ground truth.
Two measures: **accuracy** (fraction correct) and **turns** (agent steps to an
answer, the cost proxy). Two repositories, two runs each, to separate a real
effect from run-to-run noise.

Repo 2 (Vite's dev-server core) was chosen specifically because nobody involved
wrote it. Measuring only on parley's own repo would test a map of a codebase the
map's author already understood.

## Results

| | accuracy | turns |
|---|---|---|
| parley, own repo (21 questions x 2 runs) | +7.1pp (z=1.18) | **-6.9%** |
| Vite dev-server core (20 questions x 2 runs) | -2.5pp (z=-0.46) | **-16.5%** |

Neither accuracy delta is statistically significant. **The efficiency gain
replicates across two structurally unrelated codebases; the accuracy gain does
not.**

The same two question categories win both times:

| question type | parley | Vite |
|---|---|---|
| spanning (answer requires several files) | -16% turns | -30% turns |
| absence ("prove X is not handled here") | -40% turns | -24% turns |

That pattern is the interesting part, and it is mechanically explainable: both
categories are ones where an agent without a map does not know when to stop
searching. A map bounds the search. Single-file questions gain nothing, which is
what you would expect.

### The claim to carry forward

*A verified map is a genuine efficiency tool for cross-file and
prove-a-negative questions. It is not a proven accuracy tool.*

Two independent tests have now failed to show a significant accuracy gain. The
published result this replicates against (RIG, arXiv:2601.10112) reports +12.2%
accuracy and -53.9% time across eight repositories and three commercial agents;
we reproduce the direction of the time effect at smaller magnitude and do not
reproduce the accuracy effect at all. Both are reported here because a tool that
only publishes the half that worked is not measuring, it is advertising.

## The finding that shaped the architecture

**Provenance is not a correctness check.**

One map claim cited exactly the right file and asserted the opposite of what
that file did. An agent given that map took **19 turns**; the same task with no
map at all took **9**. A confidently wrong map is worse than no map, and
correct citations do not prevent it — the claim was fully traceable and fully
false.

`src/map/verify.ts` exists because of that measurement, not on principle. A
second, independent model call tries to *disprove* each claim against only the
files it cited. Only `supported` claims are presented to an agent as fact;
`contradicted` ones are dropped; `unsupported` ones are kept and visibly marked,
because hiding them would trade a false positive for a false negative.

Cost: claims are batched by shared evidence, which cut ~102 model calls to ~24
on parley's own map with no measured quality loss (survival held at 87%, and the
known-false claim above was still caught).

The falsification prompt itself took three iterations to become trustworthy
(59% -> 77% -> 80% agreement with hand judgement). Two failure modes had to be
removed: rejecting a true claim for using different vocabulary than the code,
and treating *absence of evidence* as contradiction when the evidence had simply
been truncated out of the prompt.

## Two errors in this evaluation, corrected

Kept here on purpose, because an evaluation with no recorded mistakes is not one
anybody checked.

1. **A ground-truth answer was wrong.** On `transform-vs-static-order` the
   answer key said the transform pipeline wins. It does not: the static
   middleware is registered eight lines earlier, with a comment stating that
   public files are served untransformed. The map's answer was right and the
   grader was wrong. Corrected and annotated.

2. **A result was over-read.** An early write-up claimed RIG's accuracy finding
   had reproduced. It had not — the *no-map* baseline moved from 5/6 to 6/6 on
   identical questions between runs, which is the size of the entire effect
   being claimed. That was run-to-run noise being read as signal, and it is the
   reason every number above is reported over two runs.

## What has not been tested

- Two repositories, both moderate-sized TypeScript. No large repository, and
  nothing approaching the point where the agent-facing map exceeds its token
  budget and starts being truncated.
- `skeleton.ts` handles Python, Go and Rust, but the A/B was run on TypeScript
  only. The multi-language paths are unit-tested, not benchmarked.
- Error compounding across layers (skeleton -> narrative -> verification) is
  unmeasured.
- Human comprehension. There is no rigorous published evidence that generated
  architecture documentation improves human understanding, and none is claimed
  here. That benefit is the reason the tool exists and it remains unmeasured;
  the agent-efficiency result above is the one with data behind it.
