# S11 data-retention-prune — dashboard read-only hint (web part, Track B)

Web-only companion to the `aiide prune` CLI (Track A owns requirements.md / tasks.md). The
dashboard NEVER deletes and adds NO DELETE endpoint — it only surfaces what could be cleaned and
a copy-only command. This is the read-only iron rule made visible.

## Acceptance criteria (EARS)

- **R11w.1** THE runs page SHALL stay silent until runs cross a threshold: count > 200 OR oldest
  run older than 90 days. (visual-volume: normally silent)
- **R11w.2** WHEN a threshold is crossed, THE page SHALL show one dim line: `N runs · oldest Md —
  clean up with <aiide prune …>` with a copy button (shared copy confirmation micro-interaction).
- **R11w.3** THE suggested command SHALL be age-based (`--older-than 90d`) when the age threshold
  trips, else count-based (`--max 200`); it SHALL omit `--yes` so the CLI still prompts.
- **R11w.4** THE dashboard SHALL NOT delete anything and SHALL NOT add a DELETE endpoint.

## Tasks
- [x] `web/obs.js` `pruneHint(runs, {maxRuns=200, maxAgeDays=90, now})` (pure, testable).
  - Test: `test/web-obs.test.js` → "S11: prune hint stays silent under thresholds, fires on age or count".
- [x] `web/index.html` viewRuns: render the dim hint + copy button; `copyText(btn, text)` extracted
  from `copyJson` (shared `clipboardWrite` + `flashCopied`).
- [x] i18n `prune.*` (en + zh-hans).
- [x] Browser smoke: 190-day-old run → hint `🗄 2 runs · oldest 189d — … aiide prune --older-than
  90d`, copy button confirms "✓ copied", 0 console errors.

## Deviations
- Thresholds (200 runs / 90 days) are the defaults from the task brief; `pruneHint` accepts
  overrides for future configurability.
