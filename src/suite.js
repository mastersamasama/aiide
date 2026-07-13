// Suite loading + `lab init` scaffold. Zero-dep. The loader is JSONC-tolerant so a hand-annotated
// suite (or the scaffold below) can carry real comments yet stay directly runnable.
//
// This module also owns the U1 upgrade-eval *dataset* (a suite carrying `cases[]`): case schema
// validation, per-case canonical sha256, version-lineage/superset lints, and the coverage /
// multi-intent / smoke-tier lints. All statistical thresholds are read from the U0 CANONICAL
// CONFIG (src/upgradeConfig.js) — this module never re-defines them.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { UPGRADE_CONFIG } from './upgradeConfig.js';

/** Strip //-line and /* *\/-block comments, string-aware (never touches // inside a JSON string). */
export function parseJsonc(text) {
  let out = '', i = 0, inStr = false, esc = false;
  const s = String(text);
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out);
}

/** Strict JSON first (zero risk for existing suites); only fall back to comment-stripping on failure. */
export function loadSuite(path) {
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = parseJsonc(raw); }
  // Upgrade-eval dataset? validate the `cases[]` schema up front (R1.1.4: no run may start on a
  // malformed case). A classic task-suite (has `tasks`, no `cases`) passes through untouched. The
  // extension validator additionally checks the grader/judge/responder/gate fields (subsystems 1-3).
  return validateSuiteExtensions(validateSuiteCases(parsed));
}

/**
 * Validate the optional grader/judge/responder/gate extension fields (subsystems 1-3). All are
 * optional — a classic suite has none and passes untouched. Only shape is checked here (fail-fast on
 * an obviously-wrong config); runtime semantics live in lab.js/score.js.
 */
export function validateSuiteExtensions(suite) {
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) return suite;
  const bad = (m) => { const e = new Error(`suite: ${m}`); e.code = 'invalid-suite'; throw e; };
  if ('vars' in suite && (typeof suite.vars !== 'object' || Array.isArray(suite.vars) || suite.vars === null))
    bad('`vars` must be an object of string values');
  if ('writeOps' in suite && !(Array.isArray(suite.writeOps) && suite.writeOps.every(s => typeof s === 'string')))
    bad('`writeOps` must be an array of strings');
  if ('grading' in suite) {
    const a = suite.grading?.authority;
    if (a != null && a !== 'deterministic' && a !== 'judged') bad('`grading.authority` must be "deterministic" or "judged"');
  }
  if ('responder' in suite) {
    const s = suite.responder?.strategy;
    if (s != null && !['scripted', 'policy', 'judge'].includes(s)) bad('`responder.strategy` must be scripted|policy|judge');
  }
  if ('judge' in suite && (typeof suite.judge !== 'object' || Array.isArray(suite.judge))) bad('`judge` must be an object');
  const strat = suite.responder?.strategy ?? 'policy';
  for (const t of suite.tasks ?? []) {
    const mc = t.mustConfirm ?? t.must_confirm_before;
    if (mc != null) {
      if (typeof mc !== 'object' || Array.isArray(mc)) bad(`task ${t.id}: mustConfirm must be an object`);
      const hasCmds = Array.isArray(mc.cmds) && mc.cmds.length > 0;
      const hasTools = Array.isArray(mc.tools) && mc.tools.length > 0;
      if (!hasCmds && !hasTools) bad(`task ${t.id}: mustConfirm needs a non-empty cmds[] or tools[]`);
      if (strat === 'scripted' && t.scriptedReply == null && suite.responder?.scriptedReply == null)
        bad(`task ${t.id}: responder.strategy='scripted' requires task.scriptedReply (or suite.responder.scriptedReply)`);
    }
    for (const v of t.verifiers ?? []) {
      if (v?.type === 'judge' && (typeof v.criterion !== 'string' || !v.criterion.trim()))
        bad(`task ${t.id}: a judge verifier needs a non-empty "criterion"`);
    }
  }
  return suite;
}

