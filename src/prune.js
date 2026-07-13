// aiide prune — CLI-only data retention. Zero-dep. Deletes ONLY sealed run/experiment/annotation
// files; settings/pricing/service.env and in-progress journals are excluded structurally (this module
// only ever reads runs/ + experiments/ non-recursively with an endsWith('.json') filter). No server
// DELETE endpoint exists — retention lives here, which is the read-only-server trust differentiator.
import { readFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+)\s*([smhdw])$/i);
  if (!m) throw new Error(`invalid duration "${s}" — use e.g. 30d, 12h, 90m, 2w, 45s`);
  return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

function safeSize(p) { try { return statSync(p).size; } catch { return 0; } }

/** List one collection newest-first; ts from a parsed timestamp field, mtime as fallback. */
function listCollection(dir, tsOf) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {           // non-recursive: .inprogress/ subdir never enters
    if (!f.endsWith('.json')) continue;         // journals are .jsonl → excluded
    const path = join(dir, f);
    let st; try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    let ts = st.mtimeMs;
    try {
      const raw = tsOf(JSON.parse(readFileSync(path, 'utf8')));
      const parsed = raw ? Date.parse(raw) : NaN;
      if (!Number.isNaN(parsed)) ts = parsed;
    } catch { /* unparseable → keep mtime */ }
    out.push({ id: f.replace(/\.json$/, ''), path, ts, bytes: st.size });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Prune if too old OR beyond the newest N (list is newest-first). */
function select(list, olderThanMs, max, now) {
  return list.filter((item, idx) => {
    const tooOld = olderThanMs != null && (now - item.ts) > olderThanMs;
    const overMax = max != null && idx >= max;
    return tooOld || overMax;
  });
}

export function planPrune({ dataDir, olderThanMs = null, max = null, now = Date.now() }) {
  const runs = select(listCollection(join(dataDir, 'runs'), o => o.run?.startedAt), olderThanMs, max, now);
  const experiments = select(listCollection(join(dataDir, 'experiments'), o => o.createdAt), olderThanMs, max, now)
    .map((e) => {
      const ap = join(dataDir, 'annotations', `${e.id}.json`);
      const sp = join(dataDir, 'stats', `${e.id}.json`);   // backfill sidecar (aiide stats --write)
      return { ...e, annotationsPath: existsSync(ap) ? ap : null, statsPath: existsSync(sp) ? sp : null };
    });
  const totalBytes = [...runs, ...experiments].reduce((a, x) => a + x.bytes, 0)
    + experiments.reduce((a, e) => a + (e.annotationsPath ? safeSize(e.annotationsPath) : 0), 0)
    + experiments.reduce((a, e) => a + (e.statsPath ? safeSize(e.statsPath) : 0), 0);
  return { runs, experiments, totalBytes };
}

export function executePrune(plan) {
  let runsDeleted = 0, expDeleted = 0, annDeleted = 0, statsDeleted = 0;
  for (const r of plan.runs) { try { unlinkSync(r.path); runsDeleted++; } catch { /* already gone */ } }
  for (const e of plan.experiments) {
    try { unlinkSync(e.path); expDeleted++; } catch { /* already gone */ }
    if (e.annotationsPath) { try { unlinkSync(e.annotationsPath); annDeleted++; } catch { /* gone */ } }
    if (e.statsPath) { try { unlinkSync(e.statsPath); statsDeleted++; } catch { /* gone */ } }
  }
  return { runsDeleted, expDeleted, annDeleted, statsDeleted };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
