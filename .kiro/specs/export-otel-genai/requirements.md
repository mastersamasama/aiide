# S18 · export-otel-genai — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §4.4 + spec table S18. Fulfils
> `dec-2026-07-data-layer-otel-genai-compat` (100% OTel GenAI semconv compatible, all data exportable).
> Iron rule (hard): ZERO deps — hand-write OTLP/JSON; `@opentelemetry/*` SDK is forbidden.

## Requirements

R1 — `aiide export --otel [id] [--out <p>]`
- R1.1 The system SHALL export a run OR experiment as OTLP/JSON. `id` resolves to a run first, else an
  experiment; no id → the latest experiment. Output to stdout, or to `--out <path>`.
- R1.2 It SHALL be a one-shot export (no long-running exporter).

R2 — GenAI span mapping (fin-2026-07-otel-genai-semconv-standard)
- R2.1 A run → a top-level `invoke_agent` span; each round → a `chat` child span carrying
  `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`; each toolCall →
  an `execute_tool` child span carrying `gen_ai.tool.name`.
- R2.2 Product-specific concepts (skill, Scorecard, RuntimeTarget) SHALL use `aiide.*` custom
  attributes (semconv-permitted extension), never invented span kinds.
- R2.3 An experiment → a root span carrying the scorecard as `aiide.*` attributes, with the referenced
  runs' spans nested under it ("便宜就做" — cheap because run→spans is reused).

R3 — Honesty / interop
- R3.1 Output SHALL pin the semconv version and note it is experimental (resource attribute +
  `schemaUrl`), so a consumer knows which revision it targets.
- R3.2 Valid OTLP/JSON: `resourceSpans[].scopeSpans[].spans[]` with typed attribute values and
  hex trace/span ids (deterministic from ids so re-export is stable).
</content>
