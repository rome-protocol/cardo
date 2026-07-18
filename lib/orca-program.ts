// Orca Whirlpool program constants for the Cardo /swap-orca integration.
//
// **Source of truth**: github.com/orca-so/whirlpools (Anchor program).
// All discriminators below are sha256("global:<method>")[..8].
//
// Devnet: Whirlpool program is deployed at the canonical mainnet
// address `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` and has
// 13K+ pools including funded WSOL/USDC pools (no auto-clone needed).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 3, A1 → A0 promotion via existing devnet liquidity).

import type { Hex } from 'viem';
import { pubkeyBs58ToBytes32 } from './solana-pda';
import { solanaProgramId } from './solana-programs';

/// Orca Whirlpool program (from @rome-protocol/registry). Same address on devnet + mainnet.
export const WHIRLPOOL_PROGRAM: Hex = pubkeyBs58ToBytes32(
  solanaProgramId('orcaWhirlpool', 'devnet'),
);

/// Anchor disc for `swap` (the classic SPL Token variant).
/// sha256("global:swap")[..8] — verified.
export const SWAP_DISC: Hex = '0xf8c69e91e17587c8';

/// Anchor disc for `swap_v2` (Token-2022 variant; passes both token
/// programs explicitly). v1 ships SWAP only — v2 adds support if a
/// pool's mint is Token-2022.
export const SWAP_V2_DISC: Hex = '0x2b04ed0b1ac91e62';

// ─────────────────────────────────────────────────────────────────────
// Tick array constants
//
// Each tick array covers TICK_ARRAY_SIZE ticks at the pool's
// tick_spacing. A swap touches up to 3 consecutive arrays in the
// direction of the swap.
// ─────────────────────────────────────────────────────────────────────

export const TICK_ARRAY_SIZE = 88;

/// Seed prefix for tick_array PDA: `["tick_array", whirlpool, start_tick_str]`.
/// `start_tick_str` is the ASCII-encoded i32 start tick (e.g. b"-45848").
export const TICK_ARRAY_SEED = Buffer.from('tick_array');

/// Seed prefix for adaptive-fee oracle PDA: `["oracle", whirlpool]`.
export const ORACLE_SEED = Buffer.from('oracle');

// ─────────────────────────────────────────────────────────────────────
// CU budget (empirical estimate for a single-tick-array swap; large
// multi-bin crossings may exceed). Leave headroom for Rome's atomic
// envelope.
// ─────────────────────────────────────────────────────────────────────

export const CU_SWAP = 120_000n;
