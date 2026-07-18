// PumpSwap LP — deposit / withdraw unhappy-path cases.

import {
  buildPumpSwapDepositInvoke,
  buildPumpSwapWithdrawInvoke,
} from '../../lib/pumpswap-instructions';
import { pumpswapActivePool } from '../../lib/pumpswap-pool-config';
import type { PumpSwapPool } from '../../lib/pumpswap-pools';
import { pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { Hex } from 'viem';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// Build a minimal PumpSwapPool struct from the pinned active pool's
// config so we don't need to fetch it.
const cfg = pumpswapActivePool();
const fakeCoinCreator = pubkeyBs58ToBytes32('11111111111111111111111111111111');
const fakeLpMint = pubkeyBs58ToBytes32('11111111111111111111111111111111');
const POOL: PumpSwapPool = {
  poolBump: 255,
  index: 0,
  creator: fakeCoinCreator,
  baseMint: pubkeyBs58ToBytes32(cfg.base.mintBs58),
  quoteMint: pubkeyBs58ToBytes32(cfg.quote.mintBs58),
  lpMint: fakeLpMint,
  poolBaseTokenAccount: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
  poolQuoteTokenAccount: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
  lpSupply: 0n,
  coinCreator: fakeCoinCreator,
  isMayhemMode: false,
  isCashbackCoin: false,
};

const cases: TestCaseFile = [
  {
    name: 'pumpswap.deposit.fresh-user-no-base-ata',
    description:
      'PumpSwap deposit from a fresh user → user base ATA does not exist → Anchor 3007 (account owned by wrong program). Verifies the 15-account deposit calldata. Post emulator refactor (the Rome EVM program #266 + #305) PumpSwap surfaces the owner mismatch via Custom(N) before the strict-mode loader sees it.',
    build: () =>
      buildPumpSwapDepositInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: POOL,
        poolPubkey: cfg.poolBs58,
        lpTokenAmountOut: 1n,
        maxBaseAmountIn: 1_000n,
        maxQuoteAmountIn: 1_000n,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'pumpswap.withdraw.fresh-user-no-base-ata',
    description:
      'PumpSwap withdraw from a fresh user → Anchor 3007 (account owned by wrong program). Verifies the 15-account withdraw calldata.',
    build: () =>
      buildPumpSwapWithdrawInvoke({
        userEvmAddress: FRESH_USER_EVM,
        pool: POOL,
        poolPubkey: cfg.poolBs58,
        lpTokenAmountIn: 1n,
        minBaseAmountOut: 0n,
        minQuoteAmountOut: 0n,
      }),
    expect: { revertContains: 'Custom' },
  },
];

export default cases;
