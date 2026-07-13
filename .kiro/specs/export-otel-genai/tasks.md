# S18 · export-otel-genai — Tasks

Design: `docs/aiide-update-solution.md` §4.4 + KB dec-2026-07-data-layer-otel-genai-compat.
Files: NEW `src/otel.js`, `bin/aiide.js`, NEW `test/otel.test.js`.

## Tasks
- [x] T1 — `src/otel.js` (hand-written OTLP/JSON, zero SDK): typed `attr`/`attrs`, hex trace/span ids
  (sha256-derived → deterministic), nano timestamps; `buildRunSpans` (invoke_agent→chat→execute_tool),
  `buildExperimentSpans` (root scorecard span + nested run spans), `otlpDocument` (resource + scope +
  schemaUrl + semconv note), `exportOtel({dataDir,id})` (run>experiment>latest resolution).
- [x] T2 — `bin/aiide.js`: `aiide export --otel [id] [--out <p>]` → dynamic import, stdout or file.
- [x] T3 — Tests: run maps to invoke_agent/chat/execute_tool with gen_ai.* attrs; skill/scorecard via
  aiide.*; experiment nests run spans + carries scorecard; deterministic ids; semconv pinned; valid
  shape; no `@opentelemetry` import anywhere.

## Deviations
- **D1 (semconv version)**: gen_ai semconv is still experimental; pinned `schemaUrl` 1.29.0 + a resource
  attribute flagging experimental status, honestly noted rather than claiming stability.
- **D2 (experiment scope)**: experiment→OTel implemented (the "便宜就做" branch) since run→spans was
  already built — root span carries the scorecard, referenced runs nest beneath. Missing run files are
  skipped (partial export beats failing).
</content>
