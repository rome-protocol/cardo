// Kamino Lend instruction builders.
//
// Each `build*Invoke` returns `{ program, accounts, data }` ready to
// pass into `wagmi.writeContract({ args: [program, accounts, data] })`
// against the CPI precompile (`0xFF…08`).
//
// Pattern matches `lib/meteora-swap.ts` and `lib/meteora-pool-create.ts`:
// pure functions, no network reads, no hooks. Network-dependent state
// (reserve oracles, current market authority) is passed in by callers
// from polling read hooks.
//
// IDL orderings cross-checked against:
//   github.com/Kamino-Finance/klend programs/klend/src/handlers/  (canonical, every variant)
//   github.com/Kamino-Finance/klend/programs/klend/src/handlers/  (init flows)
//
// Triage: the docs/active/technical/2026-04-25-cardo-lend-kamino-triage.md

import { concat, numberToHex, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
} from './solana-pda';
import {
  BORROW_DISC,
  DEPOSIT_DISC,
  INIT_OBLIGATION_DISC,
  INIT_USER_METADATA_DISC,
  KLEND_PROGRAM,
  REFRESH_OBLIGATION_DISC,
  REFRESH_RESERVE_DISC,
  REPAY_DISC,
  WITHDRAW_DISC,
} from './kamino-program';
import {
  deriveLendingMarketAuthority,
  deriveUserMetadata,
  deriveVanillaObligation,
} from './kamino-pdas';

// ─────────────────────────────────────────────────────────────────────
// Sysvars + constants
// ─────────────────────────────────────────────────────────────────────

const SYSVAR_INSTRUCTIONS = pubkeyBs58ToBytes32(
  'Sysvar1nstructions1111111111111111111111111',
);
const SYSVAR_RENT = pubkeyBs58ToBytes32(
  'SysvarRent111111111111111111111111111111111',
);
const SYSTEM_PROGRAM = pubkeyToBytes32(PublicKey.default);
const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);
const ASSOC_TOKEN_PROGRAM_HEX = pubkeyToBytes32(ASSOCIATED_TOKEN_PROGRAM_ID);

// ─────────────────────────────────────────────────────────────────────
// Encoding helpers (mirror lib/meteora-swap.ts conventions)
// ─────────────────────────────────────────────────────────────────────

