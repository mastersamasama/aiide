// aiide up: local dashboard server (R5). No auth, no external calls.
// Read-only EXCEPT one scoped write: PUT /api/experiments/:id/annotations, which writes a
// sidecar under <data-dir>/annotations/ — original experiment files are never modified.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets, META_KEY_RE } from './meta.js';
import { aggregateSkills } from './skills.js';
import { resolveExpStats } from './statsresolve.js';
import { buildDynamicCompareReport } from './comparedynamic.js';
import { buildReportHtml } from './report.js';

const WEB_DIR = fileURLToPath(new URL('../web', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createDashboardServer({ dataDir }) {
  return createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      const annMatch = path.match(/^\/api\/experiments\/([^/]+)\/annotations$/);
      if (req.method === 'PUT' && annMatch) {
        return void putAnnotations(req, res, dataDir, safeId(annMatch[1]))
          .catch(err => send(res, 500, { error: String(err) }));
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'read-only server (annotations PUT excepted)' });

      if (path === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0d1117"/><path d="M3 12V7M8 12V4M13 12V9" stroke="#58a6ff" stroke-width="2" stroke-linecap="round"/></svg>`);
      }
      if (path === '/api/search') return send(res, 200, searchRuns(dataDir, url.searchParams.get('q')));
      if (path === '/api/skills') return send(res, 200, aggregateSkills(dataDir));
      if (path === '/api/events') return void sseEvents(req, res, dataDir); // S9 live-tail (GET, read-only)
      if (path === '/api/runs') return send(res, 200, listRuns(dataDir));
      if (path.startsWith('/api/runs/')) return sendItem(res, join(dataDir, 'runs', safeId(path.slice('/api/runs/'.length)) + '.json'));
      if (path === '/api/experiments') return send(res, 200, listExperiments(dataDir));
      if (path.startsWith('/api/experiments/')) return sendExperiment(res, dataDir, safeId(path.slice('/api/experiments/'.length)));
      // U8 [TL-M1]: read-only upgrade views. GET-only (non-GET already 405'd above) — no write path.
      if (path === '/api/upgrades') return send(res, 200, url.searchParams.has('trend') ? upgradeTrend(dataDir) : listUpgrades(dataDir));
      // serve the single-file HTML report same-origin so the dashboard "open full report" can open it
      // in a new tab (a browser blocks an http page from following a file:// link). Read-only file read.
      const htmlMatch = path.match(/^\/api\/upgrades\/([^/]+)\/report\.html$/);
      if (htmlMatch) return sendUpgradeReportHtml(res, dataDir, safeId(htmlMatch[1]));
      if (path.startsWith('/api/upgrades/')) return sendUpgradeReport(res, dataDir, safeId(path.slice('/api/upgrades/'.length)));
      // dynamic compare: build a full upgrade report from two same-suite experiments on the fly (no
      // `aiide upgrade` run, nothing written). Read-only. GET /api/compare/<idA>/<idB>/report.
      // full single-file HTML report (ECharts CI bars + graph/heat/sankey) for a dynamic compare —
      // same buildReportHtml the `aiide upgrade` pipeline emits, fed the live report. Opens in a new tab.
      const cmpHtmlMatch = path.match(/^\/api\/compare\/([^/]+)\/([^/]+)\/report\.html$/);
      if (cmpHtmlMatch) return sendDynamicCompareHtml(res, dataDir, safeId(decodeURIComponent(cmpHtmlMatch[1])), safeId(decodeURIComponent(cmpHtmlMatch[2])));
      const cmpMatch = path.match(/^\/api\/compare\/([^/]+)\/([^/]+)\/report$/);
      if (cmpMatch) return sendDynamicCompare(res, dataDir, safeId(decodeURIComponent(cmpMatch[1])), safeId(decodeURIComponent(cmpMatch[2])));

      // static assets
      const file = path === '/' ? 'index.html' : path.slice(1);
      const full = join(WEB_DIR, file);
      if (!full.startsWith(WEB_DIR) || !existsSync(full)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(full));
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
  });
}

// ---- annotations sidecar (the ONLY writable state; experiment files stay immutable) -----------

function annotationsPath(dataDir, id) { return join(dataDir, 'annotations', `${id}.json`); }

/** Corrupt sidecar degrades to empty + warning — never a 500 (R8.3). */
function readAnnotations(dataDir, id) {
  const p = annotationsPath(dataDir, id);
  if (!existsSync(p)) return { annotations: {}, warning: null };
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    return { annotations: obj, warning: null };
  } catch { return { annotations: {}, warning: 'annotations file was corrupt — starting fresh' }; }
}

