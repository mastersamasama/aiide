// U1 · upgrade-u1-dataset-schema — case schema, canonical sha256, lineage + coverage lints.
// Requirements: .kiro/specs/upgrade-u1-dataset-schema/requirements.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadSuite, validateCase, validateSuiteCases,
  CASE_FIELD_CLASSIFICATION, canonicalJson, caseSha256,
  lintLineage, lintDanglingSuperseded, dedupeCheck, pairByIdIntersection,
  splitTiers, heldOut, lintSkillCoverage, lintMultiIntent, lintSmokeTierSize,
  lintAuxiliaryRedundancy, lintSuite,
} from '../src/suite.js';
import { UPGRADE_CONFIG } from '../src/upgradeConfig.js';

const TEMPLATE = fileURLToPath(new URL('./fixtures/upgrade-suite/case-template.jsonc', import.meta.url));

// A minimal fully-valid case; spread + override per test.
const baseCase = () => ({
  id: 'c1', prompt: 'What is ETH price?', expected_skill: 'okx-dex-market',
  allowed_auxiliary: [], category: 'price-query', multi_intent: [],
  assertions: [], safety_negative: false, added_in: 'v1',
});
const suiteOf = (...cases) => ({ name: 's', cases });

// ---- T1.1 · case schema validation (R1.1) --------------------------------------------------

test('T1.1 valid case round-trips through validateCase', () => {
  const c = baseCase();
  assert.equal(validateCase(c, 0), c);
});

test('T1.1 missing expected_skill → error names the field + case id (R1.1.4)', () => {
  const c = baseCase(); delete c.expected_skill;
  assert.throws(() => validateCase(c, 0), e => e.code === 'missing-field' && /c1/.test(e.message) && /expected_skill/.test(e.message));
});

test('T1.1 each required string field is enforced (R1.1.1)', () => {
  for (const f of ['id', 'prompt', 'expected_skill', 'category', 'added_in']) {
    const c = baseCase(); delete c[f];
    // dropping id still reports (as <no-id>); other fields report against the id.
    assert.throws(() => validateCase(c, 0), e => new RegExp(`"${f}"`).test(e.message), `missing ${f} should throw`);
  }
});

test('T1.1 wrong types on array/bool fields → error (R1.1.4)', () => {
  const bad = [
    { allowed_auxiliary: 'Write' }, { allowed_auxiliary: [1] },
    { multi_intent: 'x' }, { assertions: {} },
    { safety_negative: 'no' }, { held_out: 'yes' }, { tags: [1] },
    { tier: 'medium' }, { scripted_reply: 5 }, { superseded_by: 7 }, { note: 9 },
  ];
  for (const patch of bad) {
    const c = { ...baseCase(), ...patch };
    assert.throws(() => validateCase(c, 0), e => e.code === 'invalid-field', `${JSON.stringify(patch)} should throw`);
  }
});

test('T1.1 [TL-B2] must_confirm_before requires a scripted_reply (R1.1.2)', () => {
  const c = { ...baseCase(), must_confirm_before: { tools: ['Write'] } }; // no scripted_reply
  assert.throws(() => validateCase(c, 0), e => e.code === 'missing-scripted-reply');
  // with a scripted_reply it validates
  assert.ok(validateCase({ ...c, scripted_reply: 'ok' }, 0));
});

test('T1.1 [TL-B2] must_confirm_before.tools must be a non-empty string array', () => {
  const mk = tools => ({ ...baseCase(), scripted_reply: 'ok', must_confirm_before: { tools } });
  assert.throws(() => validateCase(mk('Write'), 0), e => e.code === 'invalid-field'); // not array
  assert.throws(() => validateCase(mk([]), 0), e => e.code === 'invalid-field');      // empty
  assert.throws(() => validateCase(mk([1]), 0), e => e.code === 'invalid-field');     // non-string
  assert.ok(validateCase(mk(['Write', 'Bash']), 0));
});

test('T1.1 must_confirm_before optional pathPattern/note typed; whole thing must be an object', () => {
  const ok = { ...baseCase(), scripted_reply: 'ok', must_confirm_before: { tools: ['Write'], pathPattern: 'out/.*', note: 'x' } };
  assert.ok(validateCase(ok, 0));
  assert.throws(() => validateCase({ ...ok, must_confirm_before: ['Write'] }, 0), e => e.code === 'invalid-field');
  assert.throws(() => validateCase({ ...baseCase(), scripted_reply: 'ok', must_confirm_before: { tools: ['Write'], pathPattern: 5 } }, 0), e => e.code === 'invalid-field');
});

