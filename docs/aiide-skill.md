# aiide — Operation Skill (AX-first)

An AI-readable guide to driving aiide and authoring suites. aiide is a local-first, zero-upload
tool that (1) observes agent sessions and (2) runs an isolated skill lab that scores skills on a
deterministic C/P/R/H composite. Zero dependencies; all data lives under `--data-dir` (default `./.aiide`).

## CLI subcommands

| Command | Purpose |
|---|---|
| `aiide ingest <dir\|file.jsonl>` | Parse Claude Code session logs → `.aiide/runs/`. |
| `aiide up [--port 4517]` | Start the read-only dashboard (local-only, zero upload). |
| `aiide lab init --suite <p> [--force]` | Write an annotated, runnable suite skeleton. |
| `aiide lab run --suite <p>` | Run an isolated skill experiment. Flags below. |
| `aiide report [experimentId]` | Print the latest/specified scorecard. |
| `aiide meta …` | Manage persistent meta defaults + capture commands. |
| `aiide prune --older-than <dur> \| --max <N> [--yes]` | Delete old runs/experiments (preview unless `--yes`). |
| `aiide export --otel [id] [--out <p>]` | Export a run/experiment as OTLP/JSON (OTel GenAI semconv). |

`aiide lab run` flags: `--model <m>`, `--models a,b` (compare), `--repeats <n>`, `--meta k=v` (repeatable),
`--fresh` (ignore the resume journal), `--data-dir <dir>`.

## Suite schema (frozen, Wave 1)

Suites are JSON — **comments (`//`, `/* */`) are accepted** (strict JSON is tried first, then a
comment-stripping fallback). Top-level fields:

| Field | Type | Notes |
|---|---|---|
| `name` | string | required; experiment id + resume-journal key derive from it. |
| `model` | string | default `sonnet`; `--models`/`--model` override. |
| `repeats` | int | default 3; ≥3 recommended (`MIN_REPEATS`) for a trustworthy Wilson CI. |
| `maxTurns` | int | default 30 (claude-code). |
| `timeoutMs` | int | default 300000 per repeat. |
| `retry` | `{maxRetries,baseDelayMs}` | env-noise retry; default `{2,1000}`. |
| `skills.dirs` | string[] | ONLY these load in the isolated profile. |
| `targetSkills` | string[] | activation of these feeds P/R. |
| `passK` | int[] | diagnostic pass@k set (default derives {1,3}); never in composite. |
| `meta` | object | k=v recorded on the experiment (see `aiide meta`). |
| `capture` | object | `{name: "cmd"}` run once/experiment, first output line recorded. |
| `runtime` | object | external runtime (see `docs/adapters.md`); omit = claude-code. |
| `tasks` | Task[] | required. |

### Task

- `id` (string, required), `prompt` (string) OR `steps` (array — multi-step, see below).
- `verifiers`: array of verifier objects (all must pass for C=1).
- `targetSkills`: per-task override of the suite-level list.

### Verifiers

| type | fields | passes when |
|---|---|---|
| `regex` | `pattern`, `flags?`, `expect?` | answer matches (or, `expect:false`, does not match). |
| `numeric_range` | `min`, `max` | a number in `[min,max]` appears in the answer. |
| `json_field` | `path` (dot-path) | answer parses as JSON and the path is non-null. |
| `file_exists` | `path`, `schema?` | file exists in the repeat workspace; with `schema.required` (dot-paths) it must be JSON containing them. |

### Multi-step tasks

```jsonc
{ "id": "flow", "minReward": 1, "steps": [
  { "prompt": "…", "verifiers": [ … ] },   // reward = fraction of this step's verifiers passing
  { "prompt": "…", "verifiers": [ … ] }    // runs only if the prior step's reward ≥ minReward
] }
```

Steps share ONE workspace (files persist across steps). If a step's reward < `minReward` (step-level,
else task-level, default 1), the rest are aborted and `abortedAtStep` is recorded. C=1 iff every step
ran and every step's reward = 1.

## Scoring model (what the numbers mean)

