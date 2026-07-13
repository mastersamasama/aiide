import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  redactSecrets, resolveMeta, parseMetaFlags, runCaptures, hashDir,
  modelMismatch, loadSettings, saveSettings, collectEnvironment,
} from '../src/meta.js';
import { runSuite } from '../src/lab.js';

const BIN = fileURLToPath(new URL('../bin/aiide.js', import.meta.url));
const CLAUDE_STUB = fileURLToPath(new URL('./fixtures/claude-stub.js', import.meta.url));

function tmp() { return mkdtempSync(join(tmpdir(), 'aiide-meta-')); }

// ---- redaction (R3.4 / R6.3) ----

test('redactSecrets: masks API keys, JWTs, k=v secrets; keeps git SHAs (by design)', () => {
  assert.equal(redactSecrets('key sk-abcdefgh1234 end'), 'key *** end');
  assert.equal(redactSecrets('eyJhbGciOi.eyJzdWIiOm.SflKxwRJSm'), '***');
  assert.equal(redactSecrets('token=abc123 rest'), 'token=*** rest');
  assert.equal(redactSecrets('APIKEY: hunter2'), 'APIKEY=***');
  const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
  assert.equal(redactSecrets(sha), sha); // git commit ids are legitimate capture output
  assert.equal(redactSecrets('v0.4.2'), 'v0.4.2');
});

// ---- resolveMeta (R2) ----

test('resolveMeta: precedence cli > suite > defaults, source recorded (AC 2.4)', () => {
  const m = resolveMeta({
    cliPairs: [['branch', 'cli-wins']],
    suiteMeta: { branch: 'suite', team: 'onchain' },
    settingsMeta: { branch: 'defaults', box: 'x1' },
  });
  assert.deepEqual(m.branch, { value: 'cli-wins', source: 'cli' });
  assert.deepEqual(m.team, { value: 'onchain', source: 'suite' });
  assert.deepEqual(m.box, { value: 'x1', source: 'defaults' });
});

test('resolveMeta: deterministic — same input, same output', () => {
  const input = { cliPairs: [['a', '1']], suiteMeta: { b: 2 }, settingsMeta: { c: true } };
  assert.deepEqual(resolveMeta(input), resolveMeta(input));
});

test('resolveMeta: invalid key / reserved key / bad value type throw (AC 2.5/2.6)', () => {
  assert.throws(() => resolveMeta({ suiteMeta: { 'bad key!': 1 } }), /invalid meta key/);
  assert.throws(() => resolveMeta({ suiteMeta: { model: 'x' } }), /reserved.*aiideVersion/s);
  assert.throws(() => resolveMeta({ suiteMeta: { obj: {} } }), /must be string\/number\/boolean/);
});

test('parseMetaFlags: valid pairs + format error with usage hint (AC 2.2/2.7)', () => {
  assert.deepEqual(parseMetaFlags(['a=1', 'b=x=y']), [['a', '1'], ['b', 'x=y']]);
  assert.deepEqual(parseMetaFlags([]), []);
  assert.throws(() => parseMetaFlags(['nope']), /--meta expects k=v.*got "nope"/s);
  assert.throws(() => parseMetaFlags(['=v']), /--meta expects k=v/);
});

// ---- hashDir (AC 1.6) ----

test('hashDir: content-sensitive, mtime-insensitive (correctness property)', () => {
  const root = tmp();
  const mk = (name, body) => {
    const d = join(root, name);
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), body);
    writeFileSync(join(d, 'sub', 'x.txt'), 'x');
    return d;
  };
  const a = mk('a', 'hello');
  const b = mk('b', 'hello');
  assert.equal(hashDir(a), hashDir(b));                 // identical content → identical hash
  utimesSync(join(a, 'SKILL.md'), new Date(0), new Date(0));
  assert.equal(hashDir(a), hashDir(b));                 // mtime never enters the digest
  writeFileSync(join(a, 'SKILL.md'), 'changed');
  assert.notEqual(hashDir(a), hashDir(b));              // content change → hash change
  rmSync(root, { recursive: true, force: true });
});

