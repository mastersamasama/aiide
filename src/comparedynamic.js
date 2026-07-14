// Dynamic compare report — build a full upgrade report on the fly from two SEALED experiments of the
// same suite, without running `aiide upgrade`. The bridge is experimentToArm: the experiment scorecard
// (C + the Phase-1 l1Pass/l3Pass) maps onto the upgrade arm's L1/L2/L3 shape, so buildComparison /
// buildReportJson run verbatim. Pairing is per-task (MIN_PAIRS=8 gates on the number of shared tasks);
// depgraph reuses each experiment's Part-D stats.depgraph; S7 probes reuse stats.probes.
//
// Honesty: L2 = correctness (C); L1/L3 are real only for tasks whose suite declared an expected skill /
// a confirm gate — otherwise null → the axis reads n/a (never fabricated). Fewer than MIN_PAIRS shared
// tasks → decideVerdict returns insufficient-data. Nothing is written to disk (pure, in-memory).
import { buildComparison, buildReportJson } from './report.js';
import { UPGRADE_CONFIG } from './upgradeConfig.js';

// Map one sealed experiment to an upgrade "arm". held-out tasks never enter a comparison.
export function experimentToArm(exp) {
  const env = exp.environment ?? {};
  const cases = {};
  for (const [id, tk] of Object.entries(exp.tasks ?? {})) {
    if (tk.held_out === true) continue;
    cases[id] = {
      skill: tk.expected_skill ?? null,
      category: tk.category ?? 'uncategorized',
      prompt: tk.prompt ?? '',
      repeats: (tk.repeats ?? []).map((r) => ({
        l1Pass: r.l1Pass ?? null,                    // Phase 1: routing verdict (null when no expected skill)
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
      })),
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
// probeBlocksToReport expects) into a two-arm probeBlocks. proximity is left null (each experiment's
// stats.proximity is a different matrix shape than proximityToCharts wants — coverage delta is the
// core of S7). excludedProbeHits rides the Phase-1 stats.probes[].excludedHits tripwire.
function probeBlocksFromExps(expA, expB) {
  const pA = Array.isArray(expA.stats?.probes) ? expA.stats.probes : null;
  const pB = Array.isArray(expB.stats?.probes) ? expB.stats.probes : null;
  if (!pA && !pB) return null;
  const hits = (probes, arm) => (probes ?? [])
    .filter((p) => (p.excludedHits ?? []).length)
    .map((p) => ({ arm, tool: p.tool, caseId: null, cmds: p.excludedHits }));
  return {
    byArm: [
      { arm: 'old', probes: pA, proximity: null },
      { arm: 'new', probes: pB, proximity: null },
    ],
    paired: { tripwired: false },
    excludedProbeHits: [...hits(pA, 'old'), ...hits(pB, 'new')],
  };
}

const EMPTY_DEPGRAPH = { n: 0, full: false, provenanceMix: null, disclaimer: '', graph: { nodes: [], edges: [] }, heatmap: { refs: [], matrix: [] }, sankey: { nodes: [], links: [] }, signals: [] };

// expA = old/baseline, expB = new/candidate. Returns a report shaped exactly like GET /api/upgrades/<id>
// so the dashboard's buildUpgradeView / upgradeReportHtml render it unchanged.
export function buildDynamicCompareReport({ expA, expB, config = UPGRADE_CONFIG, now = new Date().toISOString() } = {}) {
  const armOld = experimentToArm(expA);
  const armNew = experimentToArm(expB);
  const comparison = buildComparison(armNew, armOld, { intent: 'neutral-refactor', config });
  const probeBlocks = probeBlocksFromExps(expA, expB);
  const report = buildReportJson({
    comparison, probeBlocks, config,
    meta: {
      armNew, armOld,
      compareId: `${expA.id ?? 'A'}__${expB.id ?? 'B'}`,
      cohort: expB.suiteName ?? expA.suiteName ?? 'default',
      createdAt: now,
    },
  });
  // reuse each experiment's Part-D reference-relationship (already depgraphToCharts-shaped). Prefer the
  // arm that actually EXERCISED skills/refs — a cross-runtime external arm (okx via MCP) produces an
  // empty depgraph, so picking the richer of the two keeps the diagrams populated instead of blank.
  const dgRichness = (dg) => (dg?.graph?.nodes?.length ?? 0) + (dg?.sankey?.links?.length ?? 0) + (dg?.heatmap?.refs?.length ?? 0);
  const dgA = expA.stats?.depgraph, dgB = expB.stats?.depgraph;
  report.depgraph = (dgRichness(dgA) > dgRichness(dgB) ? dgA : dgB) ?? dgA ?? dgB ?? EMPTY_DEPGRAPH;
  report.dynamic = true;   // dashboard shows the "generated live from experiment scorecards" banner
  return report;
}
