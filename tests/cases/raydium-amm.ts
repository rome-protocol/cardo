// Raydium AMM v4 swap_base_in — unhappy-path cases.

import { buildRaydiumAmmV4SwapBaseInInvoke } from '../../lib/raydium-amm-instructions';
import { ENABLED_RAYDIUM_AMM_V4_POOLS } from '../../lib/raydium-amm-pools';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const REAL_POOL = ENABLED_RAYDIUM_AMM_V4_POOLS[0];
if (!REAL_POOL) {
  throw new Error(
    'tests/cases/raydium-amm.ts: ENABLED_RAYDIUM_AMM_V4_POOLS is empty — registry not seeded for tests',
  );
}

// Construct a pool variant whose `poolHex` is the System Program. The
// account exists (so we get past Rome's strict-mode loader's existence
// check on that slot) but won't deserialize as AmmInfo — Raydium will
// revert with InvalidAmmAccountOwner if it gets that far. In practice
// the user's source ATA also doesn't exist on a fresh PDA, so the
// strict-mode loader catches that first with "account not found".
const FAKE_POOL = {
  ...REAL_POOL,
  poolHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

const cases: TestCaseFile = [
  {
    name: 'raydium-amm.swap.fresh-user-no-source-ata',
    description:
      'swap_base_in from a fresh user → user source ATA does not exist → Rome strict-mode loader rejects with `account not found`.',
    build: () =>
      buildRaydiumAmmV4SwapBaseInInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL,
        inputIsCoin: true,
        amountIn: 1_000n,
        minimumAmountOut: 0n,
      }),
    expect: {
      // The user's source ATA is one of the writable accounts the swap
      // touches; on a fresh PDA it doesn't exist, so the strict-mode
      // loader catches it before the AMM v4 program runs. If loader
      // behavior loosens, the program will revert with InvalidAmmAccountOwner
      // (or a serum-side error) — bump this matcher accordingly.
      revertContains: 'Custom',
    },
  },
  {
    name: 'raydium-amm.swap.fake-pool-account',
    description:
      'Pass System Program in place of the AmmInfo account → Raydium rejects with InvalidAmmAccountOwner (or strict-mode loader catches the missing user ATA first).',
    build: () =>
      buildRaydiumAmmV4SwapBaseInInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: FAKE_POOL,
        inputIsCoin: true,
        amountIn: 1_000n,
        minimumAmountOut: 0n,
      }),
    expect: {
      revertContains: 'Custom',
    },
  },
];

export default cases;
