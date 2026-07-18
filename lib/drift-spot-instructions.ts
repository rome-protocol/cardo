// Drift v2 Spot instruction builders: initializeUser + initializeUserStats
// + deposit. Three single-ix steps, each a separate Rome CPI tx, since
// Rome's CPI precompile fires one Solana ix per EVM tx today.
//
// User flow (3 EVM signatures total to bootstrap a Drift account and
// deposit collateral):
//   1. EVM tx #1 → CPI → initializeUserStats (one-time per authority)
//   2. EVM tx #2 → CPI → initializeUser (one-time per authority+subAcct)
//   3. EVM tx #3 → CPI → deposit (every deposit)
//
// After the first two, subsequent deposits are single-tx.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 5 — Drift Spot deposit/withdraw).

import { concat, numberToHex, type Address, type Hex } from 'viem';
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
  DEPOSIT_DISC,
  DRIFT_PROGRAM,
  INITIALIZE_USER_DISC,
  INITIALIZE_USER_STATS_DISC,
  WITHDRAW_DISC,
} from './drift-program';
import {
  deriveDriftSigner,
  deriveDriftUser,
  deriveDriftState,
  deriveDriftUserStats,
} from './drift-pdas';

const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);
const SYSTEM_PROGRAM = pubkeyToBytes32(PublicKey.default);
const SYSVAR_RENT = pubkeyBs58ToBytes32(
  'SysvarRent111111111111111111111111111111111',
);

// ─────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────

function toU64Le(value: bigint): Hex {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const beHex = numberToHex(value, { size: 8 }).slice(2);
  const bytes: string[] = [];
  for (let i = beHex.length; i > 0; i -= 2) bytes.push(beHex.slice(i - 2, i));
  return ('0x' + bytes.join('')) as Hex;
}

