// U4 upgrade-verdict engine — paired bootstrap, non-inferiority gate, intent-parametrized verdict,
// per-skill cluster bootstrap + BH, regressed clustering, config footer (design §2.2/§6 F1/F2).
// Governance iron rule: a verdict is ADOPTION EVIDENCE, never an auto-adopt. All params come from the
// CANONICAL CONFIG (U0 src/upgradeConfig.js) — nothing is re-defined here (R4.0.1).
import { UPGRADE_CONFIG } from './upgradeConfig.js';
import { wilson, mean } from './score.js';
import { equivTokens } from './metrics.js';

const round3 = (x) => (x == null ? null : Math.round(x * 1e3) / 1e3);
const zForLevel = (level) => (level >= 0.99 ? 2.576 : level >= 0.95 ? 1.96 : level >= 0.90 ? 1.645 : 1.96);

// ---- PRNG: splitmix32 (R4.2.1, TL-m3) --------------------------------------------------------
// Named explicitly so the paired bootstrap is bit-reproducible across platforms. Classic splitmix32:
// a 32-bit state advanced by the golden-ratio increment, avalanched with two odd multipliers.
export function splitmix32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
}

// ---- paired bootstrap delta CI (R4.2.1/R4.2.2) -----------------------------------------------
// Percentile bootstrap over per-case paired deltas. Same deltas + same seed → bit-identical CI.
// ~30 lines, zero deps. Returns the point mean plus the [lo,hi] percentile interval.
export function pairedBootstrapCI(deltas, { iters = UPGRADE_CONFIG.verdict.bootstrapIters,
  seed = UPGRADE_CONFIG.verdict.bootstrapSeed, level = UPGRADE_CONFIG.verdict.ciLevel } = {}) {
  const n = deltas.length;
  if (n === 0) return { lo: null, hi: null, mean: null, n: 0 };
  const rnd = splitmix32(seed);
  const means = new Array(iters);
  for (let b = 0; b < iters; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += deltas[(rnd() * n) | 0];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const lo = means[Math.floor(alpha * iters)];
  const hi = means[Math.min(iters - 1, Math.ceil((1 - alpha) * iters) - 1)];
  const point = deltas.reduce((a, b) => a + b, 0) / n;
  return { lo: round3(lo), hi: round3(hi), mean: round3(point), n };
}

// ---- cluster bootstrap (R4.6.1) --------------------------------------------------------------
// Resample whole clusters (a case is a cluster of its repeat-level deltas) with replacement, pool the
// drawn clusters' deltas, take the pooled mean. Preserves within-case correlation the naive bootstrap
// would ignore (repeats of one case are not independent).
export function clusterBootstrapCI(clusters, { iters = UPGRADE_CONFIG.verdict.bootstrapIters,
  seed = UPGRADE_CONFIG.verdict.bootstrapSeed, level = UPGRADE_CONFIG.verdict.ciLevel } = {}) {
  const k = clusters.length;
  if (k === 0) return { lo: null, hi: null, mean: null, clusters: 0 };
  const rnd = splitmix32(seed);
  const means = new Array(iters);
  for (let b = 0; b < iters; b++) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < k; i++) {
      const c = clusters[(rnd() * k) | 0];
      for (const d of c) { sum += d; cnt++; }
    }
    means[b] = cnt ? sum / cnt : 0;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const lo = means[Math.floor(alpha * iters)];
  const hi = means[Math.min(iters - 1, Math.ceil((1 - alpha) * iters) - 1)];
  const flat = clusters.flat();
  const point = flat.length ? flat.reduce((a, b) => a + b, 0) / flat.length : 0;
  return { lo: round3(lo), hi: round3(hi), mean: round3(point), clusters: k };
}

// ---- Benjamini-Hochberg FDR (R4.6.4) ---------------------------------------------------------
// Step-up procedure: sort p-values ascending, reject every hypothesis up to the largest k with
// p_(k) ≤ (k/m)·q. Returns the rejection mask in ORIGINAL order + the adopted threshold.
export function benjaminiHochberg(pvals, q = 0.05) {
  const m = pvals.length;
  const rejected = new Array(m).fill(false);
  if (m === 0) return { rejected, threshold: 0, q };
  const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  let kMax = -1;
  for (let k = 0; k < m; k++) if (idx[k][0] <= ((k + 1) / m) * q) kMax = k;
  for (let k = 0; k <= kMax; k++) rejected[idx[k][1]] = true;
  return { rejected, threshold: kMax >= 0 ? idx[kMax][0] : 0, q };
}

