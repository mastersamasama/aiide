// Isolated skill lab (R3): empty-runtime profile + headless Claude Code runner + suite execution.
// Isolation model: a dedicated CLAUDE_CONFIG_DIR containing ONLY the suite's skills + a copy of
// credentials. User-level skills/plugins/MCP never load (different config dir); project-level
// skills never load (each repeat runs in a fresh empty workspace).
import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
  appendFileSync, unlinkSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseSessionJsonl, skillBodyCostEst } from './parser.js';
import { computeRunMetrics, priceFor } from './metrics.js';
import { scoreRepeat, scoreTask, scoreExperiment, evalVerifier, mean, gateC, graderClass, gradeSafety, gradeRouting } from './score.js';
import { loadSettings, resolveMeta, runCaptures, collectEnvironment, modelMismatch } from './meta.js';
import { UPGRADE_CONFIG } from './upgradeConfig.js';
import { buildExpStats, cliStats, proximityMatrix, resolveReps, toRefInventory } from './expstats.js';
import { attributeRead } from './depgraph.js';
import { loadProbes, extractInvocations } from './probe.js';
import { makeJudge, summarizeTrace, JUDGE_DEFAULTS } from './judge.js';
import { makeResponder } from './responder.js';
import { collectAdapterMeta, nearMissKeyWarnings } from './adaptercheck.js';

export function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/** Resolve the claude executable. Returns {cmd, preArgs} so tests can stub with `node stub.js`. */
export function resolveClaude() {
  const override = process.env.AIIDE_CLAUDE_BIN;
  if (override) {
    // supports "node C:\path\stub.js" style overrides
    const parts = override.split('||');
    return { cmd: parts[0], preArgs: parts.slice(1) };
  }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        if (line.toLowerCase().endsWith('.exe')) return { cmd: line, preArgs: [] };
        // npm shim (.cmd/.ps1) → native exe lives under sibling node_modules
        const native = join(dirname(line), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (existsSync(native)) return { cmd: native, preArgs: [] };
      }
    } catch { /* fall through */ }
  }
  return { cmd: 'claude', preArgs: [] };
}

/**
 * Build/rebuild an isolated profile. Idempotent: skills dir is rebuilt from scratch on every call.
 *
 * `mix` (U0 R0.2b) assembles a MIXED-arm bundle profile: each entry pins one skill to a specific
 * arm's version. Shape: `{ skills: [{ name?, dir, arm }, ...] }` — `dir` is that arm's copy of the
 * skill, `arm` is the arm label it came from (recorded in the returned mixMapping for provenance).
 * When `mix` is absent, behavior is bit-identical to the pre-U0 skillDirs-only path.
 */
export function ensureProfile({ name, skillDirs = [], mix = null, dataDir, sourceConfigDir = defaultConfigDir() }) {
  const profileDir = join(dataDir, 'profiles', name);
  mkdirSync(join(profileDir, 'projects'), { recursive: true });

  const skillsDir = join(profileDir, 'skills');
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
  const installed = [];
  const skillListing = [];
  // plain skillDirs carry no arm provenance; mix entries pin each skill to the arm it came from
  const sources = [
    ...skillDirs.map(dir => ({ dir, arm: null, name: basename(dir) })),
    ...(mix?.skills ?? []).map(s => ({ dir: s.dir, arm: s.arm ?? null, name: s.name ?? basename(s.dir) })),
  ];
  const mixMapping = {};
  for (const src of sources) {
    cpSync(src.dir, join(skillsDir, src.name), { recursive: true });
    installed.push(src.name);
    if (src.arm) mixMapping[src.name] = src.arm;
    skillListing.push(analyzeSkillContext(src.dir, src.name));
  }

  const cred = join(sourceConfigDir, '.credentials.json');
  if (existsSync(cred)) cpSync(cred, join(profileDir, '.credentials.json'));

  // minimal state so headless mode skips first-run onboarding
  writeFileSync(join(profileDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    installMethod: 'aiide-lab-profile',
  }, null, 2));
  writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({}, null, 2));

  return { profileDir, installedSkills: installed, skillListing, mixMapping: mix ? mixMapping : null };
}

/**
 * Static context-cost estimate for one skill (chars/4 ≈ tokens):
 * - listing cost: name + description are injected into EVERY request's system prompt while installed
 * - body cost: SKILL.md body is loaded into context only when the skill triggers
 */
export function analyzeSkillContext(dir, skillName) {
  let desc = '', body = '';
  try {
    const raw = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (m) {
      const dm = m[1].match(/^description:\s*(["']?)([\s\S]*?)\1\s*$/m);
      desc = dm ? dm[2] : '';
      body = m[2];
    } else body = raw;
  } catch { /* skill without SKILL.md */ }
  return {
    skill: skillName,
    listingTokensEst: Math.round((skillName.length + desc.length) / 4),
    bodyTokensEst: Math.round(body.length / 4),
  };
}

/** Isolation invariant (design correctness property 3): profile skills ⊆ expected set. */
export function verifyIsolation(profileDir, expectedSkills) {
  const actual = existsSync(join(profileDir, 'skills')) ? readdirSync(join(profileDir, 'skills')) : [];
  const expected = new Set(expectedSkills);
  const extra = actual.filter(s => !expected.has(s));
  return { ok: extra.length === 0, actual, extra };
}

function runProcess({ cmd, args, cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: -1, stdout, stderr: stderr + String(err), timedOut, output: null, wallMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let output = null;
      try { output = JSON.parse(stdout); } catch { /* non-JSON stdout → output stays null */ }
      resolvePromise({ exitCode: code, stdout, stderr, timedOut, output, wallMs: Date.now() - startedAt });
    });
  });
}

export function runHeadless({
  claude = resolveClaude(), profileDir, workspaceDir, prompt,
  model = 'sonnet', maxTurns = 30, allowedTools = [], timeoutMs = 300_000,
}) {
  mkdirSync(workspaceDir, { recursive: true });
  const args = [
    ...claude.preArgs, '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--max-turns', String(maxTurns),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
  return runProcess({
    cmd: claude.cmd, args, cwd: workspaceDir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir }, timeoutMs,
  });
}

// ---- prompt variable injection (Part A) ------------------------------------------------------
// Substitute {{VAR}} placeholders in a task/step prompt from suite `vars` (+ AIIDE_VAR_* env
// overrides — secrets/addresses never in the suite file). The runtime-arg tokens
// (PROMPT/MODEL/SUITE_DIR/REPLY) are reserved for the adapter layer and never touched here. An
// unresolved {{VAR}} is FATAL (fail-fast — never ship a prompt with a blank hole).
const RESERVED_TOKENS = new Set(['PROMPT', 'MODEL', 'SUITE_DIR', 'REPLY']);
export function resolvePromptVars(text, vars = {}) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name) => {
    if (RESERVED_TOKENS.has(name)) return m;
    const envKey = 'AIIDE_VAR_' + name;
    const val = process.env[envKey] ?? vars[name];
    if (val == null) throw new Error(`prompt var {{${name}}} is unresolved — set suite.vars.${name} or env ${envKey}`);
    return String(val);
  });
}

// ---- Judge-as-Runtime transport (subsystem 2) ------------------------------------------------
// A judge is a fresh, tool-less model call returning grading text. Reuses runHeadless (claude-code)
// or runCommandAdapter (external) over the shared runProcess — no skills, no journal. Built only when
// the suite has judged checks or an explicit judge block; else null (zero overhead, back-compat).
export function makeJudgeForSuite({ suite, claude, profileDir, dataDir, suiteDir = '.' }) {
  const anyJudged = (suite.tasks ?? []).some(t =>
    (t.verifiers ?? []).some(v => graderClass(v.type) === 'judged')
    || (t.steps ?? []).some(s => (s.verifiers ?? []).some(v => graderClass(v.type) === 'judged')));
  if (!anyJudged && !suite.judge) return null;
  const cfg = { ...JUDGE_DEFAULTS, ...(suite.judge ?? {}) };
  const judgeProfile = profileDir ?? defaultConfigDir();
  const ws = join(dataDir, 'judge-workspace');
  async function invoke(prompt) {
    if ((cfg.runtime ?? 'claude-code') === 'claude-code') {
      const res = await runHeadless({ claude: claude ?? resolveClaude(), profileDir: judgeProfile, workspaceDir: ws,
        prompt, model: cfg.model, maxTurns: 1, allowedTools: [], timeoutMs: cfg.timeoutMs });
      return res.output?.result ?? res.stdout ?? '';
    }
    const res = await runCommandAdapter({ runtime: cfg.runtime, workspaceDir: ws, prompt,
      model: cfg.model, timeoutMs: cfg.timeoutMs, suiteDir });
    return res.output?.result ?? res.stdout ?? '';
  }
  return makeJudge(cfg, { invoke });
}

// ==== U0 upgrade-pipeline primitives ==========================================================
// Everything below the divider is added for the upgrade comparison pipeline (spec upgrade-u0).
// The pre-U0 lab runner is unchanged; `arm` is an optional pass-through so a plain non-upgrade
// `lab run` behaves bit-for-bit as before (R0.3.0).

// ---- R0.1: bounded worker pool ---------------------------------------------------------------
/**
 * Run `worker(item, index)` over `items` with at most `limit` in flight (R0.1.1). A worker throw
 * never aborts the batch (R0.1.3): it is collected into `errors` and scheduling continues. Results
 * land in `results[index]`, preserving input order regardless of completion order. Peak concurrency
 * is bounded by `limit` because exactly `limit` drain loops share one monotonic cursor.
 */
export async function runPool(items, limit, worker) {
  const n = items.length;
  const results = new Array(n);
  const errors = [];
  const lim = Math.max(1, Math.min(limit | 0 || 1, n || 1));
  let cursor = 0;
  async function drain() {
    while (cursor < n) {
      const idx = cursor++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (error) { errors.push({ index: idx, error }); }
    }
  }
  await Promise.all(Array.from({ length: lim }, () => drain()));
  return { results, errors };
}

// ---- R0.2: per-arm CLI / env / PATH pinning --------------------------------------------------
const PATH_DELIM = process.platform === 'win32' ? ';' : ':';

/**
 * Build an env for one arm so its invocations resolve ONLY that arm's onchainos CLI (R0.2.1).
 * The arm's own cli directory is prepended to PATH; the two arms never share a mutated process
 * env, so arm A's binary can never leak into arm B's runs. `arm.env` overrides win last.
 */
export function buildArmEnv(arm, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (arm?.cliPath) {
    const binDir = dirname(arm.cliPath);
    env.PATH = binDir + PATH_DELIM + (baseEnv.PATH ?? '');
    if ('Path' in env) env.Path = env.PATH; // Windows uses `Path`; keep both in lockstep
  }
  if (arm?.env) Object.assign(env, arm.env);
  return env;
}

function defaultVersionExec(arm) {
  const bin = arm?.cliPath ?? 'onchainos';
  return execFileSync(bin, ['--version'], { env: buildArmEnv(arm), encoding: 'utf8' });
}

/**
 * Preflight assertion (R0.2.2): run `onchainos --version` for this arm and require it to equal the
 * arm's declared cliVersion. Throws on mismatch so the caller fail-fasts BEFORE any session runs.
 * `exec` is injectable so tests can mock the version probe without a real binary.
 */
export function assertArmVersion(arm, { exec = defaultVersionExec } = {}) {
  const reported = String(exec(arm) ?? '').trim();
  // tolerate `onchainos 2.1.0` / `v2.1.0` framing — match the declared version as a token
  const declared = String(arm?.cliVersion ?? '').trim();
  const ok = reported === declared
    || new RegExp(`(^|[^0-9.])${declared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9.]|$)`).test(reported);
  if (!declared || !ok) {
    throw new Error(`arm '${arm?.label ?? '?'}' version mismatch: declared ${declared || '(none)'}, `
      + `onchainos --version reports "${reported || '(empty)'}" — refusing to start any session`);
  }
  return reported;
}

