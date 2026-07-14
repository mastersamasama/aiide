// aiide observability pure logic (Wave 2 / 2.5).
// Zero-dependency ES module of PURE functions only — no DOM, no window, no fetch — so the
// bug-prone rules (attribution residual sign, deterministic loop detection, causal-compare
// comparability gate) are unit-testable under `node --test`. index.html loads this via a
// <script type="module"> shim that copies the exports onto window; test/web-obs.test.js
// imports it directly. Keep this file free of browser globals at module top level.

// ---- S4 obs-context-diff -------------------------------------------------

// The real "contribution" buckets, largest first. `other` is a reconciliation residual
// (delta − Σ positive buckets) and can be NEGATIVE at a compaction / cache-eviction boundary —
// it is intentionally NOT returned as a contribution bucket, only as `residual`.
// Tagged runs (_attr.tagged, taxonomy §3.1) split the merged `injected` bucket into
// injectedUser / injectedHarness / skillBody; legacy runs keep the historical three-bucket
// shape — untagged events are never fake-split. `compactionKind` ('confirmed' | 'inferred',
// set only on a negative residual) rides through untouched for the tooltip.
export function attrContributions(attr) {
  if (!attr) return { buckets: [], residual: 0, compactionKind: null };
  const keys = attr.tagged
    ? ['prevOut', 'toolRes', 'injectedUser', 'injectedHarness', 'skillBody']
    : ['prevOut', 'toolRes', 'injected'];
  const buckets = keys.map(key => ({ key, val: attr[key] ?? 0 })).sort((a, b) => b.val - a.val);
  return { buckets, residual: attr.other ?? 0, compactionKind: attr.compactionKind ?? null };
}

