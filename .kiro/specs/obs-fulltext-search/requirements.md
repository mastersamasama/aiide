# S8 obs-fulltext-search — Requirements (EARS)

Client-side list filter + Ctrl/⌘+F focus + optional read-only `/api/search?q=` grep over run
JSON (no index). See docs §2.4.

## Acceptance criteria (hard)

- **R8.1** THE header SHALL show a search box next to the nav; WHEN the user presses Ctrl/⌘+F,
  THE box SHALL focus (browser find suppressed). (AC 8a)
- **R8.2** WHILE on a list view (runs / experiments), typing SHALL live-filter rows client-side
  and highlight matched substrings (`<mark>`), leaving row click handlers intact. (AC 8b)
- **R8.3** WHEN the user presses Enter with a query >= 2 chars, THE app SHALL query
  `/api/search?q=` and show matching runs with a highlighted snippet, each linking to the run.
- **R8.4** THE `/api/search` endpoint SHALL be GET-only, read-only (no mutable surface), scan run
  JSON directly with no persistent index, ignore queries < 2 chars, and cap results. (AC 8c)

## Non-goals
- No inverted index (over-engineering at local scale). j/k navigation not implemented (out of scope).
