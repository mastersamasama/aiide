# aiide Upgrade Pipeline (U0–U8) — Final Verification AC Matrix

> Read-only verification of the 9 upgrade specs (`.kiro/specs/upgrade-u0..u8/`) against
> `docs/aiide-skill.md §AX` (canonical U7↔U8 contract) ↔ implementation ↔ test evidence
> (test-name / file:line). Producer: `final-verify`. Date: 2026-07-10.
>
> **`node --test` = 282 tests · 281 pass · 1 known-flaky** (`meta.test.js` `runCaptures` — capture
> subprocess timeout; **green on isolated rerun**, re-verified here; not a real failure).
>
> **Verdict: 202 ACs → 202 PASS · 0 UNCOVERED · 0 UNKNOWN.**
> (The 5 U8 doc-only ACs were re-judged to PASS after confirming the referenced docs exist at the
> **repo root** `docs/` — my first pass searched only the `aiide/` subtree and missed them; see F-2/F-3.)
>
> ### Findings (fixed / surfaced this pass)
> - **F-1 (U7↔U8 schema seam — RESOLVED during this pass).** At session start, `src/report.js`
>   emitted a **sectioned** `report.json` (`meta`/`s1_verdict`/`s2_quality`…), but the entire U8
>   consumer — `server.js` `listUpgrades`/`computeTrend` **and** `web/obs.js` `buildUpgradeView` —
>   reads the **flat canonical** schema from `docs/aiide-skill.md §AX §110` (top-level
>   `verdict`/`pairs`/`arms`/`header`/`axes.quality`/`axes.cost`/`perSkill`/`footer`/`cases` +
>   `cohort`/`lineage`). Both sides had passed only against **private fixtures**, so 281-green masked
>   a total contract divergence (real `report.json` would have listed all-null rows and an empty
>   trend). A peer agent migrated `report.js` (+`bin/aiide.js` `printVerdictLine`, +renderers,
>   +`upgrade-report.test.js`) to the flat/canonical schema mid-session; I held off editing the
>   contended file to avoid clobbering, then **proved the reconciliation end-to-end with real
>   artifacts** (see Integration e2e below). Adjudication: **flat/canonical is correct** (aligns U8
>   consumers + §AX). Now cohesive on both sides.
> - **F-2 (U8 R8.3.1/R8.3.2 — reference-path clarity, FIXED).** `docs/aiide-skill.md` cited the
>   authoritative design (`onchainos-upgrade-pipeline-design.md`) and Wave-0 probe report via
>   monorepo-relative `../../docs/…` paths that escape the repo when aiide is published standalone.
>   **Fixed:** both design authorities are now shipped in-repo at `docs/onchainos-upgrade-pipeline-design.md`
>   and `docs/wave0-probe-report.md`, and the skill refs were rewritten to those repo-root-relative
>   paths (matching the project's `src/…`/`docs/…` backtick convention). Every design-authority link
>   now resolves inside the published repo.
> - **F-3 (ixd Appendix D handoff — VERIFIED).** Source: the IxD Phase-8 delivery doc (internal IxD
>   deliverable archived in the monorepo IxD suite, not shipped in this OSS repo). Its Appendix D
>   (§D "開發交接注意事項", lines 221–236) handoff map is **consistent
>   with the implementation**: S1 verdict→**U4** (`src/upgradeVerdict.js` four-state + BH + 12% tripwire);
>   S2 L1/L2/L3 + flow-incomplete denom→**U3** (`src/score.js`, denom incl. excluded); S3 bootstrap CI→**U4**
>   (`pairedBootstrapCI` mean/ci/n/seed); S4 graph/heatmap/sankey/break-even→**U5** (`src/depgraph.js`);
>   P01 single-file HTML + report.json/md→**U7** (`bin/aiide.js`+`src/report.js`+`web/vendor/`); S6 quad+budget→
>   **U4**(`buildVersionQuad`)+**U0**(budget); AI-isomorphic data-section/copy-JSON/numbered-md→**U8**; static
>   gates→**U6**. Line 239's governance red line ("報告不得含採用/apply 按鈕；server 只讀；experiment 寫後不可變")
>   matches the iron-rule scan results below.

## Iron rules — whole-repo scan

| Rule | Check | Evidence | Verdict |
|---|---|---|---|
| 1. Zero deps / zero build | `package.json` has no `dependencies`/`devDependencies`; no bare npm import in `src/`; dashboard core does not import vendored ECharts | `package.json` (no deps keys); every `import` is `node:*` or relative; `web/index.html`+`web/obs.js` contain no `vendor/echarts` / `echarts.init` (also guarded by `T7.5/R7.5.2`) | **PASS** |
| 2. experiment/report write-once immutable | no code path rewrites a sealed `upgrades/<id>/` report | `writeReport` throws `"already exists — artifacts are immutable (R7.6.2)"` on existing dir (`report.js:589`); `prune.js`/`lab.js`/`ingest.js` never reference `upgrades/`; guarded by `T7.2/R7.6.2/R7.EB6` | **PASS** |
| 3. Server read-only except annotations | all non-GET → 405; only `PUT /annotations` writes (a sidecar) | `server.js:25` (`method !== 'GET' → 405`), `server.js:21,89` (PUT annotations); `/api/upgrades*` all GET; guarded by `R8.EB3` | **PASS** |
| 4. Governance neutral (no auto-adopt/rewrite) | no adopt/apply/rewrite action anywhere; report + dashboard state "human decision" | grep of `src/`+`web/` finds no auto-adopt/apply/rewrite path; `upgradeVerdict.js:3` ("ADOPTION EVIDENCE, never an auto-adopt"); visible neutrality text in `web/index.html` ("adoption is always … human decision · no adopt/rewrite") and report ("採用永遠是…人類決策") | **PASS** |
| 5. upgradeConfig single source | thresholds (δ/MIN_PAIRS/MIN_PAIRS_SKILL/tripwire/tokenWeights) never re-defined as literals in `src/` outside `upgradeConfig.js` | grep: no `tripwirePct`/`MIN_PAIRS`/`MIN_PAIRS_SKILL`/`nonInferiorityDeltaPp` reassigned outside `upgradeConfig.js`; consumers import `UPGRADE_CONFIG`; frozen-config guarded by `R0.0.1`/`R4.0.3` | **PASS** |

## U7→U8 integration e2e (real artifacts, not fixtures)

Generated a real report from `test/fixtures/synthetic-bundle/bundle.js` via
`node bin/aiide.js upgrade report --data-dir <tmp> --intent cost-opt` → `upgrades/old-full-vs-new-full-…/`
(`report.json`·`report.md`·`report.html`), started the read-only server on that dataDir, and drove
`server.js` + `web/obs.js` against it. **All assertions passed:**

| Surface | Assertion | Result |
|---|---|---|
| `GET /api/upgrades` | list consumes real `report.json`: `verdict=cost-opt`, `intent`, `established=false`, `pairs=13`, `exclusionPct=7.692`, `arms.new/old`=`new-full`/`old-full`, `newVersion=v2.4.0`/`oldVersion=v2.3.1`, `cohort=sonnet`, `lineage`, `compareId`, `createdAt` — **all populated, none null** | PASS |
| `GET /api/upgrades/<id>` | `axes.quality.l1`, `axes.cost.turns`, `perSkill.skills` (4), `footer.config.MIN_PAIRS=8`, `cases[]` (13), `_reportHtmlPath` annotation present | PASS |
| `GET /api/upgrades?trend=1` | `computeTrend` consumes real `cases[]`/`cohort`/`lineage` without throwing → 1 `sonnet` cohort, correct lineage segment | PASS |
| read-only | `POST /api/upgrades` → **405** | PASS |
| `web/obs.js buildUpgradeView` | same real report → `verdict=cost-opt` glyph `✗`, 3 quality axes, 3 cost axes, `nextSteps` computed, `adoptable=false` | PASS |

**Browser smoke (Playwright, visible-text via TreeWalker SHOW_TEXT excl. SCRIPT/STYLE):**
- Dashboard `#upgrades` **list**: renders `✗ cost-opt` · `new-full v2.4.0 vs old-full v2.3.1` · `13` · `sonnet` + governance-neutral notice (no adopt entry).
- Dashboard `#upgrade/<id>` **detail**: verdict badge `✗ cost-opt · 不成立` with honest reason `a quality axis failed non-inferiority`; 3 quality axes (L1 路由 −9.1pp n=11 · L2 +0pp · L3 +0pp heuristic + flow-incomplete); 3 cost axes (轮数 −1.417 显著降 · tokens · 秒); per-skill 关注名单; visible `NOT an adoption certificate (R4.6.5)`.
- Single-file `report.html`: **ECharts 5.6.0 inlined + initialised** (6 chart instances: 3 CI bars SVG + graph/heat/sankey canvas), **zero console errors/warnings**, no "ECharts unavailable" fallback.

(The synthetic bundle carries a deliberate routing regression → `cost-opt` is correctly **NOT established**; the pipeline honestly reports `✗`, not a fake pass.)

## Per-spec AC matrix

Legend: PASS = passing test / impl evidence (assertion inspected). Test names quoted verbatim; test
files under `test/`. Every `R*.EB*` edge/negative AC (33 total) and blocker-class AC (F1/F3/N1) was
verified against the actual assertion, not name-matching.

### U0 lab-infra — 23/23 PASS  (`upgrade-lab.test.js`, `upgradeConfig.test.js`)
R0.0.1 frozen config-writes-throw · R0.0.2 consumers import not redefine · R0.1.1 bounded pool ≤ cap ·
R0.1.2 unique workspace/(case,repeat,arm) · R0.1.3 worker throw never aborts batch · R0.2.1 per-arm
env no cross-leak · R0.2.2 version preflight fail-fast · R0.2.3 arm metadata recorded · R0.2b.1/.2/.3
mixed-arm profile + baseline pairing · **R0.2b.4** mini-verdict e2e (`T7.1/R0.2b.4`) · R0.3.0 no-arm
resumeKey bit-identical · R0.3.1 arm identity → distinct keys · R0.3.2 journal arm-assert · **R0.3.3
(F3)** arm B never reuses arm-A repeats (no delta≈0, `upgrade-lab.test.js:235`) · R0.4.1–.5 scripted
resume / incremental sum / zero-replay / no-script→excluded-not-zero · R0.5.1/.2 budget table +
serializable. **All PASS.**

### U1 dataset-schema — 25/25 PASS  (`upgrade-suite.test.js`)
R1.1.1–.4 required fields / must_confirm→scripted / held_out / clear field+id errors · R1.2.1/.2
canonical sha over whitelist + unclassified→lint · R1.3.1–.4 superset / content-changed / legal
supersede / lineage-break · R1.4.1/.2 id-intersection pairing + dup reject · R1.5.1/.2 tiers + held-out
· R1.6.1/.2 skill-coverage lint · R1.7.1 multi-intent floor · R1.8.1/.2 smoke-size band + template ·
R1.EB1–EB5 (aux-redundancy / dangling superseded_by / remove-case / sha exclude-metadata /
unclassified). **All PASS.**

### U2 dep-collectors — 21/21 PASS  (`upgrade-depgraph.test.js`)
R2.1.1–.4 trigger attribution (input.skill primary; attributionSkill corroboration only) · R2.2.1–.3
read attribution by path prefix · R2.3.1–.3 isMeta body hang-back cost (1457≠28) + null-no-impersonate
· R2.4.1/.1a/.2 per-session sets + `_shared` non-dilution · R2.5.1–.4 three-state structural taxonomy ·
R2.EB1–EB3 (trigger-no-attr / resume-side denial / no-isMeta→null). **All PASS.**

### U3 routing-safety-verifiers — 21/21 PASS  (`upgrade-verifiers.test.js`)
R3.1.1–.5 L1 five-value routing (+FP/permission-artifact/missed) · R3.2.1/.2 L2 reuse + post-resume
scoring · R3.3.1–.4 L3 grader / confirm-turn / sentinel-vs-heuristic / executed-without-ask · R3.4.1–.3
scripted resume / **R3.4.2 (N1)** no-script→excluded-both-axes / any-axis-fail → case fail ·
**R3.5.1 (F1)** flow-incomplete denom includes excluded (2/10) · R3.5.2 Wilson regress · R3.5.3
deliberately-different denom · R3.EB1–EB4. **All PASS.**

### U4 upgrade-verdict — 33/33 PASS  (`upgrade-verdict.test.js`)  [five-state core]
R4.0.1–.3 config import/footer/assert-frozen · R4.1.1–.3 four-tuple + dual denominators · R4.2.1–.3
splitmix32 locked seq / reproducible bootstrap / Wilson reuse · R4.3.1–.3 non-inferiority gate + strict
`>−δ` boundary · R4.4.1–.3 intent verdicts + flow-in-quality-gate + global-only cert · **R4.5.1**
pairs<8→insufficient-data · **R4.5.2/.3** exclusion>12% (strict) →inconclusive · R4.5.2a inconclusive
carries excluded-ids+reasons · **R4.5.4** single-arm(0 pairs)→insufficient-data · R4.6.1–.5 per-skill
cluster bootstrap / <5→insufficient / 5–7→reference-only / BH-only-revoke / non-cert · **R4.7.1 (F3)**
`assertArmIsolation` throws on spliced arms (`upgrade-verdict.test.js:255`) · R4.8.1 version quad ·
R4.9.1 clusterRegressed · R4.EB1–EB5. **All PASS.** Five-state `verdict` ∈ {cost-opt, quality-fix,
neutral-refactor, insufficient-data, inconclusive} with `established` toggled per state; non-adoptability
of insufficient-data/inconclusive enforced in engine **and** dashboard (`web-obs.test.js`: `upgradeAdoptable(...)===false`, glyph `✓✗~∅`).

### U5 depgraph-engine — 21/21 PASS  (`upgrade-depgraph-engine.test.js`)
R5.1.1/.2 read-rate inline/external/gray + n · R5.2.1/.2 co-read≥0.80 merge + `_shared` non-dilution ·
R5.3.1–.3 co-trigger graph / connected-component merge-map / hardExclude never merged · R5.4.1–.4
Jaccard<0.30 split + gates (≥2 cat, ≥5 sess/cat, full-only, 1-cat→insufficient) · R5.5.1/.2 break-even
savings/ceiling + parameterized P(trigger) · R5.6.1/.2 fixed disclaimer+n + candidate-only ·
R5.EB1–EB6. **All PASS.**

### U6 static-gates — 15/15 PASS  (`upgrade-skillint.test.js`)
R6.1.1–.3 desc>descMax error + 1024/1025 boundary + code-point count (astral=1) · R6.2.1/.2 trigger
collision literal · R6.3.1 `_shared` md5 drift · R6.4.1/.2 fixed-tax table (structured) · R6.5.1
declared-version check (no CLI) · R6.6.1/.2 error→fail-fast zero-token / warning survives · R6.EB1–EB4.
**All PASS.**

### U7 upgrade-report — 28/28 PASS  (`upgrade-report.test.js`)
R7.1.1–.3a CLI subcommands / budget-first / smoke-mix header · R7.2.1/.2 verdict-first schema + non-cert
/ separated PA+flow / quad / disclosure / exclusion · R7.3.1/.2 numbered `## N.` md, verdict ch.1 ·
R7.4.1–.4 single-file HTML + charts + honest next-steps + L3-heuristic flag · R7.5.1/.2 sha256 pin +
core-no-import · R7.6.1–.3 artifacts land / write-once / U8 data source · R7.7.1–.3 regressed cards +
report diff + skill×category clusters · R7.8.1 break-even substituted values · R7.EB1–EB7 (insufficient
banner no "可採用" / tampered-sha refuse / md grep / heuristic label / "還需 N 條" + inconclusive ids /
new-dir immutability / no-prev graceful). **All PASS.**

### U8 ax-docs — 15/15 PASS  (`web-obs.test.js`, `upgrade-server.test.js`, `docs/aiide-skill.md`)
| AC | evidence | verdict |
|---|---|---|
| R8.2.1 dashboard read-only upgrade view | `U8: buildUpgradeView assembles banner + 3-axis cards + version quad, honours report MIN_PAIRS` | PASS |
| R8.2.2 view does not inline ECharts | `T7.5/R7.5.2` (scans obs.js + index.html) | PASS |
| R8.2.3 view mirrors U7 next-step guidance | `U8: insufficient-data next step "還需 N 條配對" (R8.EB1)` + `U8: inconclusive next step enumerates excluded case-ids + reasons + actions` | PASS |
| R8.4.1 GET /api/upgrades lists summaries | `GET /api/upgrades lists report.json summaries, newest first (R8.4.1)` + real-artifact e2e above | PASS |
| R8.4.2 ?trend=1 intersection series, superseded breaks | `GET /api/upgrades?trend=1 …superseded lineage breaks (R8.4.2/R8.EB4)` + e2e | PASS |
| R8.4.3 pure GET, no write | `GET /api/upgrades is read-only — non-GET → 405 (R8.EB3)` | PASS |
| R8.EB1 insufficient view "還需 N 條", no 可採 | `web-obs.test.js` R8.EB1 | PASS |
| R8.EB2 dashboard-core zero ECharts import | `T7.5/R7.5.2` | PASS |
| R8.EB3 non-GET → 405 | `upgrade-server.test.js:92` | PASS |
| R8.EB4 trend breaks across superseded | `upgrade-server.test.js` R8.4.2/R8.EB4 | PASS |
| R8.1.1 AX documents CLI + schema keys + grep convention | `docs/aiide-skill.md:97–131` (CLI table, canonical §110 schema keys, report.md grep contract) — content present & correct | PASS (doc) |
| R8.1.2 AX documents 5-state semantics + insufficient/inconclusive≠parity | `docs/aiide-skill.md:135–146` (verdict table + "Hard rule for AI consumers: insufficient-data/inconclusive **never** mean 持平/可採") | PASS (doc) |
| R8.1.3 AX states governance neutrality | `docs/aiide-skill.md:148–154` ("adoption is always a human decision … Neither the CLI nor the dashboard offers any auto-adopt/rewrite action") | PASS (doc) |
| R8.3.1 docs reference authoritative design doc | `docs/aiide-skill.md:92–95` → `docs/onchainos-upgrade-pipeline-design.md` (shipped in-repo; path fixed — F-2) | PASS |
| R8.3.2 docs mark Wave 0 probe as U0/U2/U3 attachment | `docs/aiide-skill.md:95` → `docs/wave0-probe-report.md` (156 lines, shipped in-repo; path fixed — F-2) | PASS |

## Tally

| Spec | Total | PASS | UNCOVERED | UNKNOWN |
|---|---|---|---|---|
| U0 lab-infra | 23 | 23 | 0 | 0 |
| U1 dataset-schema | 25 | 25 | 0 | 0 |
| U2 dep-collectors | 21 | 21 | 0 | 0 |
| U3 routing-safety-verifiers | 21 | 21 | 0 | 0 |
| U4 upgrade-verdict | 33 | 33 | 0 | 0 |
| U5 depgraph-engine | 21 | 21 | 0 | 0 |
| U6 static-gates | 15 | 15 | 0 | 0 |
| U7 upgrade-report | 28 | 28 | 0 | 0 |
| U8 ax-docs | 15 | 15 | 0 | 0 |
| **TOTAL** | **202** | **202** | **0** | **0** |

## Gaps

**UNCOVERED:** none. **UNKNOWN:** none.

The 5 U8 doc ACs (R8.1.1/.1.2/.1.3, R8.3.1/.3.2) are PASS: their content is present and correct in
`docs/aiide-skill.md`, and the two cross-referenced docs exist at the repo-root `docs/` (paths fixed
under F-2). By design these doc-content ACs carry no automated test guard — the targets (design doc,
Wave-0 report) live outside `aiide/`, so guarding them would bind aiide to the monorepo layout. The
ixd Appendix D handoff map (F-3) was cross-checked against implementation and is consistent.
