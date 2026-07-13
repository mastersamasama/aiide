// Experiment-level statistics engines — golden-sample tests (design §一/§二/§三).
// Pure functions over synthetic reps / runs / event lists; the one integration test drives
// buildExpStats through an injected run loader so it never touches disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveReps, skillCoverage, refCoverage, cliStats, proximityMatrix, buildExpStats,
} from '../src/expstats.js';

const PROBE = {
  tool: 'onchainos',
  match: { toolName: 'Bash', commandPattern: '(?:^|[;&|]\\s*)onchainos\\s+([a-z][\\w-]*)(?:\\s+([a-z][\\w-]*))?' },
  commandSurface: { source: 'static', commands: ['price get', 'order create'] },
  sequences: [{ pattern: ['price get', 'order create'], singleCommand: 'order create --with-price' }],
};
const CLI_CFG = { minSequenceCases: 3, ngramMaxLen: 3, minSessionsForCoverage: 5, blockExclusionTripwirePct: 12 };
const PROX_CFG = { windowOrdinals: 6, decay: '1/(1+gap)', minPairCases: 3 };

// A minimal Run: rounds[].toolCalls[] with { name, input }. Skill carries skill+input.skill,
// Read carries input.file_path (+ isError:false = success), Bash carries input.command.
function fakeRun(id, { skills = [], reads = [], cmds = [] } = {}) {
  const toolCalls = [];
  for (const s of skills) toolCalls.push({ name: 'Skill', skill: s, input: { skill: s } });
  for (const r of reads) toolCalls.push({ name: 'Read', isError: false, result: 'x', input: { file_path: `/p/skills/${r}` } });
  for (const c of cmds) toolCalls.push({ name: 'Bash', input: { command: c } });
  return { id, sessionId: id, rounds: [{ seq: 1, toolCalls }] };
}

// ── resolveReps: bucket order, held_out-first, multi-step split, identity ────────
test('resolveReps: held_out first (incl. an excluded rep inside it), five buckets, identity holds', () => {
  const runs = { a: fakeRun('a'), b: fakeRun('b'), c: fakeRun('c'), m1: fakeRun('m1'), m2: fakeRun('m2') };
  const load = (id) => runs[id] ?? null; // 'missing' → null → unresolved
  const tasks = {
    held: { held_out: true, reps: [{ runId: 'a', excluded: true }, { runId: 'b' }] }, // BOTH → heldOutExcluded
    t2: { reps: [{ runId: 'c' }, { excluded: true }, { runId: null }, { runId: 'missing' }] },
    t3: { reps: [{ runId: 'm1,m2' }] }, // multi-step → one valid rep, two runs
  };
  const { buckets, counts } = resolveReps(tasks, load);

  assert.equal(counts.heldOutExcluded, 2);          // held_out's env-noise rep NOT counted in nExcluded
  assert.equal(counts.nExcluded, 1);
  assert.equal(counts.noSession, 1);
  assert.equal(counts.nUnresolved, 1);
  assert.equal(counts.nCoverageValid, 2);           // c + the multi-step rep
  assert.equal(counts.nRaw, 7);
  // identity (design §2.2.3)
  assert.equal(counts.nRaw,
    counts.nCoverageValid + counts.nExcluded + counts.heldOutExcluded + counts.noSession + counts.nUnresolved);

  const multi = buckets.valid.find((v) => v.taskId === 't3');
  assert.deepEqual(multi.runIds, ['m1', 'm2']);      // comma-split
  assert.equal(multi.runs.length, 2);                // each part loaded
});

