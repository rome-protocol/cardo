// Swap-DLMM route `/swap-dlmm` — Meteora DLMM single-bin `swap` ix
// on devnet using the seeded WSOL/USDC pool.
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md
// (Family 11 — Concentrated AMM with multi-bin swap, B7 Meteora DLMM.
//  V1 ships small-swap-only — large bin-crossings need Track A's headroom.)

'use client';

import { useCallback, useMemo } from 'react';
import { SwapDlmm } from '@/components/screens/SwapDlmm';
import { useWallet } from '../wallet-context';
import { ENABLED_DLMM_POOLS } from '@/lib/dlmm-pools';
import { useDlmmPoolState } from '@/lib/use-dlmm-pool-state';
import { useDlmmSwap } from '@/lib/use-dlmm-swap';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { activeChain } from '@/lib/chain-config';

type SwapArgs = {
  swapXForY: boolean;
  amountIn: bigint;
  minimumAmountOut: bigint;
};

// Rome EVM wrappers for the seeded pool's two SPL mints — registry-driven
// (was stale pre-#240 literals). USDC = chain_mint_id wrapper, WSOL = canonical.
const { wUsdc: RUSDC_WRAPPER, wWsol: RWSOL_WRAPPER } = activeChain().wrappers;

export default function Page() {
  const { wallet, connect } = useWallet();
  const pool = ENABLED_DLMM_POOLS[0];
  const poolState = useDlmmPoolState(pool?.poolBs58 ?? null);
  const { state: swapState, swap } = useDlmmSwap();

  // For our seeded pool: token_x = USDC, token_y = WSOL. Map mint hex
  // → EVM wrapper so useSolanaTokenBalances can read the user's
  // per-mint ATA balance.
  const tokenSpecs = useMemo(
    () =>
      pool
        ? [
            {
              wrapper: RUSDC_WRAPPER,
              mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            },
            {
              wrapper: RWSOL_WRAPPER,
              mintAddress: 'So11111111111111111111111111111111111111112',
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
      [pool.tokenXMint]:
        Number(balances[RUSDC_WRAPPER] ?? 0n) / 10 ** pool.mintXDecimals,
      [pool.tokenYMint]:
        Number(balances[RWSOL_WRAPPER] ?? 0n) / 10 ** pool.mintYDecimals,
    };
  }, [balances, pool]);

  const onSwap = useCallback(
    (args: SwapArgs) => {
      if (!wallet?.address) {
        connect?.();
        return;
      }
      if (!pool) return;
      if (args.amountIn <= 0n) return;
      void swap({
        userEvmAddress: wallet.address as `0x${string}`,
        pool,
        swapXForY: args.swapXForY,
        amountIn: args.amountIn,
        minimumAmountOut: args.minimumAmountOut,
      });
    },
    [wallet?.address, connect, pool, swap],
  );

  return (
    <SwapDlmm
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
