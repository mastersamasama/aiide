// Experiment metadata (R-metadata): environment snapshot + custom meta + capture commands.
// Design contract: collection failures degrade to null + warning, never break the experiment.
// The only fail-fast paths are user-intent errors (--meta format, reserved-key collision).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { release } from 'node:os';

export const META_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// environment top-level names — a custom key shadowing these would corrupt flat diff/analysis views
export const RESERVED_META_KEYS = [
  'aiideVersion', 'nodeVersion', 'os', 'runtimeVersion', 'model', 'suite', 'skills', 'pricing',
];

// ---- secret redaction (applies BEFORE anything is written to disk) ---------------------------
// no bare-hex rule by design: 40-hex git commit ids are legitimate capture output
// (`git rev-parse HEAD`); hex-valued secrets still get caught by the k=v rule below
export function redactSecrets(s) {
  return String(s ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '***')                                          // provider API keys
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '***') // JWT
    .replace(/\b(token|secret|password|apikey|api_key)\s*[=:]\s*\S+/gi, (_, k) => `${k}=***`);
}

// ---- <data-dir>/settings.json (general aiide settings file; meta + capture live here) ---------
export function loadSettings(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
    return {
      ...raw,
      meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
      capture: raw.capture && typeof raw.capture === 'object' ? raw.capture : {},
    };
  } catch { return { meta: {}, capture: {} }; }
}

export function saveSettings(dataDir, settings) {
  mkdirSync(dataDir, { recursive: true }); // first `aiide meta set` may run before any ingest/lab created the data dir
  const p = join(dataDir, 'settings.json');
  writeFileSync(p, JSON.stringify(settings, null, 2));
  return p;
}

// ---- custom meta: CLI > suite > settings.json defaults ---------------------------------------
export function parseMetaFlags(values) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  return list.map((v) => {
    const s = String(v);
    const eq = s.indexOf('=');
    if (eq <= 0) throw new Error(`--meta expects k=v (got "${s}")\n  example: aiide lab run --suite s.json --meta branch=main`);
    return [s.slice(0, eq), s.slice(eq + 1)];
  });
}

/** Pure merge: same inputs → same output. Throws on invalid/reserved keys (user-intent error). */
export function resolveMeta({ cliPairs = [], suiteMeta = {}, settingsMeta = {} } = {}) {
  const out = {};
  const put = (key, value, source) => {
    if (!META_KEY_RE.test(key)) throw new Error(`invalid meta key "${key}" (letters, digits, . _ - only, max 64)`);
    if (RESERVED_META_KEYS.includes(key)) throw new Error(`meta key "${key}" is reserved (reserved: ${RESERVED_META_KEYS.join(', ')})`);
    const t = typeof value;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') throw new Error(`meta value for "${key}" must be string/number/boolean (got ${t})`);
    out[key] = { value, source };
  };
  for (const [k, v] of Object.entries(settingsMeta)) put(k, v, 'defaults');
  for (const [k, v] of Object.entries(suiteMeta ?? {})) put(k, v, 'suite');
  for (const [k, v] of cliPairs) put(k, v, 'cli');
  return out;
}

// ---- capture commands: `{name: "onchainos --version"}` run once per experiment ---------------
function runShell(command, { timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', done = false;
    const finish = (res) => { if (!done) { done = true; resolvePromise(res); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ error: `timeout after ${timeoutMs}ms` }); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.on('error', (err) => { clearTimeout(timer); finish({ error: String(err.message ?? err) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish({ error: `exit ${code}` });
      const line = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (!line) return finish({ error: 'no output' });
      finish({ value: redactSecrets(line.slice(0, 200)), ms: Date.now() - t0 });
    });
  });
}

/** Sequential on purpose: few entries, and interleaved output would be hard to attribute. */
export async function runCaptures(specs = {}, { timeoutMs = 5000 } = {}) {
  const out = {};
  for (const [name, cmd] of Object.entries(specs)) {
    if (!META_KEY_RE.test(name)) { out[name] = { value: null, error: 'invalid capture name' }; continue; }
    const res = await runShell(String(cmd), { timeoutMs });
    out[name] = res.error ? { value: null, error: res.error } : res;
  }
  return out;
}

// ---- environment snapshot ---------------------------------------------------------------------
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

/** Content-only digest: sorted relative paths + bytes. mtime and platform path seps never enter. */
export function hashDir(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else files.push(p);
    }
  }
  const h = createHash('sha256');
  for (const f of files.sort((a, b) => relative(dir, a).replaceAll('\\', '/').localeCompare(relative(dir, b).replaceAll('\\', '/')))) {
    h.update(relative(dir, f).replaceAll('\\', '/'));
    h.update('\0');
    h.update(readFileSync(f));
  }
  return h.digest('hex').slice(0, 12);
}

const normModel = (s) => String(s ?? '').toLowerCase().replace(/-latest$/, '');

/** requested vs observed mismatch — substring either way counts as a match ("sonnet" ↔ "claude-sonnet-5"). */
export function modelMismatch(requested, observed = []) {
  if (!requested || !observed.length) return false;
  const req = normModel(requested);
  return !observed.some((o) => { const m = normModel(o); return m.includes(req) || req.includes(m); });
}

