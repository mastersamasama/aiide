// Adapter observability contract — Stage 1 (Run model + consumption chain) golden samples.
// Spec: docs/adapter-observability-design.md v6 §2 (D1 normalization, merge order,
// collectSessionEvents shape, provenance) + consumer-matrix rows metrics.js / score.js.
// Everything here is deterministic (fixed traces / fixed JSONL) — no wall clock, no fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRunFromTrace } from '../src/lab.js';
import { parseSessionJsonl, extractTriggers } from '../src/parser.js';
import { collectSessionEvents } from '../src/depgraph.js';
import { computeRunMetrics, equivTokens } from '../src/metrics.js';
import { scoreRepeat, detectActivation } from '../src/score.js';

const toJsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n');
const fixture = readFileSync(fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url)), 'utf8');
const ccRun = () => parseSessionJsonl(fixture, { source: 'fixture' });

const traceRun = (trace) => buildRunFromTrace(trace, { model: 'claude-sonnet-5', id: 'obs-run' });

// ---- D1 normalization (buildRunFromTrace) ----

test('normalization: declared channels only when the field is explicitly present — absent ≠ []', () => {
  const run = traceRun([
    { text: 'r1', triggers: [], refReads: [] },
    { text: 'r2' },
    { text: 'r3', triggers: ['a', 42, 'b'], refReads: [{ skill: 's', ref: 's/references/x.md' }, 'garbage'] },
  ]);
  assert.deepEqual(run.rounds[0].declaredTriggers, []); // explicit [] survives as []
  assert.deepEqual(run.rounds[0].declaredRefReads, []);
  assert.equal('declaredTriggers' in run.rounds[1], false); // absent → not set, NOT []
  assert.equal('declaredRefReads' in run.rounds[1], false);
  assert.deepEqual(run.rounds[2].declaredTriggers, ['a', 'b']); // order kept, non-strings dropped
  assert.deepEqual(run.rounds[2].declaredRefReads, [{ skill: 's', ref: 's/references/x.md', status: 'ok' }]);
});

test('normalization: refReads status defaults to ok, only ok|blocked accepted, illegal → ok', () => {
  const run = traceRun([{
    refReads: [
      { skill: 's', ref: 's/references/a.md' },
      { skill: 's', ref: 's/references/b.md', status: 'blocked' },
      { skill: 's', ref: 's/references/c.md', status: 'exploded' },
    ],
  }]);
  assert.deepEqual(run.rounds[0].declaredRefReads.map((r) => r.status), ['ok', 'blocked', 'ok']);
});

test('normalization: usage absent → usage/contextFootprint null; usage present keeps zero-default (absent ≠ all-zero)', () => {
  const run = traceRun([
    { text: 'no usage field' },
    { text: 'zero usage', usage: { in: 0, out: 0, cacheW: 0, cacheR: 0 } },
    { text: 'partial usage', usage: { in: 5 } },
  ]);
  assert.equal(run.rounds[0].usage, null);
  assert.equal(run.rounds[0].contextFootprint, null);
  assert.deepEqual(run.rounds[1].usage, { in: 0, out: 0, cacheW: 0, cacheR: 0 }); // reported zeros stay zeros
  assert.equal(run.rounds[1].contextFootprint, 0);
  assert.deepEqual(run.rounds[2].usage, { in: 5, out: 0, cacheW: 0, cacheR: 0 });
  // the two archive shapes must differ — null-not-zero
  assert.notDeepEqual(JSON.parse(JSON.stringify(run.rounds[0])).usage, JSON.parse(JSON.stringify(run.rounds[1])).usage);
});

test('normalization: denialKind preserved verbatim (never downgraded to null); absent → null', () => {
  const run = traceRun([{
    toolCalls: [
      { name: 'Read', denialKind: 'user-rejected' },
      { name: 'Read', denialKind: 'weird-future-kind' }, // unknown value survives — non-null IS the denial fact
      { name: 'Read' },
    ],
  }]);
  assert.equal(run.rounds[0].toolCalls[0].denialKind, 'user-rejected');
  assert.equal(run.rounds[0].toolCalls[1].denialKind, 'weird-future-kind');
  assert.equal(run.rounds[0].toolCalls[2].denialKind, null);
});

