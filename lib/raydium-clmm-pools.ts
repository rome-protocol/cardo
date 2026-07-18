// Raydium CLMM PoolState decoder + RPC helpers + curated pool registry.
//
// Source struct: github.com/raydium-io/raydium-clmm
// (`programs/amm/src/states/pool.rs::PoolState`).
//
// Layout (offsets in raw account data buffer; 0..8 is the 8-byte Anchor
// discriminator). All multi-byte fields are little-endian.
//
//   0..8     discriminator                          [247,237,227,245,215,195,222,70]
//   8        bump                                   u8 (1 byte; struct field is `[u8;1]`)
//   9..41    amm_config                             pubkey
//   41..73   owner                                  pubkey
//   73..105  token_mint_0                           pubkey
//   105..137 token_mint_1                           pubkey
//   137..169 token_vault_0                          pubkey
//   169..201 token_vault_1                          pubkey
//   201..233 observation_key                        pubkey
//   233      mint_decimals_0                        u8
//   234      mint_decimals_1                        u8
//   235..237 tick_spacing                           u16
//   237..253 liquidity                              u128
//   253..269 sqrt_price_x64                         u128
//   269..273 tick_current                           i32
//   273..275 padding3                               u16
//   275..277 padding4                               u16
//   277..293 fee_growth_global_0_x64                u128
//   293..309 fee_growth_global_1_x64                u128
//   309..317 protocol_fees_token_0                  u64
//   317..325 protocol_fees_token_1                  u64
//   325..341 swap_in_amount_token_0                 u128
//   341..357 swap_out_amount_token_1                u128
//   357..373 swap_in_amount_token_1                 u128
//   373..389 swap_out_amount_token_0                u128
//   389      status                                 u8
//   390..397 padding[7]                             [u8; 7]
//   397..904 reward_infos                           RewardInfo[3]   (169 bytes each)
//   904..1032 tick_array_bitmap                     [u64; 16]
//   1032..1040 total_fees_token_0                   u64
//   1040..1048 total_fees_claimed_token_0           u64
//   1048..1056 total_fees_token_1                   u64
//   1056..1064 total_fees_claimed_token_1           u64
//   1064..1072 fund_fees_token_0                    u64
//   1072..1080 fund_fees_token_1                    u64
//   1080..1088 open_time                            u64
//   1088..1096 recent_epoch                         u64
//   1096..1544 padding (24 + 32 u64 = 448 bytes)
//
// Total = 1544. All live devnet pools observed match this size 2026-04-26.

import type { Hex } from 'viem';
import { POOL_DISC, POOL_SIZE } from './raydium-clmm-program';
import { pubkeyBs58ToBytes32 } from './solana-pda';

export type RaydiumClmmPool = {
  /// Pool account pubkey (caller-supplied; not in the data buffer).
  pubkey?: Hex;
  bump: number;
  ammConfig: Hex;
  owner: Hex;
  token0Mint: Hex;
  token1Mint: Hex;
  token0Vault: Hex;
  token1Vault: Hex;
  observationKey: Hex;
  mint0Decimals: number;
  mint1Decimals: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  /// Status bit flags. Bit 4 (mask 0x10 = 16) = swap disabled. The CLMM
  /// `status` enum is wider than CPMM's:
  ///   bit0 = open-position/increase-liquidity disabled
  ///   bit1 = decrease-liquidity disabled
  ///   bit2 = collect-fee disabled
  ///   bit3 = collect-reward disabled
  ///   bit4 = swap disabled    ← gates submit
  /// `0` = fully open.
  status: number;
  /// 16 u64 little-endian slots, 1024-bit packed bitmap of initialized
  /// tick arrays (covers ±tick_spacing*60*512 ticks from tick 0).
  tickArrayBitmap: bigint[];
  /// Accumulated fees that sit in the vault but are NOT swappable until
  /// claimed by the admin/fund. Subtract from raw vault balance to get
  /// effective swap reserves. THIS WAS THE CPMM BUG (#43 fix 37a2a86).
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
};