async function putAnnotations(req, res, dataDir, id) {
  if (!existsSync(join(dataDir, 'experiments', `${id}.json`))) return send(res, 404, { error: 'experiment not found' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) return send(res, 400, { error: 'body too large' });
  }
  let obj;
  try { obj = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid JSON' }); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return send(res, 400, { error: 'expected a {key: value} object' });
  const entries = Object.entries(obj);
  if (entries.length > 100) return send(res, 400, { error: 'too many annotations (max 100)' });
  const clean = {};
  for (const [k, v] of entries) {
    if (!META_KEY_RE.test(k)) return send(res, 400, { error: `invalid key "${k}" (letters, digits, . _ - only, max 64)` });
    if (typeof v !== 'string') return send(res, 400, { error: `value for "${k}" must be a string` });
    if (v.length > 2000) return send(res, 400, { error: `value for "${k}" too long (max 2000 chars)` });
    clean[k] = redactSecrets(v); // redaction happens BEFORE disk, not at display time
  }
  mkdirSync(join(dataDir, 'annotations'), { recursive: true });
  writeFileSync(annotationsPath(dataDir, id), JSON.stringify(clean, null, 2));
  send(res, 200, clean);
}

/** Experiment GET merges the sidecar so the client needs no second request. */
// Load an experiment with its stats resolved (embedded or sidecar) — shared by the detail view and
// the dynamic-compare endpoint so both see the same stats (incl. Part-D depgraph, S7 probes).
function loadResolvedExperiment(dataDir, id) {
  const file = join(dataDir, 'experiments', `${id}.json`);
  if (!existsSync(file)) return null;
  const exp = JSON.parse(readFileSync(file, 'utf8'));
  exp.stats = resolveExpStats(exp, dataDir).stats;
  return exp;
}

// GET /api/compare/<idA>/<idB>/report → a full upgrade report built live from the two experiments.
// A = old/baseline, B = new/candidate. 404 if either is missing.
function sendDynamicCompare(res, dataDir, idA, idB) {
  const a = loadResolvedExperiment(dataDir, idA), b = loadResolvedExperiment(dataDir, idB);
  if (!a || !b) return send(res, 404, { error: 'experiment not found' });
  try {
    return send(res, 200, buildDynamicCompareReport({ expA: a, expB: b }));
  } catch (err) {
    return send(res, 500, { error: 'dynamic compare failed: ' + String(err) });
  }
}

// GET /api/compare/<A>/<B>/report.html → the full single-file HTML report (all ECharts) for the live compare.
function sendDynamicCompareHtml(res, dataDir, idA, idB) {
  const a = loadResolvedExperiment(dataDir, idA), b = loadResolvedExperiment(dataDir, idB);
  if (!a || !b) return send(res, 404, { error: 'experiment not found' });
  try {
    const html = buildReportHtml(buildDynamicCompareReport({ expA: a, expB: b }));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(html);
  } catch (err) {
    return send(res, 500, { error: 'dynamic compare html failed: ' + String(err) });
  }
}

function sendExperiment(res, dataDir, id) {
  const file = join(dataDir, 'experiments', `${id}.json`);
  if (!existsSync(file)) return send(res, 404, { error: 'not found' });
  const exp = JSON.parse(readFileSync(file, 'utf8'));
  const { annotations, warning } = readAnnotations(dataDir, id);
  exp.annotations = annotations;
  if (warning) exp.annotationsWarning = warning;
  // shared stats resolver (design A1) — same decision table as the list, so list/detail can never
  // disagree. READ-ONLY: the resolver only reads the `aiide stats --write` sidecar, never writes.
  // exp.warnings (seal-time) already exists → the resolver's ride as statsWarnings.
  const resolved = resolveExpStats(exp, dataDir);
  exp.stats = resolved.stats;                      // null when unusable — never a fake shape
  exp.statsAuthority = resolved.statsAuthority;
  exp.statsWarnings = resolved.warnings;
  if (resolved.sidecarIgnored) exp.sidecarIgnored = true;
  if (resolved.statsError != null) exp.statsError = resolved.statsError;
  // taxonomy §3.0 supplemental (stale embedded schema + non-authoritative recompute sidecar):
  // an INDEPENDENT channel — never merged into exp.stats (embedded stays byte-authoritative).
  if (resolved.supplemental) exp.supplemental = resolved.supplemental;
  send(res, 200, exp);
}

function listRuns(dataDir) {
  const dir = join(dataDir, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try {
      const { run, metrics } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return {
        id: run.id, model: run.model, startedAt: run.startedAt,
        rounds: metrics.totals.rounds, sidechainRounds: metrics.totals.sidechainRounds,
        durationMs: metrics.totals.durationMs, tokens: metrics.totals.tokens,
        costUsd: metrics.totals.costUsd, toolErrors: metrics.totals.toolErrors,
        skills: Object.keys(metrics.perSkill), meta: run.meta ?? {}, warnings: run.parseWarnings,
      };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// Read-only full-text grep across run JSON (S8). No index — a direct scan is correct and fast
// enough at aiide's local scale (tens–hundreds of runs). GET only; never mutates anything.
function searchRuns(dataDir, q) {
  q = String(q ?? '').trim();
  if (q.length < 2) return []; // avoid returning the whole corpus on a 1-char query
  const dir = join(dataDir, 'runs');
  if (!existsSync(dir)) return [];
  const needle = q.toLowerCase();
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const idx = text.toLowerCase().indexOf(needle);
    if (idx < 0) continue;
    let runId = f.replace(/\.json$/, '');
    try { runId = JSON.parse(text).run?.id ?? runId; } catch { /* corrupt file → keep filename */ }
    const start = Math.max(0, idx - 40), end = Math.min(text.length, idx + needle.length + 40);
    const snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
    out.push({ runId, snippet });
    if (out.length >= 50) break; // cap results; the client can refine
  }
  return out;
}

function listExperiments(dataDir) {
  const dir = join(dataDir, 'experiments');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return {
        id: e.id, suiteName: e.suiteName, model: e.model, repeats: e.repeats,
        createdAt: e.createdAt, composite: e.summary.composite, lowSample: e.summary.lowSample,
        taskCount: Object.keys(e.tasks).length, skills: e.profile.skills,
        runtime: e.runtime ?? 'claude-code',
        // Wave 1 made composite nullable and added degraded/excluded — surface them so the list
        // can badge a degraded experiment instead of printing a bare (possibly null) score.
        degraded: e.summary.degraded ?? false, excludedRepeats: e.summary.excludedRepeats ?? 0,
        // design A2: the SAME resolver as the detail (per-file wrapper read is fine at aiide's
        // experiment count; an existsSync shortcut would let list/detail drift on a corrupt sidecar).
        statsAuthority: resolveExpStats(e, dataDir).statsAuthority,
      };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// S9 live-tail SSE (GET, read-only). Polls the runs directory every 500ms (fs.watchFile-style
// stat polling — reliable on win32, unlike fs.watch) and pushes a `run` event whenever a run
// file is added or its bytes change (an `aiide watch` process re-ingesting a growing session).
// The initial state is already loaded by the client, so the first poll only primes, never emits.
function sseEvents(req, res, dataDir) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 2000\n\n');
  const dir = join(dataDir, 'runs');
  const seen = new Map(); // file -> mtimeMs
  let primed = false;
  const poll = () => {
    let files = [];
    try { files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []; } catch { return; }
    for (const f of files) {
      let m; try { m = statSync(join(dir, f)).mtimeMs; } catch { continue; }
      const prev = seen.get(f);
      seen.set(f, m);
      if (primed && prev !== m) {
        let runId = f.replace(/\.json$/, '');
        try { runId = JSON.parse(readFileSync(join(dir, f), 'utf8')).run?.id ?? runId; } catch { /* mid-write — keep filename */ }
        res.write(`event: run\ndata: ${JSON.stringify({ runId })}\n\n`);
      }
    }
    primed = true;
  };
  poll(); // prime without emitting
  const iv = setInterval(poll, 500);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(iv); clearInterval(hb); });
}

// ---- U8 upgrade views (read-only; data source = U7 <dataDir>/upgrades/<compare-id>/report.json) --
// [TL-M1]: a read-only GET does not violate the read-only iron rule. The server only READS the
// verdict-first report.json U7 wrote; it never writes to upgrades/ and offers no adopt/delete path.

function readReport(dir, sub) {
  const p = join(dir, sub, 'report.json');
  if (!existsSync(p)) return null;                       // not a compare dir (or report not built yet)
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } // corrupt → skip, never 500
}

