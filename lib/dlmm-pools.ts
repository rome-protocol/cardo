// Meteora DLMM LbPair decoder + RPC helpers + curated pool registry.
//
// Source struct: github.com/MeteoraAg/dlmm-sdk
// (`programs/lb_clmm/src/state/lb_pair.rs::LbPair`, mirrored 1:1 in
// idls/dlmm.json v0.10.1).
//
// Layout (offsets in raw account data buffer; 0..8 is the 8-byte Anchor
// discriminator). Multi-byte numeric fields are little-endian.
//
//   0..8     discriminator                                [33,11,49,98,181,101,177,13]
//   8..40    parameters (StaticParameters, 32 bytes)
//   40..72   v_parameters (VariableParameters, 32 bytes)
//   72       bump_seed                                    u8
//   73..75   bin_step_seed                                [u8;2]
//   75       pair_type                                    u8
//   76..80   active_id                                    i32
//   80..82   bin_step                                     u16
//   82       status                                       u8
//   83       require_base_factor_seed                     u8
//   84..86   base_factor_seed                             [u8;2]
//   86       activation_type                              u8
//   87       creator_pool_on_off_control                  u8
//   88..120  token_x_mint                                 pubkey
//   120..152 token_y_mint                                 pubkey
//   152..184 reserve_x                                    pubkey
//   184..216 reserve_y                                    pubkey
//   216..224 protocol_fee.amount_x                        u64
//   224..232 protocol_fee.amount_y                        u64
//   232..264 _padding_1                                   [u8;32]
//   264..552 reward_infos                                 [RewardInfo;2] (144 each)
//   552..584 oracle                                       pubkey
//   584..712 bin_array_bitmap                             [u64; 16]
//   712..720 last_updated_at                              i64
//   720..752 _padding_2                                   [u8;32]
//   752..784 pre_activation_swap_address                  pubkey
//   784..816 base_key                                     pubkey
//   816..824 activation_point                             u64
//   824..832 pre_activation_duration                      u64
//   832..840 _padding_3                                   [u8;8]
//   840..848 _padding_4                                   u64
//   848..880 creator                                      pubkey
//   880      token_mint_x_program_flag                    u8 (0 = SPL, 1 = T22)
//   881      token_mint_y_program_flag                    u8
//   882..904 _reserved                                    [u8;22]
//
// Total = 904. All live devnet pools observed match this size 2026-04-26.
//
// StaticParameters (32 bytes, offset 8..40):
//   8..10    base_factor                                  u16
//   10..12   filter_period                                u16
//   12..14   decay_period                                 u16
//   14..16   reduction_factor                             u16
//   16..20   variable_fee_control                         u32
//   20..24   max_volatility_accumulator                   u32
//   24..28   min_bin_id                                   i32
//   28..32   max_bin_id                                   i32
//   32..34   protocol_share                               u16
//   34       base_fee_power_factor                        u8
//   35..40   _padding                                     [u8;5]

import type { Hex } from 'viem';
import { LB_PAIR_DISC, LB_PAIR_SIZE, FEE_DENOMINATOR_PPB } from './dlmm-program';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type DlmmPool = {
  /// Pool account pubkey (caller-supplied; not in the data buffer).
  pubkey?: Hex;
  /// Active bin id — the bin where the next swap starts.
  activeId: number;
  /// Bin step in basis points (10 = 0.1%, 100 = 1%, ...).
  binStep: number;
  /// PairStatus byte. 0 = enabled. Anything else may indicate paused /
  /// custodial / restricted modes — surface as "swap disabled" in UI.
  status: number;
  pairType: number;
  tokenXMint: Hex;
  tokenYMint: Hex;
  reserveX: Hex;
  reserveY: Hex;
  oracle: Hex;
  /// Inline bin-array bitmap. 16 u64 LE words → 1024 bits, covers
  /// bin_array_index ∈ [-512, 512). Used to know which arrays are
  /// initialized without an extra account fetch.
  binArrayBitmap: bigint[];
  /// Uncollected protocol fees on each side. Subtract from raw vault
  /// balance to get effective swap reserves (mirroring the lesson
  /// learned in CPMM PR #43 + CLMM PR #46).
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  /// Static parameters used in fee-rate calc.
  baseFactor: number;
  baseFeePowerFactor: number;
  protocolShare: number;
  /// Token program flag for each side (0 = classic SPL, 1 = Token-2022).
  tokenMintXProgramFlag: number;
  tokenMintYProgramFlag: number;
  activationPoint: bigint;
};

