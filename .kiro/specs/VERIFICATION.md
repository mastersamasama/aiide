# aiide Update — Verifier AC Matrix (kirokb 3d)

> Read-only verification of all 16 completed specs against `docs/aiide-update-solution.md` spec
> table ↔ `.kiro/specs/<name>/` ↔ implementation + test evidence (file:line + test name).
> Scope: verification only — no code changed. Producer: track-a. `node --test` = **113/113 pass**.
> Verdict: **16 PASS, 0 FAIL, 0 UNCOVERED.** (S7 copy-cURL ruled out of scope by team-lead 2026-07-09;
> S9 + S14-CLI delivered in Phase 2b and verified — see the S9/S14-CLI section.)

## Four iron rules — whole-repo scan

| Rule | Check | Evidence | Verdict |
|---|---|---|---|
| 1. Zero deps / zero build | `package.json` has NO `dependencies`/`devDependencies` (only node builtins) | `package.json:1-12` (no deps key); every `import` is `node:*` or a local file | **PASS** |
| 2. experiment.json write-once immutable | resume uses a NEW append-only journal class; sealed files never mutated | journal `experiments/.inprogress/*.jsonl` `lab.js:379`; sealed once `lab.js:698` then journal unlinked `lab.js:701`; annotations write a *sidecar*, never the exp file `server.js:2-3,84` | **PASS** |
| 3. Server read-only (no DELETE/POST except annotations PUT) | all non-GET → 405; only PUT annotations writes | `server.js:24` (`method !== 'GET' → 405`), `server.js:19-24,84` (PUT annotations → sidecar); no DELETE/POST/PATCH anywhere; new `/api/search` `/api/skills` are GET `server.js:30-31` | **PASS** |
| 4a. deterministic-first (pass@k / activation×outcome / loop diagnostic only) | composite uses only C/P/R/H; loop is structural-only | composite built before pass@k/activationOutcome `score.js:180-230`; loop `detectLoops` uses `normalizeInput`+`prefixEq` exact/exact-prefix, explicit "NO semantic similarity" `obs.js:75-111` | **PASS** |
| 4b. governance-neutral (no write-back to skill/suite) | every write targets own data dirs / isolated profile copy | write-back scan: runs/experiments/journal/logs/workspaces/annotations/settings only; skills only *read* (`cpSync` source→profile copy `lab.js:54`); suites only *read* (`loadSuite`); no writer targets a source skill dir or suite file | **PASS** |

## Track A specs (Wave 1 + Phase 2a)