async function detectRuntimeVersion({ runtime, claude }) {
  if (runtime?.type === 'claude-code' || (!runtime?.type && claude)) {
    if (!claude) return null;
    const cmd = [claude.cmd, ...(claude.preArgs ?? []), '--version']
      .map(p => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
    const res = await runShell(cmd, { timeoutMs: 5000 });
    return res.value ? res.value.slice(0, 80) : null;
  }
  if (runtime?.versionCmd) {
    const res = await runShell(String(runtime.versionCmd), { timeoutMs: 5000 });
    return res.value ?? null;
  }
  return null;
}

// ---- U4 two-arm isolation + version self-report -----------------------------------------------

/** Canonical arm identity string from an arm metadata block (null = legacy / no-arm run). */
function armIdentityOf(arm) {
  return arm ? `${arm.label}|${arm.cliVersion ?? null}|${arm.profileName ?? null}` : null;
}

/**
 * F3 two-arm journal isolation assertion (R4.7.1). Reject producing a verdict when the two arms share
 * a resumeKey (spliced arms → a repeat counted for both → delta≈0 fake pass) or the SAME non-null arm
 * identity. Each experiment carries {resumeKey, arm}. Throws on collision; returns true when isolated.
 */
export function assertArmIsolation(expA, expB) {
  if (!expA || !expB) throw new Error('assertArmIsolation: two experiments required');
  if (expA.resumeKey != null && expA.resumeKey === expB.resumeKey) {
    throw new Error(`two-arm isolation violated: shared resumeKey "${expA.resumeKey}" (spliced arms — refusing verdict, R4.7.1)`);
  }
  const idA = armIdentityOf(expA.arm), idB = armIdentityOf(expB.arm);
  if (idA != null && idA === idB) {
    throw new Error(`two-arm isolation violated: identical arm identity "${idA}" (R4.7.1)`);
  }
  return true;
}

/**
 * Version self-report quad (R4.8.1): per arm — CLI version, per-skill sha256, model, harness version,
 * isolation flag. The verdict footer renders this so a reader can audit exactly which two builds were
 * compared. Reads whatever the U0 armMetadata / environment snapshot already captured; missing fields
 * degrade to null, never throw.
 */
export function buildVersionQuad(armA, armB) {
  const one = (arm) => arm == null ? null : {
    label: arm.label ?? null,
    cliVersion: arm.cliVersion ?? null,
    model: arm.model ?? null,
    harnessVersion: arm.harnessVersion ?? null,
    isolationVerified: arm.isolationVerified ?? null,
    skills: Array.isArray(arm.skills)
      ? arm.skills.map(s => ({ name: s.name ?? null, sha256: s.hash ?? s.sha256 ?? null }))
      : (arm.skills ?? null),
  };
  return { armA: one(armA), armB: one(armB) };
}

/**
 * Collect the default environment snapshot. Every field degrades to null + warning on failure —
 * metadata must never take an experiment down (correctness property 2).
 */
export async function collectEnvironment({ suite, suitePath = null, runtime = {}, dataDir, skillDirs = [], claude = null }) {
  const warnings = [];
  const attempt = (label, fn) => { try { return fn(); } catch (err) { warnings.push(`${label}: ${err.message}`); return null; } };

  const aiideVersion = attempt('aiideVersion',
    () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null);
  const os = attempt('os', () => ({ platform: process.platform, release: release(), arch: process.arch }));

  let runtimeVersion = null;
  try { runtimeVersion = await detectRuntimeVersion({ runtime, claude }); }
  catch (err) { warnings.push(`runtimeVersion: ${err.message}`); }
  if (runtimeVersion == null && (runtime?.type ?? 'claude-code') !== 'claude-code' && !runtime?.versionCmd) {
    warnings.push('runtimeVersion: external runtime has no versionCmd and reported no runtime_version');
  }

  const suiteInfo = attempt('suite', () => ({
    path: suitePath,
    sha256: suitePath && existsSync(suitePath) && statSync(suitePath).isFile() ? sha256(readFileSync(suitePath)) : null,
    params: {
      repeats: suite.repeats ?? 3, maxTurns: suite.maxTurns ?? 30,
      timeoutMs: suite.timeoutMs ?? 300_000, allowedTools: suite.allowedTools ?? [],
    },
  }));

  const skills = attempt('skills', () => skillDirs.map((dir) => {
    try { return { name: dir.split(/[\\/]/).at(-1), hash: hashDir(dir) }; }
    catch { warnings.push(`skill hash failed: ${dir}`); return { name: dir.split(/[\\/]/).at(-1), hash: null }; }
  })) ?? [];

  const pricing = attempt('pricing', () => {
    const p = join(dataDir, 'pricing.json');
    return existsSync(p) ? { source: 'override', path: p, sha256: sha256(readFileSync(p)) } : { source: 'default' };
  });

  return {
    environment: {
      aiideVersion,
      nodeVersion: process.version,
      os,
      runtimeVersion,
      model: { requested: suite.model ?? 'sonnet', observed: [] },
      suite: suiteInfo,
      skills,
      pricing,
    },
    warnings,
  };
}
