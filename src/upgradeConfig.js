// CANONICAL CONFIG for the upgrade pipeline (U0 T0.0) — single source of truth.
// Pure frozen constants, zero logic. All other upgrade modules import from here;
// re-defining any of these values elsewhere is forbidden (U0 R0.0.2).
// Threshold provenance: docs/onchainos-upgrade-pipeline-design.md §2.2/§2.3/§2.5.

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const UPGRADE_CONFIG = deepFreeze({
  // §2.2 equivalent full-price token folding (input : output : cacheRead : cacheWrite)
  tokenWeights: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },

  verdict: {
    MIN_PAIRS: 8,               // global paired-case floor → below = insufficient-data
    MIN_PAIRS_SKILL: 5,         // per-skill cluster floor (5-7 clusters → CI marked reference-only)
    nonInferiorityDeltaPp: 5,   // δ, non-inferiority margin in percentage points (F2)
    ciLevel: 0.95,
    bootstrapIters: 10000,
    bootstrapSeed: 0x9E3779B9,  // fixed seed → reproducible (PRNG: splitmix32, TL-m3)
    fdr: 'benjamini-hochberg',  // multiple-comparison correction for per-skill badges
  },

  exclusion: { tripwirePct: 12 },        // whole-case exclusion rate > 12% → verdict forced inconclusive (F1)
  flowIncomplete: { ciMethod: 'wilson' },

  concurrency: { min: 4, max: 8, default: 6 },

  dataset: {                    // consumed by U1 lints
    smokeTierMin: 20,
    smokeTierMax: 30,           // smoke tier size band (PM-B7)
    minMultiIntentPct: 0.15,    // multi-intent case share floor (PM-B5)
  },

  depgraph: {                   // consumed by U5
    inlineReadRate: 0.60,       // read rate ≥ 0.60 → suggest inline
    externalReadRate: 0.20,     // read rate ≤ 0.20 → keep external
    coReadMerge: 0.80,          // co-read rate ≥ 0.80 → suggest merging files
    coTriggerGraph: 0.50,       // co-trigger edge threshold for merge-map candidates (design §2.3)
    jaccardSplit: 0.30,         // inter-category mean pairwise Jaccard < 0.30 → split candidate
    minCategories: 2,           // split-signal statistical gate
    minSessionsPerCategory: 5,  // split-signal statistical gate
    breakEvenDivisor: 4,        // chars-per-token divisor for resident-tax savings
    hardExcludeSkills: [],      // safety/cold-trigger skills never merged (onchainos ROUTE-04)
  },

  probes: {                     // consumed by expstats M3-M5 (design §2.1; general tool-call probes)
    minSequenceCases: 3,        // M5 n-gram support floor in DISTINCT cases (repeats can't inflate)
    ngramMaxLen: 3,             // M5 max adjacent n-gram length
    minSessionsForCoverage: 5,  // M4 per-skill run floor → below = insufficient-data badge
    blockExclusionTripwirePct: 12, // per-block exclusion rate > 12% → probe block inconclusive (F1)
  },

  proximity: {                  // consumed by expstats M7 (design §2.1)
    windowOrdinals: 6,          // pair only events within this many toolCall positions
    decay: '1/(1+gap)',         // decay FORM disclosed here; fixed, not a pluggable implementation
    minPairCases: 3,            // lift emitted only at/above this distinct-case support
  },

  staticGates: { descMaxUnicode: 1024 },  // consumed by U6
});