/** Annotated, zero-setup runnable skeleton (JSONC). Reflects the frozen Wave 1 schema. */
export function scaffoldSuite() {
  return `{
  // aiide skill lab suite — full schema + CLI reference: docs/aiide-skill.md
  "name": "my-suite",
  "model": "sonnet",              // single model; or pass --models sonnet,opus to compare
  "repeats": 5,                   // ≥3 (MIN_REPEATS) for a trustworthy Wilson CI over valid samples
  "maxTurns": 30,
  "timeoutMs": 300000,

  // env-noise (HTTP 429/529, ECONNREFUSED, auth-expiry incl. onchainos 53017) → backoff retry;
  // if it persists the repeat is EXCLUDED from the denominator (never a fake C=0). timeout stays C=0.
  "retry": { "maxRetries": 2, "baseDelayMs": 1000 },

  // isolated lab: ONLY these skill dirs load (no user/project skills leak in). Add yours here.
  "skills": { "dirs": [] },       // e.g. ["./skills/okx-dex-market"]
  "targetSkills": [],             // e.g. ["okx-dex-market"] — activation feeds the P/R dimensions

  "tasks": [
    {
      "id": "single-step-example",
      "prompt": "Ask the agent something with a checkable answer.",
      "verifiers": [
        { "type": "regex", "pattern": "ETH" },                       // answer must match /ETH/i
        { "type": "numeric_range", "min": 100, "max": 100000 },      // a number in [min,max]
        { "type": "json_field", "path": "data.price" },              // answer is JSON with this path
        // filesystem verifier — resolves against the repeat's workspace (cwd):
        { "type": "file_exists", "path": "out/result.json", "schema": { "required": ["price"] } }
      ]
    },
    {
      "id": "multi-step-example",
      "minReward": 1,             // proceed to the next step only when this fraction of verifiers pass
      "steps": [
        { "prompt": "Step 1: fetch data and write out/data.json", "verifiers": [ { "type": "file_exists", "path": "out/data.json" } ] },
        { "prompt": "Step 2: use out/data.json to answer",        "verifiers": [ { "type": "regex", "pattern": "done" } ] }
      ]
    }
  ],

  "passK": [1, 3]                 // diagnostic pass@k (never enters the composite score)

  // ── External product instead of Claude Code? add a runtime block (see docs/adapters.md) ──
  // "runtime": {
  //   "type": "command",
  //   "cmd": "node", "args": ["{{SUITE_DIR}}/driver.mjs", "{{PROMPT}}"],
  //   "service": {                                    // aiide owns the service lifecycle per model
  //     "cmd": "bun", "args": ["server/server.ts"], "cwd": "../my-product",
  //     "env": { "AI_MODEL": "{{MODEL}}", "PORT": "3901" },
  //     "readyUrl": "http://127.0.0.1:3901/health",   // BYOK keys via env / <data-dir>/service.env
  //     "requiredEnv": ["ANTHROPIC_API_KEY"]
  //   }
  // }
}
`;
}

// ============================================================================================
// U1 · upgrade-eval dataset: case schema, per-case canonical sha256, lineage + coverage lints.
// Design authority: docs/onchainos-upgrade-pipeline-design.md §1 / §2.2. CONFIG: src/upgradeConfig.js.
// ============================================================================================

