// Claude Code session JSONL → normalized Run model (R1).
// Source JSONL is treated as read-only; every line failure degrades to a warning, never a throw.

const KNOWN_SKIP_TYPES = new Set([
  'system', 'progress', 'summary', 'mode', 'permission-mode',
  'last-prompt', 'queue', 'file-history-snapshot', 'todo', 'checkpoint',
  'thinking-budget',
]);

const CONTEXT_LIMITS = { default: 200_000 };

export function contextLimitFor(model = '') {
  // by design: all current Claude models ship 200k-class windows; table kept for future divergence
  return CONTEXT_LIMITS.default;
}

export function parseSessionJsonl(text, { source = '', id = null } = {}) {
  const run = {
    id: null, sessionId: null, source, model: null,
    startedAt: null, endedAt: null, cwd: null, version: null,
    prompt: null,          // first user text — the ask this run answers
    userEvents: [],        // user-side text entering context: prompts, injected reminders, hook output
    // taxonomy §3.1(a) r5 F-5-01: parse-time capability fingerprint. userEvents carry the
    // five-class `srcKind` tag ONLY when this field is present; legacy runs/*.json (immutable)
    // lack it — that ABSENCE is the structurally detectable "untagged-legacy-run" predicate
    // (the `kind` values 'user'/'attachment' sit inside the five-class value domain, so an
    // event-level "missing tag" test would be forever-false on legacy runs).
    userEventsTagVersion: 1,
    compactions: [],       // taxonomy §3.1(b): compact-boundary events [{ts}] in line order
    rounds: [], sidechains: [], parseWarnings: 0,
    meta: {},
  };
  const sidechainMap = new Map(); // agent key → rounds[]
  const toolCallIndex = new Map(); // tool_use id → toolCall object
  const roundsByRequest = new Map(); // requestId → round (streaming segment merge)
  // §3.1(b): a compact-boundary arms its OWN isSidechain domain; the next NEWLY-CREATED round
  // in that domain (first segment line of a requestId) gets compactBefore:true. A tail boundary
  // (no later new round) stays recorded in run.compactions only.
  const pendingCompact = { main: false, side: false };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { run.parseWarnings++; continue; }
    if (obj === null || typeof obj !== 'object') { run.parseWarnings++; continue; }
    const type = obj.type;

    if (obj.sessionId && !run.sessionId) run.sessionId = obj.sessionId;
    if (obj.cwd && !run.cwd) run.cwd = obj.cwd;
    if (obj.version && !run.version) run.version = obj.version;
    if (obj.timestamp) {
      if (!run.startedAt) run.startedAt = obj.timestamp;
      run.endedAt = obj.timestamp;
    }

    if (type === 'assistant') {
      ingestAssistantLine(obj, run, sidechainMap, toolCallIndex, roundsByRequest, pendingCompact);
    } else if (type === 'user') {
      ingestUserLine(obj, run, toolCallIndex);
    } else if (type === 'attachment') {
      ingestAttachmentLine(obj, run);
    } else if (type === 'compact-boundary') {
      run.compactions.push({ ts: obj.timestamp ?? null });
      pendingCompact[obj.isSidechain === true ? 'side' : 'main'] = true;
    } else if (type === 'result') {
      // §3.1(e)/G-15: one record per result line, field names verbatim, missing fields null.
      // NO Σ here — aggregation semantics (multi-result-line sum) belong to the stats layer.
      // No result line in the file → the field stays absent (legacy-shaped: absent = no channel).
      (run.selfReports ??= []).push({
        total_cost_usd: obj.total_cost_usd ?? null,
        num_turns: obj.num_turns ?? null,
        duration_ms: obj.duration_ms ?? null,
        is_error: obj.is_error ?? null,
      });
    } else if (!KNOWN_SKIP_TYPES.has(type)) {
      run.parseWarnings++;
    }
  }

  finalizeRounds(run.rounds, run.endedAt);
  for (const [agent, rounds] of sidechainMap) {
    finalizeRounds(rounds, run.endedAt);
    run.sidechains.push({ agentId: agent, rounds });
  }
  // pure agent-transcript file (subagent log): its sidechain rounds ARE the run —
  // promote so prompt / user events / context-delta attribution all light up
  if (run.rounds.length === 0 && run.sidechains.length === 1) {
    run.agentId = run.sidechains[0].agentId;
    run.rounds = run.sidechains[0].rounds;
    run.sidechains = [];
    run.userEvents = run._sidechainUserEvents ?? [];
    run.prompt = (run.userEvents.find(e => e.kind === 'user') ?? run.userEvents[0])?.text ?? null;
  }
  delete run._sidechainUserEvents;
  run.model = run.rounds.find(r => r.model)?.model
    ?? run.sidechains.flatMap(s => s.rounds).find(r => r.model)?.model ?? null;
  run.id = id ?? run.sessionId ?? hashLite(source || text.slice(0, 256));
  return run;
}

