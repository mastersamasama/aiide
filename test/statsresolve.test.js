// Shared stats resolver (design A1) — decision-table golden samples + server list/detail
// consistency (design A2). All fixtures are synthetic (fixture experiment + fixture sidecar);
// nothing here touches real .aiide data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveExpStats, statsSidecarPath, SIDECAR_AUTHORITIES, SCHEMA_SECTIONS } from '../src/statsresolve.js';
import { createDashboardServer } from '../src/server.js';
import { expStats as EXP_STATS } from './fixtures/synthetic-bundle/bundle.js';

const MINI_STATS = { schemaVersion: 2, nCoverageValid: 3, skillCoverage: { installed: [], everTriggered: [], triggerRate: [], neverTriggered: [], notExercised: [], caseJoin: {} } };

function tmpData() {
  const root = mkdtempSync(join(tmpdir(), 'aiide-resolve-'));
  const dataDir = join(root, '.aiide');
  mkdirSync(join(dataDir, 'experiments'), { recursive: true });
  mkdirSync(join(dataDir, 'stats'), { recursive: true });
  return { root, dataDir };
}
const writeSidecar = (dataDir, id, wrapper) =>
  writeFileSync(join(dataDir, 'stats', `${id}.json`), typeof wrapper === 'string' ? wrapper : JSON.stringify(wrapper));

// ---- A1 decision table, every cell -------------------------------------------------------------

test('resolver: sidecar path matches what `aiide stats --write` writes (<dataDir>/stats/<id>.json)', () => {
  assert.equal(statsSidecarPath('/d/.aiide', 'e1'), join('/d/.aiide', 'stats', 'e1.json'));
});

test('resolver A1 row 1: embedded valid wins; no sidecar → no sidecarIgnored flag', () => {
  const { root, dataDir } = tmpData();
  const out = resolveExpStats({ id: 'e1', stats: MINI_STATS }, dataDir);
  assert.equal(out.statsAuthority, 'embedded');
  assert.equal(out.stats, MINI_STATS);
  assert.deepEqual(out.warnings, []);
  assert.equal('sidecarIgnored' in out, false);
  rmSync(root, { recursive: true, force: true });
});

test('resolver A1 row 1 (deliberate): embedded valid + coexisting sidecar → sidecar IGNORED + flagged', () => {
  const { root, dataDir } = tmpData();
  const recomputed = { ...MINI_STATS, nCoverageValid: 99 }; // a --force recompute that must NOT win
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'non-authoritative-recompute', warnings: ['w'], stats: recomputed });
  const out = resolveExpStats({ id: 'e1', stats: MINI_STATS }, dataDir);
  assert.equal(out.statsAuthority, 'embedded');
  assert.equal(out.stats.nCoverageValid, 3);        // sealed numbers, not the recompute
  assert.equal(out.sidecarIgnored, true);           // but the UI can say a diagnostic sidecar exists
  assert.deepEqual(out.warnings, []);               // wrapper warnings do NOT leak from an ignored sidecar
  rmSync(root, { recursive: true, force: true });
});

test('resolver A1 row 2: embedded absent + valid wrapper → wrapper.stats, authority + warnings verbatim', () => {
  const { root, dataDir } = tmpData();
  for (const authority of SIDECAR_AUTHORITIES) {
    writeSidecar(dataDir, 'e1', { expId: 'e1', authority, warnings: ['1 rep(s) unresolved'], stats: MINI_STATS });
    const out = resolveExpStats({ id: 'e1' }, dataDir);
    assert.equal(out.statsAuthority, authority);
    assert.deepEqual(out.stats, MINI_STATS);
    assert.deepEqual(out.warnings, ['1 rep(s) unresolved']);   // 原文透传
    assert.equal('statsError' in out, false);
  }
  // embedded ERROR + valid wrapper → wrapper still wins (error ≠ valid embedded)
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'recomputed-no-embedded', warnings: [], stats: MINI_STATS });
  const out = resolveExpStats({ id: 'e1', stats: { error: 'boom' } }, dataDir);
  assert.equal(out.statsAuthority, 'recomputed-no-embedded');
  assert.deepEqual(out.stats, MINI_STATS);
  rmSync(root, { recursive: true, force: true });
});

