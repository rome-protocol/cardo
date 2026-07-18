// useOraclePrices — live reads of Oracle Gateway V2 adapters on Rome.
//
// Each adapter is a Chainlink-compatible IAggregatorV3Interface, so we
// call `latestRoundData()` and read `answer` (8-decimal USD) and
// `updatedAt` (unix seconds). Addresses come from rome-solidity's
// rome.json deploy manifest and are mirrored in
// `ROME_ADDRESSES.oracles`.
//
// **Why N individual hooks instead of useReadContracts:** Rome has no
// Multicall3 deployed. wagmi's `useReadContracts` falls back to
// Multicall3 internally and every batched read returns failure on
// Rome. We use one `useReadContract` per adapter — direct `eth_call`,
// which the Rome proxy serves cleanly. Same pattern as
// `useTokenBalances`.
//
// Returns a `prices` map keyed by *token symbol* (SOL, USDC, WSOL, ETH,
// BTC, USDT). WSOL shares the SOL adapter.

import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { ROME_ADDRESSES } from '@/lib/addresses';
import { useActiveChainId } from '@/lib/env-context';

const AGGREGATOR_V3_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

export type TokenPrice = {
  usd: number;
  updatedAt: number;
  adapter: Address;
};

export type UseOraclePrices = {
  prices: Record<string, TokenPrice>;
  loading: boolean;
};

// Per-adapter reader.
function useOneAdapter(adapter: Address) {
  const chainId = useActiveChainId();
  const r = useReadContract({
    address: adapter,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'latestRoundData',
    chainId,
    query: { refetchInterval: 15_000 },
  });
  return {
    data: r.data as
      | readonly [bigint, bigint, bigint, bigint, bigint]
      | undefined,
    isLoading: r.isLoading,
    isError: r.isError,
  };
}

export function useOraclePrices(): UseOraclePrices {
  // 5 distinct adapters today: SOL, USDC, ETH, BTC, USDT.
  // (WSOL is an alias of SOL — same adapter — so we only read 5 unique.)
  const sol = useOneAdapter(ROME_ADDRESSES.oracles.solUsd);
  const usdc = useOneAdapter(ROME_ADDRESSES.oracles.usdcUsd);
  const eth = useOneAdapter(ROME_ADDRESSES.oracles.ethUsd);
  const btc = useOneAdapter(ROME_ADDRESSES.oracles.btcUsd);
  const usdt = useOneAdapter(ROME_ADDRESSES.oracles.usdtUsd);

  return useMemo<UseOraclePrices>(() => {
    const loading =
      sol.isLoading ||
      usdc.isLoading ||
      eth.isLoading ||
      btc.isLoading ||
      usdt.isLoading;

    const toPrice = (
      r: { data: readonly [bigint, bigint, bigint, bigint, bigint] | undefined },
      adapter: Address,
    ): TokenPrice | undefined => {
      if (!r.data) return undefined;
      const answer = r.data[1];
      const updatedAt = r.data[3];
      return {
        usd: Number(answer) / 1e8,
        updatedAt: Number(updatedAt),
        adapter,
      };
    };

    const prices: Record<string, TokenPrice> = {};
    const solP = toPrice(sol, ROME_ADDRESSES.oracles.solUsd);
    if (solP) {
      prices.SOL = solP;
      prices.WSOL = solP; // alias
    }
    const usdcP = toPrice(usdc, ROME_ADDRESSES.oracles.usdcUsd);
    if (usdcP) prices.USDC = usdcP;
    const ethP = toPrice(eth, ROME_ADDRESSES.oracles.ethUsd);
    if (ethP) prices.ETH = ethP;
    const btcP = toPrice(btc, ROME_ADDRESSES.oracles.btcUsd);
    if (btcP) prices.BTC = btcP;
    const usdtP = toPrice(usdt, ROME_ADDRESSES.oracles.usdtUsd);
    if (usdtP) prices.USDT = usdtP;

    return { prices, loading };
  }, [sol, usdc, eth, btc, usdt]);
}
