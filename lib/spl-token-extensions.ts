// SPL Token classic — extension builders for Cardo `/send`.
//
// Adds the rest of the user-facing SPL Token instruction surface
// alongside `spl-transfer-instructions.ts` (TransferChecked, tag 12).
// Each builder targets the standard SPL Token program at
// `TokenkegQ…` (Token classic). Token-2022 callers can pass the
// alternate program id via `tokenProgramHex` — the instruction enum
// is identical at the same tag indices.
//
// Wire-format references (verified against
// solana-program-library/token/program/src/instruction.rs):
//
//   ApproveChecked  (tag 13): u8 || u64le(amount) || u8(decimals)
//   Revoke           (tag 5): u8
//   BurnChecked     (tag 15): u8 || u64le(amount) || u8(decimals)
//   CloseAccount     (tag 9): u8
//   SyncNative      (tag 17): u8
//
// Why *Checked over the legacy variants: the *Checked ix validates
// `decimals` against the on-chain mint, preventing the same footgun
// that motivated us to ship `TransferChecked` over `Transfer`.

import { concat, type Address, type Hex } from 'viem';
import type { AccountMeta } from './cpi-precompile';
import {
  SPL_TOKEN_PROGRAM_ID,
  deriveAta,
  deriveRomeUserPda,
  pubkeyToBytes32,
} from './solana-pda';

const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);

export const APPROVE_CHECKED_TAG = 13;
export const REVOKE_TAG = 5;
export const BURN_CHECKED_TAG = 15;
export const CLOSE_ACCOUNT_TAG = 9;
export const SYNC_NATIVE_TAG = 17;
export const SET_AUTHORITY_TAG = 6;

/// SPL Token AuthorityType discriminant values (per spl-token v3).
export const AUTHORITY_TYPE_MINT_TOKENS = 0;
export const AUTHORITY_TYPE_FREEZE_ACCOUNT = 1;
export const AUTHORITY_TYPE_ACCOUNT_OWNER = 2;
export const AUTHORITY_TYPE_CLOSE_ACCOUNT = 3;

function toU64Le(value: bigint): Hex {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return ('0x' + buf.toString('hex')) as Hex;
}

function toU8(v: number): Hex {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) {
    throw new Error(`u8 out of range: ${v}`);
  }
  return ('0x' + v.toString(16).padStart(2, '0')) as Hex;
}

export type SplTokenInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: Record<string, Hex>;
};

// ─────────────────────────────────────────────────────────────────────
// ApproveChecked — delegate spending authority over an ATA balance.
//
// Account list (from instruction.rs comment):
//   [0] source (writable)            — the user's ATA
//   [1] mint (readonly)
//   [2] delegate (readonly)          — pubkey to approve
//   [3] owner (signer, readonly)     — the user's Rome PDA
// ─────────────────────────────────────────────────────────────────────

export function buildSplApproveCheckedInvoke(args: {
  userEvmAddress: Address;
  /// SPL mint pubkey (bytes32).
  mintHex: Hex;
  /// Delegate pubkey (bytes32) — typically a Solana wallet bs58→bytes32.
  delegateHex: Hex;
  /// Approval amount in mint smallest units.
  amount: bigint;
  /// Mint decimals — TransferChecked-style validation.
  decimals: number;
  tokenProgramHex?: Hex;
}): SplTokenInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const sourceAta = deriveAta(owner, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: sourceAta, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: args.delegateHex, is_signer: false, is_writable: false },
    { pubkey: owner, is_signer: true, is_writable: false },
  ];

  const data = concat([
    toU8(APPROVE_CHECKED_TAG),
    toU64Le(args.amount),
    toU8(args.decimals),
  ]);

  return {
    program: args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX,
    accounts,
    data,
    addresses: { owner, sourceAta, delegate: args.delegateHex },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Revoke — remove any outstanding delegate.
//
// Account list:
//   [0] source (writable)            — the user's ATA
//   [1] owner (signer, readonly)
// ─────────────────────────────────────────────────────────────────────

export function buildSplRevokeInvoke(args: {
  userEvmAddress: Address;
  mintHex: Hex;
  tokenProgramHex?: Hex;
}): SplTokenInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const sourceAta = deriveAta(owner, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: sourceAta, is_signer: false, is_writable: true },
    { pubkey: owner, is_signer: true, is_writable: false },
  ];

  const data = toU8(REVOKE_TAG);

  return {
    program: args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX,
    accounts,
    data,
    addresses: { owner, sourceAta },
  };
}

// ─────────────────────────────────────────────────────────────────────
// BurnChecked — destroy tokens from an ATA. Mint supply decreases.
//
// Account list:
//   [0] source (writable)            — the user's ATA
//   [1] mint (writable)              — supply field gets updated
//   [2] owner (signer, readonly)
// ─────────────────────────────────────────────────────────────────────

export function buildSplBurnCheckedInvoke(args: {
  userEvmAddress: Address;
  mintHex: Hex;
  amount: bigint;
  decimals: number;
  tokenProgramHex?: Hex;
}): SplTokenInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const sourceAta = deriveAta(owner, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: sourceAta, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: true },
    { pubkey: owner, is_signer: true, is_writable: false },
  ];

  const data = concat([
    toU8(BURN_CHECKED_TAG),
    toU64Le(args.amount),
    toU8(args.decimals),
  ]);

  return {
    program: args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX,
    accounts,
    data,
    addresses: { owner, sourceAta },
  };
}

