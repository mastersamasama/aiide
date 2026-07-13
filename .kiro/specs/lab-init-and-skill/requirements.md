# S10 · lab-init-and-skill — Requirements (EARS)

> Design authority: `docs/aiide-update-solution.md` §4.1 + spec table S10. Depends on Wave 1 schema
> freeze (retry / file_exists / steps / passK). Iron rules: zero-dep · AX-first (AI-readable interface).

## Requirements

R1 — `aiide lab init`
- R1.1 `aiide lab init --suite <path>` SHALL write an annotated suite skeleton covering tasks /
  verifiers (regex / numeric_range / json_field / file_exists) / steps / retry whitelist /
  runtime+service (commented example) — using the Wave 1 frozen schema.
- R1.2 (AC) The produced suite SHALL be directly runnable: `aiide lab run --suite <it>` parses and
  executes without edits.
- R1.3 `lab init` SHALL refuse to overwrite an existing file unless `--force` is passed.

R2 — JSONC suite loading (so the skeleton can carry real comments AND still run)
- R2.1 The suite loader SHALL accept comments (`//`, `/* */`): try strict `JSON.parse` first (zero
  risk for existing valid-JSON suites), and only on failure strip comments (string-aware) and retry.

R3 — AX-first operation skill doc
- R3.1 `docs/aiide-skill.md` SHALL document every CLI subcommand and the full suite schema (an
  AI-readable operation guide for generating suites), reflecting all Wave 1 fields.
</content>
