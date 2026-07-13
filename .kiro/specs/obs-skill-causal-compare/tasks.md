# S15 obs-skill-causal-compare — Tasks

- [x] **T1** `web/obs.js`: `cohortComparable(a,b)` (suite.sha256 + model + runtime gate),
  `skillHashDeltas(a,b)` (changed hashes only), `ciOverlap`, `causalWithinNoise(a,b)`,
  `meanActivation(exp)`.
  - Tests: `test/web-obs.test.js` → "S15: causal gate requires same suite+model+runtime (AC 15a)",
    "S15: skillHashDeltas returns only changed hashes (AC 15c)", "S15: within-noise only when
    every shared task CI overlaps (AC 15b)", "S15: meanActivation ignores null rates…".
- [x] **T2** `web/index.html`: `causalCompareRow(a,b)` at the top of viewCompare (⇒ only when
  comparable AND exactly one skill changed; else correlational + reasons; within-noise badge only
  when all task CIs overlap).
- [x] **T3** `web/index.html`: extend the cross-runtime warning to `!cohortComparable(a,b)` (adds
  suite.sha256 + model to the existing runtime + endpointHost check).
- [x] **T4** i18n `causal.*` (en + zh-hans).

## Deviations
- "⇒" additionally requires exactly one changed skill hash: with multiple skills changed the
  single-skill causal claim is unsound, so the row degrades to correlational (honest-comparison).