// ---- modelMismatch (AC 1.3/1.4) ----

test('modelMismatch: substring either way matches; empty observed never flags', () => {
  assert.equal(modelMismatch('sonnet', ['claude-sonnet-5']), false);
  assert.equal(modelMismatch('claude-sonnet-5-latest', ['claude-sonnet-5']), false);
  assert.equal(modelMismatch('sonnet', ['deepseek-v4']), true);
  assert.equal(modelMismatch('sonnet', []), false);     // completion-only → no judgement
  assert.equal(modelMismatch(null, ['x']), false);
});

// ---- runCaptures (R3) ----

test('runCaptures: success / non-zero exit / timeout / no output all degrade (AC 3.2/3.3)', async () => {
  const res = await runCaptures({
    ok: 'node -p "40+2"',
    boom: 'node -e "process.exit(3)"',
    slow: 'node -e "setTimeout(function(){}, 5000)"',
    silent: 'node -e "0"',
    'bad name!': 'node -p "1"',
  }, { timeoutMs: 1500 });
  assert.equal(res.ok.value, '42');
  assert.ok(res.ok.ms >= 0);
  assert.deepEqual(res.boom, { value: null, error: 'exit 3' });
  assert.match(res.slow.error, /timeout/);
  assert.deepEqual(res.silent, { value: null, error: 'no output' });
  assert.equal(res['bad name!'].error, 'invalid capture name');
});

// ---- settings.json (R2.3 / R3.1) ----

test('settings: saveSettings creates the data dir when missing (first-ever aiide command)', () => {
  const dir = join(tmp(), 'not-created-yet', '.aiide');
  saveSettings(dir, { meta: { a: '1' }, capture: {} });
  assert.deepEqual(loadSettings(dir).meta, { a: '1' });
  rmSync(dir, { recursive: true, force: true });
});

test('settings: roundtrip + corrupt file degrades to empty', () => {
  const dir = tmp();
  assert.deepEqual(loadSettings(dir), { meta: {}, capture: {} }); // missing file
  saveSettings(dir, { meta: { a: '1' }, capture: { v: 'node -p "1"' } });
  assert.deepEqual(loadSettings(dir).meta, { a: '1' });
  writeFileSync(join(dir, 'settings.json'), '{corrupt');
  assert.deepEqual(loadSettings(dir), { meta: {}, capture: {} });
  rmSync(dir, { recursive: true, force: true });
});

// ---- collectEnvironment (R1) ----

test('collectEnvironment: fields present, failures degrade to null + warning (AC 1.1/1.7/1.8)', async () => {
  const dir = tmp();
  const suiteFile = join(dir, 's.json');
  writeFileSync(suiteFile, '{"name":"s"}');
  const { environment: env, warnings } = await collectEnvironment({
    suite: { model: 'gpt-x', repeats: 2 }, suitePath: suiteFile,
    runtime: { type: 'command' }, dataDir: dir, skillDirs: [],
  });
  assert.ok(env.aiideVersion);
  assert.equal(env.nodeVersion, process.version);
  assert.equal(env.os.platform, process.platform);
  assert.equal(env.model.requested, 'gpt-x');
  assert.equal(env.suite.sha256.length, 64);
  assert.equal(env.suite.params.repeats, 2);
  assert.deepEqual(env.pricing, { source: 'default' });
  assert.equal(env.runtimeVersion, null); // external runtime, no versionCmd
  assert.ok(warnings.some(w => /runtimeVersion/.test(w)));
  rmSync(dir, { recursive: true, force: true });
});

test('collectEnvironment: runtime.versionCmd resolves external runtime version (AC 1.2c)', async () => {
  const dir = tmp();
  const { environment: env } = await collectEnvironment({
    suite: {}, runtime: { type: 'command', versionCmd: 'node -p "\'9.9.9\'"' },
    dataDir: dir, skillDirs: [],
  });
  assert.equal(env.runtimeVersion, '9.9.9');
  rmSync(dir, { recursive: true, force: true });
});

// ---- runSuite integration (task 2.1) ----

