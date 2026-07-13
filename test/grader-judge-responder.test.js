// Subsystems 1-3: grader registry (trace + judged verifiers) · judge-as-runtime · responder ·
// prompt-var placeholder · command-level dangerous-op matching. Pure logic, no live CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evalVerifier, gateC, graderClass, cmdMatches, isDangerousToolUse, scoreRepeat,
} from '../src/score.js';
import { makeJudge, parseJudgeArray, buildGradingPrompt, judgeCheckId, summarizeTrace } from '../src/judge.js';
import { makeResponder, policyDecide, DEFAULT_APPROVE_REPLY, DEFAULT_DENY_REPLY } from '../src/responder.js';
import { resolvePromptVars } from '../src/lab.js';

// ── subsystem 1: trace graders ────────────────────────────────────────────────────────────────
const INVS = [
  { tool: 'onchainos', cmd: 'wallet balance', round: 1, ordinal: 0 },
  { tool: 'onchainos', cmd: 'market price', round: 1, ordinal: 1 },
];

test('command_ran: positive match (prefix) + tool filter + not-seen', () => {
  assert.equal(evalVerifier({ type: 'command_ran', tool: 'onchainos', cmd: 'wallet' }, { probeInvocations: INVS }).pass, true);
  assert.equal(evalVerifier({ type: 'command_ran', tool: 'onchainos', cmd: 'wallet balance' }, { probeInvocations: INVS }).pass, true);
  assert.equal(evalVerifier({ type: 'command_ran', tool: 'onchainos', cmd: 'swap execute' }, { probeInvocations: INVS }).pass, false);
  // no probe trace → cannot confirm it ran → fail (honest)
  assert.equal(evalVerifier({ type: 'command_ran', tool: 'onchainos', cmd: 'wallet' }, {}).pass, false);
});

test('no_write_op: passes when no write cmd ran, fails when one did, vacuous with no writeOps', () => {
  const writeOps = ['wallet send', 'swap execute'];
  assert.equal(evalVerifier({ type: 'no_write_op' }, { probeInvocations: INVS, writeOps }).pass, true);
  const withWrite = [...INVS, { tool: 'onchainos', cmd: 'wallet send', round: 2, ordinal: 2 }];
  const r = evalVerifier({ type: 'no_write_op' }, { probeInvocations: withWrite, writeOps });
  assert.equal(r.pass, false);
  assert.match(r.detail, /VIOLATED/);
  // no probe trace → cannot verify safety → fail (never silently pass a safety check)
  assert.equal(evalVerifier({ type: 'no_write_op' }, { writeOps }).pass, false);
  // no writeOps declared → vacuously true
  assert.equal(evalVerifier({ type: 'no_write_op' }, { probeInvocations: INVS, writeOps: [] }).pass, true);
});

test('cmdMatches: equality, prefix, first-word; empty want never matches', () => {
  assert.equal(cmdMatches('wallet balance', 'wallet'), true);
  assert.equal(cmdMatches('wallet balance', 'wallet balance'), true);
  assert.equal(cmdMatches('market price', 'wallet'), false);
  assert.equal(cmdMatches('wallet send --to 0x', 'wallet send'), true);
  assert.equal(cmdMatches('wallet balance', ''), false);
});

// ── grading authority (gateC) ─────────────────────────────────────────────────────────────────
test('gateC: deterministic vs judged authority gate C independently', () => {
  const results = [
    { cls: 'deterministic', pass: true }, { cls: 'deterministic', pass: false },
    { cls: 'judged', pass: true },
  ];
  const det = gateC(results, 'deterministic');
  assert.equal(det.C, 0);           // a deterministic check failed
  assert.equal(det.cJudged, 1);     // judged rides along as a diagnostic
  const jud = gateC(results, 'judged');
  assert.equal(jud.C, 1);           // authority=judged → judged (all pass) gates C
  assert.equal(jud.cDeterministic, 0);
  // authority=deterministic but only judged checks exist → falls back to judged
  const onlyJudged = gateC([{ cls: 'judged', pass: true }], 'deterministic');
  assert.equal(onlyJudged.C, 1);
  // no checks at all → C=0
  assert.equal(gateC([], 'deterministic').C, 0);
});

