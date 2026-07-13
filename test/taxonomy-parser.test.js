// Observability taxonomy T1 Stage 1 — parser/lab 前置修繕 golden samples.
// Spec: docs/observability-taxonomy.md §3.1 (a)(b)(e) + §3.5/§2 lab 前置 (rep.timedOut, rep.retries).
//   (a) userEvents five-class srcKind tagging (r5 F-5-01: NEW field + run.userEventsTagVersion —
//       `kind` semantics untouched, legacy runs stay structurally detectable by field ABSENCE)
//   (b) compact-boundary → run.compactions[] + compactBefore on the next NEW same-domain round
//   (e) result lines → run.selfReports[] (verbatim fields, one record per line, NO Σ here)
//   G-17 前置: structured rep.timedOut / rep.retries, journal-round-trip safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSessionJsonl, extractTriggers } from '../src/parser.js';
import { computeRunMetrics } from '../src/metrics.js';
import { runSuite, computeResumeKey } from '../src/lab.js';

const OBS_STUB = fileURLToPath(new URL('./fixtures/obs-stub.js', import.meta.url));
const CC_STUB = fileURLToPath(new URL('./fixtures/claude-stub.js', import.meta.url));
const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url)), 'utf8');

const tmp = () => mkdtempSync(join(tmpdir(), 'aiide-taxo-'));
const L = (o) => JSON.stringify(o);
const parse = (lines) => parseSessionJsonl(lines.join('\n'), { source: 'taxo-fixture' });

const TS = '2026-07-02T10:00:00.000Z';
const userLine = (text, extra = {}) => L({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
  uuid: 'u' + Math.random().toString(36).slice(2, 6), timestamp: TS, sessionId: 'taxo-1', ...extra,
});
const asstLine = (requestId, extra = {}, content = [{ type: 'text', text: 'ok' }]) => L({
  type: 'assistant', requestId, uuid: requestId + '-u', timestamp: TS, sessionId: 'taxo-1',
  message: {
    model: 'claude-sonnet-5', role: 'assistant', content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
  ...extra,
});

// ---- §3.1(a): five-class srcKind tagging --------------------------------------------------

test('taxonomy (a): five classes each hit their srcKind; kind semantics unchanged; tag version present', () => {
  const r = parse([
    userLine('What is the price of ETH?'),                                           // → user
    asstLine('req1', {}, [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'okx-dex-market' } }]),
    // skill-body: isMeta + sourceToolUseID (still pushed as a userEvent after hang-back)
    userLine('SKILL.md body text here', { isMeta: true, sourceToolUseID: 'tu1' }),    // → skill-body
    // tool-result-side: text block in the SAME message as a tool_result block
    L({
      type: 'user', uuid: 'u-tr', timestamp: TS, sessionId: 'taxo-1',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'skill loaded' },
        { type: 'text', text: '<system-reminder>hook says hi</system-reminder>' },
      ] },
    }),                                                                              // → tool-result-side
    L({ type: 'attachment', uuid: 'u-att', timestamp: TS, sessionId: 'taxo-1',
        attachment: { note: 'attached file state contents' } }),                     // → attachment
    userLine('Caveat: the messages below were generated…', { isMeta: true }),        // → meta-injected
  ]);

  assert.equal(r.userEventsTagVersion, 1); // parse-time capability fingerprint
  assert.deepEqual(r.userEvents.map((e) => e.srcKind),
    ['user', 'skill-body', 'tool-result-side', 'attachment', 'meta-injected']);
  // kind field semantics UNCHANGED — downstream consumers see exactly the legacy values
  assert.deepEqual(r.userEvents.map((e) => e.kind),
    ['user', 'user', 'user', 'attachment', 'user']);
  // the skill-body line still hangs its text back onto the Skill call (existing behavior kept)
  assert.equal(r.rounds[0].toolCalls[0].skillBody, 'SKILL.md body text here');
});

