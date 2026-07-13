# S17 · obs-activation-outcome — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §2.5d + spec table S17.
> The "two-halves-united" moat: observe (did the skill trigger) × eval (the score) in ONE record —
> answers "did triggering this skill actually HELP?". Depends on Wave 1 S2/S3 (same score.js region,
> textual-not-logical). Iron rules: deterministic-first (diagnostic, never composite) ·
> governance-neutral (read-only, no write-back). GUI row is Phase 2 (web/index.html) — NOT in scope.

## Requirements

R1 — `activationOutcome` task field (AX-first)
- R1.1 `scoreTask` SHALL emit a task field
  `activationOutcome: { triggered: {n, meanC} | null, notTriggered: {n, meanC} | null, lowSample }`
  computed as a PURE ADDITIVE read of the valid (non-excluded) repeats' `{activated, C}`.
- R1.2 It SHALL NEVER enter the composite (it is a correlation readout, diagnostic only).

R2 — Three null honesty guardrails
- R2.1 (AC a) WHEN no repeat carries an activation signal (all `activated == null`, i.e. no
  targetSkills), `activationOutcome` SHALL be null — NOT `{n:0}` (do not fake a comparison).
- R2.2 (AC b) WHEN one partition is empty (all triggered, or none triggered), only the populated side
  SHALL be present; the empty side SHALL be null — never render a 0/0 comparison.
- R2.3 (AC c) WHEN a populated side has n < MIN_REPEATS, `lowSample` SHALL be true ("correlational,
  low sample").

R3 — Read-only (AC d)
- R3.1 The computation SHALL only READ `repeats[].{activated, C}`; it SHALL write back to no skill or
  suite file.

R4 — Terminal scorecard line (GUI is Phase 2, excluded)
- R4.1 `printScorecard` SHALL print one per-task line when `activationOutcome` is present:
  `activation×outcome: triggered → <meanC> (n=x) · not-triggered → <meanC> (n=y)`, collapsing the
  empty side to `never triggered` / `never not-triggered`, appending `[correlational, low sample]`
  when `lowSample`.
</content>