// ── skillCoverage: three readings + not-exercised vs never-triggered ─────────────
test('skillCoverage: everTriggered/primary/auxiliary, triggerRate, never-triggered vs not-exercised', () => {
  const caseRecords = [
    { caseId: 'k1', triggerSet: ['s.a', 's.b'], primarySet: ['s.a'] }, // a primary, b auxiliary
    { caseId: 'k2', triggerSet: ['s.a'], primarySet: ['s.a'] },
  ];
  const taskInfo = {
    k1: { expected_skill: 's.a', attempted: 3, triggered: 2 },
    k2: { expected_skill: 's.a', attempted: 2, triggered: 2 },
    k3: { expected_skill: 's.c', attempted: 2, triggered: 0 }, // targets s.c, never fires
  };
  const cov = skillCoverage(caseRecords, { installedSkills: ['s.a', 's.b', 's.c', 's.d'], taskInfo });

  const a = cov.everTriggered.find((e) => e.skill === 's.a');
  assert.deepEqual(a, { skill: 's.a', cases: 2, primary: 2, auxiliary: 0 });
  const b = cov.everTriggered.find((e) => e.skill === 's.b');
  assert.deepEqual(b, { skill: 's.b', cases: 1, primary: 0, auxiliary: 1 });

  const rateA = cov.triggerRate.find((r) => r.skill === 's.a');
  assert.deepEqual(rateA, { skill: 's.a', triggered: 4, attempted: 5 }); // (2+2)/(3+2)

  assert.deepEqual(cov.neverTriggered, ['s.c']);   // targeted (k3) yet never triggered
  assert.deepEqual(cov.notExercised, ['s.d']);     // no case targets s.d — not dead weight
});

// ── refCoverage: three dead-weight exemption buckets ─────────────────────────────
test('refCoverage: unreadRefs excludes artifact-only, excluded-only, and not-exercised refs', () => {
  const caseRecords = [
    { caseId: 'k1', triggerSet: ['s.a'], readCounts: { 's.a/references/read.md': { runs: 2, skill: 's.a', refPath: 's.a/references/read.md' } } },
  ];
  const refInventory = {
    's.a': { versionSha: 'aa', refs: ['s.a/references/read.md', 's.a/references/dead.md', 's.a/references/blocked.md', 's.a/references/exclonly.md'] },
    's.b': { versionSha: 'bb', refs: ['s.b/references/x.md'] }, // s.b never triggered → not-exercised
  };
  const res = refCoverage(caseRecords, {
    refInventory,
    artifactReads: ['s.a/references/blocked.md'],   // read only in a blocked run
    excludedReads: ['s.a/references/exclonly.md'],  // read only in an excluded run
  });

  const a = res.bySkill.find((x) => x.skill === 's.a');
  assert.equal(a.shipped, 4);
  assert.equal(a.read, 1);
  assert.deepEqual(a.unreadRefs, ['s.a/references/dead.md']); // ONLY the genuine dead-weight candidate
  assert.equal(a.notExercised, false);
  assert.deepEqual(res.artifactOnlyRefs, ['s.a/references/blocked.md']);
  assert.deepEqual(res.excludedOnlyRefs, ['s.a/references/exclonly.md']);

  const b = res.bySkill.find((x) => x.skill === 's.b');
  assert.equal(b.notExercised, true);
  assert.deepEqual(b.unreadRefs, []);              // not-exercised skill's refs are NOT dead weight

  assert.deepEqual(res.readCounts['s.a/references/read.md'], { runs: 2, cases: 1 });
});

// ── cliStats M3 coverage ─────────────────────────────────────────────────────────
function cliCase(caseId, skills, runsCmds) {
  const runs = runsCmds.map((cmds, i) => ({
    runId: `${caseId}-r${i}`, triggerSet: skills,
    cliSet: cmds.map((cmd, ordinal) => ({ tool: 'onchainos', cmd, round: 1, ordinal })),
  }));
  return { caseId, triggerSet: skills, runs };
}