export function toU64Le(value: bigint): Hex {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const beHex = numberToHex(value, { size: 8 }).slice(2);
  const bytes: string[] = [];
  for (let i = beHex.length; i > 0; i -= 2) bytes.push(beHex.slice(i - 2, i));
  return ('0x' + bytes.join('')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// Reusable account-set structs
// ─────────────────────────────────────────────────────────────────────

/// Reserve-scope accounts. Constant for a given (market, reserve);
/// callers pull these from `lib/kamino-markets.ts` + on-chain reads.
export type KaminoReserveAccounts = {
  lendingMarket: Hex;
  reserve: Hex;
  reserveLiquidityMint: Hex;
  reserveLiquiditySupply: Hex;
  reserveCollateralMint: Hex;
  reserveDestinationDepositCollateral: Hex;
  /// borrow_reserve_liquidity_fee_receiver — required by borrow/repay,
  /// 0-pubkey ok for deposit/withdraw paths.
  feeReceiver: Hex;
  /// Pyth/Switchboard/Scope oracle pubkey; required by refresh_reserve.
  pythPriceOracle: Hex;
};

/// Obligation-scope accounts — per (user, market) per call.
export type KaminoObligationAccounts = {
  /// user's Rome PDA — Solana-side owner of the obligation. Signer.
  owner: Hex;
  /// Vanilla obligation PDA (derive via deriveVanillaObligation).
  obligation: Hex;
  /// User's ATA for the reserve liquidity mint (USDC / WSOL etc.) —
  /// owned by user's Rome PDA.
  userSourceLiquidity: Hex;
  /// User's ATA for the reserve collateral (cToken) mint — owned by
  /// user's Rome PDA. Same as userDestinationCollateral in deposit
  /// (collateral mints to the obligation's collateral ATA, but Kamino
  /// mints to userDestinationCollateral first then transfers; this
  /// account is required regardless).
  userDestinationCollateral: Hex;
};

// ─────────────────────────────────────────────────────────────────────
// init_user_metadata — Kamino v2 prerequisite. One-time per user.
// IDL (klend src/handlers/handler_init_user_metadata.rs):
//   1. owner                (signer, r)
//   2. fee_payer            (signer, w)
//   3. user_metadata        (init, w)         PDA(["user_meta", owner])
//   4. referrer_user_metadata (Option, r)     pass program id when None
//   5. rent                 (sysvar)
//   6. system_program       (r)
//
// data = disc(8) || user_lookup_table(32)
//
// `user_lookup_table` may be `Pubkey::default()` (32 zero bytes) when
// the user doesn't have an ALT.
// ─────────────────────────────────────────────────────────────────────

export type KaminoInitUserMetadataInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Echoed for the preview panel.
  addresses: { userMetadata: Hex; owner: Hex };
};

export function buildInitUserMetadataInvoke(args: {
  userEvmAddress: Address;
}): KaminoInitUserMetadataInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const userMetadata = deriveUserMetadata(owner);

  // referrer_user_metadata is Optional; pass KLend program id (acts as
  // None per Anchor convention for Optional remaining accounts).
  const accounts: AccountMeta[] = [
    { pubkey: owner, is_signer: true, is_writable: false },
    { pubkey: owner, is_signer: true, is_writable: true }, // fee_payer == owner (Rome PDA pays its own rent)
    { pubkey: userMetadata, is_signer: false, is_writable: true },
    { pubkey: KLEND_PROGRAM, is_signer: false, is_writable: false }, // referrer (None)
    { pubkey: SYSVAR_RENT, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  const userLookupTable = SYSTEM_PROGRAM; // 32 zero bytes — no ALT
  const data = concat([INIT_USER_METADATA_DISC, userLookupTable]);

  return { program: KLEND_PROGRAM, accounts, data, addresses: { userMetadata, owner } };
}

// ─────────────────────────────────────────────────────────────────────
// init_obligation — Vanilla obligation per (user, market). Required
// before deposit/withdraw/borrow/repay.
// IDL (klend src/handlers/handler_init_obligation.rs):
//   1. obligation_owner     (signer, r)
//   2. fee_payer            (signer, w)
//   3. obligation           (init, w)         PDA([0,0,owner,market,0,0])
//   4. lending_market       (r)
//   5. seed1_account        (r)               zero pubkey for Vanilla
//   6. seed2_account        (r)               zero pubkey for Vanilla
//   7. owner_user_metadata  (r)               must already exist
//   8. rent                 (sysvar)
//   9. system_program       (r)
//
// data = disc(8) || u8(tag=0) || u8(id=0)   for Vanilla
// ─────────────────────────────────────────────────────────────────────

export type KaminoInitObligationInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { obligation: Hex; owner: Hex; userMetadata: Hex };
};

export function buildInitObligationInvoke(args: {
  userEvmAddress: Address;
  lendingMarket: Hex;
}): KaminoInitObligationInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const obligation = deriveVanillaObligation(owner, args.lendingMarket);
  const userMetadata = deriveUserMetadata(owner);

  const accounts: AccountMeta[] = [
    { pubkey: owner, is_signer: true, is_writable: false }, // obligation_owner
    { pubkey: owner, is_signer: true, is_writable: true },  // fee_payer
    { pubkey: obligation, is_signer: false, is_writable: true },
    { pubkey: args.lendingMarket, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false }, // seed1 (Vanilla = zero)
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false }, // seed2 (Vanilla = zero)
    { pubkey: userMetadata, is_signer: false, is_writable: false },
    { pubkey: SYSVAR_RENT, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  // InitObligationArgs { tag: u8, id: u8 } — Vanilla = (0, 0)
  const data = concat([INIT_OBLIGATION_DISC, '0x0000']);

  return { program: KLEND_PROGRAM, accounts, data, addresses: { obligation, owner, userMetadata } };
}

// ─────────────────────────────────────────────────────────────────────
// refresh_reserve — pre-CPI keeper before borrow/repay. Stale-price-
// check + interest-accrue. Bundled in the same Rome tx as the action.
// IDL (KaminoLendProgram.sol):
//   1. reserve                     (w)
//   2. lending_market              (r)
//   3. pyth_price_info             (r)  optional; pass 0-pubkey if unused
//   4. switchboard_price_info      (r)  optional
//   5. switchboard_twap_price_info (r)  optional
//   6. scope_prices                (r)  optional
//
// MVP: pass only the active oracle (Pyth in our chosen market); other
// slots filled with system-program-zero.
// ─────────────────────────────────────────────────────────────────────

export function buildRefreshReserveAccounts(
  reserve: Hex,
  lendingMarket: Hex,
  pythPriceOracle: Hex,
): AccountMeta[] {
  return [
    { pubkey: reserve, is_signer: false, is_writable: true },
    { pubkey: lendingMarket, is_signer: false, is_writable: false },
    { pubkey: pythPriceOracle, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false }, // switchboard_price (None)
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false }, // switchboard_twap (None)
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false }, // scope_prices (None)
  ];
}

