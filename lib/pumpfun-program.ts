// Pump.fun bonding-curve program constants for the Cardo
// `/swap-pumpfun` integration (memecoin lifecycle, pre-graduation
// half — the post-graduation AMM half lives in `lib/pumpswap-*`).
//
// **Source of truth**: github.com/pump-fun/pump-public-docs (idl/pump.json).
// Anchor 0.x — discriminators are sha256("global:<rust_snake_case_name>")[..8].
//
// Devnet bootstrap state (verified 2026-04-25):
//   - Pump.fun (6EF8rrec…)              executable=true ✓
//   - Pump.fun fee_program (pfeeUxB6…)  executable=true ✓ (shared with PumpSwap)
//   - Global PDA (4wTV1YmiE…)           space=1005, admin GUYCUEpx…,
//                                       fee_recipient 68yFSZxz… ✓
//   - event_authority PDA (Ce6TQqeH…)   exists ✓
//   - fee_config PDA (8Wf5TiAh…)        space=2512 ✓
//   - 77,228 BondingCurve accounts on devnet — plenty of testable
//     state. Discriminator (bs58) `4y6pru6YvC7`.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 / A6 — memecoin lifecycle).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program ids (from @rome-protocol/registry)
// ─────────────────────────────────────────────────────────────────────

/// Pump.fun bonding-curve program. Same id on devnet + mainnet.
export const PUMP_FUN_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('pumpFun', 'devnet'),
);

/// Shared fee program (also used by PumpSwap AMM). The `fee_config`
/// PDA below is derived under THIS program, not under Pump.fun.
export const PUMP_FUN_FEE_PROGRAM: Hex = pubkeyBs58ToBytes32(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
);

// ─────────────────────────────────────────────────────────────────────
// Singleton accounts (PDAs pre-derived; pinned to skip a hash at runtime)
// ─────────────────────────────────────────────────────────────────────

/// PDA(["global"], PUMP_FUN_PROGRAM). Holds protocol config + fee
/// recipient. Verified live on devnet.
export const PUMP_FUN_GLOBAL: Hex = pubkeyBs58ToBytes32(
  '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
);

/// PDA(["__event_authority"], PUMP_FUN_PROGRAM).
export const PUMP_FUN_EVENT_AUTHORITY: Hex = pubkeyBs58ToBytes32(
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
);

/// PDA(["global_volume_accumulator"], PUMP_FUN_PROGRAM).
export const PUMP_FUN_GLOBAL_VOLUME_ACCUMULATOR: Hex = pubkeyBs58ToBytes32(
  'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y',
);

/// PDA(["fee_config", <literal pubkey>], PUMP_FUN_FEE_PROGRAM).
/// The 32-byte seed is fixed in the IDL (different per-program; this
/// is Pump.fun's, not PumpSwap's).
export const PUMP_FUN_FEE_CONFIG: Hex = pubkeyBs58ToBytes32(
  '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt',
);

/// `Global.fee_recipient` (decoded from on-chain Global at offset 41).
/// This is the SOL-receiving wallet for protocol fees.
export const PUMP_FUN_FEE_RECIPIENT: Hex = pubkeyBs58ToBytes32(
  '68yFSZxzLWJXkxxRGydZ63C6mHx1NLEDWmwN9Lb5yySg',
);

// ─────────────────────────────────────────────────────────────────────
// Anchor instruction discriminators
// ─────────────────────────────────────────────────────────────────────

/// `buy(amount: u64, max_sol_cost: u64, track_volume: Option<bool>)`
/// — user spends native SOL, receives memecoin into their ATA.
/// 16 accounts. Same disc as PumpSwap's `buy` (Anchor hashes the rust
/// fn name; both programs name their fn `buy`).
export const BUY_DISC: Hex = '0x66063d1201daebea';

/// `sell(amount: u64, min_sol_output: u64)` — 14 accounts. User burns
/// memecoin, receives SOL.
export const SELL_DISC: Hex = '0x33e685a4017f83ad';

// ─────────────────────────────────────────────────────────────────────
// PDA seeds
// ─────────────────────────────────────────────────────────────────────

export const BONDING_CURVE_SEED = Buffer.from('bonding-curve');
export const CREATOR_VAULT_SEED = Buffer.from('creator-vault');
export const USER_VOLUME_ACCUMULATOR_SEED = Buffer.from(
  'user_volume_accumulator',
);

// ─────────────────────────────────────────────────────────────────────
// BondingCurve account
// ─────────────────────────────────────────────────────────────────────

/// IDL discriminator for the `BondingCurve` account
/// (sha256("account:BondingCurve")[..8]).
/// bs58 = `4y6pru6YvC7` for memcmp filters.
export const BONDING_CURVE_DISC: number[] = [23, 183, 248, 55, 96, 216, 172, 96];

/// Field offsets in the BondingCurve account (after the 8-byte
/// Anchor discriminator).
///   8..16  virtual_token_reserves (u64 LE)
///   16..24 virtual_sol_reserves   (u64 LE)
///   24..32 real_token_reserves    (u64 LE)
///   32..40 real_sol_reserves      (u64 LE)
///   40..48 token_total_supply     (u64 LE)
///   48     complete               (u8 bool)
///   49..81 creator                (32-byte pubkey)  ← needed for the
///                                                     creator_vault PDA
export const BONDING_CURVE_FIELD_OFFSETS = {
  virtualTokenReserves: 8,
  virtualSolReserves: 16,
  realTokenReserves: 24,
  realSolReserves: 32,
  tokenTotalSupply: 40,
  complete: 48,
  creator: 49,
} as const;

// ─────────────────────────────────────────────────────────────────────
// CU budget — Pump.fun buy is 16 accounts + lamport transfer + ATA
// init/touch + volume accumulator updates. 250K is conservative.
// ─────────────────────────────────────────────────────────────────────

export const CU_PUMP_FUN_BUY = 250_000n;
export const CU_PUMP_FUN_SELL = 220_000n;
