// Adapter observability contract — Stage 2 (rep-level persistence + seal chain) golden samples.
// Spec: docs/adapter-observability-design.md v6 §1 (observedSignals), §3 (persistence chain +
// inventoryStatus), §4 (runtime_info fingerprint + content-addressed prompt), §5.1 (seal
// reconciliation). Everything runs through runSuite with a configurable command-adapter stub
// (fixtures/obs-stub.js) or the existing claude-code stub — same harness the S1/S2 lab tests use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runSuite, computeResumeKey, tokensEstCJK } from '../src/lab.js';

const STUB = fileURLToPath(new URL('./fixtures/obs-stub.js', import.meta.url));
const CC_STUB = fileURLToPath(new URL('./fixtures/claude-stub.js', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'aiide-seal-'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const INVENTORY = { 'okx-dex-market': { versionSha: 'aaa111', refs: ['okx-dex-market/references/api.md'] } };
const RUNTIME_INFO = { name: 'stub-rt', version: '1.2.3', tools: ['market_price'], defaults: { temperature: 0 } };

// full-signal payload: trace + declared channels + inventory + runtime_info
function payload(over = {}) {
  return {
    result: 'The ETH price is $1,999.42.',
    total_cost_usd: 0.005,
    trace: [
      {
        text: 'quote', usage: { in: 10, out: 5 }, triggers: ['okx-dex-market'],
        refReads: [{ skill: 'okx-dex-market', ref: 'okx-dex-market/references/api.md' }],
      },
      { text: 'The ETH price is $1,999.42.' },
    ],
    skills_inventory: INVENTORY,
    runtime_info: RUNTIME_INFO,
    ...over,
  };
}

function obsSuite(over = {}, env = {}) {
  return {
    name: 'obs-suite', repeats: 1, timeoutMs: 30_000, retry: { maxRetries: 0, baseDelayMs: 1 },
    runtime: { type: 'command', name: 'obs-stub', cmd: process.execPath, args: [STUB, '--go', '{{PROMPT}}'], env },
    targetSkills: ['okx-dex-market'],
    tasks: [{ id: 'eth', prompt: 'price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    ...over,
  };
}

function writePayload(root, obj, name = 'stub-payload.json') {
  const p = join(root, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function seqDir(root, payloads) {
  const dir = join(root, 'seq');
  mkdirSync(dir, { recursive: true });
  payloads.forEach((p, i) => writeFileSync(join(dir, `${i + 1}.json`), JSON.stringify(p)));
  return dir;
}

// ---- §3 hoist + strip + §1 observedSignals + inventoryStatus (adapter golden sample) ----

test('seal: inventory/runtimeInfo hoisted once to environment, per-rep copies stripped, journal rows keep them', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({ repeats: 2 }, { OBS_STUB_FILE: writePayload(root, payload()) });
  const key = computeResumeKey({ name: 'obs-suite', model: 'sonnet', sha256: null });
  const journalPath = join(dataDir, 'experiments', '.inprogress', `${key}.jsonl`);
  let journalText = null; // captured while the journal still exists (deleted at seal)
  const exp = await runSuite({
    suite, suiteDir: root, dataDir,
    onProgress: (e) => { if (e.type === 'repeat-done') journalText = readFileSync(journalPath, 'utf8'); },
  });

  // hoisted single copy
  assert.deepEqual(exp.environment.skillsInventory, INVENTORY);
  assert.equal(exp.environment.runtimeInfo.name, 'stub-rt');
  assert.equal(exp.environment.runtimeInfo.version, '1.2.3');
  assert.equal(exp.environment.runtimeInfo.systemPrompt, null); // neither text nor fingerprint given
  assert.deepEqual(exp.environment.runtimeInfo.tools, ['market_price']);
  // driftDigest: two identical carriers → two equal digests, no drift warning
  assert.equal(exp.environment.skillsInventoryDrift.digests.length, 2);
  assert.equal(new Set(exp.environment.skillsInventoryDrift.digests).size, 1);
  assert.equal(exp.environment.runtimeInfoDrift.digests.length, 2);
  assert.ok(!exp.warnings.some((w) => /drift across repeats/.test(w)));

  // sealed archive carries NO per-rep copies…
  for (const rep of exp.tasks['eth'].repeats) {
    assert.ok(!('skillsInventory' in rep));
    assert.ok(!('runtimeInfo' in rep));
    assert.ok(!('_adapterMeta' in rep));
  }
  // …but the journal rows do (resume must not lose the signals)
  assert.match(journalText, /"skillsInventory"/);
  assert.match(journalText, /"runtimeInfo"/);
  assert.match(journalText, /"_adapterMeta"/);

  // §1 observedSignals — adapter path counts channel presence over coverage-valid runs
  assert.deepEqual(exp.environment.observedSignals, {
    trace: 2, usage: 2, triggers: 2, refReads: 2, inventory: true, runtimeInfo: true,
  });

  // §3 inventoryStatus: declared inventory becomes the refCoverage denominator
  assert.equal(exp.stats.refCoverage.inventoryStatus, 'adapter-declared');
  const row = exp.stats.refCoverage.bySkill.find((s) => s.skill === 'okx-dex-market');
  assert.equal(row.shipped, 1);
  assert.equal(row.read, 1); // declared refRead landed in readSet
  assert.equal(row.refs[0].bytes, null); // declared inventories have no bytes — never a fake number

  // consistent declarations → no reconciliation warnings
  assert.ok(!exp.warnings.some((w) => /near-miss|not in skills_inventory|declared-but-silent/.test(w)));
  rmSync(root, { recursive: true, force: true });
});

// ---- resume equivalence (§3 golden: interrupted-then-cached seal ≡ uninterrupted seal) ----

test('seal: resume with ALL repeats cached seals identical environment observability to the uninterrupted run', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suiteEnv = { OBS_STUB_FILE: writePayload(root, payload()) };
  const key = computeResumeKey({ name: 'obs-suite', model: 'sonnet', sha256: null });
  const journalPath = join(dataDir, 'experiments', '.inprogress', `${key}.jsonl`);

  let journalText = null;
  const expA = await runSuite({
    suite: obsSuite({ repeats: 2 }, suiteEnv), suiteDir: root, dataDir,
    onProgress: (e) => { if (e.type === 'repeat-done') journalText = readFileSync(journalPath, 'utf8'); },
  });
  const runsAfterA = readdirSync(join(dataDir, 'runs')).length;
  assert.equal(runsAfterA, 2);

  // simulate the interruption having happened right before seal: restore the journal and re-run
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, journalText);
  const events = [];
  const expB = await runSuite({
    suite: obsSuite({ repeats: 2 }, suiteEnv), suiteDir: root, dataDir,
    onProgress: (e) => events.push(e),
  });

  assert.equal(readdirSync(join(dataDir, 'runs')).length, runsAfterA); // zero fresh invocations
  assert.ok(events.some((e) => e.type === 'resume' && e.done === 2));
  assert.deepEqual(expB.environment.skillsInventory, expA.environment.skillsInventory);
  assert.deepEqual(expB.environment.runtimeInfo, expA.environment.runtimeInfo);
  assert.deepEqual(expB.environment.observedSignals, expA.environment.observedSignals);
  assert.deepEqual(expB.environment.skillsInventoryDrift, expA.environment.skillsInventoryDrift);
  assert.deepEqual(expB.environment.runtimeInfoDrift, expA.environment.runtimeInfoDrift);
  assert.equal(expB.stats.refCoverage.inventoryStatus, 'adapter-declared');
  rmSync(root, { recursive: true, force: true });
});

// ---- multi-step + completion-only persistence (§3) ----

test('seal: multi-step rep aggregates the fields (first carrying step wins); usage quantifier counts per RUN (3 steps, 1 with usage)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const dir = seqDir(root, [
    { result: 'step1 ETH ok', trace: [{ text: 'step1 ETH ok' }] },
    {
      result: 'step2 ETH ok', skills_inventory: INVENTORY, runtime_info: RUNTIME_INFO,
      trace: [{ text: 'step2 ETH ok', usage: { in: 5, out: 2 }, triggers: ['okx-dex-market'] }],
    },
    { result: 'step3 ETH ok', trace: [{ text: 'step3 ETH ok' }] },
  ]);
  const suite = obsSuite({
    tasks: [{
      id: 'flow', steps: [
        { prompt: 's1', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
        { prompt: 's2', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
        { prompt: 's3', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
      ],
    }],
  }, { OBS_STUB_SEQ: dir });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.equal(exp.tasks['flow'].C, 1);
  assert.deepEqual(exp.environment.skillsInventory, INVENTORY); // carried by step 2 only
  assert.equal(exp.environment.runtimeInfo.name, 'stub-rt');
  // multi-step F-3-12 golden: valid bucket flatMap = 3 runs, exactly 1 carries usage / triggers
  assert.deepEqual(exp.environment.observedSignals, {
    trace: 3, usage: 1, triggers: 1, refReads: 0, inventory: true, runtimeInfo: true,
  });
  assert.ok(!('skillsInventory' in exp.tasks['flow'].repeats[0]));
  rmSync(root, { recursive: true, force: true });
});

test('seal: completion-only rep (no trace) still carries inventory/runtime_info — §5.3 joint observedSignals/inventoryStatus sample', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, {
      result: 'ETH is fine.', skills_inventory: INVENTORY, runtime_info: RUNTIME_INFO,
    }),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.equal(exp.tasks['eth'].C, 1);
  assert.equal(exp.tasks['eth'].P, null); // completion-only stays completion-only
  assert.deepEqual(exp.environment.skillsInventory, INVENTORY);
  // rep-level flags do NOT go through the resolveReps bucket (F-3-02): a noSession rep still counts
  assert.deepEqual(exp.environment.observedSignals, {
    trace: 0, usage: 0, triggers: 0, refReads: 0, inventory: true, runtimeInfo: true,
  });
  assert.equal(exp.stats.refCoverage.inventoryStatus, 'adapter-declared');
  rmSync(root, { recursive: true, force: true });
});

// ---- excluded-rep discipline (§3) ----

test('seal: inventory carried ONLY by an excluded rep → not hoisted + warning + observedSignals.inventory=false', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, {
      result: 'nope', __stderr: '429 too many requests', skills_inventory: INVENTORY,
    }),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.equal(exp.tasks['eth'].excludedRepeats, 1);
  assert.equal(exp.environment.skillsInventory, undefined);
  assert.equal(exp.environment.skillsInventoryDrift, undefined);
  assert.ok(exp.warnings.some((w) => /skills_inventory present only on excluded repeats/.test(w)));
  assert.equal(exp.environment.observedSignals.inventory, false);
  assert.equal(exp.stats.refCoverage.inventoryStatus, 'external-runtime'); // nothing hoisted → unknowable
  rmSync(root, { recursive: true, force: true });
});

