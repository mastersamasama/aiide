# S4 obs-context-diff — Tasks

- [x] **T1** Pure logic in `web/obs.js`: `attrContributions(attr)` (descending buckets + signed
  residual), `deltaSignificant(delta, footprint, ratio=0.1)`.
  - Test: `test/web-obs.test.js` → "S4: attribution buckets sorted descending; residual kept
    signed (AC 4b)", "S4: delta significance is relative to footprint, first-round has none".
- [x] **T2** `web/index.html` roundRow: Δ chip colour via `deltaSignificant(delta, r.contextFootprint)`.
- [x] **T3** `web/index.html` roundRow expanded legend: use `attrContributions` for descending
  buckets + signed residual (`+`/`−`), residual gets the Δ tooltip.

## Deviations
- The "four buckets descending" in the spec is realised as 3 sorted contribution buckets + 1
  signed residual, because the residual is explicitly not a contribution bucket (AC 4b / §2.1
  failure-mode). Wired through `attrContributions` so the invariant is unit-tested.
