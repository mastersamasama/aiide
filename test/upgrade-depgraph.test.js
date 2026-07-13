// U2 dep-collectors — golden-sample tests.
// Fixtures reproduce the real Claude Code JSONL line shapes recorded in the Wave 0
// probe report P1 (trigger / body / Read attribution) and P4 (permission-denied):
//   • Skill tool_use carries input.skill; the trigger round has NO attributionSkill
//   • SKILL.md body arrives as an isMeta:true user line whose sourceToolUseID points
//     back at the Skill tool_use (1457 chars), while the launch tool_result is 28 chars
//   • a ref Read hits skills/<name>/references/… and its tool_result has no is_error
//   • a denied tool_result carries toolDenialKind:"user-rejected" + is_error:true
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSessionJsonl, extractTriggers, classifyToolResult, skillBodyCostEst,
} from '../src/parser.js';
import { attributeRead, collectSessionEvents } from '../src/depgraph.js';

const toJsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n');

// SKILL.md body of EXACTLY 1457 chars → round(1457/4) = 364 tokens (P1 §fact 3).
const BODY_1457 = 'SKILL body '.padEnd(1457, 'x');
const LAUNCH_MSG = 'Launching skill: probe-skill'; // 28 chars — the misleading source

const PROFILE = '/home/u/.claude-probe';

// A full P1-shaped session: prompt → Skill trigger (no attr) → launch result →
// isMeta body → skill-active Read of a reference. `withBody` toggles R2.EB3.
function probeSession({ id = 's1', withBody = true } = {}) {
  const lines = [
    { type: 'user', sessionId: id, timestamp: '2026-07-01T00:00:00Z',
      message: { role: 'user', content: 'analyze OKB' } },
    // trigger round: thinking + Skill tool_use, deliberately NO attributionSkill (R2.EB1)
    { type: 'assistant', requestId: 'req-trigger', timestamp: '2026-07-01T00:00:01Z',
      message: { role: 'assistant', model: 'claude-x', content: [
        { type: 'thinking', thinking: 'pick the skill' },
        { type: 'tool_use', id: 'toolu_skill1', name: 'Skill',
          input: { skill: 'probe-skill', args: 'analyze OKB' } },
      ] } },
    { type: 'user', timestamp: '2026-07-01T00:00:02Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_skill1', content: LAUNCH_MSG } ] } },
  ];
  if (withBody) {
    lines.push({ type: 'user', isMeta: true, sourceToolUseID: 'toolu_skill1',
      timestamp: '2026-07-01T00:00:03Z',
      message: { role: 'user', content: [{ type: 'text', text: BODY_1457 }] } });
  }
  lines.push(
    // skill-active round DOES carry attributionSkill (enhancement signal only)
    { type: 'assistant', requestId: 'req-read', timestamp: '2026-07-01T00:00:04Z',
      attributionSkill: 'probe-skill',
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_read1', name: 'Read',
          input: { file_path: `${PROFILE}/skills/probe-skill/references/fake-coin-guide.md` } } ] } },
    { type: 'user', timestamp: '2026-07-01T00:00:05Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_read1', content: 'guide content' } ] } },
  );
  return parseSessionJsonl(toJsonl(lines), { source: id });
}

test('extractTriggers: primary = first Skill from input.skill even when trigger round lacks attributionSkill (R2.1.2/R2.1.3/R2.EB1)', () => {
  const run = probeSession();
  const triggerRound = run.rounds.find((r) => r.toolCalls.some((tc) => tc.name === 'Skill'));
  assert.equal(triggerRound.attributionSkill, null, 'trigger round must have no attributionSkill (P1)');
  const { primarySkill, auxiliarySkills } = extractTriggers(run);
  assert.equal(primarySkill, 'probe-skill');
  assert.deepEqual(auxiliarySkills, []);
});

