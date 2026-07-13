import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardServer } from '../src/server.js';

// U8 [TL-M1]: read-only GET /api/upgrades over the U7 verdict-first report.json artifacts.
// Interface with U7 = the <dataDir>/upgrades/<compare-id>/report.json directory layout + schema;
// these fixtures stand in for U7 output so U8 develops without depending on its code.

function writeReport(dataDir, id, report) {
  const dir = join(dataDir, 'upgrades', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
  return dir;
}

// a minimal-but-complete verdict-first report.json (mirrors decideVerdict + footer + cases)
function reportFixture(over = {}) {
  return {
    schema: 'aiide-upgrade-report/v1',
    compareId: over.compareId ?? 'new__vs__old__20260709T120000Z',
    createdAt: over.createdAt ?? '2026-07-09T12:00:00.000Z',
    intent: over.intent ?? 'cost-opt',
    verdict: over.verdict ?? 'cost-opt',
    established: over.established ?? true,
    pairs: over.pairs ?? 12,
    exclusionPct: over.exclusionPct ?? 4.5,
    excludedCases: over.excludedCases ?? [],
    gates: over.gates ?? { qualityNonInferior: true, flowOk: true, anyCostDown: true, anyCostUp: false },
    reasons: over.reasons ?? [],
    cohort: over.cohort ?? 'sonnet',
    lineage: over.lineage ?? 'onchainos-core',
    header: over.header ?? { mixedBundle: false, mix: null, baselineArm: { label: 'old-full', cliVersion: 'onchainos 1.4.0', full: true } },
    arms: over.arms ?? {
      new: { label: 'new-full', version: 'onchainos 1.5.0', harness: 'claude-code', isolation: true },
      old: { label: 'old-full', version: 'onchainos 1.4.0', harness: 'claude-code', isolation: true },
    },
    axes: over.axes ?? {
      quality: { l1: { deltaPp: 1, ci: { lo: -1, hi: 3 }, n: 12 }, l2: { deltaPp: 0, ci: { lo: -2, hi: 2 }, n: 12 }, l3: { deltaPp: 0.5, ci: { lo: -1, hi: 2 }, n: 12, heuristic: false } },
      cost: { turns: { delta: -1.3, ci: { lo: -2.1, hi: -0.5 }, n: 12, significantDown: true }, tokens: { delta: -200, ci: { lo: -350, hi: -50 }, n: 12, significantDown: true }, seconds: { delta: -2, ci: { lo: -4, hi: 0.2 }, n: 12 } },
      flowIncomplete: { rateNew: 0.02, rateOld: 0.02, regressed: false },
    },
    perSkill: over.perSkill ?? { skills: [{ skill: 'route', nCases: 9, badge: 'ok', mean: 0.5, ci: { lo: -0.5, hi: 1.5 }, significant: false, significantBadge: 'n.s.' }], note: 'per-skill diagnostics are NOT an adoption certificate', fdr: 'benjamini-hochberg' },
    footer: over.footer ?? { config: { MIN_PAIRS: 8, MIN_PAIRS_SKILL: 5, nonInferiorityDeltaPp: 5, ciLevel: 0.95, bootstrapSeed: 2654435769, fdr: 'benjamini-hochberg' }, versionQuad: { newVersion: 'onchainos 1.5.0', oldVersion: 'onchainos 1.4.0' }, tests: { count: 3, globalCorrection: 'none', perSkillCorrection: 'benjamini-hochberg' } },
    cases: over.cases ?? [{ caseId: 'c1', delta: -1.2, regressed: false }, { caseId: 'c2', delta: -0.4, regressed: false }],
  };
}

async function withServer(dataDir, fn) {
  const server = createDashboardServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('GET /api/upgrades lists report.json summaries, newest first (R8.4.1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-upg-'));
  const dataDir = join(root, '.aiide');
  writeReport(dataDir, 'cmp-a', reportFixture({ compareId: 'cmp-a', createdAt: '2026-07-08T00:00:00Z', verdict: 'cost-opt', established: true }));
  writeReport(dataDir, 'cmp-b', reportFixture({ compareId: 'cmp-b', createdAt: '2026-07-09T00:00:00Z', verdict: 'quality-fix', intent: 'quality-fix', established: false }));
  await withServer(dataDir, async (base) => {
    const list = await (await fetch(`${base}/api/upgrades`)).json();
    assert.equal(list.length, 2);
    assert.equal(list[0].compareId, 'cmp-b'); // newest first
    assert.equal(list[0].verdict, 'quality-fix');
    assert.equal(list[0].established, false);
    assert.equal(list[1].arms.new, 'new-full');
    assert.equal(list[1].arms.newVersion, 'onchainos 1.5.0');
    assert.equal(list[1].arms.baseline, 'old-full');
    assert.equal(list[1].intent, 'cost-opt');
  });
  rmSync(root, { recursive: true, force: true });
});

test('GET /api/upgrades/<id> returns the full verdict-first report + html path annotation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-upg2-'));
  const dataDir = join(root, '.aiide');
  const dir = writeReport(dataDir, 'cmp-a', reportFixture({ compareId: 'cmp-a' }));
  writeFileSync(join(dir, 'report.html'), '<html>report</html>');
  await withServer(dataDir, async (base) => {
    const rep = await (await fetch(`${base}/api/upgrades/cmp-a`)).json();
    assert.equal(rep.verdict, 'cost-opt');          // first layer IS the verdict
    assert.equal(rep.footer.config.MIN_PAIRS, 8);
    assert.match(rep._reportHtmlPath, /report\.html$/); // annotation only, disk untouched
    assert.equal((await fetch(`${base}/api/upgrades/nope`)).status, 404);
  });
  rmSync(root, { recursive: true, force: true });
});