test('resolver A1 row 3: corrupt sidecar (bad JSON / missing stats / unknown authority) → null + warning', () => {
  const { root, dataDir } = tmpData();
  const corrupt = [
    '{not json',                                                                    // JSON 坏
    JSON.stringify({ expId: 'e1', authority: 'recomputed-no-embedded' }),           // 缺 stats 栏
    JSON.stringify({ expId: 'e1', authority: 'made-up-authority', stats: MINI_STATS }), // authority 不在封闭集
    JSON.stringify([1, 2, 3]),                                                      // 不是 object
    JSON.stringify({ expId: 'e1', authority: 'recomputed-no-embedded', stats: { error: 'x' } }), // wrapper 内 error stats
  ];
  for (const body of corrupt) {
    writeSidecar(dataDir, 'e1', body);
    const out = resolveExpStats({ id: 'e1' }, dataDir);
    assert.equal(out.stats, null, `corrupt sidecar must not resolve: ${body.slice(0, 40)}`);
    assert.equal(out.statsAuthority, null);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /sidecar corrupt or unrecognized/);
  }
  rmSync(root, { recursive: true, force: true });
});

test('resolver A1 row 4: neither embedded nor sidecar → null; embedded {error} adds statsError', () => {
  const { root, dataDir } = tmpData();
  const none = resolveExpStats({ id: 'e1' }, dataDir);
  assert.deepEqual(none, { stats: null, statsAuthority: null, warnings: [] });
  const err = resolveExpStats({ id: 'e1', stats: { error: 'engine exploded' } }, dataDir);
  assert.equal(err.stats, null);
  assert.equal(err.statsAuthority, null);
  assert.equal(err.statsError, 'engine exploded');
  // embedded error + CORRUPT sidecar → both the degrade warning and the statsError surface
  writeSidecar(dataDir, 'e1', '{corrupt');
  const both = resolveExpStats({ id: 'e1', stats: { error: 'engine exploded' } }, dataDir);
  assert.equal(both.stats, null);
  assert.match(both.warnings[0], /corrupt/);
  assert.equal(both.statsError, 'engine exploded');
  rmSync(root, { recursive: true, force: true });
});

// ---- A1 stale-schema cell (taxonomy §3.0): supplemental 並列供給 --------------------------------
// The existing cells above are FROZEN golden samples — everything here is an ADDED cell: embedded
// valid + embedded schemaVersion < sidecar's + sidecar authority 'non-authoritative-recompute'
// → independent top-level `supplemental`, authoritative stats/statsAuthority byte-untouched.

// a v3 recompute sidecar stats blob: drifted v2 sections (MUST never leak) + v3 top-level sections.
// fileTargets deliberately ABSENT so "sections only carries what the sidecar actually has" is pinned.
const V3_NEW_SECTIONS = {
  contextComposition: null, // null section = honest unknowable — rides as null (null-not-zero)
  toolUsage: { totalCalls: 7, byKind: { builtin: { calls: 7 } } },
  truncation: { truncatedRoundShare: 0, finalRoundTruncated: 0 },
  cacheHitRate: { mean: 0.42 },
  selfReport: null,
  sidechainShare: { tokensShare: 0.1 },
  statsHealth: { parseWarnings: 0, exclusionBreakdown: {} },
};
const V3_RECOMPUTE_STATS = {
  ...MINI_STATS,
  schemaVersion: 3,
  nCoverageValid: 99,                                    // drifted recompute — must NOT leak
  skillCoverage: { ...MINI_STATS.skillCoverage, everTriggered: [{ skill: 'drifted', cases: 99 }] },
  ...V3_NEW_SECTIONS,
};
const V3_KEYS = SCHEMA_SECTIONS[3];

test('SCHEMA_SECTIONS: closed-set map — v3 eight keys verbatim (r5 F-5-04), v2 introduced no top-level section', () => {
  assert.deepEqual([...SCHEMA_SECTIONS[3]], [
    'contextComposition', 'toolUsage', 'truncation', 'fileTargets',
    'cacheHitRate', 'selfReport', 'sidechainShare', 'statsHealth',
  ]);
  assert.deepEqual([...SCHEMA_SECTIONS[2]], []); // caseJoin / bySkill[].refs are IN-SECTION upgrades
});

