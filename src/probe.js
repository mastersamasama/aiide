// External tool-call PROBE loading + invocation extraction (Wave 2, design §2.1; generalized §Part B).
//
// A probe is a declarative JSON adaptor for ONE external tool (a Bash CLI like onchainos, an MCP
// tool family like mcp__onchainos__*, or any other tool): it says which tool call carries the
// invocation (match.toolName literal XOR match.toolNamePattern regex) and, optionally, how to pull
// the sub-command out of a shell command line (match.commandPattern). Probes are the ONLY config for
// M3-M5/M7 probe signals; the engines in expstats.js never parse tool text themselves.
//
// cmd-source matrix (design §Part B — one cell fatal, no implementation drift):
//   toolName        + commandPattern → CLI path: input.command split into segments, each parsed.
//   toolNamePattern + commandPattern → tool name regex-matched first, then input.command parsed.
//   toolNamePattern + no commandPattern → cmd = toolNamePattern's FIRST capture group (MCP path;
//                                          input.command is never read). Pattern MUST have ≥1 group.
//   toolName (literal) + no commandPattern → VALIDATION FATAL (no defined cmd source).
//
// Reads only; never writes session JSONL (experiment immutability). Fail-fast on malformed config:
// an unknown field or an uncompilable regex throws at load — a silently-wrong probe would poison
// every downstream probe statistic, so we refuse to load it.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Known probe fields (design §2.1). Anything else is a typo/newer-schema drift → fatal.
const PROBE_FIELDS = new Set(['tool', 'match', 'commandSurface', 'sequences', 'capabilities']);
const MATCH_FIELDS = new Set(['toolName', 'toolNamePattern', 'commandPattern']);
const SURFACE_FIELDS = new Set(['source', 'commands']);
const SEQUENCE_FIELDS = new Set(['pattern', 'singleCommand']);

function rejectUnknown(obj, allowed, where) {
  for (const k of Object.keys(obj ?? {})) {
    if (!allowed.has(k)) throw new Error(`probe: unknown field '${k}' in ${where}`);
  }
}

// Number of capture groups in a regex source: matching the empty alternation always succeeds, so
// the result array length is 1 (whole match) + one slot per capture group.
function captureGroupCount(source) {
  return new RegExp(`${source}|`).exec('').length - 1;
}

// Validate + normalize ONE probe object. Throws on any structural fault (design §2.1/§Part B 防呆).
export function validateProbe(probe, source = '<inline>') {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe))
    throw new Error(`probe ${source}: not an object`);
  rejectUnknown(probe, PROBE_FIELDS, 'probe');

  if (typeof probe.tool !== 'string' || !probe.tool.trim())
    throw new Error(`probe ${source}: 'tool' must be a non-empty string`);

  const match = probe.match;
  if (!match || typeof match !== 'object') throw new Error(`probe ${source}: 'match' is required`);
  rejectUnknown(match, MATCH_FIELDS, 'match');

  const hasLiteral = match.toolName != null;
  const hasPattern = match.toolNamePattern != null;
  if (hasLiteral === hasPattern)
    throw new Error(`probe ${source}: exactly one of 'match.toolName' (literal) or 'match.toolNamePattern' (regex) is required`);
  if (hasLiteral && (typeof match.toolName !== 'string' || !match.toolName))
    throw new Error(`probe ${source}: 'match.toolName' must be a non-empty string`);
  if (hasPattern) {
    if (typeof match.toolNamePattern !== 'string' || !match.toolNamePattern)
      throw new Error(`probe ${source}: 'match.toolNamePattern' must be a non-empty string`);
    try { new RegExp(match.toolNamePattern); }
    catch (e) { throw new Error(`probe ${source}: 'match.toolNamePattern' does not compile — ${e.message}`); }
  }

  const hasCommand = match.commandPattern != null;
  if (hasCommand) {
    if (typeof match.commandPattern !== 'string' || !match.commandPattern)
      throw new Error(`probe ${source}: 'match.commandPattern' must be a non-empty string`);
    try { new RegExp(match.commandPattern); }
    catch (e) { throw new Error(`probe ${source}: 'match.commandPattern' does not compile — ${e.message}`); }
  }

  // cmd-source matrix: the two no-commandPattern cells.
  if (!hasCommand) {
    if (hasLiteral)
      throw new Error(`probe ${source}: 'match.toolName' (literal) without a 'commandPattern' has no cmd source — supply a commandPattern or use toolNamePattern with a capture group`);
    if (captureGroupCount(match.toolNamePattern) < 1)
      throw new Error(`probe ${source}: 'match.toolNamePattern' without a 'commandPattern' must have ≥1 capture group (the sub-command)`);
  }

  if (probe.commandSurface != null) {
    const cs = probe.commandSurface;
    if (typeof cs !== 'object' || Array.isArray(cs)) throw new Error(`probe ${source}: 'commandSurface' must be an object`);
    rejectUnknown(cs, SURFACE_FIELDS, 'commandSurface');
    if (cs.commands != null && !Array.isArray(cs.commands))
      throw new Error(`probe ${source}: 'commandSurface.commands' must be an array`);
  }

  if (probe.sequences != null) {
    if (!Array.isArray(probe.sequences)) throw new Error(`probe ${source}: 'sequences' must be an array`);
    for (const seq of probe.sequences) {
      if (!seq || typeof seq !== 'object') throw new Error(`probe ${source}: a sequences entry is not an object`);
      rejectUnknown(seq, SEQUENCE_FIELDS, 'sequences[]');
      if (!Array.isArray(seq.pattern)) throw new Error(`probe ${source}: 'sequences[].pattern' must be an array`);
    }
  }

  if (probe.capabilities != null && !Array.isArray(probe.capabilities))
    throw new Error(`probe ${source}: 'capabilities' must be an array`);

  return probe;
}

