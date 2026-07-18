// Raydium CLMM (Concentrated Liquidity Market Maker) program constants
// for the Cardo `/swap-raydium-clmm` integration.
//
// **Source of truth**: github.com/raydium-io/raydium-clmm
// (`programs/amm/src/states/pool.rs`, `instructions/swap_v2.rs`).
// Discriminators are sha256("global:<method>")[..8] (Anchor 0.x).
//
// Devnet bootstrap state (verified live 2026-04-26):
//   - Program devi51mZ…             executable=true ✓
//   - 7,852 PoolState accounts on devnet
//   - 2,064 alive WSOL-anything pools (liquidity > 0, status = 0)
//   - 1,132 alive WSOL pools where the current tick IS covered by an
//     initialized tick-array bitmap entry (the dead-zone filter)
//   - Sole WSOL/USDC-devnet pool with current-tick covered by inline
//     bitmap: HXAQnU2fJzMDHn3VK9m968AxvQhuiGxpcuVJjum1k7XW
//     (tick=50108, liquidity=4_000_000, fee=5 bps, vault0=1488 lamports
//      WSOL, vault1=265_912 USDC u-units i.e. 0.265 USDC). Thin pool.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3 — Raydium CLMM, A1 → A0 promotion: program already on devnet,
// reuse maintained pools rather than auto-clone).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

// ─────────────────────────────────────────────────────────────────────
// Program id (from @rome-protocol/registry).
//
// Devnet ≠ mainnet. Mainnet is `CAMMCzo5…`, devnet uses Raydium's
// devnet redeploy `devi51m…` — both tracked in registry.
// ─────────────────────────────────────────────────────────────────────

export const RAYDIUM_CLMM_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('raydiumClmm', 'devnet'),
);

// ─────────────────────────────────────────────────────────────────────
// Anchor instruction discriminators
//
// Computed: sha256("global:<method>")[..8].
//   swap                 = [248, 198, 158, 145, 225, 117, 135, 200]
//   swap_v2              = [ 43,   4, 237,  11,  26, 201,  30,  98]
//   swap_router_base_in  = [ 69, 125, 115, 218, 245, 186, 242, 196]
//
// We ship `swap_v2` — newer/canonical, supports Token-2022 + memo, and
// matches recent successful devnet activity (verified by decoding sig
// hWTtod… 2026-04-26: program=devi51m, disc=0x2b04ed0b1ac91e62).
// ─────────────────────────────────────────────────────────────────────

/// `swap_v2(amount_in: u64, other_amount_threshold: u64, sqrt_price_limit_x64: u128, is_base_input: bool)`.
/// 33 bytes after the 8-byte disc.
export const SWAP_V2_DISC: Hex = '0x2b04ed0b1ac91e62';

/// Older `swap` ix — published for completeness; we don't ship this.
export const SWAP_DISC: Hex = '0xf8c69e91e17587c8';

// ─────────────────────────────────────────────────────────────────────
// PDA seeds
// ─────────────────────────────────────────────────────────────────────

/// Tick-array PDA seed.
/// PDA(["tick_array", pool, start_tick_index_i32_BE], program).
/// Note: start_tick_index is i32 BIG-endian (Raydium quirk; CPMM uses
/// LE elsewhere — classic gotcha).
export const TICK_ARRAY_SEED = Buffer.from('tick_array');

/// Tick-array bitmap extension PDA seed.
/// PDA(["pool_tick_array_bitmap_extension", pool], program).
export const POOL_TICK_ARRAY_BITMAP_SEED = Buffer.from(
  'pool_tick_array_bitmap_extension',
);

// ─────────────────────────────────────────────────────────────────────
// Account discriminators
// ─────────────────────────────────────────────────────────────────────

/// IDL discriminator for `PoolState`.
///   sha256("account:PoolState")[..8] = [247,237,227,245,215,195,222,70]
/// Same bytes as CPMM's PoolState — different layout though. Don't share decoders.
export const POOL_DISC: number[] = [247, 237, 227, 245, 215, 195, 222, 70];

/// IDL discriminator for `AmmConfig`.
///   sha256("account:AmmConfig")[..8] = [218, 244, 33, 104, 203, 203, 43, 111]
export const AMM_CONFIG_DISC: number[] = [218, 244, 33, 104, 203, 203, 43, 111];

/// IDL discriminator for `TickArrayState` (Anchor account name on CLMM).
///   sha256("account:TickArrayState")[..8] = [192, 155, 85, 205, 49, 249, 129, 42]
export const TICK_ARRAY_STATE_DISC: number[] = [
  192, 155, 85, 205, 49, 249, 129, 42,
];

/// IDL discriminator for `TickArrayBitmapExtension`.
///   sha256("account:TickArrayBitmapExtension")[..8] = [60, 150, 36, 219, 97, 128, 139, 153]
export const TICK_ARRAY_BITMAP_EXT_DISC: number[] = [
  60, 150, 36, 219, 97, 128, 139, 153,
];

/// On-chain size of a CLMM PoolState account (bytes), per the IDL layout.
/// Live devnet pools all report 1544.
export const POOL_SIZE = 1544;

// ─────────────────────────────────────────────────────────────────────
// CLMM tick-array sizing — load-bearing for tick-array PDA derivation.
//
// One TickArrayState covers `TICK_ARRAY_SIZE_TICKS = tick_spacing * 60`
// raw ticks.
// ─────────────────────────────────────────────────────────────────────

export const TICK_ARRAY_SIZE_TICKS_PER_SPACING = 60;

/// Inline tick-array bitmap covers ±512 array slots from tick 0
/// (= 1024 bits = `[u64; 16]`). Per array slot covers `tick_spacing * 60`
/// ticks, so the inline bitmap reaches ±tick_spacing * 60 * 512 ticks.
/// Beyond that range, the `TickArrayBitmapExtension` account picks up.
export const TICK_ARRAY_BITMAP_SIZE = 512;

// ─────────────────────────────────────────────────────────────────────
// CU budget
//
// Empirical: a CLMM swap_v2 single-tick-array swap typically reports
// 80–150k CU on mainnet. We don't have a recent successful swap_v2 on
// devnet to measure (the program's recent traffic on the chosen pool
// is `ReadRayPoolPrice` from a Rome-internal canonicalisation program,
// not actual swaps). Set a conservative ceiling.
// ─────────────────────────────────────────────────────────────────────

export const CU_RAYDIUM_CLMM_SWAP = 200_000n;

// Sentinel: passing `sqrt_price_limit_x64 = 0` to swap_v2 disables the
// price-limit guard (the program internally clamps to MIN/MAX
// SQRT_PRICE_X64). Slippage is enforced via `other_amount_threshold`
// instead — that's our `minimum_amount_out` knob in the UI.
export const SQRT_PRICE_LIMIT_NONE = 0n;