test('runSuite: environment/meta/captured land on the experiment; observed model from trace', async () => {
  const root = tmp();
  const skill = join(root, 'okx-dex-market');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: okx-dex-market\ndescription: d\n---\nbody');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${CLAUDE_STUB}`;
  try {
    const suite = {
      name: 'meta-suite', repeats: 1, timeoutMs: 30_000,
      skills: { dirs: [skill] }, targetSkills: ['okx-dex-market'],
      meta: { branch: 'suite-branch', team: 'onchain' },
      capture: { answer: 'node -p "40+2"', broken: 'node -e "process.exit(2)"' },
      tasks: [{ id: 't', prompt: 'ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    };
    const warnings = [];
    const events = [];
    const exp = await runSuite({
      suite, suiteDir: root, dataDir: join(root, '.aiide'),
      cliMeta: [['branch', 'cli-branch']],
      onProgress: (e) => { events.push(e.type); if (e.type === 'warning') warnings.push(e.message); },
    });
    assert.deepEqual(exp.meta.branch, { value: 'cli-branch', source: 'cli' });
    assert.deepEqual(exp.meta.team, { value: 'onchain', source: 'suite' });
    assert.equal(exp.captured.answer.value, '42');
    assert.equal(exp.captured.broken.value, null);
    assert.ok(warnings.some(w => /capture broken/.test(w)));
    assert.ok(events.includes('metadata')); // preflight event fired before tasks
    assert.equal(exp.environment.nodeVersion, process.version);
    assert.deepEqual(exp.environment.model.observed, ['claude-sonnet-5']); // from stub trace
    assert.equal(exp.environment.model.requested, 'sonnet');
    assert.ok(!exp.warnings.some(w => /modelMismatch/.test(w))); // sonnet ⊂ claude-sonnet-5
    assert.equal(exp.environment.skills[0].name, 'okx-dex-market');
    assert.equal(exp.environment.skills[0].hash.length, 12);
    // scoring unaffected by metadata (correctness property 2)
    assert.equal(exp.tasks.t.C, 1);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('runSuite: reserved meta key fails fast before anything runs (AC 2.6)', async () => {
  const root = tmp();
  await assert.rejects(
    runSuite({ suite: { name: 's', meta: { model: 'x' }, tasks: [] }, suiteDir: root, dataDir: join(root, '.aiide') }),
    /reserved/,
  );
  rmSync(root, { recursive: true, force: true });
});

// ---- CLI: aiide meta subcommands (R5) ----

function cli(args, dir) {
  return execFileSync(process.execPath, [BIN, ...args, '--data-dir', dir], { encoding: 'utf8' });
}

test('cli: meta set/list/rm/capture/test lifecycle (AC 5.2/5.3/5.4/5.6)', () => {
  const dir = tmp();
  assert.match(cli(['meta', 'set', 'branch', 'main'], dir), /✓ branch = main/);
  assert.match(cli(['meta', 'capture', 'answer', 'node', '-p', '40+2'], dir), /✓ capture answer/);
  const list = cli(['meta', 'list'], dir);
  assert.match(list, /branch = main/);
  assert.match(list, /answer → node -p 40\+2/);
  assert.match(list, /settings\.json/);
  assert.match(cli(['meta', 'test'], dir), /✓ answer = 42/);
  assert.match(cli(['meta', 'rm', 'branch'], dir), /✓ removed branch/);
  assert.match(cli(['meta', 'rm', 'branch'], dir), /- branch not set/); // idempotent
  assert.match(cli(['meta', 'capture', '--rm', 'answer'], dir), /✓ removed capture answer/);
  assert.match(cli(['meta', 'test'], dir), /- no captures defined/);
  rmSync(dir, { recursive: true, force: true });
});

test('cli: invalid --meta aborts lab run before it starts (AC 2.7)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 's.json'), JSON.stringify({ name: 's', tasks: [] }));
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'lab', 'run', '--suite', join(dir, 's.json'), '--meta', 'nope', '--data-dir', dir], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => { assert.match(String(err.stderr), /--meta expects k=v/); assert.equal(err.status, 1); return true; },
  );
  rmSync(dir, { recursive: true, force: true });
});