test('cliStats M3: declared coverage, surface-drift on undeclared, ratio capped, unavailable without surface', () => {
  const recs = [
    cliCase('k1', ['s.a'], [['price get', 'order create', 'status']]), // 'status' undeclared
  ];
  const out = cliStats(recs, PROBE, CLI_CFG);
  assert.deepEqual(out.coverage.invoked, ['order create', 'price get', 'status']);
  assert.equal(out.coverage.declared, 2);
  assert.equal(out.coverage.ratio, 1);            // covered 2/2, capped at 1
  assert.deepEqual(out.coverage.undeclaredInvoked, ['status']);
  assert.ok(out.warnings.some((w) => w.kind === 'surface-drift'));
  assert.equal(out.coverage.status, 'available');

  const noSurface = cliStats(recs, { ...PROBE, commandSurface: undefined }, CLI_CFG);
  assert.equal(noSurface.coverage.status, 'unavailable');
  assert.equal(noSurface.coverage.declared, null);
});

// ── cliStats M4 per-skill co-occurrence + insufficient-data badge ────────────────
test('cliStats M4: same-run presence per skill; runs < minSessionsForCoverage → insufficient-data', () => {
  const recs = [
    cliCase('k1', ['s.a'], [['price get']]),
    cliCase('k2', ['s.a'], [['price get']]),
    cliCase('k3', ['s.a'], [['price get']]),
  ];
  const out = cliStats(recs, PROBE, CLI_CFG);
  const a = out.bySkill.find((x) => x.skill === 's.a');
  assert.equal(a.commands['price get'], 3);       // once per run
  assert.equal(a.runs, 3);
  assert.equal(a.status, 'insufficient-data');    // 3 < 5
});

// ── cliStats M5 distinct-case support (repeats cannot inflate) ────────────────────
test('cliStats M5: 3 DISTINCT cases with an adjacent n-gram → emitted; 3 repeats of ONE case → not', () => {
  const distinct = [
    cliCase('k1', ['s.a'], [['price get', 'order create']]),
    cliCase('k2', ['s.a'], [['price get', 'order create']]),
    cliCase('k3', ['s.a'], [['price get', 'order create']]),
  ];
  const seqs = cliStats(distinct, PROBE, CLI_CFG).sequences;
  const gram = seqs.find((s) => s.seq.join(' ') === 'price get order create');
  assert.ok(gram, 'n-gram over 3 distinct cases is emitted');
  assert.equal(gram.distinctCases, 3);
  assert.equal(gram.knownCollapse, 'order create --with-price'); // annotation only
  assert.equal(gram.status, 'hypothesis');

  // ONE case repeated 3× → distinctCases 1 < minSequenceCases 3 → suppressed
  const repeated = [cliCase('k1', ['s.a'], [['price get', 'order create'], ['price get', 'order create'], ['price get', 'order create']])];
  assert.equal(cliStats(repeated, PROBE, CLI_CFG).sequences.length, 0);
});

test('cliStats: probeZeroMatch flag → coverage suspect + warning', () => {
  const out = cliStats([cliCase('k1', ['s.a'], [[]])], PROBE, CLI_CFG, { zeroMatch: true });
  assert.equal(out.coverage.status, 'suspect');
  assert.ok(out.warnings.some((w) => w.kind === 'probe-zero-match'));
});

// ── proximityMatrix M7 ───────────────────────────────────────────────────────────
const ev = (type, id, ordinal, caseId) => ({ type, id, ordinal, caseId });

test('proximityMatrix: A→B→C closeness gradient (closer pair has higher closeness)', () => {
  const run = [ev('skill', 'A', 0, 'c1'), ev('skill', 'B', 1, 'c1'), ev('skill', 'C', 2, 'c1')];
  const { edges } = proximityMatrix([run], PROX_CFG);
  const ab = edges.find((e) => e.from.id === 'A' && e.to.id === 'B');
  const ac = edges.find((e) => e.from.id === 'A' && e.to.id === 'C');
  assert.equal(ab.closeness, 0.5);      // 1/(1+1)
  assert.equal(ac.closeness, 0.3333);   // 1/(1+2)
  assert.ok(ab.closeness > ac.closeness);
});

