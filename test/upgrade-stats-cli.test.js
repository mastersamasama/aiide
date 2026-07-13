// aiide stats subcommand (design §2.3 authority rule + §2.4 backfill boundary), prune stats sidecar,
// and buildProbeBlocks (design §2.4 probe presentation). The stats ENGINE is exercised in
// upgrade-expstats.test.js; here we assert the CLI contract and the report-side glue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planPrune, executePrune } from '../src/prune.js';
import { buildProbeBlocks } from '../src/lab.js';

const BIN = fileURLToPath(new URL('../bin/aiide.js', import.meta.url));
function tmp() { return mkdtempSync(join(tmpdir(), 'aiide-stats-')); }

// a runs/<id>.json as lab.js writes it ({run, metrics}); a Skill call so a trigger is collectible;
// optional ref reads (skill-relative logicalRef) so the v2 none-backfill 反推 path is exercisable
function seedRun(dataDir, id, skill = 'okx-dex-market', reads = []) {
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  writeFileSync(join(dataDir, 'runs', `${id}.json`), JSON.stringify({
    run: { id, sessionId: id, rounds: [{ seq: 1, toolCalls: [
      { name: 'Skill', skill },
      ...reads.map((r) => ({ name: 'Read', isError: false, result: 'x', input: { file_path: `/p/skills/${r}` } })),
    ] }] }, metrics: {},
  }));
}
function seedExperiment(dataDir, id, { tasks, stats, skills = ['okx-dex-market'], runtime }) {
  mkdirSync(join(dataDir, 'experiments'), { recursive: true });
  const exp = { id, suiteName: 's', model: 'sonnet', repeats: 1, createdAt: '2026-07-08T00:00:00Z',
    profile: { dir: null, skills }, tasks, summary: {} };
  if (runtime !== undefined) exp.runtime = runtime;
  if (stats !== undefined) exp.stats = stats;
  const p = join(dataDir, 'experiments', `${id}.json`);
  writeFileSync(p, JSON.stringify(exp, null, 2));
  return p;
}
const rep = (runId) => ({ runId, C: 1, P: 0.9, H: 0.9, activated: true, verifierResults: [], excluded: false });
function runStats(dataDir, extra = []) {
  return execFileSync(process.execPath, [BIN, 'stats', ...extra, '--data-dir', dataDir], { encoding: 'utf8', stdio: 'pipe' });
}

// ── §2.3 authority rule ────────────────────────────────────────────────────────────────────────

test('aiide stats: embedded stats is authoritative — printed, NOT recomputed', () => {
  const dir = tmp();
  seedRun(dir, 'R1');
  const embedded = { schemaVersion: 1, nRaw: 99, nCoverageValid: 99, nExcluded: 0, heldOutExcluded: 0, noSession: 0, nUnresolved: 0, sentinel: true };
  seedExperiment(dir, 'exp-embed', { tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } }, stats: embedded });
  const out = JSON.parse(runStats(dir, ['exp-embed']));
  assert.equal(out.authority, 'authoritative-embedded');
  assert.equal(out.stats.sentinel, true);      // echoed verbatim
  assert.equal(out.stats.nRaw, 99);            // NOT recomputed (real value would be 1)
  rmSync(dir, { recursive: true, force: true });
});

