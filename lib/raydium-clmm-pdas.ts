// Raydium CLMM PDA derivations.
//
// CLMM is per-pool (no global authority PDA like CPMM has). The two PDAs
// we care about for swap_v2 are:
//
//   - tick-array bitmap extension: PDA(["pool_tick_array_bitmap_extension",
//     pool], program). Always passed as remaining_account[0].
//
//   - tick-array state: PDA(["tick_array", pool, start_tick_index_i32_BE],
//     program). One per 60-tick "array slot" the swap might cross. Pass
//     as remaining_accounts[1..].
//
// The start_tick_index is encoded as i32 BIG-endian — a Raydium quirk
// the CPMM repo doesn't share. Verified against pool 6JjEnNQ live state
// on 2026-04-26: bitmap bits 358 and 396 → start indices -92400 and
// -69600 → PDAs 793kqZzX… and 9A9zvrsQ… (both confirmed exist on devnet
// with disc 0xc09b55cd31f9812a = sha256("account:TickArrayState")[..8]).
// And HXAQnU2 bitmap bit 595 → start 49800 → PDA F2BA97f… (live disc
// matches).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import {
  POOL_TICK_ARRAY_BITMAP_SEED,
  RAYDIUM_CLMM_PROGRAM,
  TICK_ARRAY_SEED,
  TICK_ARRAY_SIZE_TICKS_PER_SPACING,
} from './raydium-clmm-program';

const PROGRAM_KEY: PublicKey = bytes32ToPublicKey(RAYDIUM_CLMM_PROGRAM);

// ─────────────────────────────────────────────────────────────────────
// tick-array bitmap extension — one per pool.
// ─────────────────────────────────────────────────────────────────────

export function deriveTickArrayBitmapExtension(poolBs58: string): Hex {
  const pool = new PublicKey(poolBs58);
  const [pda] = PublicKey.findProgramAddressSync(
    [POOL_TICK_ARRAY_BITMAP_SEED, pool.toBytes()],
    PROGRAM_KEY,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// tick-array PDAs — one per array slot the swap may cross.
//
// `start_tick_index` is a multiple of `tick_spacing * 60`, encoded as
// i32 BIG-endian.
// ─────────────────────────────────────────────────────────────────────

export function deriveTickArray(
  poolBs58: string,
  startTickIndex: number,
): Hex {
  const pool = new PublicKey(poolBs58);
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(startTickIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [TICK_ARRAY_SEED, pool.toBytes(), buf],
    PROGRAM_KEY,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// Tick-array math.
//
// Round tick_current toward NEGATIVE infinity (not toward zero) when
// computing the tick-array bucket. This matches Raydium CLMM's
// `tick_array_start_index_to_tick_index_lower` math:
//
//   let q = tick_current / (tick_spacing * 60);     // truncated toward zero
//   if tick_current < 0 && tick_current % (tick_spacing * 60) != 0 { q -= 1 }
//   start = q * (tick_spacing * 60)
// ─────────────────────────────────────────────────────────────────────

export function tickArrayStartIndex(
  tickCurrent: number,
  tickSpacing: number,
): number {
  const tpa = tickSpacing * TICK_ARRAY_SIZE_TICKS_PER_SPACING;
  let q = Math.trunc(tickCurrent / tpa);
  if (tickCurrent < 0 && tickCurrent % tpa !== 0) q -= 1;
  return q * tpa;
}

/// Compressed bit position in the inline pool bitmap for `tick_current`.
/// Matches Raydium's `check_current_tick_array_is_initialized` formula:
///   compressed = (tick_current / multiplier) + 512
///   if tick_current < 0 && tick_current % multiplier != 0 { compressed -= 1 }
/// where multiplier = tick_spacing * 60.
export function compressedBitPos(
  tickCurrent: number,
  tickSpacing: number,
): number {
  const mul = tickSpacing * TICK_ARRAY_SIZE_TICKS_PER_SPACING;
  let compressed = Math.trunc(tickCurrent / mul);
  if (tickCurrent < 0 && tickCurrent % mul !== 0) compressed -= 1;
  return compressed + 512;
}

/// Inverse of `compressedBitPos`: bit position → start_tick_index.
export function bitPosToStartIndex(
  bitPos: number,
  tickSpacing: number,
): number {
  return (bitPos - 512) * tickSpacing * TICK_ARRAY_SIZE_TICKS_PER_SPACING;
}
