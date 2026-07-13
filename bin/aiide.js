#!/usr/bin/env node
// aiide — local-first agent observability + isolated skill lab. Zero deps, zero upload.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { ingestPath } from '../src/ingest.js';
import { runSuite, estimateBudget, runCommandAdapter, startService } from '../src/lab.js';
import { loadPricing } from '../src/metrics.js';
import { createDashboardServer } from '../src/server.js';
import { loadSettings, saveSettings, parseMetaFlags, runCaptures, META_KEY_RE } from '../src/meta.js';
import { loadSuite, scaffoldSuite, lintSuite } from '../src/suite.js';
import { recommendationText, failureCause } from '../src/report.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flags = {};
const positional = [];
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = args[i + 1]?.startsWith('--') ? true : args[++i];
    if (key === 'meta') (flags.meta ??= []).push(val); // repeatable: --meta a=1 --meta b=2
    else flags[key] = val;
  } else positional.push(args[i]);
}
const dataDir = resolve(flags['data-dir'] ?? '.aiide');

try {
  if (cmd === 'ingest') await cmdIngest();
  else if (cmd === 'up') await cmdUp();
  else if (cmd === 'lab' && positional[0] === 'run') await cmdLabRun();
  else if (cmd === 'lab' && positional[0] === 'init') await cmdLabInit();
  else if (cmd === 'report') await cmdReport();
  else if (cmd === 'stats') await cmdStats();
  else if (cmd === 'meta') await cmdMeta();
  else if (cmd === 'prune') await cmdPrune();
  else if (cmd === 'export') await cmdExport();
  else if (cmd === 'skill') await cmdSkill();
  else if (cmd === 'watch') await cmdWatch();
  else if (cmd === 'upgrade') await cmdUpgrade();
  else if (cmd === 'adapter' && positional[0] === 'check') await cmdAdapterCheck();
  else usage();
} catch (err) {
  console.error('error:', err.message);
  process.exit(1);
}

function usage() {
  console.log(`aiide — local-first agent observability + isolated skill lab

  aiide ingest <dir|file.jsonl>       parse Claude Code session logs into .aiide/runs/
  aiide up [--port 4517]              start local dashboard (read-only, zero upload)
  aiide watch <dir|file.jsonl>        live-tail a session dir; re-ingest as rounds arrive (open the dashboard to watch)
  aiide skill [name]                  skill profiles: list all, or one skill's version timeline + per-cohort scores
  aiide lab init --suite <file.json>  write an annotated, runnable suite skeleton [--force]
  aiide lab run --suite <file.json>   run isolated skill experiment (repeats + scoring)
      [--model sonnet] [--repeats 3] [--meta k=v ...] [--fresh]
      [--grading-authority deterministic|judged] [--judge-model haiku] [--judge-runtime claude-code]
      [--responder policy|scripted|judge]   (judged assertions + auto-answer interactive gates)
      resume: an interrupted run auto-continues from its progress journal; --fresh forces a rerun
  aiide report [experimentId]         print latest/specified experiment scorecard
  aiide stats [experimentId]          print the experiment's coverage stats (skill/ref/probes/proximity)
      [--force] [--write]             embedded stats is authoritative; --force recomputes (non-authoritative);
                                      --write saves to <data-dir>/stats/<id>.json (never mutates the experiment)
  aiide meta list                     show persistent meta defaults + capture commands
  aiide meta set <k> <v>              set a default meta key (recorded on every experiment)
  aiide meta rm <k>                   remove a default meta key
  aiide meta capture <name> <cmd...>  auto-run <cmd> per experiment, record first output line
  aiide meta capture --rm <name>      remove a capture command
  aiide meta test                     dry-run all capture commands (writes nothing)
  aiide prune --older-than 30d        delete stale runs/experiments (+annotations); preview unless --yes
      [--max N] [--yes]               --max keeps the newest N; server has NO delete endpoint
  aiide export --otel [id]            export a run/experiment as OTLP/JSON (OTel GenAI semconv) [--out f]
  aiide adapter check <output.json>   validate ONE adapter stdout JSON: schema + channel shape [--json]
                                      fatal → exit 1; warnings → exit 0. Single-shot only — trigger
                                      coverage / inventory drift need seal reconciliation (lab run)
  aiide adapter check --suite <f>     LIVE: run one real adapter invocation (suite.runtime, service
      [--task id] [--model m] [--json]   lifecycle + prompt subst) and check its actual stdout

  aiide upgrade lint --suite <f>      U1 dataset lints (schema/coverage/multi-intent/smoke-size) before a run
  aiide upgrade preflight --fixture <m>  U6 static gates (desc-length/collision/drift); fatal → non-zero exit
  aiide upgrade run|compare --fixture <m>  print U0 budget table, then aggregate two arms → verdict + report
  aiide upgrade report --fixture <m> [--format json|md] [--intent cost-opt|quality-fix|neutral-refactor]
      [--arm-exp-old <expId> --arm-exp-new <expId>]
                                         build report.json + report.md + report.html → <data-dir>/upgrades/<id>/
                                         --arm-exp-* resolve two sealed experiments' coverage stats from
                                         <data-dir> (embedded first, else stats/<id>.json sidecar) into the
                                         report's 覆盖统计对比 section, and carry both arms'
                                         environment.runtimeInfo into the 运行时自述对比 section;
                                         the flags win over a bundle's armStats/armRuntimeInfo
  aiide upgrade smoke --mix a=new,b=old [--baseline new|old] --fixture <m>
                                         mixed-bundle confirm smoke → bundle mini-verdict (mix vs baseline, default old-full)

  --data-dir <dir>   data location (default ./.aiide)
  settings: meta defaults + captures live in <data-dir>/settings.json
  pricing: put overrides in <data-dir>/pricing.json ({"models":[{"match":"gpt","in":2.5,...}]})`);
}

async function cmdIngest() {
  const target = positional[0];
  if (!target) return usage();
  const results = ingestPath(resolve(target), { dataDir });
  for (const r of results) {
    if (r.error) console.log(`  ✗ ${r.file}: ${r.error}`);
    else if (r.skipped) console.log(`  - ${r.file}: ${r.skipped}`);
    else console.log(`  ✓ ${r.runId}  (${r.rounds} rounds${r.sidechainRounds ? ` + ${r.sidechainRounds} sidechain` : ''}${r.warnings ? `, ${r.warnings} warnings` : ''})`);
  }
  console.log(`ingested ${results.filter(r => r.runId).length}/${results.length} files → ${join(dataDir, 'runs')}`);
}