- **Composite** = weighted C(0.5)/P(0.25)/R(0.15)/H(0.10); Efficiency + pass@k + activation×outcome
  are **diagnostic only**, never in the composite (deterministic-first iron rule).
- **Excluded (env-noise)**: repeats that persistently hit the retry whitelist are removed from the
  denominator (never scored C=0). All-excluded → C/composite = null; if exclusions drop valid-n below
  `MIN_REPEATS`, composite shows n/a. Degraded state surfaces in the scorecard and model-comparison.
- **activation×outcome** (per task): `triggered → meanC (n) · not-triggered → meanC (n)` — did
  triggering the skill actually help? Null-guarded (no fake 0/0).

## Governance invariant

All outputs are read-only evidence. aiide never writes back to a skill/suite and never auto-adopts a
version. `aiide up` is read-only (only exception: the annotations sidecar PUT). Retention is CLI-only
(`aiide prune`) — no DELETE endpoint.

## AX — driving the upgrade pipeline (verdict-first)

The upgrade pipeline compares two whole skill bundles (a **new** arm vs an **old** arm) on an
identical, case-id-paired dataset and emits an **adoption verdict** plus the evidence behind it.
Authoritative design (thresholds, statistics, rationale) lives in
`docs/onchainos-upgrade-pipeline-design.md` (§1 stage 4, §2.2 verdict, §3 dual-audience report,
§5 spec table U4/U7/U8) — read that, not this file, for algorithm detail; this section is the AX
contract. The Wave 0 probe reports (`docs/wave0-probe-report.md`) are the U0/U2/U3 factual
attachments the design cites. (Both paths are repo-root-relative — the docs sit next to this file
in `docs/`.)

### `aiide upgrade` subcommands

| Command | Purpose |
|---|---|
| `aiide upgrade run --arm new\|old --suite <p>` | Collect one arm's paired sessions (budget table prints first). |
| `aiide upgrade compare --new <expId> --old <expId> --intent <i>` | Pair on case-id, run the U4 verdict engine. |
| `aiide upgrade report --format json\|md\|html` | Emit the report artifact(s) under `<data-dir>/upgrades/<compare-id>/`. |
| `aiide upgrade smoke --mix skillA=new,skillB=old [--baseline new\|old]` | Mixed-bundle confirm run → bundle-level **mini-verdict** (paired: mixed arm vs baseline arm, baseline defaults to the current-production **old-full**). The **only** sanctioned path to adopt a hand-picked mix. |
| `aiide upgrade lint --suite <p>` | Static dataset checks (smoke-tier size band, multi-intent share floor). |
| `aiide upgrade preflight` | Assert both arms' `onchainos --version` + skill sha256 + isolation before collecting. |

`--intent` is one of `cost-opt` / `quality-fix` / `neutral-refactor` and parametrizes the verdict gate.

### report.json — verdict-first schema (what to read, in order)

The schema's **first layer IS the verdict** (mirrors the three-layer report). Top-level keys AX should read:

- `verdict` — one of the five values below · `established` (bool, the "成立" flag) · `intent`.
- `pairs` · `exclusionPct` · `excludedCases: [{caseId, reason}]` (reason = `env-noise` | `harness-halt`)
  · `gates` · `reasons` — the decideVerdict output, verbatim.
- `arms.{new,old}` (`label`, `version`, `harness`, `isolation`) + `header.baselineArm` + `header.mixedBundle`/`mix` — the version quad & mixed-bundle identity.
- `axes.quality.{l1,l2,l3}` (`deltaPp`, `ci{lo,hi}`, `n`, `significantUp`, L3 `heuristic`) and
  `axes.cost.{turns,tokens,seconds}` (`delta`, `ci`, `n`, `significantDown/Up`) — three axes with CI + n.
  `axes.flowIncomplete` and `l2Breakdown.permissionArtifact` are surfaced **separately** (different denominator).
- `perSkill.skills[]` (`skill`, `nCases`, `badge` ∈ `ok`/`reference-only`/`insufficient-data`, `ci`, `mean`,
  `significant`, `significantBadge`) + `perSkill.note` — **NOT an adoption certificate** (see governance).
