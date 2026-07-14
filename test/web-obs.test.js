import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  attrContributions, computeRunItems, deltaSignificant, errorRate, pruneHint,
  normalizeInput, detectLoops, stackSeries,
  cohortComparable, ciOverlap, wilsonCisDisjoint, deltaTally, skillHashDeltas, meanActivation, causalWithinNoise,
  upgradeVerdictGlyph, upgradeAdoptable, upgradeRecommendation, upgradeNextSteps, upgradeRedlist, buildUpgradeView,
  UPGRADE_ENUM_GLOSS, upgradeEnumGloss,
  expStatsState, EXP_STATS_STATE, blockStatusBadge, expSkillCoverageView, expRefCoverageView,
  expProbeView, expProximityView, buildExpStatsCard, buildProbeBlockView, EXP_GLOSSARY,
  buildQuestionList, scoreHue,
  statsAuthorityBadge, expSkillDetailRows, statsProvenanceBadge, CURRENT_STATS_SCHEMA_VERSION,
  NULL_REASON_COPY, nullReasonCopy, contextCompositionView, toolUsageView, fileTargetsView,
  runHealthView, CONTEXT_COMPOSITION_TITLE, CONTEXT_BUCKET_LABELS, TOOL_USAGE_TITLE,
  FILE_TARGETS_TITLE, FILE_TARGET_BUCKET_LABELS, RUN_HEALTH_TITLE, TOOL_KIND_ORDER,
  runtimeInfoView, runtimeInfoDiff, RUNTIME_INFO_ABSENT, RUNTIME_INFO_DRIFT_NOTE,
  SYSTEM_PROMPT_ARCHIVED, SYSTEM_PROMPT_SELF_REPORTED, RUNTIME_INFO_FIELD_ABSENT,
  CONCURRENT_FACTORS_FRAMING, RUNTIME_INFO_DIFF_ABSENT,
} from '../web/obs.js';
import { probeBlocksToReport } from '../src/report.js';
import { expStats as EXP_STATS, probeBlocks as CLI_BLOCKS } from './fixtures/synthetic-bundle/bundle.js';

// ---- S4 obs-context-diff -------------------------------------------------

test('S4: attribution buckets sorted descending; residual kept signed (AC 4b)', () => {
  const { buckets, residual } = attrContributions({ prevOut: 100, toolRes: 900, injected: 400, other: -250 });
  assert.deepEqual(buckets.map(b => b.key), ['toolRes', 'injected', 'prevOut']);
  // the negative residual is NOT rendered as a contribution bucket
  assert.equal(buckets.some(b => b.key === 'other'), false);
  assert.equal(residual, -250); // compaction: stays negative, never clamped up
});

test('S4: delta significance is relative to footprint, first-round has none (AC 4a/4c)', () => {
  assert.equal(deltaSignificant(5000, 40000), true);   // 12.5% jump → colour
  assert.equal(deltaSignificant(1000, 40000), false);  // 2.5% → dim
  assert.equal(deltaSignificant(null, 40000), false);  // no previous round
  assert.equal(deltaSignificant(5000, 0), false);
});

// ---- T1 Stage 2: computeRunItems shared module + five-class buckets (taxonomy §3.1) --------

// VERBATIM copy of the pre-extraction web/index.html inline implementation — the behaviour-
// conservation oracle: on a legacy-shaped run the shared module must match it column for column.
function legacyComputeRunItemsReference(run) {
  const items = [
    ...run.rounds.map(r => ({ kind: 'round', ts: r.ts ?? '', r })),
    ...(run.userEvents ?? []).map(u => ({ kind: 'user', ts: u.ts ?? '', u })),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  let prevRound = null, injectedChars = 0;
  for (const it of items) {
    if (it.kind === 'user') { injectedChars += it.u.chars; continue; }
    const r = it.r;
    if (prevRound) {
      r._delta = r.contextFootprint - prevRound.contextFootprint;
      const attr = {
        prevOut: prevRound.usage.out,
        toolRes: Math.round(prevRound.toolCalls.reduce((a, tc) => a + (tc.result?.length ?? 0), 0) / 4),
        injected: Math.round(injectedChars / 4),
      };
      attr.other = r._delta - attr.prevOut - attr.toolRes - attr.injected;
      r._attr = attr;
    }
    injectedChars = 0;
    prevRound = r;
  }
  return items;
}

const mkRound = (seq, ts, footprint, out, toolResults = [], extra = {}) => ({
  seq, ts, contextFootprint: footprint,
  usage: { in: 0, out, cacheW: 0, cacheR: 0 },
  toolCalls: toolResults.map((res, i) => ({ name: 'T' + i, result: res })),
  ...extra,
});
const mkEv = (ts, chars, srcKind) => ({
  ts, text: 'x'.repeat(chars), chars, kind: 'user', ...(srcKind ? { srcKind } : {}),
});

test('T1S2 conservation: legacy run (no userEventsTagVersion) — shared module equals the old inline impl column for column', () => {
  // r5 F-5-01 legacy fixture shape: a kind:'user' event whose text is system-reminder mixed
  // text, in a run WITHOUT the run-level tag — it must stay in the merged bucket, never split.
  const fixture = () => ({
    rounds: [
      mkRound(1, '2026-01-01T00:00:00Z', 1000, 50),
      mkRound(2, '2026-01-01T00:02:00Z', 4000, 80, ['r'.repeat(400)]),
      mkRound(3, '2026-01-01T00:04:00Z', 3000, 10), // shrink → negative residual
    ],
    userEvents: [
      { ts: '2026-01-01T00:01:00Z', text: '<system-reminder>' + 'x'.repeat(183), chars: 200, kind: 'user' },
      { ts: '2026-01-01T00:03:00Z', text: 'a'.repeat(120), chars: 120, kind: 'attachment' },
    ],
  });
  const refRun = fixture(), newRun = fixture();
  const ref = legacyComputeRunItemsReference(refRun);
  const got = computeRunItems(newRun);
  assert.equal(got.length, ref.length);
  for (let i = 0; i < ref.length; i++) {
    assert.equal(got[i].kind, ref[i].kind);
    assert.equal(got[i].ts, ref[i].ts);
  }
  for (const [i, rr] of refRun.rounds.entries()) {
    const nr = newRun.rounds[i];
    assert.equal(nr._delta, rr._delta, `round ${rr.seq} _delta`);
    if (!rr._attr) { assert.equal(nr._attr, undefined); continue; }
    for (const k of ['prevOut', 'toolRes', 'injected', 'other'])
      assert.equal(nr._attr[k], rr._attr[k], `round ${rr.seq} _attr.${k}`);
    assert.equal(nr._attr.tagged, false);                 // honest flag: merged, NOT a fake split
    assert.equal('injectedUser' in nr._attr, false);      // the system-reminder user line stays merged
    assert.equal('compactionKind' in nr._attr, false);    // legacy negative residual keeps old shape
  }
  // sanity against hand-computed values so the oracle itself is pinned
  assert.equal(newRun.rounds[1]._attr.injected, 50);      // 200 chars / 4
  assert.equal(newRun.rounds[2]._attr.other, -1210);      // −1000 − 80 − 100 − 30
});

test('T1S2 buckets: tagged run — five classes each land home; meta-injected → injectedHarness, skill-body never enters injectedUser', () => {
  const run = {
    userEventsTagVersion: 1,
    rounds: [mkRound(1, 't0', 1000, 100), mkRound(2, 't9', 9000, 0)],
    userEvents: [
      mkEv('t1', 400, 'user'),
      mkEv('t2', 800, 'attachment'),
      mkEv('t3', 400, 'tool-result-side'),
      mkEv('t4', 200, 'meta-injected'),
      mkEv('t5', 1200, 'skill-body'),
    ],
  };
  computeRunItems(run);
  const a = run.rounds[1]._attr;
  assert.equal(a.tagged, true);
  assert.equal(a.injectedUser, 100);                       // only the pure user line (400/4)
  assert.equal(a.injectedHarness, 350);                    // (800+400+200)/4 — harness tax incl. meta-injected
  assert.equal(a.skillBody, 300);                          // 1200/4 — NOT in injectedUser
  assert.equal('injected' in a, false);                    // merged legacy bucket gone on tagged runs
  assert.equal(a.other, 8000 - 100 - 0 - 100 - 350 - 300); // residual closes the delta
  assert.equal('compactionKind' in a, false);              // positive residual → no compaction label
  // r4 golden sentence: meta-injected must POSITIVELY land in injectedHarness (not merely be
  // absent from injectedUser) — isolated fixture with a lone meta-injected event
  const metaOnly = {
    userEventsTagVersion: 1,
    rounds: [mkRound(1, 't0', 1000, 0), mkRound(2, 't9', 2000, 0)],
    userEvents: [mkEv('t1', 200, 'meta-injected')],
  };
  computeRunItems(metaOnly);
  assert.equal(metaOnly.rounds[1]._attr.injectedHarness, 50);
  assert.equal(metaOnly.rounds[1]._attr.injectedUser, 0);
});

test('T1S2 compaction: negative residual is labelled confirmed (compactBefore) vs inferred (no marker); positive → no label', () => {
  const run = {
    userEventsTagVersion: 1,
    rounds: [
      mkRound(1, 't0', 10000, 0),
      mkRound(2, 't1', 2000, 0, [], { compactBefore: true }), // Δ −8000 + parser-seen boundary
      mkRound(3, 't2', 12000, 0),                             // Δ +10000 → positive residual
      mkRound(4, 't3', 5000, 0),                              // Δ −7000, no marker
    ],
    userEvents: [],
  };
  computeRunItems(run);
  assert.equal(run.rounds[1]._attr.compactionKind, 'confirmed');
  assert.ok(run.rounds[1]._attr.other < 0);
  assert.equal(run.rounds[2]._attr.compactionKind, undefined);
  assert.equal(run.rounds[3]._attr.compactionKind, 'inferred');
});

test('T1S2 attrContributions: tagged attr → five buckets sorted desc + compactionKind passthrough; legacy shape stays three', () => {
  const v = attrContributions({
    prevOut: 10, toolRes: 500, injectedUser: 40, injectedHarness: 300, skillBody: 90,
    other: -120, tagged: true, compactionKind: 'inferred',
  });
  assert.deepEqual(v.buckets.map(b => b.key), ['toolRes', 'injectedHarness', 'skillBody', 'injectedUser', 'prevOut']);
  assert.equal(v.buckets.some(b => b.key === 'injected'), false);
  assert.equal(v.residual, -120);                          // signed, never clamped
  assert.equal(v.compactionKind, 'inferred');
  const legacy = attrContributions({ prevOut: 1, toolRes: 2, injected: 3, other: 4, tagged: false });
  assert.deepEqual(legacy.buckets.map(b => b.key), ['injected', 'toolRes', 'prevOut']);
  assert.equal(legacy.compactionKind, null);
});

test('T1S2 stackSeries: tagged five-class buckets map onto the merged injected band; compactionKind rides along for the tooltip', () => {
  const s = stackSeries([
    { seq: 2, _attr: { tagged: true, prevOut: 10, toolRes: 20, injectedUser: 5, injectedHarness: 30, skillBody: 15, other: -100, compactionKind: 'confirmed' } },
    { seq: 3, _attr: { prevOut: 1, toolRes: 2, injected: 3, other: 4 } }, // legacy shape untouched
  ]);
  assert.equal(s[0].injected, 50);                         // 5 + 30 + 15 — chart keeps 3 positive segments
  assert.equal(s[0].residual, -100);
  assert.equal(s[0].compactionKind, 'confirmed');
  assert.equal(s[1].injected, 3);
  assert.equal(s[1].compactionKind, null);
});

test('T1S2 dashboard: computeRunItems no longer inlined; dual-layer bucket + compaction copy present in both languages', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  assert.doesNotMatch(html, /function computeRunItems/);            // extraction complete
  assert.match(html, /const items = computeRunItems\(run\)/);       // both call sites use the shared export
  assert.match(html, /'round\.injectedHarness':\s*'harness 注入（injected by harness\/runtime）'/);
  assert.match(html, /'round\.skillBody':\s*'skill 正文（SKILL\.md body）'/);
  assert.match(html, /'round\.injectedUser':\s*'用户注入文本（user，估算）'/);
  assert.match(html, /'tip\.compact\.confirmed':\s*'压缩边界已确认（compact-boundary）'/);
  assert.match(html, /'tip\.compact\.inferred':\s*'按负残差推断（inferred）'/);
  // en layer present too (dual-layer discipline: each key defined in both langs)
  for (const key of ['round.injectedUser', 'round.injectedHarness', 'round.skillBody', 'tip.compact.confirmed', 'tip.compact.inferred']) {
    const occurrences = html.split(`'${key}'`).length - 1;
    assert.ok(occurrences >= 2, `${key} present in both langs (found ${occurrences})`);
  }
  // the residual tooltip actually switches on compactionKind where it renders
  assert.match(html, /compactionKind \? t\('tip\.compact\.' \+ compactionKind\) : t\('tip\.delta'\)/);
  assert.match(html, /s\.compactionKind \? ' — ' \+ t\('tip\.compact\.' \+ s\.compactionKind\)/);
});

