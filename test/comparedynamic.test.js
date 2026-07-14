// Phase 2: dynamic compare report — build a full upgrade report from two sealed experiments without
// running `aiide upgrade`. experimentToArm bridges the experiment scorecard (C + Phase-1 l1/l3Pass)
// onto the upgrade arm shape; buildDynamicCompareReport runs buildComparison/buildReportJson verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { experimentToArm, buildDynamicCompareReport } from '../src/comparedynamic.js';

// synthetic sealed experiment: N tasks × 1 repeat, with the fields experimentToArm reads.
function mkExp(id, { nTasks = 2, C = 1, l1Pass = true, l3Pass = null, model = 'sonnet', aiideVersion = '0.1.0' } = {}) {
  const tasks = {};
  for (let i = 0; i < nTasks; i++) {
    tasks['t' + i] = {
      expected_skill: 'skill.a', category: 'cat', prompt: 'q' + i,
      repeats: [{
        runId: 'r', C, l1Pass, l3Pass, rounds: 3, excluded: false, flowStatus: 'complete',
        efficiency: { tokens: { in: 100, out: 50, cacheR: 10, cacheW: 5 }, durationMs: 2000, wallMs: 2100 },
      }],
    };
  }
  return { id, suiteName: 'suite-x', model, isolationVerified: true,
    environment: { aiideVersion, runtimeVersion: '2.0.0', skills: [{ name: 'skill.a', hash: 'abc' }] }, tasks };
}

test('experimentToArm: C→l2Pass, l1/l3 passthrough, efficiency→usage, version labels, held_out skipped', () => {
  const exp = mkExp('E', { C: 1, l1Pass: true, l3Pass: false });
  exp.tasks.held = { held_out: true, expected_skill: 'x', repeats: [{ C: 1 }] };
  const arm = experimentToArm(exp);
  assert.ok(!('held' in arm.cases), 'held_out task excluded from arm');
  const rep = arm.cases.t0.repeats[0];
  assert.equal(rep.l2Pass, true);        // C===1 → l2Pass
  assert.equal(rep.l1Pass, true);        // Phase-1 passthrough
  assert.equal(rep.l3Pass, false);
  assert.deepEqual(rep.usage, { in: 100, out: 50, cacheR: 10, cacheW: 5 }); // efficiency.tokens → usage
  assert.equal(rep.durationMs, 2000);
  assert.equal(arm.cliVersion, '0.1.0');   // environment.aiideVersion → cliVersion
  assert.equal(arm.harnessVersion, '2.0.0'); // environment.runtimeVersion → harnessVersion
  assert.equal(arm.model, 'sonnet');
});

test('experimentToArm: excluded repeat → l2Pass null (not a fake fail); missing l1/l3 → null', () => {
  const exp = mkExp('E', {});
  exp.tasks.t0.repeats[0] = { C: 0, excluded: true, efficiency: { tokens: {} } }; // no l1/l3 fields
  const rep = experimentToArm(exp).cases.t0.repeats[0];
  assert.equal(rep.l2Pass, null);  // excluded → null, never a fabricated 0
  assert.equal(rep.l1Pass, null);  // absent → null (n/a axis)
  assert.equal(rep.l3Pass, null);
  assert.equal(rep.excluded, true);
});

test('experimentToArm: skill-less runtime (env.skills empty) forces l1Pass null even if sealed false', () => {
  // an external/adapter runtime copies no skills → env.skills=[] → no Skill mechanism to route with.
  // older seals may carry l1Pass=false (graded "missed"); experimentToArm must fold those to n/a.
  const exp = mkExp('EXT', { C: 1, l1Pass: false });     // sealed as a routing "fail"
  exp.environment.skills = [];                            // ← skill-less runtime
  const rep = experimentToArm(exp).cases.t0.repeats[0];
  assert.equal(rep.l1Pass, null, 'skill-less runtime → L1 n/a, not a fabricated 0/false');
  assert.equal(rep.l2Pass, true, 'L2 (correctness) unaffected — still graded from C');
});

test('buildDynamicCompareReport: external-runtime arm → L1 routingApplicable.new=false, passNew null (no fake 0)', () => {
  const A = mkExp('A', { nTasks: 10, C: 1, l1Pass: true });          // claude-code arm (has skills)
  const B = mkExp('B', { nTasks: 10, C: 1, l1Pass: false });         // external arm sealed as routing-fail
  B.environment.skills = [];                                          // ← skill-less runtime
  const rep = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  assert.equal(rep.axes.quality.l1.routingApplicable.old, true);     // A has skills → applicable
  assert.equal(rep.axes.quality.l1.routingApplicable.new, false);    // B skill-less → n/a
  assert.equal(rep.axes.quality.l1.passNew, null, 'external arm L1 pass rate n/a, never 0%');
  assert.equal(rep.axes.quality.l1.deltaPp, null, 'no L1 delta drawn across a runtime that cannot route');
  assert.equal(rep.axes.quality.l2.passNew, 1, 'L2 (correctness) still comparable across runtimes');
});

