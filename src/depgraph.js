// U2 dependency-graph COLLECTION layer.
//
// ┌─ SCOPE (this module, U2) ───────────────────────────────────────────────────┐
// │ Pure per-session event collection over the parsed Run model: ref-read        │
// │ attribution (with _shared normalization) and per-session {triggerSet,        │
// │ readSet, category} emission. NO rates, NO co-read/co-trigger matrices, NO     │
// │ Jaccard — those are the U5 ANALYSIS engine, which will extend THIS file       │
// │ below the marker at the bottom. Keep the collect/analyze boundary sharp.     │
// └──────────────────────────────────────────────────────────────────────────────┘
//
// Reads only; never writes session JSONL (experiment immutability).
// Trigger detection + permission classification are reused from parser.js so there
// is a single source of truth for the trigger fact and the permission taxonomy.

import { createHash } from 'node:crypto';
import { classifyToolResult } from './parser.js';
// [expstats/Wave 2] probe invocation extraction. collectSessionEvents gains opts.probes so the
// same single per-session pass that emits triggerSet/readSet also emits cliSet — additive only.
import { extractInvocations } from './probe.js';
// [U5] thresholds live ONLY in the U0 canonical config (U0 R0.0.2 forbids re-defining
// them); ESM imports must be top-level, so this one import is the sole addition above
// the marker. The U2 collection functions below are unchanged — analysis is appended
// past the [U5] EXTENSION POINT at the bottom.
import { UPGRADE_CONFIG } from './upgradeConfig.js';

// U2 R2.2.1: a Read belongs to <name> iff its file_path prefix hits skills/<name>/
// (references/ included). Path is normalized to forward slashes so Windows-absolute
// profile paths (…\skills\foo\…) match the same rule. Capture 1 = skill name,
// capture 2 = the remainder under the skill dir (e.g. references/x.md, _shared/util.md).
// Exported for taxonomy §3.4 fileTargets (expstats skill-refs bucket) — ONE regex, no copy drift.
export const SKILL_READ_RE = /(?:^|\/)skills\/([^/]+)\/(.+)$/;
// U2 R2.4.1a ([TL-M3]): the _shared sub-path whose suffix + content md5 normalizes
// cross-skill copies of the same file to one logical ref.
const SHARED_RE = /(?:^|\/)_shared\/(.+)$/;

// U2 R2.2 / R2.4.1a: attribute one Read tool call to a skill ref.
// Returns null when the file_path is not under any skills/<name>/ prefix.
// { skill, refPath, logicalRef, shared, success }:
//   refPath    — skill-qualified path (<name>/<rest>), kept for traceability
//   logicalRef — the dedup/co-read KEY. For a normal ref this is refPath. For a
//                _shared file it is normalized to `_shared/<suffix>#<md5>` WITHOUT the
//                skill name, so N skills each holding an identical _shared copy collapse
//                to ONE node (co-read rate not diluted). Drifted content → different md5
//                → different logical ref (a genuinely different file).
//   success    — R2.2.3: a successful Read has no is_error on its tool_result.
export function attributeRead(readCall, profileDir = null) {
  const fp = readCall?.input?.file_path;
  if (typeof fp !== 'string' || !fp) return null;
  const norm = fp.replace(/\\/g, '/');
  const m = norm.match(SKILL_READ_RE);
  if (!m) return null;
  const skill = m[1];
  const rest = m[2];
  const refPath = `${skill}/${rest}`;
  const success = readCall.isError !== true; // R2.2.3

  const sharedM = rest.match(SHARED_RE);
  let logicalRef, shared = false;
  if (sharedM) {
    shared = true;
    const suffix = sharedM[1];
    const md5 = readCall.result != null
      ? createHash('md5').update(String(readCall.result)).digest('hex')
      : null;
    logicalRef = `_shared/${suffix}#${md5 ?? 'no-content'}`;
  } else {
    logicalRef = refPath;
  }
  return { skill, refPath, logicalRef, shared, success };
}

