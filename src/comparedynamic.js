// Dynamic compare report — build a full upgrade report on the fly from two SEALED experiments of the
// same suite, without running `aiide upgrade`. The bridge is experimentToArm: the experiment scorecard
// (C + the Phase-1 l1Pass/l3Pass) maps onto the upgrade arm's L1/L2/L3 shape, so buildComparison /
// buildReportJson run verbatim. Pairing is per-task (MIN_PAIRS=8 gates on the number of shared tasks);
// depgraph reuses each experiment's Part-D stats.depgraph; S7 probes reuse stats.probes.
//
// Honesty: L2 = correctness (C); L1/L3 are real only for tasks whose suite declared an expected skill /
// a confirm gate — otherwise null → the axis reads n/a (never fabricated). Fewer than MIN_PAIRS shared
// tasks → decideVerdict returns insufficient-data. Nothing is written to disk (pure, in-memory).
import { buildComparison, buildReportJson, depgraphToCharts } from './report.js';
import { depgraphReport } from './depgraph.js';
import { UPGRADE_CONFIG } from './upgradeConfig.js';

const round3 = (x) => (x == null ? null : Math.round(x * 1e3) / 1e3);

// Union each case's per-session triggerSet/readSet (stats.depgraphSessions) → the S5 regressed-card
// trigger/read-diff source. Absent (legacy stats without depgraphSessions) → empty map → S5 detail
// stays blank (honest: the top-level pass/fail diff still renders, just no trigger/read drill-down).
function caseDetailFromSessions(sessions) {
  const byCase = new Map();
  for (const ev of Array.isArray(sessions) ? sessions : []) {
    const id = ev.caseId;
    if (id == null) continue;
    if (!byCase.has(id)) byCase.set(id, { trig: new Set(), reads: new Map() });
    const rec = byCase.get(id);
    for (const s of ev.triggerSet ?? []) rec.trig.add(s);
    for (const r of ev.readSet ?? []) {
      const key = r?.logicalRef ?? (typeof r === 'string' ? r : null);
      if (key != null && !rec.reads.has(key)) rec.reads.set(key, r);
    }
  }
  return byCase;
}
// case-level L2/L3 label from the case's own repeats — 'pass'/'fail'/null (never fabricated).
function layerLabel(repeats, key) {
  const vals = repeats.map((r) => r[key]).filter((v) => v != null);
  if (!vals.length) return null;
  return vals.filter((v) => v === true).length >= vals.length / 2 ? 'pass' : 'fail';
}

// Map one sealed experiment to an upgrade "arm". held-out tasks never enter a comparison.
export function experimentToArm(exp) {
  const env = exp.environment ?? {};
  // Skill routing needs a skill substrate. An external/adapter runtime (okx via MCP) copies no skills
  // into a profile → env.skills is empty → it has no Skill mechanism to route with. Older sealed
  // experiments may still carry l1Pass=false (graded 'missed' before the lab.js source guard landed);
  // retroactively fold those to null here so L1 reads "n/a" instead of slandering the runtime with 0%.
  const skillRouting = (env.skills ?? []).length > 0;
  const caseDetail = caseDetailFromSessions(exp.stats?.depgraphSessions);   // S5 trigger/read source
  const cases = {};
  for (const [id, tk] of Object.entries(exp.tasks ?? {})) {
    if (tk.held_out === true) continue;
    const repeats = (tk.repeats ?? []).map((r) => ({
      l1Pass: skillRouting ? (r.l1Pass ?? null) : null, // Phase 1: routing verdict (null when no expected skill / no skill substrate)
      l2Pass: r.excluded === true ? null : r.C === 1, // L2 = correctness (the experiment's own C)
      l3Pass: r.l3Pass ?? null,                    // Phase 1: safety verdict (null when no confirm gate)
      rounds: r.rounds ?? 0,
      usage: {
        in: r.efficiency?.tokens?.in ?? 0, out: r.efficiency?.tokens?.out ?? 0,
        cacheR: r.efficiency?.tokens?.cacheR ?? 0, cacheW: r.efficiency?.tokens?.cacheW ?? 0,
      },
      durationMs: r.efficiency?.durationMs ?? r.efficiency?.wallMs ?? 0,
      excluded: r.excluded === true,
      flowStatus: r.flowStatus ?? 'complete',
      l3Heuristic: false,
      permissionArtifact: r.routing === 'permission-artifact',
    }));
    // S5 case-level detail — triggerSet/readSet unioned across the case's sessions (regressed-card
    // trigger/read diff); l2Result/l3Final derived from this case's repeats; transcript = the
    // representative answer; logPath = its runId (dashboard #run/<id> deep link). All null-safe.
    const det = caseDetail.get(id);
    const rep0 = (tk.repeats ?? []).find((r) => r.excluded !== true) ?? (tk.repeats ?? [])[0] ?? {};
    cases[id] = {
      skill: tk.expected_skill ?? null,
      category: tk.category ?? 'uncategorized',
      prompt: tk.prompt ?? '',
      repeats,
      triggerSet: det ? [...det.trig] : [],
      readSet: det ? [...det.reads.values()] : [],
      l2Result: layerLabel(repeats, 'l2Pass'),
      l3Final: layerLabel(repeats, 'l3Pass'),
      transcript: rep0.resultPreview ?? null,
      logPath: rep0.runId ?? null,
    };
  }
  return {
    label: exp.suiteName ?? exp.id ?? 'arm',
    cliVersion: env.aiideVersion != null ? String(env.aiideVersion) : null,   // S6 version quad
    model: exp.model ?? env.model?.requested ?? null,
    harnessVersion: env.runtimeVersion != null ? String(env.runtimeVersion) : null,
    isolationVerified: exp.isolationVerified ?? null,
    full: true,
    skills: (env.skills ?? []).map((s) => ({ name: s.name, sha256: s.hash ?? null })),
    cases,
  };
}

