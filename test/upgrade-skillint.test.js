// U6 static gates — golden-sample tests. Generic (no onchainos coupling), zero token.
// Pins: desc length by Unicode code point (not bytes) with an inclusive 1024 boundary,
// deterministic trigger collision, _shared md5 drift, generic tax table, and fail-fast
// aggregation where an error coexists with a warning still in the report (R6.EB4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPGRADE_CONFIG } from '../src/upgradeConfig.js';
import {
  descLint, triggerCollision, sharedDrift, taxTable, declaredVersionCheck, runStaticGates,
} from '../src/skillint.js';

// ── R6.1 desc length: Unicode code points, inclusive boundary (R6.1.2/R6.1.3, R6.EB1) ──
test('descLint: exactly 1024 CJK code points passes, 1025 errors; count is code points, not bytes', () => {
  const cjk1024 = '測'.repeat(1024);
  const cjk1025 = '測'.repeat(1025);
  // Sanity: these CJK chars are 3 bytes each in UTF-8, so a byte-based gate would misfire.
  assert.equal(Buffer.byteLength(cjk1024, 'utf8'), 3072);
  assert.ok(Buffer.byteLength(cjk1024, 'utf8') > UPGRADE_CONFIG.staticGates.descMaxUnicode);

  assert.equal(descLint({ name: 'ok', description: cjk1024 }), null); // 1024 ≤ limit → pass
  const err = descLint({ name: 'toolong', description: cjk1025 });
  assert.ok(err, '1025 code points → error');
  assert.equal(err.level, 'error');
  assert.equal(err.skill, 'toolong');
  assert.equal(err.chars, 1025); // code-point count, not the 3075-byte length
  assert.equal(err.limit, 1024);
});

test('descLint: an astral-plane (surrogate-pair) char counts as ONE code point, not two', () => {
  // 512 emoji = 512 code points but 1024 UTF-16 code units — a .length-based gate would fail it.
  const emoji = '😀'.repeat(512);
  assert.equal(emoji.length, 1024);           // UTF-16 code units
  assert.equal([...emoji].length, 512);       // code points
  assert.equal(descLint({ name: 'e', description: emoji }), null);
});

// ── R6.2 trigger collision: deterministic string match (R6.2.1/R6.2.2, R6.EB2) ──
test('triggerCollision: overlapping trigger words warn with the colliding term + skills; no overlap → no warning', () => {
  const skills = [
    { name: 'alpha', triggers: ['scan token', 'Arbitrage'] },
    { name: 'beta', triggers: ['arbitrage', 'bridge'] }, // "arbitrage" collides case-insensitively
    { name: 'gamma', triggers: ['unrelated'] },
  ];
  const warns = triggerCollision(skills);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].term, 'arbitrage');
  assert.deepEqual(warns[0].skills, ['alpha', 'beta']);
  assert.equal(warns[0].level, 'warning');

  // R6.EB2: disjoint trigger sets → no false positive.
  assert.deepEqual(triggerCollision([
    { name: 'a', triggers: ['one'] }, { name: 'b', triggers: ['two'] },
  ]), []);
});

// ── R6.3 _shared md5 drift (R6.3.1, R6.EB3) ──────────────────────────────────
test('sharedDrift: same _shared path with different content across skills → drift warning with each md5; identical → none', () => {
  const drifted = sharedDrift([
    { name: 'alpha', shared: { 'util.md': 'shared body' } },
    { name: 'beta', shared: { 'util.md': 'shared body EDITED' } },
  ]);
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].path, 'util.md');
  assert.equal(drifted[0].variants.length, 2);
  assert.equal(new Set(drifted[0].variants.map((v) => v.md5)).size, 2); // md5s differ

  // R6.EB3: byte-identical copies → no warning.
  assert.deepEqual(sharedDrift([
    { name: 'alpha', shared: { 'util.md': 'same' } },
    { name: 'beta', shared: { 'util.md': 'same' } },
  ]), []);
});

// ── R6.4 fixed tax table: generic, structured (R6.4.1/R6.4.2) ────────────────
test('taxTable: generic per-skill fixed-overhead summary with desc code points, trigger/shared counts, and desc tax tokens', () => {
  const table = taxTable([
    { name: 'alpha', description: '測'.repeat(16), triggers: ['t1', 't2'], shared: { 'util.md': 'x' } },
  ]);
  assert.equal(table.length, 1);
  const row = table[0];
  assert.deepEqual(Object.keys(row).sort(), ['descChars', 'descTaxTokens', 'sharedRefs', 'skill', 'triggerCount']);
  assert.equal(row.descChars, 16);            // code points
  assert.equal(row.triggerCount, 2);
  assert.equal(row.sharedRefs, 1);
  assert.equal(row.descTaxTokens, 4);         // ceil(16 / 4)
  // generic: no onchainos-specific keys
  assert.ok(!Object.keys(row).some((k) => /onchain|route|arm/i.test(k)));
});

// ── R6.5 declared-version + R6.6 fail-fast aggregation (R6.EB4) ──────────────
test('declaredVersionCheck: differing arm versions error unless expectedDifferent', () => {
  assert.equal(declaredVersionCheck([{ arm: 'A', version: '1.0' }, { arm: 'B', version: '1.0' }]), null);
  const err = declaredVersionCheck([{ arm: 'A', version: '1.0' }, { arm: 'B', version: '2.0' }]);
  assert.ok(err);
  assert.equal(err.level, 'error');
  assert.equal(declaredVersionCheck(
    [{ arm: 'A', version: '1.0' }, { arm: 'B', version: '2.0' }], { expectedDifferent: true }), null);
});

test('runStaticGates: an error + a warning → fail-fast (fatal), yet the warning still rides in the report (R6.EB4)', () => {
  const skills = [
    { name: 'toolong', description: '測'.repeat(1025), triggers: ['scan'], shared: { 'util.md': 'a' } }, // error: desc
    { name: 'other', description: 'ok', triggers: ['scan'], shared: { 'util.md': 'DRIFTED' } },          // warns: collision + drift
  ];
  const res = runStaticGates(skills);
  assert.equal(res.fatal, true);              // error present → fail-fast, zero token
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.gate === 'desc-length'));
  // warnings survive into the report despite the fatal error
  assert.ok(res.warnings.some((w) => w.gate === 'trigger-collision'));
  assert.ok(res.warnings.some((w) => w.gate === 'shared-drift'));
  assert.ok(Array.isArray(res.fixedTaxTable) && res.fixedTaxTable.length === 2);
});

test('runStaticGates: all gates clean → not fatal, warnings empty', () => {
  const skills = [
    { name: 'alpha', description: 'short', triggers: ['aaa'], shared: { 'util.md': 'same' } },
    { name: 'beta', description: 'short', triggers: ['bbb'], shared: { 'util.md': 'same' } },
  ];
  const res = runStaticGates(skills, [{ arm: 'A', version: '1.0' }, { arm: 'B', version: '1.0' }]);
  assert.equal(res.fatal, false);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
});