test('seal: two non-excluded reps with different inventories → drift warning + both digests archived', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const invB = { 'okx-dex-market': { versionSha: 'bbb222', refs: ['okx-dex-market/references/api.md'] } };
  const dir = seqDir(root, [
    { result: 'ETH r1', skills_inventory: INVENTORY },
    { result: 'ETH r2', skills_inventory: invB },
  ]);
  const exp = await runSuite({ suite: obsSuite({ repeats: 2 }, { OBS_STUB_SEQ: dir }), suiteDir: root, dataDir });
  assert.ok(exp.warnings.includes('skills_inventory drift across repeats'));
  assert.equal(exp.environment.skillsInventoryDrift.digests.length, 2);
  assert.equal(new Set(exp.environment.skillsInventoryDrift.digests).size, 2);
  assert.deepEqual(exp.environment.skillsInventory, INVENTORY); // fixed iteration order → first carrier
  rmSync(root, { recursive: true, force: true });
});

test('seal: an EXCLUDED rep with a different inventory does NOT trip the drift warning', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const invB = { 'okx-dex-market': { versionSha: 'bbb222', refs: [] } };
  const dir = seqDir(root, [
    { result: 'ETH r1', skills_inventory: INVENTORY },
    { result: 'nope', __stderr: '429 too many requests', skills_inventory: invB }, // excluded
  ]);
  const exp = await runSuite({ suite: obsSuite({ repeats: 2 }, { OBS_STUB_SEQ: dir }), suiteDir: root, dataDir });
  assert.equal(exp.tasks['eth'].excludedRepeats, 1);
  assert.ok(!exp.warnings.some((w) => /drift across repeats/.test(w)));
  assert.deepEqual(exp.environment.skillsInventoryDrift.digests.length, 1); // non-excluded carriers only
  assert.deepEqual(exp.environment.skillsInventory, INVENTORY);
  assert.equal(exp.environment.observedSignals.inventory, true);
  rmSync(root, { recursive: true, force: true });
});

