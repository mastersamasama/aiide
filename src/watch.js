// S9 `aiide watch <dir>`: live-tail Claude Code session JSONL(s) and incrementally re-ingest into
// the data dir. Zero-侵入 / zero-coupling: watch only WRITES run JSON into <data-dir>/runs; a
// separate `aiide up` server notices the file change (its own stat poll) and pushes SSE. The two
// processes never talk directly.
//
// Uses fs.watchFile (stat polling ~500ms), NOT fs.watch — fs.watch drops events on win32. The
// whole JSONL is re-parsed on each change: session files are small while a run is live, and the
// parser tolerates a half-written trailing line, so correctness beats byte-offset cleverness here.
import { watchFile, unwatchFile, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ingestPath } from './ingest.js';

export function watchDir({ target, dataDir, intervalMs = 500, onEvent = () => {} }) {
  const isFile = existsSync(target) && statSync(target).isFile();
  const watched = new Set();

  const ingestOne = (file) => {
    try {
      const results = ingestPath(file, { dataDir });
      for (const r of results) {
        if (r.runId) onEvent({ type: 'ingested', file: basename(file), runId: r.runId, rounds: r.rounds, sidechainRounds: r.sidechainRounds });
        else if (r.error) onEvent({ type: 'error', file: basename(file), error: r.error });
      }
    } catch (err) { onEvent({ type: 'error', file: basename(file), error: err.message }); }
  };

  const attach = (file) => {
    if (watched.has(file)) return;
    watched.add(file);
    onEvent({ type: 'watch', file: basename(file) });
    watchFile(file, { interval: intervalMs }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) ingestOne(file);
    });
    ingestOne(file); // ingest current contents immediately
  };

  const scan = () => {
    const files = isFile ? [target]
      : (existsSync(target) ? readdirSync(target).filter(f => f.endsWith('.jsonl')).map(f => join(target, f)) : []);
    for (const f of files) attach(f);
  };

  scan();
  // re-scan periodically so a session file created AFTER `aiide watch` started is picked up too
  const iv = isFile ? null : setInterval(scan, intervalMs);
  return {
    stop() {
      if (iv) clearInterval(iv);
      for (const f of watched) unwatchFile(f);
      watched.clear();
    },
  };
}