// Build the interleaved timeline items (user events + rounds) and attribute each round's context
// growth in place (sets r._delta / r._attr). Pure over the fetched run — no DOM, no fetch; used
// by both the full render and the S9 live-tail append in index.html so the two never diverge
// (extracted from index.html — taxonomy §3.1(c) shared module).
//
// Bucket regimes, gated on the run-level parse-time tag (r5 F-5-01 — the srcKind five-class tag
// exists only when the parser that produced the run wrote `userEventsTagVersion`):
//   tagged run  → five-class split by userEvent.srcKind:
//     injectedUser ('user') · injectedHarness ('attachment' + 'tool-result-side' +
//     'meta-injected' — the harness tax) · skillBody ('skill-body'); _attr.tagged = true.
//     A NEGATIVE residual additionally carries compactionKind: 'confirmed' when the round has
//     compactBefore (parser saw the compact-boundary line) else 'inferred' — a label only, the
//     negative-residual semantics/rendering stay exactly as before.
//   legacy run (field absent) → the historical merged `injected` bucket with byte-identical
//     math (never a fake split of untagged events); _attr.tagged = false.
export function computeRunItems(run) {
  const items = [
    ...run.rounds.map(r => ({ kind: 'round', ts: r.ts ?? '', r })),
    ...(run.userEvents ?? []).map(u => ({ kind: 'user', ts: u.ts ?? '', u })),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const tagged = run.userEventsTagVersion != null;
  let prevRound = null;
  let injChars = 0;                                  // legacy merged accumulator
  let injUser = 0, injHarness = 0, injSkillBody = 0; // tagged five-class accumulators
  for (const it of items) {
    if (it.kind === 'user') {
      injChars += it.u.chars;
      if (it.u.srcKind === 'user') injUser += it.u.chars;
      else if (it.u.srcKind === 'skill-body') injSkillBody += it.u.chars;
      else injHarness += it.u.chars; // attachment / tool-result-side / meta-injected
      continue;
    }
    const r = it.r;
    if (prevRound) {
      r._delta = r.contextFootprint - prevRound.contextFootprint;
      const attr = {
        prevOut: prevRound.usage.out,
        toolRes: Math.round(prevRound.toolCalls.reduce((a, tc) => a + (tc.result?.length ?? 0), 0) / 4),
        tagged,
      };
      if (tagged) {
        attr.injectedUser = Math.round(injUser / 4);
        attr.injectedHarness = Math.round(injHarness / 4);
        attr.skillBody = Math.round(injSkillBody / 4);
        attr.other = r._delta - attr.prevOut - attr.toolRes
          - attr.injectedUser - attr.injectedHarness - attr.skillBody;
        // context shrank: confirmed only by a parser-observed compact-boundary, else inferred
        if (attr.other < 0) attr.compactionKind = r.compactBefore ? 'confirmed' : 'inferred';
      } else {
        attr.injected = Math.round(injChars / 4);
        attr.other = r._delta - attr.prevOut - attr.toolRes - attr.injected;
      }
      r._attr = attr;
    }
    injChars = injUser = injHarness = injSkillBody = 0;
    prevRound = r;
  }
  return items;
}

// Visual-volume management: a Δ is "significant" (worth colouring) only when it is a real jump
// relative to the round's own footprint. Small drift stays dim.
export function deltaSignificant(delta, footprint, ratio = 0.1) {
  if (delta == null || !footprint || footprint <= 0) return false;
  return Math.abs(delta) >= footprint * ratio;
}

// ---- S5 obs-overview-metrics ---------------------------------------------

// Share of runs that hit at least one tool error. The list metadata carries per-run toolErrors
// but not total tool-call counts, so an honest overview metric is "runs affected / total".
export function errorRate(runs) {
  if (!runs || !runs.length) return 0;
  const bad = runs.filter(r => (r.toolErrors ?? 0) > 0).length;
  return bad / runs.length;
}

// ---- S11 data-retention hint (read-only) ---------------------------------

// A calm, silent-by-default retention nudge. Returns null (no hint) until runs cross a threshold
// — count over maxRuns OR oldest run older than maxAgeDays — then returns the counts and a
// COPY-ONLY `aiide prune` command. It never deletes anything; the GUI has no delete surface.
export function pruneHint(runs, { maxRuns = 200, maxAgeDays = 90, now = Date.now() } = {}) {
  if (!runs || !runs.length) return null;
  const times = runs.map(r => Date.parse(r.startedAt)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : null;
  const oldestDays = oldest == null ? 0 : Math.floor((now - oldest) / 86400000);
  const byAge = oldestDays > maxAgeDays;
  const byCount = runs.length > maxRuns;
  if (!byAge && !byCount) return null;
  // age-based cleanup is the friendlier default when both trip; command omits --yes so the CLI
  // still prompts for confirmation before deleting.
  const command = byAge ? `aiide prune --older-than ${maxAgeDays}d` : `aiide prune --max ${maxRuns}`;
  return { count: runs.length, oldestDays, command, byAge, byCount };
}

// ---- S16 obs-loop-evolution ----------------------------------------------

// Canonical JSON string with recursively sorted keys, so semantically identical tool inputs
// compare equal regardless of key order. Strings pass through untouched.
export function normalizeInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try { return stableStringify(input); } catch { return String(input); }
}
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// exact-equal OR one an exact prefix of the other — the structural signature of a rabbit-hole
// loop (same tool re-run identically, or with a growing argument). Deliberately NO semantic
// similarity: that would be a fake LLM-judge and break deterministic-first.
function prefixEq(a, b) { return a === b || a.startsWith(b) || b.startsWith(a); }

// Deterministic loop detection over a run's rounds. Returns high-confidence findings only
// (runs of length >= threshold); normal traces yield []. Anchored comparison (every call in a
// run compared to the run's first call) avoids chaining unrelated drifting inputs.
export function detectLoops(rounds, threshold = 4) {
  const calls = [];
  for (const r of rounds ?? [])
    for (const tc of r.toolCalls ?? [])
      calls.push({ name: tc.name, sig: tc.name + ' ' + normalizeInput(tc.input), isError: !!tc.isError, seq: r.seq });
  const findings = [];

  // (1) identical / exact-prefix tool input repeated
  let i = 0;
  while (i < calls.length) {
    let j = i + 1;
    while (j < calls.length && calls[j].name === calls[i].name && prefixEq(calls[j].sig, calls[i].sig)) j++;
    const count = j - i;
    if (count >= threshold) findings.push({ type: 'identical-input', tool: calls[i].name, count, fromSeq: calls[i].seq, toSeq: calls[j - 1].seq });
    i = Math.max(j, i + 1);
  }

  // (2) same-name tool erroring repeatedly
  i = 0;
  while (i < calls.length) {
    if (!calls[i].isError) { i++; continue; }
    let j = i + 1;
    while (j < calls.length && calls[j].isError && calls[j].name === calls[i].name) j++;
    const count = j - i;
    if (count >= threshold) findings.push({ type: 'repeated-error', tool: calls[i].name, count, fromSeq: calls[i].seq, toSeq: calls[j - 1].seq });
    i = Math.max(j, i + 1);
  }
  return findings;
}

// Per-round stacked-attribution series for the diverging chart. Positive buckets stack up;
// `residual` (the ± `_attr.other`) is carried signed so the renderer can draw a negative
// residual BELOW the baseline as a compaction marker instead of a fake positive height.
export function stackSeries(rounds) {
  const out = [];
  for (const r of rounds ?? []) {
    if (!r._attr) continue;
    const a = r._attr;
    // tagged five-class buckets are MAPPED onto the chart's merged `injected` band — the stacked
    // chart keeps its three positive segments (minimal-change); the per-round attribution line
    // (attrContributions) is where the split shows. compactionKind rides along for the tooltip.
    const injected = a.tagged
      ? Math.max(0, a.injectedUser ?? 0) + Math.max(0, a.injectedHarness ?? 0) + Math.max(0, a.skillBody ?? 0)
      : Math.max(0, a.injected ?? 0);
    out.push({
      seq: r.seq,
      prevOut: Math.max(0, a.prevOut ?? 0),
      toolRes: Math.max(0, a.toolRes ?? 0),
      injected,
      residual: a.other ?? 0,
      compactionKind: a.compactionKind ?? null,
    });
  }
  return out;
}

// ---- S15 obs-skill-causal-compare ----------------------------------------

// The "⇒" causal gate: two experiments are comparable only when suite bytes, model, and
// runtime all match. Otherwise the delta is correlational (other variables move at once).
export function cohortComparable(a, b) {
  const reasons = [];
  const sa = a?.environment?.suite?.sha256, sb = b?.environment?.suite?.sha256;
  if (!sa || !sb || sa !== sb) reasons.push('suite');
  if ((a?.model ?? '') !== (b?.model ?? '')) reasons.push('model');
  if ((a?.runtime ?? 'claude-code') !== (b?.runtime ?? 'claude-code')) reasons.push('runtime');
  return { comparable: reasons.length === 0, reasons };
}

export function ciOverlap(a, b) {
  if (!a || !b) return false;
  return a.lo <= b.hi && b.lo <= a.hi;
}

// Part C (Compare 1-vs-1): the two Wilson CIs don't overlap → a conservative, honest signal that the
// two experiments' success rates genuinely differ. NOT a cohort verdict (that needs `upgrade eval`'s
// N pairs + FDR) — just a read on the two experiments compare already has. Absent bounds → false.
export function wilsonCisDisjoint(a, b) {
  if (!a || !b || a.lo == null || a.hi == null || b.lo == null || b.hi == null) return false;
  return !ciOverlap(a, b);
}

// Tally task-level deltas (B−A, higher = better) into improved/regressed/flat for the Compare summary.
export function deltaTally(deltas) {
  const out = { improved: 0, regressed: 0, flat: 0 };
  for (const d of deltas) {
    if (d == null) continue;
    if (d > 0) out.improved++; else if (d < 0) out.regressed++; else out.flat++;
  }
  return out;
}

// Skills present in both experiments whose hash changed (the only ones with a variable to
// attribute). Unchanged hashes are omitted → no causal row is drawn for them.
export function skillHashDeltas(a, b) {
  const sa = a?.environment?.skills ?? [], sb = b?.environment?.skills ?? [];
  const mapB = new Map(sb.map(s => [s.name, s.hash ?? null]));
  const out = [];
  for (const s of sa) {
    if (!mapB.has(s.name)) continue;
    const hb = mapB.get(s.name);
    if ((s.hash ?? '') !== (hb ?? '')) out.push({ name: s.name, hashA: s.hash ?? null, hashB: hb });
  }
  return out;
}

// Mean activation rate across tasks that report one (null activation rates are ignored, not
// counted as 0). Returns null when no task reports activation.
export function meanActivation(exp) {
  const rates = Object.values(exp?.tasks ?? {}).map(t => t?.activationRate).filter(r => r != null);
  if (!rates.length) return null;
  return rates.reduce((a, r) => a + r, 0) / rates.length;
}

// The aggregate composite delta is "within noise" when it is backed by NO task whose success
// rate moved significantly — i.e. every shared task's Wilson CIs still overlap. Only then does
// the UI append the [within noise — CIs overlap] caveat; a significant delta stays silent.
export function causalWithinNoise(a, b) {
  const ta = a?.tasks ?? {}, tb = b?.tasks ?? {};
  const ids = Object.keys(ta).filter(id => tb[id]);
  if (!ids.length) return false;
  return ids.every(id => ciOverlap(ta[id].wilsonCi, tb[id].wilsonCi));
}

// ---- U8 upgrade-view (verdict-first, read-only, governance-neutral) ------
// Pure view model for the dashboard's #upgrades detail card. It exposes the verdict as ADOPTION
// EVIDENCE and NEVER an adopt affordance (there is no adopt button anywhere). The five verdicts
// (decideVerdict, src/upgradeVerdict.js) map to a four-state glyph — design phase6-visual ✓✗~∅:
//   established intent verdict → ✓ ok · not-established → ✗ err · inconclusive → ~ warn ·
//   insufficient-data → ∅ dim. insufficient-data / inconclusive are NEVER "持平/可採" (R8.2.3).

export const UPGRADE_INTENTS = ['cost-opt', 'quality-fix', 'neutral-refactor'];

// Plain-Chinese gloss for the L1/L2/L3 outcome enums (design S1 de-jargon standard, matched to the
// U7 report end). The dashboard renders the gloss as visible zh text and keeps the raw enum in a
// tooltip for AI cross-reference. Of these, only `flow-incomplete` currently surfaces in the
// dashboard's aggregate views; the rest live here so any per-case enum U7 later surfaces is glossed
// consistently rather than leaking a raw English token.
export const UPGRADE_ENUM_GLOSS = {
  'ok': '正常',
  'wrong-route': '路由错',
  'executed-after-confirm': '确认后执行',
  'asked-and-halted': '问完即停',
  'flow-incomplete': '确认后中断',
  'permission-artifact': '权限拒绝',
};
export function upgradeEnumGloss(enumVal) { return UPGRADE_ENUM_GLOSS[enumVal] ?? enumVal; }

// verdict → { glyph, tone }; tone is a CSS-class stem the renderer maps to a --colour var.
export function upgradeVerdictGlyph(verdict, established) {
  if (verdict === 'insufficient-data') return { glyph: '∅', tone: 'dim' };
  if (verdict === 'inconclusive') return { glyph: '~', tone: 'warn' };
  return established ? { glyph: '✓', tone: 'ok' } : { glyph: '✗', tone: 'err' };
}

// Adoption-eligible SIGNAL only (never a button): insufficient-data/inconclusive are NEVER adoptable
// (R8.EB1); an intent verdict is adoptable only when established. Even true, the human decides.
export function upgradeAdoptable(verdict, established) {
  return UPGRADE_INTENTS.includes(verdict) && established === true;
}

// Boolean-recommendation framing for the dashboard (user-requested presentation layer over the SAME
// report.json). An intent verdict is DECIDABLE — `recommended` = `established`. insufficient-data /
// inconclusive are NOT decidable: `decidable:false`, `recommended:null` — they must render as
// "undecidable", NEVER as `recommendation: false` (that would read as a real negative signal, R8.2.3).
export function upgradeRecommendation(verdict, established) {
  if (verdict === 'insufficient-data' || verdict === 'inconclusive') return { decidable: false, recommended: null };
  if (UPGRADE_INTENTS.includes(verdict)) return { decidable: true, recommended: established === true };
  return { decidable: false, recommended: null };
}

// PM-B2 next-step guidance for the two non-verdict states — structurally mirrors U7 R7.4.3 so the
// dashboard and the single-file HTML report say the same thing:
//   insufficient-data → "還需 N 條配對"  (N = MIN_PAIRS − pairs)
//   inconclusive      → the excluded case-ids + their reasons + a suggested action
export function upgradeNextSteps(report, { minPairs = 8 } = {}) {
  const v = report?.verdict;
  if (v === 'insufficient-data') {
    return { kind: 'insufficient-data', needPairs: Math.max(0, minPairs - (report.pairs ?? 0)), minPairs, pairs: report.pairs ?? 0 };
  }
  if (v === 'inconclusive') {
    return {
      kind: 'inconclusive', exclusionPct: report.exclusionPct ?? null,
      excludedCases: (report.excludedCases ?? []).map(c => ({
        caseId: c.caseId, reason: c.reason,
        // env-noise vs harness-halt get different remediation (U7 R7.4.3 suggested action)
        action: c.reason === 'harness-halt' ? 'add-scripted-reply' : 'inspect-env-noise',
      })),
    };
  }
  return null;
}

// per-skill "red list": skills that are NOT a clean adopt signal — a significant quality DROP
// ('regressed'), or a badge that forbids trust ('low-confidence': reference-only / insufficient-data).
// The per-skill table is explicitly NOT an adoption certificate (R4.6.5); this only surfaces watch-items.
export function upgradeRedlist(perSkill) {
  const skills = perSkill?.skills ?? [];
  const out = [];
  for (const s of skills) {
    const regressed = s.significant === true && (s.mean ?? 0) < 0;
    const lowConf = s.badge === 'reference-only' || s.badge === 'insufficient-data';
    if (!regressed && !lowConf) continue;
    out.push({
      skill: s.skill, mean: s.mean ?? null, ci: s.ci ?? null, badge: s.badge,
      significantBadge: s.significantBadge ?? null,
      flag: regressed ? 'regressed' : 'low-confidence',
    });
  }
  // regressions first (they are the real signal), then low-confidence
  return out.sort((a, b) => (a.flag === b.flag ? 0 : a.flag === 'regressed' ? -1 : 1));
}

// The whole #upgrades detail-card view model. `report` is one <compare-id>/report.json (verdict-first).
// minPairs is read from the report footer's config when present so the "還需 N 條" count matches the
// engine's actual MIN_PAIRS rather than a hard-coded default.
export function buildUpgradeView(report) {
  if (!report) return null;
  const minPairs = report?.footer?.config?.MIN_PAIRS ?? 8;
  const g = upgradeVerdictGlyph(report.verdict, report.established);
  const q = report.axes?.quality ?? {};
  const c = report.axes?.cost ?? {};
  const qualityAxes = ['l1', 'l2', 'l3'].filter(k => q[k]).map(k => {
    // L1 is n/a when either arm's runtime has no skill substrate (external/adapter runtime). Surface a
    // naRouting flag so the row reads "不适用" instead of a bare n/a delta (routing was never possible).
    const ra = q[k].routingApplicable;
    const naRouting = !!ra && (ra.old === false || ra.new === false);
    return {
      key: k, deltaPp: q[k].deltaPp ?? null, ci: q[k].ci ?? null, n: q[k].n ?? null,
      significantUp: q[k].significantUp === true, heuristic: q[k].heuristic === true, naRouting,
    };
  });
  const costAxes = ['turns', 'tokens', 'seconds'].filter(k => c[k]).map(k => ({
    key: k, delta: c[k].delta ?? null, ci: c[k].ci ?? null, n: c[k].n ?? null,
    significantDown: c[k].significantDown === true, significantUp: c[k].significantUp === true,
  }));
  return {
    compareId: report.compareId ?? null, createdAt: report.createdAt ?? null, intent: report.intent ?? null,
    verdict: report.verdict ?? null, established: report.established === true,
    pairs: report.pairs ?? null, exclusionPct: report.exclusionPct ?? null,
    glyph: g.glyph, tone: g.tone,
    adoptable: upgradeAdoptable(report.verdict, report.established),
    recommendation: upgradeRecommendation(report.verdict, report.established),
    reasons: report.reasons ?? [],
    header: report.header ?? {}, arms: report.arms ?? {},
    qualityAxes, costAxes, flowIncomplete: report.axes?.flowIncomplete ?? null,
    perSkillRedlist: upgradeRedlist(report.perSkill),
    perSkillNote: report.perSkill?.note ?? null,
    nextSteps: upgradeNextSteps(report, { minPairs }),
    footer: report.footer ?? null,
    reportHtmlPath: report._reportHtmlPath ?? null,
    probes: buildProbeBlockView(report.probes),   // external-tool probe-signal block (null = no probe)
  };
}

// ---- Experiment Q-A overview (master-detail) — the color-coded question list ------------------
// The exp-detail page shows a scannable list of ALL questions (one compact row each) + a detail pane,
// instead of stacking every task's full panel. Color is FUNCTIONAL: hue encodes quality (composite),
// red→green; an outright-wrong answer (C=0) is forced red so "red means wrong" always holds. Pure over
// the served experiment (tasks = scoreTask output); the DOM/render lives in index.html.

// composite∈[0,1] → hue 0(red)…120(green). correct===false (C=0) forces red regardless of composite;
// null composite (no data) → null hue (caller renders a neutral/gray row, never a fake green).
export function scoreHue(composite, correct = null) {
  if (correct === false) return 0;                      // wrong answer → unambiguous red
  if (composite == null || Number.isNaN(composite)) return null;
  const c = Math.max(0, Math.min(1, composite));
  return Math.round(c * 120);
}

// One row per non-held-out task, sorted attention-first (lowest composite on top; no-data rows last)
// so the reds cluster where the eye lands. Each row carries the at-a-glance metrics + a hue + a verdict.
export function buildQuestionList(exp) {
  const tasks = exp?.tasks ?? {};
  const items = [];
  for (const [id, tk] of Object.entries(tasks)) {
    if (tk?.held_out === true) continue;
    const composite = tk.composite ?? tk.compositePartial ?? null;
    const C = tk.C ?? null;
    const verdict = C == null ? 'na' : C >= 1 ? 'pass' : C <= 0 ? 'fail' : 'partial';
    items.push({
      id,
      label: tk.prompt ?? id,
      skill: tk.expected_skill ?? null,
      category: tk.category ?? null,
      composite, C, verdict,
      successRate: tk.successRate ?? null,
      activationRate: tk.activationRate ?? null,
      meanCostUsd: tk.efficiency?.meanCostUsd ?? null,
      meanDurationMs: tk.efficiency?.meanDurationMs ?? null,
      meanOutTokens: tk.efficiency?.meanOutTokens ?? null,
      n: tk.n ?? null,
      lowSample: tk.lowSample === true,
      degraded: tk.degraded === true,
      hue: scoreHue(composite, verdict === 'fail' ? false : null),
    });
  }
  items.sort((a, b) => {
    const av = a.composite == null ? Infinity : a.composite;
    const bv = b.composite == null ? Infinity : b.composite;
    return av - bv || String(a.id).localeCompare(String(b.id));
  });
  return items;
}

// ---- Experiment statistics card (design §2.3/§2.4) — three-state, block-status badges ----------
// Pure view models over `experiment.stats` (buildExpStats output). The dashboard card renders these;
// it re-computes nothing. Honesty discipline mirrors the engine: an absent signal is null, never a
// fake 0, and the coverage sample size is ALWAYS `nCoverageValid` (never the scorecard's `n`).

// The card's top-level STATE (design A3 — three states, driven by the resolver's statsAuthority):
//   'full'    — usable stats resolved (embedded OR a valid backfill sidecar; the authority badge
//               says which). Also reached without a resolver when a raw exp carries valid stats.
//   'error'   — seal-time stats computation failed (stats:{error} or resolver statsError) →
//               render 统计计算失败：<error>, NEVER the full card over an empty shape.
//   'legacy'  — no stats anywhere → sealed before this feature; offer to backfill via `aiide stats`.
export const EXP_STATS_STATE = { LEGACY: 'legacy', FULL: 'full', ERROR: 'error' };
export function expStatsState(experiment) {
  if (experiment?.statsAuthority) return EXP_STATS_STATE.FULL;       // resolver already decided
  if (experiment?.stats?.error || experiment?.statsError) return EXP_STATS_STATE.ERROR;
  return experiment?.stats ? EXP_STATS_STATE.FULL : EXP_STATS_STATE.LEGACY;
}

// authority → badge word (design A3). embedded / authoritative-embedded carry the SEALED numbers →
// 权威; the two recompute authorities are honest-but-non-authoritative backfills → 回填.
export function statsAuthorityBadge(authority) {
  if (authority === 'embedded' || authority === 'authoritative-embedded')
    return { word: '权威（封存时计算）', tone: 'ok' };
  if (authority === 'non-authoritative-recompute' || authority === 'recomputed-no-embedded')
    return { word: '回填（非权威）', tone: 'warn' };
  return null; // no resolver ran (raw embedded object) → no badge, not a fake one
}

// The CURRENT expstats schemaVersion, mirrored from src/expstats.js STATS_SCHEMA_VERSION. obs.js
// cannot import expstats (the dependency direction is src→web, taxonomy §3.1(c)) — the pair is
// pinned equal by test. An embedded blob BELOW this is stale: its numbers stay authoritative but
// new-schema sections can be supplied alongside (resolver `supplemental`, taxonomy §3.0).
export const CURRENT_STATS_SCHEMA_VERSION = 3;

// block-level status → a BADGE (a WORD, never a ratio). Each of the four honest states gets a
// plain-language word + a tone stem the renderer maps to a --colour var. Unknown → passthrough word.
export const BLOCK_STATUS_BADGE = {
  'insufficient-data': { word: '样本不足', tone: 'dim' },
  'unavailable': { word: '不可用', tone: 'dim' },
  'suspect': { word: '可疑', tone: 'warn' },
  'held-out-unknown': { word: '留出未知', tone: 'warn' },
  'ok': { word: '正常', tone: 'ok' },
  'available': { word: '正常', tone: 'ok' },
};
export function blockStatusBadge(status) {
  return BLOCK_STATUS_BADGE[status] ?? { word: String(status ?? '—'), tone: 'dim' };
}

// Stage 4 provenance badge (adapter observability §3 consumer matrix): stats.provenance
// 'adapter-reported' → badge data for the coverage panel header (基于 runtime 自报信号).
// 'harness-observed' / null → no badge — observed is the default posture, and an absent value
// must never fabricate one (null-not-zero applied to provenance).
export function statsProvenanceBadge(provenance) {
  if (provenance === 'adapter-reported') return { word: '基于 runtime 自报信号（adapter-reported）', tone: 'warn' };
  return null;
}

// M1 skill-trigger coverage. The two never-fired buckets carry DIFFERENT plain-language meanings —
// neverTriggered = 有题目考它但从未触发 (a real dead-weight candidate); notExercised = 没有题目考它
// (no chance given, NOT dead weight). coverageRatio is null (not 0) when nothing is installed.
export function expSkillCoverageView(stats) {
  const sc = stats?.skillCoverage;
  if (!sc) return null;
  const installed = sc.installed?.length ?? 0;
  const triggered = new Set((sc.everTriggered ?? []).map((e) => e.skill)).size;
  return {
    installed, triggered,
    coverageRatio: installed ? triggered / installed : null,
    everTriggered: sc.everTriggered ?? [],
    triggerRate: sc.triggerRate ?? [],
    neverTriggered: { skills: sc.neverTriggered ?? [], hint: '有题目考它，但从未触发（可能是真的没用上）' },
    notExercised: { skills: sc.notExercised ?? [], hint: '没有题目考它——没给机会，不是死重' },
  };
}

// M2 reference-read coverage. unreadRefs are dead-weight CANDIDATES only AFTER the three exemption
// buckets are cleared: permission-artifact (被权限拒绝读不到), excluded-only (只在被排除的运行里读过),
// not-exercised (所属 skill 从未触发，没得到出场机会).
export function expRefCoverageView(stats) {
  const rc = stats?.refCoverage;
  if (!rc) return null;
  // §S v2 null-guard (design B1 消费端必改点): bySkill === null means UNKNOWABLE (external-runtime
  // self-managed skills, or any future null reason) — render the reason, NEVER a fake 读到 0/0.
  // [] stays the normal path: knowable and empty.
  if (rc.bySkill == null) {
    return {
      unknown: true, reason: rc.reason ?? null, inventoryStatus: rc.inventoryStatus ?? null,
      shipped: null, read: null, bySkill: null, unreadRefs: [], readCounts: rc.readCounts ?? {},
      outOfInventoryReads: null, // no inventory at all → "outside the inventory" is unknowable, not 0
      exemptions: {
        artifactOnly: { refs: rc.artifactOnlyRefs ?? [], hint: '被权限拒绝、读不到，不算死重（内部名 permission-artifact）' },
        excludedOnly: { refs: rc.excludedOnlyRefs ?? [], hint: '只在被排除的运行里读过，不算数（内部名 excluded-only）' },
        notExercised: { skills: [], hint: '所属 skill 从未触发，没得到出场机会（内部名 not-exercised）' },
      },
    };
  }
  const bySkill = rc.bySkill ?? [];
  // none-backfill rows carry shipped:null (清单不可知) — the aggregate denominator is then null too,
  // never a summed-over-nulls 0 (null-not-zero).
  // none-backfill 的清单不可知是整体性质，不依赖行数：bySkill=[]（纯 _shared 读取无可反推行）时
  // every() 空真会把分母折成 0——分母必须取 null（null-not-zero），且观测到的 _shared 读取要计入分子。
  // Stage 4 (F-2-23): the knowable-denominator statuses are snapshot AND adapter-declared — a
  // declared inventory IS a denominator (unverified; the panel badge discloses that). A legacy
  // stats blob without inventoryStatus stays on the snapshot path. Everything else (none-backfill)
  // keeps the 清单不可知 handling: _shared reads counted separately, aggregate denominator null.
  const declaredInventory = rc.inventoryStatus === 'adapter-declared';
  const denomKnowable = rc.inventoryStatus == null || rc.inventoryStatus === 'snapshot' || declaredInventory;
  const shippedKnown = denomKnowable && bySkill.every((s) => s.shipped != null);
  const shipped = shippedKnown ? bySkill.reduce((a, s) => a + (s.shipped ?? 0), 0) : null;
  // 宣告制无 _shared 语义 (F-2-13): the _shared bucket belongs ONLY to the unknowable-denominator
  // path (none-backfill) — an adapter-declared _shared-looking key is just an out-of-inventory ref.
  const sharedReads = !denomKnowable
    ? Object.keys(rc.readCounts ?? {}).filter((k) => k.startsWith('_shared/')).length : 0;
  const read = bySkill.reduce((a, s) => a + (s.read ?? 0), 0) + sharedReads;
  // 清单外自报读取 (F-2-23): observed reads whose plaintext ref sits on NO inventory row — only
  // meaningful when the declared list is the denominator. Exposed as its OWN count (另有 k 笔
  // 清单外读取（自报）), never silently folded into read/shipped.
  let outOfInventoryReads = 0;
  if (declaredInventory) {
    const inInventory = new Set(bySkill.flatMap((s) => (s.refs ?? []).map((r) => r.ref)));
    outOfInventoryReads = Object.keys(rc.readCounts ?? {}).filter((k) => !inInventory.has(k)).length;
  }
  const unreadRefs = bySkill.flatMap((s) => (s.unreadRefs ?? []).map((r) => ({ ref: r, skill: s.skill })));
  return {
    shipped, read, bySkill, sharedReads, outOfInventoryReads,
    unknown: false, reason: rc.reason ?? null, inventoryStatus: rc.inventoryStatus ?? null,
    unreadRefs,
    readCounts: rc.readCounts ?? {},
    exemptions: {
      artifactOnly: { refs: rc.artifactOnlyRefs ?? [], hint: '被权限拒绝、读不到，不算死重（内部名 permission-artifact）' },
      excludedOnly: { refs: rc.excludedOnlyRefs ?? [], hint: '只在被排除的运行里读过，不算数（内部名 excluded-only）' },
      notExercised: { skills: bySkill.filter((s) => s.notExercised).map((s) => s.skill), hint: '所属 skill 从未触发，没得到出场机会（内部名 not-exercised）' },
    },
  };
}

// M3-M5 probe summary for the experiment card. THREE-state: probes === null → 未配置外部工具探针; an
// array → per-tool coverage + hypothesis sequence cards. Sequences are ALWAYS 未验证假说 (no adopt).
export function expProbeView(stats) {
  const cli = stats?.probes;
  if (cli == null) return { configured: false, tools: [] };
  return {
    configured: true,
    tools: (cli ?? []).map((t) => ({
      tool: t.tool,
      coverage: t.coverage ?? null,
      coverageStatus: blockStatusBadge(t.coverage?.status),
      bySkill: (t.bySkill ?? []).map((b) => ({ ...b, statusBadge: blockStatusBadge(b.status) })),
      sequences: (t.sequences ?? []).map((s) => ({ ...s, hypothesis: true })),   // 未验证假说
      warnings: t.warnings ?? [],
    })),
  };
}

// M7 proximity summary for the experiment card — top-k directed edges (时序邻近，非因果).
export function expProximityView(stats, { topK = 8 } = {}) {
  const p = stats?.proximity;
  if (!p || !(p.edges ?? []).length) return null;
  const topEdges = [...(p.edges ?? [])]
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || (b.closeness ?? 0) - (a.closeness ?? 0))
    .slice(0, topK);
  return { n: p.n ?? 0, topEdges };
}

