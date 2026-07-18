// Mango v4 invoke builders for Cardo `/lend` (deposit / withdraw) and
// /perps (future). Three invokes:
//
//   1. accountCreate           — register a fresh MangoAccount PDA
//   2. tokenDeposit            — move SPL from user ATA into bank vault
//   3. tokenWithdraw           — move SPL from bank vault back to user ATA
//
// Both deposit signers (owner + tokenAuthority) and the withdraw
// signer (owner) are the user's Rome PDA. Rome's CPI precompile
// auto-signs as the PDA when msg.sender == userEoa, so a single
// auto-sign covers all signer slots.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

import { concat, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  SPL_TOKEN_PROGRAM_ID,
  deriveAta,
  deriveRomeUserPda,
  pubkeyToBytes32,
} from './solana-pda';
import {
  ACCOUNT_CLOSE_DISC,
  ACCOUNT_CREATE_DISC,
  ACCOUNT_EDIT_DISC,
  ACCOUNT_EXPAND_DISC,
  DEFAULT_PERP_COUNT,
  DEFAULT_PERP_OO_COUNT,
  DEFAULT_SERUM3_COUNT,
  DEFAULT_TOKEN_COUNT,
  MANGO_V4_PROGRAM,
  TCS_CANCEL_DISC,
  TCS_CREATE_DISC,
  TOKEN_DEPOSIT_DISC,
  TOKEN_WITHDRAW_DISC,
} from './mango-program';
import { deriveMangoAccount } from './mango-pdas';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);
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

function toU32Le(v: number): Hex {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error(`u32 out of range: ${v}`);
  }
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

function toU8(v: number): Hex {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`u8 out of range: ${v}`);
  return ('0x' + v.toString(16).padStart(2, '0')) as Hex;
}

function toBool(v: boolean): Hex {
  return v ? '0x01' : '0x00';
}

/// Borsh string: u32-le length + utf8 bytes.
function toBorshString(s: string): Hex {
  const utf8 = Buffer.from(s, 'utf8');
  const len = toU32Le(utf8.length);
  return concat([len, ('0x' + utf8.toString('hex')) as Hex]);
}

// ─────────────────────────────────────────────────────────────────────
// accountCreate invoke (5 accounts)
// ─────────────────────────────────────────────────────────────────────

export type MangoAccountCreateInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { user: Hex; mangoAccount: Hex; group: Hex };
};

export function buildMangoAccountCreateInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  /// Optional account number (defaults to 0 — first account under the group).
  accountNum?: number;
  /// Optional UI label for the MangoAccount; surfaced in Mango UIs.
  name?: string;
  /// Optional override for slot counts.
  tokenCount?: number;
  serum3Count?: number;
  perpCount?: number;
  perpOoCount?: number;
}): MangoAccountCreateInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const accountNum = args.accountNum ?? 0;
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum,
  });

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false }, // owner
    { pubkey: user, is_signer: true, is_writable: true }, // payer (same PDA)
    { pubkey: SYSTEM_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  const data = concat([
    ACCOUNT_CREATE_DISC,
    toU32Le(accountNum),
    toU8(args.tokenCount ?? DEFAULT_TOKEN_COUNT),
    toU8(args.serum3Count ?? DEFAULT_SERUM3_COUNT),
    toU8(args.perpCount ?? DEFAULT_PERP_COUNT),
    toU8(args.perpOoCount ?? DEFAULT_PERP_OO_COUNT),
    toBorshString(args.name ?? ''),
  ]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount, group: args.groupHex },
  };
}

// ─────────────────────────────────────────────────────────────────────
// tokenDeposit invoke (9 accounts)
// ─────────────────────────────────────────────────────────────────────

export type MangoTokenInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: {
    user: Hex;
    mangoAccount: Hex;
    userTokenAccount: Hex;
  };
};

export function buildMangoTokenDepositInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  /// Bank's mint (used to derive the user's ATA).
  mintHex: Hex;
  /// Decoded Bank account fields. Caller is responsible for fetching +
  /// decoding the Bank to populate these. See `BANK_FIELD_OFFSETS` in
  /// mango-program.ts for the layout.
  bank: { pubkey: Hex; vault: Hex; oracle: Hex };
  amount: bigint;
  reduceOnly?: boolean;
  /// Optional MangoAccount account-num override (defaults to 0).
  accountNum?: number;
}): MangoTokenInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum: args.accountNum ?? 0,
  });
  const userTokenAccount = deriveAta(user, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false }, // owner
    { pubkey: args.bank.pubkey, is_signer: false, is_writable: true },
    { pubkey: args.bank.vault, is_signer: false, is_writable: true },
    { pubkey: args.bank.oracle, is_signer: false, is_writable: false },
    { pubkey: userTokenAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false }, // tokenAuthority (same PDA)
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  const data = concat([
    TOKEN_DEPOSIT_DISC,
    toU64Le(args.amount),
    toBool(args.reduceOnly ?? false),
  ]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount, userTokenAccount },
  };
}