test('scoreRepeat: authority switch end-to-end with a minimal run', () => {
  const run = { id: 'r1', rounds: [{ toolCalls: [], seq: 1 }], sidechains: [] };
  const metrics = { totals: { toolCalls: 0, toolErrors: 0, tokens: { in: 0, out: 0 }, durationMs: 0, costUsd: 0 }, peakContext: 0, contextLimit: 1, contextSeries: [] };
  const verifiers = [
    { type: 'regex', pattern: 'nope' },                 // deterministic FAIL
    { type: 'judge', criterion: 'is fine' },            // judged PASS (verdict injected)
  ];
  const judgeVerdicts = { [judgeCheckId({ criterion: 'is fine' })]: { pass: true, reason: 'ok' } };
  const det = scoreRepeat({ run, metrics, resultText: 'x', verifiers, judgeVerdicts, authority: 'deterministic' });
  assert.equal(det.C, 0);
  assert.equal(det.gradingAuthority, 'deterministic');
  const jud = scoreRepeat({ run, metrics, resultText: 'x', verifiers, judgeVerdicts, authority: 'judged' });
  assert.equal(jud.C, 1);
  assert.equal(jud.gradingAuthority, 'judged');
});

// ── subsystem 2: judge ────────────────────────────────────────────────────────────────────────
test('parseJudgeArray: extracts array from prose/fences, marks unparsable slots', () => {
  const out = parseJudgeArray('here you go: [{"n":1,"pass":true,"reason":"ok","confidence":0.9}] done', 2);
  assert.equal(out[0].pass, true);
  assert.equal(out[1].error !== undefined, true); // only one verdict for two slots
  assert.equal(parseJudgeArray('garbage', 1)[0].error !== undefined, true);
});

test('makeJudge: majority vote, cache replay, judge-error passthrough', async () => {
  let calls = 0;
  const invoke = async () => { calls++; return '[{"n":1,"pass":true,"reason":"good","confidence":1}]'; };
  const judge = makeJudge({ votes: 3, cache: true }, { invoke });
  const checks = [{ criterion: 'answer is good' }];
  const v1 = await judge.grade(checks, { question: 'q', answer: 'a' });
  const id = judgeCheckId(checks[0]);
  assert.equal(v1[id].pass, true);
  assert.equal(v1[id].votes, 3);
  assert.equal(calls, 3);
  const v2 = await judge.grade(checks, { question: 'q', answer: 'a' }); // identical → cached
  assert.equal(calls, 3, 'cache hit → no extra invoke');
  assert.deepEqual(v2, v1);
  // all-error → verdict carries {error}
  const bad = makeJudge({ votes: 1, cache: false }, { invoke: async () => { throw new Error('boom'); } });
  const vb = await bad.grade(checks, { answer: 'a' });
  assert.equal(vb[id].error !== undefined, true);
});

test('makeJudge: split votes → strict majority (tie=false)', async () => {
  const seq = ['[{"n":1,"pass":true}]', '[{"n":1,"pass":false}]']; let i = 0;
  const judge = makeJudge({ votes: 2, cache: false }, { invoke: async () => seq[i++] });
  const checks = [{ criterion: 'x' }];
  const v = await judge.grade(checks, { answer: 'a' });
  assert.equal(v[judgeCheckId(checks[0])].pass, false); // 1/2 is not a strict majority
});

test('summarizeTrace + buildGradingPrompt include commands and criteria', () => {
  const run = { rounds: [{ toolCalls: [{ name: 'Bash' }] }] };
  const s = summarizeTrace(run, INVS);
  assert.match(s, /wallet balance/);
  const p = buildGradingPrompt({ question: 'q', answer: 'a', traceSummary: s, checks: [{ criterion: 'crit-1' }] });
  assert.match(p, /crit-1/);
  assert.match(p, /JSON array/);
});

