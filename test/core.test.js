import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSessionJsonl } from '../src/parser.js';
import { computeRunMetrics, priceFor, DEFAULT_PRICING } from '../src/metrics.js';
import {
  runVerifier, runFileVerifier, evalVerifier, passAtK, activationOutcome,
  scoreRepeat, scoreTask, scoreExperiment, wilson, detectActivation, WEIGHTS,
} from '../src/score.js';
import { classifyEnvNoise } from '../src/lab.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url)), 'utf8');
const run = () => parseSessionJsonl(fixture, { source: 'fixture' });

// ---- parser (AC 1.1-1.4) ----

test('parser: extracts rounds, usage, skill attribution (AC 1.1)', () => {
  const r = run();
  assert.equal(r.sessionId, 'sess-fixture-1');
  assert.equal(r.rounds.length, 3); // main-loop assistant rounds
  assert.equal(r.model, 'claude-sonnet-5');
  assert.deepEqual(r.rounds[0].usage, { in: 1000, out: 50, cacheW: 2000, cacheR: 3000 });
  assert.equal(r.rounds[0].contextFootprint, 6000);
  assert.equal(r.rounds[1].attributionSkill, 'okx-dex-market');
  assert.equal(r.rounds[0].toolCalls[0].skill, 'okx-dex-market');
});

test('parser: corrupt + unknown lines become warnings, not failures (AC 1.2)', () => {
  const r = run();
  assert.equal(r.parseWarnings, 2); // 1 bad JSON + 1 unknown type
  assert.equal(r.rounds.length, 3);
});

test('parser: tool_result is_error backfills tool call (AC 2.1 input)', () => {
  const r = run();
  const bash = r.rounds[1].toolCalls.find(t => t.name === 'Bash');
  assert.equal(bash.isError, true);
  const skillCall = r.rounds[0].toolCalls.find(t => t.name === 'Skill');
  assert.equal(skillCall.isError, false);
});

test('parser: sidechain rounds separated from main loop (AC 1.4)', () => {
  const r = run();
  assert.equal(r.sidechains.length, 1);
  assert.equal(r.sidechains[0].agentId, 'side-1');
  assert.equal(r.sidechains[0].rounds.length, 1);
});

test('parser: prompt + user-side events captured (full text, main chain only)', () => {
  const r = run();
  assert.equal(r.prompt, 'What is the price of ETH?');
  assert.equal(r.userEvents.length, 1); // tool_result-only user lines are not text events
  assert.equal(r.userEvents[0].chars, r.prompt.length);
});

test('parser: idempotent — same input, same output (correctness property 1)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(run())), JSON.parse(JSON.stringify(run())));
});

// ---- metrics (AC 2.1-2.4) ----

test('metrics: totals equal per-round sums (correctness property 2 / AC 6.2)', () => {
  const r = run();
  const m = computeRunMetrics(r);
  const all = [...r.rounds, ...r.sidechains.flatMap(s => s.rounds)];
  assert.equal(m.totals.tokens.in, all.reduce((a, x) => a + x.usage.in, 0));
  assert.equal(m.totals.tokens.out, all.reduce((a, x) => a + x.usage.out, 0));
  assert.equal(m.totals.toolCalls, 2);
  assert.equal(m.totals.toolErrors, 1);
  assert.equal(m.totals.rounds, 3);
  assert.equal(m.totals.sidechainRounds, 1);
});

test('metrics: per-skill aggregation via attributionSkill + Skill tool (AC 2.3)', () => {
  const m = computeRunMetrics(run());
  const s = m.perSkill['okx-dex-market'];
  assert.ok(s);
  assert.equal(s.rounds, 3); // round1 (Skill call) + round2 + round4 (attribution)
  assert.equal(s.toolErrors, 1);
});

test('metrics: cost estimate uses model pricing and is flagged (AC 2.4)', () => {
  const m = computeRunMetrics(run());
  assert.ok(m.totals.costUsd > 0);
  assert.equal(m.totals.costIsEstimate, true);
  assert.equal(priceFor('claude-sonnet-5').in, 3);
  assert.equal(priceFor('claude-opus-4-8').in, 15);
});

