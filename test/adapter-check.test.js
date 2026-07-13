// `aiide adapter check` — Stage 6 file-mode validator (docs/adapter-observability-design.md §5.2).
// Covers: fatal classes (bad JSON / missing result / ref namespace / inventory prefix / denialKind
// type), warning classes (near-miss keys + x_ exemption, unknown denialKind value, unknown
// refReads status, purely-unknown-key silence), channel presence report (byte-stable human output,
// --json shape), CLI exit codes, and the always-printed honest-scope statement. The fixtures under
// test/fixtures/adapter-check/ are the SAME examples docs/adapters.md shows — docs as test data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  checkAdapterOutput, formatCheckReport, nearMissKeyWarnings, collectAdapterMeta,
  CHECK_SCOPE, CHANNELS, DENIAL_KINDS,
} from '../src/adaptercheck.js';

const pExecFile = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/aiide.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/adapter-check', import.meta.url));

const check = (obj) => checkAdapterOutput(typeof obj === 'string' ? obj : JSON.stringify(obj));

// ---- fatal classes (exit 1 at the CLI) ----

test('check fatal: unparseable JSON → fatal, channels null (unknowable, never "all absent"), scope still present', () => {
  const res = check('{not json');
  assert.equal(res.ok, false);
  assert.equal(res.fatals.length, 1);
  assert.match(res.fatals[0], /JSON 不可解析/);
  assert.equal(res.channels, null);
  assert.deepEqual(res.lit, []);
  assert.deepEqual(res.missing, []);
  assert.equal(res.scope, CHECK_SCOPE);
});

test('check fatal: top-level non-object (array / scalar) is a contract violation', () => {
  for (const bad of ['[1,2]', '"hi"', '42', 'null']) {
    const res = check(bad);
    assert.equal(res.ok, false, `input ${bad}`);
    assert.match(res.fatals[0], /顶层不是 JSON 对象/);
  }
});

test('check fatal: result missing or non-string', () => {
  for (const out of [{}, { result: 42 }, { result: null }, { result: { text: 'x' } }]) {
    const res = check(out);
    assert.equal(res.ok, false);
    assert.ok(res.fatals.some((f) => /'result' 缺失或非字符串/.test(f)));
  }
  assert.equal(check({ result: '' }).ok, true); // empty string is still a string — schema-valid
});

test('check fatal: refReads ref must match <skill>/references/<relpath>; skill field must agree with the prefix', () => {
  const base = (refReads) => ({ result: 'ok', trace: [{ text: 'x', refReads }] });
  // malformed namespace
  for (const ref of ['no-references.md', 'skill/refs/x.md', 'skill/references/', '/references/x.md', null, 7]) {
    const res = check(base([{ skill: 'skill', ref }]));
    assert.ok(res.fatals.some((f) => /不符 <skill>\/references\/<relpath> 形/.test(f)), `ref=${JSON.stringify(ref)}`);
  }
  // skill/prefix mismatch
  const mm = check(base([{ skill: 'skill-a', ref: 'skill-b/references/x.md' }]));
  assert.ok(mm.fatals.some((f) => /'skill-a' 与 ref 'skill-b\/references\/x\.md' 前缀不一致/.test(f)));
  // non-object entry
  assert.ok(check(base(['just-a-string'])).fatals.some((f) => /非对象项/.test(f)));
  // consistent declaration passes
  assert.equal(check(base([{ skill: 'skill-a', ref: 'skill-a/references/x.md' }])).ok, true);
  // skill omitted → only the form is checked (no inconsistency to detect)
  assert.equal(check(base([{ ref: 'skill-a/references/x.md' }])).ok, true);
});

test('check fatal: skills_inventory refs must start with <that key skill>/references/', () => {
  const res = check({
    result: 'ok',
    skills_inventory: { 'skill-a': { versionSha: 'v1', refs: ['skill-b/references/x.md', 42] } },
  });
  assert.equal(res.ok, false);
  assert.equal(res.fatals.filter((f) => /inventory prefix violation/.test(f)).length, 2);
  assert.ok(res.fatals.some((f) => /skills_inventory\['skill-a'\]/.test(f)));
});

