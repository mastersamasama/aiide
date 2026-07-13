import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { watchDir } from '../src/watch.js';
import { aggregateSkills } from '../src/skills.js';

const SAMPLE = fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url));

test('watch: ingests a session jsonl into runs on start (S9)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-watch-'));
  const sessionDir = join(root, 'session');
  const dataDir = join(root, '.aiide');
  mkdirSync(sessionDir, { recursive: true });
  cpSync(SAMPLE, join(sessionDir, 'live.jsonl'));

  const events = [];
  // attach() ingests current contents synchronously, so the run lands without waiting on the poll
  const w = watchDir({ target: sessionDir, dataDir, onEvent: (e) => events.push(e) });
  try {
    const runs = existsSync(join(dataDir, 'runs')) ? readdirSync(join(dataDir, 'runs')).filter(f => f.endsWith('.json')) : [];
    assert.ok(runs.length >= 1, 'a run json was written');
    assert.ok(events.some(e => e.type === 'ingested'), 'emitted an ingested event');
  } finally { w.stop(); }
  rmSync(root, { recursive: true, force: true });
});

test('skills: aggregateSkills joins experiments + runs, versions by hash, never-triggered flag', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiide-skills2-'));
  const dataDir = join(root, '.aiide');
  mkdirSync(join(dataDir, 'experiments'), { recursive: true });
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  const mkExp = (id, hash, createdAt, composite, actRate) => ({
    id, suiteName: 'basic.json', model: 'sonnet', repeats: 3, createdAt, runtime: 'claude-code',
    profile: { skills: ['okx'] },
    environment: { suite: { sha256: 'sha1' }, skills: [{ name: 'okx', hash }] },
    contextInsights: { skillListing: [{ skill: 'okx', listingTokensEst: 120, bodyTokensEst: 900 }] },
    tasks: { t1: { activationRate: actRate } }, summary: { composite },
  });
  writeFileSync(join(dataDir, 'experiments', 'a.json'), JSON.stringify(mkExp('a', 'h1', '2026-07-01T00:00:00Z', 0.6, 0.5)));
  writeFileSync(join(dataDir, 'experiments', 'b.json'), JSON.stringify(mkExp('b', 'h2', '2026-07-02T00:00:00Z', 0.7, 0.6)));
  const never = mkExp('c', 'h3', '2026-07-03T00:00:00Z', 0.4, 0);
  never.profile.skills = ['dead']; never.environment.skills = [{ name: 'dead', hash: 'h3' }];
  never.contextInsights.skillListing = [{ skill: 'dead', listingTokensEst: 50, bodyTokensEst: 100 }];
  writeFileSync(join(dataDir, 'experiments', 'c.json'), JSON.stringify(never));
  writeFileSync(join(dataDir, 'runs', 'r.json'), JSON.stringify({
    run: { id: 'r', model: 'sonnet', startedAt: '2026-07-01T00:00:00Z' },
    metrics: { perSkill: { okx: { rounds: 2, tokens: { in: 100, out: 50 }, toolCalls: 3, toolErrors: 0 } } },
  }));
  const skills = aggregateSkills(dataDir);
  const okx = skills.find(s => s.name === 'okx');
  assert.equal(okx.experimentCount, 2);
  assert.equal(okx.versions.length, 2);
  assert.equal(okx.runTotals.rounds, 2);
  assert.equal(okx.neverTriggered, false);
  assert.equal(skills.find(s => s.name === 'dead').neverTriggered, true);
  rmSync(root, { recursive: true, force: true });
});