function checkDisc(buf: Buffer): void {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== LB_PAIR_DISC[i]) {
      throw new Error(
        `dlmm: lb_pair discriminator mismatch (expected ${LB_PAIR_DISC.join(',')}, got ${[
          ...buf.subarray(0, 8),
        ].join(',')})`,
      );
    }
  }
}

function readPubkeyHex(buf: Buffer, off: number): Hex {
  return ('0x' + buf.subarray(off, off + 32).toString('hex')) as Hex;
}

/// Decode an LbPair account's `data` field (raw bytes, including the
/// 8-byte Anchor discriminator).
export function decodeDlmmPool(data: Buffer, pubkey?: Hex): DlmmPool {
  if (data.length < LB_PAIR_SIZE) {
    throw new Error(
      `dlmm: lb_pair data too short (got ${data.length}, expected >= ${LB_PAIR_SIZE})`,
    );
  }
  checkDisc(data);
  const bitmap: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    bitmap.push(data.readBigUInt64LE(584 + i * 8));
  }
  return {
    pubkey,
    activeId: data.readInt32LE(76),
    binStep: data.readUInt16LE(80),
    status: data[82],
    pairType: data[75],
    tokenXMint: readPubkeyHex(data, 88),
    tokenYMint: readPubkeyHex(data, 120),
    reserveX: readPubkeyHex(data, 152),
    reserveY: readPubkeyHex(data, 184),
    protocolFeeX: data.readBigUInt64LE(216),
    protocolFeeY: data.readBigUInt64LE(224),
    oracle: readPubkeyHex(data, 552),
    binArrayBitmap: bitmap,
    baseFactor: data.readUInt16LE(8),
    baseFeePowerFactor: data[8 + 26],
    protocolShare: data.readUInt16LE(8 + 24),
    tokenMintXProgramFlag: data[880],
    tokenMintYProgramFlag: data[881],
    activationPoint: data.readBigUInt64LE(816),
  };
}

/// Fetch an LbPair. `rpcUrl` is the cardo proxy route (e.g.
/// `/api/rpc/solana-devnet`).
export async function fetchDlmmPool(
  rpcUrl: string,
  poolBs58: string,
): Promise<DlmmPool> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [poolBs58, { encoding: 'base64' }],
    }),
  });
  const json = await res.json();
  const value = json?.result?.value;
  if (!value) {
    throw new Error(`dlmm: lb_pair ${poolBs58} not found on this RPC`);
  }
  const buf = Buffer.from(value.data[0], 'base64');
  return decodeDlmmPool(buf, pubkeyBs58ToBytes32(poolBs58));
}

// ─────────────────────────────────────────────────────────────────────
// Curated registry — pools Cardo's `/swap-dlmm` UI ships with.
//
// Devnet pool selection criteria, in priority order:
//   1) WSOL/USDC mint pair (wraps to rWSOL/rUSDC on Rome)
//   2) status flag = 0 (no bits set)
//   3) Both reserves > 0
//   4) `bin_array_index = floor(active_id / 70)` is INSIDE the inline
//      bitmap (i.e. |bai| < 512), AND that bin array is actually
//      initialized on-chain (the bitmap bit is set AND the PDA exists).
//   5) Neighbor bin array on at least ONE side is also initialized
//      (so a small swap that crosses one bin-array boundary doesn't
//      revert with `account not found`).
//
// Across the 7,455 LbPair WSOL pools on devnet, exactly 3 met
// criteria 1-4 as of 2026-04-26. The chosen seed is
// `3xoczq45qQL5e2vsq1c8LeyoRqxJBggnF3tMZUvHE68Y` because it has the
// most balanced reserves (~1.9 USDC, ~4.47 WSOL).
//
// Notes:
//   - Mints are reversed vs. typical Raydium pools: token_x = USDC,
//     token_y = WSOL on this DLMM pool. Don't assume token_x = WSOL.
//   - `base_fee_rate = base_factor * bin_step * 10 * 10^base_fee_power_factor`.
//     For seed pool: 10000 * 10 * 10 * 10^2 = 100_000_000 ppb = 10%.
//     Devnet pools often have inflated fees relative to mainnet; the
//     UI shows the live rate so users see what they're paying.
//   - Active bin_array_index = 30. Inline bitmap covers it (bit 30 of
//     bitmap[0] should be set). Lower neighbor (idx=29) verified to
//     EXIST; upper (idx=31) verified MISSING. So Y→X (selling WSOL)
//     is the safe default direction for v1 — it traverses toward
//     existing arrays, not into the missing one.
//
// Pools verified live via getAccountInfo on api.devnet.solana.com on
// 2026-04-26.
// ─────────────────────────────────────────────────────────────────────

