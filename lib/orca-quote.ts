// Orca Whirlpool spot quote — output for a swap at the pool's current price.
//
// Orca is concentrated-liquidity: the exact output requires walking tick arrays.
// But at the current sqrt-price the SPOT output is exact for small trades and a
// close upper bound for larger ones; the user's slippage tolerance (applied to
// otherAmountThreshold) absorbs the tick-crossing error. We quote from the
// pool's live sqrtPriceX64 (Q64.64), which useOrcaPoolState already reads.
//
//   price(raw B per raw A) = sqrtPriceX64^2 / 2^128
//   aToB (sell A → B): out_B = inAfterFee * sqrtPriceX64^2 / 2^128
//   bToA (sell B → A): out_A = inAfterFee * 2^128 / sqrtPriceX64^2
//
// fee is in Orca's native ppm (e.g. 300 = 0.03%).

const Q128 = 1n << 128n;

export function orcaSpotOut(
  sqrtPriceX64: bigint,
  aToB: boolean,
  amountIn: bigint,
  feePpm: number,
): bigint {
  if (amountIn <= 0n || sqrtPriceX64 <= 0n) return 0n;
  const ppm = Math.max(0, Math.min(1_000_000, Math.floor(feePpm)));
  const inAfterFee = (amountIn * BigInt(1_000_000 - ppm)) / 1_000_000n;
  if (inAfterFee <= 0n) return 0n;
  const sp2 = sqrtPriceX64 * sqrtPriceX64;
  // Floor division is conservative (never over-quotes) — what we want for the
  // minimumOut floor.
  return aToB ? (inAfterFee * sp2) / Q128 : (inAfterFee * Q128) / sp2;
}

/** otherAmountThreshold = expectedOut shaved by slippage (bps). */
export function orcaMinOut(expectedOut: bigint, slippageBps: number): bigint {
  if (expectedOut <= 0n) return 0n;
  const bps = Math.max(0, Math.min(10_000, Math.floor(slippageBps)));
  return (expectedOut * BigInt(10_000 - bps)) / 10_000n;
}
