# S2 · eval-error-triage-retry — Tasks

Design: `docs/aiide-update-solution.md` §1.2. Files: `src/score.js`, `src/lab.js`, `bin/aiide.js`,
`test/core.test.js` + `test/lab.test.js`, `test/fixtures/claude-stub.js` (env-noise modes).

## Tasks

- [x] T1 — `src/score.js` guardrails: `scoreTask` filters `excluded` reps out of the denominator;
  C=null when valid-n=0 (fix `mean([])→0`); composite=null when valid-n=0 OR (excluded>0 &&
  valid-n<MIN_REPEATS); emit `excludedRepeats`/`degraded`/`excludedSignatures`. `scoreExperiment`
  filters null composites (guardrail b), aggregates `degraded`/`excludedRepeats`.
- [x] T2 — `src/lab.js` retry+exclusion: `classifyEnvNoise(text)` signature list; `noiseText` reads
  stderr + process-error + trace tool-error results (never model answer); retry loop with exponential
  backoff (`suite.retry.{maxRetries,baseDelayMs}`); timeout never retried/excluded; exhausted+signature
  → mark `excluded`; emit `repeat-retry` + `repeat-done{excluded}` events; raw error to per-repeat log.
- [x] T3 — `bin/aiide.js` BOTH render paths: `printScorecard` degraded banner + per-task `(N excluded)`
  + null-composite → n/a; `printComparison` per-cell `degraded (N excluded)` + null guard; retry/excluded
  terminal lines.
- [x] T4 — Tests: signature classifier units; scoreTask exclusion (all-excluded→null, floor-breach→n/a,
  degraded flag); scoreExperiment null-filter; e2e retry-recovers + retry-exhausted-excluded via stub;
  timeout-not-excluded; comparison degraded cell.

## Deviations
- **D1**: env-noise classification reads infra surfaces only (stderr, process-failure error, trace
  tool-error results), not the model's final answer — this is what makes the whitelist unforgeable
  (§1.2 "skill 造不出"). For isolated claude-code (no MCP/external service), external-auth noise like
  53017 cannot occur; that signal path is exercised by the command-adapter/service runtime whose trace
  carries tool-error results. In-scope and consistent with the design.
- **D2 (R4.3 scope)**: valid-n < MIN_REPEATS forces composite=null ONLY when caused by exclusions
  (`excluded>0`). A suite deliberately run at repeats<3 keeps its numeric composite + existing
  lowSample warning (no regression). This matches the spec's wording "valid-n 跌破 floor" (dropped,
  i.e. exclusion-driven) and guardrail a (all-excluded).
</content>
