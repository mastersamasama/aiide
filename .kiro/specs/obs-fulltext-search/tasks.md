# S8 obs-fulltext-search — Tasks

- [x] **T1** `src/server.js` `searchRuns(dataDir, q)` + `GET /api/search?q=` route (read-only,
  no index, min 2 chars, snippet ±40 chars, cap 50).
  - Test: `test/server.test.js` → "server: /api/search is read-only full-text grep over run JSON (S8)".
- [x] **T2** `web/index.html`: header `<input id="q" class="searchbox">`, placeholder via
  applyChrome i18n.
- [x] **T3** `web/index.html`: `applySearch()` (live row filter + `markText`/`unmark` substring
  highlight), `searchKey()` (Enter → `#search/<q>`, Esc → clear), global Ctrl/⌘+F focus handler,
  `applySearch()` re-run at end of `render()`.
- [x] **T4** `web/index.html`: `viewSearch(q)` results view + router `#search/<q>` + nav-active
  mapping to runs; strip `#q` from static HTML export.
- [x] **T5** i18n `search.*` + `th.snippet` (en + zh-hans).

## Deviations
- List-view highlight is real substring `<mark>` (text-node split, handler-safe); the server
  body-search adds a separate results view. Both satisfy "命中高亮定位".
