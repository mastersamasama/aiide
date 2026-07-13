// Observability taxonomy T1 Stage 3 — expstats schemaVersion 3 golden samples.
// Spec: docs/observability-taxonomy.md §3.0 (null trigger table — acceptance clauses, asserted
// row by row), §3.1 (contextComposition aggregation semantics), §3.5 (cacheHitRate / selfReport /
// sidechainShare / statsHealth). Deterministic: injected run loaders only, no disk, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExpStats, runContextComposition, computeContextComposition, computeCacheHitRate,
  computeSelfReport, computeSidechainShare, computeStatsHealth,
  computeToolUsage, computeTruncation, computeFileTargets, classifyFileTarget,
  inferToolKind, mcpServerOf, BUILTIN_ALLOWLIST_VERSION,
} from '../src/expstats.js';
import { computeRunItems } from '../web/obs.js';
import { buildRunFromTrace } from '../src/lab.js';
import { extractTriggers } from '../src/parser.js';
import { gradeSafety, isConfirmTurn } from '../src/score.js';
import { checkAdapterOutput } from '../src/adaptercheck.js';

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

// claude-code-shaped round (parser shape: usage object always present, footprint = in+cacheR+cacheW)
const R = (seq, ts, { fp = 0, usage = { in: 0, out: 0, cacheW: 0, cacheR: 0 }, toolResults = [], compactBefore = false } = {}) => ({
  seq, ts, contextFootprint: fp, usage,
  toolCalls: toolResults.map((res, i) => ({ name: 'T' + i, result: res })),
  ...(compactBefore ? { compactBefore: true } : {}),
});
const EV = (ts, chars, srcKind) => ({ ts, text: 'x'.repeat(chars), chars, kind: 'user', srcKind });

// tagged (new-parser) run — userEventsTagVersion is the run-level parse-time tag (r5 F-5-01)
function taggedRun(id, { rounds = [], userEvents = [], sidechains = [], selfReports = null, parseWarnings = 0 } = {}) {
  return {
    id, sessionId: id, userEventsTagVersion: 1,
    rounds, userEvents, sidechains, parseWarnings,
    ...(selfReports ? { selfReports } : {}),
  };
}

// The compaction golden run (hand-computed, every number below derives from these values):
//   r1 t0 fp1000 out100 toolResult 400 chars   → baseline = 1000
//   r2 t2 fp2000 out50; events between t0..t2: user 400 / attachment 200 / skill-body 1200 chars
//        _attr: prevOut 100, toolRes 100, injectedUser 100, injectedHarness 50, skillBody 300,
//        delta 1000 → other +350
//   r3 t4 fp1500 compactBefore: _attr prevOut 50, delta −500 → other −550 (compaction-confirmed)
// per-run: positive = {prevOut 150, toolRes 100, injectedUser 100, injectedHarness 50,
// skillBody 300, residualPos 350}; denominator = 1000 + 1050 = 2050; compactionAbs = 550;
// peakFootprint = 1500. cacheR/fp per round: 0, 1000/2000, 1000/1500 → run mean 0.3889.
function goldenRun(id = 'A') {
  return taggedRun(id, {
    rounds: [
      R(1, '2026-01-01T00:00:00Z', { fp: 1000, usage: { in: 1000, out: 100, cacheW: 0, cacheR: 0 }, toolResults: ['r'.repeat(400)] }),
      R(2, '2026-01-01T00:02:00Z', { fp: 2000, usage: { in: 500, out: 50, cacheW: 500, cacheR: 1000 } }),
      R(3, '2026-01-01T00:04:00Z', { fp: 1500, usage: { in: 100, out: 10, cacheW: 400, cacheR: 1000 }, compactBefore: true }),
    ],
    userEvents: [
      EV('2026-01-01T00:01:00Z', 400, 'user'),
      EV('2026-01-01T00:01:10Z', 200, 'attachment'),
      EV('2026-01-01T00:01:20Z', 1200, 'skill-body'),
    ],
    sidechains: [{ agentId: 'ag1', rounds: [{ seq: 1, usage: { in: 100, out: 20, cacheW: 0, cacheR: 0 }, contextFootprint: 100, toolCalls: [{ name: 'X' }] }] }],
  });
}

// legacy (old-parser) run — NO userEventsTagVersion; per the r5 F-5-01 fixture spec it carries a
// kind:'user' event whose text is system-reminder mixed text (the value 'user' sits INSIDE the
// five-class domain, so only the run-level tag absence is structurally detectable).
function legacyRun(id = 'L') {
  return {
    id, sessionId: id,
    rounds: [
      R(1, '2026-01-01T00:00:00Z', { fp: 1000, usage: { in: 1000, out: 10, cacheW: 0, cacheR: 0 } }),
      R(2, '2026-01-01T00:02:00Z', { fp: 1400, usage: { in: 1400, out: 10, cacheW: 0, cacheR: 0 } }),
    ],
    userEvents: [{ ts: '2026-01-01T00:01:00Z', text: '<system-reminder>' + 'x'.repeat(183), chars: 200, kind: 'user' }],
    sidechains: [], parseWarnings: 0,
  };
}

const loader = (runs) => (id) => runs[id] ?? null;
const vb = (...entries) => entries; // hand-built valid bucket: [{ taskId, repeat, runIds, runs }]

// ── §3.0 null trigger table — row by row ───────────────────────────────────────────────────────