test('aiide stats --force: recompute over embedded → stamped non-authoritative', () => {
  const dir = tmp();
  seedRun(dir, 'R1');
  const embedded = { schemaVersion: 1, nRaw: 99, nCoverageValid: 99, nExcluded: 0, heldOutExcluded: 0, noSession: 0, nUnresolved: 0, sentinel: true };
  seedExperiment(dir, 'exp-force', { tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } }, stats: embedded });
  const out = JSON.parse(runStats(dir, ['exp-force', '--force']));
  assert.equal(out.authority, 'non-authoritative-recompute');
  assert.equal(out.stats.sentinel, undefined); // real recompute, not the sentinel
  assert.equal(out.stats.nRaw, 1);             // 1 rep actually
  assert.equal(out.stats.nCoverageValid, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('aiide stats: OLD experiment (no embedded) backfills from runs; missing held_out/expected_skill tolerated', () => {
  const dir = tmp();
  seedRun(dir, 'R1'); seedRun(dir, 'R2');
  // tasks carry NO held_out / expected_skill / category (old archive)
  seedExperiment(dir, 'exp-old', { tasks: { eth: { repeats: [rep('R1'), rep('R2')] } } });
  const out = JSON.parse(runStats(dir, ['exp-old']));
  assert.equal(out.authority, 'recomputed-no-embedded');
  assert.equal(out.stats.nCoverageValid, 2);
  assert.ok(out.warnings.some(w => /refCoverage per-skill unavailable/.test(w)));  // no snapshot → guarded
  rmSync(dir, { recursive: true, force: true });
});

// ── §2.4 backfill boundary — never silent zeros ──────────────────────────────────────────────────

test('aiide stats: runs dir missing → loud runs-pruned-cannot-backfill (non-zero exit)', () => {
  const dir = tmp();
  seedExperiment(dir, 'exp-gone', { tasks: { eth: { repeats: [rep('GONE-1'), rep('GONE-2')] } } });  // no runs dir at all
  assert.throws(
    () => runStats(dir, ['exp-gone']),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /runs-pruned-cannot-backfill/);
      assert.match(String(err.stderr), /expected 2 run file\(s\), found 0/);
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test('aiide stats: runs present but ALL referenced runs pruned → loud failure with expected/found', () => {
  const dir = tmp();
  seedRun(dir, 'OTHER');  // runs dir exists, but not the ones this experiment references
  seedExperiment(dir, 'exp-partial', { tasks: { eth: { repeats: [rep('GONE-1'), rep('GONE-2')] } } });
  assert.throws(
    () => runStats(dir, ['exp-partial']),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /runs-pruned-cannot-backfill/);
      assert.match(String(err.stderr), /expected 2 run file\(s\), found 0/);
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test('aiide stats: SOME reps unresolved → proceeds with a warning (partial prune is not fatal)', () => {
  const dir = tmp();
  seedRun(dir, 'R1');   // R1 present, R2 pruned
  seedExperiment(dir, 'exp-some', { tasks: { eth: { repeats: [rep('R1'), rep('R2')] } } });
  const out = JSON.parse(runStats(dir, ['exp-some']));
  assert.equal(out.stats.nCoverageValid, 1);
  assert.equal(out.stats.nUnresolved, 1);
  assert.ok(out.warnings.some(w => /unresolved/.test(w)));
  rmSync(dir, { recursive: true, force: true });
});

// ── §S v2 回填判定：inventoryStatus 三態 + 交叉格 ────────────────────────────────────────────────

test('aiide stats v2: claude-code 實驗回填 → none-backfill（refs 從觀測讀取反推；shipped/unreadRefs/bytes=null）', () => {
  const dir = tmp();
  seedRun(dir, 'R1', 'okx-dex-market', ['okx-dex-market/references/pairs.md']);
  seedExperiment(dir, 'exp-backfill', {
    runtime: 'claude-code',
    tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } },
  });
  const out = JSON.parse(runStats(dir, ['exp-backfill']));
  assert.equal(out.stats.schemaVersion, 3); // taxonomy T1 Stage 3 rebaseline (was §S v2)
  const rc = out.stats.refCoverage;
  assert.equal(rc.inventoryStatus, 'none-backfill');
  assert.equal(rc.reason, 'no-inventory-snapshot');
  // 反推僅及觀測到讀的 refs；不可知欄位 = null（絕非 0/[]）
  assert.equal(rc.bySkill.length, 1);
  assert.equal(rc.bySkill[0].skill, 'okx-dex-market');
  assert.equal(rc.bySkill[0].shipped, null);
  assert.equal(rc.bySkill[0].unreadRefs, null);
  assert.deepEqual(rc.bySkill[0].refs.map((r) => r.ref), ['okx-dex-market/references/pairs.md']);
  assert.equal(rc.bySkill[0].refs[0].bytes, null);
  assert.equal(rc.refMeta, null);
  assert.ok(out.warnings.some((w) => /refCoverage per-skill degraded/.test(w)));
  // v2 caseJoin 也隨回填落盤（舊實驗升級路徑 = aiide stats --write）
  assert.deepEqual(out.stats.skillCoverage.caseJoin['okx-dex-market'].cases,
    [{ caseId: 'eth', attempted: 1, triggered: 1 }]);
  rmSync(dir, { recursive: true, force: true });
});

test('aiide stats v2 交叉格: external-runtime 實驗走回填 → 仍 external-runtime 語義（優先於 none-backfill，兩層話不打架）', () => {
  const dir = tmp();
  seedRun(dir, 'R1', 'okx-dex-market', ['okx-dex-market/references/pairs.md']);
  seedExperiment(dir, 'exp-ext', {
    runtime: 'openai-adapter',   // exp.runtime !== 'claude-code' → external-runtime 優先
    tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } },
  });
  const out = JSON.parse(runStats(dir, ['exp-ext']));
  const rc = out.stats.refCoverage;
  assert.equal(rc.inventoryStatus, 'external-runtime');
  assert.equal(rc.bySkill, null);                              // 不可知（null），絕非可知且空的 []
  assert.equal(rc.reason, 'external-runtime-self-managed');
  assert.ok(rc.readCounts['okx-dex-market/references/pairs.md'], '觀測面 readCounts 照舊');
  assert.ok(out.warnings.some((w) => /external runtime manages its own skills/.test(w)));
  rmSync(dir, { recursive: true, force: true });
});

// ── taxonomy §3.0 stale-schema production path (r4 F-4-03) ──────────────────────────────────────

test('aiide stats --write on STALE embedded (v2): auto-recompute branch → non-authoritative sidecar with current schema; embedded byte-untouched; resolver serves it as supplemental', async () => {
  const dir = tmp();
  seedRun(dir, 'R1');
  const embedded = { schemaVersion: 2, nRaw: 99, nCoverageValid: 99, nExcluded: 0, heldOutExcluded: 0, noSession: 0, nUnresolved: 0, sentinel: true };
  const expPath = seedExperiment(dir, 'exp-stale', { runtime: 'claude-code', tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } }, stats: embedded });
  const before = readFileSync(expPath);
  const msg = runStats(dir, ['exp-stale', '--write']);
  assert.match(msg, /embedded v2 权威保留；新增节以非权威 sidecar 补算（supplemental）/);
  assert.match(msg, /stats →/);
  const written = JSON.parse(readFileSync(join(dir, 'stats', 'exp-stale.json'), 'utf8'));
  assert.equal(written.authority, 'non-authoritative-recompute');   // same path as --force
  assert.equal(written.stats.schemaVersion, 3);
  assert.equal(written.stats.sentinel, undefined);                  // real recompute, not an echo
  assert.ok(before.equals(readFileSync(expPath)), 'embedded experiment must stay byte-identical');
  // end-to-end: the resolver now supplies the new sections alongside the UNCHANGED sealed numbers
  const { resolveExpStats } = await import('../src/statsresolve.js');
  const resolved = resolveExpStats(JSON.parse(readFileSync(expPath, 'utf8')), dir);
  assert.equal(resolved.statsAuthority, 'embedded');
  assert.equal(resolved.stats.nRaw, 99);                            // sealed sentinel numbers hold
  assert.equal(resolved.sidecarIgnored, true);
  assert.equal(resolved.supplemental.schemaVersionFrom, 2);
  assert.equal(resolved.supplemental.schemaVersionTo, 3);
  assert.ok(Object.hasOwn(resolved.supplemental.sections, 'statsHealth'));
  assert.equal('skillCoverage' in resolved.supplemental.sections, false); // v2 recompute drift stays inside the sidecar
  rmSync(dir, { recursive: true, force: true });
});

