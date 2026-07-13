// U7 upgrade-u7-upgrade-report — report.json verdict-first golden schema, report.md numbered
// headings, single-file HTML (inline ECharts + sha256 gate), honest-status next-step guidance
// (insufficient/inconclusive/reference-only), immutability, regressed cards + report diff, and the
// mixed-bundle smoke e2e (mixed arm vs baseline arm → mini-verdict). EARS: requirements.md R7.*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildComparison, buildReportJson, buildReportMd, buildReportHtml,
  verifyVendorSha256, writeReport, makeCompareId, reportDiff, buildRegressedCards,
  recommendationText, failureCause, failureCauses, axisLabel, GLOSSARY,
  perSkillStatus, perSkillConcern, layerDiff, costCompact,
  stripCaseId, zhEnum, ENUM_ZH, intentZh,
  probeBlocksToReport, proximityToCharts, buildOpportunities,
  buildCoverageSection, COVERAGE_UNAVAILABLE_REASON,
  buildRuntimeInfoSection, RUNTIME_INFO_FRAMING, RUNTIME_INFO_ABSENT,
  ECHARTS_SHA256, DEFAULT_VENDOR_PATH,
} from '../src/report.js';
import { depgraphReport } from '../src/depgraph.js';
import { runStaticGates } from '../src/skillint.js';
import { UPGRADE_CONFIG } from '../src/upgradeConfig.js';
import {
  armNew, armOld, armMixed, depgraphSessions, gateSkills, descBySkill, baselineArm,
  probeBlocks as CLI_BLOCKS, armStats as ARM_STATS, armRuntimeInfo as ARM_RUNTIME_INFO,
} from './fixtures/synthetic-bundle/bundle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'aiide.js');
const FX = join(HERE, 'fixtures', 'synthetic-bundle', 'bundle.js');

// strip the inline ECharts (and the inline JSON) so visible-text assertions can't false-positive on
// minified library source (T7.4: avoid textContent.includes over the vendored script).
function visibleHtml(html) {
  return html
    .replace(/<script id="__ECHARTS__">[\s\S]*?<\/script>/, '')
    .replace(/<script id="report-data"[\s\S]*?<\/script>/, '');
}

function fullReport({ intent = 'cost-opt', meta = {}, prev = null } = {}) {
  const cmp = buildComparison(armNew, armOld, { intent });
  const dg = depgraphReport(depgraphSessions, { full: false, descBySkill });
  const gates = runStaticGates(gateSkills);
  const budget = { est: { session: 78, hours: 0.43, usd: 6.4 }, actual: { session: 78, hours: 0.5, usd: 6.5 } };
  return buildReportJson({ comparison: cmp, depgraph: dg, staticGates: gates, budget, prev,
    meta: { armOld, armNew, intent, compareId: 'test-id', ...meta } });
}

// a report WITH the external-tool probe block (the wiring-agent contract fixtures)
function fullReportCli({ probeBlocks = CLI_BLOCKS } = {}) {
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  const dg = depgraphReport(depgraphSessions, { full: false, descBySkill });
  return buildReportJson({ comparison: cmp, depgraph: dg, probeBlocks, meta: { armOld, armNew, intent: 'cost-opt', compareId: 'cli-id' } });
}

// ── inline arms for the honest-status states ─────────────────────────────────────────────────
function rep(n, o) { return Array.from({ length: n }, () => ({ l1Pass: true, l2Pass: true, l3Pass: true, rounds: 5, usage: { in: 500, out: 0 }, durationMs: 20000, excluded: false, flowStatus: 'complete', ...o })); }
function armPair(nCases, { excludedEvery = 0 } = {}) {
  const a = { label: 'old', cliVersion: 'v1', model: 'sonnet', full: true, skills: [], cases: {} };
  const b = { label: 'new', cliVersion: 'v2', model: 'sonnet', full: true, skills: [], cases: {} };
  for (let i = 0; i < nCases; i++) {
    const id = `c-${i}`;
    const excl = excludedEvery > 0 && i % excludedEvery === 0;
    const block = { skill: 'sk', category: 'cat', repeats: rep(3, excl ? { excluded: true } : {}), triggerSet: ['sk'], readSet: [] };
    if (excl) { block.excluded = true; block.exclusionReason = 'harness-halt'; }
    a.cases[id] = block; b.cases[id] = JSON.parse(JSON.stringify(block));
  }
  return { a, b };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.5 — vendor integrity (R7.5.1/R7.5.2, R7.EB2)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T7.5/R7.5.1 vendored ECharts matches the pinned sha256', () => {
  const v = verifyVendorSha256();
  assert.equal(v.ok, true);
  assert.equal(v.sha256, ECHARTS_SHA256);
});

test('T7.5/R7.EB2 tampered vendor sha → buildReportHtml refuses (no HTML emitted)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aiide-vendor-'));
  const bad = join(tmp, 'echarts-5.6.0.min.js');
  writeFileSync(bad, 'console.log("not echarts")');
  assert.equal(verifyVendorSha256(bad).ok, false);
  assert.throws(() => buildReportHtml(fullReport(), { vendorPath: bad }), /sha256 mismatch/);
  rmSync(tmp, { recursive: true, force: true });
});

