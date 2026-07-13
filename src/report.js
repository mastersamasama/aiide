// U7 upgrade-report — verdict-first report assembly (report.json / report.md / single-file report.html).
//
// ┌─ SCOPE (iron rules) ─────────────────────────────────────────────────────────┐
// │ • Zero dep, zero build. ECharts full dist is ONLY inlined into the HTML        │
// │   artifact (vendored, pinned, sha256-checked); never an npm dep, never in the  │
// │   aiide dashboard core (R7.5).                                                  │
// │ • This layer CONSUMES the upstream engines and DOES NOT re-compute statistics  │
// │   (U4 verdict, U5 depgraph, U6 static gates, U0 budget). It pairs cases, folds │
// │   already-graded per-repeat verdict fields with the U4 primitives, and         │
// │   assembles the three-layer-isomorphic report (design §3).                      │
// │ • Governance neutral: a verdict is ADOPTION EVIDENCE, never an auto-adopt.      │
// │   The report SHALL NOT print "adopted" and offers no apply action.             │
// │ • Artifacts are WRITE-ONCE immutable: a rerun produces a NEW <compare-id> dir. │
// └──────────────────────────────────────────────────────────────────────────────┘
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { UPGRADE_CONFIG } from './upgradeConfig.js';
import {
  aggregateArm, decideVerdict, perSkillDiagnostics, clusterRegressed,
  pairedBootstrapCI, buildVerdictFooter,
} from './upgradeVerdict.js';
import { compareFlowIncomplete, flowIncompleteRate, mean } from './score.js';
import { equivTokens } from './metrics.js';
import { buildVersionQuad } from './meta.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const round3 = (x) => (x == null ? null : Math.round(x * 1e3) / 1e3);

// ── vendored ECharts pin (R7.5.1) ────────────────────────────────────────────────────────────
export const ECHARTS_VERSION = '5.6.0';
export const ECHARTS_LICENSE = 'Apache-2.0';
export const ECHARTS_SHA256 = 'bf4a223524e40b77c304bec67e1222cf551f14880cf42c69dc046558e11c07b1';
export const DEFAULT_VENDOR_PATH = join(HERE, '..', 'web', 'vendor', 'echarts-5.6.0.min.js');

