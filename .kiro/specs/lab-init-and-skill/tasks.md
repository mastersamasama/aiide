# S10 · lab-init-and-skill — Tasks

Design: `docs/aiide-update-solution.md` §4.1. Files: NEW `src/suite.js`, `bin/aiide.js`,
NEW `docs/aiide-skill.md`, `test/lab.test.js`.

## Tasks
- [x] T1 — `src/suite.js`: `parseJsonc(text)` (string-aware `//` + `/* */` stripping), `loadSuite(path)`
  (strict JSON first, JSONC fallback), `scaffoldSuite()` (annotated, zero-setup runnable skeleton).
- [x] T2 — `bin/aiide.js`: `aiide lab init --suite <p> [--force]` writes the skeleton (refuse overwrite
  without --force); `cmdLabRun` uses `loadSuite` instead of raw `JSON.parse`. Usage text updated.
- [x] T3 — `docs/aiide-skill.md`: AX-first operation guide (all subcommands + full suite schema).
- [x] T4 — Tests: parseJsonc strips comments but not `//` inside strings; init writes + refuses
  overwrite; init output round-trips through loadSuite AND runs to an experiment under claude-stub.

## Deviations
- **D1 (comments)**: JSON has no comments; instead of `_help` keys, the loader accepts JSONC (comment
  stripping) with a strict-first fast path, so the skeleton carries real `//` comments yet stays
  directly runnable. Trailing-comma tolerance intentionally omitted (string-corruption risk); comments
  only.
- **D2 (zero-setup runnable)**: scaffold ships `skills.dirs: []` / `targetSkills: []` so it runs with
  no external skill dir; comments show where to add them. "Directly runnable" = parses + executes (not
  that stub answers pass every verifier).
</content>