// ---- §S v2 per-skill expansion rows (design B1 refs 行 + B6 miss 清单) --------------------------
// One row per skill that either has a trigger rate (targeted) or a ref inventory entry. Ratios are
// carried as {x, y} pairs — the renderer prints x/y and turns a 0 denominator into —, never a fake %.
export function expSkillDetailRows(stats) {
  const sc = stats?.skillCoverage;
  if (!sc) return [];
  if ((stats?.schemaVersion ?? 1) < 2) return []; // v1 embedded → the card carries the upgrade hint instead
  const everCases = new Map((sc.everTriggered ?? []).map((e) => [e.skill, e.cases ?? 0]));
  const rc = stats?.refCoverage ?? {};
  const bySkillRows = new Map((rc.bySkill ?? []).map((s) => [s.skill, s]));
  const skills = [...new Set([...(sc.triggerRate ?? []).map((r) => r.skill), ...bySkillRows.keys()])].sort();
  return skills.map((skill) => {
    const tr = (sc.triggerRate ?? []).find((r) => r.skill === skill) ?? null;
    const ever = everCases.get(skill) ?? 0;
    // refs 行 (B1): readRateCoTriggered = casesCoTriggered / everTriggered distinct cases — both
    // case-granular, numerator a subset → x ≤ y by engine construction. y=0 renders as —.
    let refs = null, refsNote = null;
    if (rc.bySkill == null) {
      refsNote = rc.reason ?? 'external-runtime-self-managed';
    } else {
      const bs = bySkillRows.get(skill);
      if (bs?.refs) {
        refs = bs.refs.map((r) => ({
          ref: r.ref, bytes: r.bytes ?? null, reason: r.reason ?? null,
          readsCases: r.readsCases ?? 0,
          readRateCoTriggered: { x: r.casesCoTriggered ?? 0, y: ever },
          blocked: r.blocked === true,
        }));
      } else if (rc.inventoryStatus === 'none-backfill') {
        refsNote = 'no-inventory-snapshot'; // backfill only infers OBSERVED reads; none observed here
      } else if (rc.inventoryStatus === 'adapter-declared') {
        refsNote = 'adapter-declared'; // skill triggered but absent from the DECLARED inventory → no row to join, say so
      }
    }
    // B6 miss list: only when triggerRate < 1. firedInstead three-state passthrough — array =
    // knowable (可为空), null = no valid run → 无 session 可判. rate<1 with NO triggered=0 case =
    // every miss was rep-level partial triggering → explicit note, never a silently empty list.
    let misses = null, missNote = null;
    if (tr && tr.attempted > 0 && tr.triggered < tr.attempted) {
      const cj = sc.caseJoin?.[skill];
      if (cj) {
        const rows = (cj.cases ?? []).filter((c) => (c.triggered ?? 0) === 0)
          .map((c) => ({ caseId: c.caseId, firedInstead: c.firedInstead ?? null }));
        if (rows.length) misses = rows;
        else missNote = 'partial-trigger-only'; // miss 均为部分触发（同题其他 rep 已命中），无整题落空
      }
    }
    return {
      skill,
      trigger: tr ? { triggered: tr.triggered ?? 0, attempted: tr.attempted ?? 0 } : null,
      everTriggeredCases: ever,
      refs, refsNote, misses, missNote,
    };
  });
}

