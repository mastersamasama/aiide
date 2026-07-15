// Experiment-level automatic statistics (design §一/§二/§三). Pure engines over the archived
// reps + their parsed runs. NO writes, NO server access — the archive is immutable; buildExpStats
// returns a plain stats object for the sealing/report layers to embed and render.
//
// Honesty discipline (every rule here exists because an adversarial review demanded it):
//   • null-not-zero: an absent signal is null/omitted, never a fake 0.
//   • the coverage sample size is ALWAYS `nCoverageValid`, NEVER `n` — score.js already owns `n`
//     (which counts C=0 timeout failures INTO the denominator); the two must never collide.
//   • held_out cases are excluded FIRST at rep granularity, before any other bucketing.
//   • numerator == denominator base: content stats union only VALID runs; the ONE documented
//     exception is triggerRate, whose denominator includes noSession reps to align with score.js
//     activationRate (a timeout is attempted-but-not-triggered, not invisible).
//   • probability base for M7 proximity is DISTINCT CASES, so repeats cannot pseudo-replicate.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSessionEvents, attributeRead, SKILL_READ_RE, depgraphReport } from './depgraph.js';
import { depgraphToCharts } from './report.js';
import { classifyToolResult } from './parser.js';
// expected_skill may be a single skill or a multi-skill list (compound question). Coverage stats key
// on a single skill, so they use the PRIMARY (first) skill — a documented simplification; the full
// multi-skill semantics live in gradeRouting's L1 "all-must-trigger" grade, not in coverage.
const primarySkill = (x) => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));
// §3.2 toolUsage: the toolCall `kind` closed set lives with the other adapter schema value-domain
// constants (adaptercheck.js is the shared single-source home — check and stats can never drift).
import { TOOL_KINDS } from './adaptercheck.js';
import { probeZeroMatchWarning } from './probe.js';
import { UPGRADE_CONFIG } from './upgradeConfig.js';
// Deliberate src→web dependency (taxonomy §3.1(c), encode-in-code): web/obs.js hosts the ONE
// computeRunItems implementation the run-detail page renders its per-round buckets from, and it is
// plain Node-importable ESM (test/web-obs.test.js already drives it under `node --test`). expstats
// consumes the SAME bucket producer so dashboard rounds and the per-run aggregation here can never
// drift — the identity Σ(per-round buckets) == run contribution is golden-sample-pinned.
import { computeRunItems } from '../web/obs.js';
// sidechain cost-magnitude share folds usage via equivTokens' CONSTANT default weights (§3.5/G-16:
// no pricing plumbing — deterministic, weight-stable across experiments).
import { equivTokens } from './metrics.js';

// The CURRENT expstats schemaVersion — the one buildExpStats stamps. Exported so cmdStats can
// detect a STALE embedded blob (embedded schemaVersion < this → plain --write auto-recomputes a
// non-authoritative supplemental sidecar, taxonomy §3.0 r4 F-4-03) without hardcoding the number.
export const STATS_SCHEMA_VERSION = 3;

