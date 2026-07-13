# S14 obs-skill-profile (web/server) + S17 GUI + null-guard audit — Requirements (EARS)

Phase 2a-B. Skill as a first-class noun: the one new view (`#skills` + `#skill/<name>`) plus the
`/api/skills` endpoint. Also the S17 activation×outcome GUI row and a null-guard audit for the
Wave 1 nullable data model. See docs §2.5a (S14), §2.5d (S17), §1.2 (degraded/excluded GUI).
CLI `aiide skill` is out of scope (bin belongs to Track A).

## S14 — skill profile

- **R14.1** `GET /api/skills` SHALL be read-only (GET only), scan BOTH experiments and runs with
  NO persistent index, and aggregate by skill name; it SHALL NOT write back to any skill/suite. (AC 14a)
- **R14.2** THE nav SHALL gain a third tab `skills`; `#skills` lists skills, `#skill/<name>` shows
  the profile. Skill badges in the runs and experiments tables SHALL link to `#skill/<name>`.
- **R14.3** THE profile SHALL show a version-evolution + score-trend chart where a trend line
  connects points ONLY within the same comparability cohort (suite.sha256·model·runtime); distinct
  cohorts get distinct colours and a labelled legend — never one line across cohorts. (AC 14b)
- **R14.4** A skill installed but never triggered (activation measured and always 0) SHALL be
  flagged "installed but never triggered — pure context tax". (AC 14c)
- **R14.5** THE profile SHALL show cards for activation rate, listing tax (paid every request),
  body tokens (paid when triggered), experiment count, and mean score, plus a table of the
  experiments using the skill (each linking to its scorecard). Null values render as n/a.

## S17 — activation × outcome GUI row (score.js field already produced by Track A)

- **R17.1** THE experiment scorecard per-task SHALL render `task.activationOutcome` as a row:
  `triggered → meanC (n) · not triggered → meanC (n)`. THREE null guardrails:
  (a) null activationOutcome → row omitted; (b) a partition with n=0 → show only the populated
  side + "never <side>", never a 0/0 comparison; (c) lowSample → "correlational, low sample".

## Null-guard audit (Wave 1 data model)

- **R18.1** Everywhere the web reads `composite` / C/P/R/H for render or arithmetic, a null SHALL
  render as n/a (never a fake 0, never a `.toFixed` throw): experiments list, scorecard cards,
  task panels, causal-compare score delta.
- **R18.2** A degraded experiment/task SHALL carry a `degraded` badge (--warn); excluded repeats
  SHALL show an `excluded` badge + signature in the per-task drill-down and an excluded count on
  the repeats-ok card. (docs §1.2 GUI)
- **R18.3** A fixture with degraded + null composite SHALL render the dashboard without crashing.
