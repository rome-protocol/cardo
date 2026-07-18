// Meteora DAMM v1 swap (main /swap route) — unhappy-path cases.
//
// Covers the pool registry in lib/meteora-pool.ts: the canonical
// USDC↔WSOL pool plus the LST pools (USDC↔mSOL, USDC↔wJitoSOL) added
// 2026-07-05. Fills the historical gap where the main-/swap builder
// (buildChainMeteoraSwapInvoke) had no harness case.

import { buildChainMeteoraSwapInvoke } from '../../lib/meteora-swap';
import {
  ROME_METEORA_POOL_USDC_MSOL,
  ROME_METEORA_POOL_USDC_WJITOSOL,
} from '../../lib/meteora-pool';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// Pool variant whose pool account is the System Program: exists (passes
// the strict-mode loader's existence check on that slot) but can't
// deserialize as a DAMM v1 Pool.
const FAKE_POOL = {
  ...ROME_METEORA_POOL_USDC_MSOL,
  pool: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

const cases: TestCaseFile = [
  {
    name: 'meteora.swap.msol.fresh-user-no-input-ata',
    description:
      'USDC→mSOL on the seeded LST pool from a fresh user → Anchor 3012 (AccountNotInitialized) on the missing user ATA.',
    build: () =>
      buildChainMeteoraSwapInvoke({
        userEvmAddress: FRESH_USER_EVM,
        direction: 'AToB', // USDC (A) in → mSOL (B) out
        amountIn: 1_000n,
        minimumOut: 0n,
        pool: ROME_METEORA_POOL_USDC_MSOL,
      }),
    expect: {
      // DAMM v1 is Anchor-validated: the emulator surfaces Anchor 30xx
      // (AccountNotInitialized on the fresh user's ATA) before the Rome
      // strict-mode loader — same class as tests/cases/dlmm.ts.
      revertContains: 'Custom',
    },
  },
  {
    name: 'meteora.swap.wjitosol.fresh-user-no-input-ata',
    description:
      'USDC→wJitoSOL on the seeded LST pool from a fresh user → Anchor 3012 (AccountNotInitialized) on the missing user ATA.',
    build: () =>
      buildChainMeteoraSwapInvoke({
        userEvmAddress: FRESH_USER_EVM,
        direction: 'AToB',
        amountIn: 1_000n,
        minimumOut: 0n,
        pool: ROME_METEORA_POOL_USDC_WJITOSOL,
      }),
    expect: {
      // DAMM v1 is Anchor-validated: the emulator surfaces Anchor 30xx
      // (AccountNotInitialized on the fresh user's ATA) before the Rome
      // strict-mode loader — same class as tests/cases/dlmm.ts.
      revertContains: 'Custom',
    },
  },
  {
    name: 'meteora.swap.fake-pool-account',
    description:
      'Pass System Program in place of the pool account → cannot deserialize as a DAMM v1 Pool.',
    build: () =>
      buildChainMeteoraSwapInvoke({
        userEvmAddress: FRESH_USER_EVM,
        direction: 'AToB',
        amountIn: 1_000n,
        minimumOut: 0n,
        pool: FAKE_POOL,
      }),
    expect: {
      revertContains: 'Custom',
    },
  },
];

export default cases;
