// SPL Token TransferChecked instruction builder for Cardo /send.
//
// Direct CPI to `spl-token::TransferChecked` (instruction tag 12).
// Single Solana ix, 4 accounts, one signer (the user's Rome PDA, which
// owns the source ATA).
//
// **Why TransferChecked over Transfer (tag 3)**: TransferChecked
// validates `mint` + `decimals` against the actual mint account. Plain
// Transfer trusts the caller's amount-decimals interpretation, which
// is footgun-friendly for Token-2022 mints with transfer fees. The
// stock SPL Token program supports both.
//
// **Pre-flight requirement**: the recipient's ATA must already exist.
// Creating it would require a separate ix in the same Solana tx
// (`spl_associated_token_account::create_associated_token_account`),
// which is blocked on Rome's batched-CPI feature. v1 surfaces a clear
// "recipient doesn't have an account for this token yet" error rather
// than silently failing.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 8, Phase A — Tier A0 finisher).

import { concat, numberToHex, type Address, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { AccountMeta } from './cpi-precompile';
import {
  SPL_TOKEN_PROGRAM_ID,
  bytes32ToPublicKey,
  deriveAta,
  deriveRomeUserPda,
  pubkeyToBytes32,
} from './solana-pda';

// ─────────────────────────────────────────────────────────────────────
// Constants — both SPL Token classic and Token-2022 expose the same
// instruction enum at the same indices. The token-program *program id*
// passed at the precompile differs per mint owner.
// ─────────────────────────────────────────────────────────────────────

const SPL_TOKEN_PROGRAM_HEX = pubkeyToBytes32(SPL_TOKEN_PROGRAM_ID);

/// SPL Token instruction tag for `TransferChecked`.
/// Layout: u8(12) || u64le(amount) || u8(decimals).
export const TRANSFER_CHECKED_TAG = 12;

// ─────────────────────────────────────────────────────────────────────
// Encoding helpers — local to keep this file self-contained.
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

function toU8(v: number): Hex {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) {
    throw new Error(`u8 out of range: ${v}`);
  }
  return ('0x' + v.toString(16).padStart(2, '0')) as Hex;
}

// ─────────────────────────────────────────────────────────────────────
// TransferChecked invoke builder
//
// IDL:
//   1. source_ata           (writable)  — sender's ATA for the mint
//   2. mint                 (readonly)
//   3. destination_ata      (writable)  — recipient's ATA for the mint
//   4. owner                (signer, readonly) — owner of source ATA
//                                          (user's Rome PDA in our case)
//
// data = u8(12) || u64le(amount) || u8(decimals)
//
// Token-2022 mints with transfer hooks would require additional
// `remaining_accounts` resolved per the hook program. v1 doesn't
// support transfer-hook mints — surface a friendly error if the mint
// has hooks enabled.
// ─────────────────────────────────────────────────────────────────────

export type SplTransferInvoke = {
  program: Hex;
  accounts: AccountMeta[];
  data: Hex;
  /// Echoed for the preview panel.
  addresses: { sender: Hex; sourceAta: Hex; destAta: Hex };
};

/// Build a TransferChecked CPI from the user's PDA-owned ATA to a
/// recipient's ATA on Solana.
///
/// The recipient is identified by their Solana wallet bs58 (passed as
/// `recipientHex`). The recipient's ATA is derived deterministically
/// (PDA(`[recipientWallet, TOKEN_PROGRAM, mint]`, ATA_PROGRAM)). The
/// caller is responsible for pre-flighting that the ATA exists — if it
/// doesn't, the CPI reverts.
export function buildSplTransferInvoke(args: {
  userEvmAddress: Address;
  /// Recipient's Solana wallet pubkey as bytes32 hex.
  recipientWalletHex: Hex;
  /// SPL mint pubkey as bytes32 hex.
  mintHex: Hex;
  /// Mint decimals — TransferChecked validates this against the mint
  /// account on chain. Caller resolves it (e.g. via the
  /// ROME_STATIC_TOKENS registry).
  decimals: number;
  /// Amount in mint smallest units (caller multiplies UI amount by
  /// 10^decimals).
  amount: bigint;
  /// Token program id. Defaults to SPL Token classic. For Token-2022
  /// mints, caller must pass the T22 program id.
  tokenProgramHex?: Hex;
}): SplTransferInvoke {
  const sender = deriveRomeUserPda(args.userEvmAddress);
  const tokenProgram = args.tokenProgramHex ?? SPL_TOKEN_PROGRAM_HEX;

  const sourceAta = deriveAta(sender, args.mintHex);
  // Recipient ATA derivation. Per @solana/spl-token spec, ATA derivation
  // always seeds with the SPL Token classic program id, even for
  // Token-2022 mints — the *resulting* ATA is owned by the relevant
  // token program but the address is derived from the classic seed.
  const destAta = deriveAta(args.recipientWalletHex, args.mintHex);

  const accounts: AccountMeta[] = [
    { pubkey: sourceAta, is_signer: false, is_writable: true },
    { pubkey: args.mintHex, is_signer: false, is_writable: false },
    { pubkey: destAta, is_signer: false, is_writable: true },
    { pubkey: sender, is_signer: true, is_writable: false }, // Rome PDA, auto-signed
  ];

  const data = concat([toU8(TRANSFER_CHECKED_TAG), toU64Le(args.amount), toU8(args.decimals)]);

  return { program: tokenProgram, accounts, data, addresses: { sender, sourceAta, destAta } };
}

void PublicKey; // (re-exported / used by ATA derivation transitively)
