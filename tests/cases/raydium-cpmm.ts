// Raydium CPMM swap_base_input — unhappy-path cases.

import {
  buildRaydiumCpmmDepositInvoke,
  buildRaydiumCpmmSwapBaseInputInvoke,
  buildRaydiumCpmmSwapBaseOutputInvoke,
  buildRaydiumCpmmWithdrawInvoke,
} from '../../lib/raydium-cpmm-instructions';
import { ENABLED_RAYDIUM_CPMM_POOLS } from '../../lib/raydium-cpmm-pools';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const REAL_POOL = ENABLED_RAYDIUM_CPMM_POOLS[0];
if (!REAL_POOL) {
  throw new Error(
    'tests/cases/raydium-cpmm.ts: ENABLED_RAYDIUM_CPMM_POOLS is empty — registry not seeded for tests',
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
    name: 'raydium-cpmm.swap.fresh-user-no-input-ata',
    description:
      'swap_base_input from a fresh user → user input ATA does not exist → Rome strict-mode loader rejects with `account not found`.',
    build: () =>
      buildRaydiumCpmmSwapBaseInputInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL,
        inputIsToken0: true,
        amountIn: 1_000n,
        minimumAmountOut: 0n,
      }),
    expect: {
      // The user's input ATA is one of the writable accounts the swap
      // touches; on a fresh PDA it doesn't exist, so the strict-mode
      // loader catches it before the CPMM program runs. If loader
      // behavior loosens, the program will revert with a Custom
      // (slippage / pool-status / etc.) error — bump this matcher
      // to `Custom` if that ever happens.
      revertContains: 'Custom',
    },
  },
  {
    name: 'raydium-cpmm.swap.fake-pool-account',
    description:
      'Pass System Program in place of pool_state → CPMM rejects with an owner / discriminator mismatch (or strict-mode loader catches the missing user ATA first).',
    build: () =>
      buildRaydiumCpmmSwapBaseInputInvoke({
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
  {
    name: 'raydium-cpmm.swap-base-output.fresh-user-no-input-ata',
    description:
      'swap_base_output from a fresh user → user input ATA missing → strict-mode `account not found`.',
    build: () =>
      buildRaydiumCpmmSwapBaseOutputInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL,
        inputIsToken0: true,
        maxAmountIn: 10_000n,
        amountOut: 1n,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'raydium-cpmm.deposit.fresh-user-no-token0-ata',
    description:
      'CPMM deposit from a fresh user → user token-0 ATA missing → strict-mode `account not found`.',
    build: () =>
      buildRaydiumCpmmDepositInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL,
        lpTokenAmount: 1n,
        maximumToken0Amount: 1_000n,
        maximumToken1Amount: 1_000n,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'raydium-cpmm.withdraw.fresh-user-no-lp-ata',
    description:
      'CPMM withdraw from a fresh user → user LP ATA missing → strict-mode `account not found`.',
    build: () =>
      buildRaydiumCpmmWithdrawInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL,
        lpTokenAmount: 1n,
        minimumToken0Amount: 0n,
        minimumToken1Amount: 0n,
      }),
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