// ---- extractTriggers merge order (pure explicit channel) ----

test('extractTriggers: same-round mixed — tool fact beats declaration; declared order then applies', () => {
  const run = traceRun([{
    toolCalls: [{ name: 'Skill', skill: 'fact-skill' }],
    triggers: ['declared-1', 'declared-2'],
  }]);
  const { primarySkill, auxiliarySkills } = extractTriggers(run);
  assert.equal(primarySkill, 'fact-skill');
  assert.deepEqual(auxiliarySkills, ['declared-1', 'declared-2']);
});

test('extractTriggers: cross-round mixed — earlier round wins regardless of channel', () => {
  const run = traceRun([
    { triggers: ['declared-early'] },
    { toolCalls: [{ name: 'Skill', skill: 'fact-late' }] },
  ]);
  const { primarySkill, auxiliarySkills } = extractTriggers(run);
  assert.equal(primarySkill, 'declared-early');
  assert.deepEqual(auxiliarySkills, ['fact-late']);
});

test('extractTriggers: deliberately does NOT read attributionSkill (skill field alone stays dark)', () => {
  const run = traceRun([{ skill: 'attributed-only' }]);
  assert.equal(run.rounds[0].attributionSkill, 'attributed-only');
  assert.equal(extractTriggers(run).primarySkill, null);
});

// ---- collectSessionEvents: fold-in, declaredEvents, provenance ----

test('collectSessionEvents: same-round declaredTriggers + attributionSkill — explicit declaration beats fold-in', () => {
  const run = traceRun([{ skill: 'b', triggers: ['a'] }]);
  const ev = collectSessionEvents(run);
  assert.equal(ev.primarySkill, 'a');
  assert.deepEqual(ev.auxiliarySkills, ['b']);
  assert.deepEqual(ev.triggerSet, ['a', 'b']);
});

test('collectSessionEvents: attributionSkill-only adapter run (archived shape) lights triggerSet; primary recomputed', () => {
  // simulates a runs/*.json archived before the declared channel existed: source adapter-trace, no declaredTriggers
  const run = traceRun([{ skill: 'legacy-skill', usage: { in: 1, out: 1 } }, { skill: 'second-skill' }]);
  const ev = collectSessionEvents(run);
  assert.deepEqual(ev.triggerSet, ['legacy-skill', 'second-skill']);
  assert.equal(ev.primarySkill, ev.triggerSet[0]);
  assert.deepEqual(ev.auxiliarySkills, ['second-skill']);
  assert.deepEqual(ev.declaredEvents, [
    { kind: 'trigger', skill: 'legacy-skill', round: 1 },
    { kind: 'trigger', skill: 'second-skill', round: 2 },
  ]);
});

test('collectSessionEvents: attributionSkill is NOT folded in for harness-observed runs (existing deliberate design)', () => {
  const lines = [
    { type: 'user', sessionId: 'cc-attr', message: { role: 'user', content: 'go' } },
    { type: 'assistant', requestId: 'r1', attributionSkill: 'attr-only',
      message: { role: 'assistant', content: [{ type: 'text', text: 'no skill call' }] } },
  ];
  const ev = collectSessionEvents(parseSessionJsonl(toJsonl(lines), { source: 'cc-attr' }));
  assert.deepEqual(ev.triggerSet, []);
  assert.equal(ev.primarySkill, null);
  assert.deepEqual(ev.declaredEvents, []);
  assert.equal(ev.provenance, 'harness-observed');
});

test('collectSessionEvents: declared events never enter any ordinal list; declaredEvents shape is the carrier', () => {
  const run = traceRun([{
    toolCalls: [{ name: 'Skill', skill: 'fact-skill' }],
    triggers: ['declared-skill'],
    refReads: [{ skill: 'declared-skill', ref: 'declared-skill/references/guide.md' }],
  }]);
  const ev = collectSessionEvents(run);
  // ordinal axes stay pure tool facts
  assert.deepEqual(ev.triggerEvents.map((e) => e.skill), ['fact-skill']);
  assert.ok(ev.triggerEvents.every((e) => Number.isInteger(e.ordinal)));
  assert.deepEqual(ev.readEvents, []);
  assert.deepEqual(ev.cliSet, []);
  // relaxed invariant: triggerSet ⊇ triggerEvents ids
  for (const e of ev.triggerEvents) assert.ok(ev.triggerSet.includes(e.id));
  // declaredEvents carry the declarations, without ordinal
  assert.deepEqual(ev.declaredEvents, [
    { kind: 'trigger', skill: 'declared-skill', round: 1 },
    { kind: 'read', skill: 'declared-skill', ref: 'declared-skill/references/guide.md', status: 'ok', round: 1 },
  ]);
  assert.ok(ev.declaredEvents.every((e) => !('ordinal' in e)));
  // declared ok read entered readSet (literal path IS the logicalRef in the references/ namespace)
  assert.deepEqual(ev.readSet, [{
    skill: 'declared-skill', refPath: 'declared-skill/references/guide.md',
    logicalRef: 'declared-skill/references/guide.md', shared: false,
  }]);
});