function toU16Le(v: number): Hex {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new Error(`u16 out of range: ${v}`);
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

function toBool(b: boolean): Hex {
  return b ? '0x01' : '0x00';
}

/// Encode a 32-byte name buffer for `initializeUser`. Right-pads to 32
/// bytes with zeros. Caller can pass empty for "unnamed" — Drift
/// supports that.
function encodeUserName(name: string): Hex {
  const buf = Buffer.alloc(32);
  Buffer.from(name, 'utf8').copy(buf, 0, 0, 32);
  return ('0x' + buf.toString('hex')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// Common builder return type
// ─────────────────────────────────────────────────────────────────────

export type DriftInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: {
    user: Hex;
    userStats: Hex;
    state: Hex;
  };
};

// ─────────────────────────────────────────────────────────────────────
// initializeUserStats — one-time per authority
//
// IDL: 6 accounts, 0 args (sdk/src/idl/drift.json)
//   1. userStats         (writable, PDA)
//   2. state             (writable, PDA)
//   3. authority         (readonly) — user's Rome PDA
//   4. payer             (signer, writable) — user's Rome PDA
//   5. rent              (readonly)
//   6. systemProgram     (readonly)
// ─────────────────────────────────────────────────────────────────────

export function buildInitializeUserStatsInvoke(args: {
  userEvmAddress: Address;
}): DriftInvoke {
  const authority = deriveRomeUserPda(args.userEvmAddress);
  const userStats = deriveDriftUserStats(authority);
  const state = deriveDriftState();
  // user PDA isn't in this ix but echoed for the addresses preview.
  const user = deriveDriftUser({ authority, subAccountId: 0 });

  const accounts: AccountMeta[] = [
    { pubkey: userStats, is_signer: false, is_writable: true },
    { pubkey: state, is_signer: false, is_writable: true },
    { pubkey: authority, is_signer: false, is_writable: false },
    { pubkey: authority, is_signer: true, is_writable: true }, // payer = user PDA
    { pubkey: SYSVAR_RENT, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  return {
    program: DRIFT_PROGRAM,
    accounts,
    data: INITIALIZE_USER_STATS_DISC,
    addresses: { user, userStats, state },
  };
}

// ─────────────────────────────────────────────────────────────────────
// initializeUser — per (authority, sub_account_id)
//
// IDL: 7 accounts, args = { sub_account_id: u16, name: [u8;32] }
//   1. user              (writable, PDA)
//   2. userStats         (writable, PDA)
//   3. state             (writable, PDA)
//   4. authority         (readonly)
//   5. payer             (signer, writable)
//   6. rent
//   7. systemProgram
// ─────────────────────────────────────────────────────────────────────

export function buildInitializeUserInvoke(args: {
  userEvmAddress: Address;
  subAccountId?: number;
  name?: string;
}): DriftInvoke {
  const subAcct = args.subAccountId ?? 0;
  const authority = deriveRomeUserPda(args.userEvmAddress);
  const user = deriveDriftUser({ authority, subAccountId: subAcct });
  const userStats = deriveDriftUserStats(authority);
  const state = deriveDriftState();

  const accounts: AccountMeta[] = [
    { pubkey: user, is_signer: false, is_writable: true },
    { pubkey: userStats, is_signer: false, is_writable: true },
    { pubkey: state, is_signer: false, is_writable: true },
    { pubkey: authority, is_signer: false, is_writable: false },
    { pubkey: authority, is_signer: true, is_writable: true }, // payer
    { pubkey: SYSVAR_RENT, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    INITIALIZE_USER_DISC,
    toU16Le(subAcct),
    encodeUserName(args.name ?? 'Cardo'),
  ]);

  return {
    program: DRIFT_PROGRAM,
    accounts,
    data,
    addresses: { user, userStats, state },
  };
}

// ─────────────────────────────────────────────────────────────────────
// deposit — Spot deposit into a market
//
// IDL: 7 accounts, args = { market_index: u16, amount: u64, reduce_only: bool }
//   1. state             (readonly)
//   2. user              (writable, PDA)
//   3. userStats         (writable, PDA)
//   4. authority         (signer)
//   5. spotMarketVault   (writable) — pool's vault for this mint
//   6. userTokenAccount  (writable) — user's source ATA
//   7. tokenProgram      (readonly)
//
// Plus remaining_accounts: oracle account + spotMarket account for the
// market_index being deposited (Drift's standard "pass active markets
// + their oracles as remaining accounts"). v1 starts with USDC market 0
// only; remaining_accounts = [spot_market_0, oracle_0].
// ─────────────────────────────────────────────────────────────────────

export type DepositInvoke = DriftInvoke & {
  /// Echoed for the preview panel.
  spotMarket: Hex;
};

export function buildDepositInvoke(args: {
  userEvmAddress: Address;
  marketIndex: number;
  /// Mint of the spot market (e.g. devnet USDC).
  mint: Hex;
  /// Pool's spot-market vault (read from on-chain SpotMarket struct).
  spotMarketVault: Hex;
  /// SpotMarket PDA (passed as remaining account).
  spotMarketPda: Hex;
  /// Oracle account (passed as remaining account).
  oraclePda: Hex;
  /// Amount in mint smallest unit.
  amount: bigint;
  /// Reduce-only mode (only relevant when user has open positions).
  reduceOnly?: boolean;
  subAccountId?: number;
}): DepositInvoke {
  const subAcct = args.subAccountId ?? 0;
  const authority = deriveRomeUserPda(args.userEvmAddress);
  const user = deriveDriftUser({ authority, subAccountId: subAcct });
  const userStats = deriveDriftUserStats(authority);
  const state = deriveDriftState();
  const userTokenAccount = deriveAta(authority, args.mint);

  const accounts: AccountMeta[] = [
    { pubkey: state, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: false, is_writable: true },
    { pubkey: userStats, is_signer: false, is_writable: true },
    { pubkey: authority, is_signer: true, is_writable: false },
    { pubkey: args.spotMarketVault, is_signer: false, is_writable: true },
    { pubkey: userTokenAccount, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    // remaining_accounts: [oracle, spot_market] — Drift's `load_maps`
    // consumes oracles first (greedy, until disc-mismatch), then
    // perp markets, then spot markets. The spot_market is writable
    // because its indexed-deposits accumulator gets bumped in the
    // deposit ix (writable_spot_markets includes market_index 1).
    { pubkey: args.oraclePda, is_signer: false, is_writable: false },
    { pubkey: args.spotMarketPda, is_signer: false, is_writable: true },
  ];

  const data = concat([
    DEPOSIT_DISC,
    toU16Le(args.marketIndex),
    toU64Le(args.amount),
    toBool(args.reduceOnly ?? false),
  ]);

  return {
    program: DRIFT_PROGRAM,
    accounts,
    data,
    addresses: { user, userStats, state },
    spotMarket: args.spotMarketPda,
  };
}

// ─────────────────────────────────────────────────────────────────────
// withdraw — Spot withdraw from a market
//
// IDL: 8 accounts, args = { market_index: u16, amount: u64, reduce_only: bool }
//   1. state             (readonly)
//   2. user              (writable, PDA)
//   3. userStats         (writable, PDA)
//   4. authority         (signer)
//   5. spotMarketVault   (writable) — pool's vault for this mint
//   6. driftSigner       (readonly) — PDA(["drift_signer"], DRIFT_PROGRAM)
//   7. userTokenAccount  (writable) — user's destination ATA
//   8. tokenProgram      (readonly)
//
// Plus remaining_accounts: oracle + spot market for the market_index.
// ─────────────────────────────────────────────────────────────────────

export type WithdrawInvoke = DriftInvoke & {
  spotMarket: Hex;
};

export function buildDriftSpotWithdrawInvoke(args: {
  userEvmAddress: Address;
  marketIndex: number;
  /// Mint of the spot market.
  mint: Hex;
  /// Pool's spot-market vault (read from on-chain SpotMarket struct).
  spotMarketVault: Hex;
  /// SpotMarket PDA (passed as remaining account).
  spotMarketPda: Hex;
  /// Oracle account (passed as remaining account).
  oraclePda: Hex;
  /// Amount in mint smallest unit.
  amount: bigint;
  /// Reduce-only mode (only relevant when user has open positions).
  reduceOnly?: boolean;
  subAccountId?: number;
}): WithdrawInvoke {
  const subAcct = args.subAccountId ?? 0;
  const authority = deriveRomeUserPda(args.userEvmAddress);
  const user = deriveDriftUser({ authority, subAccountId: subAcct });
  const userStats = deriveDriftUserStats(authority);
  const state = deriveDriftState();
  const driftSigner = deriveDriftSigner();
  const userTokenAccount = deriveAta(authority, args.mint);

  const accounts: AccountMeta[] = [
    { pubkey: state, is_signer: false, is_writable: false },
    { pubkey: user, is_signer: false, is_writable: true },
    { pubkey: userStats, is_signer: false, is_writable: true },
    { pubkey: authority, is_signer: true, is_writable: false },
    { pubkey: args.spotMarketVault, is_signer: false, is_writable: true },
    { pubkey: driftSigner, is_signer: false, is_writable: false },
    { pubkey: userTokenAccount, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    // remaining_accounts: [oracle, spot_market] — see deposit comment.
    { pubkey: args.oraclePda, is_signer: false, is_writable: false },
    { pubkey: args.spotMarketPda, is_signer: false, is_writable: true },
  ];

  const data = concat([
    WITHDRAW_DISC,
    toU16Le(args.marketIndex),
    toU64Le(args.amount),
    toBool(args.reduceOnly ?? false),
  ]);

  return {
    program: DRIFT_PROGRAM,
    accounts,
    data,
    addresses: { user, userStats, state },
    spotMarket: args.spotMarketPda,
  };
}

void ASSOCIATED_TOKEN_PROGRAM_ID;
void pubkeyBs58ToBytes32;
