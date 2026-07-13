// U5 dependency-graph ANALYSIS engine — golden-sample tests.
// Consumes ARRAYS of U2 session records ({ sessionId, category, triggerSet, readSet[] }).
// Records are built inline (the collector is covered by upgrade-depgraph.test.js); here we
// pin the analysis math: read rate boundaries, co-read non-dilution of _shared, co-trigger
// components + hard-exclude, Jaccard split gating, and break-even hand calculations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPGRADE_CONFIG } from '../src/upgradeConfig.js';
import {
  readRates, coReadPairs, coTriggerGraph, mergeMap, jaccardSplit, breakEven, depgraphReport,
} from '../src/depgraph.js';

const DIST_WARNING = '實驗分布 ≠ 生產分布';
const CFG = UPGRADE_CONFIG.depgraph;

// Build a session record. reads = array of { skill, ref, shared?, logicalRef? }.
function read(skill, ref, { shared = false, logicalRef = null } = {}) {
  return { skill, refPath: `${skill}/${ref}`, logicalRef: logicalRef ?? `${skill}/${ref}`, shared };
}
function sess(id, { category = null, triggers = [], reads = [] } = {}) {
  return {
    sessionId: id, category,
    primarySkill: triggers[0] ?? null, auxiliarySkills: triggers.slice(1),
    triggerSet: triggers, readSet: reads, permissionEvents: [],
  };
}

// ── T5.1 read rate boundaries (R5.1.1/R5.1.2, R5.EB5) ─────────────────────────
test('readRates: 0.60 → inline, 0.20 → external, 0.40 → gray-zone; each carries n (R5.EB5)', () => {
  // 10 sessions all trigger 'a'. ref-inline read in 6/10, ref-ext in 2/10, ref-gray in 4/10.
  const sessions = [];
  for (let i = 0; i < 10; i++) {
    const reads = [];
    if (i < 6) reads.push(read('a', 'ref-inline'));
    if (i < 2) reads.push(read('a', 'ref-ext'));
    if (i < 4) reads.push(read('a', 'ref-gray'));
    sessions.push(sess(`s${i}`, { triggers: ['a'], reads }));
  }
  const rates = readRates(sessions);
  const by = Object.fromEntries(rates.map((r) => [r.logicalRef, r]));

  assert.equal(by['a/ref-inline'].rate, 0.60);
  assert.equal(by['a/ref-inline'].advice, 'inline');       // ≥ 0.60 inclusive
  assert.equal(by['a/ref-inline'].n, 10);                  // denominator = sessions where 'a' triggered
  assert.equal(by['a/ref-ext'].rate, 0.20);
  assert.equal(by['a/ref-ext'].advice, 'external');        // ≤ 0.20 inclusive
  assert.equal(by['a/ref-gray'].rate, 0.40);
  assert.equal(by['a/ref-gray'].advice, 'gray-zone-section-split');
  for (const r of rates) { assert.equal(r.status, 'candidate'); assert.equal(r.note, DIST_WARNING); }
});

// ── T5.2 co-read merge + _shared non-dilution (R5.2.1/R5.2.2, R5.EB6) ──────────
test('coReadPairs: 8/10 co-read → merge candidate; 6/10 → not emitted', () => {
  const hi = [];
  for (let i = 0; i < 10; i++) {
    const reads = [read('a', 'x')];               // x read in all 10
    if (i < 8) reads.push(read('a', 'y'));         // y read in 8; both together in 8
    hi.push(sess(`s${i}`, { triggers: ['a'], reads }));
  }
  const pairsHi = coReadPairs(hi);
  assert.equal(pairsHi.length, 1);
  assert.deepEqual(pairsHi[0].refs, ['a/x', 'a/y']);
  assert.equal(pairsHi[0].rate, 0.80);
  assert.equal(pairsHi[0].n, 10);
  assert.equal(pairsHi[0].evidenceSessions.length, 8);
  assert.equal(pairsHi[0].status, 'candidate');
  assert.equal(pairsHi[0].note, DIST_WARNING);

  const lo = [];
  for (let i = 0; i < 10; i++) {
    const reads = [read('a', 'x')];
    if (i < 6) reads.push(read('a', 'y'));         // both together in only 6 → 0.60 < 0.80
    lo.push(sess(`s${i}`, { triggers: ['a'], reads }));
  }
  assert.equal(coReadPairs(lo).length, 0);
});