// List each <compare-id>'s report.json summary (verdict + intent + both arm labels/versions +
// timestamp) for the dashboard's #upgrades list (R8.4.1). Missing upgrades/ dir → [] (R8.EB empty).
function listUpgrades(dataDir) {
  const dir = join(dataDir, 'upgrades');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const sub of readdirSync(dir)) {
    const rep = readReport(dir, sub);
    if (!rep) continue;
    out.push({
      compareId: rep.compareId ?? sub, createdAt: rep.createdAt ?? null,
      intent: rep.intent ?? null, verdict: rep.verdict ?? null, established: rep.established ?? false,
      pairs: rep.pairs ?? null, exclusionPct: rep.exclusionPct ?? null,
      cohort: rep.cohort ?? null, lineage: rep.lineage ?? null,
      mixedBundle: rep.header?.mixedBundle ?? false,
      arms: {
        new: rep.arms?.new?.label ?? null, old: rep.arms?.old?.label ?? null,
        newVersion: rep.arms?.new?.version ?? null, oldVersion: rep.arms?.old?.version ?? null,
        baseline: rep.header?.baselineArm?.label ?? null,
      },
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ?trend=1 (R8.4.2): same-model-cohort, case-id-intersection paired trend sequences. A superseded
// genealogy is assigned a new lineage id by U7, so grouping by lineage BREAKS the trend line across
// a supersession boundary (R8.EB4) — the line never bridges two genealogies.
function upgradeTrend(dataDir) {
  const dir = join(dataDir, 'upgrades');
  if (!existsSync(dir)) return { cohorts: [] };
  const reports = [];
  for (const sub of readdirSync(dir)) { const r = readReport(dir, sub); if (r) reports.push(r); }
  return { cohorts: computeTrend(reports) };
}

export function computeTrend(reports) {
  const byCohort = new Map();
  for (const r of reports) {
    const key = r.cohort ?? 'default';
    if (!byCohort.has(key)) byCohort.set(key, []);
    byCohort.get(key).push(r);
  }
  const cohorts = [];
  for (const [cohort, reps] of byCohort) {
    reps.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    // split into contiguous lineage segments — a lineage change = superseded boundary → new segment
    const segments = [];
    let cur = null;
    for (const r of reps) {
      const lin = r.lineage ?? 'default';
      if (!cur || cur.lineage !== lin) { cur = { lineage: lin, reps: [] }; segments.push(cur); }
      cur.reps.push(r);
    }
    cohorts.push({ cohort, segments: segments.map(buildTrendSegment) });
  }
  return cohorts;
}

// One lineage segment → the case-id intersection across its reports + a per-case delta sequence.
// Intersection (not union) so every plotted case has a point at every report in the segment — an
// honest paired trend, no interpolation across a case that only appears in some runs.
function buildTrendSegment(seg) {
  const reports = seg.reps.map(r => ({
    compareId: r.compareId ?? null, createdAt: r.createdAt ?? null,
    verdict: r.verdict ?? null, established: r.established ?? false,
  }));
  const caseSets = seg.reps.map(r => new Set((r.cases ?? []).map(c => c.caseId)));
  const intersection = caseSets.length
    ? [...caseSets.reduce((acc, s) => new Set([...acc].filter(x => s.has(x))))]
    : [];
  const series = intersection.map(caseId => ({
    caseId,
    points: seg.reps.map(r => {
      const c = (r.cases ?? []).find(x => x.caseId === caseId);
      return { compareId: r.compareId ?? null, createdAt: r.createdAt ?? null, delta: c ? c.delta : null };
    }),
  }));
  return { lineage: seg.lineage, reports, caseIds: intersection, series };
}

// Full report.json for one compare (R8.4.1 drill-down). Annotates (not writes) the response with the
// on-disk report.html path so the dashboard can offer the single "open full report" entry (ixd P02).
function sendUpgradeReport(res, dataDir, compareId) {
  const compareDir = join(dataDir, 'upgrades', compareId);
  const p = join(compareDir, 'report.json');
  if (!existsSync(p) || !compareDir.startsWith(join(dataDir, 'upgrades'))) return send(res, 404, { error: 'not found' });
  let rep;
  try { rep = JSON.parse(readFileSync(p, 'utf8')); } catch { return send(res, 500, { error: 'report.json is corrupt' }); }
  const htmlPath = join(compareDir, 'report.html');
  if (existsSync(htmlPath)) rep._reportHtmlPath = htmlPath;   // response annotation only; disk untouched
  send(res, 200, rep);
}

// Serve <compare-id>/report.html verbatim (text/html, same-origin). Read-only file read; the report
// is a write-once immutable artifact (U7 R7.6.2) — the server never modifies it.
function sendUpgradeReportHtml(res, dataDir, compareId) {
  const compareDir = join(dataDir, 'upgrades', compareId);
  const p = join(compareDir, 'report.html');
  if (!existsSync(p) || !compareDir.startsWith(join(dataDir, 'upgrades'))) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(readFileSync(p));
}

function sendItem(res, file) {
  if (!existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(readFileSync(file));
}

function safeId(id) { return decodeURIComponent(id).replace(/[\\/:]/g, ''); }

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