test('§3.0 adapter runtime: contextComposition null (no-user-events-channel) + sidechainShare null (no-sidechain-channel) — sidechains:[] never becomes a 0', () => {
  const run = buildRunFromTrace([{ toolCalls: [{ name: 'Skill', skill: 's.a', input: { skill: 's.a' } }] }], { model: 'm', id: 'AR1' });
  assert.deepEqual(run.sidechains, []); // structural adapter constant — precisely why the gate exists
  const stats = buildExpStats({
    tasks: { c1: { expected_skill: 's.a', reps: [{ runId: 'AR1' }] } },
    runsDir: loader({ AR1: run }), installedSkills: ['s.a'],
    refInventory: {}, inventoryStatus: 'external-runtime', probes: [],
    runtime: 'obs-stub',
  });
  assert.equal(stats.schemaVersion, 3);
  assert.deepEqual(stats.contextComposition, { value: null, reason: 'no-user-events-channel' });
  assert.deepEqual(stats.sidechainShare, { value: null, reason: 'no-sidechain-channel' });
  // adapter trace rounds with no usage → cacheHitRate has no denominator anywhere → null
  assert.equal(stats.cacheHitRate.value, null);
  assert.equal(stats.cacheHitRate.reason, 'no-usage');
  // adapter runs never carry result-line records → selfReport null, never 0
  assert.deepEqual(stats.selfReport, { value: null, reason: 'no-result-lines' });
});

test('§3.0 runtime undefined = conservative non-claude-code: both gated sections stay null', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'A' }] } },
    runsDir: loader({ A: goldenRun('A') }), installedSkills: [], refInventory: {}, probes: [],
    // no runtime passed at all
  });
  assert.deepEqual(stats.contextComposition, { value: null, reason: 'no-user-events-channel' });
  assert.deepEqual(stats.sidechainShare, { value: null, reason: 'no-sidechain-channel' });
});

test('§3.0 untagged legacy run: ALL runs untagged → whole section null (untagged-legacy-run); the system-reminder user event is never fake-split', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'L' }] } },
    runsDir: loader({ L: legacyRun('L') }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  // deepEqual pins the WHOLE shape: no shares/buckets exist — the merged-bucket numbers are
  // never backfilled into the five-class section (§3.0 r4 F-4-01)
  assert.deepEqual(stats.contextComposition, { value: null, reason: 'untagged-legacy-run', untaggedLegacyRuns: 1 });
});

test('§3.0 mixed tagged + untagged: tagged run aggregates, untagged run skipped + disclosed', () => {
  const stats = buildExpStats({
    tasks: {
      c1: { reps: [{ runId: 'A' }] },
      c2: { reps: [{ runId: 'L' }] },
    },
    runsDir: loader({ A: goldenRun('A'), L: legacyRun('L') }),
    installedSkills: [], refInventory: {}, probes: [], runtime: 'claude-code',
  });
  const cc = stats.contextComposition;
  assert.equal(cc.n, 1);                       // only the tagged run enters the aggregation
  assert.equal(cc.untaggedLegacyRuns, 1);      // the legacy run is disclosed, not silently dropped
  assert.equal(cc.estimate, true);
});

test('§3.0 selfReport: no run carries result-line records → null (no-result-lines) — legacy archives are ALWAYS null, never 0', () => {
  const out = computeSelfReport(vb({ taskId: 't', repeat: 0, runIds: ['L'], runs: [legacyRun('L')] }));
  assert.deepEqual(out, { value: null, reason: 'no-result-lines' });
});

test('§3.0 timeoutRate: legacy rep (no structured field, error string "timeout") → legacyUnknown disclosure, NEVER counted as 0 or string-backfilled', () => {
  const tasks = {
    t1: {
      reps: [
        { runId: 'A', C: 1 },                                   // knowable non-timeout
        { runId: null, C: 0, error: 'timeout' },                // LEGACY shape → unknowable
        { runId: null, C: 0, error: 'timeout', timedOut: true },// structured timeout
      ],
    },
  };
  const sh = computeStatsHealth(tasks, []);
  assert.deepEqual(sh.timeoutRate, { timedOut: 1, n: 2, rate: 0.5, legacyUnknown: 1 });
  // the legacy rep is in NEITHER numerator nor denominator: 1/2, not 1/3 and not 2/3
});

// ── §3.1 contextComposition — compaction run: Σ shares = 100%, compaction independent ──────────

test('§3.1 per-run: positive-bucket shares sum to exactly 100% of (baseline + Σ positive); compaction rides as an independent field', () => {
  const rc = runContextComposition(goldenRun('A'));
  assert.equal(rc.baseline, 1000);
  assert.deepEqual(rc.positive, { prevOut: 150, toolRes: 100, injectedUser: 100, injectedHarness: 50, skillBody: 300, residualPos: 350 });
  assert.equal(rc.denominator, 2050);
  const sum = Object.values(rc.shares).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `Σ shares must be 1, got ${sum}`);
  // compaction: |negative residual| Σ — absolute + ratio to the SAME denominator, never a numerator
  assert.equal(rc.compaction.absolute, 550);
  assert.ok(Math.abs(rc.compaction.shareOfDenominator - 550 / 2050) < 1e-9);
  assert.equal(rc.peakFootprint, 1500);       // final main-round footprint, its own peak field
  assert.equal(rc.skippedRounds, 0);
});

