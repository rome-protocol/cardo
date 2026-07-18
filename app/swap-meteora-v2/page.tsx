// Swap-MeteoraV2 route `/swap-meteora-v2` — Meteora DAMM v2 swap.
//
// Liquidity (add/remove) was dropped: opening a DAMM-v2 position needs an
// ephemeral NFT-mint keypair signer that Rome can't provide, so it can't be
// done in-UI without sending the user to app.meteora.ag — which violates the
// no-external-Solana rule. Swap stays (fully self-contained).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useMemo } from 'react';
import { SwapMeteoraV2 } from '@/components/screens/SwapMeteoraV2';
import { useWallet } from '../wallet-context';
import { ENABLED_DAMM_V2_POOLS } from '@/lib/damm-v2-pools';
import { useDammV2PoolState } from '@/lib/use-damm-v2-pool-state';
import { useDammV2Swap } from '@/lib/use-damm-v2-swap';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';

type SwapArgs = { aToB: boolean; amountHuman: number; minimumAmountOut?: bigint };

export default function Page() {
  const { wallet, connect } = useWallet();
  const pool = ENABLED_DAMM_V2_POOLS[0];
  const poolState = useDammV2PoolState(pool);
  const { state: swapState, swap } = useDammV2Swap();

  const tokenSpecs = useMemo(
    () =>
      pool
        ? [
            {
              wrapper: '0xb7c77397143adea219ac03a4005d304af1bfebe3' as `0x${string}`,
              mintAddress: 'So11111111111111111111111111111111111111112',
            },
            {
              wrapper: '0x1F7DfAf9444D46fC10b4B4736D906dA5cAf46195' as `0x${string}`,
              mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            },
          ]
        : [],
    [pool],
  );
  const balances = useSolanaTokenBalances(
    tokenSpecs,
    wallet?.address as `0x${string}` | undefined,
  );

  const ataBalancesByMint: Record<string, number> = useMemo(() => {
    if (!pool) return {};
    return {
      [pool.tokenAMint]:
        Number(balances['0xb7c77397143adea219ac03a4005d304af1bfebe3'] ?? 0n) /
        10 ** pool.tokenADecimals,
      [pool.tokenBMint]:
        Number(balances['0x1F7DfAf9444D46fC10b4B4736D906dA5cAf46195'] ?? 0n) /
        10 ** pool.tokenBDecimals,
    };
  }, [balances, pool]);

  const onSwap = useCallback(
    (args: SwapArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!pool) return;
      const inDecimals = args.aToB ? pool.tokenADecimals : pool.tokenBDecimals;
      const decimalMul = 10n ** BigInt(inDecimals);
      const amountIn = BigInt(Math.floor(args.amountHuman * Number(decimalMul)));
      if (amountIn <= 0n) return;
      const label = args.aToB
        ? `${pool.symbolA} → ${pool.symbolB}`
        : `${pool.symbolB} → ${pool.symbolA}`;
      void swap({
        userEvmAddress: wallet.address as `0x${string}`,
        pool,
        aToB: args.aToB,
        amountIn,
        minimumAmountOut: args.minimumAmountOut ?? 0n,
        label,
      });
    },
    [wallet?.address, connect, pool, swap],
  );

  return (
    <SwapMeteoraV2
      wallet={wallet}
      onConnect={connect}
      pool={pool}
      poolState={poolState}
      ataBalancesByMint={ataBalancesByMint}
      onSwap={onSwap}
      swapState={swapState}
    />
  );
}
