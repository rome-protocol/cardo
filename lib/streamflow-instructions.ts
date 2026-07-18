// Streamflow create_v2 instruction builder.
//
// Single ix, 18 accounts, atomic. Uses create_v2 (PDA metadata,
// init_if_needed for partner/treasury/recipient ATAs) for v1 so we
// don't need a separate "create recipient ATA" pre-flight. If Rome's
// 1.4M CU envelope rejects this, fall back to create_unchecked_v2
// (10 accounts, caller pre-creates ATAs).
//
// Pattern matches `lib/stake-pool-instructions.ts` and
// `lib/meteora-swap.ts`: pure functions, no network reads.
//
// Args body layout (Anchor Borsh, 142 bytes):
//   start_time              u64 LE
//   net_amount_deposited    u64 LE     (mint smallest unit)
//   period                  u64 LE     (seconds)
//   amount_per_period       u64 LE     (mint smallest unit)
//   cliff                   u64 LE     (unix seconds; 0 = no cliff)
//   cliff_amount            u64 LE     (mint smallest unit)
//   cancelable_by_sender    bool
//   cancelable_by_recipient bool
//   automatic_withdrawal    bool
//   transferable_by_sender  bool
//   transferable_by_recipient bool
//   can_topup               bool
//   stream_name             [u8; 64]   (right-pad zeros)
//   withdraw_frequency      u64 LE
//   pausable                bool
//   can_update_rate         bool
//   nonce                   u32 LE
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 8, Phase A — Sprint 1 continued).

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
  CANCEL_DISC,
  CREATE_V2_DISC,
  STREAMFLOW_FEE_ORACLE,
  STREAMFLOW_PROGRAM,
  TOPUP_DISC,
  TRANSFER_RECIPIENT_DISC,
  UPDATE_DISC,
  WITHDRAW_DISC,
  STREAMFLOW_TREASURY,
  STREAMFLOW_WITHDRAWOR,
} from './streamflow-program';
import { deriveEscrowTokens, deriveStreamMetadata } from './streamflow-pdas';

// ─────────────────────────────────────────────────────────────────────
// Sysvars + program ids (bytes32 form)
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM = pubkeyToBytes32(PublicKey.default);
const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);
const ASSOC_TOKEN_PROGRAM_HEX = pubkeyToBytes32(ASSOCIATED_TOKEN_PROGRAM_ID);
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

function toU32Le(value: number): Hex {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`u32 out of range: ${value}`);
  }
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return ('0x' + b.toString('hex')) as Hex;
}

function toBool(b: boolean): Hex {
  return b ? '0x01' : '0x00';
}