| spec | AC | evidence (file:line · test) | verdict |
|---|---|---|---|
| **S1** eval-resume-incremental | a. interrupt → auto-resume, cached repeats | `lab.js:521,546-551` · `S1 resume: cached repeats reused…` | PASS |
| | b. suite/model/repeats drift → reject, don't start | `lab.js:400-417,522` (`cannot resume…—use --fresh`) · `S1 drift: repeats change…`, `…suite content change…` | PASS |
| | c. finish → experiment.json immutable, journal deleted | `lab.js:698-701` · same resume test asserts sealed .json + journal gone | PASS |
| | d. **zero server change; journal invisible to dashboard** | `server.js` untouched by S1; `listExperiments` non-recursive `endsWith('.json')` `server.js:117` filters `.inprogress/` + `.jsonl` · `S1 dashboard-invisible…` | PASS |
| | e. corrupt journal tail line tolerated | `loadJournalRepeats` skips bad line `lab.js:421-433` · `S1 crash-safety: corrupt tail line…` | PASS |
| **S2** eval-error-triage-retry | a. **all-excluded → C=null, composite=null (fix `mean([])→0`)** | `score.js:162` (`validN ? mean : null`), `:179` belowFloor · `S2 guardrail a…`, e2e `S2 retry exhausted…` | PASS |
| | b. **scoreExperiment filters null composite** | `score.js:223-224` (`meanOf('composite')`) · `S2 guardrail b…` | PASS |
| | c. timeout & generic exit ≠ excluded (C=0) | `lab.js:569` (`res.timedOut ? null`), classifier has no timeout sig `lab.js:342-353` · `S2 (AC c): timeout is NOT env-noise…` | PASS |
| | d. excluded repeat raw error → per-repeat log | `lab.js:466-470` (exception.txt) · `S2 retry exhausted…` asserts `/53017/` in exception.txt | PASS |
| | e. **degraded/excludedRepeats in BOTH printScorecard AND printComparison** | scorecard banner `bin/aiide.js:284-287`, per-task `:297-299`; comparison cell `bin/aiide.js:216-217` · `S2 (AC e): degraded surfaces in BOTH…` | PASS |
| | f. valid-n < MIN_REPEATS → composite n/a + lowSample | `score.js:179` belowFloor · `S2 guardrail c/f…` | PASS |
| **S3** eval-verifier-fileexists-passk | a. file_exists aligns adapter cwd (empty workspace) | `lab.js:553-555` verifyDir, `runFileVerifier` `score.js` · `S3 file_exists: resolves against workspace` | PASS |
| | b. pass@1/pass@k in diag, NOT composite | `score.js:79-92` passAtK built after composite · `S3 scoreTask: pass@k is diagnostic…` | PASS |
| | c. text verifiers zero regression | `runVerifier` untouched; router `evalVerifier` `score.js` · `S3 evalVerifier routing…` + all prior verifier tests green | PASS |
| **S12** eval-multistep-task | a. prev step reward < min_reward → abort + record | `lab.js` runMultiStep abort/`abortedAtStep` · `S12 min_reward: a failed step aborts the rest…` | PASS |
| | b. single-step suite backward compatible | `attemptInvocation` single path unchanged · 88 prior tests green + `S12 multi-step…` | PASS |
| **S17** obs-activation-outcome | a. activation=null → field null, NOT {n:0} | `score.js:66` (empty parts → null) · `S17 guardrail a…` | PASS |
| | b. one side n=0 → only populated side, no 0/0 | `score.js:68-71` (empty side → null) · `S17 guardrail b…` | PASS |
| | c. small n → correlational/low-sample | `score.js:73` lowSample · `S17 guardrail c…` | PASS |
| | d. pure read of repeats[].{activated,C}, no write-back | `score.js:65-74` read-only · `S17 …input reps not mutated` | PASS |
| | (GUI row) | **deferred to Phase 2** (web/index.html not Track A) — terminal row done `bin/aiide.js:303-307` | N/A (scoped out) |
| **S10** lab-init-and-skill | a. produced suite directly runnable | `scaffoldSuite` + `loadSuite` `suite.js` · `S10 lab init: skeleton round-trips through loadSuite AND runs` | PASS |
| | b. includes Wave 1 field examples | `suite.js` scaffold (retry/file_exists/steps/service) · same test | PASS |
| **S11 (CLI)** data-retention-prune | a. NO DELETE endpoint | `prune.js` CLI-only; `server.js:24` still GET-only | PASS |
| | b. preview then `--yes` confirm | `bin/aiide.js` cmdPrune preview/gate · `S11 CLI: preview deletes nothing; --yes deletes` | PASS |
| | c. sealed experiment + annotations sidecar; journals/config untouched | `prune.js:52-65` · `S11 executePrune: …leaves settings/journal` | PASS |
| **S18** export-otel-genai | a. invoke_agent→chat→execute_tool with gen_ai.* | `otel.js:38-95` · `S18 buildRunSpans…gen_ai.* attrs` | PASS |
| | b. skill/scorecard/runtime via aiide.* | `otel.js` aiide.* attrs · same test (`aiide.tool.skill`) | PASS |
| | c. run→OTel (experiment→OTel too) | `otel.js:98-176` · `S18 exportOtel + CLI: real run/experiment export` | PASS |
| | d. semconv version pinned + noted | `otel.js` schemaUrl + experimental note · `S18 otlpDocument: pinned experimental semconv` | PASS |
| | e. one-shot export, no daemon; NO @opentelemetry import | cmdExport one-shot · `S18 no SDK dependency…` | PASS |

## Track B specs (Wave 2 / 2.5) — logic in `web/obs.js` (unit-tested), render in `web/index.html`