test('check fatal: denialKind neither null nor string is structural; null and known string are fine', () => {
  const tc = (denialKind) => ({ result: 'ok', trace: [{ text: 'x', toolCalls: [{ name: 't', denialKind }] }] });
  for (const bad of [42, true, {}, []]) {
    const res = check(tc(bad));
    assert.ok(res.fatals.some((f) => /denialKind .* 非 null 非字符串/.test(f)), `denialKind=${JSON.stringify(bad)}`);
  }
  assert.equal(check(tc(null)).ok, true);
  assert.equal(check(tc('user-rejected')).warnings.length, 0); // closed-set value → no warning either
});

// ---- warning classes (exit 0, listed) ----

test('check warning: near-miss key (trigers) warns with the SAME wording as seal; x_ and purely unknown keys silent', () => {
  const res = check({ result: 'ok', trace: [{ text: 'x', trigers: ['a'], x_custom: 1, zzqqvv: 2 }] });
  assert.equal(res.ok, true); // warnings never flip the exit code
  assert.ok(res.warnings.some((w) => w === "adapter trace round key 'trigers' looks like 'triggers' (near-miss; x_ prefix exempts custom fields)"));
  assert.ok(!res.warnings.some((w) => /x_custom|zzqqvv/.test(w)));
  // shared implementation: the check warning IS the seal warning (single source, can never drift)
  assert.deepEqual(
    res.warnings.filter((w) => /near-miss/.test(w)),
    nearMissKeyWarnings(collectAdapterMeta({ result: 'ok', trace: [{ text: 'x', trigers: ['a'], x_custom: 1, zzqqvv: 2 }] })),
  );
});

test('check warning: near-miss also covers top-level and toolCall surfaces', () => {
  const res = check({
    result: 'ok', skills_inventori: {}, // top-level near-miss of skills_inventory
    trace: [{ text: 'x', toolCalls: [{ name: 't', denialKid: 'x' }] }], // toolCall near-miss
  });
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => /top-level key 'skills_inventori' looks like 'skills_inventory'/.test(w)));
  assert.ok(res.warnings.some((w) => /toolCall key 'denialKid' looks like 'denialKind'/.test(w)));
});

test('check warning: unknown denialKind VALUE warns (closed set shared with seal) but stays ok', () => {
  const res = check({ result: 'ok', trace: [{ text: 'x', toolCalls: [{ name: 't', denialKind: 'weird-future-kind' }] }] });
  assert.equal(res.ok, true);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /denialKind 'weird-future-kind' 不在已知值域/);
  assert.match(res.warnings[0], new RegExp([...DENIAL_KINDS].join('|'))); // discloses the known domain
});

test('check warning: unknown refReads status warns; ok/blocked/absent stay silent', () => {
  const rr = (status) => ({ result: 'ok', trace: [{ text: 'x', refReads: [{ skill: 's', ref: 's/references/a.md', ...(status !== undefined && { status }) }] }] });
  const res = check(rr('maybe'));
  assert.equal(res.ok, true);
  assert.match(res.warnings[0], /status "maybe" 未知/);
  assert.equal(check(rr('ok')).warnings.length, 0);
  assert.equal(check(rr('blocked')).warnings.length, 0);
  assert.equal(check(rr(undefined)).warnings.length, 0);
});

test('check warnings deduplicate across rounds (deterministic order)', () => {
  const res = check({
    result: 'ok',
    trace: [
      { text: 'a', toolCalls: [{ name: 't', denialKind: 'odd-kind' }] },
      { text: 'b', toolCalls: [{ name: 't', denialKind: 'odd-kind' }] },
    ],
  });
  assert.equal(res.warnings.length, 1);
});