function checkDisc(buf: Buffer): void {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== POOL_DISC[i]) {
      throw new Error(
        `raydium-clmm: pool discriminator mismatch (expected ${POOL_DISC.join(',')}, got ${[
          ...buf.subarray(0, 8),
        ].join(',')})`,
      );
    }
  }
}

function readPubkeyHex(buf: Buffer, off: number): Hex {
  return ('0x' + buf.subarray(off, off + 32).toString('hex')) as Hex;
}

function readU128LE(buf: Buffer, off: number): bigint {
  // u128 little-endian = lo u64 + (hi u64 << 64).
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) | lo;
}

/// Decode a CLMM PoolState account's `data` field (raw bytes, including
/// the 8-byte Anchor discriminator).
export function decodeRaydiumClmmPool(
  data: Buffer,
  pubkey?: Hex,
): RaydiumClmmPool {
  if (data.length < POOL_SIZE) {
    throw new Error(
      `raydium-clmm: pool data too short (got ${data.length}, expected >= ${POOL_SIZE})`,
    );
  }
  checkDisc(data);
  const bitmap: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    bitmap.push(data.readBigUInt64LE(904 + i * 8));
  }
  return {
    pubkey,
    bump: data[8],
    ammConfig: readPubkeyHex(data, 9),
    owner: readPubkeyHex(data, 41),
    token0Mint: readPubkeyHex(data, 73),
    token1Mint: readPubkeyHex(data, 105),
    token0Vault: readPubkeyHex(data, 137),
    token1Vault: readPubkeyHex(data, 169),
    observationKey: readPubkeyHex(data, 201),
    mint0Decimals: data[233],
    mint1Decimals: data[234],
    tickSpacing: data.readUInt16LE(235),
    liquidity: readU128LE(data, 237),
    sqrtPriceX64: readU128LE(data, 253),
    tickCurrent: data.readInt32LE(269),
    status: data[389],
    tickArrayBitmap: bitmap,
    protocolFeesToken0: data.readBigUInt64LE(309),
    protocolFeesToken1: data.readBigUInt64LE(317),
    fundFeesToken0: data.readBigUInt64LE(1064),
    fundFeesToken1: data.readBigUInt64LE(1072),
  };
}

/// Fetch a CLMM PoolState. `rpcUrl` is the cardo proxy route (e.g.
/// `/api/rpc/solana-devnet`).
export async function fetchRaydiumClmmPool(
  rpcUrl: string,
  poolBs58: string,
): Promise<RaydiumClmmPool> {
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
    throw new Error(`raydium-clmm: pool ${poolBs58} not found on this RPC`);
  }
  const buf = Buffer.from(value.data[0], 'base64');
  return decodeRaydiumClmmPool(buf, pubkeyBs58ToBytes32(poolBs58));
}

// ─────────────────────────────────────────────────────────────────────
// Curated registry — pools Cardo's `/swap-raydium-clmm` UI ships with.
//
// Devnet pool selection criteria, in priority order:
//   1) WSOL/USDC mint pair (wraps to rWSOL/rUSDC on Rome)
//   2) status flag = 0 (no bits set)
//   3) liquidity > 0
//   4) tick_current is COVERED by the inline bitmap (not in a dead-
//      zone gap between two initialized arrays)
//
// Across the 7,852 PoolState accounts on devnet, exactly 1 pool met
// all 4 criteria as of 2026-04-26: HXAQnU2fJzMDHn3VK9m968AxvQhuiGxpcuVJjum1k7XW.
// Liquidity is thin (~0.27 USDC + 1488 lamports of WSOL — bitmap bit
// 595 → start_idx 49800 has the only initialized tick array). The UI
// must clamp swap amounts conservatively and surface the thin-pool
// warning. AmmConfig fee = 5 bps.
//
// Pools we considered and rejected:
//   6JjEnNQ… — current tick -89748 sits in a dead-zone between bits
//             358 (-92400) and 396 (-69600). swap would revert.
//   DW1rwn… — liquidity = 0.
//
// All pubkeys verified live via getAccountInfo against
// api.devnet.solana.com on 2026-04-26.
// ─────────────────────────────────────────────────────────────────────