// S7 probes: wrap each experiment's stats.probes (== cliStats output, the per-arm shape
// probeBlocksToReport expects) into a two-arm probeBlocks. proximity rides each experiment's
// stats.proximity — it is already the {edges,n,axesOmitted} shape proximityToCharts consumes
// (built by proximityMatrix), so the M7 邻近 charts light up per arm. excludedProbeHits rides the
// Phase-1 stats.probes[].excludedHits tripwire.
function probeBlocksFromExps(expA, expB, { exclusionPct = null } = {}) {
  const pA = Array.isArray(expA.stats?.probes) ? expA.stats.probes : null;
  const pB = Array.isArray(expB.stats?.probes) ? expB.stats.probes : null;
  const proxA = expA.stats?.proximity ?? null, proxB = expB.stats?.proximity ?? null;
  if (!pA && !pB && !proxA && !proxB) return null;
  const hits = (probes, arm) => (probes ?? [])
    .filter((p) => (p.excludedHits ?? []).length)
    .map((p) => ({ arm, tool: p.tool, caseId: null, cmds: p.excludedHits }));
  // paired exclusion rides the comparison's own exclusionPct (same denominator the verdict uses);
  // tripwire flips the S7 block to 'inconclusive' exactly when the verdict's exclusion gate would.
  const tripwire = UPGRADE_CONFIG.exclusion?.tripwirePct ?? 100;
  const paired = exclusionPct == null ? { tripwired: false }
    : { exclusionPct: round3(exclusionPct / 100), tripwired: exclusionPct > tripwire };
  return {
    byArm: [
      { arm: 'old', probes: pA, proximity: proxA },
      { arm: 'new', probes: pB, proximity: proxB },
    ],
    paired,
    excludedProbeHits: [...hits(pA, 'old'), ...hits(pB, 'new')],
  };
}

// S8 coverage authority reads a resolveExpStats wrapper {stats, statsAuthority, warnings}. The server
// stashes the full wrapper on exp._statsResolved; tests (and any caller that only sets exp.stats) fall
// back to a minimal wrapper so the section still populates — authority just reads "unknown".
function statsWrapper(exp) {
  if (exp._statsResolved && typeof exp._statsResolved === 'object') return exp._statsResolved;
  return { stats: exp.stats ?? null, statsAuthority: null, warnings: [] };
}

