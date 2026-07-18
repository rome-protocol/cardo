// Fee overrides for Rome writes — estimate on-chain, apply a factor, never a
// blind hardcode.
//
// Why explicit fees at all: Rome's baseFee is 0 and MetaMask's own fee
// estimation fails on some cached-wrapper CPIs ("Network fee: Unavailable"), so
// the tx can't be sent. We compute the fee ourselves:
//   - gasPrice from eth_gasPrice (floored at the Rome min so it's never rejected)
//   - gas from eth_estimateGas × a safety factor, with a small floor; falls back
//     to a ceiling ONLY when estimateGas itself reverts (some Rome CPIs do).
// Verified on Hadrian: estimateGas returns real values for the RomeBridgeWithdraw
// contract calls (~1.45M for burnUSDC) and the precompile calls run well under
// the floor (wrap succeeds at 40K gas).

import type { Address, Hex, PublicClient } from 'viem';

const ROME_MIN_GAS_PRICE = 11_000_000_000n; // proven-good Rome min (11 gwei)
const MIN_GAS = 120_000n; // safety floor above the estimate
const ESTIMATE_REVERT_FALLBACK_GAS = 10_000_000n; // used only if estimateGas reverts
const FACTOR_NUM = 3n; // 1.5x
const FACTOR_DEN = 2n;

export type RomeFee = { type: 'legacy'; gas: bigint; gasPrice: bigint };

export async function romeFeeOverrides(
  publicClient: PublicClient | undefined,
  tx: { account: Address; to: Address; data: Hex; value?: bigint },
  opts: {
    /// Gas limit applied when estimateGas itself reverts (some Rome CPIs
    /// only succeed in a real tx). CPI-precompile writes pass a higher
    /// ceiling than the bridge default.
    fallbackGas?: bigint;
  } = {},
): Promise<RomeFee> {
  const fallbackGas = opts.fallbackGas ?? ESTIMATE_REVERT_FALLBACK_GAS;
  let gasPrice = ROME_MIN_GAS_PRICE;
  let gas = fallbackGas;

  if (publicClient) {
    try {
      const p = await publicClient.getGasPrice();
      if (p > gasPrice) gasPrice = p;
    } catch {
      /* keep the Rome min */
    }
    try {
      const est = await publicClient.estimateGas({
        account: tx.account,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      gas = (est * FACTOR_NUM) / FACTOR_DEN;
      if (gas < MIN_GAS) gas = MIN_GAS;
    } catch {
      /* estimateGas reverts on some Rome cached-wrapper CPIs — use the ceiling */
      gas = fallbackGas;
    }
  }

  return { type: 'legacy', gas, gasPrice };
}