export type RaydiumClmmPoolEntry = {
  /// Display label.
  label: string;
  /// Pool account bs58.
  poolBs58: string;
  /// Pool account hex (bytes32).
  poolHex: Hex;
  ammConfig: Hex;
  token0Mint: Hex;
  token1Mint: Hex;
  token0Vault: Hex;
  token1Vault: Hex;
  /// SPL Token program for each side (classic vs Token-2022). Both
  /// classic SPL Token for the WSOL/USDC pool.
  token0Program: Hex;
  token1Program: Hex;
  mint0Decimals: number;
  mint1Decimals: number;
  observationKey: Hex;
  /// Tick spacing (10 = 0.05% AmmConfig, 60 = 0.25%, 120 = 1%).
  tickSpacing: number;
  /// Inline-bitmap bit position of the (one) initialized tick array
  /// near current tick that the UI ships with as the conservative seed.
  /// Used to derive the tick_array PDA without re-querying the bitmap.
  /// Verified against on-chain bitmap state at registry seed time.
  seededBitPos: number;
  network: 'devnet' | 'mainnet';
  enabled: boolean;
};

const SPL_TOKEN_PROGRAM_HEX: Hex = pubkeyBs58ToBytes32(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

const WSOL_USDC_DEVNET: RaydiumClmmPoolEntry = {
  label: 'WSOL ↔ USDC · devnet (5 bps · thin)',
  poolBs58: 'HXAQnU2fJzMDHn3VK9m968AxvQhuiGxpcuVJjum1k7XW',
  poolHex: pubkeyBs58ToBytes32('HXAQnU2fJzMDHn3VK9m968AxvQhuiGxpcuVJjum1k7XW'),
  ammConfig: pubkeyBs58ToBytes32(
    'GVSwm4smQBYcgAJU7qjFHLQBHTc4AdB3F2HbZp6KqKof',
  ),
  // token_0 = WSOL
  token0Mint: pubkeyBs58ToBytes32('So11111111111111111111111111111111111111112'),
  // token_1 = USDC devnet (same mint Cardo bridges through for rUSDC)
  token1Mint: pubkeyBs58ToBytes32('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  token0Vault: pubkeyBs58ToBytes32(
    '5y3DsNuaEDuW7RnLJ5LKhDtVkBv6qcPyXjwqcxZUhYWP',
  ),
  token1Vault: pubkeyBs58ToBytes32(
    '5VrDJxxch4ua5xrBHdkCrYR45gftv8NoXaWAc3E93pye',
  ),
  token0Program: SPL_TOKEN_PROGRAM_HEX,
  token1Program: SPL_TOKEN_PROGRAM_HEX,
  mint0Decimals: 9, // WSOL
  mint1Decimals: 6, // USDC
  observationKey: pubkeyBs58ToBytes32(
    '2gxGLs29mpe9wKFtwFwNVGLaBMKPAJnUW8zAMjEcWTbq',
  ),
  tickSpacing: 10,
  seededBitPos: 595, // → start_idx 49800; tick_current = 50108 sits inside [49800, 50400)
  network: 'devnet',
  enabled: true,
} as const;

export const RAYDIUM_CLMM_POOL_REGISTRY: ReadonlyArray<RaydiumClmmPoolEntry> = [
  WSOL_USDC_DEVNET,
];

export const ENABLED_RAYDIUM_CLMM_POOLS: ReadonlyArray<RaydiumClmmPoolEntry> =
  RAYDIUM_CLMM_POOL_REGISTRY.filter((p) => p.enabled);

// ─────────────────────────────────────────────────────────────────────
// Indicative quote — concentrated-liquidity step.
//
// CLMM's exact swap is a tick-by-tick traversal that updates `liquidity`
// at each crossed tick boundary. For UI-level quoting we use the
// SINGLE-STEP approximation: assume the swap stays within the current
// tick array. Within one tick array, output is computed from the
// constant-liquidity Q64.64 swap math:
//
//   For zero_for_one (input = token_0, sqrt_price moves DOWN):
//     amount_in   = ceil(liquidity * (sqrt_p_curr - sqrt_p_next) / (sqrt_p_curr * sqrt_p_next * Q64))
//     amount_out  = floor(liquidity * (sqrt_p_curr - sqrt_p_next) / Q64)
//
//   For one_for_zero (input = token_1, sqrt_price moves UP):
//     amount_in   = ceil(liquidity * (sqrt_p_next - sqrt_p_curr) / Q64)
//     amount_out  = floor(liquidity * (sqrt_p_next - sqrt_p_curr) / (sqrt_p_curr * sqrt_p_next * Q64))
//
// Trade fee is taken off `amount_in` BEFORE the price-impact step:
//   amount_in_after_fee = amount_in * (1_000_000 - feeRatePpm) / 1_000_000
//
// This single-step approximation OVERSTATES output for swaps that
// cross tick boundaries (since it assumes constant liquidity). The
// `minimum_amount_out` slippage guard absorbs the difference. UI ships
// 200 bps default (matching CPMM PR #43).
// ─────────────────────────────────────────────────────────────────────

const FEE_DENOM = 1_000_000n;
const Q64 = 1n << 64n;

/// One-tick-array CLMM quote. Returns indicative `amount_out` in raw
/// token units. Caller computes `minimum_amount_out` from this with
/// a slippage tolerance.
export function quoteRaydiumClmmSwapSingleStep(args: {
  liquidity: bigint;
  sqrtPriceX64: bigint;
  amountIn: bigint;
  feeRatePpm: bigint;
  zeroForOne: boolean;
}): bigint {
  const { liquidity, sqrtPriceX64, amountIn, feeRatePpm, zeroForOne } = args;
  if (amountIn <= 0n || liquidity <= 0n || sqrtPriceX64 <= 0n) return 0n;

  const inAfterFee = (amountIn * (FEE_DENOM - feeRatePpm)) / FEE_DENOM;
  if (inAfterFee <= 0n) return 0n;

  if (zeroForOne) {
    // input = token_0, price moves DOWN.
    //   delta_x = (L * (sqrt_p_curr - sqrt_p_next)) / (sqrt_p_curr * sqrt_p_next / Q64)
    // Solve for sqrt_p_next given delta_x = inAfterFee:
    //   sqrt_p_next = (L * sqrt_p_curr * Q64) / (L * Q64 + inAfterFee * sqrt_p_curr)
    const num = liquidity * sqrtPriceX64 * Q64;
    const den = liquidity * Q64 + inAfterFee * sqrtPriceX64;
    if (den <= 0n) return 0n;
    const sqrtNext = num / den;
    if (sqrtNext <= 0n || sqrtNext >= sqrtPriceX64) return 0n;
    // delta_y = (L * (sqrt_p_curr - sqrt_p_next)) / Q64
    const out = (liquidity * (sqrtPriceX64 - sqrtNext)) / Q64;
    return out > 0n ? out : 0n;
  } else {
    // input = token_1, price moves UP.
    //   delta_y = (L * (sqrt_p_next - sqrt_p_curr)) / Q64
    //   so sqrt_p_next = sqrt_p_curr + (delta_y * Q64) / L
    const sqrtNext = sqrtPriceX64 + (inAfterFee * Q64) / liquidity;
    if (sqrtNext <= sqrtPriceX64) return 0n;
    // delta_x = (L * (sqrt_p_next - sqrt_p_curr)) / (sqrt_p_curr * sqrt_p_next / Q64)
    //        = (L * (sqrt_p_next - sqrt_p_curr) * Q64) / (sqrt_p_curr * sqrt_p_next)
    const num = liquidity * (sqrtNext - sqrtPriceX64) * Q64;
    const den = sqrtPriceX64 * sqrtNext;
    if (den <= 0n) return 0n;
    const out = num / den;
    return out > 0n ? out : 0n;
  }
}
