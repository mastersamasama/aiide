# S12 · eval-multistep-task — Tasks

Design: `docs/aiide-update-solution.md` §4.3. Files: `src/lab.js`, `bin/aiide.js`, `test/lab.test.js`.

## Tasks

- [x] T1 — Refactor the inner repeat body into an `attemptInvocation({...})` closure in `runSuite`
  (retry loop + env-noise classification), with a `cleanWorkspace` flag. Single-step path calls it
  once with `cleanWorkspace:true` — behavior BYTE-IDENTICAL to before (backward compat).
- [x] T2 — `runMultiStep`: clean workspace once, run each step via `attemptInvocation`
  (`cleanWorkspace:false`, shared workspace), compute step reward, abort when reward < minReward,
  aggregate into one repeat rep (C = all-ran && all-reward-1; P/H mean; activation OR; efficiency sum;
  `steps[]` + `abortedAtStep`). Persistent env-noise in a step → whole repeat excluded.
- [x] T3 — `bin/aiide.js`: repeat-done prints `(aborted@step N)` when present.
- [x] T4 — Tests: multi-step all-pass → C=1; step-2 fails min_reward → abort, C=0, abortedAtStep=2,
  step 3 never runs; single-step suite unchanged (regression); file persists across steps (file_exists).

## Deviations
- **D1 (reward model)**: reward = fraction of a step's verifiers passing; `minReward` default 1
  ("must fully pass to proceed", matching §4.3 "前一步沒過就不跑下一步"). C stays strict (all steps
  reward=1) independent of a looser minReward gate.
- **D2 (state sharing)**: steps share the filesystem workspace, NOT conversation/session context —
  each `claude -p` is stateless by the isolated-lab design. This fits the file-passing multi-step
  shape (query→write→verify); conversational continuity is out of scope (zero-侵入 constraint).
</content>