// The whole experiment statistics card. `legacy` → just the backfill hint. `error` → the seal-time
// failure string (统计计算失败), never a full card over an empty shape. `full` → sample-size
// breakdown (nCoverageValid ≠ the scorecard's n, spelled out), M1, M2, cli/proximity when present,
// plus the resolver-driven authority badge / warnings / sidecarIgnored note and §S v2 skill details.
export function buildExpStatsCard(experiment) {
  const state = expStatsState(experiment);
  const warnings = experiment?.statsWarnings ?? [];
  if (state === EXP_STATS_STATE.LEGACY) {
    return { state, warnings, backfillHint: '这是旧实验，还没有统计数据——可运行 aiide stats 回填' };
  }
  if (state === EXP_STATS_STATE.ERROR) {
    return { state, warnings, error: String(experiment?.stats?.error ?? experiment?.statsError ?? '') };
  }
  const stats = experiment.stats;
  const legacySchema = (stats.schemaVersion ?? 1) < 2;
  // taxonomy §3.0 supplemental — resolver-supplied NEW-schema sections recomputed alongside a stale
  // embedded blob. Rendered as its OWN block under the 回填（非权威） badge; NEVER merged into the
  // authoritative stats object (the views below are built from `stats` untouched).
  const supplemental = experiment.supplemental ?? null;
  const staleSchema = (stats.schemaVersion ?? 1) < CURRENT_STATS_SCHEMA_VERSION;
  return {
    state,
    authority: experiment.statsAuthority ?? null,
    authorityBadge: statsAuthorityBadge(experiment.statsAuthority),
    warnings,
    sidecarIgnored: experiment.sidecarIgnored === true,
    legacySchema,
    supplementalSections: supplemental?.sections ?? null,
    supplementalBadge: supplemental ? statsAuthorityBadge(supplemental.authority) : null,
    supplementalSchema: supplemental
      ? { from: supplemental.schemaVersionFrom ?? null, to: supplemental.schemaVersionTo ?? null } : null,
    // stale embedded schema (v1 OR v2, missing field ≡ 1) → the REAL upgrade path (taxonomy §3.0
    // r4 F-4-03): plain `aiide stats <id> --write` recomputes a non-authoritative sidecar whose
    // NEW top-level sections ride alongside — the sealed numbers never change. Once a supplemental
    // is already on screen the hint would be stale advice → suppressed. (v1's v2-level IN-SECTION
    // upgrades — caseJoin/refs — are NOT covered by this path; they need a rerun.)
    upgradeHint: staleSchema && !supplemental
      ? `旧 schema（v${stats.schemaVersion ?? 1}）——新增统计节可补算：aiide stats ${experiment.id ?? '<id>'} --write（非权威并列，封存数字不变）`
      : null,
    skillDetails: expSkillDetailRows(stats),
    schemaVersion: stats.schemaVersion ?? null,
    // Stage 4: experiment-level provenance (§2) + its badge — null passes through as null/no-badge
    provenance: stats.provenance ?? null,
    provenanceBadge: statsProvenanceBadge(stats.provenance),
    sampleSize: {
      // nCoverageValid is the coverage denominator; it is NOT the scorecard's n (which counts C=0
      // timeout failures IN). Spelled out so the two numbers never read as the same thing.
      nCoverageValid: stats.nCoverageValid ?? 0,
      nRaw: stats.nRaw ?? 0,
      breakdown: {
        valid: stats.nCoverageValid ?? 0, excluded: stats.nExcluded ?? 0,
        heldOut: stats.heldOutExcluded ?? 0, noSession: stats.noSession ?? 0, unresolved: stats.nUnresolved ?? 0,
      },
      note: '这是统计口径的有效样本（nCoverageValid），和记分卡的 n 不是一回事——记分卡把超时失败也算进 n',
    },
    skillCoverage: expSkillCoverageView(stats),
    refCoverage: expRefCoverageView(stats),
    probes: expProbeView(stats),
    proximity: expProximityView(stats),
  };
}