test('coReadPairs: two skills sharing identical _shared/util.md → ONE logical ref co-reads 0.80, not diluted to 0.40 (R5.EB6 [TL-M3])', () => {
  const UTIL_SAME = '_shared/util.md#SAME';
  const ANCHOR = '_shared/anchor.md#ANC';
  // Normalized: alpha (s0-3) and beta (s4-7) read the SAME-md5 util copy → one logicalRef.
  const norm = [];
  for (let i = 0; i < 10; i++) {
    const skill = i < 4 ? 'alpha' : 'beta';
    const reads = [read(skill, '_shared/anchor.md', { shared: true, logicalRef: ANCHOR })];
    if (i < 8) reads.push(read(skill, '_shared/util.md', { shared: true, logicalRef: UTIL_SAME }));
    norm.push(sess(`n${i}`, { triggers: [skill], reads }));
  }
  const normPairs = coReadPairs(norm);
  const utilPair = normPairs.find((p) => p.refs.includes(UTIL_SAME));
  assert.ok(utilPair, 'normalized shared util co-reads with anchor');
  assert.equal(utilPair.rate, 0.80); // 8/10, NOT diluted

  // Drifted / un-normalized: alpha copy (#A) vs beta copy (#B) are two logical refs, each
  // co-read only 4/10 = 0.40 with anchor → no merge candidate (the dilution U2 prevents).
  const drift = [];
  for (let i = 0; i < 10; i++) {
    const skill = i < 4 ? 'alpha' : 'beta';
    const md5 = i < 4 ? '#A' : '#B';
    const reads = [read(skill, '_shared/anchor.md', { shared: true, logicalRef: ANCHOR })];
    if (i < 8) reads.push(read(skill, '_shared/util.md', { shared: true, logicalRef: `_shared/util.md${md5}` }));
    drift.push(sess(`d${i}`, { triggers: [skill], reads }));
  }
  const driftPairs = coReadPairs(drift);
  assert.ok(!driftPairs.some((p) => p.refs.some((r) => r.startsWith('_shared/util.md'))),
    'split copies each land at 0.40 < 0.80 → no util merge candidate');
});

// ── T5.3 co-trigger graph + merge-map (R5.3.1/R5.3.2/R5.3.3, R5.EB4) ───────────
test('coTriggerGraph + mergeMap: connected component via a shared node; hard-excluded safety skill never enters merge-map (R5.EB4)', () => {
  // a-b co-trigger 5/10, b-c 5/10 → {a,b,c} connected via b (a,c never co-trigger directly).
  // sec co-triggers a & b at 5/10 (edge exists) but is hard-excluded → must not appear.
  // d appears once, isolated → singleton, not a merge candidate.
  const triggerSets = [
    ['a', 'b', 'sec'], ['a', 'b', 'sec'], ['a', 'b', 'sec'], ['a', 'b', 'sec'], ['a', 'b', 'sec'],
    ['b', 'c'], ['b', 'c'], ['b', 'c'], ['b', 'c'], ['b', 'c', 'd'],
  ];
  const sessions = triggerSets.map((t, i) => sess(`s${i}`, { triggers: t }));
  const graph = coTriggerGraph(sessions);

  assert.equal(graph.n, 10);
  const edgeKey = (e) => e.skills.join('-');
  const edges = graph.edges.map(edgeKey);
  assert.ok(edges.includes('a-b'), 'a-b edge at 0.50');
  assert.ok(edges.includes('b-c'), 'b-c edge at 0.50');
  assert.ok(edges.includes('a-sec') || edges.includes('sec-a'), 'sec has a high co-trigger edge in the raw graph');
  assert.equal(graph.edges.find((e) => e.skills.join('-') === 'a-b').rate, 0.50);

  const cfg = { ...CFG, hardExcludeSkills: ['sec'] };
  const merges = mergeMap(graph, { cfg });
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].members, ['a', 'b', 'c']); // connected via b
  assert.ok(!merges[0].members.includes('sec'), 'excluded safety skill absent (R5.3.3)');
  assert.ok(!merges[0].members.includes('d'), 'isolated singleton not a merge candidate');
  assert.equal(merges[0].status, 'candidate');
  assert.equal(merges[0].note, DIST_WARNING);
});

// ── T5.4 Jaccard split + statistical gate (R5.4.*, R5.EB1/EB2/EB3) ─────────────
test('jaccardSplit: two categories reading disjoint ref sets → split candidate with per-category refs', () => {
  const sessions = [];
  for (let i = 0; i < 5; i++)
    sessions.push(sess(`x${i}`, { category: 'x', triggers: ['s'], reads: [read('s', 'r1'), read('s', 'r2')] }));
  for (let i = 0; i < 5; i++)
    sessions.push(sess(`y${i}`, { category: 'y', triggers: ['s'], reads: [read('s', 'r3'), read('s', 'r4')] }));
  const res = jaccardSplit('s', sessions, { full: true });
  assert.equal(res.status, 'split-candidate');
  assert.equal(res.meanJaccard, 0);          // {r1,r2} vs {r3,r4} disjoint
  assert.equal(res.n, 10);
  assert.equal(res.categories.length, 2);
  assert.deepEqual(res.suggestedSplit.map((c) => c.category).sort(), ['x', 'y']);
  assert.equal(res.note, DIST_WARNING);
});