/** Metadata block for an arm, written into the experiment (R0.2.3). Mix fields added when present. */
export function armMetadata(arm, { isolation = null, harnessVersion = null } = {}) {
  if (!arm) return null;
  return {
    label: arm.label, cliVersion: arm.cliVersion ?? null, profileName: arm.profileName ?? null,
    model: arm.model ?? null, isolationVerified: isolation, harnessVersion,
    ...(arm.mix ? { mix: arm.mix } : {}),
    ...(arm.baseline ? { baseline: arm.baseline } : {}),
    ...(arm.pairing ? { pairing: arm.pairing } : {}),
  };
}

// ---- R0.2b: mixed bundle-profile assembly ----------------------------------------------------
/**
 * Build the metadata for a MIXED arm (R0.2b.2/R0.2b.3). CLI version is operator-chosen and defaults
 * to the new arm's; the mix mapping (skill → source arm) and the pairing semantics (mix vs baseline,
 * baseline defaults to old-full per PM-N1) are recorded so [U4]/[U7] can consume them. The e2e
 * mini-verdict assertion itself is gated to [U7] (R0.2b.4) — this only produces the record.
 */
export function mixArmMetadata({ label = 'mix', mixMapping = {}, cliVersion, baseline = 'old' } = {}) {
  return {
    label, cliVersion: cliVersion ?? null, profileName: label,
    mix: mixMapping, baseline, pairing: 'mix-vs-baseline',
  };
}

// ---- R0.4: scripted-reply resume + incremental metrics merge ---------------------------------
/**
 * Continue a halted session with the case's scripted reply (R0.4.1/R0.4.2). Uses `--resume` with the
 * SAME CLAUDE_CONFIG_DIR (profileDir), the SAME workspace cwd, and NO `--fork-session`, so it is a
 * zero-replay append to the very same session JSONL (P2). Shape mirrors runHeadless's result.
 */
export function resumeWithScriptedReply({
  claude = resolveClaude(), profileDir, workspaceDir, sessionId, reply,
  model = 'sonnet', maxTurns = 30, allowedTools = [], timeoutMs = 300_000,
}) {
  if (!sessionId) throw new Error('resumeWithScriptedReply: sessionId is required');
  mkdirSync(workspaceDir, { recursive: true });
  const args = [
    ...claude.preArgs, '-p', reply,
    '--resume', sessionId,             // same session; NO --fork-session (P2: append, no replay)
    '--model', model,
    '--output-format', 'json',
    '--max-turns', String(maxTurns),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
  return runProcess({
    cmd: claude.cmd, args, cwd: workspaceDir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir }, timeoutMs,
  });
}

/**
 * Merge the per-invocation metrics of a scripted-reply flow (R0.4.3/R0.4.4). Cost, token usage and
 * rounds are the INCREMENTAL SUM over invocations — each invocation's stdout result reports its own
 * delta, never a running total, so summing is correct and taking only the last (or only the first)
 * is wrong. Quality dimensions (C/P/H) come from the FINAL flow (last invocation), which carries the
 * complete post-resume answer that the verifiers score. Cost is never read from the JSONL (R0.4.4).
 */
export function mergeInvocationMetrics(invocations = []) {
  if (!invocations.length) return null;
  const usage = { in: 0, out: 0, cacheW: 0, cacheR: 0 };
  let costUsd = 0, rounds = 0;
  for (const inv of invocations) {
    costUsd += inv.costUsd ?? 0;
    rounds += inv.rounds ?? 0;
    const u = inv.usage ?? {};
    usage.in += u.in ?? 0; usage.out += u.out ?? 0;
    usage.cacheW += u.cacheW ?? 0; usage.cacheR += u.cacheR ?? 0;
  }
  const last = invocations.at(-1);
  return {
    costUsd: round4(costUsd), usage, rounds, invocations: invocations.length,
    C: last.C ?? null, P: last.P ?? null, H: last.H ?? null, flowStatus: 'complete',
  };
}

// Sum two rep efficiency blocks (a gated flow spans two invocations: initial halt + resume).
function sumEfficiency(a = {}, b = {}) {
  const t = (x) => x?.tokens ?? {};
  return {
    tokens: {
      in: (t(a).in ?? 0) + (t(b).in ?? 0), out: (t(a).out ?? 0) + (t(b).out ?? 0),
      cacheW: (t(a).cacheW ?? 0) + (t(b).cacheW ?? 0), cacheR: (t(a).cacheR ?? 0) + (t(b).cacheR ?? 0),
    },
    durationMs: (a.durationMs ?? 0) + (b.durationMs ?? 0),
    costUsd: round4((a.costUsd ?? 0) + (b.costUsd ?? 0)), wallMs: (a.wallMs ?? 0) + (b.wallMs ?? 0),
  };
}

/**
 * R0.4.5 hook: an asked-and-halted case with NO scripted reply is EXCLUDED from both the quality and
 * the cost axes (scoreTask drops `excluded` reps from its denominator entirely, so it is never a
 * fake C=0) and tagged flow-incomplete. The flow-incomplete DECISION lives in [U3]; this only stamps
 * the repeat-level fields ([U3] reads `flowStatus`).
 */
export function markScriptedReplyExcluded(rep = {}, reason = 'no-scripted-reply') {
  return {
    ...rep, excluded: true, excludedSignature: 'flow-incomplete',
    flowStatus: 'incomplete', flowIncompleteReason: reason,
  };
}

/**
 * [U3] T3.4 asked-and-halted disposition. Given a repeat whose L3 safety grader returned
 * `asked-and-halted` on a must_confirm_before case, decide the terminal disposition (R3.4.1/R3.4.2):
 *   - case HAS a scripted_reply → resume the halted session, re-grade L3 on the completed flow, and
 *     merge the incremental cost. The resume runner is injected (`resume`) so this stays testable
 *     without a live CLI; it must return { verdict, rep } for the completed flow.
 *   - case has NO scripted_reply → harness defect: EXCLUDE the repeat from BOTH the quality and cost
 *     axes (excluded-not-zero) and stamp flow-incomplete so it still counts in the F1 numerator. This
 *     shuts the "over-conservative new arm → work not done → three fake axis drops" reversal (R3.4.2).
 * A verdict other than asked-and-halted is returned untouched (terminal already).
 */
export async function disposeHaltedRepeat({ rep, caseObj, safetyVerdict, resume } = {}) {
  const verdict = safetyVerdict && typeof safetyVerdict === 'object' ? safetyVerdict.verdict : safetyVerdict;
  if (verdict !== 'asked-and-halted') return { rep, safetyVerdict, resumed: false };

  const scripted = caseObj?.scripted_reply ?? null;
  if (!scripted) {
    return { rep: markScriptedReplyExcluded(rep, 'harness-halt'), safetyVerdict, resumed: false, excluded: true };
  }
  if (typeof resume !== 'function') {
    // no runner available at this call site → treat as harness-halt rather than silently losing the run
    return { rep: markScriptedReplyExcluded(rep, 'harness-halt'), safetyVerdict, resumed: false, excluded: true };
  }
  const completed = await resume({ rep, caseObj, reply: scripted });
  const merged = { ...rep, ...(completed.rep ?? {}), flowStatus: 'complete', excluded: false };
  return { rep: merged, safetyVerdict: completed.verdict ?? safetyVerdict, resumed: true };
}

// ---- R0.5: run budget estimate ---------------------------------------------------------------
// A rough per-session token profile for the USD estimate. Deliberately a single knob: the estimate
// is a pre-flight sanity figure, not an accounting number (the real cost is measured per invocation).
const DEFAULT_SESSION_TOKENS = { in: 12_000, out: 1_500, cacheR: 30_000, cacheW: 4_000 };

/**
 * Pre-flight budget estimate (R0.5.1) — the SAME function the CLI prints and [U7] consumes (R0.5.2).
 * sessions = arms × cases × repeats. etaMs models wall-clock as ceil(sessions/concurrency) batches
 * of `perSessionMs` (monotonically smaller as concurrency grows). usdEst uses metrics.js pricing.
 */
export function estimateBudget({
  arms = 1, cases = 0, repeats = 3, concurrency = UPGRADE_CONFIG.concurrency.default,
  perSessionMs = 120_000, model = 'sonnet', pricing, sessionTokens = DEFAULT_SESSION_TOKENS,
} = {}) {
  const armCount = Array.isArray(arms) ? arms.length : arms;
  const sessions = armCount * cases * repeats;
  const conc = Math.max(1, concurrency | 0 || 1);
  const etaMs = Math.ceil(sessions / conc) * perSessionMs;
  const p = priceFor(model, pricing);
  const perSessionUsd = (sessionTokens.in * p.in + sessionTokens.out * p.out
    + (sessionTokens.cacheR ?? 0) * p.cacheR + (sessionTokens.cacheW ?? 0) * p.cacheW) / 1e6;
  return {
    sessions, etaMs, usdEst: round4(sessions * perSessionUsd),
    perSessionUsd: round4(perSessionUsd), concurrency: conc, pricingMatched: p.matched,
  };
}

/**
 * Generic external-runtime adapter (e.g. a website agent, a custom agent loop).
 * Contract: aiide spawns `runtime.cmd runtime.args...` with {{PROMPT}} / {{MODEL}} substituted;
 * the process prints ONE JSON object to stdout:
 *   { result: string,                        // final answer (verifiers run on this)
 *     total_cost_usd?: number,
 *     trace?: [{ text?, skill?, durationMs?, usage?: {in,out,cacheW,cacheR},
 *                toolCalls?: [{name, isError?, skill?, input?, result?}] }] }
 * With trace → full C/P/R/H scoring + timeline; without → completion-only (P/H excluded, flagged).
 */
export function runCommandAdapter({ runtime, workspaceDir, prompt, model, timeoutMs = 300_000, suiteDir = '.', extraEnv = {} }) {
  mkdirSync(workspaceDir, { recursive: true });
  const sub = s => String(s)
    .replaceAll('{{PROMPT}}', prompt)
    .replaceAll('{{MODEL}}', model ?? '')
    .replaceAll('{{SUITE_DIR}}', suiteDir);
  return runProcess({
    cmd: sub(runtime.cmd),
    args: (runtime.args ?? []).map(sub),
    cwd: runtime.cwd ? sub(runtime.cwd) : workspaceDir,
    env: { ...process.env, ...(runtime.env ?? {}), ...extraEnv },
    timeoutMs,
  });
}

// ---- service-under-test lifecycle ------------------------------------------------------------
// Some products (websites, HTTP agents) fix model/provider at process start. aiide owns the
// service lifecycle so `--models a,b` can restart it per model with the right env — and so the
// benchmark can never silently hit a stale, manually-started instance with the wrong config.

/** Optional local env file `<data-dir>/service.env` (KEY=VALUE lines) — BYOK keys live in env, never in suite files. */
export function loadServiceEnvFile(dataDir) {
  const p = join(dataDir, 'service.env');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

async function urlResponds(url, timeoutMs = 2000) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok; }
  catch { return false; }
}

function byokGuidance(missing, dataDir) {
  return [
    `missing required env for the service under test: ${missing.join(', ')} (BYOK key not provided).`,
    `Provide it one of two ways (never committed, never stored by aiide):`,
    `  1) this shell only:   $env:${missing[0]} = "sk-..."`,
    `  2) once, local file:  ${join(dataDir, 'service.env')}`,
    `       ${missing[0]}=sk-...`,
    `       ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic   # only when using DeepSeek BYOK`,
    `Then re-run the same command.`,
  ].join('\n');
}

/**
 * Start the service under test with per-model env ({{MODEL}} substituted), wait for readyUrl.
 * Fails fast when the port is already taken: testing a pre-existing instance would silently
 * benchmark the wrong model/provider.
 */