// ---- §1 observedSignals: claude-code path + empty-array channel evidence ----

test('observedSignals claude-code golden: usage literal a-priori, event counts over valid runs, inventory a-priori true', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${CC_STUB}`;
  try {
    const suite = {
      name: 'cc-obs', model: 'sonnet', repeats: 2, maxTurns: 10, timeoutMs: 30_000,
      skills: { dirs: [] }, sourceConfigDir: root, targetSkills: ['okx-dex-market'],
      tasks: [{ id: 'eth', prompt: 'price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    assert.deepEqual(exp.environment.observedSignals, {
      trace: 2,             // both JSONL sessions parsed
      usage: 'a-priori',    // literal — the parser keeps a zero skeleton, per-run counting is meaningless
      triggers: 2,          // Skill toolCall in every stub session (main rounds)
      refReads: 0,          // stub sessions read no skills/ refs
      inventory: true,      // snapshot succeeds a-priori on claude-code seal
      runtimeInfo: false,   // stub reports no version anywhere → honestly false
    });
    assert.equal(exp.environment.skillsInventory, undefined); // cc reps never carry the adapter fields
    assert.equal(exp.stats.refCoverage.inventoryStatus, 'snapshot');
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test('observedSignals adapter: explicit EMPTY triggers array is channel evidence (absent ≠ [])', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, { result: 'ETH ok', trace: [{ text: 'ETH ok', triggers: [] }] }),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.equal(exp.environment.observedSignals.triggers, 1); // key present → channel exists
  assert.equal(exp.environment.observedSignals.refReads, 0); // key absent → no channel evidence
  assert.equal(exp.environment.observedSignals.trace, 1);
  rmSync(root, { recursive: true, force: true });
});

// ---- §4 runtime_info: recompute-over-self-report + content-addressed prompt + selfReported ----

test('runtime_info: systemPromptText → aiide recomputes sha/bytes/tokensEst (self-report overridden), text stored once (content-addressed idempotent)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const TEXT = 'You are a helpful 加密货币 quoting assistant. 返回实时价格。';
  const buf = Buffer.from(TEXT, 'utf8');
  const sha = sha256(buf);
  const suite = obsSuite({ repeats: 2 }, {
    OBS_STUB_FILE: writePayload(root, payload({
      runtime_info: {
        ...RUNTIME_INFO,
        systemPromptText: TEXT,
        systemPrompt: { sha256: 'bogus-self-report', bytes: 1, tokensEst: 1 }, // must be overridden
      },
    })),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  const sp = exp.environment.runtimeInfo.systemPrompt;
  assert.equal(sp.sha256, sha);                 // full sha archived (file name prefix is just the path)
  assert.equal(sp.bytes, buf.length);
  assert.equal(sp.tokensEst, tokensEstCJK(TEXT));
  assert.equal(sp.textCaptured, true);
  assert.ok(!('selfReported' in sp));
  // content-addressed: two repeats, ONE file, exact text round-trip
  const dir = join(dataDir, 'logs', 'runtime-info');
  assert.deepEqual(readdirSync(dir), [`system-prompt-${sha.slice(0, 12)}.txt`]);
  assert.equal(readFileSync(join(dir, `system-prompt-${sha.slice(0, 12)}.txt`), 'utf8'), TEXT);
  assert.ok(!exp.warnings.some((w) => /collision/.test(w)));
  rmSync(root, { recursive: true, force: true });
});

test('runtime_info: fingerprint without full text → kept but flagged selfReported, nothing written to disk', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, payload({
      runtime_info: { name: 'rt', version: '2.0', systemPrompt: { sha256: 'abc123', bytes: 10, tokensEst: 3 } },
    })),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  const sp = exp.environment.runtimeInfo.systemPrompt;
  assert.equal(sp.selfReported, true);
  assert.equal(sp.sha256, 'abc123');
  assert.equal(existsSync(join(dataDir, 'logs', 'runtime-info')), false);
  rmSync(root, { recursive: true, force: true });
});

// ---- §5.1 seal reconciliation ----

test('reconciliation: near-miss key (trigers) warns; x_ namespace and purely unknown keys stay silent', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, {
      result: 'ETH ok',
      trace: [{ text: 'ETH ok', trigers: ['a'], x_custom: 1, zzqqvv: 2 }],
    }),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.ok(exp.warnings.some((w) => /key 'trigers' looks like 'triggers'/.test(w)));
  assert.ok(!exp.warnings.some((w) => /x_custom/.test(w)));  // sanctioned custom namespace
  assert.ok(!exp.warnings.some((w) => /zzqqvv/.test(w)));    // purely unknown — no warning
  rmSync(root, { recursive: true, force: true });
});

test('reconciliation: plausibility lints fire with inventory as denominator (unknown trigger, count > inventory, ref/skill prefix mismatch)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, {
      result: 'ETH ok',
      skills_inventory: { 'okx-dex-market': { versionSha: 'v1', refs: ['okx-dex-market/references/api.md'] } },
      trace: [{
        text: 'ETH ok',
        triggers: ['ghost-skill', 'okx-dex-market'],
        refReads: [{ skill: 'okx-dex-market', ref: 'other/references/x.md' }],
      }],
    }),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.ok(exp.warnings.some((w) => /declared trigger 'ghost-skill' not in skills_inventory/.test(w)));
  assert.ok(exp.warnings.some((w) => /one round declared 2 triggers but skills_inventory has 1 skills/.test(w)));
  assert.ok(exp.warnings.some((w) => /declared refRead 'other\/references\/x\.md' does not match its skill/.test(w)));
  rmSync(root, { recursive: true, force: true });
});

test('reconciliation: inventory ABSENT → the whole plausibility group is skipped (unknowable, not zero)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, {
      result: 'ETH ok',
      trace: [{
        text: 'ETH ok',
        triggers: ['ghost-skill', 'another-ghost'],
        refReads: [{ skill: 's', ref: 'other/references/x.md' }],
      }],
    }),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.ok(!exp.warnings.some((w) => /not in skills_inventory|implausible|does not match its skill/.test(w)));
  assert.equal(exp.stats.refCoverage.inventoryStatus, 'external-runtime');
  rmSync(root, { recursive: true, force: true });
});

test('reconciliation: inventory refs must start with <skill>/references/ — violation warns at seal', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const suite = obsSuite({}, {
    OBS_STUB_FILE: writePayload(root, {
      result: 'ETH ok',
      skills_inventory: { 'skill-a': { versionSha: 'v1', refs: ['skill-b/references/x.md'] } },
    }),
  });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  assert.ok(exp.warnings.some((w) =>
    /skills_inventory ref 'skill-b\/references\/x\.md' does not start with 'skill-a\/references\/'/.test(w)));
  rmSync(root, { recursive: true, force: true });
});

test('reconciliation: declared-but-silent — warning tier with skill targets, info tier without', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const silentPayload = writePayload(root, {
    result: 'ETH ok',
    observability: ['triggers', 'refReads'],
    trace: [{ text: 'ETH ok' }], // no declared channel key anywhere
  });

  // tier 1: suite HAS skill targets → plain warning
  const expTargets = await runSuite({
    suite: obsSuite({}, { OBS_STUB_FILE: silentPayload }), suiteDir: root, dataDir: join(dataDir, 'a'),
  });
  const hits = expTargets.warnings.filter((w) => /declared-but-silent/.test(w));
  assert.equal(hits.length, 2); // triggers + refReads
  assert.ok(hits.every((w) => /^adapter declared/.test(w))); // no info: prefix

  // tier 2: no expected_skill / targetSkills anywhere → info: prefixed
  const expNoTargets = await runSuite({
    suite: obsSuite({ targetSkills: [] }, { OBS_STUB_FILE: silentPayload }), suiteDir: root, dataDir: join(dataDir, 'b'),
  });
  const infoHits = expNoTargets.warnings.filter((w) => /declared-but-silent/.test(w));
  assert.equal(infoHits.length, 2);
  assert.ok(infoHits.every((w) => w.startsWith('info: ')));
  rmSync(root, { recursive: true, force: true });
});

// ---- installed-set fallback: declared inventory IS the adapter runtime's install set ----

test('seal: adapter suite without skills.dirs uses declared inventory keys as installed set (no "x/0" coverage)', async () => {
  const root = tmp();
  const suite = obsSuite({}, { OBS_STUB_FILE: writePayload(root, payload()) });
  const exp = await runSuite({ suite, suiteDir: root, dataDir: join(root, '.aiide') });
  assert.deepEqual(exp.stats.skillCoverage.installed, ['okx-dex-market']);
  // static skillDirs listing (when present) stays authoritative — fallback only fires on empty
  assert.equal(exp.stats.refCoverage.inventoryStatus, 'adapter-declared');
});
