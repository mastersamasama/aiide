// U6 static gates — stage-0 pre-flight lints over a skill bundle. GENERIC: nothing here
// is onchainos-specific (U6 constraint). ZERO TOKEN: pure string / md5 checks only, no LLM
// or CLI is ever invoked (R6.6.1 fail-fast must cost nothing). Reads skill descriptors only;
// never writes them (experiment immutability).
//
// ┌─ INPUT MODEL ────────────────────────────────────────────────────────────────┐
// │ A "skill" is a plain descriptor object (so the gates are pure + unit-testable):│
// │   { name, description, triggers: string[], shared: { <path>: <content> } }     │
// │ `shared` maps a logical _shared sub-path (e.g. "util.md") to that skill's copy │
// │ of the fragment's raw content; md5 is computed here. readSkillDir() builds the │
// │ same shape from disk for the CLI without any of the gates touching the FS.     │
// └──────────────────────────────────────────────────────────────────────────────┘
//
// Thresholds come ONLY from the U0 canonical config (descMaxUnicode); re-defining them
// here is forbidden (U0 R0.0.2). Output is a structured object a CLI / the U7 report can
// consume: { errors, warnings, fixedTaxTable, fatal, ok }.

import { createHash } from 'node:crypto';
import { UPGRADE_CONFIG } from './upgradeConfig.js';

const md5 = (s) => createHash('md5').update(String(s)).digest('hex');

// R6.1: description length lint. Counts Unicode CODE POINTS via [...desc].length — NOT
// UTF-8 bytes and NOT UTF-16 code units (R6.1.3), so a 1024-CJK-character desc (~3072
// bytes) passes. The gate is strictly `>` (R6.1.2): 1024 passes, 1025 errors. Returns an
// error object or null.
export function descLint(skill, cfg = UPGRADE_CONFIG.staticGates) {
  const desc = skill?.description ?? '';
  const chars = [...desc].length; // code points, not bytes / not .length code units
  if (chars > cfg.descMaxUnicode)
    return { gate: 'desc-length', level: 'error', skill: skill?.name ?? null, chars, limit: cfg.descMaxUnicode };
  return null;
}

// R6.2: cross-skill trigger-word collision. Deterministic string comparison only (R6.2.2:
// no semantic similarity). A trigger word is normalized by trim + lowercase; any normalized
// word declared by two or more skills is a collision warning listing the word + the skills.
export function triggerCollision(skills) {
  const bySkill = new Map(); // normalized trigger -> Set<skill name>
  for (const s of skills) {
    const seen = new Set();
    for (const t of s.triggers ?? []) {
      const norm = String(t).trim().toLowerCase();
      if (!norm || seen.has(norm)) continue; // dedupe within a skill so a repeat isn't a self-collision
      seen.add(norm);
      if (!bySkill.has(norm)) bySkill.set(norm, new Set());
      bySkill.get(norm).add(s.name);
    }
  }
  const warnings = [];
  for (const [term, owners] of bySkill) {
    if (owners.size >= 2)
      warnings.push({ gate: 'trigger-collision', level: 'warning', term, skills: [...owners].sort() });
  }
  return warnings.sort((a, b) => a.term.localeCompare(b.term));
}

// R6.3: _shared md5 drift. Fragments that different skills each carry should be byte-identical;
// when the md5 of the same logical _shared path differs across skills, the copies have drifted
// out of sync → warning listing the path + each skill's md5. Identical copies → no warning.
export function sharedDrift(skills) {
  const byPath = new Map(); // shared path -> Array<{ skill, md5 }>
  for (const s of skills) {
    const shared = s.shared ?? {};
    for (const [path, content] of Object.entries(shared)) {
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push({ skill: s.name, md5: md5(content) });
    }
  }
  const warnings = [];
  for (const [path, variants] of byPath) {
    const distinct = new Set(variants.map((v) => v.md5));
    if (distinct.size > 1)
      warnings.push({ gate: 'shared-drift', level: 'warning', path, variants: variants.sort((a, b) => a.skill.localeCompare(b.skill)) });
  }
  return warnings.sort((a, b) => a.path.localeCompare(b.path));
}

// R6.4: fixed tax table. Generic per-skill fixed-overhead summary (NO onchainos-specific
// keys): desc code-point count, trigger-word count, _shared reference count, and the fixed
// resident-tax estimate ceil(descChars / 4) tokens. Structured for the U7 report (R6.4.2).
export function taxTable(skills) {
  return skills.map((s) => {
    const descChars = [...(s.description ?? '')].length;
    return {
      skill: s.name,
      descChars,
      triggerCount: (s.triggers ?? []).length,
      sharedRefs: Object.keys(s.shared ?? {}).length,
      descTaxTokens: Math.ceil(descChars / 4), // fixed tax: Σ desc chars / 4
    };
  });
}

// R6.5.1: STATIC declared-version consistency (no CLI call — the runtime `onchainos --version`
// assertion is U0's preflight, R0.2.2). arms = [{ arm, version }]. When the two arms declare
// different versions and it is not an expected difference, emit an error. `expectedDifferent`
// lets an intentional A/B version skew pass.
export function declaredVersionCheck(arms, { expectedDifferent = false } = {}) {
  const versions = [...new Set((arms ?? []).map((a) => a.version))];
  if (versions.length > 1 && !expectedDifferent)
    return { gate: 'declared-version', level: 'error', arms: (arms ?? []).map((a) => ({ arm: a.arm, version: a.version })) };
  return null;
}

// R6.6: aggregate + fail-fast. Runs every static gate, collects errors (desc-length,
// version) and warnings (trigger-collision, shared-drift), and builds the tax table. Any
// error → fatal:true so the pipeline aborts BEFORE collection starts, at zero token
// (R6.6.1). Warnings never abort but ARE carried in the report object (R6.6.2 / R6.EB4:
// an error + a warning together still fail-fast, yet the warning remains in the output).
export function runStaticGates(skills, arms = null, opts = {}) {
  const cfg = opts.cfg ?? UPGRADE_CONFIG.staticGates;
  const errors = [];
  const warnings = [];

  for (const s of skills) {
    const e = descLint(s, cfg);
    if (e) errors.push(e);
  }
  if (arms) {
    const v = declaredVersionCheck(arms, { expectedDifferent: opts.expectedDifferentVersion });
    if (v) errors.push(v);
  }
  warnings.push(...triggerCollision(skills));
  warnings.push(...sharedDrift(skills));

  const fixedTaxTable = taxTable(skills);
  const fatal = errors.length > 0;
  return { errors, warnings, fixedTaxTable, fatal, ok: !fatal };
}