function ingestAssistantLine(obj, run, sidechainMap, toolCallIndex, roundsByRequest, pendingCompact) {
  const msg = obj.message ?? {};
  const reqKey = obj.requestId ?? obj.uuid;
  const sidechain = obj.isSidechain === true;
  const bucket = sidechain
    ? getSidechainBucket(sidechainMap, obj)
    : run.rounds;

  let round = roundsByRequest.get(reqKey);
  if (!round || round._sidechain !== sidechain) {
    round = {
      seq: 0, ts: obj.timestamp ?? null, durationMs: 0,
      model: msg.model ?? null,
      attributionSkill: obj.attributionSkill ?? null,
      usage: { in: 0, out: 0, cacheW: 0, cacheR: 0 },
      contextFootprint: 0,
      toolCalls: [], stopReason: null,
      text: '', thinking: '', textChars: 0, thinkingChars: 0,
      _sidechain: sidechain,
    };
    // §3.1(b): "newly created" = the FIRST segment line of a requestId — a later streaming
    // segment merging into an existing round never consumes the pending boundary.
    const domain = sidechain ? 'side' : 'main';
    if (pendingCompact?.[domain]) {
      round.compactBefore = true;
      pendingCompact[domain] = false;
    }
    roundsByRequest.set(reqKey, round);
    bucket.push(round);
  }
  if (obj.attributionSkill && !round.attributionSkill) round.attributionSkill = obj.attributionSkill;
  if (msg.stop_reason) round.stopReason = msg.stop_reason;

  const u = msg.usage;
  if (u && typeof u === 'object') {
    // by design: streaming segments of one requestId repeat the same message usage — take latest, don't sum
    round.usage = {
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cacheW: u.cache_creation_input_tokens ?? 0,
      cacheR: u.cache_read_input_tokens ?? 0,
    };
    round.contextFootprint = round.usage.in + round.usage.cacheR + round.usage.cacheW;
  }

  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      if (round.toolCalls.some(t => t.id === block.id)) continue;
      const call = {
        name: block.name ?? 'unknown', id: block.id ?? null, isError: false,
        skill: block.name === 'Skill' ? (block.input?.skill ?? null) : null,
        input: block.input ?? null, result: null, // full content, no truncation
        denialKind: null,  // U2 R2.5: permission denial kind from tool_result (e.g. 'user-rejected')
        skillBody: null,   // U2 R2.3: SKILL.md body text hung back via isMeta sourceToolUseID
      };
      round.toolCalls.push(call);
      if (call.id) toolCallIndex.set(call.id, call);
    } else if (block.type === 'text') {
      round.text += block.text ?? '';
      round.textChars += (block.text ?? '').length;
    } else if (block.type === 'thinking') {
      round.thinking += block.thinking ?? '';
      round.thinkingChars += (block.thinking ?? '').length;
    }
  }
}

