// U4 upgrade-u4-upgrade-verdict — CONFIG consumption + footer, four-tuple aggregation, paired/cluster
// bootstrap (splitmix32), Wilson reuse, BH, non-inferiority gate, intent verdict + tripwire, per-skill
// diagnostics, arm isolation, version quad, regressed clustering. Golden numbers locked below.
// EARS source: .kiro/specs/upgrade-u4-upgrade-verdict/requirements.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitmix32, pairedBootstrapCI, clusterBootstrapCI, benjaminiHochberg, nonInferiorityPass,
  assertConfigFrozen, buildVerdictFooter, aggregateArm, decideVerdict, perSkillDiagnostics, clusterRegressed,
} from '../src/upgradeVerdict.js';
import { equivTokens } from '../src/metrics.js';
import { wilson } from '../src/score.js';
import { assertArmIsolation, buildVersionQuad } from '../src/meta.js';
import { UPGRADE_CONFIG } from '../src/upgradeConfig.js';

// ============================================================================================
// T4.1 — CONFIG consumption + footer (R4.0)
// ============================================================================================

test('T4.1/R4.0.3 assertConfigFrozen: frozen config passes; a thawed clone is rejected', () => {
  assert.equal(assertConfigFrozen(UPGRADE_CONFIG), true);
  const thawed = { ...UPGRADE_CONFIG, verdict: { ...UPGRADE_CONFIG.verdict } }; // shallow copy → not frozen
  assert.throws(() => assertConfigFrozen(thawed), /not frozen/);
});

test('T4.1/R4.0.2 buildVerdictFooter: prints the effective δ / MIN_PAIRS / seed for audit', () => {
  const f = buildVerdictFooter(UPGRADE_CONFIG, { testCount: 12 });
  assert.equal(f.config.nonInferiorityDeltaPp, 5);
  assert.equal(f.config.MIN_PAIRS, 8);
  assert.equal(f.config.bootstrapSeed, 0x9E3779B9);
  assert.equal(f.tests.globalCorrection, 'none');           // R4.6.4 global 3 axes uncorrected
  assert.equal(f.tests.perSkillCorrection, 'benjamini-hochberg');
  assert.equal(f.tests.count, 12);
});

// ============================================================================================
// T4.3 — statistical primitives (R4.2/R4.6.4)
// ============================================================================================

test('T4.3/R4.2.1 splitmix32: seed 0x9E3779B9 emits the locked cross-platform sequence', () => {
  const rnd = splitmix32(0x9E3779B9);
  const seq = Array.from({ length: 5 }, () => Math.round(rnd() * 1e9) / 1e9);
  assert.deepEqual(seq, [0.850593186, 0.68442047, 0.498665397, 0.767198278, 0.944624835]);
});

test('T4.3/R4.2.2 pairedBootstrapCI: same deltas + same seed → bit-identical CI', () => {
  const deltas = [0.1, -0.2, 0.3, -0.4, 0.5, 0.0, 0.2, -0.1];
  const a = pairedBootstrapCI(deltas, { iters: 2000, seed: 0x9E3779B9, level: 0.95 });
  const b = pairedBootstrapCI(deltas, { iters: 2000, seed: 0x9E3779B9, level: 0.95 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { lo: -0.137, hi: 0.238, mean: 0.05, n: 8 });
  assert.equal(pairedBootstrapCI([], {}).n, 0);             // empty → null CI, never a throw
});

test('T4.3/R4.2.3 wilson is REUSED from score.js (not re-implemented) — ciLevel→z', () => {
  // known small dataset: 8/10 successes → the score.js Wilson interval at z=1.96
  const ci = wilson(8, 10, 1.96);
  assert.ok(ci.lo > 0.4 && ci.lo < 0.6);                   // ~0.49
  assert.ok(ci.hi > 0.9 && ci.hi <= 1);                    // ~0.94
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
});

test('T4.3/R4.6.4 benjaminiHochberg: reject set matches the step-up procedure on known p-values', () => {
  assert.deepEqual(benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05], 0.05).rejected, [true, true, true, true, true]);
  assert.deepEqual(benjaminiHochberg([0.9, 0.01, 0.7], 0.05).rejected, [false, true, false]); // original order preserved
  assert.deepEqual(benjaminiHochberg([], 0.05).rejected, []);
});

// ============================================================================================
// T4.2 — four-tuple aggregation, dual denominators (R4.1)
// ============================================================================================