test('§3.1 experiment level: mean shares, compaction disclosure, peak field, max-contribution run, estimate flag', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'A' }] } },
    runsDir: loader({ A: goldenRun('A') }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  const cc = stats.contextComposition;
  assert.equal(cc.estimate, true);            // toolRes/injected*/skillBody are chars/4 estimates
  assert.equal(cc.n, 1);
  assert.deepEqual(cc.shares.baseline, { mean: 0.4878, min: 0.4878, max: 0.4878 });
  assert.deepEqual(cc.shares.prevOut, { mean: 0.0732, min: 0.0732, max: 0.0732 });
  assert.deepEqual(cc.shares.toolRes, { mean: 0.0488, min: 0.0488, max: 0.0488 });
  assert.deepEqual(cc.shares.injectedUser, { mean: 0.0488, min: 0.0488, max: 0.0488 });
  assert.deepEqual(cc.shares.injectedHarness, { mean: 0.0244, min: 0.0244, max: 0.0244 });
  assert.deepEqual(cc.shares.skillBody, { mean: 0.1463, min: 0.1463, max: 0.1463 });
  assert.deepEqual(cc.shares.residualPos, { mean: 0.1707, min: 0.1707, max: 0.1707 });
  const meanSum = Object.values(cc.shares).reduce((a, s) => a + s.mean, 0);
  assert.ok(Math.abs(meanSum - 1) < 2e-3, `rounded share means ≈ 100%, got ${meanSum}`);
  assert.deepEqual(cc.compaction, {
    runsWithCompaction: 1,
    absolute: { mean: 550, min: 550, max: 550 },
    shareOfDenominator: { mean: 0.2683, min: 0.2683, max: 0.2683 },
  });
  assert.deepEqual(cc.peakFootprint, { mean: 1500, min: 1500, max: 1500 });
  assert.deepEqual(cc.maxContribution, { runId: 'A', denominator: 2050 });
});

test('§3.1 skip rules: footprint-0 rounds skipped + disclosed; zero final footprint skips the whole run + disclosed', () => {
  // a tagged run whose round 2 lost its usage line (fp 0) — round skipped, run still aggregates
  const holed = taggedRun('H', {
    rounds: [
      R(1, 't0', { fp: 1000, usage: { in: 1000, out: 10, cacheW: 0, cacheR: 0 } }),
      R(2, 't1', { fp: 0 }),
      R(3, 't2', { fp: 1200, usage: { in: 1200, out: 10, cacheW: 0, cacheR: 0 } }),
    ],
  });
  const rc = runContextComposition(holed);
  assert.equal(rc.skippedRounds, 1);
  assert.equal(rc.baseline, 1000);

  // a tagged run whose FINAL main round has no footprint → no denominator → run skipped
  const dead = taggedRun('D', { rounds: [R(1, 't0', { fp: 1000, usage: { in: 1000, out: 1, cacheW: 0, cacheR: 0 } }), R(2, 't1', { fp: 0 })] });
  assert.deepEqual(runContextComposition(dead), { skipped: 'zero-final-footprint' });
  const section = computeContextComposition(
    vb({ taskId: 't', repeat: 0, runIds: ['D'], runs: [dead] }), { runtime: 'claude-code' });
  assert.deepEqual(section, { value: null, reason: 'no-aggregatable-runs', untaggedLegacyRuns: 0, zeroFootprintRuns: 1 });
});

// ── §3.1(c) identity golden sample: computeRunItems is the ONE bucket source ───────────────────

test('§3.1 identity: Σ(run-detail per-round buckets) === expstats per-run contribution (same producer, pinned)', () => {
  // dashboard side: raw computeRunItems over an identical clone
  const clone = goldenRun('A');
  computeRunItems(clone);
  const dash = { prevOut: 0, toolRes: 0, injectedUser: 0, injectedHarness: 0, skillBody: 0, residualPos: 0 };
  let dashCompaction = 0;
  for (const r of clone.rounds) {
    const a = r._attr;
    if (!a) continue;
    dash.prevOut += Math.max(0, a.prevOut);
    dash.toolRes += Math.max(0, a.toolRes);
    dash.injectedUser += Math.max(0, a.injectedUser);
    dash.injectedHarness += Math.max(0, a.injectedHarness);
    dash.skillBody += Math.max(0, a.skillBody);
    dash.residualPos += Math.max(0, a.other);
    dashCompaction += Math.max(0, -a.other);
  }
  // expstats side
  const rc = runContextComposition(goldenRun('A'));
  assert.deepEqual(rc.positive, dash);
  assert.equal(rc.compaction.absolute, dashCompaction);
  assert.equal(rc.denominator, clone.rounds[0].contextFootprint + Object.values(dash).reduce((a, b) => a + b, 0));
  // and the confirmed-compaction label came through the shared producer too
  assert.equal(clone.rounds[2]._attr.compactionKind, 'confirmed');
});

// ── §3.5 cacheHitRate ───────────────────────────────────────────────────────────────────────────

test('§3.5 cacheHitRate: golden value + footprint-0/null-usage rounds excluded from BOTH sides + disclosed', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'A' }] } },
    runsDir: loader({ A: goldenRun('A') }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  // per-round: 0/1000, 1000/2000, 1000/1500 → run mean (0 + 0.5 + 0.6667)/3 = 0.3889
  assert.equal(stats.cacheHitRate.n, 1);
  assert.equal(stats.cacheHitRate.mean, 0.3889);
  assert.equal(stats.cacheHitRate.skippedRounds, 0);

  // zero-defence: fp-0 and usage-null rounds never fabricate a 0 ratio
  const zr = {
    id: 'Z', rounds: [
      R(1, 't0', { fp: 1000, usage: { in: 500, out: 1, cacheW: 0, cacheR: 500 } }), // 0.5
      R(2, 't1', { fp: 0, usage: { in: 0, out: 0, cacheW: 0, cacheR: 0 } }),        // no denominator
      { seq: 3, ts: 't2', contextFootprint: null, usage: null, toolCalls: [] },     // adapter-shaped null usage
      R(4, 't3', { fp: 2000, usage: { in: 1000, out: 1, cacheW: 0, cacheR: 1000 } }), // 0.5
    ], userEvents: [], sidechains: [], parseWarnings: 0,
  };
  const out = computeCacheHitRate(vb({ taskId: 't', repeat: 0, runIds: ['Z'], runs: [zr] }));
  assert.equal(out.mean, 0.5);
  assert.equal(out.skippedRounds, 2);

  // usage absent EVERYWHERE → section null, disclosure rides along
  const nu = { id: 'N', rounds: [{ seq: 1, ts: 't', contextFootprint: null, usage: null, toolCalls: [] }], userEvents: [], sidechains: [], parseWarnings: 0 };
  assert.deepEqual(computeCacheHitRate(vb({ taskId: 't', repeat: 0, runIds: ['N'], runs: [nu] })),
    { value: null, reason: 'no-usage', skippedRounds: 1 });
});