test('proximityMatrix: single case repeated 3× → identical confidence AND lift (no pseudo-replication)', () => {
  const one = [[ev('skill', 'A', 0, 'c1'), ev('skill', 'B', 1, 'c1')]];
  const three = [
    [ev('skill', 'A', 0, 'c1'), ev('skill', 'B', 1, 'c1')],
    [ev('skill', 'A', 0, 'c1'), ev('skill', 'B', 1, 'c1')],
    [ev('skill', 'A', 0, 'c1'), ev('skill', 'B', 1, 'c1')],
  ];
  const cfg = { ...PROX_CFG, minPairCases: 1 }; // let lift compute so we can compare it too
  const e1 = proximityMatrix(one, cfg).edges.find((e) => e.from.id === 'A' && e.to.id === 'B');
  const e3 = proximityMatrix(three, cfg).edges.find((e) => e.from.id === 'A' && e.to.id === 'B');
  assert.equal(e1.confidence, e3.confidence);
  assert.equal(e1.lift, e3.lift);
  assert.equal(e1.closeness, e3.closeness);   // normalizer = A occurrences → repeats cancel out
});

test('proximityMatrix: lift suppressed below minPairCases, emitted at/above it', () => {
  const mk = (caseId) => [ev('skill', 'A', 0, caseId), ev('skill', 'B', 1, caseId)];
  const two = proximityMatrix([mk('c1'), mk('c2')], PROX_CFG).edges.find((e) => e.from.id === 'A' && e.to.id === 'B');
  assert.equal(two.pairCases, 2);
  assert.equal(two.lift, null);               // 2 < minPairCases 3
  const three = proximityMatrix([mk('c1'), mk('c2'), mk('c3')], PROX_CFG).edges.find((e) => e.from.id === 'A' && e.to.id === 'B');
  assert.equal(three.pairCases, 3);
  assert.notEqual(three.lift, null);
});

test('proximityMatrix: never pairs across runs (A in run1, B in run2 → no edge)', () => {
  const runs = [[ev('skill', 'A', 0, 'c1')], [ev('skill', 'B', 0, 'c1')]];
  const { edges } = proximityMatrix(runs, PROX_CFG);
  assert.ok(!edges.some((e) => e.from.id === 'A' && e.to.id === 'B'));
});

test('proximityMatrix: 4-round vs 20-round runs with the same gap → comparable closeness', () => {
  const short = [[ev('skill', 'A', 0, 'cS'), ev('skill', 'B', 1, 'cS')]];
  const longEvents = [ev('skill', 'A', 0, 'cL'), ev('skill', 'B', 1, 'cL')];
  for (let i = 2; i < 20; i++) longEvents.push(ev('cli', `x${i}`, i, 'cL')); // long trailing tail
  const long = [longEvents];
  const sAB = proximityMatrix(short, PROX_CFG).edges.find((e) => e.from.id === 'A' && e.to.id === 'B');
  const lAB = proximityMatrix(long, PROX_CFG).edges.find((e) => e.from.id === 'A' && e.to.id === 'B');
  assert.equal(sAB.closeness, lAB.closeness);  // gap-based + A-normalized → length-independent
});