export async function startService({ service, model, dataDir }) {
  const sub = s => String(s).replaceAll('{{MODEL}}', model ?? '');
  const fileEnv = loadServiceEnvFile(dataDir);
  const suiteEnv = Object.fromEntries(Object.entries(service.env ?? {}).map(([k, v]) => [k, sub(v)]));
  const env = { ...process.env, ...fileEnv, ...suiteEnv };

  const missing = (service.requiredEnv ?? []).filter(k => !env[k]);
  if (missing.length) throw new Error(byokGuidance(missing, dataDir));
  if (service.readyUrl && await urlResponds(service.readyUrl)) {
    throw new Error(`something already responds at ${service.readyUrl} — stop the manually started server first; aiide must own the service lifecycle to guarantee model/env`);
  }
  const warnings = [];
  for (const cli of service.requiredCli ?? []) {
    try { execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [cli], { stdio: 'ignore' }); }
    catch { warnings.push(`required CLI '${cli}' not found on PATH — the service's tools will fail`); }
  }

  const child = spawn(resolveCommand(sub(service.cmd)), (service.args ?? []).map(sub), {
    cwd: service.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let lastOutput = '';
  child.stdout.on('data', d => { lastOutput = (lastOutput + d).slice(-2000); });
  child.stderr.on('data', d => { lastOutput = (lastOutput + d).slice(-2000); });

  const deadline = Date.now() + (service.readyTimeoutMs ?? 30_000);
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    if (await urlResponds(service.readyUrl)) { ready = true; break; }
    await new Promise(r => setTimeout(r, 400));
  }
  if (!ready) {
    killTree(child.pid);
    throw new Error(`service not ready within ${service.readyTimeoutMs ?? 30_000}ms (${service.readyUrl}); last output: ${lastOutput.slice(-400)}`);
  }

  return {
    child,
    serviceUrl: new URL(service.readyUrl).origin,
    stop: () => killTree(child.pid),
    // audit summary — env KEY NAMES and endpoint host only; secret values never recorded
    meta: {
      cmd: [sub(service.cmd), ...(service.args ?? []).map(sub)].join(' '),
      cwd: service.cwd ?? null,
      model: env.AI_MODEL ?? model ?? null,
      endpointHost: safeUrlHost(env.ANTHROPIC_BASE_URL),
      envKeys: [...new Set([...Object.keys(fileEnv), ...Object.keys(suiteEnv), ...(service.requiredEnv ?? [])])].sort(),
      warnings,
    },
  };
}

function safeUrlHost(u) {
  try { return u ? new URL(u).host : null; } catch { return null; }
}

/** Windows spawn can't execute npm .cmd shims — resolve bare commands to a real .exe. */
function resolveCommand(cmd) {
  if (process.platform !== 'win32' || /[\\/]/.test(cmd) || cmd.toLowerCase().endsWith('.exe')) return cmd;
  try {
    const lines = execFileSync('where.exe', [cmd], { encoding: 'utf8' })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) if (line.toLowerCase().endsWith('.exe')) return line;
    for (const line of lines) {
      // npm shim → the real exe usually lives under sibling node_modules/<cmd>/bin/
      const native = join(dirname(line), 'node_modules', cmd, 'bin', `${cmd}.exe`);
      if (existsSync(native)) return native;
    }
  } catch { /* not found — let spawn surface the error */ }
  return cmd;
}

/** Build a Run from an adapter-provided trace (same shape parser.js produces from JSONL). */
export function buildRunFromTrace(trace, { model = null, id }) {
  let seq = 0;
  const rounds = (trace ?? []).map(s => {
    // usage absent must survive as null (null-not-zero): "didn't report" ≠ "reported 0".
    // A present usage object keeps the zero-default skeleton for missing buckets.
    const usage = s.usage == null
      ? null
      : { in: s.usage.in ?? 0, out: s.usage.out ?? 0, cacheW: s.usage.cacheW ?? 0, cacheR: s.usage.cacheR ?? 0 };
    const round = {
      seq: ++seq, ts: s.ts ?? null, durationMs: s.durationMs ?? 0,
      model: s.model ?? model, attributionSkill: s.skill ?? null,
      usage, contextFootprint: usage == null ? null : usage.in + usage.cacheR + usage.cacheW,
      toolCalls: (s.toolCalls ?? []).map(tc => ({
        name: tc.name ?? 'tool', id: tc.id ?? null, isError: tc.isError === true,
        skill: tc.skill ?? null, input: tc.input ?? null, result: tc.result ?? null,
        // non-null denialKind IS the denial fact (classifyToolResult) — unknown values are
        // preserved verbatim, never downgraded to null; value-domain checks belong to `adapter check`
        denialKind: tc.denialKind ?? null,
        // a1 amendment: self-reported tool classification, passed through VERBATIM (value-domain
        // checks live in the stats layer / `adapter check`). Named declaredKind so a future
        // claude-code-native `kind` field can never collide with the self-report channel.
        declaredKind: tc.kind ?? null,
      })),
      // a1 amendment / r5 F-5-02 structural L3 exemption: the adapter's self-reported stop reason
      // lands on the INDEPENDENT field declaredStopReason; round.stopReason stays null for adapter
      // runs, so score.js's two stopReason read points (isConfirmTurn + gradeSafety's inline
      // confirmIdx scan) are exempt with ZERO changes. truncation stats read
      // declaredStopReason ?? stopReason; unknown values are preserved verbatim.
      stopReason: null, declaredStopReason: s.stopReason ?? null,
      text: s.text ?? '', thinking: '',
      textChars: (s.text ?? '').length, thinkingChars: 0,
    };
    // declared channels exist ONLY when the field is explicitly present: absent ≠ [] —
    // observedSignals counts channel presence, so a fabricated [] would forge capability evidence
    if (Array.isArray(s.triggers)) round.declaredTriggers = s.triggers.filter(t => typeof t === 'string');
    if (Array.isArray(s.refReads)) {
      round.declaredRefReads = s.refReads
        .filter(r => r && typeof r === 'object')
        .map(r => ({
          skill: r.skill ?? null, ref: r.ref ?? null,
          status: r.status === 'blocked' ? 'blocked' : 'ok', // only 'ok'|'blocked'; anything else → 'ok'
        }));
    }
    return round;
  });
  return {
    id, sessionId: null, source: 'adapter-trace', model,
    startedAt: null, endedAt: null, cwd: null, version: null,
    prompt: null, userEvents: [],
    rounds, sidechains: [], parseWarnings: 0, meta: {},
  };
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Locate the session JSONL claude wrote inside the isolated profile. */
export function findSessionJsonl(profileDir, sessionId) {
  const root = join(profileDir, 'projects');
  if (!existsSync(root) || !sessionId) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name === `${sessionId}.jsonl`) return p;
    }
  }
  return null;
}

const EMPTY_EFFICIENCY = { tokens: { in: 0, out: 0, cacheW: 0, cacheR: 0 }, durationMs: 0, costUsd: 0 };

// ---- env-noise triage + retry (S2) -----------------------------------------------------------
// A signature whitelist a skill CANNOT forge (a skill can't make an API return 529, nor an auth
// service return 53017). Matched against INFRA surfaces only — process stderr, the process-failure
// error, and trace tool-ERROR results — never the model's own answer, which is what keeps the
// signal unforgeable. timeout / generic exit!=0 are deliberately absent (a timeout may be a loop).
const ENV_NOISE_SIGNATURES = [
  { label: 'rate-limit-429', re: /\b429\b|too many requests/i },
  { label: 'overloaded-529', re: /\b529\b|overloaded/i },
  { label: 'auth-expired', re: /\b53017\b|auth\w*\s*(token\s*)?expir|token\s*expir|expired\s*(auth|token|credential|session)|authentication\s*(failed|expired)/i },
  { label: 'conn-refused', re: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/ },
  { label: 'rate-limit', re: /rate[\s_-]?limit(?:ed|ing)?/i },
];

export function classifyEnvNoise(text) {
  const t = String(text ?? '');
  for (const s of ENV_NOISE_SIGNATURES) if (s.re.test(t)) return s.label;
  return null;
}

/** Gather ONLY infra-error surfaces for classification (never the model's final answer). */
function noiseText({ res, rep }) {
  const parts = [rep?.error, res?.stderr];
  const trace = res?.output?.trace;
  if (Array.isArray(trace)) {
    for (const step of trace) {
      for (const tc of step?.toolCalls ?? []) {
        if (tc?.isError && tc.result != null) parts.push(String(tc.result));
      }
    }
  }
  return parts.filter(Boolean).join('\n');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round3 = (x) => Math.round(x * 1e3) / 1e3;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

// ---- resume journal + per-repeat logs (S1) ---------------------------------------------------
// A journal is an append-only <data-dir>/experiments/.inprogress/<resumeKey>.jsonl. It is a NEW
// artifact class ("in progress") — sealed experiment.json files are still write-once immutable.
// It lives in a subdirectory with a .jsonl extension, so the dashboard's non-recursive
// readdirSync + endsWith('.json') (server.js:117) filters it out with zero server changes.

function fsSafe(s) { return String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_'); }
function journalDir(dataDir) { return join(dataDir, 'experiments', '.inprogress'); }

export function suiteSha256(suitePath) {
  if (!suitePath || !existsSync(suitePath)) return null;
  try { return createHash('sha256').update(readFileSync(suitePath)).digest('hex'); }
  catch { return null; }
}

export function computeResumeKey({ name, model, sha256, arm = null }) {
  const base = `${fsSafe(name)}-${fsSafe(model ?? 'default')}-${(sha256 ?? 'nosha').slice(0, 8)}`;
  // R0.3.0: no arm → bit-identical to the pre-upgrade key. R0.3.1: an arm appends its identity so
  // two arms on the SAME suite sha + model still produce distinct keys (no cross-arm resume).
  if (!arm) return base;
  return `${base}-${fsSafe(arm.label)}-${fsSafe(arm.cliVersion)}-${fsSafe(arm.profileName)}`;
}

/** Canonical arm identity for journal ownership. Legacy (no-arm) headers/runs are identity `null`. */
function armIdentity(arm) {
  return arm ? `${arm.label}|${arm.cliVersion}|${arm.profileName}` : null;
}

function readJournalHeader(path) {
  try {
    const first = readFileSync(path, 'utf8').split(/\r?\n/).find(l => l.trim());
    const h = first ? JSON.parse(first) : null;
    return h && h.__aiide_journal ? h : null;
  } catch { return null; }
}

/** Scan .inprogress for a journal of this (name, model, arm): resume (config matches) | drift | none. */
export function findJournal({ dataDir, name, model, repeats, sha256, arm = null }) {
  const dir = journalDir(dataDir);
  if (!existsSync(dir)) return { status: 'none' };
  const wantArm = armIdentity(arm); // null for a plain non-upgrade run
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const h = readJournalHeader(join(dir, f));
    if (!h || h.name !== name || h.model !== model) continue; // different identity → not ours
    // R0.3.2: arm identity is part of the identity. A header from a different arm — or a legacy
    // header with no arm field vs an arm run (and vice-versa) — is a SEPARATE journal, not a drift:
    // skip it so the current run stays independent instead of wrongly resuming across arms.
    if (armIdentity(h.arm) !== wantArm) continue;
    if (h.suiteSha256 === sha256 && h.repeats === repeats) {
      return { status: 'resume', path: join(dir, f), header: h };
    }
    const what = h.suiteSha256 !== sha256
      ? `suite changed (${String(h.suiteSha256 ?? 'none').slice(0, 4)}→${String(sha256 ?? 'none').slice(0, 4)})`
      : `repeats changed (${h.repeats}→${repeats})`;
    return { status: 'drift', path: join(dir, f), header: h, message: what };
  }
  return { status: 'none' };
}

/** Load completed repeats keyed by `${taskId}::${repeat}`. A corrupt/truncated tail line is skipped. */
export function loadJournalRepeats(path) {
  const map = new Map();
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return map; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; } // tolerate bad tail line
    if (!obj || obj.__aiide_journal) continue;
    if (obj.taskId != null && obj.repeat != null && obj.rep) map.set(`${obj.taskId}::${obj.repeat}`, obj.rep);
  }
  return map;
}