// ---- S5 obs-overview-metrics ---------------------------------------------

test('S5: error-rate = share of runs with any tool error', () => {
  assert.equal(errorRate([{ toolErrors: 0 }, { toolErrors: 3 }, { toolErrors: 0 }, { toolErrors: 1 }]), 0.5);
  assert.equal(errorRate([]), 0);
  assert.equal(errorRate([{ toolErrors: 0 }]), 0);
});

// ---- S11 data-retention hint ---------------------------------------------

test('S11: prune hint stays silent under thresholds, fires on age or count', () => {
  const now = Date.parse('2026-07-09T00:00:00Z');
  const fresh = [{ startedAt: '2026-07-08T00:00:00Z' }, { startedAt: '2026-07-07T00:00:00Z' }];
  assert.equal(pruneHint(fresh, { now }), null); // 2 runs, 1-2 days old → silent
  assert.equal(pruneHint([], { now }), null);

  const old = [{ startedAt: '2026-01-01T00:00:00Z' }, { startedAt: '2026-07-08T00:00:00Z' }];
  const byAge = pruneHint(old, { now });
  assert.ok(byAge && byAge.byAge && byAge.oldestDays > 90);
  assert.match(byAge.command, /aiide prune --older-than 90d/);

  const many = Array.from({ length: 250 }, () => ({ startedAt: '2026-07-08T00:00:00Z' }));
  const byCount = pruneHint(many, { now });
  assert.ok(byCount && byCount.byCount && byCount.count === 250);
  assert.match(byCount.command, /aiide prune --max 200/);
});

// ---- S16 obs-loop-evolution ----------------------------------------------

test('S16: normalizeInput is key-order stable', () => {
  assert.equal(normalizeInput({ b: 1, a: 2 }), normalizeInput({ a: 2, b: 1 }));
  assert.equal(normalizeInput('ls -la'), 'ls -la');
  assert.equal(normalizeInput(null), '');
});

test('S16: detects N identical tool inputs, silent below threshold (AC 16c)', () => {
  const round = (seq, input, name = 'Bash') => ({ seq, toolCalls: [{ name, input }] });
  const looping = [1, 2, 3, 4].map(s => round(s, { cmd: 'npm test' }));
  const found = detectLoops(looping, 4);
  assert.equal(found.length, 1);
  assert.equal(found[0].type, 'identical-input');
  assert.equal(found[0].tool, 'Bash');
  assert.equal(found[0].count, 4);
  // one fewer than threshold → normal, silent
  assert.deepEqual(detectLoops(looping.slice(0, 3), 4), []);
});

test('S16: exact-prefix inputs count as the same loop; different tools do not', () => {
  const mk = (seq, input) => ({ seq, toolCalls: [{ name: 'Bash', input }] });
  const grow = [mk(1, 'ls'), mk(2, 'ls -l'), mk(3, 'ls -la'), mk(4, 'ls -la /tmp')];
  assert.equal(detectLoops(grow, 4).length, 1); // each is a prefix-extension of the first
  const mixed = [mk(1, 'ls'), { seq: 2, toolCalls: [{ name: 'Read', input: 'ls' }] }, mk(3, 'ls'), mk(4, 'ls')];
  assert.deepEqual(detectLoops(mixed, 4), []); // interrupted by a different tool
});

test('S16: repeated same-name tool errors are flagged', () => {
  const err = (seq) => ({ seq, toolCalls: [{ name: 'fetch', input: { url: seq }, isError: true }] });
  const found = detectLoops([err(1), err(2), err(3), err(4)], 4);
  assert.ok(found.some(f => f.type === 'repeated-error' && f.tool === 'fetch' && f.count === 4));
});

test('S16: stackSeries carries negative residual signed, skips round without _attr', () => {
  const rounds = [
    { seq: 1, toolCalls: [] }, // no _attr (first round)
    { seq: 2, _attr: { prevOut: 50, toolRes: 200, injected: 10, other: 40 } },
    { seq: 3, _attr: { prevOut: 30, toolRes: 0, injected: 0, other: -800 } }, // compaction
  ];
  const s = stackSeries(rounds);
  assert.equal(s.length, 2);
  assert.equal(s[0].seq, 2);
  assert.equal(s[1].residual, -800); // negative preserved for below-baseline rendering
  assert.equal(s[1].toolRes, 0);
});

// ---- S15 obs-skill-causal-compare ----------------------------------------

const expWith = (over = {}) => ({
  model: 'sonnet', runtime: 'claude-code',
  environment: { suite: { sha256: 'aaaa' }, skills: [{ name: 'okx', hash: 'a1b2c3' }] },
  summary: { composite: 0.5, C: 0.5 },
  tasks: { t1: { wilsonCi: { lo: 0.3, hi: 0.7 }, activationRate: 0.5 } },
  ...over,
});

test('S15: causal gate requires same suite+model+runtime (AC 15a)', () => {
  assert.equal(cohortComparable(expWith(), expWith()).comparable, true);
  assert.deepEqual(cohortComparable(expWith(), expWith({ model: 'opus' })).reasons, ['model']);
  const diffSuite = expWith({ environment: { suite: { sha256: 'bbbb' }, skills: [] } });
  assert.deepEqual(cohortComparable(expWith(), diffSuite).reasons, ['suite']);
  assert.equal(cohortComparable(expWith(), expWith({ runtime: 'external' })).comparable, false);
});

test('S15: skillHashDeltas returns only changed hashes (AC 15c)', () => {
  const a = expWith();
  const b = expWith({ environment: { suite: { sha256: 'aaaa' }, skills: [{ name: 'okx', hash: 'd4e5f6' }] } });
  assert.deepEqual(skillHashDeltas(a, b), [{ name: 'okx', hashA: 'a1b2c3', hashB: 'd4e5f6' }]);
  assert.deepEqual(skillHashDeltas(a, a), []); // identical hash → no causal row
});

test('Part C: wilsonCisDisjoint — non-overlap true, overlap/touching/null false', () => {
  assert.equal(wilsonCisDisjoint({ lo: 0.0, hi: 0.3 }, { lo: 0.5, hi: 0.9 }), true);  // disjoint (a below b)
  assert.equal(wilsonCisDisjoint({ lo: 0.6, hi: 0.9 }, { lo: 0.1, hi: 0.4 }), true);  // disjoint (a above b)
  assert.equal(wilsonCisDisjoint({ lo: 0.2, hi: 0.6 }, { lo: 0.5, hi: 0.9 }), false); // overlap
  assert.equal(wilsonCisDisjoint({ lo: 0.1, hi: 0.5 }, { lo: 0.5, hi: 0.9 }), false); // touching (0.5==0.5 is overlap, conservative)
  assert.equal(wilsonCisDisjoint(null, { lo: 0.5, hi: 0.9 }), false);                  // missing side
  assert.equal(wilsonCisDisjoint({ lo: null, hi: 0.3 }, { lo: 0.5, hi: 0.9 }), false); // absent bound → no claim
});

test('Part C: deltaTally — improved/regressed/flat by sign, nulls skipped', () => {
  assert.deepEqual(deltaTally([0.5, -0.2, 0, 0.1, null, -3]), { improved: 2, regressed: 2, flat: 1 });
  assert.deepEqual(deltaTally([]), { improved: 0, regressed: 0, flat: 0 });
  assert.deepEqual(deltaTally([null, null]), { improved: 0, regressed: 0, flat: 0 });
});

test('S15: within-noise only when every shared task CI overlaps (AC 15b)', () => {
  assert.equal(ciOverlap({ lo: 0.3, hi: 0.7 }, { lo: 0.5, hi: 0.9 }), true);
  assert.equal(ciOverlap({ lo: 0.1, hi: 0.3 }, { lo: 0.5, hi: 0.9 }), false);
  const a = expWith(), b = expWith();
  assert.equal(causalWithinNoise(a, b), true); // identical overlapping CIs
  const bSig = expWith({ tasks: { t1: { wilsonCi: { lo: 0.85, hi: 0.99 }, activationRate: 0.9 } } });
  assert.equal(causalWithinNoise(a, bSig), false); // disjoint CI → significant
});

test('S15: meanActivation ignores null rates, returns null when none', () => {
  assert.equal(meanActivation({ tasks: { t1: { activationRate: 0.4 }, t2: { activationRate: 0.6 } } }), 0.5);
  assert.equal(meanActivation({ tasks: { t1: { activationRate: null } } }), null);
});

// ---- U8 upgrade-view (verdict-first, governance-neutral) -----------------

test('U8: verdict → four-state glyph ✓✗~∅ (phase6-visual)', () => {
  assert.deepEqual(upgradeVerdictGlyph('cost-opt', true), { glyph: '✓', tone: 'ok' });
  assert.deepEqual(upgradeVerdictGlyph('neutral-refactor', false), { glyph: '✗', tone: 'err' });
  assert.deepEqual(upgradeVerdictGlyph('inconclusive', false), { glyph: '~', tone: 'warn' });
  assert.deepEqual(upgradeVerdictGlyph('insufficient-data', false), { glyph: '∅', tone: 'dim' });
});

test('U8: insufficient-data / inconclusive are NEVER adoptable; intent verdict only when established', () => {
  assert.equal(upgradeAdoptable('cost-opt', true), true);
  assert.equal(upgradeAdoptable('cost-opt', false), false);       // not established
  assert.equal(upgradeAdoptable('insufficient-data', false), false);
  assert.equal(upgradeAdoptable('insufficient-data', true), false); // established is never set here, but guard anyway
  assert.equal(upgradeAdoptable('inconclusive', false), false);
});

test('U8: recommendation framing — intent verdict decidable (true/false); undecidable states NEVER false', () => {
  assert.deepEqual(upgradeRecommendation('cost-opt', true), { decidable: true, recommended: true });
  assert.deepEqual(upgradeRecommendation('cost-opt', false), { decidable: true, recommended: false });
  assert.deepEqual(upgradeRecommendation('neutral-refactor', true), { decidable: true, recommended: true });
  // the two undecidable verdicts must resolve to decidable:false, recommended:null — never a `false`
  assert.deepEqual(upgradeRecommendation('insufficient-data', false), { decidable: false, recommended: null });
  assert.deepEqual(upgradeRecommendation('inconclusive', false), { decidable: false, recommended: null });
});

test('U8: insufficient-data next step prints "還需 N 條配對" = MIN_PAIRS − pairs (R8.EB1)', () => {
  const ns = upgradeNextSteps({ verdict: 'insufficient-data', pairs: 7 }, { minPairs: 8 });
  assert.equal(ns.kind, 'insufficient-data');
  assert.equal(ns.needPairs, 1);
  assert.equal(ns.minPairs, 8);
  // a settled verdict has no next-step nag
  assert.equal(upgradeNextSteps({ verdict: 'cost-opt', pairs: 12 }), null);
});

test('U8: inconclusive next step enumerates excluded case-ids + reasons + actions', () => {
  const ns = upgradeNextSteps({ verdict: 'inconclusive', exclusionPct: 14,
    excludedCases: [{ caseId: 'c9', reason: 'harness-halt' }, { caseId: 'c4', reason: 'env-noise' }] });
  assert.equal(ns.kind, 'inconclusive');
  assert.equal(ns.exclusionPct, 14);
  assert.equal(ns.excludedCases[0].action, 'add-scripted-reply');   // harness-halt remediation
  assert.equal(ns.excludedCases[1].action, 'inspect-env-noise');
});

test('U8: red list = significant regressions first, then low-confidence badges; clean skills omitted', () => {
  const red = upgradeRedlist({ skills: [
    { skill: 'ok-skill', badge: 'ok', significant: false, mean: 0.4 },
    { skill: 'ref-skill', badge: 'reference-only', significant: false, mean: 0.1 },
    { skill: 'bad-skill', badge: 'ok', significant: true, mean: -1.2, significantBadge: 'significant' },
  ] });
  assert.equal(red.length, 2);              // ok-skill dropped
  assert.equal(red[0].skill, 'bad-skill');  // regressions rank first
  assert.equal(red[0].flag, 'regressed');
  assert.equal(red[1].flag, 'low-confidence');
});

