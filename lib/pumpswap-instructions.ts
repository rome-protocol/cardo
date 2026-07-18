// PumpSwap buy/sell invoke builders.
//
// Both ix flavors:
//   - Anchor 8-byte disc
//   - Anchor-canonical account list (23 for buy, 21 for sell)
//   - Borsh args
//
// Buy (user pays quote, receives base):
//   args: base_amount_out: u64, max_quote_amount_in: u64,
//         track_volume: option<bool>
//
// Sell (user pays base, receives quote):
//   args: base_amount_in: u64, min_quote_amount_out: u64
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { concat, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
} from './solana-pda';
import {
  BUY_DISC,
  PUMPSWAP_DEPOSIT_DISC,
  PUMPSWAP_FEE_CONFIG,
  PUMPSWAP_FEE_PROGRAM,
  PUMPSWAP_GLOBAL_CONFIG,
  PUMPSWAP_PROGRAM,
  PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
  PUMPSWAP_WITHDRAW_DISC,
  SELL_DISC,
} from './pumpswap-program';
import {
  deriveCoinCreatorVaultAuthority,
  deriveEventAuthority,
  deriveGlobalVolumeAccumulator,
  deriveUserVolumeAccumulator,
} from './pumpswap-pdas';
import type { PumpSwapPool } from './pumpswap-pools';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);
const ASSOCIATED_TOKEN_PROGRAM_HEX = pubkeyToBytes32(
  ASSOCIATED_TOKEN_PROGRAM_ID,
);
const SYSTEM_PROGRAM_HEX = pubkeyToBytes32(PublicKey.default);

// ─────────────────────────────────────────────────────────────────────
// Encoders
// ─────────────────────────────────────────────────────────────────────