- `depgraph` (merge/split/inline suggestions) · `footer.config` (effective δ, MIN_PAIRS, seed, FDR) ·
  `footer.versionQuad` · `footer.tests` (test count + correction strategy).
- `cohort` + `lineage` — trend grouping keys; `cases[]` (`caseId`, `delta`, `regressed`) — paired per-case points.
- `probes` — external-tool probe-signal block (**probe 信号：命令面覆盖 + cli 下沉**), **always present**: `null`
  when no probe was configured, otherwise `{ status: 'ok'|'inconclusive', tripwired, paired:{cases,exclusionPct,tripwired},
  arms:[{arm, tools:[{tool, coverage, bySkill, sequences}]|null, proximity}], deltas:[{tool,comparable,
  ratioDelta,invokedDelta}], notComparable:[{tool,reason}], warnings:[{kind:'excluded-probe-hit',arm,caseId,tool,cmds}] }`.
  (Renamed from `cli` → `probes` during the general-probing week — probes now cover Bash CLIs, MCP tool families
  like `mcp__server__*`, and any other tool call; feature-week rename, no migration/back-compat needed. Each
  proximity event's `type` is the probe's own tool name — e.g. `onchainos:price get`, `onchainos-mcp:price_get`.)
  Reading rules: **per-arm absolutes are separate from the two-arm `deltas`**; `tripwired` (a block-level
  exclusion rate over the tripwire) forces `status: 'inconclusive'` while the absolutes still render;
  `sequences[]` are **always `status:'hypothesis'`** — a `knownCollapse` is an annotation, **never** an adopt
  action; two arms whose declared command surface differs land in `notComparable` (no delta is emitted).
  Each `arm.proximity` (from `proximityToCharts`) carries `{ topEdges, heatmap:{labels,matrix}, graph, n }`
  — a top-k `confidence`/`lift`/`n` edge table plus heatmap- and directed-graph-ready shapes. Every
  proximity number is **时序邻近，非因果** (temporal adjacency, not causation) — never an adoption signal.

### `experiment.stats` — per-experiment coverage statistics (design §2.3)

`GET /api/experiments/:id` carries an embedded `stats` object (the sealed archive is the sole authority;
`aiide stats <expId>` recomputes for diagnosis but **refuses to overwrite** an embedded one without
`--force`, and a forced recompute is stamped `non-authoritative`). Three read states:

- **`stats` key absent** — an experiment sealed before this feature. The dashboard shows a backfill hint
  (`aiide stats <expId>`), never a fake zero.
- **`stats.probes === null`** — stats present but no external-tool probe configured.
- **`stats` present** — full card. Shape: `{ schemaVersion, nRaw, nCoverageValid, nExcluded,
  heldOutExcluded, noSession, nUnresolved, skillCoverage, refCoverage, probes, proximity }`.

Sample-size contract (**load-bearing, do not conflate**): the coverage denominator is **`nCoverageValid`**,
which is **NOT** the scorecard's `n`. score.js `n` counts C=0 timeout failures **into** the denominator;
`nCoverageValid` counts only VALID resolved runs. The identity `nRaw = nCoverageValid + nExcluded +
heldOutExcluded + noSession + nUnresolved` holds (held_out reps are bucketed FIRST). Never render
`nCoverageValid` where a reader would expect the scorecard `n`.

- `skillCoverage` (M1): `installed`, `everTriggered[{skill,cases,primary,auxiliary}]`,
  `triggerRate[{skill,triggered,attempted}]` (denominator aligns score.js `activationRate` — includes
  noSession reps), and two DISTINCT never-fired buckets: `neverTriggered` (有题目考它但从未触发 — a real
  dead-weight candidate) vs `notExercised` (没有题目考它 — no chance given, NOT dead weight).
- `refCoverage` (M2): `bySkill[{skill,versionSha,shipped,read,unreadRefs,notExercised}]`,
  `readCounts{logicalRef:{runs,cases}}`, and three exemption buckets a shipped-but-unread ref must clear
  before it is a dead-weight candidate: `artifactOnlyRefs` (blocked reads), `excludedOnlyRefs`
  (only read in excluded runs), and per-skill `notExercised`.
