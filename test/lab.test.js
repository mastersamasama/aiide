import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureProfile, verifyIsolation, runHeadless, runSuite, findSessionJsonl,
  computeResumeKey, findJournal, loadJournalRepeats,
} from '../src/lab.js';
import { parseJsonc, loadSuite, scaffoldSuite } from '../src/suite.js';

const STUB = fileURLToPath(new URL('./fixtures/claude-stub.js', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/aiide.js', import.meta.url));
const stubClaude = { cmd: process.execPath, preArgs: [STUB] };

function tmp() { return mkdtempSync(join(tmpdir(), 'aiide-test-')); }

function makeSkillDir(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\nbody`);
  return dir;
}

test('ensureProfile: installs only specified skills; isolation invariant holds (AC 3.1)', () => {
  const root = tmp();
  const s1 = makeSkillDir(root, 'skill-a');
  const s2 = makeSkillDir(root, 'skill-b');
  const { profileDir, installedSkills } = ensureProfile({
    name: 'p1', skillDirs: [s1, s2], dataDir: join(root, '.aiide'), sourceConfigDir: root, // no credentials file → skipped
  });
  assert.deepEqual(installedSkills.sort(), ['skill-a', 'skill-b']);
  assert.deepEqual(readdirSync(join(profileDir, 'skills')).sort(), ['skill-a', 'skill-b']);
  assert.ok(existsSync(join(profileDir, '.claude.json')));
  assert.ok(existsSync(join(profileDir, 'projects')));
  assert.equal(verifyIsolation(profileDir, ['skill-a', 'skill-b']).ok, true);
  assert.equal(verifyIsolation(profileDir, ['skill-a']).ok, false); // extra skill detected

  // rebuild with fewer skills → previous ones must be gone (idempotent rebuild)
  ensureProfile({ name: 'p1', skillDirs: [s1], dataDir: join(root, '.aiide'), sourceConfigDir: root });
  assert.deepEqual(readdirSync(join(profileDir, 'skills')), ['skill-a']);
  rmSync(root, { recursive: true, force: true });
});

test('runHeadless: captures result JSON + session jsonl findable (AC 3.2/3.4)', async () => {
  const root = tmp();
  const profileDir = join(root, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const res = await runHeadless({
    claude: stubClaude, profileDir, workspaceDir: join(root, 'ws'),
    prompt: 'what is the price of ETH?', timeoutMs: 30_000,
  });
  assert.equal(res.timedOut, false);
  assert.ok(res.output);
  assert.match(res.output.result, /2,500\.12/);
  const jsonl = findSessionJsonl(profileDir, res.output.session_id);
  assert.ok(jsonl, 'session jsonl should be located inside profile');
  rmSync(root, { recursive: true, force: true });
});

test('runHeadless: timeout kills process and reports timedOut (AC 3.5)', async () => {
  const root = tmp();
  const profileDir = join(root, 'profile');
  mkdirSync(profileDir, { recursive: true });
  process.env.STUB_MODE = 'hang';
  const t0 = Date.now();
  let res;
  try {
    res = await runHeadless({
      claude: { cmd: process.execPath, preArgs: [STUB] }, profileDir,
      workspaceDir: join(root, 'ws'), prompt: 'x', timeoutMs: 1500,
    });
  } finally {
    delete process.env.STUB_MODE;
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 30_000, 'kill happened well before the stub 60s hang');
  assert.equal(res.output, null);
});

test('runSuite: full pipeline — repeats, scoring, experiment json, failure isolation (AC 3.3/3.5/4.x)', async () => {
  const root = tmp();
  const skill = makeSkillDir(root, 'okx-dex-market');
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const suite = {
      name: 'stub-suite', model: 'sonnet', repeats: 3, maxTurns: 10, timeoutMs: 30_000,
      skills: { dirs: [skill] }, targetSkills: ['okx-dex-market'],
      tasks: [{
        id: 'eth-price', prompt: 'what is the price of ETH?',
        verifiers: [
          { type: 'numeric_range', min: 100, max: 100000 },
          { type: 'regex', pattern: 'ETH' },
        ],
      }],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    assert.equal(exp.isolationVerified, true);
    assert.deepEqual(exp.profile.skills, ['okx-dex-market']);
    const task = exp.tasks['eth-price'];
    assert.equal(task.n, 3);
    assert.equal(task.C, 1);            // stub always answers with valid price
    assert.equal(task.activationRate, 1); // Skill tool + attributionSkill present in stub jsonl
    assert.equal(task.lowSample, false);
    assert.ok(task.wilsonCi.lo > 0.4);
    assert.ok(exp.summary.composite > 0.8);
    assert.equal(task.repeats[0].efficiency.costUsdReported, 0.0123);
    // runs persisted with experiment meta
    const runFiles = readdirSync(join(dataDir, 'runs'));
    assert.equal(runFiles.length, 3);
    // experiment persisted
    assert.equal(readdirSync(join(dataDir, 'experiments')).length, 1);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('runSuite: claude process failure → repeat recorded as failed, suite continues (AC 3.5)', async () => {
  const root = tmp();
  const skill = makeSkillDir(root, 'okx-dex-market');
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  process.env.STUB_MODE = 'fail';
  try {
    const suite = {
      name: 'fail-suite', repeats: 2, timeoutMs: 30_000,
      skills: { dirs: [skill] }, targetSkills: ['okx-dex-market'],
      tasks: [{ id: 't1', prompt: 'x', verifiers: [{ type: 'regex', pattern: 'x' }] }],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    const task = exp.tasks['t1'];
    assert.equal(task.failedRepeats, 2);
    assert.equal(task.C, 0);
    assert.equal(task.lowSample, true); // n=2 < 3
    assert.ok(task.repeats[0].error);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    delete process.env.STUB_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- S1: eval-resume-incremental ----------------------------------------------------------

const cachedRep = (id) => ({
  runId: id, C: 1, P: 0.9, H: 0.95, activated: true,
  verifierResults: [{ pass: true, type: 'regex' }], rounds: 2,
  efficiency: { tokens: { in: 0, out: 0, cacheW: 0, cacheR: 0 }, durationMs: 100, costUsd: 0 },
  error: null,
});

// write a journal directly into <dataDir>/experiments/.inprogress/<file>
function seedJournal(dataDir, file, header, lines = []) {
  const dir = join(dataDir, 'experiments', '.inprogress');
  mkdirSync(dir, { recursive: true });
  const body = [JSON.stringify({ __aiide_journal: 1, ...header }), ...lines].join('\n') + '\n';
  writeFileSync(join(dir, file), body);
  return join(dir, file);
}

function jsuite(over = {}) {
  return {
    name: 'resume-suite', model: 'sonnet', repeats: 3, maxTurns: 10, timeoutMs: 30_000,
    skills: { dirs: [] }, targetSkills: ['okx-dex-market'],
    tasks: [{ id: 'eth-price', prompt: 'what is the price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    ...over,
  };
}

test('S1 resume: cached repeats reused, only new ones run, journal deleted (AC a/c)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const key = computeResumeKey({ name: 'resume-suite', model: 'sonnet', sha256: null });
    seedJournal(dataDir, `${key}.jsonl`, { name: 'resume-suite', model: 'sonnet', repeats: 3, suiteSha256: null }, [
      JSON.stringify({ taskId: 'eth-price', repeat: 1, rep: cachedRep('cached-1') }),
      JSON.stringify({ taskId: 'eth-price', repeat: 2, rep: cachedRep('cached-2') }),
    ]);
    const events = [];
    const exp = await runSuite({ suite: jsuite(), suiteDir: root, dataDir, onProgress: e => events.push(e) });
    const task = exp.tasks['eth-price'];
    assert.equal(task.n, 3);
    assert.equal(task.repeats[0].runId, 'cached-1');       // r1 served from journal
    assert.equal(task.repeats[1].runId, 'cached-2');       // r2 served from journal
    assert.notEqual(task.repeats[2].runId, null);          // r3 freshly run
    // only r3 actually executed → exactly one run file on disk (cached runIds were never real files)
    assert.equal(readdirSync(join(dataDir, 'runs')).length, 1);
    assert.ok(events.some(e => e.type === 'resume' && e.done === 2 && e.total === 3));
    assert.ok(events.some(e => e.type === 'repeat-done' && e.repeat === 1 && e.cached === true));
    // sealed + journal removed
    assert.equal(readdirSync(join(dataDir, 'experiments')).filter(f => f.endsWith('.json')).length, 1);
    assert.equal(existsSync(join(dataDir, 'experiments', '.inprogress', `${key}.jsonl`)), false);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S1 drift: repeats change rejects resume and does not start (AC b)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  seedJournal(dataDir, 'seed.jsonl', { name: 'resume-suite', model: 'sonnet', repeats: 5, suiteSha256: null }, [
    JSON.stringify({ taskId: 'eth-price', repeat: 1, rep: cachedRep('c1') }),
  ]);
  await assert.rejects(
    runSuite({ suite: jsuite({ repeats: 3 }), suiteDir: root, dataDir }),
    /cannot resume: repeats changed \(5→3\) — use --fresh/,
  );
  assert.equal(existsSync(join(dataDir, 'runs')), false); // rejected before any artifact created
  rmSync(root, { recursive: true, force: true });
});

test('S1 drift: suite content change rejects resume (AC b)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suitePath = join(root, 's.json');
  writeFileSync(suitePath, JSON.stringify(jsuite()));
  seedJournal(dataDir, 'seed.jsonl', { name: 'resume-suite', model: 'sonnet', repeats: 3, suiteSha256: 'deadbeefdeadbeef' });
  await assert.rejects(
    runSuite({ suite: jsuite(), suiteDir: root, suitePath, dataDir }),
    /cannot resume: suite changed \(dead→/,
  );
  rmSync(root, { recursive: true, force: true });
});

test('S1 --fresh: ignores journal, reruns everything (AC b/R3.2)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const key = computeResumeKey({ name: 'resume-suite', model: 'sonnet', sha256: null });
    seedJournal(dataDir, `${key}.jsonl`, { name: 'resume-suite', model: 'sonnet', repeats: 2, suiteSha256: null }, [
      JSON.stringify({ taskId: 'eth-price', repeat: 1, rep: cachedRep('cached-1') }),
    ]);
    const exp = await runSuite({ suite: jsuite({ repeats: 2 }), suiteDir: root, dataDir, fresh: true });
    const task = exp.tasks['eth-price'];
    assert.equal(task.n, 2);
    assert.notEqual(task.repeats[0].runId, 'cached-1'); // cached rep discarded, r1 freshly run
    assert.equal(readdirSync(join(dataDir, 'runs')).length, 2);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S1 crash-safety: corrupt tail line tolerated (AC e)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const key = computeResumeKey({ name: 'resume-suite', model: 'sonnet', sha256: null });
    seedJournal(dataDir, `${key}.jsonl`, { name: 'resume-suite', model: 'sonnet', repeats: 2, suiteSha256: null }, [
      JSON.stringify({ taskId: 'eth-price', repeat: 1, rep: cachedRep('cached-1') }),
      '{"taskId":"eth-price","repeat":2,"rep":{trunc', // half-written crash tail
    ]);
    const map = loadJournalRepeats(join(dataDir, 'experiments', '.inprogress', `${key}.jsonl`));
    assert.equal(map.size, 1); // bad tail skipped, good line kept
    const exp = await runSuite({ suite: jsuite({ repeats: 2 }), suiteDir: root, dataDir });
    assert.equal(exp.tasks['eth-price'].n, 2);
    assert.equal(exp.tasks['eth-price'].repeats[0].runId, 'cached-1');
    assert.equal(readdirSync(join(dataDir, 'runs')).length, 1); // only r2 ran
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S1 per-repeat logs: exception/stdout/trace written per repeat (R7)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    await runSuite({ suite: jsuite({ repeats: 1 }), suiteDir: root, dataDir });
    const key = computeResumeKey({ name: 'resume-suite', model: 'sonnet', sha256: null });
    const logDir = join(dataDir, 'logs', key, 'eth-price-r1');
    assert.ok(existsSync(join(logDir, 'stdout.txt')));
    assert.ok(existsSync(join(logDir, 'trace.json')));
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S1 dashboard-invisible: journal filtered by endsWith(.json) + subdir (AC d)', () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  seedJournal(dataDir, 'x.jsonl', { name: 'n', model: 'm', repeats: 3, suiteSha256: null });
  writeFileSync(join(dataDir, 'experiments', 'real.json'), '{}');
  // mirrors server.js:117 listExperiments — non-recursive readdir + endsWith('.json')
  const listed = readdirSync(join(dataDir, 'experiments')).filter(f => f.endsWith('.json'));
  assert.deepEqual(listed, ['real.json']); // .inprogress dir + .jsonl never surface
  assert.equal(findJournal({ dataDir, name: 'n', model: 'm', repeats: 3, sha256: null }).status, 'resume');
  rmSync(root, { recursive: true, force: true });
});

// ---- S10: lab init + JSONC loader ---------------------------------------------------------

test('S10 parseJsonc: strips // and /* */ comments but not // inside strings', () => {
  const obj = parseJsonc(`{
    // a line comment
    "url": "http://127.0.0.1:3901/health",  /* block */
    "n": 1  // trailing
  }`);
  assert.equal(obj.url, 'http://127.0.0.1:3901/health'); // // inside the string survived
  assert.equal(obj.n, 1);
  // strict JSON still parses through loadSuite's fast path (no comments)
  assert.deepEqual(parseJsonc('{"a":1}'), { a: 1 });
});

test('S10 lab init: skeleton round-trips through loadSuite AND runs (AC)', async () => {
  const root = tmp();
  const suitePath = join(root, 'my.json');
  writeFileSync(suitePath, scaffoldSuite());          // what `lab init` writes
  const suite = loadSuite(suitePath);                 // JSONC → object
  assert.equal(suite.name, 'my-suite');
  assert.ok(suite.tasks.length >= 2);
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const exp = await runSuite({ suite: { ...suite, repeats: 1, retry: { maxRetries: 0, baseDelayMs: 1 } }, suiteDir: root, dataDir: join(root, '.aiide') });
    assert.ok(exp.tasks['single-step-example']); // parsed + executed end-to-end
    assert.ok(exp.tasks['multi-step-example']);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S10 lab init CLI: writes, refuses overwrite, --force overwrites (R1.3)', () => {
  const root = tmp();
  const p = join(root, 's.json');
  assert.match(execFileSync(process.execPath, [BIN, 'lab', 'init', '--suite', p, '--data-dir', root], { encoding: 'utf8' }), /wrote suite skeleton/);
  assert.ok(existsSync(p));
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'lab', 'init', '--suite', p], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => { assert.match(String(err.stderr), /already exists/); return true; },
  );
  assert.match(execFileSync(process.execPath, [BIN, 'lab', 'init', '--suite', p, '--force'], { encoding: 'utf8' }), /wrote suite skeleton/);
  rmSync(root, { recursive: true, force: true });
});

// ---- S2: env-noise retry / exclusion (e2e) ------------------------------------------------

test('S2 retry recovers: transient env-noise on attempt 1, success on retry, nothing excluded', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  process.env.STUB_MODE = 'envnoise-once';
  process.env.STUB_COUNTER = join(root, 'counter');
  try {
    const suite = jsuite({ repeats: 1, retry: { maxRetries: 2, baseDelayMs: 1 } });
    const events = [];
    const exp = await runSuite({ suite, suiteDir: root, dataDir, onProgress: e => events.push(e) });
    const task = exp.tasks['eth-price'];
    assert.equal(task.excludedRepeats, 0);   // recovered → not excluded
    assert.equal(task.C, 1);                  // the retry succeeded
    assert.ok(events.some(e => e.type === 'repeat-retry' && e.signature === 'rate-limit-429'));
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN; delete process.env.STUB_MODE; delete process.env.STUB_COUNTER;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 retry exhausted: persistent env-noise → excluded, degraded, raw error logged (AC a/d)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  process.env.STUB_MODE = 'envnoise';
  try {
    const suite = jsuite({ repeats: 3, retry: { maxRetries: 1, baseDelayMs: 1 } });
    const events = [];
    const exp = await runSuite({ suite, suiteDir: root, dataDir, onProgress: e => events.push(e) });
    const task = exp.tasks['eth-price'];
    assert.equal(task.excludedRepeats, 3);
    assert.equal(task.n, 0);
    assert.equal(task.C, null);
    assert.equal(task.composite, null);       // guardrail a: all-excluded → null, never fake 0
    assert.equal(task.degraded, true);
    assert.equal(exp.summary.composite, null);
    assert.equal(exp.summary.degraded, true);
    assert.equal(exp.summary.excludedRepeats, 3);
    assert.ok(events.some(e => e.type === 'repeat-done' && e.excluded === true));
    // AC d: the raw error is on disk for audit
    const key = computeResumeKey({ name: 'resume-suite', model: 'sonnet', sha256: null });
    const exc = readFileSync(join(dataDir, 'logs', key, 'eth-price-r1', 'exception.txt'), 'utf8');
    assert.match(exc, /53017/);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN; delete process.env.STUB_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 (AC c): timeout is NOT env-noise — counts as C=0, never excluded', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  process.env.STUB_MODE = 'hang';
  try {
    const suite = jsuite({ repeats: 1, timeoutMs: 1500, retry: { maxRetries: 2, baseDelayMs: 1 } });
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    const task = exp.tasks['eth-price'];
    assert.equal(task.excludedRepeats, 0);
    assert.equal(task.C, 0);
    assert.equal(task.failedRepeats, 1);
    assert.notEqual(task.repeats[0].excluded, true);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN; delete process.env.STUB_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2 (AC e): degraded surfaces in BOTH scorecard and comparison render paths', () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suitePath = join(root, 's.json');
  writeFileSync(suitePath, JSON.stringify(jsuite({ repeats: 2, retry: { maxRetries: 1, baseDelayMs: 1 } })));
  const out = execFileSync(process.execPath, [BIN, 'lab', 'run', '--suite', suitePath, '--models', 'sonnet,opus', '--data-dir', dataDir], {
    encoding: 'utf8',
    env: { ...process.env, AIIDE_CLAUDE_BIN: `${process.execPath}||${STUB}`, STUB_MODE: 'envnoise' },
  });
  assert.match(out, /⚠ degraded: 2 repeats excluded/); // printScorecard banner
  assert.match(out, /SkillScore n\/a/);                 // null composite rendered, not a crash
  assert.match(out, /degraded \(2 excluded\)/);         // printComparison cell
  rmSync(root, { recursive: true, force: true });
});

// ---- S3: file_exists verifier e2e (against the repeat workspace) --------------------------

test('S3 file_exists: verifier resolves against the repeat workspace (AC a/R1.4)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  process.env.STUB_WRITE_FILE = 'out/result.json'; // stub drops this into cwd = workspace
  try {
    const suite = {
      name: 'fileexists-suite', model: 'sonnet', repeats: 1, maxTurns: 5, timeoutMs: 30_000,
      skills: { dirs: [] },
      tasks: [
        { id: 'makes-file', prompt: 'produce a file', verifiers: [{ type: 'file_exists', path: 'out/result.json', schema: { required: ['price', 'symbol'] } }] },
        { id: 'wrong-path', prompt: 'produce a file', verifiers: [{ type: 'file_exists', path: 'out/missing.json' }] },
      ],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    assert.equal(exp.tasks['makes-file'].C, 1);   // file present + schema satisfied → C=1
    assert.equal(exp.tasks['wrong-path'].C, 0);   // path never written → C=0
    // pass@k diagnostics present (single repeat → only pass@1)
    assert.equal(exp.tasks['makes-file'].passAtK['1'], 1);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN; delete process.env.STUB_WRITE_FILE;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- S12: multi-step task -----------------------------------------------------------------

test('S12 multi-step: all steps pass → C=1, every step recorded (AC a)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const suite = {
      name: 'multistep-suite', model: 'sonnet', repeats: 1, maxTurns: 5, timeoutMs: 30_000, skills: { dirs: [] },
      tasks: [{ id: 'flow', steps: [
        { prompt: 'check price', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
        { prompt: 'place order', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
        { prompt: 'confirm', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
      ] }],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    const task = exp.tasks['flow'];
    assert.equal(task.C, 1);
    assert.equal(task.repeats[0].steps.length, 3);
    assert.equal(task.repeats[0].abortedAtStep, null);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S12 min_reward: a failed step aborts the rest, C=0, abort point recorded (AC a)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const suite = {
      name: 'multistep-abort', model: 'sonnet', repeats: 1, maxTurns: 5, timeoutMs: 30_000, skills: { dirs: [] },
      tasks: [{ id: 'flow', minReward: 1, steps: [
        { prompt: 's1', verifiers: [{ type: 'regex', pattern: 'ETH' }] },       // passes
        { prompt: 's2', verifiers: [{ type: 'regex', pattern: 'NOPEXYZ' }] },   // fails → abort
        { prompt: 's3', verifiers: [{ type: 'regex', pattern: 'ETH' }] },       // must NOT run
      ] }],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    const task = exp.tasks['flow'];
    assert.equal(task.C, 0);
    assert.equal(task.repeats[0].abortedAtStep, 2);
    assert.equal(task.repeats[0].steps.length, 2);      // step 3 never ran
    assert.equal(task.repeats[0].steps[0].reward, 1);
    assert.equal(task.repeats[0].steps[1].reward, 0);
    assert.equal(readdirSync(join(dataDir, 'runs')).length, 2); // only 2 invocations happened
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S12 + S3: file written in an early step is visible to a later step (shared workspace)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  process.env.STUB_WRITE_FILE = 'out/result.json';
  try {
    const suite = {
      name: 'multistep-file', model: 'sonnet', repeats: 1, maxTurns: 5, timeoutMs: 30_000, skills: { dirs: [] },
      tasks: [{ id: 'flow', steps: [
        { prompt: 'produce artifact', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
        { prompt: 'verify artifact', verifiers: [{ type: 'file_exists', path: 'out/result.json' }] },
      ] }],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    assert.equal(exp.tasks['flow'].C, 1); // workspace persisted across steps → file_exists passes
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN; delete process.env.STUB_WRITE_FILE;
    rmSync(root, { recursive: true, force: true });
  }
});
