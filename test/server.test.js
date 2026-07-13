import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardServer } from '../src/server.js';

function seedData(root) {
  const dataDir = join(root, '.aiide');
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  mkdirSync(join(dataDir, 'experiments'), { recursive: true });
  writeFileSync(join(dataDir, 'runs', 'r1.json'), JSON.stringify({
    run: { id: 'r1', model: 'claude-sonnet-5', startedAt: '2026-07-02T10:00:00Z', meta: {}, parseWarnings: 0, rounds: [], sidechains: [] },
    metrics: { totals: { rounds: 2, sidechainRounds: 0, durationMs: 1000, tokens: { in: 10, out: 5, cacheW: 0, cacheR: 0 }, costUsd: 0.01, toolErrors: 0 }, perSkill: { s1: {} }, contextSeries: [], peakContext: 0, contextLimit: 200000 },
  }));
  writeFileSync(join(dataDir, 'experiments', 'e1.json'), JSON.stringify({
    id: 'e1', suiteName: 'suite', model: 'sonnet', repeats: 3, createdAt: '2026-07-02T11:00:00Z',
    profile: { skills: ['s1'] }, isolationVerified: true,
    tasks: { t1: {} }, summary: { composite: 0.9, C: 1, P: 1, R: 1, H: 0.9, lowSample: false },
  }));
  return dataDir;
}

async function withServer(dataDir, fn) {
  const server = createDashboardServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('server: API shapes + 404 + read-only (AC 5.4)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-srv-'));
  const dataDir = seedData(root);
  await withServer(dataDir, async (base) => {
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, 'r1');
    assert.deepEqual(runs[0].skills, ['s1']);

    const run = await (await fetch(`${base}/api/runs/r1`)).json();
    assert.equal(run.run.id, 'r1');

    const exps = await (await fetch(`${base}/api/experiments`)).json();
    assert.equal(exps[0].composite, 0.9);

    assert.equal((await fetch(`${base}/api/runs/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/r1`, { method: 'POST' })).status, 405); // read-only
    assert.equal((await fetch(`${base}/api/runs/..%2F..%2Fsecret`)).status, 404); // traversal-safe

    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /aiide/);
  });
  rmSync(root, { recursive: true, force: true });
});

test('server: annotations PUT lifecycle — sidecar only, experiment file immutable (R4/R8)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-srv3-'));
  const dataDir = seedData(root);
  const expFile = join(dataDir, 'experiments', 'e1.json');
  const before = readFileSync(expFile, 'utf8');
  await withServer(dataDir, async (base) => {
    const put = (id, body) => fetch(`${base}/api/experiments/${id}/annotations`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    // save + redaction before disk (correctness property 3)
    const r1 = await put('e1', { note: 'auth bug fixed', leak: 'sk-abcdefgh1234' });
    assert.equal(r1.status, 200);
    const saved = await r1.json();
    assert.equal(saved.note, 'auth bug fixed');
    assert.equal(saved.leak, '***');
    const onDisk = readFileSync(join(dataDir, 'annotations', 'e1.json'), 'utf8');
    assert.doesNotMatch(onDisk, /sk-abcdefgh/);

    // GET merges the sidecar; original experiment bytes untouched (correctness property 1)
    const exp = await (await fetch(`${base}/api/experiments/e1`)).json();
    assert.equal(exp.annotations.note, 'auth bug fixed');
    assert.equal(readFileSync(expFile, 'utf8'), before);

    // validation + unknown id
    assert.equal((await put('nope', { a: 'b' })).status, 404);
    assert.equal((await put('e1', '[1,2]')).status, 400);
    assert.equal((await put('e1', { 'bad key!': 'x' })).status, 400);
    assert.equal((await put('e1', { n: 42 })).status, 400);          // non-string value
    assert.equal((await put('e1', { n: 'x'.repeat(2001) })).status, 400);
    assert.equal((await fetch(`${base}/api/runs/r1`, { method: 'POST' })).status, 405); // still read-only

    // corrupt sidecar degrades to empty + warning, never 500 (AC 8.3)
    writeFileSync(join(dataDir, 'annotations', 'e1.json'), '{corrupt');
    const exp2res = await fetch(`${base}/api/experiments/e1`);
    assert.equal(exp2res.status, 200);
    const exp2 = await exp2res.json();
    assert.deepEqual(exp2.annotations, {});
    assert.match(exp2.annotationsWarning, /corrupt/);
  });
  rmSync(root, { recursive: true, force: true });
});

