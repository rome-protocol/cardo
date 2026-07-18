// Streamflow timelock program constants for the Cardo /pay integration.
//
// **Source of truth**: github.com/streamflow-finance/js-sdk and
// github.com/streamflow-finance/rust-sdk — Anchor IDL spec 0.1.0,
// program version 0.4.0.
//
// All discriminators below are sha256("global:<method>")[..8]; verified
// in Sprint 1 continued research (2026-04-25).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 8, Phase A — Sprint 1 continued).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program ids (from @rome-protocol/registry) — **different per network**.
// Rome bridges to Solana devnet (per `lib/addresses.ts` + memory note
// `Rome's Solana bridge target`). Use the devnet program until
// mainnet bridges land.
// ─────────────────────────────────────────────────────────────────────

export const STREAMFLOW_PROGRAM_DEVNET: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('streamflow', 'devnet'),
);

export const STREAMFLOW_PROGRAM_MAINNET: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('streamflow', 'mainnet'),
);

/// Active program id — flips when Rome mainnet bridges ship.
export const STREAMFLOW_PROGRAM: Hex = STREAMFLOW_PROGRAM_DEVNET;

// ─────────────────────────────────────────────────────────────────────
// Anchor discriminators
// ─────────────────────────────────────────────────────────────────────

/// `create_v2` — PDA-metadata variant; recommended for Rome CPI since
/// it doesn't need an ephemeral signer keypair.
export const CREATE_V2_DISC: Hex = '0xd6904cec5f8b31b4';

/// `withdraw` — recipient pulls vested tokens.
export const WITHDRAW_DISC: Hex = '0xb712469c946da122';

/// `cancel` — sender (or recipient, if allowed) closes the stream early.
export const CANCEL_DISC: Hex = '0xe8dbdf29dbecdcbe';

/// `topup` — add tokens to an open stream.
export const TOPUP_DISC: Hex = '0x7e2a314ee197634d';

/// `update` — modify automatic_withdrawal flag + rate fields. Verified
/// `sha256("global:update")[..8]`.
export const UPDATE_DISC: Hex = '0xdbc858b09e3ffd7f';

/// `transfer_recipient` — reassign stream recipient. Verified
/// `sha256("global:transfer_recipient")[..8]`.
export const TRANSFER_RECIPIENT_DISC: Hex = '0xebf6e04069a6148a';

// ─────────────────────────────────────────────────────────────────────
// Hardcoded protocol pubkeys (mainnet + devnet)
// Source: js-sdk/packages/stream/solana/constants.ts:34-65
// ─────────────────────────────────────────────────────────────────────

/// Streamflow treasury authority — receives the 0.19% token fee.
/// Same on devnet + mainnet.
export const STREAMFLOW_TREASURY: Hex = pubkeyBs58ToBytes32(
  '5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw',
);

/// Streamflow auto-withdraw cranker — receives a small delegate fee.
/// Same on devnet + mainnet.
export const STREAMFLOW_WITHDRAWOR: Hex = pubkeyBs58ToBytes32(
  'wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u',
);

/// Fee oracle — devnet variant.
export const STREAMFLOW_FEE_ORACLE_DEVNET: Hex = pubkeyBs58ToBytes32(
  'Aa2JJfFzUN3V54DXUHRBJowFw416xfZHpPk9DaNy3iYs',
);

/// Fee oracle — mainnet variant. (Not used today; flipped with program.)
export const STREAMFLOW_FEE_ORACLE_MAINNET: Hex = pubkeyBs58ToBytes32(
  'B743wFVk2pCYhV91cn287e1xY7f1vt4gdY48hhNiuQmT',
);

/// Active fee oracle — flips with Rome mainnet bridges.
export const STREAMFLOW_FEE_ORACLE: Hex = STREAMFLOW_FEE_ORACLE_DEVNET;

// ─────────────────────────────────────────────────────────────────────
// PDA seeds (per rust-sdk/programs/streamflow-sdk/src/state.rs)
// ─────────────────────────────────────────────────────────────────────

/// Metadata PDA seed prefix.
export const STRM_MET_SEED = Buffer.from('strm-met');

/// Escrow tokens PDA seed prefix.
export const STRM_SEED = Buffer.from('strm');

// ─────────────────────────────────────────────────────────────────────
// Protocol fees (surface in UI before user signs — per CLAUDE.md
// "don't hide conversion costs" rule)
// ─────────────────────────────────────────────────────────────────────

/// Default Streamflow token fee, in basis points (0.19% = 19 bps).
export const STREAMFLOW_TOKEN_FEE_BPS = 19n;

/// Default SOL creation fee in lamports (~0.09 SOL).
export const STREAMFLOW_CREATION_FEE_LAMPORTS = 90_000_000n;

// ─────────────────────────────────────────────────────────────────────
// Automatic-withdrawal cadence.
//
// Enabling automatic withdrawal schedules ~ceil(duration / withdrawFrequency)
// crank withdrawals; the enable tx reverts `InsufficientFunds` once that count
// gets large. Measured on Hadrian → Streamflow devnet: enable SUCCEEDS at
// 10,080 (1-week @ 60s) and 43,200 (1-month @ 60s) scheduled withdrawals, and
// FAILS at 129,600 (3-month @ 60s). So the auto-withdrawal cadence must be
// COARSE and independent of the (60s) vesting period — a daily crank caps a
// 3-month stream at 90 scheduled withdrawals, far inside the proven-safe range.
export const AUTO_WITHDRAW_FREQUENCY_SECONDS = 86_400n; // daily
/// Conservative ceiling for scheduled auto-withdrawals (well under the
/// observed 129,600 failure point; ~2× under the 43,200 last-known-good).
export const SAFE_MAX_SCHEDULED_WITHDRAWALS = 20_000n;

/// Scheduled auto-withdrawal count for a stream of `durationSeconds` at
/// `frequencySeconds` cadence — the quantity that must stay under
/// `SAFE_MAX_SCHEDULED_WITHDRAWALS` for the enable tx to land.
export function scheduledWithdrawals(
  durationSeconds: bigint,
  frequencySeconds: bigint = AUTO_WITHDRAW_FREQUENCY_SECONDS,
): bigint {
  if (frequencySeconds <= 0n) return 0n;
  return (durationSeconds + frequencySeconds - 1n) / frequencySeconds; // ceil
}

// ─────────────────────────────────────────────────────────────────────
// CU budget — empirical estimate; create_v2 with 18 accounts is at the
// upper end of what fits inside Rome's atomic DoTx envelope. If it
// reverts on CU, fall back to create_unchecked_v2 with caller-side
// ATA pre-creation (per Streamflow research notes).
// ─────────────────────────────────────────────────────────────────────

export const CU_CREATE_V2 = 250_000n;
export const CU_WITHDRAW = 80_000n;