function ensureJournal({ dataDir, resumeKey, name, model, repeats, sha256, aiideVersion, arm = null }) {
  const dir = journalDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${resumeKey}.jsonl`);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({
      __aiide_journal: 1, name, model, repeats, suiteSha256: sha256,
      // R0.3.2: an arm run stamps its identity into the header; a plain run omits the field entirely
      // (bit-identical to the pre-upgrade header), which is exactly the "legacy" case findJournal
      // treats as a distinct identity from any arm run.
      ...(arm ? { arm: { label: arm.label, cliVersion: arm.cliVersion ?? null, profileName: arm.profileName ?? null } } : {}),
      aiideVersion: aiideVersion ?? null, createdAt: new Date().toISOString(),
    }) + '\n');
  }
  return path;
}

function appendJournalRepeat(path, taskId, repeat, rep) {
  appendFileSync(path, JSON.stringify({ taskId, repeat, rep, ts: new Date().toISOString() }) + '\n');
}

/** --fresh hygiene: drop any journal sharing this (name, model, arm) identity, whatever the suite sha. */
function clearJournals({ dataDir, name, model, arm = null }) {
  const dir = journalDir(dataDir);
  if (!existsSync(dir)) return;
  const wantArm = armIdentity(arm);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const h = readJournalHeader(join(dir, f));
    // arm-scoped: a --fresh of arm A must not wipe arm B's (or a legacy) in-progress journal
    if (h && h.name === name && h.model === model && armIdentity(h.arm) === wantArm) {
      try { unlinkSync(join(dir, f)); } catch { /* gone */ }
    }
  }
}

// per-repeat audit trail: exception/stdout/trace in an independent dir. S2's excluded-audit reads
// exception.txt. Failures degrade silently — logging must never take the experiment down.
function writeRepeatLogs({ dataDir, resumeKey, taskId, repeat, res, rep, run }) {
  try {
    const dir = join(dataDir, 'logs', resumeKey, `${taskId}-r${repeat}`);
    mkdirSync(dir, { recursive: true });
    if (res?.stdout != null) writeFileSync(join(dir, 'stdout.txt'), String(res.stdout));
    if (res?.stderr) writeFileSync(join(dir, 'stderr.txt'), String(res.stderr));
    if (rep?.error) writeFileSync(join(dir, 'exception.txt'), String(rep.error));
    const trace = run ?? res?.output ?? null;
    if (trace != null) writeFileSync(join(dir, 'trace.json'), JSON.stringify(trace, null, 2));
    return dir;
  } catch { return null; }
}

export async function runSuite({
  suite, suiteDir = '.', suitePath = null, dataDir, pricing, cliMeta = [], fresh = false,
  onProgress = () => {},
  // U0: optional arm identity (undefined → plain non-upgrade run, bit-identical to before) and the
  // bounded-pool width. concurrency defaults to 1 so a normal `lab run` executes serially exactly as
  // it always has; `runArm` (or an explicit value) opts into the pool.
  arm = null, concurrency = 1,
}) {
  const runtime = suite.runtime ?? { type: 'claude-code' };
  const model = suite.model ?? 'sonnet';
  // fail-fast BEFORE any setup: an invalid --meta / reserved key means user intent was not captured
  const settings = loadSettings(dataDir);
  const meta = resolveMeta({ cliPairs: cliMeta, suiteMeta: suite.meta, settingsMeta: settings.meta });
  const expId = `${suite.name}${model ? '-' + model : ''}${arm ? '-' + fsSafe(arm.label) : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const skillDirs = (suite.skills?.dirs ?? []).map(d => resolve(suiteDir, d));

  let profileDir = null, installedSkills = [], skillListing = [], isolation = { ok: null };
  if (runtime.type === 'claude-code') {
    ({ profileDir, installedSkills, skillListing } = ensureProfile({
      name: suite.profileName ?? suite.name, skillDirs, mix: suite.mix ?? null, dataDir,
      sourceConfigDir: suite.sourceConfigDir ?? defaultConfigDir(),
    }));
    isolation = verifyIsolation(profileDir, installedSkills);
    if (!isolation.ok) throw new Error(`isolation invariant violated: unexpected skills ${isolation.extra.join(', ')}`);
  } else {
    // external runtime manages its own skills — still record static estimates when dirs are given
    skillListing = skillDirs.map(d => analyzeSkillContext(d, basename(d)));
    installedSkills = skillListing.map(s => s.skill);
  }

  const claude = runtime.type === 'claude-code' ? resolveClaude() : null;

  // metadata snapshot (R-metadata): captures + environment; failures degrade, never abort
  const captured = await runCaptures({ ...settings.capture, ...(suite.capture ?? {}) });
  for (const [name, c] of Object.entries(captured)) {
    if (c.error) onProgress({ type: 'warning', message: `capture ${name}: ${c.error}` });
  }
  const { environment, warnings: metaWarnings } = await collectEnvironment({
    suite, suitePath, runtime, dataDir, skillDirs, claude,
  });
  onProgress({ type: 'metadata', environment, meta, captured });

  const repeats = suite.repeats ?? 3;
  const tasks = {};

  // resume detection FIRST — a drift rejection must not create any artifact ("does not start").
  // findJournal is safe when the dirs don't exist yet (returns none).
  const sha256 = suiteSha256(suitePath);
  const resumeKey = computeResumeKey({ name: suite.name, model, sha256, arm });
  let completed = new Map();
  if (fresh) {
    clearJournals({ dataDir, name: suite.name, model, arm });
  } else {
    const found = findJournal({ dataDir, name: suite.name, model, repeats, sha256, arm });
    if (found.status === 'drift') throw new Error(`cannot resume: ${found.message} — use --fresh`);
    if (found.status === 'resume') {
      completed = loadJournalRepeats(found.path);
      onProgress({ type: 'resume', done: completed.size, total: suite.tasks.length * repeats });
    }
  }
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  mkdirSync(join(dataDir, 'experiments'), { recursive: true });
  const journalPath = ensureJournal({
    dataDir, resumeKey, name: suite.name, model, repeats, sha256, aiideVersion: environment.aiideVersion, arm,
  });

  // service-under-test: aiide starts it with per-model env and always tears it down
  let service = null;
  if (runtime.type !== 'claude-code' && runtime.service) {
    service = await startService({ service: runtime.service, model, dataDir });
    for (const w of service.meta.warnings) onProgress({ type: 'warning', message: w });
    onProgress({ type: 'service-ready', url: service.serviceUrl, model: service.meta.model, endpointHost: service.meta.endpointHost });
  }

  // Stage 2 (adapter-observability §3/§4/§5.1): warnings raised while persisting rep-level
  // observability signals (system-prompt content addressing, seal reconciliation). Merged into
  // expWarnings at seal — deduped, after metaWarnings.
  const obsWarnings = [];

  // ── subsystem 1/2/3 setup: trace-grader probes · judge-as-runtime · responder ────────────────
  // Loaded once here and reused at seal (probe stats). All default to inert when the suite declares
  // none, so a classic suite runs bit-identically. authority='deterministic' keeps C reproducible.
  const writeOps = suite.writeOps ?? [];
  const authority = suite.grading?.authority ?? 'deterministic';
  let probes = [];
  try { probes = loadProbes(dataDir, suite.probes); }
  catch (e) { obsWarnings.push(`probe load failed: ${e.message} — probe/trace graders degraded to no-probes`); }
  const judge = makeJudgeForSuite({ suite, claude, profileDir, dataDir, suiteDir });
  const responder = makeResponder({ ...(suite.responder ?? {}) });

  // one agent invocation with the S2 env-noise retry loop. `cleanWorkspace` is false for multi-step
  // steps, which must share (not wipe) the workspace so a later step can consume an earlier artifact.
  async function attemptInvocation({ workspaceDir, verifyDir, prompt, verifiers, targetSkills, taskId, repeat, step, cleanWorkspace }) {
    const maxRetries = suite.retry?.maxRetries ?? 2;
    const baseDelayMs = suite.retry?.baseDelayMs ?? 1000;
    let rep, res = null, noise = null;
    // taxonomy G-17 前置: structured env-noise retry history — one entry per retried attempt
    // (the pre-success failures that used to leave zero trace beyond onProgress events).
    const retries = [];
    for (let attempt = 0; ; attempt++) {
      if (cleanWorkspace) rmSync(workspaceDir, { recursive: true, force: true }); // fresh slate each attempt
      res = null;
      try {
        res = runtime.type === 'claude-code'
          ? await runHeadless({
              claude, profileDir, workspaceDir, prompt, model,
              maxTurns: suite.maxTurns ?? 30, allowedTools: suite.allowedTools ?? [],
              timeoutMs: suite.timeoutMs ?? 300_000,
            })
          : await runCommandAdapter({
              runtime, workspaceDir, prompt, model,
              timeoutMs: suite.timeoutMs ?? 300_000, suiteDir,
              extraEnv: service ? { AIIDE_SERVICE_URL: service.serviceUrl } : {},
            });
        rep = await buildRepeat({ res, task: { id: taskId, prompt, verifiers, targetSkills }, suite, runtime, profileDir, dataDir, expId, repeat, step, pricing, verifyDir, onWarn: (w) => obsWarnings.push(w),
          probes, judge, writeOps, authority });
      } catch (err) {
        rep = { runId: null, C: 0, P: 0, H: 0, activated: false, verifierResults: [], rounds: 0, efficiency: EMPTY_EFFICIENCY, error: String(err) };
      }
      // a clean success is never env-noise; timeout is never env-noise (may be the skill looping)
      if (!rep.error && rep.C === 1) { noise = null; break; }
      noise = res?.timedOut ? null : classifyEnvNoise(noiseText({ res, rep }));
      if (noise && attempt < maxRetries) {
        const backoffMs = baseDelayMs * 2 ** attempt;
        retries.push({ attempt: attempt + 1, signature: noise, backoffMs });
        onProgress({ type: 'repeat-retry', task: taskId, repeat, step, attempt: attempt + 1, signature: noise, backoffMs });
        await sleep(backoffMs);
        continue;
      }
      break;
    }
    // set only when a retry actually happened (absent ≠ [] — no fake channel on clean reps);
    // attached to the FINAL rep whether it recovered or ended excluded (retry-exhausted).
    if (retries.length) rep.retries = retries;
    return { rep, res, noise };
  }

  // multi-step task (S12): sequential invocations sharing one workspace; abort when a step's reward
  // drops below minReward; aggregate into a single repeat rep.
  async function runMultiStep({ task, workspaceDir, verifyDir, repeat }) {
    rmSync(workspaceDir, { recursive: true, force: true }); // clean once for the whole repeat
    const stepReps = [], stepDetail = [];
    let abortedAtStep = null, excludeSig = null, lastRes = null;
    for (let s = 0; s < task.steps.length; s++) {
      const step = task.steps[s];
      const { rep, res, noise } = await attemptInvocation({
        workspaceDir, verifyDir, prompt: resolvePromptVars(step.prompt, suite.vars), verifiers: step.verifiers ?? [],
        targetSkills: step.targetSkills, taskId: task.id, repeat, step: s + 1, cleanWorkspace: false,
      });
      lastRes = res;
      const vr = rep.verifierResults ?? [];
      const reward = vr.length ? vr.filter(r => r.pass).length / vr.length : 1;
      stepReps.push(rep);
      stepDetail.push({ step: s + 1, prompt: step.prompt, reward: round3(reward), C: rep.C, runId: rep.runId ?? null, verifierResults: vr });
      if (noise) { excludeSig = noise; break; }               // persistent env-noise → exclude repeat
      const minReward = step.minReward ?? task.minReward ?? 1;
      if (reward < minReward) { abortedAtStep = s + 1; break; } // gate: don't run the next step
    }
    const ranAll = abortedAtStep == null && excludeSig == null && stepReps.length === task.steps.length;
    const C = ranAll && stepDetail.every(d => d.reward === 1) ? 1 : 0;
    const pVals = stepReps.map(r => r.P).filter(v => v != null);
    const hVals = stepReps.map(r => r.H).filter(v => v != null);
    const actVals = stepReps.map(r => r.activated).filter(v => v != null);
    const sumEff = (pick) => stepReps.reduce((a, r) => a + (pick(r.efficiency ?? {}) ?? 0), 0);
    const rep = {
      runId: stepReps.map(r => r.runId).filter(Boolean).join(',') || null,
      C, P: pVals.length ? round3(mean(pVals)) : null, H: hVals.length ? round3(mean(hVals)) : null,
      activated: actVals.length ? actVals.some(Boolean) : null,
      verifierResults: stepDetail.flatMap(d => d.verifierResults),
      steps: stepDetail, abortedAtStep,
      rounds: stepReps.reduce((a, r) => a + (r.rounds ?? 0), 0),
      model: stepReps.map(r => r.model).find(Boolean) ?? null,
      runtimeVersion: stepReps.map(r => r.runtimeVersion).find(Boolean) ?? null,
      firstRoundContext: stepReps[0]?.firstRoundContext ?? null,
      skillBodyCostEst: stepReps.reduce((a, r) => a + (r.skillBodyCostEst ?? 0), 0) || null,
      efficiency: {
        tokens: {
          in: sumEff(e => e.tokens?.in), out: sumEff(e => e.tokens?.out),
          cacheW: sumEff(e => e.tokens?.cacheW), cacheR: sumEff(e => e.tokens?.cacheR),
        },
        durationMs: sumEff(e => e.durationMs), costUsd: sumEff(e => e.costUsd), wallMs: sumEff(e => e.wallMs),
      },
      resultPreview: stepReps.at(-1)?.resultPreview ?? null,
      error: excludeSig ? (stepReps.at(-1)?.error ?? 'env-noise') : null,
    };
    // Stage 2 (§3): rep-level observability fields aggregate exactly like runtimeVersion —
    // first step that carried the field wins (F-2-06/20 pattern).
    const msInventory = stepReps.map(r => r.skillsInventory).find(Boolean);
    const msRuntimeInfo = stepReps.map(r => r.runtimeInfo).find(Boolean);
    if (msInventory) rep.skillsInventory = msInventory;
    if (msRuntimeInfo) rep.runtimeInfo = msRuntimeInfo;
    const msMetas = stepReps.map(r => r._adapterMeta).filter(Boolean);
    if (msMetas.length) rep._adapterMeta = mergeAdapterMeta(msMetas);
    // taxonomy G-17 前置: retry history flat-merges across steps (step order preserved); the
    // field exists on the aggregate only when at least one step actually retried.
    const msRetries = stepReps.flatMap(r => r.retries ?? []);
    if (msRetries.length) rep.retries = msRetries;
    if (excludeSig) { rep.excluded = true; rep.excludedSignature = excludeSig; }
    return { rep, res: lastRes };
  }

  // [TL-m2] The pool ONLY wraps the outer layer: each (case, repeat) unit still runs through the same
  // attemptInvocation / runMultiStep + writeRepeatLogs + appendJournalRepeat path as before, and each
  // task is still scored by scoreTask. concurrency=1 (the default for a plain `lab run`) makes the
  // single drain loop process units strictly in order — behaviorally identical to the old nested loop.
  // Per-task reps are placed by repeat index so completion order never perturbs scoring (R0.1).
  const repsByTask = new Map(suite.tasks.map(t => [t.id, new Array(repeats)]));

  // Confirm-gate disposition (subsystem 3): after a repeat completes, if the task declares a gate,
  // grade L3 safety over the trace and — on asked-and-halted — let the responder decide + resume.
  //   claude-code : sentinel/end_turn halt detection + `--resume` (via the tested disposeHaltedRepeat).
  //   adapter     : contract v2 — the driver prints { halted:true, ask:{…}, resumeRef }, re-invoke.
  async function applyConfirmGate({ task, rep, res, workspaceDir, verifyDir, repeat }) {
    const mustConfirm = task.mustConfirm ?? task.must_confirm_before;
    if (!mustConfirm || rep?.error || rep?.excluded) return rep;

    if (runtime.type === 'claude-code') {
      const sid = res?.output?.session_id;
      const jsonlPath = sid ? findSessionJsonl(profileDir, sid) : null;
      const run = jsonlPath ? parseSessionJsonl(readFileSync(jsonlPath, 'utf8'), { source: jsonlPath }) : null;
      if (!run) return rep;
      const safety = gradeSafety(run, { must_confirm_before: mustConfirm });
      rep.safetyVerdict = safety.verdict;
      rep.confirmationSignal = safety.confirmationSignal;
      rep.l3Pass = safety.verdict === 'executed-after-confirm'; // upgrade-fidelity L3 (persist existing verdict)
      if (safety.verdict !== 'asked-and-halted') {
        if (safety.verdict === 'executed-after-confirm') rep.flowStatus = 'complete';
        return rep; // executed-without-ask stays as a recorded FAIL signal
      }
      const idx = safety.confirmTurnIndex >= 0 ? safety.confirmTurnIndex : run.rounds.length - 1;
      const decided = await responder.respond({ kind: 'confirm', question: run.rounds[idx]?.text ?? '', danger: task.danger ?? null, trace: run });
      rep.responder = { strategy: decided.strategy, decision: decided.decision, reason: decided.reason };
      if (decided.decision !== 'approve') return markScriptedReplyExcluded(rep, 'responder-denied');
      const disposed = await disposeHaltedRepeat({
        rep, caseObj: { scripted_reply: decided.reply, must_confirm_before: mustConfirm }, safetyVerdict: safety,
        resume: async ({ reply }) => {
          const res2 = await resumeWithScriptedReply({ claude, profileDir, workspaceDir, sessionId: sid, reply,
            model, maxTurns: suite.maxTurns ?? 30, allowedTools: suite.allowedTools ?? [], timeoutMs: suite.timeoutMs ?? 300_000 });
          const rep2 = await buildRepeat({ res: res2, task, suite, runtime, profileDir, dataDir, expId, repeat, pricing, verifyDir,
            onWarn: (w) => obsWarnings.push(w), probes, judge, writeOps, authority });
          const sid2 = res2?.output?.session_id ?? sid;
          const jp2 = sid2 ? findSessionJsonl(profileDir, sid2) : jsonlPath;
          const run2 = jp2 ? parseSessionJsonl(readFileSync(jp2, 'utf8'), { source: jp2 }) : run;
          const safety2 = gradeSafety(run2, { must_confirm_before: mustConfirm });
          rep2.safetyVerdict = safety2.verdict;
          rep2.l3Pass = safety2.verdict === 'executed-after-confirm';
          rep2.responder = rep.responder;
          rep2.flowStatus = 'complete';
          rep2.efficiency = sumEfficiency(rep.efficiency, rep2.efficiency);
          return { verdict: safety2, rep: rep2 };
        },
      });
      return disposed.rep;
    }

    // adapter contract v2 — driver signalled an interactive halt
    if (res?.output?.halted && res.output.ask) {
      const a = res.output.ask;
      const decided = await responder.respond({ kind: 'ask_user', question: a.question, options: a.options, danger: a.danger ?? null });
      rep.responder = { strategy: decided.strategy, decision: decided.decision, reason: decided.reason };
      if (decided.decision !== 'approve') return markScriptedReplyExcluded(rep, 'responder-denied');
      const res2 = await runCommandAdapter({ runtime, workspaceDir, prompt: decided.reply, model,
        timeoutMs: suite.timeoutMs ?? 300_000, suiteDir,
        extraEnv: { ...(service ? { AIIDE_SERVICE_URL: service.serviceUrl } : {}),
          AIIDE_RESUME: String(res.output.resumeRef ?? '1'), AIIDE_REPLY: decided.reply } });
      const rep2 = await buildRepeat({ res: res2, task, suite, runtime, profileDir, dataDir, expId, repeat, pricing, verifyDir,
        onWarn: (w) => obsWarnings.push(w), probes, judge, writeOps, authority });
      rep2.responder = rep.responder;
      rep2.flowStatus = 'complete';
      rep2.l3Pass = true; // adapter confirm-gate: approved → resumed = confirmed-before-executing
      return rep2;
    }
    return rep;
  }

  // one (case, repeat) unit: R0.1.2 gives each a unique workspace subdir (arm-tagged when present).
  async function executeUnit({ task, repeat: i }) {
    onProgress({ type: 'repeat-start', task: task.id, repeat: i, of: repeats });
    const armTag = arm ? '-' + fsSafe(arm.label) : '';
    const workspaceDir = join(dataDir, 'workspaces', expId, `${task.id}-r${i}${armTag}`);
    // Part A: resolve {{VAR}} placeholders (suite.vars / AIIDE_VAR_*) before the prompt reaches either
    // runtime — an unresolved var is fatal (fail-fast). Reserved runtime-arg tokens are left alone.
    const prompt = resolvePromptVars(task.prompt, suite.vars);
    // effective dir file_exists verifiers resolve against (adapters.md:26: cwd omitted = workspace)
    const verifyDir = runtime.type === 'claude-code' || !runtime.cwd ? workspaceDir
      : String(runtime.cwd).replaceAll('{{PROMPT}}', prompt ?? '').replaceAll('{{MODEL}}', model ?? '').replaceAll('{{SUITE_DIR}}', suiteDir);
    let rep, res;
    try {
      if (Array.isArray(task.steps) && task.steps.length) {
        ({ rep, res } = await runMultiStep({ task, workspaceDir, verifyDir, repeat: i }));
      } else {
        const r = await attemptInvocation({
          workspaceDir, verifyDir, prompt, verifiers: task.verifiers ?? [],
          targetSkills: task.targetSkills, taskId: task.id, repeat: i, cleanWorkspace: true,
        });
        res = r.res;
        rep = r.noise ? { ...r.rep, excluded: true, excludedSignature: r.noise } : r.rep;
        rep = await applyConfirmGate({ task, rep, res, workspaceDir, verifyDir, repeat: i });
      }
    } catch (err) {
      // R0.1.3: a wholly unexpected throw in one unit is recorded as a failed repeat, never propagated
      // to abort the pool — the other units still run.
      rep = { runId: null, C: 0, P: 0, H: 0, activated: false, verifierResults: [], rounds: 0, efficiency: EMPTY_EFFICIENCY, error: String(err) };
    }
    writeRepeatLogs({ dataDir, resumeKey, taskId: task.id, repeat: i, res, rep });
    appendJournalRepeat(journalPath, task.id, i, rep); // appendFileSync is atomic under concurrency
    repsByTask.get(task.id)[i - 1] = rep;
    onProgress({ type: 'repeat-done', task: task.id, repeat: i, C: rep.C, error: rep.error, excluded: rep.excluded === true, signature: rep.excludedSignature ?? null, abortedAtStep: rep.abortedAtStep ?? null });
  }

  try {
    // pre-pass: place cached repeats deterministically (in order); collect the rest as pool units
    const pending = [];
    for (const task of suite.tasks) {
      for (let i = 1; i <= repeats; i++) {
        const cached = completed.get(`${task.id}::${i}`);
        if (cached) {
          onProgress({ type: 'repeat-start', task: task.id, repeat: i, of: repeats });
          repsByTask.get(task.id)[i - 1] = cached;
          onProgress({ type: 'repeat-done', task: task.id, repeat: i, C: cached.C, error: cached.error, cached: true });
        } else {
          pending.push({ task, repeat: i });
        }
      }
    }
    await runPool(pending, concurrency, executeUnit);
    // ── Stage 2 seal hoist (adapter-observability §1/§3/§5.1) ─────────────────────────────
    // MUST run BEFORE scoreTask/buildExpStats consume the reps: it hoists the rep-level
    // observability fields into experiment.environment, computes observedSignals + driftDigest
    // (all three at the same point, pre-strip — the flags read exactly the fields about to be
    // stripped), reconciles the raw adapter output, THEN replaces every rep with a stripped copy
    // so the sealed archive carries no per-rep duplicates. Journal rows (already appended at
    // repeat time) keep the originals, so a resume never loses the signals.
    sealRepObservability({
      suite, repeats, repsByTask, environment, runtime,
      runsDir: join(dataDir, 'runs'), warnings: obsWarnings,
    });
    for (const task of suite.tasks) {
      tasks[task.id] = { prompt: task.prompt, ...scoreTask(repsByTask.get(task.id), suite.passK) };
      // §2.2-6: persist the suite-level case attributes into the sealed experiment (additive — old
      // callers unaffected). The stats engine and `aiide stats` backfill both depend on these three.
      tasks[task.id].held_out = task.held_out === true;
      tasks[task.id].category = task.category ?? null;
      tasks[task.id].expected_skill = expectedSkillOf(task);
    }
  } finally {
    service?.stop();
  }

  const allReps = Object.values(tasks).flatMap(t => t.repeats);
  const firstCtx = allReps.map(r => r.firstRoundContext).filter(x => x > 0);
  const bodyCosts = allReps.map(r => r.skillBodyCostEst).filter(x => x > 0);
  // observed models come from actual traces; runtimeVersion backfills from run logs / adapter reports
  environment.model.observed = [...new Set(allReps.map(r => r.model).filter(Boolean))];
  if (environment.runtimeVersion == null) {
    environment.runtimeVersion = allReps.map(r => r.runtimeVersion).find(Boolean) ?? null;
  }
  const expWarnings = [...metaWarnings, ...new Set(obsWarnings)];
  if (modelMismatch(environment.model.requested, environment.model.observed)) {
    expWarnings.push(`modelMismatch: requested ${environment.model.requested}, observed ${environment.model.observed.join(', ')}`);
  }

  // ── seal-time experiment stats (design §2) ────────────────────────────────────────────────
  // Collected HERE, at seal, over the FINAL reps and by loading runs/<id>.json from DISK. This is
  // the load-bearing choice: a journal-CACHED rep never re-runs buildRepeat this invocation, but
  // its runs/*.json survives on disk from the earlier attempt, so the disk loader still counts it
  // in nCoverageValid. Moving collection into buildRepeat would silently drop every cached rep on a
  // resumed run. Both probe-load and stats failures DEGRADE (warning) — a paid suite run is never
  // lost to a stats bug (design §2.3).
  let stats;
  try {
    // reuse the probes loaded at run start (subsystem 1 setup); any load failure was already warned.
    const tasksForStats = {};
    for (const task of suite.tasks) {
      tasksForStats[task.id] = {
        reps: repsByTask.get(task.id) ?? [],
        held_out: task.held_out === true,
        category: task.category ?? null,
        expected_skill: expectedSkillOf(task),
      };
    }
    // ref inventory snapshot NOW (per skill, with versionSha; §S v2 加 refMeta bytes/tokensEst) —
    // the engine never reads a live profileDir. External runtimes have no snapshot; when the
    // adapter DECLARED an inventory (hoisted to environment.skillsInventory at seal, §3), it
    // becomes the refCoverage denominator with inventoryStatus 'adapter-declared'; otherwise
    // 'external-runtime'（engine 端 bySkill=null，不可知非空集）。refMeta stays null for declared
    // inventories — bytes are unknowable (§7: no declared refMeta). Stage 3: refCoverage has the
    // explicit 'adapter-declared' branch (top-level refMeta:null, per-row bytes:null +
    // reason:'adapter-declared'; unknown statuses degrade explicitly — no snapshot fall-through).
    const declaredInventory = runtime.type !== 'claude-code'
      ? toRefInventory(environment.skillsInventory) : null;
    const snapshot = runtime.type === 'claude-code'
      ? snapshotRefInventory(profileDir, installedSkills)
      : { inventory: declaredInventory ?? {}, refMeta: null };
    // adapter-declared inventory IS the runtime's install set: without this fallback an adapter
    // suite with no skills.dirs seals installed=0 and trigger coverage renders "1/0" (ratio is
    // null per null-not-zero, but the x/y copy still misleads). Static skillDirs listing wins.
    const statsInstalledSkills = installedSkills.length === 0 && declaredInventory
      ? Object.keys(declaredInventory).sort() : installedSkills;
    stats = buildExpStats({
      tasks: tasksForStats, runsDir: join(dataDir, 'runs'),
      installedSkills: statsInstalledSkills, refInventory: snapshot.inventory, refMeta: snapshot.refMeta,
      inventoryStatus: runtime.type === 'claude-code' ? 'snapshot'
        : declaredInventory ? 'adapter-declared' : 'external-runtime',
      probes, config: UPGRADE_CONFIG,
      // taxonomy T1 Stage 3 (§3.0 gates): same runtime string the sealed experiment carries —
      // the v3 claude-code-only sections (contextComposition/sidechainShare) gate on it.
      runtime: runtime.type === 'claude-code' ? 'claude-code' : (runtime.name ?? runtime.cmd),
    });
  } catch (e) {
    stats = { error: String(e?.message ?? e) };
    expWarnings.push(`stats computation failed: ${e?.message ?? e} — experiment sealed without stats`);
  }

  const experiment = {
    id: expId, suiteName: suite.name, model, repeats,
    environment, meta, captured, warnings: expWarnings,
    runtime: runtime.type === 'claude-code' ? 'claude-code' : (runtime.name ?? runtime.cmd),
    service: service ? service.meta : null,
    createdAt: new Date().toISOString(),
    profile: { dir: profileDir, skills: installedSkills },
    isolationVerified: isolation.ok,
    // R0.2.3: arm identity (+ mix mapping for mixed arms) travels with the experiment for [U4]/[U7]
    ...(arm ? { arm: armMetadata({ ...arm, model }, { isolation: isolation.ok, harnessVersion: environment.aiideVersion }) } : {}),
    contextInsights: {
      skillListing,
      listingTotalTokensEst: skillListing.reduce((a, s) => a + s.listingTokensEst, 0),
      meanFirstRoundContext: firstCtx.length ? Math.round(firstCtx.reduce((a, b) => a + b, 0) / firstCtx.length) : null,
      meanSkillBodyCostEst: bodyCosts.length ? Math.round(bodyCosts.reduce((a, b) => a + b, 0) / bodyCosts.length) : null,
    },
    tasks, summary: scoreExperiment(tasks),
    stats,
  };
  writeFileSync(join(dataDir, 'experiments', `${expId}.json`), JSON.stringify(experiment, null, 2));
  // sealed → the "in progress" journal has served its purpose. If sealing above threw, the journal
  // stays on disk (crash-safe): a re-run resumes instead of losing completed repeats.
  try { unlinkSync(journalPath); } catch { /* already gone */ }
  // drop the .inprogress subdir when empty so it never shows up beside sealed experiments
  try { rmdirSync(journalDir(dataDir)); } catch { /* non-empty (another suite mid-run) or gone */ }
  return experiment;
}

/**
 * Run one arm of an upgrade comparison (R0.1/R0.2/R0.3). Thin wrapper over runSuite that pins the
 * arm identity (→ arm-scoped resumeKey/journal/workspaces) and opens the bounded pool at the config
 * concurrency (default 6). Preflight `assertArmVersion` fail-fasts BEFORE any session when the arm
 * carries a cliVersion (R0.2.2). `versionExec` is injectable for tests. Everything else is runSuite.
 */
export async function runArm(arm, {
  suite, suiteDir = '.', suitePath = null, dataDir, pricing, cliMeta = [], fresh = false,
  onProgress = () => {}, concurrency = UPGRADE_CONFIG.concurrency.default, versionExec,
} = {}) {
  if (arm?.cliVersion) assertArmVersion(arm, versionExec ? { exec: versionExec } : {});
  return runSuite({ suite, suiteDir, suitePath, dataDir, pricing, cliMeta, fresh, onProgress, arm, concurrency });
}

async function buildRepeat({ res, task, suite, runtime = { type: 'claude-code' }, profileDir, dataDir, expId, repeat, step = null, pricing, verifyDir = '.', onWarn = () => {},
  probes = [], judge = null, writeOps = [], authority = 'deterministic' }) {
  // Stage 2 (§3/§4): adapter self-description context. null for claude-code — skills_inventory /
  // runtime_info are adapter-schema fields and the reconciliation lints only apply to adapters.
  const obsCtx = runtime.type !== 'claude-code' ? { dataDir, warn: onWarn } : null;
  // taxonomy G-17 前置: structured timeout flag — statsHealth timeoutRate must never regress to
  // matching the error string. The error string itself stays as-is (backward compatible).
  if (res.timedOut) return attachAdapterObservability({ ...failedRepeat('timeout', res), timedOut: true }, res, obsCtx);
  if (!res.output) return failedRepeat(`runtime exited ${res.exitCode}: ${truncate(res.stderr || res.stdout, 400)}`, res);

  const resultText = res.output.result ?? '';
  let run = null, metrics = null;

  if (runtime.type === 'claude-code') {
    const sessionId = res.output.session_id ?? null;
    const jsonlPath = sessionId ? findSessionJsonl(profileDir, sessionId) : null;
    if (jsonlPath) run = parseSessionJsonl(readFileSync(jsonlPath, 'utf8'), { source: jsonlPath });
  } else if (Array.isArray(res.output.trace) && res.output.trace.length) {
    // step-qualified id: a multi-step repeat runs one adapter invocation PER STEP — without the
    // -s suffix every step would overwrite the same runs/<id>.json (single-step ids unchanged)
    run = buildRunFromTrace(res.output.trace, {
      model: suite.model ?? null,
      id: `${expId}-${task.id}-r${repeat}${step != null ? `-s${step}` : ''}`,
    });
  }

  if (run) {
    run.meta = { experimentId: expId, taskId: task.id, repeat };
    if (run.prompt == null) run.prompt = task.prompt;
    metrics = computeRunMetrics(run, { pricing });
    writeFileSync(join(dataDir, 'runs', `${run.id}.json`), JSON.stringify({ run, metrics }, null, 2));
  }

  const verifiers = task.verifiers ?? [];
  const targetSkills = task.targetSkills ?? suite.targetSkills ?? [];

  // subsystem 1/2: probe invocations (trace graders) + precomputed judged verdicts (the ONLY async
  // step in scoring — kept here, out of the pure synchronous scoreRepeat).
  const probeInvocations = run ? probes.flatMap(p => extractInvocations(run, p)) : undefined;
  let judgeVerdicts = {};
  if (judge) {
    const judgedChecks = verifiers.filter(v => graderClass(v.type) === 'judged');
    if (judgedChecks.length) {
      const traceSummary = (judge.config.evidence ?? []).includes('trace') ? summarizeTrace(run, probeInvocations) : '';
      judgeVerdicts = await judge.grade(judgedChecks, { question: run?.prompt ?? task.prompt, answer: resultText, traceSummary });
    }
  }

  if (!run) {
    // no trace/log available — completion-only scoring; P/H/activation excluded, not zeroed.
    // no-trace + self-descriptor is a legal combination (§3): the observability fields attach here too.
    const ctx = { text: resultText, workspaceDir: verifyDir, probeInvocations, run: null, judgeVerdicts, writeOps };
    const verifierResults = verifiers.map(v => evalVerifier(v, ctx));
    const { C, cDeterministic, cJudged, gradingAuthority } = gateC(verifierResults, authority);
    return attachAdapterObservability({
      runId: null,
      C, cDeterministic, cJudged, gradingAuthority,
      P: null, H: null, activated: null, verifierResults,
      model: null, runtimeVersion: res.output.runtime_version ?? null,
      rounds: 0, firstRoundContext: null, skillBodyCostEst: null,
      efficiency: { ...EMPTY_EFFICIENCY, wallMs: res.wallMs, ...(typeof res.output.total_cost_usd === 'number' ? { costUsdReported: res.output.total_cost_usd } : {}) },
      warning: 'no trace/session log — process metrics unavailable (completion-only)',
      error: null, resultPreview: truncate(resultText, 600),
    }, res, obsCtx);
  }

  const rep = scoreRepeat({ run, metrics, resultText, verifiers, targetSkills, maxTurns: suite.maxTurns ?? 30, workspaceDir: verifyDir,
    probeInvocations, judgeVerdicts, writeOps, authority });
  // environment observations: actual model from the trace; runtime version from adapter
  // self-report (runtime_version) or the session log's version field
  rep.model = run.model ?? null;
  rep.runtimeVersion = res.output.runtime_version ?? run.version ?? null;
  // context insights: what the first request already carries + what triggered skill bodies cost
  rep.firstRoundContext = run.rounds[0]?.contextFootprint ?? null;
  // U2 handoff: skill-body context cost is the hung-back SKILL.md body (chars/4), NOT the 28-char
  // "Launching skill" tool_result the old inline math measured. Single source is parser.skillBodyCostEst.
  rep.skillBodyCostEst = skillBodyCostEst(run);
  // Upgrade-fidelity L1: per-repeat routing verdict, so a dynamic arm (experimentToArm) carries a real
  // L1 axis without re-running `aiide upgrade`. Additive — never touches C/P/H. null when the task
  // declares no expected skill (nothing to route-check) or a permission artifact blocked it.
  const expSkill = expectedSkillOf(task);
  if (expSkill != null) {
    const routing = gradeRouting(run, { expected_skill: expSkill, allowed_auxiliary: task.allowed_auxiliary ?? [] });
    rep.routing = routing;
    rep.l1Pass = routing === 'permission-artifact' ? null : routing === 'correct';
  }
  // prefer runtime-reported real cost over our estimate when available
  if (typeof res.output.total_cost_usd === 'number') rep.efficiency.costUsdReported = res.output.total_cost_usd;
  rep.efficiency.wallMs = res.wallMs;
  rep.resultPreview = truncate(resultText, 600);
  return attachAdapterObservability(rep, res, obsCtx);
}

function failedRepeat(error, res) {
  return {
    runId: null, C: 0, P: 0, H: 0, activated: false, verifierResults: [],
    rounds: 0, efficiency: { ...EMPTY_EFFICIENCY, wallMs: res?.wallMs ?? 0 },
    error, resultPreview: truncate(res?.stdout ?? '', 200),
  };
}

function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }

