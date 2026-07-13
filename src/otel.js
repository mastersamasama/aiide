// aiide export --otel — hand-written OTLP/JSON, ZERO dependencies (no @opentelemetry/* SDK).
// Maps aiide's run/experiment records onto the OTel GenAI semconv span structure
// (invoke_agent → chat → execute_tool); product-specific concepts ride on aiide.* custom attributes.
// gen_ai semconv is still experimental — the output pins its version + flags that (R3.1).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_URL = 'https://opentelemetry.io/schemas/1.29.0';
const GENAI_SEMCONV = 'gen-ai (experimental; pinned to a 2026-03 snapshot)';
const KIND_INTERNAL = 1, KIND_CLIENT = 3;

function aiideVersion() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'; }
  catch { return 'unknown'; }
}

// deterministic ids: same run/experiment → same trace/span ids on every re-export
function hhex(s, bytes) { return createHash('sha256').update(String(s)).digest('hex').slice(0, bytes * 2); }
const traceIdOf = (s) => hhex(s, 16); // 16 bytes → 32 hex chars
const spanIdOf = (s) => hhex(s, 8);   // 8 bytes → 16 hex chars

function tms(iso) { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? null : t; }
function nano(ms) { return String(BigInt(Math.max(0, Math.round(ms || 0))) * 1_000_000n); }

/** One typed OTLP attribute (drops null/empty so absent fields don't emit garbage). */
export function attr(key, value) {
  if (value == null || value === '') return null;
  let v;
  if (typeof value === 'boolean') v = { boolValue: value };
  else if (typeof value === 'number') v = Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  else v = { stringValue: String(value) };
  return { key, value: v };
}
export function attrs(obj) { return Object.entries(obj).map(([k, v]) => attr(k, v)).filter(Boolean); }

/** Run → [invoke_agent, chat*, execute_tool*] sharing one trace id. */
export function buildRunSpans(run, metrics, { traceId = traceIdOf(`run:${run.id}`), parentSpanId = null } = {}) {
  const rootId = spanIdOf(`run:${run.id}:root`);
  const startMs = tms(run.startedAt) ?? 0;
  const endMs = tms(run.endedAt) ?? startMs;
  const spans = [{
    traceId, spanId: rootId, parentSpanId: parentSpanId ?? undefined,
    name: 'invoke_agent', kind: KIND_INTERNAL,
    startTimeUnixNano: nano(startMs), endTimeUnixNano: nano(endMs),
    attributes: attrs({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.request.model': run.model,
      'gen_ai.usage.input_tokens': metrics?.totals?.tokens?.in,
      'gen_ai.usage.output_tokens': metrics?.totals?.tokens?.out,
      'aiide.run.id': run.id,
      'aiide.run.source': run.source,
      'aiide.run.rounds': metrics?.totals?.rounds,
      'aiide.run.tool_errors': metrics?.totals?.toolErrors,
      'aiide.cost.usd_estimate': metrics?.totals?.costUsd,
      'aiide.experiment.id': run.meta?.experimentId,
      'aiide.task.id': run.meta?.taskId,
    }),
  }];
  const allRounds = [...(run.rounds ?? []), ...(run.sidechains ?? []).flatMap(s => s.rounds ?? [])];
  for (const r of allRounds) {
    const chatId = spanIdOf(`run:${run.id}:r${r.seq}`);
    const rStart = tms(r.ts) ?? startMs;
    const rEnd = rStart + (r.durationMs || 0);
    spans.push({
      traceId, spanId: chatId, parentSpanId: rootId, name: 'chat', kind: KIND_CLIENT,
      startTimeUnixNano: nano(rStart), endTimeUnixNano: nano(rEnd),
      attributes: attrs({
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': r.model ?? run.model,
        'gen_ai.usage.input_tokens': r.usage?.in,
        'gen_ai.usage.output_tokens': r.usage?.out,
        'gen_ai.response.finish_reason': r.stopReason,
        'aiide.usage.cache_read_tokens': r.usage?.cacheR,
        'aiide.usage.cache_write_tokens': r.usage?.cacheW,
        'aiide.context.footprint': r.contextFootprint,
        'aiide.skill.attribution': r.attributionSkill,
      }),
    });
    for (const tc of r.toolCalls ?? []) {
      spans.push({
        traceId, spanId: spanIdOf(`run:${run.id}:r${r.seq}:${tc.id ?? tc.name}`), parentSpanId: chatId,
        name: 'execute_tool', kind: KIND_INTERNAL,
        startTimeUnixNano: nano(rStart), endTimeUnixNano: nano(rEnd),
        attributes: attrs({
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': tc.name,
          'aiide.tool.skill': tc.skill,
          'aiide.tool.is_error': tc.isError === true,
        }),
      });
    }
  }
  return { traceId, spans };
}