// ---- upgrade view: external-tool probe-signal block (design §2.4) -----------------------------
// Pure view model over report.probes (probeBlocksToReport output). null = no probe in this upgrade.
// tripwired → the block verdict is inconclusive (absolutes still shown). sequence cards are always
// 未验证假说 with NO adopt affordance; excludedProbeHits surface as explicit warnings.
export function buildProbeBlockView(cli) {
  if (!cli) return null;
  return {
    status: cli.status ?? 'ok',
    tripwired: cli.tripwired === true,
    paired: cli.paired ?? null,
    arms: (cli.arms ?? []).map((a) => ({
      arm: a.arm,
      tools: (a.tools ?? []).map((t) => ({ ...t, coverageStatus: blockStatusBadge(t.coverage?.status) })),
      proximityTop: (a.proximity?.topEdges ?? []),
    })),
    deltas: cli.deltas ?? [],
    notComparable: cli.notComparable ?? [],
    warnings: cli.warnings ?? [],
    sequences: (cli.arms ?? []).flatMap((a) => (a.tools ?? []).flatMap((t) =>
      (t.sequences ?? []).map((s) => ({ arm: a.arm, tool: t.tool, ...s, hypothesis: true })))),
  };
}

// ---- taxonomy T1 Stage 6: v3 section view models (§3.1/§3.2/§3.4/§3.5) -------------------------
// Pure view models over the eight schemaVersion-3 stats sections. Each takes
// `(section, { nonAuthoritative })` — the SECTION may come from embedded v3 stats or from the
// resolver's supplemental.sections (taxonomy §3.0); the CALLER decides the source and passes the
// honesty flag, the view model just carries it through so the renderer can pin the 回填（非权威）
// badge on supplemental-sourced segments. Honesty discipline:
//   • null-not-zero: a `{ value: null, reason }` section renders as { null:true, reasonCopy } —
//     an honest reason line, never a blank and never a fabricated 0.
//   • estimate 恒标: contextComposition is chars/4-estimated end to end — the flag rides through.
//   • dual-layer copy: zh-hans main sentence + the canonical term in a trailing 括号.
//   • §3.1 copy ban: contextComposition is INCREMENTAL ATTRIBUTION, not a cost view — its copy
//     never says 成本 / 花在 (test-pinned over the whole serialized view model).

