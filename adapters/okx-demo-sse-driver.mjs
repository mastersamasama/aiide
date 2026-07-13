#!/usr/bin/env node
// aiide command-adapter driver for okx-onchainos-demo's server-side agent loop.
// Zero deps: plain fetch + SSE parsing. The demo server must run with ENABLE_SSE=1
// (aiide's runtime.service sets this when it owns the lifecycle).
//
// Flow: POST /api/chats → chatId, open GET /api/chat/stream (mode=alpha so tools
// auto-approve — other modes stall on ask_user with no UI to answer), then
// POST /api/chat/message and collect broadcast frames until `result`.
// Output (stdout, single JSON):
//   { result, trace: [{ text, durationMs, usage?, toolCalls }], observability,
//     total_cost_usd?, runtime_info? }
// `usage` comes from the demo's `turn_usage` broadcast (server/agent-loop.ts emits the
// Messages API usage per turn). Older demo builds without that event still work —
// steps just carry no usage and aiide scores H as n/a instead of a fake-perfect score.
// `runtime_info` comes from the demo's GET /api/runtime-info introspection endpoint
// (name/version/systemPromptText/tools) — full prompt text is passed through verbatim
// so aiide recomputes the fingerprint; endpoint missing/unreachable → field omitted.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.env.AIIDE_SERVICE_URL ?? 'http://127.0.0.1:3901').replace(/\/$/, '');
const prompt = process.argv[2];
const timeoutMs = Number(process.env.AIIDE_DRIVER_TIMEOUT_MS ?? 180_000);

if (!prompt) fail(2, 'usage: okx-demo-sse-driver.mjs "<prompt>"  (AIIDE_SERVICE_URL to point at the server)');

// Fixed session token: the demo keys each session's ONCHAINOS_HOME (wallet auth) by
// sha256(token) — a random token per repeat would get an empty, unauthenticated home
// and every on-chain tool call would fail with code 53017.
const sessionToken = process.env.AIIDE_SESSION_TOKEN ?? 'aiide-bench';

// Interactive-gate contract v2 (aiide responder): when the agent asks (ask_user), the driver emits a
// `halted` output object instead of hard-failing; aiide's responder decides a reply and re-invokes
// us with AIIDE_RESUME=<chatId> so we continue the SAME chat (the reply arrives as argv[2]/{{PROMPT}}).
const resumeChatId = process.env.AIIDE_RESUME || null;

// Seed: copy an already-logged-in onchainos home (same machine — the TEE keyring is
// machine-bound) into the demo's per-session home for our token. Re-copied on EVERY
// driver start, not just once: the access token in session.json is short-lived
// (~1h), so a stale snapshot fails intermittently with 53017 mid-suite.
// It's a COPY: benchmark runs never mutate the user's global onchainos session.
const seedFrom = process.env.OKX_DEMO_SEED_HOME;
const homesDir = process.env.OKX_DEMO_HOMES_DIR;
if (seedFrom && homesDir && existsSync(join(seedFrom, 'session.json'))) {
  const target = join(homesDir, createHash('sha256').update(sessionToken).digest('hex'));
  mkdirSync(target, { recursive: true });
  for (const f of ['session.json', 'wallets.json', 'cache.json', 'chain_cache.json']) {
    if (existsSync(join(seedFrom, f))) cpSync(join(seedFrom, f), join(target, f));
  }
}
const headers = { 'content-type': 'application/json', 'x-session-token': sessionToken };