// ─────────────────────────────────────────────────────────────────────
// tokenWithdraw invoke (8 accounts)
// ─────────────────────────────────────────────────────────────────────

export function buildMangoTokenWithdrawInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  mintHex: Hex;
  bank: { pubkey: Hex; vault: Hex; oracle: Hex };
  amount: bigint;
  allowBorrow?: boolean;
  accountNum?: number;
}): MangoTokenInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum: args.accountNum ?? 0,
  });
  const userTokenAccount = deriveAta(user, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false }, // owner
    { pubkey: args.bank.pubkey, is_signer: false, is_writable: true },
    { pubkey: args.bank.vault, is_signer: false, is_writable: true },
    { pubkey: args.bank.oracle, is_signer: false, is_writable: false },
    { pubkey: userTokenAccount, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  const data = concat([
    TOKEN_WITHDRAW_DISC,
    toU64Le(args.amount),
    toBool(args.allowBorrow ?? false),
  ]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount, userTokenAccount },
  };
}

// ─────────────────────────────────────────────────────────────────────
// account_close — close a MangoAccount, refund rent to sol_destination.
// Verified vs mango-v4 src/accounts_ix/account_close.rs (5 accounts).
// ─────────────────────────────────────────────────────────────────────

export type MangoAccountCloseInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { user: Hex; mangoAccount: Hex };
};

export function buildMangoAccountCloseInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  /// Account number to close. Defaults to 0.
  accountNum?: number;
  /// Optional override for rent destination. Defaults to user's Rome PDA.
  solDestinationHex?: Hex;
}): MangoAccountCloseInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const accountNum = args.accountNum ?? 0;
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum,
  });
  const solDestination = args.solDestinationHex ?? user;

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false }, // owner
    { pubkey: solDestination, is_signer: false, is_writable: true },
    { pubkey: SPL_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  // force_close = false (only owner-callable path; admin force-close
  // not exposed here).
  const data = concat([ACCOUNT_CLOSE_DISC, '0x00' as Hex]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount },
  };
}

// ─────────────────────────────────────────────────────────────────────
// account_edit — modify name + delegate fields on a MangoAccount.
// 3 accounts: group (ro), account (rw, has_one=group/owner), owner (signer).
// Verified vs mango-v4 src/accounts_ix/account_edit.rs +
// src/lib.rs::account_edit signature.
//
// Args (Borsh):
//   name_opt: Option<String>
//   delegate_opt: Option<Pubkey>
//   temporary_delegate_opt: Option<Pubkey>
//   temporary_delegate_expiry_opt: Option<u64>
// ─────────────────────────────────────────────────────────────────────

function optString(s: string | null | undefined): Hex {
  if (s === null || s === undefined) return '0x00';
  return ('0x01' + toBorshString(s).slice(2)) as Hex;
}

function optPubkey(p: Hex | null | undefined): Hex {
  if (p === null || p === undefined) return '0x00';
  return ('0x01' + p.slice(2)) as Hex;
}

function optU64Le(v: bigint | null | undefined): Hex {
  if (v === null || v === undefined) return '0x00';
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v, 0);
  return ('0x01' + buf.toString('hex')) as Hex;
}

export type MangoAccountEditInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { user: Hex; mangoAccount: Hex };
};

export function buildMangoAccountEditInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  accountNum?: number;
  /// New display name (null = leave unchanged).
  name?: string | null;
  /// New delegate pubkey (null = leave unchanged; or pass System
  /// Program pubkey to clear).
  delegateHex?: Hex | null;
  temporaryDelegateHex?: Hex | null;
  temporaryDelegateExpiry?: bigint | null;
}): MangoAccountEditInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const accountNum = args.accountNum ?? 0;
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum,
  });

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false },
  ];

  const data = concat([
    ACCOUNT_EDIT_DISC,
    optString(args.name),
    optPubkey(args.delegateHex),
    optPubkey(args.temporaryDelegateHex),
    optU64Le(args.temporaryDelegateExpiry),
  ]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount },
  };
}

// ─────────────────────────────────────────────────────────────────────
// account_expand — grow a MangoAccount's slot counts.
// 5 accounts: group (ro), account (rw, has_one), owner (signer),
// payer (signer rw), system_program (ro).
//
// Args: token_count u8, serum3_count u8, perp_count u8, perp_oo_count u8.
// ─────────────────────────────────────────────────────────────────────

export type MangoAccountExpandInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { user: Hex; mangoAccount: Hex };
};

export function buildMangoAccountExpandInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  accountNum?: number;
  /// New slot counts. Must be >= current values.
  tokenCount: number;
  serum3Count: number;
  perpCount: number;
  perpOoCount: number;
}): MangoAccountExpandInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const accountNum = args.accountNum ?? 0;
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum,
  });

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: user, is_signer: true, is_writable: true }, // payer (same PDA)
    { pubkey: SYSTEM_PROGRAM_HEX, is_signer: false, is_writable: false },
  ];

  const data = concat([
    ACCOUNT_EXPAND_DISC,
    toU8(args.tokenCount),
    toU8(args.serum3Count),
    toU8(args.perpCount),
    toU8(args.perpOoCount),
  ]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount },
  };
}

