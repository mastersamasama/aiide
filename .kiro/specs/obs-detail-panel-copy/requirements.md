# S7 obs-detail-panel-copy — Requirements (EARS)

`<details>` collapse-state persistence + copy-JSON with a lightweight confirmation. See docs §2.3.

## Acceptance criteria (hard)

- **R7.1** THE collapse state of a `<details>` SHALL be persisted in localStorage keyed by
  section TYPE (not per instance), so the preference carries across rounds and across runs. (AC 7a)
- **R7.2** WHEN a persisted section type has a stored preference, THE view SHALL apply it on
  render; OTHERWISE the built-in default (collapsed) stands.
- **R7.3** THE run-detail and experiment views SHALL each offer a copy-JSON button that copies
  the raw record to the clipboard.
- **R7.4** WHEN a copy succeeds, THE button SHALL give a lightweight success confirmation
  (text → "✓ copied" for ~1.4s), respecting `prefers-reduced-motion` (no animation). (AC 7b)
- **R7.5** WHERE the clipboard API is unavailable (non-secure context), THE copy SHALL fall back
  to a hidden-textarea execCommand copy.

## Non-goals
- No server change. cURL copy is out of scope this spec (JSON only, per task brief).
- Export (PNG/HTML) already strips `<button>`, so copy buttons are absent from static reports.
