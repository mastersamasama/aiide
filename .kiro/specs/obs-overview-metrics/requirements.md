# S5 obs-overview-metrics — Requirements (EARS)

Runs-page top metric card row aggregating existing list fields (`server.js` ~104-108 already
carries toolErrors/tokens/cost). See docs §2.2.

## Acceptance criteria (hard)

- **R5.1** THE runs page SHALL show a top metric row: total runs, error-rate %, total tokens,
  est. cost (tool-errors count retained alongside).
- **R5.2** THE error-rate SHALL be the share of runs with at least one tool error.
- **R5.3** WHERE the error-rate crosses the threshold (>= 20%), THE error-rate card SHALL be
  coloured (err); OTHERWISE it stays neutral. (AC 5a)
- **R5.4** THE row SHALL reuse the existing `.card` visual and NOT dominate the list. (AC 5b)

## Non-goals
- No new server field; pure client aggregation of already-loaded list metadata.
