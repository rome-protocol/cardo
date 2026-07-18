// Swap-Phoenix route `/swap-phoenix` — Phoenix CLOB market order on
// devnet using Cardo's bootstrapped WSOL/USDC market. Phoenix's
// `InitializeMarket` is permissionless, so we run our own pre-seeded
// market at `613nNZ8z…` (see scripts/bootstrap-phoenix-market.ts).
//
// This is the second native CLOB integration in Cardo (after the
// AMM-flavored Raydium / Orca / Meteora swaps). Single Phoenix Swap
// (IOC) ix; the matching engine resolves price discovery on-chain.

'use client';

import { useCallback, useMemo } from 'react';
import { SwapPhoenix } from '@/components/screens/SwapPhoenix';
import { useWallet } from '../wallet-context';
import { ENABLED_PHOENIX_MARKETS } from '@/lib/phoenix-markets';
import { usePhoenixMarketState } from '@/lib/use-phoenix-market-state';
import { usePhoenixSwap } from '@/lib/use-phoenix-swap';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { activeChain } from '@/lib/chain-config';

type SwapArgs = {
  inputIsBase: boolean;
  inputLots: bigint;
  minOutputLots: bigint;
};

// Rome EVM wrappers for the seeded market's two SPL mints — registry-driven
// (was stale pre-#240 literals). USDC = chain_mint_id wrapper, WSOL = canonical.
const { wUsdc: RUSDC_WRAPPER, wWsol: RWSOL_WRAPPER } = activeChain().wrappers;

export default function Page() {
  const { wallet, connect } = useWallet();
  const market = ENABLED_PHOENIX_MARKETS[0];
  const marketState = usePhoenixMarketState(market?.marketBs58 ?? null);
  const { state: swapState, swap } = usePhoenixSwap();

  const tokenSpecs = useMemo(
    () =>
      market
        ? [
            { wrapper: RWSOL_WRAPPER, mintAddress: 'So11111111111111111111111111111111111111112' },
            { wrapper: RUSDC_WRAPPER, mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
          ]
        : [],
    [market],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );

  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    if (!market) return {};
    return {
      [market.baseMint]:
        Number(balances[RWSOL_WRAPPER] ?? 0n) / 10 ** market.baseDecimals,
      [market.quoteMint]:
        Number(balances[RUSDC_WRAPPER] ?? 0n) / 10 ** market.quoteDecimals,
    };
  }, [balances, market]);

  const onSwap = useCallback(
    (args: SwapArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!market) return;
      if (args.inputLots <= 0n) return;
      void swap({
        userEvmAddress: wallet.address as `0x${string}`,
        market,
        inputIsBase: args.inputIsBase,
        inputLots: args.inputLots,
        minOutputLots: args.minOutputLots,
      });
    },
    [wallet?.address, connect, market, swap],
  );

  return (
    <SwapPhoenix
      wallet={wallet}
      onConnect={connect}
      market={market}
      marketState={marketState}
      ataBalancesByMint={ataBalancesByMint}
      onSwap={onSwap}
      swapState={swapState}
    />
  );
}
