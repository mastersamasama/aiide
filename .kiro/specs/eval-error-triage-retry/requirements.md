# S2 · eval-error-triage-retry — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §1.2 + spec table S2 (six hard ACs).
> This is the flagship moat-amplifier: honest partial scoring. Statistical basis (入檔): repeats are
> the SAME identical task repeated, so env-noise is MCAR (missing completely at random) — removing
> excluded samples introduces no selection bias; CIs widen honestly as valid-n shrinks.
> Iron rules: zero-dep · deterministic-first · governance-neutral.

## Requirements

R1 — Signature-based env-noise whitelist (guardrail 3)
- R1.1 WHEN a repeat fails, the system SHALL classify the failure against a signature whitelist:
  HTTP 429 / 529, ECONNREFUSED (+ transient network), auth-expiry (incl. onchainos `53017`),
  rate-limit. Classification reads infra surfaces (process stderr, process-failure error, trace
  tool-error results) — NEVER the model's own answer text — so a skill cannot forge the signal.
- R1.2 A cleanly successful repeat (C=1, no error) SHALL never be classified as env-noise.

R2 — Retry with exponential backoff
- R2.1 WHEN a failed repeat matches the whitelist AND retry budget remains, the system SHALL retry
  with exponential backoff.
- R2.2 WHEN a retry succeeds, the successful repeat SHALL replace the failed one and `n`
  (the valid-sample denominator) SHALL stay = repeats (transient jitter handled, Wilson honest).

R3 — Exclusion (never fake C=0)
- R3.1 WHEN retries are exhausted AND the failure still matches the whitelist, the repeat SHALL be
  marked `excluded (env-noise)` and removed from the denominator (valid-`n` shrinks). It SHALL NEVER
  be scored C=0 (auth expiry is an uncontrolled benchmark variable, not a skill failure).
- R3.2 (AC c) `timeout` and generic `exit != 0` (no signature) SHALL NOT be excluded — they count as
  C=0 (a timeout may be the skill looping).

R4 — Three honesty guardrails (hard, each missing one = a scoring backdoor)
- R4.1 (guardrail a / AC a) WHEN every valid sample is excluded (valid-n = 0), C SHALL be null and
  composite SHALL be null — NOT 0. (Fixes the latent `mean([]) → 0` fake-zero at score.js.)
- R4.2 (guardrail b / AC b) `scoreExperiment` SHALL filter out null composites before averaging, so a
  null task composite never pollutes the experiment composite as a 0.
- R4.3 (guardrail c / AC f) WHEN valid-n drops below `MIN_REPEATS` because of exclusions, the task
  composite SHALL display n/a (null) and the lowSample flag SHALL be set.

R5 — Degraded propagation to BOTH render paths (AC e — the core reason this feature exists)
- R5.1 `scoreTask` SHALL emit `excludedRepeats` (count) alongside `failedRepeats`, plus a `degraded`
  flag; `scoreExperiment` SHALL aggregate `degraded` + total `excludedRepeats`.
- R5.2 `degraded` / `excludedRepeats` SHALL appear in BOTH `printScorecard` (bin/aiide.js) AND
  `printComparison` (bin/aiide.js). Comparison SHALL mark each degraded cell `degraded (N excluded)`.
  (Otherwise `--models a,b` with model B's window auth-dead prints a bare composite → false "B < A".)

R6 — Auditability (AC d)
- R6.1 Each excluded repeat's RAW error SHALL be written to its per-repeat log (S1 R7) — exclusion is
  an evidenced, auditable decision, not a silent denominator shrink.

## Prominent / silent UX
- Silent when no exclusions.
- Any exclusion → scorecard top prints `⚠ degraded: N repeats excluded (env-noise: <sig>) — score on
  valid samples only`; comparison prints `degraded (N excluded)`.
- Terminal: `… retry 1 (429, backoff 2s) … excluded`; task line `ok=3/3 (2 excluded)`.
</content>