// ---- channel presence report ----

test('channel report: completion-only → all channels absent, every missing line materialized', () => {
  const res = check({ result: 'ok' });
  assert.deepEqual(res.channels, {
    trace: false, usage: false, triggers: false, refReads: false,
    skills_inventory: false, runtime_info: false, observability: false,
  });
  assert.deepEqual(res.lit, []);
  assert.equal(res.missing.length, CHANNELS.length);
  assert.deepEqual(res.missing.map((m) => m.channel), CHANNELS.map((c) => c.key));
});

test('channel report: full payload lights every channel in fixed catalogue order', () => {
  const res = check(readFileSync(join(FIXTURES, '05-full.json'), 'utf8'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.channels, {
    trace: true, usage: true, triggers: true, refReads: true,
    skills_inventory: true, runtime_info: true, observability: true,
  });
  assert.deepEqual(res.lit.map((l) => l.channel), CHANNELS.map((c) => c.key));
  assert.deepEqual(res.missing, []);
});

test('channel report: explicit EMPTY triggers/refReads arrays are channel evidence (absent ≠ []); empty inventory is not', () => {
  const res = check({ result: 'ok', skills_inventory: {}, trace: [{ text: 'x', triggers: [], refReads: [] }] });
  assert.equal(res.channels.triggers, true);
  assert.equal(res.channels.refReads, true);
  assert.equal(res.channels.usage, false);       // no round carried usage
  assert.equal(res.channels.skills_inventory, false); // {} carries no inventory evidence
});

test('channel report: human output is byte-stable (exact text, fixed order, trailing newline)', () => {
  const res = check({ result: 'ok' });
  const expected = [
    '┌─ adapter check',
    '│ 通道存在性（channel presence）：',
    '│   ✗ 缺 trace → P/R 与 timeline 显示 n/a（completion-only：只有 C）',
    '│   ✗ 缺 usage → H 显示 n/a（复合分按可用维度重归一化，标 partial dims）',
    '│   ✗ 缺 triggers → activation 与触发覆盖显示 n/a（不惩罚 P/R）',
    '│   ✗ 缺 refReads → 引用读取覆盖显示 n/a',
    '│   ✗ 缺 skills_inventory → 引用覆盖分母不可知（external-runtime），覆盖率显示 n/a',
    '│   ✗ 缺 runtime_info → 运行时自述（self-descriptor）显示 n/a',
    '│   ✗ 缺 observability 声明 → seal 对帐跳过 declared-but-silent 检查（选填，不影响统计）',
    `│ 范围声明：${CHECK_SCOPE}`,
    '└─ ✓ 通过（schema 与通道形状有效）',
    '',
  ].join('\n');
  assert.equal(formatCheckReport(res), expected);
  assert.equal(formatCheckReport(res), formatCheckReport(check({ result: 'ok' }))); // reproducible
});

test('channel report: lit lines render 将点亮 with the stats list; warnings and fatals render above them', () => {
  const txt = formatCheckReport(check(readFileSync(join(FIXTURES, '03-semantics.json'), 'utf8')));
  assert.match(txt, /│ {3}✓ trace — 将点亮：P\/R 维度、逐轮 timeline、工具调用统计（tool facts）/);
  assert.match(txt, /│ {3}✓ triggers — 将点亮：activation、触发覆盖（trigger coverage）、primary skill 归因/);
  assert.match(txt, /│ {3}✗ 缺 usage → H 显示 n\/a/);
  const fatalTxt = formatCheckReport(check('{bad'));
  assert.match(fatalTxt, /│ ✗ fatal: JSON 不可解析/);
  assert.match(fatalTxt, /通道存在性（channel presence）：不可知（JSON 未解析成功）/);
  assert.match(fatalTxt, /└─ ✗ 1 项 fatal（exit 1）/);
});

test('scope statement is ALWAYS present — ok, warning-only, fatal, and unparseable results alike', () => {
  const cases = [
    check({ result: 'ok' }),
    check({ result: 'ok', trace: [{ text: 'x', trigers: [] }] }),
    check({ trace: [] }),
    check('{'),
  ];
  for (const res of cases) {
    assert.equal(res.scope, CHECK_SCOPE);
    assert.ok(formatCheckReport(res).includes(`范围声明：${CHECK_SCOPE}`));
  }
});

// ---- docs examples are test data: every fixture must pass check fully green ----

test('docs fixtures: every example under test/fixtures/adapter-check/ passes check with zero fatals and zero warnings', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5, 'expected the five doc examples');
  for (const f of files) {
    const res = check(readFileSync(join(FIXTURES, f), 'utf8'));
    assert.equal(res.ok, true, `${f}: ${res.fatals.join('; ')}`);
    assert.deepEqual(res.warnings, [], `${f} must be warning-free`);
  }
});

