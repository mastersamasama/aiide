# S14 obs-skill-profile (web/server) + S17 GUI + null-guard — Tasks

## S14
- [x] **T1** `src/server.js`: `listSkills(dataDir)` + `finalizeSkill` + `GET /api/skills`
  (read-only, no index, join experiments+runs by name, versions keyed by hash, neverTriggered flag).
  - Test: `test/server.test.js` → "server: /api/skills joins experiments + runs, keys versions by
    hash (S14)".
- [x] **T2** `web/index.html`: `#skills` nav tab + router (`#skills`, `#skill/<name>`, nav-active).
- [x] **T3** `web/index.html`: `viewSkills` (list) + `viewSkill` (profile cards, never-triggered
  panel, experiments table) + `skillTrendChart`/`skillCohortKey` (cohort-scoped trend lines,
  per-cohort colours + legend, null composite as hollow markers, hash-change ringed points).
- [x] **T4** `web/index.html`: skill badges in runs + experiments tables link to `#skill/<name>`
  (event.stopPropagation to keep row click intact).
- [x] **T5** i18n `nav.skills` + `skill.*` / `skills.*` / `th.*` (en + zh-hans).

## S17 GUI
- [x] **T6** `web/index.html`: `activationOutcomeRow(ao, skills)` (three null guardrails) rendered
  in `taskPanel`; `taskPanel` now receives `e.profile.skills` for the label.
- [x] **T7** i18n `ao.*`.

## Null-guard audit
- [x] **T8** `web/index.html`: `scoreHtml(x)` null-safe score cell; applied to experiments-list
  composite, scorecard composite card, task-panel composite, skill views, and causal-compare
  score delta (null delta → n/a).
- [x] **T9** `web/index.html`: `degraded` badge on experiments list / scorecard / task panel;
  per-repeat `excluded` badge + signature in drill-down; excluded count on repeats-ok card.
- [x] **T10** `src/server.js`: surface `degraded` + `excludedRepeats` in `listExperiments`.
  - Test: `test/server.test.js` → "server: experiments list surfaces degraded + nullable composite".
- [x] **T11** Browser smoke with a degraded/null-composite fixture — dashboard renders, 0 console errors.

## S14 CLI (Phase 2b — bin boundary opened)
- [x] **T12** Extract the skill aggregation into `src/skills.js` (`aggregateSkills(dataDir)`),
  shared by `server.js` (`GET /api/skills`) and the CLI so the two never drift.
  - Test: `test/watch.test.js` → "skills: aggregateSkills joins experiments + runs, versions by
    hash, never-triggered flag".
- [x] **T13** `bin/aiide.js` `cmdSkill()`: no-arg lists all skills (name/versions/activation/score);
  `aiide skill <name>` prints the version timeline + per-cohort score trend (cohorts never chained),
  ✓/✗/┌─│└ conventions. Read-only; "adoption is always a human decision" footer.

## Deviations
- Per-skill activation rate is approximated by the mean of `task.activationRate` across a skill's
  experiments (the stored data has per-task, not per-skill, activation). Honest for the common
  single-skill profile; noted as an approximation for multi-skill profiles.