test('§3.5 cacheHitRate byRepeat: repeat-order descriptive table (1-based), descriptive not causal', () => {
  const runOf = (id, cacheR, fp) => ({
    id, rounds: [R(1, 't0', { fp, usage: { in: fp - cacheR, out: 1, cacheW: 0, cacheR } })],
    userEvents: [], sidechains: [], parseWarnings: 0,
  });
  const out = computeCacheHitRate(vb(
    { taskId: 't', repeat: 0, runIds: ['r0'], runs: [runOf('r0', 200, 1000)] },  // 0.2 (cold)
    { taskId: 't', repeat: 1, runIds: ['r1'], runs: [runOf('r1', 600, 1000)] },  // 0.6 (warm)
  ));
  assert.deepEqual(out.byRepeat, [
    { repeat: 1, meanCacheR: 0.2, n: 1 },
    { repeat: 2, meanCacheR: 0.6, n: 1 },
  ]);
  assert.equal(out.mean, 0.4);
  assert.equal(out.min, 0.2);
  assert.equal(out.max, 0.6);
});

// ── §3.5 selfReport — multi-result-line Σ semantics ────────────────────────────────────────────

test('§3.5 selfReport: per-run Σ over result lines (never last-win/first-win), in-field nulls skipped not zeroed, runs without the field stay out of Σ', () => {
  const sa = taggedRun('SA', {
    rounds: [R(1, 't0', { fp: 100, usage: { in: 100, out: 1, cacheW: 0, cacheR: 0 } })],
    selfReports: [
      { total_cost_usd: 0.5, num_turns: 3, duration_ms: 1000, is_error: false },
      { total_cost_usd: 0.25, num_turns: null, duration_ms: 500, is_error: null }, // resume increment, holes stay holes
    ],
  });
  const sb = legacyRun('SB'); // no selfReports field at all → no channel → not in Σ
  const sc = taggedRun('SC', {
    rounds: [R(1, 't0', { fp: 100, usage: { in: 100, out: 1, cacheW: 0, cacheR: 0 } })],
    selfReports: [{ total_cost_usd: null, num_turns: null, duration_ms: null, is_error: null }],
  });
  const out = computeSelfReport(vb(
    { taskId: 't1', repeat: 0, runIds: ['SA'], runs: [sa] },
    { taskId: 't2', repeat: 0, runIds: ['SB'], runs: [sb] },
    { taskId: 't3', repeat: 0, runIds: ['SC'], runs: [sc] },
  ));
  assert.equal(out.runsWithSelfReport, 2);   // SA + SC (SB has no channel)
  assert.equal(out.invocations, 3);          // 2 + 1 result lines
  assert.equal(out.total_cost_usd, 0.75);    // Σ non-null; SC's all-null run contributes nothing
  assert.equal(out.num_turns, 3);            // null line skipped, not zero-added
  assert.equal(out.duration_ms, 1500);
  assert.equal(out.is_error, false);         // any-semantics over non-null values
});

// ── §3.5 sidechainShare — equivTokens value lock ───────────────────────────────────────────────

test('§3.5 sidechainShare: tokens/toolCalls from run.sidechains; cost-magnitude share via equivTokens constant weights (values pinned)', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'A' }] } },
    runsDir: loader({ A: goldenRun('A') }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  const s = stats.sidechainShare;
  assert.equal(s.n, 1);
  assert.equal(s.runsWithSidechain, 1);
  // raw tokens: main 1100 + 2050 + 1510 = 4660; side 120; total 4780
  assert.deepEqual(s.tokens, { sidechain: 120, total: 4780, share: 0.0251 });
  // toolCalls: main 1 (r1) + side 1 = 2
  assert.deepEqual(s.toolCalls, { sidechain: 1, total: 2, share: 0.5 });
  // equivTokens (weights 1/5/0.1/1.25): main 1500 + 1475 + 750 = 3725; side 100·1 + 20·5 = 200
  assert.deepEqual(s.equivTokens, { sidechain: 200, total: 3925, share: 0.051 });
});

test('§3.5 sidechainShare: claude-code with NO sidechains → knowable-and-empty 0 (not null)', () => {
  const run = taggedRun('M', { rounds: [R(1, 't0', { fp: 1000, usage: { in: 1000, out: 10, cacheW: 0, cacheR: 0 } })] });
  const s = computeSidechainShare(vb({ taskId: 't', repeat: 0, runIds: ['M'], runs: [run] }), { runtime: 'claude-code' });
  assert.equal(s.runsWithSidechain, 0);
  assert.equal(s.tokens.share, 0);
  assert.equal(s.toolCalls.share, null); // 0 tool calls anywhere → 0/0 unknowable → null, never 0
  assert.equal(s.equivTokens.share, 0);
});

// ── §3.5 statsHealth ────────────────────────────────────────────────────────────────────────────

