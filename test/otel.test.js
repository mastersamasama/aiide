import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSuite } from '../src/lab.js';
import { buildRunSpans, otlpDocument, exportOtel, attr } from '../src/otel.js';

const STUB = fileURLToPath(new URL('./fixtures/claude-stub.js', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/aiide.js', import.meta.url));
const OTEL_SRC = fileURLToPath(new URL('../src/otel.js', import.meta.url));
function tmp() { return mkdtempSync(join(tmpdir(), 'aiide-otel-')); }
function attrVal(span, key) {
  const a = span.attributes.find(x => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
}

const RUN = {
  id: 'r1', model: 'claude-sonnet-5', source: 'x',
  startedAt: '2026-07-02T10:00:00Z', endedAt: '2026-07-02T10:00:05Z',
  rounds: [{
    seq: 1, ts: '2026-07-02T10:00:00Z', durationMs: 2000, model: 'claude-sonnet-5',
    attributionSkill: 'okx-dex-market', usage: { in: 500, out: 30, cacheW: 0, cacheR: 1000 },
    contextFootprint: 1500, stopReason: 'tool_use',
    toolCalls: [{ name: 'Skill', id: 't1', isError: false, skill: 'okx-dex-market' }],
  }],
  sidechains: [], meta: { experimentId: 'exp1', taskId: 'eth' },
};
const METRICS = { totals: { tokens: { in: 500, out: 30 }, rounds: 1, toolErrors: 0, costUsd: 0.01 } };

test('S18 buildRunSpans: invoke_agent → chat → execute_tool with gen_ai.* attrs (R2.1)', () => {
  const { spans } = buildRunSpans(RUN, METRICS);
  const root = spans.find(s => s.name === 'invoke_agent');
  const chat = spans.find(s => s.name === 'chat');
  const tool = spans.find(s => s.name === 'execute_tool');
  assert.equal(attrVal(root, 'gen_ai.operation.name'), 'invoke_agent');
  assert.equal(attrVal(root, 'gen_ai.request.model'), 'claude-sonnet-5');
  assert.equal(chat.parentSpanId, root.spanId);
  assert.equal(attrVal(chat, 'gen_ai.usage.input_tokens'), '500'); // intValue is a string (OTLP int64)
  assert.equal(attrVal(chat, 'gen_ai.usage.output_tokens'), '30');
  assert.equal(tool.parentSpanId, chat.spanId);
  assert.equal(attrVal(tool, 'gen_ai.tool.name'), 'Skill');
  assert.equal(attrVal(tool, 'aiide.tool.skill'), 'okx-dex-market'); // R2.2 aiide.* custom
  assert.equal(attrVal(tool, 'aiide.tool.is_error'), false);
});

test('S18 ids: deterministic + correct hex widths (R3.2)', () => {
  const a = buildRunSpans(RUN, METRICS), b = buildRunSpans(RUN, METRICS);
  assert.equal(a.traceId, b.traceId);               // stable across re-export
  assert.equal(a.spans[0].spanId, b.spans[0].spanId);
  assert.match(a.traceId, /^[0-9a-f]{32}$/);
  assert.match(a.spans[0].spanId, /^[0-9a-f]{16}$/);
});

test('S18 otlpDocument: resource + scope + pinned experimental semconv (R3.1)', () => {
  const doc = otlpDocument([buildRunSpans(RUN, METRICS)], { version: '0.4.2' });
  const rs = doc.resourceSpans[0];
  assert.equal(rs.resource.attributes.find(a => a.key === 'service.name').value.stringValue, 'aiide');
  assert.match(rs.scopeSpans[0].schemaUrl, /opentelemetry\.io\/schemas/);
  assert.match(rs.resource.attributes.find(a => a.key === 'aiide.otel.genai_semconv').value.stringValue, /experimental/);
  assert.ok(rs.scopeSpans[0].spans.length >= 3);
});

test('S18 attr: typing + null/empty dropped', () => {
  assert.deepEqual(attr('k', 5), { key: 'k', value: { intValue: '5' } });
  assert.deepEqual(attr('k', 0.5), { key: 'k', value: { doubleValue: 0.5 } });
  assert.deepEqual(attr('k', true), { key: 'k', value: { boolValue: true } });
  assert.equal(attr('k', null), null);
  assert.equal(attr('k', ''), null);
});

test('S18 no SDK dependency: src/otel.js never imports @opentelemetry (iron rule)', () => {
  // an import/require, not a mention in a comment — the whole point is hand-written OTLP
  assert.doesNotMatch(readFileSync(OTEL_SRC, 'utf8'), /(?:from|require\()\s*['"]@opentelemetry/);
});

test('S18 exportOtel + CLI: real run/experiment export (R1/R2.3)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${STUB}`;
  try {
    const suite = {
      name: 'otel-suite', model: 'sonnet', repeats: 1, maxTurns: 5, timeoutMs: 30_000,
      skills: { dirs: [] }, targetSkills: ['okx-dex-market'],
      tasks: [{ id: 'eth', prompt: 'price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    };
    const exp = await runSuite({ suite, suiteDir: root, dataDir });
    const runId = exp.tasks.eth.repeats[0].runId;

    // run export
    const runExp = exportOtel({ dataDir, id: runId });
    assert.equal(runExp.kind, 'run');
    assert.ok(runExp.doc.resourceSpans[0].scopeSpans[0].spans.some(s => s.name === 'invoke_agent'));

    // experiment export nests the run + carries the scorecard (R2.3)
    const expExp = exportOtel({ dataDir, id: exp.id });
    assert.equal(expExp.kind, 'experiment');
    const spans = expExp.doc.resourceSpans[0].scopeSpans[0].spans;
    const expRoot = spans.find(s => attrVal(s, 'aiide.experiment.id') === exp.id);
    assert.ok(expRoot, 'experiment root span present');
    assert.notEqual(attrVal(expRoot, 'aiide.scorecard.composite'), undefined);
    assert.ok(spans.some(s => s.name === 'chat'), 'nested run chat spans present');

    // CLI to stdout → valid OTLP/JSON
    const out = execFileSync(process.execPath, [BIN, 'export', '--otel', exp.id, '--data-dir', dataDir], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.resourceSpans));
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});
