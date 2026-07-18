// Meteora DLMM (Dynamic Liquidity Market Maker) program constants
// for the Cardo `/swap-dlmm` integration.
//
// **Source of truth**: github.com/MeteoraAg/dlmm-sdk (idls/dlmm.json,
// version 0.10.1, fetched 2026-04-26). Discriminators and account
// layouts come straight from the IDL — no guessing.
//
// Devnet bootstrap state (verified live 2026-04-26):
//   - Program LBUZKhRx…       executable=true ✓ (BPF Loader Upgradeable)
//   - 7,455 LbPair accounts on devnet involve WSOL on either side
//     (641 token_x = WSOL, 6814 token_y = WSOL)
//   - 3 alive WSOL/USDC-devnet pools where status = 0, both reserves > 0,
//     AND active bin's bin_array_index is covered by inline bitmap
//   - The chosen seed pool is `3xoczq45qQL5e2vsq1c8LeyoRqxJBggnF3tMZUvHE68Y`
//     (token_x = USDC-devnet, token_y = WSOL, bin_step=10, active_id=2115,
//     bin_array_index = 30, base_factor=10_000, base_fee_power_factor=2
//     → base_fee_rate = 100_000_000 ppb = 10% — yes really, devnet
//     pools tend to have inflated fees).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (line 246 + line 500: Family 11 — Meteora DLMM with multi-bin swap.
//  Track A gated for large trades, but small swaps that don't cross bin
//  array boundaries fit today.)

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program id (from @rome-protocol/registry)
//
// DLMM is the same program on devnet and mainnet — Meteora deploys
// from the same binary to both.
// ─────────────────────────────────────────────────────────────────────

export const DLMM_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('meteoraDlmm', 'devnet'),
);

// ─────────────────────────────────────────────────────────────────────
// Anchor instruction discriminators
//
// Pulled directly from idls/dlmm.json (Meteora's published IDL):
//   swap                       = [248, 198, 158, 145, 225, 117, 135, 200]
//   swap2                      = [ 65,  75,  63,  76, 235,  91,  91, 136]
//   swap_exact_out             = [250,  73, 101,  33,  38, 207,  75, 184]
//   swap_with_price_impact     = [ 56, 173, 230, 208, 173, 228, 156, 205]
//
// We ship `swap` — the simplest exact-input form (amount_in, min_amount_out).
// `swap2` adds Token-2022 + memo + remaining-accounts-info; we don't need
// either for the WSOL/USDC-devnet pool (both sides are classic SPL Token,
// program flags = 0,0).
// ─────────────────────────────────────────────────────────────────────

/// `swap(amount_in: u64, min_amount_out: u64)`. 16 bytes after the disc.
export const SWAP_DISC: Hex = '0xf8c69e91e17587c8';

/// `swap2(amount_in: u64, min_amount_out: u64, remaining_accounts_info: ...)`.
/// Published for completeness; `swap_exact_in_v2` style. Not shipped in v1.
export const SWAP2_DISC: Hex = '0x414b3f4ceb5b5b88';

// ─────────────────────────────────────────────────────────────────────
// Account discriminators
// ─────────────────────────────────────────────────────────────────────

/// IDL discriminator for `LbPair`.
///   sha256("account:LbPair")[..8] = [33, 11, 49, 98, 181, 101, 177, 13]
export const LB_PAIR_DISC: number[] = [33, 11, 49, 98, 181, 101, 177, 13];

/// IDL discriminator for `BinArray`.
///   sha256("account:BinArray")[..8] = [92, 142, 92, 220, 5, 148, 70, 181]
export const BIN_ARRAY_DISC: number[] = [92, 142, 92, 220, 5, 148, 70, 181];

/// IDL discriminator for `BinArrayBitmapExtension`.
export const BIN_ARRAY_BITMAP_EXT_DISC: number[] = [
  80, 111, 124, 113, 55, 237, 18, 5,
];