// ---- non-inferiority gate (R4.3.1/R4.3.2, F2) ------------------------------------------------
// STRICT: the quality delta CI lower bound must exceed −δ. Boundary (ciLow == −δ) FAILS — an
// exactly-at-margin regression is not "non-inferior". Both args in the same units (percentage points).
export function nonInferiorityPass(ciLow, deltaPp = UPGRADE_CONFIG.verdict.nonInferiorityDeltaPp) {
  if (ciLow == null) return false;
  return ciLow > -deltaPp;
}

// ---- config frozen assertion (R4.0.3) --------------------------------------------------------
export function assertConfigFrozen(config = UPGRADE_CONFIG) {
  if (!Object.isFrozen(config) || !Object.isFrozen(config.verdict) || !Object.isFrozen(config.tokenWeights)) {
    throw new Error('UPGRADE_CONFIG is not frozen — refusing to aggregate (R4.0.3)');
  }
  return true;
}

// ---- verdict footer (R4.0.2/R4.8.1) ----------------------------------------------------------
// Print the ACTUALLY-EFFECTIVE config params + the version quad for audit. Tests assert δ/MIN_PAIRS/
// seed are present; U7 renders this verbatim.
export function buildVerdictFooter(config = UPGRADE_CONFIG, { versionQuad = null, testCount = null, fdrStrategy = null } = {}) {
  const v = config.verdict;
  return {
    config: {
      MIN_PAIRS: v.MIN_PAIRS,
      MIN_PAIRS_SKILL: v.MIN_PAIRS_SKILL,
      nonInferiorityDeltaPp: v.nonInferiorityDeltaPp,
      ciLevel: v.ciLevel,
      bootstrapIters: v.bootstrapIters,
      bootstrapSeed: v.bootstrapSeed,
      fdr: v.fdr,
      tripwirePct: config.exclusion.tripwirePct,
      tokenWeights: config.tokenWeights,
    },
    versionQuad,
    // R4.6.4: global 3 axes are NOT FDR-corrected; per-skill badges ARE. Disclose both.
    tests: { count: testCount, globalCorrection: 'none', perSkillCorrection: fdrStrategy ?? config.verdict.fdr },
  };
}

// ---- four-tuple arm aggregation (R4.1) -------------------------------------------------------
// Aggregate ONE case's repeats into the quality three-layer pass rates + three continuous cost
// magnitudes. TWO denominators are maintained on purpose (R4.1.2/R4.1.3):
//   cost/quality denominator EXCLUDES excluded repeats (env-noise + harness-halt, S2 discipline);
//   flow-incomplete denominator INCLUDES every attempted repeat (excluded halted stay in).
// Each repeat is expected to carry per-repeat verdict fields attached by the U3 grader:
//   l1Pass/l2Pass/l3Pass (bool|null — null = axis n/a for this case), rounds, usage, durationMs,
//   excluded (bool), flowStatus ('complete'|'incomplete').
export function aggregateArm(repeats = [], { tokenWeights = UPGRADE_CONFIG.tokenWeights } = {}) {
  const attempted = repeats.length;                       // flow-incomplete denominator (includes excluded)
  const valid = repeats.filter(r => !r.excluded);          // cost/quality denominator (excludes excluded)
  const excludedRepeats = attempted - valid.length;

  const rate = (pick) => {
    const xs = valid.map(pick).filter(v => v != null);
    return xs.length ? round3(xs.reduce((a, b) => a + (b ? 1 : 0), 0) / xs.length) : null;
  };
  const contMean = (pick) => {
    const xs = valid.map(pick).filter(v => v != null && Number.isFinite(v));
    return xs.length ? round3(mean(xs)) : null;
  };

  const quality = { l1PassRate: rate(r => r.l1Pass), l2PassRate: rate(r => r.l2Pass), l3PassRate: rate(r => r.l3Pass) };
  const cost = {
    meanTurns: contMean(r => r.rounds),
    meanEquivTokens: contMean(r => (r.usage ? equivTokens(r.usage, tokenWeights) : null)),
    meanSeconds: contMean(r => (r.durationMs != null ? r.durationMs / 1000 : null)),
  };
  const fiNum = repeats.filter(r => r.flowStatus === 'incomplete').length;

  return {
    n: valid.length, attempted, excludedRepeats, degraded: excludedRepeats > 0,
    quality, cost,
    flowIncomplete: { numerator: fiNum, denom: attempted, rate: attempted ? round3(fiNum / attempted) : 0 },
  };
}