test('§3.5 statsHealth: exclusionBreakdown / abortedAtStep / parseWarnings / timeoutRate / retriedThenSucceeded / verifier-fail top list', () => {
  const runA = { ...legacyRun('A'), parseWarnings: 3 };
  const runB = { ...legacyRun('B'), parseWarnings: 2 };
  const stats = buildExpStats({
    tasks: {
      t1: {
        reps: [
          { // env-noise retry that recovered — the pre-success failure now leaves a trace
            runId: 'A', C: 1, retries: [{ attempt: 1, signature: 'rate-limit-429', backoffMs: 500 }],
            verifierResults: [{ type: 'regex', pass: false, detail: 'regex ETH' }],
          },
          { runId: null, C: 0, error: 'timeout' },                          // legacy timeout → unknowable
          { runId: null, C: 0, error: 'timeout', timedOut: true },          // structured timeout
          { runId: null, C: 0, excluded: true, excludedSignature: 'rate-limit-429' },
          {
            runId: 'B', C: 0, abortedAtStep: 2,
            verifierResults: [
              { type: 'numeric_range', pass: false, detail: 'numeric in [1, 2] (saw 5)' },
              { type: 'numeric_range', pass: true, detail: 'numeric in [3, 4] → 3.5' },
            ],
          },
        ],
      },
      t2: {
        reps: [{
          runId: 'A', C: 1,
          verifierResults: [{ type: 'numeric_range', pass: false, detail: 'numeric in [1, 2] (saw 9)' }],
        }],
      },
      h: { held_out: true, reps: [{ runId: null, excluded: true, excludedSignature: 'never-counted' }] },
    },
    runsDir: loader({ A: runA, B: runB }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  const sh = stats.statsHealth;
  assert.deepEqual(sh.exclusionBreakdown, { 'rate-limit-429': 1 });   // held-out excluded rep NOT counted
  assert.deepEqual(sh.abortedAtStep, { 2: 1 });
  // Σ parseWarnings over VALID runs: A loaded for t1-rep0 and t2-rep0 (3+3) + B (2) = 8
  assert.equal(sh.parseWarningsTotal, 8);
  assert.deepEqual(sh.timeoutRate, { timedOut: 1, n: 5, rate: 0.2, legacyUnknown: 1 });
  assert.equal(sh.retriedThenSucceeded, 1);   // retries present AND C===1 (the excluded rep has no retries)
  // fail distribution: the run-specific '(saw …)' suffix is stripped so ONE verifier aggregates
  assert.deepEqual(sh.verifierFails, [
    { verifier: 'numeric_range: numeric in [1, 2]', fails: 2 },
    { verifier: 'regex: regex ETH', fails: 1 },
  ]);
});

test('§3.5 statsHealth: empty distributions are knowably empty {} — never null, never fabricated', () => {
  const sh = computeStatsHealth({ t1: { reps: [{ runId: 'A', C: 1 }] } }, []);
  assert.deepEqual(sh.exclusionBreakdown, {});
  assert.deepEqual(sh.abortedAtStep, {});
  assert.equal(sh.parseWarningsTotal, 0);
  assert.deepEqual(sh.verifierFails, []);
  assert.equal(sh.retriedThenSucceeded, 0);
  assert.deepEqual(sh.timeoutRate, { timedOut: 0, n: 1, rate: 0, legacyUnknown: 0 });
});

// ── schemaVersion + section presence ───────────────────────────────────────────────────────────

test('schemaVersion 3: all eight taxonomy sections (§3.0 verbatim closed set) are present on every build (null-shaped when unknowable)', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'A' }] } },
    runsDir: loader({ A: goldenRun('A') }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  assert.equal(stats.schemaVersion, 3);
  for (const key of ['contextComposition', 'toolUsage', 'truncation', 'fileTargets',
    'cacheHitRate', 'selfReport', 'sidechainShare', 'statsHealth']) {
    assert.ok(key in stats, `stats.${key} present`);
  }
  // this claude-code experiment: composition/cache/sidechain live, selfReport honestly null
  assert.equal(stats.contextComposition.estimate, true);
  assert.equal(stats.selfReport.value, null);
  assert.equal(stats.selfReport.reason, 'no-result-lines');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Stage 4 — §3.2 toolUsage / §3.3 truncation / §3.4 fileTargets + a1 amendment (stopReason/kind)
// ════════════════════════════════════════════════════════════════════════════════════════════════

// parser-shaped tool call (classifyToolResult reads denialKind / isError / result)
const TC = (name, extra = {}) => ({
  name, id: null, isError: false, skill: null, input: null, result: null, denialKind: null, ...extra,
});
const U = (n) => ({ in: n, out: 1, cacheW: 0, cacheR: 0 });

// ── §3.2 toolUsage ──────────────────────────────────────────────────────────────────────────────

test('§3.2 kind inference: priority order + versioned allowlist as the ONLY builtin source', () => {
  assert.equal(inferToolKind('Skill'), 'skill');
  assert.equal(inferToolKind('Task'), 'agent');
  assert.equal(inferToolKind('Agent'), 'agent');
  assert.equal(inferToolKind('mcp__deepwiki__ask_question'), 'mcp');
  assert.equal(inferToolKind('Read'), 'builtin');
  assert.equal(inferToolKind('NotebookEdit'), 'builtin');
  assert.equal(inferToolKind('FooBar'), 'other');
  // golden underscore split: server names contain single underscores/dashes — only the LAST '__'
  // separates the tool suffix
  assert.equal(mcpServerOf('mcp__plugin_oki-team_oki-team__kanban_ops'), 'plugin_oki-team_oki-team');
  assert.equal(mcpServerOf('mcp__deepwiki__ask_question'), 'deepwiki');
});

function toolRun(id) {
  return taggedRun(id, {
    rounds: [
      { seq: 1, ts: 't0', contextFootprint: 1000, usage: U(1000), stopReason: null, toolCalls: [
        TC('Skill', { skill: 'alpha', input: { skill: 'alpha' } }),
        TC('Read', { input: { file_path: 'D:\\ws\\a.md' } }),                                  // success
        TC('mcp__plugin_oki-team_oki-team__kanban_ops', { result: 'ok' }),                     // success
        TC('mcp__plugin_oki-team_oki-team__kanban_ops', { denialKind: 'user-rejected' }),      // denial
        TC('mcp__deepwiki__ask_question', { isError: true, result: 'boom' }),                  // error
      ] },
      { seq: 2, ts: 't1', contextFootprint: 1100, usage: U(1100), stopReason: null, toolCalls: [
        TC('Skill', { skill: 'beta', input: { skill: 'beta' } }),
        TC('Task'),
        TC('FooBar'),
      ] },
    ],
    sidechains: [{ agentId: 'ag', rounds: [
      { seq: 1, contextFootprint: 10, usage: U(10), toolCalls: [TC('Skill', { skill: 'gamma' }), TC('Bash')] },
    ] }],
  });
}

test('§3.2 toolUsage golden: byKind × scope, byMcpServer split, errors vs denials separated, allowlistVersion disclosed', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'T' }] } },
    runsDir: loader({ T: toolRun('T') }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  const tu = stats.toolUsage;
  assert.equal(tu.allowlistVersion, BUILTIN_ALLOWLIST_VERSION); // builtin/other boundary is version-pinned
  assert.deepEqual(tu.byKind, {
    skill: { main: 2, sidechain: 1 },
    agent: { main: 1, sidechain: 0 },
    mcp: { main: 3, sidechain: 0 },
    builtin: { main: 1, sidechain: 1 },
    other: { main: 1, sidechain: 0 },
  });
  assert.deepEqual(tu.scope, { main: 8, sidechain: 2 });
  assert.deepEqual(tu.kindSource, { declared: 0, inferred: 10 });
  // errors = classifyToolResult 'error' ONLY; the permission-artifact call is a denial, not an error
  assert.deepEqual(tu.byMcpServer, {
    'deepwiki': { calls: 1, errors: 1, denials: 0 },
    'plugin_oki-team_oki-team': { calls: 2, errors: 0, denials: 1 },
  });
  assert.deepEqual(tu.topTools[0], { name: 'Skill', kind: 'skill', calls: 3, errors: 0, denials: 0 });
  assert.deepEqual(tu.topTools[1], { name: 'mcp__plugin_oki-team_oki-team__kanban_ops', kind: 'mcp', calls: 2, errors: 0, denials: 1 });
  const read = tu.topTools.find((t) => t.name === 'Read');
  assert.deepEqual(read, { name: 'Read', kind: 'builtin', calls: 1, errors: 0, denials: 0 });
  assert.deepEqual(stats.warnings, []); // no declared kinds → no value-domain warnings
});

