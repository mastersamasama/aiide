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