- `probes` (M3-M5): `null` or a per-tool array `[{tool,warnings,coverage,bySkill,sequences}]` (one entry per
  configured probe — a Bash CLI, an MCP tool family, etc.). `coverage.status`
  ∈ `available`/`unavailable`/`suspect`; `sequences[]` are always hypotheses. Block-level statuses
  (`insufficient-data`/`unavailable`/`suspect`/`held-out-unknown`) render as **badges (a word), never a ratio**.
- `proximity` (M7): `{ edges:[{from:{type,id},to:{type,id},closeness,confidence,lift?,pairCases,runs}], n }`;
  probability base = distinct cases (repeats can't pseudo-replicate).

`aiide stats <expId>` consumers: read the embedded `stats` first; only recompute (with `--force`) to
diagnose an algorithm drift, and treat a `non-authoritative` recompute as diagnostic, not truth.

### report.md — grep contract

Sections use **numbered headings** (`## N.`) so AX can grep-extract a section; heading order mirrors
report.json layering, and the **verdict is section 1** (verdict-first). To pull the verdict block:
`grep -A20 '^## 1\.' report.md`.

### verdict semantics & reading rules

| verdict | means | AX rule |
|---|---|---|
| `cost-opt` | cost axis significantly down, quality non-inferior | adoptable **iff** `established` |
| `quality-fix` | target quality axis significantly up, cost not worse | adoptable **iff** `established` |
| `neutral-refactor` | quality non-inferior, cost not worse | adoptable **iff** `established` |
| `insufficient-data` | fewer than `MIN_PAIRS` (8) paired cases | **NOT parity, NOT adoptable** — treat as "unknown" |
| `inconclusive` | whole-case exclusion rate over the tripwire (12%) | **NOT parity, NOT adoptable** — verdict withheld |

Hard rule for AI consumers: `insufficient-data` and `inconclusive` **never** mean "持平/可採". They are
"cannot decide". When you see one, read the **next-step guidance**: `insufficient-data` states how many
more paired cases are needed (`MIN_PAIRS − pairs`); `inconclusive` enumerates the excluded case-ids with
their reasons and a suggested action (e.g. add `scripted_reply` for a harness-halt).

### Governance neutrality (invariant)

The per-skill diagnostic table is **not an independent adoption certificate** — the two arms are each
whole bundles, routing is globally coupled, and a hand-picked mix was never measured (route it through
`aiide upgrade smoke --mix` instead). The only bundle-level adoption certificate is the global verdict,
and even that is **evidence**: **adoption is always a human decision**. Neither the CLI nor the dashboard
offers any auto-adopt/rewrite action.

### `/api/upgrades` (read-only)

`aiide up` exposes a read-only `GET /api/upgrades` listing each `<compare-id>`'s summary (verdict,
intent, both arm labels/versions, timestamp), `GET /api/upgrades/<compare-id>` for the full report.json,
`GET /api/upgrades/<compare-id>/report.html` which serves the single-file HTML report verbatim
(`text/html`, same-origin, so the dashboard's "open full report" opens it in a new tab — a browser
blocks an http page from following a `file://` link), and `GET /api/upgrades?trend=1` for same-cohort,
case-id-intersection paired trend series (a superseded genealogy gets a new `lineage`, so the trend line
breaks across it). All GET-only; non-GET → 405. No write/adopt/delete surface.

### Dashboard presentation — boolean recommendation (presentation only)

The dashboard reframes the verdict as a boolean **recommendation** while keeping the four-state glyph
(✓✗~∅). **report.json field values are unchanged** — this is a presentation layer:

| report.json | dashboard label |
|---|---|
| intent verdict, `established:true` | ✓ `recommendation: true` (`升级推荐: true`) |
| intent verdict, `established:false` | ✗ `recommendation: false` (`升级推荐: false`) |
| `insufficient-data` | ∅ `undecidable (insufficient data)` — **never** `false` |
| `inconclusive` | ~ `undecidable (exclusion tripwire)` — **never** `false` |

`intent` is shown as a separate badge. The two undecidable states are never rendered as a negative
recommendation — "cannot decide" is not "do not adopt".

