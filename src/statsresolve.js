// Shared experiment-stats resolver (design §A1) — the ONE authority decision used by the server
// (list + detail) and the report layer, so "the list says none but the detail has some" is
// structurally impossible. READ-ONLY: it only ever reads the sidecar `aiide stats --write` wrote
// (<dataDir>/stats/<expId>.json, see bin/aiide.js emitStats); it never writes anything.
//
// Decision table (A1, every cell golden-sampled in test/statsresolve.test.js):
//   embedded valid                      → statsAuthority 'embedded'; a coexisting sidecar is
//                                         DELIBERATELY ignored for the AUTHORITATIVE numbers
//                                         (embedded is the sealed authority; --force recompute
//                                         sidecars are CLI diagnostics only) — flagged
//                                         sidecarIgnored:true so the UI can say so.
//   embedded valid + STALE schema (taxonomy §3.0, r3 F-3-05): embedded schemaVersion < the
//   sidecar's, sidecar wrapper authority === 'non-authoritative-recompute'
//                                       → `stats`/`statsAuthority` COMPLETELY unchanged (embedded
//                                         bytes stay authoritative), PLUS an independent top-level
//                                         `supplemental: { sections, authority:
//                                         'non-authoritative-recompute', schemaVersionFrom,
//                                         schemaVersionTo }` carrying ONLY the closed-set section
//                                         keys introduced ABOVE the embedded version (SCHEMA_SECTIONS
//                                         map; a missing embedded schemaVersion field ≡ 1, matching
//                                         obs.js). The sidecar's recompute of sections the embedded
//                                         version already has (skillCoverage/refCoverage/probes/
//                                         proximity…) NEVER leaks. sidecarIgnored narrows to "the
//                                         authoritative numbers did not adopt the sidecar" — it
//                                         coexists with supplemental. An 'authoritative-embedded'
//                                         sidecar (byte copy) never feeds supplemental.
//   embedded error/absent + valid wrapper whose authority ∈ SIDECAR_AUTHORITIES
//                                       → wrapper.stats, statsAuthority = wrapper.authority,
//                                         wrapper warnings passed through verbatim.
//   sidecar corrupt / unknown authority → stats null + warning (annotations R8.3 degrade
//                                         discipline: corrupt sidecar never becomes a 500 or a
//                                         silently-wrong number).
//   neither                             → stats null, statsAuthority null; an embedded
//                                         {error} additionally surfaces as statsError.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// closed set — a wrapper with any other authority string is treated as corrupt, never trusted.
export const SIDECAR_AUTHORITIES = Object.freeze([
  'authoritative-embedded', 'non-authoritative-recompute', 'recomputed-no-embedded',
]);

// schemaVersion → TOP-LEVEL section keys that version introduced (taxonomy §3.0 closed-set map,
// verbatim enumeration per r5 F-5-04). supplemental only ever carries keys from versions strictly
// ABOVE the embedded version. v2 introduced NO new top-level sections — caseJoin / bySkill[].refs
// are IN-SECTION shape upgrades and never ride supplemental (r4 F-4-02: a v1 experiment's v2-level
// features need a rerun; we say so instead of leaking a recompute of sections v1 already has).
export const SCHEMA_SECTIONS = Object.freeze({
  2: Object.freeze([]),
  3: Object.freeze([
    'contextComposition', 'toolUsage', 'truncation', 'fileTargets',
    'cacheHitRate', 'selfReport', 'sidechainShare', 'statsHealth',
  ]),
});

// same location cmdStats --write uses (bin/aiide.js emitStats): <dataDir>/stats/<id>.json
export function statsSidecarPath(dataDir, expId) {
  return join(dataDir, 'stats', `${expId}.json`);
}