// ══ Stage 2: adapter observability — rep-level persistence + seal chain ═══════════════════════
// (docs/adapter-observability-design.md v6 §1 observedSignals / §3 persistence + inventoryStatus /
//  §4 runtime_info / §5.1 seal reconciliation)

/**
 * Attach the adapter self-description signals to a repeat whenever `res.output` exists (§3):
 *   rep.skillsInventory — raw `skills_inventory` verbatim (the seal hoist archives ONE copy);
 *   rep.runtimeInfo     — `runtime_info` in FINGERPRINT form (§4, full prompt text never on the rep);
 *   rep._adapterMeta    — raw-output shape evidence for the §5.1 seal reconciliation (key sets,
 *                         observability self-declaration, per-round declared triggers/refReads).
 * All three ride the journal line verbatim (resume keeps them) and are stripped from the reps at
 * seal AFTER hoist/observedSignals/driftDigest are computed. ctx is null for claude-code (no-op).
 */
function attachAdapterObservability(rep, res, ctx) {
  const out = res?.output;
  if (!ctx || !out || typeof out !== 'object') return rep;
  if (out.skills_inventory != null && typeof out.skills_inventory === 'object') {
    rep.skillsInventory = out.skills_inventory;
  }
  const fingerprint = buildRuntimeInfoFingerprint(out.runtime_info, ctx);
  if (fingerprint) rep.runtimeInfo = fingerprint;
  rep._adapterMeta = collectAdapterMeta(out);
  return rep;
}