test('collectSessionEvents: blocked declared read — not in readSet, present in declaredEvents with status blocked', () => {
  const run = traceRun([{
    refReads: [
      { skill: 's', ref: 's/references/allowed.md', status: 'ok' },
      { skill: 's', ref: 's/references/walled.md', status: 'blocked' },
    ],
  }]);
  const ev = collectSessionEvents(run);
  assert.deepEqual(ev.readSet.map((r) => r.logicalRef), ['s/references/allowed.md']);
  assert.deepEqual(ev.declaredEvents.filter((e) => e.kind === 'read' && e.status === 'blocked'),
    [{ kind: 'read', skill: 's', ref: 's/references/walled.md', status: 'blocked', round: 1 }]);
});

test('collectSessionEvents: provenance decided by run.source on both sides', () => {
  assert.equal(collectSessionEvents(traceRun([{ text: 'hi' }])).provenance, 'adapter-reported');
  assert.equal(collectSessionEvents(ccRun()).provenance, 'harness-observed');
});

// ---- contract test: JSONL-built vs trace-built equivalent inputs (references/ namespace) ----

test('contract: equivalent JSONL and trace runs produce isomorphic triggerSet/readSet', () => {
  const profile = '/home/u/.claude-probe';
  const jsonlRun = parseSessionJsonl(toJsonl([
    { type: 'user', sessionId: 'ct-1', message: { role: 'user', content: 'go' } },
    { type: 'assistant', requestId: 'r1', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'probe-skill' } } ] } },
    { type: 'assistant', requestId: 'r2', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'Read',
        input: { file_path: `${profile}/skills/probe-skill/references/guide.md` } } ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't2', content: 'guide body' } ] } },
  ]), { source: 'ct-1' });
  const adapterRun = traceRun([
    { triggers: ['probe-skill'] },
    { refReads: [{ skill: 'probe-skill', ref: 'probe-skill/references/guide.md' }] },
  ]);
  const a = collectSessionEvents(jsonlRun);
  const b = collectSessionEvents(adapterRun);
  assert.deepEqual(a.triggerSet, b.triggerSet);
  assert.deepEqual(a.readSet, b.readSet);
  assert.equal(a.primarySkill, b.primarySkill);
});

test('collectSessionEvents: declared read dedupes against a tool-fact read of the same logicalRef', () => {
  const run = traceRun([{
    toolCalls: [{ name: 'Read', input: { file_path: 'skills/s/references/x.md' }, result: 'body', isError: false }],
    refReads: [{ skill: 's', ref: 's/references/x.md' }],
  }]);
  const ev = collectSessionEvents(run);
  assert.equal(ev.readSet.length, 1); // first-occurrence merge, tool fact first
  assert.equal(ev.readEvents.length, 1); // ordinal axis: tool fact only
});

// ---- detectActivation ----

test('detectActivation: triggers-only adapter run (no skill field, no toolCalls) activates; triggerSet lights up', () => {
  const run = traceRun([{ text: 'done', triggers: ['target-skill'] }]);
  assert.equal(detectActivation(run, ['target-skill']), true);
  assert.deepEqual(collectSessionEvents(run).triggerSet, ['target-skill']);
});

// ---- metrics.js null-usage chain ----