// §3.0 null-trigger table → zh-hans reason copy (exported so the renderer and tests share one map).
export const NULL_REASON_COPY = {
  'no-user-events-channel': '外部 runtime 无 userEvents 通道，无法归因',
  'untagged-legacy-run': '旧版解析产物无来源标记（需重新 ingest 或新实验）',
  'no-cwd': '无工作目录记录（外部 runtime）',
  'no-stop-reason': '无 stop reason 记录',
  'no-result-lines': '无 runtime 自报成本行（result 行）',
  'no-sidechain-channel': '外部 runtime 无子代理通道',
  'no-usage': '无 token 用量上报',
  'no-valid-runs': '无有效样本',
  'no-aggregatable-runs': '无可聚合样本',
};
export function nullReasonCopy(reason) {
  return NULL_REASON_COPY[reason] ?? `不可知（${reason ?? 'unknown'}）`;
}

// Shared null-form guard. A v3 null section is `{ value: null, reason, …disclosures }` (expstats
// nullSection); a non-null section never carries a `value` key, so `section.value === null`
// discriminates exactly. Extra disclosure counts ride along untouched for the renderer.
const isNullSection = (s) => s != null && s.value === null && 'value' in s;
function nullSectionView(section, nonAuthoritative) {
  const { value: _v, reason, ...disclosures } = section;
  return {
    null: true,
    reason: reason ?? null,
    reasonCopy: nullReasonCopy(reason),
    nonAuthoritative: nonAuthoritative === true,
    disclosures,
  };
}

// §3.1 contextComposition. Title is MANDATED copy (增量归因非成本 — taxonomy §3.1 copy ban).
export const CONTEXT_COMPOSITION_TITLE = 'context 由什么组成（增量归因，估算）';
export const CONTEXT_BUCKET_LABELS = {
  baseline: '首轮基线（firstRoundBaseline）',
  prevOut: '上轮输出（prevOut，精确）',
  toolRes: '工具结果（toolRes，估算）',
  injectedUser: '用户注入（injectedUser，估算）',
  injectedHarness: 'harness 注入（injectedHarness，估算）',
  skillBody: 'skill 正文（skillBody，估算）',
  residualPos: '未归因正残差（residualPos，含 cache 位移）',
};
export function contextCompositionView(section, { nonAuthoritative = false } = {}) {
  if (section == null) return null; // section absent (v2 embedded, no supplemental) → card omits it
  if (isNullSection(section)) return nullSectionView(section, nonAuthoritative);
  // Buckets aggregate as SHARE distributions (§3.1 denominator = baseline + Σ positive buckets, so
  // shares sum to 100% by construction). The engine deliberately does NOT aggregate per-bucket
  // absolutes — the view never fabricates them (share.mean × some denominator would be wrong math);
  // the absolute quantities it DOES expose are the engine's own: compaction absolute + peak footprint.
  const rows = Object.keys(CONTEXT_BUCKET_LABELS).map((key) => ({
    key, label: CONTEXT_BUCKET_LABELS[key], share: section.shares?.[key] ?? null,
  }));
  const cp = section.compaction ?? {};
  return {
    null: false,
    nonAuthoritative: nonAuthoritative === true,
    title: CONTEXT_COMPOSITION_TITLE,
    estimate: section.estimate === true, // chars/4 buckets — the whole section stays flagged
    n: section.n ?? 0,
    // skip disclosures (§3.0): untagged legacy runs / zero-footprint runs / zero-footprint rounds
    untaggedLegacyRuns: section.untaggedLegacyRuns ?? 0,
    zeroFootprintRuns: section.zeroFootprintRuns ?? 0,
    skippedRounds: section.skippedRounds ?? 0,
    rows,
    // compaction is an INDEPENDENT row — never one of the share buckets, never netted (§3.1)
    compaction: {
      label: '压缩回收（compaction，独立披露——绝不与正桶净加总）',
      runsWithCompaction: cp.runsWithCompaction ?? 0,
      absolute: cp.absolute ?? null,               // {mean,min,max} tokens
      shareOfDenominator: cp.shareOfDenominator ?? null,
    },
    peakFootprint: section.peakFootprint ?? null,   // {mean,min,max} — final main-round footprint
    maxContribution: section.maxContribution ?? null, // { runId, denominator }
  };
}

