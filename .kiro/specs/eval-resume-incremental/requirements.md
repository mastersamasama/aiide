# S1 · eval-resume-incremental — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §1.1 + §1.5 + spec table S1.
> Iron rules: zero-dep · experiment.json write-once immutable (journal is a NEW artifact class,
> sealed files never mutated) · governance-neutral (read-only outputs).

## Glossary
- **journal**: append-only progress file `<data-dir>/experiments/.inprogress/<resumeKey>.jsonl`.
- **resumeKey**: `${suite.name}-${model}-${suiteSha8}` (filesystem-sanitized).
- **completed repeat**: a `(taskId, repeat)` pair already recorded in the journal.

## Requirements

R1 — Incremental journaling
- R1.1 WHEN a repeat finishes (success OR failure), the system SHALL append one JSON line
  `{taskId, repeat, rep, ts}` to the journal before starting the next repeat.
- R1.2 The journal's first line SHALL be a header
  `{__aiide_journal, name, model, repeats, suiteSha256, createdAt, aiideVersion}`.
- R1.3 The system SHALL never mutate a sealed `experiments/<id>.json`; the journal is a separate
  artifact class representing only the "in progress" concept.

R2 — Resume / skip-completed (AC a)
- R2.1 WHEN `aiide lab run` starts AND a journal for the same (name, model, suiteSha256, repeats)
  exists, the system SHALL resume: load completed repeats and skip re-running them.
- R2.2 WHEN a repeat is served from the journal, the system SHALL emit it as `cached` and the
  terminal SHALL print `✓ (cached)` instead of re-running.
- R2.3 WHEN resuming, AFTER preflight the system SHALL print one line
  `↻ resuming: <done>/<total> repeats done, <togo> to go`.
- R2.4 WHEN no journal exists, the run SHALL proceed exactly as before (silent, zero perception).

R3 — Config-drift rejection (AC b)
- R3.1 WHEN a journal for the same (name, model) exists BUT its `suiteSha256` OR `repeats` differs
  from the current run, the system SHALL reject with
  `cannot resume: <what> changed (<old>→<new>) — use --fresh` AND SHALL NOT start any task.
- R3.2 WHEN `--fresh` is passed, the system SHALL delete any existing (name, model) journal and
  start a fresh run.
- R3.3 A different `model` SHALL produce an independent journal (its own identity), consistent with
  how `--models a,b` already treats each model as a separate experiment. [deviation — see tasks.md]

R4 — Immutable seal + cleanup (AC c)
- R4.1 WHEN all repeats are done, the system SHALL assemble `experiments/<id>.json` from all repeats
  (resumed + new) as a write-once timestamped file, THEN delete the journal.
- R4.2 IF sealing throws, the journal SHALL remain on disk (crash-safe / resumable).

R5 — Dashboard invisibility (AC d)
- R5.1 The journal SHALL live under `experiments/.inprogress/` (a subdirectory) with a `.jsonl`
  extension, so `listExperiments` (non-recursive `readdirSync` + `endsWith('.json')`, server.js:117)
  filters it out with zero server changes.

R6 — Crash tolerance (AC e)
- R6.1 WHEN the journal has a corrupt/truncated tail line, the parser SHALL skip it and resume from
  the remaining valid lines without crashing (append-only + crash-safe).

R7 — Per-repeat log directory (§1.5, folded into S1)
- R7.1 FOR each freshly-run repeat, the system SHALL write `stdout` / `stderr` / `exception` / `trace`
  to `<data-dir>/logs/<resumeKey>/<taskId>-r<i>/` (independent per-repeat directory).
- R7.2 Log-write failures SHALL degrade silently (never take the experiment down).
- R7.3 The exception file SHALL carry the raw error string (S2's excluded-audit depends on this).
</content>
</invoke>