test('taxonomy (a): priority order is unique-hit — skill-body beats tool-result-side; meta without source beats user but loses to tool-result-side', () => {
  const r = parse([
    asstLine('req1', {}, [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 's' } }]),
    // conflict: isMeta + sourceToolUseID AND the same message carries a tool_result → skill-body wins
    L({
      type: 'user', uuid: 'u-c1', timestamp: TS, sessionId: 'taxo-1',
      isMeta: true, sourceToolUseID: 'tu1',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'loaded' },
        { type: 'text', text: 'body via conflicting line' },
      ] },
    }),
    // isMeta WITHOUT sourceToolUseID but message has tool_result → tool-result-side wins over meta-injected
    L({
      type: 'user', uuid: 'u-c2', timestamp: TS, sessionId: 'taxo-1', isMeta: true,
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'x' },
        { type: 'text', text: 'reminder beside a tool result' },
      ] },
    }),
    // isMeta, no sourceToolUseID, no tool_result → meta-injected (never plain user)
    userLine('injected caveat', { isMeta: true }),
  ]);
  assert.deepEqual(r.userEvents.map((e) => e.srcKind),
    ['skill-body', 'tool-result-side', 'meta-injected']);
});

test('taxonomy (a): sidechain userEvents are tagged too (pure agent-transcript promotion path)', () => {
  const r = parse([
    userLine('agent task prompt', { isSidechain: true }),
    userLine('sidechain caveat', { isSidechain: true, isMeta: true }),
    asstLine('reqS', { isSidechain: true, agentId: 'side-1' }),
  ]);
  // whole file is one agent's transcript → sidechain events promoted to main
  assert.equal(r.agentId, 'side-1');
  assert.deepEqual(r.userEvents.map((e) => e.srcKind), ['user', 'meta-injected']);
  assert.equal(r.prompt, 'agent task prompt');
});

test('taxonomy (a): legacy run shape (no srcKind / no tag version) unaffected — this stage touches no consumer', () => {
  // hand-built legacy run object exactly as an old parser sealed it (immutable runs/*.json)
  const legacy = {
    id: 'legacy-1', sessionId: 's', source: 'x.jsonl', model: 'claude-sonnet-5',
    startedAt: TS, endedAt: TS, cwd: null, version: null,
    prompt: 'p',
    userEvents: [
      { ts: TS, text: 'p', chars: 1, kind: 'user' },
      // r5 legacy fixture spec: kind:'user' with system-reminder mixed text and NO srcKind
      { ts: TS, text: '<system-reminder>legacy mixed text</system-reminder>', chars: 46, kind: 'user' },
      { ts: TS, text: 'attached', chars: 8, kind: 'attachment' },
    ],
    rounds: [{
      seq: 1, ts: TS, durationMs: 0, model: 'claude-sonnet-5', attributionSkill: null,
      usage: { in: 10, out: 5, cacheW: 0, cacheR: 0 }, contextFootprint: 15,
      toolCalls: [{ name: 'Skill', id: 't1', isError: false, skill: 'okx-dex-market', input: null, result: null, denialKind: null, skillBody: null }],
      stopReason: 'end_turn', text: 'ok', thinking: '', textChars: 2, thinkingChars: 0,
    }],
    sidechains: [], parseWarnings: 0, meta: {},
  };
  assert.equal(legacy.userEventsTagVersion, undefined); // the structurally detectable legacy predicate
  // existing consumers keep working on the legacy shape, and never materialize a tag
  const m = computeRunMetrics(legacy);
  assert.equal(m.totals.rounds, 1);
  assert.deepEqual(extractTriggers(legacy), { primarySkill: 'okx-dex-market', auxiliarySkills: [] });
  assert.ok(legacy.userEvents.every((e) => !('srcKind' in e)));
  assert.equal(legacy.userEvents[1].kind, 'user'); // two legacy kind values sit INSIDE the five-class domain
});

