// Adapter observability contract — Stage 3 (expstats engine + stats backfill) golden samples.
// Spec: docs/adapter-observability-design.md v6 §2 (provenance aggregation, M7 axesOmitted) +
// §3 consumer matrix rows: expstats refCoverage explicit 'adapter-declared' branch (top-level
// refMeta:null, per-row bytes:null + reason, no _shared semantics, no fall-through), expstats
// artifactReads ∪ declared blocked reads (F-2-31), bin/aiide.js stats backfill three-way
// decision (resolveBackfillInventory). Deterministic: injected run loaders + tmp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { refCoverage, buildExpStats, resolveBackfillInventory } from '../src/expstats.js';
import { buildRunFromTrace } from '../src/lab.js';

const BIN = fileURLToPath(new URL('../bin/aiide.js', import.meta.url));

// harness-shaped run (no source field → 'harness-observed'), same helper as upgrade-expstats
function fakeRun(id, { skills = [], reads = [] } = {}) {
  const toolCalls = [];
  for (const s of skills) toolCalls.push({ name: 'Skill', skill: s, input: { skill: s } });
  for (const r of reads) toolCalls.push({ name: 'Read', isError: false, result: 'x', input: { file_path: `/p/skills/${r}` } });
  return { id, sessionId: id, rounds: [{ seq: 1, toolCalls }] };
}
// adapter run (source:'adapter-trace' → 'adapter-reported', declared channels)
const traceRun = (id, trace) => buildRunFromTrace(trace, { model: 'm', id });

// ── refCoverage: explicit 'adapter-declared' branch (consumer-matrix row 1) ─────────────────────

test('refCoverage adapter-declared: 有分母（同 snapshot 骨架）；頂級 refMeta===null；行 bytes:null + reason adapter-declared', () => {
  const caseRecords = [
    { caseId: 'k1', triggerSet: ['s.a'], readCounts: { 's.a/references/seen.md': { runs: 2 } } },
  ];
  const res = refCoverage(caseRecords, {
    refInventory: { 's.a': { versionSha: 'aa', refs: ['s.a/references/seen.md', 's.a/references/never.md'] } },
    // 就算呼叫端誤傳了 refMeta，宣告制 bytes 也不可知——絕不 join（F-2-22）
    refMeta: { 's.a/references/seen.md': { bytes: 123, tokensEst: 30 } },
    inventoryStatus: 'adapter-declared',
  });
  assert.equal(res.inventoryStatus, 'adapter-declared');
  assert.equal(res.refMeta, null); // 頂級 null（不可知）——絕非 {}（假可知）
  const a = res.bySkill.find((x) => x.skill === 's.a');
  assert.equal(a.shipped, 2); // 宣告清單就是分母
  assert.equal(a.read, 1);
  assert.deepEqual(a.unreadRefs, ['s.a/references/never.md']);
  assert.deepEqual(a.refs.find((r) => r.ref === 's.a/references/seen.md'), {
    ref: 's.a/references/seen.md', bytes: null, reason: 'adapter-declared',
    readsRuns: 2, readsCases: 1, casesCoTriggered: 1, blocked: false,
  });
  for (const row of a.refs) {
    assert.equal(row.bytes, null);
    assert.equal(row.reason, 'adapter-declared');
  }
});

test('refCoverage adapter-declared: 清單中含 _shared/ 的 ref 行不套 shared-hash-namespace（宣告制無 _shared 語義，F-2-13）', () => {
  const res = refCoverage([], {
    refInventory: { 's.a': { versionSha: 'aa', refs: ['s.a/references/_shared/util.md'] } },
    inventoryStatus: 'adapter-declared',
  });
  const row = res.bySkill[0].refs[0];
  assert.equal(row.reason, 'adapter-declared'); // NOT 'shared-hash-namespace'
  assert.equal(row.bytes, null);
});

test('refCoverage 未知 inventoryStatus: 顯式降級（bySkill=null + reason unknown-inventory-status）——絕不靜默走 snapshot 分支', () => {
  const caseRecords = [{ caseId: 'k1', triggerSet: ['s.a'], readCounts: { 's.a/references/x.md': { runs: 1 } } }];
  const res = refCoverage(caseRecords, {
    refInventory: { 's.a': { versionSha: 'aa', refs: ['s.a/references/x.md'] } },
    inventoryStatus: 'weird-future-status',
  });
  assert.equal(res.inventoryStatus, 'weird-future-status'); // 原值封存，審計可見
  assert.equal(res.bySkill, null);                          // 不可知，非 snapshot 分母
  assert.equal(res.reason, 'unknown-inventory-status');
  assert.equal(res.refMeta, null);
  assert.ok(res.readCounts['s.a/references/x.md'], '觀測面 readCounts 照舊');
});

// ── buildExpStats: declared blocked reads join the artifactReads exemption (F-2-31) ─────────────