async function cmdUp() {
  const port = Number(flags.port ?? 4517);
  const server = createDashboardServer({ dataDir });
  server.listen(port, '127.0.0.1', () => {
    console.log(`aiide dashboard → http://127.0.0.1:${port}  (data: ${dataDir}, local-only, read-only)`);
  });
}

async function cmdLabInit() {
  const rel = flags.suite ?? 'suite.json';
  const suitePath = resolve(rel);
  if (existsSync(suitePath) && !args.includes('--force')) {
    throw new Error(`${suitePath} already exists — use --force to overwrite`);
  }
  writeFileSync(suitePath, scaffoldSuite());
  console.log(`✓ wrote suite skeleton → ${suitePath}`);
  console.log(`  edit it (skills.dirs / targetSkills / tasks), then:  aiide lab run --suite ${rel}`);
  console.log(`  full schema + CLI reference → docs/aiide-skill.md`);
}

async function cmdLabRun() {
  const suitePath = resolve(flags.suite);
  const baseSuite = loadSuite(suitePath);
  if (flags.repeats) baseSuite.repeats = Number(flags.repeats);
  const cliMeta = parseMetaFlags(flags.meta ?? []); // fail-fast before anything starts
  const pricing = loadPricing(dataDir);
  // --models sonnet,opus → run the same suite once per model, then print a comparison
  const models = flags.models ? String(flags.models).split(',').map(s => s.trim()).filter(Boolean)
    : [flags.model ?? baseSuite.model ?? 'sonnet'];
  const fresh = args.includes('--fresh'); // bare boolean: the generic parser can't set it as last arg
  const exps = [];
  for (const model of models) {
    const suite = { ...baseSuite, model };
    // CLI overrides for the grader/judge/responder subsystems (all optional; suite fields are the base).
    if (flags['judge-model'] || flags['judge-runtime']) {
      suite.judge = { ...(baseSuite.judge ?? {}),
        ...(flags['judge-model'] ? { model: flags['judge-model'] } : {}),
        ...(flags['judge-runtime'] ? { runtime: flags['judge-runtime'] } : {}) };
    }
    if (flags['grading-authority']) suite.grading = { ...(baseSuite.grading ?? {}), authority: flags['grading-authority'] };
    if (flags.responder) suite.responder = { ...(baseSuite.responder ?? {}), strategy: flags.responder };
    console.log(`suite: ${suite.name} · model=${model} · ${suite.tasks.length} tasks × ${suite.repeats ?? 3} repeats`);
    const t0 = Date.now();
    const exp = await runSuite({
      suite, suiteDir: dirname(suitePath), suitePath, dataDir, pricing, cliMeta, fresh,
      onProgress: (e) => {
        if (e.type === 'metadata') printPreflight(e);
        if (e.type === 'resume') console.log(`  ↻ resuming: ${e.done}/${e.total} repeats done, ${e.total - e.done} to go`);
        if (e.type === 'service-ready') console.log(`  service up: ${e.url} · model=${e.model}${e.endpointHost ? ` · endpoint=${e.endpointHost}` : ''}`);
        if (e.type === 'warning') console.log(`  ⚠ ${e.message}`);
        if (e.type === 'repeat-start') process.stdout.write(`  ${e.task} r${e.repeat}/${e.of} … `);
        if (e.type === 'repeat-retry') process.stdout.write(`retry ${e.attempt} (${e.signature}, backoff ${(e.backoffMs / 1000).toFixed(1)}s) … `);
        if (e.type === 'repeat-done') console.log(
          e.cached ? '✓ (cached)'
            : e.excluded ? `excluded (env-noise: ${e.signature})`
            : e.error ? `FAILED (${e.error.slice(0, 80)})`
            : `C=${e.C}${e.abortedAtStep ? ` (aborted@step ${e.abortedAtStep})` : ''}`);
      },
    });
    console.log(`\nexperiment ${exp.id} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    printScorecard(exp);
    exps.push(exp);
  }
  if (exps.length > 1) {
    printComparison(exps);
    const [a, b] = exps;
    console.log(`\ncompare view: http://127.0.0.1:4517/#compare/${encodeURIComponent(a.id)}/${encodeURIComponent(b.id)}`);
  } else {
    console.log(`\nview it: aiide up  →  http://127.0.0.1:4517/#experiment/${encodeURIComponent(exps[0].id)}`);
  }
}

// what will be recorded, shown BEFORE the first task — the user sees it while there is still time to ctrl-C
function printPreflight({ environment: env, meta, captured }) {
  console.log(`┌─ metadata`);
  const osStr = env.os ? `${env.os.platform} ${env.os.arch}` : 'os n/a';
  console.log(`│ env: aiide ${env.aiideVersion ?? 'n/a'} · node ${env.nodeVersion} · ${osStr} · runtime ${env.runtimeVersion ?? 'n/a'}`);
  const sp = env.suite?.params ?? {};
  console.log(`│ suite: sha256:${env.suite?.sha256?.slice(0, 8) ?? 'n/a'}… · repeats ${sp.repeats} · maxTurns ${sp.maxTurns} · timeout ${Math.round((sp.timeoutMs ?? 0) / 1000)}s`);
  const metaStr = Object.entries(meta).map(([k, m]) => `${k}=${m.value} [${m.source}]`).join(' · ');
  if (metaStr) console.log(`│ meta: ${metaStr}`);
  const capStr = Object.entries(captured).map(([k, c]) => c.error ? `${k} ✗ ${c.error}` : `${k}=${c.value} ✓ (${c.ms}ms)`).join(' · ');
  if (capStr) console.log(`│ captured: ${capStr}`);
  console.log(`└─`);
}

async function cmdMeta() {
  const sub = positional[0];
  const settings = loadSettings(dataDir);
  const file = join(dataDir, 'settings.json');
  const assertKey = (k) => {
    if (!k || !META_KEY_RE.test(k)) { console.error(`✗ invalid key "${k ?? ''}" (letters, digits, . _ - only, max 64)`); process.exit(1); }
  };
  if (sub === 'list') {
    const dEntries = Object.entries(settings.meta);
    console.log(dEntries.length ? dEntries.map(([k, v]) => `  ${k} = ${v}`).join('\n') : '  - no defaults set');
    const cEntries = Object.entries(settings.capture);
    console.log('capture:');
    console.log(cEntries.length ? cEntries.map(([k, v]) => `  ${k} → ${v}`).join('\n') : '  - no captures defined');
    console.log(`(${file})`);
  } else if (sub === 'set') {
    const [, k, v] = positional;
    assertKey(k);
    if (v === undefined) { console.error('✗ usage: aiide meta set <k> <v>'); process.exit(1); }
    settings.meta[k] = v;
    saveSettings(dataDir, settings);
    console.log(`✓ ${k} = ${v}  (${file})`);
  } else if (sub === 'rm') {
    const k = positional[1];
    if (k in settings.meta) { delete settings.meta[k]; saveSettings(dataDir, settings); console.log(`✓ removed ${k}`); }
    else console.log(`- ${k} not set`); // idempotent
  } else if (sub === 'capture' && flags.rm) {
    const k = String(flags.rm);
    if (k in settings.capture) { delete settings.capture[k]; saveSettings(dataDir, settings); console.log(`✓ removed capture ${k}`); }
    else console.log(`- capture ${k} not set`);
  } else if (sub === 'capture') {
    const [, name, ...cmdParts] = positional;
    assertKey(name);
    if (!cmdParts.length) { console.error('✗ usage: aiide meta capture <name> <command...>'); process.exit(1); }
    settings.capture[name] = cmdParts.join(' ');
    saveSettings(dataDir, settings);
    console.log(`✓ capture ${name} → ${settings.capture[name]}`);
  } else if (sub === 'test') {
    const entries = Object.entries(settings.capture);
    if (!entries.length) return console.log('- no captures defined');
    const results = await runCaptures(settings.capture);
    for (const [k, c] of Object.entries(results)) {
      console.log(c.error ? `✗ ${k}: ${c.error}` : `✓ ${k} = ${c.value} (${c.ms}ms)`);
    }
  } else {
    usage();
    process.exit(1);
  }
}

function printComparison(exps) {
  console.log(`\n┌─ model comparison (${exps.map(e => e.model).join(' vs ')}) — paired on identical tasks`);
  const taskIds = Object.keys(exps[0].tasks);
  for (const tid of taskIds) {
    console.log(`│  ${tid}`);
    for (const e of exps) {
      const t = e.tasks[tid];
      if (!t) continue;
      // degraded must surface HERE too, not just in the scorecard: otherwise `--models a,b` with B's
      // window auth-dead prints a bare composite → a false "B < A" that misleads the decision
      const comp = t.composite == null ? 'n/a' : t.composite.toFixed(3);
      const degraded = t.excludedRepeats > 0 ? ` · degraded (${t.excludedRepeats} excluded)` : '';
      console.log(`│    ${String(e.model).padEnd(10)} composite=${comp} success=${(t.successRate * 100).toFixed(0)}% · ${(t.efficiency.meanDurationMs / 1000).toFixed(1)}s · $${t.efficiency.meanCostUsd}${degraded}`);
    }
  }
  console.log('└─ statistical caveat: n<10 per cell — differences within CI overlap are noise');
}

async function cmdPrune() {
  const { planPrune, executePrune, parseDuration, formatBytes } = await import('../src/prune.js');
  const olderThanMs = flags['older-than'] ? parseDuration(flags['older-than']) : null;
  const max = flags.max != null ? Number(flags.max) : null;
  if (olderThanMs == null && max == null) {
    throw new Error('specify --older-than <dur> and/or --max <N>  (e.g. aiide prune --older-than 30d)');
  }
  if (max != null && (!Number.isInteger(max) || max < 0)) throw new Error('--max must be a non-negative integer');
  const plan = planPrune({ dataDir, olderThanMs, max });
  const total = plan.runs.length + plan.experiments.length;
  if (total === 0) return void console.log('nothing to prune — all data is within the retention window');

  const sample = (items) => items.slice(0, 5).map(x => x.id).join(', ') + (items.length > 5 ? ' …' : '');
  const annCount = plan.experiments.filter(e => e.annotationsPath).length;
  const statsCount = plan.experiments.filter(e => e.statsPath).length;
  console.log(`┌─ prune preview (data: ${dataDir})`);
  console.log(`│ runs:        ${plan.runs.length}${plan.runs.length ? '  ' + sample(plan.runs) : ''}`);
  console.log(`│ experiments: ${plan.experiments.length}${plan.experiments.length ? '  ' + sample(plan.experiments) : ''}`);
  if (annCount) console.log(`│ + ${annCount} annotations sidecar${annCount > 1 ? 's' : ''}`);
  if (statsCount) console.log(`│ + ${statsCount} stats sidecar${statsCount > 1 ? 's' : ''}`);
  console.log(`│ reclaims ≈ ${formatBytes(plan.totalBytes)}`);
  console.log('└─');
  if (!args.includes('--yes')) {
    return void console.log('dry run — re-run with --yes to delete. settings / pricing / in-progress journals are never touched.');
  }
  const res = executePrune(plan);
  console.log(`✓ deleted ${res.runsDeleted} runs, ${res.expDeleted} experiments, ${res.annDeleted} annotations, ${res.statsDeleted} stats`);
}

async function cmdExport() {
  if (!args.includes('--otel')) throw new Error('only --otel is supported: aiide export --otel [id] [--out <file>]');
  const { exportOtel } = await import('../src/otel.js');
  // id may be positional (`export <id> --otel`) or captured by --otel (`export --otel <id>`)
  const id = positional[0] ?? (typeof flags.otel === 'string' ? flags.otel : null);
  const { kind, id: outId, doc } = exportOtel({ dataDir, id });
  const json = JSON.stringify(doc, null, 2);
  if (flags.out) {
    const p = resolve(flags.out);
    writeFileSync(p, json);
    console.log(`✓ exported ${kind} ${outId} → ${p}  (OTLP/JSON, OTel GenAI semconv)`);
  } else {
    process.stdout.write(json + '\n');
  }
}

// S14 CLI: skill as a first-class noun. Shares src/skills.js with the dashboard so the two never
// drift. Read-only — adoption is always a human decision (neutral-layer iron rule).
async function cmdSkill() {
  const { aggregateSkills } = await import('../src/skills.js');
  const skills = aggregateSkills(dataDir);
  if (!skills.length) return void console.log('no skills yet — run an experiment with a skill profile (skills.dirs in the suite)');
  const pct = v => v == null ? 'n/a' : (v * 100).toFixed(0) + '%';
  const sc = v => v == null ? 'n/a' : v.toFixed(3);
  const name = positional[0];

  if (!name) {
    console.log('┌─ skills');
    for (const s of skills) {
      const tag = s.neverTriggered ? '  ✗ never triggered (pure context tax)' : '';
      console.log(`│ ${s.name.padEnd(24)} versions=${s.versions.length}  activation=${pct(s.meanActivation)}  score=${sc(s.meanComposite)}  exps=${s.experimentCount}${tag}`);
    }
    console.log('└─ aiide skill <name>  for a version timeline + per-cohort score trend');
    return;
  }

  const s = skills.find(x => x.name === name);
  if (!s) throw new Error(`skill "${name}" not found (have: ${skills.map(x => x.name).join(', ') || 'none'})`);
  console.log(`┌─ skill: ${s.name}${s.neverTriggered ? '   ⚠ installed but never triggered — pure context tax' : ''}`);
  console.log(`│ activation ${pct(s.meanActivation)} · listing tax ≈${s.meanListingTokens ?? 'n/a'} tok/req · body ≈${s.meanBodyTokens ?? 'n/a'} tok · mean score ${sc(s.meanComposite)} · ${s.experimentCount} experiments · ${s.runCount} runs`);
  if (s.versions.length) {
    console.log('│ versions:');
    for (const v of s.versions) console.log(`│   ${String(v.hash ?? '').slice(0, 8).padEnd(10)} first seen ${v.firstSeen}`);
  }
  // per-cohort score trend — scores only compare WITHIN a comparability cohort (suite·model·runtime);
  // cross-cohort points are printed as separate lines, never chained (same honesty rule as the GUI).
  const cohortKey = e => `${String(e.suiteSha ?? '—').slice(0, 8)}·${e.model}·${e.runtime}`;
  const byCohort = new Map();
  for (const e of s.experiments) { const k = cohortKey(e); if (!byCohort.has(k)) byCohort.set(k, []); byCohort.get(k).push(e); }
  console.log('│ score trend (per comparability cohort):');
  for (const [k, exps] of byCohort) {
    console.log(`│   ${k}`);
    console.log(`│     ${exps.map(e => `${String(e.hash ?? '').slice(0, 4)}:${sc(e.composite)}`).join('  →  ')}`);
  }
  console.log('└─ read-only; adoption is always a human decision');
}

// S9 CLI: live-tail a session dir and re-ingest as rounds arrive. Zero-coupling to the server —
// it only writes run JSON; `aiide up` notices and pushes SSE to the browser.
async function cmdWatch() {
  const target = positional[0];
  if (!target) { usage(); process.exit(1); }
  const { watchDir } = await import('../src/watch.js');
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  console.log(`watching ${abs} → ${join(dataDir, 'runs')}  (fs.watchFile poll ~500ms; Ctrl-C to stop)`);
  console.log('live view: run  aiide up  in another terminal, open a run — it appends rounds as they arrive');
  watchDir({
    target: abs, dataDir,
    onEvent: (e) => {
      if (e.type === 'watch') console.log(`  · tailing ${e.file}`);
      else if (e.type === 'ingested') console.log(`  ✓ ${e.runId}  (${e.rounds} rounds${e.sidechainRounds ? ` + ${e.sidechainRounds} sc` : ''})`);
      else if (e.type === 'error') console.log(`  ✗ ${e.file}: ${e.error}`);
    },
  });
  // watchFile keeps the event loop alive; the process runs until Ctrl-C.
}

async function cmdReport() {
  const dir = join(dataDir, 'experiments');
  if (!existsSync(dir)) throw new Error('no experiments yet');
  let id = positional[0];
  if (!id) {
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    if (!files.length) throw new Error('no experiments yet');
    id = files.at(-1).replace(/\.json$/, '');
  }
  printScorecard(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
}

function printScorecard(exp) {
  const s = exp.summary;
  const d = v => (v == null ? 'n/a' : v.toFixed(2));
  console.log(`\n┌─ ${exp.suiteName} · ${exp.model} · ${exp.repeats} repeats · runtime: ${exp.runtime ?? 'claude-code'} · skills: ${exp.profile.skills.join(', ') || '(external)'}`);
  const comp = s.composite == null ? 'n/a' : s.composite.toFixed(3);
  console.log(`│ SkillScore ${comp}${s.compositePartial ? ' (partial dims)' : ''}   (C=${d(s.C)} P=${d(s.P)} R=${d(s.R)} H=${d(s.H)})${s.lowSample ? '  ⚠ low sample' : ''}`);
  if (s.excludedRepeats > 0) {
    const sigs = [...new Set(Object.values(exp.tasks).flatMap(t => t.excludedSignatures ?? []))].join(', ') || 'env-noise';
    console.log(`│ ⚠ degraded: ${s.excludedRepeats} repeats excluded (env-noise: ${sigs}) — score on valid samples only`);
  }
  if (exp.contextInsights?.listingTotalTokensEst) {
    const ci = exp.contextInsights;
    console.log(`│ context: skill listing ≈${ci.listingTotalTokensEst} tok/request · first-round context ≈${ci.meanFirstRoundContext ?? 'n/a'} tok · triggered skill bodies ≈${ci.meanSkillBodyCostEst ?? 'n/a'} tok`);
  }
  const metaStr = Object.entries(exp.meta ?? {}).map(([k, m]) => `${k}=${m.value}`).join(' · ');
  const capStr = Object.entries(exp.captured ?? {}).map(([k, c]) => c.value == null ? `${k} ✗` : `${k}=${c.value}`).join(' · ');
  if (metaStr || capStr) console.log(`│ meta: ${[metaStr, capStr].filter(Boolean).join('   captured: ')}`);
  for (const w of exp.warnings ?? []) console.log(`│ ⚠ ${w}`);
  for (const [tid, t] of Object.entries(exp.tasks)) {
    const tcomp = t.composite == null ? 'n/a' : t.composite.toFixed(3);
    const excl = t.excludedRepeats > 0 ? ` (${t.excludedRepeats} excluded)` : '';
    console.log(`│  ${tid.padEnd(18)} composite=${tcomp}  success=${(t.successRate * 100).toFixed(0)}% CI[${t.wilsonCi.lo.toFixed(2)},${t.wilsonCi.hi.toFixed(2)}]  activation=${t.activationRate == null ? 'n/a' : (t.activationRate * 100).toFixed(0) + '%'}  ok=${t.n - t.failedRepeats}/${t.n}${excl}`);
    const passStr = Object.entries(t.passAtK ?? {}).map(([k, v]) => `pass@${k}=${v == null ? 'n/a' : v.toFixed(2)}`).join(' ');
    console.log(`│  ${' '.repeat(18)} diag: ${(t.efficiency.meanDurationMs / 1000).toFixed(1)}s · $${t.efficiency.meanCostUsd} · ${t.efficiency.meanOutTokens} out-tok${passStr ? ' · ' + passStr : ''}`);
    const ao = t.activationOutcome;
    if (ao) {
      const side = (s, label, absent) => (s ? `${label} → ${s.meanC.toFixed(2)} (n=${s.n})` : absent);
      const line = `${side(ao.triggered, 'triggered', 'never triggered')} · ${side(ao.notTriggered, 'not-triggered', 'never not-triggered')}`;
      console.log(`│  ${' '.repeat(18)} activation×outcome: ${line}${ao.lowSample ? ' [correlational, low sample]' : ''}`);
    }
  }
  console.log('└─ efficiency is diagnostic-only; it never enters the composite score');
}

// `aiide stats <expId>` — experiment coverage stats (skill/ref/probes/proximity). Authority rule
// (design §2.3): a SEALED experiment's embedded `stats` is the ONLY authority — we print it and
// refuse to recompute unless --force (whose output is stamped non-authoritative, for diagnosing an
// engine-version drift). An OLD experiment with no embedded stats is backfilled from runs/. The
// backfill boundary (design §2.4) is loud: a missing runs dir or ZERO resolvable reps exits non-zero
// with `runs-pruned-cannot-backfill` (expected-vs-found counts) — never a silent all-zero stats.
async function cmdStats() {
  const { buildExpStats, resolveReps, resolveBackfillInventory, STATS_SCHEMA_VERSION } = await import('../src/expstats.js');
  const { loadProbes } = await import('../src/probe.js');
  const { UPGRADE_CONFIG } = await import('../src/upgradeConfig.js');
  const dir = join(dataDir, 'experiments');
  if (!existsSync(dir)) throw new Error('no experiments yet');
  let id = positional[0];
  if (!id) {
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    if (!files.length) throw new Error('no experiments yet');
    id = files.at(-1).replace(/\.json$/, '');
  }
  const expPath = join(dir, `${id}.json`);
  if (!existsSync(expPath)) throw new Error(`experiment not found: ${id}`);
  const exp = JSON.parse(readFileSync(expPath, 'utf8'));
  const force = args.includes('--force');
  const write = args.includes('--write');

  const hasEmbedded = exp.stats && !exp.stats.error;
  // taxonomy §3.0 (r4 F-4-03) stale-schema production path: a valid embedded blob whose
  // schemaVersion is OLD (missing field ≡ 1, the obs.js convention) is still the sealed authority —
  // but plain `--write` now auto-takes the recompute branch (same path as --force, authority
  // 'non-authoritative-recompute') so the resolver's supplemental channel gets a sidecar to feed on.
  // The embedded numbers are NEVER touched; a current-schema embedded keeps the byte-copy behavior.
  const staleEmbedded = hasEmbedded
    && (Number.isFinite(exp.stats.schemaVersion) ? exp.stats.schemaVersion : 1) < STATS_SCHEMA_VERSION;
  if (hasEmbedded && !force && !(staleEmbedded && write)) {
    return void emitStats({ expId: id, authority: 'authoritative-embedded', warnings: [], stats: exp.stats }, { id, write });
  }
  if (hasEmbedded && !force && staleEmbedded && write) {
    console.log(`embedded v${exp.stats.schemaVersion ?? 1} 权威保留；新增节以非权威 sidecar 补算（supplemental）`);
  }

  // recompute/backfill from runs
  const runsDir = join(dataDir, 'runs');
  const tasksForStats = {};
  const referencedRunIds = [];
  for (const [tid, t] of Object.entries(exp.tasks ?? {})) {
    const reps = t.repeats ?? [];
    tasksForStats[tid] = {
      reps,
      held_out: t.held_out === true,
      category: t.category ?? null,
      expected_skill: t.expected_skill ?? null,
    };
    for (const rep of reps) {
      if (rep?.runId == null) continue;
      for (const rid of String(rep.runId).split(',').map(s => s.trim()).filter(Boolean)) referencedRunIds.push(rid);
    }
  }

  // boundary: never emit silent zeros when the runs are gone
  if (!existsSync(runsDir)) {
    console.error(`error: runs-pruned-cannot-backfill — runs dir missing (${runsDir}); expected ${referencedRunIds.length} run file(s), found 0`);
    process.exit(1);
  }
  const { counts } = resolveReps(tasksForStats, runsDir);
  if (counts.nCoverageValid === 0 && counts.nUnresolved > 0) {
    const found = referencedRunIds.filter(rid => existsSync(join(runsDir, `${rid}.json`))).length;
    console.error(`error: runs-pruned-cannot-backfill — expected ${referencedRunIds.length} run file(s), found ${found}; zero reps resolvable`);
    process.exit(1);
  }

  const warnings = [];
  if (counts.nUnresolved > 0) {
    warnings.push(`${counts.nUnresolved} rep(s) unresolved (runs pruned) — counted in nUnresolved, excluded from coverage numerators`);
  }
  // §S v2 + Stage 3 回填三段判定（resolveBackfillInventory，pure/可測）：
  //   1. exp.environment.skillsInventory 非空 → 'adapter-declared'——seal hoist 的唯一封存副本
  //      即回填讀取源（F-2-18），清單轉 refInventory 作分母；refMeta 恆 null（bytes 不可知）。
  //   2. 否則 exp.runtime !== 'claude-code' → 'external-runtime'——自管 skills 的語義不變
  //      （bySkill=null），兩層話不打架（交叉格）。
  //   3. 否則 → 'none-backfill'：refs 從 readCounts 前綴反推（僅觀測到讀的），
  //      shipped/unreadRefs/bytes=null + reason:'no-inventory-snapshot'。
  const { inventoryStatus, refInventory } = resolveBackfillInventory(exp);
  warnings.push(inventoryStatus === 'adapter-declared'
    ? 'refCoverage denominator from adapter-declared inventory (runtime self-reported, not harness-verified); ref bytes unknowable'
    : inventoryStatus === 'external-runtime'
      ? 'refCoverage per-skill unavailable — external runtime manages its own skills (external-runtime-self-managed)'
      : 'refCoverage per-skill degraded — no ref inventory snapshot on backfill (refs inferred from observed reads only; shipped/unreadRefs unknown)');
  let probes = [];
  try { probes = loadProbes(dataDir); }
  catch (e) { warnings.push(`probe load failed: ${e.message} — probe stats degraded to no-probes`); }

  // seal-side rule mirrored: adapter-declared inventory is the runtime's install set — profile
  // skills are empty for adapter suites without skills.dirs, and installed=0 misleads coverage x/y
  const backfillInstalled = (exp.profile?.skills?.length ?? 0) === 0 && inventoryStatus === 'adapter-declared'
    ? Object.keys(refInventory ?? {}).sort() : (exp.profile?.skills ?? []);
  const stats = buildExpStats({
    tasks: tasksForStats, runsDir, installedSkills: backfillInstalled,
    refInventory, refMeta: null, inventoryStatus, probes, config: UPGRADE_CONFIG,
    // taxonomy T1 Stage 3 (§3.0 gates): backfill passes the sealed exp.runtime verbatim; an old
    // experiment without the field → undefined → conservative (claude-code-only sections stay null).
    runtime: exp.runtime,
  });
  const authority = hasEmbedded ? 'non-authoritative-recompute' : 'recomputed-no-embedded';
  emitStats({ expId: id, authority, warnings, stats }, { id, write });
}

function emitStats(out, { id, write }) {
  if (write) {
    const statsDir = join(dataDir, 'stats');    // NEW top-level dir — never inside experiments/
    mkdirSync(statsDir, { recursive: true });
    const p = join(statsDir, `${id}.json`);
    writeFileSync(p, JSON.stringify(out, null, 2));
    console.log(`✓ stats → ${p}  (authority: ${out.authority})`);
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// U7 `aiide upgrade` — verdict + report CLI. Three cumulative wirings onto the earlier waves:
//   lint      → U1 lintSuite (dataset gate before a run)
//   preflight → U6 runStaticGates (static gate; fatal → non-zero exit, zero token)
//   run/compare/smoke → print U0 estimateBudget table first, then aggregate two arms via U4/U5/U6.
// Collection of real sessions needs claude; for offline/e2e a `--fixture <module>` supplies a
// synthetic bundle (armNew/armOld/armMixed/depgraphSessions/gateSkills/descBySkill/baselineArm).
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function cmdUpgrade() {
  const sub = positional[0];
  if (sub === 'lint') return void await upgradeLint();
  if (sub === 'preflight') return void await upgradePreflight();
  if (sub === 'run' || sub === 'compare') return void await upgradeCompare(sub);
  if (sub === 'report') return void await upgradeReport();
  if (sub === 'smoke') return void await upgradeSmoke();
  usage();
  process.exit(1);
}

async function loadFixture() {
  if (!flags.fixture) throw new Error('this command needs --fixture <module> (real-session collection requires a live claude runtime; use a synthetic bundle for offline/e2e)');
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(resolve(String(flags.fixture))).href); // Windows: absolute paths must be file:// URLs
  return mod;
}

// U0 budget table — printed BEFORE any aggregation so the operator sees the cost while there is time to abort (R7.1.2).
function printBudget({ arms, cases, repeats, model, pricing }) {
  const b = estimateBudget({ arms, cases, repeats, model, pricing });
  console.log('┌─ budget estimate (U0)');
  console.log(`│ ${arms} arms × ${cases} cases × ${repeats} repeats = ${b.sessions} sessions · concurrency ${b.concurrency}`);
  console.log(`│ eta ≈ ${(b.etaMs / 3.6e6).toFixed(2)}h · est ≈ $${b.usdEst} ($${b.perSessionUsd}/session, pricing ${b.pricingMatched ? 'matched' : 'default'})`);
  console.log('└─');
  return b;
}

async function upgradeLint() {
  if (!flags.suite) throw new Error('aiide upgrade lint --suite <file>');
  const suite = loadSuite(resolve(flags.suite));
  const res = lintSuite(suite);
  const findings = [...(res.errors ?? []).map(e => ['error', e]), ...(res.warnings ?? []).map(w => ['warning', w])];
  console.log(`┌─ dataset lint (U1) · ${suite.name ?? 'suite'} · ${(suite.cases ?? []).length} cases`);
  if (!findings.length) console.log('│ ✓ no findings');
  for (const [lvl, f] of findings) console.log(`│ ${lvl === 'error' ? '✗' : '⚠'} ${f.gate ?? f.rule ?? ''} ${f.message ?? JSON.stringify(f)}`);
  console.log('└─');
  if ((res.errors ?? []).length) process.exit(1);
}

async function upgradePreflight() {
  const { runStaticGates } = await import('../src/skillint.js');
  const { gateSkills } = await loadFixture();
  const res = runStaticGates(gateSkills ?? []);
  console.log(`┌─ static pre-flight gates (U6) · ${(gateSkills ?? []).length} skills`);
  for (const e of res.errors) console.log(`│ ✗ ${e.gate} ${e.skill ?? ''} ${JSON.stringify(e)}`);
  for (const w of res.warnings) console.log(`│ ⚠ ${w.gate} ${w.term ?? w.path ?? ''}`);
  console.log(`│ fixed tax: ${res.fixedTaxTable.map(t => `${t.skill}=${t.descTaxTokens}tok`).join(' · ')}`);
  console.log(`└─ ${res.fatal ? '✗ FATAL — aborting before collection (R6.6.1, zero token)' : '✓ ok'}`);
  if (res.fatal) process.exit(1); // fatal error → non-zero exit
}

function resolveIntent() {
  const valid = ['cost-opt', 'quality-fix', 'neutral-refactor'];
  const intent = flags.intent ?? 'neutral-refactor';
  if (!valid.includes(intent)) throw new Error(`--intent must be one of ${valid.join(' | ')}`);
  return intent;
}

async function assembleReport({ armNew, armOld, depgraphSessions, gateSkills, descBySkill, intent, meta, prev, probes: fixtureProbes, armStats = null, armRuntimeInfo = null }) {
  const { buildComparison, buildReportJson } = await import('../src/report.js');
  const { depgraphReport } = await import('../src/depgraph.js');
  const { runStaticGates } = await import('../src/skillint.js');
  const { buildProbeBlocks } = await import('../src/lab.js');
  const { UPGRADE_CONFIG } = await import('../src/upgradeConfig.js');
  const cmp = buildComparison(armNew, armOld, { intent });
  const dg = depgraphSessions ? depgraphReport(depgraphSessions, { full: meta.mixedBundle ? false : true, descBySkill }) : null;
  const gates = gateSkills ? runStaticGates(gateSkills) : null;
  const pricing = loadPricing(dataDir);
  const cases = Object.keys(armNew.cases ?? {}).length;
  const b = estimateBudget({ arms: 2, cases, repeats: 3, model: armNew.model ?? 'sonnet', pricing });
  const budget = {
    est: { session: b.sessions, hours: Number((b.etaMs / 3.6e6).toFixed(2)), usd: b.usdEst },
    actual: { session: b.sessions, hours: Number((b.etaMs / 3.6e6).toFixed(2)), usd: b.usdEst },
  };
  // probe presentation blocks — derived from arm-labeled depgraph sessions that carry a cliSet.
  // Probe sources, in order: the fixture bundle's own `probes` export (offline/e2e path — the
  // sessions and the probe must come from the same bundle to be meaningful), else <dataDir>/probes/.
  let probes = Array.isArray(fixtureProbes) ? fixtureProbes : [];
  if (!probes.length) {
    try { const { loadProbes } = await import('../src/probe.js'); probes = loadProbes(dataDir); } catch { /* no probes → probeBlocks null */ }
  }
  const probeBlocks = buildProbeBlocks({ sessions: depgraphSessions ?? [], probes, config: UPGRADE_CONFIG });
  const report = buildReportJson({ comparison: cmp, depgraph: dg, staticGates: gates, budget, meta, prev, probeBlocks, armStats, armRuntimeInfo });
  return report;
}

// §B4 --arm-exp-old/--arm-exp-new → { armStats, armRuntimeInfo }。armStats = { old, new }（值 =
// resolveExpStats 输出 wrapper）；从 dataDir 解析已封存实验（embedded 优先，否则 stats/<id>.json
// sidecar；corrupt → stats null）。与 --fixture 并用时旗标胜 bundle 导出（前向契约：真实采集落地后
// armExperimentIds 走同一 resolver）。
// [wave 2 §4] 同一管道顺带取两侧 experiment.environment.runtimeInfo → armRuntimeInfo = { old, new }
// （缺 → null，报告节渲染「无 runtime 自述」占位——null-not-zero，不捏造自述）。
async function armExpFromFlags() {
  const oldId = flags['arm-exp-old'], newId = flags['arm-exp-new'];
  if (oldId == null && newId == null) return null;
  if (!oldId || !newId || oldId === true || newId === true) {
    throw new Error('--arm-exp-old <expId> and --arm-exp-new <expId> must be provided together');
  }
  const { resolveExpStats } = await import('../src/statsresolve.js');
  const loadExp = (id) => {
    const p = join(dataDir, 'experiments', `${id}.json`);
    if (!existsSync(p)) throw new Error(`experiment not found: ${id} (${p})`);
    return JSON.parse(readFileSync(p, 'utf8'));
  };
  const expOld = loadExp(String(oldId)), expNew = loadExp(String(newId));
  return {
    armStats: { old: resolveExpStats(expOld, dataDir), new: resolveExpStats(expNew, dataDir) },
    armRuntimeInfo: { old: expOld.environment?.runtimeInfo ?? null, new: expNew.environment?.runtimeInfo ?? null },
  };
}

async function upgradeCompare(sub) {
  const fx = await loadFixture();
  const intent = resolveIntent();
  const pricing = loadPricing(dataDir);
  const cases = Object.keys(fx.armNew.cases ?? {}).length;
  printBudget({ arms: 2, cases, repeats: 3, model: fx.armNew.model ?? 'sonnet', pricing });
  if (sub === 'run') { console.log('run: real-session collection requires a live claude runtime — use `report`/`smoke` for the offline pipeline'); return; }
  const report = await assembleReport({ ...fx, intent, meta: { armOld: fx.armOld, armNew: fx.armNew, intent } });
  printVerdictLine(report);
}

async function upgradeReport() {
  const fx = await loadFixture();
  const intent = resolveIntent();
  const format = flags.format ?? null; // json|md → print to stdout instead of writing all three
  const { buildReportMd } = await import('../src/report.js');
  const { writeReport, makeCompareId } = await import('../src/report.js');
  const compareId = makeCompareId(fx.armOld, fx.armNew);
  // --arm-exp-* 旗标胜 bundle 的 armStats/armRuntimeInfo 导出；两者皆无 → null
  // （coverage 节渲染「无统计」、runtime 自述节渲染「无 runtime 自述」占位，均不挡报告）
  const fromFlags = await armExpFromFlags();
  const armStats = fromFlags?.armStats ?? fx.armStats ?? null;
  const armRuntimeInfo = fromFlags?.armRuntimeInfo ?? fx.armRuntimeInfo ?? null;
  const report = await assembleReport({ ...fx, armStats, armRuntimeInfo, intent, meta: { armOld: fx.armOld, armNew: fx.armNew, intent, compareId } });
  if (format === 'json') return void process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (format === 'md') return void process.stdout.write(buildReportMd(report));
  const out = writeReport({ dataDir, report, compareId });
  printVerdictLine(report);
  console.log(`✓ report → ${out.dir}`);
  console.log(`  report.json · report.md · report.html (single-file, inline ECharts, immutable)`);
}

// R7.1.3 / R7.1.3a — mixed-bundle confirm smoke: mixed arm vs baseline arm (default old-full).
async function upgradeSmoke() {
  const fx = await loadFixture();
  const intent = resolveIntent();
  const { writeReport, makeCompareId } = await import('../src/report.js');
  const mix = parseMix(flags.mix);                 // { skill: 'new'|'old' }
  const baseline = flags.baseline ?? 'old';        // default old-full (PM-N1)
  if (!['new', 'old'].includes(baseline)) throw new Error('--baseline must be new | old');
  const mixedArm = fx.armMixed ?? fx.armNew;
  const baselineArm = baseline === 'new' ? fx.armNew : fx.armOld;
  const pricing = loadPricing(dataDir);
  const cases = Object.keys(mixedArm.cases ?? {}).length;
  printBudget({ arms: 2, cases, repeats: 3, model: mixedArm.model ?? 'sonnet', pricing });
  const meta = {
    armOld: baselineArm, armNew: mixedArm, intent, mixedBundle: true, mix,
    baselineArm: { label: baselineArm.label, cliVersion: baselineArm.cliVersion, full: baselineArm.full ?? true },
    compareId: 'mix-' + makeCompareId(baselineArm, mixedArm),
  };
  const report = await assembleReport({ armNew: mixedArm, armOld: baselineArm, depgraphSessions: fx.depgraphSessions, gateSkills: fx.gateSkills, descBySkill: fx.descBySkill, intent, meta, probes: fx.probes });
  console.log(`┌─ mixed-bundle confirm smoke (mini-verdict)`);
  console.log(`│ mix: ${Object.entries(mix).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`│ comparator (baseline arm): ${baselineArm.label} · ${baselineArm.cliVersion} · full=${baselineArm.full ?? true}`);
  console.log('└─');
  printVerdictLine(report);
  const out = writeReport({ dataDir, report });
  console.log(`✓ mixed-bundle report → ${out.dir}`);
}

// §5.2 `aiide adapter check <output.json>` — file-mode mechanical validator (thin wrapper; the
// pure logic lives in src/adaptercheck.js, shared with the seal reconciliation). NOT `aiide up`
// (dashboard) and NOT `aiide upgrade` (upgrade pipeline) — new noun to avoid the name collision.
async function cmdAdapterCheck() {
  const { checkAdapterOutput, formatCheckReport } = await import('../src/adaptercheck.js');
  const asJson = args.includes('--json');
  // live mode: --suite runs ONE real adapter invocation through the same command-adapter machinery
  // (service lifecycle + prompt/model substitution) and checks its actual stdout. file mode stays
  // the default single-shot validator. The design cut a bare --exec dry-run (round 1); live check
  // reuses the suite's declared runtime so what's validated is what a real `lab run` would feed in.
  if (flags.suite) {
    const res = await liveAdapterCheck({ checkAdapterOutput });
    if (asJson) process.stdout.write(JSON.stringify(res.check, null, 2) + '\n');
    else process.stdout.write(formatCheckReport(res.check, { file: res.label, live: res.live }));
    if (!res.check.ok) process.exit(1);
    return;
  }
  const file = positional[1];
  if (!file || file === true) throw new Error('usage: aiide adapter check <output.json> [--json]\n       aiide adapter check --suite <suite.json> [--task <id>] [--model m] [--json]  (live: run one real invocation)');
  const p = resolve(String(file));
  if (!existsSync(p)) throw new Error(`not found: ${p}`);
  const res = checkAdapterOutput(readFileSync(p, 'utf8'));
  if (asJson) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else process.stdout.write(formatCheckReport(res, { file: p }));
  if (!res.ok) process.exit(1);
}

async function liveAdapterCheck({ checkAdapterOutput }) {
  const suitePath = resolve(flags.suite);
  const suite = loadSuite(suitePath);
  const suiteDir = dirname(suitePath);
  const runtime = suite.runtime ?? { type: 'claude-code' };
  if (runtime.type !== 'command') {
    throw new Error(`live check needs a command adapter (suite.runtime.type='command'); got '${runtime.type ?? 'claude-code'}'. Use file mode for a captured stdout JSON.`);
  }
  const model = flags.model ?? suite.model ?? 'sonnet';
  const taskId = flags.task && flags.task !== true ? String(flags.task) : null;
  const task = taskId ? suite.tasks?.find(t => t.id === taskId) : suite.tasks?.[0];
  if (!task) throw new Error(taskId ? `task '${taskId}' not in suite` : 'suite has no tasks');
  const prompt = task.prompt ?? task.steps?.[0]?.prompt;
  if (!prompt) throw new Error(`task '${task.id}' has no prompt`);

  let service = null, extraEnv = {};
  if (runtime.service) {
    service = await startService({ service: runtime.service, model, dataDir });
    for (const w of service.meta.warnings) process.stderr.write(`  ⚠ ${w}\n`);
    extraEnv = { AIIDE_SERVICE_URL: service.serviceUrl };
    process.stderr.write(`  service ready → ${service.serviceUrl} (model ${service.meta.model})\n`);
  }
  const workspaceDir = join(dataDir, 'adapter-check', `${suite.name ?? 'suite'}-${task.id}`);
  try {
    const res = await runCommandAdapter({
      runtime, workspaceDir, prompt, model, suiteDir,
      timeoutMs: suite.timeoutMs ?? 300_000, extraEnv,
    });
    if (res.timedOut) process.stderr.write(`  ⚠ adapter timed out (${suite.timeoutMs ?? 300_000}ms) — checking whatever stdout arrived\n`);
    else if (res.exitCode !== 0) process.stderr.write(`  ⚠ adapter exited ${res.exitCode} — checking stdout anyway; stderr: ${String(res.stderr).slice(0, 200)}\n`);
    const check = checkAdapterOutput(res.stdout ?? '');
    return { check, label: `live: ${suite.name ?? suitePath} · task ${task.id} · model ${model}`, live: true };
  } finally {
    service?.stop();
  }
}

function parseMix(s) {
  if (!s || s === true) throw new Error('--mix skillA=new,skillB=old');
  const out = {};
  for (const pair of String(s).split(',')) {
    const [k, v] = pair.split('=');
    if (!k || !['new', 'old'].includes(v)) throw new Error(`bad mix entry "${pair}" — expected skill=new|old`);
    out[k.trim()] = v.trim();
  }
  return out;
}

function printVerdictLine(report) {
  const ex = report.header.exclusion;
  const undecidable = report.verdict === 'insufficient-data' || report.verdict === 'inconclusive';
  const sym = undecidable ? '∅' : report.established ? '✓' : '✗';
  console.log(`${sym} ${recommendationText(report)} · intent: ${report.intent} · n=${report.pairs} paired · 排除率 ${(ex.rate * 100).toFixed(1)}%`);
  const fc = failureCause(report);
  if (fc) console.log(`  ${fc}`);
  for (const s of report.nextSteps ?? []) console.log(`  → ${s.message}`);
}