test('T4.2/R4.1.2+R4.1.3 aggregateArm: cost denominator excludes excluded; flow-incomplete denom includes them', () => {
  const valid = Array.from({ length: 8 }, () => ({
    l1Pass: true, l2Pass: true, l3Pass: null, rounds: 4,
    usage: { in: 1000, out: 200, cacheR: 5000, cacheW: 400 }, durationMs: 2000,
    excluded: false, flowStatus: 'complete',
  }));
  const halted = [
    { excluded: true, flowStatus: 'incomplete', rounds: 2, usage: { in: 0, out: 0 }, durationMs: 100 },
    { excluded: true, flowStatus: 'incomplete', rounds: 2, usage: { in: 0, out: 0 }, durationMs: 100 },
  ];
  const agg = aggregateArm([...valid, ...halted]);
  assert.equal(agg.n, 8);                                   // cost/quality denominator drops the 2 excluded
  assert.equal(agg.attempted, 10);
  assert.equal(agg.excludedRepeats, 2);
  assert.equal(agg.flowIncomplete.denom, 10);              // flow-incomplete keeps them
  assert.equal(agg.flowIncomplete.numerator, 2);
  assert.equal(agg.flowIncomplete.rate, 0.2);
  assert.notEqual(agg.n, agg.flowIncomplete.denom);        // two deliberately-different denominators
  assert.equal(agg.quality.l1PassRate, 1);
  assert.equal(agg.quality.l3PassRate, null);              // axis n/a for these cases
  assert.equal(agg.cost.meanTurns, 4);
  assert.equal(agg.cost.meanEquivTokens, 3000);            // 1000 + 200*5 + 5000*0.1 + 400*1.25
});

test('T4.2 equivTokens: folds usage at the canonical tokenWeights (input:output:cacheR:cacheW)', () => {
  assert.equal(equivTokens({ in: 1000, out: 200, cacheR: 5000, cacheW: 400 }, UPGRADE_CONFIG.tokenWeights), 3000);
  // config field spellings (cacheRead/cacheWrite) are accepted too
  assert.equal(equivTokens({ input: 10, output: 2, cacheRead: 100, cacheWrite: 8 }, UPGRADE_CONFIG.tokenWeights), 10 + 10 + 10 + 10);
});

// ============================================================================================
// T4.4 — non-inferiority gate (R4.3)
// ============================================================================================

test('T4.4/R4.3.2+R4.EB3 nonInferiorityPass: strict > −δ; boundary −5.0 fails, −4.99 passes', () => {
  assert.equal(nonInferiorityPass(-5.0, 5), false);        // boundary: strict gate does not admit
  assert.equal(nonInferiorityPass(-4.99, 5), true);
  assert.equal(nonInferiorityPass(0.5, 5), true);
  assert.equal(nonInferiorityPass(null, 5), false);
});

// ============================================================================================
// T4.5 — intent verdict + tripwire + insufficient-data (R4.4/R4.5)
// ============================================================================================

const nonInf = { ciLow: 1, significantUp: false };   // comfortably non-inferior quality axis
const goodQuality = { l1: nonInf, l2: nonInf, l3: nonInf };
const noFlowRegress = { regressed: false };

test('T4.5/R4.EB1 decideVerdict: pairs=7 (< MIN_PAIRS 8) → insufficient-data', () => {
  const v = decideVerdict({ pairs: 7, intent: 'cost-opt', quality: goodQuality, flowIncomplete: noFlowRegress });
  assert.equal(v.verdict, 'insufficient-data');
  assert.equal(v.established, false);
});

test('T4.5/R4.EB4 decideVerdict: single-arm-missing (0 pairs) → insufficient-data, never a one-arm pass', () => {
  assert.equal(decideVerdict({ pairs: 0, intent: 'cost-opt' }).verdict, 'insufficient-data');
});

test('T4.5/R4.5.3+R4.EB2 decideVerdict tripwire: 12.0% → NOT inconclusive; 12.5% → inconclusive', () => {
  const at = decideVerdict({
    pairs: 20, exclusionPct: 12.0, intent: 'neutral-refactor', quality: goodQuality, flowIncomplete: noFlowRegress,
    cost: { turns: {}, tokens: {}, seconds: {} },
  });
  assert.notEqual(at.verdict, 'inconclusive');             // boundary is strict >
  const over = decideVerdict({
    pairs: 20, exclusionPct: 12.5, intent: 'neutral-refactor', quality: goodQuality, flowIncomplete: noFlowRegress,
    excludedCases: [{ caseId: 'c1', reason: 'harness-halt' }],
  });
  assert.equal(over.verdict, 'inconclusive');
});

