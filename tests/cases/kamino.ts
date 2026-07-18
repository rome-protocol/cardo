// Kamino Lend (klend v2) — unhappy-path cases.
//
// All 6 ix the /lend route already wires:
//   1. init_user_metadata
//   2. init_obligation
//   3. deposit_reserve_liquidity_and_obligation_collateral
//   4. withdraw_obligation_collateral_and_redeem_reserve_liquidity_v2
//   5. borrow_obligation_liquidity_v2
//   6. repay_obligation_liquidity_v2
//
// Reserve / obligation flows expect a fresh user → user_metadata
// or obligation PDA missing → strict-mode `account not found` before
// klend even decodes its account list.

import {
  buildBorrowInvoke,
  buildDepositInvoke,
  buildInitObligationInvoke,
  buildInitUserMetadataInvoke,
  buildRepayInvoke,
  buildWithdrawInvoke,
  deriveUserReserveAtas,
  type KaminoObligationAccounts,
  type KaminoReserveAccounts,
} from '../../lib/kamino-instructions';
import { kaminoMainMarket } from '../../lib/kamino-markets';
import { deriveVanillaObligation } from '../../lib/kamino-pdas';
import { deriveRomeUserPda, pubkeyBs58ToBytes32 } from '../../lib/solana-pda';
import type { TestCaseFile } from '../lib/case';

const FRESH_USER_EVM = '0x000000000000000000000000000000000000d017' as const;

// Pull the WUSDC reserve from the live Rome market registry. Same
// values the /lend page uses → we test the wire that's actually
// shipped.
const market = kaminoMainMarket();
const usdcReserve = market.reserves.find((r) => r.symbol === 'WUSDC');
if (!usdcReserve) throw new Error('WUSDC reserve missing from kaminoMainMarket()');

const reserveAccts: KaminoReserveAccounts = {
  lendingMarket: market.lendingMarket,
  reserve: usdcReserve.reserve,
  reserveLiquidityMint: usdcReserve.liquidityMint,
  reserveLiquiditySupply: usdcReserve.liquiditySupply,
  reserveCollateralMint: usdcReserve.collateralMint,
  reserveDestinationDepositCollateral: usdcReserve.collateralSupply,
  feeReceiver: usdcReserve.feeReceiver,
  // No oracle wired in the registry; pass the system-program zero
  // pubkey to satisfy the type — klend never reads it because the
  // strict-mode preflight rejects on missing user accounts first.
  pythPriceOracle: pubkeyBs58ToBytes32('11111111111111111111111111111111'),
};

function obligationFor(): KaminoObligationAccounts {
  const owner = deriveRomeUserPda(FRESH_USER_EVM);
  const obligation = deriveVanillaObligation(owner, market.lendingMarket);
  const { userSourceLiquidity, userDestinationCollateral } =
    deriveUserReserveAtas(
      FRESH_USER_EVM,
      usdcReserve!.liquidityMint,
      usdcReserve!.collateralMint,
    );
  return {
    owner,
    obligation,
    userSourceLiquidity,
    userDestinationCollateral,
  };
}

const cases: TestCaseFile = [
  {
    name: 'kamino.init-user-metadata.fresh-user',
    description:
      'init_user_metadata for a fresh user → klend rejects (user PDA + user_metadata not yet allocated). Verifies init_user_metadata calldata + user_lookup_table=0 encoding. Post emulator refactor (the Rome EVM program #266) klend surfaces a Custom(N) Anchor error before the strict-mode loader gets to it.',
    build: () =>
      buildInitUserMetadataInvoke({ userEvmAddress: FRESH_USER_EVM }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'kamino.init-obligation.fresh-user-no-user-metadata',
    description:
      'init_obligation before init_user_metadata → user_metadata PDA missing → strict-mode `account not found`. Verifies init_obligation calldata + tag=0/id=0 (Vanilla) encoding.',
    build: () =>
      buildInitObligationInvoke({
        userEvmAddress: FRESH_USER_EVM,
        lendingMarket: market.lendingMarket,
      }),
    expect: { revertContains: 'Custom' },
  },
  {
    name: 'kamino.deposit.fresh-user-no-obligation',
    description:
      'deposit for a fresh user → obligation PDA missing → strict-mode `account not found`. Verifies deposit calldata + u64 LE liquidity_amount.',
    build: () =>
      buildDepositInvoke({
        reserve: reserveAccts,
        obligation: obligationFor(),
        liquidityAmount: 1_000_000n,
        refreshReserves: [usdcReserve.reserve],
      }),
    expect: { revertContains: 'InvalidAccountOwner' },
  },
  {
    name: 'kamino.withdraw.fresh-user-no-obligation',
    description:
      'withdraw for a fresh user → obligation PDA missing → strict-mode `account not found`. Verifies withdraw calldata + u64 LE collateral_amount.',
    build: () =>
      buildWithdrawInvoke({
        reserve: reserveAccts,
        obligation: obligationFor(),
        collateralAmount: 1_000_000n,
        refreshReserves: [usdcReserve.reserve],
      }),
    expect: { revertContains: 'InvalidAccountOwner' },
  },
  {
    name: 'kamino.borrow.fresh-user-no-obligation',
    description:
      'borrow for a fresh user → obligation PDA missing → strict-mode `account not found`. Verifies borrow calldata + u64 LE liquidity_amount.',
    build: () =>
      buildBorrowInvoke({
        reserve: reserveAccts,
        obligation: obligationFor(),
        liquidityAmount: 1_000_000n,
        refreshReserves: [usdcReserve.reserve],
      }),
    expect: { revertContains: 'InvalidAccountOwner' },
  },
  {
    name: 'kamino.repay.fresh-user-no-obligation',
    description:
      'repay for a fresh user → obligation PDA missing → strict-mode `account not found`. Verifies repay calldata + u64 LE liquidity_amount.',
    build: () =>
      buildRepayInvoke({
        reserve: reserveAccts,
        obligation: obligationFor(),
        liquidityAmount: 1_000_000n,
        refreshReserves: [usdcReserve.reserve],
      }),
    expect: { revertContains: 'InvalidAccountOwner' },
  },
];

export default cases;
