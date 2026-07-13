# S16 obs-loop-evolution — Tasks

- [x] **T1** `web/obs.js`: `normalizeInput` (key-stable), `detectLoops(rounds, threshold=4)`
  (identical/exact-prefix input + repeated same-name error), `stackSeries(rounds)` (signed residual).
  - Tests: `test/web-obs.test.js` → "S16: detects N identical tool inputs…", "S16: exact-prefix…",
    "S16: repeated same-name tool errors…", "S16: stackSeries carries negative residual signed…",
    "S16: normalizeInput is key-order stable".
- [x] **T2** `web/index.html`: `stackedAttrChart(series)` (diverging: positive stack up, negative
  residual below baseline), `loopBanner(findings)`.
- [x] **T3** `web/index.html` viewRun: compute `attrStack`/`loops` (threshold from localStorage
  `aiide-loop-n`), render loop banner after cards + stacked-chart panel with legend after grid2.
- [x] **T4** i18n `panel.attrStack` / `attr.compaction` / `loop.*` (en + zh-hans).

## Deviations
- The "four buckets" render as 3 stacked positive buckets + a signed residual (positive residual
  = unattributed segment on top; negative = green compaction marker below baseline), consistent
  with S4's residual treatment.