// ── buildExpStats integration (injected loader) ─────────────────────────────────
test('buildExpStats: end-to-end identity, triggerRate incl. noSession, cli + proximity blocks', () => {
  const runs = {
    sw1: fakeRun('sw1', { skills: ['onchain.swap'], reads: ['onchain.swap/references/dex.md'], cmds: ['onchainos price get && onchainos order create'] }),
    sw2: fakeRun('sw2', { skills: ['onchain.swap'], reads: ['onchain.swap/references/dex.md'], cmds: ['onchainos price get && onchainos order create'] }),
    pr1: fakeRun('pr1', { skills: ['onchain.price'], reads: ['onchain.price/references/p.md'] }),
    h1: fakeRun('h1', { skills: ['onchain.swap'] }),
  };
  const load = (id) => runs[id] ?? null;
  const tasks = {
    'swap-1': { expected_skill: 'onchain.swap', category: 'swap', reps: [{ runId: 'sw1' }, { runId: 'sw2' }, { runId: null }] },
    'price-1': { expected_skill: 'onchain.price', category: 'price', reps: [{ runId: 'pr1' }] },
    'held-1': { expected_skill: 'onchain.swap', held_out: true, reps: [{ runId: 'h1', excluded: true }] },
    'un-1': { expected_skill: 'onchain.swap', reps: [{ runId: 'gone' }] },
  };
  const refInventory = {
    'onchain.swap': { versionSha: 'aa', refs: ['onchain.swap/references/dex.md', 'onchain.swap/references/never.md'] },
    'onchain.price': { versionSha: 'cc', refs: ['onchain.price/references/p.md'] },
    'onchain.unused': { versionSha: 'zz', refs: ['onchain.unused/references/x.md'] },
  };
  const stats = buildExpStats({
    tasks, runsDir: load,
    installedSkills: ['onchain.swap', 'onchain.price', 'onchain.unused'],
    refInventory, probes: [PROBE],
  });

  // identity
  assert.equal(stats.nRaw, 6);
  assert.equal(stats.nCoverageValid, 3);
  assert.equal(stats.heldOutExcluded, 1);
  assert.equal(stats.noSession, 1);
  assert.equal(stats.nUnresolved, 1);
  assert.equal(stats.nRaw,
    stats.nCoverageValid + stats.nExcluded + stats.heldOutExcluded + stats.noSession + stats.nUnresolved);

  // triggerRate includes the noSession rep in the denominator (aligned with activationRate)
  const swapRate = stats.skillCoverage.triggerRate.find((r) => r.skill === 'onchain.swap');
  assert.deepEqual(swapRate, { skill: 'onchain.swap', triggered: 2, attempted: 3 });

  // not-exercised skill flagged, its refs not dead weight; swap's unread ref surfaced
  assert.deepEqual(stats.skillCoverage.notExercised, ['onchain.unused']);
  const swapRef = stats.refCoverage.bySkill.find((x) => x.skill === 'onchain.swap');
  assert.deepEqual(swapRef.unreadRefs, ['onchain.swap/references/never.md']);
  const unusedRef = stats.refCoverage.bySkill.find((x) => x.skill === 'onchain.unused');
  assert.equal(unusedRef.notExercised, true);

  // probe block (array, one probe) + proximity block
  assert.ok(Array.isArray(stats.probes) && stats.probes.length === 1);
  assert.equal(stats.probes[0].tool, 'onchainos');
  assert.ok(stats.probes[0].coverage.invoked.includes('price get'));
  assert.ok(stats.probes[0].coverage.invoked.includes('order create'));
  assert.equal(stats.proximity.n, 2);            // two distinct valid cases
  assert.equal(stats.schemaVersion, 3);          // taxonomy T1 Stage 3 rebaseline (was §S v2)
});

test('buildExpStats: no probes → probes:null, proximity still computed from skill/ref events', () => {
  const runs = { r1: fakeRun('r1', { skills: ['s.a'], reads: ['s.a/references/x.md'] }) };
  const stats = buildExpStats({
    tasks: { k1: { expected_skill: 's.a', reps: [{ runId: 'r1' }] } },
    runsDir: (id) => runs[id] ?? null,
    installedSkills: ['s.a'], refInventory: { 's.a': { versionSha: 'a', refs: ['s.a/references/x.md'] } },
    probes: [],
  });
  assert.equal(stats.probes, null);
  assert.equal(stats.proximity.n, 1);
});

// ═══ §S schemaVersion 2 golden samples ═══════════════════════════════════════════
// caseJoin 對帳、firedInstead 三態、refs[] join（子集性質/blocked/bytes/_shared）、
// inventoryStatus 三態（[] 與 null 嚴格分離）。

