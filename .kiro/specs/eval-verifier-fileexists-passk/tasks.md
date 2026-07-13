# S3 · eval-verifier-fileexists-passk — Tasks

Design: `docs/aiide-update-solution.md` §1.3. Files: `src/score.js`, `src/lab.js`, `bin/aiide.js`,
`test/core.test.js` + `test/lab.test.js`.

## Tasks

- [x] T1 — `src/score.js`: `runFileVerifier(v, workspaceDir)` (file_exists + optional JSON schema),
  a `FILESYSTEM_VERIFIERS` set + `evalVerifier(v, text, workspaceDir)` router; thread `workspaceDir`
  into `scoreRepeat` (default `.`); keep `runVerifier` pure-text untouched. `passAtK(n,c,k)` unbiased
  estimator + `passAtK` map in `scoreTask` output (diagnostic only, over valid samples).
- [x] T2 — `src/lab.js`: compute the per-repeat effective `verifyDir` (workspaceDir, or substituted
  `runtime.cwd`); thread it into `buildRepeat` → `scoreRepeat` and the completion-only branch.
- [x] T3 — `bin/aiide.js`: append `pass@1=… pass@3=…` to the per-task diag line.
- [x] T4 — Tests: file_exists pass/miss + JSON-schema pass/miss; text-verifier zero-regression;
  pass@k estimator values + not-in-composite; e2e claude-code file_exists against the repeat workspace.

## Deviations
- **D1 (JSON schema shape)**: §1.3 says "可選 JSON schema" without a concrete shape. Implemented as
  `v.schema.required = [dot.path, …]` (reuses json_field path semantics) — minimal, deterministic,
  extensible. Noted so a richer schema can slot in later without breaking the contract.
- **D2 (pass@k set)**: default k ∈ {1,3}∩{k≤valid-n}; `suite.passK` overrides. Matches the spec's
  `pass@1 pass@3` terminal example; smaller suites simply show fewer k.
</content>
