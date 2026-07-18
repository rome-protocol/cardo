// SPL stake-pool — unhappy-path cases.
//
// ⚠ Devnet-program version canary: the spl-stake-pool deployment on
// Solana devnet (SPoo1Ku8…, last deployed slot 197328814) PREDATES the
// slippage instruction variants (tags 22-25, added upstream mid-2023).
// Any *WithSlippage ix therefore fails at instruction dispatch with
// BorshIoError — before a single account is inspected. Verified
// 2026-07-07 by simulating tag 16 vs tag 25 with identical accounts
// against the live devnet program: tag 16 executes, tag 25 →
// "Error: BorshIoError".
//
// That is why the UI must use DepositSol (14) / WithdrawSol (16) on
// devnet. The two slippage cases below assert the BorshIoError so we
// notice when the devnet deployment is ever upgraded (they'll start
// failing with an account-level error instead → the UI can switch back
// to the slippage variants and regain the on-chain min-out guard).

import {
  buildDepositSolWithSlippageInvoke,
  buildWithdrawSolInvoke,
  buildWithdrawSolWithSlippageInvoke,
} from '../../lib/stake-pool-instructions';
import { ENABLED_STAKE_POOLS } from '../../lib/stake-pool-registry';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

const REAL_POOL = ENABLED_STAKE_POOLS[0];
if (!REAL_POOL) {
  throw new Error(
    'tests/cases/stake-pool.ts: ENABLED_STAKE_POOLS empty — registry not seeded',
  );
}

const cases: TestCaseFile = [
  {
    name: 'stake-pool.withdraw-sol.fresh-user-no-pool-ata',
    description:
      'Plain WithdrawSol (tag 16 — the ix /stake Unstake actually submits) from a fresh user → pool-token ATA does not exist → program-level InvalidAccountData. Crucially NOT BorshIoError: tag 16 gets past instruction dispatch on the devnet program.',
    build: () =>
      buildWithdrawSolInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL.pool,
        poolTokensIn: 1n,
      }),
    expect: { revertContains: 'InvalidAccountData' },
  },
  {
    name: 'stake-pool.deposit-sol-with-slippage.devnet-program-canary',
    description:
      'DepositSolWithSlippage (tag 24) — devnet program predates slippage variants → BorshIoError at dispatch. Starts failing differently when devnet SPoo1… is upgraded.',
    build: () =>
      buildDepositSolWithSlippageInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL.pool,
        lamports: 1_000_000n,
        minimumPoolTokensOut: 1n,
      }),
    expect: { revertContains: 'BorshIoError' },
  },
  {
    name: 'stake-pool.withdraw-sol-with-slippage.devnet-program-canary',
    description:
      'WithdrawSolWithSlippage (tag 25) — devnet program predates slippage variants → BorshIoError at dispatch. Starts failing differently when devnet SPoo1… is upgraded.',
    build: () =>
      buildWithdrawSolWithSlippageInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: REAL_POOL.pool,
        poolTokensIn: 1n,
        minimumLamportsOut: 1n,
      }),
    expect: { revertContains: 'BorshIoError' },
  },
];

export default cases;