test('server: /api/search is read-only full-text grep over run JSON (S8)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-srch-'));
  const dataDir = seedData(root);
  // a run whose body mentions a distinctive tool call
  writeFileSync(join(dataDir, 'runs', 'r2.json'), JSON.stringify({
    run: { id: 'r2', model: 'sonnet', startedAt: '2026-07-02T12:00:00Z', meta: {}, parseWarnings: 0,
      rounds: [{ seq: 1, toolCalls: [{ name: 'market_price', input: { symbol: 'OKB' } }] }], sidechains: [] },
    metrics: { totals: { rounds: 1, sidechainRounds: 0, durationMs: 1, tokens: { in: 1, out: 1, cacheW: 0, cacheR: 0 }, costUsd: 0, toolErrors: 0 }, perSkill: {}, contextSeries: [], peakContext: 0, contextLimit: 200000 },
  }));
  await withServer(dataDir, async (base) => {
    const hits = await (await fetch(`${base}/api/search?q=market_price`)).json();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].runId, 'r2');
    assert.match(hits[0].snippet, /market_price/);

    // short / empty query returns nothing, not the whole corpus
    assert.deepEqual(await (await fetch(`${base}/api/search?q=a`)).json(), []);
    assert.deepEqual(await (await fetch(`${base}/api/search`)).json(), []);
    // no match → empty
    assert.deepEqual(await (await fetch(`${base}/api/search?q=zzzznotfound`)).json(), []);
    // still read-only
    assert.equal((await fetch(`${base}/api/search?q=market`, { method: 'POST' })).status, 405);
  });
  rmSync(root, { recursive: true, force: true });
});

test('server: /api/skills joins experiments + runs, keys versions by hash (S14)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-skills-'));
  const dataDir = join(root, '.aiide');
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  mkdirSync(join(dataDir, 'experiments'), { recursive: true });
  // two experiments targeting skill "okx" with different hashes (a version bump) + an untriggered skill
  const mkExp = (id, hash, createdAt, composite, actRate) => ({
    id, suiteName: 'basic.json', model: 'sonnet', repeats: 3, createdAt, runtime: 'claude-code',
    profile: { skills: ['okx'] }, isolationVerified: true,
    environment: { suite: { sha256: 'sha0001' }, skills: [{ name: 'okx', hash }] },
    contextInsights: { skillListing: [{ skill: 'okx', listingTokensEst: 120, bodyTokensEst: 900 }], listingTotalTokensEst: 120 },
    tasks: { t1: { activationRate: actRate } }, summary: { composite, degraded: false, excludedRepeats: 0, lowSample: false },
  });
  writeFileSync(join(dataDir, 'experiments', 'eA.json'), JSON.stringify(mkExp('eA', 'a1b2c3', '2026-07-01T00:00:00Z', 0.6, 0.5)));
  writeFileSync(join(dataDir, 'experiments', 'eB.json'), JSON.stringify(mkExp('eB', 'd4e5f6', '2026-07-02T00:00:00Z', 0.7, 0.6)));
  // an installed-but-never-triggered skill (activation always 0)
  const neverExp = mkExp('eC', 'ff0000', '2026-07-03T00:00:00Z', 0.4, 0);
  neverExp.profile.skills = ['dead']; neverExp.environment.skills = [{ name: 'dead', hash: 'ff0000' }];
  neverExp.contextInsights.skillListing = [{ skill: 'dead', listingTokensEst: 80, bodyTokensEst: 400 }];
  writeFileSync(join(dataDir, 'experiments', 'eC.json'), JSON.stringify(neverExp));
  writeFileSync(join(dataDir, 'runs', 'r1.json'), JSON.stringify({
    run: { id: 'r1', model: 'sonnet', startedAt: '2026-07-01T00:00:00Z', meta: {}, parseWarnings: 0, rounds: [], sidechains: [] },
    metrics: { totals: { rounds: 3, sidechainRounds: 0, durationMs: 1, tokens: { in: 1, out: 1, cacheW: 0, cacheR: 0 }, costUsd: 0, toolErrors: 0 },
      perSkill: { okx: { rounds: 2, tokens: { in: 500, out: 100 }, toolCalls: 4, toolErrors: 1 } }, contextSeries: [], peakContext: 0, contextLimit: 200000 },
  }));
  await withServer(dataDir, async (base) => {
    const skills = await (await fetch(`${base}/api/skills`)).json();
    const okx = skills.find(s => s.name === 'okx');
    assert.ok(okx, 'okx skill present');
    assert.equal(okx.experimentCount, 2);
    assert.equal(okx.versions.length, 2); // two distinct hashes → two versions on the timeline
    assert.equal(okx.runCount, 1);
    assert.equal(okx.runTotals.rounds, 2);
    assert.equal(okx.neverTriggered, false);
    assert.equal(okx.meanListingTokens, 120);
    const dead = skills.find(s => s.name === 'dead');
    assert.equal(dead.neverTriggered, true); // installed but never triggered — pure context tax
  });
  rmSync(root, { recursive: true, force: true });
});