/// Encode a stream name as a fixed 64-byte UTF-8 buffer, zero-padded.
/// Truncates if too long (the program treats the buffer as a fixed
/// array; non-zero bytes after the name are ignored at display time
/// but consume the slot).
function encodeStreamName(name: string): Hex {
  const buf = Buffer.alloc(64);
  Buffer.from(name, 'utf8').copy(buf, 0, 0, 64);
  return ('0x' + buf.toString('hex')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// create_v2 invoke builder
// ─────────────────────────────────────────────────────────────────────

export type CreateStreamArgs = {
  startTime: bigint; // unix seconds; 0 = use current
  netAmountDeposited: bigint; // mint smallest unit
  period: bigint; // unlock period seconds
  amountPerPeriod: bigint; // mint smallest unit
  cliff: bigint; // unix seconds; 0 = no cliff
  cliffAmount: bigint; // mint smallest unit
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
  automaticWithdrawal: boolean;
  transferableBySender: boolean;
  transferableByRecipient: boolean;
  canTopup: boolean;
  streamName: string; // up to 64 bytes utf8
  withdrawFrequency: bigint; // matches `period` when not auto-withdraw
  pausable: boolean;
  canUpdateRate: boolean;
  nonce: number; // u32; ≤ 255 recommended for first integration
};

export type CreateStreamInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Echoed for the preview panel.
  addresses: {
    sender: Hex;
    senderTokens: Hex;
    recipient: Hex;
    recipientTokens: Hex;
    metadata: Hex;
    escrowTokens: Hex;
    treasuryTokens: Hex;
    partnerTokens: Hex;
  };
};

export function buildCreateStreamInvoke(args: {
  userEvmAddress: Address;
  recipientHex: Hex;
  mintHex: Hex;
  /// Token program for the mint. Pass SPL Token classic for canonical
  /// USDC / WSOL on devnet/mainnet. Token-2022 mints would pass the T22
  /// program id instead — caller resolves by reading the mint's owner.
  tokenProgramHex?: Hex;
  /// Optional partner. When unset, treasury is reused as the
  /// "no partner" sentinel per Streamflow's convention.
  partnerHex?: Hex;
  stream: CreateStreamArgs;
}): CreateStreamInvoke {
  const sender = deriveRomeUserPda(args.userEvmAddress);
  const tokenProgram = args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX;
  const partner = args.partnerHex ?? STREAMFLOW_TREASURY;

  const senderTokens = deriveAta(sender, args.mintHex);
  // ATA derivation uses the SPL Token program id as a seed — not the
  // token-program kind. For Token-2022 mints the ATA derivation seed
  // is the SPL_TOKEN_PROGRAM_ID; the resulting account's *owner* is
  // Token-2022 but the address is derived from the classic seed.
  // Per @solana/spl-token spec, deriveAta() already uses the classic
  // SPL_TOKEN_PROGRAM_ID as the seed.

  const recipientTokens = deriveAta(args.recipientHex, args.mintHex);
  const treasuryTokens = deriveAta(STREAMFLOW_TREASURY, args.mintHex);
  const partnerTokens = deriveAta(partner, args.mintHex);

  const metadata = deriveStreamMetadata({
    mint: args.mintHex,
    sender,
    nonce: args.stream.nonce,
  });
  const escrowTokens = deriveEscrowTokens(metadata);

  const accounts: AccountMeta[] = [
    { pubkey: sender, is_signer: true, is_writable: true },
    { pubkey: senderTokens, is_signer: false, is_writable: true },
    { pubkey: args.recipientHex, is_signer: false, is_writable: true },
    { pubkey: metadata, is_signer: false, is_writable: true },
    { pubkey: escrowTokens, is_signer: false, is_writable: true },
    { pubkey: recipientTokens, is_signer: false, is_writable: true },
    { pubkey: STREAMFLOW_TREASURY, is_signer: false, is_writable: true },
    { pubkey: treasuryTokens, is_signer: false, is_writable: true },
    { pubkey: STREAMFLOW_WITHDRAWOR, is_signer: false, is_writable: true },
    { pubkey: partner, is_signer: false, is_writable: true },
    { pubkey: partnerTokens, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: STREAMFLOW_FEE_ORACLE, is_signer: false, is_writable: false },
    { pubkey: SYSVAR_RENT, is_signer: false, is_writable: false },
    // timelock_program — pass the program id to itself per Anchor convention
    { pubkey: STREAMFLOW_PROGRAM, is_signer: false, is_writable: false },
    { pubkey: tokenProgram, is_signer: false, is_writable: false },
    { pubkey: ASSOC_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  const s = args.stream;
  const data = concat([
    CREATE_V2_DISC,
    toU64Le(s.startTime),
    toU64Le(s.netAmountDeposited),
    toU64Le(s.period),
    toU64Le(s.amountPerPeriod),
    toU64Le(s.cliff),
    toU64Le(s.cliffAmount),
    toBool(s.cancelableBySender),
    toBool(s.cancelableByRecipient),
    toBool(s.automaticWithdrawal),
    toBool(s.transferableBySender),
    toBool(s.transferableByRecipient),
    toBool(s.canTopup),
    encodeStreamName(s.streamName),
    toU64Le(s.withdrawFrequency),
    toBool(s.pausable),
    toBool(s.canUpdateRate),
    toU32Le(s.nonce),
    // Trailing 10 zero bytes the deployed program requires. The Streamflow
    // JS SDK appends this in instructions.ts:338. Without it the program
    // reverts with Anchor error 102 (InstructionDidNotDeserialize).
    // Confirmed via live revert 2026-04-25 on Rome → Solana devnet.
    '0x00000000000000000000' as Hex,
  ]);

  return {
    program: STREAMFLOW_PROGRAM,
    accounts,
    data,
    addresses: {
      sender,
      senderTokens,
      recipient: args.recipientHex,
      recipientTokens,
      metadata,
      escrowTokens,
      treasuryTokens,
      partnerTokens,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// withdraw — recipient claims vested tokens
//
// IDL: 11 accounts, args = { amount: u64 }
//   1.  authority (signer, writable)         ← user PDA (recipient or auto-cranker)
//   2.  recipient (writable)                 ← bs58 of recipient
//   3.  recipientTokens (writable)           ← ATA(recipient, mint)
//   4.  metadata (writable)                  ← stream's metadata PDA
//   5.  escrowTokens (writable)              ← stream's escrow ATA
//   6.  streamflowTreasury (writable)
//   7.  streamflowTreasuryTokens (writable)  ← ATA(treasury, mint)
//   8.  partner (writable)
//   9.  partnerTokens (writable)             ← ATA(partner, mint)
//   10. mint (writable)
//   11. tokenProgram
//
// Pattern: same partner-fallback as createV2 — when no partner is set,
// treasury is reused as the sentinel.
// ─────────────────────────────────────────────────────────────────────

export type WithdrawStreamInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: {
    authority: Hex;
    recipient: Hex;
    recipientTokens: Hex;
    metadata: Hex;
    escrowTokens: Hex;
    treasuryTokens: Hex;
    partnerTokens: Hex;
  };
};

export function buildStreamflowWithdrawInvoke(args: {
  /// EVM caller (their Rome PDA acts as the authority signer).
  userEvmAddress: Address;
  /// Stream's metadata PDA — caller derives via `deriveStreamMetadata`
  /// or fetches it from the recipient-stream listing.
  metadataHex: Hex;
  /// SPL mint backing the stream.
  mintHex: Hex;
  /// Recipient pubkey (bytes32). For Cardo flows where the user is the
  /// recipient, this equals the user's Rome PDA.
  recipientHex: Hex;
  /// Token program for the mint (SPL Token classic by default).
  tokenProgramHex?: Hex;
  /// Optional partner; when unset, treasury is reused (same convention
  /// as createV2).
  partnerHex?: Hex;
  /// Amount to withdraw, in mint smallest units.
  amount: bigint;
}): WithdrawStreamInvoke {
  const authority = deriveRomeUserPda(args.userEvmAddress);
  const tokenProgram = args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX;
  const partner = args.partnerHex ?? STREAMFLOW_TREASURY;

  const recipientTokens = deriveAta(args.recipientHex, args.mintHex);
  const escrowTokens = deriveEscrowTokens(args.metadataHex);
  const treasuryTokens = deriveAta(STREAMFLOW_TREASURY, args.mintHex);
  const partnerTokens = deriveAta(partner, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: authority, is_signer: true, is_writable: true },
    { pubkey: args.recipientHex, is_signer: false, is_writable: true },
    { pubkey: recipientTokens, is_signer: false, is_writable: true },
    { pubkey: args.metadataHex, is_signer: false, is_writable: true },
    { pubkey: escrowTokens, is_signer: false, is_writable: true },
    { pubkey: STREAMFLOW_TREASURY, is_signer: false, is_writable: true },
    { pubkey: treasuryTokens, is_signer: false, is_writable: true },
    { pubkey: partner, is_signer: false, is_writable: true },
    { pubkey: partnerTokens, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: true },
    { pubkey: tokenProgram, is_signer: false, is_writable: false },
  ];

  const data = concat([WITHDRAW_DISC, toU64Le(args.amount)]);

  return {
    program: STREAMFLOW_PROGRAM,
    accounts,
    data,
    addresses: {
      authority,
      recipient: args.recipientHex,
      recipientTokens,
      metadata: args.metadataHex,
      escrowTokens,
      treasuryTokens,
      partnerTokens,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// cancel — terminate stream, refund remaining funds to sender.
// Verified vs js-sdk cancelStreamInstruction (13 accounts).
// data = CANCEL_DISC (no args).
// ─────────────────────────────────────────────────────────────────────

export type CancelStreamInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: {
    authority: Hex;
    sender: Hex;
    senderTokens: Hex;
    recipient: Hex;
    recipientTokens: Hex;
    metadata: Hex;
    escrowTokens: Hex;
  };
};

export function buildStreamflowCancelInvoke(args: {
  userEvmAddress: Address;
  metadataHex: Hex;
  mintHex: Hex;
  /// Stream's sender pubkey on-chain (typically the user's Rome PDA
  /// when the user originally created the stream).
  senderHex: Hex;
  /// Stream's recipient pubkey on-chain.
  recipientHex: Hex;
  partnerHex?: Hex;
  tokenProgramHex?: Hex;
}): CancelStreamInvoke {
  const authority = deriveRomeUserPda(args.userEvmAddress);
  const tokenProgram = args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX;
  const partner = args.partnerHex ?? STREAMFLOW_TREASURY;

  const senderTokens = deriveAta(args.senderHex, args.mintHex);
  const recipientTokens = deriveAta(args.recipientHex, args.mintHex);
  const escrowTokens = deriveEscrowTokens(args.metadataHex);
  const treasuryTokens = deriveAta(STREAMFLOW_TREASURY, args.mintHex);
  const partnerTokens = deriveAta(partner, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: authority, is_signer: true, is_writable: false },
    { pubkey: args.senderHex, is_signer: false, is_writable: true },
    { pubkey: senderTokens, is_signer: false, is_writable: true },
    { pubkey: args.recipientHex, is_signer: false, is_writable: true },
    { pubkey: recipientTokens, is_signer: false, is_writable: true },
    { pubkey: args.metadataHex, is_signer: false, is_writable: true },
    { pubkey: escrowTokens, is_signer: false, is_writable: true },
    { pubkey: STREAMFLOW_TREASURY, is_signer: false, is_writable: true },
    { pubkey: treasuryTokens, is_signer: false, is_writable: true },
    { pubkey: partner, is_signer: false, is_writable: true },
    { pubkey: partnerTokens, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: true },
    { pubkey: tokenProgram, is_signer: false, is_writable: false },
  ];

  return {
    program: STREAMFLOW_PROGRAM,
    accounts,
    data: CANCEL_DISC,
    addresses: {
      authority,
      sender: args.senderHex,
      senderTokens,
      recipient: args.recipientHex,
      recipientTokens,
      metadata: args.metadataHex,
      escrowTokens,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// topup — sender adds more tokens to an existing stream.
// Verified vs js-sdk topupStreamInstruction (12 accounts).
// data = TOPUP_DISC || u64le(amount).
// ─────────────────────────────────────────────────────────────────────

export type TopupStreamInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: {
    sender: Hex;
    senderTokens: Hex;
    metadata: Hex;
    escrowTokens: Hex;
  };
};

export function buildStreamflowTopupInvoke(args: {
  userEvmAddress: Address;
  metadataHex: Hex;
  mintHex: Hex;
  /// Topup amount in mint smallest units.
  amount: bigint;
  partnerHex?: Hex;
  tokenProgramHex?: Hex;
}): TopupStreamInvoke {
  const sender = deriveRomeUserPda(args.userEvmAddress);
  const tokenProgram = args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX;
  const partner = args.partnerHex ?? STREAMFLOW_TREASURY;

  const senderTokens = deriveAta(sender, args.mintHex);
  const escrowTokens = deriveEscrowTokens(args.metadataHex);
  const treasuryTokens = deriveAta(STREAMFLOW_TREASURY, args.mintHex);
  const partnerTokens = deriveAta(partner, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: sender, is_signer: true, is_writable: true },
    { pubkey: senderTokens, is_signer: false, is_writable: true },
    { pubkey: args.metadataHex, is_signer: false, is_writable: true },
    { pubkey: escrowTokens, is_signer: false, is_writable: true },
    { pubkey: STREAMFLOW_TREASURY, is_signer: false, is_writable: true },
    { pubkey: treasuryTokens, is_signer: false, is_writable: true },
    { pubkey: STREAMFLOW_WITHDRAWOR, is_signer: false, is_writable: true },
    { pubkey: partner, is_signer: false, is_writable: true },
    { pubkey: partnerTokens, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: tokenProgram, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([TOPUP_DISC, toU64Le(args.amount)]);

  return {
    program: STREAMFLOW_PROGRAM,
    accounts,
    data,
    addresses: { sender, senderTokens, metadata: args.metadataHex, escrowTokens },
  };
}

// ─────────────────────────────────────────────────────────────────────
// update — modify stream parameters (auto-withdrawal + rate + flags).
// Verified vs js-sdk updateStreamInstruction (4 accounts).
//
// data = UPDATE_DISC || Option<bool>(enable_automatic_withdrawal) ||
//        Option<u64>(withdraw_frequency) || Option<u64>(amount_per_period) ||
//        Option<bool>(transferable_by_sender) ||
//        Option<bool>(transferable_by_recipient) ||
//        Option<bool>(cancelable_by_sender)
//
// SIX args, verified against the program's ON-CHAIN Anchor IDL (fetched from
// HqDGZjaVR…'s idl PDA 2026-07-11). The bug: `enable` was emitted as a BARE u8
// (1 byte) instead of Option<bool> (2 bytes for Some) — so the program read
// withdraw_frequency's option-tag as the bool and the freq's first value byte
// (0x3c) as an invalid option-tag → InstructionDidNotDeserialize (Custom 102),
// the "enable automatic withdrawal" revert (user-reported). The last three flags are
// Option<bool> too (were mis-encoded Option<u8>; harmless while None, wrong if set).
// ─────────────────────────────────────────────────────────────────────

export type UpdateStreamInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { authority: Hex; metadata: Hex };
};

function optU64Le(v?: bigint): Hex {
  if (v === undefined || v === null) return '0x00';
  const inner = (() => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v, 0);
    return buf.toString('hex');
  })();
  return ('0x01' + inner) as Hex;
}

/// Borsh `Option<bool>`: None = 0x00, Some(true) = 0x0101, Some(false) = 0x0100.
/// (The enable flag is Option<bool>, NOT a bare u8 — a bare byte mis-aligns
/// every field after it and the program aborts InstructionDidNotDeserialize.)
function optBool(v?: boolean): Hex {
  if (v === undefined || v === null) return '0x00';
  return (v ? '0x0101' : '0x0100') as Hex;
}

export function buildStreamflowUpdateInvoke(args: {
  userEvmAddress: Address;
  metadataHex: Hex;
  enableAutomaticWithdrawal?: boolean;
  withdrawFrequency?: bigint;
  amountPerPeriod?: bigint;
  transferableBySender?: boolean;
  transferableByRecipient?: boolean;
  cancelableBySender?: boolean;
}): UpdateStreamInvoke {
  const authority = deriveRomeUserPda(args.userEvmAddress);

  const accounts: AccountMeta[] = [
    { pubkey: authority, is_signer: true, is_writable: true },
    { pubkey: args.metadataHex, is_signer: false, is_writable: true },
    { pubkey: STREAMFLOW_WITHDRAWOR, is_signer: false, is_writable: true },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  const data = concat([
    UPDATE_DISC,
    optBool(args.enableAutomaticWithdrawal), // Option<bool>
    optU64Le(args.withdrawFrequency), // Option<u64>
    optU64Le(args.amountPerPeriod), // Option<u64>
    optBool(args.transferableBySender), // Option<bool>
    optBool(args.transferableByRecipient), // Option<bool>
    optBool(args.cancelableBySender), // Option<bool>
  ]);

  return {
    program: STREAMFLOW_PROGRAM,
    accounts,
    data,
    addresses: { authority, metadata: args.metadataHex },
  };
}

// ─────────────────────────────────────────────────────────────────────
// transfer_recipient — reassign stream's recipient to a new wallet.
// Verified vs js-sdk transferRecipient flow (9 accounts).
//
//   1. authority (signer, rw)        ← user PDA, must equal current
//                                      stream.recipient
//   2. new_recipient (rw)
//   3. new_recipient_tokens (rw)
//   4. metadata (rw)
//   5. mint (ro)
//   6. rent_sysvar (ro)
//   7. token_program (ro)
//   8. associated_token_program (ro)
//   9. system_program (ro)
//
// data = TRANSFER_RECIPIENT_DISC (no args)
// ─────────────────────────────────────────────────────────────────────

export type TransferRecipientInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  addresses: { authority: Hex; newRecipient: Hex; newRecipientTokens: Hex; metadata: Hex };
};

export function buildStreamflowTransferRecipientInvoke(args: {
  userEvmAddress: Address;
  metadataHex: Hex;
  mintHex: Hex;
  /// New recipient pubkey (bytes32).
  newRecipientHex: Hex;
  tokenProgramHex?: Hex;
}): TransferRecipientInvoke {
  const authority = deriveRomeUserPda(args.userEvmAddress);
  const tokenProgram = args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX;
  const newRecipientTokens = deriveAta(args.newRecipientHex, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: authority, is_signer: true, is_writable: true },
    { pubkey: args.newRecipientHex, is_signer: false, is_writable: true },
    { pubkey: newRecipientTokens, is_signer: false, is_writable: true },
    { pubkey: args.metadataHex, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: SYSVAR_RENT, is_signer: false, is_writable: false },
    { pubkey: tokenProgram, is_signer: false, is_writable: false },
    { pubkey: ASSOC_TOKEN_PROGRAM_HEX, is_signer: false, is_writable: false },
    { pubkey: SYSTEM_PROGRAM, is_signer: false, is_writable: false },
  ];

  return {
    program: STREAMFLOW_PROGRAM,
    accounts,
    data: TRANSFER_RECIPIENT_DISC,
    addresses: {
      authority,
      newRecipient: args.newRecipientHex,
      newRecipientTokens,
      metadata: args.metadataHex,
    },
  };
}