// [TL-M4] Per-field canonical-sha whitelist (R1.2.1). EVERY schema field MUST appear here with an
// explicit include|exclude. A case carrying a field absent from this table is a lint error
// (R1.2.2 / R1.EB5) — this forces authors to consciously decide whether a new field is part of the
// graded question (moves the sha) or metadata (does not). This same table doubles as the schema
// whitelist for validation: no unknown top-level fields may ride along silently.
//   include → scoring semantics: changing the value changes the graded question, sha MUST move.
//   exclude → identity / lineage / governance / display: sha MUST NOT move.
export const CASE_FIELD_CLASSIFICATION = Object.freeze({
  prompt: 'include',              // 判分語義（改字即改題）
  expected_skill: 'include',      // L1 路由判準
  allowed_auxiliary: 'include',   // L1 false_positive 判準
  assertions: 'include',          // L2 verifier 判準
  multi_intent: 'include',        // 判分語義
  safety_negative: 'include',     // L3 安全判準
  must_confirm_before: 'include', // L3 危險操作定義 [TL-B2]
  scripted_reply: 'include',      // 續跑流內容影響三軸
  category: 'include',            // 驅動 U5/U4/U2 — 改了必須斷譜系
  id: 'exclude',                  // 身份鍵本身（改 id = 發新 case）
  added_in: 'exclude',            // 譜系元資料
  superseded_by: 'exclude',       // 譜系元資料（標譜系不得改 sha）
  held_out: 'exclude',            // 純治理旗標；移進移出是合法操作
  note: 'exclude',                // display-only
  tags: 'exclude',                // display-only
  // [self-decided, recorded in tasks rollup] `tier` (smoke|full) is not in the R1.2.1 table but is
  // required by R1.5.1 ("case 可標所屬層級"). Classified `exclude` by the same rationale as held_out:
  // an organizational layer marker whose reassignment is a governance op, not a content edit.
  tier: 'exclude',
});

/** Deterministic serialization for the per-case sha: object keys sorted; array order preserved
 *  (order is semantic for tools[]/allowed_auxiliary[]/…); undefined members dropped. */
export function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v) ?? 'null').join(',') + ']';
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const s = canonicalJson(value[key]);
    if (s !== undefined) parts.push(JSON.stringify(key) + ':' + s);
  }
  return '{' + parts.join(',') + '}';
}

/** caseSha256 = sha256(canonical-JSON(whitelist-`include` fields)). An unclassified field is fatal
 *  (R1.2.2 / R1.EB5) — the sha cannot be computed deterministically without a classification. */
export function caseSha256(caseObj) {
  const picked = {};
  for (const key of Object.keys(caseObj)) {
    const cls = CASE_FIELD_CLASSIFICATION[key];
    if (!cls) {
      const e = new Error(`case ${caseObj.id ?? '<no-id>'}: unclassified field "${key}" — add it to `
        + `CASE_FIELD_CLASSIFICATION as include|exclude (R1.2.2)`);
      e.code = 'unclassified-field';
      throw e;
    }
    if (cls === 'include' && caseObj[key] !== undefined) picked[key] = caseObj[key];
  }
  return createHash('sha256').update(canonicalJson(picked)).digest('hex');
}

function failCase(caseId, msg, code) {
  const e = new Error(`case ${caseId ?? '<no-id>'}: ${msg}`);
  e.code = code || 'invalid-case';
  throw e;
}

const REQUIRED_STRINGS = ['id', 'prompt', 'expected_skill', 'category', 'added_in'];