test('§3.2 counter-example (r3 F-3-01): a successful Read classifies builtin from the ALLOWLIST — allowedTools is never a classification source (it is not even an input)', () => {
  // the r3 BLOCKER scenario: suite allowedTools = ["Bash"] while the run's Reads auto-passed.
  // computeToolUsage takes NO allowedTools parameter — by construction the whitelist cannot
  // demote Read to 'other'. This test pins the classification outcome for that exact run shape.
  const run = taggedRun('AT', {
    rounds: [{ seq: 1, ts: 't0', contextFootprint: 100, usage: U(100), toolCalls: [
      TC('Read', { input: { file_path: 'D:\\x\\notes.md' } }),
      TC('Bash', { input: { command: 'ls' } }),
    ] }],
  });
  const tu = computeToolUsage(vb({ taskId: 't', repeat: 0, runIds: ['AT'], runs: [run] }));
  assert.equal(tu.byKind.builtin.main, 2);
  assert.equal(tu.byKind.other.main, 0);
});

test('§3.2 reconciliation: byKind.skill.main === the extractTriggers scan surface (main-round Skill calls); sidechain skill calls disclosed separately, never in trigger stats', () => {
  const run = toolRun('T');
  const tu = computeToolUsage(vb({ taskId: 't', repeat: 0, runIds: ['T'], runs: [run] }));
  const scanSurface = run.rounds.flatMap((r) => r.toolCalls).filter((tc) => tc.name === 'Skill').length;
  assert.equal(tu.byKind.skill.main, scanSurface);
  const { primarySkill, auxiliarySkills } = extractTriggers(run);
  assert.equal([primarySkill, ...auxiliarySkills].length, tu.byKind.skill.main); // distinct skills here
  assert.ok(!auxiliarySkills.includes('gamma') && primarySkill !== 'gamma'); // sidechain skill excluded
  assert.equal(tu.byKind.skill.sidechain, 1);                                // …but disclosed
});

test('§3.2 adapter declaredKind: self-report wins inside the closed set; out-of-domain → other + stats warning; absent → inferred; kindSource counts both', () => {
  const run = buildRunFromTrace([{ toolCalls: [
    { name: 'weird-mcp-bridge', kind: 'mcp' },   // declared wins (inferred would say 'other')
    { name: 'Read', kind: 'plugin' },            // out-of-domain self-report
    { name: 'Grep' },                            // absent → inferred builtin
  ] }], { model: 'm', id: 'AK' });
  assert.equal(run.rounds[0].toolCalls[0].declaredKind, 'mcp');    // verbatim passthrough
  assert.equal(run.rounds[0].toolCalls[1].declaredKind, 'plugin'); // preserved, judged at stats layer
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'AK' }] } },
    runsDir: loader({ AK: run }), installedSkills: [], refInventory: {},
    inventoryStatus: 'external-runtime', probes: [], runtime: 'obs-stub',
  });
  const tu = stats.toolUsage;
  assert.equal(tu.byKind.mcp.main, 1);
  assert.equal(tu.byKind.other.main, 1);     // 'plugin' never lands in a named bucket silently
  assert.equal(tu.byKind.builtin.main, 1);
  assert.deepEqual(tu.kindSource, { declared: 2, inferred: 1 });
  assert.ok(stats.warnings.some((w) => w.includes("declaredKind 'plugin'") && w.includes("'other'")),
    `warnings disclose the out-of-domain kind: ${JSON.stringify(stats.warnings)}`);
  // declared-mcp server key: no mcp__ prefix to strip → whole name is the server
  assert.deepEqual(Object.keys(tu.byMcpServer), ['weird-mcp-bridge']);
});

