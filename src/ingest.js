// aiide ingest: walk a file/dir of Claude Code session JSONL → normalized runs in <data-dir>/runs/.
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { parseSessionJsonl } from './parser.js';
import { computeRunMetrics, loadPricing } from './metrics.js';

export function collectJsonlFiles(path) {
  const st = statSync(path);
  if (st.isFile()) return extname(path) === '.jsonl' ? [path] : [];
  const out = [];
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (extname(entry.name) === '.jsonl') out.push(p);
    }
  }
  return out;
}

export function ingestPath(path, { dataDir }) {
  const pricing = loadPricing(dataDir);
  const files = collectJsonlFiles(path);
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  const results = [];
  for (const file of files) {
    try {
      // run id = filename stem: several transcript files (main session + per-agent sidechain
      // transcripts) can share one sessionId — sessionId as id would silently overwrite runs
      const run = parseSessionJsonl(readFileSync(file, 'utf8'), { source: file, id: basename(file, '.jsonl') });
      if (run.rounds.length === 0 && run.sidechains.length === 0) {
        results.push({ file, skipped: 'no rounds' });
        continue;
      }
      const scRounds = run.sidechains.reduce((a, s) => a + s.rounds.length, 0);
      run.kind = run.agentId ? 'agent-transcript' : 'session';
      // re-ingest must not lose experiment linkage written by the lab runner
      try {
        const prev = JSON.parse(readFileSync(join(dataDir, 'runs', `${run.id}.json`), 'utf8'));
        if (prev.run?.meta?.experimentId) run.meta = prev.run.meta;
      } catch { /* first ingest of this run */ }
      const metrics = computeRunMetrics(run, { pricing });
      writeFileSync(join(dataDir, 'runs', `${run.id}.json`), JSON.stringify({ run, metrics }, null, 2));
      results.push({ file, runId: run.id, rounds: run.rounds.length, sidechainRounds: scRounds, warnings: run.parseWarnings });
    } catch (err) {
      results.push({ file, error: String(err) });
    }
  }
  return results;
}
