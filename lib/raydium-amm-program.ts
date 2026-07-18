// Raydium AMM v4 (legacy hand-rolled AMM, not Anchor) program constants.
//
// **Source of truth**: github.com/raydium-io/raydium-amm
// (`program/src/state.rs`, `program/src/instruction.rs`).
//
// AMM v4 ≠ CPMM. CPMM is Anchor (8-byte sha256 disc, IDL-driven).
// AMM v4 is hand-rolled — single-byte u8 instruction tags, custom
// `repr(C, packed)` AmmInfo struct (no disc; size is the only filter
// for `getProgramAccounts`).
//
// Devnet bootstrap state (verified live 2026-04-26 — see PR body):
//   - mainnet program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
//     is NOT executable on devnet (System-owned, 0-byte data).
//     Direct invocations error with InvalidProgramForExecution.
//   - devnet redeploy at HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8
//     IS executable (BPFLoaderUpgradeable owner). Recent successful
//     `swap_base_in` invocations on the seeded WSOL/USDC pool at
//     8Mwd2xFBRNDGXPiGPx79e1xkWqJaUoQoGhx8vavZcfsQ — `ray_log` emitted,
//     ~28k CU consumed. So we ship against the devnet redeploy.
// ─────────────────────────────────────────────────────────────────────

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program id (from @rome-protocol/registry).
//
// Devnet ≠ mainnet. Mainnet AMM v4 is `675kPX9MH…` (NOT executable on
// devnet). Devnet redeploy at `HWy1jot…` is the active deployment.
// ─────────────────────────────────────────────────────────────────────

export const RAYDIUM_AMM_V4_PROGRAM_BS58 = solanaProgramId(
  'raydiumAmmV4',
  'devnet',
);

export const RAYDIUM_AMM_V4_PROGRAM: Hex = pubkeyBs58ToBytes32(
  RAYDIUM_AMM_V4_PROGRAM_BS58,
);

// ─────────────────────────────────────────────────────────────────────
// Instruction tags (u8) — NOT Anchor disc.
//
// Source: github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs
//   pub enum AmmInstruction {
//     Initialize2 = 1,                     // (and others 0..8)
//     SwapBaseIn = 9,
//     PreInitialize = 10,
//     SwapBaseOut = 11,
//     SimulateInfo = 12,
//     ...
//   }
//
// Verified empirically by decoding inner ix data of a real successful
// swap on devnet (sig 512rcyahXgnLW4qfzgjkR3q1PK7Kff2tUTAaoqp8T47o…):
//   data hex = 0940420f0000000000 0100000000000000
//             ^^                  ^^^^^^^^^^^^^^^^
//             tag=9               minimum_amount_out u64 LE
//                ^^^^^^^^^^^^^^^^
//                amount_in u64 LE = 1_000_000
// ─────────────────────────────────────────────────────────────────────

/// `swap_base_in` ix tag. Single-byte u8. Followed by:
///   amount_in:           u64 LE
///   minimum_amount_out:  u64 LE   ← slippage guard
/// Total ix data = 1 + 8 + 8 = 17 bytes.
export const SWAP_BASE_IN_TAG = 0x09;

/// `swap_base_out` ix tag — receive an exact `amount_out`, supply at-most
/// `max_amount_in`. We ship `swap_base_in` first; this is published for
/// future symmetry.
export const SWAP_BASE_OUT_TAG = 0x0b;

// ─────────────────────────────────────────────────────────────────────
// PDA seeds
//
// authority: PDA(["amm authority"], program). Single global PDA across
// the whole program. Owns the LP mint and signs vault-out transfers.
// (Raydium hardcodes the seed string as ASCII bytes "amm authority".)
//
// Verified by deriving with bump=255 (see raydium-amm-pdas.ts).
// ─────────────────────────────────────────────────────────────────────

export const AMM_AUTHORITY_SEED = Buffer.from('amm authority');

// ─────────────────────────────────────────────────────────────────────
// Pool account
// ─────────────────────────────────────────────────────────────────────

/// On-chain size of an AmmInfo account (bytes), per the
/// `repr(C, packed)` struct in raydium-amm/program/src/state.rs.
/// Live devnet pools report exactly 752.
///
/// Layout breakdown:
///   16 status u64 fields    = 128
///   Fees (8 u64)            =  64
///   StateData               = 144  (4×u64 + u64 pool_open_time + 2×u64 pad
///                                   + u64 + 2×u128 + u64 + 2×u128 + u64)
///   coin_vault Pubkey       =  32
///   pc_vault Pubkey         =  32
///   coin_vault_mint Pubkey  =  32
///   pc_vault_mint Pubkey    =  32
///   lp_mint Pubkey          =  32
///   open_orders Pubkey      =  32
///   market Pubkey           =  32
///   market_program Pubkey   =  32
///   target_orders Pubkey    =  32
///   padding1 [u64; 8]       =  64
///   amm_owner Pubkey        =  32
///   lp_amount u64           =   8
///   client_order_id u64     =   8
///   recent_epoch u64        =   8
///   padding2 u64            =   8
///   ─────────────────────────  ─
///                              752
export const AMM_INFO_SIZE = 752;

// ─────────────────────────────────────────────────────────────────────
// AmmStatus enum values from state.rs.
// ─────────────────────────────────────────────────────────────────────

export const AMM_STATUS_UNINITIALIZED = 0;
export const AMM_STATUS_INITIALIZED = 1;
export const AMM_STATUS_DISABLED = 2;
export const AMM_STATUS_WITHDRAW_ONLY = 3;
export const AMM_STATUS_LIQUIDITY_ONLY = 4;
export const AMM_STATUS_ORDER_BOOK_ONLY = 5;
export const AMM_STATUS_SWAP_ONLY = 6;
export const AMM_STATUS_WAITING_TRADE = 7;

// ─────────────────────────────────────────────────────────────────────
// CU budget (empirical, from a real devnet swap_base_in invocation —
// 28_238 CU consumed in tx 512rcyahXgnLW…). Add ~50% headroom for
// market state divergence; bump if signed-tx smoke shows we're tight.
// ─────────────────────────────────────────────────────────────────────

export const CU_RAYDIUM_AMM_V4_SWAP = 60_000n;
