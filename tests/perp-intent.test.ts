// Perp is a first-class /perps surface now (Jupiter Perps, Solana-wallet lane) —
// NOT an AI-orchestrator intent. This guards that the orchestrator's keyless
// heuristic no longer emits `kind:'perp'` for perp-phrased text, so perp lives
// in exactly one place. (Regression guard for the #138-style "one home per
// capability" reframe applied to perps.)

import { describe, expect, it } from 'vitest';
import { parseIntent } from '../lib/orchestration/ai-router';

// Force the heuristic path regardless of the developer's shell env.
delete process.env.ANTHROPIC_API_KEY;

describe('orchestrator no longer handles perp', () => {
  it('does not route "short $12 of SOL at 3x" to perp', async () => {
    const i = await parseIntent('short $12 of SOL at 3x');
    expect(i.kind).not.toBe('perp');
  });

  it('does not route "long $50 ETH 5x leverage" to perp', async () => {
    const i = await parseIntent('long $50 ETH 5x leverage');
    expect(i.kind).not.toBe('perp');
  });

  it('does not route "close my SOL short position" to perp', async () => {
    const i = await parseIntent('close my SOL short position');
    expect(i.kind).not.toBe('perp');
  });

  // The other intent kinds still parse correctly — removing perp didn't
  // disturb them.
  it('still parses plain swaps', async () => {
    const i = await parseIntent('swap 0.05 SOL to USDC');
    expect(i.kind).toBe('swap');
  });

  it('still parses stake intents', async () => {
    const i = await parseIntent('stake 0.01 SOL for jitosol');
    expect(i.kind).toBe('stake');
  });
});