test('buildExpStats: 宣告 blocked read 併入 artifactReads 豁免——不入 unreadRefs、行 blocked:true；真死重仍在列', () => {
  const run = traceRun('ar1', [{
    triggers: ['s.a'],
    refReads: [
      { skill: 's.a', ref: 's.a/references/open.md', status: 'ok' },
      { skill: 's.a', ref: 's.a/references/walled.md', status: 'blocked' },
    ],
  }]);
  const stats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: 'ar1' }] } },
    runsDir: (id) => (id === 'ar1' ? run : null),
    installedSkills: ['s.a'],
    refInventory: { 's.a': { versionSha: 'v', refs: ['s.a/references/open.md', 's.a/references/walled.md', 's.a/references/dead.md'] } },
    inventoryStatus: 'adapter-declared', probes: [],
  });
  const rc = stats.refCoverage;
  assert.deepEqual(rc.artifactOnlyRefs, ['s.a/references/walled.md']); // 豁免通道命中
  const a = rc.bySkill.find((x) => x.skill === 's.a');
  assert.deepEqual(a.unreadRefs, ['s.a/references/dead.md']);          // blocked 豁免；dead 誠實保留
  assert.equal(a.refs.find((r) => r.ref === 's.a/references/walled.md').blocked, true);
  assert.equal(a.refs.find((r) => r.ref === 's.a/references/open.md').blocked, false);
});

// ── buildExpStats: experiment-level provenance (§2 — f(run.source), aggregated) ────────────────

test('stats.provenance: 全 adapter 運行 → adapter-reported；全 harness → harness-observed；無 valid run → null', () => {
  const adapterRun = traceRun('a1', [{ triggers: ['s.a'] }]);
  const adapterStats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: 'a1' }] } },
    runsDir: (id) => (id === 'a1' ? adapterRun : null),
    installedSkills: ['s.a'], refInventory: {}, inventoryStatus: 'external-runtime', probes: [],
  });
  assert.equal(adapterStats.provenance, 'adapter-reported');
  assert.deepEqual(adapterStats.warnings, []); // 單一 runtime → 無異常

  const ccRun = fakeRun('h1', { skills: ['s.a'] });
  const ccStats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: 'h1' }] } },
    runsDir: (id) => (id === 'h1' ? ccRun : null),
    installedSkills: ['s.a'], refInventory: {}, probes: [],
  });
  assert.equal(ccStats.provenance, 'harness-observed');
  assert.deepEqual(ccStats.warnings, []);

  // noSession-only：無 session record 可聚合 → null（不可知，絕不編一個預設值）
  const emptyStats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: null }] } },
    runsDir: () => null, installedSkills: ['s.a'], refInventory: {}, probes: [],
  });
  assert.equal(emptyStats.provenance, null);
});

test('stats.provenance 混合出現 = 異常 → 取 adapter-reported + stats warning', () => {
  const runs = { a1: traceRun('a1', [{ triggers: ['s.a'] }]), h1: fakeRun('h1', { skills: ['s.a'] }) };
  const stats = buildExpStats({
    tasks: {
      c1: { expected_skill: 's.a', reps: [{ runId: 'a1' }] },
      c2: { expected_skill: 's.a', reps: [{ runId: 'h1' }] },
    },
    runsDir: (id) => runs[id] ?? null,
    installedSkills: ['s.a'], refInventory: {}, inventoryStatus: 'external-runtime', probes: [],
  });
  assert.equal(stats.provenance, 'adapter-reported');
  assert.equal(stats.warnings.length, 1);
  assert.match(stats.warnings[0], /mixed run provenance/);
  assert.match(stats.warnings[0], /adapter-reported/);
});

// ── buildExpStats: M7 proximity.axesOmitted (§2 — declared events have no ordinal) ─────────────

test('axesOmitted: 宣告-only adapter 實驗 → skill/ref 兩軸都標（訊號存在但全無 ordinal）', () => {
  const run = traceRun('a1', [{
    triggers: ['s.a'],
    refReads: [{ skill: 's.a', ref: 's.a/references/x.md' }],
  }]);
  const stats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: 'a1' }] } },
    runsDir: (id) => (id === 'a1' ? run : null),
    installedSkills: ['s.a'], refInventory: {}, inventoryStatus: 'external-runtime', probes: [],
  });
  assert.deepEqual(stats.proximity.axesOmitted, [
    { axis: 'skill', reason: 'declared-events-have-no-ordinal' },
    { axis: 'ref', reason: 'declared-events-have-no-ordinal' },
  ]);
  assert.deepEqual(stats.proximity.edges, []); // 宣告事件絕不合成 ordinal 進事件軸
});

