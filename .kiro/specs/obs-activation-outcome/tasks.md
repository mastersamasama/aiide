# S17 · obs-activation-outcome — Tasks

Design: `docs/aiide-update-solution.md` §2.5d. Files: `src/score.js`, `bin/aiide.js`, `test/core.test.js`.

## Tasks

- [x] T1 — `src/score.js`: `activationOutcome(validReps)` partitions valid reps by `activated` and
  returns `{triggered, notTriggered, lowSample}` with the three null guardrails; include on the
  `scoreTask` return (diagnostic, never in composite).
- [x] T2 — `bin/aiide.js`: `printScorecard` per-task `activation×outcome:` line, collapsing empty
  sides + low-sample tag.
- [x] T3 — Tests (`test/core.test.js`): both sides populated; no-targetSkills → null (not {n:0});
  one-sided → other side null (no 0/0); low-sample tag; read-only (input reps unmutated).

## Deviations
- **D1 (skill name in line)**: §2.5d's example shows the skill name (`triggered okx-dex-market → …`),
  but the SCORED task object doesn't carry targetSkills. The line renders without the per-skill name
  (cosmetic); the causal signal (meanC by partition) is fully present. GUI row (Phase 2) can add the
  name from the experiment's task defs.
- **D2 (partition set)**: computed over VALID (non-excluded) repeats to stay consistent with the
  honest denominator (S2) — excluded env-noise samples never got a fair trial, so they don't inform
  the activation×outcome correlation.
</content>
