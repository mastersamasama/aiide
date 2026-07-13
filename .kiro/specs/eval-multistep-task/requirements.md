# S12 · eval-multistep-task — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §4.3 + spec table S12.
> Depends on S3 (verifier types) + S1 (execution loop). Iron rules: zero-dep · deterministic-first ·
> experiment.json write-once (multi-step reps are ordinary journal/experiment records).

## Requirements

R1 — `steps` array
- R1.1 A task MAY declare `steps: [{ prompt, verifiers, targetSkills?, minReward? }, …]`. Each step is
  a sequential agent invocation sharing ONE repeat workspace (files persist across steps), so step 2
  can consume step 1's artifacts.
- R1.2 Each step's reward SHALL be the fraction of its verifiers that pass (no verifiers → 1).

R2 — min_reward early abort (AC a)
- R2.1 WHEN a step's reward < its `minReward` (step-level, else task-level, default 1), the system
  SHALL abort the remaining steps and record `abortedAtStep` (1-based) on the repeat.
- R2.2 The repeat's C SHALL be 1 only when every step ran AND every step reward = 1; otherwise 0.
- R2.3 Per-step drill-down (`steps[]`: index / reward / C / verifierResults / runId) SHALL be retained.

R3 — Backward compatibility (AC b)
- R3.1 A task WITHOUT `steps` SHALL run exactly as before (single invocation, identical scoring).

R4 — Integration with S1/S2/S3
- R4.1 Multi-step reps SHALL journal + resume like any repeat (S1) and be excludable on persistent
  env-noise in any step (S2). `file_exists` verifiers resolve against the shared workspace (S3).
- R4.2 P/H/activation/efficiency for a multi-step repeat SHALL aggregate across executed steps
  (mean for P/H, OR for activation, sum for efficiency/rounds) — never fabricated for un-run steps.
</content>