test('aiide stats --write on CURRENT-schema embedded (v3): byte-copy behavior unchanged (authoritative-embedded, echoed verbatim)', () => {
  const dir = tmp();
  seedRun(dir, 'R1');
  const embedded = { schemaVersion: 3, nRaw: 99, nCoverageValid: 99, nExcluded: 0, heldOutExcluded: 0, noSession: 0, nUnresolved: 0, sentinel: true };
  seedExperiment(dir, 'exp-v3', { tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } }, stats: embedded });
  const msg = runStats(dir, ['exp-v3', '--write']);
  assert.doesNotMatch(msg, /权威保留/);                               // no stale hint on a current blob
  const written = JSON.parse(readFileSync(join(dir, 'stats', 'exp-v3.json'), 'utf8'));
  assert.equal(written.authority, 'authoritative-embedded');
  assert.equal(written.stats.sentinel, true);                        // echoed verbatim, NOT recomputed
  assert.equal(written.stats.nRaw, 99);
  rmSync(dir, { recursive: true, force: true });
});

test('aiide stats (no --write) on STALE embedded: plain print stays the authoritative byte copy', () => {
  const dir = tmp();
  seedRun(dir, 'R1');
  const embedded = { nRaw: 99, nCoverageValid: 99, nExcluded: 0, heldOutExcluded: 0, noSession: 0, nUnresolved: 0, sentinel: true }; // no schemaVersion ≡ v1
  seedExperiment(dir, 'exp-stale-print', { tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } }, stats: embedded });
  const out = JSON.parse(runStats(dir, ['exp-stale-print']));
  assert.equal(out.authority, 'authoritative-embedded');
  assert.equal(out.stats.sentinel, true);
  assert.equal(existsSync(join(dir, 'stats', 'exp-stale-print.json')), false); // nothing written
  rmSync(dir, { recursive: true, force: true });
});