| spec | AC | evidence (file:line · test) | verdict |
|---|---|---|---|
| **S4** obs-context-diff | a. `_delta` significant → colour (else dim) | `obs.js:25-28` deltaSignificant; render `index.html:828` · `S4: delta significance…` | PASS |
| | b. `_attr.other` signed reconciliation residual, not a positive bucket | `obs.js:13-21` (residual separate, can be neg); render signed `index.html:836-841` · `S4: …residual kept signed (AC 4b)` | PASS |
| | c. first round → no chip | `index.html:745,828` (delta null on round 1) · `S4: …first-round has none` | PASS |
| **S5** obs-overview-metrics | a. error-rate over threshold → coloured | `obs.js:34-38`; card `index.html:682-685` (`er>=0.2`) · `S5: error-rate = share of runs…` | PASS |
| | b. doesn't steal list focus (panel volume) | metric cards `index.html:680-689` reuse panel visual | PASS |
| **S7** obs-detail-panel-copy | a. collapse state persisted across runs (by section type) | `index.html:459-470` (`localStorage aiide-det-<type>`) | PASS |
| | b. copy JSON + confirmation (cURL scoped out) | copy JSON + flash `index.html:441-453,767,974` | PASS |
| | *deviation (team-lead ruling):* copy-cURL deliberately NOT built | cURL reproduction is a claude-tap-context feature (its data are HTTP requests); aiide's dashboard is a read-only local viewer whose only requests are trivial GETs + the annotations PUT — no request body worth reproducing. copy-JSON satisfies the "take the data with you" intent; the cURL button was a competitor-copy remnant. Scope narrowed by design. | PASS |
| **S8** obs-fulltext-search | a. Cmd/Ctrl+F focus | `index.html:515-520` | PASS |
| | b. hit highlight + client filter | `index.html:529-543` (markText) | PASS |
| | c. server endpoint read-only | `server.js:30,116-139` GET-only · `server: /api/search is read-only…` | PASS |
| **S16** obs-loop-evolution | a. stacked chart NEW (not sparkline/barChart) | `index.html:1330-1355` `stackedAttrChart`; `obs.js:116-130` stackSeries · `S16: stackSeries carries negative residual signed` | PASS |
| | b. negative `_attr.other` below baseline / compaction marker, never positive height | `obs.js:126` signed; render `index.html:1348-1349` (neg → below y0, var(--ok)) · same test | PASS |
| | c. loop detect exact/exact-prefix only, silent, N configurable | `obs.js:63-111` (`prefixEq`, "NO semantic"), threshold arg, `[]` below N; N via `localStorage aiide-loop-n` `index.html:762` · `S16: detects N identical…silent below threshold`, `…exact-prefix…different tools do not` | PASS |
| **S15** obs-skill-causal-compare | a. `⇒` gate = suite.sha256 + model + runtime, else correlational | `obs.js:136-143` cohortComparable; render `index.html:944-963` · `S15: causal gate requires same suite+model+runtime` | PASS |
| | b. `[within noise]` only when all shared task CIs overlap (silent when significant) | `obs.js:175-180` causalWithinNoise; render `index.html:958` · `S15: within-noise only when every shared task CI overlaps` | PASS |
| | c. identical skill hash → no causal line | `obs.js:152-162` skillHashDeltas (omits unchanged); `index.html:945` (`!deltas.length → ''`) · `S15: skillHashDeltas returns only changed hashes` | PASS |
| | d. read-only, no write-back | pure functions in obs.js; render-only | PASS |
| **S14 (web part)** obs-skill-profile | a. `/api/skills` GET read-only, no write-back | `server.js:31,163-238` (readdirSync/readFileSync only) · `server: /api/skills joins experiments + runs…` | PASS |
| | b. trend connects only within cohort (suite·model·runtime), separate coloured lines | `index.html:644-671` skillCohortKey + per-cohort polyline | PASS |
| | c. installed-but-never-triggered signal | `server.js:227-228` neverTriggered; `index.html:598,616` | PASS |
| | d. null-attribution round → "unattributed" bucket, not dropped | `index.html:1348` (residual→unattributed), `server.js:178` (null activation ignored not 0) | PASS |

## S9 obs-live-watch + S14-CLI (track-b Phase 2b — delivered, now verified)