test('axesOmitted 兩軸獨立: 有工具事實 Skill call 的 adapter 實驗 skill 軸不標；純工具事實實驗 → []（形狀鎖定：恆為陣列）', () => {
  // adapter run：Skill 是工具事實（有 ordinal），讀取只有宣告 → 只標 ref 軸
  const mixed = traceRun('a1', [{
    toolCalls: [{ name: 'Skill', skill: 's.a', input: { skill: 's.a' } }],
    refReads: [{ skill: 's.a', ref: 's.a/references/x.md' }],
  }]);
  const mixedStats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: 'a1' }] } },
    runsDir: (id) => (id === 'a1' ? mixed : null),
    installedSkills: ['s.a'], refInventory: {}, inventoryStatus: 'external-runtime', probes: [],
  });
  assert.deepEqual(mixedStats.proximity.axesOmitted, [{ axis: 'ref', reason: 'declared-events-have-no-ordinal' }]);

  // 純工具事實（claude-code 形）→ 空陣列（不是 undefined——一致形狀，測試鎖定）
  const cc = fakeRun('h1', { skills: ['s.a'], reads: ['s.a/references/x.md'] });
  const ccStats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: 'h1' }] } },
    runsDir: (id) => (id === 'h1' ? cc : null),
    installedSkills: ['s.a'], refInventory: { 's.a': { versionSha: 'v', refs: ['s.a/references/x.md'] } }, probes: [],
  });
  assert.deepEqual(ccStats.proximity.axesOmitted, []);
});

// ── stats backfill three-way decision (consumer-matrix bin/aiide.js row) ───────────────────────

test('resolveBackfillInventory 三段判定: skillsInventory 非空 → adapter-declared；否則非 claude-code → external-runtime；否則 none-backfill', () => {
  const withInv = resolveBackfillInventory({
    runtime: 'obs-stub',
    environment: { skillsInventory: { 's.a': { versionSha: 'v1', refs: ['s.a/references/b.md', 's.a/references/a.md'] } } },
  });
  assert.equal(withInv.inventoryStatus, 'adapter-declared');
  // 清單同構轉換（sanitized + refs 排序）——與 seal 路徑共用同一 toRefInventory
  assert.deepEqual(withInv.refInventory, { 's.a': { versionSha: 'v1', refs: ['s.a/references/a.md', 's.a/references/b.md'] } });

  assert.deepEqual(resolveBackfillInventory({ runtime: 'openai-adapter', environment: {} }),
    { inventoryStatus: 'external-runtime', refInventory: {} });
  assert.deepEqual(resolveBackfillInventory({ runtime: 'claude-code' }),
    { inventoryStatus: 'none-backfill', refInventory: {} });
  // 空清單 = 無可用宣告 → 不走 adapter-declared（非 claude-code 落 external-runtime）
  assert.equal(resolveBackfillInventory({ runtime: 'obs-stub', environment: { skillsInventory: {} } }).inventoryStatus,
    'external-runtime');
});

test('aiide stats 回填 e2e: environment.skillsInventory 非空 → adapter-declared 分母 + refMeta null + provenance + axesOmitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiide-s3-'));
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const run = traceRun('AR1', [{
    triggers: ['okx-dex-market'],
    refReads: [{ skill: 'okx-dex-market', ref: 'okx-dex-market/references/api.md' }],
  }]);
  writeFileSync(join(dir, 'runs', 'AR1.json'), JSON.stringify({ run, metrics: {} }));
  mkdirSync(join(dir, 'experiments'), { recursive: true });
  writeFileSync(join(dir, 'experiments', 'exp-decl.json'), JSON.stringify({
    id: 'exp-decl', suiteName: 's', model: 'sonnet', repeats: 1, runtime: 'obs-stub',
    environment: { skillsInventory: { 'okx-dex-market': { versionSha: 'v1', refs: ['okx-dex-market/references/api.md', 'okx-dex-market/references/limits.md'] } } },
    profile: { dir: null, skills: [] },
    tasks: { eth: { repeats: [{ runId: 'AR1', C: 1, excluded: false }], expected_skill: 'okx-dex-market' } },
    summary: {},
  }));
  const out = JSON.parse(execFileSync(process.execPath, [BIN, 'stats', 'exp-decl', '--data-dir', dir], { encoding: 'utf8', stdio: 'pipe' }));
  const rc = out.stats.refCoverage;
  assert.equal(rc.inventoryStatus, 'adapter-declared');
  assert.equal(rc.refMeta, null);
  assert.equal(rc.bySkill.length, 1);
  assert.equal(rc.bySkill[0].shipped, 2); // hoisted 封存副本就是回填分母（F-2-18）
  assert.equal(rc.bySkill[0].read, 1);
  assert.deepEqual(rc.bySkill[0].unreadRefs, ['okx-dex-market/references/limits.md']);
  assert.ok(rc.bySkill[0].refs.every((r) => r.bytes === null && r.reason === 'adapter-declared'));
  assert.equal(out.stats.provenance, 'adapter-reported');
  assert.deepEqual(out.stats.proximity.axesOmitted, [
    { axis: 'skill', reason: 'declared-events-have-no-ordinal' },
    { axis: 'ref', reason: 'declared-events-have-no-ordinal' },
  ]);
  assert.ok(out.warnings.some((w) => /adapter-declared inventory/.test(w)));
  rmSync(dir, { recursive: true, force: true });
});
