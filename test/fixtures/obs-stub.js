// Configurable external-runtime adapter stub for the Stage 2 seal-chain tests.
//   OBS_STUB_FILE: path to a JSON payload printed verbatim to stdout.
//   OBS_STUB_SEQ : directory with 1.json, 2.json, … — each invocation bumps counter.txt and picks
//                  the highest-numbered payload ≤ the invocation index (later invocations reuse
//                  the last payload). Deterministic at pool concurrency 1.
// Payload escape hatches (removed before printing):
//   __stderr: text written to stderr (e.g. "429 too many requests" to trip env-noise exclusion).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// guard: node --test discovers every .js under test/ — do nothing unless invoked as an adapter
if (!process.argv.includes('--go')) process.exit(0);

let raw;
if (process.env.OBS_STUB_SEQ) {
  const dir = process.env.OBS_STUB_SEQ;
  const counterFile = join(dir, 'counter.txt');
  const n = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) + 1 : 1;
  writeFileSync(counterFile, String(n));
  const nums = readdirSync(dir)
    .map((f) => /^(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  const pick = nums.filter((k) => k <= n).at(-1) ?? nums[0];
  raw = readFileSync(join(dir, `${pick}.json`), 'utf8');
} else {
  raw = readFileSync(process.env.OBS_STUB_FILE, 'utf8');
}

const obj = JSON.parse(raw);
if (obj.__stderr) { process.stderr.write(String(obj.__stderr)); delete obj.__stderr; }
process.stdout.write(JSON.stringify(obj));
