# S9 obs-live-watch — Requirements (EARS)

`aiide watch <dir>` live-tail + read-only SSE + EventSource append-render. See docs §3.1, spec
table S9. Phase 2b.

## Acceptance criteria (hard)

- **R9.1** `aiide watch <dir|file.jsonl>` SHALL tail session JSONL with `fs.watchFile` stat
  polling (~500ms), NOT `fs.watch` (drops events on win32), re-parse the whole file (parser
  tolerates a half-written tail), and incrementally ingest into `<data-dir>/runs`.
- **R9.2** THE server SHALL expose `GET /api/events` as `text/event-stream` (GET only — does not
  break read-only) and push a `run` event when a run file is added or changes. (AC 9c: zero deps,
  browser EventSource)
- **R9.3** WHEN the client receives a `run` event for the open run, THE timeline SHALL APPEND the
  new rounds only — never a full re-render. (AC 9a)
- **R9.4** THE watch loop SHALL be stable on win32 (stat polling). (AC 9b)
- **R9.5** WHEN `aiide watch` stops, THE server SHALL keep serving normally; the journal /
  experiment files SHALL be unaffected. (AC 9d/9e)
- **R9.6** Append-render SHALL be self-contained — depend on NO render-optimization spec. (AC 9d)

## Architecture decision
- watch and server are SEPARATE processes with ZERO coupling: `aiide watch` only WRITES run JSON;
  `aiide up` independently stat-polls `<data-dir>/runs` and pushes SSE. This honours zero-侵入 and
  means neither process needs to know about the other (no IPC, no shared port).
- The server pushes on run-file mtime change (not on directory events), so it catches a re-ingested
  file whose bytes grew even when the directory mtime does not move.