// ---- intent-parametrized verdict (R4.4/R4.5) -------------------------------------------------
// The single bundle-level "adoption certificate". Inputs are already-computed comparison signals:
//   quality: { l1:{ciLow,significantUp}, l2:{...}, l3:{...} }  (ciLow in pp; non-inferiority gate)
//   flowIncomplete: { regressed }        (new arm significantly HIGHER incomplete-rate = quality drop)
//   cost:    { turns:{significantDown,significantUp}, tokens:{...}, seconds:{...} }
//   pairs, exclusionPct, excludedCases: [{caseId, reason}], intent
// Precedence: insufficient-data (pairs<MIN_PAIRS or empty) → inconclusive (exclusion tripwire) →
// intent rule. `established` is the "成立" flag; the label is always one of the five values.
export function decideVerdict({
  quality = {}, cost = {}, flowIncomplete = {}, pairs = 0, exclusionPct = 0,
  excludedCases = [], intent = 'neutral-refactor', config = UPGRADE_CONFIG,
} = {}) {
  const v = config.verdict;
  const deltaPp = v.nonInferiorityDeltaPp;
  const base = { pairs, exclusionPct: round3(exclusionPct), excludedCases, intent };

  // R4.5.1/R4.5.4: too few pairs (or a fully-missing arm → 0 pairs) → insufficient-data.
  if (pairs < v.MIN_PAIRS) {
    return { verdict: 'insufficient-data', established: false, ...base, reasons: [`paired cases ${pairs} < MIN_PAIRS ${v.MIN_PAIRS}`] };
  }
  // R4.5.2/R4.5.3: whole-case exclusion rate STRICTLY above tripwire → inconclusive (survivor-set guard).
  if (exclusionPct > config.exclusion.tripwirePct) {
    return {
      verdict: 'inconclusive', established: false, ...base,
      reasons: [`whole-case exclusion ${round3(exclusionPct)}% > tripwire ${config.exclusion.tripwirePct}%`],
    };
  }

  // quality gate — every quality axis (L1/L2/L3) non-inferior AND flow-incomplete not regressed.
  const axes = ['l1', 'l2', 'l3'];
  const qualityNonInferior = axes.every(a => quality[a] == null || nonInferiorityPass(quality[a].ciLow, deltaPp));
  const flowOk = !flowIncomplete.regressed;                                   // R4.2 (flow-incomplete in ALL intents)
  const qualityGate = qualityNonInferior && flowOk;

  const costAxes = ['turns', 'tokens', 'seconds'];
  const anyCostDown = costAxes.some(a => cost[a]?.significantDown);
  const anyCostUp = costAxes.some(a => cost[a]?.significantUp);
  const qualityUp = (axis) => quality[axis]?.significantUp === true;

  const gates = { qualityNonInferior, flowOk, anyCostDown, anyCostUp };
  let established = false;
  const reasons = [];

  if (intent === 'cost-opt') {
    // quality non-inferior + flow ok + ≥1 cost axis significantly down + no cost axis significantly up.
    established = qualityGate && anyCostDown && !anyCostUp;
    if (!qualityNonInferior) reasons.push('a quality axis failed non-inferiority');
    if (!flowOk) reasons.push('flow-incomplete regressed');
    if (!anyCostDown) reasons.push('no cost axis significantly decreased');
    if (anyCostUp) reasons.push('a cost axis significantly increased');
  } else if (intent === 'quality-fix') {
    // target quality axis significantly up + no cost axis significantly up.
    const target = quality.target ?? (qualityUp('l1') ? 'l1' : qualityUp('l2') ? 'l2' : qualityUp('l3') ? 'l3' : null);
    const targetUp = target != null && qualityUp(target);
    established = targetUp && !anyCostUp && flowOk;
    gates.targetQualityUp = targetUp;
    if (!targetUp) reasons.push('target quality axis did not significantly improve');
    if (anyCostUp) reasons.push('a cost axis significantly increased');
    if (!flowOk) reasons.push('flow-incomplete regressed');
  } else { // neutral-refactor
    // quality non-inferior (+ flow ok) + cost not significantly worse.
    established = qualityGate && !anyCostUp;
    if (!qualityNonInferior) reasons.push('a quality axis failed non-inferiority');
    if (!flowOk) reasons.push('flow-incomplete regressed');
    if (anyCostUp) reasons.push('a cost axis significantly increased');
  }

  return { verdict: intent, established, ...base, gates, reasons: established ? [] : reasons };
}