test('GET /api/upgrades/<id>/report.html serves the HTML report same-origin (text/html); 404 when absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-upghtml-'));
  const dataDir = join(root, '.aiide');
  const dir = writeReport(dataDir, 'has-html', reportFixture({ compareId: 'has-html' }));
  writeFileSync(join(dir, 'report.html'), '<!doctype html><title>upgrade report</title><body>echarts here</body>');
  writeReport(dataDir, 'no-html', reportFixture({ compareId: 'no-html' })); // report.json only, no html
  await withServer(dataDir, async (base) => {
    const res = await fetch(`${base}/api/upgrades/has-html/report.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /upgrade report/);
    assert.equal((await fetch(`${base}/api/upgrades/no-html/report.html`)).status, 404); // no html artifact
    assert.equal((await fetch(`${base}/api/upgrades/nope/report.html`)).status, 404);     // unknown compare
    assert.equal((await fetch(`${base}/api/upgrades/has-html/report.html`, { method: 'POST' })).status, 405); // read-only
  });
  rmSync(root, { recursive: true, force: true });
});

test('GET /api/upgrades is read-only — non-GET → 405 (R8.EB3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-upg3-'));
  const dataDir = join(root, '.aiide');
  writeReport(dataDir, 'cmp-a', reportFixture());
  await withServer(dataDir, async (base) => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await fetch(`${base}/api/upgrades`, { method })).status, 405, method);
      assert.equal((await fetch(`${base}/api/upgrades/cmp-a`, { method })).status, 405, method + ' detail');
    }
  });
  rmSync(root, { recursive: true, force: true });
});

test('GET /api/upgrades?trend=1 gives case-id-intersection paired series; superseded lineage breaks (R8.4.2/R8.EB4)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-upg4-'));
  const dataDir = join(root, '.aiide');
  // same cohort + same lineage, sharing c1,c2 (c3 only in the 2nd → dropped by intersection)
  writeReport(dataDir, 't1', reportFixture({ compareId: 't1', createdAt: '2026-07-01T00:00:00Z', cohort: 'sonnet', lineage: 'L1',
    cases: [{ caseId: 'c1', delta: -1 }, { caseId: 'c2', delta: 0.5 }] }));
  writeReport(dataDir, 't2', reportFixture({ compareId: 't2', createdAt: '2026-07-02T00:00:00Z', cohort: 'sonnet', lineage: 'L1',
    cases: [{ caseId: 'c1', delta: -2 }, { caseId: 'c2', delta: 0.2 }, { caseId: 'c3', delta: 9 }] }));
  // same cohort but a SUPERSEDED genealogy (new lineage id) → must be its own segment (line breaks)
  writeReport(dataDir, 't3', reportFixture({ compareId: 't3', createdAt: '2026-07-03T00:00:00Z', cohort: 'sonnet', lineage: 'L2',
    cases: [{ caseId: 'c1', delta: -3 }] }));
  await withServer(dataDir, async (base) => {
    const { cohorts } = await (await fetch(`${base}/api/upgrades?trend=1`)).json();
    assert.equal(cohorts.length, 1);
    const sonnet = cohorts[0];
    assert.equal(sonnet.cohort, 'sonnet');
    assert.equal(sonnet.segments.length, 2); // L1 and L2 do not join — superseded break

    const l1 = sonnet.segments.find(s => s.lineage === 'L1');
    assert.deepEqual(l1.caseIds.sort(), ['c1', 'c2']); // c3 excluded (not in both reports)
    assert.equal(l1.reports.length, 2);
    const c1 = l1.series.find(s => s.caseId === 'c1');
    assert.deepEqual(c1.points.map(p => p.delta), [-1, -2]); // paired sequence over time

    const l2 = sonnet.segments.find(s => s.lineage === 'L2');
    assert.equal(l2.reports.length, 1);
    assert.equal(l2.series.find(s => s.caseId === 'c1').points.length, 1); // separate, not bridged to L1
  });
  rmSync(root, { recursive: true, force: true });
});

test('GET /api/upgrades on a missing upgrades dir returns empty, not an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-upg5-'));
  await withServer(join(root, 'nothing'), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/upgrades`)).json(), []);
    assert.deepEqual(await (await fetch(`${base}/api/upgrades?trend=1`)).json(), { cohorts: [] });
  });
  rmSync(root, { recursive: true, force: true });
});

test('corrupt report.json is skipped, never a 500', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-upg6-'));
  const dataDir = join(root, '.aiide');
  writeReport(dataDir, 'good', reportFixture({ compareId: 'good' }));
  const badDir = join(dataDir, 'upgrades', 'bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'report.json'), '{not json');
  await withServer(dataDir, async (base) => {
    const list = await (await fetch(`${base}/api/upgrades`)).json();
    assert.equal(list.length, 1); // the corrupt one is skipped, the good one survives
    assert.equal(list[0].compareId, 'good');
    assert.equal((await fetch(`${base}/api/upgrades/bad`)).status, 500); // explicit detail read → corrupt
  });
  rmSync(root, { recursive: true, force: true });
});