// §3.2 toolUsage — byKind main/sidechain split, mcp-server table, top tools, classification source.
export const TOOL_USAGE_TITLE = '工具使用（toolUsage）';
export const TOOL_KIND_ORDER = ['skill', 'agent', 'mcp', 'builtin', 'other'];
export function toolUsageView(section, { nonAuthoritative = false } = {}) {
  if (section == null) return null;
  if (isNullSection(section)) return nullSectionView(section, nonAuthoritative);
  const byKind = TOOL_KIND_ORDER.map((kind) => {
    const b = section.byKind?.[kind] ?? {};
    const main = b.main ?? 0, sidechain = b.sidechain ?? 0;
    return { kind, main, sidechain, total: main + sidechain };
  });
  return {
    null: false,
    nonAuthoritative: nonAuthoritative === true,
    title: TOOL_USAGE_TITLE,
    byKind,
    scope: { main: section.scope?.main ?? 0, sidechain: section.scope?.sidechain ?? 0 },
    scopeNote: '仅本节计入子代理（sidechain）轮；触发/截断/关联统计均只看主轮（main rounds only）',
    kindSource: { declared: section.kindSource?.declared ?? 0, inferred: section.kindSource?.inferred ?? 0 },
    kindSourceNote: '分类来源：自报（declared）优先，其余按名字推断（inferred）',
    allowlistVersion: section.allowlistVersion ?? null,
    allowlistNote: 'builtin/other 边界随 aiide 版本演化（allowlistVersion），跨版本对比需对齐',
    mcpServers: Object.entries(section.byMcpServer ?? {})
      .map(([server, m]) => ({ server, calls: m.calls ?? 0, errors: m.errors ?? 0, denials: m.denials ?? 0 })),
    topTools: section.topTools ?? [],
  };
}

// §3.4 fileTargets — read/write三桶 + pathless disclosure; folded into the 工具使用 segment by the card.
export const FILE_TARGETS_TITLE = '文件目标分布（fileTargets）';
export const FILE_TARGET_BUCKET_LABELS = {
  skillRefs: 'skill 参考文档（skill-refs）',
  workspace: '工作区（workspace）',
  otherAbsolute: '其他绝对路径（other-absolute）',
};
export function fileTargetsView(section, { nonAuthoritative = false } = {}) {
  if (section == null) return null;
  if (isNullSection(section)) return nullSectionView(section, nonAuthoritative);
  const side = (b) => ({
    rows: Object.keys(FILE_TARGET_BUCKET_LABELS).map((key) => ({
      key, label: FILE_TARGET_BUCKET_LABELS[key], count: b?.[key] ?? 0,
    })),
    pathless: b?.pathless ?? 0, // disclosed, NEVER bucketed (§3.4)
  });
  return {
    null: false,
    nonAuthoritative: nonAuthoritative === true,
    title: FILE_TARGETS_TITLE,
    n: section.n ?? 0,
    noCwdRuns: section.noCwdRuns ?? 0,
    reads: side(section.reads),
    writes: side(section.writes),
    pathlessNote: '无路径参数的调用（pathless）单独披露，不入三桶',
  };
}

// §3.5 run-health aggregate card: cacheHitRate / truncation / sidechainShare / selfReport /
// statsHealth — one card, five segments, EACH segment carries its own null reason (a null cache
// section must not blank the truncation segment). `sections` = { cacheHitRate, truncation,
// sidechainShare, selfReport, statsHealth } (any may be absent → that segment is null and the
// renderer omits it). opts.estimatedCostUsd: caller-computed harness estimate juxtaposed against
// the self-reported Σ (different calibers — the note spells that out, they are never merged).
export const RUN_HEALTH_TITLE = '运行健康（cacheHitRate · truncation · sidechainShare · selfReport · statsHealth）';
export function runHealthView(sections = {}, { nonAuthoritative = false, estimatedCostUsd = null } = {}) {
  const nonAuth = nonAuthoritative === true;
  const seg = (section, build) => {
    if (section == null) return null;                       // section absent → segment omitted
    if (isNullSection(section)) return nullSectionView(section, nonAuth); // honest reason line
    return { null: false, nonAuthoritative: nonAuth, ...build(section) };
  };
  const cache = seg(sections.cacheHitRate, (s) => ({
    label: 'cache 命中率（cacheHitRate，逐轮 cacheR/footprint）',
    n: s.n ?? 0, skippedRounds: s.skippedRounds ?? 0,
    mean: s.mean ?? null, min: s.min ?? null, max: s.max ?? null,
    byRepeat: s.byRepeat ?? [], // repeat-order warm-up table — descriptive, not causal
    byRepeatNote: '按 repeat 序的暖化描述表（时序描述，非因果）',
  }));
  const truncation = seg(sections.truncation, (s) => ({
    label: '输出截断（truncation，stopReason=max_tokens）',
    rounds: s.rounds ?? 0,
    truncatedRoundShare: s.truncatedRoundShare ?? null,
    finalRoundTruncated: s.finalRoundTruncated ?? null, // { runs, n, share|null } — 0/0 stays null
    unknownStopReason: s.unknownStopReason ?? 0,        // null-stopReason rounds: disclosed, never "未截断"
    unknownFinalRuns: s.unknownFinalRuns ?? 0,
    byReason: Object.entries(s.byReason ?? {}).map(([reason, count]) => ({ reason, count })),
    unknownNote: '无 stop reason 的轮不入分母（未知不是未截断）',
  }));
  const sidechain = seg(sections.sidechainShare, (s) => ({
    label: '子代理份额（sidechainShare）',
    n: s.n ?? 0, runsWithSidechain: s.runsWithSidechain ?? 0,
    tokens: s.tokens ?? null, toolCalls: s.toolCalls ?? null, equivTokens: s.equivTokens ?? null,
    equivNote: '开销量级份额以 equivTokens 计（恒定权重，非计价），share 为 null 时表示 0/0 不可知',
  }));
  const selfReport = seg(sections.selfReport, (s) => ({
    label: '自报成本（selfReport，runtime result 行 Σ）',
    runsWithSelfReport: s.runsWithSelfReport ?? 0,
    invocations: s.invocations ?? 0,
    totalCostUsd: s.total_cost_usd ?? null,
    numTurns: s.num_turns ?? null,
    durationMs: s.duration_ms ?? null,
    isError: s.is_error ?? null,
    estimatedCostUsd: estimatedCostUsd ?? null, // juxtaposed harness estimate — flagged, never merged
    caliberNote: '自报 = runtime result 行逐次累加；估算 = harness 计价估算，两者口径不同，仅并列参考（估算恒标）',
  }));
  const statsHealth = seg(sections.statsHealth, (s) => ({
    label: '观测管线健康（statsHealth）',
    exclusions: Object.entries(s.exclusionBreakdown ?? {}).map(([signature, count]) => ({ signature, count })),
    abortedAtStep: Object.entries(s.abortedAtStep ?? {}).map(([step, count]) => ({ step, count })),
    parseWarningsTotal: s.parseWarningsTotal ?? 0,
    timeoutRate: s.timeoutRate ?? null, // { timedOut, n, rate|null, legacyUnknown }
    timeoutLegacyNote: '旧实验缺结构化超时字段的 rep 计入 legacyUnknown，不入分母（绝不用 error 字串回填）',
    retriedThenSucceeded: s.retriedThenSucceeded ?? 0,
    verifierFails: s.verifierFails ?? [], // top-10 most-red verifiers
  }));
  const segments = { cache, truncation, sidechain, selfReport, statsHealth };
  return {
    title: RUN_HEALTH_TITLE,
    nonAuthoritative: nonAuth,
    ...segments,
    empty: Object.values(segments).every((x) => x == null),
  };
}