test('buildDynamicCompareReport: <8 tasks → insufficient-data; dynamic flag; depgraph passthrough', () => {
  const A = mkExp('A', { nTasks: 2, C: 0 });
  const B = mkExp('B', { nTasks: 2, C: 1 });
  B.stats = { depgraph: { n: 5, graph: { nodes: [{ name: 'skill.a', trigger: 1 }], edges: [] }, heatmap: { refs: [], matrix: [] }, sankey: { nodes: [], links: [] } } };
  const rep = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  assert.equal(rep.dynamic, true);
  assert.equal(rep.verdict, 'insufficient-data'); // 2 pairs < MIN_PAIRS 8
  assert.equal(rep.pairs, 2);
  assert.equal(rep.depgraph.n, 5);                // reused B.stats.depgraph (Part D), not recomputed
  assert.equal(rep.axes.quality.l2.passNew, 1);   // L2 = correctness: B all-correct
  assert.equal(rep.axes.quality.l2.passOld, 0);   // A all-wrong
  assert.equal(rep.axes.quality.l1.n, 2);         // L1 present (l1Pass captured)
});

test('buildDynamicCompareReport: ≥8 paired tasks → a real (non-insufficient) verdict', () => {
  const A = mkExp('A', { nTasks: 10, C: 1, l1Pass: true });
  const B = mkExp('B', { nTasks: 10, C: 1, l1Pass: true });
  const rep = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  assert.equal(rep.pairs, 10);
  assert.notEqual(rep.verdict, 'insufficient-data'); // 10 ≥ 8 → decideVerdict gives a real verdict
});

// ─── Report-gap completion: S7 probes/proximity · S8 coverage · S9 runtime · S6 budget · S5 detail · S4 merge ───

// minimal sealed-stats shape that lights up S7 (probes+proximity) and S8 (coverage).
function statsWithCoverage() {
  return {
    probes: [{ tool: 'okx', warnings: [], coverage: { declared: 3, ratio: 0.5, invoked: ['a'] }, bySkill: [], sequences: [], excludedHits: [] }],
    proximity: { edges: [{ from: { type: 'skill', id: 'skill.a' }, to: { type: 'ref', id: 'r1' }, closeness: 0.8, confidence: 0.9, pairCases: 3, runs: 5 }], n: 5, axesOmitted: [] },
    skillCoverage: { installed: ['skill.a'], triggerRate: [{ skill: 'skill.a', triggered: 5, attempted: 10 }], caseJoin: {}, neverTriggered: [] },
    provenance: 'harness-observed',
  };
}

test('S7/S8/S9/S6: dynamic report wires proximity, coverage, runtime self-report, budget from sealed stats', () => {
  const A = mkExp('A', { nTasks: 10, C: 1 }), B = mkExp('B', { nTasks: 10, C: 1 });
  A.stats = statsWithCoverage(); B.stats = statsWithCoverage();
  const ri = { name: 'rt', version: '1.0', systemPrompt: { sha256: 'abcdef012345abcdef012345abcdef01', bytes: 100, tokensEst: 25 }, tools: ['Read'], defaults: {} };
  A.environment.runtimeInfo = ri; B.environment.runtimeInfo = ri;
  const rep = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  assert.equal(rep.probes.status, 'ok');
  assert.ok(rep.probes.arms.every((a) => a.proximity != null), 'S7 proximity charts wired per arm (was hardcoded null)');
  assert.equal(rep.coverage.status, 'ok', 'S8 coverage populated (was unavailable)');
  assert.equal(rep.runtimeInfo.status, 'ok', 'S9 runtime diff populated (both arms self-report)');
  assert.equal(rep.budget.actual.session, 20, 'S6 budget.actual sessions = total repeats across both arms');
  assert.ok(rep.budget.actual.hours > 0, 'S6 actual hours from real durationMs');
  assert.equal(rep.budget.est.session, null, 'S6 est stays honest-null (a live compare has no planned budget)');
});