// ── --write + experiment immutability ────────────────────────────────────────────────────────────

test('aiide stats --write: writes stats/<id>.json into a NEW top-level dir; experiment byte-identical', () => {
  const dir = tmp();
  seedRun(dir, 'R1');
  const expPath = seedExperiment(dir, 'exp-write', { tasks: { eth: { repeats: [rep('R1')], expected_skill: 'okx-dex-market' } } });
  const before = readFileSync(expPath);                 // Buffer snapshot
  const msg = runStats(dir, ['exp-write', '--write']);
  assert.match(msg, /stats →/);
  const sidecar = join(dir, 'stats', 'exp-write.json');
  assert.ok(existsSync(sidecar), 'sidecar written under stats/, never experiments/');
  assert.equal(existsSync(join(dir, 'experiments', 'stats')), false);
  const written = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(written.stats.nCoverageValid, 1);
  // immutability: the experiment file is not mutated (byte-identical)
  assert.ok(before.equals(readFileSync(expPath)), 'experiment file must be byte-identical');
  rmSync(dir, { recursive: true, force: true });
});

// ── prune drops the stats sidecar with its experiment (design §2.4) ──────────────────────────────

test('prune: an experiment prune also removes its <dataDir>/stats/<id>.json sidecar', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'experiments'), { recursive: true });
  mkdirSync(join(dir, 'stats'), { recursive: true });
  writeFileSync(join(dir, 'experiments', 'old.json'), JSON.stringify({ id: 'old', createdAt: '2026-01-01T00:00:00Z', tasks: {}, summary: {} }));
  writeFileSync(join(dir, 'stats', 'old.json'), JSON.stringify({ expId: 'old', stats: {} }));
  writeFileSync(join(dir, 'experiments', 'fresh.json'), JSON.stringify({ id: 'fresh', createdAt: '2026-07-08T00:00:00Z', tasks: {}, summary: {} }));
  writeFileSync(join(dir, 'stats', 'fresh.json'), JSON.stringify({ expId: 'fresh', stats: {} }));

  const now = Date.parse('2026-07-09T00:00:00Z');
  const plan = planPrune({ dataDir: dir, olderThanMs: 30 * 86_400_000, now });
  assert.deepEqual(plan.experiments.map(e => e.id), ['old']);
  assert.ok(plan.experiments[0].statsPath, 'stats sidecar located in the plan');
  const res = executePrune(plan);
  assert.equal(res.statsDeleted, 1);
  assert.equal(existsSync(join(dir, 'stats', 'old.json')), false);   // gone with its experiment
  assert.ok(existsSync(join(dir, 'stats', 'fresh.json')), 'fresh sidecar untouched');
  rmSync(dir, { recursive: true, force: true });
});