function ingestUserLine(obj, run, toolCallIndex) {
  const content = obj.message?.content;
  // user-side text = the run's prompt + everything the runtime injects between rounds
  // (system-reminders, hook output, tool-result side text) — the usual cause of
  // "context grew but the tool returned nothing" confusion
  let text = '';
  let hasToolResult = false; // §3.1(a): text blocks beside a tool_result = system-reminder/hook main channel
  if (typeof content === 'string') text = content;
  if (!Array.isArray(content)) {
    pushUserEvent(run, obj, text, userSrcKind(obj, false));
    return;
  }
  for (const block of content) {
    if (block?.type === 'tool_result') {
      hasToolResult = true;
      const call = block.tool_use_id ? toolCallIndex.get(block.tool_use_id) : null;
      if (!call) continue;
      if (block.is_error === true) call.isError = true;
      // U2 R2.5.1: permission denial is a structural field on the tool_result, not NL text
      if (block.toolDenialKind != null) call.denialKind = block.toolDenialKind;
      call.result = serializeToolResult(block.content);
    } else if (block?.type === 'text') {
      text += (text ? '\n' : '') + (block.text ?? '');
    }
  }
  // U2 R2.3.1a ([TL-m4] hang-back): a skill's SKILL.md body enters context as an
  // isMeta:true user text line whose sourceToolUseID points back at the Skill tool_use.
  // Attach it onto that call via the existing toolCallIndex so body context cost is
  // metered from the real body length — not the 28-char "Launching skill" tool_result.
  if (obj.isMeta === true && obj.sourceToolUseID) {
    const src = toolCallIndex.get(obj.sourceToolUseID);
    if (src) src.skillBody = src.skillBody ? `${src.skillBody}\n${text}` : text;
  }
  pushUserEvent(run, obj, text, userSrcKind(obj, hasToolResult));
}

// taxonomy §3.1(a) five-class source tag, unique-hit priority order (r3 F-3-03):
//   skill-body       — isMeta + sourceToolUseID (SKILL.md body hang-back line; still a userEvent)
//   tool-result-side — text block(s) in a message that also carries a tool_result block
//                      (system-reminder / hook output main channel)
//   attachment       — attachment line type (tagged at ingestAttachmentLine, not here)
//   meta-injected    — isMeta WITHOUT sourceToolUseID (caveat / command injection)
//   user             — everything else (pure user line)
// `kind` semantics stay untouched — new information rides the NEW `srcKind` field only.
function userSrcKind(obj, hasToolResult) {
  if (obj.isMeta === true && obj.sourceToolUseID) return 'skill-body';
  if (hasToolResult) return 'tool-result-side';
  if (obj.isMeta === true) return 'meta-injected';
  return 'user';
}

function pushUserEvent(run, obj, text, srcKind = 'user') {
  if (!text.trim()) return;
  const ev = { ts: obj.timestamp ?? null, text, chars: text.length, kind: 'user', srcKind };
  if (obj.isSidechain === true) {
    // kept aside: promoted to main events when the whole file is one agent's transcript
    (run._sidechainUserEvents ??= []).push(ev);
    return;
  }
  run.userEvents.push(ev);
  if (run.prompt === null) run.prompt = text;
}

// attachment lines = runtime-injected context (hook output, file states, system reminders) —
// invisible in most UIs yet they DO grow the next round's context
function ingestAttachmentLine(obj, run) {
  const text = collectStrings(obj.attachment).join('\n');
  if (!text.trim()) return;
  const ev = { ts: obj.timestamp ?? null, text, chars: text.length, kind: 'attachment', srcKind: 'attachment' };
  if (obj.isSidechain === true) (run._sidechainUserEvents ??= []).push(ev);
  else run.userEvents.push(ev);
}

function collectStrings(v, out = [], depth = 0) {
  if (depth > 4 || out.length > 80) return out;
  if (typeof v === 'string') { if (v.length > 2) out.push(v); }
  else if (Array.isArray(v)) { for (const x of v) collectStrings(x, out, depth + 1); }
  else if (v && typeof v === 'object') { for (const x of Object.values(v)) collectStrings(x, out, depth + 1); }
  return out;
}

function serializeToolResult(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : `[${b?.type ?? 'block'}]`)).join('\n');
  }
  return JSON.stringify(content);
}

function getSidechainBucket(sidechainMap, obj) {
  const key = obj.agentId ?? obj.subagentType ?? 'sidechain';
  if (!sidechainMap.has(key)) sidechainMap.set(key, []);
  return sidechainMap.get(key);
}

function finalizeRounds(rounds, endedAt) {
  rounds.forEach((r, i) => {
    r.seq = i + 1;
    const nextTs = rounds[i + 1]?.ts ?? endedAt;
    if (r.ts && nextTs) {
      r.durationMs = Math.max(0, new Date(nextTs) - new Date(r.ts));
    }
    delete r._sidechain;
  });
}

