import test from 'node:test';
import assert from 'node:assert/strict';
import { UPGRADE_CONFIG } from '../src/upgradeConfig.js';

test('UPGRADE_CONFIG is deeply frozen — writes throw in strict mode (R0.0.1)', () => {
  assert.ok(Object.isFrozen(UPGRADE_CONFIG));
  assert.throws(() => { UPGRADE_CONFIG.verdict.MIN_PAIRS = 1; }, TypeError);
  assert.throws(() => { UPGRADE_CONFIG.depgraph.hardExcludeSkills.push('x'); }, TypeError);
  assert.throws(() => { UPGRADE_CONFIG.tokenWeights.output = 1; }, TypeError);
});

test('UPGRADE_CONFIG key values match design §2.2/§2.3/§2.5 (R0.0.1)', () => {
  assert.deepEqual(UPGRADE_CONFIG.tokenWeights, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  assert.equal(UPGRADE_CONFIG.verdict.MIN_PAIRS, 8);
  assert.equal(UPGRADE_CONFIG.verdict.MIN_PAIRS_SKILL, 5);
  assert.equal(UPGRADE_CONFIG.verdict.nonInferiorityDeltaPp, 5);
  assert.equal(UPGRADE_CONFIG.verdict.bootstrapSeed, 0x9E3779B9);
  assert.equal(UPGRADE_CONFIG.exclusion.tripwirePct, 12);
  assert.equal(UPGRADE_CONFIG.concurrency.default, 6);
  assert.equal(UPGRADE_CONFIG.depgraph.coTriggerGraph, 0.50);
  assert.equal(UPGRADE_CONFIG.depgraph.jaccardSplit, 0.30);
  assert.equal(UPGRADE_CONFIG.staticGates.descMaxUnicode, 1024);
});

test('UPGRADE_CONFIG probes + proximity sections match design §2.1 and are frozen', () => {
  assert.deepEqual(UPGRADE_CONFIG.probes, {
    minSequenceCases: 3, ngramMaxLen: 3, minSessionsForCoverage: 5, blockExclusionTripwirePct: 12,
  });
  assert.deepEqual(UPGRADE_CONFIG.proximity, {
    windowOrdinals: 6, decay: '1/(1+gap)', minPairCases: 3,
  });
  assert.throws(() => { UPGRADE_CONFIG.probes.minSequenceCases = 1; }, TypeError);
  assert.throws(() => { UPGRADE_CONFIG.proximity.windowOrdinals = 1; }, TypeError);
});