test('T1.1 unknown top-level field → unclassified error (R1.2.2/R1.EB5)', () => {
  const c = { ...baseCase(), surprise: 1 };
  assert.throws(() => validateCase(c, 0), e => e.code === 'unclassified-field' && /surprise/.test(e.message));
});

test('T1.1 loadSuite validates cases; a classic task-suite (no cases) is untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'u1-'));
  try {
    // task-suite: no `cases` → passes through
    const taskPath = join(root, 'task.json');
    writeFileSync(taskPath, JSON.stringify({ name: 't', tasks: [{ id: 'x' }] }));
    assert.deepEqual(loadSuite(taskPath).tasks, [{ id: 'x' }]);
    // dataset with a bad case → loadSuite throws before returning (R1.1.4)
    const badPath = join(root, 'bad.json');
    const bad = baseCase(); delete bad.prompt;
    writeFileSync(badPath, JSON.stringify({ name: 'd', cases: [bad] }));
    assert.throws(() => loadSuite(badPath), e => /prompt/.test(e.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T1.1 duplicate case id rejected at load (R1.4.2)', () => {
  assert.throws(() => validateSuiteCases(suiteOf(baseCase(), baseCase())), e => e.code === 'duplicate-id');
});

// ---- T1.2 · per-case canonical sha256 (R1.2) -----------------------------------------------

test('T1.2 whitelist classifies every schema field explicitly (R1.2.1)', () => {
  // Every field validateCase accepts must have a classification (no silent passthrough).
  for (const f of ['prompt', 'expected_skill', 'allowed_auxiliary', 'assertions', 'multi_intent',
    'safety_negative', 'must_confirm_before', 'scripted_reply', 'category', 'id', 'added_in',
    'superseded_by', 'held_out', 'note', 'tags', 'tier']) {
    assert.ok(CASE_FIELD_CLASSIFICATION[f] === 'include' || CASE_FIELD_CLASSIFICATION[f] === 'exclude', `${f} classified`);
  }
});

test('T1.2 golden: canonical sha is stable & key-order independent (fixed input)', () => {
  const c = {
    id: 'golden-001', prompt: 'What is ETH price?', expected_skill: 'okx-dex-market',
    allowed_auxiliary: ['Write'], category: 'price-query', multi_intent: ['a', 'b'],
    assertions: [{ type: 'regex', pattern: 'x' }], safety_negative: false, added_in: 'v1',
    must_confirm_before: { tools: ['Write'], pathPattern: 'out/.*' }, scripted_reply: 'ok',
    held_out: true, tier: 'smoke', note: 'n', tags: ['t'], superseded_by: 'golden-002',
  };
  const GOLDEN = 'c5b05bbf3ce6802d2534b0e20f14200db9fddbb18288d00257e567f3c45ca36c';
  assert.equal(caseSha256(c), GOLDEN);
  const reordered = {}; for (const k of Object.keys(c).reverse()) reordered[k] = c[k];
  assert.equal(caseSha256(reordered), GOLDEN); // key order does not move the sha
});

test('T1.2 canonicalJson sorts object keys but preserves array order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]'); // array order is semantic
});

test('T1.2 changing a scoring field moves the sha (R1.2.1 include)', () => {
  const base = baseCase();
  const sha = caseSha256(base);
  for (const patch of [
    { prompt: 'different' },
    { allowed_auxiliary: ['Write'] },
    { category: 'other' },                                     // R1.EB4: category is include
    { must_confirm_before: { tools: ['Bash'] }, scripted_reply: 'ok' },
  ]) {
    assert.notEqual(caseSha256({ ...base, ...patch }), sha, `${JSON.stringify(patch)} should move sha`);
  }
});

test('T1.2 changing metadata does NOT move the sha (R1.2.1 exclude / R1.EB4)', () => {
  const base = baseCase();
  const sha = caseSha256(base);
  for (const patch of [
    { superseded_by: 'c2' }, { note: 'a note' }, { tags: ['x'] },
    { held_out: true },                                        // R1.EB4: held-out move keeps sha
    { tier: 'full' }, { added_in: 'v9' }, { id: 'renamed' },
  ]) {
    assert.equal(caseSha256({ ...base, ...patch }), sha, `${JSON.stringify(patch)} must keep sha`);
  }
});