test('resolver supplemental (flagship): embedded v2 + v3 recompute sidecar → stats byte-identical, supplemental carries ONLY the v3 keys the sidecar has, v2 recompute drift never leaks', () => {
  const { root, dataDir } = tmpData();
  const embedded = MINI_STATS; // schemaVersion 2, nCoverageValid 3
  const baseline = resolveExpStats({ id: 'e1', stats: embedded }, dataDir); // no sidecar
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'non-authoritative-recompute', warnings: ['recompute warning'], stats: V3_RECOMPUTE_STATS });
  const out = resolveExpStats({ id: 'e1', stats: embedded }, dataDir);

  // authoritative channel COMPLETELY unchanged — byte-identical to the no-sidecar resolution
  assert.equal(JSON.stringify(out.stats), JSON.stringify(baseline.stats));
  assert.equal(JSON.stringify(out.stats), JSON.stringify(embedded));
  assert.equal(out.statsAuthority, 'embedded');
  assert.equal(out.sidecarIgnored, true);           // narrowed semantics: coexists with supplemental
  assert.deepEqual(out.warnings, []);               // ignored-sidecar wrapper warnings still don't leak

  // supplemental: independent top-level field, ONLY v3 section keys the sidecar actually has
  assert.deepEqual(Object.keys(out.supplemental.sections).sort(),
    V3_KEYS.filter((k) => k !== 'fileTargets').sort()); // fileTargets absent from sidecar → absent here
  for (const k of Object.keys(out.supplemental.sections)) assert.ok(V3_KEYS.includes(k));
  assert.deepEqual(out.supplemental.sections.toolUsage, V3_NEW_SECTIONS.toolUsage);
  assert.equal(out.supplemental.sections.contextComposition, null); // null rides as null
  assert.equal(out.supplemental.authority, 'non-authoritative-recompute');
  assert.equal(out.supplemental.schemaVersionFrom, 2);
  assert.equal(out.supplemental.schemaVersionTo, 3);

  // the sidecar's recompute of v2 sections must not appear ANYWHERE in the return value
  const flat = JSON.stringify(out);
  assert.equal('skillCoverage' in out.supplemental.sections, false);
  assert.equal(flat.includes('"nCoverageValid":99'), false);
  assert.equal(flat.includes('drifted'), false);
  rmSync(root, { recursive: true, force: true });
});

test('resolver supplemental: embedded v1 dual form — explicit schemaVersion:1 and MISSING field resolve to the SAME section set (missing ≡ 1)', () => {
  const { root, dataDir } = tmpData();
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'non-authoritative-recompute', warnings: [], stats: V3_RECOMPUTE_STATS });
  const { schemaVersion: _drop, ...noVersionField } = MINI_STATS;
  const explicit = resolveExpStats({ id: 'e1', stats: { ...noVersionField, schemaVersion: 1 } }, dataDir);
  const absent = resolveExpStats({ id: 'e1', stats: noVersionField }, dataDir);
  assert.deepEqual(Object.keys(explicit.supplemental.sections).sort(), Object.keys(absent.supplemental.sections).sort());
  assert.equal(explicit.supplemental.schemaVersionFrom, 1);
  assert.equal(absent.supplemental.schemaVersionFrom, 1);
  assert.equal(explicit.supplemental.schemaVersionTo, 3);
  // r4 F-4-02 真路徑 limit: v2 introduced no TOP-LEVEL sections → a v1 embedded still gets only the
  // v3 keys; the v1→v2 in-section upgrades (caseJoin, bySkill[].refs) never ride supplemental
  for (const k of Object.keys(explicit.supplemental.sections)) assert.ok(V3_KEYS.includes(k));
  assert.equal('skillCoverage' in explicit.supplemental.sections, false);
  assert.equal('refCoverage' in explicit.supplemental.sections, false);
  rmSync(root, { recursive: true, force: true });
});

test('resolver supplemental: sidecar authority authoritative-embedded (byte copy) → NO supplemental', () => {
  const { root, dataDir } = tmpData();
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'authoritative-embedded', warnings: [], stats: V3_RECOMPUTE_STATS });
  const out = resolveExpStats({ id: 'e1', stats: MINI_STATS }, dataDir);
  assert.equal(out.statsAuthority, 'embedded');
  assert.equal(out.sidecarIgnored, true);
  assert.equal('supplemental' in out, false);
  rmSync(root, { recursive: true, force: true });
});