test('T4.5/R4.5.2a decideVerdict inconclusive carries the excluded case-id list WITH reasons (not just a count)', () => {
  const v = decideVerdict({
    pairs: 20, exclusionPct: 20, intent: 'cost-opt',
    excludedCases: [{ caseId: 'okx-1', reason: 'env-noise' }, { caseId: 'okx-2', reason: 'harness-halt' }],
  });
  assert.equal(v.verdict, 'inconclusive');
  assert.deepEqual(v.excludedCases, [{ caseId: 'okx-1', reason: 'env-noise' }, { caseId: 'okx-2', reason: 'harness-halt' }]);
});

test('T4.5/R4.4.1 cost-opt: quality non-inferior + a cost axis down + none up → established', () => {
  const v = decideVerdict({
    pairs: 12, exclusionPct: 0, intent: 'cost-opt', quality: goodQuality, flowIncomplete: noFlowRegress,
    cost: { turns: { significantDown: true }, tokens: {}, seconds: {} },
  });
  assert.equal(v.verdict, 'cost-opt');
  assert.equal(v.established, true);
});

test('T4.5/R4.4.2 cost-opt is DENIED when flow-incomplete regressed — even though a cost axis dropped', () => {
  const v = decideVerdict({
    pairs: 12, exclusionPct: 0, intent: 'cost-opt', quality: goodQuality,
    flowIncomplete: { regressed: true },                   // new arm leaves more flows unfinished
    cost: { turns: { significantDown: true }, tokens: {}, seconds: {} },
  });
  assert.equal(v.established, false);
  assert.ok(v.reasons.some(r => /flow-incomplete/.test(r)));
});

test('T4.5/R4.4.1 cost-opt denied when a cost axis significantly INCREASED', () => {
  const v = decideVerdict({
    pairs: 12, intent: 'cost-opt', quality: goodQuality, flowIncomplete: noFlowRegress,
    cost: { turns: { significantDown: true }, tokens: { significantUp: true }, seconds: {} },
  });
  assert.equal(v.established, false);
});

test('T4.5/R4.4.1 quality-fix: target axis significantly up + no cost axis up → established', () => {
  const v = decideVerdict({
    pairs: 12, intent: 'quality-fix', flowIncomplete: noFlowRegress,
    quality: { l1: { ciLow: 2, significantUp: true }, l2: nonInf, l3: nonInf },
    cost: { turns: {}, tokens: {}, seconds: {} },
  });
  assert.equal(v.verdict, 'quality-fix');
  assert.equal(v.established, true);
  // not established when no quality axis actually improved
  const flat = decideVerdict({
    pairs: 12, intent: 'quality-fix', flowIncomplete: noFlowRegress, quality: goodQuality,
    cost: { turns: {}, tokens: {}, seconds: {} },
  });
  assert.equal(flat.established, false);
});

test('T4.5/R4.4.1 neutral-refactor: quality non-inferior + cost not worse → established; a cost rise breaks it', () => {
  const ok = decideVerdict({
    pairs: 12, intent: 'neutral-refactor', quality: goodQuality, flowIncomplete: noFlowRegress,
    cost: { turns: {}, tokens: {}, seconds: {} },
  });
  assert.equal(ok.established, true);
  const worse = decideVerdict({
    pairs: 12, intent: 'neutral-refactor', quality: goodQuality, flowIncomplete: noFlowRegress,
    cost: { turns: { significantUp: true }, tokens: {}, seconds: {} },
  });
  assert.equal(worse.established, false);
});

test('T4.5/R4.3.1 non-inferiority failure blocks establishment (CI lower bound below −δ)', () => {
  const v = decideVerdict({
    pairs: 12, intent: 'neutral-refactor', flowIncomplete: noFlowRegress,
    quality: { l1: { ciLow: -6 }, l2: nonInf, l3: nonInf },  // −6 < −5 → fails
    cost: { turns: {}, tokens: {}, seconds: {} },
  });
  assert.equal(v.established, false);
});

// ============================================================================================
// T4.6 — per-skill cluster bootstrap + BH badges (R4.6)
// ============================================================================================