export type DlmmPoolEntry = {
  /// Display label.
  label: string;
  /// Pool account bs58.
  poolBs58: string;
  /// Pool account hex (bytes32).
  poolHex: Hex;
  tokenXMint: Hex;
  tokenYMint: Hex;
  reserveX: Hex;
  reserveY: Hex;
  oracle: Hex;
  /// SPL Token program for each side (classic vs Token-2022).
  tokenXProgram: Hex;
  tokenYProgram: Hex;
  mintXDecimals: number;
  mintYDecimals: number;
  /// Bin step (basis points). 10 = 0.1%, 100 = 1%.
  binStep: number;
  /// Active bin id verified at registry seed time. UI re-fetches live
  /// state but uses this for initial PDA derivation.
  seededActiveId: number;
  /// `bin_array_index` for the active bin. Equals
  /// `floor(seededActiveId / 70)`. Persisted so UI can build accounts
  /// without re-deriving on every render.
  seededBinArrayIndex: number;
  /// Whether each neighbor bin_array PDA is verified live on-chain at
  /// seed time. Used to clamp the UI direction selector.
  neighborLowerExists: boolean;
  neighborUpperExists: boolean;
  network: 'devnet' | 'mainnet';
  enabled: boolean;
};

const SPL_TOKEN_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

