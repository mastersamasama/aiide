import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runSuite } from '../src/lab.js';
import { parseSessionJsonl } from '../src/parser.js';
import { scoreTask } from '../src/score.js';

const STUB = fileURLToPath(new URL('./fixtures/adapter-stub.js', import.meta.url));
const fixture = readFileSync(fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url)), 'utf8');

function suiteFor(root) {
  return {
    name: 'adapter-suite', repeats: 2, timeoutMs: 30_000,
    runtime: { type: 'command', name: 'stub-app', cmd: process.execPath, args: [STUB, '--prompt', '{{PROMPT}}', '--model', '{{MODEL}}'] },
    targetSkills: ['okx-dex-market'],
    tasks: [{
      id: 'eth', prompt: 'price of ETH?',
      verifiers: [{ type: 'numeric_range', min: 100, max: 100000 }],
    }],
  };
}

test('parser: full untruncated content captured (text, tool input/result)', () => {
  const r = parseSessionJsonl(fixture, { source: 'fixture' });
  assert.match(r.rounds[2].text, /\$2,481\.55/); // full assistant text kept
  const bash = r.rounds[1].toolCalls.find(tc => tc.name === 'Bash');
  assert.deepEqual(bash.input, { command: 'onchainos market price --address 0xeee' });
  assert.equal(bash.result, 'command failed'); // tool_result content backfilled
});

test('command adapter with trace → full scoring + timeline run persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-adp-'));
  const exp = await runSuite({ suite: suiteFor(root), suiteDir: root, dataDir: join(root, '.aiide') });
  const task = exp.tasks['eth'];
  assert.equal(exp.runtime, 'stub-app');
  assert.equal(exp.isolationVerified, null); // external runtime — isolation not applicable
  assert.equal(task.C, 1);
  assert.equal(task.activationRate, 1);      // trace carries skill attribution
  assert.notEqual(task.P, null);
  assert.equal(task.compositePartial, false);
  assert.equal(task.repeats[0].efficiency.costUsdReported, 0.005);
  assert.equal(readdirSync(join(root, '.aiide', 'runs')).length, 2); // trace-built runs persisted
  rmSync(root, { recursive: true, force: true });
});

test('command adapter without trace → completion-only: P/H/activation n/a, weights renormalized', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-adp2-'));
  process.env.ADAPTER_MODE = 'plain';
  try {
    const exp = await runSuite({ suite: suiteFor(root), suiteDir: root, dataDir: join(root, '.aiide') });
    const task = exp.tasks['eth'];
    assert.equal(task.C, 1);
    assert.equal(task.P, null);
    assert.equal(task.H, null);
    assert.equal(task.activationRate, null);
    assert.equal(task.compositePartial, true);
    // renormalized: only C (0.5) and R (0.15) present → composite = (0.5*1 + 0.15*R)/0.65
    assert.ok(task.composite > 0.9, `composite ${task.composite} should renormalize, not zero out`);
    assert.match(task.repeats[0].warning, /completion-only/);
  } finally {
    delete process.env.ADAPTER_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoreTask: mixed full + completion-only repeats — nulls excluded from means', () => {
  const full = { C: 1, P: 0.8, H: 0.9, activated: true, verifierResults: [], rounds: 3, efficiency: { tokens: { in: 1, out: 1, cacheW: 0, cacheR: 0 }, durationMs: 1, costUsd: 0 }, error: null };
  const compOnly = { ...full, P: null, H: null, activated: null };
  const tk = scoreTask([full, compOnly, full]);
  assert.equal(tk.P, 0.8);              // mean over the two non-null only
  assert.equal(tk.activationRate, 1);   // denominator = repeats with known activation
  assert.equal(tk.compositePartial, false); // dims all present at task level
});