function toU64Le(v: bigint): Hex {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${v}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

/// Borsh `Option<bool>`: 1 byte tag (0=None, 1=Some) + 1 byte if Some.
function toOptionBool(v: boolean | null): Hex {
  if (v === null) return '0x00';
  return ('0x01' + (v ? '01' : '00')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// Shared ATA derivation
//
// PumpSwap uses an "ATA-with-token-program" derivation:
//   PDA([owner, token_program_id, mint], ATA_PROGRAM)
// Our `deriveAta` in solana-pda.ts hardcodes the classic SPL Token
// program; PumpSwap pools are still classic-SPL today, so we keep that
// path. (When Token-2022 pools land we'd plumb the token program id in.)
// ─────────────────────────────────────────────────────────────────────

import { deriveAta } from './solana-pda';

// ─────────────────────────────────────────────────────────────────────
// Common preconditions for both buy and sell.
// ─────────────────────────────────────────────────────────────────────

export type PumpSwapInvokeAddresses = {
  poolAddress: Hex;
  user: Hex;
  userBaseAta: Hex;
  userQuoteAta: Hex;
  protocolFeeRecipientAta: Hex;
  eventAuthority: Hex;
  coinCreatorVaultAta: Hex;
  coinCreatorVaultAuthority: Hex;
  /// Buy-only; undefined for sell.
  globalVolumeAccumulator?: Hex;
  /// Buy-only; undefined for sell.
  userVolumeAccumulator?: Hex;
};

function commonAddresses(args: {
  userEvmAddress: Address;
  pool: PumpSwapPool;
}): PumpSwapInvokeAddresses {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userBaseAta = deriveAta(user, args.pool.baseMint);
  const userQuoteAta = deriveAta(user, args.pool.quoteMint);

  // protocol_fee_recipient_token_account = ATA(protocol_fee_recipient, quote_mint)
  const protocolFeeRecipientAta = deriveAta(
    PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
    args.pool.quoteMint,
  );

  const eventAuthority = deriveEventAuthority();
  const coinCreatorVaultAuthority = deriveCoinCreatorVaultAuthority(
    args.pool.coinCreator,
  );
  // coin_creator_vault_ata = ATA(coin_creator_vault_authority, quote_mint)
  const coinCreatorVaultAta = deriveAta(
    coinCreatorVaultAuthority,
    args.pool.quoteMint,
  );

  return {
    poolAddress: args.pool.pubkey ?? ('0x' as Hex),
    user,
    userBaseAta,
    userQuoteAta,
    protocolFeeRecipientAta,
    eventAuthority,
    coinCreatorVaultAta,
    coinCreatorVaultAuthority,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Buy invoke (user spends quote, receives base) — 23 accounts
// ─────────────────────────────────────────────────────────────────────

export type PumpSwapBuyInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: PumpSwapInvokeAddresses;
};

export function buildPumpSwapBuyInvoke(args: {
  userEvmAddress: Address;
  pool: PumpSwapPool;
  /// Bs58 of the pool account (caller-supplied; we don't store it on the
  /// decoded struct). Required because the precompile takes a pubkey.
  poolPubkey: string;
  /// Desired minimum base tokens out (set conservatively to absorb fees +
  /// drift before tx confirmation). Encoded as the buy arg `base_amount_out`.
  baseAmountOut: bigint;
  /// Maximum quote tokens the user is willing to spend. Encoded as
  /// `max_quote_amount_in`.
  maxQuoteAmountIn: bigint;
  /// Whether to record volume in the user accumulator. Defaults to true.
  trackVolume?: boolean;
}): PumpSwapBuyInvoke {
  const poolHex = pubkeyBs58ToBytes32(args.poolPubkey);
  const addrs = commonAddresses({
    userEvmAddress: args.userEvmAddress,
    pool: args.pool,
  });
  addrs.poolAddress = poolHex;
  addrs.globalVolumeAccumulator = deriveGlobalVolumeAccumulator();
  addrs.userVolumeAccumulator = deriveUserVolumeAccumulator(addrs.user);

  const accounts: AccountMeta[] = [
    { pubkey: poolHex, is_signer: false, is_writable: true },
    { pubkey: addrs.user, is_signer: true, is_writable: true },
    { pubkey: PUMPSWAP_GLOBAL_CONFIG, is_signer: false, is_writable: false },
    { pubkey: args.pool.baseMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.quoteMint, is_signer: false, is_writable: false },
    { pubkey: addrs.userBaseAta, is_signer: false, is_writable: true },
    { pubkey: addrs.userQuoteAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolBaseTokenAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolQuoteTokenAccount, is_signer: false, is_writable: true },
    {
      pubkey: PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
      is_signer: false,
      is_writable: false,
    },
    {
      pubkey: addrs.protocolFeeRecipientAta,
      is_signer: false,
      is_writable: true,
    },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: addrs.eventAuthority, is_signer: false, is_writable: false },
    { pubkey: PUMPSWAP_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: addrs.coinCreatorVaultAta, is_signer: false, is_writable: true },
    {
      pubkey: addrs.coinCreatorVaultAuthority,
      is_signer: false,
      is_writable: false,
    },
    {
      pubkey: addrs.globalVolumeAccumulator!,
      is_signer: false,
      is_writable: false,
    },
    {
      pubkey: addrs.userVolumeAccumulator!,
      is_signer: false,
      is_writable: true,
    },
    { pubkey: PUMPSWAP_FEE_CONFIG, is_signer: false, is_writable: false },
    { pubkey: PUMPSWAP_FEE_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    BUY_DISC,
    toU64Le(args.baseAmountOut),
    toU64Le(args.maxQuoteAmountIn),
    toOptionBool(args.trackVolume ?? true),
  ]);

  return { program: PUMPSWAP_PROGRAM, accounts, data, addresses: addrs };
}

// ─────────────────────────────────────────────────────────────────────
// Sell invoke (user spends base, receives quote) — 21 accounts
// ─────────────────────────────────────────────────────────────────────

export type PumpSwapSellInvoke = PumpSwapBuyInvoke;

export function buildPumpSwapSellInvoke(args: {
  userEvmAddress: Address;
  pool: PumpSwapPool;
  poolPubkey: string;
  /// Base tokens the user spends.
  baseAmountIn: bigint;
  /// Minimum quote tokens to receive (slippage guard).
  minQuoteAmountOut: bigint;
}): PumpSwapSellInvoke {
  const poolHex = pubkeyBs58ToBytes32(args.poolPubkey);
  const addrs = commonAddresses({
    userEvmAddress: args.userEvmAddress,
    pool: args.pool,
  });
  addrs.poolAddress = poolHex;

  const accounts: AccountMeta[] = [
    { pubkey: poolHex, is_signer: false, is_writable: true },
    { pubkey: addrs.user, is_signer: true, is_writable: true },
    { pubkey: PUMPSWAP_GLOBAL_CONFIG, is_signer: false, is_writable: false },
    { pubkey: args.pool.baseMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.quoteMint, is_signer: false, is_writable: false },
    { pubkey: addrs.userBaseAta, is_signer: false, is_writable: true },
    { pubkey: addrs.userQuoteAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolBaseTokenAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolQuoteTokenAccount, is_signer: false, is_writable: true },
    {
      pubkey: PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
      is_signer: false,
      is_writable: false,
    },
    {
      pubkey: addrs.protocolFeeRecipientAta,
      is_signer: false,
      is_writable: true,
    },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: addrs.eventAuthority, is_signer: false, is_writable: false },
    { pubkey: PUMPSWAP_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: addrs.coinCreatorVaultAta, is_signer: false, is_writable: true },
    {
      pubkey: addrs.coinCreatorVaultAuthority,
      is_signer: false,
      is_writable: false,
    },
    { pubkey: PUMPSWAP_FEE_CONFIG, is_signer: false, is_writable: false },
    { pubkey: PUMPSWAP_FEE_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    SELL_DISC,
    toU64Le(args.baseAmountIn),
    toU64Le(args.minQuoteAmountOut),
  ]);

  return { program: PUMPSWAP_PROGRAM, accounts, data, addresses: addrs };
}

// ─────────────────────────────────────────────────────────────────────
// LP — deposit / withdraw
//
// Both ix share the same 15-account layout per the IDL:
//   1.  pool (rw)
//   2.  global_config (ro)
//   3.  user (signer, ro)               ← user's Rome PDA
//   4.  base_mint (ro)
//   5.  quote_mint (ro)
//   6.  lp_mint (rw)                    ← supply changes
//   7.  user_base_token_account (rw)
//   8.  user_quote_token_account (rw)
//   9.  user_pool_token_account (rw)    ← ATA(user, lp_mint)
//   10. pool_base_token_account (rw)
//   11. pool_quote_token_account (rw)
//   12. token_program (ro)
//   13. token_2022_program (ro)
//   14. event_authority (ro)
//   15. program (ro)                    ← PUMPSWAP_PROGRAM (self-id)
//
// deposit args:  lp_token_amount_out u64 || max_base_amount_in u64 ||
//                max_quote_amount_in u64
// withdraw args: lp_token_amount_in u64 || min_base_amount_out u64 ||
//                min_quote_amount_out u64
// ─────────────────────────────────────────────────────────────────────

const TOKEN_2022_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

export type PumpSwapLpAddresses = PumpSwapInvokeAddresses & {
  userPoolAta: Hex;
};

export type PumpSwapLpInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: PumpSwapLpAddresses;
};

function lpAccountList(args: {
  poolHex: Hex;
  pool: PumpSwapPool;
  user: Hex;
  userBaseAta: Hex;
  userQuoteAta: Hex;
  userPoolAta: Hex;
  eventAuthority: Hex;
}): AccountMeta[] {
  return [
    { pubkey: args.poolHex, is_signer: false, is_writable: true },
    { pubkey: PUMPSWAP_GLOBAL_CONFIG, is_signer: false, is_writable: false },
    { pubkey: args.user, is_signer: true, is_writable: false },
    { pubkey: args.pool.baseMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.quoteMint, is_signer: false, is_writable: false },
    { pubkey: args.pool.lpMint, is_signer: false, is_writable: true },
    { pubkey: args.userBaseAta, is_signer: false, is_writable: true },
    { pubkey: args.userQuoteAta, is_signer: false, is_writable: true },
    { pubkey: args.userPoolAta, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolBaseTokenAccount, is_signer: false, is_writable: true },
    { pubkey: args.pool.poolQuoteTokenAccount, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: TOKEN_2022_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: args.eventAuthority, is_signer: false, is_writable: false },
    { pubkey: PUMPSWAP_PROGRAM, is_signer: false, is_writable: false },
  ];
}

export function buildPumpSwapDepositInvoke(args: {
  userEvmAddress: Address;
  pool: PumpSwapPool;
  poolPubkey: string;
  /// LP tokens to mint (output amount).
  lpTokenAmountOut: bigint;
  /// Maximum base + quote the user is willing to spend (slippage).
  maxBaseAmountIn: bigint;
  maxQuoteAmountIn: bigint;
}): PumpSwapLpInvoke {
  const poolHex = pubkeyBs58ToBytes32(args.poolPubkey);
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userBaseAta = deriveAta(user, args.pool.baseMint);
  const userQuoteAta = deriveAta(user, args.pool.quoteMint);
  const userPoolAta = deriveAta(user, args.pool.lpMint);
  const protocolFeeRecipientAta = deriveAta(
    PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
    args.pool.quoteMint,
  );
  const eventAuthority = deriveEventAuthority();
  const coinCreatorVaultAuthority = deriveCoinCreatorVaultAuthority(
    args.pool.coinCreator,
  );
  const coinCreatorVaultAta = deriveAta(coinCreatorVaultAuthority, args.pool.quoteMint);

  const accounts = lpAccountList({
    poolHex,
    pool: args.pool,
    user,
    userBaseAta,
    userQuoteAta,
    userPoolAta,
    eventAuthority,
  });

  const data = concat([
    PUMPSWAP_DEPOSIT_DISC,
    toU64Le(args.lpTokenAmountOut),
    toU64Le(args.maxBaseAmountIn),
    toU64Le(args.maxQuoteAmountIn),
  ]);

  return {
    program: PUMPSWAP_PROGRAM,
    accounts,
    data,
    addresses: {
      poolAddress: poolHex,
      user,
      userBaseAta,
      userQuoteAta,
      protocolFeeRecipientAta,
      eventAuthority,
      coinCreatorVaultAta,
      coinCreatorVaultAuthority,
      userPoolAta,
    },
  };
}

export function buildPumpSwapWithdrawInvoke(args: {
  userEvmAddress: Address;
  pool: PumpSwapPool;
  poolPubkey: string;
  /// LP tokens to burn.
  lpTokenAmountIn: bigint;
  /// Minimum base + quote the user accepts (slippage guard).
  minBaseAmountOut: bigint;
  minQuoteAmountOut: bigint;
}): PumpSwapLpInvoke {
  const poolHex = pubkeyBs58ToBytes32(args.poolPubkey);
  const user = deriveRomeUserPda(args.userEvmAddress);
  const userBaseAta = deriveAta(user, args.pool.baseMint);
  const userQuoteAta = deriveAta(user, args.pool.quoteMint);
  const userPoolAta = deriveAta(user, args.pool.lpMint);
  const protocolFeeRecipientAta = deriveAta(
    PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
    args.pool.quoteMint,
  );
  const eventAuthority = deriveEventAuthority();
  const coinCreatorVaultAuthority = deriveCoinCreatorVaultAuthority(
    args.pool.coinCreator,
  );
  const coinCreatorVaultAta = deriveAta(coinCreatorVaultAuthority, args.pool.quoteMint);

  const accounts = lpAccountList({
    poolHex,
    pool: args.pool,
    user,
    userBaseAta,
    userQuoteAta,
    userPoolAta,
    eventAuthority,
  });

  const data = concat([
    PUMPSWAP_WITHDRAW_DISC,
    toU64Le(args.lpTokenAmountIn),
    toU64Le(args.minBaseAmountOut),
    toU64Le(args.minQuoteAmountOut),
  ]);

  return {
    program: PUMPSWAP_PROGRAM,
    accounts,
    data,
    addresses: {
      poolAddress: poolHex,
      user,
      userBaseAta,
      userQuoteAta,
      protocolFeeRecipientAta,
      eventAuthority,
      coinCreatorVaultAta,
      coinCreatorVaultAuthority,
      userPoolAta,
    },
  };
}