| spec | AC | evidence (file:line · test) | verdict |
|---|---|---|---|
| **S9** obs-live-watch | a. new round arrives → **append**, not full re-render | `index.html:534-546` appendNewRounds (`shown=cont.childElementCount`, appends only `items.slice(shown)`); list view gets a cheap re-render, the open run is the append target `index.html:526-531` | PASS |
| | b. win32-stable ~500ms → **fs.watchFile, not fs.watch** | `watch.js:9,31` `watchFile(file,{interval:500})` (explicit "NOT fs.watch — drops events on win32" `watch.js:6`); server side stat-polls `server.js:172,188` · `watch: ingests a session jsonl into runs on start (S9)` | PASS |
| | c. SSE zero dependency | server hand-writes `text/event-stream` via `res.write` `server.js:167-189`; client uses built-in `EventSource` `index.html:524`; `package.json` still has NO deps · `server: /api/events is a read-only SSE stream that pushes on run change (S9)` | PASS |
| | d. **watch stop → server unaffected** (zero-coupling) | watch only WRITES run JSON via `ingestPath` `watch.js:17-19`; server independently polls `runs/` `server.js:172` — "the two processes never talk directly" `watch.js:2-4`; `watchDir().stop()` clears interval + unwatchFile `watch.js:46-52` | PASS |
| | e. **journal unaffected by watch** | watch → `ingestPath` writes `<dataDir>/runs/<id>.json` ONLY `ingest.js:45`; never touches `experiments/.inprogress/*.jsonl` or experiment files | PASS |
| **S14-CLI** `aiide skill [name]` | a. shared aggregation (CLI ≡ `/api/skills`) | both call `aggregateSkills(dataDir)` from the SAME module `src/skills.js`: CLI `bin/aiide.js:273`, server `server.js:9,32` — cannot drift · `skills: aggregateSkills joins experiments + runs, versions by hash, never-triggered flag` | PASS |
| | b. cohort honesty rule consistent with GUI | CLI groups by `suiteSha8·model·runtime` and prints separate per-cohort trend lines, never chaining cross-cohort `bin/aiide.js:298-307`; matches GUI `skillCohortKey` `index.html:644`. Never-triggered signal `bin/aiide.js:283,292` mirrors GUI. | PASS |
| | c. read-only footer | `bin/aiide.js:308` `└─ read-only; adoption is always a human decision`; `skills.js:1-4` "Never writes anything back" (pure `readFileSync`/`readdirSync` scan) | PASS |

> S11-web (dashboard prune hint) is **DONE**, not pending: `obs.js:40-57` pruneHint (copy-only, never
> deletes) wired at `index.html:709` + copy-command `index.html:712`, tested (`S11: prune hint stays
> silent under thresholds…`). Confirmed done per team-lead ruling.

## Iron-rule re-check on the watch/server architecture (team-lead request)

The **stat-poll, zero-coupling** design holds all four rules:
- **Zero dep**: `fs.watchFile` + native `EventSource` + hand-written SSE frames — `package.json` still
  has no `dependencies` (`watch.js`, `server.js` import only `node:*`/local).
- **Immutable**: watch re-ingests into `runs/` (already-mutable derived data); it never writes an
  `experiments/*.json` or a journal — write-once experiments untouched.
- **Server read-only**: `/api/events` is a GET stream reached only past the `method !== 'GET' → 405`
  guard (`server.js:24`), and it only `res.write`s — no fs mutation, no DELETE/POST added.
- **Governance-neutral**: watch and skill aggregation are read-only; no write-back to skill/suite.
  The `aiide skill` output ends with an explicit "adoption is always a human decision" footer.

## Team-lead rulings (2026-07-09)

1. **S7 copy-cURL — NOT DONE, by design → S7 = PASS.** cURL reproduction belongs to claude-tap's
   context (its records are HTTP requests, so replay-as-cURL is meaningful). aiide's dashboard is a
   read-only local viewer whose only requests are trivial GETs + the annotations PUT — there is no
   request body worth reproducing. copy-JSON already satisfies the "take the data with you" intent; the
   cURL button was a competitor-copy remnant. Scope narrowed by design (deviation recorded in the S7 row).
2. **S11-web — reclassified DONE** (evidence above); pending list now holds only S9 and S14-CLI.

**Final: 16/16 done specs PASS, 0 FAIL, 0 UNCOVERED. All four iron rules PASS repo-wide (incl. the
watch/server stat-poll architecture). `node --test` 113/113.** Nothing pending — S9 obs-live-watch and
S14-CLI `aiide skill` were delivered by track-b (Phase 2b) and verified above.
</content>