// S6 budget: the dynamic compare has no planned budget (no `aiide upgrade` run), so `est` stays null;
// `actual` is the honest observed spend summed across BOTH arms' repeats (sessions = run count,
// hours = Σ durationMs, usd = Σ costUsd). Never fabricates an estimate it doesn't have.
function deriveBudget(expA, expB) {
  let session = 0, ms = 0, usd = 0, sawUsd = false;
  for (const exp of [expA, expB]) {
    for (const tk of Object.values(exp.tasks ?? {})) {
      for (const r of tk.repeats ?? []) {
        session += 1;
        ms += r.efficiency?.durationMs ?? r.efficiency?.wallMs ?? 0;
        const c = r.efficiency?.costUsd ?? r.efficiency?.costUsdReported;
        if (c != null) { usd += c; sawUsd = true; }
      }
    }
  }
  return {
    est: { session: null, hours: null, usd: null },
    actual: { session, hours: ms > 0 ? round3(ms / 3.6e6) : null, usd: sawUsd ? round3(usd) : null },
  };
}

const EMPTY_DEPGRAPH = { n: 0, full: false, provenanceMix: null, disclaimer: '', graph: { nodes: [], edges: [] }, heatmap: { refs: [], matrix: [] }, sankey: { nodes: [], links: [] }, signals: [] };

// expA = old/baseline, expB = new/candidate. Returns a report shaped exactly like GET /api/upgrades/<id>
// so the dashboard's buildUpgradeView / upgradeReportHtml render it unchanged.
export function buildDynamicCompareReport({ expA, expB, config = UPGRADE_CONFIG, now = new Date().toISOString(), prevExps = null } = {}) {
  const armOld = experimentToArm(expA);
  const armNew = experimentToArm(expB);
  const comparison = buildComparison(armNew, armOld, { intent: 'neutral-refactor', config });
  const probeBlocks = probeBlocksFromExps(expA, expB, { exclusionPct: comparison.exclusionPct });
  // S6 trend diff — compare THIS pair against the previous same-lineage pair (the server auto-picks the
  // two suites' immediately-earlier experiments). Built with prevExps=null so it never recurses. null
  // (no earlier pair) → reportDiff renders an honest "无基准". reportDiff reads only the prior report's
  // verdict / cost axes / regressed cases, so a dynamic prev report is a first-class baseline.
  const prev = prevExps?.expA && prevExps?.expB
    ? buildDynamicCompareReport({ expA: prevExps.expA, expB: prevExps.expB, config, now })
    : null;
  const report = buildReportJson({
    comparison, probeBlocks, config, prev,
    // S8 覆盖统计对比 — full resolveExpStats wrapper per arm (server stashes it; test fallback = minimal).
    armStats: { old: statsWrapper(expA), new: statsWrapper(expB) },
    // S9 runtime 自述对比 — experiment.environment.runtimeInfo per arm (null when the runtime didn't self-report).
    armRuntimeInfo: { old: expA.environment?.runtimeInfo ?? null, new: expB.environment?.runtimeInfo ?? null },
    // S6 预算 — honest observed spend (est stays null: a live compare has no planned budget).
    budget: deriveBudget(expA, expB),
    meta: {
      armNew, armOld,
      compareId: `${expA.id ?? 'A'}__${expB.id ?? 'B'}`,
      cohort: expB.suiteName ?? expA.suiteName ?? 'default',
      createdAt: now,
    },
  });
  // S4 dependency graph. When BOTH experiments retained raw depgraphSessions, pool them and rebuild a
  // TRUE two-arm merged graph via the same tested depgraphReport the cohort pipeline uses — a real
  // cohort view, not a hand-merge of charted matrices. Legacy stats lack depgraphSessions → fall back
  // to the richer-of-two single-arm charts (a cross-runtime external arm produces an empty depgraph, so
  // picking the richer keeps the diagrams populated instead of blank).
  const sessA = expA.stats?.depgraphSessions, sessB = expB.stats?.depgraphSessions;
  if (Array.isArray(sessA) && Array.isArray(sessB) && (sessA.length || sessB.length)) {
    report.depgraph = depgraphToCharts(depgraphReport([...sessA, ...sessB], { full: false }), config);
    report.depgraph.merged = true;   // two-arm pooled — render can label it "combined (both arms)"
  } else {
    const dgRichness = (dg) => (dg?.graph?.nodes?.length ?? 0) + (dg?.sankey?.links?.length ?? 0) + (dg?.heatmap?.refs?.length ?? 0);
    const dgA = expA.stats?.depgraph, dgB = expB.stats?.depgraph;
    report.depgraph = (dgRichness(dgA) > dgRichness(dgB) ? dgA : dgB) ?? dgA ?? dgB ?? EMPTY_DEPGRAPH;
  }
  report.dynamic = true;   // dashboard shows the "generated live from experiment scorecards" banner
  return report;
}
