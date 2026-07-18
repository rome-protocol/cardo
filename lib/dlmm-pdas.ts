// Meteora DLMM PDA derivations.
//
// DLMM is per-pool; the PDAs we care about for `swap` are:
//
//   - bin_array_bitmap_extension: PDA(["bin_array_bitmap_extension",
//     lb_pair], program). Optional in `swap`; we only pass it when the
//     pool's active bin_array_index sits OUTSIDE the inline bitmap
//     range (= |bai| >= 512). For the seeded pool 3xoczq45 (bai=30),
//     it's omitted (pass nothing as remaining_account[0] — actually
//     for `swap` it's an `optional` ix-account, not a remaining_account).
//
//   - bin_array: PDA(["bin_array", lb_pair, bin_array_index_le_i64],
//     program). One per 70-bin array slot the swap may traverse. Pass
//     these as remaining_accounts in traversal order (active first).
//
//   - oracle: stored on the LbPair as `oracle: Pubkey` at byte offset
//     552. Not derived — read from the pool struct.
//
//   - event_authority: PDA(["__event_authority"], program). Anchor-
//     standard. Pinned for the program: D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6
//     (verified on devnet 2026-04-26).
//
// `bin_array_index` is i64 LITTLE-endian (8 bytes), signed. Verified
// against pool 3xoczq45 on 2026-04-26: index 30 → PDA
// 8fezMmPSN9higvndJYspCu9NVUC5VtGbt9GdwBSJb9ro (live).

import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey, pubkeyToBytes32 } from './solana-pda';
import {
  BIN_ARRAY_BITMAP_EXT_SEED,
  BIN_ARRAY_SEED,
  BINS_PER_ARRAY,
  DLMM_PROGRAM,
  EVENT_AUTHORITY_SEED,
  INLINE_BITMAP_HALF_RANGE,
} from './dlmm-program';

const PROGRAM_KEY: PublicKey = bytes32ToPublicKey(DLMM_PROGRAM);

// ─────────────────────────────────────────────────────────────────────
// bin_array PDA — one per 70-bin array slot.
//
// Encoded as i64 LE (8 bytes signed). NOT i32 BE like Raydium CLMM —
// don't share that helper.
// ─────────────────────────────────────────────────────────────────────

export function deriveBinArray(
  poolBs58: string,
  binArrayIndex: number,
): Hex {
  const pool = new PublicKey(poolBs58);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(binArrayIndex), 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [BIN_ARRAY_SEED, pool.toBytes(), buf],
    PROGRAM_KEY,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// bin_array_bitmap_extension PDA — one per pool.
//
// Optional. Only required when |bin_array_index| >= 512 (outside the
// inline bitmap on LbPair).
// ─────────────────────────────────────────────────────────────────────

export function deriveBinArrayBitmapExtension(poolBs58: string): Hex {
  const pool = new PublicKey(poolBs58);
  const [pda] = PublicKey.findProgramAddressSync(
    [BIN_ARRAY_BITMAP_EXT_SEED, pool.toBytes()],
    PROGRAM_KEY,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// event_authority PDA — Anchor standard.
// ─────────────────────────────────────────────────────────────────────

export function deriveEventAuthority(): Hex {
  const [pda] = PublicKey.findProgramAddressSync(
    [EVENT_AUTHORITY_SEED],
    PROGRAM_KEY,
  );
  return pubkeyToBytes32(pda);
}

// ─────────────────────────────────────────────────────────────────────
// Bin geometry helpers.
// ─────────────────────────────────────────────────────────────────────

/// `bin_array_index = floor(active_id / 70)`.
/// JS's `Math.floor` rounds toward -inf which matches DLMM's signed
/// integer floor division; double-check for negative `active_id` though
/// because integer division in Rust would truncate toward zero, but
/// DLMM's source explicitly uses `div_euclid`-style floor. Verified
/// on pool 3xoczq45 (active_id=2115 → bai=30 ✓).
export function binArrayIndexForBinId(activeBinId: number): number {
  return Math.floor(activeBinId / BINS_PER_ARRAY);
}

/// First bin id covered by the array at this index.
export function startBinIdForArrayIndex(index: number): number {
  return index * BINS_PER_ARRAY;
}

/// Whether `bin_array_index` lies inside the inline bitmap on LbPair
/// (=> bin_array_bitmap_extension is NOT needed for accessing it).
export function isInsideInlineBitmap(index: number): boolean {
  return (
    index >= -INLINE_BITMAP_HALF_RANGE && index < INLINE_BITMAP_HALF_RANGE
  );
}