test('server: experiments list surfaces degraded + nullable composite (Wave 1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-deg-'));
  const dataDir = join(root, '.aiide');
  mkdirSync(join(dataDir, 'experiments'), { recursive: true });
  writeFileSync(join(dataDir, 'experiments', 'eD.json'), JSON.stringify({
    id: 'eD', suiteName: 'suite', model: 'sonnet', repeats: 3, createdAt: '2026-07-02T11:00:00Z',
    profile: { skills: [] }, isolationVerified: true, tasks: { t1: {} },
    summary: { composite: null, C: null, P: null, R: null, H: null, lowSample: true, degraded: true, excludedRepeats: 2 },
  }));
  await withServer(dataDir, async (base) => {
    const exps = await (await fetch(`${base}/api/experiments`)).json();
    assert.equal(exps[0].composite, null); // nullable now, not a fake 0
    assert.equal(exps[0].degraded, true);
    assert.equal(exps[0].excludedRepeats, 2);
  });
  rmSync(root, { recursive: true, force: true });
});

test('server: /api/events is a read-only SSE stream that pushes on run change (S9)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-sse-'));
  const dataDir = seedData(root);
  await withServer(dataDir, async (base) => {
    // still read-only: non-GET is rejected before it can stream
    assert.equal((await fetch(`${base}/api/events`, { method: 'POST' })).status, 405);

    const controller = new AbortController();
    const resp = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.match(resp.headers.get('content-type'), /text\/event-stream/);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();

    // let the first poll prime (it must NOT emit for pre-existing files), then change a run file
    await new Promise(r => setTimeout(r, 700));
    writeFileSync(join(dataDir, 'runs', 'r1.json'), JSON.stringify({
      run: { id: 'r1', model: 'x', startedAt: '2026-07-02T10:00:00Z', meta: {}, parseWarnings: 0, rounds: [], sidechains: [] },
      metrics: { totals: { rounds: 3, sidechainRounds: 0, durationMs: 1, tokens: { in: 1, out: 1, cacheW: 0, cacheR: 0 }, costUsd: 0, toolErrors: 0 }, perSkill: {}, contextSeries: [], peakContext: 0, contextLimit: 200000 },
    }));

    let buf = '', got = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event: run\ndata: (\{[^\n]*\})/);
      if (m) { got = JSON.parse(m[1]); break; }
    }
    controller.abort();
    assert.ok(got, 'received a run SSE event');
    assert.equal(got.runId, 'r1');
  });
  rmSync(root, { recursive: true, force: true });
});

test('server: empty data dir returns empty collections, not errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-srv2-'));
  await withServer(join(root, 'nothing-here'), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), []);
    assert.deepEqual(await (await fetch(`${base}/api/experiments`)).json(), []);
  });
  rmSync(root, { recursive: true, force: true });
});