test('extractTriggers: primary + distinct auxiliaries, deduped against primary (R2.1.2)', () => {
  const lines = [
    { type: 'user', sessionId: 's-multi', message: { role: 'user', content: 'go' } },
    { type: 'assistant', requestId: 'r1', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'alpha' } } ] } },
    { type: 'assistant', requestId: 'r2', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'beta' } } ] } },
    { type: 'assistant', requestId: 'r3', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'beta' } } ] } }, // dup
    { type: 'assistant', requestId: 'r4', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't4', name: 'Skill', input: { skill: 'alpha' } } ] } }, // re-trigger primary
  ];
  const { primarySkill, auxiliarySkills } = extractTriggers(parseSessionJsonl(toJsonl(lines)));
  assert.equal(primarySkill, 'alpha');
  assert.deepEqual(auxiliarySkills, ['beta']); // beta once; alpha not re-listed
});

test('isMeta body hang-back → skillBodyCostEst uses 1457 chars, NOT the 28-char launch (R2.3.1/R2.3.1a/R2.3.2)', () => {
  const run = probeSession({ withBody: true });
  const skillCall = run.rounds.flatMap((r) => r.toolCalls).find((tc) => tc.name === 'Skill');
  assert.equal(skillCall.skillBody, BODY_1457, 'body hung back onto the Skill tool_use via sourceToolUseID');
  assert.equal(skillCall.result, LAUNCH_MSG, 'launch result still captured separately');
  assert.equal(skillBodyCostEst(run), 364);           // round(1457/4)
  assert.notEqual(skillBodyCostEst(run), 7);           // round(28/4) — the lab.js:754 bug value
});

test('skillBodyCostEst: no isMeta body → null, never impersonates the launch message (R2.3.3/R2.EB3)', () => {
  const run = probeSession({ withBody: false });
  const skillCall = run.rounds.flatMap((r) => r.toolCalls).find((tc) => tc.name === 'Skill');
  assert.equal(skillCall.skillBody, null);
  assert.equal(skillBodyCostEst(run), null);
});

test('attributeRead: references/ file → skill; success has no is_error; non-skill path → null (R2.2.1/R2.2.3)', () => {
  const hit = attributeRead({
    input: { file_path: `${PROFILE}/skills/probe-skill/references/fake-coin-guide.md` }, isError: false });
  assert.equal(hit.skill, 'probe-skill');
  assert.equal(hit.refPath, 'probe-skill/references/fake-coin-guide.md');
  assert.equal(hit.logicalRef, 'probe-skill/references/fake-coin-guide.md');
  assert.equal(hit.shared, false);
  assert.equal(hit.success, true);

  // attribution does not depend on attributionSkill being present (R2.2.2) — file_path alone decides
  const outside = attributeRead({ input: { file_path: '/home/u/project/src/index.js' }, isError: false });
  assert.equal(outside, null);
});

test('attributeRead: _shared copies normalize by suffix + content md5 across skills; drift splits (R2.4.1a [TL-M3])', () => {
  const shared = 'shared util contents';
  const a = attributeRead({ input: { file_path: `${PROFILE}/skills/alpha/_shared/util.md` }, result: shared, isError: false });
  const b = attributeRead({ input: { file_path: `${PROFILE}/skills/beta/_shared/util.md` }, result: shared, isError: false });
  assert.equal(a.shared, true);
  assert.equal(a.logicalRef, b.logicalRef, 'identical _shared copies collapse to one logical ref (name-independent)');
  assert.notEqual(a.refPath, b.refPath, 'skill-qualified refPath still distinguishes the physical copies');

  const drifted = attributeRead({ input: { file_path: `${PROFILE}/skills/beta/_shared/util.md` }, result: shared + ' EDITED', isError: false });
  assert.notEqual(a.logicalRef, drifted.logicalRef, 'drifted content (different md5) is a different logical ref');
});