// Self-descriptor (runtime_info, design §4): ask the demo what runtime we are measuring.
// Fired at startup so it overlaps the chat run; a missing/old endpoint or failure is
// silently skipped — observability is additive and must never fail the run. mode=alpha
// and default locale (zh-CN) match the stream params below, so the reported prompt is
// the one this session's assembly actually uses — in its not-logged-in form. A seeded
// wallet home (see above) makes the LIVE session append a per-session "## User Wallet"
// section the endpoint cannot know; we still pass the full text verbatim and let aiide
// recompute the fingerprint — drift/mismatch detection is the design's honest channel
// (no driver-side special-casing; disclosed in docs/adapters.md §4.2).
const runtimeInfoPromise = fetch(`${base}/api/runtime-info?mode=alpha`, {
  headers, signal: AbortSignal.timeout(15_000),
}).then(r => (r.ok ? r.json() : null)).catch(() => null);

let chatId = resumeChatId;
if (!chatId) {
  const chatRes = await fetch(`${base}/api/chats`, {
    method: 'POST', headers, body: JSON.stringify({ title: 'aiide-bench' }),
  }).catch(err => fail(1, `cannot reach service at ${base}: ${err.message}`));
  if (!chatRes.ok) fail(1, `POST /api/chats → HTTP ${chatRes.status}`);
  chatId = (await chatRes.json()).id;
}

const ctrl = new AbortController();
const killTimer = setTimeout(() => ctrl.abort(), timeoutMs);

const sse = await fetch(
  `${base}/api/chat/stream?chatId=${encodeURIComponent(chatId)}&sessionToken=${sessionToken}&mode=alpha`,
  { headers: { accept: 'text/event-stream', 'x-session-token': sessionToken }, signal: ctrl.signal },
).catch(err => fail(1, `SSE connect failed: ${err.message}`));
if (!sse.ok || !sse.body) fail(1, `GET /api/chat/stream → HTTP ${sse.status}`);

// trace state: one step per API turn — `turn_usage` (emitted once per Messages request,
// right after the model reply and before that turn's tools run) is the turn boundary,
// so each step carries exactly its own usage + tool calls + text.
const steps = [];
const pending = new Map(); // toolId → toolCall (result arrives later)
let current = newStep();
let finalText = '';
let runError = null;
let resultFrame = null;
let connected = false;
let costUsdTotal = 0;
let hasReportedCost = false;
let askEvent = null;   // contract v2: set when the agent halts on ask_user
let halted = false;

function newStep() { return { text: '', durationMs: 0, toolCalls: [], usage: null, _t0: Date.now() }; }
function flushStep() {
  if (current.text || current.toolCalls.length || current.usage) {
    current.durationMs = Date.now() - current._t0;
    const { _t0, usage, ...step } = current;
    steps.push(usage ? { ...step, usage } : step);
  }
  current = newStep();
}
function asText(v) { return typeof v === 'string' ? v : JSON.stringify(v); }

function handle(frame) {
  switch (frame.type) {
    case 'connected':
      connected = true;
      // subscribe confirmed → now it is safe to send the prompt
      fetch(`${base}/api/chat/message`, {
        method: 'POST', headers,
        body: JSON.stringify({ type: 'chat', chatId, content: prompt, sessionToken }),
      }).then(r => { if (!r.ok) fail(1, `POST /api/chat/message → HTTP ${r.status}`); })
        .catch(err => fail(1, `POST /api/chat/message failed: ${err.message}`));
      break;
    case 'tool_use':
      pending.set(frame.toolId, { name: frame.toolName, isError: false, input: frame.toolInput ?? null, result: null });
      break;
    case 'tool_result': {
      const call = pending.get(frame.toolId) ?? { name: frame.toolName, isError: false, input: null, result: null };
      pending.delete(frame.toolId);
      call.result = asText(frame.output);
      call.durationMs = frame.durationMs ?? 0;
      if (/^(Cancelled:|Error|User denied)/i.test(String(call.result))) call.isError = true;
      current.toolCalls.push(call);
      break;
    }
    case 'turn_usage':
      // new API turn begins → close the previous one
      flushStep();
      current.usage = {
        in: frame.usage?.input_tokens ?? 0,
        out: frame.usage?.output_tokens ?? 0,
        cacheW: frame.usage?.cache_creation_input_tokens ?? 0,
        cacheR: frame.usage?.cache_read_input_tokens ?? 0,
      };
      if (typeof frame.usdCost === 'number') { costUsdTotal += frame.usdCost; hasReportedCost = true; }
      break;
    case 'assistant_message':
      current.text = frame.content ?? '';
      finalText = current.text;
      break;
    case 'ask_user':
      // contract v2: capture the question + halt the stream; aiide's responder answers and resumes.
      askEvent = { question: frame.question ?? frame.prompt ?? asText(frame.content ?? ''), options: frame.options ?? null };
      halted = true;
      resultFrame = { halted: true }; // break the collection loop
      break;
    case 'error':
      runError = frame.error ?? 'unknown error';
      break;
    case 'result':
      resultFrame = frame;
      break;
    default: // history / user_message / stream_text / thinking / rate_limit — not needed for the trace
      break;
  }
}