// ─────────────────────────────────────────────────────────────────────
// token_conditional_swap_create — stop-loss / take-profit primitive.
//
// 5 accounts: group (ro), account (rw, has_one=group, owner=signer),
// authority (signer), buy_bank (ro), sell_bank (ro).
//
// Args (Borsh): max_buy u64 || max_sell u64 || expiry_timestamp u64 ||
//   price_lower_limit f64 || price_upper_limit f64 || price_premium_rate f64 ||
//   allow_creating_deposits bool || allow_creating_borrows bool
//
// f64 is little-endian IEEE-754 8 bytes. All numeric prices are
// "external" (mint smallest unit ratio) per Mango's TCS spec.
// ─────────────────────────────────────────────────────────────────────

function toF64Le(v: number): Hex {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(v, 0);
  return ('0x' + buf.toString('hex')) as Hex;
}

export type MangoTcsCreateInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { user: Hex; mangoAccount: Hex };
};

export function buildMangoTcsCreateInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  accountNum?: number;
  /// Bank pubkeys for the buy + sell sides of the conditional swap.
  buyBankHex: Hex;
  sellBankHex: Hex;
  /// Max amount to buy (mint smallest unit).
  maxBuy: bigint;
  /// Max amount to sell (mint smallest unit).
  maxSell: bigint;
  /// Unix-seconds expiry. 0 = no expiry.
  expiryTimestamp: bigint;
  /// Price lower bound (mint smallest unit ratio buy/sell).
  priceLowerLimit: number;
  /// Price upper bound. Trigger fires when oracle price ∈ [lower, upper].
  priceUpperLimit: number;
  /// Premium offered to keepers (e.g. 0.005 = 0.5%).
  pricePremiumRate: number;
  /// If true, the swap can create new deposits on the buy side.
  allowCreatingDeposits?: boolean;
  /// If true, the swap can borrow on the sell side.
  allowCreatingBorrows?: boolean;
}): MangoTcsCreateInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const accountNum = args.accountNum ?? 0;
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum,
  });

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false }, // authority
    { pubkey: args.buyBankHex, is_signer: false, is_writable: false },
    { pubkey: args.sellBankHex, is_signer: false, is_writable: false },
  ];

  const data = concat([
    TCS_CREATE_DISC,
    toU64Le(args.maxBuy),
    toU64Le(args.maxSell),
    toU64Le(args.expiryTimestamp),
    toF64Le(args.priceLowerLimit),
    toF64Le(args.priceUpperLimit),
    toF64Le(args.pricePremiumRate),
    toBool(args.allowCreatingDeposits ?? false),
    toBool(args.allowCreatingBorrows ?? false),
  ]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount },
  };
}

// ─────────────────────────────────────────────────────────────────────
// token_conditional_swap_cancel — cancel an existing TCS by index + id.
//
// 5 accounts: group (ro), account (rw), authority (signer),
// buy_bank (rw), sell_bank (rw). Banks are mut here because cancel
// updates token positions (releases reserved deposits / unwinds
// reserved borrow capacity).
//
// Args: token_conditional_swap_index u8 || token_conditional_swap_id u64
// ─────────────────────────────────────────────────────────────────────

export type MangoTcsCancelInvoke = MangoTcsCreateInvoke;

export function buildMangoTcsCancelInvoke(args: {
  userEvmAddress: Address;
  groupHex: Hex;
  accountNum?: number;
  buyBankHex: Hex;
  sellBankHex: Hex;
  /// Slot index of the TCS in the account's TCS list.
  tcsIndex: number;
  /// Unique ID of the TCS (assigned at create time).
  tcsId: bigint;
}): MangoTcsCancelInvoke {
  const user = deriveRomeUserPda(args.userEvmAddress);
  const accountNum = args.accountNum ?? 0;
  const mangoAccount = deriveMangoAccount({
    groupHex: args.groupHex,
    ownerHex: user,
    accountNum,
  });

  const accounts: AccountMeta[] = [
    { pubkey: args.groupHex, is_signer: false, is_writable: false },
    { pubkey: mangoAccount, is_signer: false, is_writable: true },
    { pubkey: user, is_signer: true, is_writable: false },
    { pubkey: args.buyBankHex, is_signer: false, is_writable: true },
    { pubkey: args.sellBankHex, is_signer: false, is_writable: true },
  ];

  const data = concat([
    TCS_CANCEL_DISC,
    toU8(args.tcsIndex),
    toU64Le(args.tcsId),
  ]);

  return {
    program: MANGO_V4_PROGRAM,
    accounts,
    data,
    addresses: { user, mangoAccount },
  };
}