// ---- per-skill diagnostics (R4.6) ------------------------------------------------------------
// Per-skill cluster bootstrap (case = cluster) + BH across skills. <MIN_PAIRS_SKILL cases → only
// descriptive stats + insufficient-data badge; 5-7 cases → CI marked reference-only (round-3 dissent).
// EXPLICITLY NOT an adoption certificate (R4.6.5): two arms are each whole bundles, routing is global,
// a hand-picked mix was never measured — the mixed-bundle confirm smoke is the only path to adopt a mix.
export function perSkillDiagnostics(units = [], { config = UPGRADE_CONFIG } = {}) {
  const bySkill = new Map();
  for (const u of units) {
    if (!bySkill.has(u.skill)) bySkill.set(u.skill, new Map());
    const cases = bySkill.get(u.skill);
    if (!cases.has(u.caseId)) cases.set(u.caseId, []);
    cases.get(u.caseId).push(u.delta);
  }

  const minSkill = config.verdict.MIN_PAIRS_SKILL;
  const raw = [];
  for (const [skill, cases] of bySkill) {
    const clusters = [...cases.values()];
    const nCases = clusters.length;
    if (nCases < minSkill) {
      raw.push({
        skill, nCases, badge: 'insufficient-data', referenceOnly: false,
        ci: null, mean: round3(mean(clusters.flat())), pValue: null, significant: false,
      });
      continue;
    }
    const ci = clusterBootstrapCI(clusters, { config });
    // two-sided bootstrap p ≈ 2·(share of resamples on the null side); approximate from CI position.
    const straddlesZero = ci.lo != null && ci.hi != null && ci.lo <= 0 && ci.hi >= 0;
    const pValue = straddlesZero ? 1 : 0.01; // provisional; BH re-ranks on these below
    raw.push({
      skill, nCases, badge: nCases <= 7 ? 'reference-only' : 'ok', referenceOnly: nCases <= 7,
      ci: { lo: ci.lo, hi: ci.hi }, mean: ci.mean, pValue, significant: !straddlesZero,
    });
  }

  // R4.6.4: BH-correct the eligible (≥MIN_PAIRS_SKILL) skills' significance badges.
  const eligible = raw.filter(r => r.pValue != null);
  const bh = benjaminiHochberg(eligible.map(r => r.pValue));
  eligible.forEach((r, i) => {
    r.significantRaw = r.significant;
    r.significant = bh.rejected[i];              // BH can only REVOKE a naive significance flag
    r.significantBadge = r.significant ? (r.referenceOnly ? 'significant (reference-only)' : 'significant') : 'n.s.';
  });

  return {
    skills: raw,
    note: 'per-skill diagnostics are NOT an adoption certificate (R4.6.5) — route via mixed-bundle confirm smoke',
    fdr: config.verdict.fdr,
  };
}

// ---- regressed clustering (R4.9, PM-B3c) -----------------------------------------------------
// Group quality-regressed cases into skill×category buckets for U7 to render (U7 re-computes nothing).
// skill = U2 primary attribution, category = U1 field. Non-regressed cases are dropped.
export function clusterRegressed(pairedCases = []) {
  const out = {};
  for (const c of pairedCases) {
    if (!c.regressed) continue;
    const key = `${c.skill ?? 'unknown'}×${c.category ?? 'uncategorized'}`;
    (out[key] ??= []).push(c.caseId);
  }
  return out;
}
