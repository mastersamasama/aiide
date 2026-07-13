// Service-under-test lifecycle (runtime.service) + okx-demo SSE driver, against a stub demo server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite, loadServiceEnvFile } from '../src/lab.js';

const STUB = fileURLToPath(new URL('./fixtures/demo-stub-server.mjs', import.meta.url));
const DRIVER = fileURLToPath(new URL('../adapters/okx-demo-sse-driver.mjs', import.meta.url));

let nextPort = 39412;
function suiteFor(port, { stubMode, driverEnv, requiredEnv = ['STUB_BYOK_KEY'], repeats = 2 } = {}) {
  return {
    name: 'demo-suite', repeats, timeoutMs: 30_000,
    runtime: {
      type: 'command', name: 'okx-demo-stub',
      cmd: process.execPath, args: [DRIVER, '{{PROMPT}}'],
      env: driverEnv ?? {},
      service: {
        cmd: process.execPath, args: [STUB],
        env: { STUB_PORT: String(port), ...(stubMode ? { STUB_MODE: stubMode } : {}), AI_MODEL: '{{MODEL}}' },
        readyUrl: `http://127.0.0.1:${port}/api/chats`,
        readyTimeoutMs: 15_000,
        requiredEnv,
      },
    },
    tasks: [{
      id: 'eth', prompt: 'price of ETH?',
      verifiers: [{ type: 'regex', pattern: 'ETH' }, { type: 'numeric_range', min: 100, max: 100000 }],
    }],
  };
}

async function responds(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

test('service lifecycle: start → ready → driver trace with usage → full scoring → teardown', async () => {
  const port = nextPort++;
  const root = mkdtempSync(join(tmpdir(), 'aiide-svc-'));
  process.env.STUB_BYOK_KEY = 'test-key';
  try {
    const exp = await runSuite({ suite: { ...suiteFor(port), model: 'stub-model-x' }, suiteDir: root, dataDir: join(root, '.aiide') });
    const task = exp.tasks['eth'];
    assert.equal(task.C, 1);                       // answer passed both verifiers
    assert.notEqual(task.H, null);                 // turn_usage frames → real context data → H scored
    assert.equal(task.activationRate, null);       // no skill concept in this runtime
    assert.notEqual(task.P, null);                 // tool errors ARE observable from the trace
    assert.ok(task.P < 1, `P=${task.P} should reflect the 1-of-2 erroring tool call`);
    assert.equal(task.compositePartial, false);    // all four dims present
    // trace-built run persisted with per-turn usage + paired tool calls + prompt
    const rep = task.repeats[0];
    assert.equal(rep.efficiency.costUsdReported, 0.005); // 0.003 + 0.002 from turn_usage frames
    const runFile = JSON.parse(readFileSync(join(root, '.aiide', 'runs', `${rep.runId}.json`), 'utf8'));
    assert.equal(runFile.run.prompt, 'price of ETH?');
    assert.equal(runFile.run.rounds[0].usage.in, 900);
    assert.equal(runFile.run.rounds[0].contextFootprint, 900 + 1500);
    const calls = runFile.run.rounds.flatMap(r => r.toolCalls);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].input, { chain: 'ethereum' });
    assert.equal(calls[1].isError, true);          // "Error: no liquidity" heuristic
    // runtime_info (self-descriptor): driver fetched /api/runtime-info, aiide recomputed
    // the prompt fingerprint from the full text and archived it on the environment.
    const ri = exp.environment.runtimeInfo;
    assert.equal(ri.name, 'okx-onchainos-demo');
    assert.equal(ri.version, '0.1.0-stub');
    assert.deepEqual(ri.tools, ['mcp__onchainos__market_price', 'AskUserQuestion']);
    assert.equal(ri.systemPrompt.textCaptured, true);      // full text → recomputed, not self-reported
    assert.ok(ri.systemPrompt.sha256?.length === 64 && ri.systemPrompt.bytes > 0);
    const promptFile = join(root, '.aiide', 'logs', 'runtime-info', `system-prompt-${ri.systemPrompt.sha256.slice(0, 12)}.txt`);
    assert.ok(readFileSync(promptFile, 'utf8').includes('ALPHA MODE'), 'prompt text content-addressed on disk');
    assert.equal(exp.environment.observedSignals.runtimeInfo, true);
    // audit meta: env key NAMES only, model recorded
    assert.equal(exp.service.model, 'stub-model-x');
    assert.ok(exp.service.envKeys.includes('STUB_PORT') && exp.service.envKeys.includes('STUB_BYOK_KEY'));
    assert.ok(!JSON.stringify(exp.service).includes('test-key'), 'secret value must never be recorded');
    // teardown: the service must be gone
    assert.equal(await responds(`http://127.0.0.1:${port}/api/chats`), false);
  } finally {
    delete process.env.STUB_BYOK_KEY;
    rmSync(root, { recursive: true, force: true });
  }
});

