# S3 · eval-verifier-fileexists-passk — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §1.3 + spec table S3.
> Iron rules: zero-dep · deterministic-first (pass@k is DIAGNOSTIC, never composite) · governance-neutral.

## Requirements

R1 — filesystem verifier as an independent class (does not pollute pure-text `runVerifier`)
- R1.1 The system SHALL add a `file_exists` verifier evaluated by a NEW function
  `runFileVerifier(v, workspaceDir)`; the pure-text `runVerifier(v, text)` (regex / numeric_range /
  json_field) SHALL remain untouched.
- R1.2 (AC a) `file_exists` SHALL resolve `v.path` against the repeat's effective workspace — for
  claude-code and for a command adapter with `cwd` omitted this is the per-repeat empty workspace
  (adapters.md:26); a command adapter with explicit `runtime.cwd` resolves against that cwd.
- R1.3 `file_exists` MAY carry an optional JSON schema: WHEN `v.schema.required` (array of dot-paths)
  is present, the file SHALL parse as JSON and contain every required path (non-null), else fail.
- R1.4 A `file_exists` verifier participates in C exactly like a text verifier (all verifiers must
  pass for C=1).

R2 — pass@k diagnostics (deterministic-first)
- R2.1 The system SHALL compute pass@k (unbiased Chen et al. estimator) over a task's VALID
  (non-excluded) per-repeat C values, for k ∈ {1, 3} ∩ {k ≤ valid-n} (plus any `suite.passK`).
- R2.2 (AC b) pass@k SHALL appear only in the scorecard diagnostic area and SHALL NEVER enter the
  composite score.

R3 — Zero regression (AC c)
- R3.1 Pure-text verifiers (regex / numeric_range / json_field) SHALL behave identically to before.
</content>