test('metrics: usage-null rounds skip token/cost only — toolCalls/toolErrors/durationMs still count', () => {
  const run = traceRun([
    { durationMs: 100, toolCalls: [{ name: 'Bash', isError: true }] }, // no usage field
    { durationMs: 200, usage: { in: 10, out: 5, cacheW: 0, cacheR: 20 } },
  ]);
  const m = computeRunMetrics(run); // must not throw
  assert.deepEqual(m.totals.tokens, { in: 10, out: 5, cacheW: 0, cacheR: 20 });
  assert.equal(m.totals.toolCalls, 1);
  assert.equal(m.totals.toolErrors, 1); // isError on the usage-less round still counted
  assert.equal(m.totals.durationMs, 300);
  assert.deepEqual(m.contextSeries.map((c) => c.footprint), [null, 30]); // null preserved in series
  assert.equal(m.peakContext, 30);
});

test('metrics: all usage absent → peakContext null (not Math.max-forged 0); zero-round run → null too', () => {
  const m = computeRunMetrics(traceRun([{ text: 'a' }, { text: 'b' }]));
  assert.equal(m.peakContext, null);
  assert.equal(computeRunMetrics(traceRun([])).peakContext, null);
});

test('metrics: perSkill counts rounds/toolCalls for usage-null rounds without token forgery', () => {
  const run = traceRun([{ skill: 's', durationMs: 50, toolCalls: [{ name: 'Bash', isError: false }] }]);
  const m = computeRunMetrics(run);
  assert.equal(m.perSkill.s.rounds, 1);
  assert.equal(m.perSkill.s.toolCalls, 1);
  assert.equal(m.perSkill.s.durationMs, 50);
  assert.deepEqual(m.perSkill.s.tokens, { in: 0, out: 0, cacheW: 0, cacheR: 0 });
});

test('equivTokens: null/undefined usage folds to 0 instead of throwing', () => {
  assert.equal(equivTokens(null), 0);
  assert.equal(equivTokens(undefined), 0);
  assert.equal(equivTokens({ in: 10, out: 2 }, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }), 20);
});

// ---- score.js: H gate + error-rep discipline over the null-usage chain ----

test('scoreRepeat: usage fully absent → H null (peakContext null), rep is NOT an error rep, toolErrRate still counted', () => {
  const run = traceRun([
    { skill: 't', durationMs: 10, toolCalls: [{ name: 'Bash', isError: true }, { name: 'Bash', isError: false }] },
    { text: 'answer 42' },
  ]);
  const rep = scoreRepeat({
    run, metrics: computeRunMetrics(run), resultText: 'answer 42',
    verifiers: [{ type: 'regex', pattern: '42' }], targetSkills: [],
  });
  assert.equal(rep.error, null);
  assert.equal(rep.C, 1);
  assert.equal(rep.H, null); // usage never reported → honest n/a, not fake-perfect
  assert.equal(rep.toolErrRate, 0.5); // process signal survives the missing usage
});

test('scoreRepeat: usage all ZERO (reported, non-null) → H still null — no margin=1 fake score', () => {
  const run = traceRun([{ usage: { in: 0, out: 0, cacheW: 0, cacheR: 0 }, text: 'ok 42' }]);
  const m = computeRunMetrics(run);
  assert.equal(m.peakContext, 0); // reported zeros → peak 0 (distinct archive shape from null)
  const rep = scoreRepeat({ run, metrics: m, resultText: 'ok 42', verifiers: [], targetSkills: [] });
  assert.equal(rep.H, null);
});

// ---- claude-code behavior bit-unchanged ----

test('claude-code run: extractTriggers/detectActivation/collectSessionEvents bit-identical to pre-contract behavior', () => {
  const run = ccRun();
  const { primarySkill, auxiliarySkills } = extractTriggers(run);
  assert.equal(primarySkill, 'okx-dex-market');
  assert.deepEqual(auxiliarySkills, []);
  assert.equal(detectActivation(run, ['okx-dex-market']), true);
  assert.equal(detectActivation(run, ['nonexistent-skill']), false);
  const ev = collectSessionEvents(run);
  assert.deepEqual(ev.triggerSet, ['okx-dex-market']);
  assert.equal(ev.primarySkill, 'okx-dex-market');
  assert.deepEqual(ev.declaredEvents, []); // no declared channel on JSONL runs — ever
  const m = computeRunMetrics(run);
  assert.equal(m.peakContext, 7500); // unchanged from core.test.js golden value
});
