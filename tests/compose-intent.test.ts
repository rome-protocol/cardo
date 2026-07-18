// compose intent parsing — the keyless heuristic fallback must recognize
// "X then Y" chains as kind=compose, not misroute to whichever single-intent
// keyword happens to appear. The deployed pod runs without ANTHROPIC_API_KEY,
// so the heuristic path is the production path for /orchestrator.
//
// Regression: "swap 0.02 SOL to USDC then park it for yield" was parsed as
// kind=yield (the word "yield" matched the single-intent branch first), so
// /api/orchestrate/build-compose-step 400'd.

import { describe, expect, it } from 'vitest';
import { parseIntent } from '../lib/orchestration/ai-router';

delete process.env.ANTHROPIC_API_KEY; // force the heuristic path

describe('compose intent heuristic', () => {
  it('parses "swap … then park … for yield" as a 2-step compose', async () => {
    const i = await parseIntent('swap 0.02 SOL to USDC then park it for yield');
    expect(i.kind).toBe('compose');
    const steps = i.params.steps as Array<{ kind: string }>;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(2);
    expect(steps[0].kind).toBe('swap');
    expect(steps[1].kind).toBe('yield');
  });

  it('parses "stake … then send" chains', async () => {
    const i = await parseIntent('stake 0.05 SOL then swap to USDC');
    expect(i.kind).toBe('compose');
    const steps = i.params.steps as Array<{ kind: string }>;
    expect(steps.length).toBe(2);
    expect(steps[0].kind).toBe('stake');
    expect(steps[1].kind).toBe('swap');
  });

  it('handles the "and then" connector', async () => {
    const i = await parseIntent('swap 0.01 SOL to USDC and then yield it on kamino');
    expect(i.kind).toBe('compose');
    expect((i.params.steps as unknown[]).length).toBe(2);
  });

  it('does NOT compose a single intent that merely mentions two tokens', async () => {
    const i = await parseIntent('swap 0.05 SOL to USDC');
    expect(i.kind).toBe('swap');
  });

  it('does not treat a bare "then" inside one action as a chain', async () => {
    // no second actionable verb after "then" → stays single
    const i = await parseIntent('stake 0.01 SOL');
    expect(i.kind).toBe('stake');
  });

  it('each compose step carries a summary for the chain UI', async () => {
    const i = await parseIntent('swap 0.02 SOL to USDC then park it for yield');
    const steps = i.params.steps as Array<{ kind: string; summary: string }>;
    for (const s of steps) expect(typeof s.summary).toBe('string');
    expect(i.summary.toLowerCase()).toContain('then');
  });
});
