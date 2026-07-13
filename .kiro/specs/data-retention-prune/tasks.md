# S11 · data-retention-prune (CLI) — Tasks

Design: `docs/aiide-update-solution.md` §4.2. Files: NEW `src/prune.js`, `bin/aiide.js`, `test/*`.

## Tasks
- [x] T1 — `src/prune.js`: `parseDuration`, `planPrune({dataDir,olderThanMs,max,now})` (lists runs +
  experiments non-recursively, ts from startedAt/createdAt→mtime fallback, selects too-old OR
  over-max, resolves each experiment's annotations sidecar), `executePrune(plan)`, `formatBytes`.
- [x] T2 — `bin/aiide.js`: `aiide prune --older-than <dur> | --max <N> [--yes]` — require a selector,
  print preview, delete only on `--yes`; usage text. (dashboard hint is Phase 2b/web — not here.)
- [x] T3 — Tests: preview lists but deletes nothing; `--yes` deletes selected + annotations sidecar;
  settings/pricing/journal untouched; `--max`/`--older-than` selection correct; no selector → error.

## Deviations
- **D1 (combinable selectors)**: `--older-than` and `--max` may be given together; an item is pruned if
  it is too old OR beyond the newest N (union of deletion / intersection of retention). Either alone
  leaves the other dimension unbounded.
- **D2 (scope)**: prune removes runs/experiments/annotations only — NOT the pruned experiments' logs/
  workspaces (keyed by resumeKey/expId). Those may orphan; out of the spec's stated scope. Journals
  and config files are structurally excluded (R3.1).
</content>