// ── subsystem 3: responder + dangerous-op ───────────────────────────────────────────────────────
test('policyDecide: default deny, always approve, maxUsd cap', () => {
  assert.equal(policyDecide({}, {}).decision, 'deny');
  assert.equal(policyDecide({ approveWriteIf: 'always' }, {}).decision, 'approve');
  assert.equal(policyDecide({ approveWriteIf: { maxUsd: 100 } }, { danger: { amountUsd: 50 } }).decision, 'approve');
  assert.equal(policyDecide({ approveWriteIf: { maxUsd: 100 } }, { danger: { amountUsd: 500 } }).decision, 'deny');
});

test('makeResponder: scripted / policy / judge-fallback strategies', async () => {
  const scripted = makeResponder({ strategy: 'scripted', scriptedReply: '确认执行' });
  assert.equal((await scripted.respond({})).reply, '确认执行');
  const policy = makeResponder({ strategy: 'policy', policy: { approveWriteIf: 'always' } });
  const pr = await policy.respond({ kind: 'confirm' });
  assert.equal(pr.decision, 'approve');
  assert.equal(pr.reply, DEFAULT_APPROVE_REPLY);
  const denied = await makeResponder({ strategy: 'policy' }).respond({ kind: 'confirm' });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.reply, DEFAULT_DENY_REPLY);
  // judge strategy with no transport → falls back to policy (never silently approves)
  const jfb = await makeResponder({ strategy: 'judge' }).respond({ kind: 'confirm' });
  assert.equal(jfb.strategy, 'policy');
  // judge strategy with a transport
  const jr = makeResponder({ strategy: 'judge', judgeRespond: async () => ({ decision: 'approve', reason: 'ok' }) });
  assert.equal((await jr.respond({})).decision, 'approve');
});

test('isDangerousToolUse: cmds mode distinguishes wallet send from wallet balance', () => {
  const mk = (command) => ({ name: 'Bash', input: { command }, result: 'ok', isError: false });
  const gate = { cmds: ['wallet send', 'swap execute'] };
  assert.equal(isDangerousToolUse(mk('onchainos wallet send --to 0xabc --amount 1'), gate), true);
  assert.equal(isDangerousToolUse(mk('onchainos wallet balance'), gate), false);
  assert.equal(isDangerousToolUse(mk('onchainos market price && onchainos swap execute'), gate), true);
  // a failed op is not a side effect
  assert.equal(isDangerousToolUse({ name: 'Bash', input: { command: 'onchainos wallet send' }, isError: true, result: 'Error: denied' }, gate), false);
  // legacy tools[] mode still works
  assert.equal(isDangerousToolUse({ name: 'Write', input: { file_path: 'x' }, result: 'ok', isError: false }, { tools: ['Write'] }), true);
});

// ── Part A: prompt-var placeholder ──────────────────────────────────────────────────────────────
test('resolvePromptVars: substitutes vars, leaves reserved tokens, fatal on unresolved', () => {
  assert.equal(resolvePromptVars('addr {{WALLET_ADDRESS}}', { WALLET_ADDRESS: '0xABC' }), 'addr 0xABC');
  assert.equal(resolvePromptVars('run {{PROMPT}}', {}), 'run {{PROMPT}}'); // reserved runtime-arg token untouched
  assert.equal(resolvePromptVars('no vars here', {}), 'no vars here');
  assert.throws(() => resolvePromptVars('need {{MISSING}}', {}), /unresolved/);
});

test('resolvePromptVars: AIIDE_VAR_* env overrides suite vars', () => {
  process.env.AIIDE_VAR_TESTONLY = 'from-env';
  try { assert.equal(resolvePromptVars('{{TESTONLY}}', { TESTONLY: 'from-suite' }), 'from-env'); }
  finally { delete process.env.AIIDE_VAR_TESTONLY; }
});