export function encodeRefreshReserveData(): Hex {
  return REFRESH_RESERVE_DISC;
}

// ─────────────────────────────────────────────────────────────────────
// refresh_obligation — IDL:
//   1. lending_market           (r)
//   2. obligation               (w)
//   3+. deposit_reserves        (w)  iterator (deposits then borrows)
// ─────────────────────────────────────────────────────────────────────

export function buildRefreshObligationAccounts(
  lendingMarket: Hex,
  obligation: Hex,
  reserves: Hex[],
): AccountMeta[] {
  return [
    { pubkey: lendingMarket, is_signer: false, is_writable: false },
    { pubkey: obligation, is_signer: false, is_writable: true },
    ...reserves.map((r) => ({ pubkey: r, is_signer: false, is_writable: true })),
  ];
}

export function encodeRefreshObligationData(): Hex {
  return REFRESH_OBLIGATION_DISC;
}

// ─────────────────────────────────────────────────────────────────────
// deposit_reserve_liquidity_and_obligation_collateral
// IDL (KaminoLendProgram.sol buildDepositMetas):
//   1. owner                              (signer, r)
//   2. obligation                         (w)
//   3. lending_market                     (r)
//   4. lending_market_authority           (r)
//   5. reserve                            (w)
//   6. reserve_liquidity_mint             (r)
//   7. reserve_liquidity_supply           (w)
//   8. reserve_collateral_mint            (w)
//   9. reserve_destination_deposit_collateral (w)
//  10. user_source_liquidity              (w)
//  11. user_destination_collateral        (w)
//  12. token_program                      (r)
//  13. instruction_sysvar                 (r)
// (14+) deposit_reserves_iter             (w) — refresh
//
// data = disc || u64le(liquidity_amount)
// ─────────────────────────────────────────────────────────────────────

export type KaminoDepositInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
};

