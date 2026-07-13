// Fake okx-onchainos-demo server for service-lifecycle tests: same HTTP surface the
// SSE driver talks to (POST /api/chats, GET /api/chat/stream, POST /api/chat/message).
// STUB_MODE: ok (default, with turn_usage frames) | nousage (old demo build without
// turn_usage) | error (agent errors, no answer) | silent (never replies → driver timeout)
import { createServer } from 'node:http';

if (!process.env.STUB_PORT) process.exit(0); // guard for node --test discovery

const mode = process.env.STUB_MODE ?? 'ok';
const subscribers = new Map(); // chatId → SSE response

const send = (res, frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/chats') {
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'chat-stub-1' }));
  }
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('[]');
  }
  // Self-descriptor endpoint (runtime_info) — same response shape as the real demo's
  // GET /api/runtime-info. Only in default mode: 'nousage' plays an OLD demo build
  // (no turn_usage, no introspection endpoint → 404 → driver silently skips).
  if (req.method === 'GET' && url.pathname === '/api/runtime-info' && mode === 'ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      name: 'okx-onchainos-demo',
      version: '0.1.0-stub',
      promptParams: { locale: 'zh-CN', mode: url.searchParams.get('mode') ?? 'alpha', wallet: null, sessionToken: null },
      systemPromptText: 'You are "OnChain AI" (stub prompt).\n\nALPHA MODE',
      promptNote: 'Not-logged-in form; wallet sessions append a per-session wallet section.',
      tools: [
        { name: 'mcp__onchainos__market_price', kind: 'mcp' },
        { name: 'AskUserQuestion', kind: 'builtin' },
      ],
    }));
  }
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chatId = url.searchParams.get('chatId');
    subscribers.set(chatId, res);
    send(res, { type: 'history', messages: [], chatId });
    send(res, { type: 'connected', chatId });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/chat/message') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const { chatId } = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      const sse = subscribers.get(chatId);
      if (!sse || mode === 'silent') return;
      if (mode === 'error') {
        send(sse, { type: 'error', error: 'model exploded', chatId });
        send(sse, { type: 'result', success: false, turns: 1, duration: 10, chatId });
        return;
      }
      const usage = mode === 'nousage' ? null : true;
      send(sse, { type: 'user_message', content: 'q', chatId });
      if (usage) send(sse, { type: 'turn_usage', usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 }, usdCost: 0.003, chatId });
      send(sse, { type: 'tool_use', toolName: 'market_price', toolId: 't1', toolInput: { chain: 'ethereum' }, chatId });
      send(sse, { type: 'tool_result', toolName: 'market_price', toolId: 't1', output: { price: '1999.42' }, durationMs: 120, chatId });
      send(sse, { type: 'tool_use', toolName: 'market_price', toolId: 't2', toolInput: { chain: 'base' }, chatId });
      send(sse, { type: 'tool_result', toolName: 'market_price', toolId: 't2', output: 'Error: no liquidity', durationMs: 40, chatId });
      if (usage) send(sse, { type: 'turn_usage', usage: { input_tokens: 1100, output_tokens: 80, cache_read_input_tokens: 1600, cache_creation_input_tokens: 50 }, usdCost: 0.002, chatId });
      send(sse, { type: 'stream_text', text: 'The ETH', chatId });
      send(sse, { type: 'assistant_message', content: 'The ETH price is $1,999.42 on Ethereum.', chatId });
      send(sse, { type: 'result', success: true, turns: 2, duration: 500, chatId });
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(Number(process.env.STUB_PORT), '127.0.0.1');