// v2 caseJoin scenario:
//   m1 (expects s.a): a1 fires s.a, a2 fires s.b only, one noSession rep → attempted 3, triggered 1
//   m2 (expects s.a): a3 fires NOTHING → miss with a valid run and no other skill → firedInstead []
//   m3 (expects s.c): noSession-only → attempted 1, triggered 0, firedInstead null（無 session 可判）
//   m4 (expects s.a): excluded-only rep → attempted 0（excluded 不算 attempted）、無 valid run → null
//   mr (expects s.c): b1 fires s.a instead → miss 誤路由 → firedInstead ['s.a']
//   h  (expects s.a, held_out): 不入 caseJoin（枚舉源 = 非 held_out taskInfo）
function v2CaseJoinStats() {
  const runs = {
    a1: fakeRun('a1', { skills: ['s.a'] }),
    a2: fakeRun('a2', { skills: ['s.b'] }),
    a3: fakeRun('a3', {}),
    b1: fakeRun('b1', { skills: ['s.a'] }),
    x1: fakeRun('x1', { skills: ['s.a'] }),
    h1: fakeRun('h1', { skills: ['s.a'] }),
  };
  const tasks = {
    m1: { expected_skill: 's.a', reps: [{ runId: 'a1' }, { runId: 'a2' }, { runId: null }] },
    m2: { expected_skill: 's.a', reps: [{ runId: 'a3' }] },
    m3: { expected_skill: 's.c', reps: [{ runId: null }] },
    m4: { expected_skill: 's.a', reps: [{ runId: 'x1', excluded: true }] },
    mr: { expected_skill: 's.c', reps: [{ runId: 'b1' }] },
    h: { expected_skill: 's.a', held_out: true, reps: [{ runId: 'h1' }] },
  };
  return buildExpStats({
    tasks, runsDir: (id) => runs[id] ?? null,
    installedSkills: ['s.a', 's.b', 's.c'], refInventory: {}, probes: [],
  });
}

test('v2 caseJoin: Σ attempted/triggered === triggerRate 分母/分子（逐 skill 對帳）；枚舉源 = taskInfo（held_out 不入）', () => {
  const stats = v2CaseJoinStats();
  const join = stats.skillCoverage.caseJoin;
  // 對帳恆等式：每個 expected skill 一格
  for (const { skill, triggered, attempted } of stats.skillCoverage.triggerRate) {
    const cases = join[skill]?.cases ?? [];
    assert.equal(cases.reduce((a, c) => a + c.attempted, 0), attempted, `${skill} attempted 對帳`);
    assert.equal(cases.reduce((a, c) => a + c.triggered, 0), triggered, `${skill} triggered 對帳`);
  }
  // 枚舉源 = taskInfo：excluded-only 的 m4（attempted 0）仍在列；held_out 的 h 絕不在列
  assert.deepEqual(join['s.a'].cases.map((c) => c.caseId), ['m1', 'm2', 'm4']);
  assert.deepEqual(join['s.c'].cases.map((c) => c.caseId), ['m3', 'mr']);
  const m1 = join['s.a'].cases.find((c) => c.caseId === 'm1');
  assert.deepEqual({ attempted: m1.attempted, triggered: m1.triggered }, { attempted: 3, triggered: 1 }); // noSession 算 attempted 不算 triggered
});

test('v2 caseJoin firedInstead 三態: triggered>0 省略；miss+valid run → 陣列（[] = 可知且空）；無 valid run → null', () => {
  const join = v2CaseJoinStats().skillCoverage.caseJoin;
  const row = (skill, id) => join[skill].cases.find((c) => c.caseId === id);
  assert.ok(!('firedInstead' in row('s.a', 'm1')), 'triggered>0 → 欄位省略');           // 態一
  assert.deepEqual(row('s.a', 'm2').firedInstead, []);       // 態二：有 valid run、無其他 skill 觸發
  assert.deepEqual(row('s.c', 'mr').firedInstead, ['s.a']);  // 態二：誤路由清單（B6 行動語義素材）
  assert.equal(row('s.c', 'm3').firedInstead, null);         // 態三：noSession-only → 不可知
  assert.equal(row('s.a', 'm4').firedInstead, null);         // 態三：excluded-only（無 valid run）
});