function hashLite(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return 'run-' + (h >>> 0).toString(16);
}

// ─────────────────────────────────────────────────────────────────────────────
// U2 dep-collector reads over the Run model (pure; no session mutation).
// These are parser-level because they read only the normalized parse tree.
// The depgraph collection layer (ref normalization, per-session events) lives in
// src/depgraph.js and consumes extractTriggers/classifyToolResult from here.
// ─────────────────────────────────────────────────────────────────────────────

// U2 R2.1.2/R2.1.3: trigger set from Skill tool_use input.skill (the trigger fact)
// merged with the adapter's EXPLICIT per-round `declaredTriggers` channel. Merge order:
// round order → within a round, tool facts before declarations → declaredTriggers array
// order; primary = first occurrence, auxiliary = every later DISTINCT skill.
// attributionSkill is only an optional enhancement signal (R2.1.3) — never the sole
// attribution source — so it is deliberately not consulted here; the adapter-trace
// fold-in of attributionSkill happens at the consumer (collectSessionEvents), keeping
// this channel pure-explicit.
export function extractTriggers(run) {
  const skillCalls = [];
  for (const round of run?.rounds ?? []) {
    for (const tc of round.toolCalls ?? []) {
      if (tc.name === 'Skill' && tc.skill) skillCalls.push(tc.skill);
    }
    for (const t of round.declaredTriggers ?? []) if (t) skillCalls.push(t);
  }
  const primarySkill = skillCalls[0] ?? null;
  const seen = new Set(primarySkill ? [primarySkill] : []);
  const auxiliarySkills = [];
  for (const s of skillCalls.slice(1)) {
    if (!seen.has(s)) { seen.add(s); auxiliarySkills.push(s); }
  }
  return { primarySkill, auxiliarySkills };
}

// U2 R2.5.1: the exact runtime permission-wall text (permission-artifact fallback
// when toolDenialKind is absent but is_error is set).
const PERMISSION_WALL_RE = /Claude requested permissions to .+ but you haven't granted it yet/;

// U2 R2.5.1-R2.5.4: structurally classify a tool call's outcome. Never reads model
// natural language — decides purely on toolDenialKind / is_error / the permission-wall
// text so [U3] L1 can separate "blocked by permission" from "the model never tried".
//   'missed'             — no upstream tool_use at all (the model never called the tool)
//   'permission-artifact'— denialKind present, or is_error + permission-wall text (R2.5.1)
//   'error'              — a genuine (non-permission) tool error; is_error set (not success)
//   'success'            — no is_error and no denialKind (R2.5.3)
// Pass a tool call object (which by construction carries an upstream tool_use); pass
// hasUpstreamToolUse:false (or a nullish call) to assert the 'missed' state (R2.5.2).
export function classifyToolResult(call, { hasUpstreamToolUse = call != null } = {}) {
  if (!call || !hasUpstreamToolUse) return 'missed';
  if (call.denialKind != null) return 'permission-artifact';
  if (call.isError === true) {
    return PERMISSION_WALL_RE.test(String(call.result ?? '')) ? 'permission-artifact' : 'error';
  }
  return 'success';
}

// U2 R2.3.1/R2.3.2/R2.3.3: correct skill-body context cost — sum of the isMeta body
// text hung back onto each Skill tool_use, estimated as chars/4. Returns null when NO
// Skill call has a body (R2.3.3: never impersonate the 28-char launch tool_result).
// This is the replacement source for the lab.js:754 skillBodyCostEst bug; wiring
// (rep.skillBodyCostEst = skillBodyCostEst(run)) is left to the U3/U4 agent that owns lab.js.
export function skillBodyCostEst(run) {
  let total = 0, found = false;
  for (const round of run?.rounds ?? []) {
    for (const tc of round.toolCalls ?? []) {
      if (tc.name === 'Skill' && typeof tc.skillBody === 'string' && tc.skillBody.length > 0) {
        total += tc.skillBody.length / 4;
        found = true;
      }
    }
  }
  return found ? Math.round(total) : null;
}