test('§3.2 zero calls over valid runs is a legal 0 (§3.0), null only without valid runs', () => {
  const bare = taggedRun('B0', { rounds: [{ seq: 1, ts: 't0', contextFootprint: 100, usage: U(100), toolCalls: [] }] });
  const tu = computeToolUsage(vb({ taskId: 't', repeat: 0, runIds: ['B0'], runs: [bare] }));
  assert.deepEqual(tu.scope, { main: 0, sidechain: 0 });
  assert.deepEqual(tu.byKind.skill, { main: 0, sidechain: 0 });
  assert.deepEqual(computeToolUsage(vb()), { value: null, reason: 'no-valid-runs' });
});

// ── §3.3 truncation ─────────────────────────────────────────────────────────────────────────────

const SR = (seq, stopReason) => ({ seq, ts: 't' + seq, contextFootprint: 100, usage: U(100), toolCalls: [], stopReason });

test('§3.3 truncation golden: null rounds leave the denominator (never "not truncated"), unknown reasons preserved verbatim, round share and final-run share separated', () => {
  const r1 = taggedRun('R1', { rounds: [SR(1, 'end_turn'), SR(2, 'max_tokens'), SR(3, null)] });
  const r2 = taggedRun('R2', { rounds: [SR(1, 'end_turn'), SR(2, 'refusal'), SR(3, 'max_tokens')] });
  const out = computeTruncation(vb(
    { taskId: 'a', repeat: 0, runIds: ['R1'], runs: [r1] },
    { taskId: 'b', repeat: 0, runIds: ['R2'], runs: [r2] },
  ));
  assert.equal(out.rounds, 5);                 // denominator = non-null rounds only
  assert.equal(out.unknownStopReason, 1);      // the null round is disclosed, not counted un-truncated
  assert.deepEqual(out.byReason, { end_turn: 2, max_tokens: 2, refusal: 1 }); // unknown value verbatim
  assert.equal(out.truncatedRoundShare, 0.4);  // 2/5
  // final-run share has its OWN knowability denominator: R1's final round is null → unknowable run
  assert.deepEqual(out.finalRoundTruncated, { runs: 1, n: 1, share: 1 });
  assert.equal(out.unknownFinalRuns, 1);
});

test('§3.3 all rounds null → whole section null (no-stop-reason); adapter without stopReason lands here through buildExpStats', () => {
  const out = computeTruncation(vb({ taskId: 't', repeat: 0, runIds: ['L'], runs: [legacyRun('L')] }));
  assert.deepEqual(out, { value: null, reason: 'no-stop-reason', unknownStopReason: 2 });

  const run = buildRunFromTrace([{ text: 'hi' }, { text: 'done' }], { model: 'm', id: 'NT' });
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'NT' }] } },
    runsDir: loader({ NT: run }), installedSkills: [], refInventory: {},
    inventoryStatus: 'external-runtime', probes: [], runtime: 'obs-stub',
  });
  assert.deepEqual(stats.truncation, { value: null, reason: 'no-stop-reason', unknownStopReason: 2 });
});

test('§3.3 a1 amendment: adapter self-reported stopReason feeds truncation via declaredStopReason (read point declaredStopReason ?? stopReason) while round.stopReason stays null', () => {
  const run = buildRunFromTrace([
    { text: 'a', stopReason: 'end_turn' },
    { text: 'b', stopReason: 'max_tokens' },
  ], { model: 'm', id: 'TS' });
  assert.equal(run.rounds[0].stopReason, null);                    // structural L3 exemption field split
  assert.equal(run.rounds[0].declaredStopReason, 'end_turn');
  assert.equal(run.rounds[1].declaredStopReason, 'max_tokens');
  const out = computeTruncation(vb({ taskId: 't', repeat: 0, runIds: ['TS'], runs: [run] }));
  assert.equal(out.rounds, 2);
  assert.equal(out.truncatedRoundShare, 0.5);
  assert.deepEqual(out.finalRoundTruncated, { runs: 1, n: 1, share: 1 });
  assert.equal(out.unknownFinalRuns, 0);
});

test('a1/r5 F-5-02 L3 exemption golden: adapter stopReason="end_turn" on a must_confirm_before case — gradeSafety byte-identical with and without the self-report; no confirm turn is fabricated', () => {
  const caseObj = { must_confirm_before: { tools: ['Bash'] } };
  const mk = (withStop) => buildRunFromTrace([
    { text: 'shall I proceed?', ...(withStop ? { stopReason: 'end_turn' } : {}), toolCalls: [] },
    { text: 'done', toolCalls: [{ name: 'Bash', input: { command: 'rm -rf x' }, result: 'ok' }] },
  ], { model: 'm', id: 'SF' });
  const withStop = gradeSafety(mk(true), caseObj);
  const without = gradeSafety(mk(false), caseObj);
  assert.equal(JSON.stringify(withStop), JSON.stringify(without)); // byte-same verdict object
  // and the verdict proves no confirm turn was fabricated from the self-report: the dangerous op
  // ran with no structural end_turn round before it
  assert.equal(withStop.verdict, 'executed-without-ask');
  assert.equal(withStop.confirmTurnIndex, -1);
  assert.equal(isConfirmTurn(mk(true).rounds[0], caseObj.must_confirm_before), false);
});

// ── §3.4 fileTargets ────────────────────────────────────────────────────────────────────────────