/** Validate one case against R1.1 schema; throws with `case <id>: <field>…` on any violation. */
export function validateCase(caseObj, index) {
  if (caseObj === null || typeof caseObj !== 'object' || Array.isArray(caseObj)) {
    const e = new Error(`case at index ${index}: not an object`);
    e.code = 'invalid-case';
    throw e;
  }
  const id = caseObj.id;
  for (const f of REQUIRED_STRINGS) {
    if (typeof caseObj[f] !== 'string' || caseObj[f] === '')
      failCase(id, `missing/invalid "${f}" (expected non-empty string)`, 'missing-field');
  }
  const isStrArray = v => Array.isArray(v) && v.every(s => typeof s === 'string');
  if (!isStrArray(caseObj.allowed_auxiliary))
    failCase(id, `"allowed_auxiliary" must be an array of strings (empty allowed)`, 'invalid-field');
  if (!isStrArray(caseObj.multi_intent))
    failCase(id, `"multi_intent" must be an array of strings (empty allowed)`, 'invalid-field');
  if (!Array.isArray(caseObj.assertions))
    failCase(id, `"assertions" must be an array`, 'invalid-field');
  if (typeof caseObj.safety_negative !== 'boolean')
    failCase(id, `"safety_negative" must be a boolean`, 'invalid-field');
  if ('held_out' in caseObj && typeof caseObj.held_out !== 'boolean')
    failCase(id, `"held_out" must be a boolean`, 'invalid-field');
  if ('superseded_by' in caseObj && typeof caseObj.superseded_by !== 'string')
    failCase(id, `"superseded_by" must be a string (a case id)`, 'invalid-field');
  if ('note' in caseObj && typeof caseObj.note !== 'string')
    failCase(id, `"note" must be a string`, 'invalid-field');
  if ('tags' in caseObj && !isStrArray(caseObj.tags))
    failCase(id, `"tags" must be an array of strings`, 'invalid-field');
  if ('tier' in caseObj && caseObj.tier !== 'smoke' && caseObj.tier !== 'full')
    failCase(id, `"tier" must be "smoke" or "full"`, 'invalid-field');
  if ('scripted_reply' in caseObj && typeof caseObj.scripted_reply !== 'string')
    failCase(id, `"scripted_reply" must be a string`, 'invalid-field');
  // [TL-B2] must_confirm_before = {tools:[string], pathPattern?, note?}
  if ('must_confirm_before' in caseObj) {
    const m = caseObj.must_confirm_before;
    if (m === null || typeof m !== 'object' || Array.isArray(m))
      failCase(id, `"must_confirm_before" must be an object {tools:[string], pathPattern?, note?}`, 'invalid-field');
    if (!Array.isArray(m.tools) || m.tools.length === 0 || !m.tools.every(s => typeof s === 'string'))
      failCase(id, `"must_confirm_before.tools" must be a non-empty array of strings`, 'invalid-field');
    if ('pathPattern' in m && typeof m.pathPattern !== 'string')
      failCase(id, `"must_confirm_before.pathPattern" must be a string`, 'invalid-field');
    if ('note' in m && typeof m.note !== 'string')
      failCase(id, `"must_confirm_before.note" must be a string`, 'invalid-field');
    // R1.1.2: a dangerous-op gate is meaningless without a scripted turn to resume the halted run.
    if (typeof caseObj.scripted_reply !== 'string' || caseObj.scripted_reply === '')
      failCase(id, `"must_confirm_before" requires a non-empty "scripted_reply" (asked-and-halted needs `
        + `a scripted turn to resume) [R1.1.2]`, 'missing-scripted-reply');
  }
  // Unknown top-level field guard — same whitelist that classifies the sha (R1.2.2 / R1.EB5).
  for (const key of Object.keys(caseObj)) {
    if (!CASE_FIELD_CLASSIFICATION[key])
      failCase(id, `unclassified field "${key}" — add it to CASE_FIELD_CLASSIFICATION as `
        + `include|exclude (R1.2.2)`, 'unclassified-field');
  }
  return caseObj;
}

/** If `suite.cases[]` is present, validate every case and reject duplicate ids (R1.4.2). Returns the
 *  suite unchanged. A suite without `cases` (a classic task-suite) is returned as-is. */
export function validateSuiteCases(suite) {
  if (!suite || !Array.isArray(suite.cases)) return suite;
  const seen = new Map();
  suite.cases.forEach((c, i) => {
    validateCase(c, i);
    if (seen.has(c.id)) failCase(c.id, `duplicate case id (also at index ${seen.get(c.id)}) [R1.4.2]`, 'duplicate-id');
    seen.set(c.id, i);
  });
  return suite;
}

// ---- lints -----------------------------------------------------------------------------------
// Every lint returns a flat array of findings `{ level:'error'|'warning', code, message, …meta }`.
// Lints only READ; they never rewrite a suite (治理中立).