test('pricing adapter: custom table overrides defaults; unmatched model flagged', () => {
  const custom = {
    models: [{ match: 'sonnet', in: 99, out: 99, cacheW: 0, cacheR: 0 }, ...DEFAULT_PRICING.models],
    fallback: DEFAULT_PRICING.fallback,
  };
  assert.equal(priceFor('claude-sonnet-5', custom).in, 99); // custom entry wins over default
  assert.equal(priceFor('deepseek-chat').in, 0.27);         // non-Claude LLM supported out of the box
  assert.equal(priceFor('gpt-5.5-codex').matched, true);
  assert.equal(priceFor('totally-unknown-llm').matched, false); // falls back + flagged
  const m = computeRunMetrics(run(), { pricing: custom });
  assert.ok(m.totals.costUsd > computeRunMetrics(run()).totals.costUsd); // pricing actually applied
  assert.equal(m.totals.pricingMatched, true);
});

test('metrics: context series flagged as estimate (AC 2.2)', () => {
  const m = computeRunMetrics(run());
  assert.equal(m.contextIsEstimate, true);
  assert.equal(m.peakContext, 7500); // round 4: 1400+6100
  assert.equal(m.contextSeries.length, 3);
});

// ---- verifiers + scoring (AC 4.1-4.7) ----

test('verifiers: regex / numeric_range / json_field (AC 4.1)', () => {
  assert.equal(runVerifier({ type: 'regex', pattern: 'ETH' }, 'ETH is $2481').pass, true);
  assert.equal(runVerifier({ type: 'regex', pattern: 'error', expect: false }, 'all good').pass, true);
  assert.equal(runVerifier({ type: 'numeric_range', min: 1000, max: 10000 }, 'price: $2,481.55').pass, true);
  assert.equal(runVerifier({ type: 'numeric_range', min: 1, max: 2 }, 'price: $2,481.55').pass, false);
  assert.equal(runVerifier({ type: 'json_field', path: 'a.b' }, '{"a":{"b":1}}').pass, true);
  assert.equal(runVerifier({ type: 'json_field', path: 'a.c' }, '{"a":{"b":1}}').pass, false);
});

function repeatFor(text, opts = {}) {
  const r = run();
  return scoreRepeat({
    run: r, metrics: computeRunMetrics(r), resultText: text,
    verifiers: [{ type: 'numeric_range', min: 100, max: 100000 }],
    targetSkills: ['okx-dex-market'], maxTurns: 20, ...opts,
  });
}

test('scoreRepeat: C from verifiers, P from process, activation detected (AC 4.1-4.2)', () => {
  const rep = repeatFor('ETH is $2,481.55');
  assert.equal(rep.C, 1);
  assert.equal(rep.activated, true);
  assert.ok(rep.P > 0.5 && rep.P < 1); // 1 of 2 tool calls errored, activation ok, no max-turns
  assert.ok(rep.H > 0.9); // tiny context vs 200k limit
  assert.equal(repeatFor('no numbers here').C, 0);
});

test('activation: missing target skill → false', () => {
  assert.equal(detectActivation(run(), ['nonexistent-skill']), false);
  assert.equal(detectActivation(run(), ['okx-dex-market']), true);
});

test('scoreTask: composite = weighted C/P/R/H; efficiency NEVER in composite (AC 4.5)', () => {
  const a = repeatFor('$2481');
  const b = { ...a, efficiency: { tokens: { in: 9e9, out: 9e9, cacheW: 0, cacheR: 0 }, durationMs: 9e9, costUsd: 9e9 } };
  const tA = scoreTask([a, a, a]);
  const tB = scoreTask([b, b, b]);
  assert.equal(tA.composite, tB.composite); // efficiency change must not move composite
  const expected = WEIGHTS.C * tA.C + WEIGHTS.P * tA.P + WEIGHTS.R * tA.R + WEIGHTS.H * tA.H;
  assert.ok(Math.abs(tA.composite - expected) < 1e-9 + 5e-4);
});

test('scoreTask: failed repeats count as C=0 (AC 3.5) + drill-down evidence retained (AC 4.7)', () => {
  const good = repeatFor('$2481');
  const dead = { ...good, C: 0, activated: false, error: 'timeout' };
  const t = scoreTask([good, good, dead]);
  assert.equal(t.failedRepeats, 1);
  assert.ok(t.C < 1);
  assert.equal(t.repeats.length, 3);
  assert.ok(t.repeats[0].verifierResults.length > 0);
});

// ---- S2: env-noise triage / exclusion (six guardrails) ----