// R7.5.1 — verify the vendored ECharts file matches the pinned sha256. The HTML build calls this
// BEFORE inlining; a mismatch means the file was swapped/corrupted → refuse to emit (R7.EB2).
export function verifyVendorSha256(vendorPath = DEFAULT_VENDOR_PATH) {
  if (!existsSync(vendorPath)) {
    return { ok: false, sha256: null, expected: ECHARTS_SHA256, reason: `vendor file not found: ${vendorPath}` };
  }
  const buf = readFileSync(vendorPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { ok: sha256 === ECHARTS_SHA256, sha256, expected: ECHARTS_SHA256, bytes: buf.length };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// COMPARISON PIPELINE — fold two arms' per-repeat verdicts into the verdict + evidence structures.
// An arm: { label, cliVersion, model, harnessVersion, isolationVerified, full, skills[], mix, baseline,
//           cases: { <caseId>: { skill, category, excluded?, exclusionReason?, repeats: [ {l1Pass,l2Pass,
//           l3Pass, rounds, usage, durationMs, excluded, flowStatus, l3Heuristic?} ], triggerSet?, readSet?,
//           l2Result?, l3Final?, transcript?, logPath? } } }.
// armNew = candidate (B), armOld = baseline (A). Returns everything the six sections need.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const LAYER_META = [
  { key: 'l1', layer: 'L1', name: 'routing', pick: (a) => a.quality.l1PassRate },
  { key: 'l2', layer: 'L2', name: 'result', pick: (a) => a.quality.l2PassRate },
  { key: 'l3', layer: 'L3', name: 'safety', pick: (a) => a.quality.l3PassRate },
];
const COST_AXES = [
  { key: 'turns', i18n: 'axisT', unit: 'turn', dp: 1, pick: (a) => a.cost.meanTurns },
  { key: 'tokens', i18n: 'axisTok', unit: 'tok', dp: 0, pick: (a) => a.cost.meanEquivTokens },
  { key: 'seconds', i18n: 'axisSec', unit: 's', dp: 1, pick: (a) => a.cost.meanSeconds },
];

const casePass = (agg) => LAYER_META.every((L) => { const r = L.pick(agg); return r == null || r >= 0.5; });
const allExcluded = (agg) => agg.attempted > 0 && agg.n === 0;

export function buildComparison(armNew, armOld, { intent = 'neutral-refactor', config = UPGRADE_CONFIG } = {}) {
  const tokenWeights = config.tokenWeights;
  const newCases = armNew.cases ?? {};
  const oldCases = armOld.cases ?? {};
  const pairedIds = Object.keys(newCases).filter((id) => id in oldCases).sort();
  const unpairedIds = [
    ...Object.keys(newCases).filter((id) => !(id in oldCases)),
    ...Object.keys(oldCases).filter((id) => !(id in newCases)),
  ];

  const perCase = [];            // one row per paired case (with agg + deltas)
  const excludedCases = [];      // [{caseId, reason}]
  let l3Heuristic = false;

  for (const id of pairedIds) {
    const cn = newCases[id], co = oldCases[id];
    const aggNew = aggregateArm(cn.repeats ?? [], { tokenWeights });
    const aggOld = aggregateArm(co.repeats ?? [], { tokenWeights });
    const skill = cn.skill ?? co.skill ?? 'unknown';
    const category = cn.category ?? co.category ?? 'uncategorized';
    const excluded = cn.excluded === true || co.excluded === true || allExcluded(aggNew) || allExcluded(aggOld);
    const reason = cn.exclusionReason ?? co.exclusionReason
      ?? (allExcluded(aggNew) || allExcluded(aggOld) ? 'env-noise' : null);
    if (excluded) excludedCases.push({ caseId: id, reason: reason ?? 'env-noise' });
    if ([...(cn.repeats ?? []), ...(co.repeats ?? [])].some((r) => r.l3Heuristic)) l3Heuristic = true;
    const regressed = !excluded && casePass(aggOld) && !casePass(aggNew);
    // per-case scalar delta (pp) = mean of available quality-layer pass-rate deltas — the trend point (§AX cases[].delta)
    const layerDeltas = LAYER_META.map((L) => { const o = L.pick(aggOld), n = L.pick(aggNew); return o != null && n != null ? (n - o) * 100 : null; }).filter((d) => d != null);
    const delta = excluded || !layerDeltas.length ? null : round3(mean(layerDeltas));
    perCase.push({ id, skill, category, excluded, reason, regressed, delta, aggNew, aggOld, cn, co });
  }

  const included = perCase.filter((c) => !c.excluded);
  const pairs = pairedIds.length;
  const exclusionPct = pairs > 0 ? (excludedCases.length / pairs) * 100 : 0;

  // ── quality: per-layer arm means + paired bootstrap CI on per-case (new−old) pp ──────────────
  const qualitySignal = {};      // for decideVerdict: {l1:{ciLow,significantUp},...}
  const layers = LAYER_META.map((L) => {
    const olds = [], news = [], deltasPp = [];
    for (const c of included) {
      const o = L.pick(c.aggOld), n = L.pick(c.aggNew);
      if (o != null) olds.push(o);
      if (n != null) news.push(n);
      if (o != null && n != null) deltasPp.push((n - o) * 100);
    }
    const passOld = olds.length ? mean(olds) : null;
    const passNew = news.length ? mean(news) : null;
    const ci = pairedBootstrapCI(deltasPp, { config });
    const delta = passOld != null && passNew != null ? passNew - passOld : null;
    const significantUp = ci.lo != null && ci.lo > 0;
    // non-inferiority gate: CI lower bound (pp) must exceed −δ
    const nonInferior = ci.lo == null ? true : ci.lo > -config.verdict.nonInferiorityDeltaPp;
    qualitySignal[L.key] = { ciLow: ci.lo, significantUp };
    const skills = [...new Set(included.filter((c) => {
      const o = L.pick(c.aggOld), n = L.pick(c.aggNew);
      return o != null && n != null && n < o;                 // skills that dropped on this layer
    }).map((c) => c.skill))];
    return {
      layer: L.layer, name: L.name, passOld: round3(passOld), passNew: round3(passNew),
      delta: round3(delta), ci: [round3(ci.lo / 100), round3(ci.hi / 100)], ciPp: [ci.lo, ci.hi],
      nonInferior, significantUp, n: deltasPp.length, skills,
    };
  });

  // ── flow-incomplete: pooled two-arm one-sided z (score.js) ───────────────────────────────────
  // F1（设计 §2.1 挑战轮决策）：分母 = 全部尝试的 repeat 且【含被排除 case 的 repeat】——
  // 「新版变保守 → halt → 整案被排除 → 讯号从幸存集里消失」正是这条分母纪律要堵的洗白路径。
  // 2026-07-12 fresh-eyes 全页轮从 8.3%=3/36 反推出实作只用了 included（漂移），据此修正。
  const newReps = perCase.flatMap((c) => c.cn.repeats ?? []);
  const oldReps = perCase.flatMap((c) => c.co.repeats ?? []);
  const flow = compareFlowIncomplete(newReps, oldReps);
  const fiNew = flowIncompleteRate(newReps), fiOld = flowIncompleteRate(oldReps);
  const flowIncomplete = {
    rateOld: fiOld.rate, rateNew: fiNew.rate, wilson: [round3(fiNew.ci.lo), round3(fiNew.ci.hi)],
    numOld: fiOld.numerator, denomOld: fiOld.denom, numNew: fiNew.numerator, denomNew: fiNew.denom,
    newHigherSignificant: flow.regressed, deltaRate: flow.deltaRate,
    skills: [...new Set(included.filter((c) => (c.aggNew.flowIncomplete.rate ?? 0) > (c.aggOld.flowIncomplete.rate ?? 0)).map((c) => c.skill))],
  };

  // ── cost: per-axis paired bootstrap CI on per-case (new−old) ─────────────────────────────────
  const costSignal = {};
  const axes = COST_AXES.map((ax) => {
    const deltas = [];
    for (const c of included) {
      const o = ax.pick(c.aggOld), n = ax.pick(c.aggNew);
      if (o != null && n != null) deltas.push(n - o);
    }
    const ci = pairedBootstrapCI(deltas, { config });
    const significantDown = ci.hi != null && ci.hi < 0;
    const significantUp = ci.lo != null && ci.lo > 0;
    costSignal[ax.key] = { significantDown, significantUp };
    const m = ci.mean ?? 0;
    const fmt = (v) => (v == null ? 'n/a' : (v > 0 ? '+' : '') + v.toFixed(ax.dp) + ' ' + ax.unit);
    return {
      key: ax.key, i18n: ax.i18n, unit: ax.unit, mean: ci.mean, ci: [ci.lo, ci.hi],
      ciDisp: [fmt(ci.lo), fmt(ci.hi)], disp: fmt(ci.mean), n: ci.n,
      significant: significantDown || significantUp, significantDown, significantUp,
      direction: m < 0 ? 'good' : 'bad', seed: config.verdict.bootstrapSeed,
    };
  });

  // ── the single bundle-level verdict (U4) ─────────────────────────────────────────────────────
  const verdict = decideVerdict({
    quality: qualitySignal, cost: costSignal, flowIncomplete: { regressed: flow.regressed },
    pairs, exclusionPct, excludedCases, intent, config,
  });

  // ── per-skill diagnostics (U4): routing (L1) paired delta as the per-case unit ───────────────
  const units = [];
  for (const c of included) {
    const o = c.aggOld.quality.l1PassRate, n = c.aggNew.quality.l1PassRate;
    if (o != null && n != null) units.push({ skill: c.skill, caseId: c.id, delta: (n - o) * 100 });
  }
  const perSkillDiag = perSkillDiagnostics(units, { config });

  // ── evidence cases (S5) + regressed clustering (U4) ──────────────────────────────────────────
  const layerState = (rate) => (rate == null ? 'n/a' : rate >= 0.5 ? 'pass' : 'fail');
  const armLayers = (agg) => ({ l1: layerState(agg.quality.l1PassRate), l2: layerState(agg.quality.l2PassRate), l3: layerState(agg.quality.l3PassRate) });
  const caseHasPerm = (c) => [...(c.cn.repeats ?? []), ...(c.co.repeats ?? [])].some((r) => r.permissionArtifact);
  const evidenceCases = perCase.map((c) => ({
    caseId: c.id, skill: c.skill, category: c.category, delta: c.delta,
    prompt: stripCaseId(c.cn.prompt ?? c.co.prompt ?? null, c.id),   // original prompt, trailing (caseId) stripped
    permissionArtifact: caseHasPerm(c),                              // this case hit a permission-denied artifact (S5 shows ∅ 权限拒绝)
    l1: c.excluded ? 'excluded' : layerState(c.aggNew.quality.l1PassRate),
    l2: c.excluded ? 'excluded' : layerState(c.aggNew.quality.l2PassRate),
    l3: c.excluded ? 'excluded' : layerState(c.aggNew.quality.l3PassRate),
    status: c.excluded ? 'excluded' : 'paired',
    regressed: c.regressed,
    flowIncomplete: (c.aggNew.flowIncomplete.rate ?? 0) > 0,
    // both arms' per-layer pass/fail + per-case cost delta (for the S1.1 per-skill drill-down)
    arms: c.excluded ? null : { new: armLayers(c.aggNew), old: armLayers(c.aggOld) },
    costDelta: c.excluded ? null : {
      turns: round3((c.aggNew.cost.meanTurns ?? 0) - (c.aggOld.cost.meanTurns ?? 0)),
      tokens: round3((c.aggNew.cost.meanEquivTokens ?? 0) - (c.aggOld.cost.meanEquivTokens ?? 0)),
      seconds: round3((c.aggNew.cost.meanSeconds ?? 0) - (c.aggOld.cost.meanSeconds ?? 0)),
    },
    exclusionChain: c.excluded ? (c.reason ?? 'env-noise') : null,
    armA: c.co.transcript ?? null, armB: c.cn.transcript ?? null,
    logPath: c.cn.logPath ?? c.co.logPath ?? null,
    // R7.7.1 two-arm detail for regressed cards
    detail: {
      armA: { triggerSet: c.co.triggerSet ?? [], readSet: normRefs(c.co.readSet), l2: c.co.l2Result ?? null, l3: c.co.l3Final ?? null },
      armB: { triggerSet: c.cn.triggerSet ?? [], readSet: normRefs(c.cn.readSet), l2: c.cn.l2Result ?? null, l3: c.cn.l3Final ?? null },
    },
  }));
  for (const id of unpairedIds) {
    const src = newCases[id] ?? oldCases[id];
    evidenceCases.push({
      caseId: id, skill: src.skill ?? 'unknown', category: src.category ?? 'uncategorized', delta: null,
      prompt: stripCaseId(src.prompt ?? null, id), permissionArtifact: false,
      l1: 'n/a', l2: 'n/a', l3: 'n/a', status: 'unpaired', regressed: false, flowIncomplete: false,
      arms: null, costDelta: null,
      exclusionChain: null, armA: null, armB: null, logPath: null, detail: null,
    });
  }
  const clusters = clusterRegressed(perCase.filter((c) => c.regressed));

  return {
    intent, verdict, pairs, exclusionPct: round3(exclusionPct), excludedCases,
    layers, flowIncomplete, axes, perSkill: perSkillDiag, evidenceCases, clusters,
    l3Heuristic, permissionArtifactCount: countPermissionArtifacts(perCase),
    perCase,
  };
}

function normRefs(readSet) {
  return (readSet ?? []).map((r) => (typeof r === 'string' ? r : r.logicalRef ?? r.refPath ?? String(r)));
}
// strip a redundant trailing "（caseId）" / "(caseId)" the suite prompt may repeat (the row already shows the id)
export function stripCaseId(prompt, id) {
  if (!prompt || !id) return prompt;
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return prompt.replace(new RegExp('\\s*[（(]' + esc + '[）)]\\s*$'), '').trim();
}
function countPermissionArtifacts(perCase) {
  let n = 0;
  for (const c of perCase) for (const r of [...(c.cn.repeats ?? []), ...(c.co.repeats ?? [])]) {
    if (r.l1Pass === null && r.permissionArtifact) n++;
  }
  return n;
}

// ── R7.4.3 next-step guidance (honest-status actionability; plain-language, one number per line) ──
// REFERENCE_OK_TARGET = the per-skill case count at which the CI stops being "reference-only" (badge
// flips ok at nCases > 7, i.e. ≥ 8). Kept as a named target so the guidance never juggles MIN_PAIRS_SKILL
// (the insufficient-data floor, 5) and the reference-only ceiling (7) in one confusing sentence.
const REFERENCE_OK_TARGET = 8;
// ── 优化机会一览（跨节汇总）────────────────────────────────────────────────────────────────────
// Render-time derivation, deliberately NOT a new canonical key: the evidence stays in §4/§8;
// this list only points there, so a human sees ONE list instead of scattered card families.
// 「双证据」= two independent measurement families landing on the SAME identity (higher confidence).
// Governance: entries are pointers + evidence counts only — no adopt affordance, human decides.
// B2 token 量化：refMeta 来自 NEW arm 的 stats（经 report.coverage 通道携带，明文标注取自新版）；
// join 仅明文路径 key，_shared 成员不量化；bytes 缺 → 维持定性文案，绝不编数字。
const SHARED_REF_RE = /(?:^|\/)_shared\//;
// Σ tokensEst over the given refs — null (no sentence) unless EVERY non-_shared ref has bytes+tokensEst.
function refTokensEst(refMeta, refs) {
  if (!refMeta) return null;
  const plain = (refs ?? []).filter((r) => r && !SHARED_REF_RE.test(r));   // _shared 成员不量化
  if (!plain.length) return null;
  let sum = 0;
  for (const r of plain) {
    const m = refMeta[r];
    if (m?.bytes == null || m?.tokensEst == null) return null;             // bytes 缺 → 不编数字
    sum += m.tokensEst;
  }
  return sum;
}
const tokensSentence = (n) => (n == null ? '' : `——不相干题型每次可少读 ~${n} tokens（估算，取自新版统计）`);

export function buildOpportunities(report) {
  const ops = [];
  const refMeta = report.coverage?.refMeta ?? null;   // new-arm refMeta（B4 coverage 节携带）

  for (const s of report.depgraph?.signals ?? []) {
    if (s.kind === 'merge') {
      ops.push({ kind: 'merge', section: { md: '第 4 节', html: 's4' },
        title: `技能合并候选：${(s.members ?? []).join(' + ')}`,
        benefit: '省常驻 token（desc 每次请求都载入）',
        evidence: [`共触发 ${Math.round((s.coTrigger ?? 0) * 100)}%（n=${s.n}）`] });
    } else if (s.kind === 'merge-file') {
      ops.push({ kind: 'merge-file', section: { md: '第 4 节', html: 's4' },
        benefit: '减少一次读取往返（两份总一起读 → 并成一份只读一次）' + tokensSentence(refTokensEst(refMeta, s.members)),
        title: `文档合并候选：${(s.members ?? []).join(' + ')}`,
        evidence: [`共读 ${Math.round((s.coRead ?? 0) * 100)}%（n=${s.n}）`] });
    } else if (s.kind === 'split') {
      const skill = s.skill ?? (s.members ?? [])[0];
      const skillRefs = refMeta && skill ? Object.keys(refMeta).filter((k) => k.startsWith(skill + '/')) : [];
      ops.push({ kind: 'split', section: { md: '第 4 节', html: 's4' },
        title: `拆分候选：${s.skill ?? (s.members ?? []).join(' + ')}`,
        benefit: '按需加载省 token（不相干题不再读整包）' + tokensSentence(refTokensEst(refMeta, skillRefs)),
        risk: '拆档可能增加一次读取往返——差异段小时建议反向内联',
        evidence: ['不同题型读取的参考文档差异大'] });
    } else if (s.kind === 'inline') {
      ops.push({ kind: 'inline', section: { md: '第 4 节', html: 's4' },
        title: `内联候选：${s.ref ?? (s.members ?? []).join(' + ')}`,
        benefit: '减少一次读取往返（内容并进 SKILL.md）' + tokensSentence(refTokensEst(refMeta, [s.ref].filter(Boolean))),
        risk: '正文变长 → 触发时的 context 略增',
        evidence: ['几乎每次触发都会读取'] });
    }
  }

  const seen = new Set();
  for (const arm of report.probes?.arms ?? []) {
    for (const t of arm.tools ?? []) {
      for (const s of t.sequences ?? []) {
        const k = `${t.tool}|${(s.seq ?? []).join('→')}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const ev = [`在 ${s.distinctCases} 个不同题目里连发`];
        if (s.knownCollapse) ev.push(`未验证猜想：或可并为单条命令「${s.knownCollapse}」`);
        ops.push({ kind: 'sink', section: { md: '第 8 节', html: 's7' },
          benefit: '减少 turn（多条命令并成一条 = 少一轮往返）',
          title: `命令下沉候选：${(s.seq ?? []).join(' → ')}（${t.tool}）`, evidence: ev });
      }
    }
  }

  // 「双证据」只由跨量测家族的融合规则给出；探针 knownCollapse 之类的宣告式注记只是猜想，不算第二证据。
  for (const o of ops) o.multi = o.multi === true;
  // 多证据优先、同强度按 kind 稳定排序
  ops.sort((a, b) => (b.multi - a.multi) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
  return ops;
}

function buildNextSteps(comparison, config) {
  const v = comparison.verdict;
  const steps = [];
  if (v.verdict === 'insufficient-data') {
    const need = Math.max(0, config.verdict.MIN_PAIRS - comparison.pairs);
    steps.push({ type: 'insufficient-data', need, message: `还需 ${need} 条配对（现有 ${comparison.pairs}，需 ≥ ${config.verdict.MIN_PAIRS}）` });
  }
  if (v.verdict === 'inconclusive') {
    const actionFor = (reason) => reason === 'harness-halt' ? '修 harness'
      : reason === 'env-noise' ? '补 scripted_reply' : '检视采集环境';
    steps.push({
      type: 'inconclusive',
      message: `排除率 ${comparison.exclusionPct}% 超 ${config.exclusion.tripwirePct}% 绊线，判不了 — 先处理下列排除 case 后重跑`,
      cases: comparison.excludedCases.map((e) => ({ caseId: e.caseId, reason: e.reason, action: actionFor(e.reason) })),
    });
  }
  for (const sk of comparison.perSkill.skills) {
    if (sk.referenceOnly) {
      steps.push({ type: 'reference-only', skill: sk.skill, need: Math.max(0, REFERENCE_OK_TARGET - sk.nCases),
        message: `${sk.skill} 样本 ${sk.nCases} 条（偏少，结论仅供参考）→ 补到 ${REFERENCE_OK_TARGET} 条可信` });
    }
  }
  return steps;
}

// ── depgraph (U5 output) → ECharts chart shapes for the HTML ─────────────────────────────────
function depgraphToCharts(depgraph, config = UPGRADE_CONFIG) {
  const dg = depgraph ?? { coTriggerGraph: { nodes: [], edges: [] }, coReadPairs: [], readRates: [], mergeMap: [], jaccardSplit: [] };
  const excluded = new Set(config.depgraph.hardExcludeSkills ?? []);
  const mergePairs = new Set();
  for (const m of dg.mergeMap ?? []) {
    const mem = m.members ?? [];
    for (let i = 0; i < mem.length; i++) for (let j = i + 1; j < mem.length; j++) mergePairs.add([mem[i], mem[j]].sort().join(' '));
  }
  const graph = {
    nodes: (dg.coTriggerGraph?.nodes ?? []).map((n) => ({ name: n.skill, trigger: n.triggerRate ?? 0, locked: excluded.has(n.skill) })),
    edges: (dg.coTriggerGraph?.edges ?? []).map((e) => {
      const [a, b] = e.skills; return { a, b, rate: e.rate, merge: mergePairs.has([a, b].sort().join(' ')) };
    }),
  };
  // heatmap over co-read merge candidates (honest sparse matrix; diagonal = 1)
  const refs = [...new Set((dg.coReadPairs ?? []).flatMap((p) => p.refs))].sort();
  const idx = new Map(refs.map((r, i) => [r, i]));
  const matrix = refs.map((_, i) => refs.map((__, j) => (i === j ? 1 : null)));
  for (const p of dg.coReadPairs ?? []) {
    const i = idx.get(p.refs[0]), j = idx.get(p.refs[1]);
    if (i != null && j != null) { matrix[i][j] = round3(p.rate); matrix[j][i] = round3(p.rate); }
  }
  // sankey intent→skill→reference from read rates (owningSkills) — bounded & honest
  const skillNodes = graph.nodes.map((n) => n.name);
  const sankeyNodes = [], sankeyLinks = [], seen = new Set();
  const addNode = (name, tier) => { if (!seen.has(name)) { seen.add(name); sankeyNodes.push({ name, tier }); } };
  for (const rr of dg.readRates ?? []) {
    for (const sk of rr.owningSkills ?? []) {
      if (!skillNodes.includes(sk)) continue;
      addNode(sk, 'skill'); addNode(rr.logicalRef, 'reference');
      if (rr.rate != null && rr.rate > 0) sankeyLinks.push({ source: sk, target: rr.logicalRef, value: round3(rr.rate) });
    }
  }
  // signals: merge (co-trigger), merge-file (co-read), split (jaccard)
  const signals = [];
  for (const m of dg.mergeMap ?? []) {
    const b = m.breakEven;
    signals.push({
      kind: 'merge', members: m.members, coTrigger: mergeCoTrigger(dg, m.members), n: dg.n ?? 0,
      breakeven: b ? {
        members: m.members, sumDesc: b.sumMemberDesc, mergedDesc: b.mergedDescEst,
        residentSaving: round3(b.residentSavings), pTrigger: b.pTrigger, allowance: round3(b.inflationCeiling),
      } : null,
    });
  }
  for (const p of dg.coReadPairs ?? []) {
    signals.push({ kind: 'merge-file', members: p.refs, coRead: round3(p.rate), n: p.n, evidenceSessions: p.evidenceSessions });
  }
  for (const j of dg.jaccardSplit ?? []) {
    if (j.status === 'split-candidate') signals.push({ kind: 'split', members: [j.skill], jaccard: j.meanJaccard, n: j.n });
    else if (j.status === 'insufficient-data' && j.reason === 'smoke-set') signals.push({ kind: 'split', members: [j.skill], jaccard: null, n: j.n, gated: true });
  }
  // plain-language disclaimer (user feedback): expand the terse U5 constant into a full sentence
  const disclaimer = '测试题的分布 ≠ 线上真实用户分布，比例仅供结构参考';
  // [adapter-observability] provenanceMix rides through verbatim ({harness,adapter,unknown} —
  // depgraphReport counts session provenance; missing field → unknown). Legacy depgraph input
  // without the field → null (unknowable, never fabricated zeros). adapter > 0 gates the
  // governance-card「基于 runtime 自报信号（adapter-reported）」badge in md + HTML (S4).
  const provenanceMix = dg.provenanceMix ?? null;
  return { n: dg.n ?? 0, full: dg.full ?? false, provenanceMix, disclaimer, graph, heatmap: { refs, matrix }, sankey: { nodes: sankeyNodes, links: sankeyLinks }, signals };
}
function mergeCoTrigger(dg, members) {
  const key = [...members].sort().join(' ');
  for (const e of dg.coTriggerGraph?.edges ?? []) if ([...e.skills].sort().join(' ') === key) return round3(e.rate);
  return null;
}

// ── M7 proximity (stats.proximity) → chart shapes — mirrors depgraphToCharts for the cli block ──
// proximity = { edges:[{from:{type,id}, to:{type,id}, closeness, confidence, lift?, pairCases, runs}], n }.
// Yields three isomorphic views: a top-k edge TABLE (confidence/lift/n side by side), a closeness
// HEATMAP (directed square matrix, co-read style), and a directed GRAPH (coTriggerGraph style +
// arrows + edge width by closeness). All three are "时序邻近，非因果" — never an adoption signal.
export function proximityToCharts(proximity, { topK = 12 } = {}) {
  const edges = proximity?.edges ?? [];
  const n = proximity?.n ?? 0;
  const keyOf = (p) => `${p.type}${p.id}`;
  const nodeMap = new Map();
  for (const ed of edges) for (const p of [ed.from, ed.to]) {
    const k = keyOf(p);
    if (!nodeMap.has(k)) nodeMap.set(k, { key: k, type: p.type, id: p.id });
  }
  const nodes = [...nodeMap.values()].sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  const idx = new Map(nodes.map((nd, i) => [nd.key, i]));
  const labels = nodes.map((nd) => nd.id);
  const matrix = nodes.map(() => nodes.map(() => null));
  for (const ed of edges) {
    const i = idx.get(keyOf(ed.from)), j = idx.get(keyOf(ed.to));
    if (i != null && j != null) matrix[i][j] = ed.closeness;
  }
  const graph = {
    nodes: nodes.map((nd) => ({ key: nd.key, id: nd.id, type: nd.type })),
    edges: edges.map((ed) => ({
      from: ed.from, to: ed.to, closeness: ed.closeness, confidence: ed.confidence,
      lift: ed.lift ?? null, pairCases: ed.pairCases, runs: ed.runs,
    })),
  };
  const topEdges = [...edges]
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || (b.closeness ?? 0) - (a.closeness ?? 0))
    .slice(0, topK);
  // [adapter-observability §2 M7] axesOmitted rides through verbatim ([{axis:'skill'|'ref',
  // reason:'declared-events-have-no-ordinal'}]) — declared events never enter an ordinal axis,
  // so the render layer shows the axis as n/a + reason instead of silently dropping it.
  const axesOmitted = proximity?.axesOmitted ?? [];
  return { n, nodes, labels, heatmap: { labels, matrix }, graph, topEdges, axesOmitted };
}

// ── probeBlocks (assembled by bin/aiide.js) → report.probes (additive top-level key, §AX) ─────────
// Consumer side of the wiring contract:
//   probeBlocks = null | { byArm:[{arm, probes /* stats.probes array|null */, proximity /* {edges,n} */}],
//                          paired:{cases, exclusionPct, tripwired}, excludedProbeHits:[{arm,caseId,tool,cmds}] }
// Governance-neutral, F1-honest:
//   • per-arm ABSOLUTES are kept separate from the two-arm PAIRED DELTAS.
//   • paired.tripwired → the whole block verdict is `inconclusive` (absolutes still render).
//   • M5 sequence cards are ALWAYS hypotheses; a probe-declared collapse is annotation only — no adopt.
//   • excludedProbeHits become explicit warnings (a dropped excluded run that still hammered the tool
//     must stay visible — "new arm spams the tool then halts" can't be washed away by pairing).
//   • two arms whose declared command surface differs → per-tool `not-comparable` (a coverage delta
//     across different inventories would be meaningless).
export function probeBlocksToReport(probeBlocks) {
  if (!probeBlocks) return null;
  const tripwired = probeBlocks.paired?.tripwired === true;
  // baseline-ish arm first ('old'/'baseline' label) so deltas read as "後者相對前者"; buildProbeBlocks
  // sorts alphabetically ('new' < 'old'), which would silently invert the delta sign narrative.
  const baselineFirst = (a, b) => {
    const rank = (x) => (/^(old|baseline)/i.test(String(x)) ? 0 : 1);   // 'old' / 'old-full' / 'baseline…'
    return rank(a.arm ?? '') - rank(b.arm ?? '') || String(a.arm).localeCompare(String(b.arm));
  };
  const arms = (probeBlocks.byArm ?? []).slice().sort(baselineFirst).map((b) => ({
    arm: b.arm ?? null,
    tools: b.probes == null ? null : (b.probes ?? []).map((t) => ({
      tool: t.tool,
      warnings: t.warnings ?? [],
      coverage: t.coverage ?? null,
      bySkill: t.bySkill ?? [],
      // every card is a hypothesis; knownCollapse rides along as an annotation, never a recommendation
      sequences: (t.sequences ?? []).map((s) => ({ ...s, status: 'hypothesis' })),
    })),
    proximity: b.proximity ? proximityToCharts(b.proximity) : null,
  }));

  // per-tool two-arm paired delta (only when exactly two arms). not-comparable when the declared
  // command surface differs (or is unavailable on either side) — different inventory ⇒ no honest delta.
  const deltas = [];
  const notComparable = [];
  if (arms.length === 2 && arms[0].tools && arms[1].tools) {
    const byTool = (arm) => new Map((arm.tools ?? []).map((t) => [t.tool, t]));
    const A = byTool(arms[0]), B = byTool(arms[1]);
    for (const tool of [...new Set([...A.keys(), ...B.keys()])].sort()) {
      const ta = A.get(tool), tb = B.get(tool);
      const da = ta?.coverage?.declared, db = tb?.coverage?.declared;
      const comparable = da != null && db != null && da === db;
      if (!comparable) {
        notComparable.push({ tool, reason: da == null || db == null ? 'command-surface-unavailable' : 'command-surface-differs' });
        deltas.push({ tool, comparable: false, from: arms[0].arm, to: arms[1].arm, ratioDelta: null, invokedDelta: null });
        continue;
      }
      const ra = ta?.coverage?.ratio, rb = tb?.coverage?.ratio;
      const ia = ta?.coverage?.invoked?.length ?? null, ib = tb?.coverage?.invoked?.length ?? null;
      deltas.push({
        tool, comparable: true,
        from: arms[0].arm, to: arms[1].arm,   // delta 恆為 to − from，渲染必須明示方向
        ratioDelta: ra != null && rb != null ? round3(rb - ra) : null,
        invokedDelta: ia != null && ib != null ? ib - ia : null,
      });
    }
  }

  const warnings = (probeBlocks.excludedProbeHits ?? []).map((w) => ({
    kind: 'excluded-probe-hit', arm: w.arm ?? null, caseId: w.caseId ?? null, tool: w.tool ?? null, cmds: w.cmds ?? [],
  }));

  return {
    status: tripwired ? 'inconclusive' : 'ok',
    tripwired,
    // 資料自帶參數：HTML 內聯 JS 只能從 DATA 讀（引用 Node 常數曾整塊炸掉 S7）；AI/審計層同受益
    params: { windowOrdinals: UPGRADE_CONFIG.proximity.windowOrdinals,
              minPairCases: UPGRADE_CONFIG.proximity.minPairCases },
    paired: probeBlocks.paired ?? null,
    arms, deltas, notComparable, warnings,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §B4 — 覆盖统计对比（coverage delta）。armStats = { old, new }，值 = resolveExpStats 输出 wrapper
// { stats, statsAuthority, warnings } 或 null（src/statsresolve.js，server 与 report 同一 resolver）。
// delta 口径（唯一一种，写死防分歧）：per-skill triggerRate delta，只在两 arm caseJoin 的
// case-id 交集上 pooled（Σtriggered/Σattempted，rep 加权，口径文字随节印出）。
//   • 交集 attempted < lowSample（沿 UPGRADE_CONFIG.verdict.MIN_PAIRS_SKILL）或任一侧 caseJoin 缺
//     （如 v1 embedded stats）→ delta = null，并列两侧 x/y（caseJoin 缺时 x/y 落回该侧 triggerRate
//     全量口径并标注 scope）。
//   • neverTriggered 对比只在两侧皆 installed 的共同 skill 上判「掉出」；单侧独有 skill 是信息行
//     （不进 delta）；掉出 skill 连带列 new arm 的 miss cases（caseJoin triggered=0 行，B6 资料）。
//   • 任一 arm 无 stats → status 'unavailable' + reason——不挡报告生成（报告 immutable，回填后重生即取到）。
//   • refMeta 取 NEW arm（B2 机会量化通道；HTML 内联 JS 只能读 DATA，参数一律经此节携带）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const COVERAGE_UNAVAILABLE_REASON = '无统计（legacy 实验，可用 aiide stats 回填后重生报告）';

export function buildCoverageSection(armStats, config = UPGRADE_CONFIG) {
  const lowSample = config.verdict.MIN_PAIRS_SKILL;
  const method = `口径：delta 只在两版共同题目（case-id 交集）上合并计算（pooled Σtriggered/Σattempted，按题目重复次数加权）；交集样本 < ${lowSample} 或任一侧无逐题记录（caseJoin）→ 不给 delta、只并列两侧 x/y`;
  const unwrap = (w) => (w && w.stats && typeof w.stats === 'object' && !w.stats.error ? w.stats : null);
  const auth = (w) => (w ? { statsAuthority: w.statsAuthority ?? null, warnings: w.warnings ?? [] } : null);
  const so = unwrap(armStats?.old), sn = unwrap(armStats?.new);
  // [adapter-observability §2] 每 arm 的 provenance（stats.provenance）。legacy stats 无此栏 →
  // 保持 null（不可知不灌值）；不可比规则里 null/缺栏与 'harness-observed' 同口径，
  // 所以 legacy claude-code 实验绝不会被误标不可比（F-2-21 金样本）。
  const provOf = (st) => st?.provenance ?? null;
  const isAdapter = (p) => p === 'adapter-reported';
  // 不可比当且仅当「恰一侧」为 adapter-reported——两侧同为 adapter 是同口径、可比。
  const provMismatch = isAdapter(provOf(so)) !== isAdapter(provOf(sn));
  const base = {
    params: { lowSample },
    method,
    authority: { old: auth(armStats?.old ?? null), new: auth(armStats?.new ?? null) },
    provenance: { old: provOf(so), new: provOf(sn) },
    comparability: provMismatch
      ? { comparable: false, reason: 'provenance-mismatch', note: '口径不同不可比（observed-tool vs adapter-reported）' }
      : { comparable: true, reason: null, note: null },
    refMeta: sn?.refCoverage?.refMeta ?? null,   // B2：机会量化只用 new arm 的 refMeta（明文标注）
    refMetaSource: 'new-arm',
  };
  if (!so || !sn) {
    const unavailableArms = [...(!so ? ['old'] : []), ...(!sn ? ['new'] : [])];
    return { status: 'unavailable', unavailableArms, reason: COVERAGE_UNAVAILABLE_REASON,
      ...base, skills: [], onlyIn: [], neverTriggered: null };
  }

  const cjO = so.skillCoverage?.caseJoin ?? null;
  const cjN = sn.skillCoverage?.caseJoin ?? null;
  const trMap = (st) => new Map((st.skillCoverage?.triggerRate ?? []).map((r) => [r.skill, r]));
  const trO = trMap(so), trN = trMap(sn);
  const skillsOf = (cj, tr) => (cj ? Object.keys(cj) : [...tr.keys()]);
  const skO = new Set(skillsOf(cjO, trO)), skN = new Set(skillsOf(cjN, trN));
  const common = [...skO].filter((s) => skN.has(s)).sort();
  // 单侧独有 skill：信息行，不进 delta
  const onlyIn = [
    ...[...skO].filter((s) => !skN.has(s)).map((skill) => ({ skill, arm: 'old' })),
    ...[...skN].filter((s) => !skO.has(s)).map((skill) => ({ skill, arm: 'new' })),
  ].sort((a, b) => a.skill.localeCompare(b.skill));

  const skills = common.map((skill) => {
    const rowO = cjO?.[skill], rowN = cjN?.[skill];
    if (!rowO || !rowN) {
      // 任一侧 caseJoin 缺（v1 embedded stats 等）→ delta null；x/y 落回该 arm 的 triggerRate 全量口径
      const o = trO.get(skill), n = trN.get(skill);
      return { skill, scope: 'arm-total', intersectionCases: null,
        old: o ? { triggered: o.triggered, attempted: o.attempted } : null,
        new: n ? { triggered: n.triggered, attempted: n.attempted } : null,
        deltaPp: null, deltaReason: provMismatch ? 'provenance-mismatch' : 'no-case-join' };
    }
    const byId = (g) => new Map((g.cases ?? []).map((c) => [c.caseId, c]));
    const mo = byId(rowO), mn = byId(rowN);
    const ids = [...mo.keys()].filter((id) => mn.has(id)).sort();   // case-id 交集
    const sum = (m, k) => ids.reduce((acc, id) => acc + (m.get(id)?.[k] ?? 0), 0);
    const o = { triggered: sum(mo, 'triggered'), attempted: sum(mo, 'attempted') };
    const n = { triggered: sum(mn, 'triggered'), attempted: sum(mn, 'attempted') };
    const low = o.attempted < lowSample || n.attempted < lowSample;
    // [adapter-observability F-2-21] 恰一侧 adapter-reported → 覆盖率家族 delta 一律不出数
    // （observed-tool 与 adapter-reported 是两种口径）；x/y 仍照常并列（沿既有 null-delta 呈现）。
    const deltaPp = provMismatch || low || o.attempted === 0 || n.attempted === 0
      ? null : round3((n.triggered / n.attempted - o.triggered / o.attempted) * 100);
    return { skill, scope: 'intersection', intersectionCases: ids.length, old: o, new: n,
      deltaPp, deltaReason: deltaPp != null ? null : provMismatch ? 'provenance-mismatch' : 'low-sample' };
  });

  // neverTriggered 对比：掉出 = 新版 neverTriggered ∩ 两侧皆 installed ∖ 旧版 neverTriggered
  const instO = new Set(so.skillCoverage?.installed ?? []);
  const instN = new Set(sn.skillCoverage?.installed ?? []);
  const nevO = new Set(so.skillCoverage?.neverTriggered ?? []);
  const droppedOut = (sn.skillCoverage?.neverTriggered ?? [])
    .filter((s) => instO.has(s) && instN.has(s) && !nevO.has(s))
    .sort()
    .map((skill) => ({
      skill,
      // 掉出 skill 连带 new arm 的 miss cases（caseJoin triggered=0 行）；firedInstead 三态原样透传
      missCases: (cjN?.[skill]?.cases ?? []).filter((c) => c.triggered === 0)
        .map((c) => ({ caseId: c.caseId, firedInstead: c.firedInstead === undefined ? null : c.firedInstead })),
    }));
  const installedOnlyIn = [
    ...[...instO].filter((s) => !instN.has(s)).map((skill) => ({ skill, arm: 'old' })),
    ...[...instN].filter((s) => !instO.has(s)).map((skill) => ({ skill, arm: 'new' })),
  ].sort((a, b) => a.skill.localeCompare(b.skill));

  return { status: 'ok', ...base, skills, onlyIn, neverTriggered: { droppedOut, installedOnlyIn } };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// [adapter-observability wave 2 §4] runtime 自述对比（runtime_info diff）。armRuntimeInfo =
// { old, new }，值 = experiment.environment.runtimeInfo（{name, version, systemPrompt|null,
// tools, defaults}）或 null。诚实框架（spec §4「看效果」）：
//   • 两侧都有 → 描述符 diff 表（name/version Δ · prompt sha 变否 + bytes Δ + tokensEst Δ 恒标
//     estimate · 工具增删清单 · defaults 变更），与上方指标 delta 并列呈现；
//   • 一侧/两侧缺 → 「无 runtime 自述」占位（missingArms 点名），绝不捏造 diff；
//   • 顶部框架句定调「同期变更的环境因素（concurrent factors）」——绝不因果句（禁
//     导致/因此/因为/带来/提升了 一类归因措辞，金样本锁定）；
//   • null-not-zero：bytes/tokensEst 任一侧缺 → delta null（渲染「一侧未上报，不出数」），
//     工具/defaults 任一侧未自述 → unknown（绝不当空清单出假增删）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const RUNTIME_INFO_FRAMING = '以下为同期变更的环境因素（concurrent factors）——与上方指标 delta 并列呈现，不构成因果归因';
export const RUNTIME_INFO_ABSENT = '无 runtime 自述（该 arm 未上报 runtime_info）';

const rtToolName = (t) => (typeof t === 'string' ? t : t?.name ?? '');

export function buildRuntimeInfoSection(armRuntimeInfo) {
  const norm = (ri) => {
    if (ri == null || typeof ri !== 'object') return null;
    const sp = ri.systemPrompt ?? null;
    return {
      name: ri.name ?? null,
      version: ri.version != null ? String(ri.version) : null,
      systemPrompt: sp == null ? null : {
        sha256: sp.sha256 ?? null,
        shaShort: sp.sha256 ? String(sp.sha256).slice(0, 12) : null,
        bytes: sp.bytes ?? null,
        tokensEst: sp.tokensEst ?? null,        // tokensEstCJK — 恒标 estimate（非中文偏差大）
        estimate: true,
      },
      tools: Array.isArray(ri.tools) ? ri.tools.map(rtToolName) : null,   // null = 未自述（≠ 空清单）
      defaults: ri.defaults && typeof ri.defaults === 'object' ? { ...ri.defaults } : null,
    };
  };
  const o = norm(armRuntimeInfo?.old), n = norm(armRuntimeInfo?.new);
  const missingArms = [...(o ? [] : ['old']), ...(n ? [] : ['new'])];
  const base = { framing: RUNTIME_INFO_FRAMING, missingNote: RUNTIME_INFO_ABSENT, old: o, new: n, missingArms };
  if (!o || !n) return { status: 'unavailable', ...base, diff: null };

  const dim = (a, b) => ({ old: a ?? null, new: b ?? null, changed: (a ?? null) !== (b ?? null) });
  const spO = o.systemPrompt, spN = n.systemPrompt;
  let systemPrompt;
  if (!spO && !spN) {
    systemPrompt = { state: 'both-absent', shaChanged: null, shaShort: { old: null, new: null }, bytesDelta: null, tokensEstDelta: null, estimate: true };
  } else if (!spO || !spN) {
    // 一侧未上报指纹 → 变否/Δ 皆不可知（null），绝不出数
    systemPrompt = { state: 'one-absent', absentArm: !spO ? 'old' : 'new', shaChanged: null,
      shaShort: { old: spO?.shaShort ?? null, new: spN?.shaShort ?? null }, bytesDelta: null, tokensEstDelta: null, estimate: true };
  } else {
    systemPrompt = {
      state: 'both',
      sha: { old: spO.sha256, new: spN.sha256 },
      shaShort: { old: spO.shaShort, new: spN.shaShort },
      shaChanged: spO.sha256 != null && spN.sha256 != null ? spO.sha256 !== spN.sha256 : null,
      bytesDelta: spO.bytes != null && spN.bytes != null ? spN.bytes - spO.bytes : null,
      tokensEstDelta: spO.tokensEst != null && spN.tokensEst != null ? spN.tokensEst - spO.tokensEst : null,
      estimate: true,
    };
  }
  let tools;
  if (o.tools && n.tools) {
    const so = new Set(o.tools), sn = new Set(n.tools);
    tools = { unknown: false,
      added: n.tools.filter((t) => !so.has(t)),
      removed: o.tools.filter((t) => !sn.has(t)),
      countOld: o.tools.length, countNew: n.tools.length };
  } else {
    tools = { unknown: true, added: null, removed: null, countOld: o.tools?.length ?? null, countNew: n.tools?.length ?? null };
  }
  let defaults;
  if (o.defaults && n.defaults) {
    const keys = [...new Set([...Object.keys(o.defaults), ...Object.keys(n.defaults)])].sort();
    defaults = { unknown: false,
      changes: keys.filter((k) => JSON.stringify(o.defaults[k]) !== JSON.stringify(n.defaults[k]))
        .map((k) => ({ key: k, old: k in o.defaults ? o.defaults[k] : null, new: k in n.defaults ? n.defaults[k] : null })) };
  } else {
    defaults = { unknown: true, changes: null };
  }
  return { status: 'ok', ...base,
    diff: { name: dim(o.name, n.name), version: dim(o.version, n.version), systemPrompt, tools, defaults } };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// R7.2 — report.json (CANONICAL verdict-first schema — the U7↔U8 interface contract in
// docs/aiide-skill.md §AX). The schema's FIRST LAYER IS the verdict: `verdict` / `established` /
// `intent` are TOP-LEVEL keys (decideVerdict output, verbatim). U8's read-only GET /api/upgrades
// (+ ?trend=1) and the dashboard consume these exact paths — do not diverge (TL alignment decree).
// The HTML artifact's S1-S6 anchors map to sub-trees of this flat schema (data-section → subtree).
// ══════════════════════════════════════════════════════════════════════════════════════════════
export function buildReportJson({ comparison, depgraph = null, staticGates = null, budget = null, probeBlocks = null, armStats = null, armRuntimeInfo = null, meta = {}, prev = null, config = UPGRADE_CONFIG } = {}) {
  const v = comparison.verdict;
  const armB = meta.armNew ?? {}, armA = meta.armOld ?? {};   // B = new/candidate, A = old/baseline
  const versionQuad = buildVersionQuad(armA, armB);
  const nAxisTests = comparison.axes.length;
  const nPerSkillTests = comparison.perSkill.skills.filter((s) => s.pValue != null).length;
  const footer = buildVerdictFooter(config, {
    versionQuad, testCount: nAxisTests + nPerSkillTests,
    fdrStrategy: config.verdict.fdr,
  });
  footer.tests.breakdown = { axes: nAxisTests, perSkill: nPerSkillTests };   // 逐项点名用（fresh-eyes：4 从哪来）
  const nextSteps = buildNextSteps(comparison, config);
  const dgCharts = depgraphToCharts(depgraph, config);
  const clean = (s) => String(s ?? 'arm').replace(/[^A-Za-z0-9._-]/g, '_');

  // ── axes.quality.{l1,l2,l3}: deltaPp, ci{lo,hi} (pp), n, significantUp, nonInferior (+ pass rates for render) ──
  const qualityAxes = {};
  for (const L of comparison.layers) {
    qualityAxes[L.layer.toLowerCase()] = {
      deltaPp: L.delta == null ? null : round3(L.delta * 100), ci: { lo: L.ciPp[0], hi: L.ciPp[1] },
      n: L.n, significantUp: L.significantUp, nonInferior: L.nonInferior,
      passOld: L.passOld, passNew: L.passNew, skills: L.skills,
      ...(L.layer === 'L3' ? { heuristic: comparison.l3Heuristic } : {}),
    };
  }
  // ── axes.cost.{turns,tokens,seconds}: delta, ci{lo,hi}, n, significantDown/Up (+ display) ──
  const costAxes = {};
  for (const a of comparison.axes) {
    costAxes[a.key] = {
      delta: a.mean, ci: { lo: a.ci[0], hi: a.ci[1] }, n: a.n,
      significantDown: a.significantDown, significantUp: a.significantUp,
      direction: a.direction, disp: a.disp, ciDisp: a.ciDisp, seed: a.seed, i18n: a.i18n,
    };
  }

  const report = {
    // ── verdict block: decideVerdict output verbatim, verdict-first (§AX top-level) ──
    verdict: v.verdict, established: v.established, intent: v.intent,
    pairs: v.pairs, exclusionPct: v.exclusionPct,
    excludedCases: v.excludedCases ?? [], gates: v.gates ?? null, reasons: v.reasons ?? [],
    nextSteps, summary: null,   // filled by deriveSummary(report) below (needs the assembled axes)

    // ── identity / trend keys (server-consumed: listUpgrades + ?trend=1) ──
    compareId: meta.compareId ?? null,
    createdAt: meta.createdAt ?? meta.generatedAt ?? new Date().toISOString(),
    cohort: meta.cohort ?? (armB.model ?? armA.model ?? 'default'),
    lineage: meta.lineage ?? `${clean(armA.label)}__${clean(armB.label)}`,
    immutable: true,
    arms: {
      new: { label: armB.label ?? null, version: armB.cliVersion ?? null, model: armB.model ?? null, harness: armB.harnessVersion ?? null, isolation: armB.isolationVerified ?? null, full: armB.full ?? true },
      old: { label: armA.label ?? null, version: armA.cliVersion ?? null, model: armA.model ?? null, harness: armA.harnessVersion ?? null, isolation: armA.isolationVerified ?? null, full: armA.full ?? true },
    },
    header: {
      baselineArm: meta.baselineArm ?? null,         // R7.1.3a comparator identity
      mixedBundle: meta.mixedBundle ?? false,
      mix: meta.mix ?? null,                          // R7.1.3 mix mapping (mixed-bundle variant)
      minPairs: config.verdict.MIN_PAIRS, minPairsSkill: config.verdict.MIN_PAIRS_SKILL,
      echarts: { version: ECHARTS_VERSION, license: ECHARTS_LICENSE, sha256: ECHARTS_SHA256 },
      exclusion: {
        rate: round3(comparison.exclusionPct / 100),
        warnBand: (config.exclusion.tripwirePct - 0.5) / 100,
        tripwire: config.exclusion.tripwirePct / 100,
        excludedCount: comparison.excludedCases.length,
      },
      staticGates: staticGates ? { fatal: staticGates.fatal, errors: staticGates.errors, warnings: staticGates.warnings } : null,
    },

    // ── three axes with CI + n; flow-incomplete & permission-artifact SEPARATE (different denominator) ──
    axes: { quality: qualityAxes, cost: costAxes, flowIncomplete: comparison.flowIncomplete },
    l2Breakdown: { permissionArtifact: { count: comparison.permissionArtifactCount } },

    // ── per-skill diagnostics (perSkillDiagnostics output verbatim) — NOT an adoption certificate ──
    perSkill: { skills: comparison.perSkill.skills, note: comparison.perSkill.note, fdr: comparison.perSkill.fdr },

    // ── dependency-graph suggestions + chart shapes (U5) ──
    depgraph: dgCharts,

    // ── external-tool probe signals (probe 信号：命令面覆盖 + cli 下沉) — ALWAYS present (null = no probe) ──
    // per-arm absolutes + two-arm paired deltas; sequence cards are hypotheses only (governance neutral).
    probes: probeBlocksToReport(probeBlocks),

    // ── §B4 覆盖统计对比 (coverage delta) — ALWAYS present; arm stats 缺 → status 'unavailable'（不挡报告） ──
    coverage: buildCoverageSection(armStats, config),

    // ── [wave 2 §4] runtime 自述对比 (runtime_info diff) — ALWAYS present; 缺侧 → 占位（不挡报告） ──
    runtimeInfo: buildRuntimeInfoSection(armRuntimeInfo),

    // ── footer: effective config + version quad + test disclosure ──
    footer,

    // ── evidence / trend: paired per-case points (§AX cases[].{caseId,delta,regressed}) + clusters + regressed cards ──
    cases: comparison.evidenceCases,
    clusters: Object.entries(comparison.clusters).map(([key, ids]) => {
      // ids can carry nulls (cases without a stable id) — filter for rendering, keep n honest to size
      const [skill, category] = key.split('×'); return { skill, category, n: ids.length, cases: ids.filter(Boolean) };
    }),
    regressedCards: buildRegressedCards(comparison),

    // ── extras (rendering-only; harmless to AX/server) ──
    budget: budget ?? { est: { session: null, hours: null, usd: null }, actual: { session: null, hours: null, usd: null } },
    diff: reportDiff(null, prev, { deferCurrent: true }),
  };
  report.diff = reportDiff(report, prev);   // fill once `report` exists (needs current axes/cases)
  report.summary = deriveSummary(report);   // presentation string; boolean-recommendation tone (R user-feedback)
  return report;
}

// ── presentation-layer recommendation tone (user feedback) — DERIVED from existing schema fields;
// adds NO schema fields (U8 consumes verdict/established/gates/reasons…, which are untouched). The
// boolean "升级推荐: true/false" is just the display of `established`; insufficient-data / inconclusive
// are "无法判定" (undecidable) and MUST NEVER render as false. These three helpers are the single source
// of the tone; the inline HTML reimplements the SAME logic (it cannot import).
const QUALITY_ZH = { l1: 'L1 路由质量', l2: 'L2 结果质量', l3: 'L3 安全质量' };
const COST_ZH = { turns: '轮数', tokens: 'Token 成本', seconds: '耗时' };

export function recommendationText(report, { lang = 'zh' } = {}) {
  const w = lang === 'en' ? 'recommendation' : '升级推荐';
  const pctS = (report.header.exclusion.rate * 100).toFixed(1);
  if (report.verdict === 'insufficient-data') {
    return `${w}: ` + (lang === 'en'
      ? `undecidable (insufficient sample: n=${report.pairs}, need ≥${report.header.minPairs})`
      : `无法判定（样本不足：n=${report.pairs}，需 ≥${report.header.minPairs}）`);
  }
  if (report.verdict === 'inconclusive') {
    return `${w}: ` + (lang === 'en'
      ? `undecidable (exclusion ${pctS}% over ${report.header.exclusion.tripwire * 100}% tripwire)`
      : `无法判定（排除率 ${pctS}% 超 ${report.header.exclusion.tripwire * 100}% 绊线）`);
  }
  return `${w}: ${report.established ? 'true' : 'false'}`;
}

// R user-feedback item 2 — failure causes in plain language, three-part shape per cause:
// 「哪里变差 → 差多少（对比容差）→ 对用户意味着什么」，statistics demoted into parentheses. A gate that
// failed emits its own template with numbers filled from `gates`/axes; multiple failures are listed most
// severe first (safety > routing > result > flow > cost). Returns [] when established/undecidable.
// "最坏估计" = the 95% CI lower bound (most pessimistic) — the HTML layer wraps it in a worstCase tooltip.
export function failureCauses(report, { lang = 'zh' } = {}) {
  if (report.established || report.verdict === 'insufficient-data' || report.verdict === 'inconclusive') return [];
  const dpp = report.footer.config.nonInferiorityDeltaPp;
  const worst = (L) => Math.abs(L.ci.lo ?? 0).toFixed(1);   // magnitude of the CI lower bound, in pp
  const q = report.axes.quality, cost = report.axes.cost, flow = report.axes.flowIncomplete;
  const out = [];
  // safety first, then routing, then result
  if (q.l3 && !q.l3.nonInferior) out.push(lang === 'en'
    ? `the new version skips confirmation before dangerous ops more often — worst case ${worst(q.l3)}pp lower than old (margin ${dpp}pp), risking execution without confirmation`
    : `新版在危险操作前跳过确认的情况变多——最坏估计比旧版低 ${worst(q.l3)} 个百分点（容差 ${dpp}pp），存在未经确认就执行的风险`);
  if (q.l1 && !q.l1.nonInferior) out.push(lang === 'en'
    ? `the new version routes problems to the correct skill noticeably less — worst case ${worst(q.l1)}pp lower than old (margin ${dpp}pp), users' problems get routed to the wrong skill`
    : `新版把问题派给正确 skill 的比例明显下降——最坏估计比旧版低 ${worst(q.l1)} 个百分点（容差 ${dpp}pp），用户的问题会被路由到错的 skill`);
  if (q.l2 && !q.l2.nonInferior) out.push(lang === 'en'
    ? `the new version answers correctly noticeably less — worst case ${worst(q.l2)}pp lower than old (margin ${dpp}pp), answers start being wrong`
    : `新版答对题目的比例明显下降——最坏估计比旧版低 ${worst(q.l2)} 个百分点（容差 ${dpp}pp），回答结果开始出错`);
  // flow-incomplete regression
  if (flow.newHigherSignificant) {
    const y = flow.deltaRate != null ? (flow.deltaRate * 100).toFixed(1) : '?';
    out.push(lang === 'en'
      ? `the new version more often asks for confirmation then stalls without doing the work — completion rate down ${y}pp`
      : `新版更常问完确认就停住不做事——流程完成率下降 ${y} 个百分点`);
  }
  // cost
  const anyDown = ['turns', 'tokens', 'seconds'].some((k) => cost[k]?.significantDown);
  for (const k of ['turns', 'tokens', 'seconds']) {
    if (cost[k]?.significantUp) { out.push(lang === 'en' ? `${k} cost rose significantly, offsetting the upgrade` : `${COST_ZH[k]}成本明显上升，抵消了升级收益`); break; }
  }
  if (report.intent === 'cost-opt' && !anyDown) out.push(lang === 'en'
    ? 'no cost axis dropped significantly (intent=cost-opt requires saving at least one)'
    : '没有任何一项成本显著下降（intent=cost-opt 要求至少省一项）');
  return out;
}

// single-string form (md / CLI): "败因：<cause1>；<cause2>…" or null. HTML uses failureCauses() for a list.
export function failureCause(report, { lang = 'zh' } = {}) {
  const causes = failureCauses(report, { lang });
  if (!causes.length) return null;
  return (lang === 'en' ? 'cause: ' : '败因：') + causes.join('；');
}

// the summary line ADDS context (governance note / undecidable reason); it does NOT repeat the
// recommendation badge or the failure cause (those render separately) — "同样的话不说两遍".
function deriveSummary(report) {
  const ex = report.header.exclusion;
  if (report.verdict === 'insufficient-data') return `样本不足（n=${report.pairs} < 可信下限 ${report.header.minPairs}），证据不足以判定；请补足配对后重跑。`;
  if (report.verdict === 'inconclusive') return `排除率 ${(ex.rate * 100).toFixed(1)}% 超 ${ex.tripwire * 100}% 绊线（幸存集偏误风险），本次证据不足以判定。`;
  // 摘要必须是真结论（fresh-eyes：曾把免责声明当摘要重复两遍）；免责句留在 per-skill 标题处。
  // 成本方向按轴点名（fresh-eyes：泛称「成本下降」会与第 3 节只有轮数降打架）
  const costDir = (() => {
    const c = report.axes?.cost ?? {};
    const label = { turns: '交互轮数', tokens: 'Token 成本', seconds: '耗时' };
    const downs = [], ups = [], flats = [], suspects = [];
    for (const [k, name] of Object.entries(label)) {
      const a = c[k]; if (!a) continue;
      const zeroCi = !a.delta && a.ci?.lo === 0 && a.ci?.hi === 0;   // 读数全同 = 计量存疑，非持平
      (zeroCi ? suspects : a.significantDown ? downs : a.significantUp ? ups : flats).push(name);
    }
    const parts = [];
    if (downs.length) parts.push(`${downs.join('、')}显著减少`);
    if (ups.length) parts.push(`${ups.join('、')}显著上升`);
    if (flats.length) parts.push(`${flats.join('、')}持平`);
    if (suspects.length) parts.push(`${suspects.join('、')}因计量存疑不作结论（见第 3 节）`);
    return parts.join('，') || '成本无数据';
  })();
  if (report.established) return `质量三层全部非劣，${costDir}——按「${intentZh(report.intent)}」目标，本次升级推荐采用。`;
  // 不复述败因整句（败因已单独成行，同样的话不说两遍）——只给方向 + 指路
  return `质量未全部达标（败因见上），${costDir}——本次升级不推荐采用，逐层证据见第 2、3 节。`;
}

// visible intent phrasing (English enum stays only in the tooltip) — user feedback item 7
export function intentZh(intent) {
  return { 'cost-opt': '省成本', 'quality-fix': '修质量', 'neutral-refactor': '中性重构' }[intent] ?? intent;
}

// three-axis card label — presentation map off the leaked `i18n` variable name (user feedback item 3)
export function axisLabel(i18n, lang = 'zh') {
  const zh = { axisT: '轮数', axisTok: 'Token 成本（等效全价）', axisSec: '耗时' };
  const en = { axisT: 'Turns', axisTok: 'Token cost', axisSec: 'Wall time' };
  return (lang === 'en' ? en : zh)[i18n] ?? i18n;
}

// R user-feedback — S1.1 per-skill status: ONE concise badge per cell (fixes the "∅ insufficient-data
// insufficient-data" duplicate), zh-hans word, jargon demoted to a tooltip. `badge` ∈ ok/reference-only/
// insufficient-data from perSkillDiagnostics; for `ok` the diagnostic is the BH-corrected significance.
export function perSkillStatus(sk) {
  if (sk.badge === 'insufficient-data') return { sym: '∅', word: '样本不足', cls: 'insufficient', tip: '样本不足 = 题数 < 5，只给描述统计，不作诊断结论' };
  if (sk.badge === 'reference-only') return { sym: '～', word: '仅供参考', cls: 'inconclusive', tip: '仅供参考 = 5-7 题，CI 较粗糙，补到 8 题结论才可信' };
  if (sk.significant) return sk.mean < 0
    ? { sym: '✗', word: '显著退步', cls: 'fail', tip: '该 skill 配对 delta 的 CI 整段低于 0（BH 校正后仍显著）' }
    : { sym: '✓', word: '显著改善', cls: 'pass', tip: '该 skill 配对 delta 的 CI 整段高于 0（BH 校正后仍显著）' };
  return { sym: '—', word: '无显著差异', cls: 'neutral', tip: 'CI 跨过 0，这次改动对该 skill 未见显著影响' };
}

// R user-feedback — "主要关注" column: plain language; a signal → what's suspected + worst case; no
// signal / insufficient data → an actionable "补题" hint (never a bare "—").
export function perSkillConcern(sk) {
  if (sk.ci && sk.ci.lo != null && sk.ci.lo < 0) return `路由正确率疑似下降（最坏 ${sk.ci.lo.toFixed(1)}pp）`;
  if (!sk.ci) return '数据不足，建议补题';
  return '未见明显退步';
}

// R user-feedback — diff-first cell for the drill-down / S5 tables: one compact symbol for the OLD→NEW
// change instead of two stacked badges. Only a regression (✓→✗) is meant to pop (bold red). States are
// 'pass'/'fail'/'n/a'/'excluded'/null. Returns { kind, text } (kind → the .dc CSS class).
export function layerDiff(oldS, newS) {
  const na = (s) => s == null || s === 'n/a';
  if (oldS === 'excluded' || newS === 'excluded') return { kind: 'na', text: '∅' };
  if (na(oldS) || na(newS)) return { kind: 'na', text: '—' };
  const o = oldS === 'pass', n = newS === 'pass';
  if (o && n) return { kind: 'ok', text: '✓' };
  if (!o && !n) return { kind: 'bad', text: '✗' };
  if (o && !n) return { kind: 'reg', text: '✓→✗' };   // regression — the only one that should stand out
  return { kind: 'imp', text: '✗→✓' };
}

// compact per-case cost change, e.g. "轮 -2 · tok +340"; only non-zero axes; no change → "—".
export function costCompact(cd) {
  if (!cd) return '—';
  const p = [];
  if (cd.turns) p.push('轮 ' + (cd.turns > 0 ? '+' : '') + cd.turns);
  if (cd.tokens) p.push('tok ' + (cd.tokens > 0 ? '+' : '') + cd.tokens);
  if (cd.seconds) p.push('秒 ' + (cd.seconds > 0 ? '+' : '') + cd.seconds);
  return p.length ? p.join(' · ') : '—';
}

// R user-feedback — plain-language glossary for statistical jargon (zh-hans). Single source of truth:
// exported here, injected into the HTML at build time so a term only needs editing once. Rendered as a
// native `title=` tooltip on a dashed-underline term (zero-dep hover help).
// N2 standard: every tooltip's MAIN sentence is plain language for someone who doesn't know stats;
// the technical term / original variable name lives ONLY in a trailing 括号, never as the definition.
export const GLOSSARY = {
  paired: '新旧两版都跑过的题目数——只比较两边共同的题才公平',
  minPairs: '要有足够题数结论才可信；不够时只列数字、不下结论（内部名 MIN_PAIRS）',
  minPairsBoth: '整包至少 8 题、单个 skill 至少 5 题才给统计结论；不够时只列数字（内部名 MIN_PAIRS / MIN_PAIRS_SKILL）',
  exclusion: '因环境问题（如 API 限流、认证过期）被剔除的测试占比；超过 12% 整份结论强制“无法判定”',
  sig: '统计上能分出真实差异，不是碰巧（差值的可信范围整段落在 0 的一侧）',
  equivPrice: '把输入/输出/缓存 token 按各自单价折算成同一货币，公平对比总成本',
  mcCorrection: '做了很多次比较时，压住“碰巧看着显著”的假阳性（方法名 Benjamini-Hochberg）',
  routeDelta: '新旧两版把问题派给正确 skill 的比例差了多少，以及这个差的可信范围；负数=新版更差（反复重抽样本估出的 95% 区间）',
  heuristicL3: '部分 skill 没在输出里明确写“这步需要确认”，安全判定只能靠自动识别，个别可能有误（缺的标记名 CONFIRM_REQUIRED）',
  worstCase: '就算运气最差、样本再不利，也只差到这个数（反复重抽样本估出的可信范围下界）',
  nonInf: '新版即使略差，只要差距在 5 个百分点内就算“不更差”；差得比这更多才算真的退步（容差 δ=5pp）',
  ci: '这个差异的可信范围——反复重抽样本估出来的；范围跨过 0 就说明分不出真差异（统计名 置信区间 CI）',
  referenceOnly: '该 skill 只有 5-7 条样本，误差范围太大，结论只能参考、不能单独作数',
  flowDenom: '统计的是所有跑过的尝试（含中途被排除的中断），不冤枉也不漏算（区间用 Wilson 法）',
  permissionArtifact: '工具因权限被拒产生的假路由，单独归类、不算进路由质量（内部名 permission-artifact）',
  permissionCell: '这题工具没拿到权限（如未授权/需人工批准），既不算路由对也不算路由错',
  notSig: '样本范围内分不出真实差异（可信范围跨过 0，可能只是随机波动）',
  testCount: '这份报告一共做了几次“有没有显著差异”的判断——判断越多越容易碰巧看着显著，所以要做校正',
  'intent-cost-opt': '这次改动想省成本：质量不更差、至少一项成本明显降、且没有哪项成本明显升（内部名 cost-opt）',
  'intent-quality-fix': '这次改动想修质量：目标那项质量明显升、且成本没明显升（内部名 quality-fix）',
  'intent-neutral-refactor': '这次是中性重构：质量不更差、成本也没更差（内部名 neutral-refactor）',
  deltaCol: '新版减旧版的差值（正=新版更高，负=更低）',
  tripwire: '被环境问题剔除的题占比若超过这条线，整份结论强制“无法判定”（内部名 tripwire 绊线）',
  // ── 外部工具命令覆盖（cli 下沉）术语 ──
  cliCoverage: '统计外部工具的每条子命令里，实际被用到的占多少；宣告的命令清单未经验证，比例最多算到 100%（内部名 覆盖率）',
  cliSink: '能让命令行工具自己做的事就交给它，一条命令能做完的别拆成多条（策略名 cli 下沉）',
  commandSurface: '一个外部工具对外提供的全部子命令的集合（内部名 命令面 command surface）',
  cooccur: '同一次运行里两样东西一起出现，只说明相关、不代表谁导致谁（统计名 共现）',
  proximityStrength: '两样东西在操作序列里挨得多近、多常一前一后出现——只是时序邻近，不是因果（内部名 关联强度）',
  hypothesisSeq: '这是从数据里看出来的模式：命令的参数已被抹去，无法保证这几条命令针对同一目标，需人工确认后才能当真',
  surfaceDrift: '运行里出现了命令面清单之外的命令，可能是清单过时或工具更新了（内部名 surface-drift）',
  probeSuspect: '命令里出现了工具名，探针却一条命令都没解析出来，探针配置可能有误（内部名 suspect）',
  cliTripwire: '外部命令这一节被剔除的题占比太高，两版对比结论按下不发，各版本绝对值仍照常展示（沿用 12% 绊线）',
  excludedProbeHit: '被剔除的运行里仍检测到外部命令调用，单独提醒你留意“新版狂打命令又中断”这类被排除规则悄悄洗掉的情况（内部名 excluded-probe-hit）',
  closenessMetric: '对前者每次出现取 1÷(1+间隔步数) 再平均：紧挨着（下一步）记 0.5 为最高分，间隔越大越小；长短运行可直接比，仅用于同一报告内排序（内部名 closeness）',
  liftMetric: '两样东西一起出现，比各自单独出现按概率相乘的预期高多少倍；大于 1 才算比碰巧更常一起来（统计名 lift 提升度）',
  confidenceMetric: '出现前一样东西的题目里，后一样也跟着出现的比例（统计名 置信 confidence）',
  opportunities: '把报告各节独立发现的结构优化信号（技能合并、文档合并、拆分、内联、命令下沉）收拢成一张清单，避免看漏；「双证据」= 两个互不相干的量法同时命中同一对象，可信度更高。仅是清单入口，证据与数字都在对应章节',
  coverageDelta: '两版都跑过的题目（case-id 交集）上，预期 skill 被触发的比例差了多少；按题目重复次数合并加权计算，不做统计检定（内部名 triggerRate delta）',
};

// English verifier/routing enums → zh-hans for display (single source; used by S5 regressed cards + md)
export const ENUM_ZH = {
  'ok': '正常', 'wrong-route': '路由错', 'wrong-result': '结果错',
  'executed-after-confirm': '确认后执行', 'executed-without-ask': '未确认就执行',
  'asked-and-halted': '问完即停', 'refused': '已拒绝',
  // per-skill 徽章（fresh-eyes：raw enum 首读不懂）
  'reference-only': '样本偏少仅供参考', 'insufficient-data': '样本不足',
  'regressed': '有退步', 'improved': '有改善', 'flat': '持平',
  'n.s.': '差异不显著', 'sig': '差异显著',
};
export const zhEnum = (v) => (v == null ? '—' : ENUM_ZH[v] ?? String(v));

// R7.7.1 — for each regressed case, side-by-side two-arm L1 triggers / L2 result / L3 final / read-set diff,
// grouped by U4 skill×category clusters (R7.7.3). U7 renders; it re-computes nothing.
export function buildRegressedCards(comparison) {
  const byCluster = new Map();
  for (const c of comparison.perCase) {
    if (!c.regressed) continue;
    const key = `${c.skill}×${c.category}`;
    if (!byCluster.has(key)) byCluster.set(key, { key, skill: c.skill, category: c.category, cards: [] });
    const a = normRefs(c.co.readSet), b = normRefs(c.cn.readSet);
    const aSet = new Set(a), bSet = new Set(b);
    byCluster.get(key).cards.push({
      caseId: c.id,
      armA: { triggerSet: c.co.triggerSet ?? [], l2: c.co.l2Result ?? null, l3: c.co.l3Final ?? null, readSet: a },
      armB: { triggerSet: c.cn.triggerSet ?? [], l2: c.cn.l2Result ?? null, l3: c.cn.l3Final ?? null, readSet: b },
      readSetDiff: { addedByNew: b.filter((r) => !aSet.has(r)), removedByNew: a.filter((r) => !bSet.has(r)) },
    });
  }
  return [...byCluster.values()];
}

// R7.7.2 — structured diff vs the previous same-lineage report.json (flat schema). No prev → graceful.
export function reportDiff(curr, prev, { deferCurrent = false } = {}) {
  if (!prev) return { hasPrev: false, note: '无基准（无上一次同谱系 report.json）' };
  if (deferCurrent || !curr) return { hasPrev: false, note: '无基准（无上一次同谱系 report.json）' };
  const costOf = (rep) => rep.axes?.cost ?? {};
  const cc = costOf(curr), pc = costOf(prev);
  const axisDeltas = Object.keys(cc).map((k) => ({
    axis: cc[k].i18n ?? k, prevMean: pc[k]?.delta ?? null, currMean: cc[k].delta,
    change: pc[k]?.delta != null && cc[k].delta != null ? round3(cc[k].delta - pc[k].delta) : null,
  }));
  const regIds = (rep) => new Set((rep.cases ?? []).filter((c) => c.regressed).map((c) => c.caseId));
  const currReg = regIds(curr), prevReg = regIds(prev);
  return {
    hasPrev: true,
    verdictChange: { from: prev.verdict ?? null, to: curr.verdict, changed: (prev.verdict ?? null) !== curr.verdict },
    axisDeltas,
    regressedCases: {
      added: [...currReg].filter((id) => !prevReg.has(id)),
      removed: [...prevReg].filter((id) => !currReg.has(id)),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// R7.3 — report.md (numbered `## N.` headings, grep-able; verdict is chapter 1)
// ══════════════════════════════════════════════════════════════════════════════════════════════
export function buildReportMd(report) {
  const ex = report.header.exclusion, L = [];
  L.push(`# 升级回归报告 — ${report.arms.old.label ?? 'A'} ↔ ${report.arms.new.label ?? 'B'}`);
  L.push(`> generated ${report.createdAt} · immutable · intent=${report.intent}${report.header.mixedBundle ? ' · mixed-bundle' : ''}`);
  L.push('');

  L.push(`## 1. Verdict（升级推荐）`);
  L.push(`- **${recommendationText(report)}**`);       // boolean-recommendation tone (undecidable states never render false)
  L.push(`- 本次改动性质：${intentZh(report.intent)}（${report.intent}）`);
  const fc = failureCause(report);
  if (fc) L.push(`- ${fc}`);                             // first-screen one-line failure cause
  const nExcl = report.excludedCases?.length ?? 0;
  L.push(`- 配对 case: 共 ${report.pairs} 对（判定至少需 ${report.header.minPairs} 对，${report.pairs >= report.header.minPairs ? '达标' : '不足'}）· 其中 ${nExcl} 对被排除（排除率 ${report.exclusionPct}%，绊线 ${(ex.tripwire * 100)}%）→ 纳入分析 ${report.pairs - nExcl} 对——后文各节的题数口径若不同会各自注明`);
  L.push(`- 摘要: ${report.summary}`);
  if (report.nextSteps?.length) {
    L.push(`- 下一步指引:`);
    for (const s of report.nextSteps) {
      L.push(`  - ${s.message}`);
      for (const c of s.cases ?? []) L.push(`    - ${c.caseId}（${c.reason}）→ ${c.action}`);
    }
  }
  const ops = buildOpportunities(report);
  if (ops.length) {
    L.push(`- 优化机会一览（共 ${ops.length} 项——本报告各节独立发现的结构优化信号收拢在此，证据见对应章节。【双证据】= 两个互不相干的量法同时命中；无标者为单一量法的候选）:`);
    for (const o of ops) L.push(`  - ${o.multi ? '【双证据】' : ''}${o.title} —— ${o.evidence.join('；')} · 收益：${o.benefit ?? '见对应章节'}${o.risk ? ` · 代价风险：${o.risk}` : ''}（详见${o.section.md}）`);
  }
  L.push(`- 单个 skill 诊断（用于定位问题，不能据此拆开采用；要混搭需另跑混采确认 smoke --mix。n = 以该 skill 为预期路由的题数，与第 4 节按触发记录统计的 n 是不同口径）:`);
  for (const s of report.perSkill.skills) L.push(`  - ${s.skill}: ${zhEnum(s.badge)}${s.significantBadge ? `/${zhEnum(s.significantBadge)}` : ''} · n=${s.nCases}${s.ci ? ` · CI[${s.ci.lo}, ${s.ci.hi}]pp` : ''}${s.referenceOnly ? ' · 仅供参考（5-7 题，补到 8 题结论才可信）' : ''}`);
  L.push('');

  L.push(`## 2. Quality（质量三层：路由 / 结果 / 安全）`);
  const dpp = report.footer.config.nonInferiorityDeltaPp;
  const layerName = { l1: '路由', l2: '结果', l3: '安全' };
  for (const key of ['l1', 'l2', 'l3']) {
    const ly = report.axes.quality[key]; if (!ly) continue;
    const concl = ly.nonInferior ? '没问题' : `新版变差（最坏 ${ly.ci.lo.toFixed(1)}pp，超 ${dpp}pp 容差）`;
    const denom = ly.n != null ? `（分母 ${ly.n} 题${(report.pairs - (report.excludedCases?.length ?? 0)) !== ly.n ? '——与第 1 节纳入数不同者为不计入本层的题，如权限拒绝' : ''}）` : '';
    const ciTxt = ly.ci ? ` · 置信区间 [${ly.ci.lo}, ${ly.ci.hi}]pp——判定看的是区间最坏一端（${ly.ci.lo}pp）而非点估计` : '';
    L.push(`- ${key.toUpperCase()} ${layerName[key]}: 旧版=${fmtPct(ly.passOld)} → 新版=${fmtPct(ly.passNew)}${denom} · 点估计 deltaPp=${ly.deltaPp == null ? 'n/a' : (ly.deltaPp > 0 ? '+' : '') + ly.deltaPp}${ciTxt} · 结论: ${concl}${ly.heuristic ? ' · ⚠ 部分 skill 没明确标注“需要确认”，安全判定靠自动识别，个别可能有误' : ''}`);
  }
  const fi = report.axes.flowIncomplete;
  L.push(`- 确认后中断率（问完确认就停住没做事）: 旧版=${fi.numOld != null ? `${fi.numOld}/${fi.denomOld}=` : ''}${fmtPct(fi.rateOld)} → 新版=${fi.numNew != null ? `${fi.numNew}/${fi.denomNew}=` : ''}${fmtPct(fi.rateNew)}（区间[${fmtPct(fi.wilson[0])}, ${fmtPct(fi.wilson[1])}] 为新版的不确定范围）· 分母 = 全部尝试过的重复运行、含被排除题的运行——被排除不等于豁免此项统计${fi.newHigherSignificant ? ' · 新版显著更高 ✗' : ''}`);
  L.push(`- 权限拒绝（工具没拿到权限，不算路由错误）: ${report.l2Breakdown.permissionArtifact.count} 例——按运行次数计，同一题的多次重复各计一次，故例数可大于其涉及的题数；涉及的题不计入 L1 分母（见上方 L1 行）`);
  L.push('');

  L.push(`## 3. Cost（成本三轴 · 降=省，升=贵，持平=—）`);
  L.push(`- 本节题数口径 = 第 1 节「纳入分析」的配对题（排除者不进成本对比）。`);
  for (const key of ['turns', 'tokens', 'seconds']) {
    const a = report.axes.cost[key]; if (!a) continue;
    const zeroCi = !a.delta && a.ci?.lo === 0 && a.ci?.hi === 0;
    // 读数逐对完全相同 ≠ 持平证据（真实采集极罕见，多半是两版共用同一计量来源）——
    // 结论只能给「计量存疑」，否则与「本轴不作为持平证据」自相矛盾（fresh-eyes 全页轮）
    const dir = zeroCi ? '计量存疑，本轴无结论' : !a.delta ? '持平' : a.significantDown ? '显著省' : a.significantUp ? '显著贵' : '不显著';
    const valTxt = zeroCi ? '两版读数完全相同（疑共用同一计量来源）' : (!a.delta ? '持平' : a.disp);
    L.push(`- ${axisLabel(a.i18n)}: ${valTxt} · CI[${a.ciDisp[0]}, ${a.ciDisp[1]}] · n=${a.n} · ${dir}`);
  }
  L.push('');

  L.push(`## 4. Depgraph（依赖图建议）`);
  L.push(`- ${report.depgraph.disclaimer} · n=${report.depgraph.n}（本节口径 = 有触发/读档记录的运行数，与第 1 节配对题数不同）· full=${report.depgraph.full}`);
  // [adapter-observability §2] 治理级建议卡徽章：任一 session 为 adapter 自报口径 → 明示揭露
  const pm = report.depgraph.provenanceMix;
  if (pm && pm.adapter > 0) {
    L.push(`- ⚠ 本节拆/合治理建议基于 runtime 自报信号（adapter-reported）——证据 session 口径构成: harness ${pm.harness} · adapter ${pm.adapter} · unknown ${pm.unknown}`);
  }
  for (const s of report.depgraph.signals) {
    if (s.breakeven) {
      const b = s.breakeven;
      L.push(`- [merge] ${b.members.join(' + ')}: desc 从 ${b.sumDesc} → ${b.mergedDesc} 字符，省 ${b.sumDesc - b.mergedDesc} 字符 ≈ ${b.residentSaving} token/请求（按 4 字符≈1 token 折算）· 两者同题共触发率=${s.coTrigger ?? 'n/a'}（即第 1 节所引数字，判断合并动机用）· 至少其一被触发的题占比=${b.pTrigger}（估算收益用）· desc 省下的部分每次请求都省，而合并后的正文只在技能被触发时才载入（触发占比 ${b.pTrigger}），故正文可膨胀上限 ≈ ${b.residentSaving} ÷ ${b.pTrigger} = ${b.allowance} token，总开销仍不高于合并前`);
    } else if (s.kind === 'merge-file') {
      L.push(`- [merge-file] ${s.members.join(' + ')}: 共读率 ${s.coRead} · n=${s.n}`);
    } else if (s.kind === 'split') {
      L.push(`- [split] ${s.members.join(' + ')}: ${s.gated ? '需 full 集（smoke gated）' : `Jaccard ${s.jaccard} · n=${s.n}`}`);
    }
  }
  L.push('');

  L.push(`## 5. Evidence（证据下钻 + regressed 聚类）`);
  L.push(`- cases: ${report.cases.length}（regressed ${report.cases.filter((c) => c.regressed).length} · excluded ${report.cases.filter((c) => c.status === 'excluded').length}）`);
  for (const cl of report.clusters) L.push(`- 聚类 ${cl.skill} × ${cl.category}: n=${cl.n}${cl.cases?.length ? `（${cl.cases.join(', ')}）` : ''}`);
  for (const card of report.regressedCards) {
    for (const c of card.cards) {
      // 先交代路由事实（这才是败因对应的证据），读取差异只是伴随现象（fresh-eyes 全页轮）
      L.push(`  - ${c.caseId}: 路由到的 skill——旧版 [${(c.armA.triggerSet ?? []).join(', ')}] → 新版 [${(c.armB.triggerSet ?? []).join(', ')}] · 结果/安全: 旧版 ${zhEnum(c.armA.l2)}/${zhEnum(c.armA.l3)} → 新版 ${zhEnum(c.armB.l2)}/${zhEnum(c.armB.l3)}`);
      const parts = [];
      if (c.readSetDiff.removedByNew.length) parts.push(`新版少读了 ${c.readSetDiff.removedByNew.join(', ')}（旧版有读）`);
      if (c.readSetDiff.addedByNew.length) parts.push(`新版多读了 ${c.readSetDiff.addedByNew.join(', ')}`);
      L.push(`    - 伴随读取差异: ${parts.length ? parts.join(' · ') : '读取集一致'}`);
    }
  }
  L.push('');

  L.push(`## 6. Footprint（环境足迹 + 统计揭露 + NOTICE）`);
  const f = report.footer, bud = report.budget;
  L.push(`- 环境版本: 旧版 ${report.arms.old.version} ↔ 新版 ${report.arms.new.version} · model ${report.arms.new.model} · harness ${report.arms.new.harness} · isolation ${report.arms.new.isolation ? '✓' : '✗'}`);
  L.push(`- 统计揭露: δ=${f.config.nonInferiorityDeltaPp}pp · 判定门槛：整包 ${f.config.MIN_PAIRS} 对；单 skill 结论可信需 8 题，${f.config.MIN_PAIRS_SKILL}-7 题仅供参考、少于 ${f.config.MIN_PAIRS_SKILL} 题不出结论（MIN_PAIRS/MIN_PAIRS_SKILL 为显示下限，非可信线）· 多重比较=${f.tests.perSkillCorrection} · 检定总数=${f.tests.count}${f.tests.breakdown ? `（= 成本轴显著性 ${f.tests.breakdown.axes} 项 + 单 skill 显著性 ${f.tests.breakdown.perSkill} 项；计量存疑的轴照常计入检定数但不据以下结论，见第 3 节；质量三层走非劣性判定、确认后中断率仅作描述，均不计入）` : ''} · bootstrap seed=${f.config.bootstrapSeed} · 排除率绊线=${f.config.tripwirePct}%`);
  L.push(`- 预算实耗: est ${bud.est.session} session / ${bud.est.hours}h / $${bud.est.usd} · actual ${bud.actual.session} / ${bud.actual.hours}h / $${bud.actual.usd}（session = 题数 × 两版 × 每题重复次数，故大于第 1 节配对题数）`);
  L.push(`- ECharts ${report.header.echarts.version} (${report.header.echarts.license}) sha256 ${report.header.echarts.sha256}`);
  if (report.diff?.hasPrev) {
    L.push('');
    L.push(`## 7. Diff（vs 上次同谱系）`);
    L.push(`- verdict: ${report.diff.verdictChange.from} → ${report.diff.verdictChange.to}${report.diff.verdictChange.changed ? ' (变化)' : ''}`);
    for (const a of report.diff.axisDeltas) L.push(`- ${a.axis}: ${a.prevMean} → ${a.currMean}（Δ ${a.change}）`);
    L.push(`- regressed 新增 [${report.diff.regressedCases.added.join(', ') || '—'}] · 消失 [${report.diff.regressedCases.removed.join(', ') || '—'}]`);
  } else {
    L.push('');
    L.push(`## 7. Diff（vs 上次同谱系）`);
    L.push(`- ${report.diff?.note ?? '无基准'}`);
  }
  if (report.probes) buildCliMd(report.probes, L);
  if (report.coverage) buildCoverageMd(report.coverage, L, report.probes ? 9 : 8);   // 编号连续：probes 占 8 时顺延
  // [wave 2 §4] runtime 自述对比 — 动态编号顺延：紧跟 coverage 之后（probes/coverage 各占一号）
  if (report.runtimeInfo) buildRuntimeInfoMd(report.runtimeInfo, L, 8 + (report.probes ? 1 : 0) + (report.coverage ? 1 : 0));
  return L.join('\n') + '\n';
}

// ── report.md §B4 覆盖统计对比节 — 双层用词：zh-hans 白话主句 + 括号 canonical term ─────────────────
function buildCoverageMd(cov, L, num) {
  const armZh = { old: '旧版', new: '新版' };
  L.push('');
  L.push(`## ${num}. 覆盖统计对比（两版触发覆盖 delta）`);
  if (cov.status === 'unavailable') {
    L.push(`- ${cov.reason}（缺统计的一侧：${(cov.unavailableArms ?? []).map((a) => armZh[a] ?? a).join('、')}）`);
    return;
  }
  L.push(`- ${cov.method}`);
  const authTxt = (a) => {
    if (!a || !a.statsAuthority) return '未知';
    const zh = a.statsAuthority === 'embedded' || a.statsAuthority === 'authoritative-embedded'
      ? '封存时计算（权威）' : '回填/重算（非权威）';
    return `${zh}（${a.statsAuthority}）${(a.warnings ?? []).length ? ` ⚠ ${a.warnings.join('；')}` : ''}`;
  };
  L.push(`- 统计来源: 旧版 ${authTxt(cov.authority?.old)} · 新版 ${authTxt(cov.authority?.new)}`);
  // [adapter-observability §2] footer 揭露 provenance：adapter-reported 侧明示自报口径；
  // harness-observed / 缺栏（legacy）不加注（从简，口径不变不打扰）
  const provArms = ['old', 'new'].filter((a) => cov.provenance?.[a] === 'adapter-reported');
  if (provArms.length) {
    L.push(`- 信号口径: ${provArms.map((a) => armZh[a]).join('、')}的触发/读取信号由 runtime 自报（adapter-reported）`);
  }
  if (cov.comparability && cov.comparability.comparable === false) {
    L.push(`- ⚠ 两侧口径不同不可比（observed-tool vs adapter-reported）——触发比例变化（triggerRate delta）一律不出数，仅并列两侧 x/y`);
  }
  const xy = (r) => (r ? `${r.triggered}/${r.attempted}` : '—');
  for (const s of cov.skills ?? []) {
    const deltaTxt = s.deltaReason === 'provenance-mismatch' ? '口径不同不可比（observed-tool vs adapter-reported）'
      : s.deltaPp == null ? '—（样本不足或无统计）' : `${s.deltaPp > 0 ? '+' : ''}${s.deltaPp}pp`;
    const scopeTxt = s.scope === 'intersection' ? `交集 ${s.intersectionCases} 题` : '全量口径（一侧无逐题记录 caseJoin，不给 delta）';
    L.push(`- ${s.skill}: 旧版 ${xy(s.old)} → 新版 ${xy(s.new)}（${scopeTxt}）· 触发比例变化（triggerRate delta）: ${deltaTxt}`);
  }
  for (const o of cov.onlyIn ?? []) L.push(`- ${o.skill}: 仅存在于${armZh[o.arm]}的统计里（不进对比）`);
  const nt = cov.neverTriggered;
  if (nt) {
    if ((nt.droppedOut ?? []).length) {
      for (const d of nt.droppedOut) {
        L.push(`- ⚠ 掉出：${d.skill} 旧版触发过、新版一次都没触发（neverTriggered 对比，仅判两侧皆安装的共同 skill）——新版落空的题:`);
        if (!d.missCases.length) L.push(`  - （无逐题记录）`);
        for (const m of d.missCases) {
          const fi = m.firedInstead == null ? '无 session 可判'
            : m.firedInstead.length ? `实际触发了 ${m.firedInstead.join(', ')}（firedInstead）` : '没有其他 skill 触发';
          L.push(`  - ${m.caseId}: ${fi}`);
        }
      }
    } else {
      L.push(`- 无掉出（两侧皆安装的共同 skill 中，没有旧版触发过而新版落空的）`);
    }
    for (const io of nt.installedOnlyIn ?? []) L.push(`- ${io.skill}: 仅安装于${armZh[io.arm]}（不判掉出）`);
  }
}

// ── report.md [wave 2 §4] runtime 自述对比节 — 双层用词：zh-hans 白话主句 + 括号 canonical term。
// 框架句/占位文案取自 section 本体（单一事实源，HTML 同源经 DATA）；绝不因果句。────────────────────
function buildRuntimeInfoMd(ri, L, num) {
  const armZh = { old: '旧版', new: '新版' };
  L.push('');
  L.push(`## ${num}. 运行时自述对比（runtime_info diff）`);
  L.push(`- ${ri.framing}`);
  const summary = (p) => {
    const sp = p.systemPrompt;
    const spTxt = sp ? `system prompt 指纹 sha256 ${sp.shaShort ?? '—'}（前 12 码）` : '未上报 system prompt 指纹';
    const toolsTxt = p.tools ? `工具 ${p.tools.length} 个` : '工具清单未自述';
    return `name ${p.name ?? '—'} · version ${p.version ?? '—'} · ${spTxt} · ${toolsTxt}`;
  };
  if (ri.status !== 'ok') {
    for (const a of ['old', 'new']) {
      if (ri.missingArms.includes(a)) L.push(`- ${armZh[a]}: ${ri.missingNote}`);
      else L.push(`- ${armZh[a]}: ${summary(ri[a])}`);
    }
    return;
  }
  const d = ri.diff;
  const chg = (x) => (x.changed ? `${x.old ?? '—'} → ${x.new ?? '—'}（有变化）` : `${x.old ?? '—'}（未变）`);
  L.push(`- runtime 名称（name）: ${chg(d.name)}`);
  L.push(`- runtime 版本（version Δ）: ${chg(d.version)}`);
  const sp = d.systemPrompt;
  if (sp.state === 'both-absent') {
    L.push(`- system prompt 指纹: 两侧均未上报（无法对比）`);
  } else if (sp.state === 'one-absent') {
    L.push(`- system prompt 指纹: ${armZh[sp.absentArm]}未上报——变否与差值均不可知（不出数）`);
  } else {
    const shaTxt = sp.shaChanged == null ? '无法判断（一侧 sha256 缺失）'
      : sp.shaChanged ? `已变化（${sp.shaShort.old ?? '—'} → ${sp.shaShort.new ?? '—'}，前 12 码）`
      : `未变（${sp.shaShort.old ?? '—'}，前 12 码）`;
    const dv = (v) => (v == null ? '—（一侧未上报，不出数）' : `${v > 0 ? '+' : ''}${v}`);
    L.push(`- system prompt 指纹（sha256）: ${shaTxt} · 字节差（bytes Δ）: ${dv(sp.bytesDelta)} · token 估算差（tokensEst Δ）: ${dv(sp.tokensEstDelta)}（估算 estimate，恒标）`);
  }
  if (d.tools.unknown) {
    L.push(`- 工具清单（tools）: 至少一侧未自述工具清单——增删不可知（不出假清单）`);
  } else {
    const parts = [];
    if (d.tools.added.length) parts.push(`新增 [${d.tools.added.join(', ')}]`);
    if (d.tools.removed.length) parts.push(`移除 [${d.tools.removed.join(', ')}]`);
    L.push(`- 工具清单（tools）: ${parts.length ? parts.join(' · ') : '一致（无增删）'}（旧 ${d.tools.countOld} 个 → 新 ${d.tools.countNew} 个）`);
  }
  const fmtV = (v) => (v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
  if (d.defaults.unknown) {
    L.push(`- 默认参数（defaults）: 至少一侧未自述——变更不可知`);
  } else if (!d.defaults.changes.length) {
    L.push(`- 默认参数（defaults）: 未变`);
  } else {
    L.push(`- 默认参数（defaults）变更:`);
    for (const c of d.defaults.changes) L.push(`  - ${c.key}: ${fmtV(c.old)} → ${fmtV(c.new)}`);
  }
}

// ── report.md section 8: external-tool probe signals (only emitted when a probe was configured) ──
// Plain zh-hans; every jargon word demoted to a trailing paren. Multi-probe → per-tool subsections;
// per-arm absolutes first, then the two-arm delta (or a not-comparable note). Sequence cards are
// ALWAYS labelled 未验证假说 and carry NO adopt action; a probe-declared collapse is only 注记.
function buildCliMd(cli, L) {
  const armLabel = (a) => a ?? '（未命名版本）';
  L.push('');
  L.push(`## 8. 外部工具探针（probe 信号：命令面覆盖 + cli 下沉）`);
  L.push(`- 本节统计各版本实际调用了哪些外部工具命令，帮助发现两类机会：工具支持但从来没人用的功能，和「连续几条命令总是一起出现、或许能合并成一条」的模式（后者内部称 cli 下沉）。本节说的「题目」指基准测试题，一题对应一次运行。`);
  L.push(`- 下方所有信号只是从数据里看出的迹象，仅供人工判断，本工具不会自动采纳或应用任何建议。`);
  // 图例节首先行（fresh-eyes r3：图例夹在数据行中间会让读者分不清哪些是数据哪些是说明）
  const hasProxAny = (cli.arms ?? []).some((a) => (a.proximity?.topEdges ?? []).length);
  if (hasProxAny) {
    L.push(`- 关联配对的前缀说明：skill: = 触发某个技能 · ref: = 读取技能附带的参考文档 · 其余前缀是外部工具探针的工具名（如 onchainos:、onchainos-mcp:）= 调用该工具的命令。三者一起统计，因为「合并/下沉」的机会常跨越命令与文档。`);
    L.push(`- 关联配对三个数的读法（一「步」= 运行过程中的一条动作记录——调用一条外部命令、触发一个技能或读取一份参考文档，按发生先后排成序列；本报告统一取「其后 ${UPGRADE_CONFIG.proximity.windowOrdinals} 步之内」为观察窗口；这些只是时间先后的邻近，不代表因果）：`);
    L.push(`  - 紧邻程度：对前者的每一次出现打分——后者在其后 ${UPGRADE_CONFIG.proximity.windowOrdinals} 步内出现，得 1 ÷（1 + 距离）；没出现，该次得 0 分。距离 = 后者出现在其后第几步，紧挨着即第 1 步，得 1÷2 = 0.5，为本指标最高分。紧邻程度 = 全部出现次的平均分，取值范围 0 至 0.5（0 = 从未在窗口内跟随，0.5 = 每次都紧挨着）。仅用于同一报告内排序比较。`);
    L.push(`  - 后随比例：出现前者的题目里，后者在其后 ${UPGRADE_CONFIG.proximity.windowOrdinals} 步内也出现过的题目占比。1 = 每题都跟随。`);
    L.push(`  - 关联倍数：后随比例 ÷ 基准比例；基准比例 = 同一版本的全部题目中出现后者的题目占比。后者几乎每题都出现时，即使后随比例是 1，倍数也只有 1（这个先后关系不提供额外信息）；明显大于 1 才值得注意；配对出现少于 ${UPGRADE_CONFIG.proximity.minPairCases} 题时不计算。`);
  }
  if (cli.tripwired) {
    L.push(`- ⚠ 本节被剔除的题占比过高，两版对比无法判定（排除率 ${round3(cli.paired?.exclusionPct ?? 0)}% 超绊线）；各版本绝对值仍照常展示。`);
  }
  for (const w of cli.warnings ?? []) {
    L.push(`- ⚠ 被剔除的运行里检测到外部命令调用：${armLabel(w.arm)} 的 ${w.caseId} 跑了 ${w.tool} ${(w.cmds ?? []).join(' / ') || '（命令不详）'}（这些运行已排除，但命中提醒你留意“狂打命令然后中断”）`);
  }
  // gather the union of tools across arms → per-tool subsection
  const tools = [...new Set((cli.arms ?? []).flatMap((a) => (a.tools ?? []).map((t) => t.tool)))].sort();
  const deltaByTool = new Map((cli.deltas ?? []).map((d) => [d.tool, d]));
  const ncByTool = new Map((cli.notComparable ?? []).map((nc) => [nc.tool, nc]));
  if (!tools.length) { L.push(`- 未解析到任何外部命令调用。`); return; }
  for (const tool of tools) {
    L.push('');
    L.push(`### 8.${tools.indexOf(tool) + 1} ${tool}`);
    for (const arm of cli.arms ?? []) {
      const t = (arm.tools ?? []).find((x) => x.tool === tool);
      if (!t) continue;
      const cov = t.coverage;
      if (!cov) { L.push(`- ${armLabel(arm.arm)}: 无命令覆盖数据`); continue; }
      if (cov.status === 'unavailable') {
        L.push(`- ${armLabel(arm.arm)}: 没有可对照的命令清单（探针配置里没填），实测用到 ${cov.invoked.length} 条命令（无法算覆盖率）`);
      } else {
        const pctv = cov.ratio == null ? 'n/a' : (cov.ratio * 100).toFixed(1) + '%';   // 一位小数——取整会让 67−33 对不上 -33
        // 分子 = 清单内被用到的命令数（清单外命令另列一行）——否则 3/3=67% 会自相矛盾
        const coveredN = (cov.invoked ?? []).filter((c) => !(cov.undeclaredInvoked ?? []).includes(c)).length;
        L.push(`- ${armLabel(arm.arm)}: 配置里自报支持 ${cov.declared} 条命令（该清单未经核实，内部名 commandSurface），实测用到其中 ${coveredN} 条，清单覆盖率 ${coveredN}/${cov.declared} = ${pctv}${cov.status === 'suspect' ? ' · ⚠ 探针配置可能有误（命令里出现了工具名却一条都没解析到）' : ''}`);
        if ((cov.unused ?? []).length) L.push(`  - 从来没人用到的命令: ${cov.unused.join(', ')}`);
        if ((cov.undeclaredInvoked ?? []).length) L.push(`  - 用了自报清单之外的命令（清单可能过时，内部名 surface-drift）: ${cov.undeclaredInvoked.join(', ')}`);
      }
    }
    const d = deltaByTool.get(tool), nc = ncByTool.get(tool);
    if (nc) L.push(`- 两版对比: 两个版本自报的命令清单不一样，覆盖率没有可比性，此处不给差值（${nc.reason}）`);
    else if (d && d.comparable) {
      // 把每臂「清单内 + 清单外」的条数摊开写——只给 -2 会和 2/3→1/3 对不上（fresh-eyes F-1-03）
      const armCounts = (cli.arms ?? []).map((arm) => {
        const t = (arm.tools ?? []).find((x) => x.tool === tool);
        const inv = t?.coverage?.invoked?.length ?? 0, und = t?.coverage?.undeclaredInvoked?.length ?? 0;
        return `${armLabel(arm.arm)} ${inv} 条${und ? `（清单内 ${inv - und} + 清单外 ${und}）` : ''}`;
      }).join(' → ');
      L.push(`- 两版对比（${armLabel(d.to)} 相对 ${armLabel(d.from)}）: 覆盖率变化 ${d.ratioDelta == null ? 'n/a' : (d.ratioDelta > 0 ? '+' : '') + (d.ratioDelta * 100).toFixed(1) + ' 个百分点'} · 用到命令数 ${armCounts}（变化 ${d.invokedDelta == null ? 'n/a' : (d.invokedDelta > 0 ? '+' : '') + d.invokedDelta}）`);
    }
    // sequences (hypothesis) + proximity top-k, per arm
    for (const arm of cli.arms ?? []) {
      const t = (arm.tools ?? []).find((x) => x.tool === tool);
      for (const s of t?.sequences ?? []) {
        L.push(`- [未验证假说] ${armLabel(arm.arm)}: 命令连发 ${s.seq.join(' → ')}（在 ${s.distinctCases} 个不同题目里出现）${s.knownCollapse ? ` · 未验证的改进猜想：或可用单条命令「${s.knownCollapse}」代替` : ''}`);
      }
    }
  }
  // 关联配对是「全局」统计（skill/ref/各工具命令同轴），与哪个工具无关——放 per-tool 小节里
  // 会整份重复贴 N 遍（fresh-eyes 全页审查 MAJOR），故独立成最后一个小节、只列一次。
  const hasProx = (cli.arms ?? []).some((a) => (a.proximity?.topEdges ?? []).length || (a.proximity?.axesOmitted ?? []).length);
  if (hasProx) {
    L.push('');
    L.push(`### 8.${tools.length + 1} 关联配对（全局——命令 / 技能 / 文档同轴统计，不分工具）`);
    L.push(`- 先按版本分组，各组内按紧邻程度从高到低排列；「无额外信息」只针对关联倍数一项，配对本身仍可凭紧邻程度与后随比例作合并候选的参考。上方各工具的「命令连发」若与此处出现同一对命令，是同一现象的两种度量：那边数连发次数，这边衡量邻近程度：`);
    // [adapter-observability §2 M7] 自报事件不进任何 ordinal 轴 → 被略去的轴显式给 n/a + 理由
    const axReasonZh = (r) => (r === 'declared-events-have-no-ordinal'
      ? '自报事件无真实调用序（declared-events-have-no-ordinal）' : String(r ?? '原因未知'));
    for (const arm of cli.arms ?? []) {
      for (const ax of arm.proximity?.axesOmitted ?? []) {
        L.push(`- ${armLabel(arm.arm)}: ${ax.axis} 事件轴不可用（n/a）——${axReasonZh(ax.reason)}`);
      }
    }
    for (const arm of cli.arms ?? []) {
      const top = (arm.proximity?.topEdges ?? []).slice(0, 5);
      for (const e of top) {
        const liftTxt = e.lift == null ? `未计算（仅出现 ${e.pairCases} 题，低于最少 ${UPGRADE_CONFIG.proximity.minPairCases} 题）` : (e.lift === 1 ? '1（无额外信息）' : e.lift);
        L.push(`- ${armLabel(arm.arm)}: ${e.from.type}:${e.from.id} → ${e.to.type}:${e.to.id} · 紧邻程度 ${e.closeness} · 后随比例 ${e.confidence == null ? 'n/a' : e.confidence} · 关联倍数 ${liftTxt} · 出现于 ${e.pairCases} 题`);
      }
    }
  }
}
const fmtPct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const fmtSignedPp = (x) => (x == null ? 'n/a' : (x > 0 ? '+' : '') + (x * 100).toFixed(1) + 'pp');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// R7.4 — single-file report.html (inline ECharts + inline JSON, offline-portable)
// ══════════════════════════════════════════════════════════════════════════════════════════════
export function buildReportHtml(report, { vendorPath = DEFAULT_VENDOR_PATH } = {}) {
  const check = verifyVendorSha256(vendorPath);
  if (!check.ok) {
    throw new Error(`vendored ECharts sha256 mismatch — refusing to build HTML (R7.5.1): expected ${check.expected}, got ${check.sha256 ?? '(missing)'}${check.reason ? ' — ' + check.reason : ''}`);
  }
  const echartsSrc = readFileSync(vendorPath, 'utf8');
  const dataJson = JSON.stringify(report)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'); // safe inline JSON
  const glossaryJson = JSON.stringify(GLOSSARY).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return HTML_TEMPLATE
    .replace('/*__REPORT_DATA__*/', () => dataJson)   // function replacer: no $-pattern interpretation
    .replace('/*__GLOSSARY__*/', () => glossaryJson)  // plain-language tooltip dictionary (single source)
    .replace('/*__ECHARTS__*/', () => echartsSrc);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// R7.6 — write the three artifacts to <dataDir>/upgrades/<compare-id>/, WRITE-ONCE immutable.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export function makeCompareId(armOld, armNew, when = new Date()) {
  const stamp = when.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const clean = (s) => String(s ?? 'arm').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${clean(armOld?.label)}-vs-${clean(armNew?.label)}-${stamp}`;
}

export function writeReport({ dataDir, report, compareId = null, vendorPath = DEFAULT_VENDOR_PATH } = {}) {
  const id = compareId ?? report.compareId ?? makeCompareId({ label: report.arms?.old?.label }, { label: report.arms?.new?.label });
  const dir = join(dataDir, 'upgrades', id);
  if (existsSync(dir)) throw new Error(`upgrade report ${id} already exists — artifacts are immutable (R7.6.2); a rerun mints a NEW compare-id`);
  report.compareId = id;
  const html = buildReportHtml(report, { vendorPath });   // sha-check BEFORE any write (fail closed)
  const md = buildReportMd(report);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, 'report.json');
  const mdPath = join(dir, 'report.md');
  const htmlPath = join(dir, 'report.html');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, md);
  writeFileSync(htmlPath, html);
  return { id, dir, jsonPath, mdPath, htmlPath };
}

// ── the HTML template (self-contained; consumes report.json shape verbatim) ──────────────────
const HTML_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>onchainos 升级回归报告</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--card:#1c2230;--border:#30363d;--fg:#e6edf3;--dim:#8b949e;
--vp:#3fb950;--vf:#f85149;--vi:#d29922;--vn:#8b949e;--good:#3fb950;--bad:#f85149;--neutral:#8b949e;
--armA:#8b949e;--armB:#58a6ff;--accent:#58a6ff;--edge:#484f58;--merge:#f85149;--zero:#6e7681;}
:root[data-theme=light]{--bg:#ffffff;--panel:#f6f8fa;--card:#ffffff;--border:#d0d7de;--fg:#1f2328;--dim:#656d76;
--vp:#1a7f37;--vf:#cf222e;--vi:#9a6700;--vn:#656d76;--good:#1a7f37;--bad:#cf222e;--neutral:#656d76;--armA:#656d76;--armB:#0969da;--accent:#0969da;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,"Noto Sans CJK TC",sans-serif}
.num,code,.ci{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header.chrome{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:16px;margin:0;font-weight:600}.chrome-right{margin-left:auto;display:flex;gap:8px;align-items:center}
.btn{background:var(--card);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.btn:hover{border-color:var(--accent)}.muted,.dim{color:var(--dim)}.arm-a{color:var(--armA)}.arm-b{color:var(--armB)}
.mixed-flag{display:none;background:var(--vi);color:#0d1117;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600}
body.mixed .mixed-flag{display:inline-block}
.layout{display:flex;max-width:1180px;margin:0 auto;gap:24px;padding:0 20px}
nav.anchors{position:sticky;top:52px;align-self:flex-start;width:170px;padding:18px 0;display:flex;flex-direction:column;gap:2px;height:calc(100vh - 52px)}
nav.anchors a{color:var(--dim);text-decoration:none;font-size:13px;padding:4px 10px;border-left:2px solid transparent}
nav.anchors a.sub{padding-left:22px;font-size:12px}nav.anchors a.active{color:var(--fg);border-left-color:var(--accent)}
main.report{flex:1;min-width:0;padding:18px 0 120px}
section.block{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:18px 20px;margin-bottom:18px}
.sec-head{display:flex;align-items:center;gap:10px}.sec-head h2{font-size:16px;margin:0}.sub{color:var(--dim);font-size:12px;margin:4px 0 14px}
.cj{margin-left:auto}
.verdict{display:inline-flex;align-items:center;gap:8px;font-size:18px;font-weight:700;padding:6px 14px;border-radius:8px;border:1px solid}
.verdict .sym{font-size:18px}
.verdict.pass,.badge.pass{color:var(--vp);border-color:var(--vp)}.verdict.fail,.badge.fail{color:var(--vf);border-color:var(--vf)}
.verdict.inconclusive,.badge.inconclusive{color:var(--vi);border-color:var(--vi)}.verdict.insufficient,.badge.insufficient{color:var(--vn);border-color:var(--vn)}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:2px 8px;border-radius:5px;border:1px solid var(--border)}
.badge.intent{color:var(--accent);border-color:var(--accent)}.badge.skill{color:var(--armB);border-color:var(--border);font-family:ui-monospace,monospace}
.summary-line{margin:12px 0;font-size:14px}.axis-mini{display:flex;gap:12px;margin-top:12px;flex-wrap:wrap}
.am{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 14px;cursor:pointer;min-width:120px}
.am .k{font-size:11px;color:var(--dim)}.am .v{font-size:16px;font-weight:700}.am .s{font-size:11px}
.delta.good,.good{color:var(--good)}.delta.bad,.bad{color:var(--bad)}.delta.neutral,.neutral{color:var(--neutral)}
.tripwire{display:none;align-items:center;gap:10px;background:#341a00;border:1px solid var(--vi);color:var(--vi);border-radius:8px;padding:8px 14px;margin-bottom:12px}
.tripwire.near,.tripwire.over{display:flex}.tripwire.over{background:#3d1518;border-color:var(--vf);color:var(--vf)}
.lnk{color:var(--accent);cursor:pointer;text-decoration:underline}
.nextsteps{background:var(--card);border:1px dashed var(--vi);border-radius:8px;padding:10px 14px;margin:12px 0}
.nextsteps .h{font-weight:600;color:var(--vi);font-size:13px;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin:6px 0;font-size:13px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}th{color:var(--dim);font-weight:500;font-size:12px}
td.num,th.num{text-align:right}tr.click{cursor:pointer}tr.click:hover{background:var(--card)}
tr.dimmed{opacity:.35}tr.selected{background:var(--card)}
.diag-table td{border-left:0}.diag-row{border-left:3px solid var(--_edge,transparent)}
.diag-label{font-size:12px;color:var(--dim);margin:14px 0 4px;text-transform:none}
.ci{font-size:12px;color:var(--dim)}.ci.advisory{border-bottom:1px dashed var(--dim)}
.gloss{border-bottom:1px dashed var(--dim);cursor:help}
.badge.neutral{color:var(--dim)}
.skill-detail>td{background:var(--card);padding:8px 12px}
table.subcases{width:100%;font-size:12px;margin:2px 0}table.subcases th{font-size:11px}table.subcases td{padding:4px 8px;vertical-align:top}
.regressed-row{background:rgba(248,81,73,.08)}
.dc{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dc.ok{color:var(--dim)}.dc.bad{color:var(--vf);opacity:.55}.dc.reg{color:var(--vf);font-weight:700}.dc.imp{color:var(--vp)}.dc.na{color:var(--dim)}
.cards{display:flex;gap:14px;flex-wrap:wrap}.card{flex:1;min-width:180px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.card .k{font-size:12px;color:var(--dim)}.card .v{font-size:20px;font-weight:700;margin:2px 0}.ci-chart{height:60px;margin-top:6px}
.tabs{display:flex;gap:4px;margin-bottom:10px}.tab{padding:6px 12px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;color:var(--dim)}
.tab.on{color:var(--fg);border-color:var(--accent)}.tabpane{display:none}.tabpane.on{display:block}
.chart{height:340px;width:100%}.empty{color:var(--dim);text-align:center;padding:40px;font-size:12px}
.signal{border:1px solid var(--border);border-radius:8px;margin:8px 0;overflow:hidden}
.signal .head{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;background:var(--card)}
.signal .caret{transition:transform .15s}.signal.open .caret{transform:rotate(90deg)}
.signal .body{display:none;padding:10px 14px;border-top:1px solid var(--border)}.signal.open .body{display:block}
.kind{font-size:11px;padding:1px 7px;border-radius:4px;border:1px solid var(--border)}.kind.merge,.kind.file{color:var(--vf);border-color:var(--vf)}.kind.split{color:var(--accent);border-color:var(--accent)}
table.breakeven td{border-bottom:1px solid var(--border)}.gated-note{color:var(--dim);font-size:12px}
.chips{display:flex;gap:6px;margin-bottom:8px}.chip{padding:4px 10px;border:1px solid var(--border);border-radius:14px;cursor:pointer;font-size:12px;color:var(--dim)}.chip.on{color:var(--fg);border-color:var(--accent)}
.kv-row{display:flex;gap:10px;padding:3px 0;font-size:13px}.kv-row .kk{color:var(--dim);min-width:220px}
.notice{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:11px;color:var(--dim);margin-top:12px;line-height:1.7}
#stickybar{display:none;position:sticky;top:52px;z-index:15;background:var(--panel);border-bottom:1px solid var(--border);border-left:4px solid var(--accent);padding:6px 20px;font-size:13px;cursor:pointer;align-items:center;gap:12px}
#stickybar.show{display:flex}.verdict.compact{font-size:13px;padding:2px 8px;border:none}
@media(max-width:820px){.layout{flex-direction:column}nav.anchors{flex-direction:row;flex-wrap:wrap;height:auto;position:static;width:auto}nav.anchors a{border-left:none}}
</style>
</head>
<body>
<script id="report-data" type="application/json">/*__REPORT_DATA__*/</script>
<header class="chrome">
  <h1>onchainos <span class="muted" id="chsub"></span></h1>
  <span class="arm-pair"><span class="arm-a" id="chA"></span> ↔ <span class="arm-b" id="chB"></span></span>
  <span class="mixed-flag" id="mixedFlag">混采确认跑</span>
  <div class="chrome-right">
    <span class="muted" id="genstamp"></span>
    <button class="btn" id="copyReport">复制 report JSON</button>
    <button class="btn" onclick="toggleTheme()">◐</button>
  </div>
</header>
<div id="stickybar" onclick="location.hash='#s1'"><span id="sb-verdict"></span><span class="muted" id="sb-meta"></span></div>
<div class="layout">
  <nav class="anchors" id="anchors">
    <a href="#s1" data-sec="s1">S1 判定</a>
    <a href="#s1_1" data-sec="s1_1" class="sub">S1.1 单 skill</a>
    <a href="#s2" data-sec="s2">S2 质量三层</a>
    <a href="#s3" data-sec="s3">S3 成本三轴</a>
    <a href="#s4" data-sec="s4">S4 依赖图</a>
    <a href="#s5" data-sec="s5">S5 证据</a>
    <a href="#s6" data-sec="s6">S6 环境足迹</a>
    <a href="#s7" data-sec="s7" id="nav-s7" style="display:none">S7 外部探针</a>
    <a href="#s8" data-sec="s8" id="nav-s8">S8 覆盖统计</a>
    <a href="#s9" data-sec="s9" id="nav-s9">S9 运行时自述</a>
  </nav>
  <main class="report" id="reportMain">
    <section class="block" id="s1" data-section="s1_verdict"></section>
    <section class="block" id="s1_1" data-section="s1_verdict"></section>
    <section class="block" id="s2" data-section="s2_quality"></section>
    <section class="block" id="s3" data-section="s3_cost"></section>
    <section class="block" id="s4" data-section="s4_depgraph"></section>
    <section class="block" id="s5" data-section="s5_evidence"></section>
    <section class="block" id="s6" data-section="s6_footprint"></section>
    <section class="block" id="s7" data-section="s7_probes" style="display:none"></section>
    <section class="block" id="s8" data-section="s8_coverage"></section>
    <section class="block" id="s9" data-section="s9_runtime"></section>
  </main>
</div>
<script id="__ECHARTS__">/*__ECHARTS__*/</script>
<script>
const DATA=JSON.parse(document.getElementById('report-data').textContent);
const GLOSSARY=/*__GLOSSARY__*/;
const ENUM_ZH={'ok':'正常','wrong-route':'路由错','wrong-result':'结果错','executed-after-confirm':'确认后执行','executed-without-ask':'未确认就执行','asked-and-halted':'问完即停','refused':'已拒绝'};
function zhEnumJs(v){return v==null?'—':(ENUM_ZH[v]||String(v));}
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// wrap a term in a dashed-underline native-title tooltip (zero-dep hover help)
function gw(text,key){var g=GLOSSARY[key];return g?'<span class="gloss" title="'+esc(g)+'">'+text+'</span>':text;}
const pct=x=>x==null?'n/a':(x*100).toFixed(1)+'%';
const signedPp=x=>x==null?'n/a':(x>0?'+':'')+(x*100).toFixed(1)+'pp';   // arg is a fraction
const sPp=x=>x==null?'n/a':(x>0?'+':'')+x.toFixed(1)+'pp';               // arg already in pp
const vSym={pass:'✓',fail:'✗',inconclusive:'～',insufficient:'∅'};
const vWord={pass:'成立',fail:'不成立',inconclusive:'inconclusive',insufficient:'insufficient-data'};
let scope=null,curFilter='all';const charts={};let echartsReady=typeof echarts!=='undefined';
const COST=['turns','tokens','seconds'].map(k=>DATA.axes.cost[k]).filter(Boolean);
// shared cost display (S1 mini + S3 card): zero change → "— 持平" (no arrow), else ▼/▲ + value
function costHead(a){var zero=!a.delta,sig=a.significantDown||a.significantUp;
  return {zero:zero,sig:sig,cls:zero?'neutral':(sig?(a.direction==='good'?'good':'bad'):'neutral'),text:zero?'— 持平':((a.delta<0?'▼':'▲')+' '+esc(a.disp))};}
function intentZhJs(i){return {'cost-opt':'省成本','quality-fix':'修质量','neutral-refactor':'中性重构'}[i]||i;}
function pp1(x){return x==null?'n/a':x.toFixed(1);}
// perSkill display verdict from the U4 badge/significance (badge ∈ ok/reference-only/insufficient-data)
function skVerdict(s){return s.badge==='insufficient-data'?'insufficient':s.significant?(s.mean>=0?'pass':'fail'):'inconclusive';}
// presentation-layer recommendation tone (must mirror report.js recommendationText/failureCause/axisLabel)
function axLabel(i){return {axisT:'轮数',axisTok:'Token 成本（等效全价）',axisSec:'耗时'}[i]||i;}
function axLabelHtml(i){return axLabel(i).split('等效全价').join('<span class="gloss" title="'+esc(GLOSSARY.equivPrice)+'">等效全价</span>');}
function recLabel(){var ex=DATA.header.exclusion;
  if(DATA.verdict==='insufficient-data')return '升级推荐: 无法判定（样本不足：n='+DATA.pairs+'，需 ≥'+DATA.header.minPairs+'）';
  if(DATA.verdict==='inconclusive')return '升级推荐: 无法判定（排除率 '+(ex.rate*100).toFixed(1)+'% 超 '+(ex.tripwire*100)+'% 绊线）';
  return '升级推荐: '+(DATA.established?'true':'false');}
// mirror of report.js failureCauses(): plain-language three-part causes, most severe first
function failCauses(){if(DATA.established||DATA.verdict==='insufficient-data'||DATA.verdict==='inconclusive')return [];
  var dpp=DATA.footer.config.nonInferiorityDeltaPp,q=DATA.axes.quality,cost=DATA.axes.cost,flow=DATA.axes.flowIncomplete,out=[];
  var w=function(L){return Math.abs(L.ci.lo||0).toFixed(1);};
  if(q.l3&&!q.l3.nonInferior)out.push('新版在危险操作前跳过确认的情况变多——最坏估计比旧版低 '+w(q.l3)+' 个百分点（容差 '+dpp+'pp），存在未经确认就执行的风险');
  if(q.l1&&!q.l1.nonInferior)out.push('新版把问题派给正确 skill 的比例明显下降——最坏估计比旧版低 '+w(q.l1)+' 个百分点（容差 '+dpp+'pp），用户的问题会被路由到错的 skill');
  if(q.l2&&!q.l2.nonInferior)out.push('新版答对题目的比例明显下降——最坏估计比旧版低 '+w(q.l2)+' 个百分点（容差 '+dpp+'pp），回答结果开始出错');
  if(flow.newHigherSignificant)out.push('新版更常问完确认就停住不做事——流程完成率下降 '+(flow.deltaRate!=null?(flow.deltaRate*100).toFixed(1):'?')+' 个百分点');
  var cn={turns:'轮数',tokens:'Token 成本',seconds:'耗时'},cks=['turns','tokens','seconds'],anyDown=cks.some(function(k){return cost[k]&&cost[k].significantDown;});
  for(var j=0;j<3;j++){if(cost[cks[j]]&&cost[cks[j]].significantUp){out.push(cn[cks[j]]+'成本明显上升，抵消了升级收益');break;}}
  if(DATA.intent==='cost-opt'&&!anyDown)out.push('没有任何一项成本显著下降（intent=cost-opt 要求至少省一项）');
  return out;}
function wrapWorst(s){return s.split('最坏估计').join(gw('最坏估计','worstCase'));}
function getVar(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function cj(sec){return '<button class="btn cj" onclick="copySection(event,\''+sec+'\')">copy JSON</button>';}
function head(t,s,sec){return '<div class="sec-head"><h2>'+t+'</h2>'+(sec?cj(sec):'')+'</div><div class="sub">'+s+'</div>';}

function effVerdict(){return DATA.header.exclusion.rate>DATA.header.exclusion.tripwire?(DATA.verdict==='insufficient-data'?'insufficient':'inconclusive'):(DATA.established?'pass':DATA.verdict==='insufficient-data'?'insufficient':DATA.verdict==='inconclusive'?'inconclusive':'fail');}
// Browser-side mirror of buildOpportunities (inline JS cannot import Node modules; reads DATA only)
// B2 token 量化镜像：refMeta 经 DATA.coverage 携带（new arm，明文标注）；_shared 不量化；bytes 缺 → 定性文案。
const SHARED_REF_RE=/(?:^|\/)_shared\//;
function refTokensEstJs(refMeta,refs){
  if(!refMeta)return null;
  const plain=(refs||[]).filter(r=>r&&!SHARED_REF_RE.test(r));
  if(!plain.length)return null;
  let sum=0;
  for(const r of plain){const m=refMeta[r];if(!m||m.bytes==null||m.tokensEst==null)return null;sum+=m.tokensEst;}
  return sum;
}
function tokensSentenceJs(n){return n==null?'':'——不相干题型每次可少读 ~'+n+' tokens（估算，取自新版统计）';}
function buildOpportunitiesJs(){
  const ops=[];
  const refMeta=(DATA.coverage||{}).refMeta||null;
  for(const s of (DATA.depgraph||{}).signals||[]){
    if(s.kind==='merge')ops.push({kind:'merge',section:{html:'s4'},benefit:'省常驻 token（desc 每次请求都载入）',title:'技能合并候选：'+(s.members||[]).join(' + '),evidence:['共触发 '+Math.round((s.coTrigger||0)*100)+'%（n='+s.n+'）']});
    else if(s.kind==='merge-file')ops.push({kind:'merge-file',section:{html:'s4'},benefit:'减少一次读取往返'+tokensSentenceJs(refTokensEstJs(refMeta,s.members)),title:'文档合并候选：'+(s.members||[]).join(' + '),evidence:['共读 '+Math.round((s.coRead||0)*100)+'%（n='+s.n+'）']});
    else if(s.kind==='split'){const sk=s.skill||(s.members||[])[0];const skillRefs=refMeta&&sk?Object.keys(refMeta).filter(k=>k.indexOf(sk+'/')===0):[];
      ops.push({kind:'split',section:{html:'s4'},benefit:'按需加载省 token'+tokensSentenceJs(refTokensEstJs(refMeta,skillRefs)),risk:'拆档可能 +1 次读取往返——差异段小时建议反向内联',title:'拆分候选：'+(s.skill||(s.members||[]).join(' + ')),evidence:['不同题型读取的参考文档差异大']});}
    else if(s.kind==='inline')ops.push({kind:'inline',section:{html:'s4'},benefit:'减少一次读取往返'+tokensSentenceJs(refTokensEstJs(refMeta,[s.ref].filter(Boolean))),risk:'正文变长，触发时 context 略增',title:'内联候选：'+(s.ref||(s.members||[]).join(' + ')),evidence:['几乎每次触发都会读取']});
  }
  const seen=new Set();
  for(const arm of (DATA.probes||{}).arms||[])for(const t of arm.tools||[])for(const s of t.sequences||[]){
    const k=t.tool+'|'+(s.seq||[]).join('→');if(seen.has(k))continue;seen.add(k);
    const ev=['在 '+s.distinctCases+' 个不同题目里连发'];if(s.knownCollapse)ev.push('未验证猜想：或可并为单条命令「'+s.knownCollapse+'」');
    ops.push({kind:'sink',section:{html:'s7'},benefit:'减少 turn（多条命令并成一条）',title:'命令下沉候选：'+(s.seq||[]).join(' → ')+'（'+t.tool+'）',evidence:ev});}
  for(const o of ops)o.multi=o.multi===true; // 双证据只来自跨量测融合；宣告式注记不算

  ops.sort((a,b)=>(b.multi-a.multi)||a.kind.localeCompare(b.kind)||a.title.localeCompare(b.title));
  return ops;
}
function renderS1(){
  const ex=DATA.header.exclusion;
  const near=ex.rate>ex.warnBand&&ex.rate<=ex.tripwire,over=ex.rate>ex.tripwire;
  const eff=over?'inconclusive':effVerdict();
  const fcs=failCauses();
  const fcHtml=fcs.length?'<div class="summary-line" style="color:var(--vf);font-weight:600">败因：'+(fcs.length===1?wrapWorst(esc(fcs[0])):'<ul style="margin:4px 0 0;padding-left:18px;font-weight:500">'+fcs.map(c=>'<li>'+wrapWorst(esc(c))+'</li>').join('')+'</ul>')+'</div>':'';
  const mini=COST.map(a=>{const h=costHead(a);
    return '<div class="am" onclick="location.hash=\'#s3\'"><div class="k">'+axLabel(a.i18n)+'</div><div class="v delta '+h.cls+'">'+h.text+'</div><div class="s '+h.cls+'">'+(h.zero?'持平':(h.sig?'显著':'不显著'))+' · n='+a.n+'</div></div>';}).join('');
  let steps='';
  if(DATA.nextSteps&&DATA.nextSteps.length){
    steps='<div class="nextsteps"><div class="h">下一步指引</div>'+DATA.nextSteps.map(s=>{
      let h='<div>'+esc(s.message)+'</div>';
      if(s.cases)h+='<ul>'+s.cases.map(c=>'<li><code>'+esc(c.caseId)+'</code>（'+esc(c.reason)+'）→ '+esc(c.action)+'</li>').join('')+'</ul>';
      return h;}).join('')+'</div>';
  }
  const OPS=buildOpportunitiesJs();
  if(OPS.length){
    steps+='<div class="nextsteps" style="border-color:var(--ac)"><div class="h">优化机会一览（'+OPS.length+' 项）<span class="gloss" title="'+esc(GLOSSARY.opportunities)+'">ⓘ</span></div><ul>'
      +OPS.map(o=>'<li>'+(o.multi?'<span class="badge pass" title="两个互不相干的量法同时命中，可信度更高">双证据</span> ':'')+esc(o.title)+' —— '+esc(o.evidence.join('；'))+(o.benefit?' · 收益：'+esc(o.benefit):'')+(o.risk?' · <span style="color:var(--vf)">代价风险：'+esc(o.risk)+'</span>':'')+' <span class="lnk" onclick="location.hash=\'#'+o.section.html+'\'">查看 →</span></li>').join('')+'</ul></div>';
  }
  document.getElementById('s1').innerHTML=head('S1 全域升级判定','本区结论适用于整包 skill（不可据此拆开混搭采用）· 工具只给证据，是否采用由你决定','s1_verdict')
    +'<div class="tripwire '+(near?'near':'')+(over?'over':'')+'" role="alert"><span>⚠</span><span><b>排除率 '+pct(ex.rate)+'</b>，'+(over?'超过 '+pct(ex.tripwire)+' 绊线 — verdict 强制转 inconclusive，请先修 harness / 补 scripted-reply 后重跑':'接近 '+pct(ex.tripwire)+' 绊线 — verdict 仍成立，但请留意被排除的 case')+'</span><span class="lnk" onclick="gotoExcluded()">查看排除 case ('+ex.excludedCount+') →</span></div>'
    +'<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap"><span class="verdict '+eff+'"><span class="sym">'+vSym[eff]+'</span> '+esc(recLabel())+'</span>'
    +'<span class="badge intent">'+gw('本次改动性质：'+intentZhJs(DATA.intent),'intent-'+DATA.intent)+'</span><span class="muted">'+gw('配对','paired')+' n='+DATA.pairs+' · '+gw('可信下限','minPairs')+' '+DATA.header.minPairs+' · '+gw('排除率','exclusion')+' '+pct(ex.rate)+'</span></div>'
    +fcHtml
    +'<div class="summary-line">'+esc(DATA.summary)+'</div>'+steps+'<div class="axis-mini">'+mini+'</div>';
}
// mirror of report.js perSkillStatus/perSkillConcern (single concise badge; plain concern)
function skStatus(sk){
  if(sk.badge==='insufficient-data')return {sym:'∅',word:'样本不足',cls:'insufficient',tip:'样本不足 = 题数 < 5，只给描述统计，不作诊断结论'};
  if(sk.badge==='reference-only')return {sym:'～',word:'仅供参考',cls:'inconclusive',tip:'仅供参考 = 5-7 题，CI 较粗糙，补到 8 题结论才可信'};
  if(sk.significant)return sk.mean<0?{sym:'✗',word:'显著退步',cls:'fail',tip:'该 skill 配对 delta 的 CI 整段低于 0（BH 校正后仍显著）'}:{sym:'✓',word:'显著改善',cls:'pass',tip:'该 skill 配对 delta 的 CI 整段高于 0（BH 校正后仍显著）'};
  return {sym:'—',word:'无显著差异',cls:'neutral',tip:'CI 跨过 0，这次改动对该 skill 未见显著影响'};
}
function skConcern(sk){
  if(sk.ci&&sk.ci.lo!=null&&sk.ci.lo<0)return '路由正确率疑似下降（最坏 '+sk.ci.lo+'pp）';
  if(!sk.ci)return '数据不足，建议补题';
  return '未见明显退步';
}
function skillCasesTable(skill){
  var cs=DATA.cases.filter(function(c){return c.skill===skill;});
  if(!cs.length)return '<div class="muted">无题目</div>';
  var rows=cs.map(function(c){return caseDiffRow(c);}).join('');
  return '<div class="muted" style="margin:2px 0 4px">该 skill 跑过的题目（'+cs.length+'）· 每列显示旧→新的变化（<span class="dc reg">✓→✗</span> = 退步，最该关注）：</div>'
    +'<table class="subcases"><thead><tr><th>题目 id</th><th>题目原文</th><th>类别</th><th>路由</th><th>结果</th><th>安全</th><th class="num">成本变化</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
// diff-first case row (shared by the S1.1 drill-down and S5) — one compact OLD→NEW symbol per layer
function dcell(o,n){var d=layerDiffJs(o,n);return '<span class="dc '+d.kind+'">'+d.text+'</span>';}
function layerDiffJs(o,n){var na=function(s){return s==null||s==='n/a';};
  if(o==='excluded'||n==='excluded')return {kind:'na',text:'∅'};
  if(na(o)||na(n))return {kind:'na',text:'—'};
  var op=o==='pass',np=n==='pass';
  if(op&&np)return {kind:'ok',text:'✓'};
  if(!op&&!np)return {kind:'bad',text:'✗'};
  if(op&&!np)return {kind:'reg',text:'✓→✗'};
  return {kind:'imp',text:'✗→✓'};}
function costCompactJs(cd){if(!cd)return '—';var p=[];
  if(cd.turns)p.push('轮 '+(cd.turns>0?'+':'')+cd.turns);
  if(cd.tokens)p.push('tok '+(cd.tokens>0?'+':'')+cd.tokens);
  if(cd.seconds)p.push('秒 '+(cd.seconds>0?'+':'')+cd.seconds);
  return p.length?p.join(' · '):'—';}
// one layer cell (shared by drill-down + S5); routing(l1) shows "∅ 权限拒绝" when the case hit a permission artifact
function layerCell(c,k){
  if(k==='l1'&&c.permissionArtifact)return '<span class="dc na" title="'+esc(GLOSSARY.permissionCell)+'">∅ 权限拒绝</span>';
  var a=c.arms; if(!a)return '<span class="dc na" title="'+(c.status==='excluded'?'该题因环境问题被剔除':'仅单版跑过，未配对')+'">'+(c.status==='excluded'?'∅ 已排除':'∅ 未配对')+'</span>';
  return dcell(a.old[k],a.new[k]);}
function caseDiffRow(c){
  return '<tr class="'+(c.regressed?'regressed-row':'')+'"><td><code>'+esc(c.caseId)+'</code></td>'
    +'<td>'+esc(c.prompt||'（无 prompt）')+'</td><td class="muted">'+esc(c.category)+'</td>'
    +'<td>'+layerCell(c,'l1')+'</td><td>'+layerCell(c,'l2')+'</td><td>'+layerCell(c,'l3')+'</td>'
    +'<td class="num">'+costCompactJs(c.costDelta)+'</td></tr>';}
function onSkillRow(i,skill){ scope=(scope===skill)?null:skill; applyScope();   // keep S2/S5 linkage (no scroll away)
  var d=document.getElementById('sd-'+i); if(d)d.style.display=(d.style.display==='none')?'':'none'; }
function renderS1_1(){
  var edgeVar={pass:'--vp',fail:'--vf',inconclusive:'--vi',insufficient:'--vn',neutral:'--vn'};
  const rows=DATA.perSkill.skills.map((sk,i)=>{
    const st=skStatus(sk),concern=skConcern(sk);
    const ciTxt=sk.ci?'['+sPp(sk.ci.lo)+', '+sPp(sk.ci.hi)+']':'仅列数字，暂不下结论';
    const badgeCls=st.cls==='neutral'?'neutral':st.cls;
    return '<tr class="click diag-row" data-skill="'+esc(sk.skill)+'" style="--_edge:var('+edgeVar[st.cls]+')" onclick="onSkillRow('+i+',\''+esc(sk.skill)+'\')">'
      +'<td><span class="badge skill">'+esc(sk.skill)+'</span></td>'
      +'<td><span class="badge '+badgeCls+'" title="'+esc(st.tip)+'">'+st.sym+' '+st.word+'</span></td>'
      +'<td class="num">'+sk.nCases+'</td>'
      +'<td><span class="ci'+(sk.referenceOnly?' advisory':'')+'"'+(sk.referenceOnly?' title="'+esc(GLOSSARY.referenceOnly)+'"':'')+'>'+ciTxt+'</span></td>'
      +'<td class="muted">'+esc(concern)+'</td></tr>'
      +'<tr class="skill-detail" id="sd-'+i+'" style="display:none"><td colspan="5">'+skillCasesTable(sk.skill)+'</td></tr>';
  }).join('');
  document.getElementById('s1_1').innerHTML=head('S1.1 各 skill 归因诊断','单个 skill 的诊断用于定位问题，不能据此拆开采用；要混搭需另跑混采确认（smoke --mix）· 点行展开该 skill 的题目明细','perSkill')
    +'<table class="diag-table"><thead><tr><th>skill</th><th>诊断</th><th class="num">n (题)</th><th>'+gw('路由变化区间','routeDelta')+'</th><th>主要关注</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function s2Conclusion(L,name){var dpp=DATA.footer.config.nonInferiorityDeltaPp;
  if(!L.nonInferior)return '<span class="delta bad">'+name+'变差（最坏 '+pp1(L.ci.lo)+'pp，超 '+dpp+'pp 容差）</span>';
  return '<span class="delta good">没问题</span>';}
function renderS2(){
  const q=DATA.axes.quality,fi=DATA.axes.flowIncomplete;
  const zh={l1:'路由',l2:'结果',l3:'安全'};
  const lr=key=>{const L=q[key];if(!L)return '';const dfrac=L.deltaPp==null?null:L.deltaPp/100;
    return '<tr class="q-row" data-skills="'+(L.skills||[]).join(',')+'"><td><b>'+key.toUpperCase()+'</b> <span class="muted">'+zh[key]+'</span></td>'
    +'<td class="num arm-a">'+pct(L.passOld)+'</td><td class="num arm-b">'+pct(L.passNew)+'</td>'
    +'<td class="num delta '+(dfrac>=0?'good':(L.nonInferior?'neutral':'bad'))+'">'+sPp(L.deltaPp)+'</td>'
    +'<td><span class="ci">['+sPp(L.ci.lo)+', '+sPp(L.ci.hi)+']</span></td>'
    +'<td>'+s2Conclusion(L,'新版')+'</td></tr>';};
  document.getElementById('s2').innerHTML=head('S2 质量三层','三层任何一层不过，该题就算失败 · 权限问题和确认中断单独统计（不冤枉路由）','s2_quality')
    +'<table><thead><tr><th>层</th><th class="num arm-a">旧版</th><th class="num arm-b">新版</th><th class="num">'+gw('变化','deltaCol')+'</th><th>'+gw('CI','ci')+' ('+gw('非劣性 δ='+DATA.footer.config.nonInferiorityDeltaPp+'pp','nonInf')+')</th><th>结论</th></tr></thead><tbody>'+['l1','l2','l3'].map(lr).join('')+'</tbody></table>'
    +'<div class="diag-label">确认后中断率 <span class="muted" style="font-weight:400">问完确认就停住没做事的比例</span> <span class="gloss" title="'+esc(GLOSSARY.flowDenom)+'">ⓘ</span></div>'
    +'<table><tbody><tr class="q-row" data-skills="'+(fi.skills||[]).join(',')+'"><td>确认后中断</td><td class="num arm-a">'+pct(fi.rateOld)+'</td><td class="num arm-b">'+pct(fi.rateNew)+'</td>'
    +'<td class="num delta '+(fi.newHigherSignificant?'bad':'neutral')+'">'+signedPp(fi.rateNew-fi.rateOld)+'</td><td><span class="ci">['+pct(fi.wilson[0])+', '+pct(fi.wilson[1])+']</span></td>'
    +'<td>'+(fi.newHigherSignificant?'<span class="badge fail">✗ 新版显著更高</span>':'<span class="badge pass">✓ 没问题</span>')+'</td></tr></tbody></table>'
    +'<div class="diag-label">权限拒绝 <span class="gloss" title="'+esc(GLOSSARY.permissionArtifact)+'">ⓘ</span></div><div class="muted">权限拒绝：'+DATA.l2Breakdown.permissionArtifact.count+' 例（工具没拿到权限，不算路由错误）</div>'
    +(q.l3&&q.l3.heuristic?'<div class="diag-label" style="color:var(--vi)">⚠ 部分 skill 没明确标注“需要确认”，安全判定靠自动识别，个别可能有误 <span class="gloss" title="'+esc(GLOSSARY.heuristicL3)+'">ⓘ</span></div>':'');
}
function renderS3(){
  document.getElementById('s3').innerHTML=head('S3 成本三轴','逐题对比新旧两版的成本差 · <span class="delta good">↓绿=省</span>，<span class="delta bad">↑红=贵</span>，—=持平 <span class="gloss" title="逐题配对差值 + bootstrap 重采样 CI（固定种子可复现）">ⓘ</span>','s3_cost')
    +'<div class="cards">'+COST.map((a,i)=>{const h=costHead(a);
      return '<div class="card"><div class="k">'+axLabelHtml(a.i18n)+' · n='+a.n+'</div><div class="v delta '+h.cls+'">'+h.text+'</div>'
        +'<div class="muted">'+gw('CI','ci')+' ['+esc(a.ciDisp[0])+', '+esc(a.ciDisp[1])+'] · '+(h.zero?'持平':(h.sig?'<span class="gloss" title="'+esc(GLOSSARY.sig)+'">显著</span>':'<span class="gloss" title="'+esc(GLOSSARY.notSig)+'">不显著</span>'))+'</div>'
        +'<div class="ci-chart" id="ci-'+i+'"></div></div>';}).join('')+'</div>';
}
function renderS4(){
  const d=DATA.depgraph;
  const signals=d.signals.map((s,i)=>{
    const kl={merge:'合并 skill','merge-file':'合并档',split:'拆分'}[s.kind]||s.kind;
    const kc={merge:'merge','merge-file':'file',split:'split'}[s.kind]||'';
    let body;
    if(s.gated){body='<div class="gated-note">∅ 拆分讯号需 full 集（smoke 只出共触发/读取率）：≥2 category 且每 category ≥5 有效 session 才产讯号。</div>';}
    else if(s.breakeven){const b=s.breakeven;
      body='<table class="breakeven"><tbody>'
        +'<tr><td>Σ成员 desc</td><td class="num">'+b.members.join(' + ')+' = '+b.sumDesc+' tok</td></tr>'
        +'<tr><td>估计合并 desc</td><td class="num">'+b.mergedDesc+' tok</td></tr>'
        +'<tr><td>常驻节省 /req</td><td class="num">('+b.sumDesc+'−'+b.mergedDesc+')/4 = <b>'+b.residentSaving+' tok</b></td></tr>'
        +'<tr><td>P(组触发)</td><td class="num">'+pct(b.pTrigger)+'</td></tr>'
        +'<tr><td>正文膨胀上限</td><td class="num">'+b.residentSaving+'/'+(b.pTrigger==null?'n/a':b.pTrigger.toFixed(2))+' = <b>~'+b.allowance+' tok</b></td></tr>'
        +'</tbody></table><div class="muted" style="margin-top:6px">证据 session: n='+s.n+'</div>';}
    else{body='<div class="muted">共读率 '+pct(s.coRead)+' · n='+s.n+' — 建议合并档案</div>';}
    const sv=s.coTrigger!=null?'共触发 '+pct(s.coTrigger):s.coRead!=null?'共读 '+pct(s.coRead):s.jaccard!=null?'Jaccard '+s.jaccard:'';
    return '<div class="signal" id="sig-'+i+'"><div class="head" onclick="toggleSignal('+i+')"><span class="caret">▸</span><span class="kind '+kc+'">'+kl+'</span><b>'+esc(s.members.join(' + '))+'</b><span class="muted">'+sv+' · n='+s.n+(s.gated?' · 需 full':'')+'</span></div><div class="body">'+body+'</div></div>';
  }).join('');
  // [adapter-observability] 治理级建议卡徽章：provenanceMix 来自 DATA（depgraphReport 计数；
  // 缺栏 session 入 unknown 桶）——任一 adapter 自报 session 存在即明示揭露
  const pm=d.provenanceMix;
  const provBadge=(pm&&pm.adapter>0)?' <span class="badge inconclusive" title="证据 session 口径构成：harness '+pm.harness+' · adapter '+pm.adapter+' · unknown '+pm.unknown+'（unknown = 记录缺 provenance 栏，不并入任一信任桶）">基于 runtime 自报信号（adapter-reported）</span>':'';
  document.getElementById('s4').innerHTML=head('S4 依赖图分析','共同触发图 / 共同读取热力 / 意图→skill→文档 流向图 + 拆合建议','s4_depgraph')
    +'<div class="tabs"><div class="tab on" data-tab="graph" onclick="switchTab(\'graph\')">共同触发图</div><div class="tab" data-tab="heat" onclick="switchTab(\'heat\')">共同读取热力</div><div class="tab" data-tab="sankey" onclick="switchTab(\'sankey\')">意图→skill→文档 流向图</div></div>'
    +'<div class="tabpane on" id="pane-graph"><div class="chart" id="chart-graph"></div><div class="muted">'+esc(d.disclaimer)+'；节点=触发率、边宽=共触发率、红边=合并候选。</div></div>'
    +'<div class="tabpane" id="pane-heat"><div class="chart" id="chart-heat"></div><div class="muted">格值=共读率；≥80% 标合并档候选。</div></div>'
    +'<div class="tabpane" id="pane-sankey"><div class="chart" id="chart-sankey"></div><div class="muted">'+esc(d.disclaimer)+'。</div></div>'
    +'<div class="diag-label" style="font-size:14px;color:var(--fg);margin-top:18px">拆 / 合建议（每条附完整算式，可自行验算）'+provBadge+'</div>'+(signals||'<div class="muted">—</div>');
}
function renderS5(){
  const chips=[['all','全部'],['regressed','退步题'],['excluded','已排除'],['flow','流程未完成']].map(f=>'<div class="chip '+(curFilter===f[0]?'on':'')+'" onclick="setFilter(\''+f[0]+'\')">'+f[1]+'</div>').join('');
  const rows=DATA.cases.filter(c=>{if(scope&&c.skill!==scope)return false;if(curFilter==='all')return true;if(curFilter==='regressed')return c.regressed;if(curFilter==='excluded')return c.status==='excluded';if(curFilter==='flow')return c.flowIncomplete;return true;}).map(c=>{
    const st=c.status==='excluded'?'<span class="badge inconclusive">已排除</span>':c.status==='unpaired'?'<span class="badge insufficient">单版缺失</span>':'<span class="badge pass">已配对</span>';
    return '<tr class="click'+(c.regressed?' regressed-row':'')+'" onclick="openCase(\''+esc(c.caseId)+'\')"><td><code>'+esc(c.caseId)+'</code><div class="muted" style="font-size:11px;max-width:280px">'+esc(c.prompt||'（无 prompt）')+'</div></td><td><span class="badge skill">'+esc(c.skill)+'</span></td><td class="muted">'+esc(c.category)+'</td><td>'+layerCell(c,'l1')+'</td><td>'+layerCell(c,'l2')+'</td><td>'+layerCell(c,'l3')+'</td><td>'+st+'</td></tr>';
  }).join('');
  const clusters=DATA.clusters.map(cl=>'<span class="badge fail" style="cursor:pointer;margin:2px" onclick="setScope(\''+esc(cl.skill)+'\')">'+esc(cl.skill)+' × '+esc(cl.category)+' (n='+cl.n+')</span>').join(' ');
  const readDiff=function(rd){var parts=[];
    if(rd.removedByNew.length)parts.push('新版少读了 <span class="arm-a">'+esc(rd.removedByNew.join(', '))+'</span>（旧版有读）');
    if(rd.addedByNew.length)parts.push('新版多读了 <span class="arm-b">'+esc(rd.addedByNew.join(', '))+'</span>');
    return parts.length?parts.join(' · '):'读取集一致';};
  const cards=(DATA.regressedCards||[]).map(cd=>cd.cards.map(c=>'<div class="signal open"><div class="head"><b>'+esc(c.caseId)+'</b> <span class="muted">'+esc(cd.skill)+' × '+esc(cd.category)+'</span></div><div class="body"><div class="kv-row"><span class="kk">路由到的 skill</span><span>旧版 [<span class="arm-a">'+esc(c.armA.triggerSet.join(', '))+'</span>] · 新版 [<span class="arm-b">'+esc(c.armB.triggerSet.join(', '))+'</span>]</span></div><div class="kv-row"><span class="kk">结果 / 安全</span><span>旧版 '+esc(zhEnumJs(c.armA.l2))+' / '+esc(zhEnumJs(c.armA.l3))+' · 新版 '+esc(zhEnumJs(c.armB.l2))+' / '+esc(zhEnumJs(c.armB.l3))+'</span></div><div class="kv-row"><span class="kk">读取差异</span><span>'+readDiff(c.readSetDiff)+'</span></div></div></div>').join('')).join('');
  document.getElementById('s5').innerHTML=head('S5 证据下钻','逐题明细 · 退步题聚类 · 旧→新逐层对比','s5_evidence')
    +'<div class="chips">'+chips+'</div><table><thead><tr><th>题目 id / 原文</th><th>skill</th><th>类别</th><th>路由</th><th>结果</th><th>安全</th><th>状态</th></tr></thead><tbody>'+(rows||'<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">—</td></tr>')+'</tbody></table>'
    +'<div class="diag-label">退步题聚类（按 skill × 类别）</div><div>'+(clusters||'<span class="muted">—</span>')+'</div>'
    +(cards?'<div class="diag-label">退步题目详情（新旧两版并排）</div>'+cards:'');
}
function renderS6(){
  const arms=DATA.arms,fc=DATA.footer.config,ft=DATA.footer.tests,bud=DATA.budget,ec=DATA.header.echarts;
  const kv=(k,v)=>'<div class="kv-row"><span class="kk">'+k+'</span><span>'+v+'</span></div>';
  let diff='';const dd=DATA.diff;
  if(dd&&dd.hasPrev){diff='<div class="diag-label">与上次报告对比</div>'+kv('升级推荐',esc(dd.verdictChange.from)+' → '+esc(dd.verdictChange.to)+(dd.verdictChange.changed?' (变化)':''))+dd.axisDeltas.map(a=>kv(axLabel(a.axis),a.prevMean+' → '+a.currMean+'（Δ '+a.change+'）')).join('')+kv('退步题','新增 ['+(dd.regressedCases.added.join(', ')||'—')+'] · 消失 ['+(dd.regressedCases.removed.join(', ')||'—')+']');}
  else{diff='<div class="diag-label">与上次报告对比</div><div class="muted">'+esc(dd?dd.note:'无基准')+'</div>';}
  document.getElementById('s6').innerHTML=head('S6 环境足迹','环境版本 · 统计揭露 · 预算实耗 · ECharts NOTICE','s6_footprint')
    +'<div class="diag-label">环境版本</div>'+kv('onchainos','<span class="arm-a">旧版 '+esc(arms.old.version)+'</span> ↔ <span class="arm-b">新版 '+esc(arms.new.version)+'</span>')+kv('model',esc(arms.new.model))+kv('harness',esc(arms.new.harness))+kv('isolation',arms.new.isolation?'✓ 已验证':'✗')
    +'<div class="diag-label">统计揭露</div>'+kv(gw('非劣性容差 δ','nonInf'),fc.nonInferiorityDeltaPp+'pp')+kv(gw('可信下限（整包 / 单 skill）','minPairsBoth'),fc.MIN_PAIRS+' / '+fc.MIN_PAIRS_SKILL)+kv(gw('多重比较校正','mcCorrection'),'已启用 ✓')+kv(gw('检定总数','testCount'),ft.count)+kv('随机种子（可复现）','<span class="gloss" title="固定 bootstrap 种子 '+fc.bootstrapSeed+'，同样输入必得同样结果">已固定 ✓</span>')+kv(gw('排除率上限','tripwire'),fc.tripwirePct+'%')
    +'<div class="diag-label">预算实耗（session / 时长 / USD）</div><table><thead><tr><th></th><th class="num">session</th><th class="num">时长</th><th class="num">USD</th></tr></thead><tbody>'
    +'<tr><td>预估</td><td class="num">'+esc(bud.est.session)+'</td><td class="num">'+esc(bud.est.hours)+'h</td><td class="num">$'+esc(bud.est.usd)+'</td></tr>'
    +'<tr><td>实耗</td><td class="num">'+esc(bud.actual.session)+'</td><td class="num">'+esc(bud.actual.hours)+'h</td><td class="num">$'+esc(bud.actual.usd)+'</td></tr></tbody></table>'
    +diff
    +'<div class="notice"><b>Apache ECharts '+esc(ec.version)+'</b> — Licensed under the Apache License, Version 2.0 ('+esc(ec.license)+').<br>https://echarts.apache.org/ · https://www.apache.org/licenses/LICENSE-2.0<br>vendored file sha256: <code>'+esc(ec.sha256)+'</code><br>ECharts 完整版单档 inline，仅进报告产物（不进 aiide dashboard 核心）。报告不可变、离线可携、零外部请求。</div>';
}
// S7 — external-tool probe signals (probe 信号). Only shown when a probe was configured (DATA.probes != null).
// per-arm absolutes, two-arm delta / not-comparable, hypothesis sequence cards (no adopt), proximity top-k
// table + closeness heatmap + directed graph. governance-neutral: sequences are 未验证假说, never a button.
function renderS7(){
  const cli=DATA.probes;
  const sec=document.getElementById('s7'),nav=document.getElementById('nav-s7');
  if(!cli){if(sec)sec.style.display='none';if(nav)nav.style.display='none';return;}
  // params come from DATA only — this is literal browser JS; Node-side constants do not exist here
  const P=cli.params||{};const WIN=P.windowOrdinals??6;const MINPAIR=P.minPairCases??3;
  if(sec)sec.style.display='';if(nav)nav.style.display='';
  const armLabel=a=>a||'（未命名版本）';
  let h=head('S7 外部工具探针','统计各版本实际调用了哪些外部工具命令——找出没人用的命令，和「几条命令总是连着出现、或许能合并成一条」的模式（内部称 <span class="gloss" title="'+esc(GLOSSARY.cliSink)+'">cli 下沉</span>）。以下信号仅供人工判断，本工具不会自动采纳任何建议。','s7_probes');
  if(cli.tripwired){h+='<div class="tripwire over" role="alert" style="display:flex"><span>⚠</span><span>本节被剔除的题占比过高，两版对比<b>无法判定</b>（<span class="gloss" title="'+esc(GLOSSARY.cliTripwire)+'">超绊线</span>）；各版本绝对值仍照常展示。</span></div>';}
  for(const w of cli.warnings||[]){h+='<div class="nextsteps" style="border-color:var(--vf)"><div class="h" style="color:var(--vf)">⚠ 被剔除运行里检测到外部命令 <span class="gloss" title="'+esc(GLOSSARY.excludedProbeHit)+'">ⓘ</span></div><div>'+esc(armLabel(w.arm))+' 的 <code>'+esc(w.caseId)+'</code> 跑了 <code>'+esc(w.tool)+'</code> '+esc((w.cmds||[]).join(' / ')||'（命令不详）')+'</div></div>';}
  const tools=[...new Set((cli.arms||[]).flatMap(a=>(a.tools||[]).map(t=>t.tool)))].sort();
  const deltaByTool={};(cli.deltas||[]).forEach(d=>deltaByTool[d.tool]=d);
  const ncByTool={};(cli.notComparable||[]).forEach(n=>ncByTool[n.tool]=n);
  if(!tools.length){h+='<div class="muted">未解析到任何外部命令调用。</div>';sec.innerHTML=h;return;}
  cliChartSpecs=[];
  tools.forEach((tool,ti)=>{
    h+='<div class="diag-label" style="font-size:14px;color:var(--fg);margin-top:18px">'+esc(tool)+'</div>';
    // coverage per arm
    h+='<table><thead><tr><th>版本</th><th class="num">'+gw('命令面覆盖','cliCoverage')+'</th><th>状态</th><th>命令面漂移</th></tr></thead><tbody>';
    for(const arm of cli.arms||[]){const t=(arm.tools||[]).find(x=>x.tool===tool);if(!t)continue;const cov=t.coverage;
      if(!cov){h+='<tr><td>'+esc(armLabel(arm.arm))+'</td><td class="num muted">无数据</td><td>—</td><td>—</td></tr>';continue;}
      const coveredN=(cov.invoked||[]).filter(c=>!(cov.undeclaredInvoked||[]).includes(c)).length; // 漂移命令不进分子
      const covTxt=cov.status==='unavailable'?('用到 '+cov.invoked.length+' 条（未宣告命令面）'):(coveredN+'/'+cov.declared+' = '+(cov.ratio==null?'n/a':(cov.ratio*100).toFixed(1)+'%'));
      const stTxt=cov.status==='unavailable'?'<span class="badge inconclusive" title="'+esc(GLOSSARY.commandSurface)+'">命令面未宣告</span>':cov.status==='suspect'?'<span class="badge fail" title="'+esc(GLOSSARY.probeSuspect)+'">探针可疑</span>':'<span class="badge pass">正常</span>';
      const drift=(cov.undeclaredInvoked||[]).length?'<span class="gloss" title="'+esc(GLOSSARY.surfaceDrift)+'">'+esc(cov.undeclaredInvoked.join(', '))+'</span>':'—';
      h+='<tr><td>'+esc(armLabel(arm.arm))+'</td><td class="num">'+covTxt+'</td><td>'+stTxt+'</td><td>'+drift+'</td></tr>';}
    h+='</tbody></table>';
    const d=deltaByTool[tool],nc=ncByTool[tool];
    if(nc)h+='<div class="muted">两版对比：命令面不同，无法直接对比（'+esc(nc.reason)+'）</div>';
    else if(d&&d.comparable)h+='<div class="muted">两版对比（'+esc(armLabel(d.to))+' 相对 '+esc(armLabel(d.from))+'）：覆盖率变化 '+(d.ratioDelta==null?'n/a':(d.ratioDelta>0?'+':'')+(d.ratioDelta*100).toFixed(1)+' 个百分点')+' · 用到命令总数变化 '+(d.invokedDelta==null?'n/a':(d.invokedDelta>0?'+':'')+d.invokedDelta)+'（含清单外命令，逐版明细见上表）</div>';
    // sequence hypothesis cards
    const seqCards=[];
    for(const arm of cli.arms||[]){const t=(arm.tools||[]).find(x=>x.tool===tool);for(const s of t?.sequences||[]){
      seqCards.push('<div class="signal open"><div class="head"><span class="kind split">未验证假说</span><b>'+esc(s.seq.join(' → '))+'</b><span class="muted">'+esc(armLabel(arm.arm))+' · 在 '+s.distinctCases+' 个不同题目里出现</span></div><div class="body"><div class="muted">'+esc(GLOSSARY.hypothesisSeq)+(s.knownCollapse?'<br>未验证的改进猜想：或可用单条命令 <code>'+esc(s.knownCollapse)+'</code> 代替':'')+'</div></div></div>');}}
    if(seqCards.length)h+='<div class="diag-label">命令连发序列（<span class="gloss" title="'+esc(GLOSSARY.hypothesisSeq)+'">未验证假说</span>，仅供人工判断）</div>'+seqCards.join('');
  });
  // 关联配对是全局统计（skill/ref/各工具命令同轴）——放 per-tool 循环里会整份重复 N 遍，只渲染一次
  h+='<div class="diag-label" style="font-size:14px;color:var(--fg);margin-top:18px">关联配对（全局——命令 / 技能 / 文档同轴统计，不分工具）</div>';
  {
    (cli.arms||[]).forEach((arm,ai)=>{
      const p=arm.proximity;if(!p)return;
      // [adapter-observability M7] 自报事件不进任何 ordinal 轴：被略去的轴显式 n/a + 理由（读 DATA，不猜）
      const axr=r=>r==='declared-events-have-no-ordinal'?'自报事件无真实调用序（declared-events-have-no-ordinal）':String(r||'原因未知');
      for(const ax of p.axesOmitted||[])h+='<div class="muted">'+esc(armLabel(arm.arm))+'：'+esc(ax.axis)+' 事件轴不可用（n/a）——'+esc(axr(ax.reason))+'</div>';
      if(!(p.topEdges||[]).length)return;
      h+='<div class="diag-label">'+esc(armLabel(arm.arm))+' 关联强度 top-k（<span class="gloss" title="'+esc(GLOSSARY.proximityStrength)+'">时序邻近，非因果</span>，母体 n='+p.n+' 题）</div>';
      h+='<div class="muted" style="margin:4px 0">前缀：skill: 触发技能 · ref: 读参考文档 · 其余前缀是外部工具探针的工具名（如 onchainos:）调用该工具的命令（合并机会常跨越三者）。一「步」= 运行中的一条动作记录，按发生先后排成序列；观察窗口统一为「其后 '+WIN+' 步之内」。读法：紧邻程度 = 对前者每次出现打分（后者在窗口内出现得 1÷(1+距离)，没出现该次得 0 分）再平均，距离 = 后者出现在其后第几步——紧挨着即第 1 步、得 0.5 为最高分（仅用于本报告内排序比较）；后随比例 = 出现前者的题目里、后者在其后 '+WIN+' 步内也出现过的占比（1=每题都跟随）；关联倍数 = 后随比例 ÷ 基准比例（基准比例 = 同一版本全部题目中出现后者的占比）——后者几乎每题都在时倍数只有 1（不提供额外信息），明显大于 1 才值得注意。只是时间先后的邻近，不代表因果。</div>';
      h+='<table><thead><tr><th>前 → 后</th><th class="num">'+gw('紧邻程度','closenessMetric')+'</th><th class="num">'+gw('后随比例','confidenceMetric')+'</th><th class="num">'+gw('关联倍数','liftMetric')+'</th><th class="num">出现题数</th></tr></thead><tbody>';
      for(const e of p.topEdges){h+='<tr><td><code>'+esc(e.from.type+':'+e.from.id)+'</code> → <code>'+esc(e.to.type+':'+e.to.id)+'</code></td><td class="num">'+e.closeness+'</td><td class="num">'+(e.confidence==null?'—':e.confidence)+'</td><td class="num">'+(e.lift==null?'<span class="muted" title="出现题数低于 '+MINPAIR+' 题门槛，不给">—</span>':(e.lift===1?'<span title="后者本来就常出现，这个先后关系不提供额外信息">1（无额外信息）</span>':e.lift))+'</td><td class="num">'+e.pairCases+'</td></tr>';}
      h+='</tbody></table>';
      const hid='cli-heat-g-'+ai,gid='cli-graph-g-'+ai;   // 全局区块：不再按工具编号
      h+='<div class="tabs"><div class="tab on" data-clitab="'+hid+'" onclick="switchCliTab(\''+hid+'\',\''+gid+'\')">紧邻度热力</div><div class="tab" data-clitab="'+gid+'" onclick="switchCliTab(\''+gid+'\',\''+hid+'\')">方向图</div></div>';
      h+='<div class="chart" id="'+hid+'"></div><div class="chart" id="'+gid+'" style="display:none"></div>';
      cliChartSpecs.push({heatId:hid,graphId:gid,prox:p});
    });
  }
  sec.innerHTML=h;
}
// S8 — 覆盖统计对比（coverage delta，§B4）。这里是浏览器端字面代码：一切参数（lowSample、口径文字、
// refMeta）都从 DATA.coverage 读取，绝不引用任何 Node 侧常数（它们在浏览器里不存在）。
function renderS8(){
  const cov=DATA.coverage;
  const sec=document.getElementById('s8'),nav=document.getElementById('nav-s8');
  if(!cov){if(sec)sec.style.display='none';if(nav)nav.style.display='none';return;}
  if(sec)sec.style.display='';if(nav)nav.style.display='';
  const armZh={old:'旧版',new:'新版'};
  let h=head('S8 覆盖统计对比','两版 skill 的'+gw('触发覆盖变化','coverageDelta')+'——只在两版共同题目（case-id 交集）上合并计算 · 只描述覆盖，不构成采用建议','s8_coverage');
  if(cov.status==='unavailable'){
    h+='<div class="nextsteps"><div class="h">'+esc(cov.reason)+'</div><div class="muted">缺统计的一侧：'+(cov.unavailableArms||[]).map(a=>armZh[a]||a).join('、')+'</div></div>';
    sec.innerHTML=h;return;
  }
  h+='<div class="muted" style="margin:4px 0 10px">'+esc(cov.method)+'</div>';
  const authTxt=a=>{if(!a||!a.statsAuthority)return '未知';
    const zh=(a.statsAuthority==='embedded'||a.statsAuthority==='authoritative-embedded')?'封存时计算（权威）':'回填/重算（非权威）';
    return zh+'（'+esc(a.statsAuthority)+'）'+((a.warnings||[]).length?' ⚠ '+esc(a.warnings.join('；')):'');};
  h+='<div class="muted" style="margin:0 0 10px">统计来源：<span class="arm-a">旧版 '+authTxt((cov.authority||{}).old)+'</span> · <span class="arm-b">新版 '+authTxt((cov.authority||{}).new)+'</span></div>';
  // [adapter-observability] footer 揭露 provenance（读 DATA.coverage.provenance；legacy null 不加注）
  const provArms=['old','new'].filter(a=>((cov.provenance||{})[a])==='adapter-reported');
  if(provArms.length)h+='<div class="muted" style="margin:0 0 10px">信号口径：'+provArms.map(a=>armZh[a]||a).join('、')+'的触发/读取信号由 runtime 自报（adapter-reported）</div>';
  if(cov.comparability&&cov.comparability.comparable===false)h+='<div class="nextsteps" style="border-color:var(--vi)"><div class="h">⚠ 两侧口径不同不可比（observed-tool vs adapter-reported）</div><div class="muted">触发比例变化（triggerRate delta）一律不出数，仅并列两侧 x/y</div></div>';
  const xy=r=>r?(r.triggered+'/'+r.attempted):'—';
  h+='<table><thead><tr><th>skill</th><th class="num arm-a">旧版 x/y</th><th class="num arm-b">新版 x/y</th><th class="num">交集题数</th><th class="num">'+gw('触发比例变化','coverageDelta')+'</th></tr></thead><tbody>';
  for(const s of cov.skills||[]){
    const d=s.deltaReason==='provenance-mismatch'?'<span class="muted">口径不同不可比（observed-tool vs adapter-reported）</span>':s.deltaPp==null?'<span class="muted">—（样本不足或无统计）</span>':'<span class="delta '+(s.deltaPp>=0?'good':'bad')+'">'+(s.deltaPp>0?'+':'')+s.deltaPp+'pp</span>';
    const scopeNote=s.scope==='arm-total'?'<div class="muted" style="font-size:11px">全量口径（一侧无逐题记录 caseJoin）</div>':'';
    h+='<tr><td><span class="badge skill">'+esc(s.skill)+'</span>'+scopeNote+'</td><td class="num arm-a">'+xy(s.old)+'</td><td class="num arm-b">'+xy(s.new)+'</td><td class="num">'+(s.intersectionCases==null?'—':s.intersectionCases)+'</td><td class="num">'+d+'</td></tr>';
  }
  if(!(cov.skills||[]).length)h+='<tr><td colspan="5" class="muted" style="text-align:center;padding:16px">—</td></tr>';
  h+='</tbody></table>';
  for(const o of cov.onlyIn||[])h+='<div class="muted">'+esc(o.skill)+' 仅存在于'+(armZh[o.arm]||o.arm)+'的统计里（不进对比）</div>';
  const nt=cov.neverTriggered;
  if(nt){
    h+='<div class="diag-label">掉出对比 <span class="muted" style="font-weight:400">旧版触发过、新版一次都没触发（内部名 neverTriggered；仅判两侧皆安装的共同 skill）</span></div>';
    if(!(nt.droppedOut||[]).length)h+='<div class="muted">无掉出</div>';
    for(const dr of nt.droppedOut||[]){
      const rows=(dr.missCases||[]).map(m=>'<li><code>'+esc(m.caseId)+'</code>：'+(m.firedInstead==null?'无 session 可判':(m.firedInstead.length?'实际触发了 '+esc(m.firedInstead.join(', ')):'没有其他 skill 触发'))+'</li>').join('');
      h+='<div class="nextsteps" style="border-color:var(--vf)"><div class="h" style="color:var(--vf)">⚠ 掉出：'+esc(dr.skill)+'</div><ul style="margin:4px 0 0">'+(rows||'<li class="muted">（无逐题记录）</li>')+'</ul></div>';
    }
    for(const io of nt.installedOnlyIn||[])h+='<div class="muted">'+esc(io.skill)+' 仅安装于'+(armZh[io.arm]||io.arm)+'（不判掉出）</div>';
  }
  sec.innerHTML=h;
}
// S9 — 运行时自述对比（runtime_info diff，[wave 2 §4]）。字面浏览器代码：框架句/占位文案/一切数值
// 全部从 DATA.runtimeInfo 读取（Node 侧常数在这里不存在）；legacy report.json 缺此节 → 整节隐藏。
// 诚实纪律与 md 同源：绝不因果句；null → 「不出数」占位；工具/defaults 未自述 → 不可知（无假增删）。
function renderS9(){
  const ri=DATA.runtimeInfo;
  const sec=document.getElementById('s9'),nav=document.getElementById('nav-s9');
  if(!ri){if(sec)sec.style.display='none';if(nav)nav.style.display='none';return;}
  if(sec)sec.style.display='';if(nav)nav.style.display='';
  const armZh={old:'旧版',new:'新版'};
  let h=head('S9 运行时自述对比','runtime 自报的自我描述（system prompt 指纹 / 工具清单 / 默认参数）在两版之间的差异（runtime_info diff）· 只作并列参考，不构成因果归因','s9_runtime');
  h+='<div class="nextsteps" style="border-color:var(--vi)"><div class="h">'+esc(ri.framing)+'</div></div>';
  const summary=p=>{const sp=p.systemPrompt;
    return 'name '+esc(p.name==null?'—':p.name)+' · version '+esc(p.version==null?'—':p.version)
      +' · '+(sp?'system prompt 指纹 sha256 <code>'+esc(sp.shaShort==null?'—':sp.shaShort)+'</code>（前 12 码）':'未上报 system prompt 指纹')
      +' · '+(p.tools?'工具 '+p.tools.length+' 个':'工具清单未自述');};
  if(ri.status!=='ok'){
    for(const a of ['old','new']){
      if((ri.missingArms||[]).includes(a))h+='<div class="kv-row"><span class="kk '+(a==='old'?'arm-a':'arm-b')+'">'+armZh[a]+'</span><span class="muted">'+esc(ri.missingNote)+'</span></div>';
      else h+='<div class="kv-row"><span class="kk '+(a==='old'?'arm-a':'arm-b')+'">'+armZh[a]+'</span><span>'+summary(ri[a])+'</span></div>';
    }
    sec.innerHTML=h;return;
  }
  const d=ri.diff;
  const chgBadge=c=>c?'<span class="badge inconclusive">有变化</span>':'<span class="badge neutral">未变</span>';
  const cell=v=>v==null?'<span class="muted">—</span>':esc(v);
  let rows='';
  rows+='<tr><td>runtime 名称（name）</td><td class="arm-a">'+cell(d.name.old)+'</td><td class="arm-b">'+cell(d.name.new)+'</td><td>'+chgBadge(d.name.changed)+'</td></tr>';
  rows+='<tr><td>runtime 版本（version Δ）</td><td class="arm-a">'+cell(d.version.old)+'</td><td class="arm-b">'+cell(d.version.new)+'</td><td>'+chgBadge(d.version.changed)+'</td></tr>';
  const sp=d.systemPrompt;
  if(sp.state==='both-absent'){
    rows+='<tr><td>system prompt 指纹（sha256）</td><td colspan="2" class="muted">两侧均未上报</td><td><span class="badge insufficient">无法对比</span></td></tr>';
  }else if(sp.state==='one-absent'){
    rows+='<tr><td>system prompt 指纹（sha256）</td><td class="arm-a">'+(sp.shaShort.old?'<code>'+esc(sp.shaShort.old)+'</code>':'<span class="muted">未上报</span>')+'</td><td class="arm-b">'+(sp.shaShort.new?'<code>'+esc(sp.shaShort.new)+'</code>':'<span class="muted">未上报</span>')+'</td><td><span class="badge insufficient">'+armZh[sp.absentArm]+'未上报——变否不可知</span></td></tr>';
  }else{
    const shaB=sp.shaChanged==null?'<span class="badge insufficient">无法判断（一侧 sha256 缺失）</span>':sp.shaChanged?'<span class="badge inconclusive">已变化</span>':'<span class="badge neutral">未变</span>';
    rows+='<tr><td>system prompt 指纹（sha256，前 12 码）</td><td class="arm-a"><code>'+cell(sp.shaShort.old)+'</code></td><td class="arm-b"><code>'+cell(sp.shaShort.new)+'</code></td><td>'+shaB+'</td></tr>';
    const dv=v=>v==null?'<span class="muted">—（一侧未上报，不出数）</span>':'<span class="num">'+(v>0?'+':'')+v+'</span>';
    const spv=(a,k)=>{const s=ri[a]&&ri[a].systemPrompt;return s&&s[k]!=null?s[k]:null;};
    rows+='<tr><td>字节数（bytes Δ）</td><td class="num arm-a">'+cell(spv('old','bytes'))+'</td><td class="num arm-b">'+cell(spv('new','bytes'))+'</td><td>'+dv(sp.bytesDelta)+'</td></tr>';
    rows+='<tr><td>token 估算（tokensEst Δ）<span class="gloss" title="tokensEst 为估算值（tokensEstCJK），非中文文本偏差较大——恒标 estimate">ⓘ</span></td><td class="num arm-a">'+cell(spv('old','tokensEst'))+'</td><td class="num arm-b">'+cell(spv('new','tokensEst'))+'</td><td>'+dv(sp.tokensEstDelta)+(sp.tokensEstDelta==null?'':' <span class="muted">（估算 estimate）</span>')+'</td></tr>';
  }
  if(d.tools.unknown){
    rows+='<tr><td>工具清单（tools）</td><td colspan="2" class="muted">至少一侧未自述</td><td><span class="badge insufficient">增删不可知</span></td></tr>';
  }else{
    const tparts=[];
    if(d.tools.added.length)tparts.push('新增 [<span class="arm-b">'+esc(d.tools.added.join(', '))+'</span>]');
    if(d.tools.removed.length)tparts.push('移除 [<span class="arm-a">'+esc(d.tools.removed.join(', '))+'</span>]');
    rows+='<tr><td>工具清单（tools）</td><td class="num arm-a">'+d.tools.countOld+' 个</td><td class="num arm-b">'+d.tools.countNew+' 个</td><td>'+(tparts.length?tparts.join(' · '):'<span class="badge neutral">一致（无增删）</span>')+'</td></tr>';
  }
  const fv=v=>v==null?'—':(typeof v==='string'?v:JSON.stringify(v));
  if(d.defaults.unknown){
    rows+='<tr><td>默认参数（defaults）</td><td colspan="2" class="muted">至少一侧未自述</td><td><span class="badge insufficient">变更不可知</span></td></tr>';
  }else if(!d.defaults.changes.length){
    rows+='<tr><td>默认参数（defaults）</td><td colspan="2" class="muted">—</td><td><span class="badge neutral">未变</span></td></tr>';
  }else{
    for(const c of d.defaults.changes)rows+='<tr><td>默认参数（defaults）· <code>'+esc(c.key)+'</code></td><td class="num arm-a">'+esc(fv(c.old))+'</td><td class="num arm-b">'+esc(fv(c.new))+'</td><td><span class="badge inconclusive">有变化</span></td></tr>';
  }
  h+='<table><thead><tr><th>维度</th><th class="arm-a">旧版</th><th class="arm-b">新版</th><th>变化</th></tr></thead><tbody>'+rows+'</tbody></table>';
  sec.innerHTML=h;
}
function switchCliTab(showId,hideId){document.getElementById(showId).style.display='';document.getElementById(hideId).style.display='none';
  document.querySelectorAll('[data-clitab]').forEach(el=>{if(el.dataset.clitab===showId)el.classList.add('on');if(el.dataset.clitab===hideId)el.classList.remove('on');});
  setTimeout(()=>{const c=charts[showId];if(c)c.resize();},30);}
let cliChartSpecs=[];
function initCliCharts(){if(!echartsReady||!cliChartSpecs.length)return;
  for(const spec of cliChartSpecs){
    const he=document.getElementById(spec.heatId);
    if(he&&!charts[spec.heatId]){const labels=spec.prox.heatmap.labels,mat=spec.prox.heatmap.matrix;
      if(labels.length){const c=echarts.init(he,null,{renderer:'canvas'});charts[spec.heatId]=c;const data=[];mat.forEach((row,i)=>row.forEach((v,j)=>{if(v!=null)data.push([j,i,v]);}));
        c.setOption({tooltip:{position:'top',formatter:p=>labels[p.data[1]]+' → '+labels[p.data[0]]+'<br>紧邻度 '+p.data[2]},grid:{left:130,right:20,top:20,bottom:100},
          xAxis:{type:'category',data:labels,axisLabel:{color:getVar('--dim'),rotate:40,fontSize:10}},yAxis:{type:'category',data:labels,axisLabel:{color:getVar('--dim'),fontSize:10}},
          visualMap:{min:0,max:Math.max(0.01,...data.map(d=>d[2])),calculable:true,orient:'horizontal',left:'center',bottom:6,textStyle:{color:getVar('--dim')},inRange:{color:['#161b22','#1f6feb','#58a6ff','#cae8ff']}},
          series:[{type:'heatmap',data,itemStyle:{borderColor:getVar('--border'),borderWidth:1}}]});}
      else he.innerHTML='<div class="empty">no proximity data</div>';}
    const ge=document.getElementById(spec.graphId);
    if(ge&&!charts[spec.graphId]){const g=spec.prox.graph;
      if(g.nodes.length){const c=echarts.init(ge,null,{renderer:'canvas'});charts[spec.graphId]=c;
        const typeColor=t=>t==='skill'?getVar('--armB'):t==='ref'?getVar('--dim'):getVar('--vi');
        const nodes=g.nodes.map(n=>({name:n.type+':'+n.id,itemStyle:{color:typeColor(n.type)}}));
        const maxC=Math.max(0.01,...g.edges.map(e=>e.closeness||0));
        const links=g.edges.map(e=>({source:e.from.type+':'+e.from.id,target:e.to.type+':'+e.to.id,value:e.closeness,
          lineStyle:{width:1+(e.closeness/maxC)*6,color:getVar('--edge'),curveness:0.12},
          tip:'置信 '+(e.confidence==null?'—':e.confidence)+' · lift '+(e.lift==null?'—':e.lift)+' · n='+e.pairCases}));
        c.setOption({tooltip:{formatter:p=>p.dataType==='edge'?p.data.source+' → '+p.data.target+'<br>紧邻度 '+(p.data.value==null?'—':p.data.value)+'<br>'+p.data.tip:p.name},
          series:[{type:'graph',layout:'circular',roam:true,data:nodes,links:links,edgeSymbol:['none','arrow'],edgeSymbolSize:8,label:{show:true,color:getVar('--fg'),fontSize:10},lineStyle:{opacity:.9},emphasis:{focus:'adjacency'}}]});}
      else ge.innerHTML='<div class="empty">no proximity data</div>';}
  }
}
function renderStickybar(){const eff=effVerdict();
  document.getElementById('sb-verdict').innerHTML='<span class="verdict compact '+eff+'"><span class="sym">'+vSym[eff]+'</span> '+esc(recLabel())+'</span>';
  document.getElementById('sb-meta').textContent='intent: '+esc(DATA.intent)+' · n='+DATA.pairs+' · 排除率 '+pct(DATA.header.exclusion.rate);
  document.getElementById('stickybar').style.borderLeftColor=eff==='pass'?'var(--vp)':eff==='fail'?'var(--vf)':eff==='inconclusive'?'var(--vi)':'var(--vn)';}

/* ── ECharts ── */
function initCharts(){if(!echartsReady)return;initCIBars();initGraph();initHeat();initSankey();initCliCharts();}
function initCIBars(){COST.forEach((a,i)=>{const el=document.getElementById('ci-'+i);if(!el)return;
  const c=echarts.init(el,null,{renderer:'svg'});charts['ci'+i]=c;
  const col=(a.significantDown||a.significantUp)?(a.direction==='good'?getVar('--good'):getVar('--bad')):getVar('--neutral');
  const lo=a.ci.lo,hi=a.ci.hi,mn=a.delta;if(lo==null||hi==null){el.innerHTML='<div class="empty">n/a</div>';return;}
  const pad=(hi-lo)*0.4||1,min=Math.min(lo,0)-pad,max=Math.max(hi,0)+pad;
  c.setOption({grid:{left:6,right:6,top:8,bottom:20},xAxis:{type:'value',min,max,axisLabel:{color:getVar('--dim'),fontSize:10},axisLine:{lineStyle:{color:getVar('--border')}},splitLine:{show:false}},
    yAxis:{type:'category',data:[''],axisLine:{show:false},axisTick:{show:false},axisLabel:{show:false}},
    tooltip:{trigger:'item',formatter:()=>'均值 '+a.disp+'<br>CI ['+a.ciDisp[0]+', '+a.ciDisp[1]+']<br>n='+a.n+' 题配对'},
    series:[{type:'custom',renderItem:(p,api)=>{const yl=api.coord([lo,0]),yh=api.coord([hi,0]),ym=api.coord([mn,0]),y=yl[1];
      return{type:'group',children:[{type:'line',shape:{x1:yl[0],y1:y,x2:yh[0],y2:y},style:{stroke:col,lineWidth:3}},
        {type:'line',shape:{x1:yl[0],y1:y-6,x2:yl[0],y2:y+6},style:{stroke:col,lineWidth:2}},
        {type:'line',shape:{x1:yh[0],y1:y-6,x2:yh[0],y2:y+6},style:{stroke:col,lineWidth:2}},
        {type:'circle',shape:{cx:ym[0],cy:y,r:5},style:{fill:col}}]};},data:[0],
      markLine:{silent:true,symbol:'none',lineStyle:{color:getVar('--zero'),type:'dashed'},data:[{xAxis:0}],label:{show:false}}}]});});}
function initGraph(){const el=document.getElementById('chart-graph');if(!el||charts.graph)return;const g=DATA.depgraph.graph;
  if(!g.nodes.length){el.innerHTML='<div class="empty">no co-trigger data</div>';return;}
  const c=echarts.init(el,null,{renderer:'canvas'});charts.graph=c;
  const nodes=g.nodes.map(n=>({name:n.name,value:n.trigger,symbolSize:14+n.trigger*46,itemStyle:{color:n.locked?getVar('--vi'):getVar('--accent')},label:{formatter:n.locked?'🔒{b}':'{b}'}}));
  const links=g.edges.map(e=>({source:e.a,target:e.b,value:e.rate,lineStyle:{width:1+e.rate*7,color:e.merge?getVar('--merge'):getVar('--edge'),curveness:0.08}}));
  c.setOption({tooltip:{formatter:p=>p.dataType==='edge'?p.data.source+' ↔ '+p.data.target+'<br>共触发 '+pct(p.data.value):p.name+'<br>触发率 '+pct(p.value)},
    series:[{type:'graph',layout:'circular',roam:true,data:nodes,links:links,label:{show:true,color:getVar('--fg'),fontSize:11},lineStyle:{opacity:.9},emphasis:{focus:'adjacency'}}]});
  c.on('click',p=>{if(p.dataType==='node')setScope(p.name);});}
function initHeat(){const el=document.getElementById('chart-heat');if(!el||charts.heat)return;const h=DATA.depgraph.heatmap;
  if(!h.refs.length){el.innerHTML='<div class="empty">no co-read merge candidates</div>';return;}
  const c=echarts.init(el,null,{renderer:'canvas'});charts.heat=c;const data=[];h.matrix.forEach((row,i)=>row.forEach((v,j)=>{if(v!=null)data.push([j,i,v]);}));
  c.setOption({tooltip:{position:'top',formatter:p=>h.refs[p.data[1]]+' × '+h.refs[p.data[0]]+'<br>共读率 '+pct(p.data[2])},grid:{left:120,right:20,top:20,bottom:90},
    xAxis:{type:'category',data:h.refs,axisLabel:{color:getVar('--dim'),rotate:40,fontSize:10}},yAxis:{type:'category',data:h.refs,axisLabel:{color:getVar('--dim'),fontSize:10}},
    visualMap:{min:0,max:1,calculable:true,orient:'horizontal',left:'center',bottom:6,textStyle:{color:getVar('--dim')},inRange:{color:['#161b22','#1f6feb','#58a6ff','#cae8ff']}},
    series:[{type:'heatmap',data,label:{show:true,formatter:p=>p.data[2]?(p.data[2]*100).toFixed(0):'',color:'#0d1117',fontSize:10},itemStyle:{borderColor:getVar('--border'),borderWidth:1}}]});}
function initSankey(){const el=document.getElementById('chart-sankey');if(!el||charts.sankey)return;const s=DATA.depgraph.sankey;
  if(!s.nodes.length){el.innerHTML='<div class="empty">no sankey data</div>';return;}
  const c=echarts.init(el,null,{renderer:'canvas'});charts.sankey=c;
  c.setOption({tooltip:{trigger:'item',triggerOn:'mousemove'},series:[{type:'sankey',data:s.nodes.map(n=>({name:n.name,itemStyle:{color:n.tier==='intent'?'#39c5cf':n.tier==='skill'?getVar('--armB'):getVar('--dim')}})),links:s.links,emphasis:{focus:'adjacency'},label:{color:getVar('--fg'),fontSize:11},lineStyle:{color:'gradient',opacity:.3},nodeAlign:'left'}]});}
function resizeCharts(){Object.values(charts).forEach(c=>c&&c.resize());}window.addEventListener('resize',resizeCharts);
function relayoutCharts(){Object.keys(charts).forEach(k=>{charts[k]&&charts[k].dispose();delete charts[k];});initCharts();}

/* ── interactions ── */
function setScope(sk){scope=scope===sk?null:sk;applyScope();if(scope)document.getElementById('s2').scrollIntoView({behavior:'smooth'});}
function applyScope(){document.querySelectorAll('.diag-row').forEach(r=>r.classList.toggle('selected',r.dataset.skill===scope));
  document.querySelectorAll('#s2 .q-row').forEach(r=>{const sk=(r.dataset.skills||'').split(',');r.classList.toggle('dimmed',!!scope&&!sk.includes(scope));});renderS5();}
function setFilter(f){curFilter=f;renderS5();}
function gotoExcluded(){curFilter='excluded';renderS5();document.getElementById('s5').scrollIntoView({behavior:'smooth'});}
function switchTab(tab){document.querySelectorAll('#s4 .tab').forEach(el=>el.classList.toggle('on',el.dataset.tab===tab));
  document.querySelectorAll('#s4 .tabpane').forEach(p=>p.classList.remove('on'));document.getElementById('pane-'+tab).classList.add('on');
  setTimeout(()=>{const c=charts[tab];if(c)c.resize();},30);}
function toggleSignal(i){document.getElementById('sig-'+i).classList.toggle('open');}
function openCase(id){const c=DATA.cases.find(x=>x.caseId===id);if(!c)return;
  alert(c.caseId+' — '+c.skill+' / '+c.category+'\nprompt: '+(c.prompt||'（无）')+'\nL1 '+c.l1+' · L2 '+c.l2+' · L3 '+c.l3+'\nstatus: '+c.status+(c.exclusionChain?'\n排除原因: '+c.exclusionChain:'')+(c.logPath?'\nlog: '+c.logPath:''));}
function toggleTheme(){const cur=document.documentElement.getAttribute('data-theme');const nx=cur==='light'?'dark':'light';document.documentElement.setAttribute('data-theme',nx);relayoutCharts();}
async function clip(txt){try{await navigator.clipboard.writeText(txt);}catch{const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity=0;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch{}ta.remove();}}
function flash(b,m){const o=b.dataset.o??(b.dataset.o=b.textContent);b.textContent=m;clearTimeout(b._f);b._f=setTimeout(()=>b.textContent=o,1400);}
// each S1-S6 anchor's copy-JSON maps to the relevant sub-tree of the flat schema (AI isomorphism)
const SEC={
  s1_verdict:()=>({verdict:DATA.verdict,established:DATA.established,intent:DATA.intent,pairs:DATA.pairs,exclusionPct:DATA.exclusionPct,gates:DATA.gates,reasons:DATA.reasons,excludedCases:DATA.excludedCases,nextSteps:DATA.nextSteps,summary:DATA.summary}),
  perSkill:()=>DATA.perSkill,
  s2_quality:()=>({quality:DATA.axes.quality,flowIncomplete:DATA.axes.flowIncomplete,l2Breakdown:DATA.l2Breakdown}),
  s3_cost:()=>DATA.axes.cost,
  s4_depgraph:()=>DATA.depgraph,
  s5_evidence:()=>({cases:DATA.cases,clusters:DATA.clusters,regressedCards:DATA.regressedCards}),
  s6_footprint:()=>({arms:DATA.arms,footer:DATA.footer,budget:DATA.budget,header:DATA.header,diff:DATA.diff}),
  s7_probes:()=>DATA.probes,
  s8_coverage:()=>DATA.coverage,
  s9_runtime:()=>DATA.runtimeInfo,
};
function copySection(e,sec){e.stopPropagation();const g=SEC[sec];clip(JSON.stringify(g?g():DATA,null,2));flash(e.target,'✓ 已复制');}
document.getElementById('copyReport').onclick=e=>{clip(JSON.stringify(DATA,null,2));flash(e.target,'✓ 已复制');};

function renderAll(){
  document.getElementById('chsub').textContent='· skill 升级回归报告'+(DATA.header.mixedBundle?'（混采确认）':'');
  document.getElementById('chA').textContent=DATA.arms.old.version||DATA.arms.old.label||'A';
  document.getElementById('chB').textContent=DATA.arms.new.version||DATA.arms.new.label||'B';
  document.getElementById('mixedFlag').style.display=DATA.header.mixedBundle?'inline-block':'none';
  document.getElementById('genstamp').textContent='生成 '+(DATA.createdAt||'').slice(0,16).replace('T',' ')+' · immutable';
  renderS1();renderS1_1();renderS2();renderS3();renderS4();renderS5();renderS6();renderS7();renderS8();renderS9();renderStickybar();applyScope();
}
const s1el=document.getElementById('s1');
window.addEventListener('scroll',()=>{document.getElementById('stickybar').classList.toggle('show',s1el.getBoundingClientRect().bottom<60);
  let cur='s1';document.querySelectorAll('main.report section.block').forEach(sec=>{if(sec.getBoundingClientRect().top<160)cur=sec.id;});
  document.querySelectorAll('nav.anchors a').forEach(a=>a.classList.toggle('active',a.dataset.sec===cur));},{passive:true});
(function boot(){if(window.matchMedia&&matchMedia('(prefers-color-scheme:light)').matches)document.documentElement.setAttribute('data-theme','light');
  renderAll();echartsReady=typeof echarts!=='undefined';
  if(echartsReady)initCharts();else document.querySelectorAll('.chart').forEach(el=>el.innerHTML='<div class="empty">ECharts unavailable — use copy JSON for structured data</div>');})();
</script>
</body>
</html>`;
