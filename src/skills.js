// Skill profile aggregation (S14). Shared by the dashboard server (GET /api/skills) and the
// `aiide skill` CLI so the two never drift. Read-only: full scan of BOTH experiments and runs,
// joined by skill name — no persistent index (correct + fast at aiide's local scale). Skill hash
// keys the version timeline. Never writes anything back.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function aggregateSkills(dataDir) {
  const skills = new Map();
  const ensure = (name) => {
    if (!skills.has(name)) skills.set(name, { name, experiments: [], runs: [], firstSeen: new Map() });
    return skills.get(name);
  };

  const expDir = join(dataDir, 'experiments');
  if (existsSync(expDir)) for (const f of readdirSync(expDir)) {
    if (!f.endsWith('.json')) continue;
    let e; try { e = JSON.parse(readFileSync(join(expDir, f), 'utf8')); } catch { continue; }
    const hashByName = new Map((e.environment?.skills ?? []).map(s => [s.name, s.hash ?? null]));
    const listingByName = new Map((e.contextInsights?.skillListing ?? []).map(s => [s.skill, s]));
    const names = new Set([...(e.profile?.skills ?? []), ...listingByName.keys(), ...hashByName.keys()]);
    // per-experiment mean activation over tasks that report it (null activation is ignored, not 0)
    const acts = Object.values(e.tasks ?? {}).map(t => t.activationRate).filter(v => v != null);
    const meanAct = acts.length ? acts.reduce((a, b) => a + b, 0) / acts.length : null;
    for (const name of names) {
      const agg = ensure(name);
      const hash = hashByName.get(name) ?? null;
      const listing = listingByName.get(name);
      agg.experiments.push({
        id: e.id, suiteName: e.suiteName, createdAt: e.createdAt, model: e.model,
        runtime: e.runtime ?? 'claude-code', suiteSha: e.environment?.suite?.sha256 ?? null,
        hash, composite: e.summary?.composite ?? null, degraded: e.summary?.degraded ?? false,
        activationRate: meanAct,
        listingTokensEst: listing?.listingTokensEst ?? null, bodyTokensEst: listing?.bodyTokensEst ?? null,
      });
      if (hash && (!agg.firstSeen.has(hash) || String(e.createdAt) < agg.firstSeen.get(hash)))
        agg.firstSeen.set(hash, e.createdAt);
    }
  }

  const runDir = join(dataDir, 'runs');
  if (existsSync(runDir)) for (const f of readdirSync(runDir)) {
    if (!f.endsWith('.json')) continue;
    let obj; try { obj = JSON.parse(readFileSync(join(runDir, f), 'utf8')); } catch { continue; }
    const { run, metrics } = obj;
    for (const [name, s] of Object.entries(metrics?.perSkill ?? {})) {
      ensure(name).runs.push({
        runId: run.id, rounds: s.rounds ?? 0, tokens: s.tokens ?? { in: 0, out: 0 },
        toolCalls: s.toolCalls ?? 0, toolErrors: s.toolErrors ?? 0,
      });
    }
  }

  return [...skills.values()].map(finalizeSkill).sort((a, b) => a.name.localeCompare(b.name));
}

function finalizeSkill(agg) {
  const exps = agg.experiments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const acts = exps.map(e => e.activationRate).filter(v => v != null);
  const listings = exps.map(e => e.listingTokensEst).filter(v => v != null);
  const bodies = exps.map(e => e.bodyTokensEst).filter(v => v != null);
  const comps = exps.map(e => e.composite).filter(v => v != null);
  const meanAct = avg(acts);
  return {
    name: agg.name,
    experimentCount: exps.length,
    runCount: agg.runs.length,
    versions: [...agg.firstSeen.entries()].map(([hash, firstSeen]) => ({ hash, firstSeen }))
      .sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen))),
    meanActivation: meanAct == null ? null : Math.round(meanAct * 1e3) / 1e3,
    // installed but never triggered: activation was measured everywhere and is always 0 → pure tax
    neverTriggered: acts.length > 0 && acts.every(a => a === 0),
    meanListingTokens: listings.length ? Math.round(avg(listings)) : null,
    meanBodyTokens: bodies.length ? Math.round(avg(bodies)) : null,
    meanComposite: comps.length ? Math.round(avg(comps) * 1e3) / 1e3 : null,
    runTotals: agg.runs.reduce((a, r) => ({
      rounds: a.rounds + r.rounds, inTok: a.inTok + (r.tokens.in ?? 0), outTok: a.outTok + (r.tokens.out ?? 0),
    }), { rounds: 0, inTok: 0, outTok: 0 }),
    experiments: exps,
    runs: agg.runs,
  };
}
