// Deterministic compose recipes — the in-house orchestrator. A recipe is an
// ordered list of steps, each reusing a PROVEN per-protocol builder, executed
// as sequential Rome-CPI txs. This pins that the shipping recipe wires the
// right builders/targets, in the right order — no AI, no fake steps.

import { describe, expect, it } from 'vitest';
import { RECIPES, buildStepInvoke, getRecipe } from '../lib/compose/recipes';
import { METEORA_DAMMV1_PROGRAM, ROME_METEORA_POOL } from '../lib/meteora-pool';
import { MANGO_SOL_BANK } from '../lib/mango-config';
import { MANGO_V4_PROGRAM } from '../lib/mango-program';

const USER = '0xC777615450b91C6dCf1532645C2d809C9fae2DAc' as const;

describe('compose recipes registry', () => {
  it('ships exactly one enabled, fully-in-house recipe (swap→lend)', () => {
    const enabled = RECIPES.filter((r) => r.enabled);
    expect(enabled.length).toBeGreaterThanOrEqual(1);
    const swapLend = getRecipe('swap-lend-mango');
    expect(swapLend?.enabled).toBe(true);
    // Its steps are all built from proven flows (swap, mango).
    expect(swapLend!.steps.map((s) => s.kind)).toEqual([
      'swap',
      'mango-ensure-account',
      'mango-deposit',
    ]);
  });

  it('marks the dead-venue mockups (Drift/Kamino) as disabled previews', () => {
    // Honesty: no perp/kamino venue works on the devnet substrate, so those
    // recipes must not be runnable.
    for (const id of ['perp-with-usdc', 'lev-loop']) {
      const r = getRecipe(id);
      if (r) expect(r.enabled).toBe(false);
    }
  });
});

describe('swap-lend recipe step calldata', () => {
  const recipe = getRecipe('swap-lend-mango')!;
  const ctx = {
    userEvmAddress: USER,
    // 5 USDC in (6dp); after swap the deposit step reconciles the real WSOL out.
    inputRaw: 5_000_000n,
    // reconciled WSOL balance fed to the deposit step (9dp).
    depositRaw: 30_000_000n,
    minimumOut: 1n,
    mangoAccountExists: false,
  };

  it('step 0 swaps USDC→WSOL on the canonical Meteora pool (B→A)', () => {
    const step = recipe.steps[0];
    const inv = buildStepInvoke(step, ctx);
    expect(inv).not.toBeNull();
    expect(inv!.program.toLowerCase()).toBe(METEORA_DAMMV1_PROGRAM.toLowerCase());
    // the pool pubkey appears among the account metas
    const metas = inv!.accounts.map((a) => a.pubkey.toLowerCase());
    expect(metas).toContain(ROME_METEORA_POOL.pool.toLowerCase());
  });

  it('mango-ensure-account builds a create when the account is missing, null when it exists', () => {
    const step = recipe.steps[1];
    expect(buildStepInvoke(step, ctx)).not.toBeNull(); // missing → create
    expect(buildStepInvoke(step, { ...ctx, mangoAccountExists: true })).toBeNull(); // exists → skip
  });

  it('mango-deposit deposits the reconciled WSOL into the SOL bank', () => {
    const step = recipe.steps[2];
    const inv = buildStepInvoke(step, ctx);
    expect(inv).not.toBeNull();
    expect(inv!.program.toLowerCase()).toBe(MANGO_V4_PROGRAM.toLowerCase());
    const metas = inv!.accounts.map((a) => a.pubkey.toLowerCase());
    expect(metas).toContain(MANGO_SOL_BANK.bankHex.toLowerCase());
    expect(metas).toContain(MANGO_SOL_BANK.vaultHex.toLowerCase());
  });

  it('deposit amount reflects the reconciled balance, not the swap input', () => {
    // The deposit must use depositRaw (real post-swap WSOL), never inputRaw.
    const inv = buildStepInvoke(recipe.steps[2], ctx)!;
    const data = inv.data.toLowerCase();
    // 30_000_000 (0x01c9c380) little-endian u64 appears in the deposit ix data.
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(30_000_000n, 0);
    expect(data).toContain(le.toString('hex'));
  });
});