/**
 * §4 runtime_info → fingerprint. Fingerprint-first: name/version/tools/defaults pass through.
 * `systemPromptText` present → aiide RECOMPUTES sha256/bytes/tokensEstCJK (overriding any
 * self-reported figures — verifiable beats declared) and persists the full text content-addressed
 * under <dataDir>/logs/runtime-info/system-prompt-<sha256[0..12)>.txt: idempotent for identical
 * content (concurrency/repeat/resume safe), drift keeps every version, a 12-hex prefix collision
 * falls back to a 16-hex name + warning. The rep/experiment stores the FULL sha256 (file name
 * prefix is just the path). Text absent → the self-reported fingerprint is kept, flagged
 * selfReported:true (unverifiable, disclosed).
 */
function buildRuntimeInfoFingerprint(raw, { dataDir, warn = () => {} } = {}) {
  if (raw == null || typeof raw !== 'object') return null;
  const fp = {
    name: raw.name ?? null,
    version: raw.version ?? null,
    systemPrompt: null,
    tools: raw.tools ?? null,
    defaults: raw.defaults ?? null,
  };
  const text = typeof raw.systemPromptText === 'string' ? raw.systemPromptText : null;
  if (text != null) {
    const buf = Buffer.from(text, 'utf8');
    const sha = createHash('sha256').update(buf).digest('hex');
    fp.systemPrompt = { sha256: sha, bytes: buf.length, tokensEst: tokensEstCJK(text), textCaptured: true };
    try {
      const dir = join(dataDir, 'logs', 'runtime-info');
      mkdirSync(dir, { recursive: true });
      const shortPath = join(dir, `system-prompt-${sha.slice(0, 12)}.txt`);
      const existingSha = existsSync(shortPath)
        ? createHash('sha256').update(readFileSync(shortPath)).digest('hex') : null;
      if (existingSha === null) {
        writeFileSync(shortPath, buf);
      } else if (existingSha !== sha) {
        // 12-hex prefix collision (different content, same prefix) → longer name + disclosure
        warn(`runtime-info system prompt sha256 prefix collision at ${sha.slice(0, 12)} — stored under 16-hex name`);
        const longPath = join(dir, `system-prompt-${sha.slice(0, 16)}.txt`);
        if (!existsSync(longPath)) writeFileSync(longPath, buf);
      } // identical content → idempotent skip (content-addressed)
    } catch (e) {
      warn(`runtime-info system prompt persistence failed: ${e?.message ?? e}`);
    }
  } else if (raw.systemPrompt != null && typeof raw.systemPrompt === 'object') {
    fp.systemPrompt = {
      sha256: raw.systemPrompt.sha256 ?? null,
      bytes: raw.systemPrompt.bytes ?? null,
      tokensEst: raw.systemPrompt.tokensEst ?? null,
      selfReported: true, // no full text given → figures unverifiable, honestly flagged
    };
  }
  return fp;
}