test('resolver supplemental: embedded already v3 → NO supplemental even with a coexisting recompute sidecar', () => {
  const { root, dataDir } = tmpData();
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'non-authoritative-recompute', warnings: [], stats: V3_RECOMPUTE_STATS });
  const embeddedV3 = { ...MINI_STATS, schemaVersion: 3, ...V3_NEW_SECTIONS };
  const out = resolveExpStats({ id: 'e1', stats: embeddedV3 }, dataDir);
  assert.equal(out.statsAuthority, 'embedded');
  assert.equal(out.stats, embeddedV3);
  assert.equal(out.sidecarIgnored, true);
  assert.equal('supplemental' in out, false);
  rmSync(root, { recursive: true, force: true });
});

test('resolver supplemental: sidecar same version / corrupt / recomputed-no-embedded → NO supplemental, embedded row contract intact', () => {
  const { root, dataDir } = tmpData();
  // same version (v2 recompute against v2 embedded)
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'non-authoritative-recompute', warnings: [], stats: { ...MINI_STATS, nCoverageValid: 99 } });
  let out = resolveExpStats({ id: 'e1', stats: MINI_STATS }, dataDir);
  assert.equal('supplemental' in out, false);
  // corrupt JSON — embedded path stays the frozen golden behavior (no warnings leak)
  writeSidecar(dataDir, 'e1', '{not json');
  out = resolveExpStats({ id: 'e1', stats: MINI_STATS }, dataDir);
  assert.equal(out.statsAuthority, 'embedded');
  assert.equal(out.sidecarIgnored, true);
  assert.deepEqual(out.warnings, []);
  assert.equal('supplemental' in out, false);
  // wrong authority for the supplemental channel (recomputed-no-embedded is for MISSING embedded)
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'recomputed-no-embedded', warnings: [], stats: V3_RECOMPUTE_STATS });
  out = resolveExpStats({ id: 'e1', stats: MINI_STATS }, dataDir);
  assert.equal('supplemental' in out, false);
  rmSync(root, { recursive: true, force: true });
});

test('resolver supplemental: embedded MISSING/error → existing sidecar-authority rows unchanged (no supplemental on those paths)', () => {
  const { root, dataDir } = tmpData();
  writeSidecar(dataDir, 'e1', { expId: 'e1', authority: 'non-authoritative-recompute', warnings: [], stats: V3_RECOMPUTE_STATS });
  const missing = resolveExpStats({ id: 'e1' }, dataDir);
  assert.equal(missing.statsAuthority, 'non-authoritative-recompute'); // sidecar IS the resolution
  assert.equal('supplemental' in missing, false);
  const errored = resolveExpStats({ id: 'e1', stats: { error: 'boom' } }, dataDir);
  assert.equal(errored.statsAuthority, 'non-authoritative-recompute');
  assert.equal('supplemental' in errored, false);
  rmSync(root, { recursive: true, force: true });
});

// ---- A2: server list + detail use the SAME resolver — they can never disagree ------------------

function seedExp(dataDir, id, over = {}) {
  writeFileSync(join(dataDir, 'experiments', `${id}.json`), JSON.stringify({
    id, suiteName: 'suite', model: 'sonnet', repeats: 3, createdAt: `2026-07-0${id.length}T00:00:00Z`,
    profile: { skills: ['s1'] }, isolationVerified: true, runtime: 'claude-code',
    tasks: { t1: {} }, summary: { composite: 0.5, lowSample: false }, ...over,
  }));
}