test('docs fixtures: channel presence matches each upgrade-path stage', () => {
  const res = (f) => check(readFileSync(join(FIXTURES, f), 'utf8')).channels;
  assert.deepEqual(res('01-minimal.json'), {
    trace: false, usage: false, triggers: false, refReads: false,
    skills_inventory: false, runtime_info: false, observability: false,
  });
  assert.deepEqual(res('02-trace-cost.json'), {
    trace: true, usage: true, triggers: false, refReads: false,
    skills_inventory: false, runtime_info: false, observability: false,
  });
  assert.deepEqual(res('03-semantics.json'), {
    trace: true, usage: false, triggers: true, refReads: true,
    skills_inventory: true, runtime_info: false, observability: true,
  });
  assert.deepEqual(res('04-self-descriptor.json'), {
    trace: false, usage: false, triggers: false, refReads: false,
    skills_inventory: false, runtime_info: true, observability: true,
  });
});

// ---- CLI wiring: exit codes + --json shape ----

const runCli = (...cliArgs) => pExecFile(process.execPath, [BIN, ...cliArgs]).then(
  (r) => ({ code: 0, ...r }),
  (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }),
);

test('CLI: green file exits 0 and prints the human report', async () => {
  const { code, stdout } = await runCli('adapter', 'check', join(FIXTURES, '05-full.json'));
  assert.equal(code, 0);
  assert.match(stdout, /┌─ adapter check · /);
  assert.match(stdout, /✓ 通过（schema 与通道形状有效）/);
  assert.ok(stdout.includes(CHECK_SCOPE));
});

test('CLI: fatal file exits 1; warning-only file exits 0', async (t) => {
  const tmpdir = (await import('node:os')).tmpdir();
  const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir, 'aiide-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fatalP = join(dir, 'fatal.json');
  writeFileSync(fatalP, '{"trace":[]}'); // result missing
  const fatal = await runCli('adapter', 'check', fatalP);
  assert.equal(fatal.code, 1);
  assert.match(fatal.stdout, /✗ fatal: 'result' 缺失或非字符串/);

  const warnP = join(dir, 'warn.json');
  writeFileSync(warnP, JSON.stringify({ result: 'ok', trace: [{ text: 'x', trigers: [] }] }));
  const warn = await runCli('adapter', 'check', warnP);
  assert.equal(warn.code, 0);
  assert.match(warn.stdout, /⚠ adapter trace round key 'trigers' looks like 'triggers'/);

  const missing = await runCli('adapter', 'check', join(dir, 'nope.json'));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not found:/);
});