/** Experiment → root span (scorecard as aiide.*) + nested spans for each referenced run that exists. */
export function buildExperimentSpans(exp, loadRun) {
  const traceId = traceIdOf(`exp:${exp.id}`);
  const rootId = spanIdOf(`exp:${exp.id}:root`);
  const startMs = tms(exp.createdAt) ?? 0;
  const s = exp.summary ?? {};
  const spans = [{
    traceId, spanId: rootId, name: 'invoke_agent', kind: KIND_INTERNAL,
    startTimeUnixNano: nano(startMs), endTimeUnixNano: nano(startMs),
    attributes: attrs({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.request.model': exp.model,
      'aiide.experiment.id': exp.id,
      'aiide.suite.name': exp.suiteName,
      'aiide.runtime': exp.runtime,
      'aiide.scorecard.composite': s.composite,
      'aiide.scorecard.c': s.C, 'aiide.scorecard.p': s.P, 'aiide.scorecard.r': s.R, 'aiide.scorecard.h': s.H,
      'aiide.scorecard.low_sample': s.lowSample === true,
      'aiide.scorecard.degraded': s.degraded === true,
      'aiide.scorecard.excluded_repeats': s.excludedRepeats ?? 0,
    }),
  }];
  for (const t of Object.values(exp.tasks ?? {})) {
    for (const rep of t.repeats ?? []) {
      if (!rep.runId) continue;
      for (const rid of String(rep.runId).split(',').filter(Boolean)) { // multi-step joins run ids
        const loaded = loadRun(rid);
        if (!loaded?.run) continue;
        const { spans: runSpans } = buildRunSpans(loaded.run, loaded.metrics, { traceId, parentSpanId: rootId });
        spans.push(...runSpans);
      }
    }
  }
  return { traceId, spans };
}

/** Wrap span groups in an OTLP/JSON document with resource + scope + pinned semconv note. */
export function otlpDocument(groups, { version = aiideVersion() } = {}) {
  return {
    resourceSpans: [{
      resource: {
        attributes: attrs({
          'service.name': 'aiide',
          'service.version': version,
          'aiide.otel.genai_semconv': GENAI_SEMCONV,
        }),
      },
      scopeSpans: [{
        scope: { name: 'aiide', version },
        schemaUrl: SCHEMA_URL,
        spans: groups.flatMap(g => g.spans),
      }],
    }],
  };
}

/** Resolve id → run (first) | experiment | latest experiment; return { kind, id, doc }. */
export function exportOtel({ dataDir, id = null, version = aiideVersion() }) {
  const loadRun = (rid) => {
    try { return JSON.parse(readFileSync(join(dataDir, 'runs', `${rid}.json`), 'utf8')); } catch { return null; }
  };
  if (id && existsSync(join(dataDir, 'runs', `${id}.json`))) {
    const { run, metrics } = loadRun(id);
    return { kind: 'run', id, doc: otlpDocument([buildRunSpans(run, metrics)], { version }) };
  }
  let expId = id;
  if (!expId) {
    const dir = join(dataDir, 'experiments');
    const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
    if (!files.length) throw new Error('no experiments to export');
    expId = files.at(-1).replace(/\.json$/, '');
  }
  const expPath = join(dataDir, 'experiments', `${expId}.json`);
  if (!existsSync(expPath)) throw new Error(`no run or experiment "${id}"`);
  const exp = JSON.parse(readFileSync(expPath, 'utf8'));
  return { kind: 'experiment', id: expId, doc: otlpDocument([buildExperimentSpans(exp, loadRun)], { version }) };
}