// ── buildProbeBlocks (design §2.4) — inline synthetic sessions, NOT the shared fixture ───────────

// each session = one run: { arm, caseId, excluded?, triggerSet, triggerEvents?, cliSet:[{tool,cmd,ordinal}] }
function sess(arm, caseId, cmds, { excluded = false, ordBase = 0 } = {}) {
  return {
    arm, caseId, sessionId: `${arm}-${caseId}-${Math.random().toString(36).slice(2, 6)}`, excluded,
    triggerSet: ['onchain.swap'],
    triggerEvents: [{ id: 'onchain.swap', ordinal: ordBase }],
    cliSet: cmds.map((cmd, i) => ({ tool: 'onchainos', cmd, ordinal: ordBase + 1 + i })),
  };
}
const PROBE = { tool: 'onchainos', match: { toolName: 'Bash', commandPattern: 'onchainos (\\w+)' },
  commandSurface: { source: 'static', commands: ['price', 'order', 'balance'] }, sequences: [{ pattern: ['price', 'order'], singleCommand: 'order --with-price' }] };
const CFG = { probes: { minSequenceCases: 2, ngramMaxLen: 3, minSessionsForCoverage: 5, blockExclusionTripwirePct: 12 },
  proximity: { windowOrdinals: 6, decay: '1/(1+gap)', minPairCases: 2 } };

test('buildProbeBlocks: null when no probes OR no session carries a cliSet', () => {
  const withCli = [sess('new', 'c1', ['price'])];
  assert.equal(buildProbeBlocks({ sessions: withCli, probes: [], config: CFG }), null);      // no probes
  const noCli = [{ arm: 'new', caseId: 'c1', triggerSet: [], cliSet: [] }];
  assert.equal(buildProbeBlocks({ sessions: noCli, probes: [PROBE], config: CFG }), null);    // no probe signal
  assert.equal(buildProbeBlocks({ sessions: [], probes: [PROBE], config: CFG }), null);       // empty
});

test('buildProbeBlocks: per-arm probes + proximity; block exclusion rate + excludedProbeHits surfaced', () => {
  const sessions = [
    sess('new', 'c1', ['price', 'order']),
    sess('new', 'c2', ['price', 'order']),
    sess('old', 'c1', ['price']),
    sess('old', 'c2', ['balance']),
    // an excluded run in the new arm that DID fire the tool (the F1 "spam then halt" surface)
    sess('new', 'c3', ['price', 'order'], { excluded: true }),
  ];
  const blocks = buildProbeBlocks({ sessions, probes: [PROBE], config: CFG });
  assert.ok(blocks, 'blocks derived when cliSet present');
  // two arms, sorted
  assert.deepEqual(blocks.byArm.map(a => a.arm), ['new', 'old']);
  const newArm = blocks.byArm.find(a => a.arm === 'new');
  assert.ok(Array.isArray(newArm.probes) && newArm.probes.length === 1);   // one probe
  assert.equal(newArm.probes[0].tool, 'onchainos');
  // 'price' and 'order' invoked in the new arm's VALID runs (c3 excluded from probe stats)
  assert.deepEqual(newArm.probes[0].coverage.invoked.sort(), ['order', 'price']);
  assert.ok(newArm.probes[0].coverage.unused.includes('balance'));         // declared, never invoked
  // M5 sequence price→order reaches support (2 distinct cases) and is a hypothesis card
  assert.ok(newArm.probes[0].sequences.some(s => s.seq.join(' ') === 'price order' && s.status === 'hypothesis'));
  assert.ok(newArm.proximity && Array.isArray(newArm.proximity.edges));
  // block-level exclusion: c3 is the only excluded case of 3 distinct → 33.3% > 12% tripwire
  assert.equal(blocks.paired.cases, 3);
  assert.ok(blocks.paired.exclusionPct > 12);
  assert.equal(blocks.paired.tripwired, true);
  // excludedProbeHits records the CLI activity inside the dropped run
  assert.equal(blocks.excludedProbeHits.length, 1);
  assert.deepEqual(blocks.excludedProbeHits[0], { arm: 'new', caseId: 'c3', tool: 'onchainos', cmds: ['price', 'order'] });
});