test('jaccardSplit gate: single category → insufficient-data, never a false split (R5.EB1/R5.4.4)', () => {
  const sessions = [];
  for (let i = 0; i < 10; i++)
    sessions.push(sess(`x${i}`, { category: 'x', triggers: ['s'], reads: [read('s', 'r1')] }));
  const res = jaccardSplit('s', sessions, { full: true });
  assert.equal(res.status, 'insufficient-data');
  assert.equal(res.reason, 'too-few-categories');
  assert.equal(res.meanJaccard, null);
  assert.equal(res.n, 10);
});

test('jaccardSplit gate: a category with < 5 effective sessions → insufficient-data (R5.EB2)', () => {
  const sessions = [];
  for (let i = 0; i < 4; i++)
    sessions.push(sess(`x${i}`, { category: 'x', triggers: ['s'], reads: [read('s', 'r1')] }));
  for (let i = 0; i < 6; i++)
    sessions.push(sess(`y${i}`, { category: 'y', triggers: ['s'], reads: [read('s', 'r3')] }));
  const res = jaccardSplit('s', sessions, { full: true });
  assert.equal(res.status, 'insufficient-data');
  assert.equal(res.reason, 'too-few-sessions-per-category');
});

test('jaccardSplit gate: smoke set never emits a split decision (R5.EB3/R5.4.3)', () => {
  const sessions = [];
  for (let i = 0; i < 5; i++)
    sessions.push(sess(`x${i}`, { category: 'x', triggers: ['s'], reads: [read('s', 'r1')] }));
  for (let i = 0; i < 5; i++)
    sessions.push(sess(`y${i}`, { category: 'y', triggers: ['s'], reads: [read('s', 'r3')] }));
  const res = jaccardSplit('s', sessions, { full: false });
  assert.equal(res.status, 'insufficient-data');
  assert.equal(res.reason, 'smoke-set');
});

// ── T5.5 break-even hand calc (R5.5.1/R5.5.2) ─────────────────────────────────
test('breakEven: resident savings and inflation ceiling match hand calculation; all substituted values echoed (PM-B4)', () => {
  const be = breakEven([400, 500, 300], 600, 0.5);
  assert.equal(be.sumMemberDesc, 1200);
  assert.equal(be.mergedDescEst, 600);
  assert.equal(be.breakEvenDivisor, 4);
  assert.equal(be.residentSavings, 150);       // (1200 - 600) / 4
  assert.equal(be.pTrigger, 0.5);
  assert.equal(be.inflationCeiling, 300);       // 150 / 0.5
  assert.equal(be.note, DIST_WARNING);

  const guarded = breakEven([400, 500, 300], 600, 0);
  assert.equal(guarded.inflationCeiling, null); // pTrigger 0 → no divide blow-up
});

// ── T5.6 honest annotation + U7 aggregate (R5.6.1/R5.6.2) ─────────────────────
test('depgraphReport: bundles every signal, carries the fixed disclaimer, and drops split decisions on the smoke set', () => {
  const sessions = [];
  for (let i = 0; i < 10; i++)
    sessions.push(sess(`s${i}`, { category: i < 5 ? 'x' : 'y', triggers: ['a'], reads: [read('a', 'r1')] }));

  const full = depgraphReport(sessions, { full: true });
  assert.equal(full.disclaimer, DIST_WARNING);
  assert.equal(full.n, 10);
  assert.ok(Array.isArray(full.readRates) && full.readRates.length > 0);
  assert.ok(Array.isArray(full.jaccardSplit) && full.jaccardSplit.length === 1); // one skill 'a'

  const smoke = depgraphReport(sessions, { full: false });
  assert.deepEqual(smoke.jaccardSplit, []); // R5.4.3: no split/merge decisions on smoke
  assert.ok(Array.isArray(smoke.readRates));
});

// ── [adapter-observability Stage 5] provenanceMix（治理卡徽章的机械接线点，spec §2 F-3-07）──
test('depgraphReport: provenanceMix counts harness/adapter by the provenance field; missing field → unknown bucket (never a trust bucket)', () => {
  const sessions = [
    { ...sess('h1', { triggers: ['a'] }), provenance: 'harness-observed' },
    { ...sess('h2', { triggers: ['a'] }), provenance: 'harness-observed' },
    { ...sess('a1', { triggers: ['a'] }), provenance: 'adapter-reported' },
    sess('u1', { triggers: ['a'] }),                        // legacy record: no provenance 栏
    { ...sess('u2', { triggers: ['a'] }), provenance: null }, // explicit null — 同样不可知
  ];
  const rep = depgraphReport(sessions, { full: false });
  assert.deepEqual(rep.provenanceMix, { harness: 2, adapter: 1, unknown: 2 });
  // 全 harness 池 → adapter 0（下游徽章不渲染的门）
  const clean = depgraphReport(sessions.slice(0, 2), { full: false });
  assert.deepEqual(clean.provenanceMix, { harness: 2, adapter: 0, unknown: 0 });
  // 空池 → 全 0（不是 null：计数分母是 sessions 自身，长度可知）
  assert.deepEqual(depgraphReport([], { full: false }).provenanceMix, { harness: 0, adapter: 0, unknown: 0 });
});