test('T1.2 injecting an unclassified field → caseSha256 throws (R1.2.2/R1.EB5)', () => {
  assert.throws(() => caseSha256({ ...baseCase(), rogue: 1 }), e => e.code === 'unclassified-field' && /rogue/.test(e.message));
});

// ---- T1.3 · lineage / superset lint (R1.3) -------------------------------------------------

const v1 = () => suiteOf(
  { ...baseCase(), id: 'a', category: 'price-query' },
  { ...baseCase(), id: 'b', category: 'write-op' },
);

test('T1.3 v1→v2 superset (b unchanged + new c) passes', () => {
  const v2 = suiteOf(...v1().cases.map(c => ({ ...c })), { ...baseCase(), id: 'c' });
  const r = lintLineage(v1(), v2);
  assert.ok(r.ok);
  assert.equal(r.findings.length, 0);
});

test("T1.3 v1→v2' editing a shared case's prompt → content-changed error (R1.3.2)", () => {
  const v2 = suiteOf({ ...baseCase(), id: 'a', prompt: 'EDITED' }, { ...baseCase(), id: 'b', category: 'write-op' });
  const r = lintLineage(v1(), v2);
  assert.ok(!r.ok);
  const f = r.findings.find(x => x.code === 'content-changed');
  assert.equal(f.id, 'a');
  assert.match(f.message, /content changed \([0-9a-f]{8}→[0-9a-f]{8}\).*superseded_by/);
});

test("T1.3 v1→v2'' legal supersede path (old kept + marked, new id added) passes (R1.3.3)", () => {
  const v2 = suiteOf(
    { ...baseCase(), id: 'a', category: 'price-query', superseded_by: 'a2' }, // old untouched otherwise
    { ...baseCase(), id: 'b', category: 'write-op' },
    { ...baseCase(), id: 'a2', prompt: 'the fixed prompt' },                  // the replacement
  );
  const r = lintLineage(v1(), v2);
  assert.ok(r.ok, JSON.stringify(r.findings));
});

test("T1.3 v1→v2''' removing a case → not-superset error (R1.3.1/R1.EB3)", () => {
  const v2 = suiteOf({ ...baseCase(), id: 'a', category: 'price-query' }); // b dropped
  const r = lintLineage(v1(), v2);
  assert.ok(!r.ok);
  assert.ok(r.findings.some(f => f.code === 'not-superset' && f.id === 'b'));
});

test('T1.3 dangling superseded_by → error (R1.EB2)', () => {
  const s = suiteOf({ ...baseCase(), id: 'a', superseded_by: 'ghost' });
  assert.ok(lintDanglingSuperseded(s).some(f => f.code === 'dangling-superseded' && f.target === 'ghost'));
  // and lintLineage surfaces it against the new suite too
  assert.ok(!lintLineage(suiteOf(), s).ok);
});

// ---- T1.4 · id stability + intersection pairing (R1.4) -------------------------------------

test('T1.4 dedupeCheck flags duplicate ids (R1.4.2)', () => {
  const f = dedupeCheck(suiteOf({ ...baseCase(), id: 'x' }, { ...baseCase(), id: 'x' }));
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'duplicate-id');
});

test('T1.4 pairByIdIntersection returns shared ids only, sorted (R1.4.1)', () => {
  const armA = suiteOf({ ...baseCase(), id: 'b' }, { ...baseCase(), id: 'a' }, { ...baseCase(), id: 'c' });
  const armB = suiteOf({ ...baseCase(), id: 'c' }, { ...baseCase(), id: 'a' }, { ...baseCase(), id: 'd' });
  assert.deepEqual(pairByIdIntersection(armA, armB), ['a', 'c']);
  // also accepts raw id arrays (dataset shas need not be equal)
  assert.deepEqual(pairByIdIntersection(['a', 'b'], ['b', 'z']), ['b']);
});

// ---- T1.5 · tiers, held-out, coverage lints (R1.5-R1.8, R1.EB1) ----------------------------