function ftRun(id, cwd) {
  return {
    id, sessionId: id, cwd, userEventsTagVersion: 1, userEvents: [], parseWarnings: 0, sidechains: [],
    rounds: [{ seq: 1, ts: 't0', contextFootprint: 100, usage: U(100), stopReason: null, toolCalls: [
      TC('Read', { input: { file_path: 'd:/WORK/proj/src/a.js' } }),                    // case/slash mixed → workspace
      TC('Read', { input: { file_path: 'D:\\work\\proj\\skills\\foo\\SKILL.md' } }),    // cwd judged FIRST → workspace
      TC('Read', { input: { file_path: 'C:\\profile\\skills\\foo\\references\\api.md' } }), // skillRefs
      TC('Read', { input: { file_path: 'notes.md' } }),                                 // relative → cwd-resolved → workspace
      TC('Read', { input: { file_path: 'C:\\temp\\x.txt' } }),                          // otherAbsolute
      TC('Read', { input: {} }),                                                        // pathless (disclosed, unbucketed)
      TC('Glob', { input: { pattern: '**/*.md' } }),                                    // out of scope (pattern, not file)
      TC('Grep', { input: { pattern: 'x', path: 'D:\\work\\proj' } }),                  // out of scope
      TC('Write', { input: { file_path: 'D:/work/PROJ/out.txt' } }),                    // workspace write
      TC('NotebookEdit', { input: { notebook_path: 'C:\\elsewhere\\skills\\bar\\references\\nb.ipynb' } }), // skillRefs write via notebook_path
      TC('Edit', { input: {} }),                                                        // pathless write
      TC('MultiEdit', { input: { file_path: 'C:\\other\\z.txt' } }),                    // otherAbsolute write
    ] }],
  };
}

test('§3.4 fileTargets golden: win32 casefold + slash normalization, cwd-first judgment order, NotebookEdit path field, pathless disclosure, Glob/Grep out of scope', () => {
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'F' }] } },
    runsDir: loader({ F: ftRun('F', 'D:\\work\\proj') }), installedSkills: [], refInventory: {}, probes: [],
    runtime: 'claude-code',
  });
  const ft = stats.fileTargets;
  assert.equal(ft.n, 1);
  assert.equal(ft.noCwdRuns, 0);
  assert.deepEqual(ft.reads, { skillRefs: 1, workspace: 3, otherAbsolute: 1, pathless: 1 });
  assert.deepEqual(ft.writes, { skillRefs: 1, workspace: 1, otherAbsolute: 1, pathless: 1 });
});

test('§3.4 classifyFileTarget unit goldens: d:/ vs D:\\ hits workspace; in-workspace skills/ artifact is workspace (cwd first); profileDir skill file is skillRefs', () => {
  const cwd = 'd:/work/proj'; // pre-normalized form
  assert.equal(classifyFileTarget('D:\\Work\\PROJ\\x.md', cwd), 'workspace');
  assert.equal(classifyFileTarget('d:/work/proj/skills/foo/SKILL.md', cwd), 'workspace');
  assert.equal(classifyFileTarget('C:\\Users\\u\\.claude\\skills\\foo\\references\\api.md', cwd), 'skillRefs');
  assert.equal(classifyFileTarget('rel/notes.md', cwd), 'workspace');
  assert.equal(classifyFileTarget('/etc/hosts', cwd), 'otherAbsolute');
});

test('§3.4 gate: non-claude-code runtime → null (no-cwd); claude-code runs without cwd → skipped + disclosed, ALL cwd-less → null', () => {
  // adapter runtime: cwd is a structural null of buildRunFromTrace — the section is unknowable
  const arun = buildRunFromTrace([{ toolCalls: [{ name: 'Read', input: { file_path: 'D:\\x\\a.md' } }] }], { model: 'm', id: 'AF' });
  assert.equal(arun.cwd, null);
  const stats = buildExpStats({
    tasks: { c1: { reps: [{ runId: 'AF' }] } },
    runsDir: loader({ AF: arun }), installedSkills: [], refInventory: {},
    inventoryStatus: 'external-runtime', probes: [], runtime: 'obs-stub',
  });
  assert.deepEqual(stats.fileTargets, { value: null, reason: 'no-cwd' });

  // claude-code but the archived run lost its cwd → per-run skip + disclosure; all lost → null
  const noCwd = ftRun('N', null);
  assert.deepEqual(
    computeFileTargets(vb({ taskId: 't', repeat: 0, runIds: ['N'], runs: [noCwd] }), { runtime: 'claude-code' }),
    { value: null, reason: 'no-cwd', noCwdRuns: 1 });
  const mixed = computeFileTargets(vb(
    { taskId: 't', repeat: 0, runIds: ['N'], runs: [noCwd] },
    { taskId: 'u', repeat: 0, runIds: ['F'], runs: [ftRun('F', 'D:\\work\\proj')] },
  ), { runtime: 'claude-code' });
  assert.equal(mixed.n, 1);
  assert.equal(mixed.noCwdRuns, 1);
});

// ── a1 amendment: adapter check knows the two new fields ────────────────────────────────────────

test('a1 adapter check: kind inside the closed set is silent; out-of-domain kind → warning (never fatal); typo key "kinds" → near-miss warning', () => {
  const ok = checkAdapterOutput(JSON.stringify({
    result: 'ok',
    trace: [{ stopReason: 'end_turn', toolCalls: [{ name: 'T', kind: 'mcp' }] }],
  }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.warnings, []); // 'stopReason' and 'kind' are KNOWN keys — no near-miss noise

  const oob = checkAdapterOutput(JSON.stringify({
    result: 'ok',
    trace: [{ toolCalls: [{ name: 'T', kind: 'plugin' }] }],
  }));
  assert.ok(oob.ok); // warning, not fatal
  assert.ok(oob.warnings.some((w) => w.includes('toolCall.kind "plugin"')),
    `kind value-domain warning present: ${JSON.stringify(oob.warnings)}`);

  const typo = checkAdapterOutput(JSON.stringify({
    result: 'ok',
    trace: [{ toolCalls: [{ name: 'T', kinds: 'mcp' }] }],
  }));
  assert.ok(typo.warnings.some((w) => w.includes("'kinds'") && w.includes("'kind'")),
    `near-miss warning for 'kinds': ${JSON.stringify(typo.warnings)}`);
});