test('U8: L1/L2/L3 outcome enums have the plain-Chinese gloss (S1 de-jargon map)', () => {
  assert.deepEqual(UPGRADE_ENUM_GLOSS, {
    'ok': 'o.gloss.ok', 'wrong-route': 'o.gloss.wrong-route', 'executed-after-confirm': 'o.gloss.executed-after-confirm',
    'asked-and-halted': 'o.gloss.asked-and-halted', 'flow-incomplete': 'o.gloss.flow-incomplete', 'permission-artifact': 'o.gloss.permission-artifact',
  });
  assert.equal(upgradeEnumGloss('flow-incomplete'), 'o.gloss.flow-incomplete');
  assert.equal(upgradeEnumGloss('unknown-token'), 'unknown-token'); // unmapped → passthrough, never throws
});

test('U8: dashboard de-jargons visible enum/seed/arm text; keeps raw enum in tooltip', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  // no raw English outcome enum leaks as a visible i18n VALUE (tooltip literal is fine)
  assert.doesNotMatch(html, /'upg\.flowInc':\s*'flow-incomplete'/);
  assert.match(html, /'upg\.flowInc':\s*'确认后中断'/);                      // zh gloss matches the map
  assert.match(html, /statTip\(t\('upg\.flowInc'\), 'flow-incomplete'\)/);   // raw enum retained in tooltip
  // the jargon word 臂 (arm) is gone from every visible string; seed= is gone from the version panel
  assert.doesNotMatch(html, /臂/);
  assert.doesNotMatch(html, /seed=\$\{cfg\.bootstrapSeed/);
  // zero-change axis reads as "— 持平"/"— unchanged", not a signed +0
  assert.match(html, /'upg\.flat':\s*'— 持平'/);
  assert.match(html, /'upg\.flat':\s*'— unchanged'/);
  assert.match(html, /delta === 0 \? t\('upg\.flat'\)/);
});

