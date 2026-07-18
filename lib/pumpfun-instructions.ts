// Pump.fun bonding-curve buy/sell invoke builders.
//
// Buy (16 accounts):
//   args: amount: u64 (memecoin out), max_sol_cost: u64 (SOL in cap),
//         track_volume: Option<bool>
//   user spends NATIVE SOL (lamports from PDA), receives memecoin into
//   `associated_user` (their PDA-owned ATA for the mint).
//
// Sell (14 accounts):
//   args: amount: u64 (memecoin in), min_sol_output: u64 (SOL out floor)
//   user burns memecoin, receives SOL into PDA.
//
// User signer == PDA. Rome's CPI precompile auto-signs.

import { concat, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  deriveAta,
  deriveRomeUserPda,
  pubkeyBs58ToBytes32,
  pubkeyToBytes32,
} from './solana-pda';
import {
  BUY_DISC,
  PUMP_FUN_EVENT_AUTHORITY,
  PUMP_FUN_FEE_CONFIG,
  PUMP_FUN_FEE_PROGRAM,
  PUMP_FUN_FEE_RECIPIENT,
  PUMP_FUN_GLOBAL,
  PUMP_FUN_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_FUN_PROGRAM,
  SELL_DISC,
} from './pumpfun-program';
import {
  deriveBondingCurve,
  deriveCreatorVault,
  deriveUserVolumeAccumulator,
} from './pumpfun-pdas';
import type { BondingCurve } from './pumpfun-curves';

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
// Buy invoke (16 accounts)
//
// Account order (per IDL):
//   0  global              (read-only)
//   1  fee_recipient       (writable)
//   2  mint                (read-only)
//   3  bonding_curve       (writable)
//   4  associated_bonding_curve (writable)
//   5  associated_user     (writable)
//   6  user                (signer, writable)
//   7  system_program      (read-only)
//   8  token_program       (read-only)
//   9  creator_vault       (writable)
//   10 event_authority     (read-only)
//   11 program             (read-only — pump_fun program itself)
//   12 global_volume_accumulator (read-only)
//   13 user_volume_accumulator   (writable)
//   14 fee_config          (read-only)
//   15 fee_program         (read-only)
// ─────────────────────────────────────────────────────────────────────

export type PumpFunBuyInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: {
    user: Hex;
    bondingCurve: Hex;
    associatedBondingCurve: Hex;
    associatedUser: Hex;
    creatorVault: Hex;
    userVolumeAccumulator: Hex;
  };
};

export function buildPumpFunBuyInvoke(args: {
  userEvmAddress: Address;
  /// Memecoin SPL mint.
  mintHex: Hex;
  /// Decoded BondingCurve (caller fetched + decoded). The `creator`
  /// field is required to derive `creator_vault`.
  curve: BondingCurve;
  /// Memecoin amount the user wants to receive (in mint atoms).
  amount: bigint;
  /// Max SOL the user is willing to spend (lamports). Slippage guard.
  maxSolCost: bigint;
  /// Whether to track in the user volume accumulator (defaults true).
  trackVolume?: boolean;
}): PumpFunBuyInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const bondingCurve = deriveBondingCurve(args.mintHex);
  const associatedBondingCurve = deriveAta(bondingCurve, args.mintHex);
  const associatedUser = deriveAta(user, args.mintHex);
  const creatorVault = deriveCreatorVault(args.curve.creator);
  const userVolumeAccumulator = deriveUserVolumeAccumulator(user);

  const accounts: AccountMeta[] = [
    { pubkey: PUMP_FUN_GLOBAL, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_FEE_RECIPIENT, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: bondingCurve, is_signer: false, is_writable: true },
    { pubkey: associatedBondingCurve, is_signer: false, is_writable: true },
    { pubkey: associatedUser, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: true },
    { pubkey: SYSTEM_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: creatorVault, is_signer: false, is_writable: true },
    { pubkey: PUMP_FUN_EVENT_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_PROGRAM, is_signer: false, is_writable: false },
    {
      pubkey: PUMP_FUN_GLOBAL_VOLUME_ACCUMULATOR,
      is_signer: false,
      is_writable: false,
    },
    { pubkey: userVolumeAccumulator, is_signer: false, is_writable: true },
    { pubkey: PUMP_FUN_FEE_CONFIG, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_FEE_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    BUY_DISC,
    toU64Le(args.amount),
    toU64Le(args.maxSolCost),
    toOptionBool(args.trackVolume ?? true),
  ]);

  return {
    program: PUMP_FUN_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      creatorVault,
      userVolumeAccumulator,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Sell invoke (14 accounts)
//
// Same shape as buy but no associated_token_program / volume
// accumulators (sell doesn't track).
//
// Account order (per IDL):
//   0  global
//   1  fee_recipient (writable)
//   2  mint
//   3  bonding_curve (writable)
//   4  associated_bonding_curve (writable)
//   5  associated_user (writable)
//   6  user (signer, writable)
//   7  system_program
//   8  creator_vault (writable)
//   9  token_program
//   10 event_authority
//   11 program
//   12 fee_config
//   13 fee_program
// ─────────────────────────────────────────────────────────────────────

export type PumpFunSellInvoke = PumpFunBuyInvoke;

export function buildPumpFunSellInvoke(args: {
  userEvmAddress: Address;
  mintHex: Hex;
  curve: BondingCurve;
  /// Memecoin atoms to sell.
  amount: bigint;
  /// Minimum SOL out (slippage floor).
  minSolOutput: bigint;
}): PumpFunSellInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const bondingCurve = deriveBondingCurve(args.mintHex);
  const associatedBondingCurve = deriveAta(bondingCurve, args.mintHex);
  const associatedUser = deriveAta(user, args.mintHex);
  const creatorVault = deriveCreatorVault(args.curve.creator);
  // Sell doesn't update user_volume_accumulator; echo for the preview.
  const userVolumeAccumulator = deriveUserVolumeAccumulator(user);

  const accounts: AccountMeta[] = [
    { pubkey: PUMP_FUN_GLOBAL, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_FEE_RECIPIENT, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: bondingCurve, is_signer: false, is_writable: true },
    { pubkey: associatedBondingCurve, is_signer: false, is_writable: true },
    { pubkey: associatedUser, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: true },
    { pubkey: SYSTEM_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: creatorVault, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_EVENT_AUTHORITY, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_FEE_CONFIG, is_signer: false, is_writable: false },
    { pubkey: PUMP_FUN_FEE_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    SELL_DISC,
    toU64Le(args.amount),
    toU64Le(args.minSolOutput),
  ]);

  return {
    program: PUMP_FUN_PROGRAM,
    accounts,
    data,
    addresses: {
      user,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      creatorVault,
      userVolumeAccumulator,
    },
  };
}

// `pubkeyBs58ToBytes32` and `ASSOCIATED_TOKEN_PROGRAM_HEX` are exported
// from the upstream module re-imports already; touch them so the
// linter doesn't complain on unused imports if someone trims down.
void pubkeyBs58ToBytes32;
void ASSOCIATED_TOKEN_PROGRAM_HEX;
