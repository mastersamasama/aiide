import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDuration, planPrune, executePrune, formatBytes } from '../src/prune.js';

const BIN = fileURLToPath(new URL('../bin/aiide.js', import.meta.url));
function tmp() { return mkdtempSync(join(tmpdir(), 'aiide-prune-')); }

// build a data dir with dated runs + experiments (+ annotations, settings, an in-progress journal)
function seed(dataDir) {
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  mkdirSync(join(dataDir, 'experiments', '.inprogress'), { recursive: true });
  mkdirSync(join(dataDir, 'annotations'), { recursive: true });
  const run = (id, iso) => writeFileSync(join(dataDir, 'runs', `${id}.json`), JSON.stringify({ run: { id, startedAt: iso }, metrics: {} }));
  const exp = (id, iso) => writeFileSync(join(dataDir, 'experiments', `${id}.json`), JSON.stringify({ id, createdAt: iso, summary: {}, tasks: {} }));
  run('old-run', '2026-01-01T00:00:00Z');
  run('new-run', '2026-07-08T00:00:00Z');
  exp('old-exp', '2026-01-01T00:00:00Z');
  exp('new-exp', '2026-07-08T00:00:00Z');
  writeFileSync(join(dataDir, 'annotations', 'old-exp.json'), '{"note":"x"}');
  writeFileSync(join(dataDir, 'settings.json'), '{"meta":{}}');
  writeFileSync(join(dataDir, 'experiments', '.inprogress', 'suite-sonnet-abc.jsonl'), '{"__aiide_journal":1}\n');
}

const NOW = Date.parse('2026-07-09T00:00:00Z');

test('S11 parseDuration: units + invalid', () => {
  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  assert.equal(parseDuration('12h'), 12 * 3_600_000);
  assert.equal(parseDuration('2w'), 2 * 604_800_000);
  assert.throws(() => parseDuration('30x'), /invalid duration/);
  assert.throws(() => parseDuration('later'), /invalid duration/);
});

test('S11 planPrune --older-than: selects only stale items, resolves annotations sidecar', () => {
  const dir = tmp();
  seed(dir);
  const plan = planPrune({ dataDir: dir, olderThanMs: 30 * 86_400_000, now: NOW });
  assert.deepEqual(plan.runs.map(r => r.id), ['old-run']);
  assert.deepEqual(plan.experiments.map(e => e.id), ['old-exp']);
  assert.ok(plan.experiments[0].annotationsPath); // sidecar found
  rmSync(dir, { recursive: true, force: true });
});

test('S11 planPrune --max: keeps newest N per collection', () => {
  const dir = tmp();
  seed(dir);
  const plan = planPrune({ dataDir: dir, max: 1, now: NOW });
  assert.deepEqual(plan.runs.map(r => r.id), ['old-run']);       // newest (new-run) kept
  assert.deepEqual(plan.experiments.map(e => e.id), ['old-exp']);
  rmSync(dir, { recursive: true, force: true });
});

test('S11 executePrune: deletes selected + sidecar, leaves fresh data / settings / journal (AC/R3)', () => {
  const dir = tmp();
  seed(dir);
  const plan = planPrune({ dataDir: dir, olderThanMs: 30 * 86_400_000, now: NOW });
  const res = executePrune(plan);
  assert.deepEqual(res, { runsDeleted: 1, expDeleted: 1, annDeleted: 1, statsDeleted: 0 });
  assert.equal(existsSync(join(dir, 'runs', 'old-run.json')), false);
  assert.equal(existsSync(join(dir, 'experiments', 'old-exp.json')), false);
  assert.equal(existsSync(join(dir, 'annotations', 'old-exp.json')), false);
  // untouched:
  assert.ok(existsSync(join(dir, 'runs', 'new-run.json')));
  assert.ok(existsSync(join(dir, 'experiments', 'new-exp.json')));
  assert.ok(existsSync(join(dir, 'settings.json')));
  assert.ok(existsSync(join(dir, 'experiments', '.inprogress', 'suite-sonnet-abc.jsonl')));
  rmSync(dir, { recursive: true, force: true });
});

test('S11 CLI: preview deletes nothing; --yes deletes; no selector errors', () => {
  const dir = tmp();
  seed(dir);
  const cli = (extra) => execFileSync(process.execPath, [BIN, 'prune', ...extra, '--data-dir', dir], { encoding: 'utf8' });
  // dry run
  const preview = cli(['--older-than', '30d']);
  assert.match(preview, /prune preview/);
  assert.match(preview, /dry run/);
  assert.ok(existsSync(join(dir, 'experiments', 'old-exp.json'))); // nothing deleted
  // confirmed
  const done = cli(['--older-than', '30d', '--yes']);
  assert.match(done, /deleted 1 runs, 1 experiments, 1 annotations/);
  assert.equal(existsSync(join(dir, 'experiments', 'old-exp.json')), false);
  // no selector → error exit 1
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'prune', '--data-dir', dir], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => { assert.match(String(err.stderr), /specify --older-than/); return true; },
  );
  rmSync(dir, { recursive: true, force: true });
});

test('S11 formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
});
