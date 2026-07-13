// Run/Round/Skill metrics + USD cost estimate (R2). All costs are ESTIMATES.
// Pricing is a configurable adapter: built-in defaults below are just a starting point —
// provider prices drift, and runtimes may use non-Claude LLMs (GPT, DeepSeek, ...).
// Override/extend via <data-dir>/pricing.json (see loadPricing).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contextLimitFor } from './parser.js';

// USD per million tokens; matched by case-insensitive substring on model id, first hit wins.
export const DEFAULT_PRICING = {
  models: [
    { match: 'opus',     in: 15,   out: 75,  cacheW: 18.75, cacheR: 1.5 },
    { match: 'sonnet',   in: 3,    out: 15,  cacheW: 3.75,  cacheR: 0.3 },
    { match: 'haiku',    in: 1,    out: 5,   cacheW: 1.25,  cacheR: 0.1 },
    { match: 'gpt',      in: 2.5,  out: 10,  cacheW: 0,     cacheR: 1.25 },
    { match: 'deepseek', in: 0.27, out: 1.1, cacheW: 0,     cacheR: 0.07 },
  ],
  // used when no model entry matches; kept explicit so "unmatched" is visible in output
  fallback: { match: null, in: 3, out: 15, cacheW: 3.75, cacheR: 0.3 },
};

/** Merge <data-dir>/pricing.json over defaults. Custom entries win (prepended). */
export function loadPricing(dataDir) {
  let custom = null;
  try { custom = JSON.parse(readFileSync(join(dataDir, 'pricing.json'), 'utf8')); } catch { /* optional file */ }
  if (!custom) return DEFAULT_PRICING;
  return {
    models: [...(custom.models ?? []), ...DEFAULT_PRICING.models],
    fallback: custom.fallback ?? DEFAULT_PRICING.fallback,
  };
}

export function priceFor(model = '', pricing = DEFAULT_PRICING) {
  const m = String(model).toLowerCase();
  const hit = pricing.models.find(p => p.match && m.includes(String(p.match).toLowerCase()));
  return hit ? { ...hit, matched: true } : { ...pricing.fallback, matched: false };
}

export function computeRunMetrics(run, { pricing = DEFAULT_PRICING } = {}) {
  const allRounds = [...run.rounds, ...run.sidechains.flatMap(s => s.rounds)];
  const totals = {
    rounds: run.rounds.length,
    sidechainRounds: allRounds.length - run.rounds.length,
    // trace-built runs (adapters) carry no wall timestamps — fall back to per-round durations
    durationMs: (run.startedAt && run.endedAt)
      ? Math.max(0, new Date(run.endedAt) - new Date(run.startedAt))
      : allRounds.reduce((a, r) => a + (r.durationMs || 0), 0),
    tokens: { in: 0, out: 0, cacheW: 0, cacheR: 0 },
    toolCalls: 0, toolErrors: 0,
    costUsd: 0, costIsEstimate: true, pricingMatched: true,
  };
  for (const r of allRounds) {
    // usage:null = "not reported" (adapter rounds without a usage field): skip ONLY the
    // token/cost accumulation — toolCalls/toolErrors/durationMs are real events and still count
    if (r.usage != null) {
      totals.tokens.in += r.usage.in;
      totals.tokens.out += r.usage.out;
      totals.tokens.cacheW += r.usage.cacheW;
      totals.tokens.cacheR += r.usage.cacheR;
      const p = priceFor(r.model ?? run.model, pricing);
      if (!p.matched) totals.pricingMatched = false;
      totals.costUsd += (r.usage.in * p.in + r.usage.out * p.out + r.usage.cacheW * p.cacheW + r.usage.cacheR * p.cacheR) / 1e6;
    }
    totals.toolCalls += r.toolCalls.length;
    totals.toolErrors += r.toolCalls.filter(t => t.isError).length;
  }
  totals.costUsd = round4(totals.costUsd);

  const perSkill = {};
  for (const r of allRounds) {
    const keys = new Set();
    if (r.attributionSkill) keys.add(r.attributionSkill);
    for (const t of r.toolCalls) if (t.skill) keys.add(t.skill);
    for (const key of keys) {
      const s = (perSkill[key] ??= { rounds: 0, tokens: { in: 0, out: 0, cacheW: 0, cacheR: 0 }, durationMs: 0, toolCalls: 0, toolErrors: 0 });
      s.rounds++;
      if (r.usage != null) {
        s.tokens.in += r.usage.in; s.tokens.out += r.usage.out;
        s.tokens.cacheW += r.usage.cacheW; s.tokens.cacheR += r.usage.cacheR;
      }
      s.durationMs += r.durationMs;
      s.toolCalls += r.toolCalls.length;
      s.toolErrors += r.toolCalls.filter(t => t.isError).length;
    }
  }

  // null footprints stay null in the series; peakContext with NO non-null footprint
  // (incl. a zero-round run) is null — Math.max(0, …) would forge "peak of 0 tokens"
  const contextSeries = run.rounds.map(r => ({ seq: r.seq, footprint: r.contextFootprint }));
  const footprints = contextSeries.map(c => c.footprint).filter(f => f != null);
  const peakContext = footprints.length ? Math.max(...footprints) : null;
  const contextLimit = contextLimitFor(run.model);

  return { totals, perSkill, contextSeries, peakContext, contextLimit, contextIsEstimate: true };
}

function round4(x) { return Math.round(x * 1e4) / 1e4; }

// ---- U4 equivalent full-price token folding (R4.1.1) ------------------------------------------
// Fold a usage record {in,out,cacheR,cacheW} into ONE equivalent full-price token count using the
// canonical tokenWeights (input:output:cacheRead:cacheWrite). This is the single continuous cost
// magnitude the paired bootstrap operates on — cache reads are cheap, output is dear, so a raw token
// sum would misweight arms that shift the input/output/cache mix. Accepts both the parser's
// {cacheR,cacheW} field names and the config's {cacheRead,cacheWrite} spelling.
export function equivTokens(usage = {}, weights) {
  const u = usage ?? {}; // null usage (adapter round without a usage field) folds to 0, not a throw
  const w = weights ?? { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  const tin = u.in ?? u.input ?? 0;
  const tout = u.out ?? u.output ?? 0;
  const cr = u.cacheR ?? u.cacheRead ?? 0;
  const cw = u.cacheW ?? u.cacheWrite ?? 0;
  return tin * w.input + tout * w.output + cr * w.cacheRead + cw * w.cacheWrite;
}
