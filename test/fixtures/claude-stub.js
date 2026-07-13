// Fake `claude` binary for lab runner tests. Mimics headless behavior:
// writes a session JSONL into CLAUDE_CONFIG_DIR/projects/ and prints a result JSON to stdout.
// STUB_MODE: ok (default) | hang | fail | nolog | envnoise | envnoise-once
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// guard: node --test discovers every .js under test/ — do nothing unless invoked as a claude stand-in
if (!process.argv.includes('-p')) process.exit(0);

const mode = process.env.STUB_MODE ?? 'ok';
// env-noise: fail with an infra signature (auth-expiry 53017) the retry whitelist recognizes
if (mode === 'envnoise') { process.stderr.write('onchainos error 53017: auth token expired\n'); process.exit(53); }
// envnoise-once: fail the FIRST invocation (create marker), then succeed — proves retry recovery
if (mode === 'envnoise-once') {
  const marker = process.env.STUB_COUNTER;
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, '1');
    process.stderr.write('HTTP 429 Too Many Requests\n');
    process.exit(1);
  }
  // else fall through to the ok path below
}
if (mode === 'hang') { setTimeout(() => {}, 60_000); }
else if (mode === 'fail') { process.stderr.write('boom'); process.exit(2); }
else {
  const sid = 'stub-session-' + Math.random().toString(36).slice(2, 8);
  if (mode !== 'nolog') {
    const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'stub-workspace');
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q' }] }, uuid: 'u1', timestamp: '2026-07-02T10:00:00.000Z', sessionId: sid }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'okx-dex-market' } }], stop_reason: 'tool_use', usage: { input_tokens: 500, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 } }, requestId: 'r1', uuid: 'a1', timestamp: '2026-07-02T10:00:02.000Z', sessionId: sid }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text: 'ETH is $2,500.12' }], stop_reason: 'end_turn', usage: { input_tokens: 600, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 1100 } }, requestId: 'r2', attributionSkill: 'okx-dex-market', uuid: 'a2', timestamp: '2026-07-02T10:00:05.000Z', sessionId: sid }),
    ];
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join('\n'));
  }
  // S3: optionally emit an artifact into the repeat workspace (cwd) so file_exists has something to find
  if (process.env.STUB_WRITE_FILE) {
    const p = join(process.cwd(), process.env.STUB_WRITE_FILE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ price: 2500.12, symbol: 'ETH' }));
  }
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', result: 'ETH is currently $2,500.12 on Ethereum.',
    session_id: sid, total_cost_usd: 0.0123, num_turns: 2,
  }));
}