// ─────────────────────────────────────────────────────────────────────
// CloseAccount — reclaim the rent on an empty ATA.
//
// Account list:
//   [0] source (writable)            — the empty ATA being closed
//   [1] destination (writable)       — where the reclaimed lamports go
//   [2] owner (signer, readonly)
//
// Pre-flight: source ATA must hold zero of the underlying token.
// ─────────────────────────────────────────────────────────────────────

export function buildSplCloseAccountInvoke(args: {
  userEvmAddress: Address;
  /// Mint of the ATA being closed. We derive the user's ATA for it.
  mintHex: Hex;
  /// Destination for reclaimed rent. Defaults to user's Rome PDA.
  destinationHex?: Hex;
  tokenProgramHex?: Hex;
}): SplTokenInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const sourceAta = deriveAta(owner, args.mintHex);
  const destination = args.destinationHex ?? owner;

  const accounts: AccountMeta[] = [
    { pubkey: sourceAta, is_signer: false, is_writable: true },
    { pubkey: destination, is_signer: false, is_writable: true },
    { pubkey: owner, is_signer: true, is_writable: false },
  ];

  const data = toU8(CLOSE_ACCOUNT_TAG);

  return {
    program: args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX,
    accounts,
    data,
    addresses: { owner, sourceAta, destination },
  };
}

// ─────────────────────────────────────────────────────────────────────
// SyncNative — refresh a wrapped-SOL token account so its `amount`
// field matches the lamports in the underlying account. Useful after
// any non-SyncNative deposit of lamports into the wrapped-SOL ATA.
//
// Account list:
//   [0] native_token_account (writable)
//
// No signer required — anyone can crank.
// ─────────────────────────────────────────────────────────────────────

export function buildSplSyncNativeInvoke(args: {
  userEvmAddress: Address;
  /// Defaults to the user's wrapped-SOL ATA.
  /// Pass an explicit pubkey if you want to sync someone else's account.
  wrappedSolAtaHex?: Hex;
  /// SOL mint (used to derive the user's ATA when wrappedSolAtaHex is
  /// omitted).
  wsolMintHex: Hex;
  tokenProgramHex?: Hex;
}): SplTokenInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const ata = args.wrappedSolAtaHex ?? deriveAta(owner, args.wsolMintHex);

  const accounts: AccountMeta[] = [
    { pubkey: ata, is_signer: false, is_writable: true },
  ];

  const data = toU8(SYNC_NATIVE_TAG);

  return {
    program: args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX,
    accounts,
    data,
    addresses: { ata },
  };
}

// ─────────────────────────────────────────────────────────────────────
// SetAuthority — change the mint/freeze/owner/close authority of a
// mint or token account.
//
// Account list:
//   [0] mint_or_token_account (writable)
//   [1] current_authority (signer, readonly)
//
// Args layout:
//   u8 tag = 6
//   u8 authority_type:
//     0 = MintTokens          (mint authority of a mint)
//     1 = FreezeAccount       (freeze authority of a mint)
//     2 = AccountOwner        (owner of a token account)
//     3 = CloseAccount        (close authority of a token account)
//   Option<Pubkey> new_authority:
//     u8 tag (0=None, 1=Some)
//     32 bytes if Some
// ─────────────────────────────────────────────────────────────────────

export type SetAuthorityTarget = 'token-account' | 'mint';

export function buildSplSetAuthorityInvoke(args: {
  userEvmAddress: Address;
  /// Which kind of account is having its authority changed.
  /// 'token-account' = the user's ATA (current_authority must be the ATA owner)
  /// 'mint' = the SPL mint (current_authority must be the existing mint authority)
  target: SetAuthorityTarget;
  /// For 'token-account': the SPL mint to derive the user's ATA from.
  /// For 'mint': the mint pubkey directly.
  mintHex: Hex;
  /// Authority kind: MintTokens / FreezeAccount / AccountOwner / CloseAccount.
  authorityType: number;
  /// New authority pubkey, or null to clear (e.g. burn the mint authority).
  newAuthorityHex: Hex | null;
  tokenProgramHex?: Hex;
}): SplTokenInvoke {
  const owner = deriveRomeUserPda(args.userEvmAddress);
  const target =
    args.target === 'token-account' ? deriveAta(owner, args.mintHex) : args.mintHex;

  const accounts: AccountMeta[] = [
    { pubkey: target, is_signer: false, is_writable: true },
    { pubkey: owner, is_signer: true, is_writable: false },
  ];

  // data = u8(6) || u8(authorityType) || Option<Pubkey>(newAuthority)
  const optionTag = args.newAuthorityHex ? '0x01' : '0x00';
  const optionBody = args.newAuthorityHex ?? '0x';
  const data = concat([
    toU8(SET_AUTHORITY_TAG),
    toU8(args.authorityType),
    optionTag as Hex,
    optionBody as Hex,
  ]);

  return {
    program: args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX,
    accounts,
    data,
    addresses: { owner, target },
  };
}