export function buildDepositInvoke(args: {
  reserve: KaminoReserveAccounts;
  obligation: KaminoObligationAccounts;
  liquidityAmount: bigint;
  /// reserves to refresh before the action — typically just the one
  /// being acted on.
  refreshReserves: Hex[];
}): KaminoDepositInvoke {
  const lma = deriveLendingMarketAuthority(args.reserve.lendingMarket);
  const accounts: AccountMeta[] = [
    { pubkey: args.obligation.owner, is_signer: true, is_writable: false },
    { pubkey: args.obligation.obligation, is_signer: false, is_writable: true },
    { pubkey: args.reserve.lendingMarket, is_signer: false, is_writable: false },
    { pubkey: lma, is_signer: false, is_writable: false },
    { pubkey: args.reserve.reserve, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveLiquidityMint, is_signer: false, is_writable: false },
    { pubkey: args.reserve.reserveLiquiditySupply, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveCollateralMint, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveDestinationDepositCollateral, is_signer: false, is_writable: true },
    { pubkey: args.obligation.userSourceLiquidity, is_signer: false, is_writable: true },
    { pubkey: args.obligation.userDestinationCollateral, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, is_signer: false, is_writable: false },
    ...args.refreshReserves.map((r) => ({ pubkey: r, is_signer: false, is_writable: true })),
  ];
  const data = concat([DEPOSIT_DISC, toU64Le(args.liquidityAmount)]);
  return { program: KLEND_PROGRAM, accounts, data };
}

// ─────────────────────────────────────────────────────────────────────
// withdraw_obligation_collateral_and_redeem_reserve_liquidity_v2
// IDL (KaminoLendProgram.sol buildWithdrawMetas):
//   1. owner                              (signer, r)
//   2. obligation                         (w)
//   3. lending_market                     (r)
//   4. lending_market_authority           (r)
//   5. reserve                            (w)
//   6. reserve_source_collateral          (w)  (== reserveDestinationDepositCollateral)
//   7. reserve_collateral_mint            (w)
//   8. reserve_liquidity_supply           (w)
//   9. reserve_liquidity_mint             (r)
//  10. user_destination_liquidity         (w)
//  11. user_destination_collateral        (w)
//  12. token_program                      (r)
//  13. instruction_sysvar                 (r)
// (14+) deposit_reserves_iter             (w)
// ─────────────────────────────────────────────────────────────────────

export type KaminoWithdrawInvoke = KaminoDepositInvoke;

export function buildWithdrawInvoke(args: {
  reserve: KaminoReserveAccounts;
  obligation: KaminoObligationAccounts;
  collateralAmount: bigint;
  refreshReserves: Hex[];
}): KaminoWithdrawInvoke {
  const lma = deriveLendingMarketAuthority(args.reserve.lendingMarket);
  const accounts: AccountMeta[] = [
    { pubkey: args.obligation.owner, is_signer: true, is_writable: false },
    { pubkey: args.obligation.obligation, is_signer: false, is_writable: true },
    { pubkey: args.reserve.lendingMarket, is_signer: false, is_writable: false },
    { pubkey: lma, is_signer: false, is_writable: false },
    { pubkey: args.reserve.reserve, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveDestinationDepositCollateral, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveCollateralMint, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveLiquiditySupply, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveLiquidityMint, is_signer: false, is_writable: false },
    { pubkey: args.obligation.userSourceLiquidity, is_signer: false, is_writable: true },
    { pubkey: args.obligation.userDestinationCollateral, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, is_signer: false, is_writable: false },
    ...args.refreshReserves.map((r) => ({ pubkey: r, is_signer: false, is_writable: true })),
  ];
  const data = concat([WITHDRAW_DISC, toU64Le(args.collateralAmount)]);
  return { program: KLEND_PROGRAM, accounts, data };
}

// ─────────────────────────────────────────────────────────────────────
// borrow_obligation_liquidity_v2
// IDL (KaminoLendProgram.sol buildBorrowMetas):
//   1. owner                              (signer, r)
//   2. obligation                         (w)
//   3. lending_market                     (r)
//   4. lending_market_authority           (r)
//   5. borrow_reserve                     (w)
//   6. borrow_reserve_liquidity_mint      (r)
//   7. reserve_source_liquidity           (w)  (== reserveLiquiditySupply)
//   8. borrow_reserve_liquidity_fee_receiver (w)
//   9. user_destination_liquidity         (w)
//  10. token_program                      (r)
//  11. instruction_sysvar                 (r)
// (12+) deposit_reserves_iter             (w)
// ─────────────────────────────────────────────────────────────────────

export type KaminoBorrowInvoke = KaminoDepositInvoke;

