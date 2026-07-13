#!/usr/bin/env node
// Adapter driver skeleton for okx-onchainos-demo (frontend-first browser agent).
// Contract: print ONE JSON object to stdout — { result, total_cost_usd?, trace? }.
// Requires: `npm i playwright` (or reuse the demo repo's own playwright install),
// demo running locally (bun run dev), DEMO_URL env or default below.
//
// This is a working skeleton: the two TODO selectors must match the demo's chat UI.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  prompt: { type: 'string' }, model: { type: 'string' },
} });
const DEMO_URL = process.env.DEMO_URL ?? 'http://localhost:5173';

try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(DEMO_URL, { waitUntil: 'networkidle' });

  // TODO(selector): the chat input of the demo UI
  const input = page.locator('textarea, [contenteditable="true"]').first();
  await input.fill(values.prompt ?? '');
  await input.press('Enter');

  // TODO(selector): last assistant message bubble; adjust to the demo's DOM
  const lastMsg = page.locator('[data-role="assistant"], .assistant-message').last();
  // wait until streaming settles (text stops growing)
  let prev = '', stable = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && stable < 3) {
    await page.waitForTimeout(1000);
    const cur = (await lastMsg.textContent().catch(() => '')) ?? '';
    stable = cur && cur === prev ? stable + 1 : 0;
    prev = cur;
  }

  // white-box trace hook (recommended): demo exposes per-round usage/toolCalls in test mode
  const trace = await page.evaluate(() => globalThis.__aiideTrace ?? null).catch(() => null);
  // cost ledger from the demo's IndexedDB, if exposed similarly
  const cost = await page.evaluate(() => globalThis.__aiideCostUsd ?? null).catch(() => null);

  await browser.close();
  process.stdout.write(JSON.stringify({
    result: prev,
    ...(typeof cost === 'number' ? { total_cost_usd: cost } : {}),
    ...(Array.isArray(trace) ? { trace } : {}),
  }));
} catch (err) {
  // non-JSON stdout → aiide records the repeat as failed with this stderr
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
}