test('collectSessionEvents: triggerSet/readSet deduped, category threaded through untouched (R2.4.1/R2.4.2)', () => {
  const run = probeSession({ id: 's-collect' });
  const ev = collectSessionEvents(run, { category: 'onchain-lookup' });
  assert.equal(ev.category, 'onchain-lookup');
  assert.equal(ev.primarySkill, 'probe-skill');
  assert.deepEqual(ev.triggerSet, ['probe-skill']);
  assert.equal(ev.readSet.length, 1);
  assert.equal(ev.readSet[0].skill, 'probe-skill');
  assert.equal(ev.readSet[0].logicalRef, 'probe-skill/references/fake-coin-guide.md');
});

test('collectSessionEvents: cross-session _shared co-read is not diluted (R2.4.1a [TL-M3])', () => {
  const shared = 'identical shared body';
  function sharedReadSession(id, skill) {
    const lines = [
      { type: 'user', sessionId: id, message: { role: 'user', content: 'go' } },
      { type: 'assistant', requestId: 'r1', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'ts', name: 'Skill', input: { skill } } ] } },
      { type: 'assistant', requestId: 'r2', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tr', name: 'Read',
          input: { file_path: `${PROFILE}/skills/${skill}/_shared/util.md` } } ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tr', content: shared } ] } },
    ];
    return collectSessionEvents(parseSessionJsonl(toJsonl(lines), { source: id }), { category: 'c' });
  }
  const s1 = sharedReadSession('sh1', 'alpha');
  const s2 = sharedReadSession('sh2', 'beta');
  // Two different skills, physically different files, identical content → ONE logical ref.
  assert.equal(s1.readSet[0].logicalRef, s2.readSet[0].logicalRef);
  assert.equal(s1.readSet[0].shared, true);
  assert.notEqual(s1.readSet[0].refPath, s2.readSet[0].refPath);
});

test('classifyToolResult: three-state taxonomy is purely structural (R2.5.1-R2.5.4)', () => {
  // permission-artifact via toolDenialKind (P4 primary form)
  assert.equal(classifyToolResult({ denialKind: 'user-rejected', isError: true }), 'permission-artifact');
  // permission-artifact via is_error + permission-wall text, no denialKind
  assert.equal(classifyToolResult({
    isError: true, result: "Claude requested permissions to use Bash but you haven't granted it yet" }),
    'permission-artifact');
  // missed = the model never issued a tool_use at all (R2.5.2)
  assert.equal(classifyToolResult(null), 'missed');
  assert.equal(classifyToolResult({}, { hasUpstreamToolUse: false }), 'missed');
  // success = no is_error and no denialKind (R2.5.3)
  assert.equal(classifyToolResult({ isError: false, result: 'ok' }), 'success');
  // genuine non-permission tool error is NOT success (faithful to R2.5.3)
  assert.equal(classifyToolResult({ isError: true, result: 'ENOENT: no such file' }), 'error');
});

test('classifyToolResult: toolDenialKind captured from JSONL is classified as permission-artifact (P4 + R2.EB2)', () => {
  const lines = [
    { type: 'user', sessionId: 'sp', message: { role: 'user', content: 'run it' } },
    { type: 'assistant', requestId: 'r1', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'rm -rf /' } } ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tb', is_error: true, toolDenialKind: 'user-rejected',
        content: 'The user doesn\'t want to proceed with this tool use.' } ] } },
  ];
  const run = parseSessionJsonl(toJsonl(lines));
  const bash = run.rounds.flatMap((r) => r.toolCalls).find((tc) => tc.name === 'Bash');
  assert.equal(bash.denialKind, 'user-rejected', 'parser captured toolDenialKind (was previously discarded)');
  assert.equal(classifyToolResult(bash), 'permission-artifact');

  const ev = collectSessionEvents(run, { category: 'c' });
  assert.equal(ev.permissionEvents.length, 1);
  assert.equal(ev.permissionEvents[0].tool, 'Bash');
});