test('taxonomy: existing fixture parses with new run fields, zero extra warnings', () => {
  const r = parseSessionJsonl(FIXTURE, { source: 'fixture' });
  assert.equal(r.parseWarnings, 2); // unchanged: 1 bad JSON + 1 unknown type
  assert.equal(r.userEventsTagVersion, 1);
  assert.deepEqual(r.compactions, []);          // no boundary lines → observed zero (knowable)
  assert.ok(!('selfReports' in r));             // no result lines → field ABSENT (legacy-shaped)
  assert.equal(r.userEvents[0].srcKind, 'user');
});

// ---- §3.1(b): compact-boundary collection --------------------------------------------------

test('taxonomy (b): boundary recorded in run.compactions and compactBefore lands on the next NEW main round', () => {
  const r = parse([
    userLine('q'),
    asstLine('req1'),
    L({ type: 'compact-boundary', timestamp: '2026-07-02T10:00:30.000Z', sessionId: 'taxo-1' }),
    asstLine('req2'),
    asstLine('req3'),
  ]);
  assert.deepEqual(r.compactions, [{ ts: '2026-07-02T10:00:30.000Z' }]);
  assert.ok(!('compactBefore' in r.rounds[0]));
  assert.equal(r.rounds[1].compactBefore, true);
  assert.ok(!('compactBefore' in r.rounds[2])); // consumed exactly once
});

test('taxonomy (b) interleaved golden: main boundary → sidechain round appears first → compactBefore still lands on the next MAIN round', () => {
  const r = parse([
    userLine('q'),
    asstLine('req1'),
    L({ type: 'compact-boundary', timestamp: TS, sessionId: 'taxo-1' }), // main-domain boundary
    asstLine('reqS1', { isSidechain: true, agentId: 'side-1' }),          // different domain — must not consume
    asstLine('req2'),
  ]);
  assert.equal(r.sidechains.length, 1);
  assert.ok(!('compactBefore' in r.sidechains[0].rounds[0]));
  assert.equal(r.rounds[1].compactBefore, true);
  assert.equal(r.compactions.length, 1);
});

test('taxonomy (b): sidechain boundary attaches to the next NEW sidechain round, not a main round', () => {
  const r = parse([
    userLine('q'),
    asstLine('reqS1', { isSidechain: true, agentId: 'side-1' }),
    L({ type: 'compact-boundary', timestamp: TS, sessionId: 'taxo-1', isSidechain: true }),
    asstLine('req1'),                                                     // main — must not consume
    asstLine('reqS2', { isSidechain: true, agentId: 'side-1' }),
  ]);
  assert.ok(!('compactBefore' in r.rounds.find((x) => x.seq === 1)));
  assert.equal(r.sidechains[0].rounds[1].compactBefore, true);
});

test('taxonomy (b): a second streaming segment of the same requestId is NOT "newly created" — the boundary waits for the next request', () => {
  const r = parse([
    userLine('q'),
    asstLine('req1'),
    L({ type: 'compact-boundary', timestamp: TS, sessionId: 'taxo-1' }),
    asstLine('req1'), // same requestId → merges into the existing round, must not consume
    asstLine('req2'),
  ]);
  assert.equal(r.rounds.length, 2);
  assert.ok(!('compactBefore' in r.rounds[0]));
  assert.equal(r.rounds[1].compactBefore, true);
});

test('taxonomy (b): file-tail boundary → run.compactions only, no round flagged; multiple boundaries all counted', () => {
  const r = parse([
    userLine('q'),
    asstLine('req1'),
    L({ type: 'compact-boundary', timestamp: '2026-07-02T10:00:31.000Z', sessionId: 'taxo-1' }),
    L({ type: 'compact-boundary', timestamp: '2026-07-02T10:00:32.000Z', sessionId: 'taxo-1' }),
    asstLine('req2'),
    L({ type: 'compact-boundary', timestamp: '2026-07-02T10:00:33.000Z', sessionId: 'taxo-1' }), // tail
  ]);
  assert.deepEqual(r.compactions.map((c) => c.ts),
    ['2026-07-02T10:00:31.000Z', '2026-07-02T10:00:32.000Z', '2026-07-02T10:00:33.000Z']);
  assert.equal(r.rounds[1].compactBefore, true); // both pre-req2 boundaries collapse onto one flag
  assert.ok(r.rounds.every((x) => x.compactBefore !== false)); // never materialized as false
  assert.ok(!('compactBefore' in r.rounds[0]));
});