const okRep = () => ({ C: 1, P: 0.9, H: 0.95, activated: true, error: null, efficiency: { tokens: { out: 10 }, durationMs: 100, costUsd: 0 } });
const excRep = (sig = 'auth-expired') => ({ excluded: true, excludedSignature: sig, error: 'onchainos 53017 auth expired', C: 0, P: null, H: null, activated: null, efficiency: { tokens: { out: 0 }, durationMs: 0, costUsd: 0 } });

test('S2 classifyEnvNoise: signatures match infra codes, not model output (AC/R1)', () => {
  assert.equal(classifyEnvNoise('onchainos error 53017: auth token expired'), 'auth-expired');
  assert.equal(classifyEnvNoise('HTTP 429 Too Many Requests'), 'rate-limit-429');
  assert.equal(classifyEnvNoise('Error: 529 overloaded'), 'overloaded-529');
  assert.equal(classifyEnvNoise('connect ECONNREFUSED 127.0.0.1:3901'), 'conn-refused');
  assert.equal(classifyEnvNoise('provider rate-limited, slow down'), 'rate-limit');
  assert.equal(classifyEnvNoise('timeout'), null);              // AC c: timeout never env-noise
  assert.equal(classifyEnvNoise('runtime exited 2: bad thing'), null); // generic exit not env-noise
  assert.equal(classifyEnvNoise('the price of ETH is 4290 usd'), null); // 4290 ≠ \b429\b
});

test('S2 guardrail a: all valid samples excluded → C=null, composite=null (not fake 0)', () => {
  const t = scoreTask([excRep(), excRep(), excRep()]);
  assert.equal(t.n, 0);
  assert.equal(t.excludedRepeats, 3);
  assert.equal(t.degraded, true);
  assert.equal(t.C, null);
  assert.equal(t.composite, null); // the latent mean([])→0 fake-zero is now null
});

test('S2 guardrail c/f: exclusions dropping valid-n below floor → composite n/a + lowSample', () => {
  const t = scoreTask([okRep(), excRep(), excRep()]); // valid-n = 1 < MIN_REPEATS
  assert.equal(t.n, 1);
  assert.equal(t.excludedRepeats, 2);
  assert.equal(t.C, 1);            // C still honest on the valid sample
  assert.equal(t.composite, null); // but composite is untrustworthy → n/a
  assert.equal(t.lowSample, true);
});

test('S2: enough valid samples → composite computed, degraded flag still set', () => {
  const t = scoreTask([okRep(), okRep(), okRep(), excRep(), excRep()]);
  assert.equal(t.n, 3);
  assert.equal(t.excludedRepeats, 2);
  assert.equal(t.degraded, true);
  assert.equal(t.lowSample, false);
  assert.ok(t.composite > 0.5);    // scored on the 3 valid samples only
  assert.ok(t.wilsonCi.hi <= 1 && t.wilsonCi.lo >= 0);
});

test('S2 guardrail b: scoreExperiment filters null composites (no 0 pollution)', () => {
  const healthy = scoreTask([okRep(), okRep(), okRep()]);
  const s = scoreExperiment({ a: scoreTask([excRep(), excRep(), excRep()]), b: healthy });
  assert.equal(s.composite, healthy.composite); // task a's null did NOT drag it toward 0
  assert.equal(s.degraded, true);
  assert.equal(s.excludedRepeats, 3);
});

test('S2 (AC c): a genuine all-fail (no signature) stays C=0, not excluded', () => {
  const dead = { C: 0, P: 0, H: 0, activated: false, error: 'timeout', efficiency: { tokens: { out: 0 }, durationMs: 0, costUsd: 0 } };
  const t = scoreTask([dead, dead, dead]);
  assert.equal(t.excludedRepeats, 0);
  assert.equal(t.C, 0);
  assert.equal(t.composite != null, true); // honest zero, NOT n/a
});

// ---- S3: file_exists verifier + pass@k ----

