// Fake external-runtime adapter for lab tests. ADAPTER_MODE: trace (default) | plain
if (!process.argv.includes('--prompt')) process.exit(0); // guard for node --test discovery

const mode = process.env.ADAPTER_MODE ?? 'trace';
const base = { result: 'The ETH price is $1,999.42 on Ethereum.', total_cost_usd: 0.005 };
if (mode === 'plain') {
  process.stdout.write(JSON.stringify(base));
} else {
  process.stdout.write(JSON.stringify({
    ...base,
    trace: [
      {
        text: '', skill: 'okx-dex-market', durationMs: 800,
        usage: { in: 900, out: 40, cacheW: 0, cacheR: 1500 },
        toolCalls: [{ name: 'market_price', isError: false, input: { address: '0xeeee' }, result: '{"price":"1999.42"}' }],
      },
      {
        text: 'The ETH price is $1,999.42 on Ethereum.', durationMs: 600,
        usage: { in: 1000, out: 60, cacheW: 0, cacheR: 1600 },
      },
    ],
  }));
}