// ---- §3.1(e)/G-15: result-line collection --------------------------------------------------

test('taxonomy (e): two result lines → two selfReports records, verbatim increments, missing fields null, no Σ', () => {
  const r = parse([
    userLine('q'),
    asstLine('req1'),
    L({ type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 3, duration_ms: 1200, is_error: false, sessionId: 'taxo-1' }),
    asstLine('req2'),
    L({ type: 'result', subtype: 'success', total_cost_usd: 0.02, is_error: true, sessionId: 'taxo-1' }),
  ]);
  assert.deepEqual(r.selfReports, [
    { total_cost_usd: 0.01, num_turns: 3, duration_ms: 1200, is_error: false },
    { total_cost_usd: 0.02, num_turns: null, duration_ms: null, is_error: true },
  ]);
  assert.equal(r.parseWarnings, 0); // result is a handled type, never an unknown-type warning
});

test('taxonomy (e): no result line → selfReports absent (undefined, legacy-shaped: absent = no channel)', () => {
  const r = parse([userLine('q'), asstLine('req1')]);
  assert.ok(!('selfReports' in r));
});

// ---- lab G-17 前置: rep.timedOut + rep.retries + journal round-trip -------------------------

function obsSuite(over = {}, env = {}) {
  return {
    name: 'taxo-obs', repeats: 1, timeoutMs: 30_000, retry: { maxRetries: 2, baseDelayMs: 1 },
    runtime: { type: 'command', name: 'obs-stub', cmd: process.execPath, args: [OBS_STUB, '--go', '{{PROMPT}}'], env },
    tasks: [{ id: 'eth', prompt: 'price of ETH?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    ...over,
  };
}

function seqDir(root, payloads) {
  const dir = join(root, 'seq');
  mkdirSync(dir, { recursive: true });
  payloads.forEach((p, i) => writeFileSync(join(dir, `${i + 1}.json`), JSON.stringify(p)));
  return dir;
}

test('lab G-17: timeout rep carries structured timedOut:true (error string unchanged) and survives the journal round-trip', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  process.env.AIIDE_CLAUDE_BIN = `${process.execPath}||${CC_STUB}`;
  process.env.STUB_MODE = 'hang';
  const key = computeResumeKey({ name: 'taxo-cc', model: 'sonnet', sha256: null });
  const journalPath = join(dataDir, 'experiments', '.inprogress', `${key}.jsonl`);
  try {
    const suite = {
      name: 'taxo-cc', model: 'sonnet', repeats: 1, maxTurns: 5, timeoutMs: 1500,
      retry: { maxRetries: 1, baseDelayMs: 1 }, skills: { dirs: [] },
      tasks: [{ id: 'eth', prompt: 'price?', verifiers: [{ type: 'regex', pattern: 'ETH' }] }],
    };
    let journalText = null;
    const expA = await runSuite({
      suite, suiteDir: root, dataDir,
      onProgress: (e) => { if (e.type === 'repeat-done') journalText = readFileSync(journalPath, 'utf8'); },
    });
    const rep = expA.tasks['eth'].repeats[0];
    assert.equal(rep.timedOut, true);
    assert.equal(rep.error, 'timeout');             // backward-compatible string untouched
    assert.notEqual(rep.excluded, true);            // timeout is never env-noise
    assert.ok(!('retries' in rep));                 // no env-noise retry happened → field absent

    // journal row keeps the structured field; a resumed seal serves it back verbatim
    const row = journalText.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.rep);
    assert.equal(row.rep.timedOut, true);
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, journalText);
    const expB = await runSuite({ suite, suiteDir: root, dataDir });
    assert.equal(expB.tasks['eth'].repeats[0].timedOut, true);
  } finally {
    delete process.env.AIIDE_CLAUDE_BIN; delete process.env.STUB_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('lab G-17: env-noise retry then success → rep.retries records the pre-success attempt; journal/resume keeps it', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const dir = seqDir(root, [
    { result: 'nope', __stderr: '429 too many requests' },   // attempt 1 → env-noise
    { result: 'ETH ok', trace: [{ text: 'ETH ok' }] },        // retry → success
  ]);
  const suite = obsSuite({}, { OBS_STUB_SEQ: dir });
  const key = computeResumeKey({ name: 'taxo-obs', model: 'sonnet', sha256: null });
  const journalPath = join(dataDir, 'experiments', '.inprogress', `${key}.jsonl`);
  let journalText = null;
  const expA = await runSuite({
    suite, suiteDir: root, dataDir,
    onProgress: (e) => { if (e.type === 'repeat-done') journalText = readFileSync(journalPath, 'utf8'); },
  });
  const rep = expA.tasks['eth'].repeats[0];
  assert.equal(rep.C, 1);
  assert.notEqual(rep.excluded, true);
  assert.deepEqual(rep.retries, [{ attempt: 1, signature: 'rate-limit-429', backoffMs: 1 }]);
  assert.ok(!('timedOut' in rep));

  // journal round-trip: restore the journal and re-seal from cache — retries not lost
  assert.match(journalText, /"retries"/);
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, journalText);
  const expB = await runSuite({ suite, suiteDir: root, dataDir });
  assert.deepEqual(expB.tasks['eth'].repeats[0].retries, [{ attempt: 1, signature: 'rate-limit-429', backoffMs: 1 }]);
  rmSync(root, { recursive: true, force: true });
});

