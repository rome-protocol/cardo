// useSwapGasEstimate — wagmi `useEstimateGas` wired to the exact CPI
// precompile calldata the Swap route would submit.
//
// The Cardo Swap screen needs a live-USD gas number for its cost panel.
// Until now the route wrapper hardcoded 0.008 USD. This hook fixes that:
// it encodes the same `invoke(bytes32, AccountMeta[], bytes)` calldata
// that `onSubmitSwap` builds, asks the node for an estimate, then the
// caller multiplies by Rome's 11 gwei gas price and an ETH/USD oracle
// price to land on a live USD figure.
//
// Why ETH/USD for a chain that prices fees in USDC? Because the wagmi
// `gasEstimate` is denominated in the chain's gas token. Rome declares
// its native currency as `mETH` (18 decimals) in lib/wagmi.ts; that's
// the unit the node charges. So USD = gas_units * gwei_price * ETH_usd
// / 1e18 is the correct conversion. If Rome ever flips to USDC-native
// gas denomination (the chain_mint_id path), swap the oracle choice.
//
// Disabled unless a wallet is connected AND direction + amountIn resolve
// — before then we don't know the account metas yet.

import { useMemo } from 'react';
import { useEstimateGas } from 'wagmi';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { useActiveChainId } from '@/lib/env-context';
import { CPI_PRECOMPILE, CPI_INVOKE_ABI } from '@/lib/cpi-precompile';
import {
  buildChainMeteoraSwapInvoke,
  type SwapDirection,
} from '@/lib/meteora-swap';

export type SwapGasEstimateArgs = {
  userEvmAddress: Address | undefined;
  direction: SwapDirection | null;
  amountIn: bigint;
  minimumOut: bigint;
};

export type SwapGasEstimate = {
  /** Gas units, or undefined while loading / disabled. */
  gas: bigint | undefined;
  loading: boolean;
  error: Error | null;
};

export function useSwapGasEstimate(args: SwapGasEstimateArgs): SwapGasEstimate {
  const chainId = useActiveChainId();
  const enabled =
    !!args.userEvmAddress && !!args.direction && args.amountIn > 0n;

  // Build the exact calldata the submit path uses. Same `invoke` ABI,
  // same account metas, same (program, accounts, data) tuple. Wrap in
  // try/catch so a pre-connect hydration never throws up to the page.
  const calldata = useMemo<Hex | undefined>(() => {
    if (!enabled) return undefined;
    try {
      const { program, accounts, data } = buildChainMeteoraSwapInvoke({
        userEvmAddress: args.userEvmAddress!,
        direction: args.direction!,
        amountIn: args.amountIn,
        minimumOut: args.minimumOut,
      });
      return encodeFunctionData({
        abi: CPI_INVOKE_ABI,
        functionName: 'invoke',
        args: [program, accounts, data],
      });
    } catch {
      return undefined;
    }
  }, [
    enabled,
    args.userEvmAddress,
    args.direction,
    args.amountIn,
    args.minimumOut,
  ]);

  const { data, isLoading, error } = useEstimateGas({
    to: CPI_PRECOMPILE,
    data: calldata,
    account: args.userEvmAddress,
    chainId,
    query: { enabled: enabled && !!calldata },
  });

  return {
    gas: data,
    loading: isLoading,
    error: (error as Error | null) ?? null,
  };
}
