// Raydium CLMM swap_v2 — unhappy-path cases.

import { buildRaydiumClmmSwapV2Invoke } from '../../lib/raydium-clmm-instructions';
import { ENABLED_RAYDIUM_CLMM_POOLS } from '../../lib/raydium-clmm-pools';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const REAL_POOL = ENABLED_RAYDIUM_CLMM_POOLS[0];
if (!REAL_POOL) {
  throw new Error(
    'tests/cases/raydium-clmm.ts: ENABLED_RAYDIUM_CLMM_POOLS is empty — registry not seeded for tests',
  );
}

// Construct a pool variant whose `poolHex` is the System Program. The
// account exists (so we get past Rome's strict-mode loader's existence
// check on that slot) but won't deserialize as PoolState — Anchor will
// revert with a discriminator / wrong-owner mismatch IF the program runs.
// In practice the user's input ATA also doesn't exist on a fresh PDA,
// so the strict-mode loader catches that first with "account not found".
const FAKE_POOL = {
  ...REAL_POOL,
  poolHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

const cases: TestCaseFile = [
  {
    name: 'raydium-clmm.swap.fresh-user-no-input-ata',
    description:
      'swap_v2 from a fresh user → user input ATA does not exist → Rome strict-mode loader rejects with `account not found`.',
    build: () =>
      buildRaydiumClmmSwapV2Invoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL,
        inputIsToken0: true,
        amountIn: 1_000n,
        minimumAmountOut: 0n,
      }),
    expect: {
      // The user's input ATA is one of the writable accounts the swap
      // touches; on a fresh PDA it doesn't exist, so the strict-mode
      // loader catches it before the CLMM program runs. If loader
      // behavior loosens, the program will revert with an Anchor /
      // Custom error — bump this matcher to `Custom` if that ever
      // happens.
      revertContains: 'Custom',
    },
  },
  {
    name: 'raydium-clmm.swap.fake-pool-account',
    description:
      'Pass System Program in place of pool_state → CLMM rejects with owner / discriminator mismatch (or strict-mode loader catches the missing user ATA first).',
    build: () =>
      buildRaydiumClmmSwapV2Invoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: FAKE_POOL,
        inputIsToken0: true,
        amountIn: 1_000n,
        minimumAmountOut: 0n,
      }),
    expect: {
      revertContains: 'Custom',
    },
  },
];

export default cases;