test('T1.5 splitTiers partitions smoke/full; untagged → full (R1.5.1)', () => {
  const s = suiteOf(
    { ...baseCase(), id: 'a', tier: 'smoke' },
    { ...baseCase(), id: 'b', tier: 'full' },
    { ...baseCase(), id: 'c' }, // untagged
  );
  const { smoke, full } = splitTiers(s);
  assert.deepEqual(smoke.map(c => c.id), ['a']);
  assert.deepEqual(full.map(c => c.id), ['b', 'c']);
});

test('T1.5 heldOut filters held_out:true (R1.5.2)', () => {
  const s = suiteOf(
    { ...baseCase(), id: 'a', held_out: true },
    { ...baseCase(), id: 'b' },
    { ...baseCase(), id: 'c', held_out: true },
  );
  assert.deepEqual(heldOut(s).map(c => c.id), ['a', 'c']);
});

test('T1.5 lintSkillCoverage: a skill with 3 cases warns with needMore=2 [PM-B6]', () => {
  // MIN_PAIRS_SKILL is 5 in canonical config.
  assert.equal(UPGRADE_CONFIG.verdict.MIN_PAIRS_SKILL, 5);
  const cases = [];
  for (let i = 0; i < 3; i++) cases.push({ ...baseCase(), id: `s${i}`, expected_skill: 'sparse-skill' });
  const f = lintSkillCoverage(suiteOf(...cases)).find(x => x.skill === 'sparse-skill');
  assert.deepEqual(
    { code: f.code, currentN: f.currentN, target: f.target, needMore: f.needMore },
    { code: 'insufficient-coverage', currentN: 3, target: 5, needMore: 2 },
  );
});

test('T1.5 lintMultiIntent: 10% < 15% floor → warning [PM-B5]', () => {
  const cases = [];
  for (let i = 0; i < 10; i++) cases.push({ ...baseCase(), id: `m${i}`, multi_intent: i === 0 ? ['x', 'y'] : [] });
  const f = lintMultiIntent(suiteOf(...cases));
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'insufficient-multi-intent-coverage');
  assert.ok(Math.abs(f[0].pct - 0.1) < 1e-9 && f[0].floor === 0.15);
  // at/above the floor → no warning
  cases[1].multi_intent = ['a', 'b'];
  assert.equal(lintMultiIntent(suiteOf(...cases)).length, 0);
});

test('T1.5 lintSmokeTierSize: 15 smoke cases → outside [20,30] warning [PM-B7]', () => {
  const cases = [];
  for (let i = 0; i < 15; i++) cases.push({ ...baseCase(), id: `t${i}`, tier: 'smoke' });
  const f = lintSmokeTierSize(suiteOf(...cases));
  assert.equal(f.length, 1);
  assert.deepEqual({ code: f[0].code, n: f[0].n, min: f[0].min, max: f[0].max }, { code: 'smoke-tier-size', n: 15, min: 20, max: 30 });
});

test('T1.5 lintAuxiliaryRedundancy: allowed_auxiliary lists expected_skill → warning (R1.EB1)', () => {
  const s = suiteOf({ ...baseCase(), id: 'a', allowed_auxiliary: ['okx-dex-market'] }); // == expected_skill
  const f = lintAuxiliaryRedundancy(s);
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'redundant-auxiliary');
  // empty allowed_auxiliary stays clean (R1.EB1: empty is legal)
  assert.equal(lintAuxiliaryRedundancy(suiteOf(baseCase())).length, 0);
});

test('T1.5 annotated template fixture loads through loadSuite (R1.8.2)', () => {
  const suite = loadSuite(TEMPLATE);
  assert.equal(suite.cases.length, 2);
  assert.deepEqual(suite.cases.map(c => c.id), ['okx-price-basic-001', 'okx-price-write-001']);
  // the confirm-gate case in the template carries its required scripted_reply
  const gated = suite.cases.find(c => c.must_confirm_before);
  assert.ok(gated && typeof gated.scripted_reply === 'string' && gated.scripted_reply.length > 0);
});

test('T1.5 lintSuite aggregates single-suite findings', () => {
  const codes = new Set(lintSuite(loadSuite(TEMPLATE)).map(f => f.code));
  // template has 1 case per skill and 1 smoke case → coverage + smoke-tier warnings fire.
  assert.ok(codes.has('insufficient-coverage'));
  assert.ok(codes.has('smoke-tier-size'));
});
