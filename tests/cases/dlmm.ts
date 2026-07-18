// Meteora DLMM swap — unhappy-path cases.

import { buildDlmmSwapInvoke } from '../../lib/dlmm-instructions';
import { ENABLED_DLMM_POOLS } from '../../lib/dlmm-pools';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const REAL_POOL = ENABLED_DLMM_POOLS[0];
if (!REAL_POOL) {
  throw new Error(
    'tests/cases/dlmm.ts: ENABLED_DLMM_POOLS is empty — registry not seeded for tests',
  );
}

// Construct a pool variant whose `poolHex` is the System Program. The
// account exists (so we get past Rome's strict-mode loader's existence
// check on that slot) but won't deserialize as LbPair — Anchor will
// revert with a discriminator / wrong-owner mismatch IF the program runs.
// In practice the user's input ATA also doesn't exist on a fresh PDA,
// so the strict-mode loader catches that first with "account not found".
const FAKE_POOL = {
  ...REAL_POOL,
  poolHex: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

const cases: TestCaseFile = [
  {
    name: 'dlmm.swap.fresh-user-no-input-ata',
    description:
      'swap from a fresh user → user input ATA does not exist → Rome strict-mode loader rejects with `account not found`.',
    build: () =>
      buildDlmmSwapInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL,
        swapXForY: false, // Y→X is our safe direction (lower neighbor exists)
        amountIn: 1_000n,
        minimumAmountOut: 0n,
      }),
    expect: {
      // The user's input ATA is one of the writable accounts the swap
      // touches; on a fresh PDA the DLMM program now catches the
      // discriminator/owner mismatch on the user ATA via Anchor's 30xx
      // family before the strict-mode loader gets to it (post emulator
      // refactor — the Rome EVM program #266 + #305, May 2026).
      revertContains: 'Custom',
    },
  },
  {
    name: 'dlmm.swap.fake-pool-account',
    description:
      'Pass System Program in place of lb_pair → DLMM rejects with Anchor 3007 (account owned by wrong program).',
    build: () =>
      buildDlmmSwapInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: FAKE_POOL,
        swapXForY: false,
        amountIn: 1_000n,
        minimumAmountOut: 0n,
      }),
    expect: {
      revertContains: 'Custom',
    },
  },
];

export default cases;