test('CLI: --json emits the machine shape (ok/fatals/warnings/channels/lit/missing/scope) and keeps exit semantics', async () => {
  const green = await runCli('adapter', 'check', join(FIXTURES, '02-trace-cost.json'), '--json');
  assert.equal(green.code, 0);
  const doc = JSON.parse(green.stdout);
  assert.deepEqual(Object.keys(doc), ['ok', 'fatals', 'warnings', 'channels', 'lit', 'missing', 'scope']);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.fatals, []);
  assert.deepEqual(doc.warnings, []);
  assert.equal(doc.channels.trace, true);
  assert.equal(doc.channels.usage, true);
  assert.equal(doc.channels.triggers, false);
  assert.ok(doc.lit.every((l) => typeof l.channel === 'string' && typeof l.stats === 'string'));
  assert.ok(doc.missing.every((m) => typeof m.channel === 'string' && typeof m.effect === 'string'));
  assert.equal(doc.scope, CHECK_SCOPE);
});

test('CLI: --json on an unparseable file → channels null + exit 1 (unknowable is never all-false)', async (t) => {
  const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'aiide-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{oops');
  const res = await runCli('adapter', 'check', p, '--json');
  assert.equal(res.code, 1);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.channels, null);
  assert.equal(doc.scope, CHECK_SCOPE);
});

// ---- live mode: --suite runs one real command-adapter invocation, checks its actual stdout ----

test('CLI live: --suite runs the real adapter and lights up its channels (obs-stub)', async (t) => {
  const os = await import('node:os');
  const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(join(os.tmpdir(), 'aiide-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const STUB = fileURLToPath(new URL('./fixtures/obs-stub.js', import.meta.url));

  // full-signal payload the stub echoes verbatim
  const payloadP = join(dir, 'payload.json');
  writeFileSync(payloadP, JSON.stringify({
    result: 'the price is 42', trace: [
      { text: 'q', usage: { in: 100, out: 5 }, triggers: ['demo.x'],
        refReads: [{ skill: 'demo.x', ref: 'demo.x/references/api.md', status: 'ok' }],
        toolCalls: [{ name: 'price_get', input: {}, result: '42', isError: false }] },
    ],
    skills_inventory: { 'demo.x': { versionSha: null, refs: ['demo.x/references/api.md'] } },
    runtime_info: { name: 'stub', version: '1.0.0', tools: [{ name: 'price_get', kind: 'mcp' }] },
    observability: ['trace', 'usage', 'triggers', 'refReads', 'skills_inventory', 'runtime_info'],
  }));
  const suiteP = join(dir, 'suite.json');
  writeFileSync(suiteP, JSON.stringify({
    name: 'live-check', repeats: 1, timeoutMs: 30000,
    runtime: { type: 'command', name: 'stub', cmd: process.execPath, args: [STUB, '--go', '{{PROMPT}}'], env: { OBS_STUB_FILE: payloadP } },
    tasks: [{ id: 'p', prompt: 'price?', verifiers: [{ type: 'regex', pattern: '42' }] }],
  }));

  const { code, stdout } = await runCli('adapter', 'check', '--suite', suiteP, '--data-dir', join(dir, '.aiide'));
  assert.equal(code, 0);
  assert.match(stdout, /┌─ adapter check（live）/);
  assert.match(stdout, /✓ trace —/);
  assert.match(stdout, /✓ runtime_info —/);
  assert.ok(stdout.includes(CHECK_SCOPE));

  // --json shape carries through live mode
  const j = await runCli('adapter', 'check', '--suite', suiteP, '--data-dir', join(dir, '.aiide2'), '--json');
  assert.equal(j.code, 0);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.channels.runtime_info, true);
  assert.equal(doc.channels.triggers, true);
});

test('CLI live: non-command runtime is rejected (file mode is for captured stdout)', async (t) => {
  const os = await import('node:os');
  const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(join(os.tmpdir(), 'aiide-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const suiteP = join(dir, 'cc.json');
  writeFileSync(suiteP, JSON.stringify({ name: 'cc', tasks: [{ id: 'p', prompt: 'x' }] })); // no runtime → claude-code
  const { code, stderr } = await runCli('adapter', 'check', '--suite', suiteP, '--data-dir', join(dir, '.aiide'));
  assert.equal(code, 1);
  assert.match(stderr, /live check needs a command adapter/);
});
