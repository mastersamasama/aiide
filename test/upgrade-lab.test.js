// U0 upgrade-u0-lab-infra — bounded pool, per-arm CLI pinning, arm-scoped resumeKey/journal,
// scripted-reply resume + incremental metrics merge, mixed-bundle profile, budget estimate.
// Golden numbers: resume cost 0.1263 + 0.0846 = 0.2109 (P2). Existing lab.test.js stays untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  runPool, runSuite, runArm, ensureProfile, computeResumeKey, findJournal, loadJournalRepeats,
  buildArmEnv, assertArmVersion, resumeWithScriptedReply, mergeInvocationMetrics,
  markScriptedReplyExcluded, estimateBudget, mixArmMetadata, armMetadata,
  snapshotRefInventory, tokensEstCJK,
} from '../src/lab.js';
import { scoreTask } from '../src/score.js';
import { parseSessionJsonl } from '../src/parser.js';
import { UPGRADE_CONFIG } from '../src/upgradeConfig.js';

const STUB = fileURLToPath(new URL('./fixtures/claude-stub.js', import.meta.url));

function tmp() { return mkdtempSync(join(tmpdir(), 'aiide-u0-')); }
function makeSkillDir(root, name, marker = 'body') {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n${marker}`);
  return dir;
}

// ============================================================================================
// T0.1 — R0.1: bounded worker pool
// ============================================================================================

test('T0.1/R0.1.1+R0.1.3 runPool: peak concurrency ≤ limit; a worker throw never aborts the batch', async () => {
  const n = 12, limit = 4;
  let inFlight = 0, peak = 0;
  const worker = async (item) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    if (item === 7) throw new Error('boom-7');   // one unit explodes
    return item * 2;
  };
  const { results, errors } = await runPool([...Array(n).keys()], limit, worker);
  assert.ok(peak <= limit, `peak ${peak} must not exceed limit ${limit}`);
  assert.ok(peak > 1, 'the pool must actually run units in parallel');
  assert.equal(errors.length, 1);               // the throwing unit surfaced, batch continued
  assert.equal(errors[0].index, 7);
  assert.equal(results[6], 12);                  // units before AND after the failure ran
  assert.equal(results[11], 22);
  assert.equal(results.filter(v => v !== undefined).length, n - 1);
});

test('T0.1/R0.1.1+R0.1.2 runSuite pool: 5 cases × 3 repeats all run, every workspace path unique', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const suite = {
      name: 'pool-suite', model: 'sonnet', repeats: 3, maxTurns: 5, timeoutMs: 30_000,
      skills: { dirs: [] },
      tasks: Array.from({ length: 5 }, (_, i) => ({
        id: `t${i}`, prompt: 'what is the price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }],
      })),
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir, concurrency: 4 });
    // all 15 (case × repeat) units executed
    assert.equal(readdirSync(join(dataDir, 'runs')).length, 15);
    for (const t of Object.values(exp.tasks)) assert.equal(t.n, 3);
    // R0.1.2: each (case, repeat) got its own workspace subdir — 15 distinct names
    const ws = readdirSync(join(dataDir, 'workspaces', exp.id));
    assert.equal(ws.length, 15);
    assert.equal(new Set(ws).size, 15);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================================
// T0.2 — R0.2: per-arm CLI / env / PATH pinning
// ============================================================================================

test('T0.2/R0.2.1 buildArmEnv: arm A env exposes A cliPath, never leaks B cliPath', () => {
  const armA = { label: 'old', cliPath: '/opt/onchainos-1.0/bin/onchainos', cliVersion: '1.0.0' };
  const armB = { label: 'new', cliPath: '/opt/onchainos-2.0/bin/onchainos', cliVersion: '2.0.0' };
  const base = { PATH: '/usr/bin:/bin' };                     // clean base, neither arm present
  const envA = buildArmEnv(armA, base);
  assert.ok(envA.PATH.startsWith(dirname(armA.cliPath)));     // A's bin dir wins on PATH
  assert.ok(!envA.PATH.includes(dirname(armB.cliPath)));      // B's bin dir absent → no leak
  const envB = buildArmEnv(armB, base);
  assert.ok(envB.PATH.startsWith(dirname(armB.cliPath)));
  assert.ok(!envB.PATH.includes(dirname(armA.cliPath)));
});

test('T0.2/R0.2.2 assertArmVersion: match passes; mismatch throws (fail-fast, no session)', () => {
  const arm = { label: 'new', cliVersion: '2.1.0', cliPath: '/x/onchainos' };
  // match (framing like `onchainos 2.1.0` tolerated)
  assert.equal(assertArmVersion(arm, { exec: () => 'onchainos 2.1.0\n' }), 'onchainos 2.1.0');
  // mismatch → throw
  assert.throws(() => assertArmVersion(arm, { exec: () => 'onchainos 2.0.9' }), /version mismatch/);
});

test('T0.2/R0.2.2 runArm: version mismatch fail-fasts before any run artifact exists', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const arm = { label: 'new', cliVersion: '2.0.0', profileName: 'p-new', cliPath: '/x/onchainos' };
  const suite = { name: 's', model: 'sonnet', repeats: 1, skills: { dirs: [] }, tasks: [{ id: 't', prompt: 'x', verifiers: [] }] };
  await assert.rejects(
    runArm(arm, { suite, suiteDir: root, dataDir, versionExec: () => 'onchainos 1.9.9' }),
    /version mismatch/,
  );
  assert.equal(existsSync(join(dataDir, 'runs')), false);   // zero sessions started
  assert.equal(existsSync(join(dataDir, 'experiments')), false);
  rmSync(root, { recursive: true, force: true });
});

test('T0.2/R0.2.3 armMetadata: cliVersion/profileName/isolation/model/harness recorded', () => {
  const m = armMetadata(
    { label: 'old', cliVersion: '1.0.0', profileName: 'p-old', model: 'sonnet' },
    { isolation: true, harnessVersion: '0.9.9' },
  );
  assert.deepEqual(m, {
    label: 'old', cliVersion: '1.0.0', profileName: 'p-old', model: 'sonnet',
    isolationVerified: true, harnessVersion: '0.9.9',
  });
});

// ============================================================================================
// T0.2b — R0.2b: mixed bundle profile assembly (mini-verdict e2e gated to U7)
// ============================================================================================

test('T0.2b/R0.2b.1+2 ensureProfile mix: skillA from new + skillB from old; mixMapping recorded', () => {
  const root = tmp();
  const newA = makeSkillDir(join(root, 'new'), 'skillA', 'vNEW-A');
  const oldA = makeSkillDir(join(root, 'old'), 'skillA', 'vOLD-A');
  const newB = makeSkillDir(join(root, 'new'), 'skillB', 'vNEW-B');
  const oldB = makeSkillDir(join(root, 'old'), 'skillB', 'vOLD-B');
  const { profileDir, installedSkills, mixMapping } = ensureProfile({
    name: 'mixp', dataDir: join(root, '.aiide'), sourceConfigDir: root,
    mix: { skills: [{ name: 'skillA', dir: newA, arm: 'new' }, { name: 'skillB', dir: oldB, arm: 'old' }] },
  });
  assert.deepEqual(installedSkills.sort(), ['skillA', 'skillB']);
  // profile really carries the picked version of each skill
  assert.match(readFileSync(join(profileDir, 'skills', 'skillA', 'SKILL.md'), 'utf8'), /vNEW-A/);
  assert.match(readFileSync(join(profileDir, 'skills', 'skillB', 'SKILL.md'), 'utf8'), /vOLD-B/);
  assert.deepEqual(mixMapping, { skillA: 'new', skillB: 'old' });
  void oldA; void newB;
  rmSync(root, { recursive: true, force: true });
});

test('T0.2b/R0.2b.2+3 mixArmMetadata: mix mapping + CLI + baseline pairing (default new CLI / old baseline)', () => {
  const m = mixArmMetadata({ mixMapping: { skillA: 'new', skillB: 'old' }, cliVersion: '2.0.0' });
  assert.equal(m.label, 'mix');
  assert.equal(m.cliVersion, '2.0.0');            // operator-specified (defaults to new arm CLI upstream)
  assert.deepEqual(m.mix, { skillA: 'new', skillB: 'old' });
  assert.equal(m.baseline, 'old');                // PM-N1: baseline defaults to old-full
  assert.equal(m.pairing, 'mix-vs-baseline');     // R0.2b.3: mix pairs vs baseline, not another mix
});

test('T0.2b ensureProfile: no mix → mixMapping null, plain skillDirs path bit-identical', () => {
  const root = tmp();
  const s1 = makeSkillDir(root, 'skill-a');
  const { installedSkills, mixMapping } = ensureProfile({
    name: 'p', skillDirs: [s1], dataDir: join(root, '.aiide'), sourceConfigDir: root,
  });
  assert.deepEqual(installedSkills, ['skill-a']);
  assert.equal(mixMapping, null);
  rmSync(root, { recursive: true, force: true });
});

// ============================================================================================
// T0.3 — R0.3: arm identity into resumeKey + journal header
// ============================================================================================

const armOld = { label: 'old', cliVersion: '1.0.0', profileName: 'p-old' };
const armNew = { label: 'new', cliVersion: '2.0.0', profileName: 'p-new' };

test('T0.3/R0.3.0 computeResumeKey: no arm → bit-identical to legacy key', () => {
  // the exact legacy format (name-model-sha8) — the 6 no-arm lab.test.js call sites depend on this
  assert.equal(computeResumeKey({ name: 'resume-suite', model: 'sonnet', sha256: null }), 'resume-suite-sonnet-nosha');
  assert.equal(computeResumeKey({ name: 's', model: 'sonnet', sha256: 'deadbeefcafe' }), 's-sonnet-deadbeef');
});

test('T0.3/R0.3.1 computeResumeKey: two arms on same suite sha + model → distinct keys', () => {
  const base = { name: 's', model: 'sonnet', sha256: 'abcd1234ffff' };
  const kOld = computeResumeKey({ ...base, arm: armOld });
  const kNew = computeResumeKey({ ...base, arm: armNew });
  assert.notEqual(kOld, kNew);
  assert.ok(kOld.includes('old') && kOld.includes('1.0.0') && kOld.includes('p-old'));
  assert.ok(kNew.includes('new') && kNew.includes('2.0.0') && kNew.includes('p-new'));
});

// seed a journal file directly (mirrors lab.test.js seedJournal), optional arm header field
function seedJournal(dataDir, file, header, lines = []) {
  const dir = join(dataDir, 'experiments', '.inprogress');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), [JSON.stringify({ __aiide_journal: 1, ...header }), ...lines].join('\n') + '\n');
  return join(dir, file);
}
const cachedRep = (id) => ({
  runId: id, C: 1, P: 0.9, H: 0.95, activated: true, verifierResults: [{ pass: true, type: 'regex' }],
  rounds: 2, efficiency: { tokens: { in: 0, out: 0, cacheW: 0, cacheR: 0 }, durationMs: 100, costUsd: 0 }, error: null,
});

test('T0.3/R0.3.2 findJournal: arm B does NOT resume arm A journal (same name/model/sha)', () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const keyA = computeResumeKey({ name: 's', model: 'sonnet', sha256: null, arm: armOld });
  seedJournal(dataDir, `${keyA}.jsonl`, { name: 's', model: 'sonnet', repeats: 3, suiteSha256: null, arm: armOld });
  // arm A finds its own journal
  assert.equal(findJournal({ dataDir, name: 's', model: 'sonnet', repeats: 3, sha256: null, arm: armOld }).status, 'resume');
  // arm B — same name/model/sha/repeats — must treat it as a foreign identity → independent, not drift
  assert.equal(findJournal({ dataDir, name: 's', model: 'sonnet', repeats: 3, sha256: null, arm: armNew }).status, 'none');
  rmSync(root, { recursive: true, force: true });
});

test('T0.3/R0.3.2 findJournal: legacy (no-arm) journal is NOT resumed by an arm run, and vice-versa', () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  seedJournal(dataDir, 'legacy.jsonl', { name: 's', model: 'sonnet', repeats: 3, suiteSha256: null }); // no arm field
  // an arm run must not mis-resume a legacy journal
  assert.equal(findJournal({ dataDir, name: 's', model: 'sonnet', repeats: 3, sha256: null, arm: armOld }).status, 'none');
  // a no-arm run still resumes the legacy journal (unchanged behavior)
  assert.equal(findJournal({ dataDir, name: 's', model: 'sonnet', repeats: 3, sha256: null }).status, 'resume');

  // and the reverse: an arm journal is invisible to a no-arm run
  rmSync(join(dataDir, 'experiments', '.inprogress'), { recursive: true, force: true });
  seedJournal(dataDir, 'armed.jsonl', { name: 's', model: 'sonnet', repeats: 3, suiteSha256: null, arm: armOld });
  assert.equal(findJournal({ dataDir, name: 's', model: 'sonnet', repeats: 3, sha256: null }).status, 'none');
  rmSync(root, { recursive: true, force: true });
});

test('T0.3/R0.3.3 反例: arm B never reuses a completed arm-A journal → runs its own repeats (no delta≈0 fake)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    // arm A already "completed" 3 repeats, journal on disk (same name/model/sha as arm B will use)
    const keyA = computeResumeKey({ name: 's', model: 'sonnet', sha256: null, arm: armOld });
    seedJournal(dataDir, `${keyA}.jsonl`, { name: 's', model: 'sonnet', repeats: 3, suiteSha256: null, arm: armOld }, [
      JSON.stringify({ taskId: 'eth', repeat: 1, rep: cachedRep('A-1') }),
      JSON.stringify({ taskId: 'eth', repeat: 2, rep: cachedRep('A-2') }),
      JSON.stringify({ taskId: 'eth', repeat: 3, rep: cachedRep('A-3') }),
    ]);
    const suite = {
      name: 's', model: 'sonnet', repeats: 3, maxTurns: 5, timeoutMs: 30_000, skills: { dirs: [] },
      tasks: [{ id: 'eth', prompt: 'what is the price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    };
    // run arm B against the SAME suite — must NOT inherit arm A's cached repeats
    const expB = await runSuite({ suite, suiteDir: root, dataDir, arm: armNew, concurrency: 2 });
    const taskB = expB.tasks['eth'];
    // (c) B ran its own 3 repeats — none of A's runIds leaked in
    assert.equal(taskB.n, 3);
    for (const r of taskB.repeats) assert.ok(!String(r.runId).startsWith('A-'), 'must not reuse arm A repeats');
    assert.equal(readdirSync(join(dataDir, 'runs')).length, 3); // 3 fresh invocations happened
    // (a) keys differ, (b) arm-A journal filename ≠ arm-B key; arm-A journal survives untouched
    const keyB = computeResumeKey({ name: 's', model: 'sonnet', sha256: null, arm: armNew });
    assert.notEqual(keyA, keyB);
    assert.equal(existsSync(join(dataDir, 'experiments', '.inprogress', `${keyA}.jsonl`)), true);
    // arm-A journal still holds exactly A's repeats (never consumed by B)
    assert.equal(loadJournalRepeats(join(dataDir, 'experiments', '.inprogress', `${keyA}.jsonl`)).size, 3);
    // B recorded its arm identity in the experiment (R0.2.3)
    assert.equal(expB.arm.label, 'new');
    assert.equal(expB.arm.cliVersion, '2.0.0');
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================================
// T0.4 — R0.4: scripted-reply resume + incremental metrics merge
// ============================================================================================

test('T0.4/R0.4.3 mergeInvocationMetrics: incremental SUM (0.1263 + 0.0846 = 0.2109), not last/first', () => {
  const merged = mergeInvocationMetrics([
    { costUsd: 0.1263, rounds: 2, usage: { in: 500, out: 30, cacheW: 0, cacheR: 1000 }, C: 0, P: 0.8, H: 0.9 },
    { costUsd: 0.0846, rounds: 1, usage: { in: 600, out: 40, cacheW: 0, cacheR: 1100 }, C: 1, P: 0.95, H: 0.92 },
  ]);
  assert.equal(merged.costUsd, 0.2109);           // SUM
  assert.notEqual(merged.costUsd, 0.0846);        // not just the last invocation
  assert.notEqual(merged.costUsd, 0.1263);        // not just the first
  assert.equal(merged.rounds, 3);                 // rounds also incremental
  assert.deepEqual(merged.usage, { in: 1100, out: 70, cacheW: 0, cacheR: 2100 });
  assert.equal(merged.C, 1);                      // quality from the FINAL flow (last invocation)
  assert.equal(merged.flowStatus, 'complete');
});

test('T0.4/R0.4.1+R0.4.2 resumeWithScriptedReply: uses --resume <sid>, same cwd/CONFIG_DIR, NO --fork-session', async () => {
  const root = tmp();
  // a tiny stub that just echoes its own argv back as the result JSON
  const echo = join(root, 'echo-stub.js');
  writeFileSync(echo, `process.stdout.write(JSON.stringify({ result: 'ok', argv: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR }));\n`);
  const profileDir = join(root, 'profile');
  const workspaceDir = join(root, 'ws');
  mkdirSync(profileDir, { recursive: true });
  const res = await resumeWithScriptedReply({
    claude: { cmd: process.execPath, preArgs: [echo] },
    profileDir, workspaceDir, sessionId: 'sess-123', reply: 'yes, confirm', timeoutMs: 30_000,
  });
  const argv = res.output.argv;
  assert.ok(argv.includes('--resume'));
  assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-123');
  assert.ok(!argv.includes('--fork-session'));    // R0.4.2: pure append, no fork
  assert.equal(res.output.configDir, profileDir); // same CLAUDE_CONFIG_DIR
  assert.equal(res.output.cwd, workspaceDir);     // same workspace cwd
  rmSync(root, { recursive: true, force: true });
});

test('T0.4/R0.4.4 pure --resume is zero-replay: whole-JSONL parse has no duplicate uuids, no dedup needed', () => {
  // append-only session: first run (a1,a2) then --resume appends (a3,a4) into the SAME file
  const sid = 'sess-1';
  const line = (uuid, text) => JSON.stringify({
    type: 'assistant', message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text }],
      stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    uuid, sessionId: sid, timestamp: '2026-07-02T10:00:00.000Z',
  });
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q' }] }, uuid: 'u1', sessionId: sid, timestamp: '2026-07-02T10:00:00.000Z' }),
    line('a1', 'first'), line('a2', 'asked to confirm?'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'yes' }] }, uuid: 'u2', sessionId: sid, timestamp: '2026-07-02T10:00:10.000Z' }),
    line('a3', 'resuming'), line('a4', 'done'),
  ].join('\n');
  const run = parseSessionJsonl(jsonl, { source: 'test' });
  assert.equal(run.rounds.length, 4);             // full multi-round flow recovered from one parse
  const uuids = jsonl.split('\n').map(l => JSON.parse(l).uuid);
  assert.equal(new Set(uuids).size, uuids.length); // no duplicate lines → nothing to dedup
});

test('T0.4/R0.4.5 缺腳本 halted → excluded-not-zero + flow-incomplete (never a fake C=0)', () => {
  const marked = markScriptedReplyExcluded({ runId: 'h1', C: 0, error: null }, 'no-scripted-reply');
  assert.equal(marked.excluded, true);
  assert.equal(marked.flowStatus, 'incomplete');
  assert.equal(marked.excludedSignature, 'flow-incomplete');
  // through scoreTask: the excluded repeat leaves the denominator, so C is NOT contaminated by a 0
  const valid = (id) => ({ runId: id, C: 1, P: 0.9, H: 0.9, activated: true, verifierResults: [], rounds: 1,
    efficiency: { tokens: { in: 0, out: 0, cacheW: 0, cacheR: 0 }, durationMs: 10, costUsd: 0.01 }, error: null });
  const t = scoreTask([valid('v1'), valid('v2'), marked]);
  assert.equal(t.excludedRepeats, 1);
  assert.equal(t.n, 2);                            // excluded dropped from denominator
  assert.equal(t.C, 1);                            // both valid reps C=1 → not dragged to 0.67 by the halt
});

// ============================================================================================
// T0.5 — R0.5: run budget estimate
// ============================================================================================

test('T0.5/R0.5.1 estimateBudget: sessions = arms × cases × repeats (2 × 25 × 3 = 150)', () => {
  const b = estimateBudget({ arms: 2, cases: 25, repeats: 3, concurrency: 6 });
  assert.equal(b.sessions, 150);
  assert.ok(b.usdEst > 0);                         // priced via metrics.js
  assert.ok(Number.isFinite(b.etaMs));
});

test('T0.5/R0.5.1 estimateBudget: etaMs strictly decreases as concurrency rises (6 < 1)', () => {
  const c1 = estimateBudget({ arms: 2, cases: 25, repeats: 3, concurrency: 1 });
  const c6 = estimateBudget({ arms: 2, cases: 25, repeats: 3, concurrency: 6 });
  assert.ok(c6.etaMs < c1.etaMs, `${c6.etaMs} should be < ${c1.etaMs}`);
  // arms as an array is accepted too (length used)
  assert.equal(estimateBudget({ arms: ['old', 'new'], cases: 25, repeats: 3 }).sessions, 150);
});

test('T0.5/R0.5.2 estimateBudget: same function is CLI/U7-consumable — returns a plain serializable record', () => {
  const b = estimateBudget({ arms: 2, cases: 10, repeats: 3, concurrency: UPGRADE_CONFIG.concurrency.default });
  assert.deepEqual(Object.keys(b).sort(), ['concurrency', 'etaMs', 'perSessionUsd', 'pricingMatched', 'sessions', 'usdEst']);
  assert.equal(JSON.parse(JSON.stringify(b)).sessions, 60); // round-trips through JSON (report footer)
});

// ============================================================================================
// T-stats — seal-time experiment statistics (design §2). The engine is unit-tested in
// upgrade-expstats.test.js; these assert the LAB WIRING: stats is embedded at seal, over the FINAL
// reps, with held_out/category/expected_skill persisted, and — the challenge-loop BLOCKER — that a
// journal-CACHED rep (which never re-ran buildRepeat) is still counted because collection runs at
// seal via the on-disk runs loader.
// ============================================================================================

test('T-stats/seal: runSuite embeds experiment.stats (identity holds, probes:null w/o probes, attrs persisted)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const suite = {
      name: 'stats-suite', model: 'sonnet', repeats: 2, maxTurns: 5, timeoutMs: 30_000,
      skills: { dirs: [] },
      tasks: [
        { id: 'eth', prompt: 'what is the price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }], targetSkills: ['okx-dex-market'], category: 'price' },
        { id: 'held', prompt: 'held out one', verifiers: [{ type: 'regex', pattern: 'ETH' }], held_out: true, targetSkills: ['okx-dex-market'] },
      ],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir, concurrency: 2 });
    const s = exp.stats;
    assert.ok(s && !s.error, 'stats present and not degraded');
    assert.equal(s.schemaVersion, 3);              // taxonomy T1 Stage 3 rebaseline (was §S v2)
    // §S v2 seal 判定：claude-code runtime → inventoryStatus 'snapshot'；refMeta 随 stats 落盘
    // （无 skills 装载 → {} = 可知且空，绝非 null）
    assert.equal(s.refCoverage.inventoryStatus, 'snapshot');
    assert.deepEqual(s.refCoverage.refMeta, {});
    assert.equal(s.probes, null);                    // no probes configured → probes null (not [])
    // resolveReps identity (受測): nRaw = valid + excluded + heldOut + noSession + unresolved
    assert.equal(s.nRaw, s.nCoverageValid + s.nExcluded + s.heldOutExcluded + s.noSession + s.nUnresolved);
    assert.equal(s.nRaw, 4);                          // 2 tasks × 2 repeats
    assert.equal(s.heldOutExcluded, 2);              // held_out case's reps moved out FIRST
    assert.equal(s.nCoverageValid, 2);              // only the eth case's reps are valid coverage
    // the stub triggers okx-dex-market → it shows up in everTriggered over the valid case union
    assert.ok(s.skillCoverage.everTriggered.some(e => e.skill === 'okx-dex-market'));
    assert.ok(s.proximity && Array.isArray(s.proximity.edges), 'proximity block present');
    // §2.2-6 additive persistence on the sealed tasks
    assert.equal(exp.tasks.eth.category, 'price');
    assert.equal(exp.tasks.eth.expected_skill, 'okx-dex-market');
    assert.equal(exp.tasks.held.held_out, true);
    // Phase 1 (upgrade fidelity): each repeat carries an L1 routing verdict (l1Pass), so a dynamic
    // arm can build a real L1 axis. targetSkills present → l1Pass is a boolean (not undefined).
    assert.equal(typeof exp.tasks.eth.repeats[0].l1Pass, 'boolean');
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-stats/resume BLOCKER: journal-CACHED reps counted in nCoverageValid at seal (NOT in buildRepeat)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    // an earlier interrupted attempt left these two runs on disk + a journal marking both reps done
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const onDiskRun = (id) => JSON.stringify({
      run: { id, sessionId: id, rounds: [{ seq: 1, toolCalls: [{ name: 'Skill', skill: 'okx-dex-market' }] }] }, metrics: {},
    });
    writeFileSync(join(dataDir, 'runs', 'CACHED-1.json'), onDiskRun('CACHED-1'));
    writeFileSync(join(dataDir, 'runs', 'CACHED-2.json'), onDiskRun('CACHED-2'));
    const key = computeResumeKey({ name: 'resume-stats', model: 'sonnet', sha256: null });
    seedJournal(dataDir, `${key}.jsonl`, { name: 'resume-stats', model: 'sonnet', repeats: 2, suiteSha256: null }, [
      JSON.stringify({ taskId: 'eth', repeat: 1, rep: cachedRep('CACHED-1') }),
      JSON.stringify({ taskId: 'eth', repeat: 2, rep: cachedRep('CACHED-2') }),
    ]);
    const suite = {
      name: 'resume-stats', model: 'sonnet', repeats: 2, maxTurns: 5, timeoutMs: 30_000, skills: { dirs: [] },
      tasks: [{ id: 'eth', prompt: 'price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }], targetSkills: ['okx-dex-market'] }],
    };
    // both reps resume from the journal → buildRepeat NEVER runs this invocation, no fresh runs written
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    assert.equal(readdirSync(join(dataDir, 'runs')).length, 2, 'no fresh invocation — only the 2 cached runs exist');
    // the load-bearing assertion: cached reps are in the coverage denominator, collected at seal from disk
    assert.equal(exp.stats.nCoverageValid, 2, 'cached reps counted via the on-disk runs loader');
    assert.equal(exp.stats.nUnresolved, 0);
    assert.ok(exp.stats.skillCoverage.everTriggered.some(e => e.skill === 'okx-dex-market'));
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================================
// T-stats/v2 — §S schemaVersion 2 seal 端素材：tokensEstCJK 與 snapshotRefInventory.refMeta
// ============================================================================================

test('T-stats/v2 tokensEstCJK: CJK 字元 ×1、其餘 ÷4 向上取整、全形標點計 CJK（金樣本）', () => {
  assert.equal(tokensEstCJK('跨鏈橋接資產'), 6);       // 純中文 ≈ 字元數
  assert.equal(tokensEstCJK('abcdefgh'), 2);          // 純 ASCII ≈ chars/4（8/4）
  assert.equal(tokensEstCJK('abcde'), 2);             // 向上取整：ceil(5/4)
  assert.equal(tokensEstCJK('，。'), 2);              // 全形標點（U+FF0C / U+3002）計 CJK ×1
  assert.equal(tokensEstCJK('中文abcd'), 3);          // 混合：2×1 + 4/4
  assert.equal(tokensEstCJK(''), 0);                  // 空檔案 → 0（不是 null——檔案可知且空）
});

test('T-stats/v2 snapshotRefInventory: refMeta 僅明文 logicalRef；_shared 不入 refMeta（md5 namespace 不可重現）', () => {
  const root = tmp();
  const refsDir = join(root, 'skills', 's.a', 'references');
  mkdirSync(join(refsDir, '_shared'), { recursive: true });
  writeFileSync(join(root, 'skills', 's.a', 'SKILL.md'), '---\nname: s.a\n---\nbody');
  const cjkDoc = '滑點保護說明';                                   // 6 CJK chars → tokensEst 6
  writeFileSync(join(refsDir, 'guide.md'), cjkDoc);
  writeFileSync(join(refsDir, '_shared', 'util.md'), 'shared body content');
  const { inventory, refMeta } = snapshotRefInventory(root, ['s.a']);

  // inventory 照舊列出全部 shipped refs（含 _shared 明文路徑）
  assert.deepEqual(inventory['s.a'].refs,
    ['s.a/references/_shared/util.md', 's.a/references/guide.md']);
  assert.ok(inventory['s.a'].versionSha, 'SKILL.md sha256 captured');
  // refMeta 僅覆蓋明文 logicalRef；bytes = UTF-8 位元組數、tokensEst = CJK-aware
  assert.deepEqual(Object.keys(refMeta), ['s.a/references/guide.md']);
  assert.equal(refMeta['s.a/references/guide.md'].bytes, Buffer.byteLength(cjkDoc, 'utf8'));
  assert.equal(refMeta['s.a/references/guide.md'].tokensEst, 6);
  rmSync(root, { recursive: true, force: true });
});