test('U8 round-2: intent badge zh-localized (enum→tooltip); bare MIN_PAIRS→可信下限; zero delta→持平', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  // (1) intent enum → plain zh label, raw enum kept for AI cross-reference
  assert.match(html, /'intent\.cost-opt':\s*'省成本'/);
  assert.match(html, /'intent\.quality-fix':\s*'修质量'/);
  assert.match(html, /'intent\.neutral-refactor':\s*'中性重构'/);
  assert.match(html, /function intentBadge\(intent\)/);
  assert.match(html, /intentBadge\(u\.intent\)/);   // list cell
  assert.match(html, /intentBadge\(v\.intent\)/);   // detail banner
  // (2) no bare "MIN_PAIRS" variable name leaks into visible zh text; label is 可信下限, raw name in tooltip
  assert.match(html, /'upg\.minPairsLabel':\s*'可信下限'/);
  assert.match(html, /statTip\(t\('upg\.minPairsLabel'\)/);          // version quad uses the label
  assert.doesNotMatch(html, /statTip\('MIN_PAIRS=' \+/);            // the old bare literal is gone
  assert.match(html, /'upg\.needPairs':\s*'还需 \{n\} 条配对才能达到可信下限 \{m\}'/); // zh next-step de-jargoned
  assert.match(html, /'tip\.upg\.minPairs':\s*'MIN_PAIRS =/);        // original name retained in tooltip
  // (2b) engine reason strings also de-jargon the bare MIN_PAIRS token at display time
  assert.match(html, /function reasonHtml\(r\)/);
  assert.match(html, /\\bMIN_PAIRS\\b/);                      // word-boundary swap (leaves MIN_PAIRS_SKILL)
  assert.match(html, /v\.reasons\.map\(r => `<li>\$\{reasonHtml\(r\)\}/);
  // (3) zero-change axis still reads "— 持平" (recheck from round 1)
  assert.match(html, /delta === 0 \? t\('upg\.flat'\)/);
});

test('U8 round-3 (N1): list headers 改动性质/采用范围; arm+bundle enums zh-localized with raw in tooltip', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  // headers: zh de-jargoned, en keeps intent/cohort
  assert.match(html, /'th\.intent':\s*'改动性质'/);
  assert.match(html, /'upg\.cohort':\s*'采用范围'/);
  assert.match(html, /'th\.intent':\s*'intent'/);      // en unchanged
  assert.match(html, /'upg\.cohort':\s*'cohort'/);     // en unchanged
  // cell enum map (mixed-bundle / old-full / new-full → zh), enumLabel helper keeps the raw enum in a tooltip
  assert.match(html, /'upg\.enum\.mixed-bundle':\s*'混搭包'/);
  assert.match(html, /'upg\.enum\.old-full':\s*'旧版整包'/);
  assert.match(html, /'upg\.enum\.new-full':\s*'新版整包'/);
  assert.match(html, /function enumLabel\(value\)/);
  assert.match(html, /statTip\(label, value\)/);        // zh label + raw enum tooltip
  // enumLabel is actually applied to the arm cells + the mixed-bundle badge (list + detail)
  assert.match(html, /enumLabel\(u\.arms\.new\)/);
  assert.match(html, /enumLabel\(v\.arms\?\.new\?\.label\)/);
  assert.match(html, /enumLabel\('mixed-bundle'\)/);
  assert.match(html, /enumLabel\(v\.header\.baselineArm\.label\)/);
});

test('U8: dashboard wires plain-language tooltips onto the statistical terms + de-jargons the note', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  // the native-title tooltip mechanism exists (dotted-underline term, zero-dep)
  assert.match(html, /\.statterm\s*\{[^}]*dotted/);          // CSS: dotted underline
  assert.match(html, /function statTip\(labelHtml, tip\)/);   // helper builds title=... span
  // all four stat-term tooltip strings are defined in BOTH languages, worded like the U7 report
  for (const key of ['tip.upg.pairs', 'tip.upg.minPairs', 'tip.upg.exclusion', 'tip.upg.referenceOnly']) {
    const occurrences = html.split(`'${key}'`).length - 1;
    assert.ok(occurrences >= 2, `${key} present in both langs (found ${occurrences})`);
  }
  // the copy matches what the lead specified
  assert.match(html, /新旧两版都跑过的题目数/);          // n paired
  assert.match(html, /可信结论最低配对数/);              // MIN_PAIRS
  assert.match(html, /环境问题剔除占比，超 12%/);        // exclusion rate
  assert.match(html, /5-7 条样本的 CI 较粗糙/);          // reference-only
  // the terms actually carry a tooltip where they render (pairs / exclusion / MIN_PAIRS / n=)
  assert.match(html, /statTip\(t\('th\.pairs'\), t\('tip\.upg\.pairs'\)\)/);         // list header
  assert.match(html, /statTip\(t\('upg\.exclusionPct'\)/);                            // detail meta
  assert.match(html, /statTip\(t\('upg\.minPairsLabel'\)/);                           // version quad (label carries the tooltip)
  assert.match(html, /statTip\(`<span style="opacity:\.7">n=/);                       // axis n
  // "adoption certificate" jargon is de-jargoned to plain language in the rendered note
  assert.match(html, /单个 skill 的诊断不是采用凭证/);
  assert.match(html, /采用由你决定/);
  assert.doesNotMatch(html, /v\.perSkillNote/); // the raw English report note is no longer rendered
});

test('U8: buildUpgradeView assembles banner + 3-axis cards + version quad, honours report MIN_PAIRS', () => {
  const report = {
    compareId: 'x', createdAt: '2026-07-09T00:00:00Z', intent: 'cost-opt',
    verdict: 'insufficient-data', established: false, pairs: 6, exclusionPct: 2,
    arms: { new: { label: 'new-full' }, old: { label: 'old-full' } },
    axes: {
      quality: { l1: { deltaPp: 1, ci: { lo: -1, hi: 3 }, n: 6 }, l3: { deltaPp: 0, ci: { lo: -2, hi: 2 }, n: 6, heuristic: true } },
      cost: { turns: { delta: -1, ci: { lo: -2, hi: 0 }, n: 6, significantDown: false } },
      flowIncomplete: { rateNew: 0, rateOld: 0, regressed: false },
    },
    perSkill: { skills: [{ skill: 's', badge: 'insufficient-data', significant: false, mean: 0 }], note: 'not a cert' },
    footer: { config: { MIN_PAIRS: 10 } },
  };
  const v = buildUpgradeView(report);
  assert.equal(v.verdict, 'insufficient-data');
  assert.equal(v.glyph, '∅');
  assert.equal(v.adoptable, false);
  assert.deepEqual(v.recommendation, { decidable: false, recommended: null }); // undecidable, not `false`
  assert.equal(v.qualityAxes.length, 2);          // l1 + l3 present, l2 absent → skipped
  assert.equal(v.qualityAxes.find(a => a.key === 'l3').heuristic, true);
  assert.equal(v.costAxes.length, 1);
  assert.equal(v.perSkillRedlist.length, 1);      // insufficient-data badge → low-confidence
  assert.equal(v.nextSteps.kind, 'insufficient-data');
  assert.equal(v.nextSteps.needPairs, 4);         // 10 − 6, from the report's own footer config
});

test('U8: buildUpgradeView flags L1 naRouting when an arm has no skill substrate (external runtime)', () => {
  const mk = (l1) => ({
    verdict: 'neutral-refactor', established: true, pairs: 10, exclusionPct: 0,
    arms: { new: { label: 'okx' }, old: { label: 'cc' } },
    axes: { quality: { l1, l2: { deltaPp: 0, ci: { lo: -1, hi: 1 }, n: 10 } }, cost: {}, flowIncomplete: { rateNew: 0, rateOld: 0 } },
    perSkill: { skills: [] }, footer: { config: { MIN_PAIRS: 8 } },
  });
  // external arm: passNew n/a + routingApplicable.new false → naRouting true
  const ext = buildUpgradeView(mk({ deltaPp: null, ci: { lo: null, hi: null }, n: 0, passOld: 1, passNew: null, routingApplicable: { old: true, new: false } }));
  assert.equal(ext.qualityAxes.find(a => a.key === 'l1').naRouting, true);
  // both arms have skills → applicable both sides → not naRouting even if L2-only data
  const normal = buildUpgradeView(mk({ deltaPp: 2, ci: { lo: 0, hi: 4 }, n: 10, routingApplicable: { old: true, new: true } }));
  assert.equal(normal.qualityAxes.find(a => a.key === 'l1').naRouting, false);
  // legacy report with no routingApplicable field → naRouting stays false (back-compat)
  const legacy = buildUpgradeView(mk({ deltaPp: 2, ci: { lo: 0, hi: 4 }, n: 10 }));
  assert.equal(legacy.qualityAxes.find(a => a.key === 'l1').naRouting, false);
});

// ---- experiment statistics card (design §2.3/§2.4) — three-state + block-status badges ---------

test('EXP: three-state — no stats key = legacy (backfill hint), stats present = full', () => {
  assert.equal(expStatsState({}), EXP_STATS_STATE.LEGACY);
  assert.equal(expStatsState({ stats: EXP_STATS }), EXP_STATS_STATE.FULL);
  const legacy = buildExpStatsCard({ id: 'old-exp' });
  assert.equal(legacy.state, 'legacy');
  assert.equal(legacy.backfillHint, 'o.stats.backfillHint');
});

test('EXP: block status renders as a WORD badge, never a ratio; four honest states covered', () => {
  assert.deepEqual(blockStatusBadge('insufficient-data'), { word: 'o.status.insufficient-data', tone: 'dim' });
  assert.deepEqual(blockStatusBadge('unavailable'), { word: 'o.status.unavailable', tone: 'dim' });
  assert.deepEqual(blockStatusBadge('suspect'), { word: 'o.status.suspect', tone: 'warn' });
  assert.deepEqual(blockStatusBadge('held-out-unknown'), { word: 'o.status.held-out-unknown', tone: 'warn' });
  assert.equal(blockStatusBadge('some-future-status').word, 'some-future-status');   // passthrough, never throws
});

test('EXP M1: coverage ratio + neverTriggered vs notExercised carry DIFFERENT plain meanings', () => {
  const v = expSkillCoverageView(EXP_STATS);
  assert.equal(v.installed, 4);
  assert.equal(v.triggered, 2);            // swap + price triggered
  assert.equal(v.coverageRatio, 0.5);
  assert.deepEqual(v.neverTriggered.skills, ['onchain.bridge']);
  assert.equal(v.neverTriggered.hint, 'o.cov.neverTriggered.hint');
  assert.deepEqual(v.notExercised.skills, ['onchain.safety']);
  assert.equal(v.notExercised.hint, 'o.cov.notExercised.hint');
  // null-not-zero: no installed skills → ratio null, not 0
  assert.equal(expSkillCoverageView({ skillCoverage: { installed: [], everTriggered: [] } }).coverageRatio, null);
});

test('EXP M2: unread refs flagged only after the three exemption buckets are surfaced', () => {
  const v = expRefCoverageView(EXP_STATS);
  assert.equal(v.shipped, 8);   // v2 fixture: swap 多带一个 perm-blocked ref（refs[] 的 blocked:true 素材）
  assert.equal(v.read, 3);
  // dead-weight candidates (already exemption-cleared by the engine)
  assert.deepEqual(v.unreadRefs.map((u) => u.ref).sort(), ['onchain.price/references/venues.md', 'onchain.swap/references/slippage.md']);
  // three exemption buckets, each with a plain-language hint
  assert.deepEqual(v.exemptions.artifactOnly.refs, ['onchain.swap/references/perm-blocked.md']);
  assert.deepEqual(v.exemptions.excludedOnly.refs, ['onchain.price/references/excluded-only.md']);
  assert.deepEqual(v.exemptions.notExercised.skills, ['onchain.bridge']);   // bridge never triggered
  assert.equal(v.exemptions.artifactOnly.hint, 'o.cov.exempt.artifactOnly.hint');
});

test('EXP: probe three-state — null = 未配置探针; array = per-tool coverage + hypothesis sequences', () => {
  assert.deepEqual(expProbeView({ probes: null }), { configured: false, tools: [] });
  const v = expProbeView(EXP_STATS);
  assert.equal(v.configured, true);
  assert.equal(v.tools[0].tool, 'onchainos');
  assert.deepEqual(v.tools[0].coverage.unused, ['balance']);                  // declared-never-invoked
  assert.deepEqual(v.tools[0].coverage.undeclaredInvoked, ['order cancel']);  // surface-drift
  assert.equal(v.tools[0].coverageStatus.word, 'o.status.ok');
  assert.equal(v.tools[0].sequences[0].hypothesis, true);                     // always a hypothesis
  assert.equal(v.tools[0].sequences[0].distinctCases, 4);
});

test('EXP M7: proximity summary is top-k directed edges (时序邻近，非因果)', () => {
  const v = expProximityView(EXP_STATS);
  assert.equal(v.n, 6);
  assert.equal(v.topEdges[0].from.id, 'price get');     // highest confidence first
  assert.equal(v.topEdges[0].confidence, 1);
  assert.equal(expProximityView({ proximity: { edges: [], n: 0 } }), null);
});

test('EXP: full card spells out nCoverageValid ≠ scorecard n + sample-size breakdown', () => {
  const card = buildExpStatsCard({ stats: EXP_STATS });
  assert.equal(card.state, 'full');
  assert.equal(card.sampleSize.nCoverageValid, 13);
  assert.deepEqual(card.sampleSize.breakdown, { valid: 13, excluded: 2, heldOut: 2, noSession: 1, unresolved: 1 });
  assert.equal(card.sampleSize.note, 'o.stats.nCoverageNote');
  assert.ok(card.skillCoverage && card.refCoverage && card.probes && card.proximity);
});

// ---- upgrade view: external-tool probe-signal block (design §2.4) ------------------------------

test('probe block: null report.probes → no block; a real block carries per-arm absolutes + hypothesis seqs', () => {
  assert.equal(buildProbeBlockView(null), null);
  const cli = probeBlocksToReport(CLI_BLOCKS);
  const v = buildProbeBlockView(cli);
  assert.equal(v.status, 'ok');
  assert.equal(v.tripwired, false);
  assert.equal(v.arms.length, 2);
  assert.equal(v.arms[0].tools[0].coverageStatus.word, 'o.status.ok');
  assert.ok(v.arms[0].proximityTop.length >= 1);
  // sequence cards are always hypotheses, flattened with their arm
  assert.ok(v.sequences.length >= 1 && v.sequences.every((s) => s.hypothesis === true));
  // excluded-probe-hit surfaced as a warning (F1 — a dropped run that hammered the tool stays visible)
  assert.equal(v.warnings[0].kind, 'excluded-probe-hit');
  assert.equal(v.warnings[0].caseId, 'swap-excl-001');
});

test('probe block: paired.tripwired forces status inconclusive but keeps per-arm absolutes', () => {
  const tripped = { ...CLI_BLOCKS, paired: { cases: 4, exclusionPct: 20, tripwired: true } };
  const v = buildProbeBlockView(probeBlocksToReport(tripped));
  assert.equal(v.status, 'inconclusive');
  assert.equal(v.tripwired, true);
  assert.equal(v.arms.length, 2);                       // absolutes still present
  assert.ok(v.arms[0].tools[0].coverage);
});

test('probe block: differing declared command surface across arms → per-tool not-comparable', () => {
  const skewed = {
    ...CLI_BLOCKS,
    byArm: [
      { arm: 'old', probes: [{ tool: 'onchainos', coverage: { declared: 3, ratio: 0.5, invoked: ['a', 'b'] }, bySkill: [], sequences: [] }], proximity: { edges: [], n: 0 } },
      { arm: 'new', probes: [{ tool: 'onchainos', coverage: { declared: 5, ratio: 0.4, invoked: ['a', 'b'] }, bySkill: [], sequences: [] }], proximity: { edges: [], n: 0 } },
    ],
  };
  const v = buildProbeBlockView(probeBlocksToReport(skewed));
  assert.equal(v.notComparable[0].tool, 'onchainos');
  assert.equal(v.notComparable[0].reason, 'command-surface-differs');
  assert.equal(v.deltas[0].comparable, false);
});

// ---- stats visibility pipeline (design A3 + B1 + B6) --------------------------------------------

test('EXP A3: three-state machine — statsAuthority drives FULL; stats:{error} is ERROR, never FULL', () => {
  // resolver said usable (any authority) → FULL, even for a sidecar backfill
  assert.equal(expStatsState({ statsAuthority: 'embedded', stats: EXP_STATS }), EXP_STATS_STATE.FULL);
  assert.equal(expStatsState({ statsAuthority: 'recomputed-no-embedded', stats: EXP_STATS }), EXP_STATS_STATE.FULL);
  // seal-time failure → ERROR (both the raw embedded {error} shape and the resolver's statsError)
  assert.equal(expStatsState({ stats: { error: 'boom' } }), EXP_STATS_STATE.ERROR);
  assert.equal(expStatsState({ stats: null, statsError: 'boom' }), EXP_STATS_STATE.ERROR);
  // ERROR card carries the failure string for the 统计计算失败 line — no full card over an empty shape
  const card = buildExpStatsCard({ stats: { error: 'boom' } });
  assert.equal(card.state, 'error');
  assert.equal(card.error, 'boom');
  assert.equal(card.skillCoverage, undefined);
});

test('EXP A3: authority badge — embedded 权威, sidecar 回填(非权威); wrapper warnings + sidecarIgnored on the card', () => {
  assert.deepEqual(statsAuthorityBadge('embedded'), { word: 'o.auth.embedded', tone: 'ok' });
  assert.deepEqual(statsAuthorityBadge('authoritative-embedded'), { word: 'o.auth.embedded', tone: 'ok' });
  assert.deepEqual(statsAuthorityBadge('non-authoritative-recompute'), { word: 'o.auth.backfill', tone: 'warn' });
  assert.deepEqual(statsAuthorityBadge('recomputed-no-embedded'), { word: 'o.auth.backfill', tone: 'warn' });
  assert.equal(statsAuthorityBadge(null), null);   // no resolver ran → no badge, not a fake one
  const card = buildExpStatsCard({
    stats: EXP_STATS, statsAuthority: 'recomputed-no-embedded',
    statsWarnings: ['1 rep(s) unresolved'], sidecarIgnored: false,
  });
  assert.equal(card.state, 'full');
  assert.equal(card.authority, 'recomputed-no-embedded');
  assert.equal(card.authorityBadge.word, 'o.auth.backfill');
  assert.deepEqual(card.warnings, ['1 rep(s) unresolved']);   // wrapper warnings 原文透传
  const ign = buildExpStatsCard({ stats: EXP_STATS, statsAuthority: 'embedded', sidecarIgnored: true });
  assert.equal(ign.sidecarIgnored, true);                     // → 存在被忽略的重算 sidecar 资讯注记
});

test('EXP B1 null-guard: bySkill=null renders the reason, NEVER 读到 0/0; []=knowable-and-empty stays normal', () => {
  const base = { readCounts: {}, artifactOnlyRefs: [], excludedOnlyRefs: [] };
  // external-runtime: self-managed skills → unknowable
  const ext = expRefCoverageView({ refCoverage: { ...base, inventoryStatus: 'external-runtime', bySkill: null, reason: 'external-runtime-self-managed' } });
  assert.equal(ext.unknown, true);
  assert.equal(ext.reason, 'external-runtime-self-managed');
  assert.equal(ext.shipped, null);   // null-not-zero: no 0/0 to render
  assert.equal(ext.read, null);
  // the other null reason passes through the same guard
  const noSnap = expRefCoverageView({ refCoverage: { ...base, bySkill: null, reason: 'no-inventory-snapshot' } });
  assert.equal(noSnap.unknown, true);
  assert.equal(noSnap.reason, 'no-inventory-snapshot');
  // none-backfill: bySkill is an ARRAY but shipped:null per row → aggregate denominator null, read stays known
  const backfill = expRefCoverageView({ refCoverage: { ...base, inventoryStatus: 'none-backfill', reason: 'no-inventory-snapshot',
    bySkill: [{ skill: 's1', versionSha: null, shipped: null, read: 2, unreadRefs: null, notExercised: false, refs: [] }] } });
  assert.equal(backfill.unknown, false);
  assert.equal(backfill.shipped, null);
  assert.equal(backfill.read, 2);
  // [] = knowable and empty → normal path with honest zeros (denominator 0 renders as — downstream)
  const empty = expRefCoverageView({ refCoverage: { ...base, inventoryStatus: 'snapshot', bySkill: [] } });
  assert.equal(empty.unknown, false);
  assert.equal(empty.shipped, 0);
  // none-backfill + bySkill=[]（纯 _shared 读取，无可反推行）：every() 空真不得把分母折成 0；
  // 观测到的 _shared 读取计入分子并单独计数（live regression 2026-07-12：曾渲染成 读到 0/0）
  const sharedOnly = expRefCoverageView({ refCoverage: { ...base, inventoryStatus: 'none-backfill', reason: 'no-inventory-snapshot',
    bySkill: [], readCounts: { '_shared/a.md#f1': { runs: 9, cases: 3 }, '_shared/b.md#f2': { runs: 3, cases: 2 } } } });
  assert.equal(sharedOnly.unknown, false);
  assert.equal(sharedOnly.shipped, null);
  assert.equal(sharedOnly.read, 2);
  assert.equal(sharedOnly.sharedReads, 2);
});

test('EXP B1: per-skill refs rows — bytes, readsCases, readRateCoTriggered as x/y, blocked badge data', () => {
  const rows = expSkillDetailRows(EXP_STATS);
  assert.deepEqual(rows.map(r => r.skill), ['onchain.bridge', 'onchain.price', 'onchain.swap']);
  const swap = rows.find(r => r.skill === 'onchain.swap');
  assert.deepEqual(swap.trigger, { triggered: 6, attempted: 7 });
  assert.equal(swap.refs.length, 4);
  const dex = swap.refs.find(r => r.ref === 'onchain.swap/references/dex.md');
  assert.equal(dex.bytes, 2048);
  assert.equal(dex.readsCases, 5);
  assert.deepEqual(dex.readRateCoTriggered, { x: 5, y: 6 });   // casesCoTriggered / everTriggered cases
  assert.equal(dex.blocked, false);
  const blocked = swap.refs.find(r => r.ref === 'onchain.swap/references/perm-blocked.md');
  assert.equal(blocked.blocked, true);                         // → 读取被权限拦截 badge, never a rendered 0
  // never-triggered skill → denominator 0 (renders as x/—), subset property x ≤ y everywhere
  const bridge = rows.find(r => r.skill === 'onchain.bridge');
  assert.equal(bridge.refs[0].readRateCoTriggered.y, 0);
  for (const r of rows) for (const ref of r.refs ?? []) assert.ok(ref.readRateCoTriggered.x <= Math.max(ref.readRateCoTriggered.y, ref.readRateCoTriggered.x));
});

test('EXP B6: miss list three states — fired-instead array, null=无 session 可判, partial-trigger empty note', () => {
  const rows = expSkillDetailRows(EXP_STATS);
  // (1) real miss with a knowable culprit
  const price = rows.find(r => r.skill === 'onchain.price');
  assert.deepEqual(price.misses, [{ caseId: 'price-004', firedInstead: ['onchain.swap'] }]);
  // (2) noSession-only miss → firedInstead null (不可知)
  const bridge = rows.find(r => r.skill === 'onchain.bridge');
  assert.deepEqual(bridge.misses, [{ caseId: 'bridge-001', firedInstead: null }]);
  // (3) rate<1 but NO triggered=0 case (swap-006 is a rep-level partial) → explicit note, no silent empty
  const swap = rows.find(r => r.skill === 'onchain.swap');
  assert.equal(swap.misses, null);
  assert.equal(swap.missNote, 'partial-trigger-only');
  // a fully-triggered skill gets neither
  const full = expSkillDetailRows({ schemaVersion: 2, skillCoverage: {
    everTriggered: [{ skill: 's', cases: 2 }], triggerRate: [{ skill: 's', triggered: 2, attempted: 2 }],
    caseJoin: { s: { cases: [{ caseId: 'c1', attempted: 1, triggered: 1 }, { caseId: 'c2', attempted: 1, triggered: 1 }] } },
  }, refCoverage: { bySkill: [] } });
  assert.equal(full[0].misses, null);
  assert.equal(full[0].missNote, null);
});

test('EXP §S: v1 embedded stats (no caseJoin/refs) → 旧 schema upgrade hint, no per-skill rows', () => {
  const v1 = {
    nRaw: 3, nCoverageValid: 3,
    skillCoverage: { installed: ['a'], everTriggered: [], triggerRate: [{ skill: 'a', triggered: 0, attempted: 3 }], neverTriggered: ['a'], notExercised: [] },
    refCoverage: { bySkill: [], readCounts: {}, artifactOnlyRefs: [], excludedOnlyRefs: [] },
    probes: null, proximity: { edges: [], n: 0 },
  }; // no schemaVersion → v1
  const card = buildExpStatsCard({ id: 'exp-old', stats: v1, statsAuthority: 'embedded' });
  assert.equal(card.state, 'full');
  assert.equal(card.legacySchema, true);
  // taxonomy §3.0 真路徑 (r4 F-4-03): the hint names the REAL supplemental pipeline — plain --write
  // recomputes a non-authoritative sidecar whose NEW sections ride alongside the sealed numbers.
  assert.deepEqual(card.upgradeHint, { key: 'o.stats.upgradeHint', v: 1, id: 'exp-old' });
  assert.deepEqual(card.skillDetails, []);
  // v2 is stale against the v3 closed set → same real-path hint with its own version
  assert.deepEqual(buildExpStatsCard({ id: 'exp-v2', stats: EXP_STATS }).upgradeHint,
    { key: 'o.stats.upgradeHint', v: 2, id: 'exp-v2' });
  // current schema → no hint
  assert.equal(buildExpStatsCard({ stats: { ...EXP_STATS, schemaVersion: 3 } }).upgradeHint, null);
});

test('EXP supplemental (taxonomy §3.0): own badge + own sections channel, NEVER merged into the authoritative card views', () => {
  const supplemental = {
    sections: { toolUsage: { totalCalls: 7 }, statsHealth: { parseWarnings: 0 }, contextComposition: null },
    authority: 'non-authoritative-recompute', schemaVersionFrom: 2, schemaVersionTo: 3,
  };
  const card = buildExpStatsCard({ id: 'e1', stats: EXP_STATS, statsAuthority: 'embedded', sidecarIgnored: true, supplemental });
  // supplemental channel: verbatim sections + the NON-authoritative badge (existing 回填 style)
  assert.deepEqual(card.supplementalSections, supplemental.sections);
  assert.deepEqual(card.supplementalBadge, { word: 'o.auth.backfill', tone: 'warn' });
  assert.deepEqual(card.supplementalSchema, { from: 2, to: 3 });
  // the authoritative channel keeps its OWN badge/schema — never the supplemental's
  assert.deepEqual(card.authorityBadge, { word: 'o.auth.embedded', tone: 'ok' });
  assert.equal(card.schemaVersion, 2);
  assert.equal(card.sidecarIgnored, true);          // coexists: authoritative numbers ignored the sidecar
  // supplemental already on screen → the backfill hint would be stale advice → suppressed
  assert.equal(card.upgradeHint, null);
  // no supplemental → channel fields are null, never fabricated
  const plain = buildExpStatsCard({ id: 'e1', stats: EXP_STATS, statsAuthority: 'embedded' });
  assert.equal(plain.supplementalSections, null);
  assert.equal(plain.supplementalBadge, null);
  assert.equal(plain.supplementalSchema, null);
});

test('EXP: CURRENT_STATS_SCHEMA_VERSION mirrors src/expstats.js STATS_SCHEMA_VERSION (obs.js cannot import src — pinned here)', async () => {
  const { STATS_SCHEMA_VERSION } = await import('../src/expstats.js');
  assert.equal(CURRENT_STATS_SCHEMA_VERSION, STATS_SCHEMA_VERSION);
});

// ---- adapter observability Stage 4 (design §3 consumer matrix: web/obs.js + web/index.html) ----

test('EXP Stage4: adapter-declared → 可知分母 (shippedKnown), no _shared bucket, 清单外自报读取 counted separately', () => {
  const base = { artifactOnlyRefs: [], excludedOnlyRefs: [], refMeta: null };
  const v = expRefCoverageView({ refCoverage: { ...base, inventoryStatus: 'adapter-declared',
    bySkill: [{ skill: 's1', versionSha: null, shipped: 2, read: 1, unreadRefs: ['s1/references/b.md'], notExercised: false,
      refs: [
        { ref: 's1/references/a.md', bytes: null, reason: 'adapter-declared', readsCases: 1, casesCoTriggered: 1 },
        { ref: 's1/references/b.md', bytes: null, reason: 'adapter-declared', readsCases: 0, casesCoTriggered: 0 },
      ] }],
    // extra.md is a plaintext ref on NO inventory row; declared regime has NO _shared semantics
    // (F-2-13) so the _shared-looking key is just another out-of-inventory read, never sharedReads
    readCounts: { 's1/references/a.md': { runs: 2, cases: 1 }, 's1/references/extra.md': { runs: 1, cases: 1 }, '_shared/x.md#h': { runs: 1, cases: 1 } },
  } });
  assert.equal(v.unknown, false);
  assert.equal(v.inventoryStatus, 'adapter-declared');
  assert.equal(v.shipped, 2);              // declared list IS a knowable denominator (F-2-23)
  assert.equal(v.read, 1);                 // rows only — no _shared bucket under 宣告制
  assert.equal(v.sharedReads, 0);          // adapter-declared never enters the 清单不可知 shared path
  assert.equal(v.outOfInventoryReads, 2);  // extra.md + _shared/x.md#h sit outside the declared list
  assert.deepEqual(v.unreadRefs, [{ ref: 's1/references/b.md', skill: 's1' }]); // dead-weight logic unchanged
});

test('EXP Stage4: non-declared statuses keep outOfInventoryReads honest (0 normal path, null unknowable path)', () => {
  const base = { readCounts: { '_shared/a.md#f1': { runs: 1 } }, artifactOnlyRefs: [], excludedOnlyRefs: [] };
  // snapshot → concept vacuous, 0 (fixture regression: snapshot behavior otherwise untouched)
  assert.equal(expRefCoverageView(EXP_STATS).outOfInventoryReads, 0);
  // none-backfill (sharedOnly regression): _shared stays in sharedReads, NOT out-of-inventory
  const backfill = expRefCoverageView({ refCoverage: { ...base, inventoryStatus: 'none-backfill', reason: 'no-inventory-snapshot', bySkill: [] } });
  assert.equal(backfill.sharedReads, 1);
  assert.equal(backfill.outOfInventoryReads, 0);
  assert.equal(backfill.shipped, null);    // 清单不可知 denominator stays null
  // bySkill=null (external-runtime) → no inventory exists → out-of-inventory is unknowable, null not 0
  const ext = expRefCoverageView({ refCoverage: { ...base, inventoryStatus: 'external-runtime', bySkill: null, reason: 'external-runtime-self-managed' } });
  assert.equal(ext.outOfInventoryReads, null);
});

test('EXP Stage4: refsNote adapter-declared — triggered skill absent from the declared list is explained, not blank', () => {
  const rows = expSkillDetailRows({ schemaVersion: 2,
    skillCoverage: {
      everTriggered: [{ skill: 'ghost', cases: 1 }],
      triggerRate: [{ skill: 'ghost', triggered: 1, attempted: 1 }], caseJoin: {},
    },
    refCoverage: { inventoryStatus: 'adapter-declared',
      bySkill: [{ skill: 'listed', shipped: 1, read: 0, unreadRefs: [], notExercised: true,
        refs: [{ ref: 'listed/references/a.md', bytes: null, reason: 'adapter-declared', readsCases: 0, casesCoTriggered: 0 }] }],
      readCounts: {} },
  });
  const ghost = rows.find((r) => r.skill === 'ghost');
  assert.equal(ghost.refs, null);
  assert.equal(ghost.refsNote, 'adapter-declared');   // no more double-null blank row
  // a skill ON the declared list keeps its rows: bytes null + row-level reason passthrough (F-2-22)
  const listed = rows.find((r) => r.skill === 'listed');
  assert.equal(listed.refsNote, null);
  assert.equal(listed.refs.length, 1);
  assert.equal(listed.refs[0].bytes, null);
  assert.equal(listed.refs[0].reason, 'adapter-declared');
});

test('EXP Stage4: provenance badge — adapter-reported → badge data; harness-observed/null → no badge (never fabricated)', () => {
  assert.deepEqual(statsProvenanceBadge('adapter-reported'), { word: 'o.prov.adapter-reported', tone: 'warn' });
  assert.equal(statsProvenanceBadge('harness-observed'), null);
  assert.equal(statsProvenanceBadge(null), null);
  assert.equal(statsProvenanceBadge(undefined), null);
  const card = buildExpStatsCard({ stats: { ...EXP_STATS, provenance: 'adapter-reported' } });
  assert.equal(card.provenance, 'adapter-reported');
  assert.equal(card.provenanceBadge.word, 'o.prov.adapter-reported');
  assert.equal(card.provenanceBadge.tone, 'warn');
  // fixture carries no provenance → null passthrough, no badge
  const plain = buildExpStatsCard({ stats: EXP_STATS });
  assert.equal(plain.provenance, null);
  assert.equal(plain.provenanceBadge, null);
});

test('EXP Stage4: dashboard carries the adapter-declared / provenance zh copy + timeline 自报 badge', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  // coverage panel: four-state denominator copy — adapter-declared badge next to 读到 x/y
  assert.match(html, /清单由 adapter 自报（未经 harness 快照核验）/);
  // out-of-inventory reads line renders only when k>0 (declaredInv && rc.outOfInventoryReads)
  assert.match(html, /笔清单外读取（自报）/);
  assert.match(html, /declaredInv && rc\.outOfInventoryReads/);
  // provenance badge is rendered from the view-model (word lives in obs.js, not duplicated here)
  assert.match(html, /stCard\.provenanceBadge/);
  // per-skill row: adapter-declared refsNote copy + bytes-null tooltip without the shared-hash 误导文案
  assert.match(html, /该 skill 不在自报清单内，无参考文档行可核对/);
  assert.match(html, /字节数不可知（内部名 adapter-declared）/);
  // run timeline: rounds carrying declared signals get the 自报 badge
  assert.match(html, /r\.declaredTriggers\?\.length \|\| r\.declaredRefReads\?\.length/);
  assert.match(html, /本轮含 adapter 自报信号（declaredTriggers\/declaredRefReads）/);
  assert.match(html, />自报<\/span>/);
});

test('EXP: dashboard panel carries the new zh copy (error state, ignored sidecar, blocked ref, miss states)', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  assert.match(html, /统计计算失败：/);                          // A3 ERROR state line
  assert.match(html, /存在被忽略的重算 sidecar（CLI 诊断用）/);   // sidecarIgnored info note
  assert.match(html, /读取被权限拦截/);                          // blocked ref badge (never a rendered 0)
  assert.match(html, /无 session 可判/);                         // firedInstead null
  assert.match(html, /miss 均为部分触发（同题其他 rep 已命中），无整题落空/); // B6 empty state
  assert.match(html, /data-persist="expstats-skill"/);           // existing folding pattern, no new events
  assert.match(html, /外部运行时自管（external-runtime-self-managed）/);
  assert.match(html, /（no-inventory-snapshot）/);
  assert.match(html, /触发率（triggerRate）/);                    // 白话主句 + canonical term discipline
});

// ---- taxonomy T1 Stage 6: v3 section view models + 运行观测/运行健康 cards ----------------------

// Realistic section fixtures mirroring the src/expstats.js compute* output shapes exactly.
const CC_SECTION = {
  estimate: true, n: 4, untaggedLegacyRuns: 1, zeroFootprintRuns: 1, skippedRounds: 2,
  shares: {
    baseline: { mean: 0.42, min: 0.3, max: 0.5 },
    prevOut: { mean: 0.1, min: 0.05, max: 0.2 },
    toolRes: { mean: 0.25, min: 0.1, max: 0.4 },
    injectedUser: { mean: 0.02, min: 0, max: 0.05 },
    injectedHarness: { mean: 0.12, min: 0.08, max: 0.2 },
    skillBody: { mean: 0.05, min: 0, max: 0.1 },
    residualPos: { mean: 0.04, min: 0, max: 0.09 },
  },
  compaction: { runsWithCompaction: 1, absolute: { mean: 2100, min: 0, max: 8400 }, shareOfDenominator: { mean: 0.03, min: 0, max: 0.12 } },
  peakFootprint: { mean: 48000, min: 30000, max: 61000 },
  maxContribution: { runId: 'run-7', denominator: 92311 },
};
const TU_SECTION = {
  allowlistVersion: 'aiide-0.1.0',
  byKind: {
    skill: { main: 5, sidechain: 0 }, agent: { main: 1, sidechain: 0 }, mcp: { main: 3, sidechain: 1 },
    builtin: { main: 10, sidechain: 2 }, other: { main: 0, sidechain: 0 },
  },
  byMcpServer: { 'plugin_oki-team_oki-team': { calls: 4, errors: 1, denials: 0 } },
  scope: { main: 19, sidechain: 3 },
  kindSource: { declared: 4, inferred: 18 },
  topTools: [{ name: 'Bash', kind: 'builtin', calls: 8, errors: 1, denials: 0 }],
};
const FT_SECTION = {
  n: 3, noCwdRuns: 1,
  reads: { skillRefs: 2, workspace: 9, otherAbsolute: 1, pathless: 1 },
  writes: { skillRefs: 0, workspace: 5, otherAbsolute: 0, pathless: 0 },
};
const HEALTH_SECTIONS = {
  cacheHitRate: { n: 4, skippedRounds: 3, mean: 0.61, min: 0.2, max: 0.9, byRepeat: [{ repeat: 1, meanCacheR: 0.4, n: 2 }, { repeat: 2, meanCacheR: 0.8, n: 2 }] },
  truncation: {
    rounds: 20, unknownStopReason: 2, byReason: { end_turn: 18, max_tokens: 2 },
    truncatedRoundShare: 0.1, finalRoundTruncated: { runs: 1, n: 4, share: 0.25 }, unknownFinalRuns: 1,
  },
  sidechainShare: {
    n: 4, runsWithSidechain: 2,
    tokens: { sidechain: 1000, total: 5000, share: 0.2 },
    toolCalls: { sidechain: 3, total: 20, share: 0.15 },
    equivTokens: { sidechain: 500, total: 2000, share: 0.25 },
  },
  selfReport: { runsWithSelfReport: 3, invocations: 5, total_cost_usd: 0.123456, num_turns: 21, duration_ms: 90000, is_error: false },
  statsHealth: {
    exclusionBreakdown: { 'auth-expiry': 2 }, abortedAtStep: { 2: 1 }, parseWarningsTotal: 3,
    timeoutRate: { timedOut: 1, n: 10, rate: 0.1, legacyUnknown: 2 },
    retriedThenSucceeded: 1,
    verifierFails: [{ verifier: 'output-includes: expected text', fails: 4 }],
  },
};

test('T1S6: NULL_REASON_COPY covers the §3.0 null-trigger table verbatim; unknown reason degrades honestly', () => {
  assert.deepEqual(NULL_REASON_COPY, {
    'no-user-events-channel': 'o.nullReason.no-user-events-channel',
    'untagged-legacy-run': 'o.nullReason.untagged-legacy-run',
    'no-cwd': 'o.nullReason.no-cwd',
    'no-stop-reason': 'o.nullReason.no-stop-reason',
    'no-result-lines': 'o.nullReason.no-result-lines',
    'no-sidechain-channel': 'o.nullReason.no-sidechain-channel',
    'no-usage': 'o.nullReason.no-usage',
    'no-valid-runs': 'o.nullReason.no-valid-runs',
    'no-aggregatable-runs': 'o.nullReason.no-aggregatable-runs',
  });
  assert.equal(nullReasonCopy('some-future-reason'), 'o.nullReason.unknown'); // unknown → templated key, renderer fills {reason}
  assert.equal(nullReasonCopy(null), 'o.nullReason.unknown');
});

test('T1S6 contextCompositionView: share rows + independent compaction + disclosures; estimate always flagged', () => {
  const v = contextCompositionView(CC_SECTION);
  assert.equal(v.null, false);
  assert.equal(v.nonAuthoritative, false);
  assert.equal(v.title, 'o.ctxComp.title'); // §3.1 MANDATED title key — attribution, not cost (copy in the dict)
  assert.equal(v.estimate, true);
  // all seven buckets in the fixed order, share dist passthrough (percent + range for the renderer)
  assert.deepEqual(v.rows.map((r) => r.key),
    ['baseline', 'prevOut', 'toolRes', 'injectedUser', 'injectedHarness', 'skillBody', 'residualPos']);
  assert.deepEqual(v.rows[0].share, { mean: 0.42, min: 0.3, max: 0.5 });
  assert.equal(v.rows[1].label, 'o.ctxComp.prevOut');
  assert.equal(v.rows[4].label, 'o.ctxComp.injectedHarness');
  // compaction is an INDEPENDENT row — never one of the share buckets (§3.1: 永不净加总/入分子)
  assert.equal(v.rows.some((r) => r.key === 'compaction'), false);
  assert.equal(v.compaction.runsWithCompaction, 1);
  assert.deepEqual(v.compaction.absolute, { mean: 2100, min: 0, max: 8400 });
  assert.equal(v.compaction.label, 'o.ctxComp.compaction');
  // n / skip disclosures + peak + max-contribution run
  assert.equal(v.n, 4);
  assert.equal(v.untaggedLegacyRuns, 1);
  assert.equal(v.zeroFootprintRuns, 1);
  assert.equal(v.skippedRounds, 2);
  assert.deepEqual(v.peakFootprint, { mean: 48000, min: 30000, max: 61000 });
  assert.deepEqual(v.maxContribution, { runId: 'run-7', denominator: 92311 });
  // nonAuthoritative passthrough (supplemental-sourced section)
  assert.equal(contextCompositionView(CC_SECTION, { nonAuthoritative: true }).nonAuthoritative, true);
  // absent section (v2 embedded, no supplemental) → null: the card omits the segment entirely
  assert.equal(contextCompositionView(null), null);
  assert.equal(contextCompositionView(undefined), null);
});

test('T1S6 §3.1 copy ban: contextComposition output NEVER says 成本/花在 (incremental attribution, not a cost view)', () => {
  const BAN = /成本|花在/;
  assert.doesNotMatch(JSON.stringify(contextCompositionView(CC_SECTION)), BAN);
  assert.doesNotMatch(JSON.stringify(contextCompositionView({ value: null, reason: 'no-user-events-channel' })), BAN);
  assert.doesNotMatch(CONTEXT_COMPOSITION_TITLE, BAN);
  assert.doesNotMatch(JSON.stringify(CONTEXT_BUCKET_LABELS), BAN);
});

test('T1S6 contextCompositionView null forms: honest reason copy + disclosure passthrough, never a blank or 0', () => {
  const gated = contextCompositionView({ value: null, reason: 'no-user-events-channel' });
  assert.equal(gated.null, true);
  assert.equal(gated.reason, 'no-user-events-channel');
  assert.equal(gated.reasonCopy, 'o.nullReason.no-user-events-channel');
  const legacy = contextCompositionView({ value: null, reason: 'untagged-legacy-run', untaggedLegacyRuns: 3 }, { nonAuthoritative: true });
  assert.equal(legacy.reasonCopy, 'o.nullReason.untagged-legacy-run');
  assert.equal(legacy.disclosures.untaggedLegacyRuns, 3);  // extra nullSection counts ride through
  assert.equal(legacy.nonAuthoritative, true);
  assert.equal(contextCompositionView({ value: null, reason: 'no-aggregatable-runs' }).reasonCopy, 'o.nullReason.no-aggregatable-runs');
});

test('T1S6 toolUsageView: byKind main/sidechain split in fixed order, mcp server table, kindSource + allowlist disclosure', () => {
  const v = toolUsageView(TU_SECTION);
  assert.equal(v.null, false);
  assert.equal(v.title, TOOL_USAGE_TITLE);
  assert.deepEqual(TOOL_KIND_ORDER, ['skill', 'agent', 'mcp', 'builtin', 'other']);
  assert.deepEqual(v.byKind.map((k) => k.kind), TOOL_KIND_ORDER);
  const mcp = v.byKind.find((k) => k.kind === 'mcp');
  assert.deepEqual(mcp, { kind: 'mcp', main: 3, sidechain: 1, total: 4 });  // main/sidechain 分列
  assert.deepEqual(v.scope, { main: 19, sidechain: 3 });
  assert.equal(v.scopeNote, 'o.toolUsage.scopeNote');      // §3.2 caliber sentence on the card (copy in the dict)
  assert.deepEqual(v.kindSource, { declared: 4, inferred: 18 });
  assert.equal(v.allowlistVersion, 'aiide-0.1.0');
  assert.equal(v.allowlistNote, 'o.toolUsage.allowlistNote'); // §4 honest boundary disclosure
  assert.deepEqual(v.mcpServers, [{ server: 'plugin_oki-team_oki-team', calls: 4, errors: 1, denials: 0 }]);
  assert.equal(v.topTools[0].name, 'Bash');
  assert.equal(toolUsageView(TU_SECTION, { nonAuthoritative: true }).nonAuthoritative, true);
  // null form (no valid runs) + absent section
  const nul = toolUsageView({ value: null, reason: 'no-valid-runs' });
  assert.equal(nul.null, true);
  assert.equal(nul.reasonCopy, 'o.nullReason.no-valid-runs');
  assert.equal(toolUsageView(null), null);
});

test('T1S6 fileTargetsView: read/write三桶 + pathless disclosure outside the buckets; no-cwd null form', () => {
  const v = fileTargetsView(FT_SECTION);
  assert.equal(v.null, false);
  assert.equal(v.title, FILE_TARGETS_TITLE);
  assert.deepEqual(v.reads.rows.map((r) => r.key), ['skillRefs', 'workspace', 'otherAbsolute']);
  assert.deepEqual(v.reads.rows.map((r) => r.count), [2, 9, 1]);
  assert.equal(v.reads.pathless, 1);                       // disclosed, NOT a fourth bucket
  assert.equal(v.reads.rows.some((r) => r.key === 'pathless'), false);
  assert.deepEqual(v.writes.rows.map((r) => r.count), [0, 5, 0]);
  assert.match(v.reads.rows[0].label, /skill 参考文档（skill-refs）/);
  assert.match(v.pathlessNote, /不入三桶/);
  assert.equal(v.n, 3);
  assert.equal(v.noCwdRuns, 1);
  const nul = fileTargetsView({ value: null, reason: 'no-cwd' }, { nonAuthoritative: true });
  assert.equal(nul.null, true);
  assert.equal(nul.reasonCopy, 'o.nullReason.no-cwd');
  assert.equal(nul.nonAuthoritative, true);
  assert.equal(fileTargetsView(null), null);
});

test('T1S6 runHealthView: five segments from real sections — cache warm-up table, truncation denominators, sidechain equivTokens, selfReport Σ vs estimate, statsHealth', () => {
  const v = runHealthView(HEALTH_SECTIONS, { estimatedCostUsd: 0.2 });
  assert.equal(v.title, RUN_HEALTH_TITLE);
  assert.equal(v.empty, false);
  // cache: mean ± range + repeat-order warm-up table (descriptive, not causal)
  assert.equal(v.cache.mean, 0.61);
  assert.deepEqual(v.cache.byRepeat.map((r) => r.meanCacheR), [0.4, 0.8]);
  assert.equal(v.cache.skippedRounds, 3);
  assert.match(v.cache.byRepeatNote, /非因果/);
  // truncation: the two scalars kept separate + unknown disclosures
  assert.equal(v.truncation.truncatedRoundShare, 0.1);
  assert.deepEqual(v.truncation.finalRoundTruncated, { runs: 1, n: 4, share: 0.25 });
  assert.equal(v.truncation.unknownStopReason, 2);
  assert.equal(v.truncation.unknownFinalRuns, 1);
  assert.deepEqual(v.truncation.byReason, [{ reason: 'end_turn', count: 18 }, { reason: 'max_tokens', count: 2 }]);
  assert.match(v.truncation.unknownNote, /未知不是未截断/);
  // sidechain: three share axes; cost magnitude via equivTokens (§3.5 — no pricing dependency)
  assert.equal(v.sidechain.tokens.share, 0.2);
  assert.equal(v.sidechain.equivTokens.share, 0.25);
  assert.equal(v.sidechain.runsWithSidechain, 2);
  assert.match(v.sidechain.equivNote, /equivTokens/);
  // selfReport: self-reported Σ juxtaposed with the harness estimate — calibers spelled out, never merged
  assert.equal(v.selfReport.totalCostUsd, 0.123456);
  assert.equal(v.selfReport.invocations, 5);
  assert.equal(v.selfReport.estimatedCostUsd, 0.2);
  assert.equal(v.selfReport.isError, false);
  assert.match(v.selfReport.caliberNote, /口径不同/);
  assert.match(v.selfReport.caliberNote, /估算恒标/);
  // statsHealth: exclusion/abort distributions + structured-only timeoutRate + verifier reds
  assert.deepEqual(v.statsHealth.exclusions, [{ signature: 'auth-expiry', count: 2 }]);
  assert.deepEqual(v.statsHealth.abortedAtStep, [{ step: '2', count: 1 }]);
  assert.deepEqual(v.statsHealth.timeoutRate, { timedOut: 1, n: 10, rate: 0.1, legacyUnknown: 2 });
  assert.match(v.statsHealth.timeoutLegacyNote, /绝不用 error 字串回填/);
  assert.equal(v.statsHealth.retriedThenSucceeded, 1);
  assert.equal(v.statsHealth.parseWarningsTotal, 3);
  assert.equal(v.statsHealth.verifierFails[0].fails, 4);
});

test('T1S6 runHealthView: per-segment null reasons are independent — a null cache never blanks statsHealth', () => {
  const v = runHealthView({
    cacheHitRate: { value: null, reason: 'no-usage', skippedRounds: 4 },
    truncation: { value: null, reason: 'no-stop-reason', unknownStopReason: 12 },
    sidechainShare: { value: null, reason: 'no-sidechain-channel' },
    selfReport: { value: null, reason: 'no-result-lines' },
    statsHealth: HEALTH_SECTIONS.statsHealth,
  }, { nonAuthoritative: true });
  assert.equal(v.cache.null, true);
  assert.equal(v.cache.reasonCopy, 'o.nullReason.no-usage');
  assert.equal(v.cache.disclosures.skippedRounds, 4);
  assert.equal(v.truncation.reasonCopy, 'o.nullReason.no-stop-reason');
  assert.equal(v.truncation.disclosures.unknownStopReason, 12);
  assert.equal(v.sidechain.reasonCopy, 'o.nullReason.no-sidechain-channel');
  assert.equal(v.selfReport.reasonCopy, 'o.nullReason.no-result-lines');
  // the knowable segment still renders in full alongside four null neighbours
  assert.equal(v.statsHealth.null, false);
  assert.equal(v.statsHealth.retriedThenSucceeded, 1);
  // nonAuthoritative pinned on every segment (supplemental-sourced card)
  for (const s of [v.cache, v.truncation, v.sidechain, v.selfReport, v.statsHealth])
    assert.equal(s.nonAuthoritative, true);
  assert.equal(v.empty, false);
  // absent sections → segments null; ALL absent → empty card flag (renderer omits the panel)
  const none = runHealthView({});
  assert.equal(none.cache, null);
  assert.equal(none.statsHealth, null);
  assert.equal(none.empty, true);
  // estimate absent → null passthrough (不可得), never a fake 0
  const noEst = runHealthView({ selfReport: HEALTH_SECTIONS.selfReport });
  assert.equal(noEst.selfReport.estimatedCostUsd, null);
});

test('T1S6 dashboard wiring: 运行观测/运行健康 cards render after the coverage card, dual-layer titles, supplemental badge, null reason line', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  // cards rendered on the experiment page AFTER the coverage-stats panel (diagnosticsSection array order)
  assert.match(html, /expStatsPanel\(e\),\s*runObsPanel\(e\), runHealthPanel\(e\)/);
  // dual-layer card titles: zh-hans headline + canonical section keys
  assert.match(html, /运行观测 <span class="muted"[^>]*>context 组成 \+ 工具使用（contextComposition · toolUsage · fileTargets）/);
  assert.match(html, /运行健康 <span class="muted"[^>]*>cache · 截断 · 子代理 · 自报成本 · 异常（cacheHitRate · truncation · sidechainShare · selfReport · statsHealth）/);
  // §3.0 source resolution: embedded v3 wins, supplemental supplies below that — caller decides
  assert.match(html, /\(stats\.schemaVersion \?\? 1\) >= 3 && key in stats/);
  assert.match(html, /e\.supplemental\?\.sections/);
  // supplemental-sourced segments carry the S5-style 回填（非权威） badge, per segment
  assert.match(html, /const supBadge = \(on\) => on \? ` <span class="badge warn">\$\{t\('o\.auth\.backfill'\)\}<\/span>` : ''/);
  assert.match(html, /supBadge\(ccV\.nonAuthoritative\)/);
  assert.match(html, /supBadge\(tuV\.nonAuthoritative\)/);
  assert.match(html, /supBadge\(ftV\.nonAuthoritative\)/);
  assert.match(html, /supBadge\(sv\.nonAuthoritative\)/);   // run-health segments
  // null sections render the honest reason line (zh copy + canonical reason code), never a blank
  assert.match(html, /const nullReasonLine = \(v\) =>/);
  assert.match(html, /tf\(v\.reasonCopy/);
  // estimate badge on the contextComposition segment (估算恒标)
  assert.match(html, /估算（estimate）/);
  // fileTargets is folded into the 运行观测 card (inside runObsPanel, not its own panel)
  const obsPanelSrc = html.slice(html.indexOf('function runObsPanel'), html.indexOf('function runHealthPanel'));
  assert.match(obsPanelSrc, /fileTargetsView\(ft\.section/);
  assert.match(obsPanelSrc, /写（Write\/Edit\/NotebookEdit\/MultiEdit）/);
  // §3.1 copy ban holds in the rendering layer too: the 运行观测 panel never says 成本/花在
  assert.doesNotMatch(obsPanelSrc, /成本|花在/);
  // selfReport segment: 自报 Σ vs 估算 juxtaposed (both flagged, never merged)
  assert.match(html, /自报 Σ /);
  assert.match(html, /vs 估算 /);
  assert.match(html, /—（不可得）/);
});

test('EXP_GLOSSARY: plain-language dashboard tooltips, no traditional-Chinese leakage', () => {
  for (const key of ['coverage', 'cliSink', 'commandSurface', 'cooccur', 'proximityStrength', 'neverTriggered', 'notExercised', 'nCoverageValid', 'hypothesisSeq']) {
    assert.ok(EXP_GLOSSARY[key], `${key} defined`);
  }
  const TRAD = /[專並圖實層過獨顯類軸賴議員併駐節組觸發讀證據鑽環跡統較檢總數絆線預變採確認複書達結論遠決強轉請補後點該關與舊門單對種現語義檔訊號邊寬紅選標虧審終態細兩狀時長進離攜製質診斷僅參歸據應個來為這們麼樣業縮範聯試觀讓]/;
  for (const [k, v] of Object.entries(EXP_GLOSSARY)) {
    assert.equal([...new Set(v.match(new RegExp(TRAD, 'g')) ?? [])].length, 0, `${k} leaked traditional: ${v}`);
  }
});

// ---- adapter observability Wave 2 Stage 1: runtime 自述环境卡 + 实验对比 diff (design §4) --------

// Realistic environment fixture mirroring a sealed adapter experiment (obs-smoke shape).
const RI_ENV = {
  runtimeVersion: '9.9.9',
  runtimeInfo: {
    name: 'obs-smoke', version: '9.9.9',
    systemPrompt: { sha256: 'e30966ca1f8bb5fbfa8beab07c1d3f1fd684e4b2d029ee591e710605a27e85f6', bytes: 45, tokensEst: 14, textCaptured: true },
    tools: [{ name: 'price_get', kind: 'builtin' }],
    defaults: null,
  },
  runtimeInfoDrift: { digests: ['5d5c0896af6eb35149e7114e53053c04769c6008b950fd6eb6af755aca6ea5d9'] },
};

test('W2S1: runtimeInfoView full descriptor — sha 前 12, bytes, tokensEst 恒标估算, textCaptured → 全文已存档 badge', () => {
  const v = runtimeInfoView(RI_ENV);
  assert.equal(v.present, true);
  assert.equal(v.name, 'obs-smoke');
  assert.equal(v.version, '9.9.9');
  assert.equal(v.systemPrompt.shaShort, 'e30966ca1f8b');           // display prefix, 12 chars
  assert.equal(v.systemPrompt.sha256, RI_ENV.runtimeInfo.systemPrompt.sha256); // full sha preserved
  assert.equal(v.systemPrompt.bytes, 45);
  assert.equal(v.systemPrompt.tokensEst, 14);
  assert.equal(v.systemPrompt.estimate, true);                     // tokensEst 恒标 estimate
  assert.deepEqual(v.systemPrompt.badge, { word: SYSTEM_PROMPT_ARCHIVED, tone: 'ok', kind: 'text-captured' });
  assert.equal(SYSTEM_PROMPT_ARCHIVED, '全文已存档（logs/runtime-info）');
  assert.deepEqual(v.tools, [{ name: 'price_get', kind: 'builtin' }]);
  assert.equal(v.defaults, null);
  assert.equal(v.drift, false);
  assert.equal(v.driftNote, null);
});

test('W2S1: runtimeInfoView self-reported fingerprint — 自报指纹 badge (未经 harness 重算核验), warn tone', () => {
  const v = runtimeInfoView({ runtimeInfo: { name: 'x', version: '1',
    systemPrompt: { sha256: 'a'.repeat(64), bytes: 100, tokensEst: 25, selfReported: true }, tools: [], defaults: { temp: 0 } } });
  assert.deepEqual(v.systemPrompt.badge, { word: SYSTEM_PROMPT_SELF_REPORTED, tone: 'warn', kind: 'self-reported' });
  assert.equal(SYSTEM_PROMPT_SELF_REPORTED, '自报指纹（未经 harness 重算核验）');
  // a fingerprint WITHOUT textCaptured:true is never silently trusted — flag missing entirely → still self-reported
  const noFlag = runtimeInfoView({ runtimeInfo: { systemPrompt: { sha256: 'b'.repeat(64), bytes: 1, tokensEst: 1 } } });
  assert.equal(noFlag.systemPrompt.badge.kind, 'self-reported');
  // defaults 原样 passthrough
  assert.deepEqual(v.defaults, { temp: 0 });
  // empty tools array is a KNOWN-empty list (0 tools), not the 未自述 null
  assert.deepEqual(v.tools, []);
});

test('W2S1: runtimeInfoView drift — deduped digests >1 → drift note; identical repeats → no drift', () => {
  const twoSame = runtimeInfoView({ ...RI_ENV, runtimeInfoDrift: { digests: ['d1', 'd1', 'd1'] } });
  assert.equal(twoSame.drift, false);
  assert.equal(twoSame.driftNote, null);
  const drifted = runtimeInfoView({ ...RI_ENV, runtimeInfoDrift: { digests: ['d1', 'd2', 'd1'] } });
  assert.equal(drifted.drift, true);
  assert.equal(drifted.driftNote, RUNTIME_INFO_DRIFT_NOTE);
  assert.equal(RUNTIME_INFO_DRIFT_NOTE, '多次重复间自述不一致（drift）');
  assert.deepEqual(drifted.driftDigests, ['d1', 'd2']);
});

test('W2S1: runtimeInfoView absence — honest placeholder, never blank; claude-code version rides along', () => {
  const none = runtimeInfoView({});
  assert.equal(none.present, false);
  assert.equal(none.placeholder, RUNTIME_INFO_ABSENT);
  assert.equal(RUNTIME_INFO_ABSENT, 'runtime 未提供自述（no runtime_info）');
  assert.equal(none.version, null);
  // claude-code: runtime_info channel does not exist, but environment.runtimeVersion 可得 —
  // the ONE known dimension is carried, the rest is the honest placeholder
  const cc = runtimeInfoView({ runtimeVersion: '1.0.55' });
  assert.equal(cc.present, false);
  assert.equal(cc.version, '1.0.55');
  assert.equal(cc.placeholder, RUNTIME_INFO_ABSENT);
  // present-but-partial: each missing dimension has its own 未自述 placeholder constant
  const partial = runtimeInfoView({ runtimeInfo: { name: 'y', version: '2', systemPrompt: null, tools: null, defaults: null } });
  assert.equal(partial.present, true);
  assert.equal(partial.systemPrompt, null);
  assert.equal(partial.tools, null);
  assert.equal(RUNTIME_INFO_FIELD_ABSENT.systemPrompt, '未自述 system prompt（not reported）');
  assert.equal(RUNTIME_INFO_FIELD_ABSENT.tools, '未自述工具清单（not reported）');
  assert.equal(RUNTIME_INFO_FIELD_ABSENT.defaults, '未自述默认参数（not reported）');
});

test('W2S1: runtimeInfoDiff changed descriptors — version Δ, sha changed + bytes Δ, tools 增/删/不变, name change', () => {
  const envB = { runtimeInfo: {
    name: 'obs-smoke-next', version: '10.0.0',
    systemPrompt: { sha256: 'f'.repeat(64), bytes: 60, tokensEst: 18, textCaptured: true },
    tools: [{ name: 'price_get', kind: 'builtin' }, { name: 'order_put', kind: 'mcp' }],
    defaults: null,
  } };
  const d = runtimeInfoDiff(RI_ENV, envB);
  assert.equal(d.oneSided, false);
  assert.equal(d.framing, CONCURRENT_FACTORS_FRAMING);
  assert.deepEqual(d.name, { a: 'obs-smoke', b: 'obs-smoke-next', changed: true });
  assert.deepEqual(d.version, { a: '9.9.9', b: '10.0.0', changed: true });
  assert.equal(d.systemPrompt.changed, true);
  assert.equal(d.systemPrompt.shaShortA, 'e30966ca1f8b');
  assert.equal(d.systemPrompt.shaShortB, 'f'.repeat(12));
  assert.equal(d.systemPrompt.bytesDelta, 15);                     // 60 − 45, both sides known
  assert.deepEqual(d.tools, { unknown: false, added: ['order_put'], removed: [], unchanged: ['price_get'] });
});

test('W2S1: runtimeInfoDiff unchanged — all changed flags false, empty add/remove; null-aware honesty', () => {
  const d = runtimeInfoDiff(RI_ENV, structuredClone(RI_ENV));
  assert.equal(d.oneSided, false);
  assert.equal(d.name.changed, false);
  assert.equal(d.version.changed, false);
  assert.equal(d.systemPrompt.changed, false);
  assert.deepEqual(d.tools, { unknown: false, added: [], removed: [], unchanged: ['price_get'] });
  // one side without a self-described tool list → UNKNOWN, never a fabricated empty diff (null-not-zero)
  const noTools = runtimeInfoDiff(RI_ENV, { runtimeInfo: { ...structuredClone(RI_ENV.runtimeInfo), tools: null } });
  assert.deepEqual(noTools.tools, { unknown: true, added: null, removed: null, unchanged: null });
  // bytes on one side only → bytesDelta null (no delta against null)
  const noBytes = runtimeInfoDiff(RI_ENV, { runtimeInfo: { ...structuredClone(RI_ENV.runtimeInfo),
    systemPrompt: { sha256: 'c'.repeat(64), bytes: null, tokensEst: null, selfReported: true } } });
  assert.equal(noBytes.systemPrompt.changed, true);
  assert.equal(noBytes.systemPrompt.bytesDelta, null);
  // neither side has a systemPrompt → the dimension is null, not a fake "unchanged"
  const bare = { runtimeInfo: { name: 'z', version: '1', systemPrompt: null, tools: [], defaults: null } };
  assert.equal(runtimeInfoDiff(bare, structuredClone(bare)).systemPrompt, null);
});

test('W2S1: runtimeInfoDiff one-sided / both-absent — 无 runtime 自述 placeholder, no fabricated diff', () => {
  const dA = runtimeInfoDiff({}, RI_ENV);                          // A side lacks runtime_info
  assert.equal(dA.oneSided, true);
  assert.equal(dA.side, 'A');
  assert.equal(dA.placeholder, RUNTIME_INFO_DIFF_ABSENT);
  assert.equal(RUNTIME_INFO_DIFF_ABSENT, '无 runtime 自述');
  assert.equal(dA.framing, CONCURRENT_FACTORS_FRAMING);
  assert.equal(dA.present.present, true);                          // the side that DID self-describe rides along
  assert.equal(dA.present.name, 'obs-smoke');
  const dB = runtimeInfoDiff(RI_ENV, {});
  assert.equal(dB.oneSided, true);
  assert.equal(dB.side, 'B');
  // neither side self-describes → null (no section; absence already on each side's environment card)
  assert.equal(runtimeInfoDiff({}, {}), null);
  assert.equal(runtimeInfoDiff(null, undefined), null);
});

test('W2S1: causal ban + framing constant — diff/view output carries the mandated framing and ZERO causal wording', () => {
  assert.equal(CONCURRENT_FACTORS_FRAMING,
    '以下为同期变更的环境因素（concurrent factors）——差异与指标变化并列呈现，不构成因果归因');
  const envB = { runtimeInfo: { name: 'n2', version: '2',
    systemPrompt: { sha256: 'd'.repeat(64), bytes: 10, tokensEst: 3, selfReported: true },
    tools: [{ name: 'a', kind: 'builtin' }], defaults: { t: 1 } } };
  const CAUSAL = /导致|因此|因为/;
  for (const out of [
    runtimeInfoDiff(RI_ENV, envB), runtimeInfoDiff(RI_ENV, structuredClone(RI_ENV)),
    runtimeInfoDiff({}, RI_ENV), runtimeInfoView(RI_ENV), runtimeInfoView({}), runtimeInfoView(envB),
  ]) {
    assert.doesNotMatch(JSON.stringify(out), CAUSAL);
  }
});

test('W2S1 dashboard wiring: runtime 环境卡 self-description section + compare descriptor-diff panel', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  // experiment detail: the runtime-under-test panel renders the runtime_info section from the view model
  assert.match(html, /\$\{runtimeInfoHtml\(e\)\}/);
  assert.match(html, /runtimeInfoView\(e\.environment \?\? \{\}\)/);
  assert.match(html, /runtime 自述<\/b> <span class="muted"[^>]*>（runtime_info，指纹形式）/);
  assert.match(html, /（估算，estimate）/);                       // tokensEst 恒标估算 in the fingerprint line
  assert.match(html, /RUNTIME_INFO_FIELD_ABSENT\.systemPrompt/);   // per-dimension honest placeholders
  assert.match(html, /RUNTIME_INFO_FIELD_ABSENT\.tools/);
  assert.match(html, /RUNTIME_INFO_FIELD_ABSENT\.defaults/);
  assert.match(html, /自述工具清单为空（0 tools）/);               // known-empty ≠ 未自述
  assert.match(html, /v\.driftNote/);                              // drift warning badge wired
  // absent → the honest placeholder line (copy lives in obs.js RUNTIME_INFO_ABSENT, not duplicated)
  assert.match(html, /fmt\.esc\(v\.placeholder\)/);
  // compare view: diff panel wired into viewCompare right after the metadata diff (minimal change)
  assert.match(html, /\$\{metadataDiffPanel\(a, b\)\}\s*\$\{runtimeInfoDiffPanel\(a, b\)\}/);
  assert.match(html, /runtimeInfoDiff\(a\.environment \?\? \{\}, b\.environment \?\? \{\}\)/);
  assert.match(html, /runtime 自述对比 <span class="muted"[^>]*>（runtime_info descriptor diff）/);
  assert.match(html, /\$\{fmt\.esc\(d\.framing\)\}/);              // mandated concurrent-factors framing rendered
  assert.match(html, /（sha 变了）/);
  assert.match(html, /（sha 未变）/);
  assert.match(html, /bytes Δ /);
  assert.match(html, /不变（unchanged）/);
  assert.match(html, /一侧未自述工具清单——增删不可知（not reported）/);
  assert.match(html, /无法做描述符 diff/);                          // one-sided placeholder row
  // causal ban holds in the rendering layer too
  const panelSrc = html.slice(html.indexOf('function runtimeInfoDiffPanel'), html.indexOf('// S15: skill-version causal row'));
  assert.doesNotMatch(panelSrc, /导致|因此|因为/);
});

// ── Q-A overview (master-detail) — scoreHue + buildQuestionList ──────────────────────────────
test('scoreHue: 0=red, 1=green, C=0 forces red, null composite → null (neutral)', () => {
  assert.equal(scoreHue(0), 0);          // red
  assert.equal(scoreHue(1), 120);        // green
  assert.equal(scoreHue(0.5), 60);       // amber
  assert.equal(scoreHue(0.9, false), 0, 'wrong answer (C=0) is red even at high composite');
  assert.equal(scoreHue(null), null, 'no data → neutral hue, never a fake green');
  assert.equal(scoreHue(1.5), 120, 'clamps above 1');
});

test('buildQuestionList: attention-first sort, per-question metrics, hue, verdict; held_out skipped', () => {
  const exp = { tasks: {
    good: { prompt: 'q-good', expected_skill: 'skill.a', category: 'cat', composite: 0.95, C: 1, successRate: 1, activationRate: 1, n: 3, efficiency: { meanCostUsd: 0.1, meanDurationMs: 2000, meanOutTokens: 50 } },
    bad:  { prompt: 'q-bad', expected_skill: 'skill.b', category: 'cat', composite: 0.1, C: 0, successRate: 0, activationRate: 0.2, n: 3, lowSample: true, efficiency: { meanCostUsd: 0.3, meanDurationMs: 5000, meanOutTokens: 80 } },
    mid:  { prompt: 'q-mid', composite: 0.5, C: 0.5, n: 2 },
    held: { held_out: true, prompt: 'hidden', composite: 1, C: 1 },
  } };
  const list = buildQuestionList(exp);
  assert.equal(list.length, 3, 'held_out excluded');
  assert.deepEqual(list.map(i => i.id), ['bad', 'mid', 'good'], 'worst composite first (attention-first)');
  const bad = list[0];
  assert.equal(bad.verdict, 'fail');
  assert.equal(bad.hue, 0, 'C=0 → red');
  assert.equal(bad.lowSample, true);
  assert.equal(bad.meanCostUsd, 0.3);
  assert.equal(list.find(i => i.id === 'mid').verdict, 'partial', '0<C<1 → partial');
  assert.equal(list.find(i => i.id === 'good').verdict, 'pass');
  assert.equal(list.find(i => i.id === 'good').hue, Math.round(0.95 * 120), 'pass hue from composite');
});

test('buildQuestionList: compositePartial fallback, null composite sorts last with null hue', () => {
  const exp = { tasks: {
    a: { prompt: 'a', C: 1, compositePartial: 0.8 },      // no composite → falls back to compositePartial
    z: { prompt: 'z', C: null },                          // no composite at all → no-data row
  } };
  const list = buildQuestionList(exp);
  assert.equal(list[0].id, 'a', 'has-data row first');
  assert.equal(list[0].composite, 0.8);
  assert.equal(list[1].id, 'z', 'no-data row sorts last');
  assert.equal(list[1].hue, null, 'null composite → neutral hue');
  assert.equal(list[1].verdict, 'na');
});