// ── run loading ───────────────────────────────────────────────────────────────
// runs/<runId>.json is written by lab.js as { run, metrics }; we want the parsed Run.
function loadRunFromDir(runsDir, runId) {
  const path = join(runsDir, `${runId}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.run ?? parsed ?? null;
  } catch { return null; }
}
// runsDir may be a directory path OR an injected loader(runId)→Run|null (tests use the latter to
// avoid touching disk). One resolver either way.
function runLoader(runsDir) {
  return typeof runsDir === 'function' ? runsDir : (runId) => loadRunFromDir(runsDir, runId);
}

// ── M-buckets: resolveReps (design §2.2) ────────────────────────────────────────
// tasks = { taskId: { reps:[{runId, excluded, ...}], held_out?, expected_skill?, category? } }.
// Order is fixed and load-bearing: held_out cases move ALL their reps to heldOutExcluded FIRST
// (so a held_out case's env-noise rep is NOT double-counted in nExcluded), then each remaining
// rep lands in exactly one of excluded / noSession / unresolved / valid. multi-step runId is
// comma-joined → split and each part loaded; any missing part → the whole rep is unresolved.
// Identity (受測): nRaw = nCoverageValid + nExcluded + heldOutExcluded + noSession + nUnresolved.
export function resolveReps(tasks, runsDir) {
  const load = runLoader(runsDir);
  const buckets = { valid: [], excluded: [], heldOutExcluded: [], noSession: [], unresolved: [] };
  let nRaw = 0;

  for (const [taskId, task] of Object.entries(tasks ?? {})) {
    const reps = task?.reps ?? [];
    const heldOut = task?.held_out === true;
    reps.forEach((rep, repeat) => {
      nRaw++;
      if (heldOut) { buckets.heldOutExcluded.push({ taskId, repeat, runId: rep?.runId ?? null }); return; }
      if (rep?.excluded === true) { buckets.excluded.push({ taskId, repeat, runId: rep?.runId ?? null }); return; }
      if (rep?.runId == null) { buckets.noSession.push({ taskId, repeat, runId: null }); return; }
      const runIds = String(rep.runId).split(',').map((s) => s.trim()).filter(Boolean);
      const runs = runIds.map((id) => load(id));
      if (runs.some((r) => r == null)) {
        buckets.unresolved.push({ taskId, repeat, runIds });
      } else {
        buckets.valid.push({ taskId, repeat, runIds, runs });
      }
    });
  }

  const counts = {
    nRaw,
    nCoverageValid: buckets.valid.length,
    nExcluded: buckets.excluded.length,
    heldOutExcluded: buckets.heldOutExcluded.length,
    noSession: buckets.noSession.length,
    nUnresolved: buckets.unresolved.length,
  };
  return { buckets, counts };
}

// ── M1: skillCoverage (design §一 M1) ───────────────────────────────────────────
// caseRecords = per-case unions over VALID runs: { caseId, triggerSet[], primarySet[], ... }.
// taskInfo = { [caseId]: { expected_skill, held_out, attempted, triggered } } where attempted =
// non-excluded non-held-out reps INCLUDING noSession, triggered = those reps that activated the
// expected skill. Three parallel readings so no single number over/under-states coverage:
//   everTriggered  — distinct cases each skill was triggered in (union over repeats), primary/aux
//   triggerRate    — triggered/attempted reps of cases whose expected_skill === skill; the
//                    denominator includes noSession reps to ALIGN with score.js activationRate.
//   neverTriggered — installed skills a case targets yet never fired in any valid run
//   notExercised   — installed skills NO case targets (no chance given — not dead weight)
//   caseJoin       — §S v2 per-case join, keyed by expected skill. 枚舉源釘死為 taskInfo（expected_skill
//                    基準的全部非 held_out case，含 noSession-only case——caseRecords 只有 valid runs，
//                    不可作枚舉源）。attempted/triggered 原樣取 taskInfo，與 triggerRate 同口徑
//                    （金樣本：Σ caseJoin.attempted/triggered === triggerRate 分母/分子，逐 skill 對帳）。
//                    firedInstead 三態：triggered=0 且該 case 有 valid run → 其他實際觸發 skill 的陣列
//                    （[]=可知且為空）；無 valid run（noSession-only 等）→ null（不可知，渲染「無 session
//                    可判」）；triggered>0 → 不填（省略欄位）。
export function skillCoverage(caseRecords, { installedSkills = [], taskInfo = {} } = {}) {
  const installed = [...installedSkills].sort();

  // everTriggered over valid case unions
  const trig = new Map(); // skill -> { cases:Set, primary:Set }
  for (const cr of caseRecords) {
    const prim = new Set(cr.primarySet ?? []);
    for (const skill of cr.triggerSet ?? []) {
      if (!trig.has(skill)) trig.set(skill, { cases: new Set(), primary: new Set() });
      trig.get(skill).cases.add(cr.caseId);
      if (prim.has(skill)) trig.get(skill).primary.add(cr.caseId);
    }
  }
  const everTriggered = [...trig.entries()].map(([skill, g]) => ({
    skill, cases: g.cases.size, primary: g.primary.size, auxiliary: g.cases.size - g.primary.size,
  })).sort((a, b) => a.skill.localeCompare(b.skill));
  const triggeredSkills = new Set(trig.keys());

  // triggerRate + targeting from taskInfo
  const targeted = new Set();
  const rate = new Map(); // skill -> { triggered, attempted }
  for (const info of Object.values(taskInfo)) {
    const skill = info?.expected_skill;
    if (!skill) continue;
    targeted.add(skill);
    if (!rate.has(skill)) rate.set(skill, { triggered: 0, attempted: 0 });
    const r = rate.get(skill);
    r.triggered += info.triggered ?? 0;
    r.attempted += info.attempted ?? 0;
  }
  const triggerRate = [...rate.entries()]
    .map(([skill, r]) => ({ skill, triggered: r.triggered, attempted: r.attempted }))
    .sort((a, b) => a.skill.localeCompare(b.skill));

  // Both buckets partition skills that NEVER triggered in a valid run, split by whether any
  // case targeted them. A skill that fired only as an auxiliary is in neither (it did trigger).
  const neverTriggered = installed.filter((s) => !triggeredSkills.has(s) && targeted.has(s));
  const notExercised = installed.filter((s) => !triggeredSkills.has(s) && !targeted.has(s));

  // §S v2 caseJoin — 枚舉 taskInfo（已由 buildExpStats 過濾掉 held_out）；同一份 attempted/triggered
  // 進 caseJoin 與 triggerRate，對帳恆等式由構造保證。
  const crById = new Map(caseRecords.map((cr) => [cr.caseId, cr]));
  const caseJoin = {};
  for (const [caseId, info] of Object.entries(taskInfo)) {
    const skill = info?.expected_skill;
    if (!skill) continue;
    const row = { caseId, attempted: info.attempted ?? 0, triggered: info.triggered ?? 0 };
    if (row.triggered === 0) {
      const cr = crById.get(caseId); // 有 caseRecord ⇔ 該 case 有 valid run
      row.firedInstead = cr ? (cr.triggerSet ?? []).filter((s) => s !== skill).sort() : null;
    }
    if (!caseJoin[skill]) caseJoin[skill] = { cases: [] };
    caseJoin[skill].cases.push(row);
  }
  for (const g of Object.values(caseJoin)) g.cases.sort((a, b) => a.caseId.localeCompare(b.caseId));

  return { installed, everTriggered, triggerRate, neverTriggered, notExercised, caseJoin };
}

// ── M2: refCoverage (design §一 M2 + §S v2) ──────────────────────────────────────
// caseRecords carry readCounts = { [logicalRef]: { runs, skill, refPath } } (valid-run reads
// within that case). refInventory = { skill: { versionSha, refs:[logicalRef...] } } snapshot —
// the engine NEVER reads a live profileDir. Before a shipped-but-unread ref becomes a dead-weight
// candidate it must clear three exemptions:
//   artifactOnlyRefs — read only in permission-artifact (blocked) runs → attempted, not dead
//   excludedOnlyRefs — read only in excluded runs (caller passes those reads separately)
//   notExercised     — owning skill never triggered in any valid run → its refs got no chance
// §S v2 增量：
//   inventoryStatus 閉集決定 bySkill 的可知性（[] 與 null 語義嚴格分離：null=不可知，[]=可知且空）。
//   分派是顯式的——每個已知值一個分支，未知值顯式降級為不可知（絕不靜默走 snapshot 分支）：
//     'snapshot'         → 完整 bySkill（shipped/unreadRefs/refs 全可知）
//     'adapter-declared' → bySkill 構造同 snapshot（宣告清單就是分母），但 bytes 不可知：
//                          頂級 refMeta = null（絕不 {} 假可知，F-2-22）、每 ref 行 bytes:null +
//                          reason:'adapter-declared'；宣告制無 _shared 語義 → 清單中含 _shared/
//                          的 ref 行不套 'shared-hash-namespace'（F-2-13）
//     'none-backfill'    → refs 從 readCounts 的 `<skill>/references/` 前綴反推（僅觀測到讀的；
//                          _shared 的 md5 namespace key 天然不匹配 → 不反推）；shipped/unreadRefs/
//                          bytes = null + reason:'no-inventory-snapshot'
//     'external-runtime' → bySkill = null + reason:'external-runtime-self-managed'（自管 skills）
//     其他任何值          → bySkill = null + reason:'unknown-inventory-status'（顯式降級：分母
//                          不可知，讀取觀測面 readCounts 照舊——不可知絕不冒充 snapshot 分母）
//   bySkill[].refs[] = [{ ref, bytes|null, readsRuns, readsCases, casesCoTriggered, blocked }]：
//     casesCoTriggered = 同 case 內（該 skill 觸發 ∧ 該 ref 被讀）distinct-case 數（caseRecords join，
//     分子恆 ≤ 該 skill everTriggered distinct cases——子集性質金樣本）；blocked = artifactOnly 豁免
//     命中；bytes 取 refMeta（seal 快照隨 stats 落盤），無則 null。_shared 明文 inventory ref 的運行期
//     logicalRef 帶 read-result md5（seal 不可重現）→ 不入 refMeta，其行 bytes=null +
//     reason:'shared-hash-namespace'。不改 attributeRead 的 canonical 雜湊行為。
export function refCoverage(caseRecords, {
  refInventory = {}, excludedReads = [], artifactReads = [],
  refMeta = null, inventoryStatus = 'snapshot',
} = {}) {
  // global valid read counts (runs + distinct cases) per logicalRef
  const readCounts = {};
  for (const cr of caseRecords) {
    for (const [ref, info] of Object.entries(cr.readCounts ?? {})) {
      if (!readCounts[ref]) readCounts[ref] = { runs: 0, cases: 0 };
      readCounts[ref].runs += info.runs ?? 0;
      readCounts[ref].cases += 1;
    }
  }
  const validRefs = new Set(Object.keys(readCounts));
  const artifactSet = new Set(artifactReads);
  const excludedSet = new Set(excludedReads);
  const artifactOnlyRefs = [...artifactSet].filter((r) => !validRefs.has(r)).sort();
  const excludedOnlyRefs = [...excludedSet].filter((r) => !validRefs.has(r) && !artifactSet.has(r)).sort();
  const artifactOnly = new Set(artifactOnlyRefs);
  const excludedOnly = new Set(excludedOnlyRefs);

  const triggeredSkills = new Set();
  for (const cr of caseRecords) for (const s of cr.triggerSet ?? []) triggeredSkills.add(s);

  // external-runtime：快照不可得且自管 → 不可知（null），絕非空集
  if (inventoryStatus === 'external-runtime') {
    return {
      inventoryStatus, bySkill: null, reason: 'external-runtime-self-managed',
      readCounts, artifactOnlyRefs, excludedOnlyRefs, refMeta: null,
    };
  }

  // §S v2 refs 行組裝。baseRow = 觀測面計數（各分支共用）；refRow = snapshot/none-backfill 行
  // （refMeta join + _shared 降級）；declaredRow = adapter-declared 行（bytes 恆 null +
  // reason:'adapter-declared'，_shared 不套 shared-hash-namespace——宣告制無 _shared 語義）。
  const SHARED_REF_RE = /(?:^|\/)_shared\//;
  const baseRow = (skill, ref) => {
    let casesCoTriggered = 0;
    for (const cr of caseRecords) {
      if ((cr.triggerSet ?? []).includes(skill) && cr.readCounts?.[ref]) casesCoTriggered++;
    }
    return {
      readsRuns: readCounts[ref]?.runs ?? 0,
      readsCases: readCounts[ref]?.cases ?? 0,
      casesCoTriggered,
      blocked: artifactOnly.has(ref),
    };
  };
  const refRow = (skill, ref) => {
    const shared = SHARED_REF_RE.test(ref);
    return {
      ref,
      bytes: shared ? null : (refMeta?.[ref]?.bytes ?? null),
      ...(shared ? { reason: 'shared-hash-namespace' } : {}),
      ...baseRow(skill, ref),
    };
  };
  const declaredRow = (skill, ref) => ({
    ref, bytes: null, reason: 'adapter-declared', ...baseRow(skill, ref),
  });
  // snapshot 與 adapter-declared 的 bySkill 骨架同構（都有完整分母），只差行構造器
  const inventoryBySkill = (rowOf) => Object.entries(refInventory).map(([skill, inv]) => {
    const refs = inv?.refs ?? [];
    const notExercised = !triggeredSkills.has(skill);
    const read = refs.filter((r) => validRefs.has(r)).length;
    // a not-exercised skill's refs are NOT dead-weight candidates → unreadRefs empty
    const unreadRefs = notExercised ? [] : refs.filter(
      (r) => !validRefs.has(r) && !artifactOnly.has(r) && !excludedOnly.has(r),
    ).sort();
    return {
      skill, versionSha: inv?.versionSha ?? null, shipped: refs.length, read, unreadRefs, notExercised,
      refs: [...refs].sort().map((r) => rowOf(skill, r)),
    };
  }).sort((a, b) => a.skill.localeCompare(b.skill));

  // none-backfill（`aiide stats` 回填）：僅觀測到讀的 refs 可反推；shipped/unreadRefs 不可知 → null
  if (inventoryStatus === 'none-backfill') {
    const inferred = new Map(); // skill -> [logicalRef]
    for (const ref of validRefs) {
      const m = ref.match(/^([^/]+)\/references\//);
      if (!m) continue; // SKILL.md、_shared/<suffix>#<md5> 等非 references 前綴 → 不反推
      if (!inferred.has(m[1])) inferred.set(m[1], []);
      inferred.get(m[1]).push(ref);
    }
    const bySkill = [...inferred.entries()].map(([skill, refs]) => ({
      skill, versionSha: null, shipped: null, read: refs.length, unreadRefs: null,
      notExercised: !triggeredSkills.has(skill),
      refs: refs.sort().map((r) => refRow(skill, r)),
    })).sort((a, b) => a.skill.localeCompare(b.skill));
    return {
      inventoryStatus, bySkill, reason: 'no-inventory-snapshot',
      readCounts, artifactOnlyRefs, excludedOnlyRefs, refMeta: null,
    };
  }

  // adapter-declared：宣告清單 = 分母（同 snapshot 骨架），bytes 全鏈不可知 → 頂級 refMeta:null
  if (inventoryStatus === 'adapter-declared') {
    return {
      inventoryStatus, bySkill: inventoryBySkill(declaredRow),
      readCounts, artifactOnlyRefs, excludedOnlyRefs, refMeta: null,
    };
  }

  // 未知 inventoryStatus：顯式降級為不可知（bySkill=null），絕不靜默走 snapshot 分支
  if (inventoryStatus !== 'snapshot') {
    return {
      inventoryStatus, bySkill: null, reason: 'unknown-inventory-status',
      readCounts, artifactOnlyRefs, excludedOnlyRefs, refMeta: null,
    };
  }

  // snapshot：完整 bySkill
  // refMeta 隨 stats 落盤（{}=可知且空；上游未傳 → {}，snapshot 語義下缺檔已按行降級 bytes=null）
  return {
    inventoryStatus, bySkill: inventoryBySkill(refRow),
    readCounts, artifactOnlyRefs, excludedOnlyRefs, refMeta: refMeta ?? {},
  };
}

// ── M3+M4+M5: cliStats (design §一 M3/M4/M5) ─────────────────────────────────────
// caseRecords carry .runs = [{ runId, triggerSet[], cliSet[] }] (valid runs). cfg = UPGRADE_CONFIG.probes.
// opts.zeroMatch (from probeZeroMatchWarning at the orchestrator) → coverage.status 'suspect'.
//   M3 coverage: invoked vs declared; declared missing → status 'unavailable'; undeclaredInvoked →
//                surface-drift warning; ratio = |invoked∩declared|/|declared|, capped at 1.
//   M4 bySkill : same-RUN presence — a cmd counts once per valid run in which its skill triggered;
//                a skill with < minSessionsForCoverage runs is flagged insufficient-data.
//   M5 sequences: per-run ADJACENT n-grams (2..ngramMaxLen), support in DISTINCT cases ≥
//                minSequenceCases (repeats of one case can't reach it); every card is a
//                "hypothesis"; a probe-declared collapse is annotation only (never a recommendation).
export function cliStats(caseRecords, probe, cfg = UPGRADE_CONFIG.probes, { zeroMatch = false } = {}) {
  const tool = probe.tool;
  const warnings = [];

  const invokedSet = new Set();
  const bySkillMap = new Map();   // skill -> { commands:Map<cmd,count>, runs:count }
  const seqCases = new Map();     // seqKey -> { seq:[], cases:Set, runs:Set }
  const seqDeclared = new Map();  // seqKey -> singleCommand (annotation)
  for (const s of probe.sequences ?? []) {
    if (Array.isArray(s.pattern) && s.pattern.length >= 2)
      seqDeclared.set(s.pattern.join(' '), s.singleCommand ?? null);
  }

  for (const cr of caseRecords) {
    for (const run of cr.runs ?? []) {
      const invs = (run.cliSet ?? []).filter((i) => i.tool === tool);
      const cmds = invs.map((i) => i.cmd);
      const distinctCmds = new Set(cmds);
      for (const c of distinctCmds) invokedSet.add(c);

      // M4: per-run presence per triggered skill
      for (const skill of run.triggerSet ?? []) {
        if (!bySkillMap.has(skill)) bySkillMap.set(skill, { commands: new Map(), runs: 0 });
        const g = bySkillMap.get(skill);
        g.runs += 1;
        for (const c of distinctCmds) g.commands.set(c, (g.commands.get(c) ?? 0) + 1);
      }

      // M5: adjacent n-grams within this run's ordered cli list
      for (let n = 2; n <= (cfg.ngramMaxLen ?? 3); n++) {
        for (let i = 0; i + n <= cmds.length; i++) {
          const gram = cmds.slice(i, i + n);
          const key = gram.join(' ');
          if (!seqCases.has(key)) seqCases.set(key, { seq: gram, cases: new Set(), runs: new Set() });
          const e = seqCases.get(key);
          e.cases.add(cr.caseId);
          e.runs.add(run.runId ?? cr.caseId);
        }
      }
    }
  }

  // M3 coverage
  const declared = probe.commandSurface?.commands ?? null;
  const invoked = [...invokedSet].sort();
  let coverage;
  if (!Array.isArray(declared)) {
    coverage = { invoked, declared: null, ratio: null, unused: [], undeclaredInvoked: [], status: 'unavailable' };
  } else {
    const declaredSet = new Set(declared);
    const covered = invoked.filter((c) => declaredSet.has(c));
    const unused = declared.filter((c) => !invokedSet.has(c)).sort();
    const undeclaredInvoked = invoked.filter((c) => !declaredSet.has(c));
    const ratio = declared.length ? Math.min(1, covered.length / declared.length) : null;
    if (undeclaredInvoked.length) warnings.push({ kind: 'surface-drift', undeclared: undeclaredInvoked });
    coverage = { invoked, declared: declared.length, ratio, unused, undeclaredInvoked, status: zeroMatch ? 'suspect' : 'available' };
  }
  if (zeroMatch) { coverage.status = 'suspect'; warnings.push({ kind: 'probe-zero-match', tool }); }

  const bySkill = [...bySkillMap.entries()].map(([skill, g]) => ({
    skill,
    commands: Object.fromEntries([...g.commands.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    runs: g.runs,
    status: g.runs < (cfg.minSessionsForCoverage ?? 5) ? 'insufficient-data' : 'ok',
  })).sort((a, b) => a.skill.localeCompare(b.skill));

  const minCases = cfg.minSequenceCases ?? 3;
  const sequences = [...seqCases.values()]
    .filter((e) => e.cases.size >= minCases)
    .map((e) => ({
      seq: e.seq,
      distinctCases: e.cases.size,
      runs: [...e.runs],
      knownCollapse: seqDeclared.get(e.seq.join(' ')) ?? null,
      status: 'hypothesis',
    }))
    .sort((a, b) => b.distinctCases - a.distinctCases || a.seq.join(' ').localeCompare(b.seq.join(' ')));

  return { tool, warnings, coverage, bySkill, sequences };
}

// ── M7: proximityMatrix (design §一 M7) ──────────────────────────────────────────
// runEvents = per-RUN ordered event lists: [ [{ type:'skill'|'ref'|<probe.tool>, id, ordinal, caseId }] ].
// Pairs are formed ONLY within a run (never across — different runs are different contexts, and a
// multi-step rep's steps are different workspaces). For every ordered pair (A before B) whose
// ordinal gap ≤ windowOrdinals, accumulate decay weight 1/(1+gap).
// Probability base = DISTINCT CASES (a case "has" a pair if ANY of its runs shows it), so repeats
// never pseudo-replicate:
//   confidence(A→B) = cases(A→B) / cases(A)
//   lift            = P(A,B)/(P(A)P(B)) over case probabilities — emitted only when pairCases ≥
//                     minPairCases, else null (thin support can't support a ratio).
//   closeness(A→B)  = Σ decay weights (all runs) / count(A occurrences across valid runs) — the
//                     normalizer is pinned so the value is bounded (≤ Σ_{g=1..window} 1/(1+g)) and
//                     a 4-round run and a 20-round run with the same gaps are directly comparable.
export function proximityMatrix(runEvents, cfg = UPGRADE_CONFIG.proximity) {
  const window = cfg.windowOrdinals ?? 6;
  const minPairCases = cfg.minPairCases ?? 3;
  const keyOf = (e) => `${e.type} ${e.id}`;

  const occ = new Map();        // nodeKey -> total occurrences across all runs
  const nodeCases = new Map();  // nodeKey -> Set(caseId)
  const nodeMeta = new Map();   // nodeKey -> { type, id }
  const pairWeight = new Map(); // pairKey -> Σ decay weight
  const pairEnds = new Map();   // pairKey -> { from:nodeKey, to:nodeKey }
  const pairCases = new Map();  // pairKey -> Set(caseId)
  const pairRuns = new Map();   // pairKey -> count of runs containing the pair
  const allCases = new Set();
  const SEP = String.fromCharCode(31); // unit-separator key delimiter (never in type/id/cmd)

  runEvents.forEach((events) => {
    const evs = [...events].sort((a, b) => a.ordinal - b.ordinal);
    const runPairSeen = new Set();
    for (const e of evs) {
      const k = keyOf(e);
      occ.set(k, (occ.get(k) ?? 0) + 1);
      if (!nodeCases.has(k)) nodeCases.set(k, new Set());
      nodeCases.get(k).add(e.caseId);
      if (!nodeMeta.has(k)) nodeMeta.set(k, { type: e.type, id: e.id });
      if (e.caseId != null) allCases.add(e.caseId);
    }
    for (let i = 0; i < evs.length; i++) {
      for (let j = i + 1; j < evs.length; j++) {
        const gap = evs[j].ordinal - evs[i].ordinal;
        if (gap > window) break;               // events sorted → no later j is closer
        if (evs[i].id === evs[j].id && evs[i].type === evs[j].type) continue; // self-pair meaningless
        const from = keyOf(evs[i]);
        const to = keyOf(evs[j]);
        const pk = `${from}${SEP}${to}`;
        if (!pairEnds.has(pk)) pairEnds.set(pk, { from, to });
        pairWeight.set(pk, (pairWeight.get(pk) ?? 0) + 1 / (1 + gap));
        if (!pairCases.has(pk)) pairCases.set(pk, new Set());
        pairCases.get(pk).add(evs[i].caseId);
        if (!runPairSeen.has(pk)) { runPairSeen.add(pk); pairRuns.set(pk, (pairRuns.get(pk) ?? 0) + 1); }
      }
    }
  });

  const nCases = allCases.size;
  const edges = [];
  for (const [pk, weight] of pairWeight) {
    const { from, to } = pairEnds.get(pk);
    const casesAB = pairCases.get(pk).size;
    const casesA = nodeCases.get(from).size;
    const casesB = nodeCases.get(to).size;
    const closeness = round4(weight / (occ.get(from) || 1));
    const confidence = casesA ? round4(casesAB / casesA) : null;
    let lift = null;
    if (casesAB >= minPairCases && nCases > 0) {
      const pA = casesA / nCases, pB = casesB / nCases, pAB = casesAB / nCases;
      lift = pA > 0 && pB > 0 ? round4(pAB / (pA * pB)) : null;
    }
    edges.push({
      from: nodeMeta.get(from), to: nodeMeta.get(to),
      closeness, confidence, lift, pairCases: casesAB, runs: pairRuns.get(pk) ?? 0,
    });
  }
  edges.sort((a, b) =>
    a.from.type.localeCompare(b.from.type) || a.from.id.localeCompare(b.from.id) ||
    a.to.type.localeCompare(b.to.type) || a.to.id.localeCompare(b.to.id));

  return { edges, n: nCases };
}

// ── taxonomy T1 Stage 3 section engines (schemaVersion 3, spec §3.0/§3.1/§3.5) ────────────────
// Shared null shape for every v3 section: an unknowable section is `{ value: null, reason }`
// (extra disclosure counts may ride along) — one consistent form, test-pinned. null-not-zero is
// the acceptance clause here: an absent channel NEVER becomes a fake 0.
const nullSection = (reason, extra = {}) => ({ value: null, reason, ...extra });
// mean ± min/max distribution over a non-empty numeric list; `r` = per-value rounder.
function dist(values, r = round4) {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean: r(m), min: r(Math.min(...values)), max: r(Math.max(...values)) };
}

// Per-run "incremental composition of the final context window" (§3.1). This is NOT a cost view —
// field names and copy deliberately avoid cost vocabulary. Buckets come from web/obs.js
// computeRunItems (the dashboard's own producer, sets round._attr in place on the loaded run) so
// Σ(per-round buckets) == this run's contribution by construction.
// Returns { skipped: reason } for runs the aggregation must skip — always disclosed upstream:
//   'untagged-legacy-run'  — run.userEventsTagVersion absent: the five-class srcKind split is
//                            parse-time information (tool-result-side needs message structure,
//                            meta-injected needs the isMeta flag) and CANNOT be rebuilt from an
//                            archived run — never backfill merged-bucket numbers (r4 F-4-01/r5 F-5-01).
//   'zero-final-footprint' — last main round carries no footprint → no denominator for this run.
export function runContextComposition(run) {
  if (run?.userEventsTagVersion == null) return { skipped: 'untagged-legacy-run' };
  computeRunItems(run); // tagged run → five-class round._attr buckets (same source as run detail page)
  const rounds = run.rounds ?? [];
  const finalFootprint = rounds.length ? (rounds.at(-1).contextFootprint ?? 0) : 0;
  if (!(finalFootprint > 0)) return { skipped: 'zero-final-footprint' };
  let skippedRounds = 0, baseline = null, compactionAbs = 0;
  const positive = { prevOut: 0, toolRes: 0, injectedUser: 0, injectedHarness: 0, skillBody: 0, residualPos: 0 };
  for (const r of rounds) {
    const fp = r.contextFootprint ?? 0;
    if (!(fp > 0)) { skippedRounds++; continue; }      // footprint-less round → skipped + disclosed
    if (baseline == null) { baseline = fp; continue; } // first (non-zero) main round = baseline bucket
    const a = r._attr;
    if (!a) continue; // only possible for the very first round (no previous round to diff against)
    positive.prevOut += Math.max(0, a.prevOut ?? 0);
    positive.toolRes += Math.max(0, a.toolRes ?? 0);
    positive.injectedUser += Math.max(0, a.injectedUser ?? 0);
    positive.injectedHarness += Math.max(0, a.injectedHarness ?? 0);
    positive.skillBody += Math.max(0, a.skillBody ?? 0);
    positive.residualPos += Math.max(0, a.other ?? 0);
    compactionAbs += Math.max(0, -(a.other ?? 0)); // |negative residual| — NEVER enters a share numerator
  }
  // §3.1 aggregation denominator = baseline + Σ positive buckets ("增量組成" self-consistent base:
  // with the final footprint as denominator, increments evicted by a compaction would stay in the
  // numerator and shares would sum > 100%; with THIS denominator Σ shares ≡ 100%).
  const denominator = baseline + positive.prevOut + positive.toolRes + positive.injectedUser
    + positive.injectedHarness + positive.skillBody + positive.residualPos;
  const shares = { baseline: baseline / denominator };
  for (const k of Object.keys(positive)) shares[k] = positive[k] / denominator;
  return {
    baseline, positive, denominator, shares,
    // compaction is disclosed independently (absolute + ratio to the denominator) — never netted
    // against positive buckets, never in a share numerator.
    compaction: { absolute: compactionAbs, shareOfDenominator: compactionAbs / denominator },
    peakFootprint: finalFootprint, // final main-round footprint, listed as its own peak field
    skippedRounds,
  };
}

// §3.1 experiment-level contextComposition. Gate (§3.0 null table): runtime !== 'claude-code' →
// null ('no-user-events-channel' — adapters have no userEvents channel, so the section is
// structurally unknowable, not zero). Per-run tag-presence guard: untagged legacy runs are skipped
// and counted; ALL runs untagged → whole section null ('untagged-legacy-run').
export function computeContextComposition(validBucket, { runtime } = {}) {
  if (runtime !== 'claude-code') return nullSection('no-user-events-channel');
  const nRuns = validBucket.reduce((a, v) => a + v.runs.length, 0);
  if (nRuns === 0) return nullSection('no-valid-runs');
  let untaggedLegacyRuns = 0, zeroFootprintRuns = 0, skippedRounds = 0;
  const perRun = [];
  for (const v of validBucket) {
    for (let s = 0; s < v.runs.length; s++) {
      const run = v.runs[s];
      const rc = runContextComposition(run);
      if (rc.skipped === 'untagged-legacy-run') { untaggedLegacyRuns++; continue; }
      if (rc.skipped === 'zero-final-footprint') { zeroFootprintRuns++; continue; }
      skippedRounds += rc.skippedRounds;
      perRun.push({ runId: run.id ?? v.runIds?.[s] ?? null, ...rc });
    }
  }
  if (untaggedLegacyRuns === nRuns) return nullSection('untagged-legacy-run', { untaggedLegacyRuns });
  if (!perRun.length) return nullSection('no-aggregatable-runs', { untaggedLegacyRuns, zeroFootprintRuns });
  const shares = {};
  for (const k of ['baseline', 'prevOut', 'toolRes', 'injectedUser', 'injectedHarness', 'skillBody', 'residualPos']) {
    shares[k] = dist(perRun.map((r) => r.shares[k]));
  }
  // largest-contribution run = largest composition denominator (ties → first in rep order, deterministic)
  const maxRun = perRun.reduce((a, b) => (b.denominator > a.denominator ? b : a));
  return {
    estimate: true, // toolRes/injected*/skillBody are chars/4 estimates — the whole section stays flagged
    n: perRun.length,
    untaggedLegacyRuns, zeroFootprintRuns, skippedRounds,
    shares,
    compaction: {
      runsWithCompaction: perRun.filter((r) => r.compaction.absolute > 0).length,
      absolute: dist(perRun.map((r) => r.compaction.absolute), Math.round),
      shareOfDenominator: dist(perRun.map((r) => r.compaction.shareOfDenominator)),
    },
    peakFootprint: dist(perRun.map((r) => r.peakFootprint), Math.round),
    maxContribution: { runId: maxRun.runId, denominator: maxRun.denominator },
  };
}

// §3.5/G-11 cacheHitRate: per-round cacheR/footprint over MAIN rounds (§3.2 scope note: only
// toolUsage counts sidechain rounds) → per-run mean → experiment mean ± min/max. Rounds with a
// null usage or a zero footprint have NO denominator — dropped from numerator AND denominator,
// counted in skippedRounds (never a fake 0 ratio). usage absent everywhere (adapter without a
// usage channel) → whole section null.
export function computeCacheHitRate(validBucket) {
  let skippedRounds = 0;
  const perRun = []; // { repeat, ratio } — repeat kept for the warm-cache descriptive table
  for (const v of validBucket) {
    for (const run of v.runs) {
      const ratios = [];
      for (const r of run.rounds ?? []) {
        const fp = r.contextFootprint ?? 0;
        if (r.usage == null || !(fp > 0)) { skippedRounds++; continue; }
        ratios.push((r.usage.cacheR ?? 0) / fp);
      }
      if (ratios.length) perRun.push({ repeat: v.repeat, ratio: ratios.reduce((a, b) => a + b, 0) / ratios.length });
    }
  }
  if (!perRun.length) return nullSection('no-usage', { skippedRounds });
  // repeat-order × cacheR table — DESCRIPTIVE (repeat ordinal is 1-based for display), not causal:
  // it shows whether later repeats ran warmer, it does not claim the repeat order caused it.
  const byRepeatMap = new Map();
  for (const r of perRun) {
    if (!byRepeatMap.has(r.repeat)) byRepeatMap.set(r.repeat, []);
    byRepeatMap.get(r.repeat).push(r.ratio);
  }
  const byRepeat = [...byRepeatMap.entries()].sort((a, b) => a[0] - b[0])
    .map(([repeat, rs]) => ({ repeat: repeat + 1, meanCacheR: round4(rs.reduce((a, b) => a + b, 0) / rs.length), n: rs.length }));
  return { n: perRun.length, skippedRounds, ...dist(perRun.map((r) => r.ratio)), byRepeat };
}

// §3.5/G-15 selfReport — multi-result-line Σ semantics: each `result` line reports its OWN
// increment (scripted-reply resume runs emit several), so the run value is the SUM — last-win and
// first-win are both wrong. Field names verbatim from the JSONL. In-field nulls are skipped, never
// coerced to 0; a field with no non-null value sums to null. A run without run.selfReports has no
// result-line channel → not in the Σ; NO run has one (every legacy archive) → whole section null.
export function computeSelfReport(validBucket) {
  const sumField = (recs, field) => {
    const vals = recs.map((r) => r[field]).filter((x) => x != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const anyField = (recs, field) => {
    const vals = recs.map((r) => r[field]).filter((x) => x != null);
    return vals.length ? vals.some(Boolean) : null;
  };
  const perRun = [];
  for (const v of validBucket) {
    for (const run of v.runs) {
      const srs = run.selfReports;
      if (!Array.isArray(srs) || !srs.length) continue;
      perRun.push({
        invocations: srs.length,
        total_cost_usd: sumField(srs, 'total_cost_usd'),
        num_turns: sumField(srs, 'num_turns'),
        duration_ms: sumField(srs, 'duration_ms'),
        is_error: anyField(srs, 'is_error'),
      });
    }
  }
  if (!perRun.length) return nullSection('no-result-lines'); // legacy runs: ALWAYS null, never 0
  const cost = sumField(perRun, 'total_cost_usd');
  return {
    runsWithSelfReport: perRun.length,
    invocations: perRun.reduce((a, r) => a + r.invocations, 0),
    total_cost_usd: cost == null ? null : round6(cost), // FP-dust rounding only — value is the self-reported Σ
    num_turns: sumField(perRun, 'num_turns'),
    duration_ms: sumField(perRun, 'duration_ms'),
    is_error: anyField(perRun, 'is_error'),
  };
}

// §3.5/G-16 sidechainShare. Gate (§3.0): only claude-code has a sidechain channel — an adapter
// run's `sidechains: []` is a structural constant of buildRunFromTrace, NEVER evidence of "no
// sidechains", so a non-claude-code runtime gets null ('no-sidechain-channel'), never a 0.
// On claude-code, no sidechain IS knowable-and-empty → share 0. The cost-magnitude share folds
// usage through equivTokens' constant default weights (deterministic, no pricing dependency).
export function computeSidechainShare(validBucket, { runtime } = {}) {
  if (runtime !== 'claude-code') return nullSection('no-sidechain-channel');
  const allRuns = validBucket.flatMap((v) => v.runs);
  if (!allRuns.length) return nullSection('no-valid-runs');
  const rawTokens = (r) => {
    const u = r.usage;
    return u ? (u.in ?? 0) + (u.out ?? 0) + (u.cacheR ?? 0) + (u.cacheW ?? 0) : 0;
  };
  const tokens = { sidechain: 0, total: 0 }, toolCalls = { sidechain: 0, total: 0 }, equiv = { sidechain: 0, total: 0 };
  let runsWithSidechain = 0;
  const addRound = (r, side) => {
    const t = rawTokens(r), c = (r.toolCalls ?? []).length, e = equivTokens(r.usage);
    tokens.total += t; toolCalls.total += c; equiv.total += e;
    if (side) { tokens.sidechain += t; toolCalls.sidechain += c; equiv.sidechain += e; }
  };
  for (const run of allRuns) {
    const sideRounds = (run.sidechains ?? []).flatMap((s) => s.rounds ?? []);
    if (sideRounds.length) runsWithSidechain++;
    for (const r of run.rounds ?? []) addRound(r, false);
    for (const r of sideRounds) addRound(r, true);
  }
  const shareOf = (t) => ({
    sidechain: round4(t.sidechain), total: round4(t.total),
    share: t.total > 0 ? round4(t.sidechain / t.total) : null, // 0/0 is unknowable, not 0
  });
  return { n: allRuns.length, runsWithSidechain, tokens: shareOf(tokens), toolCalls: shareOf(toolCalls), equivTokens: shareOf(equiv) };
}

// ── taxonomy T1 Stage 4 section engines (§3.2 toolUsage / §3.3 truncation / §3.4 fileTargets) ───

// §3.2/G-09 builtin classification source — VERSIONED ALLOWLIST as the ONLY source (r3 F-3-01
// BLOCKER reversal): `allowedTools` is a permission whitelist, NOT a tool universe — headless
// read-only tools auto-pass without being listed and a typical suite declares just ['Bash'], so
// classifying by it would send every successful Read to 'other'. This constant tracks claude-code's
// known built-in tool surface and EVOLVES with runtime versions (add/remove as the CLI changes);
// the section discloses allowlistVersion so cross-version compares can align (§4 honest boundary).
// Skill / Task / Agent are deliberately absent: the kind rules classify them BEFORE this set.
export const BUILTIN_ALLOWLIST_VERSION = 'aiide-0.1.0';
export const BUILTIN_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead',
  'ExitPlanMode', 'AskUserQuestion', 'SlashCommand', 'ListMcpResources', 'ReadMcpResource',
]);
// agent-launcher tool names (extensible constant — 'Task' is the historical claude-code name,
// 'Agent' the current one; both observed in real session JSONL).
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const MCP_TOOL_RE = /^mcp__/;

// §3.2 kind inference, unique-hit priority order: skill → agent → mcp → builtin allowlist → other.
export function inferToolKind(name) {
  const n = typeof name === 'string' ? name : '';
  if (n === 'Skill') return 'skill';
  if (AGENT_TOOLS.has(n)) return 'agent';
  if (MCP_TOOL_RE.test(n)) return 'mcp';
  if (BUILTIN_TOOLS.has(n)) return 'builtin';
  return 'other';
}

// §3.2 mcp server split: strip the `mcp__` prefix, server = everything up to the LAST `__`
// (golden: mcp__plugin_oki-team_oki-team__kanban_ops → server 'plugin_oki-team_oki-team' —
// server names themselves contain single underscores and dashes, only the final `__` separates
// the tool suffix). No `__` after the prefix → the whole remainder is the server.
export function mcpServerOf(name) {
  const rest = String(name ?? '').replace(MCP_TOOL_RE, '');
  const i = rest.lastIndexOf('__');
  return i > 0 ? rest.slice(0, i) : rest;
}

// §3.2/G-09/G-16 toolUsage. Counting caliber:
//   • adapter declaredKind (self-report) WINS when inside the closed set; out-of-domain → 'other'
//     + a stats warning (never silently accepted into a named bucket); absent → inferred.
//   • errors = classifyToolResult(tc) === 'error' (permission-artifact EXCLUDED); denials =
//     classifyToolResult(tc) === 'permission-artifact' — counted separately, a denial is not an error.
//   • main AND sidechain rounds both counted, disclosed separately (scope + per-kind split) —
//     §3.2 caliber sentence: ONLY toolUsage counts sidechain rounds; trigger/truncation/M7 stats
//     are main-rounds-only, so byKind.skill.main === the extractTriggers scan surface (golden-pinned).
//   • zero calls anywhere is legal 0 (§3.0: knowable over valid runs) — null only without valid runs.
export function computeToolUsage(validBucket, { warnings = [] } = {}) {
  const allRuns = validBucket.flatMap((v) => v.runs);
  if (!allRuns.length) return nullSection('no-valid-runs');
  const kindBucket = () => ({ main: 0, sidechain: 0 });
  const byKind = { skill: kindBucket(), agent: kindBucket(), mcp: kindBucket(), builtin: kindBucket(), other: kindBucket() };
  const byMcpServer = new Map(); // server -> { calls, errors, denials }
  const scope = { main: 0, sidechain: 0 };
  const kindSource = { declared: 0, inferred: 0 };
  const tools = new Map(); // name -> { name, kind, calls, errors, denials }
  const unknownDeclared = new Set();

  const addCall = (tc, side) => {
    const at = side ? 'sidechain' : 'main';
    scope[at]++;
    let kind;
    if (tc.declaredKind != null) {
      kindSource.declared++;
      if (typeof tc.declaredKind === 'string' && TOOL_KINDS.has(tc.declaredKind)) {
        kind = tc.declaredKind;
      } else {
        kind = 'other'; // out-of-domain self-report → 'other', disclosed below
        unknownDeclared.add(String(tc.declaredKind));
      }
    } else {
      kindSource.inferred++;
      kind = inferToolKind(tc.name);
    }
    byKind[kind][at]++;
    const cls = classifyToolResult(tc);
    const isError = cls === 'error';
    const isDenial = cls === 'permission-artifact';
    const name = tc.name ?? 'unknown';
    if (!tools.has(name)) tools.set(name, { name, kind, calls: 0, errors: 0, denials: 0 });
    const t = tools.get(name);
    t.calls++; if (isError) t.errors++; if (isDenial) t.denials++;
    if (kind === 'mcp') {
      const server = mcpServerOf(name);
      if (!byMcpServer.has(server)) byMcpServer.set(server, { calls: 0, errors: 0, denials: 0 });
      const m = byMcpServer.get(server);
      m.calls++; if (isError) m.errors++; if (isDenial) m.denials++;
    }
  };

  for (const run of allRuns) {
    for (const r of run.rounds ?? []) for (const tc of r.toolCalls ?? []) addCall(tc, false);
    for (const sc of run.sidechains ?? []) {
      for (const r of sc.rounds ?? []) for (const tc of r.toolCalls ?? []) addCall(tc, true);
    }
  }
  for (const v of [...unknownDeclared].sort()) {
    warnings.push(`toolCall declaredKind '${v}' outside the closed set (${[...TOOL_KINDS].join('/')}) — classified as 'other'`);
  }
  const topTools = [...tools.values()]
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, 10);
  return {
    allowlistVersion: BUILTIN_ALLOWLIST_VERSION, // builtin/other boundary evolves with aiide versions (§4)
    byKind,
    byMcpServer: Object.fromEntries([...byMcpServer.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    scope,
    kindSource,
    topTools,
  };
}

// §3.3/G-04 truncation. Read point per MAIN round: declaredStopReason ?? stopReason (the adapter
// self-report lands on the independent declaredStopReason field — r5 F-5-02 — so it feeds THIS
// section while round.stopReason stays null and score.js's L3 read points are structurally exempt).
// Denominator discipline: only rounds with a NON-NULL value; a null round is disclosed in
// unknownStopReason and NEVER counted as un-truncated. Unknown stopReason values are preserved
// verbatim in the byReason distribution. finalRoundTruncated is a RUN share (last main round =
// the run's actual last main round even for aborted/timeout runs — cross-read with D7 stats),
// with its own knowability denominator. All rounds null → whole section null ('no-stop-reason').
export function computeTruncation(validBucket) {
  const allRuns = validBucket.flatMap((v) => v.runs);
  if (!allRuns.length) return nullSection('no-valid-runs');
  let known = 0, unknownStopReason = 0, truncated = 0;
  const byReason = new Map();
  let finalKnownRuns = 0, finalTruncatedRuns = 0, unknownFinalRuns = 0;
  const stopOf = (r) => r.declaredStopReason ?? r.stopReason ?? null;
  for (const run of allRuns) {
    const rounds = run.rounds ?? [];
    for (const r of rounds) {
      const sr = stopOf(r);
      if (sr == null) { unknownStopReason++; continue; }
      known++;
      byReason.set(sr, (byReason.get(sr) ?? 0) + 1);
      if (sr === 'max_tokens') truncated++;
    }
    const last = rounds.at(-1);
    const lastSr = last ? stopOf(last) : null;
    if (lastSr == null) { unknownFinalRuns++; }
    else { finalKnownRuns++; if (lastSr === 'max_tokens') finalTruncatedRuns++; }
  }
  if (known === 0) return nullSection('no-stop-reason', { unknownStopReason });
  return {
    rounds: known,
    unknownStopReason,
    byReason: Object.fromEntries([...byReason.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    truncatedRoundShare: round4(truncated / known),
    finalRoundTruncated: {
      runs: finalTruncatedRuns, n: finalKnownRuns,
      share: finalKnownRuns > 0 ? round4(finalTruncatedRuns / finalKnownRuns) : null, // 0/0 unknowable
    },
    unknownFinalRuns,
  };
}

// §3.4 fileTargets tool scope: reads = Read; writes = the WRITE_TOOLS constant. Tool → path-field
// mapping (r3 F-3-07; score.js's three-fallback precedent): NotebookEdit carries notebook_path.
const FILE_TARGET_PATH_FIELD = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

// win32-honest normalization (§3.4): forward slashes + casefold of the WHOLE path including the
// drive letter, so `d:/work/x` and `D:\Work\X` land on the same key. Trailing slashes stripped.
function normFsPath(p) {
  return String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

// §3.4 bucket judgment, FIXED order (full partition of pathful calls):
//   relative → resolve against run.cwd first; then (1) cwd prefix → workspace (a skills/foo/
//   artifact INSIDE the workspace is workspace product, not a skill ref); (2) SKILL_READ_RE
//   (depgraph's ONE regex) → skillRefs; (3) everything else → otherAbsolute.
export function classifyFileTarget(rawPath, cwdNorm) {
  let norm = normFsPath(rawPath);
  const absolute = /^[a-z]:\//.test(norm) || norm.startsWith('/');
  if (!absolute && cwdNorm) norm = `${cwdNorm}/${norm}`;
  if (cwdNorm && (norm === cwdNorm || norm.startsWith(cwdNorm + '/'))) return 'workspace';
  if (SKILL_READ_RE.test(norm)) return 'skillRefs';
  return 'otherAbsolute';
}

// §3.4/G-07/G-14 fileTargets (claude-code only). Gate: runtime === 'claude-code' AND run.cwd
// non-null — an adapter run's cwd is a structural null (buildRunFromTrace), so the section is
// unknowable there ('no-cwd'), never zeros. Per-run: cwd-less runs are skipped + disclosed; ALL
// runs cwd-less → whole section null. Main rounds only (§3.2 caliber sentence). A call whose
// mapped path field is missing/non-string → `pathless` disclosure count, NOT bucketed (the three
// buckets partition pathful calls only). Glob/Grep deliberately out of scope (targets are
// patterns, not files — §0 caliber note).
export function computeFileTargets(validBucket, { runtime } = {}) {
  if (runtime !== 'claude-code') return nullSection('no-cwd');
  const allRuns = validBucket.flatMap((v) => v.runs);
  if (!allRuns.length) return nullSection('no-valid-runs');
  const bucket = () => ({ skillRefs: 0, workspace: 0, otherAbsolute: 0, pathless: 0 });
  const reads = bucket(), writes = bucket();
  let noCwdRuns = 0, n = 0;
  for (const run of allRuns) {
    if (run.cwd == null) { noCwdRuns++; continue; }
    n++;
    const cwdNorm = normFsPath(run.cwd);
    for (const r of run.rounds ?? []) {
      for (const tc of r.toolCalls ?? []) {
        const isRead = tc.name === 'Read';
        if (!isRead && !WRITE_TOOLS.has(tc.name)) continue;
        const target = isRead ? reads : writes;
        const p = tc.input?.[FILE_TARGET_PATH_FIELD[tc.name]];
        if (typeof p !== 'string' || !p) { target.pathless++; continue; }
        target[classifyFileTarget(p, cwdNorm)]++;
      }
    }
  }
  if (n === 0) return nullSection('no-cwd', { noCwdRuns });
  return { n, noCwdRuns, reads, writes };
}

// verifier identity for the fail distribution: type + detail with the CLOSED-SET dynamic suffixes
// stripped ('(saw …)' / '(missing…)' / '(not valid JSON)' — score.js fail shapes) so repeated
// fails of one verifier aggregate instead of fragmenting on run-specific values.
function verifierKey(vr) {
  return `${vr.type ?? 'unknown'}: ${String(vr.detail ?? '').replace(/\s*\((?:saw |missing|not valid JSON)[^)]*\)$/, '')}`;
}

// §3.5/G-17 statsHealth — observation-pipeline health over the reps themselves. The distributions
// (exclusionBreakdown / abortedAtStep) are ALWAYS knowable ({} = knowably empty). timeoutRate
// trusts ONLY the structured rep.timedOut field: a legacy rep (field absent, error string
// 'timeout') is UNKNOWABLE — counted in legacyUnknown and dropped from the denominator, never
// string-backfilled into the numerator and never a fake false. Held-out reps sit outside every
// stats denominator (same order rule as resolveReps).
export function computeStatsHealth(tasks, validBucket) {
  const exclusionBreakdown = {}, abortedAtStep = {};
  let timedOut = 0, knowable = 0, legacyUnknown = 0, retriedThenSucceeded = 0;
  const failCounts = new Map();
  for (const task of Object.values(tasks ?? {})) {
    if (task?.held_out === true) continue;
    for (const rep of task?.reps ?? []) {
      if (rep == null) continue;
      if (rep.excluded === true) {
        const sig = rep.excludedSignature ?? 'unknown';
        exclusionBreakdown[sig] = (exclusionBreakdown[sig] ?? 0) + 1;
      }
      if (rep.abortedAtStep != null) {
        const k = String(rep.abortedAtStep);
        abortedAtStep[k] = (abortedAtStep[k] ?? 0) + 1;
      }
      if (rep.timedOut === true) { timedOut++; knowable++; }
      else if (rep.timedOut != null) { knowable++; } // explicit structured false → knowable non-timeout
      else if (rep.error === 'timeout') { legacyUnknown++; } // legacy shape: disclosed, NOT counted either way
      else { knowable++; } // no structured field, no legacy timeout marker → knowably not a timeout
      if (Array.isArray(rep.retries) && rep.retries.length && rep.C === 1) retriedThenSucceeded++;
      for (const vr of rep.verifierResults ?? []) {
        if (vr && vr.pass === false) {
          const key = verifierKey(vr);
          failCounts.set(key, (failCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const parseWarningsTotal = validBucket
    .flatMap((v) => v.runs)
    .reduce((a, run) => a + (run.parseWarnings ?? 0), 0);
  const verifierFails = [...failCounts.entries()]
    .map(([verifier, fails]) => ({ verifier, fails }))
    .sort((a, b) => b.fails - a.fails || a.verifier.localeCompare(b.verifier))
    .slice(0, 10); // top list — the "which verifier is most often red" question
  return {
    exclusionBreakdown,
    abortedAtStep,
    parseWarningsTotal,
    timeoutRate: { timedOut, n: knowable, rate: knowable > 0 ? round4(timedOut / knowable) : null, legacyUnknown },
    retriedThenSucceeded,
    verifierFails,
  };
}

// ── orchestrator: buildExpStats (design §2.3 + §S v2) ────────────────────────────
// Ties the engines together over resolved reps + parsed runs. probes absent/empty → probes:null and
// proximity computed with skill/ref events only (probe events simply not present).
// §S v2 輸入增量：inventoryStatus（'snapshot' | 'none-backfill' | 'external-runtime'，判定在呼叫端——
// seal 按 runtime.type，回填端 exp.runtime !== 'claude-code' → external-runtime 優先）與 refMeta
// （seal 快照的 { [logicalRef]: { bytes, tokensEst } }，僅明文路徑 key）。皆原樣傳給 refCoverage。
// v3 輸入增量：`runtime` = experiment 級 runtime 字串（seal 端傳 'claude-code' 或 adapter 名；
// 回填端傳 exp.runtime）。undefined 視同非 claude-code——保守：claude-code-only 的節 gate 不開，
// 絕不猜測一個通道存在。
export function buildExpStats({
  tasks, runsDir, installedSkills = [], refInventory = {}, probes = [], config = UPGRADE_CONFIG,
  refMeta = null, inventoryStatus = 'snapshot', runtime = undefined,
} = {}) {
  const load = runLoader(runsDir);
  const { buckets, counts } = resolveReps(tasks, load);

  // per-valid-rep run events, grouped into case unions
  const caseMap = new Map(); // caseId -> caseRecord
  const runEvents = [];      // per valid run event list (M7)
  const taskInfo = {};       // caseId -> { expected_skill, held_out, attempted, triggered }
  const warnings = [];       // stats-level honesty warnings

  // experiment-level provenance aggregation (§2): one experiment = one runtime → all valid
  // runs share one value; a mix is anomalous → 'adapter-reported' + warning. No valid run → null.
  const provenances = new Set();
  // M7 axesOmitted (§2 M7): per axis — ordinal events all empty AND the set layer carries that
  // signal kind (signal exists but is declaration-only). Both axes judged independently.
  let anyTriggerEvents = false, anyReadEvents = false, anyTriggerSet = false, anyReadSet = false;
  // declared blocked reads (F-2-31): carried by declaredEvents only → joined into the
  // artifactReads exemption channel below (a blocked declared ref is attempted, not dead weight)
  const declaredBlockedRefs = new Set();

  const ensureCase = (caseId) => {
    if (!caseMap.has(caseId)) {
      const t = tasks[caseId] ?? {};
      caseMap.set(caseId, {
        caseId, expected_skill: primarySkill(t.expected_skill), category: t.category ?? null,
        held_out: t.held_out === true, triggerSet: new Set(), primarySet: new Set(),
        readCounts: {}, runs: [],
      });
    }
    return caseMap.get(caseId);
  };

  const allSessions = []; // Part D: single-arm reference-relationship — collectSessionEvents per run,
                          // fed to depgraphReport (same input the upgrade cohort pipeline uses per arm)
  for (const v of buckets.valid) {
    const cr = ensureCase(v.taskId);
    const caseInfo = { id: v.taskId, category: cr.category };
    for (let s = 0; s < v.runs.length; s++) {
      const run = v.runs[s];
      const ev = collectSessionEvents(run, caseInfo, { probes });
      allSessions.push(ev);
      provenances.add(ev.provenance);
      if (ev.triggerEvents.length) anyTriggerEvents = true;
      if (ev.readEvents.length) anyReadEvents = true;
      if (ev.triggerSet.length) anyTriggerSet = true;
      if (ev.readSet.length) anyReadSet = true;
      for (const d of ev.declaredEvents) {
        if (d.kind === 'read' && d.status === 'blocked' && typeof d.ref === 'string' && d.ref) {
          declaredBlockedRefs.add(d.ref);
        }
      }
      for (const sk of ev.triggerSet) cr.triggerSet.add(sk);
      if (ev.primarySkill) cr.primarySet.add(ev.primarySkill);
      // per-ref run tally within this case
      for (const r of ev.readSet) {
        if (!cr.readCounts[r.logicalRef]) cr.readCounts[r.logicalRef] = { runs: 0, skill: r.skill, refPath: r.refPath };
        cr.readCounts[r.logicalRef].runs += 1;
      }
      cr.runs.push({ runId: run.id ?? `${v.taskId}-r${v.repeat}-s${s}`, triggerSet: ev.triggerSet, cliSet: ev.cliSet });
      // M7 event list for THIS run (skill/ref first-occurrence + all probe invocations); each probe
      // event's type is its OWN tool name (its namespace), never a hardcoded 'cli'.
      const list = [
        ...ev.triggerEvents.map((e) => ({ type: 'skill', id: e.id, ordinal: e.ordinal, caseId: v.taskId })),
        ...ev.readEvents.map((e) => ({ type: 'ref', id: e.id, ordinal: e.ordinal, caseId: v.taskId })),
        ...ev.cliSet.map((e) => ({ type: e.tool, id: e.cmd, ordinal: e.ordinal, caseId: v.taskId })),
      ];
      runEvents.push(list);
    }
  }

  const caseRecords = [...caseMap.values()].map((cr) => ({
    ...cr, triggerSet: [...cr.triggerSet], primarySet: [...cr.primarySet],
  }));

  // taskInfo for triggerRate: attempted = valid + noSession reps (non-excluded, non-held-out);
  // triggered = attempted reps whose expected_skill fired in any of the rep's runs (noSession → not).
  const attemptedByTask = new Map();
  for (const v of buckets.valid) {
    const rec = attemptedByTask.get(v.taskId) ?? { attempted: 0, triggered: 0 };
    rec.attempted += 1;
    const expected = primarySkill(tasks[v.taskId]?.expected_skill);
    const fired = expected && v.runs.some((run) => collectSessionEvents(run, { id: v.taskId }, { probes }).triggerSet.includes(expected));
    if (fired) rec.triggered += 1;
    attemptedByTask.set(v.taskId, rec);
  }
  for (const ns of buckets.noSession) {
    const rec = attemptedByTask.get(ns.taskId) ?? { attempted: 0, triggered: 0 };
    rec.attempted += 1; // attempted-but-not-triggered (aligns activationRate)
    attemptedByTask.set(ns.taskId, rec);
  }
  for (const [taskId, task] of Object.entries(tasks ?? {})) {
    if (task?.held_out === true) continue;
    const rec = attemptedByTask.get(taskId) ?? { attempted: 0, triggered: 0 };
    taskInfo[taskId] = { expected_skill: primarySkill(task?.expected_skill), held_out: false, attempted: rec.attempted, triggered: rec.triggered };
  }

  // excluded-run and artifact (blocked) reads for M2 exemptions
  const excludedReads = new Set();
  // S7 washed-out tripwire: external-tool commands invoked in EXCLUDED repeats (the "new version
  // spams commands then halts → excluded rule quietly launders it" pattern). tool -> Set<cmd>.
  const excludedCli = new Map();
  for (const ex of buckets.excluded) {
    if (ex.runId == null) continue;
    for (const id of String(ex.runId).split(',').map((s) => s.trim()).filter(Boolean)) {
      const run = load(id);
      if (!run) continue;
      const ev = collectSessionEvents(run, { id: ex.taskId }, { probes });
      for (const r of ev.readSet) excludedReads.add(r.logicalRef);
      for (const c of ev.cliSet ?? []) {
        if (!excludedCli.has(c.tool)) excludedCli.set(c.tool, new Set());
        excludedCli.get(c.tool).add(c.cmd);
      }
    }
  }
  // artifact reads are BLOCKED reads → dropped from readSet; recovered by a light re-scan.
  // Declared blocked reads (adapter runs, declaredEvents kind:'read' status:'blocked') join the
  // same exemption channel (F-2-31) — a runtime that DISCLOSED a blocked ref attempted it.
  const artifactReads = new Set(declaredBlockedRefs);
  for (const v of buckets.valid) {
    for (const run of v.runs) collectBlockedRefs(run, artifactReads);
  }

  const skill = skillCoverage(caseRecords, { installedSkills, taskInfo });
  const ref = refCoverage(caseRecords, {
    refInventory, excludedReads: [...excludedReads], artifactReads: [...artifactReads],
    refMeta, inventoryStatus,
  });

  let probesStats = null;
  if (probes && probes.length) {
    probesStats = probes.map((probe) => {
      const zeroMatch = probeZeroMatchOverValid(buckets.valid, probe);
      const st = cliStats(caseRecords, probe, config.probes ?? UPGRADE_CONFIG.probes, { zeroMatch });
      st.excludedHits = [...(excludedCli.get(probe.tool) ?? [])].sort(); // S7 washed-out tripwire (additive)
      return st;
    });
  }

  const proximity = proximityMatrix(runEvents, config.proximity ?? UPGRADE_CONFIG.proximity);
  // §2 M7 axesOmitted: declared events never enter an ordinal axis (synthesized ordinal =
  // fabricated precision) — when an axis has SIGNALS (set layer non-empty) but ZERO ordinal
  // events, the axis is mechanically flagged n/a instead of silently rendering an empty axis.
  // Always an array ([] = no axis omitted) — consistent shape, test-pinned.
  const axesOmitted = [];
  if (!anyTriggerEvents && anyTriggerSet) axesOmitted.push({ axis: 'skill', reason: 'declared-events-have-no-ordinal' });
  if (!anyReadEvents && anyReadSet) axesOmitted.push({ axis: 'ref', reason: 'declared-events-have-no-ordinal' });
  proximity.axesOmitted = axesOmitted;

  // §2 provenance: f(run.source) aggregated over valid runs. Single runtime → single value;
  // empty (no valid run) → null (unknowable, never a fabricated default); mixed → anomaly.
  let provenance = null;
  if (provenances.size === 1) {
    provenance = provenances.values().next().value;
  } else if (provenances.size > 1) {
    provenance = 'adapter-reported';
    warnings.push('mixed run provenance within one experiment (harness-observed + adapter-reported) — anomalous; recorded as adapter-reported');
  }

  // R2′/R5 similarity + dup-lock detection REMOVED 2026-07-12 (user verdict: identical copies = harmless yet it pings a human; diverged copies = similarity drops and the signal vanishes — a reminder-only check that is blind at failure time is attention noise). Engines lived at git-less history: see .kiro/specs + docs/onchainos-upgrade-pipeline-design.md notes.

  return {
    // §S v2：caseJoin 落盤、bySkill[].refs[]、inventoryStatus 閉集、refMeta 隨 stats 落盤。
    // 舊實驗 immutable 不動——回填走本函式（讀 runs）天然產出 sidecar。
    // [adapter-observability Stage 3] additive 欄位：provenance、warnings、
    // proximity.axesOmitted、refCoverage 的 adapter-declared 分支。
    // [taxonomy T1 Stage 3] schemaVersion 3：新增 contextComposition / cacheHitRate / selfReport /
    // sidechainShare / statsHealth（§3.0 null 觸發條件表為驗收條款——不可知的節恆
    // { value: null, reason }，絕非 0）。
    // [taxonomy T1 Stage 4] 補齊 v3 節閉集的其餘三節：toolUsage（§3.2）/ truncation（§3.3）/
    // fileTargets（§3.4）——至此 §3.0 的 v3 節鍵逐字枚舉全數在盤。
    schemaVersion: STATS_SCHEMA_VERSION,
    provenance,
    warnings,
    nRaw: counts.nRaw,
    nCoverageValid: counts.nCoverageValid,
    nExcluded: counts.nExcluded,
    heldOutExcluded: counts.heldOutExcluded,
    noSession: counts.noSession,
    nUnresolved: counts.nUnresolved,
    skillCoverage: skill,
    refCoverage: ref,
    probes: probesStats,
    proximity,
    contextComposition: computeContextComposition(buckets.valid, { runtime }),
    // toolUsage may append declared-kind value-domain warnings into the SAME stats-level warnings
    // array returned above (the array reference is shared — computed before this object literal
    // is assembled would be cleaner, but `warnings` is referenced, not copied, so order is safe).
    toolUsage: computeToolUsage(buckets.valid, { warnings }),
    truncation: computeTruncation(buckets.valid),
    fileTargets: computeFileTargets(buckets.valid, { runtime }),
    cacheHitRate: computeCacheHitRate(buckets.valid),
    selfReport: computeSelfReport(buckets.valid),
    sidechainShare: computeSidechainShare(buckets.valid, { runtime }),
    statsHealth: computeStatsHealth(tasks, buckets.valid),
    // Part D — single-arm reference relationship (co-trigger graph / co-read heatmap / intent→skill→ref
    // sankey), same {graph,heatmap,sankey} shape the upgrade report carries. full:false — a single
    // experiment can't support the paired jaccard merge-split analysis; the charts populate from
    // co-trigger/co-read/read-rate signals honestly (sparse → empty states). null when no sessions.
    depgraph: allSessions.length ? depgraphToCharts(depgraphReport(allSessions, { full: false })) : null,
    // Raw per-session events (collectSessionEvents output) — the INPUT to depgraphReport, kept so the
    // dynamic cross-experiment compare can pool both arms' sessions and rebuild a TRUE two-arm merged
    // graph via the same tested depgraphReport (not a hand-merge of charted matrices). Also carries
    // per-case triggerSet/readSet, so it doubles as the S5 evidence trigger/read-diff source. Additive;
    // legacy embedded stats lack it → the compare falls back to the single-arm richer-of-two graph.
    depgraphSessions: allSessions.length ? allSessions : null,
  };
}

// ── backfill inventory resolution (design §3 consumer-matrix "bin/aiide.js stats 回填" row) ──────
// Adapter-declared skills_inventory → refInventory shape for buildExpStats (same structure,
// sanitized). Shared by the seal path (lab.js) and the stats backfill (bin/aiide.js) — a single
// conversion so the two can never drift. Returns null when nothing usable is declared.
export function toRefInventory(skillsInventory) {
  if (skillsInventory == null || typeof skillsInventory !== 'object') return null;
  const out = {};
  for (const [skill, entry] of Object.entries(skillsInventory)) {
    out[skill] = {
      versionSha: typeof entry?.versionSha === 'string' ? entry.versionSha : null,
      refs: Array.isArray(entry?.refs) ? entry.refs.filter((r) => typeof r === 'string').sort() : [],
    };
  }
  return Object.keys(out).length ? out : null;
}

// `aiide stats` 回填三段判定（pure, testable — the CLI is a thin caller）：
//   1. exp.environment.skillsInventory 非空 → 'adapter-declared'（seal hoist 的唯一封存副本
//      就是回填讀取源，F-2-18）——清單轉 refInventory 作分母；refMeta 恆 null（bytes 不可知）。
//   2. 否則 exp.runtime !== 'claude-code' → 'external-runtime'（自管 skills，分母不可知）。
//   3. 否則 → 'none-backfill'（claude-code 舊檔無快照，refs 從觀測讀取反推）。
export function resolveBackfillInventory(exp) {
  const declared = toRefInventory(exp?.environment?.skillsInventory);
  if (declared) return { inventoryStatus: 'adapter-declared', refInventory: declared };
  if (exp?.runtime !== 'claude-code') return { inventoryStatus: 'external-runtime', refInventory: {} };
  return { inventoryStatus: 'none-backfill', refInventory: {} };
}

// blocked (permission-artifact) ref reads → dead-weight exemption source for M2. Reuses the
// depgraph attribution rule but keeps the FAILED reads that collectSessionEvents drops.
function collectBlockedRefs(run, into) {
  for (const round of run?.rounds ?? []) {
    for (const tc of round.toolCalls ?? []) {
      if (tc.name !== 'Read') continue;
      if (classifyToolResult(tc) !== 'permission-artifact') continue;
      const attr = attributeRead(tc);
      if (attr) into.add(attr.logicalRef);
    }
  }
}

function probeZeroMatchOverValid(validBucket, probe) {
  const runs = validBucket.flatMap((v) => v.runs);
  return probeZeroMatchWarning(runs, probe) != null;
}

function round4(x) { return Math.round(x * 1e4) / 1e4; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
