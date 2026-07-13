# S1 · eval-resume-incremental — Tasks

Design: `docs/aiide-update-solution.md` §1.1/§1.5 (referenced, not re-written).
Files: `src/lab.js` (journal + loop), `bin/aiide.js` (--fresh + resume/cached output), `test/lab.test.js`.

## Tasks

- [x] T1 — Journal primitives in `src/lab.js` (self-contained, no new file, stays in the allowed set):
  `computeResumeKey`, `findJournal` (scan `.inprogress/` by header name+model → resume|drift|none),
  `loadJournalRepeats` (tolerate bad tail line), `ensureJournal`, `appendJournalRepeat`,
  `clearJournals`, `writeRepeatLogs`. Compute `suiteSha256` early (createHash on suite file).
- [x] T2 — Wire resume into `runSuite`: accept `fresh` option; detect journal after preflight +
  experiments mkdir, before service start; throw on drift; emit `resume` progress event; ensure
  journal; in the repeat loop skip cached `(taskId, repeat)` and emit `cached:true`; append + log
  each fresh repeat; seal experiment.json (unchanged path) then `unlinkSync` the journal.
- [x] T3 — `bin/aiide.js`: `fresh = args.includes('--fresh')` (parser can't do bare booleans as last
  arg); pass to runSuite; handle `resume` event (`↻ resuming: d/t …`) and `cached` repeat-done
  (`✓ (cached)`); add `--fresh` to usage.
- [x] T4 — Tests in `test/lab.test.js`: (a) resume uses cached reps, only new repeats re-run + journal
  deleted; (b) drift on repeats change throws; (c) drift on suite sha change throws; (d) `--fresh`
  ignores journal; (e) bad tail line tolerated; (f) per-repeat logs written; (g) journal invisible to
  `endsWith('.json')` filter.

## Deviations

- **D1 (R3.3, model-drift)**: Spec §1.1 lists `model` among drift dimensions, but `model` is part of
  the experiment identity (expId, resumeKey, and `--models a,b` all key on model). Rejecting a model
  change would break `--models` resumability (model A's journal would false-reject model B). Ruling
  (“守住驗收要點意圖 + 最小改動”): a model change yields an *independent* journal (fresh run), so the
  intent “never silently resume with mismatched config” is preserved without breaking `--models`.
  Suite-sha and repeats drift ARE rejected as specified.
- **D2 (✗ glyph)**: drift is surfaced by throwing; bin/aiide.js top-level handler prints `error: …`.
  The message text matches the spec (`cannot resume: … — use --fresh`); the exact `✗` prefix is not
  reproduced (cosmetic). AC intent (reject + do not start) is met by throwing before any task runs.
</content>
