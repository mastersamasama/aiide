# S7 obs-detail-panel-copy — Tasks

- [x] **T1** `web/index.html`: `copyJson(btn, kind)` + `flashCopied` (clipboard w/ textarea
  fallback, 1.4s text confirmation).
- [x] **T2** `web/index.html`: `<details data-persist="TYPE">` mechanism — one capture-phase
  `toggle` listener persisting to localStorage + `applyPersistedDetails(root)` re-applying on render.
- [x] **T3** Tag persistable sections: `round`, `thinking` (run detail), `md-env`, `drilldown`
  (experiment). Set `copyPayload.run` / `copyPayload.exp`; add copy buttons to both headers;
  call `applyPersistedDetails($app)` after each render.
- [x] **T4** i18n `copy.json` / `copy.jsonTip` / `copy.done` (en + zh-hans).

## Testing
- Pure DOM/localStorage interaction — not unit-testable without a headless browser. Flagged for
  Playwright smoke: toggle a round, revisit → stays; click copy → clipboard has JSON + "✓ copied".

## Deviations
- Persistence is per section TYPE (coarse), matching "以 section 類型為 key" — collapsing one
  round sets the preference for the "round" section type across all rounds/runs, by design.