test('S3 runFileVerifier: presence, miss, and optional JSON schema (R1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiide-fv-'));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ price: 2500, symbol: 'ETH' }));
  assert.equal(runFileVerifier({ type: 'file_exists', path: 'result.json' }, dir).pass, true);
  assert.equal(runFileVerifier({ type: 'file_exists', path: 'nope.json' }, dir).pass, false);
  assert.equal(runFileVerifier({ type: 'file_exists', path: 'result.json', schema: { required: ['price', 'symbol'] } }, dir).pass, true);
  assert.equal(runFileVerifier({ type: 'file_exists', path: 'result.json', schema: { required: ['price', 'missing'] } }, dir).pass, false);
  writeFileSync(join(dir, 'bad.json'), 'not json');
  assert.equal(runFileVerifier({ type: 'file_exists', path: 'bad.json', schema: { required: ['x'] } }, dir).pass, false);
  rmSync(dir, { recursive: true, force: true });
});

test('S3 evalVerifier routing: file → workspace, text → answer (R1.1, no cross-pollution)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiide-fv-'));
  writeFileSync(join(dir, 'f.json'), '{}');
  assert.equal(evalVerifier({ type: 'file_exists', path: 'f.json' }, 'irrelevant text', dir).pass, true);
  assert.equal(evalVerifier({ type: 'regex', pattern: 'ETH' }, 'ETH is up', dir).pass, true); // workspace ignored
  assert.equal(evalVerifier({ type: 'regex', pattern: 'ETH' }, 'nothing', dir).pass, false);
  rmSync(dir, { recursive: true, force: true });
});

test('S3 passAtK: unbiased estimator over valid samples (R2.1)', () => {
  assert.equal(passAtK(3, 3, 1), 1);
  assert.equal(passAtK(3, 0, 1), 0);
  assert.equal(passAtK(3, 1, 1), 0.333);
  assert.equal(passAtK(3, 1, 3), 1);       // n-c=2 < k=3 → every 3-subset has a success
  assert.equal(passAtK(4, 2, 2), 0.833);
  assert.equal(passAtK(2, 1, 3), null);    // k > n → not estimable
});

test('S3 scoreTask: pass@k is diagnostic, sits beside (not inside) composite (R2.2)', () => {
  const r1 = okRep(), r0 = { ...okRep(), C: 0 };
  const t = scoreTask([r1, r1, r0]);
  assert.equal(t.passAtK['1'], 0.667); // = success rate over valid samples
  assert.equal(t.passAtK['3'], 1);
  assert.equal(typeof t.composite, 'number'); // composite still C/P/R/H-weighted, untouched by pass@k
});

// ---- S17: activation × outcome ----

const aoRep = (activated, C) => ({ ...okRep(), activated, C });

test('S17 activationOutcome: both partitions populated → per-side meanC (R1)', () => {
  const ao = activationOutcome([aoRep(true, 1), aoRep(true, 1), aoRep(true, 1), aoRep(false, 0), aoRep(false, 1)]);
  assert.deepEqual(ao.triggered, { n: 3, meanC: 1 });
  assert.deepEqual(ao.notTriggered, { n: 2, meanC: 0.5 });
  assert.equal(ao.lowSample, true); // not-triggered side n=2 < MIN_REPEATS
});

test('S17 guardrail a: no activation signal (all null) → null, NOT {n:0}', () => {
  assert.equal(activationOutcome([aoRep(null, 1), aoRep(null, 0)]), null);
  const t = scoreTask([aoRep(null, 1), aoRep(null, 1), aoRep(null, 0)]);
  assert.equal(t.activationOutcome, null); // flows through scoreTask untouched
});

test('S17 guardrail b: one-sided → empty side is null, never a 0/0 comparison', () => {
  const ao = activationOutcome([aoRep(true, 1), aoRep(true, 1), aoRep(true, 0)]);
  assert.deepEqual(ao.triggered, { n: 3, meanC: 0.667 });
  assert.equal(ao.notTriggered, null); // absent, not { n: 0 }
});

test('S17 guardrail c + R3: low-sample flagged; input reps not mutated (read-only)', () => {
  const reps = [aoRep(true, 1), aoRep(false, 0)];
  const snapshot = JSON.stringify(reps);
  const ao = activationOutcome(reps);
  assert.equal(ao.lowSample, true);
  assert.equal(JSON.stringify(reps), snapshot); // pure read, no write-back
});

test('wilson CI + low-sample warning (AC 4.6)', () => {
  const ci = wilson(8, 10);
  assert.ok(ci.lo > 0.4 && ci.lo < 0.6 && ci.hi > 0.9);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
  const rep = repeatFor('$2481');
  assert.equal(scoreTask([rep, rep]).lowSample, true);
  assert.equal(scoreTask([rep, rep, rep]).lowSample, false);
});
