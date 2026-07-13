# S4 obs-context-diff — Requirements (EARS)

Surface the already-computed per-round context attribution (`web/index.html` ~449-458:
`_delta` + `_attr{prevOut,toolRes,injected,other}`). This is surfacing, not building. See docs §2.1.

## Acceptance criteria (hard)

- **R4.1** WHEN a round has a previous round, THE run-detail timeline SHALL show a signed
  `Δ±tok` chip in the round summary.
- **R4.2** WHERE `|Δ|` is significant relative to the round footprint (>= 10%), THE chip SHALL be
  coloured (warn for growth, ok for shrink); OTHERWISE it SHALL stay dim. (visual-volume mgmt)
- **R4.3** WHEN a round is the first round (no previous), THE chip SHALL NOT be shown.
- **R4.4** WHEN a round is expanded, THE attribution SHALL list the three contribution buckets
  (`prevOut`/`toolRes`/`injected`) in descending order of contribution.
- **R4.5** `_attr.other` SHALL be rendered as a reconciliation residual with an explicit sign
  and MAY be negative (compaction / cache eviction); IT SHALL NEVER be rendered as a positive
  contribution bucket.

## Non-goals
- No change to how `_delta`/`_attr` are computed. No new server surface.