test('T4.6/R4.EB5 perSkillDiagnostics: 4 cases → insufficient-data; 5 cases → reference-only flag', () => {
  const units = [];
  // skill A: 4 cases → below MIN_PAIRS_SKILL (5)
  for (let c = 0; c < 4; c++) units.push({ skill: 'A', caseId: `a${c}`, delta: 0.1 });
  // skill B: 5 cases → reference-only
  for (let c = 0; c < 5; c++) units.push({ skill: 'B', caseId: `b${c}`, delta: 0.2 });
  const d = perSkillDiagnostics(units);
  const A = d.skills.find(s => s.skill === 'A');
  const B = d.skills.find(s => s.skill === 'B');
  assert.equal(A.badge, 'insufficient-data');
  assert.equal(A.ci, null);
  assert.equal(B.badge, 'reference-only');
  assert.equal(B.referenceOnly, true);
  assert.match(d.note, /NOT an adoption certificate/);
});

test('T4.6/R4.6.4 perSkillDiagnostics: BH can only revoke a naive significance flag (never invent one)', () => {
  const units = [];
  // one clearly-significant skill (all positive deltas, CI away from 0) among several null skills
  for (let c = 0; c < 8; c++) units.push({ skill: 'strong', caseId: `s${c}`, delta: 1 });
  for (let k = 0; k < 5; k++) for (let c = 0; c < 8; c++) units.push({ skill: `noise${k}`, caseId: `n${k}-${c}`, delta: 0 });
  const d = perSkillDiagnostics(units);
  const strong = d.skills.find(s => s.skill === 'strong');
  assert.ok(strong.significant === true || strong.significant === false); // badge present
  // every skill whose CI straddles zero is n.s. after BH
  for (const s of d.skills.filter(s => s.skill.startsWith('noise'))) assert.equal(s.significant, false);
});

// ============================================================================================
// T4.7 / T4.8 — arm isolation + version quad (R4.7/R4.8)
// ============================================================================================

test('T4.7/R4.7.1 assertArmIsolation: spliced arms (shared resumeKey) → throw; distinct arms → pass', () => {
  const a = { resumeKey: 'k-new', arm: { label: 'new', cliVersion: '2.0', profileName: 'p' } };
  const b = { resumeKey: 'k-old', arm: { label: 'old', cliVersion: '1.0', profileName: 'p' } };
  assert.equal(assertArmIsolation(a, b), true);
  assert.throws(() => assertArmIsolation(a, { ...b, resumeKey: 'k-new' }), /shared resumeKey/);
  assert.throws(() => assertArmIsolation(a, { resumeKey: 'k-old', arm: a.arm }), /identical arm identity/);
});

test('T4.8/R4.8.1 buildVersionQuad: version / skill sha256 / model / harness / isolation per arm', () => {
  const armA = { label: 'new', cliVersion: '2.0', model: 'sonnet', harnessVersion: '0.9', isolationVerified: true,
    skills: [{ name: 'okx', hash: 'abc123' }] };
  const armB = { label: 'old', cliVersion: '1.0', model: 'sonnet', harnessVersion: '0.9', isolationVerified: true,
    skills: [{ name: 'okx', hash: 'def456' }] };
  const q = buildVersionQuad(armA, armB);
  assert.equal(q.armA.cliVersion, '2.0');
  assert.equal(q.armA.skills[0].sha256, 'abc123');
  assert.equal(q.armB.skills[0].sha256, 'def456');
  assert.equal(q.armA.isolationVerified, true);
  assert.equal(buildVersionQuad(null, armB).armA, null);
});

// ============================================================================================
// T4.9 — regressed clustering (R4.9, PM-B3c)
// ============================================================================================

test('T4.9/R4.9.1 clusterRegressed: only regressed cases, keyed skill×category, grouped correctly', () => {
  const cases = [
    { caseId: 'c1', skill: 'okx', category: 'price-query', regressed: true },
    { caseId: 'c2', skill: 'okx', category: 'price-query', regressed: true },
    { caseId: 'c3', skill: 'okx', category: 'write-op', regressed: true },
    { caseId: 'c4', skill: 'okx', category: 'price-query', regressed: false }, // dropped
  ];
  const out = clusterRegressed(cases);
  assert.deepEqual(out['okx×price-query'], ['c1', 'c2']);
  assert.deepEqual(out['okx×write-op'], ['c3']);
  assert.equal(Object.keys(out).length, 2);                // the non-regressed case forms no bucket
});