const WSOL_USDC_DEVNET: DlmmPoolEntry = {
  label: 'USDC ↔ WSOL · DLMM · devnet (10 bp bin · 10% live fee)',
  poolBs58: '3xoczq45qQL5e2vsq1c8LeyoRqxJBggnF3tMZUvHE68Y',
  poolHex: pubkeyBs58ToBytes32('3xoczq45qQL5e2vsq1c8LeyoRqxJBggnF3tMZUvHE68Y'),
  // token_x = USDC-devnet, token_y = WSOL — DLMM doesn't enforce SOL-as-X.
  tokenXMint: pubkeyBs58ToBytes32(
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  tokenYMint: pubkeyBs58ToBytes32(
    'So11111111111111111111111111111111111111112',
  ),
  reserveX: pubkeyBs58ToBytes32(
    '7Pqy18JKnECWEVDLqHnfNbxnF8vmvbo6FJVJovA7yGVp',
  ),
  reserveY: pubkeyBs58ToBytes32(
    'FU3JcWLxFt8xkf38gnSGr2FpWjEkza4mCZbLZbNBHwwe',
  ),
  oracle: pubkeyBs58ToBytes32(
    'A9rkxyXxtMxXwWveBsN43GzenZUAx9hHGhbTY13a1iFQ',
  ),
  tokenXProgram: SPL_TOKEN_PROGRAM_HEX,
  tokenYProgram: SPL_TOKEN_PROGRAM_HEX,
  mintXDecimals: 6, // USDC
  mintYDecimals: 9, // WSOL
  binStep: 10,
  seededActiveId: 2115,
  seededBinArrayIndex: 30,
  neighborLowerExists: true, // BXf3sLRkkttJ6uqqNLinjNoL3QECukwkXUhENYfqcizR — verified
  neighborUpperExists: false, // FbRuGok98Uz55EfaZGhTUihZDjQN6AXjBWaFpuLAo7a8 — missing 2026-04-26
  network: 'devnet',
  enabled: true,
} as const;

export const DLMM_POOL_REGISTRY: ReadonlyArray<DlmmPoolEntry> = [
  WSOL_USDC_DEVNET,
];

export const ENABLED_DLMM_POOLS: ReadonlyArray<DlmmPoolEntry> =
  DLMM_POOL_REGISTRY.filter((p) => p.enabled);

// ─────────────────────────────────────────────────────────────────────
// Indicative quote — DLMM bin-step price math.
//
// DLMM bins each have a price `p_i = (1 + bin_step / 10000)^i`, where
// `i` is the bin id. A swap consumes liquidity at the active bin's
// price first, then moves to the next bin (via the bitmap), etc.
//
// For the v1 UI quote we use a SINGLE-BIN approximation: assume the
// swap fills entirely within the active bin's price. That is the same
// "constant liquidity within current array" assumption Raydium CLMM's
// v1 quote uses (see raydium-clmm-pools.ts). Output is overstated for
// swaps that cross multiple bins; the slippage guard absorbs the gap.
//
// Direction:
//   X→Y (zero_for_one in CLMM-speak): user pays token_x, receives
//     token_y. price_yx (token_y per token_x) at bin_id = p_i ·
//     decimal-scaling. amount_y_out = amount_x_in_after_fee · price_yx.
//   Y→X: user pays token_y, receives token_x. amount_x_out =
//     amount_y_in_after_fee / price_yx.
//
// Fee is taken off `amount_in` first:
//   amount_in_after_fee = amount_in * (FEE_DENOM - feePpb) / FEE_DENOM
//
// Numerical: use Q64 fixed-point throughout. Compute price as
// integer pow with a Q64.64 sqrt-style ladder; for v1 we approximate
// with floating-point Math.pow because the UI quote tolerates minor
// drift (the on-chain swap recomputes exactly anyway).
// ─────────────────────────────────────────────────────────────────────

/// Compute the bin price `p_i = (1 + bin_step/10000)^i` as a JS number.
/// Acceptable for UI display; exact computation lives on-chain.
export function binPriceFromBinId(activeId: number, binStep: number): number {
  const ratio = 1 + binStep / 10_000;
  return Math.pow(ratio, activeId);
}

/// Single-bin DLMM quote. Returns indicative `amount_out` in raw
/// token units. Caller computes `minimum_amount_out` from this with
/// a slippage tolerance.
///
/// `xForY` true = user spends token_x, receives token_y.
/// `xForY` false = user spends token_y, receives token_x.
export function quoteDlmmSwapSingleBin(args: {
  activeId: number;
  binStep: number;
  decimalsX: number;
  decimalsY: number;
  amountIn: bigint;
  feeRatePpb: bigint;
  xForY: boolean;
}): bigint {
  const { activeId, binStep, amountIn, feeRatePpb, xForY } = args;
  if (amountIn <= 0n) return 0n;

  const inAfterFee =
    (amountIn * (FEE_DENOMINATOR_PPB - feeRatePpb)) / FEE_DENOMINATOR_PPB;
  if (inAfterFee <= 0n) return 0n;

  // Meteora DLMM bin price `(1 + binStep/1e4)^binId` is already the RAW
  // token_y-per-token_x ratio (raw smallest-unit out per raw in) — NOT the
  // human price — so it needs no decimal rescale for raw amount math.
  // Verified on-chain: 0.1 USDC in (90,000 raw after 10% fee) → 745,274 raw
  // WSOL out at bin 2115 ⇒ ratio ≈ 8.28 = binPriceFromBinId(2115,10).
  // The previous `* 10^(decimalsY-decimalsX)` over-scaled the quote ×10^3,
  // which fed an unreachable minimumAmountOut → swaps reverted Custom(6003)
  // (slippage) at the DLMM program. (decimalsX/Y stay in the args type for
  // caller compatibility; only the human-display layer needs them.)
  const priceYPerX = binPriceFromBinId(activeId, binStep);

  if (priceYPerX <= 0 || !Number.isFinite(priceYPerX)) return 0n;

  if (xForY) {
    // amount_y_out = amount_x_in_after_fee * priceYPerX
    const out = Number(inAfterFee) * priceYPerX;
    if (!Number.isFinite(out) || out <= 0) return 0n;
    return BigInt(Math.floor(out));
  } else {
    // amount_x_out = amount_y_in_after_fee / priceYPerX
    const out = Number(inAfterFee) / priceYPerX;
    if (!Number.isFinite(out) || out <= 0) return 0n;
    return BigInt(Math.floor(out));
  }
}

/// `base_fee_rate_ppb = base_factor * bin_step * 10 * 10^base_fee_power_factor`
/// (per Meteora docs + verified against pool 3xoczq45 on 2026-04-26).
export function computeBaseFeeRatePpb(
  baseFactor: number,
  binStep: number,
  basePowerFactor: number,
): bigint {
  return (
    BigInt(baseFactor) *
    BigInt(binStep) *
    10n *
    10n ** BigInt(basePowerFactor)
  );
}
