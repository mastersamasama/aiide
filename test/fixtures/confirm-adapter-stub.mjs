// Stub command-adapter exercising the interactive-gate contract v2 (subsystem 3, adapter transport).
// First invocation → halts asking for confirmation. On resume (AIIDE_RESUME set) → executes + answers.
const resume = process.env.AIIDE_RESUME;
if (!resume) {
  process.stdout.write(JSON.stringify({
    result: '',
    trace: [{ text: 'I need your confirmation before executing the swap.', toolCalls: [] }],
    halted: true, ask: { question: 'Confirm the swap of 0.01 ETH → USDC?' }, resumeRef: 'chat-xyz',
  }));
} else {
  process.stdout.write(JSON.stringify({
    result: `Swap executed after your confirmation ("${process.env.AIIDE_REPLY ?? ''}"). You received $5.00 in USDC.`,
    trace: [{
      text: 'Swap executed. You received $5.00 in USDC.',
      toolCalls: [{ name: 'Bash', input: { command: 'onchainos swap execute --confirm' }, result: 'ok', isError: false }],
    }],
    total_cost_usd: 0.001,
  }));
}
