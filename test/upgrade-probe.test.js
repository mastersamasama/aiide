// Tool-call probe loading + invocation extraction — golden-sample tests (design §2.1 + §Part B).
// Runs are built inline as the minimal Run shape the extractor reads: rounds[].toolCalls[]
// with { name, input }. Bash carries input.command; an MCP tool call carries only { name }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProbe, loadProbes, extractInvocations, probeZeroMatchWarning } from '../src/probe.js';

const ONCHAINOS = {
  tool: 'onchainos',
  match: { toolName: 'Bash', commandPattern: '(?:^|[;&|]\\s*)onchainos\\s+([a-z][\\w-]*)(?:\\s+([a-z][\\w-]*))?' },
  commandSurface: { source: 'static', commands: ['price get', 'order create'] },
  sequences: [{ pattern: ['price get', 'order create'], singleCommand: 'order create --with-price' }],
};
// MCP probe: name-pattern with a capture group, NO commandPattern → cmd = capture group 1.
const ONCHAINOS_MCP = {
  tool: 'onchainos-mcp',
  match: { toolNamePattern: '^mcp__onchainos__(.+)$' },
  commandSurface: { source: 'static', commands: ['price_get', 'order_create'] },
};

// run helper: rounds is an array of arrays of toolCalls
function mkRun(rounds) {
  return { id: 'r', rounds: rounds.map((tcs, i) => ({ seq: i + 1, toolCalls: tcs })) };
}
const bash = (command) => ({ name: 'Bash', input: { command } });
const mcp = (name) => ({ name });   // MCP tool call: name only, NO input.command

// ── validation (design §2.1 防呆) ──────────────────────────────────────────────
test('validateProbe: accepts a well-formed CLI probe and returns it', () => {
  assert.equal(validateProbe(ONCHAINOS), ONCHAINOS);
});

test('validateProbe: accepts a well-formed MCP probe (toolNamePattern + capture group, no commandPattern)', () => {
  assert.equal(validateProbe(ONCHAINOS_MCP), ONCHAINOS_MCP);
});

test('validateProbe: unknown top-level field is fatal', () => {
  assert.throws(() => validateProbe({ ...ONCHAINOS, bogus: 1 }), /unknown field 'bogus'/);
});

test('validateProbe: unknown nested field (match) is fatal', () => {
  assert.throws(() => validateProbe({ ...ONCHAINOS, match: { toolName: 'Bash', commandPattern: 'x', extra: 1 } }),
    /unknown field 'extra' in match/);
});

test('validateProbe: an uncompilable commandPattern is fatal', () => {
  assert.throws(() => validateProbe({ tool: 't', match: { toolName: 'Bash', commandPattern: '([a-z' } }),
    /does not compile/);
});

test('validateProbe: an uncompilable toolNamePattern is fatal', () => {
  assert.throws(() => validateProbe({ tool: 't', match: { toolNamePattern: '([a-z' } }),
    /toolNamePattern.*does not compile/);
});

test('validateProbe: missing tool / match are fatal', () => {
  assert.throws(() => validateProbe({ match: { toolName: 'Bash', commandPattern: 'x' } }), /'tool' must be/);
  assert.throws(() => validateProbe({ tool: 't' }), /'match' is required/);
});

// ── cmd-source matrix (design §Part B — four cells, two fatal) ───────────────────
test('validateProbe: toolName XOR toolNamePattern — both present is fatal', () => {
  assert.throws(() => validateProbe({ tool: 't', match: { toolName: 'Bash', toolNamePattern: '^x$', commandPattern: 'x' } }),
    /exactly one of 'match.toolName'.*or 'match.toolNamePattern'/);
});

test('validateProbe: toolName (literal) with NO commandPattern is fatal (no cmd source)', () => {
  assert.throws(() => validateProbe({ tool: 't', match: { toolName: 'Bash' } }),
    /'match.toolName' \(literal\) without a 'commandPattern' has no cmd source/);
});

test('validateProbe: toolNamePattern with NO commandPattern AND no capture group is fatal', () => {
  assert.throws(() => validateProbe({ tool: 't', match: { toolNamePattern: '^mcp__onchainos__.+$' } }),
    /must have ≥1 capture group/);
});

test('validateProbe: toolNamePattern + commandPattern is accepted (name regex first, then command parse)', () => {
  const p = { tool: 't', match: { toolNamePattern: '^Bash$', commandPattern: 'onchainos (\\w+)' } };
  assert.equal(validateProbe(p), p);
});