const casesOf = suite => (suite && Array.isArray(suite.cases)) ? suite.cases : (Array.isArray(suite) ? suite : []);

/** R1.4.2 — duplicate case id → error. */
export function dedupeCheck(suite) {
  const seen = new Map(), findings = [];
  casesOf(suite).forEach((c, i) => {
    if (seen.has(c.id))
      findings.push({ level: 'error', code: 'duplicate-id', id: c.id,
        message: `duplicate case id "${c.id}" (indices ${seen.get(c.id)} and ${i}) [R1.4.2]` });
    else seen.set(c.id, i);
  });
  return findings;
}

/** R1.EB2 — superseded_by pointing at a non-existent id → error (dangling lineage). */
export function lintDanglingSuperseded(suite) {
  const ids = new Set(casesOf(suite).map(c => c.id));
  const findings = [];
  for (const c of casesOf(suite)) {
    if (typeof c.superseded_by === 'string' && !ids.has(c.superseded_by))
      findings.push({ level: 'error', code: 'dangling-superseded', id: c.id, target: c.superseded_by,
        message: `case "${c.id}" superseded_by "${c.superseded_by}" which does not exist [R1.EB2]` });
  }
  return findings;
}

/**
 * R1.3 — version lineage / superset lint. `newSuite` must be a superset of `oldSuite`:
 *  - R1.3.1/R1.EB3: every old id must survive (removal → error).
 *  - R1.3.2: a shared id whose caseSha256 changed → error (content edited in place is illegal;
 *    the one legal path is superseded_by, which leaves the old case — and its sha — untouched, so
 *    the legal-supersede case naturally passes both checks; R1.3.3).
 *  - R1.EB2: dangling superseded_by inside newSuite → error.
 * Returns `{ ok, findings }`.
 */
export function lintLineage(oldSuite, newSuite) {
  const findings = [];
  const oldCases = new Map(casesOf(oldSuite).map(c => [c.id, c]));
  const newCases = new Map(casesOf(newSuite).map(c => [c.id, c]));
  for (const oldId of oldCases.keys()) {
    if (!newCases.has(oldId))
      findings.push({ level: 'error', code: 'not-superset', id: oldId,
        message: `case "${oldId}" removed in new version — dataset is append-only (只增不改); `
          + `retire via superseded_by instead [R1.3.1/R1.EB3]` });
  }
  for (const [id, oldCase] of oldCases) {
    const newCase = newCases.get(id);
    if (!newCase) continue;
    const oldSha = caseSha256(oldCase), newSha = caseSha256(newCase);
    if (oldSha !== newSha)
      findings.push({ level: 'error', code: 'content-changed', id, oldSha, newSha,
        message: `case ${id} content changed (${oldSha.slice(0, 8)}→${newSha.slice(0, 8)}) — `
          + `修 case 唯一合法路徑是 superseded_by [R1.3.2]` });
  }
  findings.push(...lintDanglingSuperseded(newSuite));
  return { ok: findings.every(f => f.level !== 'error'), findings };
}

/** R1.4.1 — pairing key across arms/versions is the case-id INTERSECTION (dataset sha need not be
 *  equal). Accepts suites, arrays of cases, or arrays of ids. Returns the shared ids, sorted. */
export function pairByIdIntersection(armA, armB) {
  const idsOf = x => {
    const arr = (x && Array.isArray(x.cases)) ? x.cases : (Array.isArray(x) ? x : []);
    return arr.map(e => (e && typeof e === 'object') ? e.id : e); // case objects → id; raw ids → self
  };
  const b = new Set(idsOf(armB));
  return [...new Set(idsOf(armA))].filter(id => b.has(id)).sort();
}

/** R1.5.1 — partition into { smoke, full } by the `tier` marker; untagged cases fall into `full`
 *  (full is the superset tier). */
