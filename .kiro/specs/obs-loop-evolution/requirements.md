# S16 obs-loop-evolution — Requirements (EARS)

Run-detail four-bucket `_attr` stacked chart over turns (new chart) + deterministic loop
detection. Depends on S4 (`_attr` + viewRun render). See docs §2.5c.

## Acceptance criteria (hard)

- **R16.1** THE stacked chart SHALL be NEW (not sparkline/barChart, which assume non-negative,
  `web:967`/`web:977`). (AC 16a)
- **R16.2** WHERE `_attr.other` (residual) is negative (compaction / cache eviction), THE chart
  SHALL draw it BELOW the baseline as a shrink marker; IT SHALL NEVER be a positive height. (AC 16b)
- **R16.3** THE positive buckets (prevOut / toolRes / injected, plus a positive residual as
  "unattributed") SHALL stack above the baseline.
- **R16.4** Loop detection SHALL recognise ONLY deterministic structural signals: N consecutive
  tool calls with the same name AND normalized-input exact-equal OR exact-prefix, or N
  consecutive same-name tool errors. NO semantic similarity. (AC 16c)
- **R16.5** Loop detection SHALL be normally silent, fire only at high confidence (runs >= N),
  spell out the evidence (count · tool · round range), and N SHALL be configurable
  (localStorage `aiide-loop-n`, default 4).
- **R16.6** WHEN a run has a single round (no `_attr`), THE stacked chart SHALL NOT be drawn.

## Non-goals
- No semantic loop judgement (would break deterministic-first). Read-only; nothing written back.