// ── loadProbes over a scratch probes/ dir ───────────────────────────────────────
test('loadProbes: scans probes/*.json, applies suite allowList, missing dir → []', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiide-probe-'));
  try {
    assert.deepEqual(loadProbes(dataDir), []); // no probes/ dir yet
    mkdirSync(join(dataDir, 'probes'));
    writeFileSync(join(dataDir, 'probes', 'onchainos.json'), JSON.stringify(ONCHAINOS));
    writeFileSync(join(dataDir, 'probes', 'mcp.json'), JSON.stringify(ONCHAINOS_MCP));
    assert.equal(loadProbes(dataDir).length, 2);
    const only = loadProbes(dataDir, ['onchainos']);
    assert.equal(only.length, 1);
    assert.equal(only[0].tool, 'onchainos');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('loadProbes: a malformed probe file throws (fail-fast, never silently skipped)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiide-probe-'));
  try {
    mkdirSync(join(dataDir, 'probes'));
    writeFileSync(join(dataDir, 'probes', 'bad.json'), JSON.stringify({ ...ONCHAINOS, nope: true }));
    assert.throws(() => loadProbes(dataDir), /unknown field 'nope'/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// ── extraction: CLI path (toolName + commandPattern) ─────────────────────────────
test('extractInvocations: two-word + one-word capture; ordinal = flat toolCall position', () => {
  const run = mkRun([
    [bash('echo hi')],                       // ordinal 0 (non-match, still counted)
    [bash('onchainos price get --json')],    // ordinal 1 → "price get"
    [{ name: 'Read', input: { file_path: '/x' } }, bash('onchainos status')], // ordinals 2,3 → "status" at 3
  ]);
  const invs = extractInvocations(run, ONCHAINOS);
  assert.deepEqual(invs.map((i) => i.cmd), ['price get', 'status']);
  assert.deepEqual(invs.map((i) => i.ordinal), [1, 3]);
  assert.deepEqual(invs.map((i) => i.round), [2, 3]);
  assert.equal(invs[0].tool, 'onchainos');
});

test('extractInvocations: compound command splits on ; && || | — each segment matched', () => {
  const run = mkRun([[bash('onchainos price get && onchainos order create; echo done | onchainos status')]]);
  const invs = extractInvocations(run, ONCHAINOS);
  assert.deepEqual(invs.map((i) => i.cmd), ['price get', 'order create', 'status']);
  // all three come from ONE Bash call → they share that call's single ordinal
  assert.deepEqual(invs.map((i) => i.ordinal), [0, 0, 0]);
});

test('extractInvocations: non-Bash tool calls are ignored even if text matches', () => {
  const run = mkRun([[{ name: 'Read', input: { command: 'onchainos price get' } }]]);
  assert.deepEqual(extractInvocations(run, ONCHAINOS), []);
});

// ── extraction: MCP path (toolNamePattern, no commandPattern → cmd = capture group 1) ─────────────
test('extractInvocations: MCP name-pattern match → cmd = first capture group; input.command never read', () => {
  const run = mkRun([
    [mcp('mcp__onchainos__price_get')],                       // ordinal 0 → "price_get"
    [{ name: 'Read', input: { file_path: '/x' } }],           // ordinal 1 (non-match)
    [mcp('mcp__onchainos__order_create')],                    // ordinal 2 → "order_create"
    [mcp('mcp__other__thing')],                               // ordinal 3 (different family, no match)
  ]);
  const invs = extractInvocations(run, ONCHAINOS_MCP);
  assert.deepEqual(invs.map((i) => i.cmd), ['price_get', 'order_create']);
  assert.deepEqual(invs.map((i) => i.ordinal), [0, 2]);
  assert.equal(invs[0].tool, 'onchainos-mcp');
});

test('extractInvocations: an MCP tool call carrying NO input.command is handled without touching it', () => {
  // the tool call object literally has no `input` — the name-pattern path must never read it
  const tc = { name: 'mcp__onchainos__price_get' };
  assert.equal('input' in tc, false);
  const invs = extractInvocations(mkRun([[tc]]), ONCHAINOS_MCP);
  assert.deepEqual(invs.map((i) => i.cmd), ['price_get']);
});

test('extractInvocations: two probes coexist over one run, each its OWN namespace (tool)', () => {
  const run = mkRun([
    [bash('onchainos price get')],              // onchainos:price get
    [mcp('mcp__onchainos__order_create')],      // onchainos-mcp:order_create
  ]);
  const cli = extractInvocations(run, ONCHAINOS);
  const mcpInv = extractInvocations(run, ONCHAINOS_MCP);
  assert.deepEqual(cli.map((i) => `${i.tool}:${i.cmd}`), ['onchainos:price get']);
  assert.deepEqual(mcpInv.map((i) => `${i.tool}:${i.cmd}`), ['onchainos-mcp:order_create']);
});

// ── probe-zero-match warning ────────────────────────────────────────────────────
test('probeZeroMatchWarning: CLI literal present but pattern never matches → warning', () => {
  // "onchainos" appears but only as a bare word with no sub-command → the pattern (needs a
  // sub-command word) matches nothing across all runs → suspect.
  const run = mkRun([[bash('onchainos')]]);
  const w = probeZeroMatchWarning([run], ONCHAINOS);
  assert.ok(w);
  assert.equal(w.kind, 'probe-zero-match');
  assert.equal(w.tool, 'onchainos');
});

test('probeZeroMatchWarning: at least one match → null; literal absent → null', () => {
  const matched = mkRun([[bash('onchainos price get')]]);
  assert.equal(probeZeroMatchWarning([matched], ONCHAINOS), null);
  const absent = mkRun([[bash('ls -la')]]);
  assert.equal(probeZeroMatchWarning([absent], ONCHAINOS), null);
});

test('probeZeroMatchWarning: MCP probe that matches → null (no false suspect)', () => {
  const run = mkRun([[mcp('mcp__onchainos__price_get')]]);
  assert.equal(probeZeroMatchWarning([run], ONCHAINOS_MCP), null);
});
