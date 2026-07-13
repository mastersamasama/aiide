# S5 obs-overview-metrics — Tasks

- [x] **T1** `web/obs.js` `errorRate(runs)` = share of runs with any tool error.
  - Test: `test/web-obs.test.js` → "S5: error-rate = share of runs with any tool error".
- [x] **T2** `web/index.html` viewRuns cards: insert error-rate card, colour when >= 0.2.
- [x] **T3** i18n `card.errorRate` (en + zh-hans).

## Deviations
- None. Kept the existing tool-errors count card in addition to the new error-rate card
  (raw count + rate read together).
