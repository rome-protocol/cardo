// Pump.fun bonding-curve buy/sell — unhappy-path cases.
//
// Closes the coverage gap flagged by tests/contract/coverage.contract.test.ts
// (and the adapters audit): pumpfun shipped a builder + live curve fetch but
// no test case. Pattern mirrors raydium-amm — a fresh user has no associated
// token account, so Rome's strict-mode loader rejects before the Pump.fun
// program runs.

import {
  buildPumpFunBuyInvoke,
  buildPumpFunSellInvoke,
} from '../../lib/pumpfun-instructions';
import { PUMPFUN_DEFAULT } from '../../lib/pumpfun-config';
import type { BondingCurve } from '../../lib/pumpfun-curves';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// Minimal decoded curve — only `creator` is used to derive creator_vault.
// The buy/sell never gets that far for a fresh user (no associated_user ATA),
// so placeholder reserves are fine.
const FAKE_CURVE: BondingCurve = {
  virtualTokenReserves: 1_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 0n,
  realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  creator: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

const cases: TestCaseFile = [
  {
    name: 'pumpfun.buy.fresh-user-no-associated-ata',
    description:
      'buy from a fresh user → their associated_user ATA for the memecoin mint does not exist → Rome strict-mode loader rejects before Pump.fun runs.',
    build: () =>
      buildPumpFunBuyInvoke({
        userEvmAddress: FRESH_USER_EVM,
        mintHex: PUMPFUN_DEFAULT.mintHex,
        curve: FAKE_CURVE,
        amount: 1_000n,
        maxSolCost: 1_000_000_000n,
      }),
    expect: {
      // Fresh PDA has no associated_user ATA (a writable account the buy
      // touches); loader catches it first. If loader behavior loosens,
      // Pump.fun reverts with its own Custom error — bump accordingly.
      revertContains: 'Custom',
    },
  },
  {
    name: 'pumpfun.sell.fresh-user-no-associated-ata',
    description:
      'sell from a fresh user → no associated_user ATA holding the memecoin → strict-mode loader rejects with `account not found`/Custom.',
    build: () =>
      buildPumpFunSellInvoke({
        userEvmAddress: FRESH_USER_EVM,
        mintHex: PUMPFUN_DEFAULT.mintHex,
        curve: FAKE_CURVE,
        amount: 1_000n,
        minSolOutput: 0n,
      }),
    expect: {
      revertContains: 'Custom',
    },
  },
];

export default cases;