test('v2 refs[]: casesCoTriggered ≤ everTriggered distinct cases（子集性質）；blocked 命中；bytes 取 refMeta 無則 null', () => {
  const caseRecords = [
    { caseId: 'k1', triggerSet: ['s.a'], readCounts: { 's.a/references/r1.md': { runs: 2 }, 's.a/references/r2.md': { runs: 1 } } },
    { caseId: 'k2', triggerSet: ['s.a'], readCounts: { 's.a/references/r1.md': { runs: 1 } } },
    { caseId: 'k3', triggerSet: [], readCounts: { 's.a/references/r1.md': { runs: 1 } } }, // 讀了但 s.a 未觸發
  ];
  const res = refCoverage(caseRecords, {
    refInventory: { 's.a': { versionSha: 'aa', refs: ['s.a/references/r1.md', 's.a/references/r2.md', 's.a/references/r3.md', 's.a/references/rb.md'] } },
    artifactReads: ['s.a/references/rb.md'],
    refMeta: { 's.a/references/r1.md': { bytes: 111, tokensEst: 28 }, 's.a/references/r3.md': { bytes: 333, tokensEst: 84 } },
  });
  const a = res.bySkill.find((x) => x.skill === 's.a');
  const row = (ref) => a.refs.find((r) => r.ref === ref);
  // r1：讀了 4 run/3 case，但 co-trigger join 只算（觸發 ∧ 讀）的 case → 2；恆 ≤ everTriggered distinct cases (2)
  assert.deepEqual(row('s.a/references/r1.md'),
    { ref: 's.a/references/r1.md', bytes: 111, readsRuns: 4, readsCases: 3, casesCoTriggered: 2, blocked: false });
  const everTriggeredCases = 2; // k1+k2
  for (const r of a.refs) assert.ok(r.casesCoTriggered <= everTriggeredCases, `${r.ref} 子集性質`);
  // r2 無 refMeta → bytes null（不可知，非 0）；讀取計數照舊
  assert.deepEqual(row('s.a/references/r2.md'),
    { ref: 's.a/references/r2.md', bytes: null, readsRuns: 1, readsCases: 1, casesCoTriggered: 1, blocked: false });
  // rb 僅 blocked run 讀過 → artifactOnly 豁免命中 → blocked:true 且不入 unreadRefs
  assert.equal(row('s.a/references/rb.md').blocked, true);
  assert.deepEqual(a.unreadRefs, ['s.a/references/r3.md']);
  // refMeta 隨 stats 落盤（回傳原樣）
  assert.equal(res.refMeta['s.a/references/r3.md'].tokensEst, 84);
  assert.equal(res.inventoryStatus, 'snapshot');
});

test('v2 _shared inventory ref: 不入 refMeta join → 行 bytes=null + reason shared-hash-namespace（雜湊行為不動）', () => {
  const caseRecords = [{ caseId: 'k1', triggerSet: ['s.a'], readCounts: { '_shared/util.md#abc123': { runs: 1 } } }];
  const res = refCoverage(caseRecords, {
    refInventory: { 's.a': { versionSha: 'aa', refs: ['s.a/references/_shared/util.md'] } },
    // 即使呼叫端誤塞了 _shared 的明文 key，engine 也不得用它填 bytes（key 規則釘死）
    refMeta: { 's.a/references/_shared/util.md': { bytes: 999, tokensEst: 250 } },
  });
  const row = res.bySkill[0].refs[0];
  assert.equal(row.bytes, null);
  assert.equal(row.reason, 'shared-hash-namespace');
  // 運行期 md5 namespace 的讀取仍在 readCounts（canonical 雜湊不動），只是與明文 shipped ref 不 join
  assert.deepEqual(res.readCounts['_shared/util.md#abc123'], { runs: 1, cases: 1 });
  assert.equal(row.readsRuns, 0);
});