export function resolveExpStats(exp, dataDir) {
  const hasEmbedded = Boolean(exp?.stats && typeof exp.stats === 'object' && !exp.stats.error);
  const sidecarPath = exp?.id != null ? statsSidecarPath(dataDir, exp.id) : null;
  const sidecarExists = sidecarPath != null && existsSync(sidecarPath);

  if (hasEmbedded) {
    const out = { stats: exp.stats, statsAuthority: 'embedded', warnings: [] };
    if (sidecarExists) {
      out.sidecarIgnored = true; // narrowed semantics: the AUTHORITATIVE numbers ignore the sidecar
      const supplemental = resolveSupplemental(exp.stats, sidecarPath);
      if (supplemental) out.supplemental = supplemental; // …but new-schema sections ride alongside
    }
    return out;
  }

  // embedded is error/absent from here on; a seal-time failure string rides along as statsError
  const statsError = exp?.stats?.error != null ? String(exp.stats.error) : null;
  const withError = (out) => (statsError != null ? { ...out, statsError } : out);

  if (sidecarExists) {
    let wrapper = null;
    try { wrapper = JSON.parse(readFileSync(sidecarPath, 'utf8')); } catch { /* corrupt JSON */ }
    const valid = wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)
      && wrapper.stats && typeof wrapper.stats === 'object' && !Array.isArray(wrapper.stats)
      && !wrapper.stats.error
      && SIDECAR_AUTHORITIES.includes(wrapper.authority);
    if (valid) {
      return withError({
        stats: wrapper.stats,
        statsAuthority: wrapper.authority,
        warnings: Array.isArray(wrapper.warnings) ? wrapper.warnings : [],
      });
    }
    return withError({
      stats: null, statsAuthority: null,
      warnings: ['stats sidecar corrupt or unrecognized — ignored (regenerate with `aiide stats <id> --write`)'],
    });
  }

  return withError({ stats: null, statsAuthority: null, warnings: [] });
}

// A1 stale-schema cell (taxonomy §3.0): embedded stays byte-authoritative; a coexisting
// 'non-authoritative-recompute' sidecar whose stats.schemaVersion is HIGHER than the embedded's
// supplies ONLY the SCHEMA_SECTIONS keys above the embedded version, as an independent channel.
// Anything not matching (corrupt JSON, 'authoritative-embedded' byte copies, same/lower version,
// error stats) yields NO supplemental — and never a warning either: the embedded row's contract
// (warnings []) is sealed by golden samples and an ignored sidecar's noise must not leak into it.
function resolveSupplemental(embeddedStats, sidecarPath) {
  // missing schemaVersion field ≡ 1 (obs.js no-schemaVersion→v1 convention, r5 F-5-03)
  const embVer = Number.isFinite(embeddedStats.schemaVersion) ? embeddedStats.schemaVersion : 1;
  let wrapper = null;
  try { wrapper = JSON.parse(readFileSync(sidecarPath, 'utf8')); } catch { return null; }
  const usable = wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)
    && wrapper.authority === 'non-authoritative-recompute' // ONLY this authority feeds supplemental
    && wrapper.stats && typeof wrapper.stats === 'object' && !Array.isArray(wrapper.stats)
    && !wrapper.stats.error
    && Number.isFinite(wrapper.stats.schemaVersion) && wrapper.stats.schemaVersion > embVer;
  if (!usable) return null;
  const sideVer = wrapper.stats.schemaVersion;
  const sections = {};
  for (const [verStr, keys] of Object.entries(SCHEMA_SECTIONS)) {
    const ver = Number(verStr);
    if (!(ver > embVer && ver <= sideVer)) continue; // only versions the embedded LACKS
    for (const key of keys) {
      if (Object.hasOwn(wrapper.stats, key)) sections[key] = wrapper.stats[key]; // null sections ride as null (null-not-zero)
    }
  }
  if (!Object.keys(sections).length) return null; // nothing new to supply → no vacuous supplemental
  return {
    sections,
    authority: 'non-authoritative-recompute',
    schemaVersionFrom: embVer,
    schemaVersionTo: sideVer,
  };
}