// U2 R2.4.1/R2.4.2: collect one session's raw dependency events for [U5].
// Returns { sessionId, category, primarySkill, auxiliarySkills, triggerSet, readSet,
//           permissionEvents, skillBodyCostBySkill }.
//   triggerSet   — distinct skills triggered (primary first), R2.4.1
//   readSet      — distinct SUCCESSFUL ref reads, deduped by logicalRef (R2.4.1a);
//                  each entry { skill, refPath, logicalRef, shared }
//   permissionEvents — tool calls classified 'permission-artifact' (R2.5), each
//                  { tool, skill, id }. 'missed' is NOT emitted here: it needs the
//                  expected-tool set that only [U3] holds — call classifyToolResult
//                  with hasUpstreamToolUse:false there.
// caseInfo carries the [U1] case; category is threaded through untouched (no stats).
//
// [expstats additive] opts.probes → cliSet + caseId, and triggerSet/readSet gain PARALLEL
// first-occurrence position arrays (triggerEvents/readEvents) so the M7 event timeline has a
// strict ordinal for every event. The existing triggerSet/readSet/permissionEvents fields keep
// their EXACT shape (arrays of strings / {skill,refPath,logicalRef,shared} / {tool,skill,id}) —
// upgrade-depgraph-engine.test.js and all U5 consumers stay green.
//   caseId        — the [U1] case id (union key for case-level stats)
//   triggerEvents — [{ id, skill, round, ordinal }] first Skill call per triggered skill
//   readEvents    — [{ id, skill, refPath, logicalRef, round, ordinal }] first read per logicalRef
//   cliSet        — [{ tool, cmd, round, ordinal }] ALL invocations across every probe
// ordinal = flat toolCall position across the whole run (0-based) — one axis for skill/ref/cli.
//
// [adapter-observability] declared channels merge in HERE (the consumer), per merge order:
// round order → within a round tool facts before declarations → declaredTriggers array
// order → folded attributionSkill LAST (explicit declaration beats the round-level
// attribution field). attributionSkill is folded in ONLY for run.source==='adapter-trace'
// runs, so archived adapter runs (attributionSkill only, no declaredTriggers) keep the
// same coverage semantics as fresh ones without normalization-time fabrication.
// primarySkill/auxiliarySkills are RECOMPUTED over the merged stream (extractTriggers
// stays pure-explicit and is deliberately not the source here).
//   triggerSet/readSet — tool facts + declarations (first-occurrence by merge order;
//                        declared reads only when status==='ok'). Invariant relaxes to
//                        triggerSet ⊇ triggerEvents ids.
//   triggerEvents/readEvents — PURE tool facts: declared events never enter any ordinal
//                        list (a synthesized ordinal would be fabricated precision).
//   declaredEvents — [{ kind:'trigger'|'read', skill, ref?, status?, round }] no ordinal;
//                        carries blocked reads + folded attributionSkill triggers.
//   provenance     — 'adapter-reported' | 'harness-observed' by run.source; computed here
//                        (single fact point — this function already holds the run).
export function collectSessionEvents(run, caseInfo = {}, { profileDir = null, probes = [] } = {}) {
  const adapterReported = run?.source === 'adapter-trace';

  const triggerSet = [];
  const seenTrig = new Set();
  const addTrigger = (s) => { if (s && !seenTrig.has(s)) { seenTrig.add(s); triggerSet.push(s); } };

  const readSet = [];
  const seenRef = new Set();
  const permissionEvents = [];
  const triggerEvents = [];
  const seenTrigEvent = new Set();
  const readEvents = [];
  const declaredEvents = [];

  let ordinal = -1;
  let roundIdx = 0;
  for (const round of run?.rounds ?? []) {
    const rSeq = round.seq ?? (roundIdx + 1);
    for (const tc of round.toolCalls ?? []) {
      ordinal++;
      // first-occurrence position of each triggered skill (R2.4.1 union order preserved elsewhere)
      if (tc.name === 'Skill' && tc.skill) {
        addTrigger(tc.skill);
        if (!seenTrigEvent.has(tc.skill)) {
          seenTrigEvent.add(tc.skill);
          triggerEvents.push({ id: tc.skill, skill: tc.skill, round: rSeq, ordinal });
        }
      }
      if (tc.name === 'Read') {
        const attr = attributeRead(tc, profileDir);
        if (attr && attr.success && !seenRef.has(attr.logicalRef)) {
          seenRef.add(attr.logicalRef);
          readSet.push({ skill: attr.skill, refPath: attr.refPath, logicalRef: attr.logicalRef, shared: attr.shared });
          readEvents.push({ id: attr.logicalRef, skill: attr.skill, refPath: attr.refPath, logicalRef: attr.logicalRef, round: rSeq, ordinal });
        }
      }
      if (classifyToolResult(tc) === 'permission-artifact') {
        permissionEvents.push({ tool: tc.name, skill: tc.skill ?? null, id: tc.id ?? null });
      }
    }
    // declarations merge AFTER this round's tool facts
    for (const t of round.declaredTriggers ?? []) {
      if (!t) continue;
      addTrigger(t);
      declaredEvents.push({ kind: 'trigger', skill: t, round: rSeq });
    }
    if (adapterReported && round.attributionSkill) {
      addTrigger(round.attributionSkill);
      declaredEvents.push({ kind: 'trigger', skill: round.attributionSkill, round: rSeq });
    }
    for (const rr of round.declaredRefReads ?? []) {
      const status = rr?.status === 'blocked' ? 'blocked' : 'ok';
      declaredEvents.push({ kind: 'read', skill: rr?.skill ?? null, ref: rr?.ref ?? null, status, round: rSeq });
      // blocked declared reads carry through declaredEvents only (artifactReads exemption downstream)
      if (status !== 'ok' || typeof rr?.ref !== 'string' || !rr.ref) continue;
      // declared refs live in the <skill>/references/ namespace: the literal path IS the logicalRef
      if (!seenRef.has(rr.ref)) {
        seenRef.add(rr.ref);
        readSet.push({ skill: rr.skill ?? null, refPath: rr.ref, logicalRef: rr.ref, shared: false });
      }
    }
    roundIdx++;
  }

  const cliSet = [];
  for (const probe of probes ?? []) {
    for (const inv of extractInvocations(run, probe)) cliSet.push(inv);
  }

  const category = caseInfo?.category ?? caseInfo?.case?.category ?? null;
  const caseId = caseInfo?.id ?? caseInfo?.case?.id ?? null;
  return {
    sessionId: run?.sessionId ?? run?.id ?? null,
    caseId,
    category,
    primarySkill: triggerSet[0] ?? null,
    auxiliarySkills: triggerSet.slice(1),
    triggerSet,
    triggerEvents,
    readSet,
    readEvents,
    declaredEvents,
    cliSet,
    permissionEvents,
    provenance: adapterReported ? 'adapter-reported' : 'harness-observed',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// [U5] ANALYSIS ENGINE EXTENSION POINT — do NOT implement here in U2.
//
// U5 consumes an ARRAY of the collectSessionEvents(...) records above (one per
// session) and computes, using UPGRADE_CONFIG.depgraph thresholds:
//   • read rate per logical ref  → inline (≥ inlineReadRate) / external (≤ externalReadRate)
//   • co-read matrix over readSet.logicalRef → merge (≥ coReadMerge)
//   • co-trigger graph over triggerSet       → merge-map edge (≥ coTriggerGraph)
//   • inter-category mean pairwise Jaccard over readSet → split (< jaccardSplit),
//     gated by minCategories / minSessionsPerCategory
// Because readSet already deduplicates _shared copies to one logicalRef, U5's co-read
// denominators are correct without any further normalization. Append U5 functions
// below this marker; keep the collectors above unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// R5.6.1: every advice/candidate object carries this fixed disclaimer + its own n.
// Split/merge outputs are always candidates (R5.6.2 governance neutrality) — never
// "adopted", never auto-executed.
const DIST_WARNING = '實驗分布 ≠ 生產分布';

// unordered distinct pairs of an array (combinations, i<j)
function pairs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}

// R5.1: read rate per logical ref = P(ref read | an owning skill of that ref triggered).
// A ref's owning skills = every skill under which it was ever read (a normal ref has
// exactly one; a normalized _shared ref may be consumed by several). The denominator
// conditions on the owning skill having triggered, so the rate is a true conditional
// probability in [0,1]; n = that denominator (effective sessions), null-not-zero.
// advice: ≥ inlineReadRate → inline; ≤ externalReadRate → keep external; strictly
// between → gray-zone section-level split (R5.EB5 boundaries are inclusive on both ends).
export function readRates(sessions, cfg = UPGRADE_CONFIG.depgraph) {
  const owning = new Map(); // logicalRef -> Set<skill>
  const readIn = new Map(); // logicalRef -> Set<sessionIdx>
  sessions.forEach((s, idx) => {
    for (const r of s.readSet ?? []) {
      if (!owning.has(r.logicalRef)) { owning.set(r.logicalRef, new Set()); readIn.set(r.logicalRef, new Set()); }
      owning.get(r.logicalRef).add(r.skill);
      readIn.get(r.logicalRef).add(idx);
    }
  });
  const trigSets = sessions.map((s) => new Set(s.triggerSet ?? []));
  const out = [];
  for (const [ref, skillSet] of owning) {
    const owners = [...skillSet];
    let denom = 0, numer = 0;
    sessions.forEach((s, idx) => {
      if (!owners.some((sk) => trigSets[idx].has(sk))) return; // condition: owning skill triggered
      denom++;
      if (readIn.get(ref).has(idx)) numer++;
    });
    const rate = denom > 0 ? numer / denom : null;
    let advice = null;
    if (rate != null) {
      if (rate >= cfg.inlineReadRate) advice = 'inline';
      else if (rate <= cfg.externalReadRate) advice = 'external';
      else advice = 'gray-zone-section-split';
    }
    out.push({ logicalRef: ref, owningSkills: owners.sort(), rate, n: denom, advice, status: 'candidate', note: DIST_WARNING });
  }
  return out;
}

// R5.2: co-read merge candidates over logicalRef (already _shared-normalized upstream,
// so cross-skill identical copies count as ONE ref — R5.2.2 [TL-M3], not diluted). The
// rate for a pair = (# sessions both read) / (total sessions), so the R5.EB6 golden
// sample lands at 8/10 = 0.80 rather than the split-copy 4/10 = 0.40. Only pairs at or
// above coReadMerge are emitted, each with n = total sessions + evidence session ids.
export function coReadPairs(sessions, cfg = UPGRADE_CONFIG.depgraph) {
  const N = sessions.length;
  const readSets = sessions.map((s) => new Set((s.readSet ?? []).map((r) => r.logicalRef)));
  const allRefs = [...new Set(readSets.flatMap((set) => [...set]))].sort();
  const out = [];
  for (const [a, b] of pairs(allRefs)) {
    const evidence = [];
    sessions.forEach((s, idx) => {
      if (readSets[idx].has(a) && readSets[idx].has(b)) evidence.push(s.sessionId ?? idx);
    });
    const rate = N > 0 ? evidence.length / N : null;
    if (rate != null && rate >= cfg.coReadMerge)
      out.push({ refs: [a, b], rate, n: N, evidenceSessions: evidence, status: 'candidate', note: DIST_WARNING });
  }
  return out;
}

// R5.3.1: co-trigger graph. Nodes carry per-skill trigger rate; an edge exists between
// two skills when their co-trigger rate (both in the same session's triggerSet, over all
// sessions) is at or above coTriggerGraph. n = total sessions on every node/edge.
export function coTriggerGraph(sessions, cfg = UPGRADE_CONFIG.depgraph) {
  const N = sessions.length;
  const trigSets = sessions.map((s) => new Set(s.triggerSet ?? []));
  const skills = [...new Set(trigSets.flatMap((set) => [...set]))].sort();
  const nodes = skills.map((sk) => ({
    skill: sk,
    triggerRate: N > 0 ? trigSets.filter((t) => t.has(sk)).length / N : null,
    n: N,
  }));
  const edges = [];
  for (const [a, b] of pairs(skills)) {
    const both = trigSets.filter((t) => t.has(a) && t.has(b)).length;
    const rate = N > 0 ? both / N : null;
    if (rate != null && rate >= cfg.coTriggerGraph) edges.push({ skills: [a, b], rate, n: N });
  }
  return { nodes, edges, n: N, note: DIST_WARNING };
}

// R5.3.2/R5.3.3: merge-map = connected components of the co-trigger graph, hard-excluded
// skills stripped BEFORE component-finding (so a safety/cold skill never appears in any
// candidate, even at high co-trigger — R5.EB4), minus the break-even filter. Singleton
// components are not merge candidates. Break-even is applied only when the caller supplies
// desc sizes (descBySkill); a component whose merge would not save resident tax
// (residentSavings ≤ 0) is dropped. mergedDescEstOf / pTriggerOf let the caller inject
// the merged-desc estimate and group-trigger probability (both parameterized per R5.5.2).
export function mergeMap(graph, { descBySkill = null, mergedDescEstOf = null, pTriggerOf = null, cfg = UPGRADE_CONFIG.depgraph } = {}) {
  const excluded = new Set(cfg.hardExcludeSkills ?? []);
  const nodeSkills = graph.nodes.map((nd) => nd.skill).filter((sk) => !excluded.has(sk));
  const adj = new Map(nodeSkills.map((sk) => [sk, new Set()]));
  for (const e of graph.edges) {
    const [a, b] = e.skills;
    if (excluded.has(a) || excluded.has(b)) continue; // R5.3.3: edges touching excluded are dropped
    adj.get(a)?.add(b); adj.get(b)?.add(a);
  }
  const seen = new Set();
  const out = [];
  for (const start of nodeSkills) {
    if (seen.has(start)) continue;
    const comp = []; const stack = [start]; seen.add(start);
    while (stack.length) {
      const cur = stack.pop(); comp.push(cur);
      for (const nb of adj.get(cur) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    const members = comp.sort();
    if (members.length < 2) continue; // singletons are not merge candidates
    let be = null;
    if (descBySkill) {
      const sizes = members.map((m) => descBySkill[m] ?? 0);
      const est = mergedDescEstOf ? mergedDescEstOf(members) : Math.max(...sizes);
      const pt = pTriggerOf ? pTriggerOf(members) : null;
      be = breakEven(sizes, est, pt, cfg);
      if (be.residentSavings <= 0) continue; // break-even filter: merge must save resident tax
    }
    out.push({ members, status: 'candidate', breakEven: be, hardExcluded: [...excluded], note: DIST_WARNING });
  }
  return out;
}

// R5.4: inter-category mean pairwise Jaccard split signal, gated (R5.4.2/R5.4.3/R5.4.4).
// Only runs on the full set (smoke → insufficient-data, R5.EB3). Considers sessions where
// `skill` triggered, groups them by case category, and for each category collects the set
// of THIS skill's logicalRefs. Gate: ≥ minCategories categories AND every category with
// ≥ minSessionsPerCategory effective sessions; otherwise insufficient-data with n. A single
// category (R5.EB1/R5.4.4) is too-few-categories → never a false split. When the mean
// pairwise Jaccard across category ref-sets is below jaccardSplit, emit a split candidate
// whose suggested split is each category's own reference set.
export function jaccardSplit(skill, sessions, { full = false } = {}, cfg = UPGRADE_CONFIG.depgraph) {
  const insufficient = (reason, n, categories) => ({
    skill, status: 'insufficient-data', reason, meanJaccard: null, n, categories, suggestedSplit: null, note: DIST_WARNING,
  });
  if (!full) return insufficient('smoke-set', 0, []); // R5.4.3

  const byCat = new Map();
  for (const s of sessions) {
    if (!(s.triggerSet ?? []).includes(skill)) continue;
    const cat = s.category ?? '__uncategorized__';
    if (!byCat.has(cat)) byCat.set(cat, { n: 0, refs: new Set() });
    const g = byCat.get(cat);
    g.n++;
    for (const r of s.readSet ?? [])
      if (r.skill === skill || r.logicalRef.startsWith(skill + '/')) g.refs.add(r.logicalRef);
  }
  const cats = [...byCat.entries()].map(([category, g]) => ({ category, n: g.n, refs: [...g.refs].sort() }));
  const totalN = cats.reduce((a, c) => a + c.n, 0);
  if (cats.length < cfg.minCategories) return insufficient('too-few-categories', totalN, cats);           // R5.4.4/R5.EB1
  if (cats.some((c) => c.n < cfg.minSessionsPerCategory)) return insufficient('too-few-sessions-per-category', totalN, cats); // R5.EB2

  let sum = 0;
  const catPairs = pairs(cats);
  for (const [x, y] of catPairs) {
    const B = new Set(y.refs);
    const inter = x.refs.filter((v) => B.has(v)).length;
    const union = new Set([...x.refs, ...y.refs]).size;
    sum += union === 0 ? 1 : inter / union; // both empty → identical, no split signal
  }
  const meanJaccard = catPairs.length ? sum / catPairs.length : 1;
  const split = meanJaccard < cfg.jaccardSplit;
  return {
    skill,
    status: split ? 'split-candidate' : 'no-split',
    meanJaccard, n: totalN, categories: cats,
    suggestedSplit: split ? cats.map((c) => ({ category: c.category, refs: c.refs })) : null,
    note: DIST_WARNING,
  };
}

// R5.5: break-even. residentSavings = (Σ member desc − merged desc estimate) / breakEvenDivisor;
// dividing by P(group triggers) gives the body-inflation ceiling a merged skill may absorb
// before the merge stops paying off. Every substituted value is echoed back (PM-B4). pTrigger
// is parameterized (R5.5.2) — this run passes the experiment distribution; production telemetry
// plugs into the same slot. pTrigger ≤ 0 (or null) → ceiling undefined (null), not a divide blow-up.
export function breakEven(memberDescs, mergedDescEst, pTrigger, cfg = UPGRADE_CONFIG.depgraph) {
  const sumMemberDesc = memberDescs.reduce((a, b) => a + b, 0);
  const residentSavings = (sumMemberDesc - mergedDescEst) / cfg.breakEvenDivisor;
  const inflationCeiling = (pTrigger != null && pTrigger > 0) ? residentSavings / pTrigger : null;
  return {
    sumMemberDesc, mergedDescEst, breakEvenDivisor: cfg.breakEvenDivisor,
    residentSavings, pTrigger, inflationCeiling, status: 'candidate', note: DIST_WARNING,
  };
}

// U7-facing aggregate. One structured object bundling every U5 signal for the report layer:
//   { n, full, disclaimer, readRates[], coReadPairs[], coTriggerGraph{}, mergeMap[], jaccardSplit[] }
// On the smoke set only co-trigger + read rate are meaningful (R5.4.3), so jaccardSplit is []
// and mergeMap runs without break-even. When descBySkill is supplied, mergeMap applies the
// break-even filter with a group-trigger probability computed from the session events.
export function depgraphReport(sessions, { full = false, descBySkill = null } = {}, cfg = UPGRADE_CONFIG.depgraph) {
  const graph = coTriggerGraph(sessions, cfg);
  const trigSets = sessions.map((s) => new Set(s.triggerSet ?? []));
  const N = sessions.length;
  const pTriggerOf = descBySkill
    ? (members) => (N > 0 ? trigSets.filter((t) => members.some((m) => t.has(m))).length / N : null)
    : null;
  // [adapter-observability §2 F-3-07/F-5-05] provenance mix over the session records'
  // provenance field ('harness-observed' | 'adapter-reported', stamped by
  // collectSessionEvents). A record WITHOUT the field (legacy archives) counts as
  // `unknown` — it is never silently merged into either trust bucket (null-not-zero).
  // Downstream: report governance cards render the「基于 runtime 自报信号
  // （adapter-reported）」badge whenever adapter > 0.
  const provenanceMix = { harness: 0, adapter: 0, unknown: 0 };
  for (const s of sessions) {
    if (s?.provenance === 'harness-observed') provenanceMix.harness++;
    else if (s?.provenance === 'adapter-reported') provenanceMix.adapter++;
    else provenanceMix.unknown++;
  }
  return {
    n: N,
    full,
    provenanceMix,
    disclaimer: DIST_WARNING,
    readRates: readRates(sessions, cfg),
    coReadPairs: coReadPairs(sessions, cfg),
    coTriggerGraph: graph,
    mergeMap: mergeMap(graph, { descBySkill, pTriggerOf, cfg }),
    jaccardSplit: full ? graph.nodes.map((nd) => jaccardSplit(nd.skill, sessions, { full }, cfg)) : [],
  };
}