test('server A2: detail carries stats/statsAuthority/statsWarnings/sidecarIgnored; list statsAuthority agrees; read-only', async () => {
  const { root, dataDir } = tmpData();
  seedExp(dataDir, 'e-emb', { stats: EXP_STATS });                       // embedded valid
  seedExp(dataDir, 'e-side');                                            // sidecar-backed
  writeSidecar(dataDir, 'e-side', { expId: 'e-side', authority: 'recomputed-no-embedded', warnings: ['backfill: no ref inventory snapshot'], stats: MINI_STATS });
  seedExp(dataDir, 'e-ign', { stats: EXP_STATS });                       // embedded + ignored sidecar
  writeSidecar(dataDir, 'e-ign', { expId: 'e-ign', authority: 'non-authoritative-recompute', warnings: [], stats: MINI_STATS });
  seedExp(dataDir, 'e-corrupt');                                         // corrupt sidecar
  writeSidecar(dataDir, 'e-corrupt', '{nope');
  seedExp(dataDir, 'e-err', { stats: { error: 'stats blew up at seal' } }); // embedded error, no sidecar
  seedExp(dataDir, 'e-none');                                            // nothing at all
  const sidecarBytes = readFileSync(join(dataDir, 'stats', 'e-side.json'), 'utf8');
  const expBytes = readFileSync(join(dataDir, 'experiments', 'e-err.json'), 'utf8');

  const server = createDashboardServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/experiments`)).json();
    const listAuth = Object.fromEntries(list.map(e => [e.id, e.statsAuthority]));
    assert.deepEqual(listAuth, {
      'e-emb': 'embedded', 'e-ign': 'embedded', 'e-side': 'recomputed-no-embedded',
      'e-corrupt': null, 'e-err': null, 'e-none': null,
    });

    const detail = async (id) => (await fetch(`${base}/api/experiments/${id}`)).json();
    // list and detail agree on EVERY experiment (same resolver — structural, not coincidental)
    for (const e of list) assert.equal((await detail(e.id)).statsAuthority, e.statsAuthority, e.id);

    const emb = await detail('e-emb');
    assert.equal(emb.statsAuthority, 'embedded');
    assert.equal(emb.stats.schemaVersion, 2);
    assert.deepEqual(emb.statsWarnings, []);
    assert.equal('sidecarIgnored' in emb, false);

    const ign = await detail('e-ign');
    assert.equal(ign.statsAuthority, 'embedded');
    assert.equal(ign.stats.nCoverageValid, EXP_STATS.nCoverageValid); // sealed numbers, not the sidecar's
    assert.equal(ign.sidecarIgnored, true);

    const side = await detail('e-side');
    assert.equal(side.statsAuthority, 'recomputed-no-embedded');
    assert.equal(side.stats.nCoverageValid, 3);
    assert.deepEqual(side.statsWarnings, ['backfill: no ref inventory snapshot']); // wrapper warnings 原文
    assert.equal(side.warnings, undefined); // seal-time exp.warnings channel untouched

    const corrupt = await detail('e-corrupt');
    assert.equal(corrupt.stats, null);
    assert.equal(corrupt.statsAuthority, null);
    assert.match(corrupt.statsWarnings[0], /corrupt/);

    const err = await detail('e-err');
    assert.equal(err.stats, null);                       // never a fake shape
    assert.equal(err.statsAuthority, null);
    assert.equal(err.statsError, 'stats blew up at seal');

    const none = await detail('e-none');
    assert.equal(none.stats, null);
    assert.equal(none.statsAuthority, null);
    assert.equal('statsError' in none, false);

    // read-only iron rule: server reads the sidecar but never writes/creates anything under stats/
    assert.equal(readFileSync(join(dataDir, 'stats', 'e-side.json'), 'utf8'), sidecarBytes);
    assert.equal(readFileSync(join(dataDir, 'experiments', 'e-err.json'), 'utf8'), expBytes);
    assert.equal(existsSync(join(dataDir, 'stats', 'e-none.json')), false);
  } finally { server.close(); }
  rmSync(root, { recursive: true, force: true });
});

test('server A2: detail passes supplemental through verbatim; authoritative stats untouched; list unchanged', async () => {
  const { root, dataDir } = tmpData();
  seedExp(dataDir, 'e-supp', { stats: MINI_STATS });   // embedded v2
  writeSidecar(dataDir, 'e-supp', { expId: 'e-supp', authority: 'non-authoritative-recompute', warnings: [], stats: V3_RECOMPUTE_STATS });
  const server = createDashboardServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const detail = await (await fetch(`${base}/api/experiments/e-supp`)).json();
    assert.equal(detail.statsAuthority, 'embedded');
    assert.equal(detail.stats.schemaVersion, 2);
    assert.equal(detail.stats.nCoverageValid, 3);                    // sealed, not the 99 recompute
    assert.equal(detail.sidecarIgnored, true);
    assert.equal(detail.supplemental.authority, 'non-authoritative-recompute');
    assert.equal(detail.supplemental.schemaVersionFrom, 2);
    assert.equal(detail.supplemental.schemaVersionTo, 3);
    assert.deepEqual(detail.supplemental.sections.toolUsage, V3_NEW_SECTIONS.toolUsage);
    assert.equal('skillCoverage' in detail.supplemental.sections, false); // v2 drift never leaks
    const list = await (await fetch(`${base}/api/experiments`)).json();
    assert.equal(list.find(e => e.id === 'e-supp').statsAuthority, 'embedded'); // list agrees
  } finally { server.close(); }
  rmSync(root, { recursive: true, force: true });
});
