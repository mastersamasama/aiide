# S9 obs-live-watch — Tasks

- [x] **T1** `src/watch.js` `watchDir({target, dataDir, intervalMs, onEvent})`: fs.watchFile per
  jsonl + periodic dir re-scan for new files; re-ingest via `ingestPath` on change; `stop()`.
  - Test: `test/watch.test.js` → "watch: ingests a session jsonl into runs on start (S9)".
- [x] **T2** `src/server.js` `sseEvents(req,res,dataDir)` + `GET /api/events` (stat-poll runs dir
  500ms, prime-without-emit, `run` events, heartbeat, cleanup on close).
  - Test: `test/server.test.js` → "server: /api/events is a read-only SSE stream that pushes on
    run change (S9)" (also asserts POST → 405, still read-only).
- [x] **T3** `web/index.html`: `computeRunItems(run)` extracted from viewRun; `initLiveEvents()`
  (one EventSource, silent degrade); `appendNewRounds(runId)` appends only items beyond
  `childElementCount`; `#timeline-items` container; live-dot indicator + pulse (reduced-motion safe).
- [x] **T4** `bin/aiide.js` `cmdWatch()` + dispatch + usage.
- [x] **T5** i18n `live.on` (en + zh-hans).

## Verification
- Browser smoke: opened a 2-round run, stamped the first DOM node, wrote a 3-round update →
  timeline grew 2→3, the stamped node SURVIVED (proves append, not re-render), appended node is
  round #3, live dot showed, 0 console errors.

## Deviations
- Server watches run-file mtimes via a 500ms stat poll (not `fs.watchFile` on the directory):
  content changes to an existing run file don't reliably bump directory mtime, and stat polling is
  the same reliable primitive the spec mandates for the watcher. Documented as the architecture
  decision (zero-coupling processes).