// ---- adapter observability Wave 2 Stage 1: runtime 自述（runtime_info, design §4） ---------------
// Pure view models over `experiment.environment.runtimeInfo` / `.runtimeInfoDrift`. Honesty
// discipline (§4 「看效果」诚实框架):
//   • null-not-zero: an absent self-description renders an HONEST PLACEHOLDER, never a blank —
//     and a side that did not self-describe its tools yields `unknown`, never a fabricated
//     empty added/removed set.
//   • fingerprint disclosure: textCaptured → the prompt text was archived by the harness
//     (recomputed sha, verifiable); otherwise the fingerprint is SELF-REPORTED and says so.
//   • tokensEst is ALWAYS flagged as an estimate (估算恒标).
//   • the diff view model carries the mandated concurrent-factors framing sentence and NEVER
//     any causal wording (导致/因此/因为 test-banned over the serialized output).

export const RUNTIME_INFO_ABSENT = 'runtime 未提供自述（no runtime_info）';
export const RUNTIME_INFO_DRIFT_NOTE = '多次重复间自述不一致（drift）';
export const SYSTEM_PROMPT_ARCHIVED = '全文已存档（logs/runtime-info）';
export const SYSTEM_PROMPT_SELF_REPORTED = '自报指纹（未经 harness 重算核验）';
// present-but-partial descriptor: each missing DIMENSION gets its own honest placeholder line
export const RUNTIME_INFO_FIELD_ABSENT = {
  systemPrompt: '未自述 system prompt（not reported）',
  tools: '未自述工具清单（not reported）',
  defaults: '未自述默认参数（not reported）',
};

// Environment card view model. `env` = experiment.environment. No runtimeInfo at all (claude-code
// only carries `runtimeVersion` — the runtime_info channel is adapter-only) → present:false with
// the honest placeholder; the environment-level version still rides along so the ONE dimension
// claude-code does have is not blanked.
export function runtimeInfoView(env) {
  const digests = [...new Set(env?.runtimeInfoDrift?.digests ?? [])];
  const drift = digests.length > 1;
  const ri = env?.runtimeInfo ?? null;
  if (ri == null) {
    return {
      present: false,
      placeholder: RUNTIME_INFO_ABSENT,
      version: env?.runtimeVersion != null ? String(env.runtimeVersion) : null,
      drift: false, driftNote: null, driftDigests: [],
    };
  }
  const sp = ri.systemPrompt ?? null;
  const systemPrompt = sp == null ? null : {
    sha256: sp.sha256 ?? null,
    shaShort: sp.sha256 ? String(sp.sha256).slice(0, 12) : null,
    bytes: sp.bytes ?? null,
    tokensEst: sp.tokensEst ?? null,
    estimate: true, // tokensEst 恒标 estimate — tokensEstCJK, 非中文偏差大
    // textCaptured → harness archived the full text + recomputed the fingerprint (verifiable);
    // anything else is the runtime's own claim → disclosed as self-reported, never silently trusted
    badge: sp.textCaptured === true
      ? { word: SYSTEM_PROMPT_ARCHIVED, tone: 'ok', kind: 'text-captured' }
      : { word: SYSTEM_PROMPT_SELF_REPORTED, tone: 'warn', kind: 'self-reported' },
  };
  return {
    present: true,
    name: ri.name ?? null,
    version: ri.version != null ? String(ri.version) : null,
    systemPrompt,                                   // null → renderer prints FIELD_ABSENT.systemPrompt
    tools: Array.isArray(ri.tools)
      ? ri.tools.map((t) => ({ name: t?.name ?? '', kind: t?.kind ?? null })) : null, // null → 未自述
    defaults: ri.defaults ?? null,                  // 原样 passthrough — null → 未自述
    drift,
    driftNote: drift ? RUNTIME_INFO_DRIFT_NOTE : null,
    driftDigests: digests,
  };
}

// §4 mandated framing — descriptor diff and metric deltas are JUXTAPOSED, never causally linked.
export const CONCURRENT_FACTORS_FRAMING =
  '以下为同期变更的环境因素（concurrent factors）——差异与指标变化并列呈现，不构成因果归因';
export const RUNTIME_INFO_DIFF_ABSENT = '无 runtime 自述';

// Descriptor diff view model for the compare view. Neither side self-describes → null (nothing to
// diff — each side's absence already shows on its own environment card). One side missing →
// { oneSided:true, side } where `side` names the side WITHOUT runtime_info ('A'|'B'); the present
// side's card view rides along. Both present → per-dimension diff rows; a dimension only one side
// reported stays honest: tools go `unknown` (never a fake add/remove), sha compares null-aware.
export function runtimeInfoDiff(envA, envB) {
  const a = envA?.runtimeInfo ?? null, b = envB?.runtimeInfo ?? null;
  if (a == null && b == null) return null;
  if (a == null || b == null) {
    return {
      oneSided: true,
      side: a == null ? 'A' : 'B',
      placeholder: RUNTIME_INFO_DIFF_ABSENT,
      framing: CONCURRENT_FACTORS_FRAMING,
      present: runtimeInfoView(a == null ? envB : envA), // the side that DID self-describe
    };
  }
  const spA = a.systemPrompt ?? null, spB = b.systemPrompt ?? null;
  let systemPrompt = null;
  if (spA != null || spB != null) {
    const shaA = spA?.sha256 ?? null, shaB = spB?.sha256 ?? null;
    systemPrompt = {
      shaA, shaB,
      shaShortA: shaA ? String(shaA).slice(0, 12) : null,
      shaShortB: shaB ? String(shaB).slice(0, 12) : null,
      changed: shaA !== shaB,
      bytesA: spA?.bytes ?? null, bytesB: spB?.bytes ?? null,
      // Δ only when both sides carry bytes — a delta against null would fabricate a number
      bytesDelta: spA?.bytes != null && spB?.bytes != null ? spB.bytes - spA.bytes : null,
    };
  }
  let tools;
  if (Array.isArray(a.tools) && Array.isArray(b.tools)) {
    const namesA = new Set(a.tools.map((t) => t?.name)), namesB = new Set(b.tools.map((t) => t?.name));
    tools = {
      unknown: false,
      added: b.tools.filter((t) => !namesA.has(t?.name)).map((t) => t?.name ?? ''),
      removed: a.tools.filter((t) => !namesB.has(t?.name)).map((t) => t?.name ?? ''),
      unchanged: a.tools.filter((t) => namesB.has(t?.name)).map((t) => t?.name ?? ''),
    };
  } else {
    // at least one side did not self-describe its tool list → add/remove is UNKNOWABLE (null-not-zero)
    tools = { unknown: true, added: null, removed: null, unchanged: null };
  }
  const dim = (va, vb) => ({ a: va ?? null, b: vb ?? null, changed: (va ?? null) !== (vb ?? null) });
  return {
    oneSided: false,
    framing: CONCURRENT_FACTORS_FRAMING,
    name: dim(a.name, b.name),
    version: dim(a.version != null ? String(a.version) : null, b.version != null ? String(b.version) : null),
    systemPrompt,      // null when NEITHER side has one
    tools,
  };
}

// Plain-language glossary for the NEW dashboard statistics/cli strings (single source, mirrors the
// U7 report GLOSSARY). Main sentence is jargon-free; the original term rides in a trailing 括号.
export const EXP_GLOSSARY = {
  coverage: '跑过的题目里，某个能力真正被用到的比例（内部名 覆盖率）',
  cliSink: '能让命令行工具自己做的事就交给它，一条命令能做完的别拆成多条（策略名 cli 下沉）',
  commandSurface: '一个外部工具对外提供的全部子命令的集合（内部名 命令面）',
  cooccur: '同一次运行里两样东西一起出现，只说明相关、不代表谁导致谁（统计名 共现）',
  proximityStrength: '两样东西在操作序列里挨得多近、多常一前一后出现——只是时序邻近，不是因果（内部名 关联强度）',
  neverTriggered: '有题目考这个 skill，它却从未触发（可能真没用上）',
  notExercised: '没有任何题目考这个 skill——没给机会，不是死重',
  nCoverageValid: '统计口径下的有效样本数；和记分卡的 n 不一样，记分卡把超时失败也算进去',
  hypothesisSeq: '从数据里猜出来的命令连发模式，参数已被抹去、无法保证针对同一目标，需人工确认',
};