test('S8 coverage stays unavailable when an arm has no stats (legacy) — honest, never fabricated', () => {
  const rep = buildDynamicCompareReport({ expA: mkExp('A', { nTasks: 10, C: 1 }), expB: mkExp('B', { nTasks: 10, C: 1 }), now: '2026-01-01T00:00:00Z' });
  assert.equal(rep.coverage.status, 'unavailable');
});

test('S5: experimentToArm attaches case triggerSet/readSet from depgraphSessions; regressed card shows the diff', () => {
  const A = mkExp('A', { nTasks: 10, C: 1 });   // old passes L2
  const B = mkExp('B', { nTasks: 10, C: 0 });   // new fails L2 → every paired case regressed
  const sessFor = (refs) => Object.keys(A.tasks).map((id) => ({ caseId: id, triggerSet: ['skill.a'], readSet: refs.map((r) => ({ logicalRef: r, refPath: r, skill: 'skill.a' })), provenance: 'harness-observed' }));
  A.stats = { depgraphSessions: sessFor(['refOld']) };
  B.stats = { depgraphSessions: sessFor(['refNew']) };
  const armA = experimentToArm(A);
  assert.deepEqual(armA.cases.t0.triggerSet, ['skill.a']);
  assert.equal(armA.cases.t0.readSet[0].logicalRef, 'refOld');
  assert.equal(armA.cases.t0.l2Result, 'pass');   // C=1
  const rep = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  const card = rep.regressedCards.flatMap((c) => c.cards)[0];
  assert.ok(card, 'at least one regressed card built');
  assert.deepEqual(card.armA.readSet, ['refOld']);
  assert.deepEqual(card.armB.readSet, ['refNew']);
  assert.deepEqual(card.readSetDiff.addedByNew, ['refNew']);
  assert.deepEqual(card.readSetDiff.removedByNew, ['refOld']);
});

test('S5: legacy stats without depgraphSessions → empty case detail (honest blank; top-level diff still renders)', () => {
  const arm = experimentToArm(mkExp('A', { nTasks: 10, C: 1 }));   // no stats
  assert.deepEqual(arm.cases.t0.triggerSet, []);
  assert.deepEqual(arm.cases.t0.readSet, []);
});

test('S6 trend: prevExps → report.diff.hasPrev with verdict/cost/regressed blocks; no prevExps → honest 无基准', () => {
  const mk = (id, C) => mkExp(id, { nTasks: 10, C });
  const prevA = mk('pA', 1), prevB = mk('pB', 1);   // previous pair: both arms correct (no regression)
  const A = mk('A', 1), B = mk('B', 0);             // current pair: new arm fails → cases regressed now
  const rep = buildDynamicCompareReport({ expA: A, expB: B, prevExps: { expA: prevA, expB: prevB }, now: '2026-01-01T00:00:00Z' });
  assert.equal(rep.diff.hasPrev, true, 'a prior pair makes S6 a real trend diff (not a stub)');
  assert.ok(rep.diff.verdictChange && 'changed' in rep.diff.verdictChange, 'verdict change block present');
  assert.ok(Array.isArray(rep.diff.axisDeltas), 'cost axis deltas present');
  assert.ok(Array.isArray(rep.diff.regressedCases.added), 'newly-regressed case ids present');
  const noPrev = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  assert.equal(noPrev.diff.hasPrev, false, 'no earlier pair → honest 无基准 (never fabricated)');
});

test('S4: both arms retain depgraphSessions → true pooled merge (n = |A|+|B|); one missing → single-arm fallback', () => {
  const A = mkExp('A', { nTasks: 10, C: 1 }), B = mkExp('B', { nTasks: 10, C: 1 });
  const sess = (ids, skill) => ids.map((id) => ({ caseId: id, triggerSet: [skill], readSet: [], provenance: 'harness-observed' }));
  A.stats = { depgraphSessions: sess(Object.keys(A.tasks), 'skill.a') };
  B.stats = { depgraphSessions: sess(Object.keys(B.tasks), 'skill.b') };
  const merged = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  assert.equal(merged.depgraph.merged, true, 'two-arm pooled merge flagged');
  assert.equal(merged.depgraph.n, 20, 'n = pooled session count across both arms');
  // one arm lacks sessions (legacy) → fall back to single-arm richer-of-two, no merged flag
  B.stats = { depgraph: { n: 1, graph: { nodes: [{ name: 'x' }], edges: [] }, sankey: { links: [] }, heatmap: { refs: [] } } };
  const fallback = buildDynamicCompareReport({ expA: A, expB: B, now: '2026-01-01T00:00:00Z' });
  assert.notEqual(fallback.depgraph.merged, true, 'fallback single-arm, not a fake merge');
});