// Scan <dataDir>/probes/*.json → validated probe objects. allowList (optional, from a suite's
// `probes: [...]` field) whitelists by tool name; a probe whose tool is not on the list is
// skipped. Missing probes/ dir → [] (no probes configured is a valid state, not an error).
export function loadProbes(dataDir, allowList = null) {
  const dir = join(dataDir, 'probes');
  if (!existsSync(dir)) return [];
  const allow = Array.isArray(allowList) && allowList.length ? new Set(allowList) : null;
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let parsed;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { throw new Error(`probe ${name}: invalid JSON — ${e.message}`); }
    const probe = validateProbe(parsed, name);
    if (allow && !allow.has(probe.tool)) continue;
    out.push(probe);
  }
  return out;
}

// Split a compound shell command into segments on the sequencing operators ; && || | so each
// sub-command is matched independently (design: "splits compound commands on ; && |").
function splitSegments(command) {
  return String(command).split(/\s*(?:;|&&|\|\||\|)\s*/).filter((s) => s.length);
}

// Extract every invocation of `probe` from one run, in toolCall order.
//   → [{ tool, cmd, round, ordinal }]
// ordinal = the tool call's flat position across the whole run (0-based, counting ALL tool calls,
// matching or not) so probe events share the SAME ordinal axis as skill/ref events in
// depgraph.collectSessionEvents — M7 needs one strict order over all three event types.
// For the command-parsing paths, cmd = "<sub1> <sub2>" when the pattern captures a second word,
// else "<sub1>"; multiple invocations from one compound line all carry that call's single ordinal.
// For the toolNamePattern-only (MCP) path, cmd = the name pattern's first capture group and
// input.command is never read.
export function extractInvocations(run, probe) {
  const { toolName, toolNamePattern, commandPattern } = probe.match;
  const nameRe = toolNamePattern ? new RegExp(toolNamePattern) : null;
  const cmdRe = commandPattern ? new RegExp(commandPattern) : null;
  const out = [];
  let ordinal = -1;
  let roundIdx = 0;
  for (const round of run?.rounds ?? []) {
    const rSeq = round.seq ?? (roundIdx + 1);
    for (const tc of round.toolCalls ?? []) {
      ordinal++;
      let nameMatch = null;
      if (nameRe) { nameMatch = nameRe.exec(String(tc.name ?? '')); if (!nameMatch) continue; }
      else if (tc.name !== toolName) continue;

      if (cmdRe) {
        const command = tc.input?.command;
        if (typeof command !== 'string' || !command) continue;
        for (const seg of splitSegments(command)) {
          const m = seg.match(cmdRe);
          if (!m || !m[1]) continue;
          const cmd = m[2] ? `${m[1]} ${m[2]}` : m[1];
          out.push({ tool: probe.tool, cmd, round: rSeq, ordinal });
        }
      } else {
        // toolNamePattern + no commandPattern → cmd = first capture group (validation guarantees ≥1)
        const cmd = nameMatch?.[1];
        if (cmd) out.push({ tool: probe.tool, cmd, round: rSeq, ordinal });
      }
    }
    roundIdx++;
  }
  return out;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// design §2.1 防呆: the probe's tool literal is in play, yet the pattern captured ZERO invocations
// across all runs → the pattern is probably wrong (surface drift the other way). Returns a warning
// object for the caller to flag coverage `suspect`, or null when either the literal never appeared
// or the pattern did match at least once. For a toolNamePattern (MCP) probe the "literal present"
// heuristic is simply the probe.tool string appearing in a tool-call name.
export function probeZeroMatchWarning(runs, probe) {
  const { toolName, toolNamePattern } = probe.match;
  const literalRe = new RegExp(`(?:^|[\\s;&|])${escapeRegExp(probe.tool)}(?:\\s|$)`);
  let literalSeen = false;
  let matched = 0;
  for (const run of runs ?? []) {
    for (const round of run?.rounds ?? []) {
      for (const tc of round.toolCalls ?? []) {
        if (toolNamePattern) {
          if (typeof tc.name === 'string' && tc.name.includes(probe.tool)) literalSeen = true;
        } else {
          if (tc.name !== toolName) continue;
          if (literalRe.test(String(tc.input?.command ?? ''))) literalSeen = true;
        }
      }
    }
    matched += extractInvocations(run, probe).length;
  }
  if (literalSeen && matched === 0)
    return { kind: 'probe-zero-match', tool: probe.tool, note: '探針在場且命令含 tool 字面值但 pattern 零命中' };
  return null;
}