export function buildBorrowInvoke(args: {
  reserve: KaminoReserveAccounts;
  obligation: KaminoObligationAccounts;
  liquidityAmount: bigint;
  refreshReserves: Hex[];
}): KaminoBorrowInvoke {
  const lma = deriveLendingMarketAuthority(args.reserve.lendingMarket);
  const accounts: AccountMeta[] = [
    { pubkey: args.obligation.owner, is_signer: true, is_writable: false },
    { pubkey: args.obligation.obligation, is_signer: false, is_writable: true },
    { pubkey: args.reserve.lendingMarket, is_signer: false, is_writable: false },
    { pubkey: lma, is_signer: false, is_writable: false },
    { pubkey: args.reserve.reserve, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveLiquidityMint, is_signer: false, is_writable: false },
    { pubkey: args.reserve.reserveLiquiditySupply, is_signer: false, is_writable: true },
    { pubkey: args.reserve.feeReceiver, is_signer: false, is_writable: true },
    { pubkey: args.obligation.userSourceLiquidity, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, is_signer: false, is_writable: false },
    ...args.refreshReserves.map((r) => ({ pubkey: r, is_signer: false, is_writable: true })),
  ];
  const data = concat([BORROW_DISC, toU64Le(args.liquidityAmount)]);
  return { program: KLEND_PROGRAM, accounts, data };
}

// ─────────────────────────────────────────────────────────────────────
// repay_obligation_liquidity_v2
// IDL (KaminoLendProgram.sol buildRepayMetas):
//   1. owner                              (signer, r)
//   2. obligation                         (w)
//   3. lending_market                     (r)
//   4. repay_reserve                      (w)
//   5. reserve_liquidity_mint             (r)
//   6. reserve_destination_liquidity      (w)  (== reserveLiquiditySupply)
//   7. user_source_liquidity              (w)
//   8. token_program                      (r)
//   9. instruction_sysvar                 (r)
// (10+) deposit_reserves_iter             (w)
// ─────────────────────────────────────────────────────────────────────

export type KaminoRepayInvoke = KaminoDepositInvoke;

export function buildRepayInvoke(args: {
  reserve: KaminoReserveAccounts;
  obligation: KaminoObligationAccounts;
  liquidityAmount: bigint;
  refreshReserves: Hex[];
}): KaminoRepayInvoke {
  const accounts: AccountMeta[] = [
    { pubkey: args.obligation.owner, is_signer: true, is_writable: false },
    { pubkey: args.obligation.obligation, is_signer: false, is_writable: true },
    { pubkey: args.reserve.lendingMarket, is_signer: false, is_writable: false },
    { pubkey: args.reserve.reserve, is_signer: false, is_writable: true },
    { pubkey: args.reserve.reserveLiquidityMint, is_signer: false, is_writable: false },
    { pubkey: args.reserve.reserveLiquiditySupply, is_signer: false, is_writable: true },
    { pubkey: args.obligation.userSourceLiquidity, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, is_signer: false, is_writable: false },
    ...args.refreshReserves.map((r) => ({ pubkey: r, is_signer: false, is_writable: true })),
  ];
  const data = concat([REPAY_DISC, toU64Le(args.liquidityAmount)]);
  return { program: KLEND_PROGRAM, accounts, data };
}

// ─────────────────────────────────────────────────────────────────────
// Convenience: derive the user's ATAs for a given reserve.
// ─────────────────────────────────────────────────────────────────────

export function deriveUserReserveAtas(
  userEvmAddress: Address,
  reserveLiquidityMint: Hex,
  reserveCollateralMint: Hex,
): { userSourceLiquidity: Hex; userDestinationCollateral: Hex } {
  const userPda = deriveRomeUserPda(userEvmAddress);
  return {
    userSourceLiquidity: deriveAta(userPda, reserveLiquidityMint),
    userDestinationCollateral: deriveAta(userPda, reserveCollateralMint),
  };
}

void ASSOC_TOKEN_PROGRAM_HEX; // referenced in future ATA-init flows
