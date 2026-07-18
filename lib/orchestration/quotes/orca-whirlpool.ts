// Orca Whirlpool quote (concentrated liquidity).
//
// CL pools are price-band-by-price-band — true quote requires walking tick
// arrays. For an MVP we approximate using sqrtPrice as spot, which is exact
// for trades below a single tick crossing. For larger trades we'd need to
// fetch the active tick array + walk band-by-band.
//
// Whirlpool layout (well-known):
//   sqrtPrice (u128) at offset 65
//   tokenMintA / tokenMintB at offsets 8 + 13 + 1 + 32 = (anchor disc + bumps)
//   For our purposes we only need sqrtPrice and decimals to convert.

import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { Hex } from 'viem';
import { bytes32ToPublicKey } from '../../solana-pda';
import type { Quote, FailedQuote } from '../types';

// Whirlpool struct (verified offsets — this layout includes whirlpoolsConfig
// pubkey before the per-pool fields, which my prior reading missed):
//   0    anchor disc                    (8B)
//   8    whirlpoolsConfig pubkey        (32B)
//   40   whirlpoolBump[1]               (1B)
//   41   tickSpacing                    (2B)
//   43   tickSpacingSeed                (2B)
//   45   feeRate                        (2B u16)
//   47   protocolFeeRate                (2B)
//   49   liquidity                      (16B u128)
//   65   sqrtPrice                      (16B u128)
//   81   tickCurrentIndex               (4B i32)
//   85   protocolFeeOwedA               (8B)
//   93   protocolFeeOwedB               (8B)
//   101  tokenMintA                     (32B)
//   133  tokenVaultA                    (32B)
//   ...
const OFFSET_FEE_RATE = 45;       // u16, in 1/10000ths
const OFFSET_LIQUIDITY = 49;      // u128
const OFFSET_SQRT_PRICE = 65;     // u128
const OFFSET_TOKEN_MINT_A = 101;  // pubkey
const OFFSET_TOKEN_MINT_B = OFFSET_TOKEN_MINT_A + 32;

const WHIRLPOOL_MIN_LEN = OFFSET_TOKEN_MINT_B + 32;

function readU128LE(buf: Buffer, offset: number): bigint {
  // Solana u128 LE: lower 64 bits first
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export type OrcaWhirlpoolQuoteArgs = {
  conn: Connection;
  poolHex: Hex;
  /// true = swap A → B (input is mint A), false = swap B → A.
  aToB: boolean;
  amountIn: bigint;
  decimalsIn: number;
  decimalsOut: number;
};

export async function quoteOrcaWhirlpool(
  args: OrcaWhirlpoolQuoteArgs,
): Promise<Quote | FailedQuote> {
  const { conn, poolHex, aToB, amountIn, decimalsIn, decimalsOut } = args;
  const venue = 'orca-whirlpool' as const;
  try {
    const poolPk = bytes32ToPublicKey(poolHex);
    const acct = await conn.getAccountInfo(poolPk);
    if (!acct) return { venue, poolAddress: poolHex, error: 'pool not found' };
    if (acct.data.length < WHIRLPOOL_MIN_LEN) {
      return { venue, poolAddress: poolHex, error: `data ${acct.data.length}B < ${WHIRLPOOL_MIN_LEN}B` };
    }

    const feeRateBps = acct.data.readUInt16LE(OFFSET_FEE_RATE); // already in 1/10000ths
    const sqrtPrice = readU128LE(acct.data, OFFSET_SQRT_PRICE);

    // Whirlpool sqrtPrice is in Q64.64 format, scaled by 2^64.
    // priceB_per_A_raw (raw amounts) = sqrtPrice^2 / 2^128.
    //
    // Compute in full bigint precision to avoid lossy Number(u128) conversions.
    // Strategy: scale to 18 decimals of precision, then convert to Number once.
    const SCALE = 10n ** 18n;
    const Q128 = 2n ** 128n;
    const priceBperA_raw_scaled = (sqrtPrice * sqrtPrice * SCALE) / Q128; // bigint, 18-dec scaled
    const priceBperA_raw = Number(priceBperA_raw_scaled) / 1e18;

    // priceBperA_raw is the ratio of raw output amount per raw input amount when
    // selling A for B. Adjust for decimals to get human price:
    //   1 human A = 10^decA raw A → 10^decA × priceBperA_raw raw B = 10^(decA-decB) × priceBperA_raw human B
    const decA = aToB ? decimalsIn : decimalsOut;
    const decB = aToB ? decimalsOut : decimalsIn;
    const humanPriceBperA = priceBperA_raw * Math.pow(10, decA - decB);
    const spotPrice = aToB ? humanPriceBperA : 1 / humanPriceBperA;

    // Output amount via raw-units math (no decimals adjustment needed since
    // both amountIn and amountOut are raw): amountOut_raw = amountIn_raw × ratio_raw.
    // ratio_raw = priceBperA_raw if aToB, else 1/priceBperA_raw.
    const amountInPostFee = (amountIn * BigInt(10_000 - feeRateBps)) / 10_000n;
    const ratioScaled = aToB ? priceBperA_raw_scaled : (SCALE * SCALE) / priceBperA_raw_scaled;
    const amountOut = (amountInPostFee * ratioScaled) / SCALE;

    // No price-impact estimate without tick walking
    return {
      venue,
      poolAddress: poolHex,
      amountOut,
      spotPrice,
      priceImpactBps: 0,
      estimatedCu: 100_000,
      note: 'sqrtPrice-only approximation; exact quote requires tick walking',
    };
  } catch (e) {
    return { venue, poolAddress: poolHex, error: (e as Error).message ?? String(e) };
  }
}