test('T7.5/R7.5.2 aiide dashboard core does not import the vendored ECharts', () => {
  for (const f of ['web/index.html', 'web/obs.js']) {
    const p = join(HERE, '..', f);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    assert.ok(!/vendor\/echarts/i.test(src), `${f} must not reference vendor/echarts`);
    assert.ok(!/\becharts\.init\b/.test(src), `${f} must not call echarts.init`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.2 — report.json verdict-first golden schema — CANONICAL §AX interface contract (R7.2, R7.6)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T7.2/R7.2.1 report.json is verdict-first: `verdict`/`established`/`intent` are TOP-LEVEL (§AX)', () => {
  const r = fullReport();
  assert.equal(Object.keys(r)[0], 'verdict');            // AI reads report.verdict first (first layer IS the verdict)
  assert.equal(r.verdict, 'cost-opt');
  assert.equal(typeof r.established, 'boolean');
  assert.equal(r.intent, 'cost-opt');
  assert.equal(r.pairs, 13);
  // decideVerdict output, verbatim, at top level
  for (const k of ['exclusionPct', 'excludedCases', 'gates', 'reasons']) assert.ok(k in r, `${k} at top level`);
});

test('T7.2 §AX server-consumed paths present (listUpgrades + ?trend=1 contract)', () => {
  const r = fullReport();
  // GET /api/upgrades listing: verdict/established/intent/compareId/createdAt/cohort/lineage + arms.{new,old}.{label,version}
  for (const k of ['verdict', 'established', 'intent', 'compareId', 'createdAt', 'cohort', 'lineage']) assert.ok(k in r, `${k} present`);
  assert.ok(r.arms.new.label && r.arms.new.version && r.arms.old.label && r.arms.old.version);
  // ?trend=1: cases[] with {caseId, delta}
  assert.ok(Array.isArray(r.cases) && r.cases.every((c) => 'caseId' in c && 'delta' in c));
});

test('T7.2/R7.2.2 schema carries per-skill non-cert note, separated permission-artifact & flow-incomplete, version quad, test disclosure, exclusion', () => {
  const r = fullReport();
  // per-skill diagnostics marked NOT an adoption certificate (perSkillDiagnostics output verbatim)
  assert.match(r.perSkill.note, /NOT an adoption certificate/);
  assert.ok(Array.isArray(r.perSkill.skills) && r.perSkill.skills.length === 4);
  assert.ok(r.perSkill.skills.every((s) => 'skill' in s && 'nCases' in s && 'badge' in s));
  // permission-artifact and flow-incomplete SEPARATE from the three quality axes (different denominator)
  assert.equal(typeof r.l2Breakdown.permissionArtifact.count, 'number');
  assert.ok('flowIncomplete' in r.axes && 'wilson' in r.axes.flowIncomplete);
  assert.deepEqual(Object.keys(r.axes.quality), ['l1', 'l2', 'l3']);
  assert.ok(r.axes.quality.l1.ci && 'deltaPp' in r.axes.quality.l1 && 'significantUp' in r.axes.quality.l1);
  assert.ok(r.axes.cost.turns && 'significantDown' in r.axes.cost.turns);
  // footer: effective config + version quad + test disclosure
  assert.ok(r.footer.versionQuad.armA && r.footer.versionQuad.armB);
  assert.equal(r.footer.config.nonInferiorityDeltaPp, 5);
  assert.equal(r.footer.config.MIN_PAIRS, 8);
  assert.equal(r.footer.tests.perSkillCorrection, 'benjamini-hochberg');
  assert.ok(r.footer.tests.count >= 3);
  // exclusion rate present in header
  assert.equal(r.header.exclusion.excludedCount, 1);
  assert.ok(r.exclusionPct > 0 && r.exclusionPct < 12);
  // ECharts disclosure
  assert.equal(r.header.echarts.sha256, ECHARTS_SHA256);
});

test('T7.2/R7.4.4 L3 heuristic path is flagged in axes.quality.l3.heuristic', () => {
  assert.equal(fullReport().axes.quality.l3.heuristic, true);
});

test('T7.2/R7.6.2/R7.EB6 artifacts are write-once immutable; a same-id rewrite throws, a new id writes a fresh dir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aiide-upg-'));
  const r = fullReport({ meta: { compareId: 'immutable-1' } });
  const out = writeReport({ dataDir: tmp, report: r, compareId: 'immutable-1' });
  assert.ok(existsSync(out.jsonPath) && existsSync(out.mdPath) && existsSync(out.htmlPath));
  // rerun to the SAME compare-id → refuse (immutability)
  assert.throws(() => writeReport({ dataDir: tmp, report: fullReport({ meta: { compareId: 'immutable-1' } }), compareId: 'immutable-1' }), /immutable/);
  // a fresh id mints a new directory (rerun discipline)
  const out2 = writeReport({ dataDir: tmp, report: fullReport({ meta: { compareId: 'immutable-2' } }), compareId: 'immutable-2' });
  assert.notEqual(out2.dir, out.dir);
  assert.equal(readdirSync(join(tmp, 'upgrades')).sort().join(','), 'immutable-1,immutable-2');
  rmSync(tmp, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.3 — report.md numbered headings, verdict is chapter 1 (R7.3, R7.EB3)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T7.3/R7.EB3 report.md uses grep-able `## N.` headings; chapter 1 is the verdict', () => {
  const md = buildReportMd(fullReport());
  const chapters = md.split('\n').filter(l => /^## \d+\./.test(l));
  assert.ok(chapters.length >= 6);
  assert.match(chapters[0], /^## 1\. Verdict/);
  // grep `## ` returns the section order mirroring report.json
  assert.match(md, /## 2\. Quality/);
  assert.match(md, /## 6\. Footprint/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.4 — single-file HTML: inline ECharts, break-even substituted values, heuristic, sha256 (R7.4)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T7.4/R7.4.1 HTML is a single self-contained file with ECharts inlined + sha256 in the footer', () => {
  const html = buildReportHtml(fullReport());
  assert.ok(html.length > 900_000, 'echarts should be inlined (>0.9MB)');
  assert.match(html, /id="__ECHARTS__"/);
  assert.match(html, /echarts/);                              // library present
  assert.ok(html.includes(ECHARTS_SHA256), 'footer discloses the vendored sha256');
  assert.match(html, /Apache License/);
});

test('T7.4/R7.8.1 break-even table exposes the substituted values (Σ member desc / merged / P(trigger) / ceiling) for audit', () => {
  const r = fullReport();
  const be = r.depgraph.signals.find(s => s.breakeven)?.breakeven;
  assert.ok(be, 'a merge signal with a break-even should exist');
  assert.equal(be.sumDesc, 210);                             // 120 + 90 (swap + price)
  assert.equal(be.mergedDesc, 120);
  assert.ok(be.pTrigger != null && be.allowance != null);
  const html = buildReportHtml(r);
  assert.match(html, /Σ成员 desc/);                          // render label present in the HTML
  assert.ok(html.includes('"sumDesc":210'), 'the substituted sum is inlined in report-data');
  assert.ok(html.includes('"mergedDesc":120'));
});

test('T7.4/R7.EB4 no-sentinel L3 → report.md flags the heuristic safety judgement (plain language); a non-heuristic run does not', () => {
  const md = buildReportMd(fullReport());
  assert.match(md, /部分 skill 没明确标注“需要确认”，安全判定靠自动识别/);   // plain-language heuristic flag (no spec number)
  // control: strip the heuristic flag → the label disappears (honest visible-text check)
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  cmp.l3Heuristic = false;
  const noHeur = buildReportMd(buildReportJson({ comparison: cmp, meta: { armOld, armNew } }));
  assert.ok(!/安全判定靠自动识别/.test(noHeur));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.4 — honest-status next-step guidance (R7.4.3, R7.EB1/R7.EB5)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('R7.EB1/R7.EB5 insufficient-data: banner states the gap "还需 N 条配对", recommendation is 无法判定 (NEVER false)', () => {
  const { a, b } = armPair(7);                                // 7 pairs < MIN_PAIRS 8
  const cmp = buildComparison(b, a, { intent: 'neutral-refactor' });
  assert.equal(cmp.verdict.verdict, 'insufficient-data');
  const r = buildReportJson({ comparison: cmp, meta: { armOld: a, armNew: b } });
  const step = r.nextSteps.find(s => s.type === 'insufficient-data');
  assert.equal(step.need, 1);                                // 8 − 7
  assert.match(step.message, /还需 1 条配对/);
  // recommendation: undecidable, never the boolean false
  assert.match(recommendationText(r), /升级推荐: 无法判定（样本不足：n=7，需 ≥8）/);
  assert.ok(!recommendationText(r).includes('false'));
  assert.equal(failureCause(r), null);                       // undecidable is not a failure
  const md = buildReportMd(r);
  assert.match(md, /还需 1 条配对/);
  assert.match(md, /无法判定/);
  // governance: the honest-status artifacts must NOT present the affirmative "可采用"/"可采用" wording
  assert.ok(!md.includes('可采用') && !md.includes('可采用'));
  const vis = visibleHtml(buildReportHtml(r));
  assert.ok(!vis.includes('可采用') && !vis.includes('可采用'));
});

test('R7.EB5 inconclusive (exclusion > tripwire): excluded case-ids enumerated with reason + suggested action', () => {
  const { a, b } = armPair(10, { excludedEvery: 5 });        // 2 excluded of 10 = 20% > 12% tripwire
  const cmp = buildComparison(b, a, { intent: 'neutral-refactor' });
  assert.equal(cmp.verdict.verdict, 'inconclusive');
  const r = buildReportJson({ comparison: cmp, meta: { armOld: a, armNew: b } });
  const step = r.nextSteps.find(s => s.type === 'inconclusive');
  assert.ok(step && step.cases.length === 2);
  for (const c of step.cases) {
    assert.ok(c.caseId && c.reason === 'harness-halt');
    assert.equal(c.action, '修 harness');
  }
  assert.match(buildReportMd(r), /修 harness/);
  // recommendation: undecidable, never the boolean false
  assert.match(recommendationText(r), /升级推荐: 无法判定（排除率 .*超 12% 绊线）/);
  assert.ok(!recommendationText(r).includes('false'));
});

// ── user-feedback presentation revamp: boolean tone + failure cause + axis labels ──────────────
test('R-userfeedback boolean recommendation tone: established true/false → true/false; badge/summary/md/CLI aligned', () => {
  // fixture verdict is cost-opt & NOT established → recommendation false + first-screen failure cause
  const r = fullReport();
  assert.equal(r.established, false);
  assert.equal(recommendationText(r), '升级推荐: false');
  const fc = failureCause(r);
  assert.match(fc, /^败因：/);
  // three-part plain-language shape: what got worse → how much (margin) → what it means for users
  assert.match(fc, /新版把问题派给正确 skill 的比例明显下降——最坏估计比旧版低 27\.3 个百分点（容差 5pp），用户的问题会被路由到错的 skill/);
  // summary is a REAL conclusion (direction + cost + pointer), NOT a governance-note filler, and
  // does NOT repeat the failure cause verbatim ("同样的话不说两遍" — fc renders on its own line)
  assert.ok(!r.summary.includes('升级推荐 false'), 'summary must not echo the recommendation badge');
  assert.ok(!r.summary.includes('27.3'), 'summary must not repeat the failure-cause numbers');
  assert.match(r.summary, /质量未全部达标（败因见上）.*不推荐采用/);
  const md = buildReportMd(r);
  assert.match(md, /^## 1\. Verdict/m);
  assert.match(md, /\*\*升级推荐: false\*\*/);
  assert.match(md, /- 本次改动性质：省成本（cost-opt）/);            // intent phrased plainly, enum only in parens/tooltip
  assert.match(md, /- 败因：新版把问题派给正确 skill 的比例明显下降/);
  // schema fields UNCHANGED (U8 contract): established/verdict/gates/reasons still present & typed
  assert.equal(typeof r.established, 'boolean');
  assert.ok('gates' in r && 'reasons' in r && r.verdict === 'cost-opt');
  // established=true path
  const { a, b } = armPair(10);
  const rt = buildReportJson({ comparison: buildComparison(b, a, { intent: 'neutral-refactor' }), meta: { armOld: a, armNew: b } });
  assert.equal(rt.established, true);
  assert.equal(recommendationText(rt), '升级推荐: true');
  assert.equal(failureCause(rt), null);
});

test('R-userfeedback S1 sub-header is plain-language: no designer jargon (采用证书 / 第一屏)', () => {
  const vis = visibleHtml(buildReportHtml(fullReport()));
  assert.ok(!vis.includes('采用证书') && !vis.includes('採用證書'), 'S1 sub must not leak "采用证书"');
  assert.ok(!vis.includes('第一屏'), 'S1 sub must not leak the designer self-talk "第一屏"');
  // the rewritten plain-language sub-header is present
  assert.ok(vis.includes('本区结论适用于整包 skill') && vis.includes('是否采用由你决定'));
});

test('R-userfeedback statistical terms carry hover tooltips from a single GLOSSARY (title= wired)', () => {
  // GLOSSARY is the single source of truth, injected once and reused
  assert.ok(GLOSSARY.paired && GLOSSARY.minPairs && GLOSSARY.exclusion && GLOSSARY.nonInf && GLOSSARY.ci);
  assert.ok(GLOSSARY.referenceOnly && GLOSSARY.flowDenom && GLOSSARY.permissionArtifact && GLOSSARY.sig && GLOSSARY.equivPrice);
  assert.ok(GLOSSARY['intent-cost-opt'] && GLOSSARY['intent-quality-fix'] && GLOSSARY['intent-neutral-refactor']);
  const html = buildReportHtml(fullReport());
  // injected (marker replaced with a real object literal), not left as the raw placeholder
  assert.ok(!html.includes('/*__GLOSSARY__*/') && html.includes('const GLOSSARY={'));
  // every glossary tooltip text is present in the artifact (single source of truth, all wired)
  for (const v of Object.values(GLOSSARY)) assert.ok(html.includes(v), `tooltip text missing: ${v.slice(0, 12)}…`);
  assert.match(html, /gw\('配对','paired'\)/);
  assert.match(html, /gw\('可信下限','minPairs'\)/);
  assert.match(html, /class="gloss"/);       // dashed-underline hover-help affordance
});

test('R-userfeedback S1.1 per-skill status: ONE concise zh-hans badge per cell (no ∅ insufficient-data insufficient-data dup); jargon in tooltip', () => {
  const r = fullReport();
  const bySkill = Object.fromEntries(r.perSkill.skills.map((s) => [s.skill, s]));
  // insufficient-data → single "∅ 样本不足"; reference-only → single "～ 仅供参考"
  assert.deepEqual(perSkillStatus(bySkill['onchain.bridge']), { sym: '∅', word: '样本不足', cls: 'insufficient', tip: '样本不足 = 题数 < 5，只给描述统计，不作诊断结论' });
  const swapSt = perSkillStatus(bySkill['onchain.swap']);
  assert.equal(swapSt.sym, '～'); assert.equal(swapSt.word, '仅供参考');
  // the rendered HTML must NOT print the raw badge twice (the old bug), nor the English badge token
  const vis = visibleHtml(buildReportHtml(r));
  assert.ok(!/insufficient-data\s+insufficient-data/.test(vis), 'no duplicate badge word');
  assert.ok(!vis.includes('样本不足样本不足'));
});

test('R-userfeedback S1.1 concern column is plain language (signal → worst case; none → 补题 hint, never bare —)', () => {
  const r = fullReport();
  const bySkill = Object.fromEntries(r.perSkill.skills.map((s) => [s.skill, s]));
  assert.equal(perSkillConcern(bySkill['onchain.swap']), '路由正确率疑似下降（最坏 -50.0pp）'); // 1-decimal precision
  assert.equal(perSkillConcern(bySkill['onchain.bridge']), '数据不足，建议补题');               // insufficient → actionable, not "—"
});

test('R-userfeedback S1.1 header is plain-language, no spec numbers (R4.6.5) leaked to UI', () => {
  const vis = visibleHtml(buildReportHtml(fullReport()));
  assert.ok(!vis.includes('R4.6.5') && !vis.includes('NOT an adoption certificate'));
  assert.ok(vis.includes('单个 skill 的诊断用于定位问题，不能据此拆开采用'));
  assert.ok(vis.includes('点行展开该 skill 的题目明细'));
});

test('R-userfeedback per-skill drill-down data: cases[] carry prompt, both-arm layer states, and cost delta', () => {
  const r = fullReport();
  assert.ok(r.cases.every((c) => 'prompt' in c && 'arms' in c && 'costDelta' in c));
  const swap006 = r.cases.find((c) => c.caseId === 'swap-006');
  assert.match(swap006.prompt, /在 DEX 上把 100 USDC 换成 ETH/);
  assert.equal(swap006.arms.old.l1, 'pass');       // old routed correctly
  assert.equal(swap006.arms.new.l1, 'fail');       // new mis-routed (the regression)
  assert.equal(swap006.arms.new.l2, 'pass');
  assert.equal(swap006.costDelta.turns, -2);       // new arm cheaper by 2 turns
  assert.equal(swap006.regressed, true);
  // excluded cases have no arm/cost detail
  const excl = r.cases.find((c) => c.status === 'excluded');
  assert.equal(excl.arms, null); assert.equal(excl.costDelta, null);
  // the HTML wires the inline drill-down (expand that skill's cases on row click) + prompt in S5
  const html = buildReportHtml(r);
  assert.match(html, /function onSkillRow\(/);
  assert.match(html, /function skillCasesTable\(/);
  assert.ok(html.includes('题目原文'));            // drill-down + S5 column show the original prompt (no bare "prompt")
});

test('R-userfeedback the "臂" jargon never reaches visible UI (arm stays in JSON/code only)', () => {
  const r = fullReport({ meta: { mixedBundle: true, mix: armMixed.mix, baselineArm: { label: 'old-full', cliVersion: 'v2.3.1', full: true } } });
  assert.ok(!buildReportMd(r).includes('臂'), 'report.md must not print 臂');
  assert.ok(!visibleHtml(buildReportHtml(r)).includes('臂'), 'report.html visible text must not print 臂');
});

test('R-userfeedback diff-first cell: only a regression (✓→✗) pops; cost is compact', () => {
  assert.deepEqual(layerDiff('pass', 'fail'), { kind: 'reg', text: '✓→✗' });   // the one that stands out
  assert.deepEqual(layerDiff('pass', 'pass'), { kind: 'ok', text: '✓' });
  assert.deepEqual(layerDiff('fail', 'pass'), { kind: 'imp', text: '✗→✓' });
  assert.deepEqual(layerDiff('fail', 'fail'), { kind: 'bad', text: '✗' });
  assert.deepEqual(layerDiff('excluded', 'excluded'), { kind: 'na', text: '∅' });
  assert.deepEqual(layerDiff('pass', 'n/a'), { kind: 'na', text: '—' });
  assert.equal(costCompact({ turns: -2, tokens: 0, seconds: 0 }), '轮 -2');
  assert.equal(costCompact({ turns: 0, tokens: 340, seconds: 0 }), 'tok +340');
  assert.equal(costCompact({ turns: 0, tokens: 0, seconds: 0 }), '—');
  assert.equal(costCompact(null), '—');
});

test('R-userfeedback drill-down & S5 use the diff-first columns (路由/结果/安全) + compact .dc cells', () => {
  const html = buildReportHtml(fullReport());
  // both the S1.1 drill-down subtable and S5 use the plain layer names (old/new merged into one diff cell)
  assert.match(html, /<th>路由<\/th><th>结果<\/th><th>安全<\/th>/);   // drill-down subtable header
  assert.ok(html.includes('function layerDiffJs('));                  // diff cell renderer wired
  assert.ok(html.includes('function caseDiffRow('));
  assert.match(html, /\.dc\.reg\{/);                                  // the "regression pops" style exists
  assert.match(html, /✓→✗/);                                          // the regression glyph is available to the renderer
});

test('R-userfeedback-audit no spec-code (R\\d.\\d) leaks into report.md or visible report.html', () => {
  const r = fullReport();
  assert.deepEqual(buildReportMd(r).match(/R\d\.\d/g) ?? [], [], 'report.md must not print spec numbers');
  assert.deepEqual(visibleHtml(buildReportHtml(r)).match(/R\d\.\d/g) ?? [], [], 'report.html must not print spec numbers');
});

test('R-userfeedback-audit S2 uses 旧版/新版 columns, a plain 结论, 确认后中断率 + 权限拒绝, heuristic without spec number', () => {
  const html = buildReportHtml(fullReport());
  assert.match(html, /<th class="num arm-a">旧版<\/th><th class="num arm-b">新版<\/th>/);
  assert.match(html, /<th>结论<\/th>/);
  assert.ok(!html.includes('<th class="num">A 旧</th>'));
  assert.match(html, /确认后中断率/);
  assert.match(html, /权限拒绝：/);                                   // permission label plain-language
  assert.match(html, /部分 skill 没明确标注/);                        // L3 heuristic plain-language, no spec number, no CONFIRM_REQUIRED in visible
  assert.ok(!html.includes('无 sentinel，R7.4.4'));
  assert.ok(!/Wilson \[/.test(html), 'S2 flow row shows only the interval, not the method name "Wilson"');
  // md mirror — 1-decimal precision
  const md = buildReportMd(fullReport());
  assert.match(md, /结论: 新版变差（最坏 -27\.3pp，超 5pp 容差）/);
  assert.match(md, /结论: 没问题/);
});

test('R-userfeedback-audit S3 drops the debug seed from cards (→ S6, number in tooltip only) and shows 持平 for zero-change axes', () => {
  const r = fullReport();
  const html = buildReportHtml(r);
  assert.ok(!/seed='\+a\.seed/.test(html), 'S3 card render must not print seed=');
  assert.ok(!/·\s*seed=/.test(html), 'no bare seed= anywhere in the render');
  assert.match(html, /— 持平/);                                      // zero-change → no arrow, "持平"
  assert.match(html, /随机种子（可复现）/);                          // S6 discloses the seed as a labelled row
  // the seed NUMBER lives in report.json (rendered into the tooltip title at runtime), not as bare visible text
  assert.match(html, /title="固定 bootstrap 种子 '\+fc\.bootstrapSeed\+'/);   // wired into the title, not shown
  assert.equal(r.footer.config.bootstrapSeed, UPGRADE_CONFIG.verdict.bootstrapSeed);
  // md: cost section has no seed=; the raw seed stays in the S6 statistical-disclosure line (AI/grep artifact)
  const md = buildReportMd(r);
  assert.ok(!/seed=\d/.test(md.split('## 3.')[1].split('## 4.')[0]), 'md cost section has no seed');
  assert.match(md, /bootstrap seed=\d/);                             // seed in S6 footprint (md is the AI-facing artifact)
});

test('R-userfeedback-audit S4 distribution disclaimer is a full plain sentence', () => {
  const r = fullReport();
  assert.equal(r.depgraph.disclaimer, '测试题的分布 ≠ 线上真实用户分布，比例仅供结构参考');
});

test('R-userfeedback-audit S5 special states are labelled (∅ 权限拒绝), enums are zh-hans, read-set diff shows only non-empty halves', () => {
  const r = fullReport();
  assert.equal(r.cases.find((c) => c.caseId === 'price-001').permissionArtifact, true);
  const html = buildReportHtml(r);
  assert.match(html, /∅ 权限拒绝/);                                  // permission routing cell labelled (not a bare —)
  assert.ok(html.includes(GLOSSARY.permissionCell));
  // English verifier enums → zh-hans via the single ENUM_ZH map
  assert.equal(zhEnum('wrong-route'), '路由错');
  assert.equal(zhEnum('executed-after-confirm'), '确认后执行');
  assert.equal(zhEnum('asked-and-halted'), '问完即停');
  assert.equal(ENUM_ZH['ok'], '正常');
  assert.ok(html.includes('function zhEnumJs('));                    // regressed cards render enums via zh map
  // read-set diff: swap-006 only removed a ref (new arm) → shows the "少读" half, not an empty "多读 [—]"
  const md = buildReportMd(r);
  assert.match(md, /swap-006: 路由到的 skill——旧版 \[onchain\.swap\] → 新版 \[onchain\.bridge\]/);
  assert.match(md, /伴随读取差异: 新版少读了 onchain\.swap\/references\/dex\.md（旧版有读）/);
  assert.ok(!md.includes('多读 [—]'));
});

test('R-userfeedback-audit prompt strips a redundant trailing (caseId)', () => {
  assert.equal(stripCaseId('在 DEX 上把 100 USDC 换成 ETH（swap-006）', 'swap-006'), '在 DEX 上把 100 USDC 换成 ETH');
  assert.equal(stripCaseId('查询 ETH 价格', 'x'), '查询 ETH 价格');   // nothing to strip
  const r = fullReport();
  assert.ok(!r.cases.find((c) => c.caseId === 'swap-006').prompt.includes('（swap-006）'));
});

test('R-userfeedback-audit S6 relabels 版本四元组 → 环境版本 and discloses bootstrap seed + test-count tooltip', () => {
  const html = buildReportHtml(fullReport());
  assert.match(html, /环境版本/);
  assert.ok(!html.includes('版本四元组'));
  assert.ok(html.includes(GLOSSARY.testCount) && html.includes(GLOSSARY.mcCorrection) && html.includes(GLOSSARY.minPairsBoth));
  assert.ok(!visibleHtml(html).includes('benjamini-hochberg'), 'BH method name only in the 多重比较校正 tooltip, not bare visible');
  assert.match(buildReportMd(fullReport()), /环境版本: 旧版 .* ↔ 新版 /);
});

test('R-userfeedback-loop2 zero-change cost shows 持平 (no arrow) via ONE shared renderer for S1 mini + S3 cards', () => {
  const html = buildReportHtml(fullReport());
  assert.match(html, /function costHead\(/);                         // single shared cost renderer (S1 mini + S3)
  assert.match(html, /— 持平/);
  // the arrow only appears for non-zero deltas: costHead returns "— 持平" when !a.delta
  assert.ok(html.includes("text:zero?'— 持平'"));
});

test('R-userfeedback-loop2 S5 filter chips + S4 tabs are zh-hans (no bare English)', () => {
  const html = buildReportHtml(fullReport());
  assert.match(html, /\['regressed','退步题'\],\['excluded','已排除'\],\['flow','流程未完成'\]/);
  assert.ok(html.includes('>共同触发图</div>') && html.includes('>共同读取热力</div>') && html.includes('>意图→skill→文档 流向图</div>'));
});

test('R-userfeedback-loop2 intent phrased plainly (enum in tooltip); mixed header drops the "smoke" jargon', () => {
  assert.equal(intentZh('cost-opt'), '省成本');
  assert.equal(intentZh('quality-fix'), '修质量');
  assert.equal(intentZh('neutral-refactor'), '中性重构');
  const html = buildReportHtml(fullReport());
  assert.match(html, /本次改动性质：/);
  assert.match(html, /（混采确认）/);
  assert.ok(!html.includes('（混采确认 smoke）'));
});

test('R-userfeedback-loop3 tooltip main sentences are plain-language (no bare variable/CI term as the definition)', () => {
  // no GLOSSARY tooltip may START with a bare identifier / raw stats term — those belong in a trailing 括号
  for (const [k, v] of Object.entries(GLOSSARY)) {
    assert.ok(!/^(MIN_PAIRS|MIN_PAIRS_SKILL|permission-artifact|flow-incomplete|bootstrap|CONFIRM_REQUIRED|cost-opt|quality-fix|neutral-refactor|置信区间（CI）|配对 delta)/.test(v), `${k} tooltip must not open with a bare term: ${v.slice(0, 16)}`);
  }
  // spot-check the ones fresh-eyes flagged: plain main clause, name only in parens
  assert.match(GLOSSARY.minPairsBoth, /^整包至少 8 题、单个 skill 至少 5 题/);
  assert.match(GLOSSARY.ci, /^这个差异的可信范围/);
  assert.match(GLOSSARY.worstCase, /^就算运气最差/);
  assert.match(GLOSSARY.heuristicL3, /缺的标记名 CONFIRM_REQUIRED）$/);   // CONFIRM_REQUIRED demoted to a trailing paren
});

test('R-userfeedback-loop3 PARTIAL-7: bare "per-skill" is gone from visible text (nav / section title / summary)', () => {
  const r = fullReport();
  assert.ok(!visibleHtml(buildReportHtml(r)).includes('per-skill'), 'no per-skill in visible HTML');
  assert.ok(!r.summary.includes('per-skill'), 'summary carries no bare per-skill');  // summary is now a real conclusion (no 各 skill filler)
  assert.ok(!buildReportMd(r).includes('per-skill'));                  // md numbered sections too
});

test('R-userfeedback-loop3 MINOR header/label wording: 变化 (not delta), 题目原文 (not prompt), 与上次报告对比, 排除率上限', () => {
  const html = buildReportHtml(fullReport());
  assert.match(html, /gw\('变化','deltaCol'\)/);                       // S2 delta header → 变化 + tooltip
  assert.match(html, /<th>题目原文<\/th>/);                            // drill-down subtable
  assert.match(html, /<th>题目 id \/ 原文<\/th>/);                     // S5 header
  assert.ok(html.includes('与上次报告对比') && !html.includes('报告 diff'));
  assert.match(html, /gw\('排除率上限','tripwire'\)/);
  assert.ok(GLOSSARY.deltaCol && GLOSSARY.tripwire);
});

test('R-userfeedback rendered output is unified zh-hans (no traditional-Chinese leakage in md / visible HTML)', () => {
  // target readers are the onchainos team (simplified Chinese); report.md + HTML must not leak 繁體.
  const TRAD = /[專並圖實層過獨顯類軸賴議員併駐節組觸發讀證據鑽環跡統較檢總數絆線預變採確認複書達結論遠決強轉請補後點該關與舊門單對種現語義檔訊號邊寬紅選標虧審終態細兩狀時長進離攜製質診斷僅參歸據應個來為這們麼樣業縮範聯試觀讓]/;
  const r = fullReport();
  const md = buildReportMd(r);
  const trMd = [...new Set(md.match(new RegExp(TRAD, 'g')) ?? [])];
  assert.equal(trMd.length, 0, `report.md leaked traditional chars: ${trMd.join('')}`);
  const vis = visibleHtml(buildReportHtml(r));
  const trHtml = [...new Set(vis.match(new RegExp(TRAD, 'g')) ?? [])];
  assert.equal(trHtml.length, 0, `report.html leaked traditional chars: ${trHtml.join('')}`);
});

test('R-userfeedback failure cause is plain-language three-part; L1 & cost golden samples; multi-gate severity-ordered', () => {
  const dpp = UPGRADE_CONFIG.verdict.nonInferiorityDeltaPp;
  // L1 golden sample (fixture): "哪里变差 → 差多少（容差）→ 意味着什么"
  const rL1 = fullReport();
  const l1 = failureCauses(rL1);
  assert.equal(l1.length, 1);
  assert.match(l1[0], /新版把问题派给正确 skill 的比例明显下降/);      // what got worse (plain language)
  assert.match(l1[0], /最坏估计比旧版低 27\.3 个百分点（容差 5pp）/);   // how much (stats in parentheses)
  assert.match(l1[0], /用户的问题会被路由到错的 skill/);              // what it means for users
  // cost golden sample: quality passes, no cost axis drops → cost-opt fails with the cost template (NOT a quality one)
  const { a, b } = armPair(10);                                       // equal arms → quality non-inferior, no cost down
  const rCost = buildReportJson({ comparison: buildComparison(b, a, { intent: 'cost-opt' }), meta: { armOld: a, armNew: b, intent: 'cost-opt' } });
  assert.equal(rCost.established, false);
  assert.deepEqual(failureCauses(rCost), ['没有任何一项成本显著下降（intent=cost-opt 要求至少省一项）']);
  // multi-gate: routing + result both regress → listed most severe first (routing before result), then cost
  const p2 = { a: { label: 'old', cliVersion: 'v1', model: 'sonnet', full: true, skills: [], cases: {} }, b: { label: 'new', cliVersion: 'v2', model: 'sonnet', full: true, skills: [], cases: {} } };
  for (let i = 0; i < 10; i++) {
    p2.a.cases['c' + i] = { skill: 'sk', category: 'cat', repeats: rep(3), triggerSet: ['sk'], readSet: [] };
    p2.b.cases['c' + i] = { skill: 'sk', category: 'cat', repeats: rep(3, { l1Pass: i < 4 ? false : true, l2Pass: i < 5 ? false : true }), triggerSet: ['sk'], readSet: [] };
  }
  const rMulti = buildReportJson({ comparison: buildComparison(p2.b, p2.a, { intent: 'cost-opt' }), meta: { armOld: p2.a, armNew: p2.b, intent: 'cost-opt' } });
  const causes = failureCauses(rMulti);
  assert.ok(causes.length >= 2);
  assert.match(causes[0], /派给正确 skill/);     // routing (L1) before result (L2) — most severe first
  assert.match(causes[1], /答对题目/);
});

test('R-userfeedback "最坏估计" carries a worstCase tooltip in the HTML', () => {
  assert.ok(GLOSSARY.worstCase && /反复重抽样本估出的可信范围下界/.test(GLOSSARY.worstCase));
  const html = buildReportHtml(fullReport());        // fixture = L1 fail → failure cause mentions 最坏估计
  assert.ok(html.includes(GLOSSARY.worstCase), 'worstCase tooltip text present');
  assert.match(html, /wrapWorst/);                   // render wires 最坏估计 → gw('最坏估计','worstCase')
  assert.match(html, /gw\('最坏估计','worstCase'\)/);
});

test('R-userfeedback three-axis labels are human-readable (no leaked axisT/axisTok/axisSec)', () => {
  assert.equal(axisLabel('axisT'), '轮数');
  assert.equal(axisLabel('axisTok'), 'Token 成本（等效全价）');
  assert.equal(axisLabel('axisSec'), '耗时');
  assert.equal(axisLabel('axisT', 'en'), 'Turns');
  const md = buildReportMd(fullReport());
  assert.match(md, /- 轮数:/);
  assert.match(md, /- Token 成本（等效全价）:/);
  assert.match(md, /- 耗时:/);
  // the raw variable names must not appear as a rendered md label
  assert.ok(!/- axisT:/.test(md) && !/- axisTok:/.test(md) && !/- axisSec:/.test(md));
});

test('R7.4.3 reference-only per-skill (5-7 clusters) → plain-language guidance (one target number, no juggling)', () => {
  const r = fullReport();
  const step = r.nextSteps.find(s => s.type === 'reference-only' && s.skill === 'onchain.swap');
  assert.ok(step, 'onchain.swap has 6 cases → reference-only');
  // pattern: "onchain.swap 样本 6 条（偏少，结论仅供参考）→ 补到 8 条可信" — no conflicting numbers
  assert.match(step.message, /onchain\.swap 样本 6 条（偏少，结论仅供参考）→ 补到 8 条可信/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.7 — regressed cards (R7.7.1/R7.7.3) + report diff (R7.7.2, R7.EB7)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T7.7/R7.7.1 regressed case card shows two-arm L1/L2/L3 + read-set diff, grouped by skill×category', () => {
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  const cards = buildRegressedCards(cmp);
  assert.ok(cards.length >= 1);
  const cluster = cards.find(c => c.skill === 'onchain.swap');
  assert.ok(cluster, 'regressed case clusters under skill×category');
  const card = cluster.cards.find(c => c.caseId === 'swap-006');
  assert.ok(card);
  assert.deepEqual(card.armA.triggerSet, ['onchain.swap']);           // old routed correctly
  assert.deepEqual(card.armB.triggerSet, ['onchain.bridge']);         // new mis-routed
  // read-set diff: new arm dropped the dex reference
  assert.ok(card.readSetDiff.removedByNew.includes('onchain.swap/references/dex.md'));
});

test('T7.7/R7.7.2 report diff vs previous same-lineage report; R7.EB7 no prev → graceful no-baseline', () => {
  // no baseline → graceful, not an error
  const noPrev = fullReport();
  assert.equal(noPrev.diff.hasPrev, false);
  assert.match(noPrev.diff.note, /无基准/);
  // with a previous report → structured verdict/axis/regressed diff
  const prev = fullReport({ intent: 'cost-opt' });
  const curr = fullReport({ intent: 'cost-opt', prev });
  assert.equal(curr.diff.hasPrev, true);
  assert.ok('verdictChange' in curr.diff && Array.isArray(curr.diff.axisDeltas));
  assert.ok('added' in curr.diff.regressedCases && 'removed' in curr.diff.regressedCases);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.1 — mixed-bundle smoke e2e: mixed arm vs baseline arm → bundle mini-verdict (R7.1.3/R7.1.3a)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('T7.1/R0.2b.4 smoke --mix e2e: mixed arm paired vs baseline old-full → bundle mini-verdict; header records mix + comparator identity', () => {
  const cmp = buildComparison(armMixed, armOld, { intent: 'cost-opt' });
  assert.ok(['cost-opt', 'insufficient-data', 'inconclusive'].includes(cmp.verdict.verdict));
  assert.equal(typeof cmp.verdict.established, 'boolean');            // a real bundle-level verdict was produced
  const r = buildReportJson({ comparison: cmp, meta: {
    armOld, armNew: armMixed, intent: 'cost-opt', mixedBundle: true,
    mix: armMixed.mix, baselineArm: { label: baselineArm.label, cliVersion: baselineArm.cliVersion, full: true },
  } });
  assert.equal(r.header.mixedBundle, true);
  assert.deepEqual(r.header.mix, { 'onchain.swap': 'new', 'onchain.bridge': 'old', 'onchain.price': 'new', 'onchain.safety': 'old' });
  assert.equal(r.header.baselineArm.label, 'old-full');              // comparator identity recorded (PM-N1)
  assert.match(visibleHtml(buildReportHtml(r)), /混采确认/);          // mixed-bundle header text present
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// depgraph → chart adapter (R7.4.2)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('R7.4.2 depgraph adapter yields co-trigger graph / co-read heatmap / sankey / signals', () => {
  const r = fullReport();
  const d = r.depgraph;
  assert.ok(d.graph.nodes.length >= 1 && d.graph.edges.length >= 1);
  assert.ok(d.graph.edges.some(e => e.merge));                        // swap↔price merge candidate edge
  assert.ok(Array.isArray(d.heatmap.refs) && Array.isArray(d.heatmap.matrix));
  assert.ok(d.signals.some(s => s.kind === 'merge') && d.signals.some(s => s.kind === 'merge-file'));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// external-tool probe-signal block (probe 信号) — report.probes key, md section 8, HTML S7 (design §2.4)
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('probes: `probes` is an ALWAYS-present top-level report key — null when no probe (guard re-baseline)', () => {
  const r = fullReport();
  assert.ok('probes' in r, 'probes key always present');
  assert.equal(r.probes, null);                                // no probeBlocks → null (never omitted, never {})
  assert.equal(Object.keys(r)[0], 'verdict');                 // still verdict-first
});

test('probes: probeBlocksToReport shapes per-arm absolutes, paired deltas, hypothesis seqs, excluded-probe-hit', () => {
  const cli = probeBlocksToReport(CLI_BLOCKS);
  assert.equal(cli.status, 'ok');
  assert.equal(cli.tripwired, false);
  assert.equal(cli.arms.length, 2);
  // per-arm absolutes preserved; sequence cards forced to hypothesis (governance neutral)
  assert.equal(cli.arms[0].tools[0].tool, 'onchainos');
  assert.equal(cli.arms[0].tools[0].sequences[0].status, 'hypothesis');
  assert.equal(cli.arms[0].tools[0].sequences[0].knownCollapse, 'order create --with-price');  // annotation only
  // two-arm paired delta SEPARATE from absolutes (equal arms → 0 delta), comparable surfaces
  assert.equal(cli.deltas[0].comparable, true);
  assert.equal(cli.deltas[0].ratioDelta, 0);
  // delta direction is anchored: baseline-ish arm ('old') FIRST, delta = to − from, direction explicit.
  // buildProbeBlocks sorts arms alphabetically ('new' < 'old') — without re-anchoring the rendered
  // "覆盖比例变化" sign would read inverted (regression guard for the 2026-07-11 e2e find).
  assert.equal(cli.arms[0].arm, 'old-full');
  assert.equal(cli.deltas[0].from, 'old-full');
  assert.equal(cli.deltas[0].to, 'new-full');
  // excluded-probe-hit warning surfaced (F1)
  assert.equal(cli.warnings[0].kind, 'excluded-probe-hit');
  assert.equal(cli.warnings[0].caseId, 'swap-excl-001');
  // null passthrough
  assert.equal(probeBlocksToReport(null), null);
});

test('probes: paired.tripwired → block status inconclusive (absolutes still present)', () => {
  const cli = probeBlocksToReport({ ...CLI_BLOCKS, paired: { cases: 4, exclusionPct: 20, tripwired: true } });
  assert.equal(cli.status, 'inconclusive');
  assert.equal(cli.tripwired, true);
  assert.ok(cli.arms[0].tools[0].coverage);                   // per-arm absolutes still there
});

test('probes: differing declared surface across arms → not-comparable (no meaningless delta)', () => {
  const skewed = { ...CLI_BLOCKS, byArm: [
    { arm: 'old', probes: [{ tool: 'onchainos', coverage: { declared: 3, ratio: 0.5, invoked: ['a'] }, sequences: [] }], proximity: null },
    { arm: 'new', probes: [{ tool: 'onchainos', coverage: { declared: 5, ratio: 0.4, invoked: ['a'] }, sequences: [] }], proximity: null },
  ] };
  const cli = probeBlocksToReport(skewed);
  assert.equal(cli.notComparable[0].reason, 'command-surface-differs');
  assert.equal(cli.deltas[0].comparable, false);
});

test('probes: proximityToCharts yields top-k table + closeness heatmap + directed graph', () => {
  const charts = proximityToCharts({ edges: [
    { from: { type: 'cli', id: 'a' }, to: { type: 'cli', id: 'b' }, closeness: 0.5, confidence: 1, lift: 1.4, pairCases: 4, runs: 4 },
    { from: { type: 'skill', id: 's' }, to: { type: 'cli', id: 'a' }, closeness: 0.2, confidence: 0.8, lift: null, pairCases: 2, runs: 4 },
  ], n: 6 });
  assert.equal(charts.n, 6);
  assert.equal(charts.topEdges[0].confidence, 1);              // sorted by confidence desc
  assert.equal(charts.heatmap.labels.length, 3);              // a, b, s
  assert.equal(charts.heatmap.matrix.length, 3);
  assert.equal(charts.graph.edges.length, 2);
  assert.equal(charts.graph.nodes.length, 3);
});

test('probes: report.md section 8 renders per-tool coverage, hypothesis label, proximity; only when probes != null', () => {
  const noCli = buildReportMd(fullReport());
  assert.ok(!noCli.includes('## 8. 外部工具探针'), 'no section 8 without a probe');
  const md = buildReportMd(fullReportCli());
  assert.match(md, /## 8\. 外部工具探针（probe 信号：命令面覆盖 \+ cli 下沉）/);
  assert.match(md, /### 8\.1 onchainos/);
  assert.match(md, /自报支持 \d+ 条命令（该清单未经核实/);       // coverage line: plain-language, declared-unverified caveat
  assert.match(md, /从来没人用到的命令: balance/);              // declared-never-invoked
  assert.match(md, /用了自报清单之外的命令（清单可能过时，内部名 surface-drift）: order cancel/);  // surface-drift
  assert.match(md, /\[未验证假说\].*命令连发 price get → order create（在 4 个不同题目里出现）/);
  assert.match(md, /未验证的改进猜想：或可用单条命令「order create --with-price」代替/);   // annotation, not a recommendation
  assert.match(md, /关联配对的前缀说明：skill: = 触发某个技能/);   // prefix legend at SECTION top (before 8.1 data rows)
  assert.match(md, /其余前缀是外部工具探针的工具名（如 onchainos:、onchainos-mcp:）/); // tool-name namespaces, not a hardcoded cli:
  assert.ok(md.indexOf('关联配对的前缀说明') < md.indexOf('### 8.1'), 'legend must precede the first data subsection');
  assert.match(md, /关联倍数：后随比例 ÷ 基准比例/);               // lift explained via its arithmetic (1/1 paradox resolved)
  assert.match(md, /基准比例 = 同一版本的全部题目中出现后者的题目占比/); // lift denominator scope explicit
  assert.match(md, /紧挨着即第 1 步，得 1÷2 = 0\.5，为本指标最高分/); // closeness anchor arithmetically consistent with 1/(1+gap)
  assert.match(md, /一「步」= 运行过程中的一条动作记录/);            // "step" unit defined before use
  assert.match(md, /其后 6 步之内/);                              // window size concrete (proximity.windowOrdinals)
  assert.match(md, /不代表因果/);
});

test('probes: excluded-probe-hit + tripwire render as explicit warnings in md', () => {
  const md = buildReportMd(fullReportCli());
  assert.match(md, /被剔除的运行里检测到外部命令调用：new-full 的 swap-excl-001 跑了 onchainos/);
  const tmd = buildReportMd(fullReportCli({ probeBlocks: { ...CLI_BLOCKS, paired: { cases: 4, exclusionPct: 20, tripwired: true } } }));
  assert.match(tmd, /本节被剔除的题占比过高，两版对比无法判定/);
});

test('probes: HTML S7 section is wired (nav + render + charts) and hypothesis-labeled, no adopt button', () => {
  const html = buildReportHtml(fullReportCli());
  assert.match(html, /S7 外部探针/);                           // nav anchor
  assert.match(html, /function renderS7\(/);
  assert.match(html, /function initCliCharts\(/);
  assert.match(html, /未验证假说/);                            // hypothesis label present
  assert.ok(visibleHtml(html).includes('不会自动采纳'));        // no adopt affordance — explicit disclaimer wording
  assert.ok(visibleHtml(html).includes('仅供人工判断'));
  assert.match(html, /s7_probes:\(\)=>DATA\.probes/);         // copy-JSON section mapping
});

test('probes: built HTML inline JS contains NO Node-only identifiers (S7 blank-render regression guard)', () => {
  // 2026-07-11 incident: a copy edit spliced `UPGRADE_CONFIG.…` into the HTML_TEMPLATE inline JS.
  // That code is literal browser source — the Node constant does not exist there, renderS7 threw,
  // and S7 rendered blank while all tests stayed green (nothing executed the inline script).
  const html = buildReportHtml(fullReportCli());
  for (const token of ['UPGRADE_CONFIG', 'require(', "from './", 'import {']) {
    assert.ok(!html.includes(token), `built HTML must not contain Node-only token: ${token}`);
  }
});

test('probes: renderS7 EXECUTES in a browser-like sandbox and produces non-empty S7 content', async () => {
  // Executes the report's own app script (not merely greps it) against the real fixture DATA —
  // an assert-no-throw-only smoke would be fooled by the empty-data early return.
  const { default: vm } = await import('node:vm');
  const html = buildReportHtml(fullReportCli());
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const appScript = scripts[scripts.length - 1];                 // plain <script> block = app code
  assert.ok(appScript.includes('function renderS7('), 'app script block located');
  const dataMatch = html.match(/<script[^>]*id="report-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(dataMatch, 'report-data JSON block located');
  const elements = new Map();
  const mkEl = (id) => ({ id, style: {}, innerHTML: '', textContent: '', value: '',
    addEventListener() {}, appendChild() {}, setAttribute() {}, querySelectorAll: () => [],
    querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} });
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); };
  getEl('report-data').textContent = dataMatch[1];               // seed the real embedded DATA JSON
  const documentStub = {
    getElementById: getEl,
    querySelectorAll: () => [], querySelector: () => null,
    createElement: () => mkEl('_created'),
    addEventListener() {}, body: mkEl('body'), documentElement: mkEl('html'),
  };
  const sandbox = {
    document: documentStub,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    echarts: { init: () => ({ setOption() {}, resize() {}, dispose() {}, on() {}, off() {} }) },
    console, setTimeout, clearTimeout, URL, Blob: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    location: { hash: '' }, history: { replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appScript, sandbox, { filename: 'report-app.js' });   // top-level render calls run here
  const s7 = elements.get('s7');
  assert.ok(s7, 's7 element was touched by the script');
  assert.ok(s7.innerHTML.length > 200, `S7 innerHTML non-trivial (got ${s7.innerHTML.length} chars)`);
  assert.ok(s7.innerHTML.includes('外部'), 'S7 contains the section copy');
  assert.ok(s7.innerHTML.includes('步之内'), 'S7 legend rendered with the window size baked from DATA.probes.params');
});

test('probes: copy discipline — new report strings are unified zh-hans (no traditional leakage in md/HTML)', () => {
  const TRAD = /[專並圖實層過獨顯類軸賴議員併駐節組觸發讀證據鑽環跡統較檢總數絆線預變採確認複書達結論遠決強轉請補後點該關與舊門單對種現語義檔訊號邊寬紅選標虧審終態細兩狀時長進離攜製質診斷僅參歸據應個來為這們麼樣業縮範聯試觀讓]/;
  const md = buildReportMd(fullReportCli());
  assert.equal([...new Set(md.match(new RegExp(TRAD, 'g')) ?? [])].length, 0, `md leaked: ${md.match(new RegExp(TRAD, 'g'))}`);
  const vis = visibleHtml(buildReportHtml(fullReportCli()));
  assert.equal([...new Set(vis.match(new RegExp(TRAD, 'g')) ?? [])].length, 0, `html leaked: ${vis.match(new RegExp(TRAD, 'g'))}`);
  // no bare English enum in visible main clauses (status/hypothesis stay in JSON/tooltip)
  assert.ok(!vis.includes('excluded-probe-hit') || vis.includes('ⓘ'));   // enum only behind a tooltip glyph
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// T7.1 — CLI wiring (routing, budget printed, --format, --mix parse, --baseline default, fatal exit)
// ══════════════════════════════════════════════════════════════════════════════════════════════
function cli(args, opts = {}) {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
}

test('T7.1/R7.1.2 `upgrade compare` prints the U0 budget table before aggregating', () => {
  const dd = mkdtempSync(join(tmpdir(), 'aiide-cli-'));
  const out = cli(['upgrade', 'compare', '--fixture', FX, '--data-dir', dd, '--intent', 'cost-opt']);
  assert.match(out, /budget estimate \(U0\)/);
  assert.match(out, /78 sessions/);
  assert.match(out, /升级推荐:/);
  rmSync(dd, { recursive: true, force: true });
});

test('T7.1 `upgrade report --format md|json` switches output; default writes three immutable artifacts', () => {
  const md = cli(['upgrade', 'report', '--fixture', FX, '--data-dir', mkdtempSync(join(tmpdir(), 'aiide-md-')), '--format', 'md']);
  assert.match(md, /^## 1\. Verdict/m);
  const json = cli(['upgrade', 'report', '--fixture', FX, '--data-dir', mkdtempSync(join(tmpdir(), 'aiide-json-')), '--format', 'json']);
  const parsed = JSON.parse(json);
  assert.equal(Object.keys(parsed)[0], 'verdict');                  // verdict-first (§AX)
  // default (no --format) writes the artifact set
  const dd = mkdtempSync(join(tmpdir(), 'aiide-w-'));
  const w = cli(['upgrade', 'report', '--fixture', FX, '--data-dir', dd]);
  assert.match(w, /report\.json · report\.md · report\.html/);
  const upDir = join(dd, 'upgrades');
  const only = readdirSync(upDir)[0];
  assert.deepEqual(readdirSync(join(upDir, only)).sort(), ['report.html', 'report.json', 'report.md']);
  rmSync(dd, { recursive: true, force: true });
});

test('T7.1/R7.1.3/R7.1.3a `smoke --mix` parses the mix map, defaults baseline to old-full, records mixed-bundle header', () => {
  const dd = mkdtempSync(join(tmpdir(), 'aiide-smoke-'));
  const out = cli(['upgrade', 'smoke', '--mix', 'onchain.swap=new,onchain.bridge=old', '--fixture', FX, '--data-dir', dd, '--intent', 'cost-opt']);
  assert.match(out, /mixed-bundle confirm smoke/);
  assert.match(out, /mix: onchain\.swap=new, onchain\.bridge=old/);
  assert.match(out, /comparator \(baseline arm\): old-full/);          // default baseline = old-full (PM-N1)
  assert.match(out, /升级推荐:/);
  const report = JSON.parse(readFileSync(join(dd, 'upgrades', readdirSync(join(dd, 'upgrades'))[0], 'report.json'), 'utf8'));
  assert.equal(report.header.mixedBundle, true);
  assert.equal(report.header.baselineArm.label, 'old-full');
  rmSync(dd, { recursive: true, force: true });
});

test('T7.1/R6.6.1 `upgrade preflight` fatal static gate → non-zero exit', () => {
  const dd = mkdtempSync(join(tmpdir(), 'aiide-pf-'));
  // clean bundle → ok, exit 0
  const ok = cli(['upgrade', 'preflight', '--fixture', FX]);
  assert.match(ok, /✓ ok/);
  // an over-long description → fatal → the CLI exits non-zero
  const badFx = join(dd, 'bad.js');
  writeFileSync(badFx, `export const gateSkills = [{ name: 'x', description: '${'z'.repeat(1100)}', triggers: [], shared: {} }];\n`);
  let code = 0;
  try { cli(['upgrade', 'preflight', '--fixture', badFx]); } catch (e) { code = e.status; }
  assert.equal(code, 1);
  rmSync(dd, { recursive: true, force: true });
});

test('T7.1 `upgrade lint` runs U1 dataset lints over a suite', () => {
  const dd = mkdtempSync(join(tmpdir(), 'aiide-lint-'));
  const suitePath = join(dd, 'suite.json');
  writeFileSync(suitePath, JSON.stringify({
    name: 'tiny', datasetVersion: 'v1',
    cases: [{ id: 'a1', prompt: 'p', expected_skill: 'sk', allowed_auxiliary: [], category: 'c', multi_intent: [], assertions: [{ type: 'regex', pattern: 'x' }], safety_negative: false, added_in: 'v1', tier: 'smoke' }],
  }));
  const out = cli(['upgrade', 'lint', '--suite', suitePath]);
  assert.match(out, /dataset lint \(U1\)/);
  rmSync(dd, { recursive: true, force: true });
});

// ── 优化机会一览（cross-section rollup + fusion honesty）─────────────────────────────────────────
test('opportunities: rollup aggregates depgraph/probes; fusion honesty rules', () => {
  const rep = fullReportCli();
  const ops = buildOpportunities(rep);
  assert.ok(ops.length >= 2, 'aggregates across at least two signal families');
  const kinds = new Set(ops.map((o) => o.kind));
  assert.ok(kinds.has('sink'), 'probe signals present');
  assert.ok(kinds.has('merge-file') || kinds.has('merge') || kinds.has('split'), 'depgraph signals present');
  // fusion honesty: 双证据 ONLY from cross-measurement joins — a probe knownCollapse annotation
  // is a declared guess, NOT independent evidence (2026-07-12 self-caught mislabel).
  const sink = ops.find((o) => o.kind === 'sink');
  assert.equal(sink.multi, false, 'knownCollapse annotation must not mark a sink op as dual-evidence');
  for (const o of ops) { assert.ok(o.section?.md && o.section?.html); assert.ok(o.evidence.length >= 1); }
  // md renders the rollup with section pointers
  const md = buildReportMd(rep);
  assert.match(md, /优化机会一览（共 \d+ 项/);
  assert.ok(md.indexOf('优化机会一览') < md.indexOf('## 2.'), 'rollup lives in section 1');
  // HTML mirror exists (browser-side derivation reading DATA only)
  const html = buildReportHtml(rep);
  assert.match(html, /function buildOpportunitiesJs\(/);
  assert.match(html, /优化机会一览/);
});

// ── F1 denominator golden (design §2.1 challenge-round decision) ────────────────────────────────
test('F1: flow-incomplete denominator counts ALL attempted reps INCLUDING excluded cases', () => {
  // The washing path this rule blocks: new arm turns conservative → halts → whole case excluded →
  // the signal vanishes from the survivor set. Fixture: 13 paired cases × 3 reps = 39 attempted
  // (incl. swap-excl-001's 3 excluded reps); 3 incomplete → 3/39 = 7.7%. The pre-2026-07-12 drift
  // used included-only (36) and read 8.3% — this golden pins the denominator forever.
  const r = fullReport();
  const fi = r.axes.flowIncomplete;
  assert.equal(fi.denomNew, 39, 'denominator = all attempted reps incl. excluded-case reps');
  assert.equal(fi.numNew, 3);
  assert.equal(fi.rateNew, 0.077);
  const md = buildReportMd(r);
  assert.match(md, /确认后中断率.*3\/39=7\.7%/);
  assert.match(md, /含被排除题的运行/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §B4 覆盖统计对比 (coverage delta) + §B2 机会 token 量化 — armStats 通道（resolveExpStats wrapper 形）
// ══════════════════════════════════════════════════════════════════════════════════════════════
const wrapStats = (stats) => ({ stats, statsAuthority: 'embedded', warnings: [] });
function mkV2Stats({ installed = ['sk'], triggerRate = [], neverTriggered = [], caseJoin = {}, refMeta = {} } = {}) {
  return { schemaVersion: 2,
    skillCoverage: { installed, everTriggered: [], triggerRate, neverTriggered, notExercised: [], caseJoin },
    refCoverage: { inventoryStatus: 'snapshot', bySkill: [], readCounts: {}, artifactOnlyRefs: [], excludedOnlyRefs: [], refMeta } };
}
const cjRows = (rows) => ({ cases: rows.map(([caseId, attempted, triggered, firedInstead]) =>
  ({ caseId, attempted, triggered, ...(triggered === 0 ? { firedInstead } : {}) })) });

// a full report wired with the fixture armStats (probes present → coverage becomes md chapter 9)
function fullReportCoverage() {
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  const dg = depgraphReport(depgraphSessions, { full: false, descBySkill });
  return buildReportJson({ comparison: cmp, depgraph: dg, probeBlocks: CLI_BLOCKS, armStats: ARM_STATS,
    meta: { armOld, armNew, intent: 'cost-opt', compareId: 'cov-id' } });
}

test('B4 coverage golden: per-skill delta pooled ONLY over the case-id intersection (Σtriggered/Σattempted)', () => {
  // 手工可验小例：old 有 f（new 缺）、new 有 g（old 缺）→ 两者都不进交集；交集 a..e：
  // old 4/5（e 落空）→ new 5/5 → delta = 100% − 80% = +20pp
  const old = mkV2Stats({ triggerRate: [{ skill: 'sk', triggered: 5, attempted: 6 }],
    caseJoin: { sk: cjRows([['a', 1, 1], ['b', 1, 1], ['c', 1, 1], ['d', 1, 1], ['e', 1, 0, []], ['f', 1, 1]]) } });
  const neu = mkV2Stats({ triggerRate: [{ skill: 'sk', triggered: 6, attempted: 6 }],
    caseJoin: { sk: cjRows([['a', 1, 1], ['b', 1, 1], ['c', 1, 1], ['d', 1, 1], ['e', 1, 1], ['g', 1, 1]]) } });
  const cov = buildCoverageSection({ old: wrapStats(old), new: wrapStats(neu) });
  assert.equal(cov.status, 'ok');
  assert.equal(cov.params.lowSample, UPGRADE_CONFIG.verdict.MIN_PAIRS_SKILL);   // 沿既有阈值，经 DATA 携带
  const row = cov.skills.find((s) => s.skill === 'sk');
  assert.equal(row.scope, 'intersection');
  assert.equal(row.intersectionCases, 5);                        // f（仅旧）与 g（仅新）不进交集
  assert.deepEqual(row.old, { triggered: 4, attempted: 5 });     // x/y 并列（交集口径，手工可验）
  assert.deepEqual(row.new, { triggered: 5, attempted: 5 });
  assert.equal(row.deltaPp, 20);                                 // 5/5 − 4/5 = +20pp
  assert.equal(row.deltaReason, null);
  assert.match(cov.method, /case-id 交集/);                      // 口径文字并列印出
  assert.match(cov.method, /Σtriggered\/Σattempted/);
});

test('B4 coverage golden (fixture armStats): swap rep-weighted +14.286pp; price low-sample → delta null with x/y', () => {
  const cov = buildCoverageSection(ARM_STATS);
  assert.equal(cov.status, 'ok');
  const swap = cov.skills.find((s) => s.skill === 'onchain.swap');
  assert.deepEqual(swap.old, { triggered: 6, attempted: 7 });    // swap-006 attempted=2 → rep 加权进 Σ
  assert.deepEqual(swap.new, { triggered: 7, attempted: 7 });
  assert.equal(swap.intersectionCases, 6);
  assert.equal(swap.deltaPp, 14.286);                            // 7/7 − 6/7，round3
  const price = cov.skills.find((s) => s.skill === 'onchain.price');
  assert.equal(price.intersectionCases, 3);                      // 新侧缺 price-004 → 交集 3 题
  assert.equal(price.deltaPp, null);                             // Σattempted 3 < lowSample 5
  assert.equal(price.deltaReason, 'low-sample');
  assert.deepEqual(price.old, { triggered: 3, attempted: 3 });   // delta null 仍并列两侧 x/y
  assert.deepEqual(price.new, { triggered: 2, attempted: 3 });
  // 掉出：仅两侧皆 installed 的共同 skill；连带 new arm 的 miss cases（caseJoin triggered=0 行）
  assert.deepEqual(cov.neverTriggered.droppedOut,
    [{ skill: 'onchain.bridge', missCases: [{ caseId: 'bridge-001', firedInstead: ['onchain.swap'] }] }]);
  // 单侧独有：caseJoin 侧（stake 仅存在于新版统计）与 installed 侧（legacy/stake）皆为信息行
  assert.deepEqual(cov.onlyIn, [{ skill: 'onchain.stake', arm: 'new' }]);
  assert.deepEqual(cov.neverTriggered.installedOnlyIn,
    [{ skill: 'onchain.legacy', arm: 'old' }, { skill: 'onchain.stake', arm: 'new' }]);
  // B2 通道：refMeta 取自 new arm 且明文标注
  assert.equal(cov.refMetaSource, 'new-arm');
  assert.equal(cov.refMeta['onchain.swap/references/dex.md'].tokensEst, 680);
});

test('B4 coverage: any arm without stats → unavailable + reason; report generation not blocked', () => {
  const covNone = buildCoverageSection(null);
  assert.equal(covNone.status, 'unavailable');
  assert.deepEqual(covNone.unavailableArms, ['old', 'new']);
  assert.equal(covNone.reason, COVERAGE_UNAVAILABLE_REASON);
  assert.match(covNone.reason, /无统计（legacy 实验，可用 aiide stats 回填后重生报告）/);
  // 单侧缺（resolver 给 stats:null）与 embedded {error} 都算无 stats
  const covHalf = buildCoverageSection({ old: { stats: null, statsAuthority: null, warnings: [] }, new: ARM_STATS.new });
  assert.equal(covHalf.status, 'unavailable');
  assert.deepEqual(covHalf.unavailableArms, ['old']);
  assert.deepEqual(covHalf.refMeta, ARM_STATS.new.stats.refCoverage.refMeta);   // B2 通道仍携带 new-arm refMeta
  const covErr = buildCoverageSection({ old: { stats: { error: 'boom' }, statsAuthority: null, warnings: [] }, new: ARM_STATS.new });
  assert.equal(covErr.status, 'unavailable');
  // 不挡报告生成：无 armStats 的报告照常出全形；coverage 节位于 probes 之后
  const r = fullReport();
  assert.equal(r.coverage.status, 'unavailable');
  const keys = Object.keys(r);
  assert.equal(keys.indexOf('coverage'), keys.indexOf('probes') + 1);
  const md = buildReportMd(r);
  assert.match(md, /## 8\. 覆盖统计对比/);                       // 无 probes 节 → 编号顺位 8
  assert.match(md, /无统计（legacy 实验，可用 aiide stats 回填后重生报告）/);
});

test('B4 coverage: one side without caseJoin (v1 stats) → delta null, x/y falls back to arm-total triggerRate', () => {
  const v1 = { schemaVersion: 1,
    skillCoverage: { installed: ['sk'], everTriggered: [], triggerRate: [{ skill: 'sk', triggered: 2, attempted: 4 }], neverTriggered: [], notExercised: [] },
    refCoverage: {} };
  const v2 = mkV2Stats({ triggerRate: [{ skill: 'sk', triggered: 5, attempted: 5 }], caseJoin: { sk: cjRows([['a', 1, 1]]) } });
  const cov = buildCoverageSection({ old: wrapStats(v1), new: wrapStats(v2) });
  const row = cov.skills.find((s) => s.skill === 'sk');
  assert.equal(row.scope, 'arm-total');
  assert.equal(row.deltaPp, null);                               // 任一侧 caseJoin 缺 → delta null
  assert.equal(row.deltaReason, 'no-case-join');
  assert.deepEqual(row.old, { triggered: 2, attempted: 4 });     // 并列两侧 x/y（triggerRate 全量口径）
  assert.deepEqual(row.new, { triggered: 5, attempted: 5 });
});

test('B4 coverage: 掉出 judged ONLY on both-side-installed common skills; single-side installs are info rows', () => {
  const old = mkV2Stats({ installed: ['both', 'common', 'oldonly'], neverTriggered: ['both'],
    triggerRate: [{ skill: 'common', triggered: 1, attempted: 1 }],
    caseJoin: { common: cjRows([['a', 1, 1]]) } });
  const neu = mkV2Stats({ installed: ['both', 'common', 'newonly'], neverTriggered: ['both', 'common', 'newonly'],
    triggerRate: [{ skill: 'common', triggered: 0, attempted: 1 }],
    caseJoin: { common: cjRows([['a', 1, 0, null]]) } });
  const cov = buildCoverageSection({ old: wrapStats(old), new: wrapStats(neu) });
  // both（两侧本来都没触发）不算掉出；newonly（单侧安装）不判掉出 → 只有 common
  assert.deepEqual(cov.neverTriggered.droppedOut.map((d) => d.skill), ['common']);
  // miss case 的 firedInstead=null（无 valid run，不可知）原样透传
  assert.deepEqual(cov.neverTriggered.droppedOut[0].missCases, [{ caseId: 'a', firedInstead: null }]);
  assert.deepEqual(cov.neverTriggered.installedOnlyIn,
    [{ skill: 'newonly', arm: 'new' }, { skill: 'oldonly', arm: 'old' }]);
});

test('B4 coverage report.md: chapter 9 after probes; x/y并列 + delta null wording + 掉出/单侧 info lines; zh-hans only', () => {
  const md = buildReportMd(fullReportCoverage());
  assert.match(md, /## 9\. 覆盖统计对比（两版触发覆盖 delta）/);   // probes 占 8 → 顺延 9
  assert.match(md, /onchain\.swap: 旧版 6\/7 → 新版 7\/7（交集 6 题）· 触发比例变化（triggerRate delta）: \+14\.286pp/);
  assert.match(md, /onchain\.price: 旧版 3\/3 → 新版 2\/3（交集 3 题）· 触发比例变化（triggerRate delta）: —（样本不足或无统计）/);
  assert.match(md, /⚠ 掉出：onchain\.bridge 旧版触发过、新版一次都没触发/);
  assert.match(md, /bridge-001: 实际触发了 onchain\.swap（firedInstead）/);
  assert.match(md, /onchain\.stake: 仅存在于新版的统计里（不进对比）/);
  assert.match(md, /onchain\.legacy: 仅安装于旧版（不判掉出）/);
  assert.match(md, /口径：delta 只在两版共同题目（case-id 交集）上合并计算/);   // 口径并列印出
  assert.match(md, /统计来源: 旧版 封存时计算（权威）（embedded） · 新版 封存时计算（权威）（embedded）/);
  // B2：机会一览的 merge-file 收益句带 ~N tokens（SKILL.md 400 + dex.md 680 = 1080，取自 new arm）
  assert.match(md, /不相干题型每次可少读 ~1080 tokens（估算，取自新版统计）/);
  // 繁体不得出现（新节沿全报告纪律）
  const TRAD = /[專並圖實層過獨顯類軸賴議員併駐節組觸發讀證據鑽環跡統較檢總數絆線預變採確認複書達結論遠決強轉請補後點該關與舊門單對種現語義檔訊號邊寬紅選標虧審終態細兩狀時長進離攜製質診斷僅參歸據應個來為這們麼樣業縮範聯試觀讓]/;
  const covSec = md.split('## 9. 覆盖统计对比')[1];
  assert.deepEqual([...new Set(covSec.match(new RegExp(TRAD, 'g')) ?? [])], [], 'coverage section leaked traditional chars');
});

test('B2 opportunities: refMeta bytes → ~N tokens sentence; bytes missing → qualitative unchanged; _shared never quantified', () => {
  const refMeta = { 'sk/references/a.md': { bytes: 400, tokensEst: 100 }, 'sk/references/b.md': { bytes: 800, tokensEst: 200 } };
  const mkRep = (signals, rm) => ({ depgraph: { signals }, probes: null, coverage: { refMeta: rm, refMetaSource: 'new-arm' } });
  // split：skill 明文路径前缀 join → Σ tokensEst；量化句明文标注取自新版
  const split = buildOpportunities(mkRep([{ kind: 'split', members: ['sk'], n: 5 }], refMeta)).find((o) => o.kind === 'split');
  assert.match(split.benefit, /不相干题型每次可少读 ~300 tokens（估算，取自新版统计）/);
  // inline：单 ref
  const inline = buildOpportunities(mkRep([{ kind: 'inline', ref: 'sk/references/a.md' }], refMeta)).find((o) => o.kind === 'inline');
  assert.match(inline.benefit, /~100 tokens/);
  // merge-file：成员 Σ
  const mf = buildOpportunities(mkRep([{ kind: 'merge-file', members: ['sk/references/a.md', 'sk/references/b.md'], coRead: 0.9, n: 5 }], refMeta)).find((o) => o.kind === 'merge-file');
  assert.match(mf.benefit, /~300 tokens/);
  // bytes 缺（refMeta null）→ 维持现行定性文案，绝不编数字
  const noMeta = buildOpportunities(mkRep([{ kind: 'split', members: ['sk'], n: 5 }], null)).find((o) => o.kind === 'split');
  assert.equal(noMeta.benefit, '按需加载省 token（不相干题不再读整包）');
  // 成员含 refMeta 缺项 → 整条不量化（不编数字）
  const partial = buildOpportunities(mkRep([{ kind: 'merge-file', members: ['sk/references/a.md', 'sk/SKILL.md'], coRead: 0.9, n: 5 }], refMeta)).find((o) => o.kind === 'merge-file');
  assert.ok(!partial.benefit.includes('~'), 'partially-known member set must not fabricate a number');
  // _shared 成员不量化（join 仅明文路径 key）
  const shared = buildOpportunities(mkRep([{ kind: 'inline', ref: '_shared/util.md#abc' }], refMeta)).find((o) => o.kind === 'inline');
  assert.equal(shared.benefit, '减少一次读取往返（内容并进 SKILL.md）');
});

test('B4 coverage: renderS8 EXECUTES in a browser-like sandbox with armStats DATA; Node-token blacklist covers new code', async () => {
  const { default: vm } = await import('node:vm');
  const html = buildReportHtml(fullReportCoverage());
  // Node-token 黑名单涵盖新代码（renderS8 / buildOpportunitiesJs 量化镜像都是浏览器端字面代码）
  for (const token of ['UPGRADE_CONFIG', 'require(', "from './", 'import {']) {
    assert.ok(!html.includes(token), `built HTML must not contain Node-only token: ${token}`);
  }
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const appScript = scripts[scripts.length - 1];
  assert.ok(appScript.includes('function renderS8('), 'app script block located');
  const dataMatch = html.match(/<script[^>]*id="report-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(dataMatch, 'report-data JSON block located');
  const elements = new Map();
  const mkEl = (id) => ({ id, style: {}, innerHTML: '', textContent: '', value: '',
    addEventListener() {}, appendChild() {}, setAttribute() {}, querySelectorAll: () => [],
    querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} });
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); };
  getEl('report-data').textContent = dataMatch[1];
  const documentStub = {
    getElementById: getEl,
    querySelectorAll: () => [], querySelector: () => null,
    createElement: () => mkEl('_created'),
    addEventListener() {}, body: mkEl('body'), documentElement: mkEl('html'),
  };
  const sandbox = {
    document: documentStub,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    echarts: { init: () => ({ setOption() {}, resize() {}, dispose() {}, on() {}, off() {} }) },
    console, setTimeout, clearTimeout, URL, Blob: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    location: { hash: '' }, history: { replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appScript, sandbox, { filename: 'report-app.js' });
  const s8 = elements.get('s8');
  assert.ok(s8, 's8 element was touched by the script');
  assert.ok(s8.innerHTML.length > 200, `S8 innerHTML non-trivial (got ${s8.innerHTML.length} chars)`);
  assert.ok(s8.innerHTML.includes('覆盖统计对比'), 'S8 contains the section copy');
  assert.ok(s8.innerHTML.includes('6/7'), 'S8 renders x/y ratios');
  assert.ok(s8.innerHTML.includes('—（样本不足或无统计）'), 'S8 renders the delta-null wording');
  assert.ok(s8.innerHTML.includes('掉出：onchain.bridge'), 'S8 renders the dropped-out card');
  // S1 机会一览走 buildOpportunitiesJs 镜像：量化句由 DATA.coverage.refMeta 驱动（纯 DATA，无 Node 常数）
  const s1 = elements.get('s1');
  assert.ok(s1.innerHTML.includes('每次可少读 ~1080 tokens'), 'S1 opportunities quantified from DATA.coverage.refMeta');
});

test('B4 coverage: unavailable state renders in HTML S8 (vm) without blocking the rest of the report', async () => {
  const { default: vm } = await import('node:vm');
  const html = buildReportHtml(fullReportCli());                  // no armStats → coverage unavailable
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const appScript = scripts[scripts.length - 1];
  const dataMatch = html.match(/<script[^>]*id="report-data"[^>]*>([\s\S]*?)<\/script>/);
  const elements = new Map();
  const mkEl = (id) => ({ id, style: {}, innerHTML: '', textContent: '', value: '',
    addEventListener() {}, appendChild() {}, setAttribute() {}, querySelectorAll: () => [],
    querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} });
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); };
  getEl('report-data').textContent = dataMatch[1];
  const documentStub = { getElementById: getEl, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => mkEl('_created'), addEventListener() {}, body: mkEl('body'), documentElement: mkEl('html') };
  const sandbox = {
    document: documentStub,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    echarts: { init: () => ({ setOption() {}, resize() {}, dispose() {}, on() {}, off() {} }) },
    console, setTimeout, clearTimeout, URL, Blob: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    location: { hash: '' }, history: { replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appScript, sandbox, { filename: 'report-app.js' });
  const s8 = elements.get('s8');
  assert.ok(s8.innerHTML.includes('无统计（legacy 实验，可用 aiide stats 回填后重生报告）'), 'unavailable reason rendered');
  assert.ok(elements.get('s7').innerHTML.length > 0, 'the rest of the report still renders');
});

test('B4 CLI: --arm-exp-old/--arm-exp-new resolve stats from dataDir (embedded + sidecar); flags win over fixture armStats', () => {
  const dd = mkdtempSync(join(tmpdir(), 'aiide-armexp-'));
  mkdirSync(join(dd, 'experiments'), { recursive: true });
  mkdirSync(join(dd, 'stats'), { recursive: true });
  // seed：old = embedded 权威；new = 无 embedded + sidecar wrapper（authority ∈ 封闭集）
  writeFileSync(join(dd, 'experiments', 'exp-old.json'), JSON.stringify({ id: 'exp-old', stats: ARM_STATS.old.stats }));
  writeFileSync(join(dd, 'experiments', 'exp-new.json'), JSON.stringify({ id: 'exp-new' }));
  writeFileSync(join(dd, 'stats', 'exp-new.json'), JSON.stringify({ expId: 'exp-new', authority: 'recomputed-no-embedded', warnings: ['backfilled'], stats: ARM_STATS.new.stats }));
  const out = cli(['upgrade', 'report', '--fixture', FX, '--data-dir', dd, '--arm-exp-old', 'exp-old', '--arm-exp-new', 'exp-new', '--format', 'json']);
  const rep = JSON.parse(out);
  assert.equal(rep.coverage.status, 'ok');
  assert.equal(rep.coverage.authority.old.statsAuthority, 'embedded');
  // 旗标胜 bundle 导出：fixture armStats 两侧都是 'embedded'，此处 new 侧读的是 dataDir sidecar
  assert.equal(rep.coverage.authority.new.statsAuthority, 'recomputed-no-embedded');
  assert.deepEqual(rep.coverage.authority.new.warnings, ['backfilled']);
  assert.equal(rep.coverage.skills.find((s) => s.skill === 'onchain.swap').deltaPp, 14.286);
  rmSync(dd, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// [adapter-observability Stage 5] — S8 provenance footer + 不可比规则（spec §2 F-2-21：恰一侧
// adapter-reported → 覆盖率家族 delta 一律不出数；null/缺栏与 harness-observed 同口径，legacy
// 不误伤）；S4 治理卡 provenanceMix 徽章；S7 proximity.axesOmitted 对应轴 n/a + reason。
// ══════════════════════════════════════════════════════════════════════════════════════════════

// stats maker with an optional provenance stamp（省略 = legacy 缺栏，保持 null-not-zero）
function provStats(rows, provenance) {
  const st = mkV2Stats({ triggerRate: [{ skill: 'sk', triggered: 5, attempted: 6 }],
    caseJoin: { sk: cjRows(rows) } });
  if (provenance !== undefined) st.provenance = provenance;
  return st;
}
const ROWS_OLD = [['a', 1, 1], ['b', 1, 1], ['c', 1, 1], ['d', 1, 1], ['e', 1, 0, []], ['f', 1, 1]]; // 5/6
const ROWS_NEW = [['a', 1, 1], ['b', 1, 1], ['c', 1, 1], ['d', 1, 1], ['e', 1, 1], ['f', 1, 1]];     // 6/6

test('S8 不可比规则: 恰一侧 adapter-reported → delta 不出数; harness↔harness / legacy(null)↔harness / adapter↔adapter 皆可比', () => {
  // ① adapter vs harness → 不可比：delta null + deltaReason='provenance-mismatch'，x/y 仍并列
  const mixed = buildCoverageSection({ old: wrapStats(provStats(ROWS_OLD, 'harness-observed')),
    new: wrapStats(provStats(ROWS_NEW, 'adapter-reported')) });
  assert.deepEqual(mixed.provenance, { old: 'harness-observed', new: 'adapter-reported' });
  assert.deepEqual(mixed.comparability,
    { comparable: false, reason: 'provenance-mismatch', note: '口径不同不可比（observed-tool vs adapter-reported）' });
  const mrow = mixed.skills.find((s) => s.skill === 'sk');
  assert.equal(mrow.deltaPp, null);
  assert.equal(mrow.deltaReason, 'provenance-mismatch');
  assert.deepEqual(mrow.old, { triggered: 5, attempted: 6 });   // 不可比仍诚实并列两侧 x/y
  assert.deepEqual(mrow.new, { triggered: 6, attempted: 6 });

  // ② harness vs harness → 可比（6/6 − 5/6 = +16.667pp）
  const hh = buildCoverageSection({ old: wrapStats(provStats(ROWS_OLD, 'harness-observed')),
    new: wrapStats(provStats(ROWS_NEW, 'harness-observed')) });
  assert.equal(hh.comparability.comparable, true);
  assert.equal(hh.skills[0].deltaPp, 16.667);

  // ③ legacy（无 provenance 栏）vs harness-observed → 同口径可比（F-2-21 金样本：legacy 不误伤）
  const legacy = buildCoverageSection({ old: wrapStats(provStats(ROWS_OLD)),
    new: wrapStats(provStats(ROWS_NEW, 'harness-observed')) });
  assert.equal(legacy.provenance.old, null);                     // 缺栏保持 null，不捏造
  assert.equal(legacy.comparability.comparable, true);
  assert.equal(legacy.skills[0].deltaPp, 16.667);

  // ④ adapter vs adapter → 两侧同口径（「恰一侧」规则不命中），可比
  const aa = buildCoverageSection({ old: wrapStats(provStats(ROWS_OLD, 'adapter-reported')),
    new: wrapStats(provStats(ROWS_NEW, 'adapter-reported')) });
  assert.equal(aa.comparability.comparable, true);
  assert.equal(aa.skills[0].deltaPp, 16.667);
});

test('S8 md: adapter 侧 footer「触发/读取信号由 runtime 自报（adapter-reported）」+ 不可比文案; harness/legacy 侧从简不加注', () => {
  const mkArm = (stats, prov) => { const s = JSON.parse(JSON.stringify(stats)); if (prov) s.provenance = prov; return wrapStats(s); };
  const armStats = { old: mkArm(ARM_STATS.old.stats), new: mkArm(ARM_STATS.new.stats, 'adapter-reported') };
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  const dg = depgraphReport(depgraphSessions, { full: false, descBySkill });
  const rep = buildReportJson({ comparison: cmp, depgraph: dg, probeBlocks: CLI_BLOCKS, armStats,
    meta: { armOld, armNew, intent: 'cost-opt', compareId: 'prov-md' } });
  assert.deepEqual(rep.coverage.provenance, { old: null, new: 'adapter-reported' });
  assert.equal(rep.coverage.comparability.comparable, false);    // legacy null vs adapter → 恰一侧
  const md = buildReportMd(rep);
  assert.match(md, /- 信号口径: 新版的触发\/读取信号由 runtime 自报（adapter-reported）/);
  assert.match(md, /⚠ 两侧口径不同不可比（observed-tool vs adapter-reported）——触发比例变化（triggerRate delta）一律不出数，仅并列两侧 x\/y/);
  // swap 行「不出数」：口径不同不可比取代 +14.286pp，x/y 仍并列
  assert.match(md, /onchain\.swap: 旧版 6\/7 → 新版 7\/7（交集 6 题）· 触发比例变化（triggerRate delta）: 口径不同不可比（observed-tool vs adapter-reported）/);
  assert.ok(!md.includes('+14.286pp'), 'provenance mismatch 时不得出 delta 数');
  // 反例：两侧皆 legacy（无 provenance 栏）→ 不加注、delta 照常（既有金样本口径不变）
  const mdLegacy = buildReportMd(fullReportCoverage());
  assert.ok(!mdLegacy.includes('信号口径'), 'legacy 两侧从简不加注');
  assert.ok(!mdLegacy.includes('口径不同不可比'), 'legacy 两侧不标不可比');
  assert.match(mdLegacy, /\+14\.286pp/);
});

test('S4 治理卡: provenanceMix.adapter>0 → md 徽章行（含 unknown 桶计数）; 全 unknown/harness → 不渲染', () => {
  // fixture sessions 本身无 provenance 栏 → 其余 8 条入 unknown（缺栏不混入任一信任桶）
  const adapterSessions = depgraphSessions.map((s, i) => (
    i === 0 ? { ...s, provenance: 'adapter-reported' } : i === 1 ? { ...s, provenance: 'harness-observed' } : s));
  const dg = depgraphReport(adapterSessions, { full: false, descBySkill });
  assert.deepEqual(dg.provenanceMix, { harness: 1, adapter: 1, unknown: 8 });
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  const rep = buildReportJson({ comparison: cmp, depgraph: dg,
    meta: { armOld, armNew, intent: 'cost-opt', compareId: 'pm-md' } });
  assert.deepEqual(rep.depgraph.provenanceMix, { harness: 1, adapter: 1, unknown: 8 });  // 经 depgraphToCharts 原样透传
  const md = buildReportMd(rep);
  assert.match(md, /本节拆\/合治理建议基于 runtime 自报信号（adapter-reported）——证据 session 口径构成: harness 1 · adapter 1 · unknown 8/);
  // 全非 adapter（fixture 原样 → unknown 10）→ 无徽章行
  const mdClean = buildReportMd(fullReport());
  assert.ok(!mdClean.includes('基于 runtime 自报信号'), '无 adapter session 不渲染徽章');
  // depgraph 输入缺 provenanceMix（legacy 报告再水化）→ null，不捏造全 0
  assert.equal(buildReportJson({ comparison: cmp, depgraph: { ...dg, provenanceMix: undefined },
    meta: { armOld, armNew, intent: 'cost-opt' } }).depgraph.provenanceMix, null);
});

test('S7 axesOmitted: proximityToCharts 透传 + md 对应轴 n/a + reason 文案; 无 topEdges 的 arm 仍渲染', () => {
  const OMIT = [{ axis: 'skill', reason: 'declared-events-have-no-ordinal' },
    { axis: 'ref', reason: 'declared-events-have-no-ordinal' }];
  assert.deepEqual(proximityToCharts({ edges: [], n: 0, axesOmitted: OMIT }).axesOmitted, OMIT);
  assert.deepEqual(proximityToCharts({ edges: [], n: 0 }).axesOmitted, []);   // 缺栏 → 空阵列（既有输入不受影响）
  const blocks = JSON.parse(JSON.stringify(CLI_BLOCKS));
  blocks.byArm[0].proximity = { edges: [], n: 0 };                            // old：无边亦无省略 → 不出 n/a 行
  blocks.byArm[1].proximity = { edges: [], n: 0, axesOmitted: OMIT };          // new：自报 arm，两轴皆无 ordinal
  const md = buildReportMd(fullReportCli({ probeBlocks: blocks }));
  assert.match(md, /### 8\.2 关联配对/);                                       // 无任何 topEdges 时小节仍存在（n/a 可见）
  assert.match(md, /new-full: skill 事件轴不可用（n\/a）——自报事件无真实调用序（declared-events-have-no-ordinal）/);
  assert.match(md, /new-full: ref 事件轴不可用（n\/a）——自报事件无真实调用序（declared-events-have-no-ordinal）/);
  assert.ok(!/old-full: (skill|ref) 事件轴不可用/.test(md), '未省略轴的 arm 不出 n/a 行');
});

test('[Stage 5] HTML vm e2e: S4 徽章 + S8 不可比/footer + S7 事件轴 n/a 全由 DATA 驱动; Node-token 黑名单涵盖新代码', async () => {
  const { default: vm } = await import('node:vm');
  const mkArm = (stats, prov) => { const s = JSON.parse(JSON.stringify(stats)); if (prov) s.provenance = prov; return wrapStats(s); };
  const armStats = { old: mkArm(ARM_STATS.old.stats, 'harness-observed'), new: mkArm(ARM_STATS.new.stats, 'adapter-reported') };
  const adapterSessions = depgraphSessions.map((s) => ({ ...s, provenance: 'adapter-reported' }));
  const dg = depgraphReport(adapterSessions, { full: false, descBySkill });
  const blocks = JSON.parse(JSON.stringify(CLI_BLOCKS));
  blocks.byArm[1].proximity = { edges: [], n: 0, axesOmitted: [{ axis: 'skill', reason: 'declared-events-have-no-ordinal' }] };
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  const rep = buildReportJson({ comparison: cmp, depgraph: dg, probeBlocks: blocks, armStats,
    meta: { armOld, armNew, intent: 'cost-opt', compareId: 'prov-html' } });
  const html = buildReportHtml(rep);
  // Node-token 黑名单（2026-07-11 事故防线）涵盖本波新增的浏览器端字面代码
  for (const token of ['UPGRADE_CONFIG', 'require(', "from './", 'import {']) {
    assert.ok(!html.includes(token), 'built HTML must not contain Node-only token: ' + token);
  }
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const appScript = scripts[scripts.length - 1];
  const dataMatch = html.match(/<script[^>]*id="report-data"[^>]*>([\s\S]*?)<\/script>/);
  const elements = new Map();
  const mkEl = (id) => ({ id, style: {}, innerHTML: '', textContent: '', value: '',
    addEventListener() {}, appendChild() {}, setAttribute() {}, querySelectorAll: () => [],
    querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} });
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); };
  getEl('report-data').textContent = dataMatch[1];
  const documentStub = { getElementById: getEl, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => mkEl('_created'), addEventListener() {}, body: mkEl('body'), documentElement: mkEl('html') };
  const sandbox = {
    document: documentStub,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    echarts: { init: () => ({ setOption() {}, resize() {}, dispose() {}, on() {}, off() {} }) },
    console, setTimeout, clearTimeout, URL, Blob: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    location: { hash: '' }, history: { replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appScript, sandbox, { filename: 'report-app.js' });
  const s4 = elements.get('s4');
  assert.ok(s4.innerHTML.includes('基于 runtime 自报信号（adapter-reported）'), 'S4 治理卡徽章');
  assert.ok(s4.innerHTML.includes('harness 0 · adapter 10 · unknown 0'), '徽章 tooltip 携带 mix 计数');
  const s8 = elements.get('s8');
  assert.ok(s8.innerHTML.includes('两侧口径不同不可比（observed-tool vs adapter-reported）'), 'S8 不可比横幅');
  assert.ok(s8.innerHTML.includes('信号口径：新版的触发/读取信号由 runtime 自报（adapter-reported）'), 'S8 footer 只标 adapter 侧');
  assert.ok(!s8.innerHTML.includes('旧版的触发/读取信号由 runtime 自报'), 'harness 侧从简不加注');
  assert.ok(!s8.innerHTML.includes('+14.286pp'), '不可比时 delta 数被抑制');
  const s7 = elements.get('s7');
  assert.ok(s7.innerHTML.includes('skill 事件轴不可用（n/a）——自报事件无真实调用序（declared-events-have-no-ordinal）'), 'S7 事件轴 n/a 文案');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// [wave 2 §4] S9 runtime 自述对比 (runtime_info diff) — 描述符 diff 与指标 delta 并列，绝不因果句
// ══════════════════════════════════════════════════════════════════════════════════════════════
const CAUSAL_WORDS = /导致|因此|因为|带来|提升了|使得|归因于/;

function fullReportRuntimeInfo(armRuntimeInfo = ARM_RUNTIME_INFO) {
  const cmp = buildComparison(armNew, armOld, { intent: 'cost-opt' });
  const dg = depgraphReport(depgraphSessions, { full: false, descBySkill });
  return buildReportJson({ comparison: cmp, depgraph: dg, probeBlocks: CLI_BLOCKS, armStats: ARM_STATS,
    armRuntimeInfo, meta: { armOld, armNew, intent: 'cost-opt', compareId: 'rt-id' } });
}

test('S9 runtime_info diff golden: sha changed + bytes/tokensEst Δ + tools add/remove + defaults change', () => {
  const s = buildRuntimeInfoSection(ARM_RUNTIME_INFO);
  assert.equal(s.status, 'ok');
  assert.deepEqual(s.missingArms, []);
  assert.equal(s.diff.version.old, '2.3.1');
  assert.equal(s.diff.version.new, '2.4.0');
  assert.equal(s.diff.version.changed, true);
  assert.equal(s.diff.systemPrompt.state, 'both');
  assert.equal(s.diff.systemPrompt.shaChanged, true);
  assert.equal(s.diff.systemPrompt.bytesDelta, 300);           // 5120 − 4820
  assert.equal(s.diff.systemPrompt.tokensEstDelta, 80);        // 1290 − 1210
  assert.equal(s.diff.systemPrompt.estimate, true);            // tokensEst 恒标 estimate
  assert.deepEqual(s.diff.tools.added, ['order_cancel']);
  assert.deepEqual(s.diff.tools.removed, ['order_legacy']);
  assert.equal(s.diff.tools.unknown, false);
  const maxTurns = s.diff.defaults.changes.find((c) => c.key === 'maxTurns');
  assert.deepEqual(maxTurns, { key: 'maxTurns', old: 30, new: 40 });
});

test('S9 runtime_info: one side missing → unavailable placeholder, never a fabricated diff', () => {
  const oneSided = buildRuntimeInfoSection({ old: ARM_RUNTIME_INFO.old, new: null });
  assert.equal(oneSided.status, 'unavailable');
  assert.equal(oneSided.diff, null);
  assert.deepEqual(oneSided.missingArms, ['new']);
  assert.equal(oneSided.missingNote, RUNTIME_INFO_ABSENT);
  const bothMissing = buildRuntimeInfoSection({ old: null, new: null });
  assert.equal(bothMissing.status, 'unavailable');
  assert.deepEqual(bothMissing.missingArms, ['old', 'new']);
  const noArg = buildRuntimeInfoSection(null);
  assert.equal(noArg.status, 'unavailable');
});

test('S9 runtime_info: tools/prompt null on one side → unknown/null, not a fake empty diff', () => {
  const s = buildRuntimeInfoSection({
    old: { name: 'x', version: '1', systemPrompt: null, tools: null, defaults: null },
    new: { name: 'x', version: '2', systemPrompt: { sha256: 'c'.repeat(64), bytes: 100, tokensEst: 25 }, tools: [{ name: 't', kind: 'mcp' }], defaults: null },
  });
  assert.equal(s.status, 'ok');
  assert.equal(s.diff.systemPrompt.state, 'one-absent');
  assert.equal(s.diff.systemPrompt.absentArm, 'old');
  assert.equal(s.diff.systemPrompt.shaChanged, null);          // 一侧缺 → 变否不可知
  assert.equal(s.diff.systemPrompt.bytesDelta, null);          // 绝不出数
  assert.equal(s.diff.tools.unknown, true);                    // old.tools null → 增删不可知
  assert.equal(s.diff.tools.added, null);
  assert.equal(s.diff.defaults.unknown, true);
});

test('S9 runtime_info: framing sentence present, NO causal attribution words anywhere in the section', () => {
  const s = buildRuntimeInfoSection(ARM_RUNTIME_INFO);
  assert.equal(s.framing, RUNTIME_INFO_FRAMING);
  assert.match(s.framing, /同期变更的环境因素（concurrent factors）/);
  assert.doesNotMatch(s.framing, CAUSAL_WORDS);
  assert.doesNotMatch(JSON.stringify(s), CAUSAL_WORDS, 'section JSON must carry no causal wording');
});

test('S9 runtime_info: md + HTML render the diff, pass Node-token guard, no causal words in visible text', () => {
  const r = fullReportRuntimeInfo();
  assert.equal(r.runtimeInfo.status, 'ok');
  const md = buildReportMd(r);
  assert.match(md, /运行时自述对比（runtime_info diff）/);
  assert.match(md, /order_cancel/);                            // 工具增删进 md
  const html = buildReportHtml(r);
  for (const token of ['UPGRADE_CONFIG', 'require(', "from './", 'import {']) {
    assert.ok(!html.includes(token), `built HTML must not contain Node-only token: ${token}`);
  }
  // causal ban is scoped to the runtime_info SECTION (other chapters legitimately use 因为 etc.);
  // the section-JSON + framing checks above already guard S9's data — assert the md chapter body too
  const s9Md = md.slice(md.indexOf('运行时自述对比')).split(/\n## /)[0];
  assert.doesNotMatch(s9Md, CAUSAL_WORDS, 'S9 md chapter must carry no causal wording');
});

test('S9 runtime_info: renderS9 EXECUTES in browser sandbox, produces non-empty diff content from DATA', async () => {
  const { default: vm } = await import('node:vm');
  const html = buildReportHtml(fullReportRuntimeInfo());
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const appScript = scripts[scripts.length - 1];
  assert.ok(appScript.includes('function renderS9('), 'renderS9 present in app script');
  const dataMatch = html.match(/<script[^>]*id="report-data"[^>]*>([\s\S]*?)<\/script>/);
  const elements = new Map();
  const mkEl = (id) => ({ id, style: {}, innerHTML: '', textContent: '', value: '',
    addEventListener() {}, appendChild() {}, setAttribute() {}, querySelectorAll: () => [],
    querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} });
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); };
  getEl('report-data').textContent = dataMatch[1];
  const documentStub = { getElementById: getEl, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => mkEl('_created'), addEventListener() {}, body: mkEl('body'), documentElement: mkEl('html') };
  const sandbox = {
    document: documentStub, window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    echarts: { init: () => ({ setOption() {}, resize() {}, dispose() {}, on() {}, off() {} }) },
    console, setTimeout, clearTimeout, URL, Blob: class {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(), location: { hash: '' }, history: { replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
    ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appScript, sandbox, { filename: 'report-app.js' });
  const s9 = elements.get('s9');                                // renderS9 writes to #s9 (data-section=s9_runtime)
  assert.ok(s9, 's9 element touched by script');
  assert.ok(s9.innerHTML.length > 100, `S9 innerHTML non-trivial (got ${s9.innerHTML.length})`);
  assert.ok(s9.innerHTML.includes('concurrent factors'), 'S9 framing rendered from DATA');
  assert.ok(s9.innerHTML.includes('order_cancel'), 'S9 tool-add rendered from DATA');
});