/// IDL discriminator for `Oracle`.
export const ORACLE_DISC: number[] = [139, 194, 131, 179, 140, 179, 229, 244];

/// On-chain size of an LbPair (verified against
/// `3xoczq45qQL5e2vsq1c8LeyoRqxJBggnF3tMZUvHE68Y` on 2026-04-26).
export const LB_PAIR_SIZE = 904;

/// On-chain size of a BinArray. From the IDL:
///   8 disc + 8 index + 1 version + 7 padding + 32 lb_pair + 70 * 88 (Bin) = 6216
/// But the on-chain account is allocated 10136 — Anchor includes some
/// extra reserved space. Verified by reading idx=30 of pool 3xoczq45 on
/// 2026-04-26: space=10136. We don't decode bins for the v1 quote; UI
/// uses the bin_step formula instead.
export const BIN_ARRAY_SIZE = 10136;

// ─────────────────────────────────────────────────────────────────────
// PDA seeds (load-bearing — match Meteora's program source verbatim)
// ─────────────────────────────────────────────────────────────────────

/// BinArray PDA seed.
/// PDA(["bin_array", lb_pair, bin_array_index_le_i64], program).
/// `bin_array_index` is encoded as i64 LITTLE-endian (8 bytes signed).
export const BIN_ARRAY_SEED = Buffer.from('bin_array');

/// BinArrayBitmapExtension PDA seed.
/// PDA(["bin_array_bitmap_extension", lb_pair], program).
/// One per pool. Optional in `swap` ix — we omit it when the pool's
/// active bin sits within the inline bitmap (bin_array_index ∈ [-512, 512)).
export const BIN_ARRAY_BITMAP_EXT_SEED = Buffer.from(
  'bin_array_bitmap_extension',
);

/// Anchor's standard event-authority seed.
/// PDA(["__event_authority"], program).
/// Pinned for the seeded pool: D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6.
export const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

// ─────────────────────────────────────────────────────────────────────
// DLMM bin geometry
//
// One BinArray covers exactly 70 contiguous bins:
//   bin_array_index = floor(active_id / 70)   (rounding toward -inf)
//
// The inline bitmap on LbPair covers bin_array_index ∈ [-512, 512)
// (= 1024 bits = [u64; 16]). Beyond that the BinArrayBitmapExtension
// account picks up. For our seeded pool active_id=2115 → bin_array_index
// = 30, well inside the inline bitmap.
// ─────────────────────────────────────────────────────────────────────

export const BINS_PER_ARRAY = 70;
export const INLINE_BITMAP_HALF_RANGE = 512;

// ─────────────────────────────────────────────────────────────────────
// Fee math (Meteora docs: `base_fee_rate_ppb = base_factor * bin_step *
// 10 * 10^base_fee_power_factor`).
//
// Result is in parts-per-billion (1e9 denominator). The `swap` ix
// internally extracts the fee from `amount_in` BEFORE the bin-traversal
// step; we mirror that in the UI quote for honest output.
//
// Total fee = base_fee_rate + variable_fee (which depends on volatility
// state). For an indicative single-step quote at the active bin's
// price, we ignore variable_fee (it's volatility-driven, often zero
// when the pool is idle).
// ─────────────────────────────────────────────────────────────────────

/// Fee denominator for ppb (parts-per-billion).
export const FEE_DENOMINATOR_PPB = 1_000_000_000n;

// ─────────────────────────────────────────────────────────────────────
// CU budget
//
// DLMM single-bin-array swap on mainnet: empirical 100–180k CU.
// With Rome CPI overhead (~50k frame), set a conservative ceiling that
// fits a single Cardo CPI invoke from within a Rome EVM tx. Bump if
// we observe ComputeBudgetExceeded in smoke.
// ─────────────────────────────────────────────────────────────────────

export const CU_DLMM_SWAP = 220_000n;