// collectAdapterMeta moved to src/adaptercheck.js (shared shape-evidence collector — the seal
// reconciliation and `aiide adapter check` walk the raw output identically).

/** Multi-step _adapterMeta merge: unions of key sets, concatenated declarations (step order kept). */
function mergeAdapterMeta(metas) {
  const union = (pick) => [...new Set(metas.flatMap((m) => pick(m) ?? []))].sort();
  const merged = {
    topKeys: union((m) => m.topKeys),
    roundKeys: union((m) => m.roundKeys),
    toolCallKeys: union((m) => m.toolCallKeys),
    declaredTriggersByRound: metas.flatMap((m) => m.declaredTriggersByRound ?? []),
    declaredRefReads: metas.flatMap((m) => m.declaredRefReads ?? []),
  };
  const obs = union((m) => m.observability);
  if (metas.some((m) => Array.isArray(m.observability))) merged.observability = obs;
  return merged;
}

// toRefInventory moved to expstats.js (Stage 3): the seal path and the `aiide stats` backfill
// (resolveBackfillInventory) share one conversion so the two callers can never drift.

const sha256Json = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * §3 seal hoist + §1 observedSignals + §5.1 reconciliation, all at ONE point BEFORE the strip
 * (the flags read exactly the fields the strip removes — any other order forges false negatives).
 * Iteration order is FIXED: suite.tasks × repeat index — never completion order. Hoist and the
 * rep-level flags consider only non-excluded reps ("non-excluded reps" denominator, F-3-11);
 * signals carried ONLY by excluded reps are disclosed as a warning, never hoisted (unknowable ≠ 0).
 * Finally every rep in repsByTask is replaced by a NEW object without the observability fields
 * (never an in-place delete — the original rep references are shared with the journal writer and
 * any other reader).
 */
function sealRepObservability({ suite, repeats, repsByTask, environment, runtime, runsDir, warnings }) {
  const isClaudeCode = runtime.type === 'claude-code';

  const ordered = []; // fixed iteration order: suite.tasks × repeat
  for (const task of suite.tasks) {
    const arr = repsByTask.get(task.id) ?? [];
    for (let i = 0; i < repeats; i++) if (arr[i] != null) ordered.push(arr[i]);
  }
  const nonExcluded = ordered.filter((r) => r.excluded !== true);
  const excluded = ordered.filter((r) => r.excluded === true);

  const hasInventory = (r) => r.skillsInventory != null && typeof r.skillsInventory === 'object'
    && Object.keys(r.skillsInventory).length > 0;
  const hasRuntimeInfo = (r) => r.runtimeInfo != null;

  // hoist + driftDigest (per field: first non-empty carrier archives; sha list enables mechanical
  // re-verification after the journal is gone, F-3-09)
  const invCarriers = nonExcluded.filter(hasInventory);
  if (invCarriers.length) {
    environment.skillsInventory = invCarriers[0].skillsInventory;
    const digests = invCarriers.map((r) => sha256Json(r.skillsInventory));
    environment.skillsInventoryDrift = { digests };
    if (new Set(digests).size > 1) warnings.push('skills_inventory drift across repeats');
  } else if (excluded.some(hasInventory)) {
    warnings.push('skills_inventory present only on excluded repeats — not hoisted (unknowable, not zero)');
  }
  const riCarriers = nonExcluded.filter(hasRuntimeInfo);
  if (riCarriers.length) {
    environment.runtimeInfo = riCarriers[0].runtimeInfo;
    const digests = riCarriers.map((r) => sha256Json(r.runtimeInfo));
    environment.runtimeInfoDrift = { digests };
    if (new Set(digests).size > 1) warnings.push('runtime_info drift across repeats');
  } else if (excluded.some(hasRuntimeInfo)) {
    warnings.push('runtime_info present only on excluded repeats — not hoisted (unknowable, not zero)');
  }

  // run-level quantifiers over the coverage-valid runs (resolveReps valid bucket flatMap, F-3-12).
  // resolveReps throw, or every runId-bearing rep unloadable → null (unknowable), NEVER 0.
  let validRuns = null;
  try {
    const shape = {};
    for (const task of suite.tasks) {
      shape[task.id] = { reps: repsByTask.get(task.id) ?? [], held_out: task.held_out === true };
    }
    const { buckets, counts } = resolveReps(shape, runsDir);
    validRuns = counts.nCoverageValid === 0 && counts.nUnresolved > 0
      ? null : buckets.valid.flatMap((v) => v.runs);
  } catch { validRuns = null; }

  // §1 observedSignals — quantifier table verbatim. claude-code counts OBSERVED events (capability
  // a-priori known); adapters count CHANNEL PRESENCE (explicit key, [] included — absent ≠ []).
  const signals = {
    trace: null, usage: null, triggers: null, refReads: null,
    inventory: isClaudeCode ? true : nonExcluded.some(hasInventory),
    runtimeInfo: isClaudeCode
      ? (environment.runtimeVersion != null || nonExcluded.some((r) => r.runtimeVersion != null))
      : nonExcluded.some(hasRuntimeInfo),
  };
  if (validRuns) {
    const count = (pred) => validRuns.filter(pred).length;
    if (isClaudeCode) {
      signals.trace = count((run) => run.id != null);
      signals.usage = 'a-priori'; // parser keeps a zero skeleton → per-run counting is meaningless (F-4-04)
      signals.triggers = count((run) => (run.rounds ?? []).some(
        (rd) => (rd.toolCalls ?? []).some((tc) => tc.name === 'Skill'))); // main rounds only (F-4-09)
      signals.refReads = count((run) => (run.rounds ?? []).some(
        (rd) => (rd.toolCalls ?? []).some((tc) => tc.name === 'Read' && attributeRead(tc) != null)));
    } else {
      signals.trace = count((run) => run.source === 'adapter-trace' && (run.rounds ?? []).length > 0);
      signals.usage = count((run) => (run.rounds ?? []).some((rd) => rd.usage != null));
      signals.triggers = count((run) => (run.rounds ?? []).some((rd) => 'declaredTriggers' in rd));
      signals.refReads = count((run) => (run.rounds ?? []).some((rd) => 'declaredRefReads' in rd));
    }
  }
  environment.observedSignals = signals;

  if (!isClaudeCode) {
    reconcileAdapterOutput({
      suite, nonExcluded, validRuns,
      inventory: environment.skillsInventory ?? null, warnings,
    });
  }

  // strip: map NEW rep objects without the observability fields — the sealed archive carries the
  // single environment copy only; journal rows (already written) keep the per-rep originals.
  for (const [taskId, arr] of repsByTask) {
    repsByTask.set(taskId, arr.map((rep) => {
      if (rep == null) return rep;
      const { skillsInventory, runtimeInfo, _adapterMeta, ...rest } = rep;
      return rest;
    }));
  }
}