test('usage-less runtime (old demo build) ⇒ H n/a + partial composite, never fake-perfect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-svc5-'));
  process.env.STUB_BYOK_KEY = 'k';
  try {
    const exp = await runSuite({
      suite: suiteFor(nextPort++, { stubMode: 'nousage', repeats: 1 }),
      suiteDir: root, dataDir: join(root, '.aiide'),
    });
    const task = exp.tasks['eth'];
    assert.equal(task.C, 1);
    assert.equal(task.H, null);
    assert.equal(task.activationRate, null);
    assert.equal(task.compositePartial, true);
    assert.equal(task.repeats[0].efficiency.costUsdReported, undefined);
    // old build has no /api/runtime-info → driver silently skips (run never fails)
    assert.equal(exp.environment.runtimeInfo, undefined);
    assert.equal(exp.environment.observedSignals.runtimeInfo, false);
  } finally {
    delete process.env.STUB_BYOK_KEY;
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight: missing BYOK env → guided error, service never spawned', async () => {
  const port = nextPort++;
  const root = mkdtempSync(join(tmpdir(), 'aiide-svc2-'));
  delete process.env.STUB_BYOK_KEY;
  try {
    await assert.rejects(
      runSuite({ suite: suiteFor(port), suiteDir: root, dataDir: join(root, '.aiide') }),
      /STUB_BYOK_KEY[\s\S]*service\.env/,
    );
    assert.equal(await responds(`http://127.0.0.1:${port}/api/chats`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight: <data-dir>/service.env supplies BYOK without shell env; port-busy is rejected', async () => {
  const port = nextPort++;
  const root = mkdtempSync(join(tmpdir(), 'aiide-svc3-'));
  const dataDir = join(root, '.aiide');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'service.env'), '# local only\nSTUB_BYOK_KEY=from-file\n');
  assert.deepEqual(loadServiceEnvFile(dataDir), { STUB_BYOK_KEY: 'from-file' });
  delete process.env.STUB_BYOK_KEY;
  try {
    const exp = await runSuite({ suite: suiteFor(port, { repeats: 1 }), suiteDir: root, dataDir });
    assert.equal(exp.tasks['eth'].C, 1);

    // occupy a fresh port with a look-alike and expect a hard refusal
    // (fresh port: reusing one straight after killTree races Windows socket teardown)
    const busyPort = nextPort++;
    const squatter = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
    await new Promise(r => squatter.listen(busyPort, '127.0.0.1', r));
    try {
      await assert.rejects(
        runSuite({ suite: suiteFor(busyPort, { repeats: 1 }), suiteDir: root, dataDir }),
        /already responds/,
      );
    } finally { squatter.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('driver: agent error with no answer → failed repeat; driver timeout → failed repeat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-svc4-'));
  process.env.STUB_BYOK_KEY = 'k';
  try {
    const errExp = await runSuite({
      suite: suiteFor(nextPort++, { stubMode: 'error', repeats: 1 }),
      suiteDir: root, dataDir: join(root, '.aiide'),
    });
    assert.equal(errExp.tasks['eth'].failedRepeats, 1);
    assert.match(errExp.tasks['eth'].repeats[0].error, /model exploded|exited 1/);

    const silentExp = await runSuite({
      suite: suiteFor(nextPort++, { stubMode: 'silent', repeats: 1, driverEnv: { AIIDE_DRIVER_TIMEOUT_MS: '1500' } }),
      suiteDir: root, dataDir: join(root, '.aiide'),
    });
    assert.equal(silentExp.tasks['eth'].failedRepeats, 1);
    assert.match(silentExp.tasks['eth'].repeats[0].error, /timed out|exited 1/);
  } finally {
    delete process.env.STUB_BYOK_KEY;
    rmSync(root, { recursive: true, force: true });
  }
});