test('v2 inventoryStatus 三態: snapshot 完整 / none-backfill 反推 / external-runtime null（[] 與 null 嚴格分離）', () => {
  const caseRecords = [
    { caseId: 'k1', triggerSet: ['s.a'], readCounts: {
      's.a/references/seen.md': { runs: 2 }, 's.a/SKILL.md': { runs: 2 }, '_shared/u.md#ff00': { runs: 1 },
    } },
  ];
  // snapshot：refs [] = 可知且空（skill 裝了但沒帶任何 reference）
  const snap = refCoverage(caseRecords, { refInventory: { 's.empty': { versionSha: 'ee', refs: [] } }, inventoryStatus: 'snapshot' });
  assert.equal(snap.reason, undefined);
  const empty = snap.bySkill.find((x) => x.skill === 's.empty');
  assert.deepEqual(empty.refs, []);
  assert.equal(empty.shipped, 0);

  // none-backfill：僅 `<skill>/references/` 前綴反推；SKILL.md 與 _shared md5 key 不反推；
  // shipped/unreadRefs/bytes = null（不可知，絕非 0/[]）
  const back = refCoverage(caseRecords, { refInventory: {}, inventoryStatus: 'none-backfill' });
  assert.equal(back.reason, 'no-inventory-snapshot');
  assert.equal(back.bySkill.length, 1);
  const ba = back.bySkill[0];
  assert.equal(ba.skill, 's.a');
  assert.equal(ba.shipped, null);
  assert.equal(ba.unreadRefs, null);
  assert.equal(ba.read, 1);
  assert.deepEqual(ba.refs.map((r) => r.ref), ['s.a/references/seen.md']);
  assert.equal(ba.refs[0].bytes, null);
  assert.equal(back.refMeta, null);

  // external-runtime：bySkill = null（不可知）——絕不渲染成「可知且空」的 []
  const ext = refCoverage(caseRecords, { refInventory: {}, inventoryStatus: 'external-runtime' });
  assert.equal(ext.bySkill, null);
  assert.equal(ext.reason, 'external-runtime-self-managed');
  assert.equal(ext.refMeta, null);
  assert.ok(ext.readCounts['s.a/references/seen.md'], '觀測面（readCounts）不受 inventory 可知性影響');
});

test('buildExpStats: schemaVersion 3（taxonomy T1 Stage 3 rebaseline）+ inventoryStatus/refMeta 直通 refCoverage', () => {
  const runs = { r1: fakeRun('r1', { skills: ['s.a'], reads: ['s.a/references/x.md'] }) };
  const stats = buildExpStats({
    tasks: { k1: { expected_skill: 's.a', reps: [{ runId: 'r1' }] } },
    runsDir: (id) => runs[id] ?? null,
    installedSkills: ['s.a'],
    refInventory: { 's.a': { versionSha: 'a', refs: ['s.a/references/x.md'] } },
    refMeta: { 's.a/references/x.md': { bytes: 42, tokensEst: 11 } },
    inventoryStatus: 'snapshot', probes: [],
  });
  assert.equal(stats.schemaVersion, 3);
  assert.equal(stats.refCoverage.inventoryStatus, 'snapshot');
  assert.equal(stats.refCoverage.bySkill[0].refs[0].bytes, 42);
  assert.equal(stats.refCoverage.refMeta['s.a/references/x.md'].tokensEst, 11);
  // caseJoin 落盤且與 triggerRate 對帳
  assert.deepEqual(stats.skillCoverage.caseJoin['s.a'].cases, [{ caseId: 'k1', attempted: 1, triggered: 1 }]);
});