// §5.1/§5.2 known key sets, near-miss targets and editDistance moved to src/adaptercheck.js —
// the ONE source `aiide adapter check` and this seal reconciliation both import (never drift).

/**
 * §5.1 seal reconciliation — ALL experiment-warning level (the anti-forgery honesty clause works by
 * disclosure, never by rejection):
 *   declared-but-silent — observability self-declared a channel yet NO valid run carried its key.
 *     warning when the suite has skill targets, 'info: ' prefixed otherwise. Skipped entirely when
 *     there are no valid runs (silence would be unknowable, not evidence).
 *   near-miss keys     — unknown keys within edit distance ≤ 2 of the known optional key set
 *     (typo'd 'trigers' silently loses a whole channel). `x_` prefix is the sanctioned custom
 *     namespace — exempt; purely unknown keys stay silent.
 *   plausibility lints — inventory is the denominator; inventory absent → the WHOLE group is
 *     skipped (unknowable is never treated as zero, F-2-08/25).
 */
function reconcileAdapterOutput({ suite, nonExcluded, validRuns, inventory, warnings }) {
  const found = new Set(); // dedupe across reps, insertion-ordered (deterministic rep order)

  // declared-but-silent (two tiers)
  const declaredTokens = new Set();
  for (const r of nonExcluded) for (const tok of r._adapterMeta?.observability ?? []) declaredTokens.add(tok);
  if (validRuns && validRuns.length) {
    const hasTargets = (suite.targetSkills?.length ?? 0) > 0 || suite.tasks.some((t) =>
      t.expected_skill || (Array.isArray(t.targetSkills) && t.targetSkills.length)
      || (Array.isArray(t.steps) && t.steps.some((s) => Array.isArray(s.targetSkills) && s.targetSkills.length)));
    for (const [token, roundKey] of [['triggers', 'declaredTriggers'], ['refReads', 'declaredRefReads']]) {
      if (!declaredTokens.has(token)) continue;
      const seen = validRuns.some((run) => (run.rounds ?? []).some((rd) => roundKey in rd));
      if (!seen) {
        const msg = `adapter declared '${token}' in observability but no valid run carried the channel (declared-but-silent)`;
        found.add(hasTargets ? msg : `info: ${msg}`);
      }
    }
  }

  // near-miss keys — shared implementation with `aiide adapter check` (src/adaptercheck.js)
  for (const r of nonExcluded) {
    const meta = r._adapterMeta;
    if (!meta) continue;
    for (const w of nearMissKeyWarnings(meta)) found.add(w);
  }

  // plausibility lints — inventory as denominator, absent → whole group skipped
  if (inventory && Object.keys(inventory).length) {
    const skillKeys = new Set(Object.keys(inventory));
    for (const r of nonExcluded) {
      for (const trigs of r._adapterMeta?.declaredTriggersByRound ?? []) {
        for (const t of trigs) {
          if (!skillKeys.has(t)) found.add(`declared trigger '${t}' not in skills_inventory`);
        }
        if (trigs.length > skillKeys.size) {
          found.add(`one round declared ${trigs.length} triggers but skills_inventory has ${skillKeys.size} skills (implausible)`);
        }
      }
      for (const rr of r._adapterMeta?.declaredRefReads ?? []) {
        if (rr.skill && typeof rr.ref === 'string' && !rr.ref.startsWith(`${rr.skill}/`)) {
          found.add(`declared refRead '${rr.ref}' does not match its skill '${rr.skill}' prefix`);
        }
      }
    }
    // inventory prefix lint (check = fatal is `adapter check`'s job; seal discloses as warning)
    for (const [skill, entry] of Object.entries(inventory)) {
      for (const ref of entry?.refs ?? []) {
        if (typeof ref !== 'string' || !ref.startsWith(`${skill}/references/`)) {
          found.add(`skills_inventory ref '${ref}' does not start with '${skill}/references/'`);
        }
      }
    }
  }

  for (const w of found) warnings.push(w);
}

// The single expected/target skill for a case: explicit `expected_skill` wins, else the first
// `targetSkills` entry (the primary), else null. triggerRate (M1) is keyed on this per §2.2-6.
function expectedSkillOf(task) {
  if (task?.expected_skill) return task.expected_skill;
  const ts = task?.targetSkills;
  return Array.isArray(ts) && ts.length ? ts[0] : null;
}

// Snapshot the reference inventory of an isolated profile at SEAL time (design §2.2-6/§2.3/§S v2):
// returns { inventory, refMeta } —
//   inventory: per skill → { versionSha, refs:[logicalRef] }. logicalRef mirrors
//     depgraph.attributeRead exactly (`<skill>/references/<relpath>`), so refCoverage can match
//     shipped refs to reads. versionSha is the sha256 of the skill's SKILL.md (no separate
//     content-sha is captured in lab metadata).
//   refMeta (§S v2): { [logicalRef]: { bytes, tokensEst } } — key 僅明文路徑 logicalRef。_shared
//     檔的運行期 logicalRef 帶 read-result md5（`_shared/<suffix>#<md5>`，seal 時不可重現）→ 不入
//     refMeta（engine 端該 refs 行 bytes=null + reason:'shared-hash-namespace'）；不改 attributeRead
//     的 canonical 雜湊行為。tokensEst = tokensEstCJK（標 estimate）；bytes 為主數字。
// The stats engine NEVER walks profileDir itself — this snapshot is the only bridge.
export function snapshotRefInventory(profileDir, installedSkills = []) {
  const inventory = {};
  const refMeta = {};
  if (!profileDir) return { inventory, refMeta };
  const skillsRoot = join(profileDir, 'skills');
  for (const skill of installedSkills) {
    const skillDir = join(skillsRoot, skill);
    let versionSha = null;
    try { versionSha = createHash('sha256').update(readFileSync(join(skillDir, 'SKILL.md'))).digest('hex'); }
    catch { /* skill without SKILL.md → versionSha stays null */ }
    const refs = [];
    const walk = (dir, prefix) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(join(dir, e.name), rel); continue; }
        const logicalRef = `${skill}/references/${rel}`;
        refs.push(logicalRef);
        if (/(?:^|\/)_shared\//.test(rel)) continue; // md5 namespace，seal 不可重現 → 不入 refMeta
        try {
          const buf = readFileSync(join(dir, e.name));
          refMeta[logicalRef] = { bytes: buf.length, tokensEst: tokensEstCJK(buf.toString('utf8')) };
        } catch { /* 讀不到 → 無 meta（下游 bytes=null，null-not-zero） */ }
      }
    };
    walk(join(skillDir, 'references'), '');
    inventory[skill] = { versionSha, refs: refs.sort() };
  }
  return { inventory, refMeta };
}

// §S v2 tokensEst（CJK-aware，標 estimate）：以解碼字元（code point）計，CJK 字元 ×1 + 其餘字元 ÷4，
// 向上取整。CJK 範圍釘死為：U+4E00-9FFF（一-鿿）、U+3400-4DBF（㐀-䶿 擴展A）、U+3000-303F（　-〿
// CJK 標點）、U+FF00-FFEF（＀-￯ 全形標點）。用途唯一：depgraph split/inline/merge 機會訊號的收益
// 量化（B2）——不做 costTable/wastedTokens。
const CJK_CHAR_RE = /[　-〿㐀-䶿一-鿿＀-￯]/;
export function tokensEstCJK(text) {
  let cjk = 0, other = 0;
  for (const ch of String(text ?? '')) { if (CJK_CHAR_RE.test(ch)) cjk++; else other++; }
  return cjk + Math.ceil(other / 4);
}

// ── probeBlocks for the upgrade report (design §2.4) ──────────────────────────────────────────
// Assemble the report-side probe presentation from arm-labeled depgraph sessions that carry a cliSet
// (each session = one run: { arm, caseId, excluded?, triggerSet, triggerEvents?, readEvents?,
// cliSet:[{tool,cmd,ordinal}] }). Returns null when the signal is absent — no probes, or no session
// carries any probe invocation — which is exactly the current pre-cliSet fixture. Per-arm probe stats
// come from expstats.cliStats over that arm's valid (non-excluded) case unions; per-arm proximity from
// proximityMatrix over its valid run event timelines. `paired` reports the block's OWN case-level
// exclusion rate and trips the F1 wire when it exceeds probes.blockExclusionTripwirePct;
// `excludedProbeHits` surfaces probe activity inside dropped runs (the "new arm spams the tool then
// halts" reversal the pairing discipline would otherwise wash out).
export function buildProbeBlocks({ sessions = [], probes = [], config = UPGRADE_CONFIG } = {}) {
  if (!Array.isArray(sessions) || !sessions.length) return null;
  const anyCli = sessions.some((s) => Array.isArray(s.cliSet) && s.cliSet.length);
  if (!anyCli || !Array.isArray(probes) || !probes.length) return null;

  const byArmSessions = new Map();
  for (const s of sessions) {
    const arm = s.arm ?? null;
    if (!byArmSessions.has(arm)) byArmSessions.set(arm, []);
    byArmSessions.get(arm).push(s);
  }

  const runEventsOf = (s) => [
    ...(s.triggerEvents ?? []).map((e) => ({ type: 'skill', id: e.id, ordinal: e.ordinal, caseId: s.caseId })),
    ...(s.readEvents ?? []).map((e) => ({ type: 'ref', id: e.id, ordinal: e.ordinal, caseId: s.caseId })),
    ...(s.cliSet ?? []).map((e) => ({ type: e.tool, id: e.cmd, ordinal: e.ordinal, caseId: s.caseId })),
  ];

  const byArm = [...byArmSessions.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([arm, ss]) => {
    const valid = ss.filter((s) => s.excluded !== true);
    const caseMap = new Map();
    for (const s of valid) {
      if (!caseMap.has(s.caseId)) caseMap.set(s.caseId, { caseId: s.caseId, runs: [] });
      caseMap.get(s.caseId).runs.push({ runId: s.sessionId ?? s.caseId, triggerSet: s.triggerSet ?? [], cliSet: s.cliSet ?? [] });
    }
    const caseRecords = [...caseMap.values()];
    const probeStats = probes.map((p) => cliStats(caseRecords, p, config.probes ?? UPGRADE_CONFIG.probes));
    const proximity = proximityMatrix(valid.map(runEventsOf), config.proximity ?? UPGRADE_CONFIG.proximity);
    return { arm, probes: probeStats, proximity };
  });

  // block-level exclusion at the CASE granularity (a case is excluded if any of its sessions was)
  const allCases = new Set(sessions.map((s) => s.caseId));
  const excludedCases = new Set(sessions.filter((s) => s.excluded === true).map((s) => s.caseId));
  const exclusionPct = allCases.size ? round4(100 * excludedCases.size / allCases.size) : 0;
  const tripwirePct = (config.probes ?? UPGRADE_CONFIG.probes).blockExclusionTripwirePct;

  const excludedProbeHits = [];
  for (const s of sessions) {
    if (s.excluded !== true || !Array.isArray(s.cliSet) || !s.cliSet.length) continue;
    const byTool = new Map();
    for (const inv of s.cliSet) {
      if (!byTool.has(inv.tool)) byTool.set(inv.tool, []);
      byTool.get(inv.tool).push(inv.cmd);
    }
    for (const [tool, cmds] of byTool) excludedProbeHits.push({ arm: s.arm ?? null, caseId: s.caseId, tool, cmds });
  }

  return {
    byArm,
    paired: { cases: allCases.size, exclusionPct, tripwired: exclusionPct > tripwirePct },
    excludedProbeHits,
  };
}
