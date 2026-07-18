// Swap-Raydium-CLMM route `/swap-raydium-clmm` — Raydium CLMM swap_v2
// on devnet using the seeded WSOL/USDC pool. Family 3,
// A1 → A0 promotion via existing devnet liquidity (no auto-clone needed
// — Raydium runs a maintained CLMM redeploy at `devi51m…` on devnet).
//
// Per the integration roadmap at
//   the docs/active/technical/2026-04-25-cardo-solana-integration-roadmap.md

'use client';

import { useCallback, useMemo } from 'react';
import { SwapRaydiumClmm } from '@/components/screens/SwapRaydiumClmm';
import { useWallet } from '../wallet-context';
import { ENABLED_RAYDIUM_CLMM_POOLS } from '@/lib/raydium-clmm-pools';
import { useRaydiumClmmPoolState } from '@/lib/use-raydium-clmm-pool-state';
import { useRaydiumClmmSwap } from '@/lib/use-raydium-clmm-swap';
import { useSolanaTokenBalances } from '@/lib/use-solana-balances';
import { activeChain } from '@/lib/chain-config';

type SwapArgs = {
  inputIsToken0: boolean;
  amountIn: bigint;
  minimumAmountOut: bigint;
};

// Rome EVM wrappers for the seeded pool's two SPL mints — registry-driven
// (was stale pre-#240 literals). USDC = chain_mint_id wrapper, WSOL = canonical.
const { wUsdc: RUSDC_WRAPPER, wWsol: RWSOL_WRAPPER } = activeChain().wrappers;

export default function Page() {
  const { wallet, connect } = useWallet();
  const pool = ENABLED_RAYDIUM_CLMM_POOLS[0];
  const poolState = useRaydiumClmmPoolState(pool?.poolBs58 ?? null);
  const { state: swapState, swap } = useRaydiumClmmSwap();

  // Map mint hex → EVM wrapper so useSolanaTokenBalances can read the
  // user's per-mint ATA balance. token_0 = WSOL, token_1 = USDC for the
  // seeded pool — that ordering is encoded in the pool struct, not
  // chosen by us.
  const tokenSpecs = useMemo(
    () =>
      pool
        ? [
            { wrapper: RWSOL_WRAPPER, mintAddress: 'So11111111111111111111111111111111111111112' },
            { wrapper: RUSDC_WRAPPER, mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
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
      [pool.token0Mint]:
        Number(balances[RWSOL_WRAPPER] ?? 0n) / 10 ** pool.mint0Decimals,
      [pool.token1Mint]:
        Number(balances[RUSDC_WRAPPER] ?? 0n) / 10 ** pool.mint1Decimals,
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
        inputIsToken0: args.inputIsToken0,
        amountIn: args.amountIn,
        minimumAmountOut: args.minimumAmountOut,
        // Live tick from pool state → correct tick array for the current
        // price (a stale static seed reverts once the pool has traded).
        tickCurrent: poolState.pool?.tickCurrent,
      });
    },
    [wallet?.address, connect, pool, poolState.pool?.tickCurrent, swap],
  );

  return (
    <SwapRaydiumClmm
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