test('lab G-17: retry-exhausted excluded rep still carries its retry history', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const payload = join(root, 'p.json');
  writeFileSync(payload, JSON.stringify({ result: 'nope', __stderr: '429 too many requests' }));
  const suite = obsSuite({ retry: { maxRetries: 1, baseDelayMs: 1 } }, { OBS_STUB_FILE: payload });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  const rep = exp.tasks['eth'].repeats[0];
  assert.equal(rep.excluded, true);
  assert.equal(rep.excludedSignature, 'rate-limit-429');
  assert.deepEqual(rep.retries, [{ attempt: 1, signature: 'rate-limit-429', backoffMs: 1 }]);
  rmSync(root, { recursive: true, force: true });
});

test('lab G-17: multi-step aggregate flat-merges step retries (set only when a step actually retried)', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const dir = seqDir(root, [
    { result: 'nope', __stderr: '429 too many requests' },   // step 1 attempt 1 → env-noise
    { result: 'ETH ok', trace: [{ text: 'ETH ok' }] },        // step 1 retry → success; step 2 reuses
  ]);
  const suite = obsSuite({
    tasks: [{
      id: 'flow', steps: [
        { prompt: 's1', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
        { prompt: 's2', verifiers: [{ type: 'regex', pattern: 'ETH' }] },
      ],
    }],
  }, { OBS_STUB_SEQ: dir });
  const exp = await runSuite({ suite, suiteDir: root, dataDir });
  const rep = exp.tasks['flow'].repeats[0];
  assert.equal(rep.C, 1);
  assert.deepEqual(rep.retries, [{ attempt: 1, signature: 'rate-limit-429', backoffMs: 1 }]);
  rmSync(root, { recursive: true, force: true });
});

test('lab G-17: clean rep carries neither timedOut nor retries (absent ≠ false/[])', async () => {
  const root = tmp();
  const dataDir = join(root, '.aiide');
  const payload = join(root, 'p.json');
  writeFileSync(payload, JSON.stringify({ result: 'ETH ok', trace: [{ text: 'ETH ok' }] }));
  const exp = await runSuite({ suite: obsSuite({}, { OBS_STUB_FILE: payload }), suiteDir: root, dataDir });
  const rep = exp.tasks['eth'].repeats[0];
  assert.equal(rep.C, 1);
  assert.ok(!('timedOut' in rep));
  assert.ok(!('retries' in rep));
  rmSync(root, { recursive: true, force: true });
});