const decoder = new TextDecoder();
let buf = '';
try {
  for await (const chunk of sse.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const data = block.split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try { handle(JSON.parse(data)); } catch { /* non-JSON frame — ignore */ }
    }
    if (resultFrame) break;
  }
} catch (err) {
  if (!resultFrame) fail(1, ctrl.signal.aborted ? `timed out after ${timeoutMs}ms waiting for result` : `SSE stream error: ${err.message}`);
}
clearTimeout(killTimer);
ctrl.abort(); // close the SSE connection

if (!connected) fail(1, 'never received `connected` frame — is the server running with ENABLE_SSE=1?');
flushStep();

// contract v2: the agent halted on ask_user → emit a `halted` output; aiide's responder decides a
// reply and re-invokes us with AIIDE_RESUME=<chatId> to continue the same chat. exit 0 (not a failure).
if (halted) {
  process.stdout.write(JSON.stringify({
    result: finalText || '',
    trace: steps,
    observability: ['trace', ...(steps.some(s => s.usage) ? ['usage'] : [])],
    ...(hasReportedCost ? { total_cost_usd: costUsdTotal } : {}),
    halted: true, ask: askEvent, resumeRef: chatId,
  }));
  process.exit(0);
}
if (!finalText && runError) fail(1, `agent errored with no answer: ${runError}`);
if (!finalText) fail(1, `no assistant_message received (result: ${JSON.stringify(resultFrame)})`);

// runtime_info: name/version/tools + FULL systemPromptText (aiide recomputes the
// sha256/bytes/tokensEst fingerprint from the text — verifiable beats self-reported,
// design §4). tools flatten to name strings per the adapter schema (docs/adapters.md
// §3.1); the endpoint's {name, kind} detail stays queryable on the demo side.
const info = await runtimeInfoPromise;
const runtimeInfo = info && typeof info === 'object' ? {
  name: info.name ?? null,
  version: info.version ?? null,
  ...(typeof info.systemPromptText === 'string' ? { systemPromptText: info.systemPromptText } : {}),
  ...(Array.isArray(info.tools) ? { tools: info.tools.map(t => t?.name).filter(Boolean) } : {}),
} : null;

// observability self-declaration reflects what THIS output actually carries (trace is
// unconditional; usage depends on turn_usage frames — old demo builds lack them; the
// runtime_info channel exists only when the introspection endpoint answered).
const observability = [
  'trace',
  ...(steps.some(s => s.usage) ? ['usage'] : []),
  ...(runtimeInfo ? ['runtime_info'] : []),
];

process.stdout.write(JSON.stringify({
  result: finalText,
  trace: steps,
  observability,
  ...(hasReportedCost ? { total_cost_usd: costUsdTotal } : {}),
  ...(runtimeInfo ? { runtime_info: runtimeInfo } : {}),
  demo: resultFrame ? { success: resultFrame.success, turns: resultFrame.turns, durationMs: resultFrame.duration } : null,
  ...(runError ? { runtimeError: runError } : {}),
}));

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}