export function splitTiers(suite) {
  const smoke = [], full = [];
  for (const c of casesOf(suite)) (c.tier === 'smoke' ? smoke : full).push(c);
  return { smoke, full };
}

/** R1.5.2 — the held-out subset (goodhart guard); [U5] full-only analyses filter these out. */
export function heldOut(suite) {
  return casesOf(suite).filter(c => c.held_out === true);
}

/** R1.6 — per-skill coverage. Any skill with < MIN_PAIRS_SKILL cases → actionable warning carrying
 *  {skill, currentN, target, needMore} [PM-B6]. */
export function lintSkillCoverage(suite, config = UPGRADE_CONFIG) {
  const target = config.verdict.MIN_PAIRS_SKILL;
  const counts = new Map();
  for (const c of casesOf(suite)) counts.set(c.expected_skill, (counts.get(c.expected_skill) || 0) + 1);
  const findings = [];
  for (const [skill, currentN] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (currentN < target)
      findings.push({ level: 'warning', code: 'insufficient-coverage', skill, currentN, target,
        needMore: target - currentN,
        message: `skill "${skill}" has ${currentN} case(s), below MIN_PAIRS_SKILL=${target} `
          + `(need ${target - currentN} more) [R1.6]` });
  }
  return findings;
}

/** R1.7 — multi-intent coverage. Share of cases with a non-empty multi_intent[] below
 *  dataset.minMultiIntentPct → warning [PM-B5]. */
export function lintMultiIntent(suite, config = UPGRADE_CONFIG) {
  const cases = casesOf(suite);
  if (cases.length === 0) return [];
  const withMulti = cases.filter(c => Array.isArray(c.multi_intent) && c.multi_intent.length > 0).length;
  const pct = withMulti / cases.length;
  const floor = config.dataset.minMultiIntentPct;
  if (pct < floor)
    return [{ level: 'warning', code: 'insufficient-multi-intent-coverage', pct, floor,
      withMulti, total: cases.length,
      message: `multi-intent cases ${(pct * 100).toFixed(1)}% < floor ${(floor * 100).toFixed(1)}% [R1.7]` }];
  return [];
}

/** R1.8 — smoke tier size band. smoke count outside [smokeTierMin, smokeTierMax] → warning [PM-B7]. */
export function lintSmokeTierSize(suite, config = UPGRADE_CONFIG) {
  const n = splitTiers(suite).smoke.length;
  const { smokeTierMin: min, smokeTierMax: max } = config.dataset;
  if (n < min || n > max)
    return [{ level: 'warning', code: 'smoke-tier-size', n, min, max,
      message: `smoke tier has ${n} case(s), outside band [${min}, ${max}] [R1.8]` }];
  return [];
}

/** R1.EB1 — allowed_auxiliary listing expected_skill itself is redundant → warning. */
export function lintAuxiliaryRedundancy(suite) {
  const findings = [];
  for (const c of casesOf(suite)) {
    if (Array.isArray(c.allowed_auxiliary) && c.allowed_auxiliary.includes(c.expected_skill))
      findings.push({ level: 'warning', code: 'redundant-auxiliary', id: c.id, skill: c.expected_skill,
        message: `case "${c.id}": allowed_auxiliary lists expected_skill "${c.expected_skill}" `
          + `(redundant) [R1.EB1]` });
  }
  return findings;
}

/** Aggregate every single-suite lint (no lineage — that needs a prior version). Exported so a CLI
 *  (`aiide upgrade lint`, wired in bin/aiide.js by U0/pipeline owner) can print findings. */
export function lintSuite(suite, config = UPGRADE_CONFIG) {
  return [
    ...dedupeCheck(suite),
    ...lintDanglingSuperseded(suite),
    ...lintAuxiliaryRedundancy(suite),
    ...lintSkillCoverage(suite, config),
    ...lintMultiIntent(suite, config),
    ...lintSmokeTierSize(suite, config),
  ];
}
